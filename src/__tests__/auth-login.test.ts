/**
 * B3: auth login 用假 CDP + 假 launchChromium + fake timers 覆盖：
 * 到达调用方 URL（origin+pathname）/ 60s 后 stderr 提示 / 5 分钟超时抛错 / 失败回收进程。
 * 新语义：目标 URL 由调用方显式提供（--url），完成 URL 条件不保证业务已登录。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { authLogin, AuthLoginError, launchProfileAndProbe } from '../browser/profile-browser.js';

vi.mock('../browser/managed-browser.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../browser/managed-browser.js')>();
  return {
    ...actual,
    launchChromium: vi.fn(),
    killProcessGroup: vi.fn(async () => {}),
    openCdpSession: vi.fn(),
    attachToPage: vi.fn(async () => 's1'),
    probeAuthState: vi.fn(),
  };
});

const { launchChromium, killProcessGroup, openCdpSession, probeAuthState } = await import('../browser/managed-browser.js');

let home: string;
let savedProbeUrl: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-login-'));
  savedProbeUrl = process.env.E2ET_AUTH_PROBE_URL;
});
afterEach(() => {
  vi.useRealTimers();
  if (savedProbeUrl === undefined) delete process.env.E2ET_AUTH_PROBE_URL;
  else process.env.E2ET_AUTH_PROBE_URL = savedProbeUrl;
  fs.rmSync(home, { recursive: true, force: true });
});

/** 假 CDP：按 urlSequence 依次返回最终 URL；记录 Browser.close 调用。 */
function startFakeCdp(opts: {
  urlSequence: string[];        // 每次 Runtime.evaluate 返回的 URL（循环到末尾停）
  onClose?: () => void;         // 收到 Browser.close 时触发（让 child exit）
}): { baseUrl: string; methods: string[]; navigated: string[]; evaluated: () => number; closeCount: () => number } {
  const methods: string[] = [];
  const navigated: string[] = [];
  let closeCount = 0;
  let evalCount = 0;
  vi.mocked(openCdpSession).mockResolvedValueOnce({
    send: async (method: string, params?: { url?: string }) => {
      methods.push(method);
      if (method === 'Page.navigate') navigated.push(params?.url ?? '');
      if (method === 'Runtime.evaluate') {
        return { result: { value: opts.urlSequence[Math.min(evalCount++, opts.urlSequence.length - 1)] } };
      }
      if (method === 'Browser.close') {
        closeCount++;
        opts.onClose?.();
      }
      return {};
    },
    close: () => {},
  } as any);
  return { baseUrl: 'http://127.0.0.1:0', methods, navigated, evaluated: () => evalCount, closeCount: () => closeCount };
}

/** 假 child：EventEmitter，exitCode/signalCode 可控，可 emit exit。 */
function fakeChild(): { child: any; emitExit: () => void } {
  const ee = new EventEmitter();
  (ee as any).exitCode = null;
  (ee as any).signalCode = null;
  (ee as any).stderr = { removeAllListeners: () => {}, destroy: () => {} };
  (ee as any).unref = () => {};
  (ee as any).kill = () => {};
  return { child: ee, emitExit: () => { (ee as any).exitCode = 0; ee.emit('exit', 0, null); } };
}

describe('auth login（假 CDP + 生产阈值 fake timers）', () => {
  const TARGET = 'https://app.example.test/home';

  async function startPolling(cdp: { navigated: string[] }): Promise<void> {
    for (let attempt = 0; attempt < 20 && vi.getTimerCount() === 0; attempt++) {
      await Promise.resolve();
    }
    expect(cdp.navigated).toContain(TARGET);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
  }

  it('导航调用方 --url（与 probe URL 无关）；完整中间页链路不提前关闭', async () => {
    let childRef: { emitExit: () => void } | null = null;
    const cdp = startFakeCdp({
      urlSequence: [
        'https://login.example.test/preLogin2.htm',
        'https://mid.example.test/buc',
        'https://app.example.test/home?ticket=SECRET',
      ],
      onClose: () => childRef?.emitExit(),
    });
    // probe URL 与 login 无关（login 只认 --url）：设成另一个域验证不干扰
    process.env.E2ET_AUTH_PROBE_URL = 'https://login.example.test/preLogin2.htm';
    const fc = fakeChild();
    childRef = fc;
    vi.mocked(launchChromium).mockResolvedValueOnce({ pid: 12345, port: 0, baseUrl: cdp.baseUrl, userDataDir: home, child: fc.child } as any);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const pending = authLogin('/fake/chrome', home, { url: TARGET });
    await startPolling(cdp);
    await vi.advanceTimersByTimeAsync(1000);
    expect(cdp.evaluated()).toBe(1);
    expect(cdp.closeCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(cdp.evaluated()).toBe(2);
    expect(cdp.closeCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    const r = await pending;
    // query 不影响 origin+pathname 判定；finalUrl 输出已 stripQuery
    expect(r.finalUrl).toBe('https://app.example.test/home');
    expect(cdp.closeCount()).toBe(1);
    expect(cdp.methods).toContain('Browser.close');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('60s 提示一次；5 分钟超时 URL 去 query 且回收进程', async () => {
    const cdp = startFakeCdp({ urlSequence: ['https://login.example.test/preLogin2.htm?ticket=SECRET'] });
    const fc = fakeChild();
    vi.mocked(launchChromium).mockResolvedValueOnce({ pid: 1, port: 0, baseUrl: cdp.baseUrl, userDataDir: home, child: fc.child } as any);
    const onStatus = vi.fn();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const pending = authLogin('/fake/chrome', home, { url: TARGET, onStatus });
    const outcome = pending.then(() => null, (error: Error) => error);
    await startPolling(cdp);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onStatus).toHaveBeenCalledOnce();
    expect(onStatus).toHaveBeenCalledWith('请在弹出的浏览器窗口里完成登录');
    expect(cdp.closeCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(240_000);
    const error = await outcome;
    expect(error?.message).toMatch(/登录未在 300s 内到达 https:\/\/app\.example\.test\/home（最终 URL: https:\/\/login\.example\.test\/preLogin2\.htm）/);
    expect(error).toMatchObject({ name: 'AuthLoginError', code: 'AUTH_FAILED' });
    expect(vi.mocked(killProcessGroup)).toHaveBeenCalledWith(1, 3000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('Chrome 启动失败分类为 ENV_UNAVAILABLE', async () => {
    vi.mocked(launchChromium).mockRejectedValueOnce(new Error('spawn EPERM'));
    await expect(authLogin('/fake/chrome', home, { url: TARGET })).rejects.toMatchObject({
      name: 'AuthLoginError',
      code: 'ENV_UNAVAILABLE',
    });
  });
});

describe('profile 副本探测失败清理', () => {
  it('杀进程、删副本后立即触发 early meta 清理', async () => {
    const master = path.join(home, 'master');
    fs.mkdirSync(path.join(master, 'Default'), { recursive: true });
    fs.writeFileSync(path.join(master, 'Default', 'Cookies'), 'encrypted');
    vi.mocked(launchChromium).mockImplementationOnce(async (_executable, dir) => ({
      pid: 12, baseUrl: 'http://127.0.0.1:9222', userDataDir: dir, child: fakeChild().child,
    } as any));
    vi.mocked(openCdpSession).mockResolvedValueOnce({ close: () => {} } as any);
    vi.mocked(probeAuthState).mockResolvedValueOnce({ finalUrl: '', probeError: '探测失败: 导航错误' });
    let copyDir = '';
    const cleared = vi.fn((handle: { pid: number; userDataDir: string }) => {
      expect(handle.pid).toBe(12);
      expect(handle.userDataDir).toBe(copyDir);
      expect(killProcessGroup).toHaveBeenCalledWith(12, 3000);
      expect(fs.existsSync(copyDir)).toBe(false);
    });
    const result = await launchProfileAndProbe('/fake/chrome', master, 'profile-test', { E2ET_HOME: home },
      (handle) => { copyDir = handle.userDataDir; expect(fs.existsSync(copyDir)).toBe(true); }, cleared);
    expect(result.handle).toBeUndefined();
    expect(result.result.probeError).toContain('探测失败');
    expect(cleared).toHaveBeenCalledOnce();
  });
});
