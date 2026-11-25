/**
 * 登录态来源解析 + auth import。
 *
 * 两种来源：
 * - profile：合法 current 指针指向的版本母本，否则 legacy <e2etRoot>/e2e-profile；副本启动，无 cookie 注入
 * - imported：显式 E2ET_AUTH_STATE，否则 <e2etRoot>/auth/imported.json
 *
 * auto 顺序：profile → imported。某来源母本/文件不存在或不是标准结构就跳过
 * （到期 cookie 是事实不是拒绝理由）。探测只看技术性结果（probeError），不判定业务登录页。
 * 探测失败（显式探测 URL 导航抛错 / chrome-error）→ 该来源不可用，继续下一个。
 * 有 E2ET_CDP_URL 时 profile 不适用，跳过。
 * --auth 显式指定时只试这一个，不降级；全部失败 → AuthResolveError（exit 3）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { checkAuthFreshness, validateStorageState } from './browser/auth-check.js';
import { authStatePath, explicitAuthStateInputError, injectAndProbeAuthState, resolveChromiumExecutable, resolveSystemChrome, AuthCleanupError } from './browser/managed-browser.js';
import { resolveBrowserChoices, type BrowserChoice, type BrowserMode } from './browser/daemon-client.js';
import { profileMasterPath, profileMasterExists, profileMasterComplete } from './browser/profile-browser.js';
import { e2etRoot } from './daemon/session-meta.js';
import { buildAuthSummary, type AuthSummary, type CookieLike } from './shared/auth-state.js';

/** 两种来源：profile（母本 profile 副本启动，无 cookie 注入）/ imported（注入标准 storageState） */
export type AuthSource = 'profile' | 'imported';
export type AuthMode = 'auto' | AuthSource;
export type BrowserSource = 'managed' | 'existing' | 'chrome-profile';

// —— 路径解析 ——

/** imported 来源路径：<e2etRoot>/auth/imported.json */
export function importedAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(e2etRoot(env), 'auth', 'imported.json');
}

export function resolveAuthPath(source: AuthSource, env: NodeJS.ProcessEnv = process.env): string {
  if (source === 'imported') return authStatePath(env);
  return profileMasterPath(env);
}

/** auto 解析顺序：profile → imported（profile 母本存在时优先用副本启动，无 cookie 注入） */
export function autoAuthOrder(): AuthSource[] {
  return ['profile', 'imported'];
}

export function sourcesForMode(mode: AuthMode): AuthSource[] {
  return mode === 'auto' ? autoAuthOrder() : [mode];
}

/** 显式 state 是本次执行输入；auto 必须择优 imported，不能先试 profile。 */
export function effectiveAuthMode(mode: AuthMode, env: NodeJS.ProcessEnv = process.env): AuthMode {
  return mode === 'auto' && Object.hasOwn(env, 'E2ET_AUTH_STATE') ? 'imported' : mode;
}

// —— 静态状态（status / doctor / preflight 用，不需浏览器）——

export interface AuthSourceStaticState {
  source: AuthSource;
  path: string;
  present: boolean;
  /** imported/ci：标准 storageState 结构校验结果；profile：null（cookie 加密，静态无法验证业务有效性） */
  valid: boolean | null;
  /** 已到期的输入 cookie 名（事实，不代表登录有效/无效） */
  expired: string[];
  reason?: string;
}

export function staticAuthSourceState(source: AuthSource, env: NodeJS.ProcessEnv = process.env): AuthSourceStaticState {
  if (source === 'profile') {
    const p = profileMasterPath(env);
    const present = profileMasterExists(env);
    const complete = present ? profileMasterComplete(env) : { complete: false, missing: [] };
    return {
      source: 'profile',
      path: p,
      present,
      valid: present && complete.complete ? null : false,
      expired: [],
      ...(present && !complete.complete
        ? { reason: `profile 母本不完整（缺少: ${complete.missing.join(', ')}）—— 先 auth login 或 auth import --chrome --url <url>` }
        : present ? {} : { reason: `profile 母本不存在: ${p} —— 先 auth login 或 auth import` }),
    };
  }
  const inputError = explicitAuthStateInputError(env);
  if (inputError) {
    return { source, path: '', present: false, valid: false, expired: [], reason: inputError };
  }
  const p = resolveAuthPath(source, env);
  const f = checkAuthFreshness(p);
  return {
    source,
    path: p,
    present: f.present,
    valid: f.valid,
    expired: f.expired,
    ...(f.reason ? { reason: f.reason } : {}),
  };
}

// —— 探测（managed 模式）——

export interface ProbeResult {
  finalUrl: string;
  /** 探测失败（显式探测 URL 导航抛错 / chrome-error）—— 来源不可用，继续下一个 */
  probeError?: string;
}

/** 探测函数签名：注入指定路径的 cookie 并按 E2ET_AUTH_PROBE_URL 显式输入探测（无输入则不导航） */
export type ProbeAuthFn = (authPath: string) => Promise<ProbeResult>;

export type AuthSourceFailureReason =
  | 'file_missing'
  | 'invalid_format'
  | 'inject_failed'
  | 'probe_failed'
  | 'not_applicable';

export interface AuthSourceFailure {
  source: AuthSource;
  reason: AuthSourceFailureReason;
  detail: string;
}

export class AuthResolveError extends Error {
  readonly failures: AuthSourceFailure[];
  constructor(failures: AuthSourceFailure[]) {
    const perSource = failures.map((f) => `${f.source}: ${f.detail}`).join('; ');
    super(
      `auth resolve 失败 —— ${perSource}\n` +
      `补救：e2et auth import（导入 storageState / 显式 --domain 的 cookie 头）或 e2et auth login`,
    );
    this.name = 'AuthResolveError';
    this.failures = failures;
  }
}

/** profile 探测函数签名：启动 profile 副本并探测，无 cookie 注入。无 authPath 参数。 */
export type ProfileProbeFn = () => Promise<ProbeResult>;

export interface ResolveAuthOpts {
  /** managed 浏览器 baseUrl（imported/ci 注入探测用；profile 不用） */
  baseUrl: string;
  authMode: AuthMode;
  env?: NodeJS.ProcessEnv;
  /** imported/ci 注入探测函数（测试注入用）；默认走 injectAndProbeAuthState */
  probeAuth?: ProbeAuthFn;
  /** profile 探测函数；生产由 defaultBootstrap 注入 launchProfileAndProbe */
  profileProbe: ProfileProbeFn;
  /** 现成浏览器 endpoint；设了则 profile 不适用，跳过 */
  cdpUrl?: string | null;
  /** 由已选浏览器决定 profile 是否可用（managed/existing 不可用）。 */
  profileAllowed?: boolean;
}

export interface ResolvedAuth {
  authSource: AuthSource;
}

export interface SessionCandidate {
  browser: BrowserChoice;
  authMode: AuthMode;
  valid: AuthSource[];
  failures: AuthSourceFailure[];
  unavailable?: string;
}

export async function resolveSessionCandidates(
  browserMode: BrowserMode,
  authMode: AuthMode,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SessionCandidate[]> {
  authMode = effectiveAuthMode(authMode, env);
  const choices = await resolveBrowserChoices(browserMode, authMode, profileMasterExists(env), env);
  return choices.map((browser) => {
    const candidateAuth = browser.kind === 'chrome' ? 'profile' : authMode;
    const pre = preflightAuthSources(candidateAuth, env, undefined, browser.kind === 'existing' ? browser.endpoint : null, browser.kind === 'chrome');
    const unavailable = browser.kind === 'chrome' && !resolveSystemChrome(env)
      ? '找不到系统 Google Chrome：profile 需要系统 Chrome（不能用 Playwright Chromium）'
      : browser.kind === 'managed' && !resolveChromiumExecutable(env)
        ? '找不到 Chromium：设 BROWSER_EXECUTABLE_PATH、PUPPETEER_EXECUTABLE_PATH、CHROME_EXECUTABLE_PATH，或安装 Chromium'
        : undefined;
    return { browser, authMode: candidateAuth, valid: pre.valid, failures: pre.failures, ...(unavailable ? { unavailable } : {}) };
  });
}

/**
 * 静态预检：返回可用来源列表（不需浏览器）。
 * - profile：完整母本目录存在即 valid（结构未知，留待浏览器探测）；
 * - imported/ci：文件存在 + 标准 storageState 结构（到期 cookie 是事实，不拒绝）。
 * 有 cdpUrl 时 profile 标记 not_applicable 跳过。managed 启动前先调，全部不可用就不起浏览器。
 */
export function preflightAuthSources(
  mode: AuthMode,
  env: NodeJS.ProcessEnv = process.env,
  _nowSec?: number,
  cdpUrl: string | null = env.E2ET_CDP_URL ?? null,
  profileAllowed = !cdpUrl,
): { valid: AuthSource[]; failures: AuthSourceFailure[] } {
  mode = effectiveAuthMode(mode, env);
  const sources = sourcesForMode(mode);
  const valid: AuthSource[] = [];
  const failures: AuthSourceFailure[] = [];
  for (const source of sources) {
    if (source === 'profile') {
      if (!profileAllowed) {
        failures.push({ source, reason: 'not_applicable', detail: '当前浏览器端点不支持 profile' });
        continue;
      }
      if (!profileMasterExists(env)) {
        failures.push({ source, reason: 'file_missing', detail: `profile 母本不存在: ${profileMasterPath(env)}` });
        continue;
      }
      const complete = profileMasterComplete(env);
      if (!complete.complete) {
        failures.push({ source, reason: 'invalid_format', detail: `profile 母本不完整（缺少: ${complete.missing.join(', ')}）` });
        continue;
      }
      valid.push(source);
      continue;
    }
    const inputError = explicitAuthStateInputError(env);
    if (inputError) {
      failures.push({ source, reason: 'invalid_format', detail: inputError });
      continue;
    }
    const p = resolveAuthPath(source, env);
    const f = checkAuthFreshness(p);
    if (!f.present) {
      failures.push({ source, reason: 'file_missing', detail: `文件不存在: ${p}` });
      continue;
    }
    if (!f.valid) {
      failures.push({ source, reason: 'invalid_format', detail: `不是标准 storageState: ${f.reason ?? ''}` });
      continue;
    }
    valid.push(source);
  }
  return { valid, failures };
}

/**
 * 解析 + 探测登录态来源。
 * - auto：按 profile → imported → ci 顺序；profile 用 profileProbe（副本启动，无注入），
 *   imported/ci 用 probeAuth（managed 浏览器注入 + 显式探测 URL，未设则不导航）。
 * - profile 探测失败 → 杀副本+删目录（由 profileProbe 负责）→ 降级到 imported/ci。
 * - 显式 --auth：只试这一个，不降级。
 * - 有 cdpUrl 时 profile 不适用，preflight 已过滤。
 * - 全部失败 → AuthResolveError（exit 3）。
 */
export async function resolveAndProbeAuth(opts: ResolveAuthOpts): Promise<ResolvedAuth> {
  const env = opts.env ?? process.env;
  const cdpUrl = opts.cdpUrl !== undefined ? opts.cdpUrl : env.E2ET_CDP_URL ?? null;
  const probeAuth = opts.probeAuth ?? defaultProbeAuth(opts.baseUrl);
  const authMode = effectiveAuthMode(opts.authMode, env);

  // 复用 preflightAuthSources 做静态筛选（profile present / imported/ci 标准结构）
  const { valid, failures } = preflightAuthSources(authMode, env, undefined, cdpUrl, opts.profileAllowed ?? !cdpUrl);

  for (const source of valid) {
    if (source === 'profile') {
      let probe: ProbeResult;
      try {
        probe = await opts.profileProbe();
      } catch (e) {
        failures.push({ source, reason: 'inject_failed', detail: `profile 探测异常: ${(e as Error).message}` });
        continue;
      }
      if (probe.probeError) {
        failures.push({ source, reason: 'probe_failed', detail: probe.probeError });
        continue;
      }
      return { authSource: source };
    }
    // imported/ci：注入探测
    const p = resolveAuthPath(source, env);
    let probe: ProbeResult;
    try {
      probe = await probeAuth(p);
    } catch (e) {
      // P4：回滚失败的 AuthCleanupError 立即上抛——context 带残留状态时不能降级试下一身份；
      // 由 defaultBootstrap 既有 owned browser/context 处置负责彻底清理
      if (e instanceof AuthCleanupError) throw e;
      failures.push({ source, reason: 'inject_failed', detail: `注入失败: ${(e as Error).message}` });
      continue;
    }
    if (probe.probeError) {
      failures.push({ source, reason: 'probe_failed', detail: probe.probeError });
      continue;
    }
    return { authSource: source };
  }
  throw new AuthResolveError(failures);
}

/** 默认探测函数：走真实 CDP 注入 + 显式探测 URL（无输入则不导航，返回当前 URL 事实） */
function defaultProbeAuth(baseUrl: string): ProbeAuthFn {
  return async (authPath: string): Promise<ProbeResult> => {
    return injectAndProbeAuthState(baseUrl, authPath);
  };
}

// —— auth import ——

/** USAGE 类错误（如裸 cookie 头缺 --domain）：CLI 以 exit 2 报，与解析/IO 失败区分 */
export class AuthUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthUsageError';
  }
}

export interface ImportAuthOpts {
  /** 原始输入内容（已从文件/stdin 读入） */
  input: string;
  env?: NodeJS.ProcessEnv;
  /** 裸 cookie 头的作用域（--domain）；cookies JSON/storageState 的 domain 来自输入，不由该参数改写 */
  domain?: string;
}

export interface ImportAuthResult {
  path: string;
  summary: AuthSummary;
}

/**
 * 校验 --domain：合法单一 DNS host（可带前导点表示域 cookie）。
 * 拒绝 URL / 路径 / 端口 / 空值 / 通配符，不猜默认。
 */
export function parseDomainArg(input: string): string {
  if (!input || input.length === 0) throw new AuthUsageError('--domain 不能为空');
  if (input.includes('://') || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(input) || /[/?#]/.test(input)) {
    throw new AuthUsageError(`--domain 只接受单一 DNS host（可带前导点），不接受 URL/路径/端口: ${input}`);
  }
  const host = input.replace(/^\./, '');
  if (host.includes('*')) throw new AuthUsageError(`--domain 不接受通配符: ${input}`);
  if (!/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/.test(host)) {
    throw new AuthUsageError(`--domain 不是合法 DNS host: ${input}`);
  }
  return input;
}

/** 解析三种输入格式为 cookies 数组：storageState / cookies 数组 / cookie 头字符串（需显式 domain）。
 *  P4：兼容层——只取 cookies；importAuth 用内部完整解析保留未知字段给标准校验。 */
export function parseAuthInput(input: string, domain?: string): CookieLike[] {
  return parseAuthStateInput(input, domain).cookies;
}

interface ParsedAuthState {
  cookies: CookieLike[];
  /** storageState 输入的 origins 原样保留（仅 undefined 才规范为 []；显式 null 交给校验拒绝） */
  origins: unknown;
  /** 同次解析的完整内存快照（保留未知字段，如非空 credentials——标准校验拒绝，不提前丢弃） */
  raw: Record<string, unknown>;
}

/** 单次 JSON.parse 解析三种输入：storageState（保留完整字段与 origins）/ cookies 数组（origins []）/ cookie 头（需显式 domain，origins []）。
 *  不把用户 state 拆成两个不同时刻的快照；未知非空状态不在解析层丢弃，交给标准校验拒绝。 */
function parseAuthStateInput(input: string, domain?: string): ParsedAuthState {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('输入为空');
  // 格式 1/2：JSON（只 parse 一次）
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    if (e instanceof SyntaxError) {
      // 格式 3：cookie 头字符串 a=b; c=d（缺作用域信息，必须显式 domain，写盘前拒绝）
      const cookies = parseCookieHeader(trimmed, domain);
      return { cookies, origins: [], raw: { cookies, origins: [] } };
    }
    throw e;
  }
  if (Array.isArray(parsed)) {
    // 格式 2：cookies 数组
    const cookies = normalizeCookies(parsed);
    return { cookies, origins: [], raw: { cookies: parsed, origins: [] } };
  }
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { cookies?: unknown }).cookies)) {
    // 格式 1：Playwright storageState——同次解析对象 spread，未知字段（credentials 等）保留给校验
    const obj = parsed as Record<string, unknown>;
    return {
      cookies: normalizeCookies(obj.cookies as unknown[]),
      origins: obj.origins === undefined ? [] : obj.origins,
      raw: { ...obj },
    };
  }
  throw new Error('JSON 既不是 cookies 数组也不是 storageState 对象（{cookies:[...]}）');
}

function normalizeCookies(arr: unknown[]): CookieLike[] {
  // 显式空数组是合法 state（cookies:[]）；不再把空数组当业务无 cookie 拒绝
  return arr.map((c, i) => {
    // T1: name 只要是字符串就接受（含空串 ""——Chrome 接受空 name，ci 来源注入一直正常）
    if (!c || typeof c !== 'object' || typeof (c as { name?: unknown }).name !== 'string') {
      throw new Error(`cookie 项 #${i} name 不是字符串`);
    }
    return c as CookieLike;
  });
}

function parseCookieHeader(header: string, domain?: string): CookieLike[] {
  // 裸 cookie 头无作用域信息：缺 --domain 在写盘前拒绝（USAGE）
  const scope = parseDomainArg(domain ?? '');
  const cookies: CookieLike[] = [];
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!name) continue;
    cookies.push({ name, value, domain: scope, path: '/', sameSite: 'None', secure: true });
  }
  if (cookies.length === 0) throw new Error('cookie 头无有效键值对（格式 a=b; c=d）');
  return cookies;
}

/**
 * auth import：单次解析输入 → 对完整内存快照跑标准结构校验（含 origins 与未知非空状态）→
 * 校验通过后才投影 {cookies, origins} 原子落盘到 <e2etRoot>/auth/imported.json。
 * P4：保留调用方 storageState 的 origins（不拆两个快照）；裸 cookie 头/cookies 数组仍构成 origins:[]；
 * 坏 origins/未知非空状态在写盘前拒绝，不覆盖已有输出，固定安全文案不带原字段名。
 * 不做业务 cookie/到期判据（到期是事实）；USAGE 错误（缺 --domain / 非法 --domain）
 * 与坏格式错误都在写盘前抛出，不覆盖已有 imported.json。成功原子 rename，权限 0600 / 目录 0700。
 */
export function importAuth(opts: ImportAuthOpts): ImportAuthResult {
  const env = opts.env ?? process.env;
  const state = parseAuthStateInput(opts.input, opts.domain);
  // 先校验完整快照：未知非空状态字段在此拒绝（不在解析层丢弃）
  const invalid = validateStorageState(state.raw);
  if (invalid) throw new Error(`输入不构成标准 storageState: ${invalid}`);
  const storageState = { cookies: state.cookies, origins: state.origins };
  const serialized = JSON.stringify(storageState);
  const target = importedAuthPath(env);
  const targetDir = path.dirname(target);
  fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  const tmpFile = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmpFile, serialized, { mode: 0o600 });
  try {
    // 原子 rename 到目标
    fs.renameSync(tmpFile, target);
    try { fs.chmodSync(target, 0o600); } catch { /* ignore */ }
    try { fs.chmodSync(targetDir, 0o700); } catch { /* ignore */ }
    return { path: target, summary: buildAuthSummary(state.cookies, serialized) };
  } catch (e) {
    try { fs.rmSync(tmpFile, { force: true }); } catch { /* ignore */ }
    throw e;
  }
}
