/**
 * page.* 命令 handler：inspect/state/read/execute/console/screenshot 与页面动作。
 * 只在这里调用 browser 页面原语；实际值从 req.params 读取，action runner 负责事务。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import {
  navigate, clickNode, typeIntoNode, pressKey, selectOption, TargetNotFoundError,
  screenshot as captureScreenshot,
} from '../browser/interactions.js';
import {
  fillNode, uploadFiles, hoverNode, scrollNode, backHistory, refreshPage,
  chooseOptions, setDateValue, pickCategory, fillFormByScope,
} from '../browser/actions.js';
import { collectPageState, type FrameDesc, type PageState } from '../browser/page-state.js';
import { FrameUnavailableError } from '../browser/frame-view.js';
import { isValidDotPath, readPageIdentity } from '../browser/page-data.js';
import { inspectUi } from '../browser/assert.js';
import { selectConsoleEntries } from '../shared/console.js';
import { redactText, redactUrl, redactUrlWithEvidence, ensurePrivateDir, scrubValue } from './trace.js';
import { e2etRoot } from './session-meta.js';
import { AUTH_DATA_NOT_REPLAYABLE } from '../shared/element-value.js';
import type { DaemonRequest, DaemonResponse } from './protocol.js';
import type { LifecycleSnapshot } from './session-types.js';
import type { PageContext } from './page-context.js';
import type { PageObservers } from './page-observers.js';
import type { NetworkTrace } from './network-trace.js';
import type { ActionRunner } from './action-runner.js';
import { NAV_TIMEOUT_MS, SETTLE_MS, waitForLoad } from './action-waits.js';
import { requestContext } from '../request-context.js';

const NO_FOLLOW = (fs.constants as unknown as Record<string, number>).O_NOFOLLOW ?? 0;
const RESULT_MAX_BYTES = 100 * 1024;
const RESULT_PREVIEW_CHARS = 500;

export interface PageCommandsDeps {
  sessionId: string;
  page: PageContext;
  observers: () => PageObservers | null;
  networkTrace: () => NetworkTrace | null;
  lifecycleSnapshot: () => Readonly<LifecycleSnapshot>;
  runner: ActionRunner;
  trace: (ev: Record<string, unknown>) => void;
}

export class PageCommands {
  constructor(private readonly deps: PageCommandsDeps) {}

  private get page(): PageContext { return this.deps.page; }
  private get observers(): PageObservers | null { return this.deps.observers(); }
  private get nt(): NetworkTrace | null { return this.deps.networkTrace(); }
  private stopped(): boolean {
    const ls = this.deps.lifecycleSnapshot();
    return ls.stopped || ls.state !== 'running';
  }
  private ok(req: DaemonRequest, data: unknown): DaemonResponse { return { id: req.id, ok: true, data }; }
  private fail(req: DaemonRequest, code: string, message: string, hint?: string): DaemonResponse {
    return { id: req.id, ok: false, error: { code, message, ...(hint ? { hint } : {}) } };
  }

  async handle(req: DaemonRequest, onWaitStarted: (deadlineMs: number) => void): Promise<DaemonResponse> {
    switch (req.method) {
      case 'page.inspect': return this.inspect(req);
      case 'page.console': return this.console(req);
      case 'page.open': return this.open(req, onWaitStarted);
      case 'page.state': return this.state(req);
      case 'page.read': return this.read(req);
      case 'page.execute': return this.execute(req);
      case 'page.screenshot': return this.screenshot(req);
      default: return this.action(req, onWaitStarted);
    }
  }

  private async attachConsole(): Promise<void> {
    const observers = this.observers;
    const cdp = this.page.activeCdp();
    if (!observers || !cdp || observers.hasActiveConsole()) return;
    try { await observers.attach(this.page.activeId() ?? this.page.sourceId(), cdp); }
    catch (e) {
      const ls = this.deps.lifecycleSnapshot();
      if (!ls.stopped && ls.state === 'running') {
        this.deps.trace({ t: 'console_init_error', error: redactErrorMessage(e) });
      }
    }
  }

  private async inspect(req: DaemonRequest): Promise<DaemonResponse> {
    const cdp = this.page.activeCdp();
    const nt = this.nt;
    if (!cdp || !nt) return this.fail(req, 'NOT_READY', '浏览器会话未就绪');
    if (this.stopped()) return this.fail(req, 'STOPPING', '会话正在停止');
    const check = String(req.params?.check ?? '') as 'text-artifacts' | 'i18n' | 'overflow' | 'broken-images' | 'error-exposure';
    if (!['text-artifacts', 'i18n', 'overflow', 'broken-images', 'error-exposure'].includes(check)) {
      return this.fail(req, 'BAD_REQUEST', '--check 只支持 text-artifacts|i18n|overflow|broken-images|error-exposure');
    }
    const within = req.params?.within !== undefined ? String(req.params.within) : undefined;
    if (within && /^\[\d+\]$/.test(within)) {
      return this.fail(req, 'BAD_REQUEST', 'frame 内不支持 [N] 索引（无 frame 快照），先用 css=/role=/label=/text= 定位');
    }
    const frameDescRaw = req.params?.frame !== undefined ? String(req.params.frame) : undefined;
    let inspectCdp = cdp;
    let frameDesc: FrameDesc[] | undefined;
    let frameEvidence: { frame_id: string; url: string } | undefined;
    if (frameDescRaw) {
      try {
        const ctx = await this.observers!.resolveActiveFrameContext(frameDescRaw);
        inspectCdp = ctx.view;
        frameDesc = [ctx.desc];
        const identity = await readPageIdentity(ctx.channel.session, ctx.frameId);
        frameEvidence = { frame_id: identity.frame_id, url: redactUrl(identity.url) };
      } catch (e) {
        if (e instanceof FrameUnavailableError) return this.fail(req, 'FRAME_UNSUPPORTED', e.message);
        throw e;
      }
    }
    const scanned = await inspectUi({
      cdp: inspectCdp,
      resolveReq: () => null,
      getBodyInfo: () => undefined,
      readBody: () => null,
      currentUrl: async () => '',
    }, check, within);
    this.deps.trace({
      t: 'inspect',
      ts: Date.now(),
      ...(nt.getLastFinishedActionId() ? { after: nt.getLastFinishedActionId()! } : {}),
      ...(req.params?.group !== undefined ? { group: String(req.params.group) } : {}),
      check,
      ...(within ? { within } : {}),
      ...(frameDesc ? { frame: frameDesc } : {}),
      total: scanned.total,
      truncated: scanned.truncated,
      candidates: scanned.candidates,
      context: { target_id: this.page.activeId() ?? this.page.sourceId(), nav: nt.currentNav(), ...(frameEvidence ?? {}) },
    });
    return this.ok(req, { check, ...(within ? { within } : {}), ...(frameEvidence ? { frame: frameEvidence } : {}), total: scanned.total, truncated: scanned.truncated, candidates: scanned.candidates });
  }

  private async console(req: DaemonRequest): Promise<DaemonResponse> {
    if (this.stopped()) return this.fail(req, 'STOPPING', '会话正在停止');
    await this.attachConsole();
    const observers = this.observers;
    if (!observers?.hasActiveConsole()) return this.fail(req, 'NOT_READY', 'Console 观察器未就绪');
    const frameDescRaw = req.params?.frame !== undefined ? String(req.params.frame) : undefined;
    let frameId: string | undefined;
    if (frameDescRaw) {
      try { frameId = (await observers.resolveActiveFrameContext(frameDescRaw)).frameId; }
      catch (e) {
        if (e instanceof FrameUnavailableError) return this.fail(req, 'FRAME_UNSUPPORTED', e.message);
        throw e;
      }
    }
    const snapshot = await observers.consoleSnapshot();
    if (!snapshot) return this.fail(req, 'NOT_READY', 'Console 观察器未就绪');
    const selected = selectConsoleEntries(snapshot.snapshot, { scope: 'session', ...(frameId ? { frameId } : {}) });
    return this.ok(req, {
      active: snapshot.snapshot.active,
      complete: snapshot.complete,
      truncated: snapshot.snapshot.truncated,
      ...(frameId ? { frame_id: frameId } : {}),
      entries: selected.logs,
      incomplete: selected.incomplete,
    });
  }

  private async open(req: DaemonRequest, onWaitStarted: (deadlineMs: number) => void): Promise<DaemonResponse> {
    if (!String(req.params?.url ?? '')) return this.fail(req, 'BAD_REQUEST', '缺 url');
    await this.attachConsole();
    return this.deps.runner.run(req, 'open', onWaitStarted, async ({ cdp }) => {
      const actualUrl = String(req.params?.url ?? '');
      await navigate(cdp, actualUrl);
      await waitForLoad(cdp, NAV_TIMEOUT_MS);
      await new Promise((r) => setTimeout(r, SETTLE_MS));
      return { resolved_value: actualUrl };
    });
  }

  private async state(req: DaemonRequest): Promise<DaemonResponse> {
    const cdp = this.page.activeCdp();
    if (!cdp) return this.fail(req, 'NOT_READY', '浏览器会话未就绪');
    if (this.stopped()) return this.fail(req, 'STOPPING', '会话正在停止');
    const frameDescRaw = req.params?.frame !== undefined ? String(req.params.frame) : undefined;
    if (frameDescRaw) return this.frameState(req, cdp, frameDescRaw);
    const observedCdp = cdp;
    const observedTargetId = this.page.activeId() ?? this.page.sourceId();
    const observedNav = this.nt?.currentNav() ?? 'n0';
    const before = await readIdentity(observedCdp);
    if (!before) return this.fail(req, 'READ_UNAVAILABLE', '页面状态读取失败:无法取得主文档身份', '确认会话与页面存活后重试');
    const ps = await collectPageState(observedCdp, { debugAx: req.params?.debug_ax === true });
    const currentDom = await observedCdp.evaluate<number>('window.__e2etChangeCount || 0').catch(() => 0);
    const after = await readIdentity(observedCdp);
    if (this.isStale(observedCdp, observedTargetId, observedNav, before, after)) {
      return this.fail(req, 'STALE_CONTEXT', '页面上下文已变化（切换/关闭/导航/同 URL 重载），拒绝返回旧快照', '重新 page state 后再操作');
    }
    const seq = this.page.advanceSnapshot(currentDom);
    const pageSnap = digest(this.page.assignRefs(ps));
    return this.ok(req, { snapshot_id: seq.snapshotId, change_count: seq.changeCount, tabs: this.page.tabsDigest(), context: { target_id: observedTargetId, frame_id: before.frame_id, loader_id: before.loader_id, nav: observedNav, url: redactUrl(before.url), origin: before.origin }, ...pageSnap });
  }

  private async frameState(req: DaemonRequest, cdp: import('../browser/daemon-client.js').CdpSession, frameDescRaw: string): Promise<DaemonResponse> {
    const observedCdp = cdp;
    const observedTargetId = this.page.activeId() ?? this.page.sourceId();
    const observedNav = this.nt?.currentNav() ?? 'n0';
    let frameCtx;
    try { frameCtx = await this.observers!.resolveActiveFrameContext(frameDescRaw); }
    catch (e) {
      if (e instanceof FrameUnavailableError) return this.fail(req, 'FRAME_UNSUPPORTED', e.message, '先 page state 看 frames[]');
      throw e;
    }
    const before = await readPageIdentity(frameCtx.channel.session, frameCtx.frameId).catch(() => null);
    if (!before) return this.fail(req, 'READ_UNAVAILABLE', '页面状态读取失败:无法取得 frame 身份', '确认会话与页面存活后重试');
    let ps: PageState | undefined;
    let collectError: unknown;
    try { ps = await collectPageState(frameCtx.view, { debugAx: req.params?.debug_ax === true }); }
    catch (error) { collectError = error; }
    const after = await readPageIdentity(frameCtx.channel.session, frameCtx.frameId).catch(() => null);
    const stale = this.page.activeCdp() !== observedCdp
      || (this.page.activeId() ?? this.page.sourceId()) !== observedTargetId
      || (this.nt?.currentNav() ?? 'n0') !== observedNav
      || this.deps.lifecycleSnapshot().state !== 'running' || this.deps.lifecycleSnapshot().stopped
      || !after
      || after.frame_id !== before.frame_id || after.loader_id !== before.loader_id
      || after.url !== before.url || after.origin !== before.origin;
    if (stale) return this.fail(req, 'STALE_CONTEXT', '页面上下文已变化（切换/关闭/导航/同 URL 重载），拒绝返回旧快照', '重新 page state 后再操作');
    if (collectError || !ps) throw collectError ?? new Error('READ_UNAVAILABLE: frame 快照采集失败');
    const digestNoIndex = digest(ps);
    return this.ok(req, {
      frame: frameCtx.desc,
      context: { target_id: frameCtx.channel.targetId, frame_id: after.frame_id, loader_id: after.loader_id, nav: observedNav, url: redactUrl(after.url), origin: after.origin },
      ...digestNoIndex,
      elements: digestNoIndex.elements.map(({ index: _index, ...rest }) => rest),
    });
  }

  private isStale(observedCdp: import('../browser/daemon-client.js').CdpSession, observedTargetId: string, observedNav: string, before: { frame_id: string; loader_id: string; url: string; origin: string }, after: { frame_id: string; loader_id: string; url: string; origin: string } | null): boolean {
    const ls = this.deps.lifecycleSnapshot();
    return this.page.activeCdp() !== observedCdp
      || (this.page.activeId() ?? this.page.sourceId()) !== observedTargetId
      || (this.nt?.currentNav() ?? 'n0') !== observedNav
      || ls.state !== 'running' || ls.stopped
      || !after
      || after.frame_id !== before.frame_id || after.loader_id !== before.loader_id
      || after.url !== before.url || after.origin !== before.origin;
  }

  private async read(req: DaemonRequest): Promise<DaemonResponse> {
    const nt = this.nt;
    if (!this.page.activeCdp() || !nt) return this.fail(req, 'NOT_READY', '浏览器会话未就绪');
    if (this.stopped()) return this.fail(req, 'STOPPING', '会话正在停止');
    if (nt.isActionActive()) return this.fail(req, 'BUSY', 'action 执行中，暂不能读取页面数据（观察拒绝中间值）');
    const parsed = parsePageDataSourceParams(req.params);
    if (!parsed.ok) return this.fail(req, 'BAD_REQUEST', parsed.message);
    const group = req.params?.group !== undefined ? String(req.params.group) : undefined;
    const frameDescRaw = req.params?.frame !== undefined ? String(req.params.frame) : undefined;
    let frame: import('./page-observers.js').PageDataFrame | undefined;
    if (frameDescRaw) {
      try { frame = await this.observers!.resolvePageDataFrame(frameDescRaw); }
      catch (e) {
        if (e instanceof FrameUnavailableError) return this.fail(req, 'FRAME_UNSUPPORTED', e.message);
        throw e;
      }
    }
    const read = await this.observers!.readPageDataObserved(parsed.source, { after: nt.getLastFinishedActionId() ?? undefined, group }, frame);
    if (!read.ok) return this.fail(req, read.code, read.message, read.hint);
    return this.ok(req, { source: parsed.source, ...read.result, context: read.context });
  }

  private async execute(req: DaemonRequest): Promise<DaemonResponse> {
    const cdp = this.page.activeCdp();
    const nt = this.nt;
    if (!cdp || !nt) return this.fail(req, 'NOT_READY', '浏览器会话未就绪');
    if (this.stopped()) return this.fail(req, 'STOPPING', '会话正在停止');
    const stale = this.page.checkStaleIndex(req.params, req.id);
    if (stale) return stale;
    const expression = String(req.params?.expression ?? '');
    if (!expression) return this.fail(req, 'BAD_REQUEST', '缺 expression');
    const intent = String(req.params?.intent ?? '');
    if (!intent) return this.fail(req, 'BAD_REQUEST', '缺 intent');
    const awaitPromise = req.params?.await_promise === true;
    const action = nt.beginAction('execute', intent, { expression, await_promise: awaitPromise });
    if (!action) return this.fail(req, 'BUSY', '已有 action 正在执行');
    try {
      const result = await cdp.send<{
        result: { value?: unknown; type?: string; subtype?: string; unserializableValue?: string };
        exceptionDetails?: { text: string; exception?: { description?: string } };
      }>('Runtime.evaluate', {
        expression: `(() => {
          const value = (0, eval)(${JSON.stringify(expression)});
          const check = value => {
            const json = JSON.stringify(value, (_key, v) => {
              if (['undefined', 'function', 'symbol', 'bigint'].includes(typeof v)
                || (typeof v === 'number' && !Number.isFinite(v))
                || (v !== null && typeof v === 'object' && typeof v.then === 'function')) {
                throw new Error('表达式返回值不可 JSON 序列化；thenable 请显式使用 --await-promise');
              }
              return v;
            });
            return JSON.parse(json);
          };
          return ${awaitPromise} ? Promise.resolve(value).then(check) : check(value);
        })()`,
        returnByValue: true, awaitPromise,
      });
      requestContext.getStore()?.signal.throwIfAborted();
      if (result.exceptionDetails) {
        const message = redactText(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
        nt.finishAction(action, false, { error: { code: 'EXEC_ERROR', message } });
        return this.fail(req, 'EXEC_ERROR', message);
      }
      const remoteObj = result.result;
      if (remoteObj.subtype === 'promise' || remoteObj.unserializableValue !== undefined || remoteObj.value === undefined) {
        const message = `表达式返回值不可 JSON 序列化（type=${remoteObj.type ?? 'unknown'}），请返回 JSON-serializable 值`;
        nt.finishAction(action, false, { error: { code: 'EXEC_ERROR', message } });
        return this.fail(req, 'EXEC_ERROR', message);
      }
      const truncated = truncateResult(remoteObj.value);
      const shot = await this.saveScreenshot(cdp);
      requestContext.getStore()?.signal.throwIfAborted();
      const trace = nt.finishAction(action, true, { execute_result: truncated, ...(shot.path ? { screenshot_path: shot.path } : {}), ...(shot.error ? { screenshot_error: shot.error } : {}) });
      return this.ok(req, { ...trace, result: truncated, ...(shot.path ? { screenshot_path: shot.path } : {}), ...(shot.error ? { screenshot_error: shot.error } : {}) });
    } catch (e) {
      const signal = requestContext.getStore()?.signal;
      if (signal?.aborted) {
        const error = { code: 'REQUEST_CANCELLED', message: signal.reason.message };
        nt.finishAction(action, false, { error });
        return this.fail(req, error.code, error.message);
      }
      const message = redactText((e as Error).message);
      nt.finishAction(action, false, { error: { code: 'EXEC_ERROR', message } });
      return this.fail(req, 'EXEC_ERROR', message);
    }
  }

  private async screenshot(req: DaemonRequest): Promise<DaemonResponse> {
    const cdp = this.page.activeCdp();
    if (!cdp) return this.fail(req, 'NOT_READY', '浏览器会话未就绪');
    if (this.stopped()) return this.fail(req, 'STOPPING', '会话正在停止');
    const intent = String(req.params?.intent ?? '');
    if (!intent) return this.fail(req, 'BAD_REQUEST', '缺 intent');
    const fullPage = Boolean(req.params?.full_page);
    const group = req.params?.group !== undefined ? String(req.params.group) : undefined;
    const data = await captureScreenshot(cdp, fullPage);
    const buf = Buffer.from(data, 'base64');
    const file = this.writeScreenshot(buf);
    if (group) {
      this.deps.trace({ t: 'screenshot', after: this.nt?.getLastFinishedActionId() ?? '', group, path: file, full_page: fullPage });
    }
    return this.ok(req, { path: file, full_page: fullPage, bytes: buf.length });
  }

  private writeScreenshot(buf: Buffer): string {
    const shotsDir = path.join(e2etRoot(), 'workspace', 'screenshots');
    ensurePrivateDir(shotsDir, true);
    const uuid = crypto.randomUUID();
    const file = path.join(shotsDir, `${this.deps.sessionId}_${uuid}.png`);
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW, 0o600);
    try { fs.writeFileSync(fd, buf); } finally { fs.closeSync(fd); }
    return file;
  }

  private async saveScreenshot(cdp: import('../browser/daemon-client.js').CdpSession): Promise<{ path?: string; error?: string }> {
    try {
      const data = await captureScreenshot(cdp, false);
      return { path: this.writeScreenshot(Buffer.from(data, 'base64')) };
    } catch (e) {
      return { error: redactText((e as Error).message) };
    }
  }

  // ── 页面动作 ──
  private action(req: DaemonRequest, onWaitStarted: (deadlineMs: number) => void): Promise<DaemonResponse> {
    const runner = this.deps.runner;
    const page = this.page;
    switch (req.method) {
      case 'page.click':
        return runner.run(req, 'click', onWaitStarted, async ({ cdp, target }) => {
          const t = await page.resolveTargetInfo(target, cdp);
          await clickNode(cdp, t.backendNodeId);
          return { target: t };
        });
      case 'page.double_click':
        return runner.run(req, 'double_click', onWaitStarted, async ({ cdp, target }) => {
          const t = await page.resolveTargetInfo(target, cdp);
          await clickNode(cdp, t.backendNodeId, { clicks: 2 });
          return { target: t };
        });
      case 'page.fill':
        return runner.run(req, 'fill', onWaitStarted, async ({ cdp, target, recordInput }) => {
          const value = String(req.params?.value ?? '');
          const t = await page.resolveTargetInfo(target, cdp);
          await fillNode(cdp, t.backendNodeId, value, recordInput);
          return { target: t, resolved_value: value };
        });
      case 'page.type':
        return runner.run(req, 'type', onWaitStarted, async ({ cdp, target, recordInput }) => {
          const value = String(req.params?.value ?? '');
          const t = await page.resolveTargetInfo(target, cdp);
          await typeIntoNode(cdp, t.backendNodeId, value, recordInput);
          return { target: t, resolved_value: value };
        });
      case 'page.press':
        return runner.run(req, 'press', onWaitStarted, async ({ cdp }) => {
          await pressKey(cdp, String(req.params?.key ?? ''));
          return {};
        });
      case 'page.select':
        return runner.run(req, 'select', onWaitStarted, async ({ cdp, target }) => {
          const filterText = req.params?.filter_text !== undefined ? String(req.params.filter_text) : undefined;
          const option = String(req.params?.option ?? '');
          const t = await page.resolveTargetInfo(target, cdp);
          const { picked, selection } = await selectOption(cdp, t.backendNodeId, option, filterText);
          return { target: t, resolved_value: option, picked, selection };
        });
      case 'page.upload': {
        const files = parseStringList(req.params?.files);
        return runner.run(req, 'upload', onWaitStarted, async ({ cdp, target }) => {
          const t = await page.resolveTargetInfo(target, cdp);
          await uploadFiles(cdp, t.backendNodeId, files);
          return { target: t };
        });
      }
      case 'page.hover':
        return runner.run(req, 'hover', onWaitStarted, async ({ cdp, target }) => {
          const t = await page.resolveTargetInfo(target, cdp);
          page.setHover(await hoverNode(cdp, t.backendNodeId), t.backendNodeId);
          return { target: t };
        });
      case 'page.scroll': {
        const dirExplicit = req.params?.dir !== undefined;
        const dir = dirExplicit ? String(req.params!.dir) : 'down';
        const hasTarget = req.params?.target !== undefined && req.params?.target !== null;
        if (!hasTarget) req.params = { ...(req.params ?? {}), dir };
        return runner.run(req, 'scroll', onWaitStarted, async ({ cdp, target }) => {
          if (target && !dirExplicit) {
            const t = await page.resolveTargetInfo(target, cdp);
            const { moved } = await scrollNode(cdp, { target: t.backendNodeId });
            return { target: t, moved, output_value: String(moved) };
          }
          if (target) {
            const t = await page.resolveTargetInfo(target, cdp);
            const { moved } = await scrollNode(cdp, { target: t.backendNodeId, dir });
            return { target: t, direction: dir, moved, output_value: String(moved) };
          }
          const { moved } = await scrollNode(cdp, { dir });
          return { direction: dir, moved, output_value: String(moved) };
        });
      }
      case 'page.switch-tab': {
        if (!page.hasRegistry()) return Promise.resolve(this.fail(req, 'NOT_READY', '浏览器会话未就绪'));
        const rawIndex = req.params?.index !== undefined ? Number(req.params.index) : undefined;
        const urlContains = req.params?.url_contains !== undefined ? String(req.params.url_contains) : undefined;
        return runner.run(req, 'switch_tab', onWaitStarted, async () => {
          const tabs = page.readyTabs();
          const fromTargetId = page.activeId();
          const fromUrl = fromTargetId ? page.targetUrl(fromTargetId) : '';
          let resolved: { targetId: string; url: string; resolvedIndex: number } | null = null;
          if (urlContains) {
            const hit = tabs.find((t) => page.targetUrl(t.targetId).includes(urlContains));
            if (hit) resolved = { targetId: hit.targetId, url: page.targetUrl(hit.targetId), resolvedIndex: tabs.indexOf(hit) };
          } else if (rawIndex !== undefined) {
            const hit = tabs[rawIndex];
            if (hit) resolved = { targetId: hit.targetId, url: page.targetUrl(hit.targetId), resolvedIndex: rawIndex };
          } else {
            const last = tabs.filter((t) => t.targetId !== fromTargetId).at(-1);
            if (last) resolved = { targetId: last.targetId, url: page.targetUrl(last.targetId), resolvedIndex: tabs.indexOf(last) };
          }
          if (!resolved) {
            throw new TargetNotFoundError(urlContains ? `没有 URL 含 '${urlContains}' 的存活 tab` : (rawIndex !== undefined ? `tab 索引 ${rawIndex} 越界（当前 ${tabs.length} 个 ready tab）` : '没有可切换的非 active tab（当前仅 1 个 tab）'));
          }
          const switched = page.setActivePageWs(resolved.targetId);
          if (!switched) throw new Error('目标 tab 不可操作（已关闭或未 ready）');
          const urlEvidence = redactUrlWithEvidence(await page.activeCdp()!.evaluate<string>('location.href'));
          if (urlEvidence.redacted) throw new Error(AUTH_DATA_NOT_REPLAYABLE);
          return {
            output_value: urlEvidence.value,
            resolved_tab: { target_id: resolved.targetId, url: urlEvidence.value, resolved_index: resolved.resolvedIndex, ...(fromTargetId ? { from_target_id: fromTargetId } : {}) },
            switched_to: urlEvidence.value,
            target_id: resolved.targetId,
            resolved_index: resolved.resolvedIndex,
            from_target_id: fromTargetId,
            from_url: redactUrl(fromUrl),
            tabs: page.tabsDigest(),
          };
        });
      }
      case 'page.back':
        return runner.run(req, 'back', onWaitStarted, async ({ cdp }) => {
          await backHistory(cdp);
          const url = await cdp.evaluate<string>('location.href');
          const evidence = redactUrlWithEvidence(url);
          if (evidence.redacted) throw new Error(AUTH_DATA_NOT_REPLAYABLE);
          return { switched_to: url, output_value: url };
        });
      case 'page.refresh':
        return runner.run(req, 'refresh', onWaitStarted, async ({ cdp }) => {
          await refreshPage(cdp);
          const url = await cdp.evaluate<string>('location.href');
          const evidence = redactUrlWithEvidence(url);
          if (evidence.redacted) throw new Error(AUTH_DATA_NOT_REPLAYABLE);
          return { output_value: url };
        });
      case 'page.choose': {
        const options = Array.isArray(req.params?.options) ? req.params.options.map((o) => String(o)) : [];
        return runner.run(req, 'choose', onWaitStarted, async ({ cdp, target, recordSelection }) => {
          const filterText = req.params?.filter_text !== undefined ? String(req.params.filter_text) : undefined;
          const t = await page.resolveTargetInfo(target, cdp);
          const { picked, selection } = await chooseOptions(cdp, t.backendNodeId, options, filterText, recordSelection);
          return { target: t, picked, output_value: JSON.stringify(picked), selection };
        });
      }
      case 'page.date':
        return runner.run(req, 'date', onWaitStarted, async ({ cdp, target, recordInput }) => {
          const value = String(req.params?.value ?? '');
          const t = await page.resolveTargetInfo(target, cdp);
          const set = await setDateValue(cdp, t.backendNodeId, value, recordInput);
          return { target: t, value: set, resolved_value: value };
        });
      case 'page.category': {
        const pathValue = Array.isArray(req.params?.path) ? req.params.path.map((p) => String(p)) : [];
        return runner.run(req, 'category', onWaitStarted, async ({ cdp, target, recordSelection }) => {
          const t = await page.resolveTargetInfo(target, cdp);
          const { picked, selection } = await pickCategory(cdp, t.backendNodeId, pathValue, recordSelection);
          return { target: t, picked, output_value: JSON.stringify(picked), selection };
        });
      }
      case 'page.fill-form': {
        const scope = String(req.params?.scope ?? 'required') as 'required' | 'all' | 'targeted';
        const fields = parseFieldMap(req.params?.fields);
        const skip = parseStringList(req.params?.skip);
        return runner.run(req, 'fill_form', onWaitStarted, async ({ cdp, recordFilled, recordInput }) => {
          const getElements = async () => (await collectPageState(cdp)).elements;
          const filled = await fillFormByScope(cdp, { scope, fields, skip }, getElements, recordFilled, recordInput);
          return { filled, output_value: JSON.stringify(Object.fromEntries(filled.map((field) => [field.name, field.value]))) };
        });
      }
      default:
        return Promise.resolve(this.fail(req, 'UNKNOWN_METHOD', '未知方法: ' + req.method));
    }
  }
}

function redactErrorMessage(e: unknown): string {
  return redactText((e as Error).message);
}

async function readIdentity(cdp: import('../browser/daemon-client.js').CdpSession): Promise<{ frame_id: string; loader_id: string; url: string; origin: string } | null> {
  return readPageIdentity(cdp).catch(() => null);
}

/** page.execute 返回值截断保护：JSON.stringify 后超 100KB 的替换为截断标记对象。 */
function truncateResult(v: unknown): unknown {
  const sanitized = scrubValue(v);
  const json = JSON.stringify(sanitized);
  if (Buffer.byteLength(json, 'utf8') <= RESULT_MAX_BYTES) return sanitized;
  return {
    _truncated: true,
    original_type: v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v,
    preview: json.slice(0, RESULT_PREVIEW_CHARS),
  };
}

function parseStringList(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (Array.isArray(v)) return v.map(String);
  return [String(v)];
}

function parseFieldMap(v: unknown): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  if (v === undefined || v === null) return out;
  if (Array.isArray(v)) {
    for (const item of v) {
      const [k, ...rest] = String(item).split('=');
      if (k) out[k] = rest.join('=');
    }
    return out;
  }
  if (typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, String(val)]));
  return out;
}

/** 精简快照（沿用旧 browser_control.digest 的形态，去 backendNodeId 等内部字段）。 */
function digest(state: PageState) {
  return {
    url: state.url,
    title: state.title,
    busy: state.busy,
    container: state.container,
    ...(state.container_name ? { container_name: state.container_name } : {}),
    ...(state.truncated ? { truncated: true, total_elements: state.total_elements } : {}),
    messages: state.messages,
    elements: state.elements.map((e) => ({
      index: e.index,
      role: e.role,
      name: e.name,
      ...(e.value ? { value: e.value } : {}),
      ...(e.required ? { required: true } : {}),
      ...(e.disabled ? { disabled: true } : {}),
      ...(e.expanded !== undefined ? { expanded: e.expanded } : {}),
      ...(e.checked !== undefined ? { checked: e.checked } : {}),
      ...(e.fieldLabel ? { fieldLabel: e.fieldLabel } : {}),
    })),
    frames: state.frames,
    ...(state.debug_ax ? { debug_ax: state.debug_ax } : {}),
  };
}

export function parsePageDataSourceParams(params: Record<string, unknown> | undefined): { ok: true; source: import('../browser/page-data.js').PageDataSource } | { ok: false; message: string } {
  const ls = params?.local_storage;
  const gl = params?.global;
  const rawPath = params?.path;
  const hasLs = ls !== undefined && ls !== null;
  const hasG = gl !== undefined && gl !== null;
  if (hasLs === hasG) return { ok: false, message: '必须且只能指定一种数据源:--local-storage <key> 或 --global <name>' };
  if (hasLs) {
    const key = String(ls);
    if (key === '') return { ok: false, message: '--local-storage key 不能为空' };
    if (rawPath !== undefined && rawPath !== null) {
      const p = String(rawPath);
      if (p === '') return { ok: false, message: '--path 不能为空' };
      if (!isValidDotPath(p)) return { ok: false, message: '--path 只支持 dot path（如 record.mode / items.0.id），不支持 [] / 过滤 / 空段' };
      return { ok: true, source: { local_storage: key, path: p } };
    }
    return { ok: true, source: { local_storage: key } };
  }
  if (rawPath !== undefined && rawPath !== null) return { ok: false, message: '--path 只能与 --local-storage 一起使用' };
  const name = String(gl);
  if (name === '') return { ok: false, message: '--global name 不能为空' };
  return { ok: true, source: { global: name } };
}

