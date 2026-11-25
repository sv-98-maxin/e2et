/** P4 replay-context 单测：来源/资源生命周期（无真实浏览器，chromium 全 mock；
 *  fs 的 cpSync/existsSync/mkdtempSync 用 vi.mock 包装以便注入失败）。
 *
 * 覆盖合同正反例：
 * - 本次选择来自参数/环境（任何启动前拒绝非法枚举/组合；provenance 不参与）
 * - E2ET_HOME 隔离（imported 用该根 auth/imported.json；显式 AUTH_STATE 唯一输入，
 *   missing/坏 JSON 直接失败不 fallback；空字符串拒绝）
 * - profile：母本字节不变、副本清理（含 cpSync 失败）、ignoreDefaultArgs 不带 mock-keychain、
 *   context.close 拒绝后仍用公开 browser() 句柄关自有 Chrome
 * - managed：newContext 拒绝仍关 browser；context.close 拒绝仍关 browser
 * - existing：仅显式 E2ET_CDP_URL；私有 context 关闭 + browser.close 仅断连（connect 句柄
 *   cleanup 模型，与 owned 物理关闭区分；真实共享浏览器 sentinel 存活属 tester 真机验收）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('@playwright/test', () => ({ chromium: { launch: vi.fn(), connectOverCDP: vi.fn(), launchPersistentContext: vi.fn() } }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, cpSync: vi.fn(actual.cpSync), existsSync: vi.fn(actual.existsSync), mkdtempSync: vi.fn(actual.mkdtempSync) };
});
const { chromium } = await import('@playwright/test');
import { withReplayContext } from '../replay-context.js';

const realFs = await vi.importActual<typeof fs>('node:fs');

let home: string;
let previousHome: string | undefined;
let previousState: string | undefined;
let previousCdp: string | undefined;
let previousChrome: string | undefined;
let previousBrowser: string | undefined;
let previousPuppeteer: string | undefined;
let previousHeadless: string | undefined;
let previousReplayAuth: string | undefined;
let previousReplayBrowser: string | undefined;
const managedProfileDirs: string[] = [];

beforeEach(() => {
  previousHome = process.env.E2ET_HOME;
  previousState = process.env.E2ET_AUTH_STATE;
  previousCdp = process.env.E2ET_CDP_URL;
  previousChrome = process.env.CHROME_EXECUTABLE_PATH;
  previousBrowser = process.env.BROWSER_EXECUTABLE_PATH;
  previousPuppeteer = process.env.PUPPETEER_EXECUTABLE_PATH;
  previousHeadless = process.env.HEADLESS;
  previousReplayAuth = process.env.E2ET_REPLAY_AUTH;
  previousReplayBrowser = process.env.E2ET_REPLAY_BROWSER;
  // 每次恢复真实实现（mockReset 清掉后重设，后续用例再按需注入失败）；
  // home 用 realFs 建，避免被 trackMkdtemp 的跟踪误计入 replay 副本
  vi.mocked(fs.cpSync).mockImplementation(realFs.cpSync);
  vi.mocked(fs.existsSync).mockImplementation(realFs.existsSync);
  vi.mocked(fs.mkdtempSync).mockImplementation(realFs.mkdtempSync);
  home = realFs.mkdtempSync(path.join(os.tmpdir(), 'replay-ctx-'));
  process.env.E2ET_HOME = home;
  delete process.env.E2ET_AUTH_STATE;
  delete process.env.E2ET_CDP_URL;
  delete process.env.HEADLESS;
  delete process.env.CHROME_EXECUTABLE_PATH;
  delete process.env.BROWSER_EXECUTABLE_PATH;
  delete process.env.PUPPETEER_EXECUTABLE_PATH;
  delete process.env.E2ET_REPLAY_AUTH;
  delete process.env.E2ET_REPLAY_BROWSER;
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.E2ET_HOME;
  else process.env.E2ET_HOME = previousHome;
  if (previousState === undefined) delete process.env.E2ET_AUTH_STATE;
  else process.env.E2ET_AUTH_STATE = previousState;
  if (previousCdp === undefined) delete process.env.E2ET_CDP_URL;
  else process.env.E2ET_CDP_URL = previousCdp;
  if (previousChrome === undefined) delete process.env.CHROME_EXECUTABLE_PATH;
  else process.env.CHROME_EXECUTABLE_PATH = previousChrome;
  if (previousBrowser === undefined) delete process.env.BROWSER_EXECUTABLE_PATH;
  else process.env.BROWSER_EXECUTABLE_PATH = previousBrowser;
  if (previousPuppeteer === undefined) delete process.env.PUPPETEER_EXECUTABLE_PATH;
  else process.env.PUPPETEER_EXECUTABLE_PATH = previousPuppeteer;
  if (previousHeadless === undefined) delete process.env.HEADLESS;
  else process.env.HEADLESS = previousHeadless;
  if (previousReplayAuth === undefined) delete process.env.E2ET_REPLAY_AUTH;
  else process.env.E2ET_REPLAY_AUTH = previousReplayAuth;
  if (previousReplayBrowser === undefined) delete process.env.E2ET_REPLAY_BROWSER;
  else process.env.E2ET_REPLAY_BROWSER = previousReplayBrowser;
  fs.rmSync(home, { recursive: true, force: true });
  vi.mocked(chromium.launch).mockReset();
  vi.mocked(chromium.connectOverCDP).mockReset();
  vi.mocked(chromium.launchPersistentContext).mockReset();
  vi.mocked(fs.cpSync).mockClear();
  vi.mocked(fs.existsSync).mockClear();
  vi.mocked(fs.mkdtempSync).mockClear();
  vi.unstubAllGlobals();
  for (const dir of managedProfileDirs.splice(0)) realFs.rmSync(dir, { recursive: true, force: true });
});

const STATE = { cookies: [], origins: [{ origin: 'https://example.test', localStorage: [{ name: 'k', value: 'v' }] }] };
const SYSTEM_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const importedPath = (): string => path.join(home, 'auth', 'imported.json');
function writeImported(state: unknown = STATE): void {
  fs.mkdirSync(path.dirname(importedPath()), { recursive: true });
  fs.writeFileSync(importedPath(), typeof state === 'string' ? state : JSON.stringify(state));
}

async function withPlatform(platform: NodeJS.Platform, run: () => Promise<void>): Promise<void> {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...descriptor, value: platform });
  try {
    await run();
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
  }
}

function fakeBrowser(opts: { newContextImpl?: () => Promise<any>; closeImpl?: () => Promise<void> } = {}) {
  const calls = { newContext: 0, contextClose: 0, browserClose: 0 };
  const browser = {
    newContext: vi.fn(async (options?: Record<string, unknown>) => {
      calls.newContext++;
      if (opts.newContextImpl) return opts.newContextImpl();
      return fakeContext(options);
    }),
    close: vi.fn(async () => {
      calls.browserClose++;
      opts.closeImpl?.();
    }),
  };
  addManagedDebugEndpoint(browser);
  const fakeContext = (options?: Record<string, unknown>) => ({
    storageState: options?.storageState,
    close: vi.fn(async () => { calls.contextClose++; }),
    browser: () => browser,
  });
  return { browser, calls, fakeContext };
}

function addManagedDebugEndpoint(browser: any): void {
  const dir = realFs.mkdtempSync(path.join(os.tmpdir(), 'managed-profile-'));
  managedProfileDirs.push(dir);
  realFs.writeFileSync(path.join(dir, 'DevToolsActivePort'), '9222\n/devtools/browser/context-test');
  browser.newBrowserCDPSession = vi.fn(async () => ({
    send: vi.fn(async () => ({ arguments: [`--user-data-dir=${dir}`] })),
    detach: vi.fn(async () => {}),
  }));
}

describe('withReplayContext 本次选择校验（启动前拒绝）', () => {
  it.each([
    ['chrome+imported', { auth: 'imported', browser: 'chrome' }],
    ['managed+profile', { auth: 'profile', browser: 'managed' }],
    ['existing+profile', { auth: 'profile', browser: 'existing' }],
    ['bad-auth-enum', { auth: 'mock', browser: 'managed' }],
    ['bad-browser-enum', { auth: 'imported', browser: 'unknown' }],
  ])('%s → 拒绝且不启动浏览器', async (_name, input) => {
    await expect(withReplayContext(async () => {}, input)).rejects.toThrow(/不能配|只能配|枚举不合法/);
    expect(chromium.launch).not.toHaveBeenCalled();
    expect(chromium.connectOverCDP).not.toHaveBeenCalled();
    expect(chromium.launchPersistentContext).not.toHaveBeenCalled();
  });

  it('非法本次输入在 CDP 探测前拒绝', async () => {
    process.env.E2ET_REPLAY_AUTH = '';
    process.env.E2ET_CDP_URL = 'http://127.0.0.1:1';
    const fetchProbe = vi.fn(async () => { throw new Error('must not probe'); });
    vi.stubGlobal('fetch', fetchProbe);
    await expect(withReplayContext(async () => {})).rejects.toThrow(/auth 枚举不合法/);
    expect(fetchProbe).not.toHaveBeenCalled();
  });
});

describe('managed/imported 状态解析（E2ET_HOME 隔离 + 显式 AUTH_STATE 唯一输入）', () => {
  it('imported 读该根 auth/imported.json，注入解析后的 state 对象（不是路径）', async () => {
    writeImported();
    const { browser, calls } = fakeBrowser();
    vi.mocked(chromium.launch).mockResolvedValue(browser as any);
    let run = 0;
    await withReplayContext(async (_context, cdpEndpoint, environment) => {
      run++;
      expect(cdpEndpoint).toBe('ws://127.0.0.1:9222/devtools/browser/context-test');
      expect(environment).toEqual({ auth_source: 'imported', browser_source: 'managed' });
    }, { auth: 'imported', browser: 'managed' });
    expect(run).toBe(1);
    expect(calls.newContext).toBe(1);
    expect(chromium.launch).toHaveBeenCalledOnce();
    const options = vi.mocked(chromium.launch).mock.calls[0]![0] as Record<string, unknown> | undefined;
    expect((options as { headless?: boolean } | undefined)?.headless).toBe(true);
    expect((options as { args?: string[] } | undefined)?.args).toEqual([
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0',
      '--enable-automation',
    ]);
    const ctxOptions = (browser.newContext as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { storageState?: unknown };
    expect(ctxOptions.storageState).toEqual(STATE);
    expect(calls.contextClose).toBe(1);
    expect(calls.browserClose).toBe(1);
  });

  it('空 e2e-profile 目录不算 profile 可用；auto 选 imported+managed', async () => {
    writeImported();
    fs.mkdirSync(path.join(home, 'e2e-profile'));
    const { browser, calls } = fakeBrowser();
    vi.mocked(chromium.launch).mockResolvedValue(browser as any);
    await withReplayContext(async (_context, _cdpEndpoint, environment) => {
      expect(environment).toEqual({ auth_source: 'imported', browser_source: 'managed' });
    }, { auth: 'auto', browser: 'auto' });
    expect(chromium.launch).toHaveBeenCalledOnce();
    expect(chromium.launchPersistentContext).not.toHaveBeenCalled();
    expect(calls.newContext).toBe(1);
  });

  it('symlink profile 母本不算可用；auto 选 imported+managed', async () => {
    writeImported();
    const target = path.join(home, 'real-profile');
    fs.mkdirSync(path.join(target, 'Default'), { recursive: true });
    fs.symlinkSync(target, path.join(home, 'e2e-profile'), 'dir');
    const { browser } = fakeBrowser();
    vi.mocked(chromium.launch).mockResolvedValue(browser as any);
    await withReplayContext(async (_context, _cdpEndpoint, environment) => {
      expect(environment).toEqual({ auth_source: 'imported', browser_source: 'managed' });
    }, { auth: 'auto', browser: 'auto' });
    expect(chromium.launch).toHaveBeenCalledOnce();
    expect(chromium.launchPersistentContext).not.toHaveBeenCalled();
  });

  it('显式 profile 遇空 e2e-profile 目录在复制前拒绝', async () => {
    fs.mkdirSync(path.join(home, 'e2e-profile'));
    await expect(withReplayContext(async () => {}, { auth: 'profile', browser: 'chrome' }))
      .rejects.toThrow('profile 母本不存在');
    expect(chromium.launchPersistentContext).not.toHaveBeenCalled();
  });

  it('配置的 existing CDP 不可达时 auto 不把地址配置当可用，降级 imported+managed', async () => {
    writeImported();
    process.env.E2ET_CDP_URL = 'http://127.0.0.1:1';
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connection refused'); }));
    const { browser } = fakeBrowser();
    vi.mocked(chromium.launch).mockResolvedValue(browser as any);
    await withReplayContext(async (_context, _cdpEndpoint, environment) => {
      expect(environment).toEqual({ auth_source: 'imported', browser_source: 'managed' });
    }, { auth: 'imported', browser: 'auto' });
    expect(chromium.connectOverCDP).not.toHaveBeenCalled();
    expect(chromium.launch).toHaveBeenCalledOnce();
  });

  it('macOS 无显式 env → managed 保持 Playwright 默认 Chromium', async () => {
    writeImported();
    const { browser } = fakeBrowser();
    vi.mocked(chromium.launch).mockResolvedValue(browser as any);
    vi.mocked(fs.existsSync).mockImplementation((candidate) => String(candidate) === SYSTEM_CHROME);
    await withPlatform('darwin', async () => {
      await withReplayContext(async () => {}, { auth: 'imported', browser: 'managed' });
    });
    const options = vi.mocked(chromium.launch).mock.calls[0]![0] as Record<string, unknown>;
    expect(options.executablePath).toBeUndefined();
  });

  it('macOS 显式 BROWSER_EXECUTABLE_PATH 覆盖 Playwright 默认', async () => {
    writeImported();
    const override = path.join(home, 'override-chrome');
    fs.writeFileSync(override, '');
    process.env.BROWSER_EXECUTABLE_PATH = override;
    const { browser } = fakeBrowser();
    vi.mocked(chromium.launch).mockResolvedValue(browser as any);
    vi.mocked(fs.existsSync).mockImplementation((candidate) => [SYSTEM_CHROME, override].includes(String(candidate)));
    await withPlatform('darwin', async () => {
      await withReplayContext(async () => {}, { auth: 'imported', browser: 'managed' });
    });
    const options = vi.mocked(chromium.launch).mock.calls[0]![0] as Record<string, unknown>;
    expect(options.executablePath).toBe(override);
  });

  it('缺 state 文件 → 失败不 fallback（不悄悄匿名）', async () => {
    await expect(withReplayContext(async () => {}, { auth: 'imported', browser: 'managed' })).rejects.toThrow(/读取失败/);
    expect(chromium.launch).not.toHaveBeenCalled();
  });

  it('坏 JSON → 固定安全文案失败（不拼解析原文），不启动', async () => {
    writeImported('{bad json');
    await expect(withReplayContext(async () => {}, { auth: 'imported', browser: 'managed' })).rejects.toThrow('不是合法 JSON（内容不回显）');
    expect(chromium.launch).not.toHaveBeenCalled();
  });

  it('非空显式 E2ET_AUTH_STATE 是唯一输入：只读该路径，缺失直接失败不找其它身份', async () => {
    writeImported(); // 该根有合法 imported.json，但显式路径缺失时不得回退使用
    const explicit = path.join(home, 'explicit-state.json');
    process.env.E2ET_AUTH_STATE = explicit;
    await expect(withReplayContext(async () => {}, { auth: 'imported', browser: 'managed' })).rejects.toThrow(/读取失败/);
    expect(chromium.launch).not.toHaveBeenCalled();
  });

  it('显式 E2ET_AUTH_STATE 空字符串 → 拒绝（空值不是合法输入，不回退默认）', async () => {
    writeImported();
    process.env.E2ET_AUTH_STATE = '   ';
    await expect(withReplayContext(async () => {}, { auth: 'imported', browser: 'managed' })).rejects.toThrow('空字符串');
    expect(chromium.launch).not.toHaveBeenCalled();
  });

  it('缺 cookies 数组（匿名补 [] 不允许）与非空未支持状态字段 → 拒绝', async () => {
    writeImported({ origins: [] });
    await expect(withReplayContext(async () => {}, { auth: 'imported', browser: 'managed' })).rejects.toThrow('缺 cookies 数组');
    writeImported({ cookies: [], origins: [], credentials: [{ id: 'x' }] });
    await expect(withReplayContext(async () => {}, { auth: 'imported', browser: 'managed' })).rejects.toThrow('未支持的非空状态字段');
    expect(chromium.launch).not.toHaveBeenCalled();
  });

  it('newContext 拒绝（含敏感原文）→ 固定安全文案 + 仍关 owned browser', async () => {
    writeImported();
    const secret = 'Bearer controlled-secret-123456789';
    const { browser, calls } = fakeBrowser({ newContextImpl: async () => { throw new Error(secret); } });
    vi.mocked(chromium.launch).mockResolvedValue(browser as any);
    let error: unknown;
    try {
      await withReplayContext(async () => {}, { auth: 'imported', browser: 'managed' });
    } catch (e) { error = e; }
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain('controlled-secret');
    expect(calls.browserClose).toBe(1);
  });

  it('context.close 拒绝 → 仍关自有 browser（前一个 cleanup 不阻止后一个）', async () => {
    writeImported();
    const calls = { contextClose: 0, browserClose: 0 };
    const browser = {
      newContext: vi.fn(async () => ({
        close: vi.fn(async () => { calls.contextClose++; throw new Error('context close boom'); }),
        browser: () => browser,
      })),
      close: vi.fn(async () => { calls.browserClose++; }),
    };
    addManagedDebugEndpoint(browser);
    vi.mocked(chromium.launch).mockResolvedValue(browser as any);
    let run = 0;
    await withReplayContext(async () => { run++; }, { auth: 'imported', browser: 'managed' });
    expect(run).toBe(1);
    expect(calls.contextClose).toBe(1);
    expect(calls.browserClose).toBe(1);
  });
});

describe('existing 显式 CDP 来源（断连≠物理关闭）', () => {
  it('无 E2ET_CDP_URL → 拒绝（不发现共享登录态）', async () => {
    writeImported();
    await expect(withReplayContext(async () => {}, { auth: 'imported', browser: 'existing' })).rejects.toThrow('需要显式 E2ET_CDP_URL');
    expect(chromium.connectOverCDP).not.toHaveBeenCalled();
  });

  it('私有 context 关闭后 browser.close 仅断连（connect 句柄 cleanup 模型，与 owned 物理关闭区分）', async () => {
    // 本测试只建模 connectOverCDP 公共句柄的 cleanup 合同：私有 context 先关、句柄 close 只断连。
    // 真实共享浏览器 sentinel 存活属 tester 真机验收（协议模型不冒充）。
    writeImported();
    process.env.E2ET_CDP_URL = 'http://127.0.0.1:12345';
    const calls = { contextClose: 0, disconnect: 0 };
    const browser = {
      newContext: vi.fn(async () => ({
        close: vi.fn(async () => { calls.contextClose++; }),
        browser: () => browser,
      })),
      close: vi.fn(async () => {
        // connectOverCDP 句柄 close 只断连 transport（Playwright browserProcess.close/kill 只调
        // transport.closeAndWait），模型中不携带任何杀进程语义
        calls.disconnect++;
      }),
    };
    vi.mocked(chromium.connectOverCDP).mockResolvedValue(browser as any);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      webSocketDebuggerUrl: 'ws://127.0.0.1:12345/devtools/browser/existing',
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    let run = 0;
    await withReplayContext(async (context, cdpEndpoint, environment) => {
      run++;
      expect(context).toBeTruthy();
      expect(cdpEndpoint).toBe('ws://127.0.0.1:12345/devtools/browser/existing');
      expect(environment).toEqual({ auth_source: 'imported', browser_source: 'existing' });
    }, { auth: 'imported', browser: 'existing' });
    expect(run).toBe(1);
    expect(calls.contextClose).toBe(1);
    expect(calls.disconnect).toBe(1);
  });

  it('newContext 拒绝 → 仍断连（不断连会让连接句柄泄漏）', async () => {
    writeImported();
    process.env.E2ET_CDP_URL = 'http://127.0.0.1:12345';
    const calls = { disconnect: 0 };
    const browser = {
      newContext: vi.fn(async () => { throw new Error('storage state rejected'); }),
      close: vi.fn(async () => { calls.disconnect++; }),
    };
    vi.mocked(chromium.connectOverCDP).mockResolvedValue(browser as any);
    await expect(withReplayContext(async () => {}, { auth: 'imported', browser: 'existing' })).rejects.toThrow();
    expect(calls.disconnect).toBe(1);
  });
});
describe('chrome-profile 母本副本生命周期', () => {
  const masterDir = (): string => path.join(home, 'e2e-profile');
  function buildMaster(): { masterDir: string; masterHash: string } {
    const dir = masterDir();
    fs.mkdirSync(path.join(dir, 'Default'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'Default', 'Cookies'), 'owned-cookie-model');
    fs.writeFileSync(path.join(dir, 'fixture'), 'owned-mother');
    fs.writeFileSync(path.join(dir, 'SingletonLock'), 'lock');
    fs.writeFileSync(path.join(dir, 'DevToolsActivePort'), 'old\n/devtools/browser/stale');
    fs.mkdirSync(path.join(dir, 'Cache'));
    fs.writeFileSync(path.join(dir, 'Cache', 'junk'), 'junk');
    return { masterDir: dir, masterHash: hashDir(dir) };
  }
  /** 深层递归内容 hash：覆盖嵌套文件字节（Default/Cookies 等），不是浅层目录列表 */
  function hashDir(dir: string): string {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    return entries.map((e) => e.isDirectory()
      ? `${e.name}/d:{${hashDir(path.join(dir, e.name))}}`
      : `${e.name}:${realFs.readFileSync(path.join(dir, e.name)).toString()}`).join('|');
  }
  /** mkdtemp 跟踪：真实建临时目录并记录路径（验证结束后删除） */
  function trackMkdtemp(): string[] {
    const dirs: string[] = [];
    vi.mocked(fs.mkdtempSync).mockImplementation(((prefix: string) => {
      const d = realFs.mkdtempSync(prefix);
      dirs.push(d);
      return d;
    }) as unknown as typeof fs.mkdtempSync);
    return dirs;
  }

  it('母本字节不变；副本复制跳过缓存目录与 Singleton*；结束后临时副本删除', async () => {
    const { masterDir: dir, masterHash } = buildMaster();
    process.env.CHROME_EXECUTABLE_PATH = '/usr/bin/true';
    const tmpDirs = trackMkdtemp();
    const calls = { persistent: 0, contextClose: 0, ownedBrowserClose: 0 };
    const browser = { close: vi.fn(async () => { calls.ownedBrowserClose++; }) };
    vi.mocked(chromium.launchPersistentContext).mockImplementation((async (copyDir: string, options?: Record<string, unknown>) => {
      calls.persistent++;
      // 副本里不应有 Cache/ 与 Singleton*；Default/Cookies 已复制（母本 cookie 模型）
      expect(fs.existsSync(path.join(copyDir, 'Cache'))).toBe(false);
      expect(fs.existsSync(path.join(copyDir, 'SingletonLock'))).toBe(false);
      expect(fs.existsSync(path.join(copyDir, 'DevToolsActivePort'))).toBe(false);
      expect(fs.readFileSync(path.join(copyDir, 'Default', 'Cookies'), 'utf8')).toBe('owned-cookie-model');
      expect((options as { ignoreDefaultArgs?: string[] } | undefined)?.ignoreDefaultArgs).toEqual(['--use-mock-keychain']);
      expect((options as { args?: string[] } | undefined)?.args).toEqual([
        '--remote-debugging-address=127.0.0.1',
        '--remote-debugging-port=0',
      ]);
      fs.writeFileSync(path.join(copyDir, 'DevToolsActivePort'), '9333\n/devtools/browser/profile-test');
      return {
        close: vi.fn(async () => { calls.contextClose++; }),
        browser: () => browser,
      } as any;
    }) as any);
    let run = 0;
    await withReplayContext(async (_context, cdpEndpoint, environment) => {
      run++;
      expect(cdpEndpoint).toBe('ws://127.0.0.1:9333/devtools/browser/profile-test');
      expect(environment).toEqual({ auth_source: 'profile', browser_source: 'chrome-profile' });
    }, { auth: 'profile', browser: 'chrome' });
    expect(run).toBe(1);
    expect(calls.persistent).toBe(1);
    expect(calls.contextClose).toBe(1);
    expect(calls.ownedBrowserClose).toBe(1);
    // 母本不变
    expect(hashDir(dir)).toBe(masterHash);
    expect(fs.readdirSync(masterDir()).includes('Cache')).toBe(true);
    // 副本已删除
    for (const d of tmpDirs) expect(fs.existsSync(d)).toBe(false);
  });

  it('cpSync 失败 → 副本回收、母本不变、固定安全文案（不透传底层原文）', async () => {
    const { masterDir: dir, masterHash } = buildMaster();
    process.env.CHROME_EXECUTABLE_PATH = '/usr/bin/true';
    const secret = 'Bearer copy-secret-123456789';
    const tmpDirs = trackMkdtemp();
    vi.mocked(fs.cpSync).mockImplementation((() => { throw new Error(secret); }) as typeof fs.cpSync);
    let error: unknown;
    try {
      await withReplayContext(async () => {}, { auth: 'profile', browser: 'chrome' });
    } catch (e) { error = e; }
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain('copy-secret');
    expect(chromium.launchPersistentContext).not.toHaveBeenCalled();
    expect(hashDir(dir)).toBe(masterHash);
    for (const d of tmpDirs) expect(fs.existsSync(d)).toBe(false);
  });

  it('合法 current 指针指向 e2etRoot/e2e-profiles 直接子目录时优先使用版本目录', async () => {
    const { masterDir: legacy, masterHash } = buildMaster();
    const version = path.join(home, 'e2e-profiles', 'profile-current');
    fs.mkdirSync(path.join(version, 'Default'), { recursive: true });
    fs.writeFileSync(path.join(version, 'Local State'), '{}');
    fs.writeFileSync(path.join(version, 'Default', 'source-marker'), 'current-version');
    fs.writeFileSync(path.join(home, 'e2e-profile-current'), `${version}\n`);
    process.env.CHROME_EXECUTABLE_PATH = '/usr/bin/true';
    const tmpDirs = trackMkdtemp();
    vi.mocked(chromium.launchPersistentContext).mockImplementation((async (copyDir: string) => {
      expect(fs.readFileSync(path.join(copyDir, 'Default', 'source-marker'), 'utf8')).toBe('current-version');
      fs.writeFileSync(path.join(copyDir, 'DevToolsActivePort'), '9333\n/devtools/browser/pointer');
      return { close: vi.fn(async () => {}), browser: () => ({ close: vi.fn(async () => {}) }) } as any;
    }) as any);
    await withReplayContext(async () => {}, { auth: 'profile', browser: 'chrome' });
    expect(hashDir(legacy)).toBe(masterHash);
    for (const d of tmpDirs) expect(fs.existsSync(d)).toBe(false);
  });

  it('pointer 损坏或目标被删时回退 legacy e2e-profile', async () => {
    const { masterDir: legacy } = buildMaster();
    const version = path.join(home, 'e2e-profiles', 'profile-deleted');
    fs.mkdirSync(path.join(version, 'Default'), { recursive: true });
    fs.writeFileSync(path.join(version, 'Local State'), '{}');
    fs.writeFileSync(path.join(home, 'e2e-profile-current'), `${version}\n`);
    fs.rmSync(version, { recursive: true, force: true });
    process.env.CHROME_EXECUTABLE_PATH = '/usr/bin/true';
    trackMkdtemp();
    vi.mocked(chromium.launchPersistentContext).mockImplementation((async (copyDir: string) => {
      expect(fs.readFileSync(path.join(copyDir, 'Default', 'Cookies'), 'utf8')).toBe('owned-cookie-model');
      fs.writeFileSync(path.join(copyDir, 'DevToolsActivePort'), '9444\n/devtools/browser/legacy');
      return { close: vi.fn(async () => {}), browser: () => ({ close: vi.fn(async () => {}) }) } as any;
    }) as any);
    await withReplayContext(async () => {}, { auth: 'profile', browser: 'chrome' });
    expect(fs.existsSync(path.join(legacy, 'Default', 'Cookies'))).toBe(true);

    fs.writeFileSync(path.join(home, 'e2e-profile-current'), 'relative/invalid\n');
    await withReplayContext(async () => {}, { auth: 'profile', browser: 'chrome' });
    expect(chromium.launchPersistentContext).toHaveBeenCalledTimes(2);
  });

  it('context.close 拒绝 → 公开 browser() 句柄仍关自有 Chrome，副本删除、母本不动', async () => {
    const { masterDir: dir, masterHash } = buildMaster();
    process.env.CHROME_EXECUTABLE_PATH = '/usr/bin/true';
    const tmpDirs = trackMkdtemp();
    const calls = { ownedBrowserClose: 0 };
    const browser = { close: vi.fn(async () => { calls.ownedBrowserClose++; }) };
    vi.mocked(chromium.launchPersistentContext).mockImplementation((async (copyDir: string) => {
      fs.writeFileSync(path.join(copyDir, 'DevToolsActivePort'), '9444\n/devtools/browser/profile-close-test');
      return {
        close: vi.fn(async () => { throw new Error('persistent context close boom'); }),
        browser: () => browser,
      } as any;
    }) as any);
    let run = 0;
    await withReplayContext(async () => { run++; }, { auth: 'profile', browser: 'chrome' });
    expect(run).toBe(1);
    expect(calls.ownedBrowserClose).toBe(1);
    expect(hashDir(dir)).toBe(masterHash);
    for (const d of tmpDirs) expect(fs.existsSync(d)).toBe(false);
  });

  it('同次显式 profile + --auth-state 冲突 → 拒绝（不悄悄换账号）', async () => {
    buildMaster();
    process.env.CHROME_EXECUTABLE_PATH = '/usr/bin/true';
    await expect(withReplayContext(async () => {}, {
      auth: 'profile',
      browser: 'chrome',
      authState: path.join(home, 'some-state.json'),
    })).rejects.toThrow('混用');
    expect(chromium.launchPersistentContext).not.toHaveBeenCalled();
  });

  it('找不到系统 Chrome → 拒绝，不回退 Playwright Chromium', async () => {
    buildMaster();
    process.env.CHROME_EXECUTABLE_PATH = '/nonexistent/chrome';
    vi.mocked(fs.existsSync).mockReturnValue(false);
    try {
      await expect(withReplayContext(async () => {}, { auth: 'profile', browser: 'chrome' })).rejects.toThrow('找不到系统 Google Chrome');
      expect(chromium.launchPersistentContext).not.toHaveBeenCalled();
    } finally {
      vi.mocked(fs.existsSync).mockReset();
    }
  });
});
