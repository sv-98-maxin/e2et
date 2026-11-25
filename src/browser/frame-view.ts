/**
 * 短生命周期 frame 作用域视图：把 evaluate / AX 树 / DOM.getDocument 限定到单个 iframe。
 * 每个 action 按需创建，用完即弃；不缓存跨 action / context 的句柄。
 * OOPIF 或失效 frame → FrameUnavailableError（fail-closed，不回退主文档，不换世界重试）。
 */
import type { CdpSession } from './daemon-client.js';

export class FrameUnavailableError extends Error {
  readonly code = 'FRAME_UNSUPPORTED';
  constructor(reason: string) { super(`frame 不可用: ${reason}`); this.name = 'FrameUnavailableError'; }
}

/**
 * 创建 frame 作用域的 CdpSession Proxy。
 *
 * 协议链（真实 CDP，不造假）：
 * - 先 Page.createIsolatedWorld 拿该 frame 的 executionContextId；
 *   缺/非法 context 或协议错误抛 FrameUnavailableError。
 * - Proxy.evaluate：走 Runtime.evaluate + 固定 contextId，语义与 CdpSession.evaluate
 *   一致（returnByValue/awaitPromise/异常文本），只是强制 frame 世界。
 * - Proxy.send(Runtime.evaluate)：spread 后强制 contextId，caller 无法覆盖。
 * - Proxy.send(Accessibility.getFullAXTree)：强制 frameId，AX 树按 frame 过滤。
 * - Proxy.send(DOM.getDocument)：用该 isolated world 的 document 句柄合成
 *   {root:{nodeId}}——Runtime.evaluate → objectId → DOM.requestNode → nodeId，
 *   requestNode 后 finally releaseObject，句柄不跨调用缓存。
 * - 其它成员（on/onClose/takeEvents/close 等）经 Reflect.get 透传原 session，
 *   函数 bind 原对象，避免 private state 的 this 被代理破坏。
 */
export async function createFrameView(cdp: CdpSession, frameId: string, deadlineMs?: number): Promise<CdpSession> {
  let world: { executionContextId?: number };
  try {
    world = await cdp.send<{ executionContextId?: number }>(
      'Page.createIsolatedWorld', { frameId, worldName: 'e2et-frame-view' }, deadlineMs,
    );
  } catch (e) {
    throw new FrameUnavailableError(`createIsolatedWorld 失败: ${(e as Error).message}`);
  }
  const contextId = world.executionContextId;
  if (typeof contextId !== 'number' || !Number.isInteger(contextId) || contextId < 0) {
    throw new FrameUnavailableError(`isolate world 未返回合法 executionContextId: ${JSON.stringify(world)}`);
  }

  /** DOM.getDocument：isolated world 的 document 句柄链，一次一取不缓存 */
  async function frameDocumentRoot(): Promise<{ root: { nodeId: number } }> {
    // DOM.requestNode 需要 DOM 前端有根：先取原 target 根初始化（结果丢弃，不用于 frame 定位）
    try {
      await cdp.send('DOM.getDocument', { depth: 0 });
    } catch (e) {
      throw new FrameUnavailableError(`DOM 前端根初始化失败: ${(e as Error).message}`);
    }
    let objectId: string;
    const doc = await cdp.send<{
      result?: { objectId?: string };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    }>('Runtime.evaluate', { expression: 'document', contextId, returnByValue: false, awaitPromise: false });
    if (doc.exceptionDetails) {
      throw new FrameUnavailableError(`frame document 求值失败: ${doc.exceptionDetails.exception?.description || doc.exceptionDetails.text}`);
    }
    objectId = doc.result?.objectId ?? '';
    if (!objectId) throw new FrameUnavailableError('frame document 未返回 objectId');
    let nodeId = 0;
    try {
      // 真实协议形状：DOM.requestNode 返回顶层 {nodeId}
      const node = await cdp.send<{ nodeId?: number }>('DOM.requestNode', { objectId });
      nodeId = node?.nodeId ?? 0;
    } catch (e) {
      throw new FrameUnavailableError(`DOM.requestNode 失败: ${(e as Error).message}`);
    } finally {
      await cdp.send('Runtime.releaseObject', { objectId }).catch(() => { /* 句柄释放尽力而为 */ });
    }
    if (!Number.isInteger(nodeId) || nodeId <= 0) {
      throw new FrameUnavailableError(`DOM.requestNode 未返回合法 nodeId: ${nodeId}`);
    }
    return { root: { nodeId } };
  }

  const scopedSend = async <T = any>(method: string, params: Record<string, unknown> = {}, deadline = deadlineMs): Promise<T> => {
    if (method === 'Runtime.evaluate') {
      // spread 之后强制 contextId：caller 传什么都会被覆盖到 frame 世界
      return cdp.send<T>(method, { ...params, contextId }, deadline);
    }
    if (method === 'Accessibility.getFullAXTree') {
      return cdp.send<T>(method, { ...params, frameId }, deadline);
    }
    if (method === 'DOM.getDocument') {
      return frameDocumentRoot() as Promise<T>;
    }
    return cdp.send<T>(method, params, deadline);
  };

  const scopedEvaluate = async <T = any>(expression: string): Promise<T> => {
    const res = await cdp.send<{
      result?: { value?: T };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    }>('Runtime.evaluate', { expression, contextId, returnByValue: true, awaitPromise: true });
    if (res.exceptionDetails) {
      throw new Error(`页面脚本异常: ${res.exceptionDetails.exception?.description || res.exceptionDetails.text}`);
    }
    return res.result?.value as T;
  };

  return new Proxy(cdp, {
    get(target: CdpSession, prop: string | symbol, _receiver: unknown): unknown {
      if (prop === 'send') return scopedSend;
      if (prop === 'evaluate') return scopedEvaluate;
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as CdpSession;
}
