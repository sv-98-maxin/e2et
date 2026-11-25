/**
 * Daemon 客户端：连 session 的 unix socket，发请求等响应。
 * CLI 子命令（page open / page state / session stop）通过它和 daemon 通信。
 */
import * as net from 'node:net';
import { encodeLine, parseLine, type DaemonRequest, type DaemonResponse, type DaemonError, type DaemonWaitStarted } from './protocol.js';
import { DEFAULT_REQUEST_TIMEOUT_MS, MAX_TIMER_MS } from '../wait-timeout.js';

export interface DaemonClientOptions {
  /** 连接超时（ms），默认 5000 */
  connectTimeoutMs?: number;
  /** 单次请求超时（ms），默认 30000 */
  requestTimeoutMs?: number;
}

interface PendingEntry {
  resolve: (r: DaemonResponse) => void;
  reject: (e: Error) => void;
  /** 合法预算通知只延长当前绝对 deadline。 */
  reArm: (deadlineMs: number) => void;
  /** 当前定时器清理，供错误/断连路径调用。 */
  clearTimer: () => void;
}

export class DaemonClient {
  private socket: net.Socket;
  private buffer = '';
  private nextId = 1;
  private pending = new Map<number, PendingEntry>();
  private closed = false;

  private constructor(socket: net.Socket) {
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      let nl: number;
      while ((nl = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 1);
        const msg = parseLine(line);
        if (msg && 'wait_deadline_ms' in msg) {
          const ws = msg as DaemonWaitStarted;
          const p = this.pending.get(ws.id);
          if (p && isValidDeadline(ws.wait_deadline_ms)) p.reArm(ws.wait_deadline_ms);
          continue;
        }
        if (msg && 'ok' in msg) {
          const p = this.pending.get(msg.id);
          if (!p) continue;
          this.pending.delete(msg.id);
          p.resolve(msg as DaemonResponse);
        }
      }
    });
    socket.on('error', (err) => {
      const e = new DaemonClientError({ code: 'REQUEST_INTERRUPTED', message: `daemon socket 错误: ${err.message}；执行结果未知`, hint: '禁止自动重试，先检查会话状态和 trace' });
      for (const p of this.pending.values()) { p.clearTimer(); p.reject(e); }
      this.pending.clear();
    });
    socket.on('close', () => {
      // 显式 close() 已自行清理 pending；仅被动断连走此分支
      if (this.closed) return;
      const e = new DaemonClientError({ code: 'REQUEST_INTERRUPTED', message: 'daemon 连接已关闭；执行结果未知', hint: '禁止自动重试，先检查会话状态和 trace' });
      for (const p of this.pending.values()) { p.clearTimer(); p.reject(e); }
      this.pending.clear();
    });
  }

  static connect(socketPath: string, opts: DaemonClientOptions = {}): Promise<DaemonClient> {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`连接 daemon 超时: ${socketPath}`));
      }, opts.connectTimeoutMs ?? 5000);
      socket.once('connect', () => {
        clearTimeout(timer);
        resolve(new DaemonClient(socket));
      });
      socket.once('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`连接 daemon 失败 (${socketPath}): ${err.message}`));
      });
      socket.connect(socketPath);
    });
  }

  request(method: string, params: Record<string, unknown> = {}, opts: DaemonClientOptions = {}): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('daemon client 已关闭'));
    const id = this.nextId++;
    const req: DaemonRequest = { id, method, params };
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let deadline = Date.now() + (opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
      const arm = (timeoutMs: number): void => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          try { this.socket.write(encodeLine({ id, cancel: true })); } catch { /* 断连由 socket 收口 */ }
          this.pending.delete(id);
          reject(new DaemonClientError({ code: 'REQUEST_TIMEOUT', message: `daemon 请求超时: ${method}；执行结果未知`, hint: '禁止自动重试，先检查会话状态和 trace' }));
        }, Math.max(0, timeoutMs));
      };
      arm(opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (r: DaemonResponse) => {
          if (timer) { clearTimeout(timer); timer = undefined; }
          if (r.ok) resolve(r.data);
          else reject(new DaemonClientError(r.error!));
        },
        reject: (e: Error) => {
          if (timer) { clearTimeout(timer); timer = undefined; }
          reject(e);
        },
        reArm: (deadlineMs: number) => {
          const now = Date.now();
          const nextDeadline = Math.max(now, deadlineMs) + DEFAULT_REQUEST_TIMEOUT_MS;
          const duration = nextDeadline - now;
          if (duration > MAX_TIMER_MS) return; // 越界不续命，保留现有定时器
          if (nextDeadline <= deadline) return;
          deadline = nextDeadline;
          arm(duration);
        },
        clearTimer: () => { if (timer) { clearTimeout(timer); timer = undefined; } },
      });
      this.socket.write(encodeLine(req));
    });
  }

  /** 快速探活：socket 能否连上。 */
  static ping(socketPath: string, timeoutMs = 1000): Promise<boolean> {
    return DaemonClient.connect(socketPath, { connectTimeoutMs: timeoutMs })
      .then((c) => {
        c.close();
        return true;
      })
      .catch(() => false);
  }

  close(): void {
    if (this.closed) return;
    // 先 reject/clear 所有 pending 与当前定时器，再 destroy socket
    const e = new Error('daemon client 已关闭');
    for (const p of this.pending.values()) { p.clearTimer(); p.reject(e); }
    this.pending.clear();
    this.closed = true;
    this.socket.destroy();
  }
}

/** wait-start deadline 校验：必须是正 safe integer epoch（负数/零不续命），且续命 duration 在平台定时器上限内。保留合法已过期 deadline 的 max(0,...) 语义。 */
function isValidDeadline(deadlineMs: unknown): deadlineMs is number {
  if (typeof deadlineMs !== 'number' || !Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) return false;
  const duration = Math.max(0, deadlineMs - Date.now()) + DEFAULT_REQUEST_TIMEOUT_MS;
  return duration <= MAX_TIMER_MS;
}

export class DaemonClientError extends Error {
  code: string;
  hint?: string;
  constructor(err: DaemonError) {
    super(err.message);
    this.code = err.code;
    if (err.hint) this.hint = err.hint;
  }
}
