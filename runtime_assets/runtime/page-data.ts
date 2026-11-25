/**
 * P2 回放侧页面数据读取:context.newCDPSession(page) 消费与生成侧相同的标准
 * CDP 协议与标量合同(CODER-P2-PAGE-DATA 第 6 节)。
 *
 * - local-storage:只返回原 storage 字符串(不解析 path;checks 的 data 分支负责
 *   JSON.parse + data-only dot path 遍历,避免循环 import)
 * - global:返回真实标量(Runtime.evaluate 固定常量 this → getProperties 自身属性;
 *   每次读取唯一 objectGroup,finally releaseObjectGroup,不执行 getter)
 * - Page.enable 后、初始 frame tree 前绑定本次读取专用的 frameNavigated /
 *   navigatedWithinDocument 事件标记,读取期间导航就拒绝;再做前后
 *   frame_id/loader_id/url 对照(SPA 跳走再跳回相同 URL 也不能绕过)
 * - 导航标记:主文档 frameNavigated 置位;navigatedWithinDocument 记 frameId 集合,
 *   只比对真实主 frame id(子 frame SPA 不误伤);监听贯穿读取与 detach 全程,
 *   数据先存局部变量,全部 cleanup await 后再同步核对导航标记/Page 存活/detach 成败
 * - finally 顺序:先 await detach(监听仍在线,漂移期导航可见)再 off 本次具名监听,
 *   不造永久全局监听(Playwright CDPSession.on 返回 this,不是退订函数);非 Chromium 明确失败
 */
import type { Page } from '@playwright/test';

export type PageDataSource = { local_storage: string; path?: string } | { global: string };
export interface PageDataValue { present: boolean; value?: string | number | boolean | null; }

/** 真实 frame 通道:由 RequestTracker 选定,同源 frame 走 page root session,OOPIF 走实际 child session。 */
export interface PageDataSession {
  send(method: string, params?: Record<string, unknown>): Promise<any>;
  on(event: string, listener: (params: any) => void): void;
  off(event: string, listener: (params: any) => void): void;
}
export interface PageDataTarget {
  session: PageDataSession;
  frameId: string;
  /** 该 frame 的真实 default executionContextId;global 读取必需,缺失即拒绝。 */
  defaultContextId?: number;
}

function unavailable(message: string): Error {
  return new Error('页面数据读取失败:' + message);
}

interface FrameLike {
  id?: string;
  loaderId?: string;
  url?: string;
  urlFragment?: string;
}
interface RemoteObjectLike {
  type?: string;
  subtype?: string;
  value?: unknown;
  unserializableValue?: string;
}
interface PropertyDescriptorLike {
  name?: string;
  value?: RemoteObjectLike;
  get?: unknown;
  set?: unknown;
  wasThrown?: boolean;
}

function flattenFrameTree(tree: { frame?: FrameLike; childFrames?: unknown } | undefined): FrameLike[] {
  if (!tree) return [];
  const out: FrameLike[] = [];
  const walk = (node: { frame?: FrameLike; childFrames?: unknown }): void => {
    if (node.frame) out.push(node.frame);
    for (const child of (node.childFrames as Array<{ frame?: FrameLike; childFrames?: unknown }> | undefined) ?? []) walk(child);
  };
  walk(tree);
  return out;
}

/** 选定 frame 的真实身份;frameId 缺省读 root(仅无 --frame 的既有路径),指定则必须在该 session 的 frame tree 中。 */
async function frameIdentity(
  session: PageDataSession,
  frameId?: string,
): Promise<{ frame_id: string; loader_id: string; url: string }> {
  const tree = await session.send('Page.getFrameTree');
  const frame = frameId === undefined
    ? tree?.frameTree?.frame
    : flattenFrameTree(tree?.frameTree).find((f) => f?.id === frameId);
  if (!frame || typeof frame.id !== 'string' || frame.id === '' || typeof frame.loaderId !== 'string') {
    throw unavailable('无法取得选定 frame 身份(协议返回不完整或 frame 缺失)');
  }
  return { frame_id: frame.id, loader_id: frame.loaderId, url: String(frame.url ?? '') + String(frame.urlFragment ?? '') };
}

export async function readPageDataSource(
  page: Page,
  source: PageDataSource,
  target?: PageDataTarget,
): Promise<PageDataValue> {
  // 无 --frame 时才是主文档读取;指定 frame 时只接受调用方选定的真实通道,缺通道直接拒绝(不 root 兜底)。
  let ownedSession: { detach(): Promise<void> } | undefined;
  let session: PageDataSession;
  if (target) {
    session = target.session;
  } else {
    const context = page.context() as unknown as { newCDPSession?: (p: Page) => Promise<PageDataSession & { detach(): Promise<void> }> };
    if (typeof context.newCDPSession !== 'function') {
      throw new Error('assert data 只支持 Chromium 浏览器(需要 CDP 会话读取 localStorage/全局标量),当前 context 不提供 newCDPSession');
    }
    const created = await context.newCDPSession(page);
    session = created;
    ownedSession = created;
  }
  // P4 导航标记:主文档 frameNavigated(parentId 缺失)置位;navigatedWithinDocument 记录 frameId 集合,
  // 监听贯穿初始身份获取/读取/读后对照/detach 全程(不在 detach 前撤),最终只核对真实 before.frame_id,
  // 子 frame SPA 不误伤主文档,主 frame 跳走再跳回(frameNavigated 事件已发生)仍拒绝
  let mainNavigated = false;
  const navWithinDocFrames = new Set<string>();
  // 命名 listener:Playwright CDPSession.on 返回 this(非退订函数),detach 完成后用 off(event, listener) 移除
  // 选定 frame id 在 before 读取后确定;此前到达的导航已反映在 before 身份里,不会读到旧数据。
  let observedFrameId: string | undefined;
  const onFrameNavigated = (params: { frame?: { id?: unknown; parentId?: unknown } }): void => {
    // 主文档导航或选定 frame 自身导航都使读取失效;其他子 frame 导航由 before/after 身份对照兜底。
    if (observedFrameId === undefined) {
      if (params?.frame?.parentId === undefined) mainNavigated = true;
    } else if (params?.frame?.id === observedFrameId || params?.frame?.parentId === undefined) {
      mainNavigated = true;
    }
  };
  const onNavigatedWithinDocument = (params: { frameId?: unknown }): void => {
    // 只记录真实字符串 frameId;最终只接受与 before.frame_id 相同的事件,其余(子 frame/无 id)不计数
    if (typeof params?.frameId === 'string') navWithinDocFrames.add(params.frameId);
  };
  type Outcome =
    | { ok: true; value: PageDataValue; frameId: string }
    | { ok: false; error: unknown };
  let outcome: Outcome;
  try {
    await session.send('Page.enable');
    session.on('Page.frameNavigated', onFrameNavigated);
    session.on('Page.navigatedWithinDocument', onNavigatedWithinDocument);
    const before = await frameIdentity(session, target?.frameId);
    observedFrameId = before.frame_id;
    const value = 'local_storage' in source
      ? await readLocalStorage(session, before.frame_id, source.local_storage)
      : await readGlobal(session, source.global, target ? target.defaultContextId : undefined, target !== undefined);
    if (mainNavigated || navWithinDocFrames.has(before.frame_id)) throw unavailable('读取期间页面发生导航,拒绝返回旧数据');
    const after = await frameIdentity(session, target?.frameId);
    if (mainNavigated || navWithinDocFrames.has(before.frame_id) || after.frame_id !== before.frame_id || after.loader_id !== before.loader_id || after.url !== before.url) {
      throw unavailable('页面上下文已变化(导航/同 URL 重载),拒绝返回旧或混拼数据');
    }
    outcome = { ok: true, value, frameId: before.frame_id };
  } catch (e) {
    outcome = { ok: false, error: e };
  }
  // cleanup:监听保留到 detach 完成(漂移期间导航仍可见),之后无论成败都 off
  let detachError: unknown;
  if (ownedSession) {
    try {
      await ownedSession.detach();
    } catch (e) { detachError = e; }
  }
  try {
    session.off('Page.frameNavigated', onFrameNavigated);
    session.off('Page.navigatedWithinDocument', onNavigatedWithinDocument);
  } catch { /* session 已关闭 */ }
  if (!outcome.ok) throw outcome.error;
  // 数据在局部变量;全部 cleanup await 后同步核对导航标记/Page 存活/detach 成败,最后才返回
  if (detachError !== undefined) throw unavailable('读取会话清理失败,拒绝返回未验证数据');
  if (page.isClosed()) throw unavailable('读取期间页面已关闭,拒绝返回旧数据');
  if (mainNavigated || navWithinDocFrames.has(outcome.frameId)) throw unavailable('清理期间页面发生导航,拒绝返回旧数据');
  return outcome.value;
}

async function readLocalStorage(session: PageDataSession, frameId: string, key: string): Promise<PageDataValue> {
  const keyRes = await session.send('Storage.getStorageKeyForFrame', { frameId });
  if (typeof keyRes?.storageKey !== 'string') throw unavailable('协议未返回 storageKey');
  const items = await session.send('DOMStorage.getDOMStorageItems', {
    storageId: { storageKey: keyRes.storageKey, isLocalStorage: true },
  });
  if (!Array.isArray(items?.entries)) throw unavailable('协议未返回存储条目');
  const hit = (items.entries as string[][]).find((e) => Array.isArray(e) && e.length >= 2 && e[0] === key);
  if (!hit) return { present: false };
  if (typeof hit[1] !== 'string') throw unavailable('匹配条目不是字符串');
  return { present: true, value: hit[1] };
}

async function readGlobal(
  session: PageDataSession,
  name: string,
  defaultContextId: number | undefined,
  frameSelected: boolean,
): Promise<PageDataValue> {
  // 选定 frame 的 global 必须走该 frame 的真实 default world;缺 context 不退回主文档 this。
  if (frameSelected && defaultContextId === undefined) {
    throw unavailable('选定 frame 缺少真实 default execution context,拒绝用主文档 this 兜底');
  }
  // 每次读取唯一 objectGroup;finally releaseObjectGroup 回收整个组
  const objectGroup = 'e2et-replay-' + Math.random().toString(36).slice(2) + '-' + Date.now().toString(36);
  try {
    const evalRes = await session.send('Runtime.evaluate', {
      expression: 'this',
      returnByValue: false,
      awaitPromise: false,
      generatePreview: false,
      objectGroup,
      ...(defaultContextId === undefined ? {} : { contextId: defaultContextId }),
    });
    if (evalRes?.exceptionDetails) throw unavailable('全局对象求值异常');
    const objectId = evalRes?.result?.objectId;
    if (typeof objectId !== 'string' || objectId === '') throw unavailable('全局对象无 objectId');
    const props: { result?: PropertyDescriptorLike[] } = await session.send('Runtime.getProperties', {
      objectId,
      ownProperties: true,
      generatePreview: false,
    });
    if (!Array.isArray(props?.result)) throw unavailable('协议未返回属性列表');
    const desc = props.result.find((d) => d?.name === name);
    if (!desc) return { present: false };
    if (desc.wasThrown === true || desc.get !== undefined || desc.set !== undefined) {
      throw unavailable(`global "${name}" 是访问器属性,拒绝读取(不执行 getter)`);
    }
    const obj = desc.value;
    if (!obj || typeof obj !== 'object') throw unavailable(`global "${name}" 描述符无值`);
    if (obj.subtype === 'null') return { present: true, value: null };
    if (obj.unserializableValue !== undefined) throw unavailable(`global "${name}" 是非 JSON 标量(NaN/BigInt 等)`);
    if (obj.type === 'string') return { present: true, value: typeof obj.value === 'string' ? obj.value : String(obj.value ?? '') };
    if (obj.type === 'boolean') return { present: true, value: obj.value === true };
    if (obj.type === 'number') {
      const n = Number(obj.value);
      if (!Number.isFinite(n)) throw unavailable(`global "${name}" 数字非有限`);
      return { present: true, value: n };
    }
    throw unavailable(`global "${name}" 是非标量(${obj.type ?? 'unknown'}),只支持 string/number/boolean/null`);
  } finally {
    await session.send('Runtime.releaseObjectGroup', { objectGroup }).catch(() => {});
  }
}
