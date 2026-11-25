import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { traceDir, traceRoot } from './session-meta.js';

import { TRACE_SCHEMA_VERSION } from '../shared/versions.js';

export const TRACE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const STRUCTURAL_KEYS = new Set(['session_id', 'cdp_request_id']);
const URL_HEADER_KEYS = new Set(['location', 'referer', 'referrer']);
const NO_FOLLOW = (fs.constants as unknown as Record<string, number>).O_NOFOLLOW ?? 0;

// Phase2：纯字符串 URL/文本来源安全规则唯一源在 shared/url-safety.ts；本模块仅转发/调用，
// private IO/body/header 投影留在此处。redactUrl 与 redactUrlWithEvidence 同源。
import { REDACTED, isSensitiveKey, redactText, redactUrl, redactUrlWithEvidence } from '../shared/url-safety.js';
export { redactText, redactUrl, redactUrlWithEvidence };

function redactHeaderValue(key: string, value: unknown): unknown {
  if (isSensitiveKey(key)) return REDACTED;
  if (Array.isArray(value)) return value.map((item) => redactHeaderValue(key, item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redactHeaderValue(childKey, child)]));
  }
  if (typeof value !== 'string') return value;
  return URL_HEADER_KEYS.has(key.toLowerCase()) ? redactUrl(value) : redactText(value);
}

export function redactHeaders(headers: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    out[key.toLowerCase()] = redactHeaderValue(key, value);
  }
  return out;
}

export function scrubValue(value: unknown, key?: string): unknown {
  if (key && !STRUCTURAL_KEYS.has(key) && isSensitiveKey(key)) return REDACTED;
  if (typeof value === 'string') {
    if (key && ['url', 'from', 'to', 'location', 'referer', 'referrer'].includes(key.toLowerCase())) return redactUrl(value);
    return redactText(value);
  }
  if (Array.isArray(value)) return value.map((item) => scrubValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, scrubValue(child, childKey)]));
  }
  return value;
}

export function ensurePrivateDir(dir: string, recursive = false): void {
  try {
    fs.mkdirSync(dir, { recursive, mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const pathStat = fs.lstatSync(dir);
  if (pathStat.isSymbolicLink() || !pathStat.isDirectory()) throw new Error('unsafe trace directory');
  if (!NO_FOLLOW) {
    fs.chmodSync(dir, 0o700);
    return;
  }
  const fd = fs.openSync(dir, fs.constants.O_RDONLY | NO_FOLLOW);
  try {
    if (!fs.fstatSync(fd).isDirectory()) throw new Error('unsafe trace directory');
    fs.fchmodSync(fd, 0o700);
  } finally {
    fs.closeSync(fd);
  }
}

function sessionTraceDir(id: string): string {
  const root = traceRoot();
  ensurePrivateDir(root, true);
  const dir = traceDir(id);
  ensurePrivateDir(dir);
  return dir;
}

function tracePath(id: string): string {
  return path.join(sessionTraceDir(id), 'trace.jsonl');
}

/** 读一个会话的全部 trace 事件（测试用）。文件不存在返回空数组。 */
export function readTraceEvents(id: string): Record<string, unknown>[] {
  const target = tracePath(id);
  if (!fs.existsSync(target)) return [];
  const fd = fs.openSync(target, fs.constants.O_RDONLY | NO_FOLLOW);
  try {
    if (!fs.fstatSync(fd).isFile()) return [];
    const content = fs.readFileSync(fd, 'utf8');
    const out: Record<string, unknown>[] = [];
    for (const line of content.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      out.push(JSON.parse(t) as Record<string, unknown>);
    }
    return out;
  } finally {
    fs.closeSync(fd);
  }
}

export function appendTraceEvent(id: string, event: Record<string, unknown>): void {
  const target = tracePath(id);
  if (!NO_FOLLOW && fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error('unsafe trace file');
  const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | NO_FOLLOW, 0o600);
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error('unsafe trace file');
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, JSON.stringify(projectTraceEvent(event)) + '\n', 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function projectTraceEvent(event: Record<string, unknown>): Record<string, unknown> {
  const t = String(event.t ?? '');
  const contractKeys: ReadonlySet<string> = CONTRACT_KEYS_BY_TYPE[t] ?? EMPTY_SET;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    out[key] = contractKeys.has(key) ? value : scrubValue(value, key);
  }
  return out;
}
const EMPTY_SET = new Set<string>();
const CONTRACT_KEYS_BY_TYPE: Record<string, ReadonlySet<string>> = {
  action: new Set(['t','id','ts','ts_end','kind','intent','nav','args','value','save_as','creates','target','frame','settled_by','requests','result','execute_result','resolved_tab','replayable','resolved_value','output_value','saved_value','source_action']),
  assert: new Set(['t','id','ts','after','kind','expect','actual','pass','evidence','target','within','value','read_mode','observation_ref','replayable','frame']),
  capture: new Set(['t','id','ts','after','from','as','value','path','lineage','target','read_mode','replayable','result','frame']),
  inspect: new Set(['t','id','ts','after','group','check','within','frame','total','truncated','candidates','context']),
  observation: new Set(['t','id','ts','after','source','target_id','document','nav','origin','result','replayable','group']),
  request: new Set(['t','id','ts','path','nav','call_index','url_redacted','triggered_by','target_id','creates','req_body_ref','resp_body_ref','req_body_omitted','resp_body_omitted','req_body_redacted_paths','resp_body_redacted_paths']),
};

function writeSanitizedBlob(id: string, bytes: Buffer): string {
  const blobs = path.join(sessionTraceDir(id), 'blobs');
  ensurePrivateDir(blobs);
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  const target = path.join(blobs, sha);
  if (!NO_FOLLOW && fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error('unsafe trace blob');
  let fd: number;
  let created = false;
  try {
    fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW, 0o600);
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    fd = fs.openSync(target, fs.constants.O_RDWR | NO_FOLLOW);
  }
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error('unsafe trace blob');
    if (created) {
      fs.writeFileSync(fd, bytes);
    } else if (crypto.createHash('sha256').update(fs.readFileSync(fd)).digest('hex') !== sha) {
      throw new Error('unsafe trace blob');
    }
    fs.fchmodSync(fd, 0o600);
  } finally {
    fs.closeSync(fd);
  }
  return 'blobs/' + sha;
}

export function storeTraceFile(sessionId: string, file: string): string {
  return writeSanitizedBlob(sessionId, fs.readFileSync(file));
}

export function readTraceBody(sessionId: string, ref: string): string | null {
  return readTraceBlob(sessionId, ref)?.toString('utf8') ?? null;
}

export function readTraceBlob(sessionId: string, ref: string): Buffer | null {
  if (!ref.startsWith('blobs/')) return null;
  const sha = ref.slice('blobs/'.length);
  if (!/^[a-f0-9]{64}$/.test(sha)) return null;
  const target = path.join(sessionTraceDir(sessionId), 'blobs', sha);
  let fd: number;
  try {
    fd = fs.openSync(target, fs.constants.O_RDONLY | NO_FOLLOW);
  } catch {
    return null;
  }
  try {
    if (!fs.fstatSync(fd).isFile()) return null;
    const content = fs.readFileSync(fd);
    if (crypto.createHash('sha256').update(content).digest('hex') !== sha) return null;
    return content;
  } finally {
    fs.closeSync(fd);
  }
}

/** F3：带路径事实的递归脱敏。实际替换后与原节点不同才 push currentPath 副本
 *  （原值就是 marker 不算改写）；敏感键替换只记该节点，不保存原子树。 */
function redactJsonWithPaths(value: unknown, currentPath: string[], redactedPaths: string[][]): unknown {
  if (Array.isArray(value)) {
    return value.map((item, i) => redactJsonWithPaths(item, [...currentPath, String(i)], redactedPaths));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => {
      const childPath = [...currentPath, childKey];
      // 敏感键本身命中：整值替为 marker，值真的不同才登记该节点
      if (isSensitiveKey(childKey)) {
        if (REDACTED !== child) redactedPaths.push(childPath);
        return [childKey, REDACTED];
      }
      return [childKey, redactJsonWithPaths(child, childPath, redactedPaths)];
    }));
  }
  if (typeof value === 'string') {
    const replaced = redactText(value);
    if (replaced !== value) redactedPaths.push([...currentPath]);
    return replaced;
  }
  return value;
}

function redactForm(text: string): string {
  const params = new URLSearchParams(text);
  for (const [key, value] of [...params.entries()]) {
    params.set(key, isSensitiveKey(key) ? REDACTED : redactText(value));
  }
  return params.toString();
}

export type StoredTraceBody =
  | { ref: string; redacted_paths: string[][] }
  | { omitted: 'unsupported_content_type' | 'non_utf8_body' };

export function storeTraceBody(
  sessionId: string,
  raw: string,
  contentType = '',
  base64Encoded = false,
): StoredTraceBody {
  const mime = contentType.split(';', 1)[0].trim().toLowerCase();
  const json = mime === 'application/json' || mime.endsWith('+json') || (!mime && /^[\s]*[\[{]/.test(raw));
  const form = mime === 'application/x-www-form-urlencoded' || (!mime && /(?:^|&)[^=&]+=[^&]*/.test(raw));
  const text = mime.startsWith('text/') || ['application/javascript', 'application/xml', 'application/graphql'].includes(mime);
  if (!json && !form && !text) return { omitted: 'unsupported_content_type' };

  let decoded: string;
  try {
    const bytes = base64Encoded ? Buffer.from(raw, 'base64') : Buffer.from(raw, 'utf8');
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { omitted: 'non_utf8_body' };
  }

  let sanitized: string;
  const redactedPaths: string[][] = [];
  if (json) {
    try {
      sanitized = JSON.stringify(redactJsonWithPaths(JSON.parse(decoded), [], redactedPaths));
    } catch {
      sanitized = redactText(decoded);
      if (sanitized !== decoded) redactedPaths.push([]);
    }
  } else if (form) {
    sanitized = redactForm(decoded);
    // F3：form 以 URLSearchParams 规范化 entries 比较实际处理前后（不是原串编码差异）
    const before = [...new URLSearchParams(decoded).entries()];
    const after = [...new URLSearchParams(sanitized).entries()];
    if (before.length !== after.length || before.some(([k, v], i) => after[i][0] !== k || after[i][1] !== v)) {
      redactedPaths.push([]);
    }
  } else {
    sanitized = redactText(decoded);
    // 非JSON text：实际前后值不同才记根 [ [] ]
    if (sanitized !== decoded) redactedPaths.push([]);
  }
  return { ref: writeSanitizedBlob(sessionId, Buffer.from(sanitized, 'utf8')), redacted_paths: redactedPaths };
}

export function cleanupExpiredTraces(
  currentSessionId: string,
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): string[] {
  const root = traceRoot(env);
  if (!fs.existsSync(root)) return [];
  const removed: string[] = [];
  for (const name of fs.readdirSync(root)) {
    if (name === currentSessionId) continue;
    const target = path.join(root, name);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(target); } catch { continue; }
    if (stat.isSymbolicLink() || !stat.isDirectory() || now - stat.mtimeMs <= TRACE_TTL_MS) continue;
    fs.rmSync(target, { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

export interface SessionTraceFields {
  session_id: string;
  env: string;
  tool_version: string;
  browser_version?: string;
  headless?: boolean;
  transport?: string;
  /** 录制事实的安全来源标签；本 CLI 当前只产生 profile/imported。 */
  auth_source?: string;
  browser_source?: 'managed' | 'existing' | 'chrome-profile';
  browser_context_id?: string;
  viewport?: { width: number; height: number; deviceScaleFactor?: number };
}

export function writeSessionStart(f: SessionTraceFields): void {
  appendTraceEvent(f.session_id, {
    t: 'session',
    id: 'session',
    ts: Date.now(),
    schema_version: TRACE_SCHEMA_VERSION,
    session_id: f.session_id,
    env: f.env,
    tool_version: f.tool_version,
    ...(f.browser_version ? { browser: { version: f.browser_version, ...(f.headless !== undefined ? { headless: f.headless } : {}) } } : {}),
    ...(f.viewport ? { viewport: f.viewport } : {}),
    ...(f.transport ? { transport: f.transport } : {}),
    ...(f.auth_source ? { auth_source: f.auth_source } : {}),
    ...(f.browser_source ? { browser_source: f.browser_source } : {}),
    ...(f.browser_context_id ? { browser_context_id: f.browser_context_id } : {}),
  });
}

export interface SessionEndExtras {
  /** 会话是否用过 mock(用过即不可落库) */
  mocked?: boolean;
  /** 断言统计 */
  asserts?: { total: number; pass: number };
  /** 超时动作数量(settled_by 含 timeout 的 action 数) */
  timeouts?: number;
}

export function writeSessionEnd(
  session_id: string,
  result: 'pass' | 'fail' | 'blocked' | 'aborted',
  extras: SessionEndExtras = {},
): void {
  appendTraceEvent(session_id, {
    t: 'session_end',
    id: 'session_end',
    ts: Date.now(),
    result,
    ...(extras.mocked ? { mocked: true } : {}),
    ...(extras.asserts ? { asserts: extras.asserts } : {}),
    ...(extras.timeouts !== undefined ? { timeouts: extras.timeouts } : {}),
    ended_at: new Date().toISOString(),
  });
}
