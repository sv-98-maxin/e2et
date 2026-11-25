/**
 * P2 生成侧唯一页面数据读取 helper(合同 CODER-P2-PAGE-DATA)。
 *
 * 只读主文档:localStorage 指定 key(标准 DOMStorage 协议)或主世界全局对象的
 * 自身标量属性(Runtime 对象协议,不执行 getter)。不执行任意代码:
 *  - local-storage:Storage.getStorageKeyForFrame + DOMStorage.getDOMStorageItems,
 *    不调用页面 localStorage.getItem(避免页面覆写方法执行副作用)
 *  - global:Runtime.evaluate 固定常量 'this' 取全局 objectId → getProperties 按
 *    name 精确选自身属性 → 标量 value;每次读取唯一 objectGroup,finally
 *    releaseObjectGroup 回收全局对象及 getProperties 返回的子对象/访问器句柄
 *    (protocol.d.ts:属性结果继承目标对象的 objectGroup,只释放父句柄会漏子句柄)。
 *
 * 协议事实来自 node_modules/playwright-core/types/protocol.d.ts。
 * 错误码:READ_UNAVAILABLE(协议/解析)/ READ_UNSUPPORTED_TYPE(getter/非标量)/
 * READ_TOO_LARGE(超 100KB)。固定 message/hint,不拼入存储内容或异常 token。
 */
import { randomUUID } from 'node:crypto';
import type { CdpSession } from './daemon-client.js';
import { jsonPath } from './assert.js';

/** 数据源:localStorage key(可选 dot path)或全局属性名。两种恰好其一(调用方校验)。 */
export type PageDataSource = { local_storage: string; path?: string } | { global: string };

/** 读取结果:缺失时 present=false,不伪造 value:null(缺失 ≠ null)。 */
export interface PageDataValue {
  present: boolean;
  value?: string | number | boolean | null;
}

/** 主文档身份:frame_id / loader_id(协议允许空串,初始 about:blank)/ url(+fragment)/ origin。 */
export interface PageIdentity {
  frame_id: string;
  loader_id: string;
  url: string;
  origin: string;
}

/** 选中值 JSON 序列化上限(与既有 RESULT_MAX_BYTES 一致:100KB)。 */
export const PAGE_DATA_MAX_BYTES = 100 * 1024;

export type PageDataErrorCode = 'READ_UNAVAILABLE' | 'READ_UNSUPPORTED_TYPE' | 'READ_TOO_LARGE' | 'STALE_CONTEXT';

/** 页面数据读取错误:固定文案,不携带存储内容/异常原文(防泄漏)。 */
export class PageDataError extends Error {
  readonly code: PageDataErrorCode;
  readonly hint: string;
  constructor(code: PageDataErrorCode, message: string, hint: string) {
    super(message);
    this.name = 'PageDataError';
    this.code = code;
    this.hint = hint;
  }
}

/** dot path 合同(P2 data-only):非空段、不含 [] / 过滤 / 空白(如 record.mode / items.0.id)。
 *  两端(生成侧 jsonPath / 回放侧 data 分支遍历)同语义:对象精确自身 key,数组段 Number+integer 取 index。 */
export function isValidDotPath(p: string): boolean {
  if (p === '') return false;
  const segs = p.split('.');
  return segs.every((s) => s.length > 0 && !/[\[\]=\s]/.test(s));
}

const UNAVAILABLE = (): PageDataError => new PageDataError(
  'READ_UNAVAILABLE',
  '页面数据读取失败:协议调用未返回可用结果或存储值不可解析',
  '确认会话与页面仍存活后重试;读取失败不自动换页/换源',
);
const UNSUPPORTED = (): PageDataError => new PageDataError(
  'READ_UNSUPPORTED_TYPE',
  '页面数据读取失败:目标是访问器属性或非 JSON 标量(对象/数组/function/Promise/NaN/BigInt 等)',
  'data 读取与断言只支持 string/number/boolean/null 标量;对象结构请用 localStorage + --path',
);
const TOO_LARGE = (): PageDataError => new PageDataError(
  'READ_TOO_LARGE',
  '页面数据读取失败:选中值 JSON 序列化超过 100KB 上限',
  '选择更小的叶子值(组合 --path)后重试;不返回截断值',
);
export function staleContextError(): PageDataError {
  return new PageDataError(
    'STALE_CONTEXT',
    '页面上下文已变化(切换/关闭/导航/同 URL 重载),拒绝返回旧或混拼数据',
    '先 page state 确认当前页面,再重新读取',
  );
}

function missingDefaultContextError(): PageDataError {
  return new PageDataError(
    'READ_UNAVAILABLE',
    '页面数据读取失败:该 frame 缺少实际 default execution context',
    '用该 frame 的 default executionContextId 读取;禁止用 isolated world 或主文档 this 兜底',
  );
}

/** CDP 协议形状(节选自 protocol.d.ts,只声明本文件消费的字段) */
interface FrameLike {
  id?: string;
  loaderId?: string;
  url?: string;
  urlFragment?: string;
  securityOrigin?: string;
}
interface RemoteObjectLike {
  type?: string;
  subtype?: string;
  value?: unknown;
  unserializableValue?: string;
  objectId?: string;
}
interface PropertyDescriptorLike {
  name?: string;
  value?: RemoteObjectLike;
  get?: unknown;
  set?: unknown;
  wasThrown?: boolean;
}

export async function readPageIdentity(cdp: CdpSession, frameId?: string): Promise<PageIdentity> {
  let tree: { frameTree?: { frame?: FrameLike } };
  try {
    tree = await cdp.send<{ frameTree?: { frame?: FrameLike } }>('Page.getFrameTree');
  } catch {
    throw UNAVAILABLE();
  }
  const root = tree?.frameTree;
  const frame = frameId === undefined
    ? root?.frame
    : flattenFrameTrees(root).find((f) => f?.id === frameId);
  if (!frame || typeof frame.id !== 'string' || frame.id === '') throw UNAVAILABLE();
  // loaderId 允许协议真实给出的空字符串(初始 about:blank);缺字段(非空字符串)是读取失败
  if (typeof frame.loaderId !== 'string') throw UNAVAILABLE();
  return {
    frame_id: frame.id,
    loader_id: frame.loaderId,
    url: String(frame.url ?? '') + String(frame.urlFragment ?? ''),
    origin: String(frame.securityOrigin ?? ''),
  };
}

function flattenFrameTrees(tree: { frame?: FrameLike; childFrames?: unknown } | undefined): FrameLike[] {
  if (!tree) return [];
  const out: FrameLike[] = [];
  const walk = (node: { frame?: FrameLike; childFrames?: unknown }): void => {
    if (node.frame) out.push(node.frame);
    const children = Array.isArray(node.childFrames) ? node.childFrames as Array<{ frame?: FrameLike; childFrames?: unknown }> : [];
    for (const child of children) walk(child);
  };
  walk(tree);
  return out;
}

export interface PageDataReadOptions {
  defaultContextId?: number;
}

/** 读取页面数据:local-storage 走 DOMStorage 协议,global 走 Runtime 对象协议。 */
export async function readPageData(
  cdp: CdpSession,
  frameId: string,
  source: PageDataSource,
  opts: PageDataReadOptions = {},
): Promise<PageDataValue> {
  if ('local_storage' in source) {
    if (typeof source.local_storage !== 'string' || source.local_storage === '') throw UNAVAILABLE();
    return readLocalStorage(cdp, frameId, source.local_storage, source.path);
  }
  if (typeof source.global !== 'string' || source.global === '') throw UNAVAILABLE();
  const contextId = opts.defaultContextId;
  if (contextId !== undefined && (!Number.isInteger(contextId) || contextId < 0)) throw UNAVAILABLE();
  return readGlobal(cdp, frameId, source.global, contextId);
}

async function readLocalStorage(cdp: CdpSession, frameId: string, key: string, path?: string): Promise<PageDataValue> {
  let storageKey: string;
  let entries: Array<{ [k: number]: string; length: number }>;
  try {
    const keyRes = await cdp.send<{ storageKey?: string }>('Storage.getStorageKeyForFrame', { frameId });
    if (typeof keyRes?.storageKey !== 'string') throw new Error('no storageKey');
    storageKey = keyRes.storageKey;
    const items = await cdp.send<{ entries?: unknown }>('DOMStorage.getDOMStorageItems', {
      storageId: { storageKey, isLocalStorage: true },
    });
    if (!Array.isArray(items?.entries)) throw new Error('no entries');
    entries = items.entries;
  } catch (e) {
    if (e instanceof PageDataError) throw e;
    throw UNAVAILABLE();
  }
  // 只选与显式 key 精确相等的条目;不返回/记录其它 key 或全量 entries
  const hit = entries.find((e) => Array.isArray(e) && e.length >= 2 && e[0] === key);
  if (!hit) return { present: false };
  const raw = hit[1];
  // 匹配的原始值必须是字符串(DOMStorage Item = string[])
  if (typeof raw !== 'string') throw UNAVAILABLE();
  if (path === undefined) {
    checkSize(raw);
    return { present: true, value: raw };
  }
  // path 命中:JSON.parse(reviver 置空对象/数组原型)→ 既有 jsonPath(不改路径语法)
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw, nullProtoReviver);
  } catch {
    throw UNAVAILABLE();
  }
  const v = jsonPath(parsed, path);
  if (v === undefined) return { present: false };
  return scalarValue(v);
}

async function readGlobal(
  cdp: CdpSession,
  frameId: string,
  name: string,
  defaultContextId?: number,
): Promise<PageDataValue> {
  if (defaultContextId === undefined) {
    const root = await readPageIdentity(cdp);
    if (root.frame_id !== frameId) throw missingDefaultContextError();
  }
  // 每次读取唯一 objectGroup:并发观察互不释放,finally 回收本次整个组
  const objectGroup = 'e2et-page-data-' + randomUUID();
  try {
    let evalRes: { result?: RemoteObjectLike; exceptionDetails?: unknown };
    try {
      evalRes = await cdp.send<{ result?: RemoteObjectLike; exceptionDetails?: unknown }>('Runtime.evaluate', {
        expression: 'this',
        returnByValue: false,
        awaitPromise: false,
        generatePreview: false,
        objectGroup,
        ...(defaultContextId === undefined ? {} : { contextId: defaultContextId }),
      });
    } catch {
      throw UNAVAILABLE();
    }
    if (evalRes?.exceptionDetails) throw UNAVAILABLE();
    const objectId = evalRes?.result?.objectId;
    // 缺 objectId 不猜 {} 或 null
    if (typeof objectId !== 'string' || objectId === '') throw UNAVAILABLE();
    let props: { result?: PropertyDescriptorLike[] };
    try {
      props = await cdp.send<{ result?: PropertyDescriptorLike[] }>('Runtime.getProperties', {
        objectId,
        ownProperties: true,
        generatePreview: false,
      });
    } catch {
      throw UNAVAILABLE();
    }
    if (!Array.isArray(props?.result)) throw UNAVAILABLE();
    // 按 name 精确选自身属性;存在 get/set 或 wasThrown 就拒绝,不调用 getter
    const desc = props.result.find((d) => d?.name === name);
    if (!desc) return { present: false };
    if (desc.wasThrown === true || desc.get !== undefined || desc.set !== undefined) throw UNSUPPORTED();
    const obj = desc.value;
    if (!obj || typeof obj !== 'object') throw UNSUPPORTED();
    return remoteScalar(obj);
  } finally {
    // 回收本次整个 objectGroup(全局对象 + getProperties 返回的子对象/访问器句柄);
    // 释放失败(如 WS 已断)静默——句柄随 target/session 生命周期回收
    await cdp.send('Runtime.releaseObjectGroup', { objectGroup }).catch(() => {});
  }
}

/** RemoteObject → 标量。null 取 subtype;NaN/Infinity 等 unserializableValue 拒绝。 */
function remoteScalar(obj: RemoteObjectLike): PageDataValue {
  if (obj.subtype === 'null') return { present: true, value: null };
  if (obj.unserializableValue !== undefined) throw UNSUPPORTED();
  if (obj.type === 'string') {
    const v = typeof obj.value === 'string' ? obj.value : String(obj.value ?? '');
    checkSize(v);
    return { present: true, value: v };
  }
  if (obj.type === 'boolean') return { present: true, value: obj.value === true };
  if (obj.type === 'number') {
    const n = Number(obj.value);
    if (!Number.isFinite(n)) throw UNSUPPORTED();
    return { present: true, value: n };
  }
  // function/symbol/bigint/undefined/object(含 promise)拒绝
  throw UNSUPPORTED();
}

/** JSON path 命中值 → 标量结果。对象/数组/非有限数拒绝。 */
function scalarValue(v: unknown): PageDataValue {
  if (v === null) return { present: true, value: null };
  if (typeof v === 'string') {
    checkSize(v);
    return { present: true, value: v };
  }
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw UNSUPPORTED();
    return { present: true, value: v };
  }
  if (typeof v === 'boolean') return { present: true, value: v };
  throw UNSUPPORTED();
}

/** 选中值 JSON 序列化超限 → READ_TOO_LARGE(不返回截断值)。按 utf8 字节计。 */
function checkSize(v: string | number | boolean | null): void {
  if (Buffer.byteLength(JSON.stringify(v), 'utf8') > PAGE_DATA_MAX_BYTES) throw TOO_LARGE();
}

/** 仅本次 data 读取的 JSON.parse reviver:把解析出的对象/数组原型置空。
 *  目的:空 JSON 的 constructor.name 等继承属性不再被 jsonPath 误报成 present;
 *  保留实际 JSON 自身同名字段(不做字段黑名单)。不改既有 API 断言的解析行为。 */
function nullProtoReviver(_key: string, v: unknown): unknown {
  if (v !== null && typeof v === 'object') {
    if (Array.isArray(v)) {
      const copy = [...(v as unknown[])];
      Object.setPrototypeOf(copy, null);
      return copy;
    }
    return Object.assign(Object.create(null), v);
  }
  return v;
}
