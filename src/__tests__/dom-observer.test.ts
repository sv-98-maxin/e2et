import { describe, expect, it } from 'vitest';
import * as vm from 'node:vm';
import { OBSERVER_SCRIPT } from '../daemon/observer-script.js';

/** 创建模拟浏览器 DOM 上下文供 OBSERVER_SCRIPT 原样 IIFE 执行 */
function createContext() {
  const dclListeners: Array<{ handler: () => void; once: boolean }> = [];
  let docEl: Element | null = null;
  const observers: Array<{ root: Element; cb: MutationCallback }> = [];

  class FakeMutationObserver {
    private cb: MutationCallback;
    constructor(cb: MutationCallback) { this.cb = cb; }
    observe(root: Element) { observers.push({ root, cb: this.cb }); }
    disconnect() {
      const i = observers.findIndex((o) => o.cb === this.cb);
      if (i !== -1) observers.splice(i, 1);
    }
  }

  const doc = {
    get documentElement() { return docEl; },
    addEventListener(event: string, handler: () => void, opts?: { once?: boolean }) {
      if (event === 'DOMContentLoaded') dclListeners.push({ handler, once: !!opts?.once });
    },
  };

  const ctx = vm.createContext({
    window: {} as Record<string, unknown>,
    document: doc,
    MutationObserver: FakeMutationObserver,
    _setDocEl(el: Element | null) { docEl = el; },
    _fireDOMContentLoaded() {
      for (const { handler, once } of dclListeners) handler();
      for (let i = dclListeners.length - 1; i >= 0; i--) { if (dclListeners[i].once) dclListeners.splice(i, 1); }
    },
    _observerCount: () => observers.length,
    _getObservers: () => [...observers],
  });

  return ctx;
}

describe('OBSERVER_SCRIPT', () => {
  it('同 root 幂等：重复执行不创建新 observer', () => {
    const ctx = createContext();
    (ctx as any)._setDocEl({} as Element);

    vm.runInContext(OBSERVER_SCRIPT, ctx);
    const obs1 = vm.runInContext('window.__e2etObserver', ctx);
    const root1 = vm.runInContext('window.__e2etObsRoot', ctx);

    vm.runInContext(OBSERVER_SCRIPT, ctx);
    const obs2 = vm.runInContext('window.__e2etObserver', ctx);
    const root2 = vm.runInContext('window.__e2etObsRoot', ctx);

    expect(obs2).toBe(obs1);
    expect(root2).toBe(root1);
    expect((ctx as any)._observerCount()).toBe(1);
  });

  it('换 root 时 disconnect 旧 observer 并绑新 root', () => {
    const ctx = createContext();
    const rootA = { tag: 'A' } as unknown as Element;
    (ctx as any)._setDocEl(rootA);

    vm.runInContext(OBSERVER_SCRIPT, ctx);
    const obs1 = vm.runInContext('window.__e2etObserver', ctx);
    expect(vm.runInContext('window.__e2etObsRoot', ctx)).toBe(rootA);

    const rootB = { tag: 'B' } as unknown as Element;
    (ctx as any)._setDocEl(rootB);
    vm.runInContext(OBSERVER_SCRIPT, ctx);

    const obs2 = vm.runInContext('window.__e2etObserver', ctx);
    expect(obs2).not.toBe(obs1);
    expect(vm.runInContext('window.__e2etObsRoot', ctx)).toBe(rootB);
    expect((ctx as any)._observerCount()).toBe(1);
  });

  it('旧 root 仍 isConnected=true 且换 document 时不保留旧 observer', () => {
    // 真实对照：popup 初始空文档的 root.isConnected=true 但不再是当前 documentElement
    const ctx = createContext();
    const oldRoot = { tag: 'oldRoot' } as unknown as Element;
    (ctx as any)._setDocEl(oldRoot);

    vm.runInContext(OBSERVER_SCRIPT, ctx);
    expect(vm.runInContext('window.__e2etObsRoot', ctx)).toBe(oldRoot);
    const obs1 = vm.runInContext('window.__e2etObserver', ctx);

    // 模拟导航：documentElement 变为新 root（oldRoot 对象仍存活但不再是 documentElement）
    const newRoot = { tag: 'newRoot' } as unknown as Element;
    (ctx as any)._setDocEl(newRoot);
    vm.runInContext(OBSERVER_SCRIPT, ctx);

    // 旧 observer 被 disconnect，新 observer 绑到新 root
    expect(vm.runInContext('window.__e2etObsRoot', ctx)).toBe(newRoot);
    expect(vm.runInContext('window.__e2etObserver', ctx)).not.toBe(obs1);
    expect((ctx as any)._observerCount()).toBe(1);
    expect((ctx as any)._getObservers()[0].root).toBe(newRoot);
  });

  it('root 为空时 DCL 回调中 document 不匹配则不挂 observer', () => {
    const ctx = createContext();
    (ctx as any)._setDocEl(null);

    vm.runInContext(OBSERVER_SCRIPT, ctx);
    expect(vm.runInContext('window.__e2etObserver', ctx)).toBeUndefined();

    // 先设 documentElement（让回调有 root 可绑），再替换 document 对象
    (ctx as any)._setDocEl({ tag: 'newDoc' } as unknown as Element);
    // 替换 document 使 document !== 捕获的 doc
    vm.runInContext('document = { documentElement: window.__e2etObsRoot, addEventListener: function(){} }', ctx);
    (ctx as any)._fireDOMContentLoaded();

    // 旧回调的 document !== doc 检查使其跳过 attach
    expect(vm.runInContext('window.__e2etObserver', ctx)).toBeUndefined();
  });

  it('root 为空时 DCL 回调正常绑定', () => {
    const ctx = createContext();
    (ctx as any)._setDocEl(null);

    vm.runInContext(OBSERVER_SCRIPT, ctx);
    expect(vm.runInContext('window.__e2etObserver', ctx)).toBeUndefined();

    const root = { tag: 'root' } as unknown as Element;
    (ctx as any)._setDocEl(root);
    (ctx as any)._fireDOMContentLoaded();

    expect(vm.runInContext('window.__e2etObserver', ctx)).toBeDefined();
    expect(vm.runInContext('window.__e2etObsRoot', ctx)).toBe(root);
  });

  it('DOMContentLoaded once 语义：后续触发不影响已绑 observer', () => {
    const ctx = createContext();
    (ctx as any)._setDocEl(null);

    vm.runInContext(OBSERVER_SCRIPT, ctx);

    const root = { tag: 'root' } as unknown as Element;
    (ctx as any)._setDocEl(root);
    (ctx as any)._fireDOMContentLoaded();
    expect(vm.runInContext('window.__e2etObserver', ctx)).toBeDefined();

    const obs1 = vm.runInContext('window.__e2etObserver', ctx);
    (ctx as any)._fireDOMContentLoaded(); // once 已退订，不应重绑
    expect(vm.runInContext('window.__e2etObserver', ctx)).toBe(obs1);
    expect((ctx as any)._observerCount()).toBe(1);
  });

  it('旧 pending DCL 回调不覆盖已安装的新 doc observer', () => {
    // 场景：IIFE1 在无 root 时注册 DCL；导航后 IIFE2 在新 doc 上已有 root 直接绑
    // 旧 DCL 仍会触发但 document !== doc 使其跳过
    const ctx = createContext();
    (ctx as any)._setDocEl(null);

    vm.runInContext(OBSERVER_SCRIPT, ctx); // IIFE1: 无 root，注册 DCL
    expect(vm.runInContext('window.__e2etObserver', ctx)).toBeUndefined();

    // 导航完成：新 document 有 root
    const newRoot = { tag: 'newRoot' } as unknown as Element;
    (ctx as any)._setDocEl(newRoot);
    vm.runInContext(OBSERVER_SCRIPT, ctx); // IIFE2: 有 root，直接绑
    const obs2 = vm.runInContext('window.__e2etObserver', ctx);
    expect(obs2).toBeDefined();
    expect(vm.runInContext('window.__e2etObsRoot', ctx)).toBe(newRoot);

    // 旧 DCL 触发：document 已不是 IIFE1 捕获的 doc（本 vm 中 document 未变，
    // 但 DCL once 语义使其只触发一次，已被 IIFE2 的执行消费——验证 observer 不变）
    (ctx as any)._fireDOMContentLoaded();
    // observer 仍是 IIFE2 绑的，未被旧 DCL 覆盖
    expect(vm.runInContext('window.__e2etObserver', ctx)).toBe(obs2);
    expect((ctx as any)._observerCount()).toBe(1);
  });

  it('同 doc root 为空重复注入只产生一个 observer', () => {
    const ctx = createContext();
    (ctx as any)._setDocEl(null);

    vm.runInContext(OBSERVER_SCRIPT, ctx); // 第一次
    vm.runInContext(OBSERVER_SCRIPT, ctx); // 重复：仍无 root

    // 尚无 observer（两次都走 DCL 注册路径）
    expect(vm.runInContext('window.__e2etObserver', ctx)).toBeUndefined();

    // 设置 root 并触发 DCL——once 语义让第一个 handler 消费后移除
    const root = { tag: 'root' } as unknown as Element;
    (ctx as any)._setDocEl(root);
    (ctx as any)._fireDOMContentLoaded();

    expect(vm.runInContext('window.__e2etObserver', ctx)).toBeDefined();
    expect((ctx as any)._observerCount()).toBe(1);
  });

  it('mutation 触发时递增 __e2etChangeCount', () => {
    const ctx = createContext();
    (ctx as any)._setDocEl({} as Element);

    vm.runInContext(OBSERVER_SCRIPT, ctx);
    expect(vm.runInContext('window.__e2etChangeCount', ctx)).toBe(0);

    const obs = (ctx as any)._getObservers() as Array<{ cb: MutationCallback }>;
    expect(obs).toHaveLength(1);
    obs[0].cb([], {} as MutationObserver);

    expect(vm.runInContext('window.__e2etChangeCount', ctx)).toBe(1);
  });

  it('保留已有 __e2etChangeCount，不重置', () => {
    const ctx = createContext();
    (ctx as any)._setDocEl({} as Element);
    vm.runInContext('window.__e2etChangeCount = 42', ctx);

    vm.runInContext(OBSERVER_SCRIPT, ctx);
    expect(vm.runInContext('window.__e2etChangeCount', ctx)).toBe(42);
  });
});
