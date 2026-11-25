import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';
import { DaemonClient } from '../daemon/client.js';
import { runDaemon } from '../daemon/daemon.js';
import type { BootstrapResult } from '../daemon/bootstrap.js';
import { resolveSocketPath, traceDir } from '../daemon/session-meta.js';
import { readTraceEvents } from '../daemon/trace.js';
import { buildIr } from '../ir/build.js';
import { checkIr } from '../ir/check.js';
import { judgeIr } from '../ir/judge.js';
import { parseTrace } from '../ir/trace-reader.js';
import { MAX_WAIT_TIMEOUT_MS } from '../wait-timeout.js';
import { encodeLine, type DaemonRequest } from '../daemon/protocol.js';

class DaemonCdp {
  calls: string[] = [];
  closeCalled = false;
  private listeners = new Map<string, Array<(params: any) => void>>();
  private resolveNavigate: (() => void) | null = null;
  private started: (() => void) | null = null;
  readonly navigateStarted = new Promise<void>((resolve) => { this.started = resolve; });
  private targetUrl = 'about:blank';

  constructor(private readonly options: { deferResponseBody?: boolean; failPageEnable?: boolean } = {}) {}

  on(method: string, handler: (params: any) => void): () => void {
    const list = this.listeners.get(method) ?? [];
    list.push(handler);
    this.listeners.set(method, list);
    return () => this.listeners.set(method, list.filter((item) => item !== handler));
  }

  onClose(): void {}
  close(): void { this.closeCalled = true; }

  async send<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push(method);
    if (method === 'Page.enable' && this.options.failPageEnable) throw new Error('Page.enable token=init-secret');
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main', loaderId: '', url: 'about:blank', securityOrigin: '' } } } as T;
    if (method === 'Page.navigate') {
      this.targetUrl = String(params.url);
      this.started?.();
      return await new Promise<T>((resolve) => { this.resolveNavigate = () => resolve({} as T); });
    }
    if (method === 'Accessibility.getFullAXTree') return { nodes: [] } as T;
    if (method === 'Network.getResponseBody' && this.options.deferResponseBody) return await new Promise<T>(() => {});
    if (method === 'Network.getResponseBody') return { body: '{"token":"response-secret","ok":true}' } as T;
    return {} as T;
  }

  async evaluate<T = any>(expression: string): Promise<T> {
    if (expression.includes('window.innerWidth')) return { width: 1280, height: 720, deviceScaleFactor: 2 } as T;
    if (expression.includes('readyState')) return 'complete' as T;
    if (expression.includes('__e2etChangeCount')) return 0 as T;
    if (expression.includes('__e2etObserver')) return true as T;
    return '' as T;
  }

  releaseNavigation(): void {
    this.emit('Network.requestWillBeSent', {
      requestId: 'document-1', frameId: 'main', type: 'Document', wallTime: Date.now() / 1000,
      request: {
        url: this.targetUrl,
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: 'Bearer header-secret' },
        postData: '{"password":"request-secret"}',
      },
    });
    this.emit('Network.responseReceived', {
      requestId: 'document-1',
      response: { status: 200, mimeType: 'application/json', headers: { 'content-type': 'application/json', 'set-cookie': 'sid=cookie-secret' } },
    });
    this.emit('Page.frameNavigated', { frame: { id: 'main', url: this.targetUrl } });
    this.emit('Network.loadingFinished', { requestId: 'document-1' });
    this.resolveNavigate?.();
    setTimeout(() => this.emit('Page.loadEventFired', {}), 0);
  }

  private emit(method: string, params: any): void {
    for (const handler of this.listeners.get(method) ?? []) handler(params);
  }
}

describe('daemon page.open trace 集成', () => {
  let home: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.E2ET_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-network-'));
    process.env.E2ET_HOME = home;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.E2ET_HOME;
    else process.env.E2ET_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('ready 前启用监听；page.open 写 action/navigation/request；并发 open 返回 BUSY', async () => {
    const id = 'daemon-trace';
    const socket = resolveSocketPath(id);
    const cdp = new DaemonCdp();
    const bootstrap = async (): Promise<BootstrapResult> => ({
      tabId: 'tab', session: cdp as any, endpoint: 'http://127.0.0.1:0', browserSource: 'managed',
    });
    const done = runDaemon(id, { env: 'pre', socketPath: socket, browserBootstrap: bootstrap, exitOnStop: false });
    const deadline = Date.now() + 5000;
    while (!(await DaemonClient.ping(socket, 100)) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(cdp.calls).toContain('Network.enable');

    const first = await DaemonClient.connect(socket);
    const second = await DaemonClient.connect(socket);
    const open = first.request('page.open', {
      // Phase2 URL 来源守卫：query 含 token 会被整条命令拒绝（AUTH_DATA_NOT_REPLAYABLE），
      // 能落 trace 的只有无实际替换的 URL；本测试聚焦 trace 集成，用普通业务 query
      url: 'https://example.test/next?ref=normal', intent: '打开页面',
    }, { requestTimeoutMs: 5000 });
    await cdp.navigateStarted;
    await expect(second.request('page.open', {
      url: 'https://example.test/other', intent: '并发打开',
    })).rejects.toMatchObject({ code: 'BUSY' });
    await expect(second.request('stop', {})).rejects.toMatchObject({ code: 'BUSY' });
    cdp.releaseNavigation();
    const result = await open as any;
    expect(result).toMatchObject({ action_id: 'a1', navigation: 'n1', requests: [{ id: 'r1', nav: 'n1', call_index: 1, status: 200 }] });

    await first.request('stop', {});
    first.close();
    second.close();
    await done;

    const dir = traceDir(id);
    const events = fs.readFileSync(path.join(dir, 'trace.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(events[0]).toMatchObject({ t: 'session', viewport: { width: 1280, height: 720, deviceScaleFactor: 2 } });
    expect(events.find((event) => event.t === 'navigation')).toMatchObject({ id: 'n1', triggered_by: 'a1', kind: 'same_page' });
    expect(events.find((event) => event.t === 'request')).toMatchObject({ id: 'r1', nav: 'n1', call_index: 1, triggered_by: 'a1' });
    expect(events.find((event) => event.t === 'action')).toMatchObject({ id: 'a1', kind: 'open', nav: 'n1', requests: ['r1'], result: { ok: true } });
    expect(events.filter((event) => event.t === 'session_end')).toHaveLength(1);
    expect(events.findIndex((event) => event.t === 'action')).toBeLessThan(events.findIndex((event) => event.t === 'session_end'));
    const all = fs.readFileSync(path.join(dir, 'trace.jsonl'), 'utf8')
      + fs.readdirSync(path.join(dir, 'blobs')).map((name) => fs.readFileSync(path.join(dir, 'blobs', name), 'utf8')).join('');
    for (const secret of ['header-secret', 'cookie-secret', 'request-secret', 'response-secret']) {
      expect(all).not.toContain(secret);
    }
  }, 15000);

  it('deferred response body 有短超时，stop 等 request finalize 后才写 session_end', async () => {
    const id = 'daemon-body-timeout';
    const socket = resolveSocketPath(id);
    const cdp = new DaemonCdp({ deferResponseBody: true });
    const done = runDaemon(id, {
      env: 'pre', socketPath: socket, exitOnStop: false,
      browserBootstrap: async () => ({ tabId: 'tab', session: cdp as any, endpoint: 'http://127.0.0.1:0' }),
    });
    const deadline = Date.now() + 5000;
    while (!(await DaemonClient.ping(socket, 100)) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    const client = await DaemonClient.connect(socket);
    const open = client.request('page.open', { url: 'https://example.test/deferred', intent: '打开延迟页' }, { requestTimeoutMs: 5000 });
    await cdp.navigateStarted;
    cdp.releaseNavigation();
    await open;
    const stopStarted = Date.now();
    await client.request('stop', {}, { requestTimeoutMs: 5000 });
    expect(Date.now() - stopStarted).toBeLessThan(5000);
    client.close();
    await done;

    const events = fs.readFileSync(path.join(traceDir(id), 'trace.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const requestIndex = events.findIndex((event) => event.t === 'request');
    const endIndex = events.findIndex((event) => event.t === 'session_end');
    expect(events[requestIndex]).toMatchObject({ resp_body_omitted: 'body_unavailable' });
    expect(requestIndex).toBeGreaterThanOrEqual(0);
    expect(endIndex).toBeGreaterThan(requestIndex);
  }, 15000);

  it('Page.enable 初始化失败写 aborted，并销毁 existing context/连接', async () => {
    const id = 'daemon-init-fail';
    const socket = resolveSocketPath(id);
    const cdp = new DaemonCdp({ failPageEnable: true });
    const ownerCalls: string[] = [];
    const owner = {
      send: vi.fn(async (method: string) => { ownerCalls.push(method); return {}; }),
      onClose: vi.fn(),
      close: vi.fn(),
    };
    await expect(runDaemon(id, {
      env: 'pre', socketPath: socket, exitOnStop: false,
      browserBootstrap: async () => ({
        tabId: 'tab', session: cdp as any, endpoint: 'http://127.0.0.1:9222',
        browserSource: 'existing', browserContextId: 'ctx', owner: owner as any,
      }),
    })).rejects.toThrow('网络监听初始化失败');

    expect(cdp.closeCalled).toBe(true);
    expect(ownerCalls).toContain('Target.disposeBrowserContext');
    expect(owner.close).toHaveBeenCalledOnce();
    const events = fs.readFileSync(path.join(traceDir(id), 'trace.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(events.map((event) => [event.t, event.result])).toEqual([
      ['session', undefined],
      ['session_end', 'aborted'],
    ]);
    const meta = JSON.parse(fs.readFileSync(path.join(home, 'sessions', id + '.json'), 'utf8'));
    expect(meta.error).not.toContain('init-secret');
    expect(meta.session_end.result).toBe('aborted');
  }, 15000);
});

/** Phase D：open 等待链路 fake CDP。复用 DaemonCdp 的事件时序，另补：
 *  可配 location.href（显式 wait_url 轮询）、localStorage（assert.data）、截图、
 *  loadingFailed 注入（wait_api transport 失败）。 */
class PhaseDOpenCdp {
  calls: string[] = [];
  closeCalled = false;
  locationHref = 'https://page.test/app';
  storageEntries: Array<[string, string]> = [];
  failApi = false;
  /** 慢导航：navMs 后导航返回（TTFB ≤ 30s 真实 CDP send 上限），再 loadMs 后 loadEventFired（< NAV_TIMEOUT 20s），
   *  两段各自在真实上限内、总 exec 超过 client 初始 30s 传输预算 */
  slowNav: { navMs: number; loadMs: number } | undefined;
  private listeners = new Map<string, Array<(params: any) => void>>();
  private resolveNavigate: (() => void) | null = null;
  private started: (() => void) | null = null;
  readonly navigateStarted = new Promise<void>((resolve) => { this.started = resolve; });
  private targetUrl = 'about:blank';

  on(method: string, handler: (params: any) => void): () => void {
    const list = this.listeners.get(method) ?? [];
    list.push(handler);
    this.listeners.set(method, list);
    return () => this.listeners.set(method, list.filter((item) => item !== handler));
  }

  onClose(): void {}
  close(): void { this.closeCalled = true; }

  async send<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push(method);
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main', loaderId: '', url: 'about:blank', securityOrigin: '' } } } as T;
    if (method === 'Page.navigate') {
      this.targetUrl = String(params.url);
      this.started?.();
      if (this.slowNav) {
        const { navMs, loadMs } = this.slowNav;
        setTimeout(() => {
          this.emitDocumentSettled();
          this.resolveNavigate?.();
          setTimeout(() => this.emit('Page.loadEventFired', {}), loadMs);
        }, navMs);
      }
      return await new Promise<T>((resolve) => { this.resolveNavigate = () => resolve({} as T); });
    }
    if (method === 'Accessibility.getFullAXTree') return { nodes: [] } as T;
    if (method === 'Page.captureScreenshot') return { data: Buffer.from('png').toString('base64') } as T;
    if (method === 'Storage.getStorageKeyForFrame') return { storageKey: 'https://page.test' } as T;
    if (method === 'DOMStorage.getDOMStorageItems') return { entries: this.storageEntries.map(([k, v]) => [k, v]) } as T;
    if (method === 'Runtime.evaluate') {
      const expr = String(params.expression ?? '');
      if (expr.includes('__e2etChangeCount')) return { result: { value: 0 } } as T;
      if (expr.includes('location.href')) return { result: { value: this.locationHref } } as T;
      return { result: { value: '' } } as T;
    }
    if (method === 'Network.getResponseBody') return { body: '{"ok":true}' } as T;
    return {} as T;
  }

  async evaluate<T = any>(expression: string): Promise<T> {
    if (expression.includes('window.innerWidth')) return { width: 1280, height: 720, deviceScaleFactor: 2 } as T;
    if (expression.includes('readyState')) return 'complete' as T;
    if (expression.includes('__e2etChangeCount')) return 0 as T;
    if (expression.includes('__e2etObserver')) return true as T;
    if (expression.includes('location.href')) return this.locationHref as T;
    return '' as T;
  }

  releaseNavigation(): void {
    if (this.failApi) {
      this.emit('Network.requestWillBeSent', {
        requestId: 'doc-fail', frameId: 'main', type: 'Document', wallTime: Date.now() / 1000,
        request: { url: this.targetUrl, method: 'GET', headers: {} },
      });
      this.emit('Network.loadingFailed', { requestId: 'doc-fail', errorText: 'net::ERR_CONNECTION_REFUSED', type: 'Document' });
      this.emit('Page.frameNavigated', { frame: { id: 'main', url: this.targetUrl } });
      this.resolveNavigate?.();
      setTimeout(() => this.emit('Page.loadEventFired', {}), 0);
      return;
    }
    this.emitDocumentSettled();
    this.resolveNavigate?.();
    setTimeout(() => this.emit('Page.loadEventFired', {}), 0);
  }

  private emitDocumentSettled(): void {
    this.emit('Network.requestWillBeSent', {
      requestId: 'document-1', frameId: 'main', type: 'Document', wallTime: Date.now() / 1000,
      request: {
        url: this.targetUrl,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      },
    });
    this.emit('Network.responseReceived', {
      requestId: 'document-1',
      response: { status: 200, mimeType: 'application/json', headers: { 'content-type': 'application/json' } },
    });
    this.emit('Page.frameNavigated', { frame: { id: 'main', url: this.targetUrl } });
    this.emit('Network.loadingFinished', { requestId: 'document-1' });
  }

  private emit(method: string, params: any): void {
    for (const handler of this.listeners.get(method) ?? []) handler(params);
  }
}

describe('Phase D：page.open 并入 runAction 等待链路', () => {
  let home: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.E2ET_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-phase-d-'));
    process.env.E2ET_HOME = home;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.E2ET_HOME;
    else process.env.E2ET_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  interface Booted { socket: string; done: Promise<void>; id: string }

  async function boot(cdp: PhaseDOpenCdp): Promise<Booted> {
    const id = 'phd-' + Math.random().toString(36).slice(2, 8);
    const socket = resolveSocketPath(id);
    fs.rmSync(socket, { force: true });
    const done = runDaemon(id, {
      env: 'pre', socketPath: socket, exitOnStop: false,
      browserBootstrap: async (): Promise<BootstrapResult> => ({
        tabId: 'tab', session: cdp as any, endpoint: 'http://127.0.0.1:0',
        authSource: 'imported', browserSource: 'managed',
      }),
    });
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (await DaemonClient.ping(socket, 200)) break;
      await new Promise((r) => setTimeout(r, 30));
    }
    return { socket, done, id };
  }

  /** 无论成败都收资源：stop + close + await done（done 带 race 超时，失败断言不跳过清理也不挂死） */
  async function runWith<T>(booted: Booted, fn: (client: DaemonClient) => Promise<T>): Promise<T> {
    const client = await DaemonClient.connect(booted.socket);
    try {
      return await fn(client);
    } finally {
      try { await client.request('stop', {}, { requestTimeoutMs: 10000 }); } catch { /* 已停/失败也继续清理 */ }
      client.close();
      await Promise.race([booted.done, new Promise((r) => setTimeout(r, 5000))]);
    }
  }

  /** 裸 socket 直发 page.open：观察 wait-start 通知行（DaemonClient 会消费通知，裸 socket 才能计数） */
  function openViaRawSocket(socket: string, params: Record<string, unknown>, timeoutMs = 30000): Promise<{ waitStarts: number[]; response: any }> {
    return new Promise((resolve, reject) => {
      const conn = net.connect(socket);
      let buf = '';
      const waitStarts: number[] = [];
      let response: any;
      const timer = setTimeout(() => { conn.destroy(); reject(new Error('raw socket 观察超时')); }, timeoutMs);
      conn.setEncoding('utf8');
      conn.on('connect', () => {
        conn.write(encodeLine({ id: 901, method: 'page.open', params } satisfies DaemonRequest));
      });
      conn.on('data', (chunk: string) => {
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          const msg = JSON.parse(line);
          if ('wait_deadline_ms' in msg) waitStarts.push(msg.wait_deadline_ms);
          else if ('ok' in msg) response = msg;
        }
        if (response !== undefined) { clearTimeout(timer); conn.end(); resolve({ waitStarts, response }); }
      });
      conn.on('error', (e) => { clearTimeout(timer); conn.destroy(); reject(e); });
    });
  }

  it('末步 open 默认自动等待：trace 带 url/group/截图/真实 settled_by → build/check/judge 全链通过', async () => {
    const cdp = new PhaseDOpenCdp();
    cdp.storageEntries = [['mode', 'fast']];
    const booted = await boot(cdp);
    const result = await runWith(booted, async (client) => {
      const openP = client.request('page.open', { url: 'https://example.test/app', intent: '打开页面', group: 'G1' });
      await cdp.navigateStarted;
      cdp.releaseNavigation();
      const res = await openP as any;
      expect(res.settled_by?.length).toBeGreaterThan(0);
      const a = await client.request('assert.data', { local_storage: 'mode', equals: 'fast' });
      expect((a as any).pass).toBe(true);
      return res;
    });
    // trace 事实：action 带 url（脱敏）、group、截图、settled_by
    const events = readTraceEvents(booted.id);
    const openAction = events.find((e) => e.t === 'action' && e.kind === 'open') as any;
    expect(openAction.args.url).toBeTruthy();
    expect(openAction.group).toBe('G1');
    expect(openAction.screenshot_path).toBeTruthy();
    expect(openAction.settled_by?.length).toBeGreaterThan(0);
    // 生产链：build → check → judge
    const built = await buildIr(booted.id, { name: 'phd-open-auto' });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const trace = parseTrace(events);
    const lastStep = built.ir.steps[built.ir.steps.length - 1];
    expect(lastStep.action).toBe('open');
    expect((lastStep.wait ?? []).length).toBeGreaterThan(0);
    const checked = checkIr(built.ir, { trace });
    expect(checked.passed).toBe(true);
    expect(checked.failures).toEqual([]);
    const judged = judgeIr(built.ir, { trace });
    expect(judged.regressible).toBe(true);
    expect(judged.reasons).toEqual([]);
    expect(result.action_id).toMatch(/^a\d+$/);
  }, 15000);

  it('末步 open 显式 wait_url：settled_by 记 url 条件，预算落 trace，build/check/judge 通过', async () => {
    const cdp = new PhaseDOpenCdp();
    cdp.storageEntries = [['mode', 'fast']];
    const booted = await boot(cdp);
    await runWith(booted, async (client) => {
      const openP = client.request('page.open', {
        url: 'https://example.test/app', intent: '打开页面',
        wait_url: '/app', wait_timeout_ms: 5000,
      });
      await cdp.navigateStarted;
      cdp.releaseNavigation();
      const res = await openP as any;
      expect(res.settled_by).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'url', url: '/app' })]));
      const a = await client.request('assert.data', { local_storage: 'mode', equals: 'fast' });
      expect((a as any).pass).toBe(true);
    });
    const events = readTraceEvents(booted.id);
    const openAction = events.find((e) => e.t === 'action' && e.kind === 'open') as any;
    expect(openAction.args.wait_timeout_ms).toBe(5000);
    expect(openAction.settled_by).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'url' })]));
    const built = await buildIr(booted.id, { name: 'phd-open-wait-url' });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const trace = parseTrace(events);
    const lastStep = built.ir.steps[built.ir.steps.length - 1];
    expect(lastStep.action).toBe('open');
    expect(lastStep.wait).toEqual(expect.arrayContaining([expect.objectContaining({ url: { contains: '/app' } })]));
    expect(lastStep.wait_timeout_ms).toBe(5000);
    const checked = checkIr(built.ir, { trace });
    expect(checked.passed).toBe(true);
    const judged = judgeIr(built.ir, { trace });
    expect(judged.regressible).toBe(true);
  }, 15000);

  it('显式等待超时 → WAIT_TIMEOUT，失败动作落 trace，build 拒绝（不可产出可接受 IR）', async () => {
    const cdp = new PhaseDOpenCdp();
    cdp.locationHref = 'https://page.test/other';
    const booted = await boot(cdp);
    await runWith(booted, async (client) => {
      const openP = client.request('page.open', {
        url: 'https://example.test/app', intent: '打开页面',
        wait_url: '/never-match', wait_timeout_ms: 300,
      });
      await cdp.navigateStarted;
      cdp.releaseNavigation();
      await expect(openP).rejects.toMatchObject({ code: 'WAIT_TIMEOUT' });
    });
    const events = readTraceEvents(booted.id);
    const openAction = events.find((e) => e.t === 'action' && e.kind === 'open') as any;
    expect(openAction.result.ok).toBe(false);
    expect(openAction.settled_by).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'timeout' })]));
    const built = await buildIr(booted.id, { name: 'phd-open-timeout' });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error.code).toBe('SESSION_NOT_PASS');
  }, 15000);

  it('wait_api transport 失败 → WAIT_API_FAILED，失败动作落 trace，build 拒绝', async () => {
    const cdp = new PhaseDOpenCdp();
    cdp.failApi = true;
    const booted = await boot(cdp);
    await runWith(booted, async (client) => {
      const openP = client.request('page.open', {
        url: 'https://example.test/api/fail', intent: '打开失败接口页',
        wait_api: '/api/fail', wait_timeout_ms: 5000,
      });
      await cdp.navigateStarted;
      cdp.releaseNavigation();
      await expect(openP).rejects.toMatchObject({ code: 'WAIT_API_FAILED' });
    });
    const events = readTraceEvents(booted.id);
    const openAction = events.find((e) => e.t === 'action' && e.kind === 'open') as any;
    expect(openAction.result.ok).toBe(false);
    const built = await buildIr(booted.id, { name: 'phd-open-api-fail' });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error.code).toBe('SESSION_NOT_PASS');
  }, 15000);

  it('open 恰好发一次 socket 预算通知，deadline 覆盖执行+等待总预算（默认慢导航不被 30s 截断）', async () => {
    const cdp = new PhaseDOpenCdp();
    const booted = await boot(cdp);
    try {
      const t0 = Date.now();
      const raw = openViaRawSocket(booted.socket, { url: 'https://example.test/app', intent: '打开页面' });
      await cdp.navigateStarted;
      cdp.releaseNavigation();
      const { waitStarts, response } = await raw;
      expect(waitStarts).toHaveLength(1);
      // 默认无显式等待：30s(请求) + 20s(导航) + 1.2s(settle*2) + 10s(自动等待) + 1.2s(dom idle*4) = 62.4s
      expect(waitStarts[0] - t0).toBeGreaterThanOrEqual(60_000);
      expect(waitStarts[0] - t0).toBeLessThanOrEqual(95_000);
      expect(response.ok).toBe(true);
      expect((response.data as any).settled_by?.length).toBeGreaterThan(0);
    } finally {
      try { const client = await DaemonClient.connect(booted.socket); await client.request('stop', {}, { requestTimeoutMs: 5000 }); client.close(); } catch {}
      await Promise.race([booted.done, new Promise((r) => setTimeout(r, 5000))]);
    }
  }, 15000);

  it('小显式预算 + 慢导航：不被 client 传输定时器误杀，仍返回 WAIT_TIMEOUT（显式超时）', async () => {
    const cdp = new PhaseDOpenCdp();
    cdp.locationHref = 'https://page.test/other';
    // 慢导航构造：14s TTFB（< 30s CDP send 上限）+ 17s load（< NAV_TIMEOUT 20s），
    // 两段各自在真实上限内、总 exec ≈ 31.6s 超过 client 初始 30s 传输预算
    cdp.slowNav = { navMs: 14_000, loadMs: 17_000 };
    const booted = await boot(cdp);
    try {
      const client = await DaemonClient.connect(booted.socket);
      try {
        const openP = client.request('page.open', {
          url: 'https://example.test/slow', intent: '慢导航',
          wait_url: '/never-match', wait_timeout_ms: 1,
        });
        // 未修复：无通知 → 30s 初始定时器在 exec 中途杀掉（daemon 请求超时，非 WAIT_TIMEOUT）；
        // 修复：exec 前通知续命 → 导航完成 → 显式 1ms 预算超时 → WAIT_TIMEOUT
        await expect(openP).rejects.toMatchObject({ code: 'WAIT_TIMEOUT' });
      } finally {
        try { await client.request('stop', {}, { requestTimeoutMs: 5000 }); } catch {}
        client.close();
      }
    } finally {
      await Promise.race([booted.done, new Promise((r) => setTimeout(r, 5000))]);
    }
  }, 45_000);

  it('最大合法 wait 预算：通知恰一次且 deadline 用满预算，请求成功（client 不拒该 deadline）', async () => {
    const cdp = new PhaseDOpenCdp();
    const booted = await boot(cdp);
    try {
      const t0 = Date.now();
      const raw = openViaRawSocket(booted.socket, {
        url: 'https://example.test/app', intent: '打开页面',
        wait_url: '/app', wait_timeout_ms: MAX_WAIT_TIMEOUT_MS,
      });
      await cdp.navigateStarted;
      cdp.releaseNavigation();
      const { waitStarts, response } = await raw;
      expect(waitStarts).toHaveLength(1);
      // 30s + 20s + 1.2s + MAX + 1.2s = MAX + 52.4s（用满合法最大预算）
      expect(waitStarts[0] - t0).toBeGreaterThanOrEqual(MAX_WAIT_TIMEOUT_MS + 40_000);
      expect(waitStarts[0] - t0).toBeLessThanOrEqual(MAX_WAIT_TIMEOUT_MS + 70_000);
      expect(response.ok).toBe(true);
      expect((response.data as any).settled_by).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'url' })]));
    } finally {
      try { const client = await DaemonClient.connect(booted.socket); await client.request('stop', {}, { requestTimeoutMs: 5000 }); client.close(); } catch {}
      await Promise.race([booted.done, new Promise((r) => setTimeout(r, 5000))]);
    }
  }, 15000);

  it('daemon 侧非法 wait_timeout_ms → BAD_REQUEST（动作前拒绝）', async () => {
    const cdp = new PhaseDOpenCdp();
    const booted = await boot(cdp);
    await runWith(booted, async (client) => {
      const openP = client.request('page.open', {
        url: 'https://example.test/app', intent: '打开页面',
        wait_url: '/app', wait_timeout_ms: 'bad',
      });
      // 先挂 rejection 断言（避免 reject 早于 await 造成窗口期 unhandled）
      const assertion = expect(openP).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      // 未修复：导航已开始（navigateStarted 到）→ release 驱动完成 → open 成功返回 → 断言红；
      // 修复：BAD_REQUEST 立即返回（navigateStarted 不到，race 超时后断言直接吃 reject）
      await Promise.race([cdp.navigateStarted, new Promise((r) => setTimeout(r, 3000))]);
      cdp.releaseNavigation();
      await assertion;
    });
    const events = readTraceEvents(booted.id);
    expect(events.filter((e) => e.t === 'action')).toHaveLength(0);
  }, 15000);
});
