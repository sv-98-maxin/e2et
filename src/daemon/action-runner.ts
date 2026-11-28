/**
 * 动作事务 owner：dialog 策略/listener、准备 → 执行 → 等待 → 证据 → 提交/失败收口。
 * 保留 run(req, kind, onWaitStarted, exec) 合同；每次只传本动作数据与有限 owner 端口。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { CdpSession } from '../browser/daemon-client.js';
import { screenshot as captureScreenshot } from '../browser/interactions.js';
import { createFrameView, FrameUnavailableError } from '../browser/frame-view.js';
import {
  parseTargetSpec,
  type TargetSpec,
  type ResolvedTargetInfo,
  type SelectionRecorder,
  type FilledField,
} from '../browser/actions.js';
import { ACTION_OUTPUT_KINDS } from '../shared/types.js';
import type { InputCommit, InputCommitEvidence, RecordInputCallback } from '../shared/types.js';
import { InvalidRefError } from '../browser/assert.js';
import { TargetNotFoundError } from '../browser/interactions.js';
import { CdpReadError } from '../browser/page-state.js';
import { NetworkTrace, WaitApiFailure, type ActionValue, type SettledBy, type WaitSpec, type TraceAction } from './network-trace.js';
import { appendTraceEvent, ensurePrivateDir, redactText, redactUrlWithEvidence, storeTraceFile } from './trace.js';
import { e2etRoot } from './session-meta.js';
import { parseWaitTimeoutMs, DEFAULT_WAIT_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS } from '../wait-timeout.js';
import { isValidTemplate, renderTemplate } from '../value-template.js';
import { AUTH_DATA_NOT_REPLAYABLE } from '../shared/element-value.js';
import type { DialogPolicy, LifecycleSnapshot } from './session-types.js';
import type { DaemonRequest, DaemonResponse } from './protocol.js';
import type { PageContext } from './page-context.js';
import { resolveFrameId, type PageObservers } from './page-observers.js';
import type { SessionValues } from './session-values.js';
import { requestContext, releaseRequestInputs } from '../request-context.js';
import {
  ACTION_SETTLE_TIMEOUT_MS, DOM_IDLE_MS, NAV_TIMEOUT_MS, SETTLE_MS,
  parseWaitSpec, prepareWaitBindings, queryWaitTarget, readWaitValue, waitForDomIdle,
  type WaitBinding, type WaitDeps,
} from './action-waits.js';

const NO_FOLLOW = (fs.constants as unknown as Record<string, number>).O_NOFOLLOW ?? 0;

export interface ActionExecContext {
  cdp: CdpSession;
  target: TargetSpec | undefined;
  recordSelection: SelectionRecorder;
  recordFilled: (field: FilledField) => void;
  recordInput: RecordInputCallback;
}

export interface ActionRunnerDeps {
  sessionId: string;
  page: PageContext;
  observers: () => PageObservers | null;
  networkTrace: () => NetworkTrace | null;
  values: SessionValues;
  lifecycleSnapshot: () => Readonly<LifecycleSnapshot>;
}

export type DialogHandled = { kind: string; message: string; registered: boolean };

interface ActionPlan {
  args: Record<string, unknown>;
  targetSpec: TargetSpec | undefined;
  actionValue: ActionValue | undefined;
  resolvedValue: string | undefined;
  frameDesc: string | undefined;
  frameId: string | undefined;
  frameDescObj: import('../browser/page-state.js').FrameDesc[] | undefined;
  actionCdp: CdpSession;
  waitSpecEarly: WaitSpec | undefined;
  waitBindings: Map<string, WaitBinding>;
  declaredBudget: number | undefined;
  group: string | undefined;
  saveAs: string | undefined;
  dialogRaw: { accept: boolean; prompt_text?: string } | undefined;
  creates: { entity: string; path: string } | undefined;
}

export class ActionRunner {
  private currentDialogPolicy: DialogPolicy | undefined;
  private currentDialogRegistered = false;
  private dialogHandled: DialogHandled | undefined;
  private readonly dialogListeners = new Map<CdpSession, () => void>();

  constructor(private readonly deps: ActionRunnerDeps) {}

  /** 持久 dialog listener：覆盖 exec 与 wait；每 pageWs 只装一次。 */
  installDialogHandler(pageWs: CdpSession): void {
    if (this.dialogListeners.has(pageWs)) return;
    const off = pageWs.on('Page.javascriptDialogOpening', (params: any) => {
      const policy = this.currentDialogPolicy;
      const handle = (): void => {
        const registered = !!policy && this.currentDialogRegistered;
        const kind = String(params?.type ?? 'alert');
        const message = String(params?.message ?? '');
        const accept = !policy?.requestContext?.signal.aborted && (policy?.accept ?? false);
        if (policy) {
          this.dialogHandled = { kind, message, registered };
          this.deps.networkTrace()?.recordDialog(policy.actionId, kind, message, accept ? 'accept' : 'dismiss', registered);
        } else {
          appendTraceEvent(this.deps.sessionId, { t: 'dialog', kind, message: redactText(message), handled: 'dismiss', registered: false });
        }
        const pending = pageWs.send('Page.handleJavaScriptDialog', {
          accept,
          ...(accept && kind === 'prompt' && policy?.promptText !== undefined ? { promptText: policy.promptText } : {}),
        }).then(() => {}).catch(() => {
          if (policy) policy.handlingFailed = true;
          try {
            appendTraceEvent(this.deps.sessionId, { t: 'dialog_handling_error', ...(policy ? { after: policy.actionId } : {}), error: 'DIALOG_HANDLING_FAILED' });
          } catch { /* trace 已结束 */ }
        });
        if (policy) policy.pending.push(pending);
      };
      if (policy?.requestContext) requestContext.run(policy.requestContext, handle);
      else handle();
    });
    const cleanup = (): void => {
      off();
      this.dialogListeners.delete(pageWs);
    };
    this.dialogListeners.set(pageWs, cleanup);
    pageWs.onClose(cleanup);
  }

  removeDialogHandler(pageWs: CdpSession): void {
    this.dialogListeners.get(pageWs)?.();
  }

  clearDialogHandlers(): void {
    for (const off of this.dialogListeners.values()) off();
    this.dialogListeners.clear();
  }

  private stopped(): boolean {
    const ls = this.deps.lifecycleSnapshot();
    return ls.stopped || ls.state !== 'running';
  }

  async run(
    req: DaemonRequest,
    kind: string,
    onWaitStarted: (deadlineMs: number) => void,
    exec: (ctx: ActionExecContext) => Promise<{ target?: ResolvedTargetInfo; [k: string]: unknown }>,
  ): Promise<DaemonResponse> {
    requestContext.getStore()?.signal.throwIfAborted();
    const cdp = this.deps.page.activeCdp();
    if (!cdp || !this.deps.networkTrace()) return this.fail(req, 'NOT_READY', '浏览器会话未就绪');
    if (this.stopped()) return this.fail(req, 'STOPPING', '会话正在停止');
    const stale = this.deps.page.checkStaleIndex(req.params, req.id);
    if (stale) return stale;
    const prepared = await this.prepare(req, kind, cdp);
    requestContext.getStore()?.signal.throwIfAborted();
    if (!prepared.ok) return prepared.response;
    const plan = prepared.plan;
    const action = this.deps.networkTrace()!.beginAction(kind, String(req.params?.intent ?? ''), plan.args, {
      ...(plan.creates ? { creates: plan.creates } : {}),
      ...(plan.actionValue ? { value: plan.actionValue } : {}),
      ...(plan.saveAs ? { saveAs: plan.saveAs } : {}),
      ...(plan.frameDescObj ? { frame: plan.frameDescObj } : {}),
      ...(plan.dialogRaw ? { dialog: { accept: plan.dialogRaw.accept, ...(plan.dialogRaw.prompt_text !== undefined ? { prompt_text: plan.dialogRaw.prompt_text } : {}) } } : {}),
      ...(plan.group ? { group: plan.group } : {}),
    });
    if (!action) return this.fail(req, 'BUSY', '已有 action 正在执行');
    const dialogPolicy: DialogPolicy = {
      actionId: action.id,
      accept: plan.dialogRaw?.accept ?? false,
      ...(plan.dialogRaw?.prompt_text !== undefined ? { promptText: plan.dialogRaw.prompt_text } : {}),
      pending: [],
      handlingFailed: false,
      requestContext: requestContext.getStore(),
    };
    this.currentDialogPolicy = dialogPolicy;
    this.currentDialogRegistered = !!plan.dialogRaw;
    this.dialogHandled = undefined;
    const recorders = this.createRecorders(plan.args);
    const prevChangeCount = this.deps.page.changeCount();
    let cleanupPending: Promise<boolean> | undefined;
    const cleanup = (): Promise<boolean> => cleanupPending ??= (async () => {
      let cleaned = await releaseRequestInputs();
      for (const commit of recorders.inputCommits) {
        try { await commit.dispose(); }
        catch (error) { cleaned = false; console.error('❌ input handle cleanup:', error); }
      }
      for (const pending of dialogPolicy.pending) {
        try { await pending; } catch { cleaned = false; }
      }
      if (dialogPolicy.handlingFailed) cleaned = false;
      return cleaned;
    })();
    try {
      return await this.executeTransaction(req, kind, plan, action, dialogPolicy, recorders, prevChangeCount, onWaitStarted, exec);
    } catch (error) {
      const cleaned = await cleanup();
      if (this.currentDialogPolicy === dialogPolicy) this.currentDialogPolicy = undefined;
      return this.finishFailure(req, kind, action, error, cleaned);
    } finally {
      await cleanup();
      if (this.currentDialogPolicy === dialogPolicy) this.currentDialogPolicy = undefined;
    }
  }

  // ── 准备：守卫/参数/值槽/frame ──
  private async prepare(req: DaemonRequest, kind: string, cdp: CdpSession): Promise<{ ok: true; plan: ActionPlan } | { ok: false; response: DaemonResponse }> {
    const intent = String(req.params?.intent ?? '');
    if (!intent) return { ok: false, response: this.fail(req, 'BAD_REQUEST', '缺 intent') };
    const kindCheck = this.checkKindParams(req, kind);
    if (kindCheck) return { ok: false, response: kindCheck };
    if (req.params?.value_ref === '') {
      return { ok: false, response: this.fail(req, 'BAD_REQUEST', 'value_ref 变量名为空', '提供前序 capture 的变量名，或省略 --value-ref') };
    }
    const targetRaw = req.params?.target;
    const targetSpec = targetRaw !== undefined && targetRaw !== null ? parseTargetSpec(targetRaw) : undefined;
    if (targetRaw !== undefined && targetRaw !== null && !targetSpec) {
      return { ok: false, response: this.fail(req, 'BAD_TARGET', '无法解析 target: ' + String(targetRaw)) };
    }
    const args = this.buildArgs(req, kind, targetSpec);
    const createsRaw = req.params?.creates as { entity: string; path: string } | undefined;
    const creates = createsRaw?.entity && createsRaw?.path ? createsRaw : undefined;
    const dialogRaw = (req.params?.dialog ?? (req.params?.dialog_accept !== undefined ? { accept: Boolean(req.params?.dialog_accept), prompt_text: req.params?.dialog_prompt_text as string | undefined } : undefined)) as { accept: boolean; prompt_text?: string } | undefined;
    const frameDesc = req.params?.frame !== undefined ? String(req.params.frame) : undefined;
    const saveAs = req.params?.save_as !== undefined ? String(req.params.save_as) : undefined;
    if (saveAs !== undefined && !ACTION_OUTPUT_KINDS.includes(kind)) {
      return { ok: false, response: this.fail(req, 'BAD_REQUEST', `${kind} 无输出值，不支持 --save-as`, '有输出的动作: open/type/fill/select/date/choose/category/fill_form/scroll/back/refresh') };
    }
    const valueTemplate = req.params?.value_template !== undefined ? String(req.params.value_template) : undefined;
    if (valueTemplate !== undefined && !isValidTemplate(valueTemplate)) return { ok: false, response: this.fail(req, 'BAD_REQUEST', 'template 含不支持的占位符或缺生成占位符') };
    const valueRef = req.params?.value_ref !== undefined ? String(req.params.value_ref) : undefined;
    let declaredBudget: number | undefined;
    if (req.params?.wait_timeout_ms !== undefined) {
      try { declaredBudget = parseWaitTimeoutMs(req.params.wait_timeout_ms); }
      catch (e) { return { ok: false, response: this.fail(req, 'BAD_REQUEST', (e as Error).message) }; }
    }
    if (frameDesc && (kind === 'back' || kind === 'refresh')) {
      return { ok: false, response: this.fail(req, 'BAD_REQUEST', `${kind} 与 --frame 互斥（${kind} 导航整个页面，不能在 iframe 作用域内执行）`) };
    }
    const waitSpecEarly = parseWaitSpec(req.params);
    if (frameDesc && waitSpecEarly) {
      for (const waitTarget of [waitSpecEarly.element, waitSpecEarly.gone]) {
        if (waitTarget === undefined) continue;
        if (parseTargetSpec(waitTarget)?.kind === 'index') {
          return { ok: false, response: this.fail(req, 'BAD_REQUEST', 'frame 内不支持 wait_element/wait_gone 的 [N] 索引（无 frame 快照），先用 css=/text= 定位', '用 css=... 或 text=...') };
        }
      }
    }
    const resolved = this.resolveValueSlot(req, kind, args, valueRef, valueTemplate);
    if ('response' in resolved) return { ok: false, response: resolved.response };
    if (kind === 'open' && resolved.value !== undefined) {
      const urlEvidence = redactUrlWithEvidence(resolved.value);
      if (urlEvidence.redacted) {
        return { ok: false, response: this.fail(req, AUTH_DATA_NOT_REPLAYABLE, 'URL 含认证来源字段（userinfo/query/hash 实际被改写），拒绝执行', '去掉凭证后重试') };
      }
      args.url = urlEvidence.value;
    }
    const frame = await this.resolveFrame(req, cdp, frameDesc, targetSpec);
    if ('response' in frame) return { ok: false, response: frame.response };
    const bindings = await prepareWaitBindings(this.waitDeps(), waitSpecEarly, kind, frame.actionCdp, declaredBudget);
    if (!bindings.ok) return { ok: false, response: this.fail(req, bindings.error.code, bindings.error.message) };
    if (dialogRaw) args.dialog = { accept: dialogRaw.accept, ...(dialogRaw.prompt_text !== undefined ? { prompt_text: dialogRaw.prompt_text } : {}) };
    return {
      ok: true,
      plan: {
        args, targetSpec,
        actionValue: resolved.actionValue, resolvedValue: resolved.value,
        frameDesc, frameId: frame.frameId, frameDescObj: frame.frameDescObj, actionCdp: frame.actionCdp,
        waitSpecEarly, waitBindings: bindings.bindings, declaredBudget,
        group: req.params?.group !== undefined ? String(req.params.group) : undefined,
        saveAs, dialogRaw, creates,
      },
    };
  }

  private checkKindParams(req: DaemonRequest, kind: string): DaemonResponse | null {
    if (kind !== 'switch_tab') return null;
    if (req.params?.save_as !== undefined && (typeof req.params.save_as !== 'string' || !req.params.save_as.trim())) {
      return this.fail(req, 'BAD_REQUEST', '--save-as 需要非空字符串变量名');
    }
    if (req.params?.value_ref !== undefined || req.params?.value_template !== undefined) {
      return this.fail(req, 'BAD_REQUEST', 'switch_tab 无输入值槽，不支持 --value-ref/--value-template');
    }
    if (req.params?.frame !== undefined) {
      return this.fail(req, 'BAD_REQUEST', 'switch_tab 与 --frame 互斥（切换整个页面）');
    }
    for (const waitTarget of [req.params?.wait_element, req.params?.wait_gone]) {
      if (waitTarget !== undefined && parseTargetSpec(String(waitTarget))?.kind === 'index') {
        return this.fail(req, 'BAD_REQUEST', 'switch_tab 等待不能使用切换前的 [N] 引用，请用 css=/text= 定位目标页');
      }
    }
    return null;
  }

  private buildArgs(req: DaemonRequest, kind: string, targetSpec: TargetSpec | undefined): Record<string, unknown> {
    const args: Record<string, unknown> = {};
    if (kind === 'switch_tab') {
      if (req.params?.index !== undefined) args.index = Number(req.params.index);
      if (req.params?.url_contains !== undefined) args.url_contains = String(req.params.url_contains);
    }
    if (targetSpec) args.target = targetSpec;
    const valueSlot = this.valueSlotOf(kind);
    if (valueSlot === undefined) {
      if (req.params?.value !== undefined) args.value = String(req.params.value);
      if (req.params?.option !== undefined) args.option = String(req.params.option);
    }
    if (req.params?.key !== undefined) args.key = String(req.params.key);
    if (req.params?.dir !== undefined) args.direction = String(req.params.dir);
    if (req.params?.files !== undefined) args.files = parseStringList(req.params.files).map((file) => ({ name: path.basename(file), blob_ref: storeTraceFile(this.deps.sessionId, file) }));
    if (req.params?.wait_api !== undefined) args.wait_api = String(req.params.wait_api);
    if (kind === 'choose' || kind === 'category' || kind === 'select') {
      if (req.params?.filter_text !== undefined) args.filter_text = String(req.params.filter_text);
    }
    if (kind === 'choose' && Array.isArray(req.params?.options)) args.options = req.params.options.map((o) => String(o));
    if (kind === 'category' && Array.isArray(req.params?.path)) args.path = req.params.path.map((p) => String(p));
    return args;
  }

  private valueSlotOf(kind: string): 'url' | 'option' | 'value' | undefined {
    return kind === 'open' ? 'url' : kind === 'select' ? 'option'
      : (kind === 'type' || kind === 'fill' || kind === 'date') ? 'value' : undefined;
  }

  private resolveValueSlot(req: DaemonRequest, kind: string, args: Record<string, unknown>, valueRef: string | undefined, valueTemplate: string | undefined):
    { actionValue: ActionValue | undefined; value: string | undefined } | { response: DaemonResponse } {
    const valueSlot = this.valueSlotOf(kind);
    if (!valueSlot) {
      if (valueRef || valueTemplate) return { response: this.fail(req, 'BAD_REQUEST', `${kind} 无输入值槽，不支持 --value-ref/--value-template`) };
      return { actionValue: undefined, value: undefined };
    }
    let actionValue: ActionValue | undefined;
    let resolvedValue: string | undefined;
    if (valueRef) {
      const v = this.deps.values.getVarEntry(valueRef);
      if (v === undefined) return { response: this.fail(req, 'BAD_REQUEST', '未定义的变量引用: ' + valueRef, '前序步骤需 --save-as') };
      resolvedValue = v.value;
      actionValue = { raw: v.value, origin: 'captured', ref: valueRef };
    } else if (valueTemplate) {
      const v = renderTemplate(valueTemplate);
      resolvedValue = v;
      actionValue = { raw: v, origin: 'generated', template: valueTemplate };
    } else if (req.params?.[valueSlot] !== undefined) {
      resolvedValue = String(req.params[valueSlot]);
      actionValue = { raw: resolvedValue, origin: 'literal' };
    }
    if (resolvedValue !== undefined) {
      req.params = { ...req.params, [valueSlot]: resolvedValue };
      args[valueSlot] = resolvedValue;
    }
    return { actionValue, value: resolvedValue };
  }

  private async resolveFrame(
    req: DaemonRequest, cdp: CdpSession, frameDesc: string | undefined, targetSpec: TargetSpec | undefined,
  ): Promise<{ frameId: string | undefined; frameDescObj: import('../browser/page-state.js').FrameDesc[] | undefined; actionCdp: CdpSession } | { response: DaemonResponse }> {
    let actionCdp = cdp;
    if (!frameDesc) return { frameId: undefined, frameDescObj: undefined, actionCdp };
    const observers = this.deps.observers();
    if (!observers) return { response: this.fail(req, 'NOT_READY', '浏览器会话未就绪') };
    const r = await resolveFrameId(cdp, frameDesc, observers.oopifFrameHints(undefined), observers.hasActiveConsole() ? (candidate: string) => observers.hasDefaultContext(candidate) : undefined);
    if (!r) return { response: this.fail(req, 'BAD_FRAME', '找不到匹配的 iframe: ' + frameDesc, '先 page state 看 frames[]') };
    const frameDescObj = [r.desc];
    if (targetSpec?.kind === 'index') {
      return { response: this.fail(req, 'BAD_REQUEST', 'frame 内不支持 [N] 索引（无 frame 快照），先用 css=/text= 定位', '用 --target css=... 或 text=...') };
    }
    try {
      const channel = await observers.selectFrameChannel(this.deps.page.activeId() ?? this.deps.page.sourceId(), r.frameId, Date.now() + 30_000);
      actionCdp = await createFrameView(channel.session, r.frameId);
    } catch (e) {
      if (e instanceof FrameUnavailableError) {
        return { response: this.fail(req, 'FRAME_UNSUPPORTED', e.message, '跨域 iframe(OOPIF)或 frame 已失效') };
      }
      throw e;
    }
    return { frameId: r.frameId, frameDescObj, actionCdp };
  }

  private createRecorders(args: Record<string, unknown>): {
    recordSelection: SelectionRecorder;
    recordFilled: (field: FilledField) => void;
    recordInput: RecordInputCallback;
    inputCommits: InputCommit[];
  } {
    const recordSelection: SelectionRecorder = (scope, pick) => {
      if (!args.selection || typeof args.selection !== 'object') {
        args.selection = { scope, picks: [] };
      }
      (args.selection as { picks: unknown[] }).picks.push(pick);
    };
    const recordFilled: (field: FilledField) => void = (field) => {
      if (!args.fields || typeof args.fields !== 'object') {
        args.fields = Object.create(null);
        args.field_targets = Object.create(null);
        args.field_order = [];
      }
      (args.fields as Record<string, { raw: string; origin: 'literal' }>)[field.name] = { raw: field.value, origin: 'literal' };
      (args.field_targets as Record<string, ResolvedTargetInfo>)[field.name] = field.target;
      (args.field_order as string[]).push(field.name);
    };
    const inputCommits: InputCommit[] = [];
    const recordInput: RecordInputCallback = (commit) => { inputCommits.push(commit); };
    return { recordSelection, recordFilled, recordInput, inputCommits };
  }

  private waitDeps(): WaitDeps {
    return { page: this.deps.page, observers: this.deps.observers };
  }

  // ── 执行 + 等待 + 证据 ──
  private async executeTransaction(
    req: DaemonRequest,
    kind: string,
    plan: ActionPlan,
    action: TraceAction,
    dialogPolicy: DialogPolicy,
    recorders: ReturnType<ActionRunner['createRecorders']>,
    prevChangeCount: number,
    onWaitStarted: (deadlineMs: number) => void,
    exec: (ctx: ActionExecContext) => Promise<{ target?: ResolvedTargetInfo; [k: string]: unknown }>,
  ): Promise<DaemonResponse> {
    const nt = this.deps.networkTrace()!;
    const { args, actionValue } = plan;
    requestContext.getStore()?.signal.throwIfAborted();
    if (kind === 'open') {
      const waitAllowance = plan.waitSpecEarly ? (plan.declaredBudget ?? DEFAULT_WAIT_TIMEOUT_MS) : ACTION_SETTLE_TIMEOUT_MS;
      onWaitStarted(Date.now() + DEFAULT_REQUEST_TIMEOUT_MS + NAV_TIMEOUT_MS + SETTLE_MS * 2 + waitAllowance + DOM_IDLE_MS * 4);
    }
    if (this.deps.page.hasHover()) {
      const navigation = ['hover', 'back', 'refresh', 'switch_tab'].includes(kind);
      const next = !navigation && plan.targetSpec ? await this.deps.page.resolveTargetInfo(plan.targetSpec, plan.actionCdp) : undefined;
      if (navigation || !next || !await this.deps.page.withinHover(next.backendNodeId)) await this.deps.page.clearHover(action.id, plan.group);
    }
    const execRes = await exec({ cdp: plan.actionCdp, target: plan.targetSpec, recordSelection: recorders.recordSelection, recordFilled: recorders.recordFilled, recordInput: recorders.recordInput });
    requestContext.getStore()?.signal.throwIfAborted();
    if (kind === 'switch_tab') this.recordSwitchTab(args, execRes);
    if (kind === 'select' && execRes.selection && typeof execRes.selection === 'object') args.selection = execRes.selection;
    const execResolved = this.valueSlotOf(kind) ? (execRes as Record<string, unknown>).resolved_value : undefined;
    if (actionValue && this.valueSlotOf(kind) && (typeof execResolved !== 'string' || execResolved !== actionValue.raw)) {
      return this.valueContractFailure(req, nt, action, `exec 实际输入与公共渲染值不一致 (action ${action.id})`, '输入值在执行链被改写，拒绝发布');
    }
    let execOutputValue = typeof (execRes as Record<string, unknown>).output_value === 'string' ? ((execRes as Record<string, unknown>).output_value as string) : undefined;
    if (kind === 'fill_form' && Array.isArray(execRes.filled)) {
      args.scope = req.params?.scope ?? 'required';
      args.skip = parseStringList(req.params?.skip);
    }
    if (kind === 'scroll' && typeof (execRes as Record<string, unknown>).moved === 'boolean') {
      args.moved = (execRes as Record<string, unknown>).moved;
    }
    const waited = await this.waitForCompletion(req, kind, plan, action, recorders.inputCommits, onWaitStarted, nt);
    requestContext.getStore()?.signal.throwIfAborted();
    if ('response' in waited) return waited.response;
    const { settledBy, timedOut, waitSpec } = waited;
    const cdp = this.deps.page.activeCdp()!;
    const ps = await collectPageStateForRunner(cdp);
    requestContext.getStore()?.signal.throwIfAborted();
    const currentDom = await cdp.evaluate<number>('window.__e2etChangeCount || 0').catch(() => 0);
    requestContext.getStore()?.signal.throwIfAborted();
    this.deps.page.advanceChangeCount(currentDom);
    const pageChanged = this.deps.page.changeCount() > prevChangeCount;
    const execTarget = execRes.target;
    for (const pending of dialogPolicy.pending) await pending;
    requestContext.getStore()?.signal.throwIfAborted();
    if (dialogPolicy.handlingFailed) throw new Error('DIALOG_HANDLING_FAILED');
    const commitOutcome = await this.commitSuccess(req, kind, plan, action, execRes, execResolved, execOutputValue, settledBy, timedOut, waitSpec, recorders.inputCommits, dialogPolicy);
    requestContext.getStore()?.signal.throwIfAborted();
    if ('response' in commitOutcome) return commitOutcome.response;
    execOutputValue = commitOutcome.execOutputValue;
    return this.buildSuccessResponse(req, plan, execRes, execTarget, timedOut, pageChanged, ps, commitOutcome.savedVar);
  }

  private recordSwitchTab(args: Record<string, unknown>, execRes: { [k: string]: unknown }): void {
    const resolvedTab = execRes.resolved_tab as { target_id: string; url: string; resolved_index: number; from_target_id?: string };
    args.resolved_index = resolvedTab.resolved_index;
    args.target_id = resolvedTab.target_id;
    args.resolved_url = resolvedTab.url;
    args.from_target_id = resolvedTab.from_target_id;
    args.to_target_id = resolvedTab.target_id;
  }

  private async waitForCompletion(
    req: DaemonRequest,
    kind: string,
    plan: ActionPlan,
    action: TraceAction,
    inputCommits: InputCommit[],
    onWaitStarted: (deadlineMs: number) => void,
    nt: NetworkTrace,
  ): Promise<{ settledBy: SettledBy[]; timedOut: boolean; waitSpec: WaitSpec | undefined } | { response: DaemonResponse }> {
    let apiFailed: { ref: string; reason: string } | undefined;
    const waitSpec = plan.waitSpecEarly;
    let timeout = false;
    let timedOut = false;
    let settledBy: SettledBy[] | undefined;
    if (waitSpec) {
      const budget = plan.declaredBudget ?? DEFAULT_WAIT_TIMEOUT_MS;
      plan.args.wait_timeout_ms = budget;
      const deadline = Date.now() + budget;
      if (kind !== 'open') onWaitStarted(deadline);
      let explicit: SettledBy[];
      try {
        explicit = await nt.waitForExplicit(action, waitSpec, {
          queryTarget: (raw, deadlineMs) => queryWaitTarget(this.waitDeps(), plan.frameDescObj?.[0], plan.waitBindings, raw, deadlineMs),
          readText: (deadlineMs) => readWaitValue(this.waitDeps(), plan.frameDescObj?.[0], deadlineMs, 'document.body.innerText', '等待文本读取失败'),
          readUrl: (deadlineMs) => readWaitValue(this.waitDeps(), plan.frameDescObj?.[0], deadlineMs, 'location.href', '等待 URL 读取失败'),
        }, deadline);
      } catch (e) {
        if (e instanceof WaitApiFailure) {
          apiFailed = { ref: e.ref, reason: e.reason };
          explicit = [{ kind: 'timeout', ms: Date.now() - action.ts }];
        } else {
          throw e;
        }
      }
      settledBy = explicit;
      if (explicit.some((e) => e.kind === 'timeout')) timeout = true;
    } else {
      const auto = await nt.waitForActionRequests(action, ACTION_SETTLE_TIMEOUT_MS);
      settledBy = auto.settled_by;
      timedOut = auto.timedOut;
      if (inputCommits.length > 0 && timedOut) timeout = true;
      if (action.waitRequestIds.length === 0) {
        await waitForDomIdle(this.deps.page.activeCdp()!, DOM_IDLE_MS);
        settledBy.push({ kind: 'dom_quiet', ms: Date.now() - action.ts, quiet_ms: DOM_IDLE_MS });
      }
    }
    requestContext.getStore()?.signal.throwIfAborted();
    if (apiFailed) {
      nt.finishAction(action, false, { settled_by: settledBy, error: { code: 'WAIT_API_FAILED', message: `接口等待失败: ${apiFailed.ref} (${apiFailed.reason})`, hint: '目标请求 transport 失败（loadingFailed），检查接口可用性' } });
      return { response: { id: req.id, ok: false, error: { code: 'WAIT_API_FAILED', message: `接口等待失败: ${apiFailed.ref} (${apiFailed.reason})`, hint: '目标请求 transport 失败（loadingFailed），检查接口可用性', settled_by: settledBy } } as DaemonResponse };
    }
    if (timeout) {
      const message = waitSpec ? '显式等待超时' : '输入动作自动等待超时';
      const hint = waitSpec ? '检查 --wait-* 条件是否可达' : '请求尚未 settled，无法证明输入动作完成';
      nt.finishAction(action, false, { settled_by: settledBy, error: { code: 'WAIT_TIMEOUT', message, hint } });
      return { response: { id: req.id, ok: false, error: { code: 'WAIT_TIMEOUT', message, hint, settled_by: settledBy } } as DaemonResponse };
    }
    return { settledBy: settledBy!, timedOut, waitSpec };
  }

  private async commitSuccess(
    req: DaemonRequest, kind: string, plan: ActionPlan, action: TraceAction,
    execRes: { [k: string]: unknown }, execResolved: unknown, execOutputValue: string | undefined,
    settledBy: SettledBy[], timedOut: boolean, waitSpec: WaitSpec | undefined,
    inputCommits: InputCommit[], dialogPolicy: DialogPolicy,
  ): Promise<{ savedVar: { name: string; value: string } | undefined; execOutputValue: string | undefined } | { response: DaemonResponse }> {
    const nt = this.deps.networkTrace()!;
    const args = plan.args;
    requestContext.getStore()?.signal.throwIfAborted();
    if (kind === 'switch_tab') {
      const urlEvidence = redactUrlWithEvidence(await this.deps.page.activeCdp()!.evaluate<string>('location.href'));
      requestContext.getStore()?.signal.throwIfAborted();
      if (urlEvidence.redacted) throw new Error(AUTH_DATA_NOT_REPLAYABLE);
      execOutputValue = urlEvidence.value;
      execRes.output_value = urlEvidence.value;
      execRes.switched_to = urlEvidence.value;
      (execRes.resolved_tab as { url: string }).url = urlEvidence.value;
      args.resolved_url = urlEvidence.value;
      execRes.tabs = this.deps.page.tabsDigest();
      for (const pending of dialogPolicy.pending) await pending;
      if (dialogPolicy.handlingFailed) throw new Error('DIALOG_HANDLING_FAILED');
    }
    const inputCommitEvidence: InputCommitEvidence[] = [];
    for (const commit of inputCommits) {
      const evidence = await commit.verify();
      requestContext.getStore()?.signal.throwIfAborted();
      inputCommitEvidence.push({ ...evidence, phase: 'after-wait' });
      args.input_commits = inputCommitEvidence;
    }
    let savedVar: { name: string; value: string } | undefined;
    if (plan.saveAs) {
      const boundValue = execOutputValue ?? plan.resolvedValue;
      if (boundValue === undefined) {
        return { response: this.valueContractFailure(req, nt, action, `save_as "${plan.saveAs}" 需要绑定值但动作未产出 resolvedValue (action: ${action.id})`, `${kind} 不提供输入值，不能 save_as`) };
      }
      savedVar = { name: plan.saveAs, value: boundValue };
    }
    const screenshot = await this.captureScreenshotQuietly();
    requestContext.getStore()?.signal.throwIfAborted();
    if (plan.actionValue && this.valueSlotOf(kind) && typeof execResolved === 'string' && execResolved === plan.actionValue.raw) {
      this.deps.values.publishActionValue(action.id, plan.actionValue);
    }
    if (savedVar) this.deps.values.setVar(savedVar.name, { value: savedVar.value, origin: plan.actionValue?.origin ?? 'literal' });
    const trace = nt.finishAction(action, true, {
      ...(kind === 'switch_tab' ? { resolved_tab: execRes.resolved_tab as { target_id: string; url: string; resolved_index: number; from_target_id?: string } } : {}),
      settled_by: settledBy,
      ...(execRes.target ? { target: execRes.target } : {}),
      ...(typeof execResolved === 'string' ? { resolved_value: execResolved } : {}),
      ...(execOutputValue !== undefined ? { output_value: execOutputValue } : {}),
      ...(savedVar ? { saved_value: savedVar.value } : {}),
      ...(plan.actionValue ? { source_action: action.id } : {}),
      ...(screenshot.path ? { screenshot_path: screenshot.path } : {}),
      ...(screenshot.error ? { screenshot_error: screenshot.error } : {}),
      ...(screenshot.startedAt !== undefined ? { screenshot_started_at: screenshot.startedAt, screenshot_ended_at: screenshot.endedAt } : {}),
    });
    (execRes as Record<string, unknown>).__trace = trace;
    (execRes as Record<string, unknown>).__screenshot = screenshot;
    (execRes as Record<string, unknown>).__timedOut = timedOut;
    (execRes as Record<string, unknown>).__waitSpec = waitSpec;
    return { savedVar, execOutputValue };
  }

  private buildSuccessResponse(
    req: DaemonRequest,
    plan: ActionPlan, execRes: { [k: string]: unknown },
    execTarget: ResolvedTargetInfo | undefined, timedOut: boolean,
    pageChanged: boolean, ps: import('../browser/page-state.js').PageState,
    savedVar: { name: string; value: string } | undefined,
  ): DaemonResponse {
    const trace = (execRes as Record<string, unknown>).__trace as Record<string, unknown>;
    const inputCommitEvidence = (plan.args.input_commits as InputCommitEvidence[] | undefined) ?? [];
    const { target: _execTarget, __trace, __screenshot, __timedOut, __waitSpec, ...execRest } = execRes as Record<string, unknown>;
    return {
      id: req.id,
      ok: true,
      data: {
        ...trace,
        ...(execTarget ? { target: execTarget } : {}),
        ...execRest,
        ...(inputCommitEvidence.length > 0 ? { input_commits: inputCommitEvidence } : {}),
        page_changed: pageChanged,
        change_count: this.deps.page.changeCount(),
        ...(timedOut ? { timeout: true } : {}),
        ...(savedVar ? { saved: savedVar } : {}),
        ...(this.dialogHandled ? { dialog: this.dialogHandled } : {}),
        ...(plan.frameDesc ? { frame_resolved: plan.frameId ?? false } : {}),
        ...digestPageState(ps),
      },
    } as DaemonResponse;
  }

  // ── 失败收口 ──
  private finishFailure(req: DaemonRequest, kind: string, action: TraceAction, error: unknown, cleaned: boolean): DaemonResponse {
    const nt = this.deps.networkTrace()!;
    const signal = requestContext.getStore()?.signal;
    if (signal?.aborted) {
      const cancelled = { code: 'REQUEST_CANCELLED', message: signal.reason.message, hint: cleaned ? '禁止自动重试，先检查会话状态和 trace' : '请求资源清理失败；执行结果未知，禁止自动重试，检查会话状态和 trace' };
      action.error = cancelled;
      nt.finishAction(action, false, { error: cancelled });
      return { id: req.id, ok: false, error: cancelled };
    }
    const msg = (error as Error).message;
    if (msg === AUTH_DATA_NOT_REPLAYABLE) {
      action.args = {};
      if (action.value) {
        action.value = { raw: '[REDACTED]', origin: action.value.origin, ...(action.value.template !== undefined ? { template: '[REDACTED]' } : {}), ...(action.value.ref !== undefined ? { ref: action.value.ref } : {}) };
      }
      action.replayable = false;
      const authError = { code: AUTH_DATA_NOT_REPLAYABLE, message: kind === 'switch_tab' ? '目标页 URL 含认证来源字段，拒绝发布输出' : '目标为凭证通道（密码控件），拒绝写入', hint: kind === 'switch_tab' ? '去掉 URL 凭证后重试' : '不要对密码控件录制输入' };
      action.error = authError;
      nt.finishAction(action, false, { error: authError });
      return { id: req.id, ok: false, error: { ...authError } } as DaemonResponse;
    }
    const completedWaits = (error as { settled_by?: SettledBy[] }).settled_by;
    const daemonError = this.classifyError(msg, error);
    action.error = daemonError;
    nt.finishAction(action, false, completedWaits ? { settled_by: completedWaits, error: daemonError } : { error: daemonError });
    if (msg === 'DIALOG_HANDLING_FAILED') {
      return { id: req.id, ok: false, error: { code: 'DIALOG_HANDLING_FAILED', message: 'DIALOG_HANDLING_FAILED', ...(completedWaits ? { settled_by: completedWaits } : {}) } } as DaemonResponse;
    }
    const stableCode = /^(FILL_NOT_COMMITTED|SELECTION_NOT_COMMITTED|SELECTION_TARGET_CHANGED|NOT_INTERACTABLE)(?::|$)/.exec(msg)?.[1];
    if (stableCode) {
      const inputFailure = error as { expected?: string; actual?: unknown; target?: unknown };
      return {
        id: req.id,
        ok: false,
        error: {
          code: stableCode,
          message: redactText(msg),
          ...(completedWaits ? { settled_by: completedWaits } : {}),
          ...(Object.hasOwn(error as object, 'expected') ? { expected: inputFailure.expected } : {}),
          ...(Object.hasOwn(error as object, 'actual') ? { actual: inputFailure.actual } : {}),
          ...(Object.hasOwn(error as object, 'target') ? { target: inputFailure.target } : {}),
        },
      } as DaemonResponse;
    }
    if (error instanceof CdpReadError) throw new Error(kind + ' 失败: ' + redactText(msg));
    if (error instanceof InvalidRefError || error instanceof TargetNotFoundError) {
      return { id: req.id, ok: false, error: { code: 'NOT_FOUND', message: redactText(msg) } } as DaemonResponse;
    }
    if (msg.startsWith('BAD_REQUEST:') || (error as { code?: string }).code === 'BAD_REQUEST') {
      return { id: req.id, ok: false, error: { code: 'BAD_REQUEST', message: redactText(msg) } } as DaemonResponse;
    }
    if (msg.startsWith('OPTION_NOT_FOUND') || msg.startsWith('OPTION_POOL_DECLARED_MISSING')) {
      return { id: req.id, ok: false, error: { code: 'NOT_FOUND', message: redactText(msg) } } as DaemonResponse;
    }
    if (msg.startsWith('OPTION_AMBIGUOUS') || msg.startsWith('OPTION_POOL_DECLARED_AMBIGUOUS') || msg.startsWith('OPTION_MULTIPLE_ON_SINGLE')) {
      return { id: req.id, ok: false, error: { code: 'BAD_REQUEST', message: redactText(msg) } } as DaemonResponse;
    }
    if (msg.startsWith('BAD_REQUEST')) return { id: req.id, ok: false, error: { code: 'BAD_REQUEST', message: redactText(msg) } } as DaemonResponse;
    if (msg.startsWith('INSUFFICIENT_EVIDENCE')) return { id: req.id, ok: false, error: { code: 'INSUFFICIENT_EVIDENCE', message: redactText(msg) } } as DaemonResponse;
    if (msg.includes('禁用') || msg.includes('不可见')) return { id: req.id, ok: false, error: { code: 'NOT_INTERACTABLE', message: redactText(msg) } } as DaemonResponse;
    throw new Error(kind + ' 失败: ' + redactText(msg));
  }

  private classifyError(msg: string, error: unknown): { code: string; message: string } {
    if (msg === 'DIALOG_HANDLING_FAILED') return { code: 'DIALOG_HANDLING_FAILED', message: 'DIALOG_HANDLING_FAILED' };
    const stable = /^(FILL_NOT_COMMITTED|SELECTION_NOT_COMMITTED|SELECTION_TARGET_CHANGED|NOT_INTERACTABLE)(?::|$)/.exec(msg)?.[1];
    if (stable) return { code: stable, message: redactText(msg) };
    if (error instanceof InvalidRefError || error instanceof TargetNotFoundError) return { code: 'NOT_FOUND', message: redactText(msg) };
    if (msg.startsWith('BAD_REQUEST:') || (error as { code?: string }).code === 'BAD_REQUEST') return { code: 'BAD_REQUEST', message: redactText(msg) };
    if (msg.startsWith('OPTION_NOT_FOUND') || msg.startsWith('OPTION_POOL_DECLARED_MISSING')) return { code: 'NOT_FOUND', message: redactText(msg) };
    if (msg.startsWith('OPTION_AMBIGUOUS') || msg.startsWith('OPTION_POOL_DECLARED_AMBIGUOUS') || msg.startsWith('OPTION_MULTIPLE_ON_SINGLE')) return { code: 'BAD_REQUEST', message: redactText(msg) };
    if (msg.startsWith('BAD_REQUEST')) return { code: 'BAD_REQUEST', message: redactText(msg) };
    if (msg.startsWith('INSUFFICIENT_EVIDENCE')) return { code: 'INSUFFICIENT_EVIDENCE', message: redactText(msg) };
    if (msg.includes('禁用') || msg.includes('不可见')) return { code: 'NOT_INTERACTABLE', message: redactText(msg) };
    return { code: 'DAEMON_ERROR', message: redactText(msg) };
  }

  private valueContractFailure(req: DaemonRequest, nt: NetworkTrace, action: TraceAction, message: string, hint: string): DaemonResponse {
    action.replayable = false;
    action.error = { code: 'VALUE_CONTRACT_MISMATCH', message, hint };
    nt.finishAction(action, false, { error: action.error });
    return { id: req.id, ok: false, error: { code: 'VALUE_CONTRACT_MISMATCH', message, hint } };
  }

  private async captureScreenshotQuietly(): Promise<{ path?: string; error?: string; startedAt?: number; endedAt?: number }> {
    const cdp = this.deps.page.activeCdp();
    if (!cdp) return { error: 'NO_ACTIVE_PAGE' };
    const startedAt = Date.now();
    try {
      let data: string;
      try { data = await captureScreenshot(cdp, true); }
      catch { data = await captureScreenshot(cdp, false); }
      const buf = Buffer.from(data, 'base64');
      const shotsDir = path.join(e2etRoot(), 'workspace', 'screenshots');
      ensurePrivateDir(shotsDir, true);
      const uuid = crypto.randomUUID();
      const file = path.join(shotsDir, `${this.deps.sessionId}_${uuid}.png`);
      const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW, 0o600);
      try { fs.writeFileSync(fd, buf); } finally { fs.closeSync(fd); }
      return { path: file, startedAt, endedAt: Date.now() };
    } catch (e) {
      return { error: redactText((e as Error).message), startedAt, endedAt: Date.now() };
    }
  }

  private fail(req: DaemonRequest, code: string, message: string, hint?: string): DaemonResponse {
    return { id: req.id, ok: false, error: { code, message, ...(hint ? { hint } : {}) } };
  }
}

async function collectPageStateForRunner(cdp: CdpSession): Promise<import('../browser/page-state.js').PageState> {
  const { collectPageState } = await import('../browser/page-state.js');
  return collectPageState(cdp);
}

function parseStringList(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (Array.isArray(v)) return v.map(String);
  return [String(v)];
}

function digestPageState(state: import('../browser/page-state.js').PageState) {
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
