/**
 * Browser Daemon Client
 *
 * CDP target 管理 + WebSocket 操控标签页。
 * daemon.ts 按 browser/auth 组合选端点；此处负责探测及 tab 的 CDP 连接。
 */
import { WebSocket } from 'ws';
import type { AuthMode } from '../auth-resolve.js';
import { requestContext } from '../request-context.js';

export type TransportKind = 'native-cdp' | 'managed';
export type BrowserMode = 'auto' | 'existing' | 'chrome' | 'managed';
export type BrowserChoice = { kind: 'existing'; endpoint: string; version?: string } | { kind: 'chrome' | 'managed' };

export function incompatibleBrowserAuth(browser: BrowserMode, auth: AuthMode): string | null {
  if (auth === 'profile' && (browser === 'existing' || browser === 'managed')) return `--browser ${browser} 不能配 --auth profile`;
  if (browser === 'chrome' && auth === 'imported') return '--browser chrome 只能配 --auth profile|auto';
  return null;
}

/** 规范化用户给的 CDP URL：去掉 /json/* 尾巴，剩 discovery 基地址 */
export function nativeBaseUrl(raw: string): string {
  return raw.replace(/\/+$/, '').replace(/\/json(\/version|\/list)?$/i, '');
}

const CDP_TIMEOUT_MS = 30_000;

export interface TabInfo {
  id: string;
  title: string;
  url: string;
}

async function fetchJson<T>(url: string, timeoutMs = 2000): Promise<T | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

interface CdpVersion {
  Browser?: string;
  webSocketDebuggerUrl?: string;
}

type CdpProbe = (base: string) => Promise<CdpVersion | null>;

/** auto 选择 existing 前必须真实探测配置端点；仅有环境变量不等于浏览器可用。 */
export async function configuredCdpAvailable(
  env: NodeJS.ProcessEnv = process.env,
  probe: CdpProbe = (base) => fetchJson<CdpVersion>(`${base}/json/version`, 3000),
): Promise<boolean> {
  const raw = env.E2ET_CDP_URL;
  if (typeof raw !== 'string' || raw.trim() === '') return false;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === 'ws:' || parsed.protocol === 'wss:') return true;
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const version = await probe(nativeBaseUrl(raw));
    return typeof version?.webSocketDebuggerUrl === 'string' && version.webSocketDebuggerUrl.length > 0;
  } catch {
    return false;
  }
}

export async function resolveBrowserChoices(
  browser: BrowserMode,
  auth: AuthMode,
  hasProfile: boolean,
  env: NodeJS.ProcessEnv = process.env,
  probe: CdpProbe = (base) => fetchJson<CdpVersion>(`${base}/json/version`, 3000),
): Promise<BrowserChoice[]> {
  const conflict = incompatibleBrowserAuth(browser, auth);
  if (conflict) throw new Error(conflict);
  if (browser === 'chrome' || (browser === 'auto' && auth === 'profile')) return [{ kind: 'chrome' }];
  if (browser === 'managed') return [{ kind: 'managed' }];
  const port = env.BROWSER_REMOTE_DEBUGGING_PORT ?? '9222';
  const base = env.E2ET_CDP_URL
    ? nativeBaseUrl(env.E2ET_CDP_URL)
    : `http://127.0.0.1:${port}`;
  const version = await probe(base);
  if (browser === 'existing') {
    if (!version?.webSocketDebuggerUrl) throw new Error('现成浏览器 CDP endpoint 不可达（/json/version 无响应）');
    return [{ kind: 'existing', endpoint: base, version: version.Browser }];
  }
  if (auth === 'imported') {
    return version?.webSocketDebuggerUrl
      ? [{ kind: 'existing', endpoint: base, version: version.Browser }]
      : [{ kind: 'managed' }];
  }
  return [
    ...(hasProfile ? [{ kind: 'chrome' as const }] : []),
    ...(version?.webSocketDebuggerUrl ? [{ kind: 'existing' as const, endpoint: base, version: version.Browser }] : []),
    { kind: 'managed' },
  ];
}

/** 在指定浏览器里创建 tab。
 * 现代 Chrome CDP 要求 PUT /json/new（GET 在新版本被拒）。失败不回退同 URL GET：
 * 重复请求只会拖垮启动链而不解决协议不匹配。 */
export async function createTabIn(base: string, url: string): Promise<TabInfo> {
  let res: Response;
  try {
    res = await fetch(`${base}/json/new?${encodeURIComponent(url)}`, {
      method: 'PUT',
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    throw new Error(`创建标签页失败：CDP /json/new 请求失败（${e instanceof Error ? '网络/超时' : '未知'}）`);
  }
  if (!res.ok) {
    throw new Error(`创建标签页失败：CDP /json/new 拒绝（HTTP ${res.status}）`);
  }
  const data = (await res.json()) as { id: string; url: string };
  return { id: data.id, title: '', url: data.url };
}

/** 按 tabId 取真实 page WS URL。baseUrl 必传（不依赖全局 discovery） */
async function resolvePageWsUrl(tabId: string, baseUrl: string): Promise<string> {
  const targets = await fetchJson<Array<{ id: string; type: string; webSocketDebuggerUrl?: string }>>(
    `${baseUrl}/json/list`,
  );
  const target = (targets || []).find((t) => t.id === tabId);
  if (!target?.webSocketDebuggerUrl) {
    throw new Error(`CDP target ${tabId} 不存在或没有 webSocketDebuggerUrl`);
  }
  return target.webSocketDebuggerUrl;
}

/** 单 tab 的 CDP 连接 */
export interface CdpEvent {
  method: string;
  params: any;
  sessionId?: string;
}

export class CdpSession {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private events: CdpEvent[] = [];
  private listeners: Array<{ method: string; handler: (params: any) => void; sessionId?: string }> = [];
  private childCloseListeners = new Map<string, Set<() => void>>();
  readonly sessionId?: string;

  private closed = false;
  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('close', () => requestContext.exit(() => {
      this.closed = true;
      for (const { reject } of this.pending.values()) {
        reject(new Error('CDP 会话已关闭（浏览器断开）'));
      }
      this.pending.clear();
      for (const sessionId of [...this.childCloseListeners.keys()]) this.fireChildClose(sessionId);
    }));
    ws.on('message', (raw: Buffer) => requestContext.exit(() => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.id !== undefined) {
        const p = this.pending.get(this.pendingKey(msg.id, msg.sessionId));
        if (!p) return;
        this.pending.delete(this.pendingKey(msg.id, msg.sessionId));
        if (msg.error) p.reject(new Error(`CDP error: ${msg.error.message}`));
        else p.resolve(msg.result ?? {});
        return;
      }
      if (msg.method) {
        const event: CdpEvent = { method: msg.method, params: msg.params || {} };
        if (msg.sessionId !== undefined) event.sessionId = msg.sessionId;
        if (msg.method === 'Target.detachedFromTarget' && msg.sessionId === undefined) {
          const detached = String(msg.params?.sessionId ?? '');
          if (detached) this.fireChildClose(detached);
        }
        this.events.push(event);
        for (const l of this.listeners) {
          if (l.method === msg.method && l.sessionId === msg.sessionId) l.handler(msg.params || {});
        }
      }
    }));
  }

  static async connect(tabId: string, baseUrl: string): Promise<CdpSession> {
    const wsUrl = await resolvePageWsUrl(tabId, baseUrl);
    const ws = new WebSocket(wsUrl, {
      perMessageDeflate: false,
      maxPayload: 256 * 1024 * 1024,
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CDP 连接 tab ${tabId} 超时`)), 10_000);
      ws.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.once('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`CDP 连接失败: ${err.message}`));
      });
    });
    return new CdpSession(ws);
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}, deadlineMs?: number): Promise<T> {
    return this.sendScoped(undefined, method, params, deadlineMs);
  }

  private sendScoped<T = any>(
    sessionId: string | undefined,
    method: string,
    params: Record<string, unknown> = {},
    deadlineMs?: number,
    inputCleanup = false,
  ): Promise<T> {
    const ctx = requestContext.getStore();
    const cleanup = inputCleanup || method === 'Runtime.releaseObject' || method === 'Runtime.releaseObjectGroup'
      || (method === 'Page.handleJavaScriptDialog' && params.accept === false);
    if (!cleanup && ctx?.signal.aborted) return Promise.reject(ctx.signal.reason);
    if (this.closed) return Promise.reject(new Error('CDP 会话已关闭'));
    const remaining = deadlineMs === undefined ? CDP_TIMEOUT_MS : Math.min(CDP_TIMEOUT_MS, deadlineMs - Date.now());
    if (remaining <= 0) return Promise.reject(new Error(`CDP ${method} 预算耗尽`));
    const id = this.nextId++;
    const key = this.pendingKey(id, sessionId);
    return new Promise<T>((resolve, reject) => {
      const clear = (): void => {
        clearTimeout(timer);
        ctx?.signal.removeEventListener('abort', abort);
      };
      const abort = (): void => {
        const pending = this.pending.get(key);
        this.pending.delete(key);
        pending?.reject(ctx!.signal.reason);
      };
      const timer = setTimeout(() => {
        const pending = this.pending.get(key);
        this.pending.delete(key);
        pending?.reject(new Error(`CDP ${method} 超时`));
      }, remaining);
      this.pending.set(key, {
        resolve: (v) => {
          clear();
          resolve(v);
        },
        reject: (e) => {
          clear();
          reject(e);
        },
      });
      let inputs: Map<string, () => Promise<void>> | undefined;
      let inputKey: string | undefined;
      let release: (() => Promise<void>) | undefined;
      const revokeDown = (): void => {
        if (inputKey !== undefined && release && inputs?.get(inputKey) === release) inputs.delete(inputKey);
      };
      const fail = (error: Error): void => {
        revokeDown();
        const pending = this.pending.get(key);
        this.pending.delete(key);
        pending?.reject(error);
      };
      try {
        const payload = JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) });
        if (!cleanup) {
          ctx?.signal.throwIfAborted();
          ctx?.onProgress(Date.now() + remaining);
          ctx?.signal.throwIfAborted();
          ctx?.signal.addEventListener('abort', abort, { once: true });
        }
        if (ctx && !cleanup) {
          const mouse = method === 'Input.dispatchMouseEvent';
          const keyboard = method === 'Input.dispatchKeyEvent';
          const down = (mouse && params.type === 'mousePressed')
            || (keyboard && (params.type === 'keyDown' || params.type === 'rawKeyDown'));
          const up = (mouse && params.type === 'mouseReleased') || (keyboard && params.type === 'keyUp');
          if (down || up) {
            inputKey = JSON.stringify([sessionId ?? null, mouse ? 'mouse' : 'key', mouse ? params.button : params.key, ...(keyboard ? [params.code] : [])]);
            inputs = ctx.inputCleanups.get(this);
            if (down) {
              if (!inputs) { inputs = new Map(); ctx.inputCleanups.set(this, inputs); }
              const releaseParams = { ...params, type: mouse ? 'mouseReleased' : 'keyUp', ...(mouse ? { buttons: 0 } : {}) };
              release = () => this.sendScoped(sessionId, method, releaseParams, undefined, true).then(() => {});
              inputs.set(inputKey, release);
            }
          }
        }
        let writeFailed = false;
        this.ws.send(payload, (error) => {
          if (!error) return;
          writeFailed = true;
          fail(error);
        });
        if (!writeFailed && inputKey !== undefined && !release) inputs?.delete(inputKey);
      } catch (error) {
        fail(error as Error);
      }
    });
  }

  async evaluate<T = any>(expression: string): Promise<T> {
    return this.evaluateScoped<T>(undefined, expression);
  }

  private async evaluateScoped<T>(sessionId: string | undefined, expression: string): Promise<T> {
    const res = await this.sendScoped<{
      result: { value?: T };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    }>(sessionId, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (res.exceptionDetails) {
      throw new Error(`页面脚本异常: ${res.exceptionDetails.exception?.description || res.exceptionDetails.text}`);
    }
    return res.result.value as T;
  }

  on(method: string, handler: (params: any) => void): () => void {
    return this.onScoped(undefined, method, handler);
  }

  private onScoped(sessionId: string | undefined, method: string, handler: (params: any) => void): () => void {
    const entry = { method, handler, sessionId };
    this.listeners.push(entry);
    return () => {
      const i = this.listeners.indexOf(entry);
      if (i !== -1) this.listeners.splice(i, 1);
    };
  }

  onClose(cb: () => void): void {
    this.ws.on('close', cb);
  }

  takeEvents(methodPrefix?: string): CdpEvent[] {
    const out = this.events.filter((e) => e.sessionId === undefined && (!methodPrefix || e.method.startsWith(methodPrefix)));
    this.events = this.events.filter((e) => e.sessionId !== undefined);
    return out;
  }

  close(): void {
    this.ws.close();
  }

  child(sessionId: string): CdpSession {
    if (this.sessionId !== undefined) throw new Error('CDP child session 不能再挂 child');
    if (!sessionId) throw new Error('CDP child session 需要非空 sessionId');
    const root = this;
    return new Proxy(this, {
      get(target, prop: string | symbol): unknown {
        switch (prop) {
          case 'send':
            return <T = any>(method: string, params: Record<string, unknown> = {}, deadlineMs?: number): Promise<T> =>
              root.sendScoped<T>(sessionId, method, params, deadlineMs);
          case 'evaluate':
            return <T = any>(expression: string): Promise<T> => root.evaluateScoped<T>(sessionId, expression);
          case 'on':
            return (method: string, handler: (params: any) => void): (() => void) =>
              root.onScoped(sessionId, method, handler);
          case 'onClose':
            return (cb: () => void): void => {
              const set = root.childCloseListeners.get(sessionId) ?? new Set<() => void>();
              set.add(cb);
              root.childCloseListeners.set(sessionId, set);
            };
          case 'takeEvents':
            return (prefix?: string): CdpEvent[] => {
              const out = root.events.filter((e) => e.sessionId === sessionId && (!prefix || e.method.startsWith(prefix)));
              root.events = root.events.filter((e) => e.sessionId !== sessionId);
              return out;
            };
          case 'close':
            return (): void => { void root.detachChild(sessionId); };
          case 'detach':
            return (): Promise<void> => root.detachChild(sessionId);
          case 'sessionId':
            return sessionId;
          case 'child':
            return (): never => { throw new Error('CDP child session 不能再挂 child'); };
          default: {
            const value = Reflect.get(target, prop, target);
            return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
          }
        }
      },
    }) as CdpSession;
  }

  async detach(): Promise<void> {
    this.close();
  }

  private async detachChild(sessionId: string): Promise<void> {
    this.fireChildClose(sessionId);
    try {
      await this.sendScoped(undefined, 'Target.detachFromTarget', { sessionId });
    } catch {}
  }

  private fireChildClose(sessionId: string): void {
    const listeners = this.childCloseListeners.get(sessionId);
    this.childCloseListeners.delete(sessionId);
    for (const cb of listeners ?? []) {
      try { cb(); } catch {}
    }
    this.rejectScopedPending(sessionId, new Error('CDP child 会话已 detach'));
  }

  private rejectScopedPending(sessionId: string, error: Error): void {
    const prefix = `${sessionId}\0`;
    for (const [key, pending] of this.pending) {
      if (!key.startsWith(prefix)) continue;
      this.pending.delete(key);
      pending.reject(error);
    }
  }

  private pendingKey(id: number, sessionId: string | undefined): string {
    return `${sessionId ?? '\0root'}\0${id}`;
  }
}

/** 在指定浏览器里关闭 tab */
export async function closeTabIn(base: string, tabId: string): Promise<void> {
  await fetch(`${base}/json/close/${tabId}`, {
    method: 'PUT',
    signal: AbortSignal.timeout(5_000),
  }).catch(() => null);
}
