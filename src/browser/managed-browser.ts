/**
 * Managed 浏览器：无现成 CDP endpoint 时由 daemon.ts 自起 loopback-only 专用 Chromium，
 * 并从 storageState 注入已有登录态。
 *
 * 安全边界：
 * - remote-debugging 只绑 127.0.0.1，端口 0 由系统分配，不暴露公网；
 * - 绝不传 --remote-allow-origins=*；
 * - managed 自动启动只用本工具专用目录；显式 Chrome 导入只读取隔离副本；
 * - 登录态来自 storageState（默认 <e2etRoot>/auth/imported.json，
 *   可 E2ET_AUTH_STATE 覆盖），cookies 经 DevTools 协议 Network.setCookies 注入。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { validateStorageState, type StorageOrigin } from '../shared/auth-state.js';
import { isProcessAlive } from './process-utils.js';
import { e2etRoot } from '../daemon/session-meta.js';

const LAUNCH_TIMEOUT_MS = 15_000;

/** 启动后的 Chromium 句柄 */
export interface LaunchedChromium {
  pid: number;
  port: number;
  baseUrl: string;
  userDataDir: string;
  child: ChildProcess;
}

/**
 * 按 PID 杀进程组（detached spawn 的 child 是进程组组长）。
 * SIGTERM → 超时 SIGKILL 兜底。pid 无效时 no-op。
 */
export async function killProcessGroup(pid: number, timeoutMs = 3000): Promise<void> {
  if (!pid) return;
  const killer = new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      try { process.kill(-pid, 'SIGKILL'); } catch {
        try { process.kill(pid, 'SIGKILL'); } catch {}
      }
      resolve();
    }, timeoutMs);
    const poll = setInterval(() => {
      if (!isProcessAlive(pid)) {
        clearInterval(poll);
        clearTimeout(t);
        resolve();
      }
    }, 200);
  });
  try { process.kill(-pid, 'SIGTERM'); } catch {
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }
  await killer;
}

/**
 * 启动一个 Chromium 实例（loopback-only、端口 0 系统分配）。
 */
export interface LaunchChromiumOpts {
  /** 不带 --use-mock-keychain（profile 副本启动用，macOS 钥匙串加密的 cookie 才能解）。
   *  managed 临时目录启动保持 true（不依赖系统钥匙串）。默认 true。 */
  mockKeychain?: boolean;
  /** headless 覆盖；默认跟随 E2ET_MANAGED_HEADLESS 语义 */
  headless?: boolean;
  /** 显式 Chrome profile 目录名；仅隔离副本导入时指定。 */
  profileDirectory?: string;
  /** 进程已 spawn、endpoint 可用前同步通知；抛错时回收进程组后原样传播。 */
  onSpawn?: (pid: number) => void;
}

export async function launchChromium(
  executable: string,
  userDataDir: string,
  env: NodeJS.ProcessEnv = process.env,
  opts: LaunchChromiumOpts = {},
): Promise<LaunchedChromium> {
  const headless = opts.headless ?? (env.E2ET_MANAGED_HEADLESS !== '0');
  const mockKeychain = opts.mockKeychain ?? true;
  fs.mkdirSync(userDataDir, { recursive: true });

  const args = [
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--ignore-certificate-errors',
    '--window-size=1280,900',
    ...(opts.profileDirectory !== undefined ? [`--profile-directory=${opts.profileDirectory}`] : []),
    ...(mockKeychain ? ['--use-mock-keychain'] : []),
    ...(headless ? ['--headless=new'] : []),
    'about:blank',
  ];

  const child: ChildProcess = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  let stderrBuf = '';
  child.stderr?.on('data', (d: Buffer) => { stderrBuf += d.toString(); });
  if (child.pid && opts.onSpawn) {
    try {
      opts.onSpawn(child.pid);
    } catch (error) {
      await killProcessGroup(child.pid).catch(() => {});
      child.stderr?.removeAllListeners();
      child.stderr?.destroy();
      throw error;
    }
  }

  const baseUrl = await new Promise<string>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let poll: NodeJS.Timeout | undefined;
    const clearWaiters = (): void => {
      if (poll) clearInterval(poll);
      if (timer) clearTimeout(timer);
      poll = undefined;
      timer = undefined;
    };
    const fail = (message: string, kill: boolean): void => {
      if (settled) return;
      settled = true;
      clearWaiters();
      void (async () => {
        if (kill && child.pid && child.exitCode === null && child.signalCode === null) {
          await killProcessGroup(child.pid).catch(() => {});
        }
        child.stderr?.removeAllListeners();
        child.stderr?.destroy();
        reject(new Error(message));
      })();
    };
    timer = setTimeout(() => {
      fail(`Chromium 启动超时（${LAUNCH_TIMEOUT_MS}ms）\n${stderrBuf.slice(-500)}`, true);
    }, LAUNCH_TIMEOUT_MS);
    poll = setInterval(() => {
      if (settled) return;
      const m = stderrBuf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) {
        settled = true;
        clearWaiters();
        const http = m[1].replace(/^ws:\/\//, 'http://').replace(/\/devtools\/browser\/.*$/, '');
        resolve(http);
      }
    }, 100);
    child.once('exit', (code) => {
      fail(`Chromium 提前退出 code=${code}\n${stderrBuf.slice(-500)}`, false);
    });
    child.once('error', (e) => {
      fail(`Chromium 启动失败: ${e.message}`, true);
    });
  });

  const port = Number(new URL(baseUrl).port);
  return { pid: child.pid!, port, baseUrl, userDataDir, child };
}

/** 默认 auth state 路径：尊重 E2ET_HOME，不硬编码 os.homedir() */
export function defaultAuthStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(e2etRoot(env), 'auth', 'imported.json');
}

/** 显式 state 输入为空的固定诊断；未设置 E2ET_AUTH_STATE 时返回 undefined。 */
export function explicitAuthStateInputError(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!Object.hasOwn(env, 'E2ET_AUTH_STATE')) return undefined;
  if (env.E2ET_AUTH_STATE?.trim()) return undefined;
  return 'E2ET_AUTH_STATE 是空字符串或纯空白（显式空值不是合法 state 输入）';
}

/** auth state 路径：显式输入必须非空，否则默认个人 imported state。 */
export function authStatePath(env: NodeJS.ProcessEnv = process.env): string {
  const inputError = explicitAuthStateInputError(env);
  if (inputError) throw new Error(inputError);
  return env.E2ET_AUTH_STATE !== undefined ? env.E2ET_AUTH_STATE : defaultAuthStatePath(env);
}

async function fetchJson<T>(url: string, timeoutMs = 3000): Promise<T | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** 读取 storageState cookies（Playwright 格式），白名单映射成 CDP Network.setCookieParams。
 * Playwright 1.64.1 用字符串 partitionKey + 私有布尔 _crHasCrossSiteAncestor 表达分区；
 * 升级 Playwright 时需复验 Source 与编译回放的分区探针。 */
function loadStorageStateCookies(cookies: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  if (!Array.isArray(cookies) || cookies.length === 0) return [];
  return cookies.map((c) => {
    const out: Record<string, unknown> = { name: c.name, value: c.value };
    if (c.domain) out.domain = c.domain;
    if (c.path) out.path = c.path;
    if (typeof c.secure === 'boolean') out.secure = c.secure;
    if (typeof c.httpOnly === 'boolean') out.httpOnly = c.httpOnly;
    if (typeof c.expires === 'number' && c.expires > 0) out.expires = c.expires;
    if (c.sameSite && ['Strict', 'Lax', 'None'].includes(String(c.sameSite))) out.sameSite = c.sameSite;
    // Playwright 允许只有 url 没有 domain/path 的 cookie；两种都缺则丢弃
    if (!out.domain && c.url) out.url = c.url;
    if (typeof c.partitionKey === 'string') {
      out.partitionKey = {
        topLevelSite: c.partitionKey,
        hasCrossSiteAncestor: c._crHasCrossSiteAncestor ?? true,
      };
    }
    return out;
  }).filter((c) => c.domain || c.url);
}

/** P4：一次 read/parse/validate 得到 {cookies, origins}——cookies 与 origins 来自文件的同一时刻快照，
 *  不让两段逻辑各自读盘；origins 缺省规范为 []。cookie 走白名单投影送 Network.setCookies，
 *  origins 保留标准 StorageOrigin（供 restoreStorageOrigins 恢复），均不透传私有字段。 */
export interface LoadedAuthState {
  cookies: Array<Record<string, unknown>>;
  origins: StorageOrigin[];
}

export function loadAuthState(authPath: string): LoadedAuthState {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(authPath, 'utf8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`登录态文件不存在: ${authPath}`);
    throw new Error(`登录态文件不可解析（非合法 JSON）: ${authPath}`);
  }
  const reason = validateStorageState(raw);
  if (reason) throw new Error(`登录态文件不是标准 storageState: ${reason}`);
  const state = raw as { cookies?: Array<Record<string, unknown>>; origins?: StorageOrigin[] };
  // 空但显式提供的合法 state 是用户输入：注入 0 条 cookie，不偷偷匿名降级
  return { cookies: loadStorageStateCookies(state.cookies ?? []), origins: state.origins ?? [] };
}

export interface InjectAuthResult {
  finalUrl: string;
  /** 探测失败（显式探测 URL 导航抛错 / chrome-error / 导航后未落地）—— 来源不可用，继续下一个 */
  probeError?: string;
}

/** P4：登录态回滚失败——context 带残留状态时不能降级试下一身份，立即上抛由 owned 处置彻底清理 */
export class AuthCleanupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthCleanupError';
  }
}

// —— CDP 低层会话：注入探测 / profile 探测 / auth login / export 复用 ——

export interface CdpLowSession {
  send<T = any>(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<T>;
  addEventListener(method: string, handler: (params: any) => void): () => void;
  onClose(cb: () => void): void;
  close(): void;
  /** 等待连接确认断开，超时返回 false。不使用 sleep 猜测。 */
  waitClosed(timeoutMs: number): Promise<boolean>;
  /** 强制断开底层连接（terminate / RST），不等握手。 */
  forceClose(): void;
}

/** 打开 CDP browser-level WS 会话（注入探测 / profile 探测 / login / export 复用）。 */
export async function openCdpSession(baseUrl: string): Promise<CdpLowSession> {
  const version = await fetchJson<{ webSocketDebuggerUrl?: string }>(`${baseUrl}/json/version`, 3000);
  if (!version?.webSocketDebuggerUrl) throw new Error('CDP /json/version 无 webSocketDebuggerUrl');
  const { WebSocket } = await import('ws');
  const ws = new WebSocket(version.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('browser WS 连接超时')), 10_000);
    ws.once('open', () => { clearTimeout(t); resolve(); });
    ws.once('error', (e) => { clearTimeout(t); reject(e); });
  });
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  const eventListeners: Array<{ method: string; handler: (params: any) => void }> = [];
  ws.on('message', (raw: Buffer) => {
    let msg: any;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.id !== undefined) {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`CDP: ${msg.error.message}`));
      else p.resolve(msg.result ?? {});
      return;
    }
    if (msg.method) {
      for (const l of eventListeners) {
        if (l.method === msg.method) l.handler(msg.params ?? {});
      }
    }
  });
  const send = <T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP ${method} 超时`)); }, 15_000);
      pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  const addEventListener = (method: string, handler: (params: any) => void): (() => void) => {
    const entry = { method, handler };
    eventListeners.push(entry);
    return () => {
      const i = eventListeners.indexOf(entry);
      if (i !== -1) eventListeners.splice(i, 1);
    };
  };
  return {
    send, addEventListener,
    onClose: (cb) => { ws.on('close', cb); },
    close: () => ws.close(),
    waitClosed: (timeoutMs: number): Promise<boolean> => new Promise((resolve) => {
      if (ws.readyState === ws.CLOSED) return resolve(true);
      const done = () => { clearTimeout(t); resolve(true); };
      const t = setTimeout(() => { ws.off('close', done); resolve(false); }, timeoutMs);
      ws.once('close', done);
    }),
    forceClose: () => { ws.terminate(); },
  };
}

/**
 * 确认 owner WebSocket 已断开：close → 等 close 事件（短超时）→ forceClose → 再等。
 * 返回 true=已确认断开，false=超时无法确认。不使用 sleep 猜测，幂等。
 */
export async function confirmOwnerClosed(
  owner: CdpLowSession,
  closeTimeoutMs = 2000,
): Promise<boolean> {
  owner.close();
  if (await owner.waitClosed(closeTimeoutMs)) return true;
  owner.forceClose();
  return owner.waitClosed(closeTimeoutMs);
}

/** attach 到启动参数创建的 about:blank page，避开完整 profile 恢复出的历史业务标签；
 *  没有空白页时才回退第一个 page。返回 sessionId（注入探测 / profile 探测共用）。 */
export async function attachToPage(session: CdpLowSession): Promise<string> {
  const { targetInfos } = await session.send<{ targetInfos: Array<{ targetId: string; type: string; url?: string }> }>('Target.getTargets');
  const pages = targetInfos.filter((t) => t.type === 'page');
  const page = pages.find((t) => t.url === 'about:blank' || t.url === 'about://blank') ?? pages[0];
  if (!page) throw new Error('managed 浏览器没有 page target');
  const { sessionId } = await session.send<{ sessionId: string }>('Target.attachToTarget', { targetId: page.targetId, flatten: true });
  return sessionId;
}

export interface ProbeAuthStateOpts {
  /** 显式期望 URL：按 origin+pathname 命中才算落地；未提供时沿用“任意非错误页”语义。 */
  expectedUrl?: string;
  /** 显式 URL 的总轮询预算。Portal 免登实测 24~29s，默认至少覆盖 60s。 */
  totalTimeoutMs?: number;
  /** URL 轮询间隔。 */
  pollIntervalMs?: number;
}

const DEFAULT_AUTH_PROBE_TIMEOUT_MS = 60_000;
const DEFAULT_AUTH_PROBE_POLL_MS = 1_000;

function isLandedUrl(url: string): boolean {
  return !!url && url !== 'about:blank' && !url.startsWith('chrome-error://');
}

function matchesExpectedUrl(finalUrl: string, expectedUrl: string): boolean {
  if (!isLandedUrl(finalUrl)) return false;
  try {
    const actual = new URL(finalUrl);
    const expected = new URL(expectedUrl);
    return actual.origin === expected.origin && actual.pathname === expected.pathname;
  } catch {
    return false;
  }
}

function safeUrlForDiagnostic(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '(空)';
  }
}

/** 在已 attach 的会话里探测：显式 probeUrl 优先，否则 E2ET_AUTH_PROBE_URL 是调用方输入（无业务默认）。
 *  - 无该输入：不导航任何页面，返回当前 URL 事实（不声称登录有效）；
 *  - 有输入：先验 URL 合法（http(s)），启动导航后轮询 `location.href`；
 *    expectedUrl 存在时只认 origin+pathname 命中，否则认任意非 about:blank/chrome-error 的最终页。
 *  - Page.navigate 的 CDP promise 超时不代表页面未导航，继续轮询到总预算；errorText 仍直接失败。
 *  不注入 cookie、不清 cookie；所有出口都取消轮询并导回 about:blank。 */
export async function probeAuthState(
  session: CdpLowSession,
  sessionId: string,
  probeUrl = process.env.E2ET_AUTH_PROBE_URL,
  opts: ProbeAuthStateOpts = {},
): Promise<InjectAuthResult> {
  await session.send('Page.enable', {}, sessionId);
  if (!probeUrl) {
    // 无显式探测 URL：不导航，只读当前 URL
    try {
      const evalRes = await session.send<{ result?: { value?: string } }>(
        'Runtime.evaluate',
        { expression: 'location.href', returnByValue: true },
        sessionId,
      );
      return { finalUrl: evalRes.result?.value ?? '' };
    } catch (e) {
      return { finalUrl: '', probeError: `读取当前 URL 失败: ${(e as Error).message}` };
    }
  }
  // 显式 URL：导航前验证（只接受 http/https）
  let parsed: URL;
  try {
    parsed = new URL(probeUrl);
  } catch {
    throw new Error(`E2ET_AUTH_PROBE_URL 不是合法 URL（拒绝在导航前）`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`E2ET_AUTH_PROBE_URL 只接受 http(s) URL（当前 ${parsed.protocol}，拒绝在导航前）`);
  }
  if (opts.expectedUrl) {
    let expected: URL;
    try {
      expected = new URL(opts.expectedUrl);
    } catch {
      throw new Error('探测期望 URL 不是合法 URL（拒绝在导航前）');
    }
    if (expected.protocol !== 'http:' && expected.protocol !== 'https:') {
      throw new Error(`探测期望 URL 只接受 http(s) URL（当前 ${expected.protocol}，拒绝在导航前）`);
    }
  }
  const totalTimeoutMs = Math.max(1, opts.totalTimeoutMs ?? DEFAULT_AUTH_PROBE_TIMEOUT_MS);
  const pollIntervalMs = Math.max(1, opts.pollIntervalMs ?? DEFAULT_AUTH_PROBE_POLL_MS);
  const deadline = Date.now() + totalTimeoutMs;
  let finalUrl = '';
  let navigationError: string | undefined;

  const waitPoll = (): { promise: Promise<void>; cancel: () => void } => {
    let timer: NodeJS.Timeout | undefined;
    const promise = new Promise<void>((resolve) => {
      const remaining = deadline - Date.now();
      timer = setTimeout(resolve, Math.max(1, Math.min(pollIntervalMs, remaining)));
    });
    return {
      promise,
      cancel: () => {
        if (timer) clearTimeout(timer);
      },
    };
  };

  // Page.navigate 的单次 CDP promise 只用于尽早发现明确 errorText。超时/拒绝不终止 URL 轮询，
  // 因为导航可能已提交而 load 事件或响应 promise 永远不会到达。
  const navigationOutcome = session.send<{ errorText?: string }>('Page.navigate', { url: probeUrl }, sessionId).then(
    (result) => {
      if (result.errorText) navigationError = `导航失败: ${result.errorText}`;
      return navigationError;
    },
    () => undefined,
  );

  try {
    // 明确 errorText 若先返回，不必空等一个轮询周期；超时/拒绝会在下面继续。
    const firstPoll = waitPoll();
    try {
      await Promise.race([navigationOutcome, firstPoll.promise]);
    } finally {
      firstPoll.cancel();
    }
    if (navigationError) {
      return { finalUrl: '', probeError: navigationError };
    }

    while (Date.now() < deadline) {
      try {
        const evalRes = await session.send<{ result?: { value?: string } }>(
          'Runtime.evaluate',
          { expression: 'location.href', returnByValue: true },
          sessionId,
        );
        finalUrl = evalRes.result?.value ?? '';
      } catch {
        finalUrl = '';
      }
      if (navigationError) {
        return { finalUrl: '', probeError: navigationError };
      }
      if (opts.expectedUrl ? matchesExpectedUrl(finalUrl, opts.expectedUrl) : isLandedUrl(finalUrl)) {
        return { finalUrl };
      }
      if (Date.now() >= deadline) break;
      await waitPoll().promise;
    }

    if (opts.expectedUrl) {
      return {
        finalUrl,
        probeError: `探测未在 ${Math.ceil(totalTimeoutMs / 1000)}s 内到达期望 URL（最终 URL: ${safeUrlForDiagnostic(finalUrl)}）`,
      };
    }
    return { finalUrl, probeError: `探测未落地（最终 URL: ${safeUrlForDiagnostic(finalUrl)}）` };
  } finally {
    // 所有出口都导回 about:blank；迟到的导航 promise 已由 catch 侧消费，不再阻塞本次结果。
    await session.send('Page.navigate', { url: 'about:blank' }, sessionId).catch(() => {});
    await new Promise((r) => setTimeout(r, 200));
  }
}

/**
 * 向 managed 浏览器注入 storageState 登录态并探测（注入 + 探测两步复用）。
 *
 * 探测遵循 probeAuthState 语义：E2ET_AUTH_PROBE_URL 是调用方显式 URL 输入（无业务默认）；
 * 未设时不导航任何页面，返回当前 URL/注入事实；设了只检查导航与协议错误，不判定业务登录页。
 * 注入前只拒绝缺文件/坏格式（loadAuthState 单次读盘）；到期 cookie 是事实，不拒绝。
 * P4：注入完整 {cookies, origins}（同一快照）；任一注入/探测失败清 cookie 并回滚本次 origins，
 * 回滚失败抛 AuthCleanupError（调用方不得降级试下一身份）。
 */
export async function injectAndProbeAuthState(
  baseUrl: string,
  authStatePathArg?: string,
): Promise<InjectAuthResult> {
  const authPath = authStatePathArg ?? authStatePath();
  const state = loadAuthState(authPath);
  const session = await openCdpSession(baseUrl);
  try {
    const sessionId = await attachToPage(session);
    return await injectAndProbeInSession(session, sessionId, state);
  } finally {
    session.close();
  }
}

export async function injectAndProbeInSession(session: CdpLowSession, sessionId: string, state: LoadedAuthState): Promise<InjectAuthResult> {
  let passed = false;
  try {
    await session.send('Network.enable', {}, sessionId);
    await session.send('Network.setCookies', { cookies: state.cookies }, sessionId);
    if (state.origins.length > 0) {
      // 恢复标准 localStorage（interceptor 全清后才执行显式 probe，不留给真实业务页面）
      await restoreStorageOrigins(session, sessionId, state.origins);
    }
    const probeUrl = process.env.E2ET_AUTH_PROBE_URL;
    const probe = probeUrl
      ? await probeAuthState(session, sessionId, probeUrl, { expectedUrl: probeUrl })
      : await probeAuthState(session, sessionId);
    if (!probe.probeError) passed = true;
    return probe;
  } finally {
    // B2 + P4：任何非通过出口（注入/恢复/探测失败或抛异常）都清 cookie 并回滚本次 origins。
    // cookie 清理与 origins 回滚分别尝试，前一个失败不阻止后一个；任一失败 →
    // AuthCleanupError（固定安全文案，不带协议原文/cookie/localStorage 值），调用方不得
    // 在同一带残留状态的 context 上降级试下一身份，由 owned browser/context 处置彻底清理
    if (!passed) {
      let cleanupFailed = false;
      await session.send('Network.clearBrowserCookies', {}, sessionId).catch(() => { cleanupFailed = true; });
      if (state.origins.length > 0) {
        try {
          await restoreStorageOrigins(session, sessionId, state.origins, true);
        } catch {
          cleanupFailed = true;
        }
      }
      if (cleanupFailed) {
        throw new AuthCleanupError('登录态清理/回滚失败（context 可能带残留状态，拒绝继续尝试下一来源，由 owned browser/context 处置彻底清理）');
      }
    }
  }
}

/**
 * P4：恢复/回滚标准 StorageOrigin（localStorage）——仅本次自有 auth 初始化 target 使用。
 *
 * 本地 Playwright coreBundle setStorageState 同样用临时页面 + 请求拦截以固定 <html></html> 应答、
 * 逐 origin 导航后恢复存储，这是标准状态初始化，不是会话中的 API mock。
 *
 * 目标归属：CdpLowSession.addEventListener 只透传 params（openCdpSession 会丢外层 msg.sessionId），
 * 不能只凭 origin 或 Document 类型借其他 target 的事件——在自有 attached session 先取真实 main
 * frameId（Page.getFrameTree），frameNavigated 与 Fetch.requestPaused 均严格比对该 frameId
 * （同时 Document / 安全 origin），同 origin 的别的 frame/target 一律不接受。
 *
 * 生命周期（零外发合同）：Fetch 拦截本 target 全部资源类型（不只 Document），
 * Document 用固定 <html></html> + 显式 text/html Content-Type 应答，其余（含 favicon）
 * 惰性 204 应答封住——初始化期不触达 origin 服务器；导航等【匹配 frame 事件 +
 * 真实 Page.navigate 响应】双事实（errorText 非空即拒），之后才读 storage key；
 * finally 先回 about:blank 并等真实响应（拦截仍在线，封住迟到 favicon），
 * 之后才 off 监听 + Fetch.disable，每步都尝试；固定安全收尾失败拒继续。
 * 之后才执行调用方显式 probe。clearOnly 仅失败回滚用（清本次尝试 origins，不写值），
 * 不是公开扩展选项。不执行调用方 JS，不发送初始化请求到业务服务器。
 */
export async function restoreStorageOrigins(
  session: CdpLowSession,
  sessionId: string,
  origins: StorageOrigin[],
  clearOnly = false,
): Promise<void> {
  if (origins.length === 0) return;
  // 自有 attached session 的真实 main frameId：两处事件严格比对该 id
  const tree = await session.send<{ frameTree?: { frame?: { id?: unknown } } }>('Page.getFrameTree', {}, sessionId);
  const mainFrameId = tree?.frameTree?.frame?.id;
  if (typeof mainFrameId !== 'string' || mainFrameId === '') {
    throw new Error('无法取得 auth 初始化 target 的主 frame id，拒绝恢复 origins');
  }
  let currentOrigin: string | undefined;
  let frameWait: { resolve: () => void; origin: string } | undefined;
  const onPaused = (params: { requestId?: unknown; frameId?: unknown; resourceType?: unknown; request?: { url?: unknown } }): void => {
    const requestId = typeof params.requestId === 'string' ? params.requestId : undefined;
    if (!requestId) return;
    // foreign frame/target 不借用：不 fulfill 也不 continue（惰性 204 也不发），留给其 owner 处置
    if (params.frameId !== mainFrameId) return;
    // 本 owned 主 frame + Document + 当前恢复 origin → 固定空 HTML + 显式 text/html Content-Type
    let documentForCurrentOrigin = false;
    if (params.resourceType === 'Document') {
      const url = typeof params.request?.url === 'string' ? params.request.url : '';
      try { documentForCurrentOrigin = currentOrigin !== undefined && new URL(url).origin === currentOrigin; } catch { documentForCurrentOrigin = false; }
    }
    if (documentForCurrentOrigin) {
      session.send('Fetch.fulfillRequest', {
        requestId,
        responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }],
        body: Buffer.from('<html></html>').toString('base64'),
      }, sessionId).catch(() => {});
      return;
    }
    // 本 owned 主 frame 的其余请求（favicon 等非 Document、其它 origin）：owned 初始化期零外发
    // ——惰性 204 应答封在本 target，不 continue（continue 即触达服务器）
    session.send('Fetch.fulfillRequest', { requestId, responseCode: 204 }, sessionId).catch(() => {});
  };
  const onFrameNavigated = (params: { frame?: { id?: unknown; parentId?: unknown; url?: unknown } }): void => {
    const frame = params?.frame;
    // 只接受本 target 主 frame 的真实导航且安全源一致；同 origin 别的 frame/target 不算
    if (!frame || frame.parentId !== undefined || frame.id !== mainFrameId || !frameWait) return;
    const url = typeof frame.url === 'string' ? frame.url : '';
    let matches = false;
    try { matches = new URL(url).origin === frameWait.origin; } catch { matches = false; }
    if (matches) frameWait.resolve();
  };
  const offPaused = session.addEventListener('Fetch.requestPaused', onPaused);
  const offFrame = session.addEventListener('Page.frameNavigated', onFrameNavigated);
  try {
    await session.send('Page.enable', {}, sessionId);
    // 拦截本 attached 初始化 target 的全部资源类型（不只 Document）：初始化期零外发，
    // favicon 等非 Document 请求同样封住，不触达 origin 服务器
    await session.send('Fetch.enable', {}, sessionId);
    for (const origin of origins) {
      currentOrigin = origin.origin;
      // frame wait 先注册（监听已在导航前挂上）；导航响应在 then 里核对 errorText；
      // 立刻 await Promise.all([frame 事件, 真实导航响应])：事件先到（ack 前）不提前操作 storage、
      // 响应 errorText 非空即拒，且 frame 10s 超时不被后续 nav 等待拖延（任一侧先拒绝立即上抛）。
      // 定时器局部，所有成败出口都清；任一侧先失败后另一侧悬空承诺不成为 unhandled rejection
      let clearTimer: () => void = () => {};
      const frameEvent = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`origin ${origin.origin} 导航等待提交超时`)), 10_000);
        clearTimer = () => clearTimeout(timer);
        frameWait = {
          resolve: () => { clearTimer(); resolve(); },
          origin: origin.origin,
        };
      });
      const navResponse = session.send<{ errorText?: unknown }>('Page.navigate', { url: origin.origin }, sessionId)
        .then((res) => {
          if (typeof res?.errorText === 'string' && res.errorText !== '') {
            throw new Error(`origin ${origin.origin} 导航失败（固定安全文案，不透传 errorText）`);
          }
          return res;
        });
      frameEvent.catch(() => { /* nav 先拒绝时 frame 迟到拒绝不悬空 */ });
      navResponse.catch(() => { /* frame 先拒绝时 nav 迟到拒绝不悬空 */ });
      try {
        await Promise.all([frameEvent, navResponse]);
      } finally {
        frameWait = undefined;
        clearTimer();
      }
      // 导航提交后，用 Runtime.evaluate 操作 localStorage（同 Playwright setStorageState 方案），
      // 避免对合成响应 frame 调 Storage.getStorageKeyForFrame 的 opaque origin 错误
      const lsExpr = clearOnly
        ? 'localStorage.clear()'
        : `localStorage.clear();${origin.localStorage.map(e =>
            `localStorage.setItem(${JSON.stringify(e.name)},${JSON.stringify(e.value)})`
          ).join(';')}`;
      const evalRes = await session.send<{ exceptionDetails?: { text?: unknown } }>('Runtime.evaluate', {
        expression: lsExpr,
      }, sessionId);
      if (evalRes.exceptionDetails) {
        throw new Error(`origin ${origin.origin} localStorage 操作失败（固定安全文案）`);
      }
    }
  } finally {
    frameWait = undefined;
    currentOrigin = undefined;
    // 收尾顺序（零外发合同）：先回 about:blank 并等真实导航响应——拦截仍在线，
    // 封住旧文档/迟到的 favicon；之后才移除监听、disable Fetch。不先 disable
    // 让迟到 favicon 触达服务器。每步都尝试，前一步失败不阻止后一步
    let teardownFailed = false;
    await session.send<{ errorText?: unknown }>('Page.navigate', { url: 'about:blank' }, sessionId)
      .then((res) => {
        if (typeof res?.errorText === 'string' && res?.errorText !== '') teardownFailed = true;
      })
      .catch(() => { teardownFailed = true; });
    try { offPaused(); } catch { /* 监听已不可用也继续后续清理 */ }
    try { offFrame(); } catch { /* 同上 */ }
    await session.send('Fetch.disable', {}, sessionId).catch(() => { teardownFailed = true; });
    if (teardownFailed) throw new Error('auth 初始化 Fetch 拦截收尾失败（interceptor 可能残留，拒绝继续）');
  }
}
export const LINUX_SYSTEM_CHROMIUM = [
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
] as const;

/**
 * 解析 Chromium 可执行文件路径。
 * 优先级：BROWSER_EXECUTABLE_PATH → PUPPETEER_EXECUTABLE_PATH → CHROME_EXECUTABLE_PATH → ms-playwright 缓存 → 系统路径。
 * linux 系统路径覆盖 Debian 系 stable 命名（盒雁沙箱实测 /usr/bin/chromium-browser，Chromium 135）。
 */
export function resolveChromiumExecutable(
  env: NodeJS.ProcessEnv = process.env,
  platformOverride?: NodeJS.Platform,
  homeOverride?: string,
): string | null {
  for (const executable of [env.BROWSER_EXECUTABLE_PATH, env.PUPPETEER_EXECUTABLE_PATH, env.CHROME_EXECUTABLE_PATH]) {
    if (executable && fs.existsSync(executable)) return executable;
  }
  const platform = platformOverride ?? process.platform;
  const home = homeOverride ?? os.homedir();
  const darwinPaths = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  const cacheDir = platform === 'darwin'
    ? path.join(home, 'Library', 'Caches', 'ms-playwright')
    : path.join(home, '.cache', 'ms-playwright');
  let pwChromium = '';
  try {
    const dirs = fs.readdirSync(cacheDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^chromium-\d+$/.test(d.name))
      .sort((a, b) => Number(b.name.replace('chromium-', '')) - Number(a.name.replace('chromium-', '')));
    for (const d of dirs) {
      const candidates = platform === 'darwin'
        ? [path.join(cacheDir, d.name, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium')]
        : [path.join(cacheDir, d.name, 'chrome-linux', 'chrome')];
      for (const c of candidates) {
        if (fs.existsSync(c)) { pwChromium = c; break; }
      }
      if (pwChromium) break;
    }
  } catch {}
  const candidates = [
    pwChromium,
    ...(platform === 'darwin' ? darwinPaths : [...LINUX_SYSTEM_CHROMIUM]),
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/**
 * N2: 解析系统 Google Chrome 可执行文件路径（auth login / profile 副本 / auth export 专用）。
 * 不走 Playwright Chromium 优先的 resolveChromiumExecutable：macOS 上 Chrome 与 Chromium 的
 * 钥匙串条目不同（"Chrome Safe Storage" vs "Chromium Safe Storage"），用 Chromium 打开系统 Chrome
 * 建的 profile 解不开 cookie。
 * 优先级：CHROME_EXECUTABLE_PATH → 系统 Google Chrome（macOS .app / Linux google-chrome-stable）。
 * 找不到 → null（调用方 exit 3）。
 */
export function resolveSystemChrome(
  env: NodeJS.ProcessEnv = process.env,
  platformOverride?: NodeJS.Platform,
): string | null {
  if (env.CHROME_EXECUTABLE_PATH && fs.existsSync(env.CHROME_EXECUTABLE_PATH)) {
    return env.CHROME_EXECUTABLE_PATH;
  }
  const platform = platformOverride ?? process.platform;
  const candidates = platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    : ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium'];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}
