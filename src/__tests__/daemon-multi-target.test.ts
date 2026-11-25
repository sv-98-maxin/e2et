import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CdpSession } from '../browser/daemon-client.js';
import { runDaemon } from '../daemon/daemon.js';
import type { BootstrapResult } from '../daemon/bootstrap.js';
import { DaemonClient } from '../daemon/client.js';
import { resolveSocketPath, traceDir } from '../daemon/session-meta.js';

vi.mock('../browser/managed-browser.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../browser/managed-browser.js')>();
  return { ...actual, openCdpSession: vi.fn(), resolveChromiumExecutable: vi.fn(() => '/fake/chromium'), launchChromium: vi.fn() };
});

/** 单个 page 的 fake cdp：支持 Page/Network/AX/Runtime，elements 带 backendDOMNodeId。 */
class PageCdp {
  calls: string[] = [];
  closeCalls = 0;
  private listeners = new Map<string, Array<(p: any) => void>>();
  private closeCbs: Array<() => void> = [];
  private url: string;
  private axNodeId: number;
  constructor(url: string, axNodeId: number) { this.url = url; this.axNodeId = axNodeId; }
  on(method: string, h: (p: any) => void) { const l = this.listeners.get(method) ?? []; l.push(h); this.listeners.set(method, l); return () => { this.listeners.set(method, l.filter((x) => x !== h)); }; }
  onClose(cb: () => void) { this.closeCbs.push(cb); }
  close() { this.closeCalls++; for (const cb of this.closeCbs) cb(); }
  fireClose() { for (const cb of this.closeCbs) cb(); }
  listenersCount() { let n = 0; for (const l of this.listeners.values()) n += l.length; return n; }
  async send<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push(method);
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main', loaderId: '', url: this.url, securityOrigin: '' } } } as T;
    if (method === 'Page.navigate') { this.url = String(params.url ?? this.url); setTimeout(() => this.emit('Page.loadEventFired', {}), 0); return {} as T; }
    if (method === 'Page.reload') { setTimeout(() => this.emit('Page.loadEventFired', {}), 0); return {} as T; }
    if (method === 'Page.getNavigationHistory') return { currentIndex: 0, entries: [{ id: 0, url: this.url }] } as T;
    if (method === 'Accessibility.getFullAXTree') return { nodes: [{ nodeId: 'n', role: { type: 'role', value: 'button' }, name: { type: 'string', value: 'btn-' + this.axNodeId }, backendDOMNodeId: this.axNodeId, ignored: false }] } as T;
    if (method === 'DOM.resolveNode') return { object: { objectId: 'obj-' + this.axNodeId } } as T;
    if (method === 'Runtime.callFunctionOn') {
      const fd = String(params.functionDeclaration);
      if (params.returnByValue === false && fd.includes('isElementVisible')) return { result: { type: 'function', objectId: 'snapshot-visibility-fn' } } as T;
      if (fd.includes('return this(element)') || fd.includes('isConnected')) return { result: { value: { connected: true, visible: true } } } as T;
    }
    return {} as T;
  }
  async evaluate<T = any>(expr: string): Promise<T> {
    if (expr.includes('innerWidth')) return { width: 1280, height: 720 } as T;
    if (expr.includes('readyState')) return 'complete' as T;
    if (expr.includes('__e2etChangeCount')) return 0 as T;
    if (expr.includes('__e2etObserver')) return true as T;
    if (expr.includes('document.title')) return { url: this.url, title: 't' } as T;
    if (expr.includes('location.href')) return this.url as T;
    return '' as T;
  }
  emit(m: string, p: any) { for (const h of this.listeners.get(m) ?? []) h(p); }
}

/** fake owner（owned 模式 browser-level WS）：支持 setAutoAttach/getTargets + 派 attachedToTarget。 */
class FakeOwner {
  calls: Array<{ method: string; params: Record<string, unknown>; sessionId?: string }> = [];
  private listeners = new Map<string, Array<(p: any) => void>>();
  onClose() {}
  close() {}
  addEventListener(m: string, h: (p: any) => void) { const l = this.listeners.get(m) ?? []; l.push(h); this.listeners.set(m, l); return () => { this.listeners.set(m, l.filter((x) => x !== h)); }; }
  async send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    this.calls.push({ method, params, sessionId });
    if (method === 'Target.getTargets') return { targetInfos: [{ targetId: 'src', type: 'page' }] } as T;
    return {} as T;
  }
  emit(m: string, p: any) { for (const h of this.listeners.get(m) ?? []) h(p); }
}

describe('daemon 多 target 真实 switch + 跨页 ref', () => {
  let home: string;
  let prevHome: string | undefined;
  beforeEach(() => {
    prevHome = process.env.E2ET_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-multi-'));
    process.env.E2ET_HOME = home;
    process.env.E2ET_IDLE_TIMEOUT_MS = '60000';
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.E2ET_HOME;
    else process.env.E2ET_HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('真实 switch-tab 切 popup 再切回 source；旧源 ref 在子页拒绝、切回后新 ref 可用', async () => {
    const srcCdp = new PageCdp('https://example.test/source', 100);
    const popCdp = new PageCdp('https://example.test/popup', 200);
    const owner = new FakeOwner();
    // CdpSession.connect 按 targetId 路由：src → srcCdp，popup → popCdp
    vi.spyOn(CdpSession, 'connect').mockImplementation(async (tabId: string) => {
      return (tabId === 'popup' ? popCdp : srcCdp) as unknown as CdpSession;
    });
    const { openCdpSession } = await import('../browser/managed-browser.js');
    vi.mocked(openCdpSession).mockResolvedValue(owner as any);

    const id = 'multi-switch';
    const socket = resolveSocketPath(id);
    const done = runDaemon(id, {
      env: 'pre', socketPath: socket, exitOnStop: false,
      browserBootstrap: async (): Promise<BootstrapResult> => ({
        tabId: 'src', session: srcCdp as any, endpoint: 'http://127.0.0.1:0', browserSource: 'managed', owner: owner as any,
      }),
    });
    let client: any = null;
    try {
      const dl = Date.now() + 8000;
      while (!(await DaemonClient.ping(socket, 100)) && Date.now() < dl) await new Promise((r) => setTimeout(r, 30));
      client = await DaemonClient.connect(socket);
      // source page.state → 拿 ref
      const st = await client.request('page.state', {}) as any;
      expect(st.tabs).toHaveLength(1);
      const srcRef = st.elements[0].index;
      // 模拟 popup attachedToTarget（post-arm，新 target，waiting=true）
      owner.emit('Target.attachedToTarget', { targetInfo: { targetId: 'popup', type: 'page', url: 'https://example.test/popup', openerId: 'src' }, sessionId: 'pop-child', waitingForDebugger: true });
      // 等 popup 接管 + resume
      await new Promise((r) => setTimeout(r, 150));
      // 真 switch-tab 到 popup（按 url_contains）
      const sw = await client.request('page.switch-tab', { url_contains: '/popup', intent: '切到 popup' }) as any;
      expect(sw.target_id).toBe('popup');
      expect(sw.switched_to).toContain('/popup');
      expect(sw.from_target_id).toBe('src');
      // 旧源 ref 在 popup 拒绝（跨页 ref 失效）
      await expect(client.request('page.click', { target: '[' + srcRef + ']', intent: '旧源 ref 点子页按钮', snapshot_change_count: st.change_count }))
        .rejects.toMatchObject({ code: 'NOT_FOUND' });
      // popup page.state → 新 ref 可用
      const popSt = await client.request('page.state', {}) as any;
      const popRef = popSt.elements[0].index;
      // switch-tab 切回 source
      const back = await client.request('page.switch-tab', { url_contains: '/source', intent: '切回 source' }) as any;
      expect(back.target_id).toBe('src');
      // 切回后 popup 的旧 ref 在 source 拒绝
      await expect(client.request('page.click', { target: '[' + popRef + ']', intent: 'popup 旧 ref 点源页', snapshot_change_count: popSt.change_count }))
        .rejects.toMatchObject({ code: 'NOT_FOUND' });
    } finally {
      try { if (client) await client.request('stop', {}, { requestTimeoutMs: 3000 }); } catch {}
      client?.close();
      try { await done; } catch {}
    }
  }, 20000);

  it('关闭 active popup → 回到存活 source，可继续操作', async () => {
    const srcCdp = new PageCdp('https://example.test/source', 100);
    const popCdp = new PageCdp('https://example.test/popup', 200);
    const owner = new FakeOwner();
    vi.spyOn(CdpSession, 'connect').mockImplementation(async (tabId: string) => (tabId === 'popup' ? popCdp : srcCdp) as unknown as CdpSession);
    const { openCdpSession } = await import('../browser/managed-browser.js');
    vi.mocked(openCdpSession).mockResolvedValue(owner as any);
    const id = 'multi-close';
    const socket = resolveSocketPath(id);
    const done = runDaemon(id, {
      env: 'pre', socketPath: socket, exitOnStop: false,
      browserBootstrap: async (): Promise<BootstrapResult> => ({ tabId: 'src', session: srcCdp as any, endpoint: 'http://127.0.0.1:0', browserSource: 'managed', owner: owner as any }),
    });
    let client: any = null;
    try {
      const dl = Date.now() + 8000;
      while (!(await DaemonClient.ping(socket, 100)) && Date.now() < dl) await new Promise((r) => setTimeout(r, 30));
      client = await DaemonClient.connect(socket);
      owner.emit('Target.attachedToTarget', { targetInfo: { targetId: 'popup', type: 'page', url: 'https://example.test/popup', openerId: 'src' }, sessionId: 'pop-child', waitingForDebugger: true });
      await new Promise((r) => setTimeout(r, 150));
      await client.request('page.switch-tab', { url_contains: '/popup', intent: '切到 popup' });
      // 关闭 popup（targetDestroyed + pageWs onClose）
      owner.emit('Target.targetDestroyed', { targetId: 'popup' });
      await new Promise((r) => setTimeout(r, 100));
      // active 回到 source，可继续 page.state
      const st = await client.request('page.state', {}) as any;
      expect(st.url).toContain('/source');
      // popup 不在 tabs
      expect(st.tabs.find((t: any) => t.target_id === 'popup')).toBeUndefined();
    } finally {
      try { if (client) await client.request('stop', {}, { requestTimeoutMs: 3000 }); } catch {}
      client?.close();
      try { await done; } catch {}
    }
  }, 20000);
});

describe('daemon 多 target assert/capture 跨页 ref + enable 失败', () => {
  let home: string;
  let prevHome: string | undefined;
  beforeEach(() => {
    prevHome = process.env.E2ET_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-mt-r1-'));
    process.env.E2ET_HOME = home;
    process.env.E2ET_IDLE_TIMEOUT_MS = '60000';
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.E2ET_HOME;
    else process.env.E2ET_HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('assert visible/absent + capture element 的 [N] 走 refMap：旧源 ref 在子页拒绝', async () => {
    const srcCdp = new PageCdp('https://example.test/source', 100);
    const popCdp = new PageCdp('https://example.test/popup', 200);
    const owner = new FakeOwner();
    vi.spyOn(CdpSession, 'connect').mockImplementation(async (tabId: string) => (tabId === 'popup' ? popCdp : srcCdp) as unknown as CdpSession);
    const { openCdpSession } = await import('../browser/managed-browser.js');
    vi.mocked(openCdpSession).mockResolvedValue(owner as any);
    const id = 'mt-r1-ref';
    const socket = resolveSocketPath(id);
    const done = runDaemon(id, { env: 'pre', socketPath: socket, exitOnStop: false, browserBootstrap: async (): Promise<BootstrapResult> => ({ tabId: 'src', session: srcCdp as any, endpoint: 'http://127.0.0.1:0', browserSource: 'managed', owner: owner as any }) });
    let client: any = null;
    try {
      const dl = Date.now() + 8000;
      while (!(await DaemonClient.ping(socket, 100)) && Date.now() < dl) await new Promise((r) => setTimeout(r, 30));
      client = await DaemonClient.connect(socket);
      const st = await client.request('page.state', {}) as any;
      const srcRef = st.elements[0].index;
      owner.emit('Target.attachedToTarget', { targetInfo: { targetId: 'popup', type: 'page', url: 'https://example.test/popup', openerId: 'src' }, sessionId: 'pop-c', waitingForDebugger: true });
      await new Promise((r) => setTimeout(r, 150));
      await client.request('page.switch-tab', { url_contains: '/popup', intent: '切 popup' });
      // 旧源 ref 在 popup：assert visible / absent / capture element 均拒绝（不走 AX 局部 index）
      await expect(client.request('assert.visible', { target: '[' + srcRef + ']', after: '0', expect: 'visible' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(client.request('capture.element', { target: '[' + srcRef + ']', as: 'v', after: '0' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    } finally {
      try { if (client) await client.request('stop', {}, { requestTimeoutMs: 3000 }); } catch {}
      client?.close();
      try { await done; } catch {}
    }
  }, 20000);

  it('popup Page.enable reject → fail-closed：不 ready、不进 tabs、waiting 被 resume', async () => {
    const srcCdp = new PageCdp('https://example.test/source', 100);
    // popup cdp：Page.enable 抛错
    const popCdp = new PageCdp('https://example.test/popup', 200);
    const origSend = popCdp.send.bind(popCdp);
    vi.spyOn(popCdp, 'send').mockImplementation(async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'Page.enable') throw new Error('Page.enable 拒绝');
      return origSend(method, params);
    });
    const owner = new FakeOwner();
    vi.spyOn(CdpSession, 'connect').mockImplementation(async (tabId: string) => (tabId === 'popup' ? popCdp : srcCdp) as unknown as CdpSession);
    const { openCdpSession } = await import('../browser/managed-browser.js');
    vi.mocked(openCdpSession).mockResolvedValue(owner as any);
    const id = 'mt-r1-enable';
    const socket = resolveSocketPath(id);
    const done = runDaemon(id, { env: 'pre', socketPath: socket, exitOnStop: false, browserBootstrap: async (): Promise<BootstrapResult> => ({ tabId: 'src', session: srcCdp as any, endpoint: 'http://127.0.0.1:0', browserSource: 'managed', owner: owner as any }) });
    let client: any = null;
    try {
      const dl = Date.now() + 8000;
      while (!(await DaemonClient.ping(socket, 100)) && Date.now() < dl) await new Promise((r) => setTimeout(r, 30));
      client = await DaemonClient.connect(socket);
      owner.emit('Target.attachedToTarget', { targetInfo: { targetId: 'popup', type: 'page', url: 'https://example.test/popup', openerId: 'src' }, sessionId: 'pop-c', waitingForDebugger: true });
      await new Promise((r) => setTimeout(r, 200));
      // popup enable 失败 → fail-closed：不进 tabs，只有 source
      const st = await client.request('page.state', {}) as any;
      expect(st.tabs.find((t: any) => t.target_id === 'popup')).toBeUndefined();
      expect(st.tabs).toHaveLength(1);
      // waiting popup 被 resume（runIfWaitingForDebugger 兜底），且只一次（owner takeoverPopup catch 单路径，onAttached 外层 catch 不重复）
      const traceDirPath = traceDir(id);
      const trace = fs.readFileSync(path.join(traceDirPath, 'trace.jsonl'), 'utf8');
      expect(trace).toContain('popup_init_error');
      const resumeCalls = owner.calls.filter((c: any) => c.method === 'Runtime.runIfWaitingForDebugger' && c.sessionId === 'pop-c');
      expect(resumeCalls).toHaveLength(1);
    } finally {
      try { if (client) await client.request('stop', {}, { requestTimeoutMs: 3000 }); } catch {}
      client?.close();
      try { await done; } catch {}
    }
  }, 20000);

  it('popup pageWS connect 失败：waiting 被 resume 一次（owner connect catch 单路径，外层不重复），不进 tabs', async () => {
    const srcCdp = new PageCdp('https://example.test/source', 100);
    const owner = new FakeOwner();
    // connect 对 popup 抛错 → takeoverPopup connect catch 负责 release + resumeChild + throw
    vi.spyOn(CdpSession, 'connect').mockImplementation(async (tabId: string) => {
      if (tabId === 'popup') throw new Error('CDP 连接失败');
      return srcCdp as unknown as CdpSession;
    });
    const { openCdpSession } = await import('../browser/managed-browser.js');
    vi.mocked(openCdpSession).mockResolvedValue(owner as any);
    const id = 'mt-r1-connect';
    const socket = resolveSocketPath(id);
    const done = runDaemon(id, { env: 'pre', socketPath: socket, exitOnStop: false, browserBootstrap: async (): Promise<BootstrapResult> => ({ tabId: 'src', session: srcCdp as any, endpoint: 'http://127.0.0.1:0', browserSource: 'managed', owner: owner as any }) });
    let client: any = null;
    try {
      const dl = Date.now() + 8000;
      while (!(await DaemonClient.ping(socket, 100)) && Date.now() < dl) await new Promise((r) => setTimeout(r, 30));
      client = await DaemonClient.connect(socket);
      owner.emit('Target.attachedToTarget', { targetInfo: { targetId: 'popup', type: 'page', url: 'https://example.test/popup', openerId: 'src' }, sessionId: 'pop-c', waitingForDebugger: true });
      await new Promise((r) => setTimeout(r, 200));
      const st = await client.request('page.state', {}) as any;
      expect(st.tabs.find((t: any) => t.target_id === 'popup')).toBeUndefined();
      expect(st.tabs).toHaveLength(1);
      // waiting popup 被 resume 一次（connect catch 单路径），外层 catch 不重复
      const resumeCalls = owner.calls.filter((c: any) => c.method === 'Runtime.runIfWaitingForDebugger' && c.sessionId === 'pop-c');
      expect(resumeCalls).toHaveLength(1);
      const trace = fs.readFileSync(path.join(traceDir(id), 'trace.jsonl'), 'utf8');
      expect(trace).not.toContain('popup_attached');
    } finally {
      try { if (client) await client.request('stop', {}, { requestTimeoutMs: 3000 }); } catch {}
      client?.close();
      try { await done; } catch {}
    }
  }, 20000);
});

describe('daemon onPopup 取消静默回收（R2）', () => {
  let home: string;
  let prevHome: string | undefined;
  beforeEach(() => {
    prevHome = process.env.E2ET_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-r2-'));
    process.env.E2ET_HOME = home;
    process.env.E2ET_IDLE_TIMEOUT_MS = '60000';
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.E2ET_HOME;
    else process.env.E2ET_HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  // Page/Network enable 各覆盖 resolve/reject
  const enableMethods = ['Page.enable', 'Network.enable'] as const;
  const settleTypes = ['resolve', 'reject'] as const;

  it.each(enableMethods.flatMap((m) => settleTypes.map((s) => ({ method: m, settle: s }))))(
    'stop 在 $method await 期间，$settle 后：晚续体静默回收，无 popup_attached/popup_init_error',
    async ({ method, settle }: { method: 'Page.enable' | 'Network.enable'; settle: 'resolve' | 'reject' }) => {
    const srcCdp = new PageCdp('https://example.test/source', 100);
    const popCdp = new PageCdp('https://example.test/popup', 200);
    let ctrl = { resolve: (_v: any) => {}, reject: (_e: any) => {} };
    let resolveEntered: () => void = () => {};
    const entered = new Promise<void>((res) => { resolveEntered = res; });
    const pending = new Promise<any>((res, rej) => { ctrl = { resolve: res, reject: rej }; });
    const origSend = popCdp.send.bind(popCdp);
    vi.spyOn(popCdp, 'send').mockImplementation(async (m: string, p: Record<string, unknown> = {}) => {
      if (m === method) { resolveEntered(); return pending as any; }
      return origSend(m, p);
    });
    const owner = new FakeOwner();
    vi.spyOn(CdpSession, 'connect').mockImplementation(async (tabId: string) => (tabId === 'popup' ? popCdp : srcCdp) as unknown as CdpSession);
    const { openCdpSession } = await import('../browser/managed-browser.js');
    vi.mocked(openCdpSession).mockResolvedValue(owner as any);
    const id = `r2-${method === 'Page.enable' ? 'page' : 'net'}-${settle}`;
    const socket = resolveSocketPath(id);
    const done = runDaemon(id, { env: 'pre', socketPath: socket, exitOnStop: false, browserBootstrap: async (): Promise<BootstrapResult> => ({ tabId: 'src', session: srcCdp as any, endpoint: 'http://127.0.0.1:0', browserSource: 'managed', owner: owner as any }) });
    let client: any = null;
    try {
      const dl = Date.now() + 8000;
      while (!(await DaemonClient.ping(socket, 100)) && Date.now() < dl) await new Promise((r) => setTimeout(r, 30));
      client = await DaemonClient.connect(socket);
      owner.emit('Target.attachedToTarget', { targetInfo: { targetId: 'popup', type: 'page', url: 'https://example.test/popup', openerId: 'src' }, sessionId: 'pop-c', waitingForDebugger: true });
      await entered; // 确认 onPopup 已进入指定 method 的 await
      await client.request('stop', {}, { requestTimeoutMs: 5000 });
      client.close();
      await done;
      // stop+done 后读基线（已含 session_end）；记录 close 基数
      const traceBefore = fs.readFileSync(path.join(traceDir(id), 'trace.jsonl'), 'utf8');
      expect(traceBefore).toContain('session_end');
      const closeBefore = popCdp.closeCalls;
      // 晚续体：resolve 或 reject 都走 cancelled() → silentRecycle
      if (settle === 'resolve') ctrl.resolve({});
      else ctrl.reject(new Error('CDP 会话已关闭'));
      // 等晚续体 close 调用（silentRecycle 关 pageWs）
      await vi.waitFor(() => expect(popCdp.closeCalls).toBeGreaterThan(closeBefore), { timeout: 5000, interval: 20 });
      const traceAfter = fs.readFileSync(path.join(traceDir(id), 'trace.jsonl'), 'utf8');
      expect(traceAfter).toBe(traceBefore);
      expect(traceAfter).not.toContain('popup_attached');
      expect(traceAfter).not.toContain('popup_init_error');
    } finally {
      try { if (client) { await client.request('stop', {}, { requestTimeoutMs: 3000 }); } } catch {}
      client?.close();
      try { await done; } catch {}
    }
  }, 20000);
});

describe('daemon onPopup 取消续体覆盖 reject + resume + targetDestroyed（R3）', () => {
  let home: string;
  let prevHome: string | undefined;
  beforeEach(() => {
    prevHome = process.env.E2ET_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-r3-'));
    process.env.E2ET_HOME = home;
    process.env.E2ET_IDLE_TIMEOUT_MS = '60000';
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.E2ET_HOME;
    else process.env.E2ET_HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  async function boot(clientId: string, popCdp: PageCdp) {
    const srcCdp = new PageCdp('https://example.test/source', 100);
    const owner = new FakeOwner();
    vi.spyOn(CdpSession, 'connect').mockImplementation(async (tabId: string) => (tabId === 'popup' ? popCdp : srcCdp) as unknown as CdpSession);
    const { openCdpSession } = await import('../browser/managed-browser.js');
    vi.mocked(openCdpSession).mockResolvedValue(owner as any);
    const socket = resolveSocketPath(clientId);
    const done = runDaemon(clientId, { env: 'pre', socketPath: socket, exitOnStop: false, browserBootstrap: async (): Promise<BootstrapResult> => ({ tabId: 'src', session: srcCdp as any, endpoint: 'http://127.0.0.1:0', browserSource: 'managed', owner: owner as any }) });
    const dl = Date.now() + 8000;
    while (!(await DaemonClient.ping(socket, 100)) && Date.now() < dl) await new Promise((r) => setTimeout(r, 30));
    const client = await DaemonClient.connect(socket);
    return { srcCdp, owner, socket, done, client };
  }

  it('stop 在 resume await 期间：晚续体静默回收，无 popup_attached', async () => {
    const popCdp = new PageCdp('https://example.test/popup', 200);
    const { owner, done, client } = await boot('r3-resume-stop', popCdp);
    let resumeCallCount = 0;
    let rejectResume: (e: any) => void = () => {};
    const resumePending = new Promise<any>((_res, rej) => { rejectResume = rej; });
    const origOwnerSend = owner.send.bind(owner);
    vi.spyOn(owner, 'send').mockImplementation(async (method: string, params: Record<string, unknown> = {}, sessionId?: string) => {
      if (method === 'Runtime.runIfWaitingForDebugger') { resumeCallCount++; return resumePending; }
      return origOwnerSend(method, params, sessionId);
    });
    try {
      owner.emit('Target.attachedToTarget', { targetInfo: { targetId: 'popup', type: 'page', url: 'https://example.test/popup', openerId: 'src' }, sessionId: 'pop-child', waitingForDebugger: true });
      // 等第1次 resume 被调用（onPopup 里 resumePopup）
      await vi.waitFor(() => expect(resumeCallCount).toBeGreaterThanOrEqual(1), { timeout: 5000, interval: 20 });
      // stop：doCleanup 同步设 stopped=true
      const stopP = client.request('stop', {}, { requestTimeoutMs: 5000 }).catch(() => {});
      // 等第2次 resume 被调用（stop 里 resumeChild），两次共享同一 pending
      await vi.waitFor(() => expect(resumeCallCount).toBeGreaterThanOrEqual(2), { timeout: 5000, interval: 20 });
      // 一次 reject 解开两个 await（onPopup + stop）
      rejectResume(new Error('CDP 会话已关闭'));
      await Promise.all([stopP, done]);
      client.close();
      const traceBefore = fs.readFileSync(path.join(traceDir('r3-resume-stop'), 'trace.jsonl'), 'utf8');
      expect(traceBefore).toContain('session_end');
      await new Promise((r) => setTimeout(r, 50));
      const traceAfter = fs.readFileSync(path.join(traceDir('r3-resume-stop'), 'trace.jsonl'), 'utf8');
      expect(traceAfter).toBe(traceBefore);
      expect(traceAfter).not.toContain('popup_attached');
      expect(traceAfter).not.toContain('popup_init_error');
    } finally {
      try { await client.request('stop', {}, { requestTimeoutMs: 3000 }); } catch {}
      client?.close();
      try { await done; } catch {}
    }
  }, 20000);

  it('targetDestroyed 在 resume await 期间：晚续体静默回收，无 popup_attached', async () => {
    const popCdp = new PageCdp('https://example.test/popup', 200);
    const { owner, done, client } = await boot('r3-resume-destroyed', popCdp);
    let resumeCallCount = 0;
    let resumeResolve: (v: any) => void = () => {};
    const resumePending = new Promise((res) => { resumeResolve = res; });
    const origOwnerSend = owner.send.bind(owner);
    vi.spyOn(owner, 'send').mockImplementation(async (method: string, params: Record<string, unknown> = {}, sessionId?: string) => {
      if (method === 'Runtime.runIfWaitingForDebugger') { resumeCallCount++; return resumePending as any; }
      return origOwnerSend(method, params, sessionId);
    });
    try {
      owner.emit('Target.attachedToTarget', { targetInfo: { targetId: 'popup', type: 'page', url: 'https://example.test/popup', openerId: 'src' }, sessionId: 'pop-child', waitingForDebugger: true });
      await vi.waitFor(() => expect(resumeCallCount).toBeGreaterThanOrEqual(1), { timeout: 5000, interval: 20 });
      const closeBefore = popCdp.closeCalls;
      // target 销毁 → handleTargetClosed 标 entry.closed → cancelled()
      owner.emit('Target.targetDestroyed', { targetId: 'popup' });
      // resolve resume → onPopup 继续 → cancelled() → silentRecycle
      resumeResolve({});
      // 等实际 close 调用
      await vi.waitFor(() => expect(popCdp.closeCalls).toBeGreaterThan(closeBefore), { timeout: 5000, interval: 20 });
      const trace = fs.readFileSync(path.join(traceDir('r3-resume-destroyed'), 'trace.jsonl'), 'utf8');
      expect(trace).not.toContain('popup_attached');
      expect(trace).not.toContain('popup_init_error');
      expect(trace).toContain('target_closed');
    } finally {
      try { await client.request('stop', {}, { requestTimeoutMs: 3000 }); } catch {}
      client?.close();
      try { await done; } catch {}
    }
  }, 20000);

  it('DOMContent evaluate 卡住后 stop：reject 不写 dom_observer_rebind_error，close 退订', async () => {
    const popCdp = new PageCdp('https://example.test/popup', 200);
    const { owner, done, client } = await boot('r3-domc-eval-stop', popCdp);
    // 正常初始化 popup（evaluate 不拦启动时 OBSERVER_SCRIPT，只拦 domContent 回调的 evaluate）
    const origEval = popCdp.evaluate.bind(popCdp);
    let evalCount = 0;
    let domContentEvalEntered = false;
    let rejectDomEval: (e: any) => void = () => {};
    const domEvalPending = new Promise<any>((_res, rej) => { rejectDomEval = rej; });
    let unsubCallCount = 0;
    const origOn = popCdp.on.bind(popCdp);
    vi.spyOn(popCdp, 'on').mockImplementation((method: string, handler: (p: any) => void) => {
      const off = origOn(method, handler);
      if (method === 'Page.domContentEventFired') {
        return () => { unsubCallCount++; off(); };
      }
      return off;
    });
    vi.spyOn(popCdp, 'evaluate').mockImplementation(async (expr: string) => {
      evalCount++;
      // 首次 evaluate（onPopup 正常流程）正常通过
      if (evalCount === 1) return origEval(expr);
      // 后续 evaluate（来自 domContent 回调）挂起
      if (expr.includes('__e2et') || expr.includes('MutationObserver')) { domContentEvalEntered = true; return domEvalPending as any; }
      return origEval(expr);
    });
    try {
      owner.emit('Target.attachedToTarget', { targetInfo: { targetId: 'popup', type: 'page', url: 'https://example.test/popup', openerId: 'src' }, sessionId: 'pop-c', waitingForDebugger: true });
      // 等 popup 正常初始化完成（首次 evaluate 已通过）
      await vi.waitFor(() => expect(evalCount).toBeGreaterThanOrEqual(1), { timeout: 5000, interval: 20 });
      // 触发 domContent 事件 → evaluate pend（非首次，走挂起路径）
      popCdp.emit('Page.domContentEventFired', {});
      await vi.waitFor(() => expect(domContentEvalEntered).toBe(true), { timeout: 5000, interval: 20 });
      // stop → cancelled=true
      await client.request('stop', {}, { requestTimeoutMs: 5000 });
      // 断言 domContent 监听器已被 close 回调退订：按方法名看 listeners
      const domContentListeners = (popCdp as any).listeners?.get('Page.domContentEventFired')?.length ?? 0;
      expect(domContentListeners).toBe(0);
      client.close();
      await done;
      // stop+done 后读基线；记录 unsub 调用基数
      const traceBefore = fs.readFileSync(path.join(traceDir('r3-domc-eval-stop'), 'trace.jsonl'), 'utf8');
      expect(traceBefore).toContain('session_end');
      const unsubBefore = unsubCallCount;
      // reject evaluate（stop 后 → cancelled → catch 不写 trace，finally 触发再次退订）
      rejectDomEval(new Error('evaluate 失败'));
      // 等 finally 退订调用
      await vi.waitFor(() => expect(unsubCallCount).toBeGreaterThan(unsubBefore), { timeout: 5000, interval: 20 });
      const traceAfter = fs.readFileSync(path.join(traceDir('r3-domc-eval-stop'), 'trace.jsonl'), 'utf8');
      expect(traceAfter).toBe(traceBefore);
    } finally {
      try { await client.request('stop', {}, { requestTimeoutMs: 3000 }); } catch {}
      client?.close();
      try { await done; } catch {}
    }
  }, 20000);

  it('旧 pageWs close 延迟到新 entry ready 后不关闭新 entry', async () => {
    const srcCdp = new PageCdp('https://example.test/source', 100);
    const popCdpOld = new PageCdp('https://example.test/popup', 200);
    const popCdpNew = new PageCdp('https://example.test/popup', 300);
    // 旧 cdp：Page.enable 挂起为可控 promise；entered 在 send 里触发
    let resolveOldEnable: (v: any) => void = () => {};
    let oldEnableEntered = false;
    const oldEnablePending = new Promise<any>((res) => { resolveOldEnable = res; });
    const origOldSend = popCdpOld.send.bind(popCdpOld);
    vi.spyOn(popCdpOld, 'send').mockImplementation(async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'Page.enable') { oldEnableEntered = true; return oldEnablePending as any; }
      return origOldSend(method, params);
    });
    // 旧 cdp close 只记录不发 close 事件（模拟延迟 WS close 到达）
    popCdpOld.close = () => { popCdpOld.closeCalls++; /* 不触发 closeCbs */ };
    const owner = new FakeOwner();
    let connectIdx = 0;
    let resumeChildCalled = false;
    vi.spyOn(CdpSession, 'connect').mockImplementation(async (tabId: string) => {
      if (tabId !== 'popup') return srcCdp as unknown as CdpSession;
      connectIdx++;
      return (connectIdx === 1 ? popCdpOld : popCdpNew) as unknown as CdpSession;
    });
    const origOwnerSend = owner.send.bind(owner);
    vi.spyOn(owner, 'send').mockImplementation(async (method: string, params: Record<string, unknown> = {}, sessionId?: string) => {
      if (method === 'Runtime.runIfWaitingForDebugger' && sessionId === 'pop-c1') { resumeChildCalled = true; }
      return origOwnerSend(method, params, sessionId);
    });
    const { openCdpSession } = await import('../browser/managed-browser.js');
    vi.mocked(openCdpSession).mockResolvedValue(owner as any);
    const id = 'r3-old-ws-close';
    const socket = resolveSocketPath(id);
    const done = runDaemon(id, { env: 'pre', socketPath: socket, exitOnStop: false, browserBootstrap: async (): Promise<BootstrapResult> => ({ tabId: 'src', session: srcCdp as any, endpoint: 'http://127.0.0.1:0', browserSource: 'managed', owner: owner as any }) });
    let client: any = null;
    try {
      const dl = Date.now() + 8000;
      while (!(await DaemonClient.ping(socket, 100)) && Date.now() < dl) await new Promise((r) => setTimeout(r, 30));
      client = await DaemonClient.connect(socket);
      // 旧 onPopup：enable 挂起
      owner.emit('Target.attachedToTarget', { targetInfo: { targetId: 'popup', type: 'page', url: 'https://example.test/popup', openerId: 'src' }, sessionId: 'pop-c1', waitingForDebugger: true });
      await vi.waitFor(() => expect(oldEnableEntered).toBe(true), { timeout: 5000, interval: 20 });
      // reject 旧 Page.enable → takeoverPopup catch → release + resumeChild + throw → 旧 entry 被移除
      resolveOldEnable(Promise.reject(new Error('Page.enable 失败')));
      await vi.waitFor(() => expect(resumeChildCalled).toBe(true), { timeout: 5000, interval: 20 });
      // 旧 entry 已释放 → 新 attachedToTarget 可 reserve
      owner.emit('Target.attachedToTarget', { targetInfo: { targetId: 'popup', type: 'page', url: 'https://example.test/popup', openerId: 'src' }, sessionId: 'pop-c2', waitingForDebugger: true });
      await vi.waitFor(() => expect(connectIdx).toBe(2), { timeout: 5000, interval: 20 });
      // 新 onPopup 完成初始化 → page.state 确认 popup ready
      await vi.waitFor(async () => {
        const st = await client.request('page.state', {}) as any;
        return st.tabs.find((t: any) => t.target_id === 'popup');
      }, { timeout: 5000, interval: 50 });
      // 切到新 popup
      await client.request('page.switch-tab', { url_contains: '/popup', intent: '切新 popup' });
      // 读 switch 前 trace 基线
      const traceBefore = fs.readFileSync(path.join(traceDir(id), 'trace.jsonl'), 'utf8');
      // 旧 cdp WS close 延迟到达：onClose 检查 targetRegistry.get(id) === 旧 entry → 已换新 entry → 不调 handleTargetClosed
      popCdpOld.fireClose();
      // 等微任务传播
      await new Promise((r) => setTimeout(r, 20));
      // 新 entry 不被关闭：popup 仍在 tabs 且仍是 active
      const st2 = await client.request('page.state', {}) as any;
      const popupTab2 = st2.tabs.find((t: any) => t.target_id === 'popup');
      expect(popupTab2).toBeDefined();
      const traceAfter = fs.readFileSync(path.join(traceDir(id), 'trace.jsonl'), 'utf8');
      // fireClose 后 trace 不变（旧 WS close 不触发 handleTargetClosed）
      expect(traceAfter).toBe(traceBefore);
    } finally {
      try { await client.request('stop', {}, { requestTimeoutMs: 3000 }); } catch {}
      client?.close();
      try { await done; } catch {}
    }
  }, 20000);
});

describe('daemon popup 状态隔离（R3：observer 安装 + 切页 epoch + hover 关闭回退）', () => {
  let home: string;
  let prevHome: string | undefined;
  beforeEach(() => {
    prevHome = process.env.E2ET_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-r3-iso-'));
    process.env.E2ET_HOME = home;
    process.env.E2ET_IDLE_TIMEOUT_MS = '60000';
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.E2ET_HOME;
    else process.env.E2ET_HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('popup 接管装 DOM observer（addScript + evaluate）；切 popup 后 page_changed epoch 推进', async () => {
    const srcCdp = new PageCdp('https://example.test/source', 100);
    const popCdp = new PageCdp('https://example.test/popup', 200);
    // popup 的 __e2etChangeCount=5（>source 的 0），验证切页后 epoch 推进、不拿 source 旧计数压住
    const origPopEval = popCdp.evaluate.bind(popCdp);
    vi.spyOn(popCdp, 'evaluate').mockImplementation(async (expr: string) => {
      if (expr.includes('__e2etChangeCount')) return 5 as any;
      return origPopEval(expr);
    });
    const owner = new FakeOwner();
    vi.spyOn(CdpSession, 'connect').mockImplementation(async (tabId: string) => (tabId === 'popup' ? popCdp : srcCdp) as unknown as CdpSession);
    const { openCdpSession } = await import('../browser/managed-browser.js');
    vi.mocked(openCdpSession).mockResolvedValue(owner as any);
    const id = 'r3-iso-observer';
    const socket = resolveSocketPath(id);
    const done = runDaemon(id, { env: 'pre', socketPath: socket, exitOnStop: false, browserBootstrap: async (): Promise<BootstrapResult> => ({ tabId: 'src', session: srcCdp as any, endpoint: 'http://127.0.0.1:0', browserSource: 'managed', owner: owner as any }) });
    let client: any = null;
    try {
      const dl = Date.now() + 8000;
      while (!(await DaemonClient.ping(socket, 100)) && Date.now() < dl) await new Promise((r) => setTimeout(r, 30));
      client = await DaemonClient.connect(socket);
      owner.emit('Target.attachedToTarget', { targetInfo: { targetId: 'popup', type: 'page', url: 'https://example.test/popup', openerId: 'src' }, sessionId: 'pop-c', waitingForDebugger: true });
      await new Promise((r) => setTimeout(r, 150));
      // popup 接管装了 DOM observer：未来文档（addScript）+ 当前文档（evaluate）
      expect(popCdp.calls.some((c: string) => c === 'Page.addScriptToEvaluateOnNewDocument')).toBe(true);
      // source page.state change_count 基线
      const srcSt = await client.request('page.state', {}) as any;
      const srcCC = srcSt.change_count;
      // 切 popup
      await client.request('page.switch-tab', { url_contains: '/popup', intent: '切 popup' });
      const popSt = await client.request('page.state', {}) as any;
      // 切页推进 epoch：popup change_count > source（不拿 source 旧计数压住 popup 新计数）
      expect(popSt.change_count).toBeGreaterThan(srcCC);
    } finally {
      try { if (client) await client.request('stop', {}, { requestTimeoutMs: 3000 }); } catch {}
      client?.close();
      try { await done; } catch {}
    }
  }, 20000);

  it('hover 后关闭 active popup → 回退 source：丢弃死页 hover 引用，后续动作不崩', async () => {
    const srcCdp = new PageCdp('https://example.test/source', 100);
    const popCdp = new PageCdp('https://example.test/popup', 200);
    // 让 hoverNode 成功：DOM.resolveNode 返 objectId，Runtime.callFunctionOn 无 exceptionDetails
    const origPopSend = popCdp.send.bind(popCdp);
    vi.spyOn(popCdp, 'send').mockImplementation(async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'DOM.scrollIntoViewIfNeeded') return {} as any;
      return origPopSend(method, params);
    });
    const owner = new FakeOwner();
    vi.spyOn(CdpSession, 'connect').mockImplementation(async (tabId: string) => (tabId === 'popup' ? popCdp : srcCdp) as unknown as CdpSession);
    const { openCdpSession } = await import('../browser/managed-browser.js');
    vi.mocked(openCdpSession).mockResolvedValue(owner as any);
    const id = 'r3-iso-hover-close';
    const socket = resolveSocketPath(id);
    const done = runDaemon(id, { env: 'pre', socketPath: socket, exitOnStop: false, browserBootstrap: async (): Promise<BootstrapResult> => ({ tabId: 'src', session: srcCdp as any, endpoint: 'http://127.0.0.1:0', browserSource: 'managed', owner: owner as any }) });
    let client: any = null;
    try {
      const dl = Date.now() + 8000;
      while (!(await DaemonClient.ping(socket, 100)) && Date.now() < dl) await new Promise((r) => setTimeout(r, 30));
      client = await DaemonClient.connect(socket);
      owner.emit('Target.attachedToTarget', { targetInfo: { targetId: 'popup', type: 'page', url: 'https://example.test/popup', openerId: 'src' }, sessionId: 'pop-c', waitingForDebugger: true });
      await new Promise((r) => setTimeout(r, 150));
      // 切 popup，hover 一个元素（设置 currentHoverCleanup 指向 popup WS）
      await client.request('page.switch-tab', { url_contains: '/popup', intent: '切 popup' });
      const popSt = await client.request('page.state', {}) as any;
      const popRef = popSt.elements[0].index;
      const hoverRes = await client.request('page.hover', { target: '[' + popRef + ']', intent: 'hover 子页按钮' });
      expect(hoverRes).toBeTruthy();
      // 关闭 active popup（targetDestroyed）→ handleTargetClosed wasActive → 丢弃 hover 引用 → 回退 source
      owner.emit('Target.targetDestroyed', { targetId: 'popup' });
      await new Promise((r) => setTimeout(r, 120));
      // 回退 source 后 page.state 正常（不崩，不对死 WS 清 hover）
      const st = await client.request('page.state', {}) as any;
      expect(st.url).toContain('/source');
      expect(st.tabs.find((t: any) => t.target_id === 'popup')).toBeUndefined();
      // 后续动作正常（clearHover 不对死 popup WS 调，currentHoverCleanup 已丢弃）
      const st2 = await client.request('page.state', {}) as any;
      expect(st2.url).toContain('/source');
    } finally {
      try { if (client) await client.request('stop', {}, { requestTimeoutMs: 3000 }); } catch {}
      client?.close();
      try { await done; } catch {}
    }
  }, 20000);
});
