/**
 * P2 生成侧 page-data 协议 harness（红前测试,先于实现编写）。
 *
 * fake CDP 严格按 node_modules/playwright-core/types/protocol.d.ts 的真实返回形状构造:
 *  - Page.getFrameTree → { frameTree: { frame: { id, loaderId, url, urlFragment?, securityOrigin } } }
 *  - Storage.getStorageKeyForFrame({frameId}) → { storageKey }
 *  - DOMStorage.getDOMStorageItems({storageId:{storageKey,isLocalStorage}}) → { entries: string[][] }
 *  - Runtime.evaluate('this') → { result: RemoteObject } / exceptionDetails
 *  - Runtime.getProperties({objectId,ownProperties,generatePreview}) → { result: PropertyDescriptor[] }
 *  - Runtime.releaseObjectGroup({objectGroup})
 * 不手造业务安全值:所有断言只消费协议方法返回后的生产代码输出,并核对协议调用序列本身。
 */
import { describe, expect, it } from 'vitest';
import {
  PageDataError,
  readPageData,
  readPageIdentity,
  type PageDataSource,
} from '../page-data.js';

/** 协议形状 fake:记录全部 send 调用,可注入每方法返回/抛错,支持 getter 计数。 */
class ProtocolCdp {
  calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  /** Runtime.evaluate 被调用的 expression 列表(证明不执行页面 getter/任意表达式) */
  evaluateExpressions: string[] = [];
  releasedGroups: string[] = [];
  /** 模拟页面 getter 被执行(生产代码绝不允许触发) */
  getterCalls = 0;
  /** 存储条目(精确 [key, value] 对) */
  storageEntries: string[][] = [];
  /** global 自身属性描述符(name → PropertyDescriptor 形状) */
  globalProps: Record<string, Record<string, unknown>> = {};
  frame = { id: 'F1', loaderId: 'LD1', url: 'https://page.test/app', urlFragment: '', securityOrigin: 'https://page.test' };
  storageKey = 'https://page.test';
  /** 协议调用抛错注入 */
  fail: Record<string, Error> = {};
  private objectIdSeq = 0;

  async send<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ method, params });
    const fail = this.fail[method];
    if (fail) throw fail;
    switch (method) {
      case 'Page.getFrameTree':
        return { frameTree: { frame: this.frame } } as T;
      case 'Storage.getStorageKeyForFrame':
        return { storageKey: this.storageKey } as T;
      case 'DOMStorage.getDOMStorageItems': {
        // 真实协议:entries 是 string[][];标量 key 序列化为字符串
        return { entries: this.storageEntries.map(([k, v]) => [String(k), String(v)]) } as T;
      }
      case 'Runtime.evaluate': {
        this.evaluateExpressions.push(String(params.expression ?? ''));
        // 生产合同:expression 必须是工具固定常量 'this'
        if (params.expression !== 'this') {
          // 模拟页面里执行了任意表达式(错误实现才会走到这里);若表达式是访问器读取则计 getter
          this.getterCalls++;
          return { result: { type: 'undefined' } } as T;
        }
        return { result: { type: 'object', className: 'globalThis', objectId: 'g-' + (++this.objectIdSeq) } } as T;
      }
      case 'Runtime.getProperties': {
        const objectId = String(params.objectId ?? '');
        const own = params.ownProperties === true;
        const out = Object.entries(this.globalProps)
          .filter(([, d]) => own || !d.isOwn)
          .map(([name, d]) => ({ name, ...d }));
        // 记录被消费的 objectId:断言 getProperties 作用于 evaluate 返回的全局对象
        (this as { lastPropsObjectId?: string }).lastPropsObjectId = objectId;
        return { result: out } as T;
      }
      case 'Runtime.releaseObjectGroup':
        this.releasedGroups.push(String(params.objectGroup ?? ''));
        return {} as T;
      default:
        return {} as T;
    }
  }
  prop(name: string, desc: Record<string, unknown>, isOwn = true): void {
    this.globalProps[name] = { ...desc, isOwn };
  }
  used(method: string, match?: (params: Record<string, unknown>) => boolean): boolean {
    return this.calls.some((c) => c.method === method && (match ? match(c.params ?? {}) : true));
  }
}

function ls(key: string, path?: string): PageDataSource {
  return path === undefined ? { local_storage: key } : { local_storage: key, path };
}

describe('readPageIdentity（协议身份读取）', () => {
  it('主 frame 身份:frame_id/loader_id/url+fragment/origin', async () => {
    const cdp = new ProtocolCdp();
    cdp.frame = { id: 'F9', loaderId: 'LD9', url: 'https://a.test/x', urlFragment: '#sec', securityOrigin: 'https://a.test' };
    const id = await readPageIdentity(cdp as any);
    expect(id).toEqual({ frame_id: 'F9', loader_id: 'LD9', url: 'https://a.test/x#sec', origin: 'https://a.test' });
  });

  it('loaderId 允许协议真实给出的空字符串(初始 about:blank)', async () => {
    const cdp = new ProtocolCdp();
    cdp.frame = { id: 'F0', loaderId: '', url: 'about:blank', urlFragment: '', securityOrigin: '://' };
    const id = await readPageIdentity(cdp as any);
    expect(id.frame_id).toBe('F0');
    expect(id.loader_id).toBe('');
  });

  it('缺 loaderId 字段(非空字符串)→ READ_UNAVAILABLE', async () => {
    const cdp = new ProtocolCdp();
    cdp.frame = { id: 'F1', url: 'https://a.test/', urlFragment: '', securityOrigin: 'https://a.test' } as any;
    await expect(readPageIdentity(cdp as any)).rejects.toMatchObject({ code: 'READ_UNAVAILABLE' });
  });

  it('缺 frame.id → READ_UNAVAILABLE', async () => {
    const cdp = new ProtocolCdp();
    cdp.frame = { loaderId: 'LD1', url: 'https://a.test/', urlFragment: '', securityOrigin: 'https://a.test' } as any;
    await expect(readPageIdentity(cdp as any)).rejects.toMatchObject({ code: 'READ_UNAVAILABLE' });
  });

  it('协议调用抛错 → READ_UNAVAILABLE(不泄漏原始异常文本)', async () => {
    const cdp = new ProtocolCdp();
    cdp.fail['Page.getFrameTree'] = new Error('WebSocket is already in CLOSING state <SECRET_TOKEN_XYZ>');
    const err = await readPageIdentity(cdp as any).catch((e) => e as PageDataError);
    expect(err.code).toBe('READ_UNAVAILABLE');
    expect(err.message).not.toContain('SECRET_TOKEN_XYZ');
  });
});

describe('readPageData local-storage(标准存储协议,不调用页面 getItem)', () => {
  it('raw 字符串:present/value,消费 getStorageKeyForFrame + getDOMStorageItems 协议链', async () => {
    const cdp = new ProtocolCdp();
    cdp.storageEntries = [['mode', 'simple'], ['other', 'x']];
    const v = await readPageData(cdp as any, 'F1', ls('mode'));
    expect(v).toEqual({ present: true, value: 'simple' });
    expect(cdp.used('Storage.getStorageKeyForFrame', (p) => p.frameId === 'F1')).toBe(true);
    expect(cdp.used('DOMStorage.getDOMStorageItems', (p) => {
      const sid = p.storageId as Record<string, unknown>;
      return sid?.storageKey === 'https://page.test' && sid?.isLocalStorage === true;
    })).toBe(true);
    // 不调用页面 localStorage(getItem 是 Runtime.evaluate,只允许 'this' 常量)
    expect(cdp.evaluateExpressions).toEqual([]);
  });

  it('无匹配 key → present:false(缺 key 不伪造 null)', async () => {
    const cdp = new ProtocolCdp();
    cdp.storageEntries = [['key10', 'x']];
    expect(await readPageData(cdp as any, 'F1', ls('key1'))).toEqual({ present: false });
  });

  it('空字符串 raw 值是有效标量(不被 truthy 判断丢弃)', async () => {
    const cdp = new ProtocolCdp();
    cdp.storageEntries = [['empty', '']];
    expect(await readPageData(cdp as any, 'F1', ls('empty'))).toEqual({ present: true, value: '' });
  });

  it('JSON path:命中 string/number 0/false/null 均为有效标量', async () => {
    const cdp = new ProtocolCdp();
    cdp.storageEntries = [['cfg', JSON.stringify({ mode: 'fast', n: 0, b: false, z: null, items: [{ id: 'i9' }] })]];
    expect(await readPageData(cdp as any, 'F1', ls('cfg', 'mode'))).toEqual({ present: true, value: 'fast' });
    expect(await readPageData(cdp as any, 'F1', ls('cfg', 'n'))).toEqual({ present: true, value: 0 });
    expect(await readPageData(cdp as any, 'F1', ls('cfg', 'b'))).toEqual({ present: true, value: false });
    expect(await readPageData(cdp as any, 'F1', ls('cfg', 'z'))).toEqual({ present: true, value: null });
    expect(await readPageData(cdp as any, 'F1', ls('cfg', 'items.0.id'))).toEqual({ present: true, value: 'i9' });
  });

  it('JSON path 未命中 → present:false;命中 null 是 present:true/value:null(missing ≠ null)', async () => {
    const cdp = new ProtocolCdp();
    cdp.storageEntries = [['cfg', JSON.stringify({ z: null })]];
    expect(await readPageData(cdp as any, 'F1', ls('cfg', 'nope'))).toEqual({ present: false });
    expect(await readPageData(cdp as any, 'F1', ls('cfg', 'z'))).toEqual({ present: true, value: null });
  });

  it('空 JSON 的继承属性 constructor.name 不误报 present(原型置空)', async () => {
    const cdp = new ProtocolCdp();
    cdp.storageEntries = [['cfg', '{}']];
    expect(await readPageData(cdp as any, 'F1', ls('cfg', 'constructor.name'))).toEqual({ present: false });
  });

  it('显式自身 constructor.name 字段仍可读取(不做字段黑名单)', async () => {
    const cdp = new ProtocolCdp();
    cdp.storageEntries = [['cfg', JSON.stringify({ constructor: { name: 'real' } })]];
    expect(await readPageData(cdp as any, 'F1', ls('cfg', 'constructor.name'))).toEqual({ present: true, value: 'real' });
  });

  it('malformed JSON + path → READ_UNAVAILABLE', async () => {
    const cdp = new ProtocolCdp();
    cdp.storageEntries = [['cfg', 'not json']];
    await expect(readPageData(cdp as any, 'F1', ls('cfg', 'a'))).rejects.toMatchObject({ code: 'READ_UNAVAILABLE' });
  });

  it('数组段 Number+integer 语义:items.01/items.1e0 命中 index 1,非数字段 missing', async () => {
    const cdp = new ProtocolCdp();
    cdp.storageEntries = [['cfg', JSON.stringify({ items: [{ id: 'i0' }, { id: 'i1' }, { id: 'i2' }] })]];
    expect(await readPageData(cdp as any, 'F1', ls('cfg', 'items.01.id'))).toEqual({ present: true, value: 'i1' });
    expect(await readPageData(cdp as any, 'F1', ls('cfg', 'items.1e0.id'))).toEqual({ present: true, value: 'i1' });
    expect(await readPageData(cdp as any, 'F1', ls('cfg', 'items.abc'))).toEqual({ present: false });
  });

  it("对象自身 '01' 键精确命中(不微当数组下标)", async () => {
    const cdp = new ProtocolCdp();
    cdp.storageEntries = [['cfg', JSON.stringify({ '01': 'objKey01' })]];
    expect(await readPageData(cdp as any, 'F1', ls('cfg', '01'))).toEqual({ present: true, value: 'objKey01' });
    expect(await readPageData(cdp as any, 'F1', ls('cfg', '1'))).toEqual({ present: false });
  });

  it('path 命中对象/数组 → READ_UNSUPPORTED_TYPE(非标量拒绝)', async () => {
    const cdp = new ProtocolCdp();
    cdp.storageEntries = [['cfg', JSON.stringify({ obj: { a: 1 }, arr: [1] })]];
    await expect(readPageData(cdp as any, 'F1', ls('cfg', 'obj'))).rejects.toMatchObject({ code: 'READ_UNSUPPORTED_TYPE' });
    await expect(readPageData(cdp as any, 'F1', ls('cfg', 'arr'))).rejects.toMatchObject({ code: 'READ_UNSUPPORTED_TYPE' });
  });

  it('选中值序列化超 100KB → READ_TOO_LARGE,不返回截断值', async () => {
    const cdp = new ProtocolCdp();
    cdp.storageEntries = [['big', 'x'.repeat(100 * 1024 + 10)]];
    await expect(readPageData(cdp as any, 'F1', ls('big'))).rejects.toMatchObject({ code: 'READ_TOO_LARGE' });
  });

  it('协议失败(存储读取抛错)→ READ_UNAVAILABLE', async () => {
    const cdp = new ProtocolCdp();
    cdp.fail['DOMStorage.getDOMStorageItems'] = new Error('boom');
    await expect(readPageData(cdp as any, 'F1', ls('mode'))).rejects.toMatchObject({ code: 'READ_UNAVAILABLE' });
  });
});

describe('readPageData global(主世界对象协议,不执行 getter)', () => {
  it('own string/number/boolean 标量可取', async () => {
    const cdp = new ProtocolCdp();
    cdp.prop('gStr', { value: { type: 'string', value: 'v1' } });
    cdp.prop('gNum', { value: { type: 'number', value: 42 } });
    cdp.prop('gBool', { value: { type: 'boolean', value: false } });
    expect(await readPageData(cdp as any, 'F1', { global: 'gStr' })).toEqual({ present: true, value: 'v1' });
    expect(await readPageData(cdp as any, 'F1', { global: 'gNum' })).toEqual({ present: true, value: 42 });
    expect(await readPageData(cdp as any, 'F1', { global: 'gBool' })).toEqual({ present: true, value: false });
  });

  it('null RemoteObject(type object + subtype null)→ present:true/value:null', async () => {
    const cdp = new ProtocolCdp();
    cdp.prop('gNull', { value: { type: 'object', subtype: 'null', value: null } });
    expect(await readPageData(cdp as any, 'F1', { global: 'gNull' })).toEqual({ present: true, value: null });
  });

  it('缺属性 → present:false', async () => {
    const cdp = new ProtocolCdp();
    cdp.prop('other', { value: { type: 'string', value: 'x' } });
    expect(await readPageData(cdp as any, 'F1', { global: 'nope' })).toEqual({ present: false });
  });

  it('访问器属性(get/set)拒绝且不执行 getter(getter 计数仍 0)', async () => {
    const cdp = new ProtocolCdp();
    cdp.prop('gAcc', { get: { type: 'function' }, set: { type: 'function' } });
    await expect(readPageData(cdp as any, 'F1', { global: 'gAcc' })).rejects.toMatchObject({ code: 'READ_UNSUPPORTED_TYPE' });
    expect(cdp.getterCalls).toBe(0);
    // evaluate 只允许固定常量 'this',不得拼接调用方 name
    expect(cdp.evaluateExpressions).toEqual(['this']);
  });

  it('wasThrown 描述符拒绝', async () => {
    const cdp = new ProtocolCdp();
    cdp.prop('gThrow', { wasThrown: true, value: { type: 'string', value: 'x' } });
    await expect(readPageData(cdp as any, 'F1', { global: 'gThrow' })).rejects.toMatchObject({ code: 'READ_UNSUPPORTED_TYPE' });
  });

  it('function/symbol/bigint/undefined/object/promise → READ_UNSUPPORTED_TYPE', async () => {
    const cdp = new ProtocolCdp();
    cdp.prop('gFn', { value: { type: 'function' } });
    cdp.prop('gSym', { value: { type: 'symbol', description: 's' } });
    cdp.prop('gBig', { value: { type: 'bigint', unserializableValue: '123n' } });
    cdp.prop('gUndef', { value: { type: 'undefined' } });
    cdp.prop('gObj', { value: { type: 'object', className: 'Object', objectId: 'o-x' } });
    cdp.prop('gPromise', { value: { type: 'object', subtype: 'promise', objectId: 'o-p' } });
    for (const name of ['gFn', 'gSym', 'gBig', 'gUndef', 'gObj', 'gPromise']) {
      await expect(readPageData(cdp as any, 'F1', { global: name })).rejects.toMatchObject({ code: 'READ_UNSUPPORTED_TYPE' });
    }
  });

  it('unserializableValue(NaN/Infinity)→ 拒绝', async () => {
    const cdp = new ProtocolCdp();
    cdp.prop('gNaN', { value: { type: 'number', unserializableValue: 'NaN' } });
    cdp.prop('gInf', { value: { type: 'number', unserializableValue: 'Infinity' } });
    await expect(readPageData(cdp as any, 'F1', { global: 'gNaN' })).rejects.toMatchObject({ code: 'READ_UNSUPPORTED_TYPE' });
    await expect(readPageData(cdp as any, 'F1', { global: 'gInf' })).rejects.toMatchObject({ code: 'READ_UNSUPPORTED_TYPE' });
  });

  it('evaluate exceptionDetails / 缺 objectId → READ_UNAVAILABLE(不猜 {} 或 null)', async () => {
    const cdp = new ProtocolCdp();
    cdp.prop('gStr', { value: { type: 'string', value: 'v' } });
    // 例外注入:用 fail 不可行(evaluate 返回形状),改一个专用 fake
    const cdp2 = new (class extends ProtocolCdp {
      async send<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
        if (method === 'Runtime.evaluate') {
          this.evaluateExpressions.push(String(params.expression ?? ''));
          return { exceptionDetails: { text: 'Uncaught', exception: { description: 'SECRET_ERR' } } } as T;
        }
        return super.send(method, params);
      }
    })();
    const err = await readPageData(cdp2 as any, 'F1', { global: 'gStr' }).catch((e) => e as PageDataError);
    expect(err.code).toBe('READ_UNAVAILABLE');
    expect(err.message).not.toContain('SECRET_ERR');
    const cdp3 = new (class extends ProtocolCdp {
      async send<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
        if (method === 'Runtime.evaluate') {
          this.evaluateExpressions.push(String(params.expression ?? ''));
          return { result: { type: 'object', className: 'globalThis' } } as T; // 无 objectId
        }
        return super.send(method, params);
      }
    })();
    await expect(readPageData(cdp3 as any, 'F1', { global: 'gStr' })).rejects.toMatchObject({ code: 'READ_UNAVAILABLE' });
  });

  it("evaluate 固定常量 this + returnByValue:false + awaitPromise:false + generatePreview:false,不拼调用方 name", async () => {
    const cdp = new ProtocolCdp();
    cdp.prop('gStr', { value: { type: 'string', value: 'v' } });
    await readPageData(cdp as any, 'F1', { global: 'gStr' });
    const ev = cdp.calls.find((c) => c.method === 'Runtime.evaluate');
    expect(ev?.params).toMatchObject({ expression: 'this', returnByValue: false, awaitPromise: false, generatePreview: false });
    expect(String(ev?.params.expression)).not.toContain('gStr');
  });

  it('getProperties ownProperties:true + generatePreview:false,作用于全局 objectId', async () => {
    const cdp = new ProtocolCdp();
    cdp.prop('gStr', { value: { type: 'string', value: 'v' } });
    await readPageData(cdp as any, 'F1', { global: 'gStr' });
    const gp = cdp.calls.find((c) => c.method === 'Runtime.getProperties');
    expect(gp?.params).toMatchObject({ ownProperties: true, generatePreview: false });
    expect(String(gp?.params.objectId)).toMatch(/^g-\d+$/);
  });

  it('finally releaseObjectGroup 回收整个组(含 getProperties 子句柄),组名每次读取唯一', async () => {
    const cdp = new ProtocolCdp();
    cdp.prop('gStr', { value: { type: 'string', value: 'v' } });
    await readPageData(cdp as any, 'F1', { global: 'gStr' });
    await readPageData(cdp as any, 'F1', { global: 'gStr' });
    // 两次读取各 release 一次;objectGroup 与 evaluate 时生成的一致且互不相同
    const groups = cdp.calls.filter((c) => c.method === 'Runtime.evaluate').map((c) => String(c.params?.objectGroup));
    expect(cdp.releasedGroups).toEqual(groups);
    expect(new Set(groups).size).toBe(2);
  });

  it('成功读取也释放组;属性读取拒绝(getter)同样释放组', async () => {
    const cdp = new ProtocolCdp();
    cdp.prop('gStr', { value: { type: 'string', value: 'v' } });
    cdp.prop('gAcc', { get: { type: 'function' } });
    await readPageData(cdp as any, 'F1', { global: 'gStr' });
    await readPageData(cdp as any, 'F1', { global: 'gAcc' }).catch(() => {});
    const evGroups = cdp.calls.filter((c) => c.method === 'Runtime.evaluate').map((c) => String(c.params?.objectGroup));
    expect(cdp.releasedGroups).toEqual(evGroups);
  });

  it('缺属性(present:false)也走 finally 释放', async () => {
    const cdp = new ProtocolCdp();
    await readPageData(cdp as any, 'F1', { global: 'nope' });
    expect(cdp.releasedGroups).toHaveLength(1);
  });

  it('两个读取使用不同组:后读取不释放先读取的组', async () => {
    const cdp = new ProtocolCdp();
    cdp.prop('gStr', { value: { type: 'string', value: 'v' } });
    await readPageData(cdp as any, 'F1', { global: 'gStr' });
    const firstRelease = [...cdp.releasedGroups];
    cdp.prop('gStr', { value: { type: 'string', value: 'v2' } });
    await readPageData(cdp as any, 'F1', { global: 'gStr' });
    expect(cdp.releasedGroups).toHaveLength(2);
    expect(cdp.releasedGroups[1]).not.toBe(firstRelease[0]);
  });
});

describe('readPageData 入参合同', () => {
  it('local_storage 空 key / global 空 name → READ_UNAVAILABLE(输入错误,不上协议)', async () => {
    const cdp = new ProtocolCdp();
    await expect(readPageData(cdp as any, 'F1', { local_storage: '' })).rejects.toMatchObject({ code: 'READ_UNAVAILABLE' });
    await expect(readPageData(cdp as any, 'F1', { global: '' })).rejects.toMatchObject({ code: 'READ_UNAVAILABLE' });
    // 没发任何读取协议调用
    expect(cdp.calls.filter((c) => c.method.startsWith('Storage.') || c.method.startsWith('DOMStorage.') || c.method.startsWith('Runtime.'))).toHaveLength(0);
  });
});
