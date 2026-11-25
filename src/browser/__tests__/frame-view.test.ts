/**
 * frame-view 生产入口测试（P3 合同 §6）：
 * 真实协议链（Runtime.evaluate → objectId → DOM.requestNode → nodeId → releaseObject）、
 * contextId/frameId 强制覆盖、非拦截方法 this 透传、句柄不缓存、失效协议 fail-closed。
 */
import { describe, it, expect, vi } from 'vitest';
import { createFrameView, FrameUnavailableError } from '../frame-view.js';

/** 最小 CdpSession 形状 mock：可编程 send 分派 */
class FakeCdp {
  calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  private listeners = new Map<string, Array<(params: any) => void>>();
  private secret = 'priv'; // 私有状态：验证非拦截方法 this 绑定原对象
  /** 按方法名编程返回/抛错的 handler */
  handlers = new Map<string, (params: Record<string, unknown>) => any>();

  on(method: string, handler: (params: any) => void): () => void {
    const list = this.listeners.get(method) ?? [];
    list.push(handler);
    this.listeners.set(method, list);
    return () => this.listeners.set(method, list.filter((item) => item !== handler));
  }

  onClose(): string { return this.secret; }

  takeEvents(): string[] { return [this.secret]; }

  async send<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ method, params });
    const h = this.handlers.get(method);
    if (!h) return {} as T;
    return h(params) as T;
  }

  async evaluate<T = any>(expression: string): Promise<T> {
    const h = this.handlers.get('Runtime.evaluate');
    return (h ? h({ expression }) : {}) as T;
  }

  sent(method: string): Array<Record<string, unknown>> {
    return this.calls.filter((c) => c.method === method).map((c) => c.params);
  }
}

function fakeWithWorld(contextId = 7): FakeCdp {
  const cdp = new FakeCdp();
  cdp.handlers.set('Page.createIsolatedWorld', () => ({ executionContextId: contextId }));
  return cdp;
}

describe('createFrameView 真实协议链', () => {
  it('DOM.getDocument：Runtime.evaluate(document) → objectId → DOM.requestNode → {root:{nodeId}}，finally releaseObject', async () => {
    const cdp = fakeWithWorld();
    cdp.handlers.set('Runtime.evaluate', (p) => {
      if (p.expression === 'document') return { result: { objectId: 'doc-obj-1' } };
      return {};
    });
    cdp.handlers.set('DOM.requestNode', () => ({ nodeId: 42 }));
    const view = await createFrameView(cdp as any, 'frame-1');
    const doc = await view.send<{ root: { nodeId: number } }>('DOM.getDocument', { depth: -1 });
    expect(doc).toEqual({ root: { nodeId: 42 } });
    // 协议链按真实顺序消费
    const evals = cdp.sent('Runtime.evaluate');
    expect(evals[0]).toMatchObject({ expression: 'document', contextId: 7, returnByValue: false });
    expect(cdp.sent('DOM.requestNode')[0]).toEqual({ objectId: 'doc-obj-1' });
    // requestNode 后 finally releaseObject（requestNode 成功也必须释放）
    expect(cdp.sent('Runtime.releaseObject').length).toBeGreaterThanOrEqual(1);
  });

  it('document 句柄不缓存：两次 DOM.getDocument 走两次完整协议链', async () => {
    const cdp = fakeWithWorld();
    let objSeq = 0;
    cdp.handlers.set('Runtime.evaluate', (p) => {
      if (p.expression === 'document') return { result: { objectId: 'doc-' + (++objSeq) } };
      return {};
    });
    cdp.handlers.set('DOM.requestNode', () => ({ nodeId: 42 }));
    const view = await createFrameView(cdp as any, 'frame-1');
    await view.send('DOM.getDocument');
    await view.send('DOM.getDocument');
    expect(cdp.sent('Runtime.evaluate').filter((p) => p.expression === 'document')).toHaveLength(2);
    expect(cdp.sent('DOM.requestNode')).toHaveLength(2);
    expect(cdp.sent('Runtime.releaseObject')).toHaveLength(2);
  });

  it(' objectId 缺失 → FrameUnavailableError（不返回空根）', async () => {
    const cdp = fakeWithWorld();
    cdp.handlers.set('Runtime.evaluate', () => ({ result: {} }));
    const view = await createFrameView(cdp as any, 'frame-1');
    await expect(view.send('DOM.getDocument')).rejects.toBeInstanceOf(FrameUnavailableError);
  });

  it('document 求值 exceptionDetails → FrameUnavailableError', async () => {
    const cdp = fakeWithWorld();
    cdp.handlers.set('Runtime.evaluate', () => ({ result: {}, exceptionDetails: { text: 'ctx destroyed' } }));
    const view = await createFrameView(cdp as any, 'frame-1');
    await expect(view.send('DOM.getDocument')).rejects.toBeInstanceOf(FrameUnavailableError);
  });

  it('requestNode 返回 nodeId=0 → FrameUnavailableError（不返回 0 根）', async () => {
    const cdp = fakeWithWorld();
    cdp.handlers.set('Runtime.evaluate', () => ({ result: { objectId: 'doc-obj' } }));
    cdp.handlers.set('DOM.requestNode', () => ({ nodeId: 0 }));
    const view = await createFrameView(cdp as any, 'frame-1');
    await expect(view.send('DOM.getDocument')).rejects.toBeInstanceOf(FrameUnavailableError);
    // 失败路径也 releaseObject
    expect(cdp.sent('Runtime.releaseObject').length).toBeGreaterThanOrEqual(1);
  });

  it('requestNode 缺 nodeId 字段 → FrameUnavailableError（不返回假根）', async () => {
    const cdp = fakeWithWorld();
    cdp.handlers.set('Runtime.evaluate', () => ({ result: { objectId: 'doc-obj' } }));
    cdp.handlers.set('DOM.requestNode', () => ({}));
    const view = await createFrameView(cdp as any, 'frame-1');
    await expect(view.send('DOM.getDocument')).rejects.toBeInstanceOf(FrameUnavailableError);
    expect(cdp.sent('Runtime.releaseObject').length).toBeGreaterThanOrEqual(1);
  });

  it('requestNode 协议错误 → FrameUnavailableError（finally 仍 releaseObject）', async () => {
    const cdp = fakeWithWorld();
    cdp.handlers.set('Runtime.evaluate', () => ({ result: { objectId: 'doc-obj' } }));
    cdp.handlers.set('DOM.requestNode', () => { throw new Error('CDP error: no node'); });
    const view = await createFrameView(cdp as any, 'frame-1');
    await expect(view.send('DOM.getDocument')).rejects.toBeInstanceOf(FrameUnavailableError);
    expect(cdp.sent('Runtime.releaseObject').length).toBeGreaterThanOrEqual(1);
  });
});

describe('createFrameView context/frame 强制覆盖', () => {
  it('send(Runtime.evaluate)：caller 传 contextId 也会被覆盖为 frame 世界', async () => {
    const cdp = fakeWithWorld(7);
    cdp.handlers.set('Runtime.evaluate', () => ({ result: { value: 'ok' } }));
    const view = await createFrameView(cdp as any, 'frame-1');
    await view.send('Runtime.evaluate', { expression: '1', contextId: 999 });
    expect(cdp.sent('Runtime.evaluate').at(-1)).toMatchObject({ expression: '1', contextId: 7 });
  });

  it('send(Accessibility.getFullAXTree)：强制 frameId', async () => {
    const cdp = fakeWithWorld();
    cdp.handlers.set('Accessibility.getFullAXTree', () => ({ nodes: [] }));
    const view = await createFrameView(cdp as any, 'frame-9');
    await view.send('Accessibility.getFullAXTree', {});
    expect(cdp.sent('Accessibility.getFullAXTree').at(-1)).toMatchObject({ frameId: 'frame-9' });
  });

  it('evaluate：走固定 contextId + 真实 returnByValue/awaitPromise 语义', async () => {
    const cdp = fakeWithWorld(7);
    cdp.handlers.set('Runtime.evaluate', () => ({ result: { value: 'hello' } }));
    const view = await createFrameView(cdp as any, 'frame-1');
    const v = await view.evaluate<string>('location.href');
    expect(v).toBe('hello');
    expect(cdp.sent('Runtime.evaluate').at(-1)).toMatchObject({ expression: 'location.href', contextId: 7, returnByValue: true, awaitPromise: true });
  });

  it('evaluate exceptionDetails → 页面脚本异常（CdpSession.evaluate 同语义）', async () => {
    const cdp = fakeWithWorld();
    cdp.handlers.set('Runtime.evaluate', () => ({ result: {}, exceptionDetails: { text: 'oops', exception: { description: 'TypeError: boom at line 1' } } }));
    const view = await createFrameView(cdp as any, 'frame-1');
    await expect(view.evaluate('bad()')).rejects.toThrow('页面脚本异常: TypeError: boom at line 1');
  });

  it('其它方法原样透传（params 不改写）', async () => {
    const cdp = fakeWithWorld();
    const view = await createFrameView(cdp as any, 'frame-1');
    await view.send('DOM.resolveNode', { backendNodeId: 33 });
    expect(cdp.sent('DOM.resolveNode').at(-1)).toEqual({ backendNodeId: 33 });
  });
});

describe('createFrameView fail-closed 与透传 this', () => {
  it('createIsolatedWorld 协议错误 → FrameUnavailableError', async () => {
    const cdp = new FakeCdp();
    cdp.handlers.set('Page.createIsolatedWorld', () => { throw new Error('CDP error: no frame'); });
    await expect(createFrameView(cdp as any, 'gone-frame')).rejects.toBeInstanceOf(FrameUnavailableError);
  });

  it('缺/非法 executionContextId → FrameUnavailableError', async () => {
    for (const bad of [{}, { executionContextId: undefined }, { executionContextId: -1 }, { executionContextId: 1.5 }]) {
      const cdp = new FakeCdp();
      cdp.handlers.set('Page.createIsolatedWorld', () => bad);
      await expect(createFrameView(cdp as any, 'frame-1')).rejects.toBeInstanceOf(FrameUnavailableError);
    }
  });

  it('非拦截方法保留 this：onClose/takeEvents 读到原 session 私有状态', async () => {
    const cdp = fakeWithWorld();
    const view = await createFrameView(cdp as any, 'frame-1');
    expect((view as any).takeEvents()).toEqual(['priv']);
    expect((view as any).onClose()).toBe('priv');
  });

  it('on() 透传原 session：事件回调真实可达', async () => {
    const cdp = fakeWithWorld();
    const view = await createFrameView(cdp as any, 'frame-1');
    const seen: any[] = [];
    view.on('Page.frameNavigated', (p) => seen.push(p));
    cdp.listeners.get('Page.frameNavigated')?.forEach((h) => h({ frame: { id: 'frame-1' } }));
    expect(seen).toEqual([{ frame: { id: 'frame-1' } }]);
  });
});

/** 有状态 DOM 前端 mock：requestNode 只有在 DOM.getDocument 已初始化后才返回真实 nodeId，
 *  未初始化返回 0（建模 CDP 真机行为：requestNode 需要该 target DOM 前端有根）。 */
class StatefulDomCdp {
  calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  rootRequested = false;
  /** 主文档根（与 frame 根 42 不同，防止误当定位结果） */
  mainRootNodeId = 1;
  /** 可控开关：初始化 getDocument 抛错 / requestNode 恒 0 */
  initFails = false;
  requestNodeAlwaysZero = false;

  async send<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ method, params });
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 } as T;
    if (method === 'DOM.getDocument') {
      this.rootRequested = true;
      if (this.initFails) throw new Error('CDP error: DOM agent not ready');
      return { root: { nodeId: this.mainRootNodeId } } as T;
    }
    if (method === 'Runtime.evaluate' && params.expression === 'document') {
      return { result: { objectId: 'frame-doc' } } as T;
    }
    if (method === 'DOM.requestNode') {
      const nodeId = this.requestNodeAlwaysZero || !this.rootRequested ? 0 : 42;
      return { nodeId } as T;
    }
    if (method === 'Runtime.releaseObject') return {} as T;
    return {} as T;
  }
}

describe('DOM 前端根初始化（真机 frame CSS 修复）', () => {
  it('未初始化时 requestNode=0：frame 根必须先初始化 DOM 前端再拿 42（不是主根 1）', async () => {
    const cdp = new StatefulDomCdp();
    const view = await createFrameView(cdp as any, 'frame-1');
    const doc = await view.send<{ root: { nodeId: number } }>('DOM.getDocument', { depth: -1 });
    // 帧根来自 requestNode（42），不是主文档根（1），也不是未初始化的 0
    expect(doc).toEqual({ root: { nodeId: 42 } });
    // 协议顺序：DOM 前端初始化（depth:0 getDocument）先于 frame document 求值与 requestNode
    const initIdx = cdp.calls.findIndex((c) => c.method === 'DOM.getDocument' && c.params.depth === 0);
    const evalIdx = cdp.calls.findIndex((c) => c.method === 'Runtime.evaluate' && c.params.expression === 'document');
    const reqIdx = cdp.calls.findIndex((c) => c.method === 'DOM.requestNode');
    expect(initIdx).toBeGreaterThanOrEqual(0);
    expect(evalIdx).toBeGreaterThan(initIdx);
    expect(reqIdx).toBeGreaterThan(evalIdx);
  });

  it('初始化拒绝 → FrameUnavailableError，不进入 frame document/requestNode', async () => {
    const cdp = new StatefulDomCdp();
    cdp.initFails = true;
    const view = await createFrameView(cdp as any, 'frame-1');
    await expect(view.send('DOM.getDocument')).rejects.toBeInstanceOf(FrameUnavailableError);
    // 拒绝后没有 evaluate('document') / requestNode 调用
    expect(cdp.calls.some((c) => c.method === 'Runtime.evaluate' && c.params.expression === 'document')).toBe(false);
    expect(cdp.calls.some((c) => c.method === 'DOM.requestNode')).toBe(false);
  });

  it('初始化后 requestNode 仍 0 → 仍 FrameUnavailableError（不回退/不重试）', async () => {
    const cdp = new StatefulDomCdp();
    cdp.requestNodeAlwaysZero = true;
    const view = await createFrameView(cdp as any, 'frame-1');
    await expect(view.send('DOM.getDocument')).rejects.toBeInstanceOf(FrameUnavailableError);
  });

  it('二次 DOM.getDocument 每次都重新初始化前端根（不缓存）', async () => {
    const cdp = new StatefulDomCdp();
    const view = await createFrameView(cdp as any, 'frame-1');
    await view.send('DOM.getDocument');
    await view.send('DOM.getDocument');
    // 两次 frame 取根 = 两次 depth:0 初始化（导航后根可能已换，不缓存）
    expect(cdp.calls.filter((c) => c.method === 'DOM.getDocument' && c.params.depth === 0)).toHaveLength(2);
    expect(cdp.calls.filter((c) => c.method === 'DOM.requestNode')).toHaveLength(2);
  });
});
