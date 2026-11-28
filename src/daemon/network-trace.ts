import type { CdpSession } from '../browser/daemon-client.js';
import type { FrameDesc } from '../browser/page-state.js';
import type { ResolvedTargetInfo } from '../browser/actions.js';
import { NetworkNavigationTracker, type NetworkNavigationState } from '../shared/network-navigation.js';
import {
  appendTraceEvent,
  redactText,
  redactUrl,
  redactUrlWithEvidence,
  storeTraceBody,
} from './trace.js';
import { redactHeaders, redactedHeaderKeys } from '../shared/headers.js';
import { requestContext } from '../request-context.js';

type TraceCdpSession = Pick<CdpSession, 'on' | 'send'>;

interface RequestData {
  url: string;
  method: string;
  headers?: Record<string, unknown>;
  postData?: string;
  hasPostData?: boolean;
}

interface ResponseData {
  status?: number;
  headers?: Record<string, unknown>;
  mimeType?: string;
}

interface RequestHop {
  id: string;
  /** 逻辑 page owner（source/popup），不是 CDP child transport target。 */
  targetId: string;
  /** start 实际所在的 CDP transport target：root page 或 OOPIF child。 */
  transportTargetId: string;
  cdpRequestId: string;
  frameId?: string;
  request: RequestData;
  resourceType: string;
  path: string;
  nav: string;
  callIndex: number;
  started: number;
  triggeredBy: string | null;
  mainDocument: boolean;
  /** 本请求是否被 --creates 标记（path 匹配 action.creates.path 才置） */
  creates?: string;
  postData?: Promise<string | undefined>;
  /** onLoadingFinished 时立即发起的 getResponseBody promise（与 postData 同模式） */
  responseBody?: Promise<{ body?: string; base64Encoded?: boolean } | null>;
  response?: ResponseData;
}

type ResponseBodyMode = 'fetch' | 'unavailable' | 'none';

/** 单个 target 的 trace 分区状态：独立 mainFrame / currentUrl / currentNav，
 *  共用全局 requestSeq/actionSeq 分配器（保证 r/a 全会话唯一）与共源导航分配器（n 唯一）。 */
interface TargetState extends NetworkNavigationState {
  targetId: string;
  cdp: TraceCdpSession;
  /** 该 target 是否为源/root tab（不可移除，switch 不改 source） */
  isSource: boolean;
  /** 非_source 首次主文档导航已提交 → 后续 doc nav 用 same_page（仅首次 new_tab）。 */
  firstNavEmitted: boolean;
  offListeners: Array<() => void>;
  /** per-target 导航代数：主文档 frameNavigated / same-document / pending nav 提交时递增。
   *  initialize 在 CDP 读前后对比此值，识别 getFrameTree 快照是否被后续导航事件淘汰。 */
  navGen: number;
}

interface FrameChannelState {
  ownerTargetId: string;
  targetId: string;
  frameId: string;
  cdp: TraceCdpSession;
  offListeners: Array<() => void>;
}

export interface ActionCreates {
  entity: string;
  path: string;
}

export interface ActionValue {
  raw: string;
  origin: 'literal' | 'generated' | 'captured';
  template?: string;
  ref?: string;
}

export interface TraceAction {
  id: string;
  ts: number;
  intent: string;
  kind: string;
  args: Record<string, unknown>;
  requests: string[];
  /** 语义等待身份：本次 action 需要等待的独立 trace rID；redirect 原位换成终链 rID。 */
  waitRequestIds: string[];
  navigations: string[];
  /** --creates 标注：仅 path 匹配的本 action 触发请求带 creates */
  creates?: ActionCreates;
  /** --value-template / --value-ref 渲染后的值，写进 trace action.value */
  value?: ActionValue;
  /** --save-as 变量名，写进 trace action.save_as */
  saveAs?: string;
  /** --frame 描述（可跨会话重放），写进 trace action.frame。结构化 FrameDesc[] */
  frame?: FrameDesc[];
  /** --dialog 预登记，写进 trace action.args.dialog */
  dialog?: { accept: boolean; prompt_text?: string };
  /** --group：步骤分组标签，报告按此折叠 */
  group?: string;
  /** F2：本动作可回放事实（来源改写 → false）。beginAction 构造时显式写 extra?.replayable ?? true；
  *  finishAction 只传递不重新判断；失败路径可置 false，不能凭 ok 清除。 */
  replayable: boolean;
  /** 本动作执行的 target（beginAction 时从 active target 记录）。其他 target 的后台请求不偷继承 creates/等待。 */
  targetId?: string;
  /** 失败原因：ok=false 时必须填，编译期强制写脱敏错误 */
  error?: { code: string; message: string; hint?: string };
  /** switch-tab 真实目标证据（不是 DOM element target）：target_id/url/resolved_index/from_target_id。
   *  IR build/check 据此区分真实 switch 与旧假 history switch。 */
  resolved_tab?: { target_id: string; url: string; resolved_index: number; from_target_id?: string };
}

export interface SettledBy {
  kind: 'request' | 'timeout' | 'dom_quiet' | 'element' | 'element_gone' | 'text' | 'url';
  ref?: string;
  ms: number;
  quiet_ms?: number;
  target?: string;
  resolved?: ResolvedTargetInfo;
  locator?: import('../shared/types.js').Locator;
  identity?: import('../shared/types.js').RefIdentity;
  observation?: import('../browser/locator-query.js').LocatorObservation;
  text?: string;
  url?: string;
}

export interface WaitSpec {
  /** 多个 path 共用同一 deadline，逐个等 settle（逗号分隔输入） */
  apis?: Array<{ path: string; nth?: number }>;
  element?: string;
  gone?: string;
  text?: string;
  url?: string;
}

export interface RequestSummary {
  id: string;
  path: string;
  nav: string;
  call_index: number;
  status?: number;
  target_id?: string;
  /** 实际写入 trace 的安全 URL（未改写时保留原串） */
  url?: string;
  /** URL 是否被实际脱敏改写；true 时 query 不得作为可回放断言证据 */
  url_redacted?: boolean;
  /** 终端失败原因（loadingFailed），同步设置；不成功响应。 */
  failed?: string;
  /** 安全响应头（小写名）与实际被改写头名；header 断言只认未改写证据。 */
  resp_headers?: Record<string, string>;
  resp_headers_redacted?: string[];
}

/** 显式 API 等待命中请求的终端失败（loadingFailed）。daemon 映射为 WAIT_API_FAILED。 */
export class WaitApiFailure extends Error {
  ref: string;
  reason: string;
  constructor(ref: string, reason: string) {
    super(`❌ 接口等待失败: ${ref} (${reason})`);
    this.name = 'WaitApiFailure';
    this.ref = ref;
    this.reason = reason;
  }
}

const ALLOWED_TYPES = new Set(['xhr', 'fetch', 'document']);
const BODY_READ_TIMEOUT_MS = 1_000;
const TRACE_FLUSH_TIMEOUT_MS = 5_000;
const IGNORED_URLS = [
  /\.(png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot)(\?|$)/i,
  /\/arms-retcode\//i,
  /\/collect\?/i,
  /\/tracker\//i,
  /\/beacon\//i,
  /google-analytics/i,
];

/** 源 target 默认 id（测试直接 new NetworkTrace(sid, cdp) 不传 targetId 时用）。 */
const SOURCE_TARGET_ID = '__source__';

function shouldTrack(resourceType: string, url: string): boolean {
  if (!ALLOWED_TYPES.has(resourceType.toLowerCase())) return false;
  if (!/^https?:\/\//i.test(url)) return false;
  return !IGNORED_URLS.some((pattern) => pattern.test(url));
}

function requestPath(url: string): string {
  try { return new URL(url).pathname; } catch { return url.split('?', 1)[0]; }
}

function contentType(headers: Record<string, unknown> | undefined, fallback = ''): string {
  const entry = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === 'content-type');
  return entry ? String(entry[1]) : fallback;
}

function eventTime(wallTime: unknown): number {
  return typeof wallTime === 'number' && Number.isFinite(wallTime) ? Math.round(wallTime * 1000) : Date.now();
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<{ ok: true; value: T } | { ok: false; error?: unknown }> {
  return await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false }), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve({ ok: true, value }); },
      (error) => { clearTimeout(timer); resolve({ ok: false, error }); },
    );
  });
}

/** 轮询条件直到 truthy 或 deadline。truthy 必须在 deadline 内返回才接受；过期后的 truthy 不放行。
 *  fn 抛错直接传播（协议/输入错误不当“条件未满足”重试，调用方按语义自行区分）。 */
async function pollUntil(fn: () => Promise<boolean>, deadline: number): Promise<boolean> {
  const signal = requestContext.getStore()?.signal;
  signal?.throwIfAborted();
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const last = await fn();
    signal?.throwIfAborted();
    if (last && Date.now() < deadline) return true;
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, Math.min(100, Math.max(0, deadline - Date.now()))));
  }
  signal?.throwIfAborted();
  return false;
}

/** 复合键：cdpRequestId 是页面作用域，跨 target 会重号，必须带 targetId 限定。 */
function compositeKey(targetId: string, cdpRequestId: string): string {
  return targetId + ':' + cdpRequestId;
}

export class NetworkTrace {
  private requestSeq = 0;
  private actionSeq = 0;
  private activeAction: TraceAction | null = null;
  /** 共源导航分配器/规则：navSeq/pendingNavigations map 由其 state.pendingNavigation 替换 */
  private nav = new NetworkNavigationTracker();
  private inflight = new Map<string, RequestHop>();
  private callIndexes = new Map<string, number>();
  private summaries = new Map<string, RequestSummary>();
  /** rID -> terminal/detach/redirect 终态时间；等待只看这个账本。 */
  private settledAt = new Map<string, number>();
  private completionListeners = new Set<() => void>();
  private work: Promise<void> = Promise.resolve();
  private workFailed = false;
  private cancelled = false;
  /** 最近一个 finishAction 的 action.id,assert/capture 挂 after 用。无 action 时 null。 */
  private lastFinishedActionId: string | null = null;
  private lastFinishedActionGroup: string | undefined;
  /** 请求 id → {req_body_ref, resp_body_ref, creates?, failed?},assert/capture 读 body 用。 */
  private bodyRefs = new Map<string, { req_body_ref?: string; resp_body_ref?: string; req_body_omitted?: string; resp_body_omitted?: string; creates?: string; failed?: string | null; status?: number; req_body_redacted_paths?: string[][]; resp_body_redacted_paths?: string[][] }>();

  /** target 分区：source 固定，popup 增量注册；active 决定 currentNav()/action.nav 归属。 */
  private targets = new Map<string, TargetState>();
  private frameChannels = new Map<string, FrameChannelState>();
  private terminalAliases = new Map<string, string>();
  private activeTargetId: string;
  private readonly sourceTargetId: string;

  constructor(
    private readonly sessionId: string,
    cdp: TraceCdpSession,
    sourceTargetId: string = SOURCE_TARGET_ID,
  ) {
    this.sourceTargetId = sourceTargetId;
    this.activeTargetId = sourceTargetId;
    // 源 target 初始 nav = n0（与单 target 旧实现一致）
    this.targets.set(sourceTargetId, {
      targetId: sourceTargetId, cdp, mainFrameId: null, currentUrl: 'about:blank',
      currentNavId: 'n0', isSource: true, firstNavEmitted: false, offListeners: [], navGen: 0,
    });
  }

  install(): void {
    this.installListeners(this.sourceTargetId);
  }

  /** 在指定 target 的 cdp 上注册 Network/Page 事件监听（popup attach 后增量调用）。
   *  必须在 Network.enable / runIfWaitingForDebugger 之前完成，否则首批请求事件丢失。 */
  private installListeners(targetId: string): void {
    const state = this.targets.get(targetId);
    if (!state) return;
    const cdp = state.cdp;
    const off: Array<() => void> = [];
    off.push(cdp.on('Network.requestWillBeSent', (params: any) => this.onRequestWillBeSent(params, targetId, targetId, cdp, true)));
    off.push(cdp.on('Network.responseReceived', (params: any) => this.onResponseReceived(params, targetId, targetId, true)));
    off.push(cdp.on('Network.loadingFinished', (params: any) => this.onLoadingFinished(params, targetId, targetId, cdp, true)));
    off.push(cdp.on('Network.loadingFailed', (params: any) => this.onLoadingFailed(params, targetId, targetId, true)));
    off.push(cdp.on('Page.frameNavigated', (params: any) => this.onFrameNavigated(params, targetId)));
    off.push(cdp.on('Page.navigatedWithinDocument', (params: any) => this.onNavigatedWithinDocument(params, targetId)));
    state.offListeners = off;
  }

  /** CDP Page.getFrameTree 读取 + navGen CAS 写快照。
 *  读取期间临时观测 same-document 事件，CAS 通过后用观测值替代旧快照 URL。 */
  async initialize(targetId: string): Promise<void> {
    const state = this.targets.get(targetId);
    if (!state) return;
    const genBefore = state.navGen;
    // 读取期间 same-document 事件可能先于续体到达，按 frameId 保留观测 URL
    const sameDocObserved = new Map<string, string>();
    const onSameDoc = (params: any) => {
      if (params?.frameId && params?.url) sameDocObserved.set(String(params.frameId), String(params.url));
    };
    const offSameDoc = state.cdp.on('Page.navigatedWithinDocument', onSameDoc);
    let frameTree: { frameTree?: { frame?: { id?: string; url?: string; urlFragment?: string } } } = {};
    try {
      frameTree = await state.cdp.send<{ frameTree?: { frame?: { id?: string; url?: string; urlFragment?: string } } }>('Page.getFrameTree');
    } finally {
      offSameDoc();
    }
    const frame = frameTree.frameTree?.frame;
    // CAS：旧快照不覆盖新 frame 事实
    if (this.cancelled || this.targets.get(targetId) !== state || state.navGen !== genBefore) return;
    if (frame?.id) state.mainFrameId = String(frame.id);
    // 临时观测中有同 frameId 的 same-document URL → 用观测值替代旧快照
    const observedUrl = frame?.id ? sameDocObserved.get(String(frame.id)) : undefined;
    if (observedUrl) {
      state.currentUrl = observedUrl;
    } else if (frame?.url) {
      // CDP Frame.url 不含 fragment，urlFragment 单独字段（含 '#'）；拼接完整 URL
      state.currentUrl = String(frame.url) + String(frame.urlFragment ?? '');
    }
  }

  async enable(): Promise<void> {
    await this.targets.get(this.sourceTargetId)!.cdp.send('Network.enable');
  }

  /** 注册新 target（popup）。分配独立初始 nav（全局 navSeq 保证唯一），不改 source/currentNav。
   *  只装监听；Page.enable / Network.enable 由调用方在 resume 前发到该 target 的 pageWS。 */
  addTarget(targetId: string, cdp: TraceCdpSession, mainFrameId?: string, url?: string): void {
    if (this.targets.has(targetId)) return;
    const initialNav = this.nav.next();
    this.targets.set(targetId, {
      targetId, cdp, mainFrameId: mainFrameId ?? null,
      currentUrl: url ?? 'about:blank', currentNavId: initialNav,
      isSource: false, firstNavEmitted: false, offListeners: [], navGen: 0,
    });
    this.installListeners(targetId);
  }

  addFrameChannel(ownerTargetId: string, targetId: string, cdp: TraceCdpSession, frameId: string): void {
    if (!ownerTargetId || !targetId || !frameId || this.frameChannels.has(targetId)) return;
    if (!this.targets.has(ownerTargetId)) throw new Error('FRAME_CHANNEL_OWNER_UNAVAILABLE');
    const state: FrameChannelState = { ownerTargetId, targetId, frameId, cdp, offListeners: [] };
    state.offListeners.push(cdp.on('Network.requestWillBeSent', (params: any) => this.onRequestWillBeSent(params, ownerTargetId, targetId, cdp, false, frameId)));
    state.offListeners.push(cdp.on('Network.responseReceived', (params: any) => this.onResponseReceived(params, ownerTargetId, targetId, false, frameId)));
    state.offListeners.push(cdp.on('Network.loadingFinished', (params: any) => this.onLoadingFinished(params, ownerTargetId, targetId, cdp, false, frameId)));
    state.offListeners.push(cdp.on('Network.loadingFailed', (params: any) => this.onLoadingFailed(params, ownerTargetId, targetId, false, frameId)));
    this.frameChannels.set(targetId, state);
  }

  removeFrameChannel(targetId: string): void {
    const state = this.frameChannels.get(targetId);
    if (!state) return;
    for (const off of state.offListeners) { try { off(); } catch {} }
    this.frameChannels.delete(targetId);
    const prefix = targetId + ':';
    for (const [key, primary] of [...this.terminalAliases]) {
      if (!key.startsWith(prefix) && !primary.startsWith(prefix)) continue;
      if (primary.startsWith(prefix)) {
        const hop = this.inflight.get(primary);
        if (hop) this.failHop(primary, hop, 'FRAME_CHANNEL_DETACHED');
      }
      this.terminalAliases.delete(key);
    }
    for (const [key, hop] of [...this.inflight]) {
      const inChannel = hop.transportTargetId === targetId;
      const parentDocument = hop.targetId === state.ownerTargetId
        && hop.frameId === state.frameId
        && hop.resourceType.toLowerCase() === 'document';
      if (inChannel || parentDocument) this.failHop(key, hop, 'FRAME_CHANNEL_DETACHED');
    }
  }

  /** 切换 active target：影响 currentNav()/action.nav 与 path shorthand 默认归属。
   *  不改 source target（source 固定保留，switch 回源即 setActive(source)）。 */
  setActiveTarget(targetId: string): boolean {
    if (!this.targets.has(targetId)) return false;
    this.activeTargetId = targetId;
    return true;
  }

  getActiveTargetId(): string {
    return this.activeTargetId;
  }

  getSourceTargetId(): string {
    return this.sourceTargetId;
  }

  hasTarget(targetId: string): boolean {
    return this.targets.has(targetId);
  }

  getTargetUrl(targetId: string): string | undefined {
    return this.targets.get(targetId)?.currentUrl;
  }

  /** 移除 target：卸载监听（popup 关闭 / detach）。source 不可移除。 */
  removeTarget(targetId: string): void {
    const state = this.targets.get(targetId);
    if (!state || state.isSource) return;
    for (const off of state.offListeners) { try { off(); } catch {} }
    state.offListeners = [];
    // 在途 hop 是真实终态，不删证据：标记 TARGET_CLOSED 并结算后通知 waiter。
    for (const [key, hop] of [...this.inflight]) {
      if (hop.targetId === targetId) this.failHop(key, hop, 'TARGET_CLOSED');
    }
    for (const channel of [...this.frameChannels.values()]) {
      if (channel.ownerTargetId === targetId) this.removeFrameChannel(channel.targetId);
    }
    for (const [key, primary] of [...this.terminalAliases]) {
      if (key.startsWith(targetId + ':') || primary.startsWith(targetId + ':')) {
        this.terminalAliases.delete(key);
      }
    }
    // 清该 target 的 pendingNavigations（不留失去 target 的待提交导航，不误提交到其他 target）
    delete state.pendingNavigation;
    this.targets.delete(targetId);
    if (this.activeTargetId === targetId) this.activeTargetId = this.sourceTargetId;
  }

  /** 所有 target 的 cdp（waitForActionRequests/waitForExplicit 跨 target 监听 settle 用）。 */
  private allCdps(): TraceCdpSession[] {
    return [...this.targets.values()].map((s) => s.cdp);
  }

  currentNav(): string {
    const state = this.targets.get(this.activeTargetId);
    return state ? state.currentNavId : 'n0';
  }

  isActionActive(): boolean {
    return this.activeAction !== null;
  }

  /** 当前正在执行的 action id；无 action 时 null（console 归因用）。 */
  getActiveActionId(): string | null {
    return this.activeAction?.id ?? null;
  }

  beginAction(
    kind: string,
    intent: string,
    args: Record<string, unknown> = {},
    extra?: {
      creates?: ActionCreates;
      value?: ActionValue;
      saveAs?: string;
      frame?: FrameDesc[];
      dialog?: { accept: boolean; prompt_text?: string };
      group?: string;
      replayable?: boolean;
    },
  ): TraceAction | null {
    if (this.activeAction) return null;
    const action: TraceAction = {
      id: 'a' + ++this.actionSeq,
      ts: Date.now(),
      intent: redactText(intent),
      kind,
      args,
      requests: [],
      waitRequestIds: [],
      navigations: [],
      targetId: this.activeTargetId,
      replayable: extra?.replayable ?? true,
      ...(extra?.creates ? { creates: extra.creates } : {}),
      ...(extra?.value ? { value: extra.value } : {}),
      ...(extra?.saveAs ? { saveAs: extra.saveAs } : {}),
      ...(extra?.frame ? { frame: extra.frame } : {}),
      ...(extra?.dialog ? { dialog: extra.dialog } : {}),
      ...(extra?.group ? { group: extra.group } : {}),
    };
    this.activeAction = action;
    return action;
  }

  finishAction(
    action: TraceAction,
    ok: boolean,
    extra?: { settled_by?: SettledBy[]; target?: unknown; creates?: string; execute_result?: unknown; screenshot_path?: string; screenshot_error?: string; screenshot_started_at?: number; screenshot_ended_at?: number; resolved_tab?: { target_id: string; url: string; resolved_index: number; from_target_id?: string }; resolved_value?: string; output_value?: string; saved_value?: string; source_action?: string; error?: { code: string; message: string; hint?: string } },
  ): { action_id: string; requests: RequestSummary[]; navigation: string | null; settled_by: SettledBy[] } {
    const signal = requestContext.getStore()?.signal;
    if (signal?.aborted) {
      ok = false;
      action.error = { code: 'REQUEST_CANCELLED', message: signal.reason.message, ...(extra?.error?.hint ? { hint: extra.error.hint } : {}) };
      extra = { ...extra, error: action.error };
    }
    if (this.activeAction === action) this.activeAction = null;
    this.lastFinishedActionId = action.id;
    this.lastFinishedActionGroup = action.group;
    appendTraceEvent(this.sessionId, {
      t: 'action',
      id: action.id,
      ts: action.ts,
      ts_end: Date.now(),
      kind: action.kind,
      intent: action.intent,
      nav: this.currentNav(),
      args: action.args,
      result: ok
        ? { ok: true } as const
        : { ok: false, error: extra?.error ?? action.error ?? { code: 'UNKNOWN', message: '未记录错误原因' } },
      ...(extra?.execute_result !== undefined ? { execute_result: extra.execute_result } : {}),
      requests: action.requests,
      ...(extra?.settled_by ? { settled_by: extra.settled_by } : {}),
      ...(extra?.target ? { target: extra.target } : {}),
      ...(extra?.resolved_tab ? { resolved_tab: extra.resolved_tab } : {}),
      ...(action.value ? { value: action.value } : {}),
      ...(action.saveAs ? { save_as: action.saveAs } : {}),
      ...(action.frame ? { frame: action.frame } : {}),
      ...(action.creates ? { creates: action.creates } : {}),
      ...(action.group ? { group: action.group } : {}),
      ...(extra?.screenshot_path ? { screenshot_path: extra.screenshot_path } : {}),
      ...(extra?.screenshot_error ? { screenshot_error: extra.screenshot_error } : {}),
      ...(extra?.screenshot_started_at !== undefined ? { screenshot_started_at: extra.screenshot_started_at } : {}),
      ...(extra?.screenshot_ended_at !== undefined ? { screenshot_ended_at: extra.screenshot_ended_at } : {}),
      ...(extra?.resolved_value !== undefined ? { resolved_value: extra.resolved_value } : {}),
      ...(extra?.output_value !== undefined ? { output_value: extra.output_value } : {}),
      ...(extra?.saved_value !== undefined ? { saved_value: extra.saved_value } : {}),
      ...(extra?.source_action !== undefined ? { source_action: extra.source_action } : {}),
      replayable: action.replayable,
    });
    return {
      action_id: action.id,
      requests: action.requests.map((id) => this.summaries.get(id)).filter((item): item is RequestSummary => !!item),
      navigation: action.navigations.at(-1) ?? null,
      settled_by: extra?.settled_by ?? [],
    };
  }

  /** 等本 action 的 waitRequestIds 全部终态，返回 settled_by。
   *  只订阅本对象完成通知，每次通知重读 live waitRequestIds；不再复制各 CDP 通道 listener。 */
  async waitForActionRequests(action: TraceAction, timeoutMs = 10_000): Promise<{ settled_by: SettledBy[]; timedOut: boolean }> {
    const signal = requestContext.getStore()?.signal;
    signal?.throwIfAborted();
    const t0 = action.ts;
    const entries = new Map<string, SettledBy>();
    const collect = (): void => {
      for (const id of action.waitRequestIds) {
        if (entries.has(id)) continue;
        const settled = this.settledAt.get(id);
        if (settled !== undefined) entries.set(id, { kind: 'request', ref: id, ms: settled - t0 });
      }
    };
    collect();
    if (action.waitRequestIds.length === 0) return { settled_by: [], timedOut: false };
    let timedOut = false;
    await new Promise<void>((resolve, reject) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let listener: () => void;
      const finish = (): void => {
        done = true;
        if (timer) { clearTimeout(timer); timer = undefined; }
        this.completionListeners.delete(listener);
        signal?.removeEventListener('abort', abort);
      };
      const abort = (): void => { if (done) return; finish(); reject(signal!.reason); };
      listener = (): void => {
        if (done) return;
        collect();
        if (action.waitRequestIds.every((id) => entries.has(id))) {
          finish();
          resolve();
        }
      };
      timer = setTimeout(() => { timedOut = true; finish(); resolve(); }, timeoutMs);
      this.completionListeners.add(listener);
      signal?.addEventListener('abort', abort, { once: true });
      listener();
    });
    const live = new Set(action.waitRequestIds);
    const settledBy = [...entries.entries()]
      .filter(([id]) => live.has(id))
      .map(([, entry]) => entry);
    if (timedOut) settledBy.push({ kind: 'timeout', ms: timeoutMs });
    return { settled_by: settledBy, timedOut };
  }

  async flush(): Promise<void> {
    const settled = await settleWithin(this.work, TRACE_FLUSH_TIMEOUT_MS);
    if (!settled.ok) {
      this.cancelled = true;
      throw new Error('network trace flush timeout');
    }
    if (this.workFailed) throw new Error('network trace finalize failed');
  }

  /** exact transport key -> 已验 alias -> owner+frame+requestId 唯一 Document hop。 */
  private resolveHopKey(
    ownerTargetId: string,
    transportTargetId: string,
    cdpRequestId: string,
    frameId: string | undefined,
    documentOnly: boolean,
  ): string | undefined {
    const exact = compositeKey(transportTargetId, cdpRequestId);
    if (this.inflight.has(exact)) return exact;
    const alias = this.terminalAliases.get(exact);
    if (alias && this.inflight.has(alias)) return alias;
    if (!frameId) return undefined;
    let matched: string | undefined;
    for (const [key, hop] of this.inflight) {
      if (hop.targetId !== ownerTargetId || hop.cdpRequestId !== cdpRequestId || hop.frameId !== frameId) continue;
      if (documentOnly && hop.resourceType.toLowerCase() !== 'document') continue;
      if (matched !== undefined) return undefined;
      matched = key;
    }
    return matched;
  }

  private onRequestWillBeSent(
    params: any,
    ownerTargetId: string,
    transportTargetId: string,
    cdp: TraceCdpSession,
    rootTransport: boolean,
    channelFrameId?: string,
  ): void {
    const cdpRequestId = String(params?.requestId ?? '');
    const request = params?.request as RequestData | undefined;
    if (!cdpRequestId || !request?.url) return;

    const state = this.targets.get(ownerTargetId);
    if (!state) return;
    const key = compositeKey(transportTargetId, cdpRequestId);
    const resourceType = String(params.type ?? '');
    const eventFrameId = params.frameId !== undefined ? String(params.frameId) : channelFrameId;

    // redirect 只结算旧 hop；旧 rID 继续留在 action.requests，waitRequestIds 稍后原位换终链。
    const previousKey = params.redirectResponse
      ? this.resolveHopKey(ownerTargetId, transportTargetId, cdpRequestId, eventFrameId, true)
      : undefined;
    const previous = previousKey ? this.inflight.get(previousKey) : undefined;
    if (params.redirectResponse && previous && previousKey) {
      previous.response = params.redirectResponse as ResponseData;
      this.inflight.delete(previousKey);
      if (previousKey !== key) this.terminalAliases.delete(key);
      this.queueFinalize(previous, eventTime(params.wallTime), 'unavailable', null);
    }

    // F2：仅 root transport 允许从首个 Document 兜底 mainFrameId；child 不得改 owner 顶层身份。
    if (rootTransport && !state.mainFrameId && resourceType.toLowerCase() === 'document' && params.frameId) {
      state.mainFrameId = String(params.frameId);
    }

    // Document 跨通道重复 start：在分配 rID/callIndex 前按 owner+frame+requestId 唯一去重。
    if (!params.redirectResponse && resourceType.toLowerCase() === 'document' && eventFrameId) {
      const existing = this.resolveHopKey(ownerTargetId, transportTargetId, cdpRequestId, eventFrameId, true);
      if (existing) {
        if (existing !== key) this.terminalAliases.set(key, existing);
        return;
      }
    }

    const redirectContinuation = !!params.redirectResponse && !!previous?.mainDocument;
    const mainDocument = rootTransport
      ? this.nav.onRequest(state, {
        resourceType,
        frameId: params.frameId !== undefined ? String(params.frameId) : undefined,
        url: request.url,
        redirectContinuation,
        triggeredBy: this.activeAction?.id ?? null,
      })
      : false;

    if (!shouldTrack(resourceType, request.url)) return;
    const path = requestPath(request.url);
    const nav = state.currentNavId;
    const indexKey = nav + '\0' + path;
    const callIndex = (this.callIndexes.get(indexKey) ?? 0) + 1;
    this.callIndexes.set(indexKey, callIndex);
    const id = 'r' + ++this.requestSeq;
    const triggeredBy = params.redirectResponse && previous
      ? previous.triggeredBy
      : (this.activeAction && this.activeAction.targetId === ownerTargetId ? this.activeAction.id : null);
    // creates 只赋予动作所属逻辑 owner 的同 path 请求；其他 page 的后台请求不偷继承 creates。
    const createsEntity = (this.activeAction && this.activeAction.targetId === ownerTargetId && this.activeAction.creates && this.activeAction.creates.path === path)
      ? this.activeAction.creates.entity
      : undefined;
    const hop: RequestHop = {
      id,
      targetId: ownerTargetId,
      transportTargetId,
      cdpRequestId,
      frameId: eventFrameId,
      request,
      resourceType,
      path,
      nav,
      callIndex,
      started: eventTime(params.wallTime),
      triggeredBy,
      mainDocument,
      ...(createsEntity ? { creates: createsEntity } : {}),
      ...(request.postData === undefined && request.hasPostData ? {
        postData: settleWithin(
          cdp.send<{ postData?: string }>('Network.getRequestPostData', { requestId: cdpRequestId }),
          BODY_READ_TIMEOUT_MS,
        ).then((result) => result.ok ? result.value.postData : undefined),
      } : {}),
    };
    this.inflight.set(key, hop);
    const safeUrl = redactUrlWithEvidence(request.url);
    this.summaries.set(id, {
      id, path, nav, call_index: callIndex, target_id: ownerTargetId,
      url: safeUrl.value, url_redacted: safeUrl.redacted,
    });
    if (triggeredBy && this.activeAction?.id === triggeredBy) {
      const waitIndex = previous ? this.activeAction.waitRequestIds.indexOf(previous.id) : -1;
      if (waitIndex >= 0) {
        this.activeAction.waitRequestIds[waitIndex] = id;
        this.notifyCompletion();
      } else {
        this.activeAction.waitRequestIds.push(id);
      }
      this.activeAction.requests.push(id);
    }
  }

  private onResponseReceived(
    params: any,
    ownerTargetId: string,
    transportTargetId: string,
    rootTransport: boolean,
    channelFrameId?: string,
  ): void {
    const requestId = String(params?.requestId ?? '');
    const frameId = rootTransport
      ? undefined
      : (params?.frameId !== undefined ? String(params.frameId) : channelFrameId);
    const key = this.resolveHopKey(ownerTargetId, transportTargetId, requestId, frameId, !rootTransport);
    const hop = key ? this.inflight.get(key) : undefined;
    if (!key || !hop) return;
    const exact = compositeKey(transportTargetId, requestId);
    if (key !== exact) this.terminalAliases.set(exact, key);
    hop.response = params.response as ResponseData;
    const summary = this.summaries.get(hop.id);
    if (summary) {
      const headers = redactHeaders(hop.response.headers);
      summary.resp_headers = headers;
      summary.resp_headers_redacted = redactedHeaderKeys(hop.response.headers, headers);
    }
  }

  private onLoadingFinished(
    params: any,
    ownerTargetId: string,
    transportTargetId: string,
    cdp: TraceCdpSession,
    rootTransport: boolean,
    channelFrameId?: string,
  ): void {
    const requestId = String(params?.requestId ?? '');
    const frameId = rootTransport
      ? undefined
      : (params?.frameId !== undefined ? String(params.frameId) : channelFrameId);
    const key = this.resolveHopKey(ownerTargetId, transportTargetId, requestId, frameId, !rootTransport);
    const hop = key ? this.inflight.get(key) : undefined;
    if (!key || !hop) return;
    const exact = compositeKey(transportTargetId, requestId);
    if (key !== exact) this.terminalAliases.set(exact, key);
    this.settleFinished(key, hop, cdp);
  }

  private onLoadingFailed(
    params: any,
    ownerTargetId: string,
    transportTargetId: string,
    rootTransport: boolean,
    channelFrameId?: string,
  ): void {
    const requestId = String(params?.requestId ?? '');
    const errorText = redactText(String(params?.errorText ?? 'loading_failed'));
    // 诊断只写 stderr(42304 A2):mock/CORS 失败定位所需 CDP 原始字段;不输出 URL/请求头/body
    const cors = params?.corsErrorStatus ?? {};
    process.stderr.write(
      `[network-trace] loadingFailed: targetId=${transportTargetId}`
      + ` requestId=${requestId}`
      + ` type=${String(params?.type ?? '')}`
      + ` errorText=${errorText}`
      + ` blockedReason=${String(params?.blockedReason ?? '')}`
      + ` corsError=${String(cors?.corsError ?? '')}`
      + ` failedParameter=${String(cors?.failedParameter ?? '')}\n`,
    );
    const frameId = rootTransport
      ? undefined
      : (params?.frameId !== undefined ? String(params.frameId) : channelFrameId);
    const key = this.resolveHopKey(ownerTargetId, transportTargetId, requestId, frameId, !rootTransport);
    const hop = key ? this.inflight.get(key) : undefined;
    if (!key || !hop) return;
    const exact = compositeKey(transportTargetId, requestId);
    if (key !== exact) this.terminalAliases.set(exact, key);
    if (hop.mainDocument) this.emitPendingNavigation(hop.targetId);
    this.failHop(key, hop, errorText);
  }

  private failHop(key: string, hop: RequestHop, reason: string): void {
    if (this.inflight.get(key) !== hop) return;
    this.inflight.delete(key);
    this.settledAt.set(hop.id, Date.now());
    const summary = this.summaries.get(hop.id);
    if (summary && summary.failed === undefined) summary.failed = reason;
    this.queueFinalize(hop, Date.now(), 'none', reason);
    this.notifyCompletion();
  }

  private settleFinished(key: string, hop: RequestHop, cdp: TraceCdpSession | undefined): void {
    this.inflight.delete(key);
    this.settledAt.set(hop.id, Date.now());
    if (hop.mainDocument) this.emitPendingNavigation(hop.targetId);
    hop.responseBody = cdp
      ? settleWithin(
        cdp.send<{ body?: string; base64Encoded?: boolean }>('Network.getResponseBody', { requestId: hop.cdpRequestId }),
        BODY_READ_TIMEOUT_MS,
      ).then((result) => result.ok ? result.value : null)
      : Promise.resolve(null);
    this.queueFinalize(hop, Date.now(), 'fetch', null);
    this.notifyCompletion();
  }

  private onFrameNavigated(params: any, targetId: string): void {
    const frame = params?.frame;
    if (!frame || frame.parentId !== undefined) return;
    const state = this.targets.get(targetId);
    if (!state) return;
    state.navGen++;
    const isMain = this.nav.onFrameNavigated(state, {
      id: String(frame.id ?? state.mainFrameId ?? ''),
      parentId: frame.parentId,
      url: frame.url !== undefined ? String(frame.url) : undefined,
      urlFragment: frame.urlFragment !== undefined ? String(frame.urlFragment) : undefined,
    });
    if (!isMain) return;
    if (state.pendingNavigation) this.emitPendingNavigation(targetId);
  }

  private onNavigatedWithinDocument(params: any, targetId: string): void {
    const state = this.targets.get(targetId);
    if (!state) return;
    const navigation = this.nav.onSameDocument(state, {
      frameId: params?.frameId !== undefined ? String(params.frameId) : undefined,
      url: String(params?.url ?? state.currentUrl),
      triggeredBy: this.activeAction?.id ?? null,
    });
    if (!navigation) return;
    // SPA 路由一律 spa_route（任何 target，不误 new_tab）
    appendTraceEvent(this.sessionId, {
      t: 'navigation', id: navigation.id, ts: Date.now(), from: navigation.from, to: navigation.to, kind: 'spa_route', triggered_by: navigation.triggeredBy, target_id: targetId,
    });
    state.navGen++;
    if (navigation.triggeredBy && this.activeAction?.id === navigation.triggeredBy) this.activeAction.navigations.push(navigation.id);
  }

  private emitPendingNavigation(targetId: string): void {
    const state = this.targets.get(targetId);
    if (!state?.pendingNavigation) return;
    const navigation = this.nav.finishPending(state);
    if (!navigation) return;
    const kind = !state.isSource && !state.firstNavEmitted ? 'new_tab' : 'same_page';
    appendTraceEvent(this.sessionId, {
      t: 'navigation',
      id: navigation.id,
      ts: Date.now(),
      from: navigation.from,
      to: navigation.to,
      kind,
      triggered_by: navigation.triggeredBy,
      target_id: targetId,
    });
    state.firstNavEmitted = true;
    state.navGen++;
    if (navigation.triggeredBy && this.activeAction?.id === navigation.triggeredBy) {
      this.activeAction.navigations.push(navigation.id);
    }
  }

  private queueFinalize(hop: RequestHop, finished: number, responseBody: ResponseBodyMode, failed: string | null): void {
    this.work = this.work
      .then(() => { if (this.cancelled) return; return this.finalize(hop, finished, responseBody, failed); })
      .catch(() => { this.workFailed = true; });
  }

  private async finalize(hop: RequestHop, finished: number, responseBody: ResponseBodyMode, failed: string | null): Promise<void> {
    let reqBodyRef: string | undefined;
    let reqBodyOmitted: string | undefined;
    let reqBodyRedactedPaths: string[][] | undefined;
    const requestBody = hop.request.postData ?? await hop.postData;
    if (requestBody !== undefined && requestBody !== '') {
      const stored = storeTraceBody(this.sessionId, requestBody, contentType(hop.request.headers));
      if ('ref' in stored) { reqBodyRef = stored.ref; reqBodyRedactedPaths = stored.redacted_paths; }
      else reqBodyOmitted = stored.omitted;
    } else if (hop.request.hasPostData && hop.request.postData === undefined) {
      reqBodyOmitted = 'body_unavailable';
    }

    let respBodyRef: string | undefined;
    let respBodyOmitted: string | undefined;
    let respBodyRedactedPaths: string[][] | undefined;
    if (responseBody === 'fetch') {
      // await 已在 onLoadingFinished 中立即发起的 promise，不再串行发 CDP
      const body = hop.responseBody ? await hop.responseBody : null;
      if (body?.body !== undefined && body.body !== '') {
        const stored = storeTraceBody(
          this.sessionId,
          body.body,
          contentType(hop.response?.headers, hop.response?.mimeType),
          body.base64Encoded === true,
        );
        if ('ref' in stored) { respBodyRef = stored.ref; respBodyRedactedPaths = stored.redacted_paths; }
        else respBodyOmitted = stored.omitted;
      } else if (!body) {
        respBodyOmitted = 'body_unavailable';
      }
    } else if (responseBody === 'unavailable') {
      // CDP redirectResponse replaces the hop without loadingFinished; the reused requestId now points at the next hop.
      respBodyOmitted = 'body_unavailable';
    }

    const summary = this.summaries.get(hop.id);
    if (summary && hop.response?.status !== undefined) summary.status = hop.response.status;
    this.bodyRefs.set(hop.id, {
      ...(reqBodyRef ? { req_body_ref: reqBodyRef } : {}),
      ...(reqBodyRef ? { req_body_redacted_paths: reqBodyRedactedPaths } : {}),
      ...(reqBodyOmitted ? { req_body_omitted: reqBodyOmitted } : {}),
      ...(respBodyRef ? { resp_body_ref: respBodyRef } : {}),
      ...(respBodyRef ? { resp_body_redacted_paths: respBodyRedactedPaths } : {}),
      ...(respBodyOmitted ? { resp_body_omitted: respBodyOmitted } : {}),
      ...(hop.creates ? { creates: hop.creates } : {}),
      ...(hop.response?.status !== undefined ? { status: hop.response.status } : {}),
      ...(failed ? { failed } : {}),
    });
    const safeUrl = redactUrlWithEvidence(hop.request.url);
    appendTraceEvent(this.sessionId, {
      t: 'request',
      id: hop.id,
      ts: hop.started,
      cdp_request_id: hop.cdpRequestId,
      method: hop.request.method,
      url: safeUrl.value,
      url_redacted: safeUrl.redacted,
      path: hop.path,
      nav: hop.nav,
      call_index: hop.callIndex,
      resource_type: hop.resourceType,
      started: hop.started,
      finished,
      status: hop.response?.status,
      failed,
      mocked: false,
      triggered_by: hop.triggeredBy,
      req_headers: redactHeaders(hop.request.headers),
      resp_headers: redactHeaders(hop.response?.headers),
      target_id: hop.targetId,
      ...(hop.creates ? { creates: hop.creates } : {}),
      ...(reqBodyRef ? { req_body_ref: reqBodyRef } : {}),
      ...(reqBodyRef ? { req_body_redacted_paths: reqBodyRedactedPaths } : {}),
      ...(reqBodyOmitted ? { req_body_omitted: reqBodyOmitted } : {}),
      ...(respBodyRef ? { resp_body_ref: respBodyRef } : {}),
      ...(respBodyRef ? { resp_body_redacted_paths: respBodyRedactedPaths } : {}),
      ...(respBodyOmitted ? { resp_body_omitted: respBodyOmitted } : {}),
    });
  }

  /** 显式 --wait-*：按 WaitSpec 等条件，共用一个绝对 deadline。
   *  wait_api: 本 action 触发的、path 匹配请求里第 nth 个 settle 的；选 nth 后再判成败（loadingFailed 终端失败抛 WaitApiFailure）。
   *  wait_element/wait_gone/wait_text/wait_url: bounded polling，按剩余 deadline。超时记 timeout。 */
  async waitForExplicit(
    action: TraceAction,
    spec: WaitSpec,
    deps: {
      queryTarget: (target: string, deadlineMs: number) => Promise<Pick<SettledBy, 'locator' | 'identity'> & { observation: import('../browser/locator-query.js').LocatorObservation }>;
      readText: (deadlineMs: number) => Promise<string>;
      readUrl: (deadlineMs: number) => Promise<string>;
    },
    deadlineMs: number,
  ): Promise<SettledBy[]> {
    const signal = requestContext.getStore()?.signal;
    signal?.throwIfAborted();
    const t0 = action.ts;
    const out: SettledBy[] = [];
    const specs: Array<{ condition: Omit<SettledBy, 'ms'>; api?: { path: string; nth: number }; run: () => Promise<boolean> }> = [];
    for (const api of spec.apis ?? []) {
      const nth = api.nth ?? 1;
      specs.push({ condition: { kind: 'request' }, api: { path: api.path, nth }, run: () => this.waitApi(action, api.path, nth, deadlineMs) });
    }
    for (const [target, kind] of [[spec.element, 'element'], [spec.gone, 'element_gone']] as const) {
      if (!target) continue;
      const condition: Omit<SettledBy, 'ms'> = { kind, target };
      specs.push({ condition, run: () => pollUntil(async () => {
        const result = await deps.queryTarget(target, deadlineMs);
        if (result.observation.matches > 1) throw new Error('BAD_REQUEST: 等待目标不唯一');
        Object.assign(condition, result);
        if (!result.locator) {
          if (kind === 'element_gone' || result.observation.matches !== 0) throw new Error('INSUFFICIENT_EVIDENCE: 等待没有冻结定位身份');
          return false;
        }
        return result.observation.matches === (kind === 'element' ? 1 : 0);
      }, deadlineMs) });
    }
    if (spec.text) {
      const text = spec.text;
      specs.push({ condition: { kind: 'text', text }, run: () => pollUntil(() => deps.readText(deadlineMs).then((t) => t.includes(text)), deadlineMs) });
    }
    if (spec.url) {
      const url = spec.url;
      specs.push({ condition: { kind: 'url', url }, run: () => pollUntil(() => deps.readUrl(deadlineMs).then((u) => u.includes(url)), deadlineMs) });
    }
    for (const item of specs) {
      signal?.throwIfAborted();
      // API 等待直接 await：WaitApiFailure 传播（不被 settleWithin 吞成 timeout）；超时返回 false
      if (item.condition.kind === 'request') {
        const ok = await item.run();
        signal?.throwIfAborted();
        const ms = Date.now() - t0;
        if (!ok || Date.now() >= deadlineMs) {
          out.push({ kind: 'timeout', ms });
          return out;
        }
        const api = item.api!;
        const matching = action.waitRequestIds
          .filter((id) => this.settledAt.has(id) && this.summaries.get(id)?.path === api.path)
          .sort((left, right) => (this.settledAt.get(left) ?? 0) - (this.settledAt.get(right) ?? 0));
        item.condition.ref = matching[api.nth - 1];
        out.push({ ...item.condition, ms });
      } else {
        // 非原生等待：剩余 deadline（不加下限）；run 抛错（协议/输入错误）原样传播，不当超时
        const ok = await settleWithin(item.run(), Math.max(0, deadlineMs - Date.now()));
        signal?.throwIfAborted();
        if (!ok.ok || !ok.value) {
          if (!ok.ok && 'error' in ok && ok.error !== undefined) {
            if (ok.error instanceof Error) Object.assign(ok.error, { settled_by: out });
            throw ok.error;
          }
          out.push({ kind: 'timeout', ms: Date.now() - t0 });
          return out;
        }
        out.push({ ...item.condition, ms: Date.now() - t0 });
      }
    }
    return out;
  }

  /** wait_api 核心动作：等第 nth 个 path 匹配请求 settle，选中后判成败。
   *  选中为 loadingFailed → reject WaitApiFailure（传播出 waitForExplicit）。
   *  deadline 到 → resolve(false)（超时）。每个终态分支清理监听与定时器。 */
  private waitApi(action: TraceAction, path: string, nth: number, deadlineMs: number): Promise<boolean> {
    const signal = requestContext.getStore()?.signal;
    signal?.throwIfAborted();
    const selectNth = (): string | undefined => {
      const matching = action.waitRequestIds
        .filter((id) => this.settledAt.has(id) && this.summaries.get(id)?.path === path)
        .sort((left, right) => (this.settledAt.get(left) ?? 0) - (this.settledAt.get(right) ?? 0));
      return matching[nth - 1];
    };
    return new Promise<boolean>((resolve, reject) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let listener: () => void;
      const cleanup = (): void => {
        done = true;
        if (timer) { clearTimeout(timer); timer = undefined; }
        this.completionListeners.delete(listener);
        signal?.removeEventListener('abort', abort);
      };
      const abort = (): void => { if (done) return; cleanup(); reject(signal!.reason); };
      const settle = (): void => {
        if (done) return;
        const sel = selectNth();
        if (!sel) return;
        const summary = this.summaries.get(sel);
        cleanup();
        if (summary?.failed) { reject(new WaitApiFailure(summary.id, summary.failed)); return; }
        resolve(true);
      };
      listener = (): void => {
        if (done) return;
        settle();
      };
      // 已满足（含选中即为失败 → 立即 reject）
      if (selectNth()) { settle(); return; }
      this.completionListeners.add(listener);
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => { cleanup(); resolve(false); }, Math.max(0, deadlineMs - Date.now()));
    });
  }

  private notifyCompletion(): void {
    for (const listener of [...this.completionListeners]) {
      try { listener(); } catch { /* listener 自处理错误 */ }
    }
  }

  /** 记 dialog 事件并返回是否本 action 触发（registered=false 时由调用方在命令返回 data.dialog） */
  recordDialog(after: string, kind: string, message: string, handled: 'accept' | 'dismiss', registered: boolean): void {
    appendTraceEvent(this.sessionId, {
      t: 'dialog',
      after,
      kind,
      message: redactText(message),
      handled,
      registered,
    });
  }

  /** req 引用解析:r<id> 直接查 summaries;<path>[@<nav>][#<n>] 按 path(+nav+call_index) 查。
   *  nav 省略（隐式 path）只查 active target 的 currentNav，不放开其他页 fallback（避免跨页串引用）；
   *  显式 nav/rID 可查会话内唯一历史证据。找不到返回 null（无证据，不伪造）。 */
  resolveReqRef(ref: string): RequestSummary | null {
    if (!ref) return null;
    if (/^r\d+$/.test(ref)) return this.summaries.get(ref) ?? null;
    // path[@nav][#n]
    const m = ref.match(/^([^@#]+)(?:@(n\d+))?(?:#(\d+))?$/);
    if (!m) return null;
    const [, path, nav, nStr] = m;
    const callIndex = nStr ? Number(nStr) : undefined;
    // 隐式 path（无 nav）：只查 active target 的 currentNav，禁止跨页 fallback
    const navFilter = nav ?? this.currentNav();
    const candidates: RequestSummary[] = [];
    for (const s of this.summaries.values()) {
      if (s.path !== path) continue;
      if (s.nav !== navFilter) continue;
      if (callIndex !== undefined && s.call_index !== callIndex) continue;
      candidates.push(s);
    }
    if (candidates.length === 0) return null;
    // call_index 省略时取最近一次(最大 call_index)
    candidates.sort((a, b) => (a.nav === b.nav ? b.call_index - a.call_index : a.nav < b.nav ? 1 : -1));
    return candidates[0];
  }

  /** 取请求的 body ref 信息(req/resp body_ref + creates + failed + status)。 */
  getBodyRef(id: string): { req_body_ref?: string; resp_body_ref?: string; req_body_omitted?: string; resp_body_omitted?: string; creates?: string; failed?: string | null; status?: number; req_body_redacted_paths?: string[][]; resp_body_redacted_paths?: string[][] } | undefined {
    return this.bodyRefs.get(id);
  }

  /** 最近一个 finishAction 的 action id;无 action 返回 null。 */
  getLastFinishedActionId(): string | null {
    return this.lastFinishedActionId;
  }

  getLastFinishedActionGroup(): string | undefined {
    return this.lastFinishedActionGroup;
  }
}
