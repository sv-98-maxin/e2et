/**
 * P2 回放侧红前测试:readPageDataSource(标准 CDP 协议消费 + 导航拒绝 + 身份对照 + 句柄回收)。
 *
 * fake CDPSession 按 Playwright CDPSession API(send/on/detach)与 protocol.d.ts 形状构造。
 */
import { describe, expect, it } from 'vitest';
import { readPageDataSource } from '../page-data.js';

type Listener = (params: any) => void;

/** 可编程 fake CDPSession */
class FakeCdpSession {
  calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  detached = false;
  releasedGroups: string[] = [];
  evaluateExpressions: string[] = [];
  storageEntries: string[][] = [];
  globalProps: Record<string, Record<string, unknown>> = {};
  /** 每次读取 frame(按序消费) */
  frameTreeQueue: Array<Record<string, unknown>> = [];
  private listeners = new Map<string, Listener[]>();
  private objectIdSeq = 0;
  /** send 钩子(注入导航/抛错) */
  onSend?: (method: string, params: Record<string, unknown>) => void;
  /** detach 实现(可注入:拒绝/在途导航) */
  detachImpl: () => Promise<void> = async () => {};

  /** 忠实 Playwright CDPSession: on/off 返回 this(不是退订函数) */
  on(method: string, handler: Listener): this {
    const list = this.listeners.get(method) ?? [];
    list.push(handler);
    this.listeners.set(method, list);
    return this;
  }
  off(method: string, handler: Listener): this {
    const list = this.listeners.get(method) ?? [];
    this.listeners.set(method, list.filter((h) => h !== handler));
    return this;
  }
  listenerCount(): number {
    return [...this.listeners.values()].reduce((n, l) => n + l.length, 0);
  }
  emit(method: string, params: any): void {
    for (const h of this.listeners.get(method) ?? []) h(params);
  }
  async send<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ method, params });
    this.onSend?.(method, params);
    switch (method) {
      case 'Page.enable': return {} as T;
      case 'Page.getFrameTree': {
        const frame = (this.frameTreeQueue.length > 1 ? this.frameTreeQueue.shift() : this.frameTreeQueue[0]) ?? { id: 'F1', loaderId: 'LD1', url: 'https://page.test/app', urlFragment: '', securityOrigin: 'https://page.test' };
        return { frameTree: { frame } } as T;
      }
      case 'Storage.getStorageKeyForFrame': return { storageKey: 'https://page.test' } as T;
      case 'DOMStorage.getDOMStorageItems': return { entries: this.storageEntries.map(([k, v]) => [String(k), String(v)]) } as T;
      case 'Runtime.evaluate': {
        this.evaluateExpressions.push(String(params.expression ?? ''));
        if (params.expression !== 'this') return { result: { type: 'undefined' } } as T;
        return { result: { type: 'object', className: 'globalThis', objectId: 'g-' + (++this.objectIdSeq) } } as T;
      }
      case 'Runtime.getProperties': {
        return { result: Object.entries(this.globalProps).map(([name, d]) => ({ name, ...d })) } as T;
      }
      case 'Runtime.releaseObjectGroup':
        this.releasedGroups.push(String(params.objectGroup ?? ''));
        return {} as T;
      default: return {} as T;
    }
  }
  async detach(): Promise<void> { await this.detachImpl(); this.detached = true; }
}

function fakePage(session: FakeCdpSession): any {
  return {
    url: () => 'https://page.test/app',
    context: () => ({ newCDPSession: async () => session }),
    isClosed: () => false,
    waitForTimeout: async () => {},
  };
}

describe('readPageDataSource local-storage(回放侧,只返回原字符串不解析 path)', () => {
  it('返回命中原字符串;消费 getStorageKeyForFrame + getDOMStorageItems', async () => {
    const s = new FakeCdpSession();
    s.storageEntries = [['cfg', '{"record":{"mode":"fast"}}'], ['other', 'x']];
    const v = await readPageDataSource(fakePage(s), { local_storage: 'cfg' });
    expect(v).toEqual({ present: true, value: '{"record":{"mode":"fast"}}' });
    expect(s.calls.some((c) => c.method === 'Storage.getStorageKeyForFrame')).toBe(true);
    expect(s.calls.some((c) => c.method === 'DOMStorage.getDOMStorageItems')).toBe(true);
  });

  it('缺 key → present:false(不伪造 null)', async () => {
    const s = new FakeCdpSession();
    s.storageEntries = [['other', 'x']];
    expect(await readPageDataSource(fakePage(s), { local_storage: 'cfg' })).toEqual({ present: false });
  });

  it('读取结束 finally:off 移除本次监听(无残余)+ detach', async () => {
    const s = new FakeCdpSession();
    s.storageEntries = [['cfg', 'v']];
    await readPageDataSource(fakePage(s), { local_storage: 'cfg' });
    expect(s.detached).toBe(true);
    expect(s.listenerCount()).toBe(0);
  });

  it('读取失败(导航拒绝)也移除监听 + detach(finally 总执行)', async () => {
    const s = new FakeCdpSession();
    s.storageEntries = [['cfg', 'v']];
    s.onSend = (method) => {
      if (method === 'DOMStorage.getDOMStorageItems') {
        s.emit('Page.frameNavigated', { frame: { id: 'F1', loaderId: 'LD2', url: 'https://page.test/other' } });
      }
    };
    await expect(readPageDataSource(fakePage(s), { local_storage: 'cfg' })).rejects.toThrow();
    expect(s.detached).toBe(true);
    expect(s.listenerCount()).toBe(0);
  });

  it('global 读取成功后同样无残余监听', async () => {
    const s = new FakeCdpSession();
    s.globalProps = { gStr: { value: { type: 'string', value: 'v' } } };
    await readPageDataSource(fakePage(s), { global: 'gStr' });
    expect(s.detached).toBe(true);
    expect(s.listenerCount()).toBe(0);
  });
});

describe('readPageDataSource global(真实标量)', () => {
  it('string/number/boolean/null 标量返回', async () => {
    const s = new FakeCdpSession();
    s.globalProps = {
      gStr: { value: { type: 'string', value: 'v1' } },
      gNum: { value: { type: 'number', value: 7 } },
      gBool: { value: { type: 'boolean', value: false } },
      gNull: { value: { type: 'object', subtype: 'null', value: null } },
    };
    expect(await readPageDataSource(fakePage(s), { global: 'gStr' })).toEqual({ present: true, value: 'v1' });
    expect(await readPageDataSource(fakePage(s), { global: 'gNum' })).toEqual({ present: true, value: 7 });
    expect(await readPageDataSource(fakePage(s), { global: 'gBool' })).toEqual({ present: true, value: false });
    expect(await readPageDataSource(fakePage(s), { global: 'gNull' })).toEqual({ present: true, value: null });
  });

  it('getter/访问器拒绝,不执行(只 evaluate 常量 this)', async () => {
    const s = new FakeCdpSession();
    s.globalProps = { gAcc: { get: { type: 'function' }, set: { type: 'function' } } };
    await expect(readPageDataSource(fakePage(s), { global: 'gAcc' })).rejects.toThrow();
    expect(s.evaluateExpressions.every((e) => e === 'this')).toBe(true);
  });

  it('对象/Promise/NaN/BigInt/undefined → 拒绝', async () => {
    const s = new FakeCdpSession();
    s.globalProps = {
      gObj: { value: { type: 'object', className: 'Object', objectId: 'o1' } },
      gPromise: { value: { type: 'object', subtype: 'promise', objectId: 'o2' } },
      gNaN: { value: { type: 'number', unserializableValue: 'NaN' } },
      gBig: { value: { type: 'bigint', unserializableValue: '1n' } },
      gUndef: { value: { type: 'undefined' } },
    };
    for (const name of ['gObj', 'gPromise', 'gNaN', 'gBig', 'gUndef']) {
      await expect(readPageDataSource(fakePage(s), { global: name })).rejects.toThrow();
    }
  });

  it('唯一 objectGroup + finally releaseObjectGroup + detach', async () => {
    const s = new FakeCdpSession();
    s.globalProps = { gStr: { value: { type: 'string', value: 'v' } } };
    await readPageDataSource(fakePage(s), { global: 'gStr' });
    await readPageDataSource(fakePage(s), { global: 'gStr' });
    const groups = s.calls.filter((c) => c.method === 'Runtime.evaluate').map((c) => String(c.params?.objectGroup));
    expect(groups).toHaveLength(2);
    expect(new Set(groups).size).toBe(2);
    expect(s.releasedGroups).toEqual(groups);
    expect(s.detached).toBe(true);
  });
});

describe('readPageDataSource 导航/身份防护', () => {
  it('读取期间主 frame 导航(frameNavigated)→ 拒绝,不返回旧数据', async () => {
    const s = new FakeCdpSession();
    s.storageEntries = [['cfg', 'v']];
    // 首次 frame tree 读取返回后、存储读取时触发主 frame 导航
    let frameTreeCount = 0;
    s.onSend = (method) => {
      if (method === 'Page.getFrameTree') frameTreeCount++;
      if (method === 'DOMStorage.getDOMStorageItems') {
        s.emit('Page.frameNavigated', { frame: { id: 'F1', loaderId: 'LD2', url: 'https://page.test/other' } });
      }
    };
    await expect(readPageDataSource(fakePage(s), { local_storage: 'cfg' })).rejects.toThrow();
    expect(s.detached).toBe(true);
  });

  it('读取期间同文档导航(navigatedWithinDocument)→ 拒绝', async () => {
    const s = new FakeCdpSession();
    s.storageEntries = [['cfg', 'v']];
    s.onSend = (method) => {
      if (method === 'DOMStorage.getDOMStorageItems') {
        s.emit('Page.navigatedWithinDocument', { frameId: 'F1', url: 'https://page.test/app#x' });
      }
    };
    await expect(readPageDataSource(fakePage(s), { local_storage: 'cfg' })).rejects.toThrow();
  });

  it('前后 frame tree 对照:loaderId 变(同 URL 重载)→ 拒绝', async () => {
    const s = new FakeCdpSession();
    s.storageEntries = [['cfg', 'v']];
    // readPageDataSource 内部恰好两次 getFrameTree(读前/读后):读后 loaderId 变
    s.frameTreeQueue = [
      { id: 'F1', loaderId: 'LD1', url: 'https://page.test/app', urlFragment: '', securityOrigin: 'https://page.test' },
      { id: 'F1', loaderId: 'LD2', url: 'https://page.test/app', urlFragment: '', securityOrigin: 'https://page.test' },
    ];
    await expect(readPageDataSource(fakePage(s), { local_storage: 'cfg' })).rejects.toThrow();
    expect(s.detached).toBe(true);
  });

  it('SPA 跳走再跳回相同 URL:URL fragment 变 → 前后对照拒绝', async () => {
    const s = new FakeCdpSession();
    s.storageEntries = [['cfg', 'v']];
    // 读前/读后两次 tree:读后 fragment 变(同 URL 不同 fragment 也算漂移)
    s.frameTreeQueue = [
      { id: 'F1', loaderId: 'LD1', url: 'https://page.test/app', urlFragment: '', securityOrigin: 'https://page.test' },
      { id: 'F1', loaderId: 'LD1', url: 'https://page.test/app', urlFragment: '#spa', securityOrigin: 'https://page.test' },
    ];
    await expect(readPageDataSource(fakePage(s), { local_storage: 'cfg' })).rejects.toThrow();
  });

  it('子 frame 导航(iframe)不误伤主文档读取', async () => {
    const s = new FakeCdpSession();
    s.storageEntries = [['cfg', 'v']];
    s.onSend = (method) => {
      if (method === 'DOMStorage.getDOMStorageItems') {
        s.emit('Page.frameNavigated', { frame: { id: 'F2', parentId: 'F1', loaderId: 'LX', url: 'https://child.test/' } });
      }
    };
    const v = await readPageDataSource(fakePage(s), { local_storage: 'cfg' });
    expect(v).toEqual({ present: true, value: 'v' });
  });
});

describe('readPageDataSource 环境合同', () => {
  it('非 Chromium(无 newCDPSession)→ 明确失败', async () => {
    const page: any = { url: () => 'https://x.test/', context: () => ({}) };
    await expect(readPageDataSource(page, { local_storage: 'cfg' })).rejects.toThrow(/Chromium/i);
  });
});

describe('readPageDataSource cleanup 生命周期(P4:detach 期间漂移/detach 拒绝/页面关闭)', () => {
  it('detach await 期间主 frame 导航 → 拒绝成功值(监听保留到 detach 完成)', async () => {
    const s = new FakeCdpSession();
    s.storageEntries = [['cfg', 'v']];
    s.detachImpl = async () => {
      // detach 在途时发主 frame 导航:监听仍未撤,标记可见
      s.emit('Page.frameNavigated', { frame: { id: 'F1', loaderId: 'LD2', url: 'https://page.test/changed' } });
      await Promise.resolve();
    };
    await expect(readPageDataSource(fakePage(s), { local_storage: 'cfg' })).rejects.toThrow('清理期间页面发生导航');
    expect(s.detached).toBe(true);
    expect(s.listenerCount()).toBe(0);
  });

  it('detach await 期间子 frame 同文档导航 → 不影响主文档返回(真实主 frame id 才计数)', async () => {
    const s = new FakeCdpSession();
    s.storageEntries = [['cfg', 'v']];
    s.detachImpl = async () => {
      s.emit('Page.navigatedWithinDocument', { frameId: 'F2', url: 'https://child.test/#x' });
      await Promise.resolve();
    };
    const v = await readPageDataSource(fakePage(s), { local_storage: 'cfg' });
    expect(v).toEqual({ present: true, value: 'v' });
    expect(s.detached).toBe(true);
    expect(s.listenerCount()).toBe(0);
  });

  it('detach 拒绝 → 拒绝成功值(固定安全文案,不泄漏协议原文)', async () => {
    const s = new FakeCdpSession();
    s.storageEntries = [['cfg', 'v']];
    s.detachImpl = async () => { throw new Error('CdpSession DetachedProtocolError raw details'); };
    await expect(readPageDataSource(fakePage(s), { local_storage: 'cfg' })).rejects.toThrow('读取会话清理失败,拒绝返回未验证数据');
    expect(s.listenerCount()).toBe(0);
  });

  it('读取成功后页面已关闭 → 拒绝返回旧数据', async () => {
    const s = new FakeCdpSession();
    s.storageEntries = [['cfg', 'v']];
    let closed = false;
    const page = { ...fakePage(s), isClosed: () => closed };
    s.onSend = (method) => {
      if (method === 'DOMStorage.getDOMStorageItems') closed = true;
    };
    await expect(readPageDataSource(page, { local_storage: 'cfg' })).rejects.toThrow('页面已关闭');
    expect(s.detached).toBe(true);
    expect(s.listenerCount()).toBe(0);
  });

  it('读取失败(协议拒绝)时 detach 也拒绝 → 原读取错误优先传播(不吞)', async () => {
    const s = new FakeCdpSession();
    s.storageEntries = [['cfg', 'v']];
    s.detachImpl = async () => { throw new Error('detach boom'); };
    s.onSend = (method) => {
      if (method === 'DOMStorage.getDOMStorageItems') {
        s.emit('Page.frameNavigated', { frame: { id: 'F1', loaderId: 'LD2', url: 'https://page.test/other' } });
      }
    };
    await expect(readPageDataSource(fakePage(s), { local_storage: 'cfg' })).rejects.toThrow('读取期间页面发生导航');
    expect(s.listenerCount()).toBe(0);
  });

  it('初始身份 await 期间主 frame 导航先到 → 拒绝(监听先于首次 frameTree 挂上)', async () => {
    const s = new FakeCdpSession();
    s.storageEntries = [['cfg', 'v']];
    s.onSend = (method) => {
      if (method === 'Page.getFrameTree') {
        s.emit('Page.frameNavigated', { frame: { id: 'F1', loaderId: 'LD2', url: 'https://page.test/other' } });
      }
    };
    await expect(readPageDataSource(fakePage(s), { local_storage: 'cfg' })).rejects.toThrow();
    expect(s.detached).toBe(true);
    expect(s.listenerCount()).toBe(0);
  });

  it('初始身份 await 期间主 frame 同文档导航先到 → 集合记录真实 frameId,最终拒绝', async () => {
    const s = new FakeCdpSession();
    s.storageEntries = [['cfg', 'v']];
    s.onSend = (method) => {
      if (method === 'Page.getFrameTree') {
        s.emit('Page.navigatedWithinDocument', { frameId: 'F1', url: 'https://page.test/app#early' });
      }
    };
    await expect(readPageDataSource(fakePage(s), { local_storage: 'cfg' })).rejects.toThrow();
    expect(s.listenerCount()).toBe(0);
  });
});
