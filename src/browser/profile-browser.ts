/**
 * profile 登录态：母本 profile 副本启动 + 探测 + auth login + auth export。
 *
 * 与 managed 临时目录启动的区别：profile 副本不能带 --use-mock-keychain
 * （macOS 上 profile cookie 用钥匙串加密，带 mock keychain 等于没登录）。
 * 母本只读：每次启动复制副本并删 Singleton*。
 *
 * 不读/写/删用户真实 ~/.e2et（测试一律临时 E2ET_HOME）。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import {
  launchChromium,
  killProcessGroup,
  openCdpSession,
  attachToPage,
  probeAuthState,
  type LaunchedChromium,
  type InjectAuthResult,
} from './managed-browser.js';
import { e2etRoot } from '../daemon/session-meta.js';
import { buildAuthSummary, type CookieLike, type AuthSummary } from '../shared/auth-state.js';
import { validateStorageState } from './auth-check.js';

/** 登录自动免登等待（实测 24~29s，判据留 60s）；之后提示用户手动登录 */
const AUTO_LOGIN_WAIT_MS = 60_000;
/** auth login 总上限 5 分钟 */
const LOGIN_TOTAL_CAP_MS = 5 * 60_000;
/** auth login 轮询间隔 */
const LOGIN_POLL_INTERVAL_MS = 1_000;

export type AuthLoginFailureCode = 'AUTH_FAILED' | 'ENV_UNAVAILABLE';

/** auth login 的稳定失败边界：URL/登录态失败 exit 1，Chrome/profile/运行时环境失败 exit 3。 */
export class AuthLoginError extends Error {
  readonly code: AuthLoginFailureCode;

  constructor(code: AuthLoginFailureCode, message: string) {
    super(message);
    this.name = 'AuthLoginError';
    this.code = code;
  }
}

function authLoginEnvError(message: string, cause?: unknown): AuthLoginError {
  const detail = cause instanceof Error && cause.message ? `: ${cause.message}` : '';
  return new AuthLoginError('ENV_UNAVAILABLE', `${message}${detail}`);
}

/** 完整 profile 的版本目录父路径。 */
export function profileVersionsPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(e2etRoot(env), 'e2e-profiles');
}

/** 原子切换用的 current 指针文件。 */
export function profileCurrentPointerPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(e2etRoot(env), 'e2e-profile-current');
}

function validProfileVersion(candidate: string, env: NodeJS.ProcessEnv): string | undefined {
  if (!path.isAbsolute(candidate)) return undefined;
  const resolved = path.resolve(candidate);
  if (path.dirname(resolved) !== path.resolve(profileVersionsPath(env))) return undefined;
  try {
    const stat = fs.lstatSync(resolved);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return undefined;
    if (!fs.lstatSync(path.join(resolved, 'Default')).isDirectory()) return undefined;
    if (!fs.lstatSync(path.join(resolved, 'Local State')).isFile()) return undefined;
    return resolved;
  } catch {
    return undefined;
  }
}

/** 读取合法 current 指针；损坏、越界或目录不完整时由调用方回退旧母本。 */
function currentProfileVersion(env: NodeJS.ProcessEnv): string | undefined {
  try {
    return validProfileVersion(fs.readFileSync(profileCurrentPointerPath(env), 'utf-8').trim(), env);
  } catch {
    return undefined;
  }
}

/** profile 母本目录：优先合法 current 指针，否则回退既有 <e2etRoot>/e2e-profile。 */
export function profileMasterPath(env: NodeJS.ProcessEnv = process.env): string {
  return currentProfileVersion(env) ?? path.join(e2etRoot(env), 'e2e-profile');
}

function completeProfileDirectory(profileDir: string): boolean {
  try {
    const stat = fs.lstatSync(profileDir);
    return stat.isDirectory()
      && !stat.isSymbolicLink()
      && fs.lstatSync(path.join(profileDir, 'Default')).isDirectory();
  } catch {
    return false;
  }
}

/** profile 母本存在性只看完整目录，不以 Cookie 数量/文件代表鉴权成功。 */
/** profile 母本关键文件路径（完整性校验 + mtime 只读守卫用）。 */
const PROFILE_MASTER_KEY_FILES = ['Default', 'Local State'] as const;

/** 母本完整性：Default 目录 + Local State 文件。Cookies 不查；完整性不代表业务登录有效。 */
export function profileMasterComplete(env: NodeJS.ProcessEnv = process.env): {
  complete: boolean;
  missing: string[];
} {
  const dir = profileMasterPath(env);
  const missing: string[] = [];
  if (!completeProfileDirectory(dir)) {
    return { complete: false, missing: ['Default'] };
  }
  try {
    if (!fs.lstatSync(path.join(dir, 'Local State')).isFile()) {
      missing.push('Local State');
    }
  } catch {
    missing.push('Local State');
  }
  return { complete: missing.length === 0, missing };
}

/** 记录母本关键文件的 mtime 快照（启动前调用）。 */
export function snapshotMasterMtimes(env: NodeJS.ProcessEnv = process.env): Map<string, number> {
  const dir = profileMasterPath(env);
  const mtimes = new Map<string, number>();
  for (const rel of PROFILE_MASTER_KEY_FILES) {
    const abs = path.join(dir, rel);
    try { mtimes.set(rel, fs.lstatSync(abs).mtimeMs); } catch { /* ignore */ }
  }
  for (const rel of ['Default/Cookies', 'Default/Network/Cookies']) {
    const abs = path.join(dir, rel);
    try { mtimes.set(rel, fs.lstatSync(abs).mtimeMs); } catch { /* ignore */ }
  }
  return mtimes;
}

/** 校验母本关键文件 mtime 是否与快照一致。返回被修改的文件列表。 */
export function checkMasterMtimes(
  before: Map<string, number>,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const dir = profileMasterPath(env);
  const modified: string[] = [];
  for (const [rel, beforeMs] of before) {
    const abs = path.join(dir, rel);
    try {
      const afterMs = fs.lstatSync(abs).mtimeMs;
      if (afterMs !== beforeMs) modified.push(rel);
    } catch {
      modified.push(rel);
    }
  }
  return modified;
}

export function profileMasterExists(env: NodeJS.ProcessEnv = process.env): boolean {
  return completeProfileDirectory(profileMasterPath(env));
}

/** auth export 优先读取的 Cookie 数据库路径（兼容旧 Default/Cookies 与 Network/Cookies）。 */
export function profileCookiesFile(env: NodeJS.ProcessEnv = process.env): string {
  const profileDir = path.join(profileMasterPath(env), 'Default');
  const direct = path.join(profileDir, 'Cookies');
  return fs.existsSync(direct) ? direct : path.join(profileDir, 'Network', 'Cookies');
}

/** 原子写 current 指针。调用方只在新版本已验证后调用。 */
export function switchProfileMaster(versionDir: string, env: NodeJS.ProcessEnv = process.env): void {
  const candidate = validProfileVersion(versionDir, env);
  if (!candidate) throw new Error(`profile 版本目录不完整或不在 ${profileVersionsPath(env)}: ${versionDir}`);
  const pointer = profileCurrentPointerPath(env);
  fs.mkdirSync(path.dirname(pointer), { recursive: true, mode: 0o700 });
  const temporary = `${pointer}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${candidate}\n`, { encoding: 'utf-8', mode: 0o600 });
  try {
    fs.renameSync(temporary, pointer);
    try { fs.chmodSync(pointer, 0o600); } catch { /* ignore */ }
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch { /* ignore */ }
    throw error;
  }
}

export function gcProfileVersions(
  currentVersion: string,
  env: NodeJS.ProcessEnv = process.env,
  remove: (target: fs.PathLike, options: fs.RmOptions) => void = fs.rmSync,
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(profileVersionsPath(env), { withFileTypes: true });
  } catch {
    return;
  }
  const active = path.resolve(currentVersion);
  const pointer = currentProfileVersion(env) ?? active;
  const candidates = entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && /^profile-/.test(entry.name))
    .map((entry) => {
      const dir = path.join(profileVersionsPath(env), entry.name);
      try {
        return { dir: path.resolve(dir), mtimeMs: fs.lstatSync(dir).mtimeMs };
      } catch {
        return undefined;
      }
    })
    .filter((entry): entry is { dir: string; mtimeMs: number } => !!entry)
    .filter((entry) => entry.dir !== active && entry.dir !== pointer)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const stale of candidates.slice(1)) {
    try { remove(stale.dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/** staging 与版本目录同盘：rename → 原子写指针 → GC；指针失败删新版本，旧指针不动。 */
export function installProfileVersion(stagingDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const versionsDir = profileVersionsPath(env);
  if (path.dirname(path.resolve(stagingDir)) !== path.resolve(versionsDir)) {
    throw new Error(`profile staging 不在 ${versionsDir}: ${stagingDir}`);
  }
  const versionDir = path.join(versionsDir, `profile-${Date.now()}-${process.pid}-${randomUUID()}`);
  fs.renameSync(stagingDir, versionDir);
  try {
    switchProfileMaster(versionDir, env);
  } catch (error) {
    try { fs.rmSync(versionDir, { recursive: true, force: true }); } catch { /* ignore */ }
    throw error;
  }
  gcProfileVersions(versionDir, env);
  return versionDir;
}

/** profile 副本启动时跳过这些缓存类目录（启动快、不复制无用数据） */
export const PROFILE_SKIP_DIRS = new Set([
  'Cache', 'Code Cache', 'GPUCache', 'ShaderCache',
  'Service Worker', 'GrShaderCache', 'DawnCache', 'DawnGraphiteCache',
]);

export interface BrowserCookie extends Omit<CookieLike, 'partitionKey' | '_crHasCrossSiteAncestor'> {
  partitionKey?: { topLevelSite?: unknown; hasCrossSiteAncestor?: unknown };
  partitionKeyOpaque?: boolean;
}

/** 复制 profile 母本到临时副本目录，删 Singleton*，跳过缓存目录。
 *  前缀 e2et-<sid>- 符合孤儿回收归属校验约定。返回副本目录。 */
export function copyProfileForSession(masterDir: string, sessionId: string): string {
  const prefix = path.join(os.tmpdir(), `e2et-${sessionId}-`);
  const copyDir = fs.mkdtempSync(prefix);
  copyDirContents(masterDir, copyDir);
  // 母本里的单例锁必须删，否则副本一启动就 profile in use
  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    fs.rmSync(path.join(copyDir, f), { force: true });
  }
  return copyDir;
}

/** 递归复制目录，跳过 PROFILE_SKIP_DIRS。fs.cpSync 的 filter 不递归判子目录，手写。 */
function copyDirContents(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (PROFILE_SKIP_DIRS.has(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirContents(s, d);
    } else if (entry.isSymbolicLink()) {
      try { fs.symlinkSync(fs.readlinkSync(s), d); } catch { /* ignore broken symlinks */ }
    } else if (entry.isFile()) {
      fs.copyFileSync(s, d);
    }
  }
}

/** 删除 profile 副本目录（回收用）。 */
export function cleanupProfileCopy(copyDir: string): void {
  try { fs.rmSync(copyDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

/** 启动 profile 副本并探测（不注入 cookie）。
 *  探测遵循 probeAuthState 语义（E2ET_AUTH_PROBE_URL 显式输入，无输入不导航）。
 *  成功：返回 handle（pid/baseUrl/userDataDir），浏览器保留供会话使用；ws 关闭。
 *  失败（probeError）：杀浏览器 + 删副本目录，返回 probe 结果。
 *  B2：浏览器启动成功后立即调 onEarlyMeta 让 daemon 写 early meta（pid/副本目录/endpoint），
 *  供 CLI 启动超时 / SIGTERM / SIGKILL 期间回收副本目录；失败清理后成对清除。 */
export async function launchProfileAndProbe(
  executable: string,
  masterDir: string,
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
  onEarlyMeta?: (handle: { pid: number; baseUrl: string; userDataDir: string }) => void,
  onClearEarlyMeta?: (handle: { pid: number; baseUrl: string; userDataDir: string }) => void,
  onSpawnResource?: (pid: number, userDataDir: string) => void,
): Promise<{ result: InjectAuthResult; handle?: { pid: number; baseUrl: string; userDataDir: string } }> {
  const copyDir = copyProfileForSession(masterDir, sessionId);
  let launched: LaunchedChromium | null = null;
  const masterMtimes = snapshotMasterMtimes(env);
  try {
    launched = await launchChromium(executable, copyDir, env, {
      mockKeychain: false,
      onSpawn: onSpawnResource ? (pid) => onSpawnResource(pid, copyDir) : undefined,
    });
    // B2: 启动成功立即写 early meta，探测期间 CLI 超时/SIGTERM 才能回收副本
    onEarlyMeta?.({ pid: launched.pid, baseUrl: launched.baseUrl, userDataDir: copyDir });
    const session = await openCdpSession(launched.baseUrl);
    try {
      const sid = await attachToPage(session);
      const probeUrl = env.E2ET_AUTH_PROBE_URL ?? process.env.E2ET_AUTH_PROBE_URL;
      let result = probeUrl
        ? await probeAuthState(session, sid, probeUrl, { expectedUrl: probeUrl })
        : await probeAuthState(session, sid);
      if (!result.probeError) {
        // 母本只读守卫：探测通过后校验母本关键文件 mtime 未变
        const modified = checkMasterMtimes(masterMtimes, env);
        if (modified.length > 0) {
          result = { finalUrl: '', probeError: `母本被修改（${modified.join(', ')}），拒绝使用该来源` };
          await stopLaunchedChromium(launched!);
          cleanupProfileCopy(copyDir);
          onClearEarlyMeta?.({ pid: launched!.pid, baseUrl: launched!.baseUrl, userDataDir: copyDir });
          return { result };
        }
        // 通过：保留浏览器供会话使用（child 脱离本进程管理）
        launched.child.unref?.();
        launched.child.stderr?.removeAllListeners();
        launched.child.stderr?.destroy();
        return {
          result,
          handle: { pid: launched.pid, baseUrl: launched.baseUrl, userDataDir: copyDir },
        };
      }
      // 未通过：杀浏览器 + 删副本
      await stopLaunchedChromium(launched);
      cleanupProfileCopy(copyDir);
      onClearEarlyMeta?.({ pid: launched.pid, baseUrl: launched.baseUrl, userDataDir: copyDir });
      return { result };
    } finally {
      session.close();
    }
  } catch (e) {
    const phase = launched ? '探测' : '启动';
    if (launched) await stopLaunchedChromium(launched);
    cleanupProfileCopy(copyDir);
    if (launched) onClearEarlyMeta?.({ pid: launched.pid, baseUrl: launched.baseUrl, userDataDir: copyDir });
    return { result: { finalUrl: '', probeError: `profile ${phase}失败: ${(e as Error).message}` } };
  }
}

/** auth login 选项。url 必填（调用方显式提供，无业务默认）。 */
export interface AuthLoginOpts {
  /** 登录后应到达的 URL（调用方显式提供；完成该 URL 条件不代表业务已登录） */
  url: string;
  onStatus?: (msg: string) => void;
  pollIntervalMs?: number;
  autoWaitMs?: number;
  totalCapMs?: number;
}

export interface AuthLoginResult {
  profilePath: string;
  finalUrl: string;
  durationMs: number;
}

function removeProfileRuntimeFiles(profileDir: string): void {
  for (const entry of fs.readdirSync(profileDir)) {
    if (entry === 'DevToolsActivePort' || entry.startsWith('Singleton')) {
      fs.rmSync(path.join(profileDir, entry), { recursive: true, force: true });
    }
  }
}

async function stopLaunchedChromium(launched: LaunchedChromium): Promise<void> {
  await killProcessGroup(launched.pid, 3000).catch(() => {});
  launched.child.stderr?.removeAllListeners();
  launched.child.stderr?.destroy();
}

/** auth login：有头打开专用 profile，导航到调用方 URL 轮询落地，关闭让 cookie 落盘。
 *  - 判据：最终 URL 与调用方 URL 的标准 origin+pathname 相等（isAtUrl）；
 *    中间页（登录页/跳转页）一律继续等。
 *  - 前 60s 等自动免登；未落地则 stderr 提示用户在窗口里手动登录，继续轮询，总上限 5 分钟。
 *  - 落地后 Browser.close 正常关闭（让 cookie 落盘），等进程退出；N1 超时强杀。
 *  - 任何失败路径都回收浏览器进程。不读 stdin。
 *  - 输出事实（profile_path/final_url/duration_ms）：完成调用方 URL 条件，不保证业务已登录。
 *  - onStatus：测试/进度回调（可选），不向 stdout 打印进度（stdout 只给最终 JSON）。 */
export async function authLogin(
  executable: string,
  profileDir: string,
  opts: AuthLoginOpts,
): Promise<AuthLoginResult> {
  const pollInterval = opts.pollIntervalMs ?? LOGIN_POLL_INTERVAL_MS;
  const autoWait = opts.autoWaitMs ?? AUTO_LOGIN_WAIT_MS;
  const totalCap = opts.totalCapMs ?? LOGIN_TOTAL_CAP_MS;
  const targetUrl = opts.url;
  const start = Date.now();
  let launched: LaunchedChromium | null = null;
  try {
    try {
      fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
    } catch (error) {
      throw authLoginEnvError('auth login 环境失败（profile 目录不可用）', error);
    }
    try {
      launched = await launchChromium(executable, profileDir, process.env, { mockKeychain: false, headless: false });
    } catch (error) {
      throw authLoginEnvError('auth login 环境失败（Chrome 启动失败）', error);
    }
    let session: Awaited<ReturnType<typeof openCdpSession>>;
    try {
      session = await openCdpSession(launched.baseUrl);
    } catch (error) {
      throw authLoginEnvError('auth login 环境失败（Chrome CDP 不可用）', error);
    }
    let finalUrl = '';
    try {
      let sid: string;
      try {
        sid = await attachToPage(session);
        await session.send('Page.enable', {}, sid);
      } catch (error) {
        throw authLoginEnvError('auth login 环境失败（Chrome 页面不可用）', error);
      }
      await session.send('Page.navigate', { url: targetUrl }, sid).catch(() => {});
      let prompted = false;
      while (Date.now() - start < totalCap) {
        await new Promise((r) => setTimeout(r, pollInterval));
        try {
          const evalRes = await session.send<{ result?: { value?: string } }>(
            'Runtime.evaluate',
            { expression: 'location.href', returnByValue: true },
            sid,
          );
          finalUrl = evalRes.result?.value ?? '';
        } catch { finalUrl = ''; }
        if (isAtUrl(finalUrl, targetUrl)) {
          break;
        }
        if (!prompted && Date.now() - start >= autoWait) {
          opts.onStatus?.('请在弹出的浏览器窗口里完成登录');
          prompted = true;
        }
      }
      if (!isAtUrl(finalUrl, targetUrl)) {
        // N5: 超时报错里的 URL 走 stripQuery
        throw new AuthLoginError(
          'AUTH_FAILED',
          `登录未在 ${Math.round(totalCap / 1000)}s 内到达 ${stripQuery(targetUrl)}（最终 URL: ${stripQuery(finalUrl) || '(空)'}）—— 请检查网络/账号，或重试 auth login`,
        );
      }
      // Browser.close 正常关闭让 cookie 落盘
      await session.send('Browser.close').catch(() => {});
    } finally {
      session.close();
    }
    // N1: 等进程退出，超时强杀（reject 让 finally 杀）
    try {
      await waitExit(launched.child, 10_000);
    } catch (error) {
      throw authLoginEnvError('auth login 环境失败（Chrome 未正常退出）', error);
    }
    launched = null;
    return { profilePath: profileDir, finalUrl: stripQuery(finalUrl), durationMs: Date.now() - start };
  } catch (error) {
    if (error instanceof AuthLoginError) throw error;
    throw authLoginEnvError('auth login 环境失败（浏览器/profile 运行时异常）', error);
  } finally {
    if (launched) await stopLaunchedChromium(launched);
  }
}

/** auth login 只写私有 staging；成功后同盘 rename 并原子切指针，失败不碰 current/legacy。 */
export async function loginProfileAndInstall(
  executable: string,
  env: NodeJS.ProcessEnv,
  opts: AuthLoginOpts,
  login: typeof authLogin = authLogin,
): Promise<AuthLoginResult> {
  const versionsDir = profileVersionsPath(env);
  let stagingDir: string;
  try {
    fs.mkdirSync(versionsDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(versionsDir, 0o700);
    stagingDir = fs.mkdtempSync(path.join(versionsDir, '.login-'));
    fs.chmodSync(stagingDir, 0o700);
  } catch (error) {
    throw authLoginEnvError('auth login 环境失败（无法创建 profile staging）', error);
  }
  try {
    const result = await login(executable, stagingDir, opts);
    removeProfileRuntimeFiles(stagingDir);
    return {
      ...result,
      profilePath: installProfileVersion(stagingDir, env),
    };
  } catch (error) {
    try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch { /* ignore */ }
    if (error instanceof AuthLoginError) throw error;
    throw authLoginEnvError('auth login 环境失败（profile 安装失败）', error);
  }
}

/** N1: 等子进程退出；已退出立即 resolve，超时 reject（让 finally 强杀）。 */
function waitExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(() => reject(new Error(`Browser.close 后进程 ${timeoutMs}ms 未退出`)), timeoutMs);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

/** 登录落地判据：最终 URL 与调用方期望 URL 的标准 origin+pathname 相等。
 *  about:blank / chrome-error / 空值不匹配；query/hash 不影响判定。 */
export function isAtUrl(finalUrl: string, expectedUrl: string): boolean {
  if (!finalUrl || finalUrl === 'about:blank' || finalUrl.startsWith('chrome-error://')) return false;
  let a: URL;
  let b: URL;
  try {
    a = new URL(finalUrl);
    b = new URL(expectedUrl);
  } catch {
    return false;
  }
  return a.origin === b.origin && a.pathname === b.pathname;
}

/** URL 只保留 origin + path，不带 query。 */
export function stripQuery(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch { return url; }
}

/** auth export：从 profile 副本 headless 启动 → 浏览器级 Storage.getCookies
 *  → 只保留作用域覆盖 --domain 的 cookie → 关浏览器删副本。
 *  N3: 强制 headless: true。N4: 浏览器级 Storage.getCookies（不 attach page、不带 sessionId）。
 *  母本不存在 → 抛错（exit 3，提示先 auth login）。 */
export async function exportCookiesFromProfile(
  executable: string,
  masterDir: string,
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
  domain: string,
): Promise<CookieLike[]> {
  if (!completeProfileDirectory(masterDir)) {
    throw new Error(`profile 母本不存在: ${masterDir} —— 先执行 e2et auth login`);
  }
  const host = domain.replace(/^\./, '');
  const copyDir = copyProfileForSession(masterDir, sessionId);
  const cookies = await readCookiesFromProfileCopy(executable, copyDir, env);
  return sanitizeCookiesForPlaywright(
    cookies.filter((c) => domainMatches(host, String(c.domain ?? ''))),
  );
}

/** 从已有 profile 副本 headless 读取浏览器级 Cookie，不应用业务域过滤。
 *  显式 probeUrl 时先完成目标域 warm-up；副本与本次启动浏览器由本函数负责回收。 */
export async function readCookiesFromProfileCopy(
  executable: string,
  copyDir: string,
  env: NodeJS.ProcessEnv,
  profileDirectory?: string,
  probeUrl?: string,
): Promise<BrowserCookie[]> {
  let launched: LaunchedChromium | null = null;
  try {
    launched = await launchChromium(executable, copyDir, env, {
      mockKeychain: false,
      headless: true,
      ...(profileDirectory !== undefined ? { profileDirectory } : {}),
    });
    const session = await openCdpSession(launched.baseUrl);
    try {
      if (probeUrl !== undefined) {
        const sessionId = await attachToPage(session);
        const probe = await probeAuthState(session, sessionId, probeUrl);
        let finalHostname = '';
        try {
          finalHostname = new URL(probe.finalUrl).hostname;
        } catch {}
        if (probe.probeError || finalHostname !== new URL(probeUrl).hostname) {
          throw new Error('系统 Chrome 登录态 warm-up 未到达目标域名');
        }
      }
      const { cookies } = await session.send<{ cookies: Array<Record<string, unknown>> }>('Storage.getCookies', {});
      return cookies as BrowserCookie[];
    } finally {
      session.close();
    }
  } finally {
    if (launched) await stopLaunchedChromium(launched);
    cleanupProfileCopy(copyDir);
  }
}

/** 通用域匹配：cookie 的 domain 属性是否作用于 host（精确或点边界后缀）。
 *  cookieDomain 去前导点后 === host，或 host 以 '.'+cookieDomain 结尾。
 *  点边界保证 example.test.evil.test 不会被 test.evil.test 的子域骗局匹配。 */
export function domainMatches(host: string, cookieDomain: string): boolean {
  const d = cookieDomain.replace(/^\./, '');
  if (!d || !host) return false;
  return host === d || host.endsWith('.' + d);
}

/** auth export 落盘纯函数：原子写 0600 storageState JSON。
 *  B3: 抽出来单测；不依赖浏览器，不碰 stdout/stderr（调用方负责 envelope）。
 *  无业务 cookie 判据：cookie 事实进摘要（不含 value）；写盘失败抛错。 */
const PW_COOKIE_KEYS = new Set([
  'name', 'value', 'domain', 'path', 'expires', 'httpOnly', 'secure', 'sameSite',
  'partitionKey', '_crHasCrossSiteAncestor',
]);

/** 将 CDP 分区对象转换为 Playwright 持久化字段，同时保持 canonical 输入幂等。 */
export function sanitizeCookiesForPlaywright(cookies: Array<CookieLike | BrowserCookie>): CookieLike[] {
  if (cookies.some((cookie) => 'partitionKeyOpaque' in cookie && cookie.partitionKeyOpaque === true)) {
    throw new Error('目标域含不支持的 opaque 分区 Cookie，已拒绝导入');
  }
  return cookies.map((c) => {
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(c)) {
      if (PW_COOKIE_KEYS.has(k)) clean[k] = v;
    }
    const partitionKey = c.partitionKey;
    if (partitionKey !== null && typeof partitionKey === 'object') {
      if (typeof partitionKey.topLevelSite !== 'string'
        || (partitionKey.hasCrossSiteAncestor !== undefined
          && typeof partitionKey.hasCrossSiteAncestor !== 'boolean')) {
        throw new Error('分区 Cookie 元数据非法，已拒绝导入');
      }
      clean.partitionKey = partitionKey.topLevelSite;
      if ('hasCrossSiteAncestor' in partitionKey) {
        clean._crHasCrossSiteAncestor = partitionKey.hasCrossSiteAncestor;
      }
    }
    return clean as unknown as CookieLike;
  });
}

export function writeExportResult(out: string, cookies: CookieLike[]): AuthSummary {
  const sanitized = sanitizeCookiesForPlaywright(cookies);
  const storageState = { cookies: sanitized, origins: [] };
  // 写盘前跑标准结构校验：坏格式拒绝且不覆盖已有输出；到期/数量只是事实
  const invalid = validateStorageState(storageState);
  if (invalid) throw new Error(`导出 cookie 不构成标准 storageState: ${invalid}`);
  const serialized = JSON.stringify(storageState);
  const tmpFile = `${out}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
  fs.writeFileSync(tmpFile, serialized, { mode: 0o600 });
  fs.renameSync(tmpFile, out);
  try { fs.chmodSync(out, 0o600); } catch { /* ignore */ }
  return buildAuthSummary(sanitized, serialized);
}
