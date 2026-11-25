/**
 * 请求历史追踪：单一 browser-level WebSocket 的 CDP 事件流（Network/Page），
 * root/child 共用 wire id，严格按顶层 sessionId 路由。按 path+nav+call_index 精确查询；
 * 真实 body+postData 都 settle 后一次性提交完成（loadingFinished 发 getResponseBody）。
 * 导航分号走共源 shared/network-navigation。
 */
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import type { Page, BrowserContext, Frame, ElementHandle } from '@playwright/test';
import { NetworkNavigationTracker, type NetworkNavigationState } from './shared/network-navigation.js';
import { redactHeaders, redactedHeaderKeys } from './shared/headers.js';
import { ConsoleObserver, type ConsoleObserverChannel } from './shared/console-observer.js';
import type { ConsoleEntry, ConsoleSnapshot } from './shared/console.js';

export interface RequestRecord {
  url: string;
  method: string;
  path: string;
  nav: string;
  call_index: number;
  status?: number;
  started?: number;
  responseHeaders?: Record<string, string>;
  responseHeadersRedacted?: string[];
  body?: string;
  requestBody?: string;
  /** 终端失败原因（loadingFailed 或 body 读取拒绝）；一经记录不再被后续完成回调清除。 */
  failed?: string;
}

/** waitForComplete 失败：命中的请求终端失败。 */
export class WaitApiFailure extends Error {
  ref: { path: string; nav: number; call_index: number };
  reason: string;
  constructor(ref: { path: string; nav: number; call_index: number }, reason: string) {
    super(`❌ 接口等待失败 {path:${ref.path},nav:${ref.nav},call_index:${ref.call_index}}: ${reason}`);
    this.name = 'WaitApiFailure';
    this.ref = ref;
    this.reason = reason;
  }
}

type CompletionListener = () => void;

/** 单个 request hop（requestId 仅在本 page session 内解释）。 */
interface RequestHop {
  record: RequestRecord;
  /** 原始 CDP requestId（本 transport 内解释）。 */
  requestId: string;
  /** 实际 frameId；terminal 事件不带 frameId 时按 attach 通道身份补。 */
  frameId?: string;
  /** start 实际所在的 transport target：root page 或 OOPIF child。 */
  transportTargetId: string;
  resourceType: string;
  mainDocument: boolean;
  /** hasPostData 且缺 postData 时立即发起的 getRequestPostData（失败 catch=>undefined，不伪造） */
  postDataPromise?: Promise<string | undefined>;
  /** redirect 前 hop：被链尾 requestWillBeSent 替换，不再等 body；晚到 postData 保留回填 */
  replaced: boolean;
}

/** 每 page 的 attach 注册：独立 CDPSession/state/inflight 与监听解绑。 */
interface PageRegistration {
  page?: Page;
  targetId?: string;
  sessionId?: string;
  cdp: RequestSession;
  state: NetworkNavigationState;
  inflight: Map<string, RequestHop>;
  off: Array<() => void>;
  /** attach 局部 frame generation：主帧事件递增，getFrameTree 快照仅 generation 未变时生效 */
  gen: number;
  disposed: boolean;
  attachPromise: Promise<void>;
  sessionClosed: boolean;
  pendingRootNetwork: Array<() => void>;
  offClose?: () => void;
  /** 本 page 的 Console 观察（root + OOPIF child）；生命周期跟随 registration。 */
  consoleObserver?: ConsoleObserver;
  consoleChildren?: Map<string, {
    observer: ConsoleObserver;
    frameId?: string;
    channel?: ConsoleObserverChannel & { off(method: string, handler: (params: any) => void): void };
    url?: string;
    name?: string;
  }>;
  /** 已收到 attachedToTarget、但 collector 尚未登记完成的 iframe session。 */
  consolePending?: Set<string>;
  consoleRetired?: ConsoleSnapshot[];
  consoleErrors?: string[];
}

interface RequestSession {
  send(method: string, params?: Record<string, unknown>): Promise<any>;
  on(event: string, listener: (params: any) => void): unknown;
  off(event: string, listener: (params: any) => void): unknown;
  detach(): Promise<void>;
}

interface NativeWebSocket {
  on(event: 'open' | 'message' | 'error' | 'close', listener: (...args: any[]) => void): unknown;
  off(event: 'open' | 'message' | 'error' | 'close', listener: (...args: any[]) => void): unknown;
  once(event: 'open' | 'error' | 'close', listener: (...args: any[]) => void): unknown;
  send(data: string, callback?: (error?: Error) => void): void;
  close(): void;
}

interface NativeWebSocketConstructor {
  new (url: string, options?: { perMessageDeflate?: boolean; maxPayload?: number }): NativeWebSocket;
}

interface PendingCommand {
  method: string;
  resolve: (value: any) => void;
  reject: (error: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
  bodyRead: boolean;
}

interface ChildSession {
  targetId: string;
  type: 'page' | 'iframe';
  frameId?: string;
  networkOff?: Array<() => void>;
  listeners: Map<string, Set<(params: any) => void>>;
  paused: boolean;
}

interface NetworkTransport {
  cdp: Pick<RequestSession, 'send'>;
  transportTargetId: string;
  frameId?: string;
  root: boolean;
}

async function withinDeadline<Result>(operation: Promise<Result>, timeoutMs = 30_000): Promise<Result> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('REQUEST_TRACKER_COMMAND_TIMEOUT')), Math.max(0, timeoutMs));
    })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const ALLOWED_TYPES = new Set(['xhr', 'fetch', 'document']);
const ROOT_CHANNEL = '\0root';
const nodeRequire = typeof require === 'function' ? require : createRequire(process.cwd() + '/');

function requestPath(url: string): string {
  try { return new URL(url).pathname; } catch { return url.split('?', 1)[0]; }
}

function eventTime(wallTime: unknown): number {
  return typeof wallTime === 'number' && Number.isFinite(wallTime) ? Math.round(wallTime * 1000) : Date.now();
}

function pendingKey(sessionId: string | undefined, id: number): string {
  return `${sessionId ?? ROOT_CHANNEL}\0${id}`;
}

function requestKey(transportTargetId: string, requestId: string): string {
  return `${transportTargetId}\0${requestId}`;
}

function createNativeSocket(endpoint: string): NativeWebSocket {
  let wsModule: { WebSocket?: NativeWebSocketConstructor; default?: NativeWebSocketConstructor };
  try {
    wsModule = nodeRequire('ws') as typeof wsModule;
  } catch {
    throw new Error('REQUEST_TRACKER_START_FAILED: 无法解析宿主 ws');
  }
  const WebSocket = wsModule.WebSocket ?? wsModule.default;
  if (!WebSocket) throw new Error('REQUEST_TRACKER_START_FAILED: 宿主 ws 缺少 WebSocket 构造器');
  return new WebSocket(endpoint, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
}

export class RequestTracker {
  private history: RequestRecord[] = [];
  private callIndexes = new Map<string, number>();
  /** 完成通知订阅者：body 提交 / loadingFailed 两个生产者触发。 */
  private completionListeners = new Set<CompletionListener>();
  /** 共源导航分配器：全 run 一个；n 全 run 唯一 */
  private nav = new NetworkNavigationTracker();
  /** 每 run 一次性 n0：第一次 attach 分 n0；所有后续 attach（含 close/失败后 map 空）一律 next()，
   *  防止死页重新 attach 后沿用 n0 复用旧历史 body 造成假绿。 */
  private n0Taken = false;
  /** page → attach 注册；dispose 后解除 */
  private registrations = new Map<Page, PageRegistration>();
  private targets = new Map<string, PageRegistration>();
  private children = new Map<string, ChildSession>();
  private pending = new Map<string, PendingCommand>();
  private tasks = new Set<Promise<void>>();
  private disposals = new Map<PageRegistration, Promise<void>>();
  private root?: NativeWebSocket;
  private commandId = 0;
  private mainTargetId?: string;
  private browserContextId?: string;
  private context?: BrowserContext;
  private identityTargetId?: string;
  private bindings = new Map<Page, Promise<void>>();
  private preexisting = new Set<string>();
  private targetWaiters = new Map<string, Set<{ resolve: () => void; reject: (error: unknown) => void; timer: ReturnType<typeof setTimeout> }>>();
  private failures: unknown[] = [];
  private stopped = false;

  private diagnostic(event: string, fields: Record<string, unknown> = {}): void {
    console.error(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
  }

  private bodyDiagnostic(hop: Pick<RequestHop, 'record'>, kind: 'responseBody' | 'requestBody', value: string): void {
    this.diagnostic('body', {
      targetId: this.targetIdForRecord(hop.record),
      contextId: this.browserContextId,
      path: hop.record.path,
      nav: hop.record.nav,
      callIndex: hop.record.call_index,
      kind,
      sha256: createHash('sha256').update(value).digest('hex'),
      length: Buffer.byteLength(value),
    });
  }

  private targetIdForRecord(record: RequestRecord): string | undefined {
    return this.targetHistory.get(record);
  }

  private targetHistory = new WeakMap<RequestRecord, string>();

  /** Replay console 归因：当前 step 与刚完成 step，供 session/action 两种范围。 */
  private consoleActionId: string | null = null;
  private consoleAfterId: string | null = null;
  private consoleBySession = new Map<string, { reg: PageRegistration; observer: ConsoleObserver; frameId?: string }>();

  beginConsoleAction(stepId: string): void {
    this.consoleActionId = stepId;
  }

  finishConsoleAction(stepId: string): void {
    this.consoleActionId = null;
    this.consoleAfterId = stepId;
  }

  consoleScopeId(): string | null {
    return this.consoleActionId ?? this.consoleAfterId;
  }

  private consoleAttribution(): { action_id?: string; after_id?: string } {
    return {
      ...(this.consoleActionId ? { action_id: this.consoleActionId } : {}),
      ...(!this.consoleActionId && this.consoleAfterId ? { after_id: this.consoleAfterId } : {}),
    };
  }

  /** 当前 page 的 Console 快照（root + 实际 OOPIF child + 已 detach 的历史快照）。 */
  async consoleSnapshot(page: Page, frameId?: string): Promise<{ snapshot: ConsoleSnapshot; complete: boolean }> {
    const reg = this.registrations.get(page);
    if (!reg?.consoleObserver) {
      return { snapshot: { active: false, truncated: false, entries: [] }, complete: false };
    }
    let frameComplete = true;
    try {
      if ((reg.consolePending?.size ?? 0) > 0) frameComplete = false;
      const tree = await reg.cdp.send('Page.getFrameTree');
      const frameIds = new Set<string>();
      const pending = [tree?.frameTree];
      while (pending.length) {
        const node = pending.pop();
        const id = node?.frame?.id;
        if (typeof id !== 'string' || !id || frameIds.has(id)) {
          frameComplete = false;
          continue;
        }
        frameIds.add(id);
        for (const child of node.childFrames ?? []) pending.push(child);
      }
      for (const meta of reg.consoleChildren?.values() ?? []) {
        if (meta.frameId) frameIds.add(meta.frameId);
      }
      if (frameId === undefined) {
        for (const id of frameIds) if (!this.consoleHasFrame(reg, id)) frameComplete = false;
      } else if (!this.consoleHasFrame(reg, frameId)) {
        frameComplete = false;
      }
    } catch {
      frameComplete = false;
    }
    const snapshots: ConsoleSnapshot[] = [reg.consoleObserver.snapshot()];
    for (const meta of reg.consoleChildren?.values() ?? []) snapshots.push(meta.observer.snapshot());
    for (const snap of reg.consoleRetired ?? []) snapshots.push(snap);
    const entries: ConsoleEntry[] = [];
    for (const snap of snapshots) entries.push(...snap.entries);
    entries.sort((a, b) => a.ts - b.ts || a.seq - b.seq);
    const rootActive = reg.consoleObserver.snapshot().active;
    const childrenActive = [...(reg.consoleChildren?.values() ?? [])].every((m) => m.observer.snapshot().active);
    const complete = frameComplete && rootActive && childrenActive
      && !reg.disposed && !page.isClosed() && (reg.consoleErrors?.length ?? 0) === 0;
    return {
      snapshot: {
        active: complete,
        truncated: snapshots.some((s) => s.truncated),
        entries,
      },
      complete,
    };
  }

  private consoleHasFrame(reg: PageRegistration, frameId: string): boolean {
    let matches = reg.consoleObserver?.getDefaultContext(frameId) !== undefined ? 1 : 0;
    for (const meta of reg.consoleChildren?.values() ?? []) {
      if (meta.observer.getDefaultContext(frameId) !== undefined) matches++;
    }
    return matches === 1;
  }

  /** Playwright Frame → 该 page 实际 CDP frameId：由实际 DOM owner 证明，不按 URL/name 猜身份。 */
  async resolveConsoleFrameId(page: Page, frame: Frame): Promise<string> {
    const reg = this.registrations.get(page);
    if (!reg) throw new Error('CONSOLE_FRAME_UNAVAILABLE: page 未注册');
    if (frame === page.mainFrame()) {
      const tree = await reg.cdp.send('Page.getFrameTree');
      const rootId = tree?.frameTree?.frame?.id;
      if (typeof rootId !== 'string' || !rootId) {
        throw new Error('CONSOLE_FRAME_UNAVAILABLE: 主 frame id 缺失');
      }
      return rootId;
    }
    const parent = frame.parentFrame();
    if (!parent) throw new Error('FRAME_UNAVAILABLE: frame 缺父 frame');
    const parentTarget = await this.resolvePageDataTarget(page, parent);
    const contextId = parentTarget.defaultContextId;
    if (contextId === undefined) {
      throw new Error('FRAME_UNAVAILABLE: 父 frame default execution context 缺失');
    }
    const objectGroup = 'e2et-frame-owner-' + Math.random().toString(36).slice(2) + '-' + Date.now().toString(36);
    let owner: ElementHandle | undefined;
    let completed = false;
    try {
      try {
        owner = await frame.frameElement();
      } catch {
        throw new Error('FRAME_UNAVAILABLE: frame owner 不可用');
      }
      const selector = await owner.evaluate((node) => {
        if (!node.isConnected || node.nodeType !== 1) return null;
        const element = node as Element;
        const parts: string[] = [];
        for (let current: Element | null = element; current; current = current.parentElement) {
          let index = 1;
          for (let sibling = current.previousElementSibling; sibling; sibling = sibling.previousElementSibling) index++;
          parts.unshift(`${current.tagName.toLowerCase()}:nth-child(${index})`);
        }
        const path = parts.join(' > ');
        return document.querySelector(path) === element ? path : null;
      });
      if (typeof selector !== 'string' || selector === '') {
        throw new Error('FRAME_UNAVAILABLE: frame owner 唯一 DOM 路径无法证明');
      }
      const evaluated = await parentTarget.session.send<{ result?: { objectId?: string }; exceptionDetails?: unknown }>('Runtime.evaluate', {
        expression: `document.querySelector(${JSON.stringify(selector)})`,
        contextId,
        objectGroup,
      });
      if (evaluated?.exceptionDetails || typeof evaluated?.result?.objectId !== 'string' || !evaluated.result.objectId) {
        throw new Error('FRAME_UNAVAILABLE: frame owner 节点不可解析');
      }
      const described = await parentTarget.session.send<{ node?: { frameId?: string } }>('DOM.describeNode', {
        objectId: evaluated.result.objectId,
      });
      const frameId = described?.node?.frameId;
      if (typeof frameId !== 'string' || !frameId) {
        throw new Error('FRAME_UNAVAILABLE: frame owner 缺真实 frameId');
      }
      let stillOwner = false;
      try {
        stillOwner = await owner.evaluate((node, path) => node.isConnected && document.querySelector(path) === node, selector);
      } catch {
        stillOwner = false;
      }
      if (!stillOwner) throw new Error('FRAME_UNAVAILABLE: frame owner 身份已失效');
      if (frame.isDetached()) throw new Error('FRAME_UNAVAILABLE: frame 已 detach');
      completed = true;
      return frameId;
    } finally {
      const cleanupErrors: unknown[] = [];
      try {
        await parentTarget.session.send('Runtime.releaseObjectGroup', { objectGroup });
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (owner) {
        try {
          await owner.dispose();
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (completed && cleanupErrors.length > 0) throw cleanupErrors[0];
    }
  }

  /** 选定 frame 的真实数据通道:同源/main 用 page root session,OOPIF 用实际 child channel;不按主文档兜底。 */
  async resolvePageDataTarget(page: Page, frame: Frame): Promise<{
    session: ConsoleObserverChannel & { off(method: string, handler: (params: any) => void): void };
    frameId: string;
    defaultContextId?: number;
  }> {
    const reg = this.registrations.get(page);
    if (!reg?.consoleObserver) throw new Error('PAGE_DATA_FRAME_UNAVAILABLE: page 未注册');
    const frameId = await this.resolveConsoleFrameId(page, frame);
    const child = [...(reg.consoleChildren?.values() ?? [])].find((meta) => meta.frameId === frameId);
    if (child) {
      if (!child.channel) throw new Error('PAGE_DATA_FRAME_UNAVAILABLE: child channel 缺失');
      const contextId = child.observer.getDefaultContext(frameId);
      return { session: child.channel, frameId, ...(contextId === undefined ? {} : { defaultContextId: contextId }) };
    }
    const rootCtx = reg.consoleObserver.getDefaultContext(frameId);
    return {
      session: {
        send: (method, params) => reg.cdp.send(method, params),
        on: (method, handler) => { reg.cdp.on(method, handler); return () => { reg.cdp.off(method, handler); }; },
        off: (method, handler) => { reg.cdp.off(method, handler); },
      },
      frameId,
      ...(rootCtx === undefined ? {} : { defaultContextId: rootCtx }),
    };
  }

  async start(context: BrowserContext, cdpEndpoint: string): Promise<void> {
    const parsedEndpoint = new URL(cdpEndpoint);
    if (parsedEndpoint.protocol !== 'ws:' && parsedEndpoint.protocol !== 'wss:') {
      throw new Error('REQUEST_TRACKER_START_FAILED: 浏览器 CDP endpoint 必须是 ws(s)');
    }
    this.context = context;
    const existingPage = context.pages().find((page) => !page.isClosed());
    const identityPage = existingPage ?? await context.newPage();
    let identityFailed = false;
    let identitySession: Awaited<ReturnType<BrowserContext['newCDPSession']>> | undefined;
    try {
      identitySession = await context.newCDPSession(identityPage);
      const result = await withinDeadline(identitySession.send('Target.getTargetInfo'));
      const contextId = result.targetInfo.browserContextId;
      const targetId = result.targetInfo.targetId;
      if (typeof targetId !== 'string' || !targetId || result.targetInfo.type !== 'page') throw new Error('REQUEST_TRACKER_IDENTITY_FAILED: Target.getTargetInfo 缺真实 page targetId');
      if (contextId !== undefined && (typeof contextId !== 'string' || !contextId)) throw new Error('REQUEST_TRACKER_IDENTITY_FAILED: browserContextId 非法');
      this.identityTargetId = targetId;
      this.browserContextId = contextId;
    } catch (error) {
      identityFailed = true;
      throw error;
    } finally {
      const errors: unknown[] = [];
      if (identitySession) {
        try { await withinDeadline(identitySession.detach()); } catch (error) { errors.push(error); }
      }
      if (!existingPage) {
        try { await withinDeadline(identityPage.close()); } catch (error) { errors.push(error); }
      }
      if (errors.length) {
        this.failures.push(...errors);
        if (!identityFailed) throw errors[0];
      }
    }
    const socket = createNativeSocket(cdpEndpoint);
    this.root = socket;
    socket.on('message', this.onSocketMessage);
    socket.on('error', this.onSocketError);
    socket.on('close', this.onSocketClose);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('REQUEST_TRACKER_WS_OPEN_TIMEOUT')), 10_000);
        socket.once('open', () => { clearTimeout(timer); resolve(); });
        socket.once('error', () => { clearTimeout(timer); reject(new Error('REQUEST_TRACKER_WS_OPEN_FAILED')); });
      });
    } catch (error) {
      this.stopped = true;
      socket.close();
      throw error;
    }
    const deadline = Date.now() + 30_000;
    const targets = await this.sendRoot('Target.getTargets', {}, deadline).catch((error: unknown) => {
      this.stopped = true;
      socket.close();
      throw error;
    });
    this.preexisting = new Set(targets.targetInfos.map((info: { targetId: string }) => info.targetId));
    this.diagnostic('autoAttachArm', { phase: 'listeners-ready', contextId: this.browserContextId });
    await this.sendRoot('Target.setAutoAttach', {
      autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
      filter: [{ type: 'page', exclude: false }, { exclude: true }],
    }, deadline).catch((error: unknown) => {
      this.stopped = true;
      socket.close();
      throw error;
    });
  }

  private trackTask(task: Promise<void>): void {
    this.tasks.add(task);
    void task.catch((error: unknown) => this.failures.push(error)).finally(() => this.tasks.delete(task));
  }

  private sendChild(sessionId: string, method: string, params: Record<string, unknown> = {}, deadline = Date.now() + 30_000): Promise<any> {
    return this.sendWire(sessionId, method, params, deadline);
  }

  private sendRoot(method: string, params: Record<string, unknown>, deadline: number): Promise<any> {
    return this.sendWire(undefined, method, params, deadline);
  }

  private sendWire(sessionId: string | undefined, method: string, params: Record<string, unknown>, deadline: number): Promise<any> {
    if (!this.root) return Promise.reject(new Error('REQUEST_TRACKER_ROOT_MISSING'));
    if (deadline <= Date.now()) return Promise.reject(new Error(`REQUEST_TRACKER_COMMAND_TIMEOUT: ${method}`));
    const bodyRead = method === 'Network.getResponseBody' || method === 'Network.getRequestPostData';
    if (this.stopped && bodyRead) return Promise.reject(new Error('REQUEST_TRACKER_DISPOSED'));
    const id = ++this.commandId;
    const key = pendingKey(sessionId, id);
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (!bodyRead) {
        timer = setTimeout(() => {
          this.pending.delete(key);
          reject(new Error(`REQUEST_TRACKER_COMMAND_TIMEOUT: ${method}`));
        }, Math.max(0, deadline - Date.now()));
      }
      this.pending.set(key, { method, resolve, reject, timer, bodyRead });
      this.diagnostic('command', {
        method,
        id,
        sid: sessionId,
        targetId: sessionId ? this.children.get(sessionId)?.targetId : undefined,
        contextId: this.browserContextId,
      });
      const message = JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) });
      this.root!.send(message, (error?: Error) => {
        if (error) {
          const pending = this.pending.get(key);
          if (!pending) return;
          if (pending.timer) clearTimeout(pending.timer);
          this.pending.delete(key);
          pending.reject(error);
        }
      });
    });
  }

  private readonly onSocketMessage = (raw: unknown): void => {
    let message: { id?: number; method?: string; params?: any; result?: any; error?: any; sessionId?: string };
    try {
      message = JSON.parse(String(raw));
      if (typeof message.id === 'number') {
        const key = pendingKey(message.sessionId, message.id);
        const pending = this.pending.get(key);
        if (!pending) return;
        if (pending.timer) clearTimeout(pending.timer);
        this.pending.delete(key);
        this.diagnostic('commandResponse', {
          method: pending.method,
          id: message.id,
          sid: message.sessionId,
          targetId: message.sessionId ? this.children.get(message.sessionId)?.targetId : undefined,
          contextId: this.browserContextId,
          status: message.error ? 'error' : 'ok',
        });
        if (message.error) pending.reject(new Error(`REQUEST_TRACKER_CDP_ERROR: ${JSON.stringify(message.error)}`));
        else pending.resolve(message.result ?? {});
      } else if (typeof message.method === 'string') {
        if (message.sessionId === undefined) {
          if (message.method === 'Target.attachedToTarget') this.onAttached(message.params);
          else if (message.method === 'Target.detachedFromTarget') this.onDetached(message.params);
          return;
        }
        const child = this.children.get(message.sessionId);
        for (const listener of child?.listeners.get(message.method) ?? []) listener(message.params);
      } else {
        throw new Error('REQUEST_TRACKER_INVALID_MESSAGE');
      }
    } catch (error) {
      this.failures.push(error);
      this.rejectAllPending(error);
    }
  };

  private rejectChannel(sessionId: string, error: unknown): void {
    for (const [key, pending] of this.pending) {
      if (!key.startsWith(`${sessionId}\0`)) continue;
      if (pending.timer) clearTimeout(pending.timer);
      this.pending.delete(key);
      pending.reject(error);
    }
  }

  private rejectAllPending(error: unknown): void {
    for (const [key, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      this.pending.delete(key);
      pending.reject(error);
    }
  }

  private readonly onSocketError = (): void => {
    const error = new Error('REQUEST_TRACKER_WS_ERROR');
    this.diagnostic('transport', { phase: 'error' });
    if (!this.stopped) this.failures.push(error);
    this.rejectAllPending(error);
  };

  private readonly onSocketClose = (): void => {
    const error = new Error('REQUEST_TRACKER_WS_CLOSED');
    this.diagnostic('transport', { phase: 'closed' });
    if (!this.stopped) this.failures.push(error);
    for (const sessionId of this.children.keys()) this.onDetached({ sessionId });
    this.rejectAllPending(error);
  };

  private readonly onDetached = (payload: { sessionId: string }): void => {
    const child = this.children.get(payload.sessionId);
    for (const reg of this.registrations.values()) reg.consolePending?.delete(payload.sessionId);
    if (child) {
      const consoleEntry = this.consoleBySession.get(payload.sessionId);
      if (consoleEntry) {
        consoleEntry.reg.consoleRetired?.push(consoleEntry.observer.snapshot());
        consoleEntry.observer.dispose();
        consoleEntry.reg.consoleChildren?.delete(payload.sessionId);
        this.consoleBySession.delete(payload.sessionId);
      }
      for (const off of child.networkOff?.splice(0) ?? []) { try { off(); } catch { /* listener 已失效 */ } }
      const reason = child.type === 'page' ? 'TARGET_CLOSED' : 'FRAME_CHANNEL_DETACHED';
      let failed = false;
      for (const reg of new Set([...this.registrations.values(), ...this.targets.values()])) {
        for (const [key, hop] of [...reg.inflight]) {
          const inChannel = hop.transportTargetId === child.targetId;
          const parentDocument = hop.resourceType.toLowerCase() === 'document'
            && child.frameId !== undefined && hop.frameId === child.frameId;
          if (!inChannel && !parentDocument) continue;
          reg.inflight.delete(key);
          if (hop.record.failed === undefined) hop.record.failed = reason;
          failed = true;
          this.diagnostic('request', {
            targetId: reg.targetId,
            contextId: this.browserContextId,
            path: hop.record.path,
            nav: hop.record.nav,
            callIndex: hop.record.call_index,
            phase: 'channelDetached',
            transportTargetId: child.targetId,
            frameId: hop.frameId,
            reason,
          });
        }
      }
      const pageReg = child.type === 'page' ? this.targets.get(child.targetId) : undefined;
      if (pageReg) {
        pageReg.sessionClosed = true;
        this.targets.delete(child.targetId);
        void this.disposeRegistration(pageReg).catch((error: unknown) => {
          this.diagnostic('target', { phase: 'dispose-error', targetId: child.targetId, error: String(error) });
        });
      }
      child.paused = false;
      this.diagnostic('target', {
        phase: 'detached',
        sid: payload.sessionId,
        targetId: child.targetId,
        contextId: this.browserContextId,
      });
      for (const listener of child.listeners.get('close') ?? []) listener({});
      this.children.delete(payload.sessionId);
      if (failed) this.notifyCompletion();
    }
    this.rejectChannel(payload.sessionId, new Error('REQUEST_TRACKER_CHILD_DETACHED'));
  };

  private async releaseUnowned(sessionId: string, paused: boolean): Promise<void> {
    const deadline = Date.now() + 30_000;
    let failed = false;
    try {
      if (paused) {
        await this.sendChild(sessionId, 'Runtime.runIfWaitingForDebugger', {}, deadline);
        this.diagnostic('resume', { sid: sessionId, phase: 'unowned' });
      }
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      if (deadline <= Date.now()) {
        this.failures.push(new Error('REQUEST_TRACKER_COMMAND_TIMEOUT: unowned detach'));
      } else {
        try { await this.sendRoot('Target.detachFromTarget', { sessionId }, deadline); } catch (error) {
          if (!failed) throw error;
          this.failures.push(error);
        }
        this.diagnostic('target', { phase: 'detachedUnowned', sid: sessionId });
      }
    }
  }

  private readonly onAttached = (payload: { sessionId: string; waitingForDebugger: boolean; targetInfo: { targetId: string; openerId?: string; browserContextId?: string; type: string } }): void => {
    const { sessionId, targetInfo } = payload;
    if (this.stopped) {
      this.trackTask(this.releaseUnowned(sessionId, payload.waitingForDebugger));
      return;
    }
    const owned = targetInfo.type === 'page' && targetInfo.browserContextId === this.browserContextId && !this.preexisting.has(targetInfo.targetId)
      && (!this.mainTargetId || !!targetInfo.openerId && this.targets.has(targetInfo.openerId));
    if (!owned) {
      this.diagnostic('target', {
        phase: 'unowned',
        sid: sessionId,
        targetId: targetInfo.targetId,
        contextId: targetInfo.browserContextId,
      });
      this.trackTask(this.releaseUnowned(sessionId, payload.waitingForDebugger));
      return;
    }
    const child: ChildSession = {
      targetId: targetInfo.targetId,
      type: 'page',
      listeners: new Map<string, Set<(params: any) => void>>(),
      paused: payload.waitingForDebugger,
    };
    this.diagnostic('target', {
      phase: 'attached',
      sid: sessionId,
      targetId: targetInfo.targetId,
      contextId: targetInfo.browserContextId,
    });
    this.children.set(sessionId, child);
    const transport: RequestSession = {
      send: (method, params) => this.sendChild(sessionId, method, params),
      on: (event, listener) => {
        if (!child.listeners.has(event)) child.listeners.set(event, new Set());
        child.listeners.get(event)!.add(listener);
      },
      off: (event, listener) => child.listeners.get(event)?.delete(listener),
      detach: async () => {
        const deadline = Date.now() + 30_000;
        this.diagnostic('target', {
          phase: 'detachStart',
          sid: sessionId,
          targetId: child.targetId,
          contextId: this.browserContextId,
        });
        if (child.paused) {
          await this.sendChild(sessionId, 'Runtime.runIfWaitingForDebugger', {}, deadline);
          child.paused = false;
        }
        await this.sendRoot('Target.detachFromTarget', { sessionId }, deadline);
        this.diagnostic('target', {
          phase: 'detachedByOwner',
          sid: sessionId,
          targetId: child.targetId,
          contextId: this.browserContextId,
        });
      },
    };
    const reg = this.createRegistration(undefined, transport, targetInfo.targetId, sessionId);
    this.targets.set(targetInfo.targetId, reg);
    for (const waiter of this.targetWaiters.get(targetInfo.targetId) ?? []) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
    this.targetWaiters.delete(targetInfo.targetId);
    reg.attachPromise = this.initializeRegistration(reg).then(async () => {
      const deadline = Date.now() + 30_000;
      if (deadline <= Date.now()) throw new Error('REQUEST_TRACKER_COMMAND_TIMEOUT: Runtime.runIfWaitingForDebugger');
      await this.sendChild(sessionId, 'Runtime.runIfWaitingForDebugger', {}, deadline);
      this.diagnostic('resume', {
        sid: sessionId,
        targetId: targetInfo.targetId,
        contextId: this.browserContextId,
        phase: 'page-network-frame-ready',
      });
      child.paused = false;
    }).catch(async (error: unknown) => {
      try { await this.disposeRegistration(reg); } catch { /* first error is the real attach failure */ }
      throw error;
    });
    this.trackTask(reg.attachPromise);
  };

  private createRegistration(page: Page | undefined, cdp: RequestSession, targetId?: string, sessionId?: string): PageRegistration {
    const isFirst = !this.n0Taken;
    this.n0Taken = true;
    return {
      page, targetId, sessionId, cdp,
      state: { mainFrameId: null, currentUrl: 'about:blank', currentNavId: isFirst ? 'n0' : this.nav.next() },
      inflight: new Map(), off: [], gen: 0, disposed: false, attachPromise: undefined!, sessionClosed: false,
      pendingRootNetwork: [],
    };
  }

  private async readPageTargetInfo(page: Page): Promise<{ targetId: string; browserContextId?: string }> {
    if (!this.context || page.context() !== this.context) {
      throw new Error('REQUEST_TRACKER_BINDING_FAILED: public Page 不属于本 context');
    }
    const session = await this.context.newCDPSession(page);
    let bindingFailed = false;
    try {
      const result = await withinDeadline(session.send('Target.getTargetInfo'));
      if (typeof result?.targetInfo?.targetId !== 'string' || !result.targetInfo.targetId) {
        throw new Error('REQUEST_TRACKER_BINDING_FAILED: Target.getTargetInfo 缺真实 page targetId');
      }
      return {
        targetId: result.targetInfo.targetId,
        ...(result.targetInfo.browserContextId === undefined ? {} : { browserContextId: result.targetInfo.browserContextId }),
      };
    } catch (error) {
      bindingFailed = true;
      throw error;
    } finally {
      try { await withinDeadline(session.detach()); } catch (error) {
        this.failures.push(error);
        if (!bindingFailed) throw error;
      }
    }
  }

  async ownedPages(): Promise<Page[]> {
    if (!this.root || !this.context) throw new Error('REQUEST_TRACKER_START_REQUIRED');
    if (this.targets.size === 0) return [];
    const candidates = new Map<string, Page>();
    for (const candidate of this.context.pages()) {
      if (candidate.isClosed() || this.registrations.has(candidate)) continue;
      const targetInfo = await this.readPageTargetInfo(candidate);
      if (targetInfo.browserContextId !== this.browserContextId) continue;
      if (targetInfo.targetId === this.identityTargetId || this.preexisting.has(targetInfo.targetId)) continue;
      if (!this.targets.has(targetInfo.targetId)) continue;
      const existing = candidates.get(targetInfo.targetId);
      if (existing && existing !== candidate) {
        throw new Error('REQUEST_TRACKER_BINDING_FAILED: 多个 Page 对应同一 owned target');
      }
      candidates.set(targetInfo.targetId, candidate);
    }
    const pages: Page[] = [];
    for (const [targetId, reg] of this.targets) {
      if (reg.disposed || reg.sessionClosed || this.targets.get(targetId) !== reg) continue;
      if (targetId === this.identityTargetId || this.preexisting.has(targetId)) continue;
      let page = reg.page;
      if (page) {
        if (this.registrations.get(page) !== reg) {
          throw new Error('REQUEST_TRACKER_BINDING_FAILED: 已绑定 Page 与 target owner 不一致');
        }
        const duplicate = candidates.get(targetId);
        if (duplicate && duplicate !== page) {
          throw new Error('REQUEST_TRACKER_BINDING_FAILED: 多个 Page 对应同一 owned target');
        }
        if (page.isClosed()) continue;
      } else {
        page = candidates.get(targetId);
        if (!page || page.isClosed()) continue;
        await this.attach(page);
      }
      await reg.attachPromise;
      if (reg.disposed || reg.sessionClosed || this.targets.get(targetId) !== reg) continue;
      if (reg.page !== page) {
        throw new Error('REQUEST_TRACKER_BINDING_FAILED: target 已绑定其它 Page');
      }
      if (page.isClosed()) continue;
      pages.push(page);
    }
    return pages;
  }

  private async bindPage(page: Page): Promise<void> {
    const targetInfo = await this.readPageTargetInfo(page);
    if (targetInfo.browserContextId !== this.browserContextId) throw new Error('REQUEST_TRACKER_BINDING_FAILED: Page browserContextId 不属于本 run');
    if (targetInfo.targetId === this.identityTargetId) throw new Error('REQUEST_TRACKER_BINDING_FAILED: 不能把预先 identity Page 当新 run main');
    let reg = this.targets.get(targetInfo.targetId);
    if (!reg) {
      await this.waitForTarget(targetInfo.targetId, Date.now() + 5_000);
      reg = this.targets.get(targetInfo.targetId);
    }
    if (!reg) throw new Error('REQUEST_TRACKER_BINDING_FAILED: 实际 Page target 不属于早流 owner');
    if (reg.page && reg.page !== page) throw new Error('REQUEST_TRACKER_BINDING_FAILED: target 已绑定其它 Page');
    this.mainTargetId ??= targetInfo.targetId;
    reg.page = page;
    this.registrations.set(page, reg);
    await reg.attachPromise;
  }

  attach(page: Page): Promise<void> {
    const binding = this.bindings.get(page);
    if (binding) return binding;
    const existing = this.registrations.get(page);
    if (existing && !existing.disposed) return existing.attachPromise;
    if (!this.root) return Promise.reject(new Error('REQUEST_TRACKER_START_REQUIRED'));
    const promise = this.bindPage(page);
    this.bindings.set(page, promise);
    return promise;
  }

  private waitForTarget(targetId: string, deadline: number): Promise<void> {
    if (this.targets.has(targetId)) return Promise.resolve();
    if (deadline <= Date.now()) return Promise.reject(new Error('REQUEST_TRACKER_BINDING_FAILED: 等待 early target 超时'));
    return new Promise<void>((resolve, reject) => {
      const waiters = this.targetWaiters.get(targetId) ?? new Set();
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          waiters.delete(waiter);
          if (waiters.size === 0) this.targetWaiters.delete(targetId);
          reject(new Error('REQUEST_TRACKER_BINDING_FAILED: 等待 early target 超时'));
        }, Math.max(0, deadline - Date.now())),
      };
      waiters.add(waiter);
      this.targetWaiters.set(targetId, waiters);
    });
  }

  /** page 级 iframe autoAttach：child 先建 Console collector，再 resume；失败明确记录并 detach。 */
  private async attachFrameConsole(reg: PageRegistration, payload: any): Promise<void> {
    const sid = String(payload?.sessionId ?? '');
    const targetInfo = payload?.targetInfo ?? {};
    const targetId = String(targetInfo.targetId ?? '');
    const waiting = payload?.waitingForDebugger === true;
    if (!sid) return;
    if (String(targetInfo.type ?? '') !== 'iframe') {
      if (waiting) await this.sendChild(sid, 'Runtime.runIfWaitingForDebugger', {}, Date.now() + 30_000).catch(() => {});
      return;
    }
    const child: ChildSession = this.children.get(sid) ?? {
      targetId, type: 'iframe', listeners: new Map(), paused: waiting,
    };
    this.children.set(sid, child);
    const channel = {
      send: <T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> => this.sendChild(sid, method, params) as Promise<T>,
      on: (method: string, handler: (params: unknown) => void): (() => void) => {
        if (!child.listeners.has(method)) child.listeners.set(method, new Set());
        child.listeners.get(method)!.add(handler);
        return () => { child.listeners.get(method)?.delete(handler); };
      },
      off: (method: string, handler: (params: any) => void): void => {
        child.listeners.get(method)?.delete(handler);
      },
    };
    let observer: ConsoleObserver | undefined;
    try {
      await this.sendChild(sid, 'Page.enable', {}, Date.now() + 30_000);
      const tree = await this.sendChild(sid, 'Page.getFrameTree', {}, Date.now() + 30_000) as {
        frameTree?: { frame?: { id?: string; name?: string; url?: string; urlFragment?: string } };
      };
      const frame = tree?.frameTree?.frame;
      const frameId = typeof frame?.id === 'string' ? frame.id : undefined;
      if (!frameId) throw new Error('FRAME_UNAVAILABLE: OOPIF child 缺真实 frameId');
      child.frameId = frameId;
      if (!child.networkOff) {
        const transport: NetworkTransport = { cdp: channel, transportTargetId: targetId, frameId, root: false };
        child.networkOff = [
          channel.on('Network.requestWillBeSent', (params) => this.onRequestWillBeSent(reg, transport, params)),
          channel.on('Network.responseReceived', (params) => this.onResponseReceived(reg, transport, params)),
          channel.on('Network.loadingFinished', (params) => this.onLoadingFinished(reg, transport, params)),
          channel.on('Network.loadingFailed', (params) => this.onLoadingFailed(reg, transport, params)),
        ];
        await channel.send('Network.enable');
      }
      observer = new ConsoleObserver(channel, targetId, () => this.consoleAttribution());
      await observer.start();
      reg.consoleChildren?.set(sid, {
        observer, frameId, channel,
        name: String(frame?.name ?? ''),
        url: String(frame?.url ?? '') + String(frame?.urlFragment ?? ''),
      });
      this.consoleBySession.set(sid, { reg, observer, ...(frameId ? { frameId } : {}) });
      if (waiting) {
        await this.sendChild(sid, 'Runtime.runIfWaitingForDebugger', {}, Date.now() + 30_000);
        child.paused = false;
      }
    } catch (error) {
      observer?.dispose();
      for (const off of child.networkOff?.splice(0) ?? []) { try { off(); } catch { /* listener 已失效 */ } }
      reg.consoleErrors?.push(`frame-attach:${targetId}`);
      if (waiting) {
        try { await this.sendChild(sid, 'Runtime.runIfWaitingForDebugger', {}, Date.now() + 30_000); } catch { /* child 已消失 */ }
      }
      try { await this.sendRoot('Target.detachFromTarget', { sessionId: sid }, Date.now() + 30_000); } catch { /* 已 detach */ }
      throw error;
    } finally {
      reg.consolePending?.delete(sid);
    }
  }

  private async initializeRegistration(reg: PageRegistration): Promise<void> {
    const { state } = reg;
    try {
      const cdp = reg.cdp;
      const off: Array<() => void> = [];
      reg.off = off;
      const transport: NetworkTransport = {
        cdp, transportTargetId: reg.targetId ?? ROOT_CHANNEL, root: true,
      };
      const handleRootNetwork = (handler: () => void): void => {
        if (state.mainFrameId === null) {
          reg.pendingRootNetwork.push(handler);
          return;
        }
        handler();
      };
      const onRequestWillBeSent = (params: any): void => handleRootNetwork(() => this.onRequestWillBeSent(reg, transport, params));
      const onResponseReceived = (params: any): void => handleRootNetwork(() => this.onResponseReceived(reg, transport, params));
      const onLoadingFinished = (params: any): void => handleRootNetwork(() => this.onLoadingFinished(reg, transport, params));
      const onLoadingFailed = (params: any): void => handleRootNetwork(() => this.onLoadingFailed(reg, transport, params));
      const onFrameNavigated = (params: any): void => {
        const frame = params?.frame;
        const frameId = typeof frame?.id === 'string' ? frame.id : '';
        if (frame?.parentId === undefined && frameId !== '' && state.mainFrameId === null) {
          state.mainFrameId = frameId;
          this.flushRootNetworkQueue(reg);
        }
        const isMain = this.nav.onFrameNavigated(state, {
          id: frameId,
          parentId: frame?.parentId,
          url: frame?.url !== undefined ? String(frame.url) : undefined,
          urlFragment: frame?.urlFragment !== undefined ? String(frame.urlFragment) : undefined,
        });
        if (isMain) {
          reg.gen++;
          this.nav.finishPending(state);
        }
      };
      const onNavigatedWithinDocument = (params: any): void => {
        const navigation = this.nav.onSameDocument(state, {
          frameId: params?.frameId !== undefined ? String(params.frameId) : undefined,
          url: String(params?.url ?? state.currentUrl),
        });
        if (navigation) reg.gen++;
      };
      const onPageClose = (): void => {
        reg.sessionClosed = true;
        this.diagnostic('target', {
          phase: 'close',
          targetId: reg.targetId,
          contextId: this.browserContextId,
        });
        void this.disposeRegistration(reg).catch((error: unknown) => console.error('❌ request tracker cleanup:', error));
      };
      cdp.on('Network.requestWillBeSent', onRequestWillBeSent);
      cdp.on('Network.responseReceived', onResponseReceived);
      cdp.on('Network.loadingFinished', onLoadingFinished);
      cdp.on('Network.loadingFailed', onLoadingFailed);
      cdp.on('Page.frameNavigated', onFrameNavigated);
      cdp.on('Page.navigatedWithinDocument', onNavigatedWithinDocument);
      cdp.on('close', onPageClose);
      reg.offClose = () => { cdp.off('close', onPageClose); };
      off.push(() => cdp.off('Network.requestWillBeSent', onRequestWillBeSent));
      off.push(() => cdp.off('Network.responseReceived', onResponseReceived));
      off.push(() => cdp.off('Network.loadingFinished', onLoadingFinished));
      off.push(() => cdp.off('Network.loadingFailed', onLoadingFailed));
      off.push(() => cdp.off('Page.frameNavigated', onFrameNavigated));
      off.push(() => cdp.off('Page.navigatedWithinDocument', onNavigatedWithinDocument));
      reg.consoleChildren = new Map();
      reg.consolePending = new Set();
      reg.consoleRetired = [];
      reg.consoleErrors = [];
      const onFrameAttached = (params: any): void => {
        if (String(params?.targetInfo?.type ?? '') === 'iframe' && typeof params?.sessionId === 'string') {
          reg.consolePending?.add(params.sessionId);
        }
        void this.attachFrameConsole(reg, params).catch((error: unknown) => {
          this.diagnostic('console', { phase: 'frame-attach-error', sid: params?.sessionId, error: String(error) });
        });
      };
      cdp.on('Target.attachedToTarget', onFrameAttached);
      off.push(() => cdp.off('Target.attachedToTarget', onFrameAttached));
      const onFrameDetached = (params: any): void => {
        if (typeof params?.sessionId === 'string') this.onDetached({ sessionId: params.sessionId });
      };
      cdp.on('Target.detachedFromTarget', onFrameDetached);
      off.push(() => cdp.off('Target.detachedFromTarget', onFrameDetached));
      const pageEnabled = cdp.send('Page.enable');
      const networkEnabled = cdp.send('Network.enable');
      const autoAttached = cdp.send('Target.setAutoAttach', {
        autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
        filter: [{ type: 'iframe', exclude: false }, { exclude: true }],
      });
      await Promise.all([pageEnabled, networkEnabled, autoAttached]);
      reg.consoleObserver = new ConsoleObserver(
        {
          send: (method, params) => cdp.send(method, params),
          on: (method, handler) => { cdp.on(method, handler); return () => { cdp.off(method, handler); }; },
        },
        reg.targetId ?? '',
        () => this.consoleAttribution(),
      );
      await reg.consoleObserver.start();
      const genBefore = reg.gen;
      const tree = await cdp.send('Page.getFrameTree');
      const frame = tree?.frameTree?.frame;
      if (typeof frame?.id !== 'string' || frame.id === '') {
        throw new Error('❌ 请求追踪 attach 失败：Page.getFrameTree 未返回非空主帧 id');
      }
      const observedUrl = String(frame.url ?? '') + String(frame.urlFragment ?? '');
      // 旧快照不覆盖新事件：仅 generation 未变时填 mainFrameId，并在早流处理后补 URL
      if (reg.gen === genBefore) {
        state.mainFrameId = frame.id;
        this.flushRootNetworkQueue(reg);
        if (!state.pendingNavigation) state.currentUrl = observedUrl;
      }
      this.diagnostic('initialized', {
        sid: reg.sessionId,
        targetId: reg.targetId,
        contextId: this.browserContextId,
        phase: 'Page.enable+Network.enable+Page.getFrameTree',
      });
    } catch (e) {
      try { await this.disposeRegistration(reg); } catch (error) { console.error('❌ request tracker cleanup:', error); }
      throw e;
    }
  }

  /** 主帧身份未就绪时的 Root Network 早流：按原收到顺序补处理一次。 */
  private flushRootNetworkQueue(reg: PageRegistration): void {
    if (reg.state.mainFrameId === null || reg.disposed) return;
    for (const handler of reg.pendingRootNetwork.splice(0)) handler();
  }

  private disposeRegistration(reg: PageRegistration): Promise<void> {
    const existing = this.disposals.get(reg);
    if (existing) return existing;
    reg.disposed = true;
    reg.pendingRootNetwork.splice(0);
    if (reg.page) this.registrations.delete(reg.page);
    const cleanup = Promise.resolve().then(async () => {
      const errors: unknown[] = [];
      try { reg.consoleObserver?.dispose(); } catch { /* collector 释放失败不覆盖主清理 */ }
      for (const meta of reg.consoleChildren?.values() ?? []) {
        try { meta.observer.dispose(); } catch { /* 同上 */ }
      }
      for (const off of reg.off) { try { off(); } catch (error) { errors.push(error); } }
      reg.off = [];
      if (reg.cdp) {
        try { if (!reg.sessionClosed) await withinDeadline(reg.cdp.detach()); } catch (error) {
          if (!reg.sessionClosed && !reg.page?.isClosed()) errors.push(error);
        } finally {
          try { reg.offClose?.(); } catch (error) { errors.push(error); }
        }
      }
      if (errors.length) throw new Error(`REQUEST_TRACKER_CLEANUP_FAILED: ${errors.map(String).join('; ')}`);
    });
    this.disposals.set(reg, cleanup);
    return cleanup;
  }

  async dispose(): Promise<void> {
    const errors: unknown[] = [];
    this.stopped = true;
    const deadline = Date.now() + 30_000;
    for (const waiters of this.targetWaiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('REQUEST_TRACKER_DISPOSED'));
      }
    }
    this.targetWaiters.clear();
    this.rejectAllPending(new Error('REQUEST_TRACKER_DISPOSED'));
    if (this.root) {
      for (const [sessionId, child] of this.children) {
        if (!child.paused) continue;
        try { await this.sendChild(sessionId, 'Runtime.runIfWaitingForDebugger', {}, deadline); child.paused = false; } catch (error) { errors.push(error); }
      }
    }
    try {
      while (this.tasks.size) await withinDeadline(Promise.allSettled(this.tasks), deadline - Date.now());
    } catch (error) { errors.push(error); }
    for (const reg of new Set([...this.registrations.values(), ...this.targets.values()])) {
      void this.disposeRegistration(reg).catch(() => undefined);
    }
    for (const result of await Promise.allSettled(this.disposals.values())) if (result.status === 'rejected') errors.push(result.reason);
    if (this.root) {
      try { await this.sendRoot('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: true }, deadline); } catch (error) { errors.push(error); }
      try {
        while (this.tasks.size) await withinDeadline(Promise.allSettled(this.tasks), deadline - Date.now());
      } catch (error) { errors.push(error); }
      const socket = this.root;
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('REQUEST_TRACKER_WS_CLOSE_TIMEOUT')), Math.max(0, deadline - Date.now()));
          socket.once('close', () => { clearTimeout(timer); resolve(); });
          this.diagnostic('transport', { phase: 'close_requested', reason: 'dispose' });
          socket.close();
        });
      } catch (error) {
        errors.push(error);
      }
      socket.off('message', this.onSocketMessage);
      socket.off('error', this.onSocketError);
      socket.off('close', this.onSocketClose);
    }
    errors.push(...this.failures);
    if (errors.length) throw new Error(`REQUEST_TRACKER_CLEANUP_FAILED: ${errors.map(String).join('; ')}`);
  }

  /** exact transport key -> owner 内唯一 Document hop；fetch/XHR 不走 Document fallback。 */
  private resolveNetworkHop(
    reg: PageRegistration,
    transport: NetworkTransport,
    requestId: string,
    frameId: string | undefined,
    documentOnly: boolean,
  ): { key: string; hop: RequestHop } | undefined {
    const exactKey = requestKey(transport.transportTargetId, requestId);
    const exact = reg.inflight.get(exactKey);
    if (exact) return { key: exactKey, hop: exact };
    if (!documentOnly || !frameId) return undefined;
    let matched: { key: string; hop: RequestHop } | undefined;
    for (const [key, hop] of reg.inflight) {
      if (hop.requestId !== requestId || hop.frameId !== frameId) continue;
      if (hop.resourceType.toLowerCase() !== 'document') continue;
      if (matched) return undefined;
      matched = { key, hop };
    }
    return matched;
  }

  private onRequestWillBeSent(reg: PageRegistration, transport: NetworkTransport, params: any): void {
    const requestId = String(params?.requestId ?? '');
    const request = params?.request;
    if (!requestId || !request?.url) return;
    const { state, inflight } = reg;
    const resourceType = String(params?.type ?? '');
    const frameId = params?.frameId !== undefined ? String(params.frameId) : transport.frameId;

    // redirect 前跳：保留真实 status；链尾 settle；不伪造 body/成功完成
    const redirectPrevious = params.redirectResponse
      ? this.resolveNetworkHop(reg, transport, requestId, frameId, true)
      : undefined;
    if (params.redirectResponse && redirectPrevious) {
      const previous = redirectPrevious.hop;
      const status = (params.redirectResponse as { status?: number }).status;
      if (typeof status === 'number' && previous.record.status === undefined) previous.record.status = status;
      const headers = (params.redirectResponse as { headers?: Record<string, unknown> }).headers;
      previous.record.responseHeaders = redactHeaders(headers);
      previous.record.responseHeadersRedacted = redactedHeaderKeys(headers, previous.record.responseHeaders);
      inflight.delete(redirectPrevious.key);
      previous.replaced = true;
      // 前跳已启动的 postData 晚到时回填保留（不覆盖失败、不触发完成）
      if (previous.postDataPromise) {
        void previous.postDataPromise.then((value) => {
          if (value !== undefined && previous.record.requestBody === undefined && previous.record.failed === undefined) {
            previous.record.requestBody = value;
            this.bodyDiagnostic(previous, 'requestBody', value);
          }
        });
      }
    }

    // Document 跨 transport 重复 start：在分配 nav/callIndex/record 前按 owner+frame+requestId 唯一去重。
    if (!params.redirectResponse && resourceType.toLowerCase() === 'document' && frameId) {
      if (this.resolveNetworkHop(reg, transport, requestId, frameId, true)) return;
    }

    const redirectContinuation = !!params.redirectResponse && !!redirectPrevious?.hop.mainDocument;
    // 共享分号在过滤/建 record 之前调用（main Document 起始即切新 n，不等 commit）
    const mainDocument = transport.root
      ? this.nav.onRequest(state, {
        resourceType,
        frameId: params?.frameId !== undefined ? String(params.frameId) : undefined,
        url: String(request.url),
        redirectContinuation,
      })
      : false;

    if (!ALLOWED_TYPES.has(resourceType.toLowerCase())) return;
    if (!/^https?:\/\//i.test(String(request.url))) return;

    const url = String(request.url);
    const path = requestPath(url);
    const nav = state.currentNavId;
    const indexKey = nav + '\0' + path;
    const callIndex = (this.callIndexes.get(indexKey) ?? 0) + 1;
    this.callIndexes.set(indexKey, callIndex);

    const record: RequestRecord = {
      url,
      method: String(request.method ?? 'GET'),
      path,
      nav,
      call_index: callIndex,
      started: eventTime(params.wallTime),
      // 事件已附带的 postData 原串保留
      ...(request.postData !== undefined ? { requestBody: String(request.postData) } : {}),
    };
    this.history.push(record);
    if (reg.targetId) this.targetHistory.set(record, reg.targetId);
    this.diagnostic('request', {
      targetId: reg.targetId,
      contextId: this.browserContextId,
      path,
      nav,
      callIndex: callIndex,
      method: record.method,
      phase: 'requestWillBeSent',
    });
    if (record.requestBody !== undefined) this.bodyDiagnostic({ record }, 'requestBody', record.requestBody);
    const hop: RequestHop = {
      record,
      requestId,
      ...(frameId ? { frameId } : {}),
      transportTargetId: transport.transportTargetId,
      resourceType,
      mainDocument,
      replaced: false,
      // hasPostData 且缺 postData：立即发起，失败 catch=>undefined 不伪造请求体
      ...(request.postData === undefined && request.hasPostData ? {
        postDataPromise: transport.cdp.send('Network.getRequestPostData', { requestId })
          .then((result) => (result as { postData?: string } | undefined)?.postData).catch(() => undefined),
      } : {}),
    };
    inflight.set(requestKey(transport.transportTargetId, requestId), hop);
  }

  private onResponseReceived(reg: PageRegistration, transport: NetworkTransport, params: any): void {
    const requestId = String(params?.requestId ?? '');
    const frameId = transport.root
      ? undefined
      : (params?.frameId !== undefined ? String(params.frameId) : transport.frameId);
    const resolved = this.resolveNetworkHop(reg, transport, requestId, frameId, !transport.root);
    if (!resolved) return;
    const hop = resolved.hop;
    // 精确归因：只给本 requestId 对应 hop 设 status，不按 path/最新记录混归因
    const status = (params?.response as { status?: number })?.status;
    if (typeof status === 'number' && hop.record.status === undefined) hop.record.status = status;
    const headers = (params?.response as { headers?: Record<string, unknown> })?.headers;
    hop.record.responseHeaders = redactHeaders(headers);
    hop.record.responseHeadersRedacted = redactedHeaderKeys(headers, hop.record.responseHeaders);
    this.diagnostic('request', {
      targetId: reg.targetId,
      contextId: this.browserContextId,
      path: hop.record.path,
      nav: hop.record.nav,
      callIndex: hop.record.call_index,
      status: hop.record.status,
      phase: 'responseReceived',
    });
  }

  private onLoadingFinished(reg: PageRegistration, transport: NetworkTransport, params: any): void {
    const requestId = String(params?.requestId ?? '');
    const frameId = transport.root
      ? undefined
      : (params?.frameId !== undefined ? String(params.frameId) : transport.frameId);
    const resolved = this.resolveNetworkHop(reg, transport, requestId, frameId, !transport.root);
    if (!resolved) return;
    const hop = resolved.hop;
    reg.inflight.delete(resolved.key);
    if (hop.mainDocument) this.nav.finishPending(reg.state);
    // 立即发起 getResponseBody；与 postData 都 settle 后一次性提交，不拿 headers/status 当完成
    const bodyPromise = transport.cdp.send('Network.getResponseBody', { requestId: hop.requestId })
      .then((value) => ({ value: value as { body?: string; base64Encoded?: boolean } | undefined }))
      .catch((e) => ({ error: (e as Error)?.message ?? 'body_read_failed' }));
    const postData = hop.postDataPromise ?? Promise.resolve(undefined);
    this.trackTask(Promise.all([bodyPromise, postData]).then(([body, post]) => {
      if (hop.replaced) return;
      // F5：先判 terminal 失败——已失败后不允许任何成功回填（late 成功不覆盖失败）
      if (hop.record.failed !== undefined) return;
      if (this.stopped) {
        hop.record.failed = 'REQUEST_TRACKER_DISPOSED';
        this.notifyCompletion();
        return;
      }
      if ('error' in body) {
        // body 读取拒绝 = 终端失败，不伪造 body
        hop.record.failed = body.error;
        this.notifyCompletion();
        return;
      }
      // F5：真实 typeof string 才算 body（空串合法）；缺失/非法形状记固定 terminal，不伪造空串
      const raw = body.value?.body;
      if (typeof raw !== 'string') {
        hop.record.failed = 'body_read_failed';
        this.notifyCompletion();
        return;
      }
      // base64 按 Buffer 解码
      hop.record.body = body.value?.base64Encoded === true ? Buffer.from(raw, 'base64').toString('utf8') : raw;
      this.bodyDiagnostic(hop, 'responseBody', hop.record.body);
      if (post !== undefined && hop.record.requestBody === undefined) {
        hop.record.requestBody = post;
        this.bodyDiagnostic(hop, 'requestBody', post);
      }
      this.notifyCompletion();
    }));
  }

  private onLoadingFailed(reg: PageRegistration, transport: NetworkTransport, params: any): void {
    const requestId = String(params?.requestId ?? '');
    const frameId = transport.root
      ? undefined
      : (params?.frameId !== undefined ? String(params.frameId) : transport.frameId);
    const resolved = this.resolveNetworkHop(reg, transport, requestId, frameId, !transport.root);
    if (!resolved) return;
    const hop = resolved.hop;
    reg.inflight.delete(resolved.key);
    // 立即写 terminal failure 并通知；late postData 不能清除该失败
    if (hop.record.failed === undefined) {
      hop.record.failed = String(params?.errorText ?? 'request_failed');
      this.diagnostic('request', {
        targetId: reg.targetId,
        contextId: this.browserContextId,
        path: hop.record.path,
        nav: hop.record.nav,
        callIndex: hop.record.call_index,
        status: hop.record.status,
        phase: 'loadingFailed',
      });
      this.notifyCompletion();
    }
    if (hop.mainDocument) this.nav.finishPending(reg.state);
  }

  /** 按 path+nav+call_index 精确查询 */
  query(path: string, nav: number, callIndex: number): RequestRecord | undefined {
    const navStr = 'n' + nav;
    return this.history.find(
      (r) => r.path === path && r.nav === navStr && r.call_index === callIndex,
    );
  }

  /** 按 path 模糊查询，取最近一条 */
  queryLatest(path: string): RequestRecord | undefined {
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.history[i].path === path) return this.history[i];
    }
    return undefined;
  }

  /** 等待指定 ref 的响应体完成。
   *  ref 对应的请求可能尚未开始（下游 AI → checkProducer 链路延后发起），因此始终订阅完成通知，
   *  每次通知重新 query 精确 ref，只 resolve 自己的已完成 body；不捕获初始 record。
   *  page 已关闭 / AbortSignal 已中止 → 立即拒绝（订阅后事件不可观察过去）。
   *  超时/关闭/中止/完成 每个终态分支清理监听与定时器。 */
  waitForComplete(
    page: Page,
    ref: { path: string; nav: number; call_index: number },
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<RequestRecord> {
    // 订阅前先检查已终态：close/abort 事件已发生，事后挂监听不可观察
    if (page.isClosed()) {
      return Promise.reject(new Error('❌ 接口等待失败: page 已关闭'));
    }
    if (signal?.aborted) return Promise.reject(new Error('❌ 接口等待被中止'));

    // 立即可就绪的 record：仍需在 close/abort 未发生的前提下接受
    const initial = this.query(ref.path, ref.nav, ref.call_index);
    if (initial?.failed) return Promise.reject(new WaitApiFailure(ref, initial.failed));
    if (initial?.body !== undefined) return Promise.resolve(initial);

    return new Promise<RequestRecord>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      // 每次通知重新 query 精确 ref（请求可能延后发起）
      const listener: CompletionListener = () => {
        if (settled) return;
        if (page.isClosed()) { cleanup(); reject(new Error('❌ 接口等待失败: page 已关闭')); return; }
        if (signal?.aborted) { cleanup(); reject(new Error('❌ 接口等待被中止')); return; }
        const rec = this.query(ref.path, ref.nav, ref.call_index);
        if (!rec) return; // 请求还未发起，继续等
        if (rec.failed) { cleanup(); reject(new WaitApiFailure(ref, rec.failed)); return; }
        if (rec.body !== undefined) { cleanup(); resolve(rec); return; }
      };
      const onTimeout = (): void => {
        if (settled) return;
        cleanup();
        reject(new Error(
          `❌ 接口等待超时 {path:${ref.path},nav:${ref.nav},call_index:${ref.call_index}}（${timeoutMs}ms 内 body 未完成）`,
        ));
      };
      const onPageClose = (): void => {
        if (settled) return;
        cleanup();
        reject(new Error('❌ 接口等待失败: page 已关闭'));
      };
      const onAbort = (): void => {
        if (settled) return;
        cleanup();
        reject(new Error('❌ 接口等待被中止'));
      };
      const cleanup = (): void => {
        settled = true;
        if (timer) { clearTimeout(timer); timer = undefined; }
        this.completionListeners.delete(listener);
        page.off('close', onPageClose);
        signal?.removeEventListener('abort', onAbort);
      };
      this.completionListeners.add(listener);
      page.on('close', onPageClose);
      signal?.addEventListener('abort', onAbort);
      timer = setTimeout(onTimeout, Math.max(0, timeoutMs));
    });
  }

  private notifyCompletion(): void {
    for (const l of this.completionListeners) {
      try { l(); } catch { /* listener 自处理错误 */ }
    }
  }
}
