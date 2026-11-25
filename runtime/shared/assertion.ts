/**
 * 共源断言逻辑：AssertOp / jsonPath / compare。
 * 唯一维护源，src/shared 和 runtime_assets 由 sync 脚本镜像。
 *
 * jsonPath 支持 $ 根前缀 / dot 遍历 / [N] 下标 / [key=val] 过滤段；
 * 裸 $ 返回 root；$. / $[ 开头剥首个 $；$abc 是普通字段名。
 * 缺失路径返回 undefined；null 是已存在的值。
 *
 * compare: missing(actual===undefined) 对所有 op 返回 false；
 * null 是已存在值，eq/ne/contains 正常比较，exists 为 false。
 */
export type AssertOp = '==' | '!=' | 'exists' | 'contains' | '>' | '<';

/** F4：回放证据被脱敏改写时固定错误码，daemon 映射结构化错误，不归 pass:false */
export const REPLAY_EVIDENCE_REDACTED = 'REPLAY_EVIDENCE_REDACTED';

/** JSON path 取值：a.b.c / a[0] / a.b[2].c / a[key=val]。
 *  可选根前缀：裸 $ 返回 root；$. / $[ 开头剥首个 $；$abc 保留。
 *  找不到返回 undefined。 */
export function jsonPath(root: unknown, expr: string): unknown {
  return resolveJsonPath(root, expr, []);
}

/** F4：回放路径取值，与 jsonPath 共用同一内部遍历。
 *  redactedPaths 是 body 实际被改写节点的具体键/下标路径；
 *  读取被改写节点/位于改写子树内/依赖改写 filter 字段时抛 REPLAY_EVIDENCE_REDACTED，
 *  无改写路径事实（空数组）时行为与 jsonPath 完全一致。 */
export function replayJsonPath(root: unknown, expr: string, redactedPaths: readonly (readonly string[])[]): unknown {
  return resolveJsonPath(root, expr, redactedPaths);
}

function pathIsPrefix(prefix: readonly string[], full: readonly string[]): boolean {
  if (prefix.length > full.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (prefix[i] !== full[i]) return false;
  }
  return true;
}

function guardRedacted(candidate: readonly string[], redactedPaths: readonly (readonly string[])[]): void {
  for (const rp of redactedPaths) {
    if (pathIsPrefix(rp, candidate)) {
      throw new Error(`${REPLAY_EVIDENCE_REDACTED}: 来源字段被脱敏改写 (${rp.join('.')})`);
    }
  }
}

function guardResultSubtree(currentPath: readonly string[], redactedPaths: readonly (readonly string[])[]): void {
  for (const rp of redactedPaths) {
    if (pathIsPrefix(currentPath, rp)) {
      throw new Error(`${REPLAY_EVIDENCE_REDACTED}: 来源字段被脱敏改写 (${rp.join('.')})`);
    }
  }
}

function resolveJsonPath(root: unknown, expr: string, redactedPaths: readonly (readonly string[])[]): unknown {
  if (expr === '$') {
    guardResultSubtree([], redactedPaths);
    return root;
  }
  if (root == null) return undefined;
  const effective = expr.startsWith('$.') || expr.startsWith('$[') ? expr.slice(1) : expr;
  // 保护 [...] 内的点号不被 split 拆断
  const brackets: string[] = [];
  const protectedExpr = effective.replace(/\[([^\]]*?)\]/g, (_, inner) => {
    brackets.push('[' + inner + ']');
    return `§${brackets.length - 1}§`;
  });
  const splitSegs = protectedExpr.split('.');
  const restoredSegs = splitSegs.map(seg =>
    seg.replace(/§(\d+)§/g, (_, idx) => brackets[Number(idx)])
  );
  const parts: string[] = [];
  for (const seg of restoredSegs) {
    if (seg === '') continue;
    const re = /^([^\[]*)((?:\[[^\]]*\])*)$/;
    const m = seg.match(re);
    if (!m) return undefined;
    const [, head, bracketsSeg] = m;
    if (head !== '') parts.push(head);
    if (bracketsSeg) {
      for (const b of bracketsSeg.matchAll(/\[([^\]]*)\]/g)) {
        const inner = b[1];
        if (/^\d+$/.test(inner)) parts.push(inner);
        else parts.push('[' + inner + ']');
      }
    }
  }
  let cur: unknown = root;
  const currentPath: string[] = [];
  for (const k of parts) {
    if (cur == null) return undefined;
    const filter = /^\[([^=\]]+)=([^\]]*)\]$/.exec(k);
    if (filter) {
      const [, fk, fv] = filter;
      if (!Array.isArray(cur)) return undefined;
      let hit: unknown;
      let hitIndex = -1;
      // F4：filter 按数组原下标逐个读 fk，读取前检查每个实际读取的 filter key 是否被改写
      for (let i = 0; i < cur.length; i++) {
        const item = cur[i];
        if (item == null || typeof item !== 'object') continue;
        guardRedacted([...currentPath, String(i), fk], redactedPaths);
        if (String((item as Record<string, unknown>)[fk]) === fv) { hit = item; hitIndex = i; break; }
      }
      if (hitIndex < 0) return undefined;
      currentPath.push(String(hitIndex));
      cur = hit;
      continue;
    }
    // F4：读取具体节点前检查该节点是否位于被改写节点之下
    guardRedacted([...currentPath, k], redactedPaths);
    if (Array.isArray(cur)) {
      const idx = Number(k);
      if (!Number.isInteger(idx)) return undefined;
      cur = cur[idx];
    } else if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[k];
    } else {
      return undefined;
    }
    currentPath.push(k);
  }
  // F4：返回对象/数组/根前检查结果子树是否包含被改写节点
  guardResultSubtree(currentPath, redactedPaths);
  return cur;
}

/** op 比较。actual/expected 已是 JS 值。
 *  missing(actual===undefined) 对所有 op 返回 false。
 *  null 是已存在值：eq/ne/contains 按既有规则，exists 为 false。 */
export function compare(op: AssertOp, actual: unknown, expected: unknown): boolean {
  // missing 对所有 op 返回 false（ne 不假绿）
  if (actual === undefined) return false;
  switch (op) {
    case '==':
      return looseEqual(actual, expected);
    case '!=':
      return !looseEqual(actual, expected);
    case 'exists':
      // null 存在但 exists=false（合同）
      return actual !== undefined && actual !== null;
    case 'contains': {
      if (actual == null) return false;
      if (typeof actual === 'string') return actual.includes(String(expected));
      if (Array.isArray(actual)) return actual.some((item) => looseEqual(item, expected));
      if (typeof actual === 'object') return Object.values(actual as Record<string, unknown>).some((v) => looseEqual(v, expected));
      return false;
    }
    case '>': {
      const a = toNumber(actual);
      const e = toNumber(expected);
      return a !== null && e !== null && a > e;
    }
    case '<': {
      const a = toNumber(actual);
      const e = toNumber(expected);
      return a !== null && e !== null && a < e;
    }
    default:
      return false;
  }
}

/** 解析 CLI 断言字符串 "<path> <op> <value>"。value 部分交给调用方 parseValue。 */
export function parseAssertion(str: string): { path: string; op: AssertOp; valueJson: string } | null {
  const m = str.match(/^(\S+)\s+(==|!=|exists|contains|>|<)\s*(.*)$/);
  if (!m) return null;
  const [, path, op, valueRest] = m;
  return { path, op: op as AssertOp, valueJson: valueRest.trim() };
}

/** value 部分按 JSON 解析（失败则当字符串；空串保持空串）。 */
export function parseValue(jsonStr: string): unknown {
  if (jsonStr === '') return '';
  try {
    return JSON.parse(jsonStr);
  } catch {
    return jsonStr;
  }
}

/** query 完整键名取值：保留有序 string[]；缺失 undefined；空值保持 ['']。
 *  不接受 JSON 路径语法，键名原样匹配。 */
export function queryParamValues(url: string, key: string): string[] | undefined {
  let params: URLSearchParams;
  try { params = new URL(url).searchParams; } catch { return undefined; }
  const values = params.getAll(key);
  return values.length ? values : undefined;
}

/** query 断言比较：eq/ne 标量只接受单值、数组按整体有序比较；其余 op 单值直比、多值走 compare。 */
export function compareQuery(op: AssertOp, values: string[] | undefined, expected: unknown): boolean {
  if (values === undefined) return false;
  if (op === '==' || op === '!=') {
    const actual = Array.isArray(expected) ? values : values.length === 1 ? values[0] : undefined;
    return compare(op, actual, expected);
  }
  return values.length === 1 ? compare(op, values[0], expected) : compare(op, values, expected);
}

function looseEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'string') return String(a) === b;
  if (typeof b === 'number' && typeof a === 'string') return a === String(b);
  if (a == null || b == null) return a == null && b == null;
  if (typeof a === 'object' && typeof b === 'object') {
    try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
  }
  return false;
}

function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/** 路径逐级缩短（由长到短，以 '' 收尾）：a.b[0].c → a.b[0] → a.b → a → ''。
 *  仅用于路径未命中诊断，不参与取值；支持 '$' 前缀、下标段与 filter 段的边界回退。 */
export function shortenPath(path: string): string[] {
  const out: string[] = [];
  let cur = path;
  while (cur !== '') {
    out.push(cur === '$' ? '' : cur);
    if (cur === '$') return out;
    if (cur.endsWith(']')) {
      const open = cur.lastIndexOf('[');
      cur = open > 0 ? cur.slice(0, open) : '';
      if (cur.endsWith('.')) cur = cur.slice(0, -1);
    } else {
      const dot = cur.lastIndexOf('.');
      cur = dot > 0 ? cur.slice(0, dot) : '';
    }
  }
  if (out[out.length - 1] !== '') out.push('');
  return out;
}

/** 未命中路径诊断：找最长可解析前缀，在该前缀对象上取可用 key（只输出 key 名/长度，不输出值）。
 *  body 缺失（undefined/null）时无结构可诊断；null 是已存在值，只回最前缀不伪造 key。 */
export function diagnoseMissingPath(body: unknown, path: string): Record<string, unknown> {
  if (body === undefined || body === null) {
    return { path_status: 'missing', resolved_prefix: '' };
  }
  let resolvedPrefix = '';
  let resolved: unknown = body;
  for (const prefix of shortenPath(path)) {
    const value = prefix === '' ? body : jsonPath(body, prefix);
    if (value !== undefined) {
      resolvedPrefix = prefix;
      resolved = value;
      break;
    }
  }
  if (Array.isArray(resolved)) {
    return { path_status: 'missing', resolved_prefix: resolvedPrefix, array_length: resolved.length };
  }
  if (resolved !== null && typeof resolved === 'object') {
    return { path_status: 'missing', resolved_prefix: resolvedPrefix, available_keys: Object.keys(resolved).slice(0, 5) };
  }
  return { path_status: 'missing', resolved_prefix: resolvedPrefix };
}
