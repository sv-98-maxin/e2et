/**
 * C42304-P3 定向测试：target-aware initialize + popup Page.getFrameTree 读取 + 取消路径
 *
 * 验证项：
 * 1. late-attach（waiting=false, existing_late, 无 frameNavigated）→ Page.getFrameTree 读真 URL →
 *    tabs/url_contains 匹配真 popup URL，source URL/mainFrame/current nav 不被覆盖
 * 2. popup_attached URL 用 targetUrl() 事实，不用旧 info.url
 * 3. Page.getFrameTree 读 about:blank → 保持 about:blank，不 crash
 * 4. getFrameTree await 期间 stop → silentRecycle；stop 后 resolve/reject 不写新 trace（字节级比基线）
 * 5. getFrameTree await 期间 targetDestroyed → silentRecycle
 * 6. getFrameTree 真实 reject（非取消）→ popup_init_error + 不 ready + owner 单一清理
 * 7. NetworkTrace.initialize 指定 target 不污染 source
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CdpSession } from '../browser/daemon-client.js';
import { runDaemon } from '../daemon/daemon.js';
import type { BootstrapResult } from '../daemon/bootstrap.js';
import { DaemonClient } from '../daemon/client.js';
import { resolveSocketPath, traceDir } from '../daemon/session-meta.js';
import { NetworkTrace } from '../daemon/network-trace.js';

vi.mock('../browser/managed-browser.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../browser/managed-browser.js')>();
  return { ...actual, openCdpSession: vi.fn(), resolveChromiumExecutable: vi.fn(() => '/fake/chromium'), launchChromium: vi.fn() };
});

// ── shared helpers ──

class PageCdp {
  calls: string[] = [];
  closeCalls = 0;
  private listeners = new Map<string, Array<(p: any) => void>>();
  private closeCbs: Array<() => void> = [];
  private url: string;
  private axNodeId: number;
  urlFragment?: string;
  constructor(url: string, axNodeId: number) { this.url = url; this.axNodeId = axNodeId; }
  on(method: string, h: (p: any) => void) { const l = this.listeners.get(method) ?? []; l.push(h); this.listeners.set(method, l); return () => { this.listeners.set(method, l.filter((x) => x !== h)); }; }
  onClose(cb: () => void) { this.closeCbs.push(cb); }
  close() { this.closeCalls++; for (const cb of this.closeCbs) cb(); }
  fireClose() { for (const cb of this.closeCbs) cb(); }
  async send<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push(method);
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main', loaderId: '', url: this.url, securityOrigin: '', ...(this.urlFragment ? { urlFragment: this.urlFragment } : {}) } } } as T;
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
    if (expr === '({ url: location.href, title: document.title })') return { url: this.url + (this.urlFragment ?? ''), title: 't' } as T;
    if (expr.includes('location.href')) return this.url + (this.urlFragment ?? '') as T;
    return '' as T;
  }
  emit(m: string, p: any) {
    if (m === 'Page.frameNavigated' && p?.frame?.parentId === undefined && p?.frame?.url) this.url = String(p.frame.url);
    if (m === 'Page.navigatedWithinDocument' && p?.url) this.url = String(p.url);
    for (const h of this.listeners.get(m) ?? []) h(p); }
}

class FakeOwner {
  calls: Array<{ method: string; params: Record<string, unknown>; sessionId?: string }> = [];
  private listeners = new Map<string, Array<(p: any) => void>>();
  onClose() {}
  close() {}
  addEventListener(m: string, h: (p: any) => void) { const l = this.listeners.get(m) ?? []; l.push(h); this.listeners.set(m, l); return () => { this.listeners.set(m, l.filter((x) => x !== h)); }; }
  async send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    this.calls.push({ method, params, sessionId });
    if (method === 'Target.getTargets') return { targetInfos: [{ targetId: 'src', type: 'page' }] } as T;
    // 无 sessionId 的 Runtime.runIfWaitingForDebugger（stop 里 resumeChild）走共享 resolver
    if (method === 'Runtime.runIfWaitingForDebugger' && !sessionId) return {} as T;
    return {} as T;
  }
  emit(m: string, p: any) { for (const h of this.listeners.get(m) ?? []) h(p); }
}

/** 建起 daemon + 等 ready + 连 client。owned 模式给 owner，shared 不给。 */
async function bootDaemon(id: string, srcCdp: PageCdp, popCdp: PageCdp, owner: FakeOwner, isOwned = true) {
  vi.spyOn(CdpSession, 'connect').mockImplementation(async (tabId: string) =>
    (tabId === 'popup' ? popCdp : srcCdp) as unknown as CdpSession,
  );
  const { openCdpSession } = await import('../browser/managed-browser.js');
  vi.mocked(openCdpSession).mockResolvedValue(owner as any);
  const socket = resolveSocketPath(id);
  const done = runDaemon(id, {
    env: 'pre', socketPath: socket, exitOnStop: false,
    browserBootstrap: async (): Promise<BootstrapResult> => ({
      tabId: 'src', session: srcCdp as any, endpoint: 'http://127.0.0.1:0',
      browserSource: isOwned ? 'managed' : 'existing',
      ...(isOwned ? { owner: owner as any } : {}),
    }),
  });
  const dl = Date.now() + 8000;
  while (!(await DaemonClient.ping(socket, 100)) && Date.now() < dl) await new Promise((r) => setTimeout(r, 30));
  const client = await DaemonClient.connect(socket);
  return { socket, done, client };
}

/** 发 attachedToTarget 事件。waiting=false → existing_late 模式（不卡在 runIfWaitingForDebugger）。 */
function emitPopupAttach(owner: FakeOwner, targetId: string, url: string, openerId = 'src') {
  owner.emit('Target.attachedToTarget', {
    targetInfo: { targetId, type: 'page', url, openerId },
    sessionId: targetId + '-child',
    waitingForDebugger: false,
  });
}

/** 等 popup 实际 ready：page.state tabs 里找到 targetId。 */
async function waitForPopupReady(client: any, targetId: string, timeoutMs = 5000) {
  const dl = Date.now() + timeoutMs;
  while (Date.now() < dl) {
    const st = await client.request('page.state', {}) as any;
    if (st.tabs.find((t: any) => t.target_id === targetId)) return st;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`popup ${targetId} 未在 ${timeoutMs}ms 内 ready`);
}

/** 读 trace jsonl 解析为对象数组 */
function readTrace(id: string) {
  return fs.readFileSync(path.join(traceDir(id), 'trace.jsonl'), 'utf8')
    .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

let home: string;
let prevHome: string | undefined;

beforeEach(() => {
  prevHome = process.env.E2ET_HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ti-'));
  process.env.E2ET_HOME = home;
  process.env.E2ET_IDLE_TIMEOUT_MS = '60000';
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.E2ET_HOME;
  else process.env.E2ET_HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
});

// ── 1. NetworkTrace.initialize target-aware（纯逻辑） ──

describe('NetworkTrace.initialize target-aware', () => {
  it('initialize 指定 target 不改 source', async () => {
    const trace = new NetworkTrace('ut', new PageCdp('https://s.test', 1) as any, 'src');
    trace.install();
    await trace.initialize('src');
    trace.addTarget('pop', new PageCdp('https://p.test', 2) as any);
    expect(trace.getTargetUrl('pop')).toBe('about:blank');
    await trace.initialize('pop');
    expect(trace.getTargetUrl('pop')).toBe('https://p.test');
    expect(trace.getTargetUrl('src')).toBe('https://s.test');
    expect((trace as any).targets.get('src').mainFrameId).toBe('main');
    expect((trace as any).targets.get('pop').mainFrameId).toBe('main');
  });

  it('initialize 未知 targetId 静默无操作', async () => {
    const trace = new NetworkTrace('ut2', new PageCdp('https://s.test', 1) as any, 'src');
    trace.install();
    await trace.initialize('src');
    await trace.initialize('ghost');
    expect(trace.getTargetUrl('ghost')).toBeUndefined();
  });
});

// ── 2. daemon late-attach：Page.getFrameTree 读真 URL ──

describe('daemon popup late-attach', () => {
  it('waiting=false, 无 frameNavigated → Page.getFrameTree 读真 URL → switch url_contains 匹配', async () => {
    const srcCdp = new PageCdp('https://example.test/source', 100);
    const popCdp = new PageCdp('https://example.test/license/edit', 200);
    const owner = new FakeOwner();
    const { done, client } = await bootDaemon('late-url', srcCdp, popCdp, owner, true);
    try {
      // attachedToTarget URL=about:blank 但 popup 已导航（late-attach 典型场景：waiting=false → existing_late）
      emitPopupAttach(owner, 'popup', 'about:blank');
      // 等 popup 实际 ready，不靠 sleep 猜
      const st1 = await waitForPopupReady(client, 'popup');
      const popupTab = st1.tabs.find((t: any) => t.target_id === 'popup');
      expect(popupTab).toBeDefined();
      // 核心：popup URL 是 Page.getFrameTree 读到的真 URL，不是 about:blank
      expect(popupTab.url).toContain('/license/edit');

      // switch-tab 用 url_contains 匹配真实 URL
      const sw = await client.request('page.switch-tab', { url_contains: '/license/edit', intent: '切 popup' }) as any;
      expect(sw.target_id).toBe('popup');
      expect(sw.switched_to).toContain('/license/edit');

      // source URL/mainFrame 不被 popup 初始化覆盖
      const back = await client.request('page.switch-tab', { url_contains: '/source', intent: '切回 source' }) as any;
      expect(back.target_id).toBe('src');
    } finally {
      try { await client.request('stop', {}, { requestTimeoutMs: 3000 }); } catch {}
      client.close();
      try { await done; } catch {}
    }
  }, 20000);

  it('popup_attached URL 用 targetUrl() 事实（非旧 info.url）', async () => {
    const srcCdp = new PageCdp('https://example.test/source', 100);
    const popCdp = new PageCdp('https://example.test/license/upload', 200);
    const owner = new FakeOwner();
    const id = 'late-trace-url';
    const { done, client } = await bootDaemon(id, srcCdp, popCdp, owner, true);
    try {
      emitPopupAttach(owner, 'popup', 'about:blank');
      await waitForPopupReady(client, 'popup');
      const attached = readTrace(id).find((e: any) => e.t === 'popup_attached');
      expect(attached).toBeDefined();
      expect(attached.url).toContain('/license/upload');
      expect(attached.url).not.toContain('about:blank');
    } finally {
      try { await client.request('stop', {}, { requestTimeoutMs: 3000 }); } catch {}
      client.close();
      try { await done; } catch {}
    }
  }, 20000);

  it('Page.getFrameTree 返回 about:blank → 保持 about:blank，不 crash', async () => {
    const srcCdp = new PageCdp('https://example.test/source', 100);
    const popCdp = new PageCdp('about:blank', 200);
    const owner = new FakeOwner();
    const { done, client } = await bootDaemon('late-blank', srcCdp, popCdp, owner, true);
    try {
      emitPopupAttach(owner, 'popup', 'about:blank');
      await waitForPopupReady(client, 'popup');
      const st = await client.request('page.state', {}) as any;
      const popupTab = st.tabs.find((t: any) => t.target_id === 'popup');
      expect(popupTab).toBeDefined();
      expect(popupTab.url).toContain('about:blank');
    } finally {
      try { await client.request('stop', {}, { requestTimeoutMs: 3000 }); } catch {}
      client.close();
      try { await done; } catch {}
    }
  }, 20000);
  it('子 frame same-document 不能污染主 frame URL', async () => {
    const srcCdp = new PageCdp('https://example.test/source', 100);
    const mainUrl = 'https://example.test/popup/main';
    const subFrameUrl = 'https://example.test/popup/main#sub';
    const popCdp = new PageCdp(mainUrl, 200);
    let gftCount = 0;
    const origSend = popCdp.send.bind(popCdp);
    vi.spyOn(popCdp, 'send').mockImplementation(async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'Page.getFrameTree') {
        if (++gftCount === 1) {
          const result = { frameTree: { frame: { id: 'popup-main', url: mainUrl } } };
          queueMicrotask(() => popCdp.emit('Page.navigatedWithinDocument', { frameId: 'sub-frame-id', url: subFrameUrl }));
          return result;
        }
        return { frameTree: { frame: { id: 'popup-main', url: mainUrl } } };
      }
      return origSend(method, params);
    });
    const owner = new FakeOwner();
    const id = 'init-race-subframe';
    const { done, client } = await bootDaemon(id, srcCdp, popCdp, owner, true);
    try {
      emitPopupAttach(owner, 'popup', 'about:blank');
      const st = await waitForPopupReady(client, 'popup');
      const popupTab = st.tabs.find((t: any) => t.target_id === 'popup');
      expect(popupTab).toBeDefined();
      expect(popupTab.url).toBe(mainUrl);
      expect(popupTab.url).not.toContain('#sub');
    } finally {
      try { await client.request('stop', {}, { requestTimeoutMs: 3000 }); } catch {}
      client.close();
      try { await done; } catch {}
    }
  }, 20000);
  it('mOld→frameNavigated mNew→new-main same-document：旧帧不回写，new-main 仍能路由', async () => {
    const srcCdp = new PageCdp('https://example.test/source', 100);
    const mOld = 'https://example.test/popup/old';
    const mNew = 'https://example.test/popup/new';
    const mNewHash = 'https://example.test/popup/new#section';
    const popCdp = new PageCdp(mOld, 200);
    let gftCount = 0;
    const origSend = popCdp.send.bind(popCdp);
    vi.spyOn(popCdp, 'send').mockImplementation(async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'Page.getFrameTree') {
        if (++gftCount === 1) {
          const result = { frameTree: { frame: { id: 'old-main', url: mOld } } };
          queueMicrotask(() => {
            popCdp.emit('Page.frameNavigated', { frame: { id: 'new-main', url: mNew, parentId: undefined } });
          });
          return result;
        }
        return { frameTree: { frame: { id: 'new-main', url: mNewHash } } };
      }
      return origSend(method, params);
    });
    const owner = new FakeOwner();
    const id = 'init-race-mnew-spa';
    const { done, client } = await bootDaemon(id, srcCdp, popCdp, owner, true);
    try {
      emitPopupAttach(owner, 'popup', 'about:blank');
      const st = await waitForPopupReady(client, 'popup');
      const popupTab = st.tabs.find((t: any) => t.target_id === 'popup');
      expect(popupTab).toBeDefined();
      expect(popupTab.url).toContain('/new');
      expect(popupTab.url).not.toContain('/old');
      // 旧 snapshot 续体已执行，switch by /old 必须 NOT_FOUND
      await expect(client.request('page.switch-tab', { url_contains: '/old', intent: '切旧' }))
        .rejects.toMatchObject({ code: 'NOT_FOUND' });
      // new-main 的 same-document 事件仍能路由（旧帧 old-main 不会覆盖 mainFrameId）
      popCdp.emit('Page.navigatedWithinDocument', { frameId: 'new-main', url: mNewHash });
      const st2 = await client.request('page.state', {}) as any;
      const popupTab2 = st2.tabs.find((t: any) => t.target_id === 'popup');
      expect(popupTab2).toBeDefined();
      expect(popupTab2.url).toContain('#section');
      expect(popupTab2.url).not.toContain('/old');
      const sw = await client.request('page.switch-tab', { url_contains: '#section', intent: '切新 SPA' }) as any;
      expect(sw.target_id).toBe('popup');
    } finally {
      try { await client.request('stop', {}, { requestTimeoutMs: 3000 }); } catch {}
      client.close();
      try { await done; } catch {}
    }
  }, 20000);
});

// ── 3. getFrameTree 取消路径 ──
// ── 2.5 初始化竞态：getFrameTree 旧 URL + 紧随 frameNavigated 新 URL ──
describe('daemon popup initialize 竞态', () => {
  it('packet-batch: getFrameTree 返回旧 URL 后紧随 frameNavigated 新 URL → tabs/popup_attached/switch 必须用新 URL', async () => {
    const srcCdp = new PageCdp('https://example.test/source', 100);
    const oldUrl = 'https://example.test/license/old';
    const newUrl = 'https://example.test/license/new';
    const popCdp = new PageCdp(oldUrl, 200);
    let gftCount = 0;
    const origSend = popCdp.send.bind(popCdp);
    vi.spyOn(popCdp, 'send').mockImplementation(async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'Page.getFrameTree') {
        if (++gftCount === 1) {
          const result = { frameTree: { frame: { id: 'popup-main', url: oldUrl } } };
          queueMicrotask(() => popCdp.emit('Page.frameNavigated', { frame: { id: 'popup-main', url: newUrl, parentId: undefined } }));
          return result;
        }
        return { frameTree: { frame: { id: 'popup-main', url: newUrl } } };
      }
      return origSend(method, params);
    });
    const owner = new FakeOwner();
    const id = 'init-race-packet';
    const { done, client } = await bootDaemon(id, srcCdp, popCdp, owner, true);
    try {
      emitPopupAttach(owner, 'popup', 'about:blank');
      const st = await waitForPopupReady(client, 'popup');
      const popupTab = st.tabs.find((t: any) => t.target_id === 'popup');
      expect(popupTab).toBeDefined();
      expect(popupTab.url).toContain('/license/new');
      expect(popupTab.url).not.toContain('/license/old');
      const attached = readTrace(id).find((e: any) => e.t === 'popup_attached');
      expect(attached).toBeDefined();
      expect(attached.url).toContain('/license/new');
      expect(attached.url).not.toContain('/license/old');
      const sw = await client.request('page.switch-tab', { url_contains: '/license/new', intent: '切新 URL' }) as any;
      expect(sw.target_id).toBe('popup');
      expect(sw.switched_to).toContain('/license/new');
      await expect(client.request('page.switch-tab', { url_contains: '/license/old', intent: '切旧 URL' }))
        .rejects.toMatchObject({ code: 'NOT_FOUND' });
    } finally {
      try { await client.request('stop', {}, { requestTimeoutMs: 3000 }); } catch {}
      client.close();
      try { await done; } catch {}
    }
  }, 20000);
  it('source initialize: getFrameTree 旧 URL + 紧随 frameNavigated 新 URL → source URL 必须是新 URL', async () => {
    const oldUrl = 'https://example.test/source/old';
    const newUrl = 'https://example.test/source/new';
    const srcCdp = new PageCdp(oldUrl, 100);
    let gftCount = 0;
    const origSend = srcCdp.send.bind(srcCdp);
    vi.spyOn(srcCdp, 'send').mockImplementation(async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'Page.getFrameTree') {
        if (++gftCount === 1) {
          const result = { frameTree: { frame: { id: 'src-main', loaderId: 'SRC1', url: oldUrl, securityOrigin: 'https://example.test' } } };
          queueMicrotask(() => srcCdp.emit('Page.frameNavigated', { frame: { id: 'src-main', url: newUrl, parentId: undefined } }));
          return result;
        }
        return { frameTree: { frame: { id: 'src-main', loaderId: 'SRC2', url: newUrl, securityOrigin: 'https://example.test' } } };
      }
      return origSend(method, params);
    });
    const popCdp = new PageCdp('https://example.test/popup', 200);
    const owner = new FakeOwner();
    const { done, client } = await bootDaemon('init-race-src', srcCdp, popCdp, owner, true);
    try {
      const st = await client.request('page.state', {}) as any;
      expect(st.url).toContain('/source/new');
      expect(st.url).not.toContain('/source/old');
      // NetworkTrace 缓存也必须用新 URL（不是旧 getFrameTree 快照）
      const srcTab = st.tabs.find((t: any) => t.source);
      expect(srcTab).toBeDefined();
      expect(srcTab.url).toContain('/source/new');
      expect(srcTab.url).not.toContain('/source/old');
    } finally {
      try { await client.request('stop', {}, { requestTimeoutMs: 3000 }); } catch {}
      client.close();
      try { await done; } catch {}
    }
  }, 20000);
  it('same-document 导航不能被旧 frame 快照回写', async () => {
    const srcCdp = new PageCdp('https://example.test/source', 100);
    const basePage = 'https://example.test/popup/page';
    const hashNav = 'https://example.test/popup/page#tab';
    const popCdp = new PageCdp(basePage, 200);
    let gftCount = 0;
    const origSend = popCdp.send.bind(popCdp);
    vi.spyOn(popCdp, 'send').mockImplementation(async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'Page.getFrameTree') {
        if (++gftCount === 1) {
          const result = { frameTree: { frame: { id: 'popup-main', url: basePage } } };
          queueMicrotask(() => popCdp.emit('Page.navigatedWithinDocument', { frameId: 'popup-main', url: hashNav }));
          return result;
        }
        return { frameTree: { frame: { id: 'popup-main', url: hashNav } } };
      }
      return origSend(method, params);
    });
    const owner = new FakeOwner();
    const id = 'init-race-spa';
    const { done, client } = await bootDaemon(id, srcCdp, popCdp, owner, true);
    try {
      emitPopupAttach(owner, 'popup', 'about:blank');
      const st = await waitForPopupReady(client, 'popup');
      const popupTab = st.tabs.find((t: any) => t.target_id === 'popup');
      expect(popupTab).toBeDefined();
      expect(popupTab.url).toContain('#tab');
    } finally {
      try { await client.request('stop', {}, { requestTimeoutMs: 3000 }); } catch {}
      client.close();
      try { await done; } catch {}
    }
  }, 20000);
});

describe('daemon popup getFrameTree 取消', () => {
  it('stop 在 getFrameTree await 期间 → silentRecycle；晚 resolve 不写新 trace', async () => {
    const srcCdp = new PageCdp('https://example.test/source', 100);
    const popCdp = new PageCdp('https://example.test/popup', 200);
    let resolveGft: (v: any) => void = () => {};
    let gftEntered = false;
    const gftPending = new Promise<any>((res) => { resolveGft = res; });
    const origSend = popCdp.send.bind(popCdp);
    vi.spyOn(popCdp, 'send').mockImplementation(async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'Page.getFrameTree') { gftEntered = true; return gftPending as any; }
      return origSend(method, params);
    });
    const owner = new FakeOwner();
    const id = 'gft-stop';
    const { done, client } = await bootDaemon(id, srcCdp, popCdp, owner, true);
    try {
      emitPopupAttach(owner, 'popup', 'about:blank');
      await vi.waitFor(() => expect(gftEntered).toBe(true), { timeout: 5000, interval: 20 });
      // stop → cancelled=true
      await client.request('stop', {}, { requestTimeoutMs: 5000 });
      client.close();
      await done; // stopped 完成
      // 基线已含 session_end
      const traceBefore = fs.readFileSync(path.join(traceDir(id), 'trace.jsonl'), 'utf8');
      expect(traceBefore).toContain('session_end');
      const closeBefore = popCdp.closeCalls;
      // 晚 resolve getFrameTree
      resolveGft({ frameTree: { frame: { id: 'main', url: 'https://example.test/popup' } } });
      await vi.waitFor(() => expect(popCdp.closeCalls).toBeGreaterThan(closeBefore), { timeout: 5000, interval: 20 });
      const traceAfter = fs.readFileSync(path.join(traceDir(id), 'trace.jsonl'), 'utf8');
      // 字节级比：stop 后晚续体不写任何新 trace
      expect(traceAfter).toBe(traceBefore);
      expect(traceAfter).not.toContain('popup_attached');
      expect(traceAfter).not.toContain('popup_init_error');
    } finally {
      try { await client.request('stop', {}, { requestTimeoutMs: 3000 }); } catch {}
      client.close();
      try { await done; } catch {}
    }
  }, 20000);

  it('stop 在 getFrameTree await 期间 → 晚 reject 也不写新 trace', async () => {
    const srcCdp = new PageCdp('https://example.test/source', 100);
    const popCdp = new PageCdp('https://example.test/popup', 200);
    let rejectGft: (e: any) => void = () => {};
    let gftEntered = false;
    const gftPending = new Promise<any>((_res, rej) => { rejectGft = rej; });
    const origSend = popCdp.send.bind(popCdp);
    vi.spyOn(popCdp, 'send').mockImplementation(async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'Page.getFrameTree') { gftEntered = true; return gftPending as any; }
      return origSend(method, params);
    });
    const owner = new FakeOwner();
    const id = 'gft-stop-rej';
    const { done, client } = await bootDaemon(id, srcCdp, popCdp, owner, true);
    try {
      emitPopupAttach(owner, 'popup', 'about:blank');
      await vi.waitFor(() => expect(gftEntered).toBe(true), { timeout: 5000, interval: 20 });
      await client.request('stop', {}, { requestTimeoutMs: 5000 });
      client.close();
      await done;
      const traceBefore = fs.readFileSync(path.join(traceDir(id), 'trace.jsonl'), 'utf8');
      expect(traceBefore).toContain('session_end');
      const closeBefore = popCdp.closeCalls;
      rejectGft(new Error('WS 已关'));
      await vi.waitFor(() => expect(popCdp.closeCalls).toBeGreaterThan(closeBefore), { timeout: 5000, interval: 20 });
      const traceAfter = fs.readFileSync(path.join(traceDir(id), 'trace.jsonl'), 'utf8');
      expect(traceAfter).toBe(traceBefore);
      expect(traceAfter).not.toContain('popup_init_error');
      expect(traceAfter).not.toContain('popup_attached');
    } finally {
      try { await client.request('stop', {}, { requestTimeoutMs: 3000 }); } catch {}
      client.close();
      try { await done; } catch {}
    }
  }, 20000);

  it('targetDestroyed 在 getFrameTree await 期间 → silentRecycle', async () => {
    const srcCdp = new PageCdp('https://example.test/source', 100);
    const popCdp = new PageCdp('https://example.test/popup', 200);
    let resolveGft: (v: any) => void = () => {};
    let gftEntered = false;
    const gftPending = new Promise<any>((res) => { resolveGft = res; });
    const origSend = popCdp.send.bind(popCdp);
    vi.spyOn(popCdp, 'send').mockImplementation(async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'Page.getFrameTree') { gftEntered = true; return gftPending as any; }
      return origSend(method, params);
    });
    const owner = new FakeOwner();
    const id = 'gft-destroyed';
    const { done, client } = await bootDaemon(id, srcCdp, popCdp, owner, true);
    try {
      emitPopupAttach(owner, 'popup', 'about:blank');
      await vi.waitFor(() => expect(gftEntered).toBe(true), { timeout: 5000, interval: 20 });
      // target 销毁 → entry.closed → cancelled()
      owner.emit('Target.targetDestroyed', { targetId: 'popup' });
      const closeBefore = popCdp.closeCalls;
      resolveGft({ frameTree: { frame: { id: 'main', url: 'https://example.test/popup' } } });
      await vi.waitFor(() => expect(popCdp.closeCalls).toBeGreaterThan(closeBefore), { timeout: 5000, interval: 20 });
      const trace = fs.readFileSync(path.join(traceDir(id), 'trace.jsonl'), 'utf8');
      expect(trace).not.toContain('popup_attached');
      expect(trace).not.toContain('popup_init_error');
      expect(trace).toContain('target_closed');
    } finally {
      try { await client.request('stop', {}, { requestTimeoutMs: 3000 }); } catch {}
      client.close();
      try { await done; } catch {}
    }
  }, 20000);

  it('getFrameTree 真实 reject → popup_init_error + 不 ready + owner 单一清理', async () => {
    const srcCdp = new PageCdp('https://example.test/source', 100);
    const popCdp = new PageCdp('https://example.test/popup', 200);
    const origSend = popCdp.send.bind(popCdp);
    vi.spyOn(popCdp, 'send').mockImplementation(async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'Page.getFrameTree') throw new Error('CDP getFrameTree 失败');
      return origSend(method, params);
    });
    const owner = new FakeOwner();
    const id = 'gft-reject';
    const { done, client } = await bootDaemon(id, srcCdp, popCdp, owner, true);
    try {
      emitPopupAttach(owner, 'popup', 'about:blank');
      // 等 onPopup 执行完（非取消路径）→ popup 不 ready
      await vi.waitFor(() => readTrace(id).some((e: any) => e.t === 'popup_init_error'), { timeout: 5000, interval: 30 });
      const st = await client.request('page.state', {}) as any;
      expect(st.tabs.find((t: any) => t.target_id === 'popup')).toBeUndefined();
      // waiting=false → owner 不会 resume（非 paused popup 不需要 resume）
      const resumeCalls = owner.calls.filter((c: any) => c.method === 'Runtime.runIfWaitingForDebugger' && c.sessionId === 'popup-child');
      expect(resumeCalls).toHaveLength(0);
    } finally {
      try { await client.request('stop', {}, { requestTimeoutMs: 3000 }); } catch {}
      client.close();
      try { await done; } catch {}
    }
  }, 20000);
});

describe('daemon popup urlFragment 保留', () => {
  it('popup getFrameTree url+urlFragment → tabs/popup_attached 完整 URL，switch by hash 成功', async () => {
    const srcCdp = new PageCdp('https://example.test/source', 100);
    const popCdp = new PageCdp('https://example.test/pages/productLicense.html', 200);
    popCdp.urlFragment = '#/new';
    const owner = new FakeOwner();
    const id = 'frag-popup';
    const { done, client } = await bootDaemon(id, srcCdp, popCdp, owner, true);
    try {
      emitPopupAttach(owner, 'popup', 'about:blank');
      const st = await waitForPopupReady(client, 'popup');
      const popupTab = st.tabs.find((t: any) => t.target_id === 'popup');
      expect(popupTab).toBeDefined();
      expect(popupTab.url).toBe('https://example.test/pages/productLicense.html#/new');
      const attached = readTrace(id).find((e: any) => e.t === 'popup_attached');
      expect(attached).toBeDefined();
      expect(attached.url).toBe('https://example.test/pages/productLicense.html#/new');
      const sw = await client.request('page.switch-tab', { url_contains: 'productLicense.html#/new', intent: '切 hash popup' }) as any;
      expect(sw.target_id).toBe('popup');
      expect(sw.switched_to).toBe('https://example.test/pages/productLicense.html#/new');
    } finally {
      try { await client.request('stop', {}, { requestTimeoutMs: 3000 }); } catch {}
      client.close();
      try { await done; } catch {}
    }
  }, 20000);
});
