import * as fs from 'node:fs';
import {
  cleanupOrphanBrowser,
  generateSessionId,
  isPidAlive,
  listSessions,
  readMeta,
  resolveSocketPath,
  sessionsDir,
  traceDir,
  writeMeta,
} from '../daemon/session-meta.js';
import { DaemonClient, DaemonClientError } from '../daemon/client.js';
import type { AuthMode } from '../auth-resolve.js';
import type { BrowserMode } from '../browser/daemon-client.js';
import { incompatibleBrowserAuth } from '../browser/daemon-client.js';
import { explicitAuthStateInputError } from '../browser/managed-browser.js';
import { cliDistPath, diag, emitError, emitOk, EXIT_ENV, EXIT_USAGE, EXIT_VALIDATION, type Deps } from './context.js';
import { parseArgs } from './args.js';
import { commandDefinitions } from './commands.js';
import { redactEndpoint } from './auth.js';
import { AcceptanceInputError, freezeAcceptance, readAcceptanceInput } from '../report/acceptance.js';

const ENV_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function getArgs(name: string, sub?: string) {
  return commandDefinitions().find((c) => c.name === name && c.subcommand === sub)?.args ?? [];
}

export async function handleSession(d: Deps, argv: string[]): Promise<number> {
  const sub = argv[0];
  if (!sub) return emitError(d, 'USAGE', 'session 需要子命令 (start|stop|list)', undefined, EXIT_USAGE);
  switch (sub) {
    case 'start': return await sessionStart(d, argv.slice(1));
    case 'stop': return await sessionStop(d, argv.slice(1));
    case 'list': return sessionList(d, argv.slice(1));
    default: return emitError(d, 'USAGE', `session 未知子命令: ${sub}`, 'start|stop|list', EXIT_USAGE);
  }
}

async function sessionStart(d: Deps, argv: string[]): Promise<number> {
  const { values, errors } = parseArgs(argv, getArgs('session', 'start'));
  if (errors.length) return emitError(d, 'USAGE', errors.join('; '), undefined, EXIT_USAGE);
  const env = values['--env'] ?? 'default';
  if (!ENV_LABEL_RE.test(env)) {
    return emitError(d, 'USAGE', '--env 只允许字母数字开头，后续可为字母数字、点、下划线、连字符', undefined, EXIT_USAGE);
  }
  const authMode = (values['--auth'] as AuthMode) ?? 'auto';
  const browserMode = (values['--browser'] as BrowserMode) ?? 'auto';
  const conflict = incompatibleBrowserAuth(browserMode, authMode);
  if (conflict) return emitError(d, 'USAGE', conflict, undefined, EXIT_USAGE);
  const childEnv = { ...d.env };
  delete childEnv.E2ET_RUN_ACCEPTANCE_DIR;
  delete childEnv.E2ET_RUN_ID;
  if (authMode === 'profile' || browserMode === 'chrome') delete childEnv.E2ET_AUTH_STATE;
  const authStateError = explicitAuthStateInputError(childEnv);
  if (authStateError) return emitError(d, 'USAGE', authStateError, undefined, EXIT_USAGE);
  const id = generateSessionId();
  try {
    const acceptance = readAcceptanceInput(values['--acceptance']);
    if (acceptance) {
      const directory = traceDir(id, d.env);
      freezeAcceptance(acceptance, directory);
      childEnv.E2ET_RUN_ACCEPTANCE_DIR = directory;
    }
  } catch (error) {
    if (error instanceof AcceptanceInputError) return emitError(d, error.code, error.message, undefined, EXIT_USAGE);
    throw error;
  }
  const socketPath = resolveSocketPath(id, d.env);
  fs.mkdirSync(sessionsDir(d.env), { recursive: true });
  try { fs.rmSync(socketPath, { force: true }); } catch { /* ignore */ }
  const cliPath = d.cliPath || cliDistPath();
  if (!d.cliPath && !fs.existsSync(cliPath)) {
    return emitError(d, 'ENV_UNAVAILABLE', `CLI 产物不存在: ${cliPath}`, '先 npm run build', EXIT_ENV);
  }
  const child = d.spawner(id, env, socketPath, cliPath, authMode, browserMode, childEnv);
  const { ready, error } = await d.readyWaiter(socketPath, id, 30_000);
  if (!ready) {
    if (child && child.pid) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch {
        try { process.kill(child.pid, 'SIGKILL'); } catch {}
      }
    }
    const orphanMeta = readMeta(id, d.env);
    if (orphanMeta) cleanupOrphanBrowser(orphanMeta);
    try { fs.rmSync(socketPath, { force: true }); } catch { /* ignore */ }
    return emitError(d, 'ENV_UNAVAILABLE', `daemon 启动失败: ${error ?? '未知'}`, '检查浏览器可用性（E2ET_CDP_URL / 登录态）', EXIT_ENV);
  }
  const meta = readMeta(id, d.env);
  return emitOk(d, {
    session_id: id,
    socket: socketPath,
    pid: meta?.pid,
    tab_id: meta?.tab_id,
    ...(meta?.browser_context_id ? { browser_context_id: meta.browser_context_id } : {}),
    browser_endpoint: redactEndpoint(meta?.browser_endpoint),
    env,
    started_at: meta?.started_at,
    ...(meta?.auth_source ? { auth_source: meta.auth_source } : {}),
    ...(meta?.browser_source ? { browser_source: meta.browser_source } : {}),
  });
}

async function sessionStop(d: Deps, argv: string[]): Promise<number> {
  const { values, errors } = parseArgs(argv, getArgs('session', 'stop'));
  if (errors.length) return emitError(d, 'USAGE', errors.join('; '), undefined, EXIT_USAGE);
  const id = values['-s'];
  const meta = readMeta(id, d.env);
  if (!meta) return emitError(d, 'NOT_FOUND', `会话不存在: ${id}`, 'e2et session list', EXIT_VALIDATION);
  if (meta.session_end) {
    try { fs.rmSync(meta.socket, { force: true }); } catch { /* ignore */ }
    return emitOk(d, { session_id: id, result: meta.session_end.result, already_stopped: true });
  }
  if (!isPidAlive(meta.pid)) {
    writeMeta({ ...meta, session_end: { result: 'aborted', ended_at: Date.now() } }, d.env);
    try { fs.rmSync(meta.socket, { force: true }); } catch { /* ignore */ }
    return emitOk(d, { session_id: id, result: 'aborted', hint: 'daemon 进程已不在，标记 aborted' });
  }
  let client: DaemonClient;
  try {
    client = await DaemonClient.connect(meta.socket, { connectTimeoutMs: 3000 });
  } catch {
    try { process.kill(meta.pid, 'SIGTERM'); } catch { /* ignore */ }
    writeMeta({ ...meta, session_end: { result: 'aborted', ended_at: Date.now() } }, d.env);
    try { fs.rmSync(meta.socket, { force: true }); } catch { /* ignore */ }
    return emitOk(d, { session_id: id, result: 'aborted', hint: 'socket 不可连，已 SIGTERM 并标记 aborted' });
  }
  try {
    const data = await client.request('stop', {}, { requestTimeoutMs: 15_000 }) as { result?: string; session_id?: string };
    const result = data?.result ?? 'aborted';
    return emitOk(d, { session_id: id, result });
  } catch (error) {
    if (error instanceof DaemonClientError) {
      const unknown = error.code === 'REQUEST_TIMEOUT' || error.code === 'REQUEST_INTERRUPTED';
      return emitError(d, error.code, error.message, error.hint, unknown ? EXIT_ENV : EXIT_VALIDATION);
    }
    diag(d, `[session stop] stop 请求失败: ${(error as Error).message}`);
    try { process.kill(meta.pid, 'SIGKILL'); } catch { /* ignore */ }
    const fresh = readMeta(id, d.env);
    if (fresh?.session_end) {
      try { fs.rmSync(fresh.socket, { force: true }); } catch { /* ignore */ }
      return emitOk(d, { session_id: id, result: fresh.session_end.result });
    }
    writeMeta({ ...meta, session_end: { result: 'aborted', ended_at: Date.now() } }, d.env);
    try { fs.rmSync(meta.socket, { force: true }); } catch { /* ignore */ }
    return emitOk(d, { session_id: id, result: 'aborted', hint: 'daemon 收尾超时，已强杀并标记 aborted' });
  } finally {
    client.close();
  }
}

function sessionList(d: Deps, _argv: string[]): number {
  const sessions = listSessions(d.env);
  for (const s of sessions) {
    if (s.status === 'aborted' && s.socket) {
      try { fs.rmSync(s.socket, { force: true }); } catch { /* ignore */ }
    }
  }
  return emitOk(d, { sessions: sessions.map((s) => ({
    id: s.id,
    pid: s.pid,
    status: s.status,
    env: s.env,
    started_at: s.started_at,
    socket: s.socket,
    tab_id: s.tab_id,
    ...(s.browser_endpoint ? { browser_endpoint: redactEndpoint(s.browser_endpoint) } : {}),
    ...(s.session_end ? { result: s.session_end.result } : {}),
  })) });
}
