import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { defaultBootstrap } from '../daemon/bootstrap.js';
import { readMeta, writeMeta } from '../daemon/session-meta.js';
import { importedAuthPath } from '../auth-resolve.js';

vi.mock('../browser/managed-browser.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../browser/managed-browser.js')>();
  return {
    ...actual,
    resolveSystemChrome: vi.fn(() => '/system/google-chrome'),
    resolveChromiumExecutable: vi.fn(() => '/playwright/chromium'),
    launchChromium: vi.fn(),
    injectAndProbeAuthState: vi.fn(async () => ({ landedOnLogin: false, finalUrl: 'https://portal.example.invalid/' })),
    killProcessGroup: vi.fn(async () => {}),
  };
});
vi.mock('../browser/profile-browser.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../browser/profile-browser.js')>();
  return { ...actual, launchProfileAndProbe: vi.fn() };
});
vi.mock('../browser/daemon-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../browser/daemon-client.js')>();
  return {
    ...actual,
    createTabIn: vi.fn(async () => ({ id: 'tab1' })),
    CdpSession: { connect: vi.fn(async () => ({ close: () => {} })) },
  };
});

const { resolveSystemChrome, resolveChromiumExecutable, launchChromium, killProcessGroup } = await import('../browser/managed-browser.js');
const { launchProfileAndProbe } = await import('../browser/profile-browser.js');

describe('daemon profile 启动与降级', () => {
  let home: string;
  let previous: Record<string, string | undefined>;
  let managedDir: string;
  const sessionId = 'profile-test';

  beforeEach(() => {
    previous = Object.fromEntries(['E2ET_HOME', 'E2ET_CDP_URL', 'E2ET_AUTH_STATE'].map((key) => [key, process.env[key]]));
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-profile-'));
    process.env.E2ET_HOME = home;
    delete process.env.E2ET_CDP_URL;
    delete process.env.E2ET_AUTH_STATE;
    const master = path.join(home, 'e2e-profile', 'Default');
    fs.mkdirSync(master, { recursive: true });
    fs.writeFileSync(path.join(master, 'Cookies'), 'encrypted');
    fs.writeFileSync(path.join(home, 'e2e-profile', 'Local State'), '{}');
    managedDir = '';
    vi.clearAllMocks();
    vi.mocked(resolveSystemChrome).mockReturnValue('/system/google-chrome');
    vi.mocked(resolveChromiumExecutable).mockReturnValue('/playwright/chromium');
    vi.mocked(launchChromium).mockImplementation(async (_exe, dir) => {
      managedDir = dir;
      return { pid: 22, baseUrl: 'http://127.0.0.1:9223', userDataDir: dir, child: { unref: () => {}, stderr: { removeAllListeners: () => {}, destroy: () => {} } } } as any;
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ Browser: 'fake' }) })));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (managedDir) fs.rmSync(managedDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  function failProfile(beforeClear?: (handle: { pid: number; baseUrl: string; userDataDir: string }) => void): { cleared: () => ReturnType<typeof readMeta>; profileDir: () => string } {
    let cleared: ReturnType<typeof readMeta> = null;
    let profileDir = '';
    vi.mocked(launchProfileAndProbe).mockImplementation(async (executable, _master, _sid, _env, onEarly, onClear) => {
      expect(executable).toBe('/system/google-chrome');
      profileDir = fs.mkdtempSync(path.join(os.tmpdir(), `e2et-${sessionId}-`));
      const handle = { pid: 11, baseUrl: 'http://127.0.0.1:9222', userDataDir: profileDir };
      onEarly?.(handle);
      expect(readMeta(sessionId)?.browser_pid).toBe(11);
      await killProcessGroup(handle.pid, 3000);
      fs.rmSync(profileDir, { recursive: true, force: true });
      beforeClear?.(handle);
      onClear?.(handle);
      cleared = readMeta(sessionId);
      return { result: { landedOnLogin: false, finalUrl: '', probeError: 'profile 探测失败' } };
    });
    return { cleared: () => cleared, profileDir: () => profileDir };
  }

  function writeImported(): void {
    const imported = importedAuthPath(process.env);
    fs.mkdirSync(path.dirname(imported), { recursive: true });
    const expires = Math.floor(Date.now() / 1000) + 3600;
    fs.writeFileSync(imported, JSON.stringify({ cookies: ['EXAMPLE_SESSION', 'X-XSRF-TOKEN'].map((name) => ({ name, value: 'fake', domain: '.example.invalid', path: '/', expires })), origins: [] }));
  }

  it('失败无 fallback：清掉三项 browser meta，归属及错误字段保留', async () => {
    writeMeta({ id: sessionId, pid: process.pid, socket: 'test.sock', env: 'pre', started_at: Date.now(), auth_source: 'profile', error: 'existing error' });
    const observed = failProfile();
    await expect(defaultBootstrap(sessionId, 'test.sock', 'pre', 'profile')).rejects.toThrow(/profile 探测失败/);
    expect(observed.cleared()).toMatchObject({ id: sessionId, socket: 'test.sock', env: 'pre', auth_source: 'profile', error: 'existing error' });
    expect(observed.cleared()).not.toHaveProperty('browser_pid');
    expect(observed.cleared()).not.toHaveProperty('browser_user_data_dir');
    expect(observed.cleared()).not.toHaveProperty('browser_endpoint');
    expect(fs.readdirSync(path.join(home, 'sessions')).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect(fs.existsSync(observed.profileDir())).toBe(false);
    expect(killProcessGroup).toHaveBeenCalledWith(11, 3000);
    expect(resolveChromiumExecutable).not.toHaveBeenCalled();
  });

  it('profile 系统 Chrome 失败后，managed 仍选 Playwright Chromium', async () => {
    writeImported();
    const observed = failProfile();
    const result = await defaultBootstrap(sessionId, 'test.sock', 'pre', 'auto');
    expect(result.authSource).toBe('imported');
    expect(observed.cleared()).not.toHaveProperty('browser_pid');
    expect(readMeta(sessionId)?.browser_pid).toBe(22);
    expect(readMeta(sessionId)?.browser_user_data_dir).toBe(managedDir);
    expect(fs.existsSync(observed.profileDir())).toBe(false);
    expect(launchChromium).toHaveBeenCalledWith('/playwright/chromium', managedDir);
  });

  it('系统 Chrome 缺失：显式 profile 报错，不拿 Chromium 顶', async () => {
    vi.mocked(resolveSystemChrome).mockReturnValue(null);
    await expect(defaultBootstrap(sessionId, 'test.sock', 'pre', 'profile')).rejects.toThrow(/找不到系统 Google Chrome/);
    expect(launchProfileAndProbe).not.toHaveBeenCalled();
    expect(resolveChromiumExecutable).not.toHaveBeenCalled();
  });

  it('系统 Chrome 缺失：auto 记录 profile 失败并降级 imported', async () => {
    writeImported();
    vi.mocked(resolveSystemChrome).mockReturnValue(null);
    const result = await defaultBootstrap(sessionId, 'test.sock', 'pre', 'auto');
    expect(result.authSource).toBe('imported');
    expect(launchProfileAndProbe).not.toHaveBeenCalled();
    expect(launchChromium).toHaveBeenCalledWith('/playwright/chromium', managedDir);
  });

  it('managed tab 连接失败时回收浏览器并清理 early meta', async () => {
    writeImported();
    const { CdpSession } = await import('../browser/daemon-client.js');
    vi.mocked(CdpSession.connect).mockRejectedValueOnce(new Error('page WS 失败'));
    await expect(defaultBootstrap(sessionId, 'test.sock', 'pre', 'imported', 'managed')).rejects.toThrow('page WS 失败');
    expect(killProcessGroup).toHaveBeenCalledWith(22, 3000);
    expect(readMeta(sessionId)?.browser_pid).toBeUndefined();
    expect(readMeta(sessionId)?.browser_user_data_dir).toBeUndefined();
    expect(readMeta(sessionId)?.browser_endpoint).toBeUndefined();
    expect(fs.existsSync(managedDir)).toBe(false);
  });

  it('旧 profile 的清理回调不误清已经切换的浏览器字段', async () => {
    const observed = failProfile((handle) => writeMeta({
      ...readMeta(sessionId)!, browser_pid: 22, browser_endpoint: 'http://127.0.0.1:9223',
      browser_user_data_dir: `${handle.userDataDir}-managed`,
    }));
    await expect(defaultBootstrap(sessionId, 'test.sock', 'pre', 'profile')).rejects.toThrow(/profile 探测失败/);
    expect(observed.cleared()?.browser_pid).toBe(22);
    expect(observed.cleared()?.browser_endpoint).toBe('http://127.0.0.1:9223');
  });
});
