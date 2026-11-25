import { readMeta, isPidAlive } from '../daemon/session-meta.js';
import { DaemonClient, DaemonClientError } from '../daemon/client.js';
import { isValidDotPath, type PageDataSource } from '../browser/page-data.js';
import { parseValue } from '../browser/assert.js';
import { parseWaitTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, DEFAULT_WAIT_TIMEOUT_MS } from '../wait-timeout.js';
import { emitOk, emitError, EXIT_USAGE, EXIT_VALIDATION, EXIT_ENV, type Deps } from './context.js';

/** 从 parseArgs 结果提取操作命令公共参数，转成 daemon 端字段名。 */
export function collectCommon(values: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (values['--wait-api']) out.wait_api = values['--wait-api'];
  if (values['--wait-element']) out.wait_element = values['--wait-element'];
  if (values['--wait-gone']) out.wait_gone = values['--wait-gone'];
  if (values['--wait-text']) out.wait_text = values['--wait-text'];
  if (values['--wait-url']) out.wait_url = values['--wait-url'];
  if (values['--wait-timeout-ms'] !== undefined) out.wait_timeout_ms = values['--wait-timeout-ms'];
  if (values['--creates']) {
    const raw = values['--creates'];
    const eq = raw.indexOf('=');
    if (eq > 0) out.creates = { entity: raw.slice(0, eq), path: raw.slice(eq + 1) };
  }
  if (values['--dialog']) {
    out.dialog = { accept: values['--dialog'] === 'accept', ...(values['--prompt-text'] !== undefined ? { prompt_text: values['--prompt-text'] } : {}) };
  }
  if (values['--frame']) out.frame = values['--frame'];
  if (values['--save-as']) out.save_as = values['--save-as'];
  if (values['--value-template'] !== undefined) out.value_template = values['--value-template'];
  if (values['--value-ref'] !== undefined) out.value_ref = values['--value-ref'];
  if (values['--group']) out.group = values['--group'];
  return out;
}

/** 数据源 flag → 校验后的 source。 */
export function parsePageDataSourceFlags(values: Record<string, string>): { ok: true; source: PageDataSource } | { ok: false; message: string } {
  const ls = values['--local-storage'];
  const gl = values['--global'];
  const flagPath = values['--path'];
  const hasLs = ls !== undefined;
  const hasG = gl !== undefined;
  if (hasLs === hasG) return { ok: false, message: '必须且只能指定一种数据源:--local-storage <key> 或 --global <name>' };
  if (hasLs) {
    if (ls === '') return { ok: false, message: '--local-storage key 不能为空' };
    if (flagPath !== undefined) {
      if (flagPath === '') return { ok: false, message: '--path 不能为空' };
      if (!isValidDotPath(flagPath)) return { ok: false, message: '--path 只支持 dot path（如 record.mode / items.0.id），不支持 [] / 过滤 / 空段' };
      return { ok: true, source: { local_storage: ls, path: flagPath } };
    }
    return { ok: true, source: { local_storage: ls } };
  }
  if (flagPath !== undefined) return { ok: false, message: '--path 只能与 --local-storage 一起使用' };
  if (gl === '') return { ok: false, message: '--global name 不能为空' };
  return { ok: true, source: { global: gl } };
}

/** --equals flag 字符串只在 CLI 层 parseValue 一次，socket 传真实 JSON scalar。 */
export function parseEqualsScalar(raw: string): { ok: true; value: string | number | boolean | null } | { ok: false; message: string } {
  const v = parseValue(raw);
  if (v !== null && typeof v === 'object') return { ok: false, message: '--equals 只接受 JSON 标量（字符串/数字/boolean/null），不接受对象或数组' };
  if (typeof v === 'number' && !Number.isFinite(v)) return { ok: false, message: '--equals 数字必须是有限值（NaN/Infinity 拒绝）' };
  return { ok: true, value: v as string | number | boolean | null };
}

/** 统一 daemon 调用：会话查找 → socket 连接 → 请求 → 错误映射。 */
export async function callDaemon(d: Deps, id: string, method: string, params: Record<string, unknown>): Promise<number> {
  const hasWait = !!(params.wait_api || params.wait_element || params.wait_gone || params.wait_text || params.wait_url);
  if (params.wait_timeout_ms !== undefined) {
    let budget: number | undefined;
    try { budget = parseWaitTimeoutMs(params.wait_timeout_ms); }
    catch (e) { return emitError(d, 'USAGE', (e as Error).message, undefined, EXIT_USAGE); }
    if (!hasWait) return emitError(d, 'USAGE', 'wait_timeout_ms 需配合至少一个 --wait-* 条件', undefined, EXIT_USAGE);
    if (budget !== undefined) params.wait_timeout_ms = budget;
  }
  const meta = readMeta(id, d.env);
  if (!meta) return emitError(d, 'NOT_FOUND', `会话不存在: ${id}`, 'e2et session list', EXIT_VALIDATION);
  if (meta.session_end) return emitError(d, 'SESSION_ENDED', `会话已结束: ${meta.session_end.result}`, 'e2et session start', EXIT_VALIDATION);
  if (!isPidAlive(meta.pid)) {
    return emitError(d, 'SESSION_ENDED', 'daemon 进程已不在（aborted）', 'e2et session start', EXIT_VALIDATION);
  }
  let client: DaemonClient;
  try {
    client = await DaemonClient.connect(meta.socket, { connectTimeoutMs: 3000 });
  } catch (e) {
    return emitError(d, 'ENV_UNAVAILABLE', `连接 daemon 失败: ${(e as Error).message}`, undefined, EXIT_ENV);
  }
  try {
    const customBudget = typeof params.wait_timeout_ms === 'number' ? params.wait_timeout_ms : undefined;
    const budget = customBudget ?? (hasWait ? DEFAULT_WAIT_TIMEOUT_MS : undefined);
    const requestTimeoutMs = budget !== undefined ? budget + DEFAULT_REQUEST_TIMEOUT_MS : DEFAULT_REQUEST_TIMEOUT_MS;
    const data = await client.request(method, params, { requestTimeoutMs });
    return emitOk(d, data);
  } catch (e) {
    if (e instanceof DaemonClientError) {
      const unknown = e.code === 'REQUEST_TIMEOUT' || e.code === 'REQUEST_INTERRUPTED';
      return emitError(d, e.code, e.message, e.hint, unknown ? EXIT_ENV : EXIT_VALIDATION);
    }
    return emitError(d, 'ENV_UNAVAILABLE', (e as Error).message, undefined, EXIT_ENV);
  } finally {
    client.close();
  }
}
