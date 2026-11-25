/**
 * 回放上下文：按本次执行参数或环境输入启动浏览器 context。
 *
 * IR provenance 只记录录制历史事实，不参与本次来源选择：
 * - e2et 根尊重 E2ET_HOME，否则 ~/.e2et（与 CLI e2etRoot 同语义的独立实现，不跨包 import）
 * - imported 优先使用显式 E2ET_AUTH_STATE，否则该根 auth/imported.json
 *   （非空取该路径；空值直接拒绝，不回退默认，不找其它身份），缺失/坏 JSON 直接失败
 * - state 文件只读取一次，按 CLI 相同受支持合同校验（cookies 必须数组；origins 规范化
 *   http(s) origin + localStorage 键值；未知非空顶层/嵌套存储拒绝）后交 Playwright 标准
 *   storageState 注入校验（不把路径再传给另一段逻辑重新选择）；JSON/注入错误用固定安全
 *   文案，不拼 cookie/token/JSON 解析原文；显式空标准 state 合法（≠没有来源）
 * - chrome/profile：仅系统 Chrome + profile 母本副本（优先合法
 *   e2etRoot/e2e-profile-current 指针，否则回退 legacy e2etRoot/e2e-profile），
 *   launchPersistentContext + ignoreDefaultArgs ['--use-mock-keychain']（钥匙串 cookie），
 *   不注入 imported/ci；显式 state 覆盖与此来源冲突时拒绝；副本只在 os.tmpdir 私有
 *   mkdtemp，复制（在 try 内，失败也回收）跳过缓存目录与 Singleton*，母本不改；finally
 *   先保留公开 context.browser() owned 句柄再关 context、继续尝试 owned browser.close，
 *   最后删本次副本——context.close 拒绝也不遗留自有 Chrome 进程
 * - managed/imported：chromium.launch（沿用显式 executable 环境输入），
 *   browser.newContext({storageState})；newContext 拒绝也 finally browser.close，
 *   context.close 拒绝不阻止关自有 browser
 * - existing/imported：仅显式 E2ET_CDP_URL，connectOverCDP 后
 *   newContext({storageState})（在 try/finally 内，newContext 拒绝也断连）；结束先关本次
 *   私有 context 再断连——公共句柄 browser.close 仅断连，非物理关闭共享浏览器
 *   （Playwright connectOverCDP 的 browserProcess.close/kill 只调 transport.closeAndWait）；
 *   不复用 default context，不依赖共享登录态
 *
 * 各分支保留 HEADLESS 当前合同（HEADLESS !== 'false'，默认 headless）。
 * 新 context/启动异常对外固定安全文案，不透传原 cookie/token/底层 message。
 * profile 自带存储，不套 cookie/state 模式。本文件只管来源/资源生命周期，
 * 业务是否登录/环境是否正确由 Skill 的真实 data/DOM 断言负责。
 */
import { chromium, type Browser, type BrowserContext } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { validateStorageState, type StorageOrigin } from './shared/auth-state.js';
import { resolveReplaySelection, type ReplaySelectionInput } from './shared/replay-env.js';

export type ReplayEnvironmentInput = ReplaySelectionInput;

export interface ReplayEnvironment {
  auth_source: 'profile' | 'imported';
  browser_source: 'chrome-profile' | 'managed' | 'existing';
}

/** Playwright 公开 storageState 实际类型（BrowserContext.storageState() 返回值推导，不新增依赖） */
type StandardState = Awaited<ReturnType<BrowserContext['storageState']>>;

/** e2et 根：尊重 E2ET_HOME，否则 ~/.e2et（与 CLI e2etRoot 同语义） */
function e2etRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.E2ET_HOME ?? path.join(os.homedir(), '.e2et');
}

function profileMasterPath(env: NodeJS.ProcessEnv = process.env): string {
  const root = e2etRoot(env);
  const versionsRoot = path.resolve(root, 'e2e-profiles');
  try {
    const candidate = fs.readFileSync(path.join(root, 'e2e-profile-current'), 'utf-8').trim();
    if (!path.isAbsolute(candidate)) throw new Error('relative pointer');
    const resolved = path.resolve(candidate);
    if (path.dirname(resolved) !== versionsRoot) throw new Error('pointer outside versions root');
    const version = fs.lstatSync(resolved);
    const profile = fs.lstatSync(path.join(resolved, 'Default'));
    const localState = fs.lstatSync(path.join(resolved, 'Local State'));
    if (version.isSymbolicLink() || !version.isDirectory()
      || profile.isSymbolicLink() || !profile.isDirectory()
      || localState.isSymbolicLink() || !localState.isFile()) {
      throw new Error('incomplete profile version');
    }
    return resolved;
  } catch {
    return path.join(root, 'e2e-profile');
  }
}

/** 与核心 Source 同判据：母本必须是非 symlink 目录，且含非 symlink 的 Default 目录。 */
function profileMasterExists(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    const masterDir = profileMasterPath(env);
    const master = fs.lstatSync(masterDir);
    return master.isDirectory()
      && !master.isSymbolicLink()
      && fs.lstatSync(path.join(masterDir, 'Default')).isDirectory();
  } catch {
    return false;
  }
}

function replayError(message: string): Error {
  return new Error(`回放上下文不可用: ${message}`);
}

/** 非空字符串环境输入 */
function nonEmptyInput(value: string | undefined): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * 读一次并交给 runtime/shared 的唯一纯校验；IO 错误和校验原因都不回显 state 内容。
 */
function loadStandardState(statePath: string): StandardState {
  let raw: string;
  try {
    raw = fs.readFileSync(statePath, 'utf8');
  } catch {
    throw replayError(`登录态文件读取失败: ${statePath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw replayError('登录态文件不是合法 JSON（内容不回显）');
  }
  const invalid = validateStorageState(parsed);
  if (invalid) throw replayError(`登录态不是标准 storageState: ${invalid}`);
  const state = parsed as { cookies: StandardState['cookies']; origins?: StorageOrigin[] };
  return {
    cookies: state.cookies,
    origins: state.origins ?? [],
  };
}

/** imported 的 state 路径：显式 E2ET_AUTH_STATE 定义即唯一输入（空值在入口已拒绝） */
function resolveStatePath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = nonEmptyInput(env.E2ET_AUTH_STATE);
  if (explicit) return explicit;
  return path.join(e2etRoot(env), 'auth', 'imported.json');
}

/** 系统 Google Chrome（与 CLI resolveSystemChrome 同解析合同）；找不到拒绝，不回退 Playwright Chromium */
function resolveSystemChrome(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.CHROME_EXECUTABLE_PATH && fs.existsSync(env.CHROME_EXECUTABLE_PATH)) return env.CHROME_EXECUTABLE_PATH;
  const candidates = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    : ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium'];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/** managed 启动的显式 executable 环境输入（不扫缓存目录，Playwright 自管默认 Chromium） */
function resolveExplicitExecutable(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const p of [env.BROWSER_EXECUTABLE_PATH, env.PUPPETEER_EXECUTABLE_PATH, env.CHROME_EXECUTABLE_PATH]) {
    if (p && fs.existsSync(p)) return p;
  }
  return undefined;
}

/** profile 副本复制时跳过的缓存目录（与 CLI PROFILE_SKIP_DIRS 同集合的独立实现） */
const PROFILE_SKIP_DIRS = new Set([
  'Cache', 'Code Cache', 'GPUCache', 'ShaderCache',
  'Service Worker', 'GrShaderCache', 'DawnCache', 'DawnGraphiteCache',
]);
const DEVTOOLS_ACTIVE_PORT = 'DevToolsActivePort';
const REMOTE_DEBUGGING_ARGS = [
  '--remote-debugging-address=127.0.0.1',
  '--remote-debugging-port=0',
];

function devtoolsEndpoint(profileDir: string, contents: string): string {
  const [portLine, pathLine] = contents.trim().split(/\r?\n/);
  const port = Number(portLine);
  if (!Number.isInteger(port) || port <= 0 || port > 65535 || !pathLine?.startsWith('/devtools/browser/')) {
    throw replayError(`${DEVTOOLS_ACTIVE_PORT} 内容非法`);
  }
  return `ws://127.0.0.1:${port}${pathLine}`;
}

async function readDevToolsEndpoint(profileDir: string): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      return devtoolsEndpoint(profileDir, fs.readFileSync(path.join(profileDir, DEVTOOLS_ACTIVE_PORT), 'utf8'));
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  if (lastError instanceof Error && lastError.message.includes(`${DEVTOOLS_ACTIVE_PORT} 内容非法`)) throw lastError;
  throw replayError(`读取 ${DEVTOOLS_ACTIVE_PORT} 超时`);
}

function ownUserDataDir(args: string[]): string {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith('--user-data-dir=')) values.push(arg.slice('--user-data-dir='.length));
    else if (arg === '--user-data-dir' && typeof args[i + 1] === 'string') values.push(args[++i]!);
  }
  if (values.length !== 1 || !values[0]) {
    throw replayError('Browser.getBrowserCommandLine 未返回唯一 user-data-dir');
  }
  return values[0];
}

async function managedDevToolsEndpoint(browser: Browser): Promise<string> {
  let session: Awaited<ReturnType<Browser['newBrowserCDPSession']>> | undefined;
  try {
    session = await browser.newBrowserCDPSession();
    const commandLine = await session.send('Browser.getBrowserCommandLine') as { arguments?: unknown };
    if (!Array.isArray(commandLine.arguments) || commandLine.arguments.some((arg) => typeof arg !== 'string')) {
      throw replayError('Browser.getBrowserCommandLine 返回非法 arguments');
    }
    return await readDevToolsEndpoint(ownUserDataDir(commandLine.arguments as string[]));
  } finally {
    if (session) await session.detach().catch(() => {});
  }
}

async function resolveCdpWebSocketUrl(raw: string): Promise<string> {
  let input: URL;
  try {
    input = new URL(raw);
  } catch {
    throw replayError('E2ET_CDP_URL 不是合法 URL');
  }
  if (input.protocol === 'ws:' || input.protocol === 'wss:') return raw;
  if (input.protocol !== 'http:' && input.protocol !== 'https:') {
    throw replayError('E2ET_CDP_URL 必须是 http(s) 或 ws(s)');
  }
  const base = raw.replace(/\/+$/, '').replace(/\/json(?:\/version|\/list)?$/i, '');
  let response: Response;
  try {
    response = await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(5_000) });
  } catch {
    throw replayError('existing CDP /json/version 不可达');
  }
  if (!response.ok) throw replayError(`existing CDP /json/version 拒绝（HTTP ${response.status}）`);
  let version: { webSocketDebuggerUrl?: unknown };
  try {
    version = await response.json() as { webSocketDebuggerUrl?: unknown };
  } catch {
    throw replayError('existing CDP /json/version 不是合法 JSON');
  }
  if (typeof version.webSocketDebuggerUrl !== 'string') {
    throw replayError('existing CDP /json/version 缺 webSocketDebuggerUrl');
  }
  let socketUrl: URL;
  try {
    socketUrl = new URL(version.webSocketDebuggerUrl);
  } catch {
    throw replayError('existing CDP webSocketDebuggerUrl 非法');
  }
  if (socketUrl.protocol !== 'ws:' && socketUrl.protocol !== 'wss:') {
    throw replayError('existing CDP webSocketDebuggerUrl 必须是 ws(s)');
  }
  return version.webSocketDebuggerUrl;
}

async function configuredExistingAvailable(env: NodeJS.ProcessEnv): Promise<boolean> {
  const raw = nonEmptyInput(env.E2ET_CDP_URL);
  if (!raw) return false;
  try {
    await resolveCdpWebSocketUrl(raw);
    return true;
  } catch {
    return false;
  }
}

type ReplayRun = (
  context: BrowserContext,
  cdpEndpoint: string,
  environment: ReplayEnvironment,
) => Promise<void>;

interface ResolvedReplayEnvironment {
  environment: ReplayEnvironment;
  env: NodeJS.ProcessEnv;
}

async function resolveReplayEnvironment(
  input: ReplayEnvironmentInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedReplayEnvironment> {
  const profileAvailable = Boolean(resolveSystemChrome(env) && profileMasterExists(env));
  // 先校验本次参数，非法值不能因为 CDP 探测而先产生远程副作用。
  let selection = resolveReplaySelection(input, env, {
    profileAvailable,
    existingAvailable: false,
  });
  const requestedBrowser = input.browser ?? env.E2ET_REPLAY_BROWSER ?? 'auto';
  if (selection.browser === 'managed'
    && requestedBrowser === 'auto'
    && await configuredExistingAvailable(env)) {
    selection = resolveReplaySelection(input, env, {
      profileAvailable,
      existingAvailable: true,
    });
  }
  const environment: ReplayEnvironment = {
    auth_source: selection.auth,
    browser_source: selection.browser === 'chrome' ? 'chrome-profile' : selection.browser,
  };
  return {
    environment,
    env: {
      ...env,
      ...(selection.authState !== undefined
        ? { E2ET_AUTH_STATE: selection.authState }
        : { E2ET_AUTH_STATE: undefined }),
    },
  };
}

/** 参数优先于环境；IR provenance 不传这里。 */
export async function withReplayContext(
  run: ReplayRun,
  input: ReplayEnvironmentInput = {},
): Promise<void> {
  const { environment, env } = await resolveReplayEnvironment(input);
  const headless = env.HEADLESS !== 'false';
  if (environment.browser_source === 'chrome-profile') {
    await withProfileContext(headless, run, environment, env);
    return;
  }
  const state = loadStandardState(resolveStatePath(env));
  if (environment.browser_source === 'managed') {
    await withManagedContext(state, headless, run, environment, env);
  } else {
    await withExistingContext(state, run, environment, env);
  }
}

async function withProfileContext(
  headless: boolean,
  run: ReplayRun,
  environment: ReplayEnvironment,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  // profile 自带存储：显式 state 覆盖与此来源冲突时拒绝，不悄悄换账号
  if (nonEmptyInput(env.E2ET_AUTH_STATE)) {
    throw replayError('profile 回放不注入显式登录态文件（E2ET_AUTH_STATE 与 chrome-profile 来源冲突）');
  }
  const chrome = resolveSystemChrome(env);
  if (!chrome) {
    throw replayError('找不到系统 Google Chrome（CHROME_EXECUTABLE_PATH 或系统安装），不回退 Playwright Chromium');
  }
  const masterDir = profileMasterPath(env);
  if (!profileMasterExists(env)) {
    throw replayError(`profile 母本不存在: ${masterDir} —— 先 auth login`);
  }
  // 副本只在 os.tmpdir 私有 mkdtemp；复制在 try 内（失败也走 finally 回收），母本不改
  const copyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2et-replay-'));
  let context: BrowserContext | undefined;
  try {
    try {
      fs.cpSync(masterDir, copyDir, {
        recursive: true,
        filter: (src) => {
          const base = path.basename(src);
          if (PROFILE_SKIP_DIRS.has(base) || base.startsWith('Singleton') || base === DEVTOOLS_ACTIVE_PORT) return false;
          return true;
        },
      });
    } catch (e) {
      throw replayError(`profile 母本复制失败（副本已回收，不透传底层信息: ${(e as Error).name})`);
    }
    try {
      context = await chromium.launchPersistentContext(copyDir, {
        executablePath: chrome,
        headless,
        args: REMOTE_DEBUGGING_ARGS,
        // 真实系统 Chrome 钥匙串 cookie：不带 --use-mock-keychain
        ignoreDefaultArgs: ['--use-mock-keychain'],
      });
    } catch (e) {
      throw replayError(`profile Chrome 启动失败（副本已回收，不透传底层信息: ${(e as Error).name})`);
    }
    await run(context, await readDevToolsEndpoint(copyDir), environment);
  } finally {
    if (context) {
      // 先保留公开 browser() owned 句柄，再关 context；context.close 拒绝也继续尝试
      // owned browser.close（不遗留自有 Chrome 进程），最后删本次副本，母本不动
      const owned = context.browser();
      await context.close().catch(() => {});
      if (owned) await owned.close().catch(() => {});
    }
    fs.rmSync(copyDir, { recursive: true, force: true });
  }
}

async function withManagedContext(
  state: StandardState,
  headless: boolean,
  run: ReplayRun,
  environment: ReplayEnvironment,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const executable = resolveExplicitExecutable(env);
  let browser;
  try {
    browser = await chromium.launch({
      headless,
      args: [...REMOTE_DEBUGGING_ARGS, '--enable-automation'],
      ...(executable ? { executablePath: executable } : {}),
    });
  } catch (e) {
    throw replayError(`managed 浏览器启动失败（不透传底层信息: ${(e as Error).name})`);
  }
  try {
    let context: BrowserContext;
    try {
      context = await browser.newContext({ storageState: state });
    } catch (e) {
      throw replayError(`登录态注入校验失败（内容不回显: ${(e as Error).name})`);
    }
    try {
      await run(context, await managedDevToolsEndpoint(browser), environment);
    } finally {
      // context.close 拒绝也继续关闭自有 browser，不让前一个 cleanup 阻止后一个
      await context.close().catch(() => {});
    }
  } finally {
    // launch 成功后 newContext 拒绝也必须 finally browser.close
    await browser.close().catch(() => {});
  }
}

async function withExistingContext(
  state: StandardState,
  run: ReplayRun,
  environment: ReplayEnvironment,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  // 仅显式 E2ET_CDP_URL；不复用 default context，不依赖发现出的共享登录态
  const cdpUrl = nonEmptyInput(env.E2ET_CDP_URL);
  if (!cdpUrl) {
    throw replayError('existing 回放需要显式 E2ET_CDP_URL（共享浏览器端点）');
  }
  let browser;
  try {
    browser = await chromium.connectOverCDP(cdpUrl);
  } catch (e) {
    throw replayError(`existing CDP 连接失败（不透传底层信息: ${(e as Error).name})`);
  }
  try {
    let context: BrowserContext;
    try {
      context = await browser.newContext({ storageState: state });
    } catch (e) {
      throw replayError(`登录态注入校验失败（内容不回显: ${(e as Error).name})`);
    }
    try {
      await run(context, await resolveCdpWebSocketUrl(cdpUrl), environment);
    } finally {
      // 先关本次私有 context；公共连接句柄 browser.close 仅断连（connectOverCDP 的
      // browserProcess.close/kill 只调 transport.closeAndWait），不物理关闭共享浏览器
      await context.close().catch(() => {});
    }
  } finally {
    // newContext 拒绝也必须断连（仅断连，不物理关共享浏览器）
    await browser.close().catch(() => {});
  }
}
