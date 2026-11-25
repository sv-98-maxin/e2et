import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  attachToPage,
  killProcessGroup,
  launchChromium,
  openCdpSession,
  probeAuthState,
  type LaunchedChromium,
} from './managed-browser.js';
import {
  PROFILE_SKIP_DIRS,
  installProfileVersion,
  isAtUrl,
  profileVersionsPath,
  stripQuery,
} from './profile-browser.js';

export interface ChromeProfiles {
  userDataDir: string;
  profiles: string[];
}

export class ChromeAuthError extends Error {
  readonly code: 'ENV_UNAVAILABLE' | 'AUTH_FAILED';

  constructor(code: 'ENV_UNAVAILABLE' | 'AUTH_FAILED', message: string) {
    super(message);
    this.name = 'ChromeAuthError';
    this.code = code;
  }
}

function envError(message: string): ChromeAuthError {
  return new ChromeAuthError('ENV_UNAVAILABLE', message);
}

function authError(message: string): ChromeAuthError {
  return new ChromeAuthError('AUTH_FAILED', message);
}

function safeErrorDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return message.replace(/https?:\/\/[^\s)]+/g, (url) => stripQuery(url));
}

async function stopLaunchedChromium(launched: LaunchedChromium): Promise<void> {
  await killProcessGroup(launched.pid, 3000).catch(() => {});
  launched.child.stderr?.removeAllListeners();
  launched.child.stderr?.destroy();
}

function lstat(file: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(file);
  } catch {
    return undefined;
  }
}

function isRegularFile(file: string): boolean {
  const stat = lstat(file);
  return !!stat && stat.isFile() && !stat.isSymbolicLink();
}

function isReadableRegularFile(file: string): boolean {
  if (!isRegularFile(file)) return false;
  try {
    fs.accessSync(file, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function isRegularDirectory(file: string): boolean {
  const stat = lstat(file);
  return !!stat && stat.isDirectory() && !stat.isSymbolicLink();
}

function cookieFileInProfile(profileDir: string): string | undefined {
  const direct = path.join(profileDir, 'Cookies');
  if (isReadableRegularFile(direct)) return direct;
  const nested = path.join(profileDir, 'Network', 'Cookies');
  return isReadableRegularFile(nested) ? nested : undefined;
}

export function discoverChromeProfiles(homeDir: string): ChromeProfiles {
  const userDataDir = path.join(homeDir, 'Library', 'Application Support', 'Google', 'Chrome');
  if (!isRegularDirectory(userDataDir)) {
    throw envError(`系统 Chrome 用户数据目录不存在、不可读取或不是普通目录: ${userDataDir}`);
  }
  if (!isReadableRegularFile(path.join(userDataDir, 'Local State'))) {
    throw envError(`系统 Chrome 缺少可读取的 Local State: ${path.join(userDataDir, 'Local State')}；请检查完全磁盘访问权限（Full Disk Access）`);
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(userDataDir, { withFileTypes: true });
  } catch {
    throw envError(`系统 Chrome 用户数据目录不可读取: ${userDataDir}；请检查完全磁盘访问权限（Full Disk Access）`);
  }
  const profiles = entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && (entry.name === 'Default' || /^Profile \d+$/.test(entry.name)))
    .filter((entry) => cookieFileInProfile(path.join(userDataDir, entry.name)) !== undefined)
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'en'));
  return { userDataDir, profiles };
}

const SYSTEM_RSYNC = '/usr/bin/rsync';
const SYSTEM_SECURITY = '/usr/bin/security';
const SYSTEM_SQLITE = '/usr/bin/sqlite3';

const CHROME_SAFE_STORAGE_SERVICE = 'Chrome Safe Storage';
const CHROME_SAFE_STORAGE_ACCOUNT = 'Chrome';
/** Chrome 时间戳起点（1601-01-01）与 Unix 纪元的秒差 */
const CHROME_EPOCH_OFFSET_SECONDS = 11_644_473_600;
/** macOS 旧加密格式前缀；v11 起密钥不落在 login keychain，外部无法解密 */
const COOKIE_V10_MAGIC = Buffer.from('v10');

const CHROME_PROFILE_IMPORT_EXCLUDES = [
  ...PROFILE_SKIP_DIRS,
  'CacheStorage',
  'Component Cache',
  'Crashpad',
  'Media Cache',
  'Shared Dictionary',
  'budget_database',
  'optimization_guide_hint_cache_store',
  'Extensions',
  'Extension State',
  'Extension Rules',
  'Extension Scripts',
  'Local Extension Settings',
  'Managed Extension Settings',
  'Sync Extension Settings',
  'History*',
  'Bookmarks*',
  'Favicons*',
  'Web Data*',
  'Visited Links',
  'Top Sites*',
  'Shortcuts*',
  'Login Data*',
  'Network Action Predictor*',
  'AutofillStrikeDatabase',
  'Download Service',
  'Downloads',
  'File System',
  'DevToolsActivePort',
  'Singleton*',
].sort();

/** 每次导入跑两遍，降低 Chrome 运行中 SQLite/LevelDB 文件跨时点复制的不一致。 */
export function chromeProfileCopyArgs(
  userDataDir: string,
  profileDirectory: string,
  stagingDir: string,
): string[][] {
  const sourceProfile = path.join(userDataDir, profileDirectory);
  const sourceLocalState = path.join(userDataDir, 'Local State');
  const targetProfile = path.join(stagingDir, 'Default');
  return [
    [
      '-rpt',
      ...CHROME_PROFILE_IMPORT_EXCLUDES.map((name) => `--exclude=/${name}`),
      '--',
      `${sourceProfile}${path.sep}`,
      `${targetProfile}${path.sep}`,
    ],
    [
      '-pt',
      '--',
      sourceLocalState,
      path.join(stagingDir, 'Local State'),
    ],
  ];
}

type CopyExecError = NodeJS.ErrnoException & {
  status?: number | null;
  stderr?: string | Buffer;
};

export function mapChromeCopyError(error: unknown): ChromeAuthError {
  const execError = error as CopyExecError;
  const code = typeof execError.code === 'string' ? execError.code : undefined;
  const stderr = Buffer.isBuffer(execError.stderr)
    ? execError.stderr.toString('utf8')
    : execError.stderr ?? '';
  if (code === 'ENOENT' && execError.path === SYSTEM_RSYNC) {
    return envError(`系统 rsync 不可用: ${SYSTEM_RSYNC}`);
  }
  if (code === 'EPERM' || code === 'EACCES'
    || stderr.includes('Operation not permitted')
    || stderr.includes('Permission denied')) {
    const reason = code === 'EACCES' || stderr.includes('Permission denied') ? 'EACCES' : 'EPERM';
    return envError(`读取系统 Chrome profile 文件失败（${reason}）；请给运行 e2et 的宿主授予完全磁盘访问权限（Full Disk Access）`);
  }
  if (code === 'EBUSY' || stderr.includes('Device or resource busy')) {
    return authError('系统 Chrome profile 文件被占用（EBUSY）；请重试');
  }
  if (code === 'ENOENT' || execError.status === 23 || execError.status === 24
    || stderr.includes('No such file or directory')) {
    return authError('系统 Chrome profile 复制期间源文件发生变化或不存在；请重试');
  }
  if (code === 'EIO' || stderr.includes('Input/output error')) {
    return authError('读取系统 Chrome profile 时发生 I/O 失败（EIO）');
  }
  if (code === 'ETIMEDOUT') return authError('系统 Chrome profile 复制超时');
  return authError('系统 Chrome profile 复制失败');
}

function copyChromeProfile(userDataDir: string, profileDirectory: string, stagingDir: string, env: NodeJS.ProcessEnv): void {
  const commands = chromeProfileCopyArgs(userDataDir, profileDirectory, stagingDir);
  try {
    for (let pass = 0; pass < 2; pass++) {
      for (const args of commands) {
        execFileSync(SYSTEM_RSYNC, args, {
          stdio: ['ignore', 'ignore', 'pipe'],
          env: { ...env, LC_ALL: 'C' },
          timeout: 120_000,
          killSignal: 'SIGKILL',
        });
      }
    }
  } catch (error) {
    throw mapChromeCopyError(error);
  }
}

function removeProfileRuntimeFiles(userDataDir: string): void {
  for (const entry of fs.readdirSync(userDataDir)) {
    if (entry === 'DevToolsActivePort' || entry.startsWith('Singleton')) {
      fs.rmSync(path.join(userDataDir, entry), { recursive: true, force: true });
    }
  }
}

/** staging 固定用 Default，源 Profile N 的 Local State 元数据同步改键。 */
export function normalizeStagedProfile(stagingDir: string, sourceProfileDirectory: string): void {
  const profileDir = path.join(stagingDir, 'Default');
  if (!isRegularDirectory(profileDir)) throw authError('Chrome profile 副本缺少 Default 目录');
  const localStateFile = path.join(stagingDir, 'Local State');
  let parsed: Record<string, unknown>;
  try {
    const raw = JSON.parse(fs.readFileSync(localStateFile, 'utf-8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not object');
    parsed = raw as Record<string, unknown>;
  } catch {
    throw authError('Chrome Local State 副本损坏，无法归一化 profile');
  }
  const profile = parsed.profile && typeof parsed.profile === 'object' && !Array.isArray(parsed.profile)
    ? parsed.profile as Record<string, unknown>
    : {};
  if (sourceProfileDirectory !== 'Default') {
    const infoCache = profile.info_cache && typeof profile.info_cache === 'object' && !Array.isArray(profile.info_cache)
      ? profile.info_cache as Record<string, unknown>
      : {};
    const selected = infoCache[sourceProfileDirectory];
    profile.info_cache = {
      Default: selected && typeof selected === 'object' && !Array.isArray(selected) ? selected : {},
    };
  }
  profile.last_used = 'Default';
  if (Array.isArray(profile.last_active_profiles)) profile.last_active_profiles = ['Default'];
  parsed.profile = profile;
  const temporary = `${localStateFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(parsed), { encoding: 'utf-8', mode: 0o600 });
  fs.renameSync(temporary, localStateFile);
}

export type VerifyChromeProfileFn = (
  executable: string,
  profileDir: string,
  url: string,
  env: NodeJS.ProcessEnv,
) => Promise<string>;

export interface InjectableChromeCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  expires?: number;
  sameSite?: 'Strict' | 'Lax' | 'None';
  partitionKey?: { topLevelSite: string; hasCrossSiteAncestor: boolean };
}

interface StagedCookieRow {
  host_key: string;
  name: string;
  path: string;
  expires_utc: number;
  is_secure: number;
  is_httponly: number;
  samesite: number;
  top_frame_site_key: string | null;
  has_cross_site_ancestor: number;
  value: string | null;
  encrypted: string | null;
}

function chromeSafeStorageKey(env: NodeJS.ProcessEnv): Buffer {
  let password: string;
  try {
    password = execFileSync(SYSTEM_SECURITY, [
      'find-generic-password',
      '-w',
      '-s', CHROME_SAFE_STORAGE_SERVICE,
      '-a', CHROME_SAFE_STORAGE_ACCOUNT,
    ], {
      encoding: 'utf-8',
      env: { ...env, LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
    }).trim();
  } catch {
    throw envError('读取钥匙串 Chrome Safe Storage 密钥失败（macOS 可能弹窗要求授权）；授权后重试');
  }
  if (!password) throw envError('钥匙串 Chrome Safe Storage 密钥为空');
  return crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
}

/**
 * 解 macOS 旧格式（v10）cookie：AES-128-CBC + PKCS#7，明文可能带 SHA256(host_key) 前缀。
 * v11 起的密钥不在 login keychain，外部取不到，返回 undefined。
 */
export function decryptChromeCookieValue(hostKey: string, encrypted: Buffer, key: Buffer): string | undefined {
  if (encrypted.length <= 3 || !encrypted.subarray(0, 3).equals(COOKIE_V10_MAGIC)) return undefined;
  let plain: Buffer;
  try {
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
    plain = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]);
  } catch {
    return undefined;
  }
  const hostDigest = crypto.createHash('sha256').update(hostKey).digest();
  const value = plain.length >= 32 && plain.subarray(0, 32).equals(hostDigest) ? plain.subarray(32) : plain;
  return value.toString('utf-8');
}

function toInjectableCookie(row: StagedCookieRow, value: string): InjectableChromeCookie {
  const cookie: InjectableChromeCookie = {
    name: row.name,
    value,
    domain: row.host_key,
    path: row.path || '/',
    secure: Number(row.is_secure) === 1,
    httpOnly: Number(row.is_httponly) === 1,
  };
  const expires = Number(row.expires_utc);
  if (Number.isFinite(expires) && expires > 0) {
    cookie.expires = Math.round(expires / 1e6 - CHROME_EPOCH_OFFSET_SECONDS);
  }
  const sameSite = Number(row.samesite);
  if (sameSite === 0) cookie.sameSite = 'None';
  else if (sameSite === 1) cookie.sameSite = 'Lax';
  else if (sameSite === 2) cookie.sameSite = 'Strict';
  if (row.top_frame_site_key) {
    cookie.partitionKey = {
      topLevelSite: row.top_frame_site_key,
      hasCrossSiteAncestor: Number(row.has_cross_site_ancestor) === 1,
    };
  }
  return cookie;
}

/**
 * 读取 staged profile 的 Cookies 并解成可注入的明文。
 *
 * Chrome 158 起按 user-data-dir 切换加密方案：默认目录仍写 v10，非默认目录（staged profile 就是）
 * 写 v11，且 v11 密钥不在 login keychain，复制过去的 v10 密文会判死并被整库清空。
 * 因此复制后不再指望 Chrome 自己解密，改由这里解成明文、启动后经 CDP 注入，由 Chrome 用当前
 * 方案重新加密落盘。
 */
export function readStagedChromeCookies(profileDir: string, env: NodeJS.ProcessEnv): InjectableChromeCookie[] {
  // staging 根目录下 profile 固定归一化为 Default；也兼容直接传 profile 目录
  const defaultProfileDir = path.join(profileDir, 'Default');
  const cookieFile = cookieFileInProfile(isRegularDirectory(defaultProfileDir) ? defaultProfileDir : profileDir);
  if (!cookieFile) return [];
  let rows: StagedCookieRow[];
  try {
    const raw = execFileSync(SYSTEM_SQLITE, [
      '-json',
      cookieFile,
      'select host_key, name, path, expires_utc, is_secure, is_httponly, samesite,'
        + ' top_frame_site_key, has_cross_site_ancestor, value, hex(encrypted_value) as encrypted'
        + ' from cookies',
    ], {
      encoding: 'utf-8',
      env: { ...env, LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    rows = raw.trim() ? JSON.parse(raw) as StagedCookieRow[] : [];
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw envError(`系统 sqlite3 不可用: ${SYSTEM_SQLITE}`);
    throw authError(`读取 staged Cookies 失败（${safeErrorDetail(error)}）`);
  }
  if (rows.length === 0) return [];

  const needsKey = rows.some((row) => !!row.encrypted);
  const key = needsKey ? chromeSafeStorageKey(env) : undefined;
  const cookies: InjectableChromeCookie[] = [];
  let undecryptable = 0;
  for (const row of rows) {
    let value = row.value ?? '';
    if (row.encrypted) {
      const decrypted = key ? decryptChromeCookieValue(row.host_key, Buffer.from(row.encrypted, 'hex'), key) : undefined;
      if (decrypted === undefined) {
        undecryptable++;
        continue;
      }
      value = decrypted;
    }
    cookies.push(toInjectableCookie(row, value));
  }
  if (cookies.length === 0) {
    throw authError(`staged Cookies 全部无法解密（${undecryptable} 条；Chrome 加密格式与钥匙串密钥不匹配）`);
  }
  return cookies;
}

async function injectStagedCookies(
  session: Awaited<ReturnType<typeof openCdpSession>>,
  sessionId: string,
  cookies: InjectableChromeCookie[],
): Promise<void> {
  await session.send('Network.enable', {}, sessionId);
  try {
    await session.send('Network.setCookies', { cookies }, sessionId);
  } catch {
    // 单条不合法（如 CHIPS 分区键）不该拖垮整批：降级逐条注入，全失败才报错
    let injected = 0;
    for (const cookie of cookies) {
      try {
        await session.send('Network.setCookies', { cookies: [cookie] }, sessionId);
        injected++;
      } catch { /* 跳过该条 */ }
    }
    if (injected === 0) throw authError('staged Cookies 注入失败');
  }
}

export async function verifyChromeProfile(
  executable: string,
  profileDir: string,
  url: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const cookies = readStagedChromeCookies(profileDir, env);
  let launched: LaunchedChromium | null = null;
  let session: Awaited<ReturnType<typeof openCdpSession>> | undefined;
  try {
    launched = await launchChromium(executable, profileDir, env, { mockKeychain: false });
    session = await openCdpSession(launched.baseUrl);
    const sessionId = await attachToPage(session);
    if (cookies.length > 0) await injectStagedCookies(session, sessionId, cookies);
    const probe = await probeAuthState(session, sessionId, url, { expectedUrl: url });
    if (probe.probeError) {
      throw authError(`staged profile 验证失败：导航错误或页面未落地（最终 URL: ${stripQuery(probe.finalUrl) || '(空)'}；已注入 ${cookies.length} 条 cookie）`);
    }
    if (!isAtUrl(probe.finalUrl, url)) {
      throw authError(`staged profile 未到达 --url（期望: ${stripQuery(url)}，最终: ${stripQuery(probe.finalUrl) || '(空)'}；已注入 ${cookies.length} 条 cookie）`);
    }
    return probe.finalUrl;
  } catch (error) {
    if (error instanceof ChromeAuthError) throw error;
    const detail = safeErrorDetail(error);
    throw authError(`staged profile 启动或验证失败${detail ? `（${detail}）` : ''}`);
  } finally {
    if (session) {
      // 走正常退出路径，Chrome 才会把注入的 cookie 用它当前的加密方案落盘；SIGTERM 会丢
      await session.send('Browser.close').catch(() => {});
      try { session.close(); } catch { /* ignore */ }
    }
    if (launched) await stopLaunchedChromium(launched);
  }
}

export interface ImportChromeProfileOpts {
  executable: string;
  userDataDir: string;
  profileDirectory: string;
  url: string;
  env: NodeJS.ProcessEnv;
  verify?: VerifyChromeProfileFn;
  copy?: (userDataDir: string, profileDirectory: string, stagingDir: string, env: NodeJS.ProcessEnv) => void;
}

export interface ImportedChromeProfile {
  profilePath: string;
  profileDirectory: string;
  finalUrl: string;
}

export async function importChromeProfile(opts: ImportChromeProfileOpts): Promise<ImportedChromeProfile> {
  const versionsDir = profileVersionsPath(opts.env);
  fs.mkdirSync(versionsDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(versionsDir, 0o700);
  const stagingDir = fs.mkdtempSync(path.join(versionsDir, '.staging-'));
  try {
    fs.chmodSync(stagingDir, 0o700);
    (opts.copy ?? copyChromeProfile)(opts.userDataDir, opts.profileDirectory, stagingDir, opts.env);
    normalizeStagedProfile(stagingDir, opts.profileDirectory);
    removeProfileRuntimeFiles(stagingDir);
    const finalUrl = await (opts.verify ?? verifyChromeProfile)(opts.executable, stagingDir, opts.url, opts.env);
    if (!isAtUrl(finalUrl, opts.url)) {
      throw authError(`staged profile 未到达 --url（最终: ${stripQuery(finalUrl) || '(空)'}）`);
    }
    removeProfileRuntimeFiles(stagingDir);
    const versionPath = installProfileVersion(stagingDir, opts.env);
    return {
      profilePath: versionPath,
      profileDirectory: opts.profileDirectory,
      finalUrl,
    };
  } catch (error) {
    try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch { /* ignore */ }
    if (error instanceof ChromeAuthError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    const detail = error instanceof Error ? error.message : '';
    throw authError(`Chrome profile 安装失败，旧 profile 未改变${code ? `（${code}）` : detail ? `（${detail}）` : ''}`);
  }
}
