/**
 * 显式完成预算契约：CLI/daemon/IR/render 共享的预算解析与回放预算计算。
 * runtime 侧不 import 本模块（独立维护本地 30s 常量）。
 */

/** 显式完成兜底（非 sleep）：未声明 --wait-timeout-ms 的显式等待用此值。 */
export const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
/** 既有传输/原生操作允许量（socket 请求、native action）。 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** 平台定时器上限（2^31 - 1）。 */
export const MAX_TIMER_MS = 2_147_483_647;
/** 单步 wait_timeout 上限：扣除回放 setup/action 允许量。 */
export const MAX_WAIT_TIMEOUT_MS = MAX_TIMER_MS - 3 * DEFAULT_REQUEST_TIMEOUT_MS;

/**
 * 解析 --wait-timeout-ms 值。仅 undefined 视为缺省（返回 undefined）。
 * present 但非法（null/空串/带空白/小数/非纯数字/0/溢出）一律抛 Error，不默认回退。
 * string 必须是纯 digits（不 trim、不含空白/符号），如 "12"；" 12 "/"12.5"/"" 拒。
 */
export function parseWaitTimeoutMs(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  let n: number;
  if (typeof value === 'number') {
    n = value;
  } else if (typeof value === 'string' && /^[0-9]+$/.test(value)) {
    n = Number(value);
  } else {
    throw new Error(`wait_timeout_ms 非法: 必须是正整数，实际 ${JSON.stringify(value)}`);
  }
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new Error(`wait_timeout_ms 非法: 必须是正整数，实际 ${n}`);
  }
  if (n > MAX_WAIT_TIMEOUT_MS) {
    throw new Error(`wait_timeout_ms 非法: 超过上限 ${MAX_WAIT_TIMEOUT_MS}，实际 ${n}`);
  }
  return n;
}

/**
 * 回放预算：2 * DEFAULT_REQUEST_TIMEOUT_MS（setup + 收尾）
 *   + 每步 (nativeCallCount * DEFAULT_REQUEST_TIMEOUT_MS + (step.wait_timeout_ms ?? DEFAULT_WAIT_TIMEOUT_MS))。
 * nativeCallCount：category=args.labels 数量、fill_form=args.fields 键数、其余 1（下限 1）。
 * 非 finite 或超 MAX_TIMER_MS 抛错。
 */
export function replayTimeoutMs(
  steps: ReadonlyArray<{ action?: string; args?: Record<string, unknown>; wait_timeout_ms?: number }>,
): number {
  let total = 2 * DEFAULT_REQUEST_TIMEOUT_MS;
  for (const step of steps) {
    const native = nativeCallCount(step);
    total += native * DEFAULT_REQUEST_TIMEOUT_MS + (step.wait_timeout_ms ?? DEFAULT_WAIT_TIMEOUT_MS);
  }
  if (!Number.isFinite(total)) throw new Error('replay budget 非 finite');
  if (total > MAX_TIMER_MS) throw new Error(`replay budget 超过平台定时器上限: ${total} > ${MAX_TIMER_MS}`);
  return total;
}

/** 当前两个聚合 action 循环的实际 native 调用次数；其余 action 为 1。 */
export function nativeCallCount(step: { action?: string; args?: Record<string, unknown> }): number {
  if (step.action === 'category') {
    const labels = step.args?.labels;
    return Array.isArray(labels) ? Math.max(1, labels.length) : 1;
  }
  if (step.action === 'fill_form') {
    const fields = step.args?.fields;
    return fields && typeof fields === 'object' ? Math.max(1, Object.keys(fields).length) : 1;
  }
  return 1;
}
