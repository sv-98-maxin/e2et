/**
 * assert/capture/mock handler owner：断言计数、MockInterceptor 与精确清理摘要。
 * 成功与失败事件、错误码与统计保持原合同；mock.clear 不抹 history。
 */
import type { CdpSession } from '../browser/daemon-client.js';
import { MockInterceptor } from '../browser/mock.js';
import {
  parseAssertion, assertApi, assertRequest, assertToast, assertText, assertVisible, assertAbsent,
  assertTableRow, assertField, assertUrl, assertStyle, assertElement, assertApiHeader, parseValue,
  InvalidRefError, type AssertResult, type AssertDeps,
} from '../browser/assert.js';
import { captureApi, captureElement, type CaptureDeps, type CaptureResult } from '../browser/capture.js';
import { matchConsole, type ConsoleCheck } from '../shared/console.js';
import { FrameUnavailableError } from '../browser/frame-view.js';
import type { FrameDesc } from '../browser/page-state.js';
import { appendTraceEvent, readTraceBody, redactText, scrubValue } from './trace.js';
import { AUTH_DATA_NOT_REPLAYABLE } from '../shared/element-value.js';
import { REPLAY_EVIDENCE_REDACTED } from '../shared/assertion.js';
import { ASSERT_KIND_BY_METHOD } from './session-types.js';
import type { ActionValue } from './network-trace.js';
import type { LifecycleSnapshot } from './session-types.js';
import type { DaemonRequest, DaemonResponse } from './protocol.js';
import type { PageContext } from './page-context.js';
import { pageDataScrubKey, type PageObservers } from './page-observers.js';
import type { NetworkTrace } from './network-trace.js';
import type { SessionValues } from './session-values.js';
import { parsePageDataSourceParams } from './page-commands.js';
import { requestContext } from '../request-context.js';

export interface EvidenceDeps {
  sessionId: string;
  page: PageContext;
  observers: () => PageObservers | null;
  networkTrace: () => NetworkTrace | null;
  values: SessionValues;
  lifecycleSnapshot: () => Readonly<LifecycleSnapshot>;
  trace: (ev: Record<string, unknown>) => void;
}

export class EvidenceCommands {
  private assertsTotal = 0;
  private assertsPass = 0;
  private mockInterceptor: MockInterceptor | null = null;

  constructor(private readonly deps: EvidenceDeps) {}

  summary(): { total: number; pass: number } {
    return { total: this.assertsTotal, pass: this.assertsPass };
  }

  hasMocked(): boolean {
    return this.mockInterceptor?.hasMocked() === true;
  }

  async dispose(): Promise<void> {
    try { await this.mockInterceptor?.disable(); } catch { /* 浏览器已断开 */ }
  }

  private get page(): PageContext { return this.deps.page; }
  private get nt(): NetworkTrace | null { return this.deps.networkTrace(); }
  private stopped(): boolean {
    const ls = this.deps.lifecycleSnapshot();
    return ls.stopped || ls.state !== 'running';
  }
  private ok(req: DaemonRequest, data: unknown): DaemonResponse { return { id: req.id, ok: true, data }; }
  private fail(req: DaemonRequest, code: string, message: string, hint?: string): DaemonResponse {
    return { id: req.id, ok: false, error: { code, message, ...(hint ? { hint } : {}) } };
  }
  private activeRefTarget(): string { return this.page.activeId() ?? this.page.sourceId(); }

  async handle(req: DaemonRequest): Promise<DaemonResponse> {
    if (req.method.startsWith('assert.') && req.method !== 'assert.data') return this.assertCommand(req);
    if (req.method === 'assert.data') return this.assertData(req);
    if (req.method === 'capture.api' || req.method === 'capture.element') return this.capture(req);
    if (req.method === 'mock.add') return this.mockAdd(req);
    if (req.method === 'mock.clear') return this.mockClear(req);
    return this.fail(req, 'UNKNOWN_METHOD', '未知方法: ' + req.method);
  }

  // ── assert ──
  private async assertCommand(req: DaemonRequest): Promise<DaemonResponse> {
    const cdp = this.page.activeCdp();
    const nt = this.nt;
    if (!cdp || !nt) return this.fail(req, 'NOT_READY', '浏览器会话未就绪');
    if (this.stopped()) return this.fail(req, 'STOPPING', '会话正在停止');
    const after = nt.getLastFinishedActionId();
    if (!after) return this.fail(req, 'BAD_REQUEST', 'assert 必须跟在操作命令之后', '先执行 page click/fill 等操作');
    const assertFrameRaw = req.params?.frame !== undefined ? String(req.params.frame) : undefined;
    let assertCdp: CdpSession = cdp;
    let assertFrameDesc: FrameDesc[] | undefined;
    if (assertFrameRaw) {
      try {
        const ctx = await this.deps.observers()!.resolveActiveFrameContext(assertFrameRaw);
        assertCdp = ctx.view;
        assertFrameDesc = [ctx.desc];
      } catch (e) {
        if (requestContext.getStore()?.signal.aborted) return this.assertFailure(req, e, after);
        if (e instanceof FrameUnavailableError) return this.fail(req, 'FRAME_UNSUPPORTED', e.message);
        throw e;
      }
      const targetParam = req.params?.target !== undefined ? String(req.params.target) : req.params?.within !== undefined ? String(req.params.within) : '';
      if (/^\[\d+\]$/.test(targetParam)) {
        return this.fail(req, 'BAD_REQUEST', 'frame 内不支持 [N] 索引（无 frame 快照），先用 css=/role=/label=/text= 定位');
      }
    }
    const deps: AssertDeps = {
      cdp: assertCdp,
      resolveReq: (ref: string) => nt.resolveReqRef(ref),
      getBodyInfo: (id: string) => nt.getBodyRef(id),
      getHeadersInfo: (id: string) => {
        const summary = nt.resolveReqRef(id);
        return summary ? { headers: (summary as { resp_headers?: Record<string, string> }).resp_headers, redacted: (summary as { resp_headers_redacted?: string[] }).resp_headers_redacted } : undefined;
      },
      readBody: (ref: string) => readTraceBody(this.deps.sessionId, ref),
      currentUrl: () => cdp.evaluate<string>('location.href').catch(() => ''),
      resolveRef: assertFrameRaw ? undefined : (ref: number) => { const m = this.page.resolveRef(ref); if (!m) return null; return m.targetId === this.activeRefTarget() ? m : null; },
    };
    let result: AssertResult;
    let assertValueMeta: (ActionValue & { source_action?: string }) | undefined;
    try {
      switch (req.method) {
        case 'assert.api': {
          const reqRef = String(req.params?.req ?? '');
          const hasExpect = req.params?.expect !== undefined;
          const hasHeader = req.params?.header !== undefined;
          if (!reqRef) return this.fail(req, 'BAD_REQUEST', '缺 req 引用');
          if (hasExpect === hasHeader) return this.fail(req, 'BAD_REQUEST', '--expect 与 --header 必须恰好提供一个');
          if (hasHeader) {
            if (req.params?.value_ref !== undefined || req.params?.value_from_action !== undefined) {
              return this.fail(req, 'BAD_REQUEST', '--header 模式不支持 --value-ref/--value-from-action');
            }
            const header = String(req.params?.header ?? '');
            if (!header) return this.fail(req, 'BAD_REQUEST', '缺 --header');
            result = await assertApiHeader(deps, reqRef, header);
            break;
          }
          const expect = String(req.params?.expect ?? '');
          if (!expect) return this.fail(req, 'BAD_REQUEST', '缺 --expect');
          const source = this.deps.values.parseAssertValueSource(req.params);
          if (!source.ok) return this.fail(req, source.error.code, source.error.message, source.error.hint);
          if (source.value !== undefined && parseAssertion(expect)?.valueJson) {
            return this.fail(req, 'BAD_REQUEST', '引用模式（--value-ref/--value-from-action）下 --expect 只能给 "<path> <op>"，不能同时携带 literal 文本');
          }
          assertValueMeta = source.meta;
          result = await assertApi(deps, reqRef, expect, source.value);
          break;
        }
        case 'assert.request': {
          const reqRef = String(req.params?.req ?? '');
          const hasBody = req.params?.body !== undefined;
          const hasQuery = req.params?.query !== undefined;
          if (hasBody === hasQuery) return this.fail(req, 'BAD_REQUEST', '--body 与 --query 必须恰好提供一个');
          const body = String(hasBody ? req.params?.body : req.params?.query);
          if (!reqRef) return this.fail(req, 'BAD_REQUEST', '缺 req 引用');
          if (!body) return this.fail(req, 'BAD_REQUEST', hasBody ? '缺 --body' : '缺 --query');
          const source = this.deps.values.parseAssertValueSource(req.params);
          if (!source.ok) return this.fail(req, source.error.code, source.error.message, source.error.hint);
          if (source.value !== undefined && parseAssertion(body)?.valueJson) {
            return this.fail(req, 'BAD_REQUEST', `引用模式（--value-ref/--value-from-action）下 ${hasBody ? '--body' : '--query'} 只能给 "<path> <op>"，不能同时携带 literal 文本`);
          }
          assertValueMeta = source.meta;
          result = await assertRequest(deps, reqRef, body, source.value, hasQuery ? 'query' : 'body');
          break;
        }
        case 'assert.toast': {
          const text = String(req.params?.text ?? '');
          if (!text) return this.fail(req, 'BAD_REQUEST', '缺 text');
          result = await assertToast(deps, text);
          break;
        }
        case 'assert.text': {
          if (req.params?.value !== undefined && req.params?.contains !== undefined) {
            return this.fail(req, 'BAD_REQUEST', 'value / --value-ref / --value-from-action 必须恰好提供一个');
          }
          const sourceParams = req.params?.value === undefined && req.params?.contains !== undefined
            ? { ...req.params, value: req.params.contains }
            : req.params;
          const source = this.deps.values.parseAssertValueSource(sourceParams, true);
          if (!source.ok) return this.fail(req, source.error.code, source.error.message, source.error.hint);
          const resolved = source.value;
          if (resolved === undefined || !resolved.trim()) return this.fail(req, 'BAD_REQUEST', 'assert text 期望值为空或纯空白');
          assertValueMeta = source.meta;
          result = await assertText(deps, resolved, req.params?.within !== undefined ? String(req.params.within) : undefined);
          break;
        }
        case 'assert.visible': {
          const target = String(req.params?.target ?? '');
          if (!target) return this.fail(req, 'BAD_REQUEST', '缺 target');
          result = await assertVisible(deps, target);
          break;
        }
        case 'assert.absent': {
          const target = String(req.params?.target ?? '');
          if (!target) return this.fail(req, 'BAD_REQUEST', '缺 target');
          result = await assertAbsent(deps, target);
          break;
        }
        case 'assert.table_row': {
          const contains = String(req.params?.contains ?? '');
          const count = req.params?.count !== undefined ? Number(req.params.count) : undefined;
          if (!contains) return this.fail(req, 'BAD_REQUEST', '缺 contains');
          result = await assertTableRow(deps, contains, count);
          break;
        }
        case 'assert.field': {
          const label = String(req.params?.label ?? '');
          if (!label) return this.fail(req, 'BAD_REQUEST', '缺 label');
          const source = this.deps.values.parseAssertValueSource(req.params, true);
          if (!source.ok) return this.fail(req, source.error.code, source.error.message, source.error.hint);
          assertValueMeta = source.meta;
          result = await assertField(deps, label, source.value ?? '');
          break;
        }
        case 'assert.style': {
          const target = String(req.params?.target ?? '');
          const property = String(req.params?.property ?? '');
          const equals = req.params?.equals !== undefined ? String(req.params.equals) : '';
          const pseudoRaw = req.params?.pseudo !== undefined ? String(req.params.pseudo) : undefined;
          if (!target) return this.fail(req, 'BAD_REQUEST', '缺 target');
          if (!property) return this.fail(req, 'BAD_REQUEST', '缺 --property');
          if (pseudoRaw !== undefined && pseudoRaw !== 'before' && pseudoRaw !== 'after') return this.fail(req, 'BAD_REQUEST', '--pseudo 只支持 before|after');
          result = await assertStyle(deps, target, { property, equals, ...(pseudoRaw ? { pseudo: pseudoRaw as 'before' | 'after' } : {}), ...(req.params?.all === true ? { all: true } : {}) });
          break;
        }
        case 'assert.element': {
          const target = String(req.params?.target ?? '');
          const property = String(req.params?.property ?? '');
          const expectRaw = String(req.params?.expect ?? '');
          if (!target) return this.fail(req, 'BAD_REQUEST', '缺 target');
          if (!property) return this.fail(req, 'BAD_REQUEST', '缺 --property');
          const parsed = expectRaw.match(/^(==|!=|exists|contains|>|<)\s*(.*)$/);
          if (!parsed) return this.fail(req, 'BAD_REQUEST', '--expect 需要 "<op> <value>"');
          result = await assertElement(deps, target, { property, op: parsed[1] as '==' | '!=' | 'exists' | 'contains' | '>' | '<', value: parseValue(parsed[2].trim()), ...(req.params?.all === true ? { all: true } : {}) });
          break;
        }
        case 'assert.console': {
          const scopeRaw = req.params?.scope !== undefined ? String(req.params.scope) : 'session';
          if (scopeRaw !== 'session' && scopeRaw !== 'action') return this.fail(req, 'BAD_REQUEST', '--scope 只支持 session|action');
          const noError = req.params?.no_error === true;
          const level = req.params?.level !== undefined ? String(req.params.level) : undefined;
          if (noError === (level !== undefined)) return this.fail(req, 'BAD_REQUEST', '--no-error 与 --level 必须恰好提供一个');
          let check: ConsoleCheck;
          if (noError) {
            check = { noError: true };
          } else {
            const contains = req.params?.contains !== undefined ? String(req.params.contains) : undefined;
            if (contains === undefined) return this.fail(req, 'BAD_REQUEST', '--level 模式必须提供 --contains');
            const levels = ['log', 'debug', 'info', 'warning', 'error', 'trace'] as const;
            if (!levels.includes(level as (typeof levels)[number])) return this.fail(req, 'BAD_REQUEST', '--level 非法');
            const count = req.params?.count === undefined ? 1 : req.params.count;
            if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) return this.fail(req, 'BAD_REQUEST', '--count 必须是非负整数');
            check = { level: level as (typeof levels)[number], contains, count };
          }
          const observers = this.deps.observers()!;
          await this.attachConsoleIfNeeded(observers);
          requestContext.getStore()?.signal.throwIfAborted();
          if (!observers.hasActiveConsole()) return this.fail(req, 'NOT_READY', 'Console 观察器未就绪');
          let frameId: string | undefined;
          if (assertFrameRaw) {
            try { frameId = (await observers.resolveActiveFrameContext(assertFrameRaw)).frameId; }
            catch (e) {
              requestContext.getStore()?.signal.throwIfAborted();
              if (e instanceof FrameUnavailableError) return this.fail(req, 'FRAME_UNSUPPORTED', e.message);
              throw e;
            }
          }
          const consoleSnap = await observers.consoleSnapshot();
          requestContext.getStore()?.signal.throwIfAborted();
          if (!consoleSnap) return this.fail(req, 'NOT_READY', 'Console 观察器未就绪');
          const actionId = scopeRaw === 'action' ? (nt.getActiveActionId() ?? after) : undefined;
          if (scopeRaw === 'action' && !actionId) return this.fail(req, 'BAD_REQUEST', 'action scope 需要已完成/进行中的 action 身份');
          const match = matchConsole(consoleSnap.snapshot, check, { scope: scopeRaw, ...(actionId ? { actionId } : {}), ...(frameId ? { frameId } : {}) });
          result = {
            kind: 'console',
            expect: { check, scope: scopeRaw },
            actual: { pass: match.pass, expected: match.expected, actual: match.actual, counts: match.counts, incomplete: match.incomplete, complete: consoleSnap.complete, logs: match.logs },
            pass: match.pass,
            evidence: [{ logs: match.logs, incomplete: match.incomplete, complete: consoleSnap.complete }],
          };
          break;
        }
        case 'assert.url': {
          const contains = String(req.params?.contains ?? '');
          if (!contains) return this.fail(req, 'BAD_REQUEST', '缺 contains');
          result = await assertUrl(deps, contains);
          break;
        }
        default:
          return this.fail(req, 'UNKNOWN_METHOD', '未知 assert: ' + req.method);
      }
      requestContext.getStore()?.signal.throwIfAborted();
    } catch (e) {
      return this.assertFailure(req, e, after);
    }
    this.assertsTotal++;
    if (result.pass) this.assertsPass++;
    if (result.target) this.page.updateRefIdentity(result.target);
    if (result.within) this.page.updateRefIdentity(result.within);
    appendTraceEvent(this.deps.sessionId, {
      t: 'assert', after, kind: result.kind, expect: result.expect, actual: result.actual, pass: result.pass, evidence: result.evidence,
      ...(result.target ? { target: result.target } : {}),
      ...(result.within ? { within: result.within } : {}),
      ...(req.params?.group !== undefined ? { group: String(req.params.group) } : {}),
      ...(assertValueMeta ? { value: assertValueMeta } : {}),
      ...(result.read_mode ? { read_mode: result.read_mode } : {}),
      ...(result.identity ? { identity: result.identity } : {}),
      ...(result.path_status ? { path_status: result.path_status } : {}),
      ...(assertFrameDesc ? { frame: assertFrameDesc } : {}),
      replayable: true,
    });
    return this.ok(req, { ...result });
  }

  private async attachConsoleIfNeeded(observers: PageObservers): Promise<void> {
    const cdp = this.page.activeCdp();
    if (observers.hasActiveConsole() || !cdp) return;
    try { await observers.attach(this.activeRefTarget(), cdp); }
    catch (e) {
      const ls = this.deps.lifecycleSnapshot();
      if (!ls.stopped && ls.state === 'running') this.deps.trace({ t: 'console_init_error', error: redactText((e as Error).message) });
    }
  }

  private assertFailure(req: DaemonRequest, e: unknown, after: string): DaemonResponse {
    const signal = requestContext.getStore()?.signal;
    if (signal?.aborted) {
      const code = 'REQUEST_CANCELLED';
      const kind = ASSERT_KIND_BY_METHOD[req.method] ?? req.method.slice('assert.'.length);
      this.assertsTotal++;
      appendTraceEvent(this.deps.sessionId, {
        t: 'assert', after, kind, expect: null, actual: { error: { code } }, pass: false, replayable: false, evidence: [{ code }],
        ...(req.params?.group !== undefined ? { group: String(req.params.group) } : {}),
      });
      return this.fail(req, code, signal.reason.message);
    }
    const msg = (e as Error).message;
    if (msg.startsWith('INSUFFICIENT_EVIDENCE')) return this.fail(req, 'INSUFFICIENT_EVIDENCE', redactText(msg));
    if (msg === AUTH_DATA_NOT_REPLAYABLE || msg.startsWith(REPLAY_EVIDENCE_REDACTED)) {
      const code = msg === AUTH_DATA_NOT_REPLAYABLE ? AUTH_DATA_NOT_REPLAYABLE : REPLAY_EVIDENCE_REDACTED;
      const kind = ASSERT_KIND_BY_METHOD[req.method] ?? String(req.method);
      this.assertsTotal++;
      appendTraceEvent(this.deps.sessionId, { t: 'assert', after, kind, expect: '[REDACTED]', actual: { error: { code } }, pass: false, replayable: false, evidence: [{ code }] });
      return this.fail(req, code, code === AUTH_DATA_NOT_REPLAYABLE ? '字段为凭证通道（密码控件），拒绝读取' : '断言依赖被脱敏改写的来源字段，拒绝回放');
    }
    if (msg.startsWith('BODY_UNAVAILABLE')) {
      return this.fail(req, 'BODY_UNAVAILABLE', redactText(msg), '请求 body 未存进 trace(可能响应未结束或非 JSON)；若已确认目标站未登录，先核自己Chrome的目标页：仍已登录则直接 e2et auth import --chrome --url <目标业务URL>；也未登录则请用户在自己的Chrome登录，完成后再复制profile；保留失败证据，结束旧会话，新会话/回放显式 --auth profile --browser chrome；只有profile复制或复用确实不可用时选择 e2et auth login --url <目标业务URL>，新登录可能使原Chrome下线');
    }
    if (msg.startsWith('BAD_REQUEST')) return this.fail(req, 'BAD_REQUEST', redactText(msg));
    if (e instanceof InvalidRefError) return this.fail(req, 'NOT_FOUND', redactText(msg), '切换/关闭/新快照后旧 ref 失效，先 page state 刷新');
    return this.fail(req, 'DAEMON_ERROR', redactText(msg));
  }

  // ── assert.data ──
  private async assertData(req: DaemonRequest): Promise<DaemonResponse> {
    const nt = this.nt;
    if (!this.page.activeCdp() || !nt) return this.fail(req, 'NOT_READY', '浏览器会话未就绪');
    if (this.stopped()) return this.fail(req, 'STOPPING', '会话正在停止');
    if (nt.isActionActive()) return this.fail(req, 'BUSY', 'action 执行中，暂不能断言页面数据（观察拒绝中间值）');
    const after = nt.getLastFinishedActionId();
    if (!after) return this.fail(req, 'BAD_REQUEST', 'assert 必须跟在操作命令之后', '先执行 page open 等操作');
    const parsed = parsePageDataSourceParams(req.params);
    if (!parsed.ok) return this.fail(req, 'BAD_REQUEST', parsed.message);
    const equalsRaw = req.params?.equals;
    if (equalsRaw === undefined) return this.fail(req, 'BAD_REQUEST', '缺 --equals 期望标量');
    if (equalsRaw !== null && typeof equalsRaw === 'object') return this.fail(req, 'BAD_REQUEST', '--equals 只接受 JSON 标量（字符串/数字/boolean/null），不接受对象或数组');
    if (typeof equalsRaw === 'number' && !Number.isFinite(equalsRaw)) return this.fail(req, 'BAD_REQUEST', '--equals 数字必须是有限值');
    const expected = equalsRaw as string | number | boolean | null;
    const equalsScrubbed = scrubValue(expected, pageDataScrubKey(parsed.source)) as string | number | boolean | null;
    const group = req.params?.group !== undefined ? String(req.params.group) : undefined;
    const frameDescRaw = req.params?.frame !== undefined ? String(req.params.frame) : undefined;
    let dataFrame: import('./page-observers.js').PageDataFrame | undefined;
    if (frameDescRaw) {
      try { dataFrame = await this.deps.observers()!.resolvePageDataFrame(frameDescRaw); }
      catch (e) {
        if (requestContext.getStore()?.signal.aborted) return this.assertFailure(req, e, after);
        if (e instanceof FrameUnavailableError) return this.fail(req, 'FRAME_UNSUPPORTED', e.message);
        throw e;
      }
    }
    const dataFrameDesc = dataFrame ? [dataFrame.desc] : undefined;
    const read = await this.deps.observers()!.readPageDataObserved(parsed.source, { after, group }, dataFrame);
    const signal = requestContext.getStore()?.signal;
    if (signal?.aborted) return this.assertFailure(req, signal.reason, after);
    const replayable = equalsScrubbed === expected && (read.ok ? read.replayable : false) === true;
    if (!read.ok) {
      this.assertsTotal++;
      appendTraceEvent(this.deps.sessionId, {
        t: 'assert', after, kind: 'data',
        expect: { source: parsed.source, equals: equalsScrubbed },
        actual: { error: { code: read.code, message: read.message } },
        pass: false, replayable,
        evidence: [{ observation: read.observationId, error: { code: read.code } }],
        observation_ref: read.observationId,
        ...(dataFrameDesc ? { frame: dataFrameDesc } : {}),
        ...(group ? { group } : {}),
      });
      return this.fail(req, read.code, read.message, read.hint);
    }
    const pass = read.value.present && read.value.value === expected;
    this.assertsTotal++;
    if (pass) this.assertsPass++;
    const actual = { present: read.value.present, ...(read.result.value !== undefined ? { value: read.result.value } : {}), context: read.context };
    const expectShown = { source: parsed.source, equals: equalsScrubbed };
    appendTraceEvent(this.deps.sessionId, {
      t: 'assert', after, kind: 'data', expect: expectShown, actual, pass, replayable,
      evidence: [{ observation: read.observationId }], observation_ref: read.observationId,
      ...(dataFrameDesc ? { frame: dataFrameDesc } : {}),
      ...(group ? { group } : {}),
    });
    return this.ok(req, {
      kind: 'data', expect: expectShown, actual, pass, replayable,
      evidence: [{ observation: read.observationId }], observation_ref: read.observationId,
      ...(dataFrameDesc ? { frame: dataFrameDesc } : {}),
    });
  }

  // ── capture ──
  private async capture(req: DaemonRequest): Promise<DaemonResponse> {
    const cdp = this.page.activeCdp();
    const nt = this.nt;
    if (!cdp || !nt) return this.fail(req, 'NOT_READY', '浏览器会话未就绪');
    if (this.stopped()) return this.fail(req, 'STOPPING', '会话正在停止');
    const after = nt.getLastFinishedActionId();
    if (!after) return this.fail(req, 'BAD_REQUEST', 'capture 必须跟在操作命令之后', '先执行 page click/fill 等操作');
    const as = String(req.params?.as ?? '');
    if (!as) return this.fail(req, 'BAD_REQUEST', '缺 --as 变量名');
    const captureFrameRaw = req.params?.frame !== undefined ? String(req.params.frame) : undefined;
    let captureCdp: CdpSession = cdp;
    let captureFrameDesc: FrameDesc[] | undefined;
    if (captureFrameRaw) {
      const targetParam = req.params?.target !== undefined ? String(req.params.target) : '';
      if (/^\[\d+\]$/.test(targetParam)) return this.fail(req, 'BAD_REQUEST', 'frame 内不支持 [N] 索引（无 frame 快照），先用 css=/role=/label=/text= 定位');
      try {
        const ctx = await this.deps.observers()!.resolveActiveFrameContext(captureFrameRaw);
        captureCdp = ctx.view;
        captureFrameDesc = [ctx.desc];
      } catch (e) {
        if (requestContext.getStore()?.signal.aborted) return this.captureFailure(req, e, after, as);
        if (e instanceof FrameUnavailableError) return this.fail(req, 'FRAME_UNSUPPORTED', e.message);
        throw e;
      }
    }
    const cdeps: CaptureDeps = {
      cdp: captureCdp,
      resolveReq: (ref: string) => nt.resolveReqRef(ref),
      getBodyInfo: (id: string) => nt.getBodyRef(id),
      readBody: (ref: string) => readTraceBody(this.deps.sessionId, ref),
      generatedValues: () => {
        const out = new Set<string>();
        for (const v of this.deps.values.allVars()) if (v.origin === 'generated') out.add(v.value);
        return out;
      },
      resolveRef: captureFrameRaw ? undefined : (ref: number) => { const m = this.page.resolveRef(ref); if (!m) return null; return m.targetId === this.activeRefTarget() ? m : null; },
    };
    let captured: CaptureResult;
    try {
      if (req.method === 'capture.api') {
        const reqRef = String(req.params?.req ?? '');
        const jsonPathExpr = String(req.params?.path ?? '');
        if (!reqRef) return this.fail(req, 'BAD_REQUEST', '缺 req 引用');
        if (!jsonPathExpr) return this.fail(req, 'BAD_REQUEST', '缺 path');
        captured = await captureApi(cdeps, reqRef, jsonPathExpr, as);
      } else {
        const target = String(req.params?.target ?? '');
        if (!target) return this.fail(req, 'BAD_REQUEST', '缺 target');
        captured = await captureElement(cdeps, target, as);
      }
      requestContext.getStore()?.signal.throwIfAborted();
    } catch (e) {
      return this.captureFailure(req, e, after, as);
    }
    this.deps.values.setVar(as, { value: captured.value, origin: captured.lineage === 'created' || captured.lineage === 'generated' ? 'captured' : 'literal' });
    if (captured.target) this.page.updateRefIdentity(captured.target);
    appendTraceEvent(this.deps.sessionId, {
      t: 'capture', after, as: captured.as, replayable: true,
      result: {
        ok: true, value: captured.value, from: captured.from, lineage: captured.lineage,
        ...(req.method === 'capture.api' ? { path: String(req.params?.path ?? '') } : {}),
        ...(captured.read_mode ? { read_mode: captured.read_mode } : {}),
        ...(captured.target ? { target: captured.target } : {}),
      },
      ...(req.params?.group !== undefined ? { group: String(req.params.group) } : {}),
      ...(captureFrameDesc ? { frame: captureFrameDesc } : {}),
    });
    return this.ok(req, { ...captured });
  }

  private captureFailure(req: DaemonRequest, e: unknown, after: string, as: string): DaemonResponse {
    const signal = requestContext.getStore()?.signal;
    if (signal?.aborted) {
      const code = 'REQUEST_CANCELLED';
      appendTraceEvent(this.deps.sessionId, {
        t: 'capture', after, as, replayable: false, result: { ok: false, error: { code } },
        ...(req.params?.group !== undefined ? { group: String(req.params.group) } : {}),
      });
      return this.fail(req, code, signal.reason.message);
    }
    const msg = (e as Error).message;
    if (msg.startsWith('INSUFFICIENT_EVIDENCE')) return this.fail(req, 'INSUFFICIENT_EVIDENCE', redactText(msg));
    if (msg === AUTH_DATA_NOT_REPLAYABLE || msg.startsWith(REPLAY_EVIDENCE_REDACTED)) {
      const code = msg === AUTH_DATA_NOT_REPLAYABLE ? AUTH_DATA_NOT_REPLAYABLE : REPLAY_EVIDENCE_REDACTED;
      appendTraceEvent(this.deps.sessionId, {
        t: 'capture', after, as, replayable: false, result: { ok: false, error: { code } },
        ...(req.params?.group !== undefined ? { group: String(req.params.group) } : {}),
      });
      return this.fail(req, code, code === AUTH_DATA_NOT_REPLAYABLE ? '目标为凭证通道（密码控件），拒绝读取' : 'capture 依赖被脱敏改写的来源字段，拒绝回放');
    }
    if (msg.startsWith('BODY_UNAVAILABLE')) {
      return this.fail(req, 'BODY_UNAVAILABLE', redactText(msg), '若已确认目标站未登录，先核自己Chrome的目标页：仍已登录则直接 e2et auth import --chrome --url <目标业务URL>；也未登录则请用户在自己的Chrome登录，完成后再复制profile；保留失败证据，结束旧会话，新会话/回放显式 --auth profile --browser chrome；只有profile复制或复用确实不可用时选择 e2et auth login --url <目标业务URL>，新登录可能使原Chrome下线');
    }
    if (msg.startsWith('BAD_REQUEST')) return this.fail(req, 'BAD_REQUEST', redactText(msg));
    if (e instanceof InvalidRefError) return this.fail(req, 'NOT_FOUND', redactText(msg), '切换/关闭/新快照后旧 ref 失效，先 page state 刷新');
    return this.fail(req, 'DAEMON_ERROR', redactText(msg));
  }

  // ── mock ──
  private async mockAdd(req: DaemonRequest): Promise<DaemonResponse> {
    const cdp = this.page.activeCdp();
    if (!cdp) return this.fail(req, 'NOT_READY', '浏览器会话未就绪');
    if (this.stopped()) return this.fail(req, 'STOPPING', '会话正在停止');
    const path = String(req.params?.path ?? '');
    const callIndex = req.params?.call_index !== undefined ? Number(req.params.call_index) : undefined;
    const status = req.params?.status !== undefined ? Number(req.params.status) : 200;
    const bodyB64 = String(req.params?.body_b64 ?? '');
    const contentType = req.params?.content_type !== undefined ? String(req.params.content_type) : undefined;
    if (!path) return this.fail(req, 'BAD_REQUEST', '缺 path');
    if (!bodyB64) return this.fail(req, 'BAD_REQUEST', '缺 body-file');
    let bodyBuffer: Buffer;
    try { bodyBuffer = Buffer.from(bodyB64, 'base64'); }
    catch { return this.fail(req, 'BAD_REQUEST', 'body-file 不是合法 base64'); }
    if (!this.mockInterceptor) this.mockInterceptor = new MockInterceptor(cdp);
    await this.mockInterceptor.add({ path, callIndex, status, bodyBuffer, contentType });
    appendTraceEvent(this.deps.sessionId, { t: 'mock', op: 'add', path, ...(callIndex !== undefined ? { call_index: callIndex } : {}), status, body_size: bodyBuffer.length });
    return this.ok(req, { path, mocked: true });
  }

  private async mockClear(req: DaemonRequest): Promise<DaemonResponse> {
    const path = req.params?.path !== undefined ? String(req.params.path) : undefined;
    if (this.mockInterceptor) await this.mockInterceptor.clear(path);
    appendTraceEvent(this.deps.sessionId, { t: 'mock', op: 'clear', ...(path ? { path } : {}) });
    return this.ok(req, { cleared: path ?? 'all' });
  }
}
