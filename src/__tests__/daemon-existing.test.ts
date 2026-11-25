import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CdpSession } from '../browser/daemon-client.js';
import { openCdpSession, launchChromium, injectAndProbeAuthState, injectAndProbeInSession, type CdpLowSession } from '../browser/managed-browser.js';
import { runDaemon } from '../daemon/daemon.js';
import { defaultBootstrap } from '../daemon/bootstrap.js';
import { DaemonClient } from '../daemon/client.js';
import { importedAuthPath } from '../auth-resolve.js';
import { readMeta, writeMeta, resolveSocketPath, traceDir } from '../daemon/session-meta.js';
import { readTraceEvents } from '../daemon/trace.js';
import { launchProfileAndProbe } from '../browser/profile-browser.js';

vi.mock('../browser/managed-browser.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../browser/managed-browser.js')>();
  return { ...actual, openCdpSession: vi.fn(), resolveSystemChrome: vi.fn(() => '/system/google-chrome'),
    resolveChromiumExecutable: vi.fn(() => '/fake/chromium'), launchChromium: vi.fn(),
    injectAndProbeAuthState: vi.fn(async () => ({ finalUrl: 'https://portal.example.invalid/' })) };
});
vi.mock('../browser/profile-browser.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../browser/profile-browser.js')>();
  return { ...actual, launchProfileAndProbe: vi.fn() };
});

describe('现成浏览器隔离 context', () => {
  let home: string;
  let saved: Record<string, string | undefined>;
  const endpoint = 'http://127.0.0.1:9222';

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-existing-'));
    saved = Object.fromEntries(['E2ET_HOME', 'E2ET_CDP_URL', 'E2ET_AUTH_STATE', 'E2ET_AUTH_PROBE_URL', 'E2ET_IDLE_TIMEOUT_MS'].map((key) => [key, process.env[key]]));
    process.env.E2ET_HOME = home;
    process.env.E2ET_CDP_URL = endpoint;
    delete process.env.E2ET_AUTH_STATE;
    delete process.env.E2ET_AUTH_PROBE_URL;
    process.env.E2ET_IDLE_TIMEOUT_MS = '60000';
    const imported = importedAuthPath();
    fs.mkdirSync(path.dirname(imported), { recursive: true });
    const expires = Math.floor(Date.now() / 1000) + 3600;
    fs.writeFileSync(imported, JSON.stringify({ cookies: ['EXAMPLE_SESSION', 'X-XSRF-TOKEN'].map((name) => ({ name, value: 'test-only', domain: '.example.invalid', path: '/', expires })), origins: [] }));
    vi.mocked(openCdpSession).mockReset();
    vi.mocked(launchProfileAndProbe).mockReset();
    vi.mocked(launchChromium).mockReset();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => String(url).includes('/json/new')
      ? { id: 'profile-tab', url: 'about:blank' }
      : { Browser: 'Chromium/test', webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/browser/test' } })));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(home, { recursive: true, force: true });
  });

  // existing-force-ok 测试可能在 TMPDIR 留 e2et-existing-force-ok-* 残留（managed 临时目录
  // 由 defaultBootstrap 内 fs.mkdtempSync 创建，mock 写死 userDataDir 时 result.browserUserDataDir
  // 指向错误路径导致泄漏）。精确前缀清理，不误删别的 sessionId 目录。
  afterEach(() => {
    const prefix = 'e2et-existing-force-ok-';
    for (const name of fs.readdirSync(os.tmpdir())) {
      if (name.startsWith(prefix)) {
        fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true });
      }
    }
  });

  function fakeBrowser(finalUrls = ['https://portal.example.invalid/'], failAt?: string,
    opts: { disposeFails?: boolean; waitClosed?: 'true' | 'false' | 'deferred'; waitClosedSeq?: boolean[]; forceCloseFn?: () => void;
      navErrors?: Array<string | undefined>;
      ids?: { contextId?: string; targetId?: string; targetSessionId?: string } } = {}) {
    const ctxId = opts.ids?.contextId ?? 'isolated-1';
    const tgtId = opts.ids?.targetId ?? 'private-tab';
    const sessId = opts.ids?.targetSessionId ?? 'private-session';
    const calls: Array<{ method: string; params: Record<string, unknown>; sessionId?: string }> = [];
    const listeners = new Map<string, (params: unknown) => void>();
    const close = vi.fn();
    const ownerCloseHandlers: Array<() => void> = [];
    let resolveDeferred: (() => void) | undefined;
    const waitClosed = vi.fn(async (_timeoutMs: number): Promise<boolean> => {
      // waitClosedSeq：按调用顺序消费（force 路径第一/第二次返回不同值）
      if (opts.waitClosedSeq && opts.waitClosedSeq.length) return opts.waitClosedSeq.shift()!;
      if (opts.waitClosed === 'false') return false;
      if (opts.waitClosed === 'deferred') {
        return new Promise<boolean>((resolve) => { resolveDeferred = () => resolve(true); });
      }
      return true;
    });
    const forceClose = vi.fn(() => { opts.forceCloseFn?.(); });
    // per-fake context/target 存活状态：dispose 本 context 后该 target 后续 Runtime/Page.navigate 报错，
    // 使误 dispose（A cleanup dispose 了 B 的 context）能让测试红；不跨 fake 共享，不掩盖真实隔离。
    let contextAlive = false;
    const ensureAlive = () => { if (!contextAlive) throw new Error('context 已 dispose，target 不可用'); };
    const owner: CdpLowSession = {
      send: vi.fn(async (method: string, params: Record<string, unknown> = {}, sessionId?: string) => {
        calls.push({ method, params, sessionId });
        if (method === 'Target.disposeBrowserContext') {
          // 误 dispose 跨 context：A cleanup 绝不能 dispose B 的 ctx，否则抛错让测试红
          if (params.browserContextId !== ctxId) throw new Error(`unknown context ${params.browserContextId}（误 dispose 跨 context）`);
          if (opts.disposeFails) throw new Error('dispose 失败');
          contextAlive = false;
          return {};
        }
        if (method === failAt) throw new Error(`${method} 失败`);
        if (method === 'Target.createBrowserContext') { contextAlive = true; return { browserContextId: ctxId }; }
        if (method === 'Target.createTarget') return { targetId: tgtId };
        if (method === 'Target.attachToTarget') return { sessionId: sessId };
        if (method === 'Runtime.evaluate') { ensureAlive(); return { result: { value: finalUrls.shift() } }; }
        if (method === 'Page.navigate') {
          ensureAlive();
          if (params.url !== 'about:blank') {
            const errorText = opts.navErrors?.shift();
            if (errorText) return { errorText };
            queueMicrotask(() => listeners.get('Page.loadEventFired')?.({}));
          }
          return {};
        }
        return {};
      }),
      addEventListener: vi.fn((method, handler) => { listeners.set(method, handler); return () => { listeners.delete(method); }; }),
      onClose: vi.fn((handler: () => void) => { ownerCloseHandlers.push(handler); }),
      close,
      waitClosed,
      forceClose,
    };
    vi.mocked(openCdpSession).mockResolvedValue(owner);
    // 富 tab：支持 page.open 驱动（navigate 触发 loadEventFired、evaluate 返回页面态、AX 树空）
    const tabListeners: Array<{ method: string; handler: (params: any) => void }> = [];
    let tabUrl = 'about:blank';
    const tab = {
      send: vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
        if (method === 'Page.navigate') {
          ensureAlive();
          if (typeof params.url === 'string') tabUrl = params.url;
          // setTimeout(macrotask)：waitForLoad 在 navigate 返回后才注册 loadEventFired 监听，
          // queueMicrotask 会赶在注册前触发导致错过；macrotask 排在 waitForLoad 同步注册之后。
          setTimeout(() => tabListeners.filter((l) => l.method === 'Page.loadEventFired').forEach((l) => l.handler({})), 0);
        }
        if (method === 'Accessibility.getFullAXTree') return { nodes: [] };
        return {};
      }),
      evaluate: vi.fn(async (expr: string) => {
        ensureAlive();
        if (expr.includes('location.href')) return tabUrl;
        if (expr.includes('readyState')) return 'complete';
        if (expr.includes('__e2etChangeCount')) return 0;
        if (expr.includes('__e2etObserver')) return true;
        return '';
      }),
      on: vi.fn((method: string, handler: (params: any) => void) => {
        const entry = { method, handler };
        tabListeners.push(entry);
        return () => { const i = tabListeners.indexOf(entry); if (i !== -1) tabListeners.splice(i, 1); };
      }),
      onClose: vi.fn(),
      close: vi.fn(),
    };
    vi.spyOn(CdpSession, 'connect').mockResolvedValue(tab as unknown as CdpSession);
    return {
      owner, calls, close, tab, waitClosed, forceClose,
      triggerOwnerClose: () => { for (const handler of ownerCloseHandlers) handler(); },
      resolveDeferred: () => resolveDeferred?.(),
    };
  }

  function fakeProfile(sessionId: string): void {
    const cookieFile = path.join(home, 'e2e-profile', 'Default', 'Cookies');
    fs.mkdirSync(path.dirname(cookieFile), { recursive: true });
    fs.writeFileSync(cookieFile, 'test-only');
    fs.writeFileSync(path.join(home, 'e2e-profile', 'Local State'), '{}');
    vi.mocked(launchProfileAndProbe).mockImplementation(async (_exe, _master, _sid, _env, onEarly) => {
      const previous = readMeta(sessionId);
      expect(previous?.browser_context_id).toBeUndefined();
      expect(previous?.browser_endpoint).toBeUndefined();
      expect(previous?.tab_id).toBeUndefined();
      const handle = { pid: 123, baseUrl: 'http://127.0.0.1:9333', userDataDir: path.join(home, 'profile-copy') };
      onEarly?.(handle);
      return { handle, result: { finalUrl: 'https://portal.example.invalid/' } };
    });
  }

  it('CDP 存在但 profile 不适用时只消费显式 state/imported', async () => {
    const id = 'existing-no-auth';
    const fake = fakeBrowser();
    const result = await defaultBootstrap(id, 'test.sock', 'pre', 'auto', 'auto');
    expect(result).toMatchObject({ browserSource: 'existing', authSource: 'imported', tabId: 'private-tab' });
    expect(openCdpSession).toHaveBeenCalledOnce();
    expect(fake.calls).toContainEqual({ method: 'Network.setCookies', params: expect.any(Object), sessionId: 'private-session' });
    expect(readMeta(id)?.browser_context_id).toBe('isolated-1');
  });

  it.each(['owner', 'Target.createBrowserContext', 'Target.createTarget', 'Target.attachToTarget', 'probe', 'page WS'])(
    'existing %s 失败清理后降级 managed+imported', async (stage) => {
      const id = `existing-fallback-${stage.replace(/\W/g, '-')}`;
      // probe 失败 = 显式探测 URL 导航返回明确 errorText，不再空等 URL 轮询预算
      if (stage === 'probe') process.env.E2ET_AUTH_PROBE_URL = 'https://probe.example.test/';
      const fake = fakeBrowser(undefined,
        stage.startsWith('Target.') ? stage : undefined,
        { navErrors: stage === 'probe' ? ['net::ERR_FAILED'] : undefined });
      if (stage === 'owner') vi.mocked(openCdpSession).mockRejectedValueOnce(new Error('owner 失败'));
      if (stage === 'page WS') vi.mocked(CdpSession.connect).mockRejectedValueOnce(new Error('page WS 失败'));
      vi.mocked(launchChromium).mockImplementation(async (_executable, userDataDir) => ({
        pid: 456,
        baseUrl: 'http://127.0.0.1:9333',
        userDataDir,
        child: { unref: () => {}, stderr: { removeAllListeners: () => {}, destroy: () => {} } },
      }) as any);
      const result = await defaultBootstrap(id, 'test.sock', 'pre', 'auto', 'auto');
      expect(result).toMatchObject({ browserSource: 'managed', authSource: 'imported' });
      expect(readMeta(id)).toMatchObject({ browser_source: 'managed', transport: 'managed' });
      expect(fake.calls.some((call) => call.method === 'Browser.close')).toBe(false);
      if (stage !== 'owner') expect(fake.close).toHaveBeenCalledOnce();
      if (!['owner', 'Target.createBrowserContext'].includes(stage)) {
        expect(fake.calls).toContainEqual({ method: 'Target.disposeBrowserContext', params: { browserContextId: 'isolated-1' }, sessionId: undefined });
      }
      fs.rmSync(result.browserUserDataDir!, { recursive: true, force: true });
    },
  );

  it('强制 auth/imported 的 existing owner 失败不降级 profile', async () => {
    const id = 'existing-forced';
    fakeProfile(id);
    fakeBrowser();
    vi.mocked(openCdpSession).mockRejectedValueOnce(new Error('owner 失败'));
    await expect(defaultBootstrap(id, 'test.sock', 'pre', 'imported', 'auto')).rejects.toThrow('owner 失败');
    expect(launchProfileAndProbe).not.toHaveBeenCalled();
    expect(readMeta(id)).toMatchObject({ transport: 'native-cdp', browser_source: 'existing' });
    expect(readMeta(id)?.browser_endpoint).toBeUndefined();
  });

  it('无 profile 时 existing owner 失败后清理并降级 managed+imported', async () => {
    const id = 'existing-to-managed';
    fakeBrowser();
    vi.mocked(openCdpSession).mockRejectedValueOnce(new Error('owner 失败'));
    vi.mocked(launchChromium).mockImplementation(async (_executable, userDataDir) => {
      const previous = readMeta(id);
      expect(previous).toMatchObject({ transport: 'managed', browser_source: 'managed' });
      expect(previous?.browser_context_id).toBeUndefined();
      expect(previous?.browser_endpoint).toBeUndefined();
      expect(previous?.tab_id).toBeUndefined();
      return { pid: 456, baseUrl: 'http://127.0.0.1:9333', userDataDir,
        child: { unref: () => {}, stderr: { removeAllListeners: () => {}, destroy: () => {} } } } as any;
    });
    const result = await defaultBootstrap(id, 'test.sock', 'pre', 'auto', 'auto');
    try {
      expect(result).toMatchObject({ browserSource: 'managed', authSource: 'imported' });
      expect(launchChromium).toHaveBeenCalledWith('/fake/chromium', result.browserUserDataDir);
      expect(injectAndProbeAuthState).toHaveBeenCalledOnce();
      expect(readMeta(id)?.browser_context_id).toBeUndefined();
    } finally {
      fs.rmSync(result.browserUserDataDir!, { recursive: true, force: true });
    }
  });

  it('auto 完整链：existing 失败 → profile 探测失败 → managed+imported 成功', async () => {
    const id = 'existing-profile-managed';
    fakeProfile(id);
    vi.mocked(launchProfileAndProbe).mockResolvedValue({ result: { finalUrl: '', probeError: 'profile 无效' } });
    const fake = fakeBrowser(undefined, 'Target.createTarget');
    vi.mocked(launchChromium).mockImplementation(async (_executable, userDataDir) => ({
      pid: 456, baseUrl: 'http://127.0.0.1:9333', userDataDir,
      child: { unref: () => {}, stderr: { removeAllListeners: () => {}, destroy: () => {} } },
    } as any));
    const result = await defaultBootstrap(id, 'test.sock', 'pre', 'auto', 'auto');
    try {
      expect(result).toMatchObject({ browserSource: 'managed', authSource: 'imported' });
      expect(fake.calls.map((call) => call.method)).toContain('Target.disposeBrowserContext');
      expect(fake.close).toHaveBeenCalledOnce();
      expect(launchProfileAndProbe).toHaveBeenCalledOnce();
      expect(launchChromium).toHaveBeenCalledOnce();
      expect(readMeta(id)?.browser_context_id).toBeUndefined();
      expect(readMeta(id)?.browser_source).toBe('managed');
    } finally {
      fs.rmSync(result.browserUserDataDir!, { recursive: true, force: true });
    }
  });

  it.each(['Target.createBrowserContext', 'Target.createTarget', 'Target.attachToTarget', 'probe', 'page WS'])(
    '强制 existing %s 失败后无 context/endpoint/tab 残留', async (stage) => {
      const id = `existing-fail-${stage.replace(/\W/g, '-')}`;
      fakeProfile(id);
      // probe 失败 = 显式探测 URL 导航返回明确 errorText，不再空等 URL 轮询预算
      if (stage === 'probe') process.env.E2ET_AUTH_PROBE_URL = 'https://probe.example.test/';
      const fake = fakeBrowser(undefined, stage.startsWith('Target.') ? stage : undefined, {
        navErrors: stage === 'probe' ? ['net::ERR_FAILED'] : undefined,
      });
      if (stage === 'page WS') vi.mocked(CdpSession.connect).mockRejectedValueOnce(new Error('page WS 失败'));
      await expect(defaultBootstrap(id, 'test.sock', 'pre', 'auto', 'existing')).rejects.toThrow();
      expect(readMeta(id)).toMatchObject({ browser_source: 'existing', transport: 'native-cdp' });
      expect(readMeta(id)?.browser_context_id).toBeUndefined();
      expect(readMeta(id)?.browser_endpoint).toBeUndefined();
      expect(readMeta(id)?.tab_id).toBeUndefined();
      expect(fake.close).toHaveBeenCalledOnce();
      expect(launchProfileAndProbe).not.toHaveBeenCalled();
    },
  );

  it('旧 context 清理不覆盖随后写入的新 context meta', async () => {
    const id = 'existing-compare-clear';
    const fake = fakeBrowser();
    const send = vi.mocked(fake.owner.send).getMockImplementation()!;
    vi.mocked(fake.owner.send).mockImplementation(async (method, params, targetSession) => {
      if (method === 'Target.createTarget') {
        writeMeta({ ...readMeta(id)!, browser_context_id: 'new-context', browser_endpoint: 'http://other:9222', tab_id: 'new-tab' });
        throw new Error('旧 target 失败');
      }
      return send(method, params, targetSession);
    });
    await expect(defaultBootstrap(id, 'test.sock', 'pre', 'imported', 'existing')).rejects.toThrow('旧 target 失败');
    expect(readMeta(id)).toMatchObject({ browser_context_id: 'new-context', browser_endpoint: 'http://other:9222', tab_id: 'new-tab' });
    expect(fake.calls.map((call) => call.method)).toContain('Target.disposeBrowserContext');
  });

  it('CDP 未返回 context id 时绝不创建默认 context 标签页', async () => {
    const fake = fakeBrowser();
    vi.mocked(fake.owner.send).mockResolvedValueOnce({} as never);
    await expect(defaultBootstrap('existing-no-context-id', 'test.sock', 'pre', 'imported', 'existing')).rejects.toThrow(/未返回 browserContextId/);
    expect(fake.calls.some((call) => call.method === 'Target.createTarget')).toBe(false);
    expect(fake.close).toHaveBeenCalledOnce();
    expect(readMeta('existing-no-context-id')?.browser_endpoint).toBeUndefined();
  });

  it('bootstrap 失败 trace 使用 existing transport/source，不保留已 dispose 的 context', async () => {
    const id = 'existing-trace-fail';
    const fake = fakeBrowser(undefined, 'Target.createTarget');
    const before = process.listeners('SIGTERM');
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit 1'); });
    try {
      await expect(runDaemon(id, { env: 'pre', socketPath: resolveSocketPath(id), authMode: 'imported', browserMode: 'existing' })).rejects.toThrow('exit 1');
      const meta = readMeta(id);
      expect(meta).toMatchObject({ browser_source: 'existing', transport: 'native-cdp' });
      expect(meta?.browser_context_id).toBeUndefined();
      expect(meta?.browser_endpoint).toBeUndefined();
      expect(meta?.tab_id).toBeUndefined();
      const events = fs.readFileSync(path.join(traceDir(id), 'trace.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(events[0]).toMatchObject({ t: 'session', transport: 'native-cdp', browser_source: 'existing' });
      expect(events[0]).not.toHaveProperty('browser_context_id');
      expect(events[1]).toMatchObject({ t: 'session_end', result: 'aborted' });
      expect(fake.close).toHaveBeenCalledOnce();
    } finally {
      exit.mockRestore();
      for (const listener of process.listeners('SIGTERM')) if (!before.includes(listener)) process.off('SIGTERM', listener);
    }
  });

  it('只在新 context 的 target 注入 cookie；owner 保持到 stop，随后主动 dispose', async () => {
    const fake = fakeBrowser();
    const id = 'existing-stop';
    const socket = resolveSocketPath(id);
    const done = runDaemon(id, { env: 'pre', socketPath: socket, authMode: 'imported', browserMode: 'existing', exitOnStop: false });
    try {
      const deadline = Date.now() + 5000;
      while (!(await DaemonClient.ping(socket, 100)) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      const meta = readMeta(id);
      expect(meta).toMatchObject({ browser_context_id: 'isolated-1', browser_source: 'existing', auth_source: 'imported', tab_id: 'private-tab' });
      expect(meta?.browser_pid).toBeUndefined();
      expect(fs.readFileSync(path.join(traceDir(id), 'trace.jsonl'), 'utf8')).toContain('"browser_context_id":"isolated-1"');
      expect(fake.calls).toContainEqual({ method: 'Target.createBrowserContext', params: { disposeOnDetach: true }, sessionId: undefined });
      expect(fake.calls).toContainEqual({ method: 'Target.createTarget', params: { url: 'about:blank', browserContextId: 'isolated-1' }, sessionId: undefined });
      expect(fake.calls).toContainEqual({ method: 'Target.attachToTarget', params: { targetId: 'private-tab', flatten: true }, sessionId: undefined });
      // Security.setIgnoreCertificateErrors：在 attachToTarget 之后、Network.setCookies 之前，target session 作用域
      const secCall = fake.calls.find((c) => c.method === 'Security.setIgnoreCertificateErrors');
      expect(secCall).toBeDefined();
      expect(secCall?.params).toEqual({ ignore: true });
      expect(secCall?.sessionId).toBe('private-session'); // target session，非 browser-level（sessionId 非 undefined）
      const attachIdx = fake.calls.findIndex((c) => c.method === 'Target.attachToTarget');
      const secIdx = fake.calls.findIndex((c) => c.method === 'Security.setIgnoreCertificateErrors');
      const injectIdx = fake.calls.findIndex((c) => c.method === 'Network.setCookies');
      expect(attachIdx).toBeLessThan(secIdx);
      expect(secIdx).toBeLessThan(injectIdx);
      // 禁止 browser-level（无 sessionId）的 Security 命令
      expect(fake.calls.filter((c) => c.method.startsWith('Security.') && !c.sessionId)).toEqual([]);
      const injection = fake.calls.find((call) => call.method === 'Network.setCookies');
      expect(injection?.sessionId).toBe('private-session');
      expect((injection?.params.cookies as unknown[])).toHaveLength(2);
      expect(fake.calls.filter((call) => call.method === 'Network.setCookies' && !call.sessionId)).toEqual([]);
      expect(fake.calls.some((call) => call.method === 'Target.getTargets' || call.method === 'Browser.close')).toBe(false);
      expect(fake.close).not.toHaveBeenCalled();
      const client = await DaemonClient.connect(socket);
      await client.request('stop', {});
      client.close();
      await done;
      expect(fake.calls).toContainEqual({ method: 'Target.disposeBrowserContext', params: { browserContextId: 'isolated-1' }, sessionId: undefined });
      expect(fake.close).toHaveBeenCalledOnce();
      expect(fake.tab.close).toHaveBeenCalledOnce();
      expect(readMeta(id)?.session_end?.result).toBe('blocked');
      expect(fake.calls.some((call) => call.method === 'Browser.close')).toBe(false);
    } finally {
      if (!fake.close.mock.calls.length) {
        const client = await DaemonClient.connect(socket).catch(() => null);
        await client?.request('stop', {}).catch(() => {});
        client?.close();
        await done;
      }
    }
  });

  it('existing owner WS 关闭（page 仍活）时会话 aborted', async () => {
    const fake = fakeBrowser();
    const id = 'existing-owner-close';
    const socket = resolveSocketPath(id);
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => { rejections.push(reason); };
    process.on('unhandledRejection', onRejection);
    const done = runDaemon(id, { env: 'pre', socketPath: socket, authMode: 'imported', browserMode: 'existing', exitOnStop: false });
    try {
      const deadline = Date.now() + 5000;
      while (!(await DaemonClient.ping(socket, 100)) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      const client = await DaemonClient.connect(socket);
      client.close();
      // 只断 owner WS（page/tab 仍活）：会话必须 aborted，而不是继续假装 ready
      fake.triggerOwnerClose();
      await Promise.race([done, new Promise((resolve) => setTimeout(resolve, 3000))]);
      expect(readMeta(id)?.session_end?.result).toBe('aborted');
      const events = readTraceEvents(id);
      const last = events.at(-1) as { t?: string; result?: string } | undefined;
      expect(last?.t).toBe('session_end');
      expect(last?.result).toBe('aborted');
      expect(fake.close).toHaveBeenCalledOnce();
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
      if (!fake.close.mock.calls.length) {
        const client = await DaemonClient.connect(socket).catch(() => null);
        await client?.request('stop', {}).catch(() => {});
        client?.close();
        await Promise.race([done.catch(() => {}), new Promise((resolve) => setTimeout(resolve, 3000))]);
      }
    }
  });

  it('target 连接失败时销毁 context 并断开 owner，不关共享浏览器', async () => {
    const fake = fakeBrowser();
    vi.mocked(CdpSession.connect).mockRejectedValueOnce(new Error('target 连接失败'));
    await expect(defaultBootstrap('existing-fail', 'fail.sock', 'pre', 'imported', 'existing')).rejects.toThrow('target 连接失败');
    expect(fake.calls.map((call) => call.method)).toContain('Target.disposeBrowserContext');
    expect(fake.close).toHaveBeenCalledOnce();
    expect(fake.calls.some((call) => call.method === 'Browser.close')).toBe(false);
  });

  it('existing+auto 的 imported 探测失败清 cookie 后不重试其它身份', async () => {
    process.env.E2ET_AUTH_PROBE_URL = 'https://probe.example.test/';
    const fake = fakeBrowser(['https://probe.example.test/'], undefined, { navErrors: ['net::ERR_FAILED'] });
    await expect(defaultBootstrap('existing-auto', 'auto.sock', 'pre', 'auto', 'existing'))
      .rejects.toThrow(/auth resolve 失败|probe/i);
    const operations = fake.calls.filter((call) => ['Network.setCookies', 'Network.clearBrowserCookies'].includes(call.method));
    expect(operations.map((call) => call.method)).toEqual(['Network.setCookies', 'Network.clearBrowserCookies']);
    expect(operations.every((call) => call.sessionId === 'private-session')).toBe(true);
    // 探测失败后必须断开本次 owner 连接并销毁隔离 context；共享浏览器本身不能被关闭。
    expect(fake.close).toHaveBeenCalledOnce();
    expect(fake.calls.some((call) => call.method === 'Browser.close')).toBe(false);
  });

  it('SIGTERM handler 走 aborted 收尾并主动 dispose', async () => {
    const fake = fakeBrowser();
    const id = 'existing-term';
    const socket = resolveSocketPath(id);
    const before = process.listeners('SIGTERM');
    const done = runDaemon(id, { env: 'pre', socketPath: socket, authMode: 'imported', browserMode: 'existing', exitOnStop: false });
    const deadline = Date.now() + 5000;
    while (!(await DaemonClient.ping(socket, 100)) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    const handler = process.listeners('SIGTERM').find((listener) => !before.includes(listener));
    expect(handler).toBeDefined();
    (handler as () => void)();
    await done;
    expect(readMeta(id)?.session_end?.result).toBe('aborted');
    expect(fake.calls).toContainEqual({ method: 'Target.disposeBrowserContext', params: { browserContextId: 'isolated-1' }, sessionId: undefined });
    expect(fake.close).toHaveBeenCalledOnce();
    expect(fake.calls.some((call) => call.method === 'Browser.close')).toBe(false);
  });

  it('dispose 失败 + close 确认成功时清 meta 并 close owner，不调 forceClose', async () => {
    const fake = fakeBrowser(undefined, 'Target.attachToTarget', { disposeFails: true, waitClosed: 'true' });
    await expect(defaultBootstrap('existing-dispose-ok', 'd.sock', 'pre', 'imported', 'existing'))
      .rejects.toThrow('Target.attachToTarget 失败');
    // dispose 尝试过
    expect(fake.calls.some((c) => c.method === 'Target.disposeBrowserContext')).toBe(true);
    // close 被调（confirmOwnerClosed 内部发起）
    expect(fake.close).toHaveBeenCalledOnce();
    // close 确认成功 → 不需要 forceClose
    expect(fake.forceClose).not.toHaveBeenCalled();
    // 断链确认 → meta 已清，可降级
    const meta = readMeta('existing-dispose-ok');
    expect(meta?.browser_context_id).toBeUndefined();
    expect(meta?.browser_endpoint).toBeUndefined();
    expect(meta?.tab_id).toBeUndefined();
    expect(meta?.cleanup_blocked).toBeUndefined();
  });

  it('dispose 失败 + close 延迟时下一候选在 close 确认前绝不启动；确认后才启动', async () => {
    const fake = fakeBrowser(undefined, 'Target.attachToTarget', { disposeFails: true, waitClosed: 'deferred' });
    // managed 作为降级候选：launchChromium 调到才算"下一候选启动"
    vi.mocked(launchChromium).mockImplementation(async () => {
      return { pid: 789, baseUrl: 'http://127.0.0.1:9444', userDataDir: '/tmp/managed-x',
        child: { unref: () => {}, stderr: { removeAllListeners: () => {}, destroy: () => {} } } } as any;
    });
    // bootstrap 在 existing catch 里 await waitClosed(deferred)，此时下一候选尚未启动
    const bootstrapPromise = defaultBootstrap('existing-deferred', 'd2.sock', 'pre', 'auto', 'auto');
    // 让 microtask/promise 推进，但 deferred 未 resolve → launchChromium 不应被调
    await new Promise((r) => setTimeout(r, 10));
    expect(fake.waitClosed).toHaveBeenCalled();
    expect(vi.mocked(launchChromium)).not.toHaveBeenCalled();
    // resolve deferred → waitClosed 返回 true → meta 清 → 降级到 managed → launchChromium 启动
    fake.resolveDeferred();
    let result;
    try {
      result = await bootstrapPromise;
    } catch {
      // managed 后续步骤可能因 mock 不全而失败，但"下一候选已启动"才是断言重点
    }
    expect(vi.mocked(launchChromium)).toHaveBeenCalled();
    if (result) fs.rmSync(result.browserUserDataDir!, { recursive: true, force: true });
  });

  it('force 路径：close→waitClosed(false)→forceClose→waitClosed(true)，第二次确认 true 才允许降级', async () => {
    // waitClosedSeq=[false,true]：第一次 close 未确认 → forceClose → 第二次确认 true → 降级
    const fake = fakeBrowser(undefined, 'Target.attachToTarget', { disposeFails: true, waitClosedSeq: [false, true] });
    vi.mocked(launchChromium).mockImplementation(async (_exe, userDataDir) => ({
      pid: 789, baseUrl: 'http://127.0.0.1:9444', userDataDir,
      child: { unref: () => {}, stderr: { removeAllListeners: () => {}, destroy: () => {} } } } as any));
    let result;
    try { result = await defaultBootstrap('existing-force-ok', 'f1.sock', 'pre', 'auto', 'auto'); } catch { /* managed 后续 mock 不全可能失败，断言重点是调用顺序与降级启动 */ }
    // 严格调用顺序：close 一次、waitClosed 两次、forceClose 一次
    expect(fake.close).toHaveBeenCalledTimes(1);
    expect(fake.forceClose).toHaveBeenCalledTimes(1);
    expect(fake.waitClosed).toHaveBeenCalledTimes(2);
    // async mock：await results[n].value 取实际返回值
    expect(await fake.waitClosed.mock.results[0].value).toBe(false);
    expect(await fake.waitClosed.mock.results[1].value).toBe(true);
    // invocationCallOrder 严格递增：close < waitClosed(1) < forceClose < waitClosed(2)
    const [closeOrd] = fake.close.mock.invocationCallOrder;
    const [w1] = fake.waitClosed.mock.invocationCallOrder;
    const [fc] = fake.forceClose.mock.invocationCallOrder;
    const [, w2] = fake.waitClosed.mock.invocationCallOrder;
    expect(closeOrd).toBeLessThan(w1);
    expect(w1).toBeLessThan(fc);
    expect(fc).toBeLessThan(w2);
    // 第二次确认 true → 降级到 managed 启动
    expect(vi.mocked(launchChromium)).toHaveBeenCalled();
    // 断链已确认 → meta 已清（不保留 cleanup_blocked）
    expect(readMeta('existing-force-ok')?.cleanup_blocked).toBeUndefined();
    if (result) fs.rmSync(result.browserUserDataDir!, { recursive: true, force: true });
  });

  it('force 路径：close→waitClosed(false)→forceClose→waitClosed(false)，第二次 false 不降级且 cleanup_blocked', async () => {
    // waitClosedSeq=[false,false]：两次确认都失败 → 不降级，保留 meta 供诊断
    const fake = fakeBrowser(undefined, 'Target.attachToTarget', { disposeFails: true, waitClosedSeq: [false, false] });
    await expect(defaultBootstrap('existing-force-block', 'f2.sock', 'pre', 'auto', 'auto'))
      .rejects.toThrow('owner 断链无法确认');
    // 严格调用顺序：close 一次、waitClosed 两次、forceClose 一次
    expect(fake.close).toHaveBeenCalledTimes(1);
    expect(fake.forceClose).toHaveBeenCalledTimes(1);
    expect(fake.waitClosed).toHaveBeenCalledTimes(2);
    expect(await fake.waitClosed.mock.results[0].value).toBe(false);
    expect(await fake.waitClosed.mock.results[1].value).toBe(false);
    const [closeOrd] = fake.close.mock.invocationCallOrder;
    const [w1] = fake.waitClosed.mock.invocationCallOrder;
    const [fc] = fake.forceClose.mock.invocationCallOrder;
    const [, w2] = fake.waitClosed.mock.invocationCallOrder;
    expect(closeOrd).toBeLessThan(w1);
    expect(w1).toBeLessThan(fc);
    expect(fc).toBeLessThan(w2);
    // 禁止降级 → 下一候选未启动
    expect(vi.mocked(launchChromium)).not.toHaveBeenCalled();
    expect(vi.mocked(launchProfileAndProbe)).not.toHaveBeenCalled();
    // meta 保留 context 供诊断，标记 cleanup_blocked
    const meta = readMeta('existing-force-block');
    expect(meta?.browser_context_id).toBe('isolated-1');
    expect(meta?.browser_endpoint).toBe(endpoint);
    expect(meta?.tab_id).toBe('private-tab');
    expect(meta?.cleanup_blocked).toBe(true);
    expect(meta?.cleanup_reason).toBe('owner_disconnect_unconfirmed');
  });

  it('Security 失败 → 不注 cookie/不导航，existing cleanup 后 auto 降级 managed', async () => {
    const fake = fakeBrowser(undefined, 'Security.setIgnoreCertificateErrors', { disposeFails: false });
    vi.mocked(launchChromium).mockImplementation(async (_exe, userDataDir) => ({
      pid: 456, baseUrl: 'http://127.0.0.1:9333', userDataDir,
      child: { unref: () => {}, stderr: { removeAllListeners: () => {}, destroy: () => {} } } } as any));
    const result = await defaultBootstrap('sec-fail', 'sf.sock', 'pre', 'auto', 'auto');
    // Security 抛错 → resolveAndProbeAuth 未执行 → 无 Network.setCookies / probe Page.navigate
    expect(fake.calls.some((c) => c.method === 'Network.setCookies')).toBe(false);
    expect(fake.calls.some((c) => c.method === 'Page.navigate')).toBe(false);
    // existing cleanup：dispose + close owner
    expect(fake.calls).toContainEqual({ method: 'Target.disposeBrowserContext', params: { browserContextId: 'isolated-1' }, sessionId: undefined });
    expect(fake.close).toHaveBeenCalledOnce();
    // auto 降级 managed 成功
    expect(result.browserSource).toBe('managed');
    expect(vi.mocked(launchChromium)).toHaveBeenCalled();
    // existing context meta 已清（managed 接管，browser_source=managed）
    expect(readMeta('sec-fail')?.browser_source).toBe('managed');
    expect(readMeta('sec-fail')?.browser_context_id).toBeUndefined();
    fs.rmSync(result.browserUserDataDir!, { recursive: true, force: true });
  });

  it('injectAndProbeInSession（managed/profile 共用探测）不发送 Security 命令', async () => {
    // managed/profile 走 injectAndProbeAuthState/probeAuthState（不经 daemon existing 块），不应有 Security
    process.env.E2ET_AUTH_PROBE_URL = 'https://probe.example.test/';
    const sent: string[] = [];
    const listeners = new Map<string, (p: unknown) => void>();
    const fakeSession: CdpLowSession = {
      send: vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
        sent.push(method);
        if (method === 'Page.navigate' && params.url && params.url !== 'about:blank') {
          queueMicrotask(() => listeners.get('Page.loadEventFired')?.({}));
        }
        if (method === 'Runtime.evaluate') return { result: { value: 'https://probe.example.test/' } };
        return {};
      }),
      addEventListener: vi.fn((m: string, h: (p: unknown) => void) => { listeners.set(m, h); return () => { listeners.delete(m); }; }),
      onClose: vi.fn(),
      close: vi.fn(),
      waitClosed: vi.fn(async () => true),
      forceClose: vi.fn(),
    };
    await injectAndProbeInSession(fakeSession, 'sid', { cookies: [{ name: 'x', value: 'y', domain: '.example.invalid' }], origins: [] });
    expect(sent.some((m) => m.startsWith('Security.'))).toBe(false);
    expect(sent).toContain('Network.setCookies');
    expect(sent).toContain('Page.navigate');
  });

  it('并发两个 existing session 用不同 context/target/sessionId，stop A 后 B 仍可导航且不串', async () => {
    const fake1 = fakeBrowser(undefined, undefined, { ids: { contextId: 'ctx-a', targetId: 'tab-a', targetSessionId: 'sess-a' } });
    const fake2 = fakeBrowser(undefined, undefined, { ids: { contextId: 'ctx-b', targetId: 'tab-b', targetSessionId: 'sess-b' } });
    // 按 call 序路由：第一个 existing bootstrap → fake1，第二个 → fake2
    let ownerIdx = 0;
    vi.mocked(openCdpSession).mockImplementation(async () => {
      const o = ownerIdx === 0 ? fake1.owner : fake2.owner;
      ownerIdx++;
      return o;
    });
    (CdpSession.connect as unknown as vi.Mock).mockImplementation(async (tabId: string) =>
      (tabId === 'tab-a' ? fake1.tab : fake2.tab) as unknown as CdpSession);
    const idA = 'sec-conc-a', idB = 'sec-conc-b';
    const sockA = resolveSocketPath(idA), sockB = resolveSocketPath(idB);
    const doneA = runDaemon(idA, { env: 'pre', socketPath: sockA, authMode: 'imported', browserMode: 'existing', exitOnStop: false });
    try {
      const dlA = Date.now() + 5000;
      while (!(await DaemonClient.ping(sockA, 100)) && Date.now() < dlA) await new Promise((r) => setTimeout(r, 20));
      const doneB = runDaemon(idB, { env: 'pre', socketPath: sockB, authMode: 'imported', browserMode: 'existing', exitOnStop: false });
      try {
        const dlB = Date.now() + 5000;
        while (!(await DaemonClient.ping(sockB, 100)) && Date.now() < dlB) await new Promise((r) => setTimeout(r, 20));
        // 各自 Security 作用域不同（sess-a / sess-b），不串
        const sec1 = fake1.calls.find((c) => c.method === 'Security.setIgnoreCertificateErrors');
        const sec2 = fake2.calls.find((c) => c.method === 'Security.setIgnoreCertificateErrors');
        expect(sec1?.sessionId).toBe('sess-a');
        expect(sec2?.sessionId).toBe('sess-b');
        // 各自 CdpSession.connect 接到自己的 target
        expect(CdpSession.connect).toHaveBeenCalledWith('tab-a', endpoint);
        expect(CdpSession.connect).toHaveBeenCalledWith('tab-b', endpoint);
        // stop A
        const ca = await DaemonClient.connect(sockA);
        await ca.request('stop', {});
        ca.close();
        await doneA;
        // A 收尾关闭了 owner，B 不受影响
        expect(fake1.close).toHaveBeenCalledOnce();
        expect(fake2.close).not.toHaveBeenCalled();
        // 隔离断言：A cleanup 只 dispose 自己的 ctx-a，绝无 ctx-b（误 dispose 跨 context 会让测试红）
        const aDisposes = fake1.calls.filter((c) => c.method === 'Target.disposeBrowserContext');
        expect(aDisposes.length).toBeGreaterThan(0);
        expect(aDisposes.every((c) => c.params.browserContextId === 'ctx-a')).toBe(true);
        expect(aDisposes.some((c) => c.params.browserContextId === 'ctx-b')).toBe(false);
        // B owner 在 B 再次导航前未收到任何 dispose（A stop 不能误关 B 的 context/target）
        const bDisposesBefore = fake2.calls.filter((c) => c.method === 'Target.disposeBrowserContext');
        expect(bDisposesBefore.length).toBe(0);
        // 驱动 B 的 page.open → B 的 tab 收到 Page.navigate（B 仍可导航）
        const cb = await DaemonClient.connect(sockB);
        const res = await cb.request('page.open', { url: 'https://portal.example.invalid/', intent: 'B stop A 后导航' }, { requestTimeoutMs: 10000 });
        expect((res as any)?.page_changed !== undefined || res !== undefined).toBe(true);
        const bNav = fake2.tab.send.mock.calls.find((c: unknown[]) => c[0] === 'Page.navigate');
        expect(bNav).toBeDefined();
        // B 的 Security 仍在 sess-b（未被 A 的 stop 改动）
        expect(fake2.calls.find((c) => c.method === 'Security.setIgnoreCertificateErrors')?.sessionId).toBe('sess-b');
        await cb.request('stop', {});
        cb.close();
        await doneB;
      } finally {
        const c = await DaemonClient.connect(sockB).catch(() => null);
        await c?.request('stop', {}).catch(() => {});
        c?.close();
        await doneB.catch(() => {});
      }
    } finally {
      const c = await DaemonClient.connect(sockA).catch(() => null);
      await c?.request('stop', {}).catch(() => {});
      c?.close();
      await doneA.catch(() => {});
    }
  });

  it('existing 成功后 page.open 复用同一 target 的 CdpSession，Security 早于后续 Page.navigate', async () => {
    const fake = fakeBrowser();
    const id = 'sec-pageopen';
    const socket = resolveSocketPath(id);
    // 显式探测 URL：probe 在同一 target session 上导航（验证与 Security 同 target 的导航路径）
    process.env.E2ET_AUTH_PROBE_URL = 'https://portal.example.invalid/';
    const done = runDaemon(id, { env: 'pre', socketPath: socket, authMode: 'imported', browserMode: 'existing', exitOnStop: false });
    try {
      const deadline = Date.now() + 5000;
      while (!(await DaemonClient.ping(socket, 100)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      // CdpSession.connect 用 probe 的同一 target（private-tab）+ existing endpoint，不是默认页
      expect(CdpSession.connect).toHaveBeenCalledWith('private-tab', endpoint);
      // 驱动一次 page.open → 走同一个 CdpSession(tab) 的 Page.navigate（非静态字段比较）
      const client = await DaemonClient.connect(socket);
      await client.request('page.open', { url: 'https://portal.example.invalid/', intent: '证书修复后续导航' }, { requestTimeoutMs: 10000 });
      // tab 收到了 page.open 的 Page.navigate（后续导航复用同一 target session）
      const tabNavIdx = fake.tab.send.mock.calls.findIndex((c: unknown[]) => c[0] === 'Page.navigate');
      expect(tabNavIdx).toBeGreaterThanOrEqual(0);
      // Security（owner.send，target session 作用域）调用早于 page.open 的 Page.navigate（tab.send）
      const secCall = fake.calls.find((c) => c.method === 'Security.setIgnoreCertificateErrors');
      const secOrder = fake.owner.send.mock.invocationCallOrder[fake.calls.indexOf(secCall!)];
      const navOrder = fake.tab.send.mock.invocationCallOrder[tabNavIdx];
      expect(secOrder).toBeLessThan(navOrder);
      // probe 的 Page.navigate 也带同一 targetSessionId（Security 与后续导航同 target）
      const probeNav = fake.calls.find((c) => c.method === 'Page.navigate' && c.sessionId === 'private-session');
      expect(probeNav).toBeDefined();
      await client.request('stop', {});
      client.close();
      await done;
    } finally {
      const c = await DaemonClient.connect(socket).catch(() => null);
      await c?.request('stop', {}).catch(() => {});
      c?.close();
      await done.catch(() => {});
    }
  });

  it('强制 --browser existing + Security 失败：不注 cookie/不导航/不启动 managed/profile，context/meta 清理并 reject', async () => {
    const fake = fakeBrowser(undefined, 'Security.setIgnoreCertificateErrors');
    await expect(defaultBootstrap('sec-forced', 'sf2.sock', 'pre', 'imported', 'existing'))
      .rejects.toThrow('Security.setIgnoreCertificateErrors 失败');
    // Security 抛错在 resolveAndProbeAuth 之前 → 不注 cookie、不导航
    expect(fake.calls.some((c) => c.method === 'Network.setCookies')).toBe(false);
    expect(fake.calls.some((c) => c.method === 'Page.navigate')).toBe(false);
    // 强制 existing 不降级 managed/profile
    expect(vi.mocked(launchChromium)).not.toHaveBeenCalled();
    expect(vi.mocked(launchProfileAndProbe)).not.toHaveBeenCalled();
    // context 完整清理：dispose + close owner
    expect(fake.calls).toContainEqual({ method: 'Target.disposeBrowserContext', params: { browserContextId: 'isolated-1' }, sessionId: undefined });
    expect(fake.close).toHaveBeenCalledOnce();
    // meta 完整清理（browser_source/transport 保留 existing 标记，context/endpoint/tab 清空）
    const meta = readMeta('sec-forced');
    expect(meta?.browser_source).toBe('existing');
    expect(meta?.transport).toBe('native-cdp');
    expect(meta?.browser_context_id).toBeUndefined();
    expect(meta?.browser_endpoint).toBeUndefined();
    expect(meta?.tab_id).toBeUndefined();
  });
});
