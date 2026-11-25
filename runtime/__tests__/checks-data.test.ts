/**
 * P2 回放侧 checks data 分支红前测试:JSON path 解析 + 严格标量比较(dot path 合同)。
 */
import { describe, expect, it } from 'vitest';
import { executeChecks } from '../checks.js';
import type { Check } from '../types.js';
import type { PageDataSource } from '../types.js';
import { createValueContext } from '../value.js';
import { RequestTracker } from '../request-tracker.js';

type Listener = (params: any) => void;

/** 最小 fake page + 可编程 CDP(local-storage/global 协议)。
 *  session 忠实 Playwright CDPSession:on/off 返回 this(非退订函数)。 */
function pageWith(entries: string[][], globalProps: Record<string, Record<string, unknown>> = {}): any {
  const listeners = new Map<string, Listener[]>();
  const state = { detached: false };
  const session: any = {
    calls: [] as Array<{ method: string; params?: Record<string, unknown> }>,
    async send(method: string, params: Record<string, unknown> = {}) {
      this.calls.push({ method, params });
      switch (method) {
        case 'Page.enable': return {};
        case 'Page.getFrameTree': return { frameTree: { frame: { id: 'F1', loaderId: 'LD1', url: 'https://page.test/app', urlFragment: '', securityOrigin: 'https://page.test' } } };
        case 'Storage.getStorageKeyForFrame': return { storageKey: 'https://page.test' };
        case 'DOMStorage.getDOMStorageItems': return { entries };
        case 'Runtime.evaluate': return { result: { type: 'object', className: 'globalThis', objectId: 'g1' } };
        case 'Runtime.getProperties': return { result: Object.entries(globalProps).map(([name, d]) => ({ name, ...d })) };
        case 'Runtime.releaseObjectGroup': return {};
        default: return {};
      }
    },
    on(method: string, handler: Listener) {
      const list = listeners.get(method) ?? [];
      list.push(handler);
      listeners.set(method, list);
      return session; // 忠实 Playwright:on 返回 this
    },
    off(method: string, handler: Listener) {
      const list = listeners.get(method) ?? [];
      listeners.set(method, list.filter((h) => h !== handler));
      return session;
    },
    async detach() { state.detached = true; },
  };
  const page: any = {
    url: () => 'https://page.test/app',
    context: () => ({ newCDPSession: async () => session }),
    isClosed: () => false,
    waitForTimeout: async () => {},
    __state: state,
    __listenerCount: () => [...listeners.values()].reduce((n: number, l: Listener[]) => n + l.length, 0),
  };
  return page;
}

function dataCheck(source: PageDataSource, equals: unknown): Check[] {
  // 测试要传非标量反例（对象/数组）验证拒绝，这里做单点断言型转换
  return [{ assert: { data: { source, equals: equals as string | number | boolean | null } } }];
}

async function run(checks: Check[]): Promise<unknown> {
  return executeChecks(pageWith([], {}), checks, createValueContext(), new RequestTracker(), 1000);
}

describe('assert data 回放:会话清理(on/off/detach)', () => {
  it('成功断言后:无残余监听 + detach', async () => {
    const page = pageWith([['mode', 'simple']]);
    await executeChecks(page, dataCheck({ local_storage: 'mode' }, 'simple'), createValueContext(), new RequestTracker(), 1000);
    expect(page.__state.detached).toBe(true);
    expect(page.__listenerCount()).toBe(0);
  });

  it('断言失败后同样无残余监听 + detach', async () => {
    const page = pageWith([['mode', 'simple']]);
    await expect(executeChecks(page, dataCheck({ local_storage: 'mode' }, 'other'), createValueContext(), new RequestTracker(), 1000)).rejects.toThrow();
    expect(page.__state.detached).toBe(true);
    expect(page.__listenerCount()).toBe(0);
  });
});

describe('assert data 回放:local-storage 无 path(原字符串严格比较)', () => {
  it('字符串相等 → 通过', async () => {
    const page = pageWith([['mode', 'simple']]);
    await executeChecks(page, dataCheck({ local_storage: 'mode' }, 'simple'), createValueContext(), new RequestTracker(), 1000);
  });

  it("存储字符串 '123' 与数字 123 严格不相等 → 失败(数字字符串不与数字误判相等)", async () => {
    const page = pageWith([['num', '123']]);
    await expect(executeChecks(page, dataCheck({ local_storage: 'num' }, 123), createValueContext(), new RequestTracker(), 1000)).rejects.toThrow();
  });

  it('missing key 与 null 不相等 → 失败', async () => {
    const page = pageWith([['other', 'x']]);
    await expect(executeChecks(page, dataCheck({ local_storage: 'nope' }, null), createValueContext(), new RequestTracker(), 1000)).rejects.toThrow();
  });

  it('空串期望匹配空串值', async () => {
    const page = pageWith([['empty', '']]);
    await executeChecks(page, dataCheck({ local_storage: 'empty' }, ''), createValueContext(), new RequestTracker(), 1000);
  });
});

describe('assert data 回放:local-storage + path(JSON 解析 + dot path)', () => {
  const cfg = JSON.stringify({ record: { mode: 'fast' }, n: 0, b: false, z: null, items: [{ id: 'i9' }], obj: { a: 1 }, arr: [1] });

  it('命中 string/number 0/boolean false/null 均有效', async () => {
    for (const [path, equals] of [['record.mode', 'fast'], ['n', 0], ['b', false], ['z', null], ['items.0.id', 'i9']] as Array<[string, unknown]>) {
      const page = pageWith([['cfg', cfg]]);
      await executeChecks(page, dataCheck({ local_storage: 'cfg', path }, equals), createValueContext(), new RequestTracker(), 1000);
    }
  });

  it('path 未命中 → 失败(missing 不等于 null)', async () => {
    const page = pageWith([['cfg', cfg]]);
    await expect(executeChecks(page, dataCheck({ local_storage: 'cfg', path: 'nope' }, null), createValueContext(), new RequestTracker(), 1000)).rejects.toThrow();
  });

  it('数组段语义与生成侧 jsonPath 一致:01/1e0 取 index,非数字段 missing', async () => {
    const cfg = JSON.stringify({ items: [{ id: 'i0' }, { id: 'i1' }, { id: 'i2' }] });
    // items.01 → Number('01')=1 → items[1](与生成侧 jsonPath 同语义)
    const p1 = pageWith([['cfg', cfg]]);
    await executeChecks(p1, dataCheck({ local_storage: 'cfg', path: 'items.01.id' }, 'i1'), createValueContext(), new RequestTracker(), 1000);
    // items.1e0 → Number('1e0')=1 → items[1]
    const p2 = pageWith([['cfg', cfg]]);
    await executeChecks(p2, dataCheck({ local_storage: 'cfg', path: 'items.1e0.id' }, 'i1'), createValueContext(), new RequestTracker(), 1000);
    // 非数字数组段 → missing(不与 null 相等)
    const p3 = pageWith([['cfg', cfg]]);
    await expect(executeChecks(p3, dataCheck({ local_storage: 'cfg', path: 'items.abc' }, null), createValueContext(), new RequestTracker(), 1000)).rejects.toThrow();
  });

  it("对象自身 '01' 键精确命中(不微当数组下标)", async () => {
    const cfg = JSON.stringify({ '01': 'objKey01' });
    const p1 = pageWith([['cfg', cfg]]);
    await executeChecks(p1, dataCheck({ local_storage: 'cfg', path: '01' }, 'objKey01'), createValueContext(), new RequestTracker(), 1000);
    // 不存在 '1' 键 → missing
    const p2 = pageWith([['cfg', cfg]]);
    await expect(executeChecks(p2, dataCheck({ local_storage: 'cfg', path: '1' }, 'objKey01'), createValueContext(), new RequestTracker(), 1000)).rejects.toThrow();
  });

  it('malformed JSON → 失败', async () => {
    const page = pageWith([['cfg', 'not json']]);
    await expect(executeChecks(page, dataCheck({ local_storage: 'cfg', path: 'a' }, 'x'), createValueContext(), new RequestTracker(), 1000)).rejects.toThrow();
  });

  it('命中对象/数组(非标量)→ 失败', async () => {
    const page = pageWith([['cfg', cfg]]);
    await expect(executeChecks(page, dataCheck({ local_storage: 'cfg', path: 'obj' }, {}), createValueContext(), new RequestTracker(), 1000)).rejects.toThrow();
    const page2 = pageWith([['cfg', cfg]]);
    await expect(executeChecks(page2, dataCheck({ local_storage: 'cfg', path: 'arr' }, []), createValueContext(), new RequestTracker(), 1000)).rejects.toThrow();
  });

  it('空 JSON 的 constructor.name 继承属性不误报(原型隔离)', async () => {
    const page = pageWith([['cfg', '{}']]);
    await expect(executeChecks(page, dataCheck({ local_storage: 'cfg', path: 'constructor.name' }, 'Object'), createValueContext(), new RequestTracker(), 1000)).rejects.toThrow();
  });

  it('显式自身 constructor 字段可命中(不黑名单)', async () => {
    const page = pageWith([['cfg', JSON.stringify({ constructor: { name: 'real' } })]]);
    await executeChecks(page, dataCheck({ local_storage: 'cfg', path: 'constructor.name' }, 'real'), createValueContext(), new RequestTracker(), 1000);
  });

  it('缺失 key(无原始 JSON 可解析)→ 失败', async () => {
    const page = pageWith([]);
    await expect(executeChecks(page, dataCheck({ local_storage: 'cfg', path: 'a' }, 'x'), createValueContext(), new RequestTracker(), 1000)).rejects.toThrow();
  });
});

describe('assert data 回放:global(真实标量)', () => {
  const globals = {
    gStr: { value: { type: 'string', value: 'v1' } },
    gNum: { value: { type: 'number', value: 7 } },
    gBool: { value: { type: 'boolean', value: false } },
    gNull: { value: { type: 'object', subtype: 'null', value: null } },
  };

  it('标量相等 → 通过(含 null/0/false)', async () => {
    for (const [name, equals] of [['gStr', 'v1'], ['gNum', 7], ['gBool', false], ['gNull', null]] as Array<[string, unknown]>) {
      const page = pageWith([], globals);
      await executeChecks(page, dataCheck({ global: name }, equals), createValueContext(), new RequestTracker(), 1000);
    }
  });

  it('缺属性 → 失败', async () => {
    const page = pageWith([], globals);
    await expect(executeChecks(page, dataCheck({ global: 'nope' }, null), createValueContext(), new RequestTracker(), 1000)).rejects.toThrow();
  });

  it('类型不匹配(string vs number)→ 失败', async () => {
    const page = pageWith([], globals);
    await expect(executeChecks(page, dataCheck({ global: 'gNum' }, '7'), createValueContext(), new RequestTracker(), 1000)).rejects.toThrow();
  });
});

describe('assert data 回放：P4 安全诊断（不回显期望/实际值）', () => {
  it('mismatch 错误信息只带源与固定文案，不包含期望/实际值（防敏感值进 replay HTML）', async () => {
    const page = pageWith([['mode', 'secret-actual-value-987654321']]);
    let message = '';
    try {
      await executeChecks(page, dataCheck({ local_storage: 'mode' }, 'secret-expected-value-123456789'), createValueContext(), new RequestTracker(), 1000);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('❌ assert.data');
    expect(message).toContain('"local_storage":"mode"');
    expect(message).toContain('期望值与实际值不一致');
    expect(message).not.toContain('secret-expected-value');
    expect(message).not.toContain('secret-actual-value');
  });

  it('成功日志同样不回显期望值', async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.join(' ')); };
    try {
      const page = pageWith([['mode', 'secret-pass-value-13579']]);
      await executeChecks(page, dataCheck({ local_storage: 'mode' }, 'secret-pass-value-13579'), createValueContext(), new RequestTracker(), 1000);
    } finally {
      console.log = origLog;
    }
    const dataLogs = logs.filter((l) => l.includes('assert.data'));
    expect(dataLogs).toHaveLength(1);
    expect(dataLogs[0]).not.toContain('secret-pass-value');
  });
});
