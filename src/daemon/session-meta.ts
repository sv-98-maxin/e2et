/**
 * 会话元数据读写 + socket 路径解析 + 存活判定。
 *
 * 元数据 SSOT：~/.e2et/sessions/{id}.json。socket 默认同目录 {id}.sock；
 * macOS unix socket 路径上限 104 字节，超长时退到 os.tmpdir() 下的短路径，
 * 实际 socket 路径记入元数据，客户端一律读元数据拿 socket，不拼路径。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { isProcessAlive } from '../browser/process-utils.js';

/** 同步阻塞等待 ms 毫秒，不起子进程（避免繁忙机器 spawnSync ETIMEDOUT）。 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** e2et 根目录：默认 ~/.e2et，可用 E2ET_HOME 覆盖（沙箱/测试）。 */
export function e2etRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.E2ET_HOME ?? path.join(os.homedir(), '.e2et');
}
export function sessionsDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(e2etRoot(env), 'sessions');
}
export function traceRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(e2etRoot(env), 'workspace', 'traces');
}

/** macOS unix socket 路径上限（SUN_LEN - 1）。留余量给 NUL 终止。 */
const SOCKET_PATH_MAX = 100;

export interface SessionEnd {
  result: 'pass' | 'fail' | 'blocked' | 'aborted';
  ended_at: number;
}

export interface SessionMeta {
  id: string;
  pid: number;
  socket: string;
  tab_id?: string;
  browser_endpoint?: string;
  browser_context_id?: string;
  browser_version?: string;
  browser_pid?: number;
  browser_port?: number;
  browser_user_data_dir?: string;
  transport?: string;
  started_at: number;
  env: string;
  /** 录制事实的安全来源标签；本 CLI 当前只产生 profile/imported。 */
  auth_source?: string;
  /** 浏览器来源：managed（自起临时 Chromium）/ existing（native-cdp 直连）/ chrome-profile（专用 profile 副本） */
  browser_source?: 'managed' | 'existing' | 'chrome-profile';
  /** daemon 启动失败时写入，CLI 据此快速报错 */
  error?: string;
  /** 优雅退出后补写 */
  session_end?: SessionEnd;
  /** 孤儿回收已执行（防重复杀） */
  orphan_cleaned?: boolean;
  /** 清理竞态阻断：owner 断链无法确认，禁止降级（保留 context 供诊断） */
  cleanup_blocked?: boolean;
  /** cleanup_blocked 的原因 */
  cleanup_reason?: string;
}

export function traceDir(id: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(traceRoot(env), id);
}

export function metaPath(id: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(sessionsDir(env), `${id}.json`);
}

/**
 * socket 路径：优先 sessions 目录；超 100 字节退到 os.tmpdir() 短路径。
 * 返回的路径会被写入元数据，客户端不自己拼。
 */
export function resolveSocketPath(id: string, env: NodeJS.ProcessEnv = process.env): string {
  const primary = path.join(sessionsDir(env), `${id}.sock`);
  if (primary.length <= SOCKET_PATH_MAX) return primary;
  return path.join(os.tmpdir(), `e2et-${id}.sock`);
}

export function readMeta(id: string, env: NodeJS.ProcessEnv = process.env): SessionMeta | null {
  try {
    return JSON.parse(fs.readFileSync(metaPath(id, env), 'utf-8')) as SessionMeta;
  } catch {
    return null;
  }
}

export function writeMeta(meta: SessionMeta, env: NodeJS.ProcessEnv = process.env): void {
  fs.mkdirSync(sessionsDir(env), { recursive: true });
  const target = metaPath(meta.id, env);
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(meta, null, 2), { encoding: 'utf-8', mode: 0o600 });
  fs.renameSync(temporary, target);
}

/** 进程是否存活（非僵尸）。Linux 下 zombie(STAT=Z) 不算存活。 */
export function isPidAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  return isProcessAlive(pid);
}

export interface SessionListItem extends SessionMeta {
  status: 'running' | 'stopped' | 'aborted';
}

/**
 * 扫 sessions 目录列出会话及存活状态。
 * pid 已死且无 session_end → aborted；有 session_end → stopped；pid 活 → running。
 *
 * 孤儿浏览器回收：daemon 被 SIGKILL 时来不及收自己的浏览器（managed 模式）。
 * 这里在标记 aborted 时，如果 meta.browser_pid 仍存活且 browser_user_data_dir 是
 * 本会话的临时目录，顺手杀进程组 + 清理目录。
 */
export function listSessions(env: NodeJS.ProcessEnv = process.env): SessionListItem[] {
  const dir = sessionsDir(env);
  if (!fs.existsSync(dir)) return [];
  const out: SessionListItem[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const id = entry.name.slice(0, -'.json'.length);
    const meta = readMeta(id, env);
    if (!meta) continue;
    let status: SessionListItem['status'];
    if (meta.session_end) {
      status = meta.session_end.result === 'aborted' ? 'aborted' : 'stopped';
    } else if (isPidAlive(meta.pid)) {
      status = 'running';
    } else {
      status = 'aborted';
      // F6: 孤儿浏览器回收（managed 模式，daemon 被 SIGKILL）
      const cleaned = cleanupOrphanBrowser(meta);
      // F6: 写回 meta（session_end + 回收标记），后续 list 不再重复杀
      writeMeta({ ...meta, session_end: { result: 'aborted', ended_at: Date.now() }, orphan_cleaned: cleaned.killed || cleaned.cleaned }, env);
    }
    out.push({ ...meta, status });
  }
  return out.sort((a, b) => b.started_at - a.started_at);
}

/** 回收结果 */
interface CleanupResult { killed: boolean; cleaned: boolean }

/**
 * 杀掉已死 daemon 留下的孤儿浏览器进程组 + 清理临时 user-data-dir。
 * F6 防误杀：校验 user_data_dir 的父目录是 os.tmpdir() 且以 e2et-<sid>- 开头；
 * 校验该 pid 的命令行包含 --user-data-dir=<该目录>；不满足则只标记 aborted、不杀不删。
 *
 * 同步等待：SIGTERM → 轮询最多 2s → SIGKILL → 确认进程组归零后再删目录。
 * 旧实现用 unref 的 timer 做 SIGKILL 兜底，CLI 退出后永不触发。
 */
export function cleanupOrphanBrowser(meta: SessionMeta): CleanupResult {
  if (!meta.browser_pid || !meta.browser_user_data_dir) return { killed: false, cleaned: false };
  const dir = meta.browser_user_data_dir;
  const tmpDir = path.resolve(os.tmpdir());
  const expectedPrefix = `e2et-${meta.id}-`;

  // 校验 1: 目录的父目录是 os.tmpdir()（dirname 比较而非 startsWith，避免 tmpdir 子目录误匹配）
  if (path.dirname(path.resolve(dir)) !== tmpDir) {
    return { killed: false, cleaned: false };
  }
  const dirBasename = path.basename(dir);
  if (!dirBasename.startsWith(expectedPrefix)) {
    return { killed: false, cleaned: false };
  }

  let killed = false;
  // 校验 2: pid 的命令行包含 --user-data-dir=<该目录>
  if (isPidAlive(meta.browser_pid)) {
    try {
      const cmd = execSync(`ps -o command= -p ${meta.browser_pid}`, { encoding: 'utf8', timeout: 2000 });
      if (!cmd.includes(`--user-data-dir=${dir}`)) {
        return { killed: false, cleaned: false };
      }
    } catch {
      // ps 不可用或 pid 已死 → 无法验证命令行，不杀不删（防误杀）
      return { killed: false, cleaned: false };
    }
    // 校验通过，SIGTERM → 轮询 2s → SIGKILL → 确认归零
    try { process.kill(-meta.browser_pid, 'SIGTERM'); } catch {
      try { process.kill(meta.browser_pid, 'SIGTERM'); } catch {}
    }
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if (!isPidAlive(meta.browser_pid)) break;
      // 同步阻塞 100ms
      sleepSync(100);
    }
    if (isPidAlive(meta.browser_pid)) {
      try { process.kill(-meta.browser_pid, 'SIGKILL'); } catch {
        try { process.kill(meta.browser_pid, 'SIGKILL'); } catch {}
      }
      // 等进程组归零（最多再 1s）
      const dl2 = Date.now() + 1000;
      while (Date.now() < dl2) {
        if (!isPidAlive(meta.browser_pid)) break;
        sleepSync(100);
      }
    }
    killed = true;
  }
  // 进程组归零后再删目录
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  return { killed, cleaned: true };
}

/** 生成短会话 id：s_ + 8 位 hex，足以避撞且 socket 路径短。 */
export function generateSessionId(): string {
  return 's_' + Array.from(crypto.getRandomValues(new Uint8Array(4)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
