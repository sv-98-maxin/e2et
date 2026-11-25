/**
 * Daemon 通信协议：unix socket 上换行分隔 JSON。
 * 请求 {id, method, params}，响应 {id, ok, data|error}。无新依赖。
 */

export interface DaemonRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface DaemonCancel {
  id: number;
  cancel: true;
}

export interface DaemonError {
  code: string;
  message: string;
  hint?: string;
}

export interface DaemonResponse {
  id: number;
  ok: boolean;
  data?: unknown;
  error?: DaemonError;
}

/** 请求预算通知：实际 CDP 执行与显式等待可多次延长预算，非终态响应，不入 CLI stdout。 */
export interface DaemonWaitStarted {
  id: number;
  wait_deadline_ms: number;
}

export function encodeLine(obj: DaemonRequest | DaemonCancel | DaemonResponse | DaemonWaitStarted): string {
  return JSON.stringify(obj) + '\n';
}

export function parseLine(line: string): DaemonRequest | DaemonCancel | DaemonResponse | DaemonWaitStarted | null {
  const t = line.trim();
  if (!t) return null;
  try {
    return JSON.parse(t) as DaemonRequest | DaemonCancel | DaemonResponse | DaemonWaitStarted;
  } catch {
    return null;
  }
}
