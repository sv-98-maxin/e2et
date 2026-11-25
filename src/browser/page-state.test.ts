import { describe, it, expect } from 'vitest';
import type { CdpSession } from './daemon-client.js';
import { collectPageState, probeBackendNode, CdpReadError } from './page-state.js';

interface FakeAx {
  role: string;
  roleType?: string;
  name: string;
  backendDOMNodeId?: number;
  ignored?: boolean;
  parentId?: string;
}

/** 假会话：真实可见性探测走 DOM.resolveNode + Runtime.callFunctionOn；
 *  首个节点初始化可见性工厂（返回 function RemoteObject），后续节点调用该工厂；
 *  fallback/fieldLabel 读取也走 Runtime.callFunctionOn，返回 fallbackName。
 *  这样能验证「combobox 无信息 name → 进 needsFallback → 回退值填充 name」的触发链路。 */
function fakeSession(opts: {
  ax: FakeAx[];
  partialAx?: FakeAx[];
  fallbackName?: string;
  visible?: Record<number, boolean>;
  malformedVisibility?: boolean;
  emptyResolve?: boolean;
}) {
  const calls: string[] = [];
  let factoryCalls = 0;
  let groupCalls = 0;
  const toAxNodes = (ax: FakeAx[]) => ax.map((e, i) => ({
    nodeId: String(i + 1),
    parentId: e.parentId,
    ignored: e.ignored ?? false,
    role: { type: e.roleType ?? 'role', value: e.role },
    name: { type: 'computedString', value: e.name },
    backendDOMNodeId: e.backendDOMNodeId ?? i + 1,
    properties: [],
    childIds: [],
  }));
  const session = {
    send(method: string, params: Record<string, unknown> = {}) {
      calls.push(method);
      if (method === 'Accessibility.enable') return Promise.resolve({});
      if (method === 'Accessibility.getFullAXTree') {
        return Promise.resolve({ nodes: toAxNodes(opts.ax) });
      }
      if (method === 'DOM.resolveNode') {
        if (opts.emptyResolve) return Promise.resolve({ object: null });
        return Promise.resolve({ object: { objectId: 'obj-' + String(params.backendNodeId) } });
      }
      if (method === 'Runtime.callFunctionOn') {
        const fn = String(params.functionDeclaration);
        if (params.returnByValue === false && fn.includes('isElementVisible')) {
          factoryCalls++;
          return Promise.resolve({ result: { type: 'function', objectId: 'visibility-fn' } });
        }
        // public probeBackendNode 的既有一次性可见性调用
        if (fn.includes('isConnected')) {
          return Promise.resolve({ result: { value: { connected: true, visible: true } } });
        }
        if (fn.includes('return this(element)')) {
          if (opts.malformedVisibility) return Promise.resolve({ result: {} });
          const args = params.arguments as Array<{ objectId: string }>;
          const backend = Number(args[0].objectId.replace('obj-', ''));
          return Promise.resolve({ result: { value: { connected: true, visible: opts.visible?.[backend] ?? true } } });
        }
        return Promise.resolve({ result: { value: opts.fallbackName } });
      }
      if (method === 'Runtime.releaseObjectGroup') {
        groupCalls++;
        return Promise.resolve({});
      }
      if (method === 'Accessibility.getPartialAXTree') {
        return Promise.resolve({ nodes: toAxNodes(opts.partialAx ?? []) });
      }
      if (method === 'Runtime.evaluate') {
        return Promise.resolve({ result: { value: { url: 'https://x', title: 'x' } } });
      }
      return Promise.resolve({});
    },
    evaluate(expression: string) {
      return session.send('Runtime.evaluate', { expression, returnByValue: true }).then((r: any) => r.result.value);
    },
  };
  return {
    session: session as unknown as CdpSession,
    calls,
    stats: () => ({ factoryCalls, groupCalls }),
  };
}

describe('collectPageState 快照级可见性闭包', () => {
  it('多个节点只注入一次完整可见性源，结尾释放同一 objectGroup 一次', async () => {
    const ax: FakeAx[] = Array.from({ length: 10 }, (_, i) => ({
      role: 'combobox',
      name: `控件${i}`,
      backendDOMNodeId: 700 + i,
    }));
    const { session, stats } = fakeSession({ ax, fallbackName: 'x' });
    await collectPageState(session);
    expect(stats()).toEqual({ factoryCalls: 1, groupCalls: 1 });
  });

  it('隐藏节点按工厂逐节点结果剔除，不影响其余可见元素', async () => {
    const { session } = fakeSession({
      ax: [
        { role: 'combobox', name: '可见', backendDOMNodeId: 800 },
        { role: 'combobox', name: '隐藏', backendDOMNodeId: 801 },
      ],
      fallbackName: 'x',
      visible: { 801: false },
    });
    const state = await collectPageState(session);
    expect(state.elements.map((e) => e.name)).toEqual(['可见']);
  });

  it.each([
    ['resolveNode 空对象', { emptyResolve: true }],
    ['可见性回包缺字段', { malformedVisibility: true }],
  ])('%s → CdpReadError，不当 gone', async (_label, opts) => {
    const { session } = fakeSession({
      ax: [{ role: 'combobox', name: '控件', backendDOMNodeId: 900 }],
      fallbackName: 'x',
      ...opts,
    });
    await expect(collectPageState(session)).rejects.toBeInstanceOf(CdpReadError);
  });
});

describe('collectPageState needsFallback 回退触发', () => {
  it('combobox 无信息 name(=控件类型名)触发回退，用 fallback 值填充', async () => {
    const { session, calls } = fakeSession({
      ax: [{ role: 'combobox', name: 'combobox', backendDOMNodeId: 10 }],
      fallbackName: '业务主体',
    });
    const state = await collectPageState(session);
    expect(calls).toContain('Runtime.callFunctionOn');
    expect(state.elements[0].name).toBe('业务主体');
  });

  it('combobox 空 name 触发回退', async () => {
    const { session, calls } = fakeSession({
      ax: [{ role: 'combobox', name: '', backendDOMNodeId: 11 }],
      fallbackName: '商品类型',
    });
    const state = await collectPageState(session);
    expect(calls).toContain('Runtime.callFunctionOn');
    expect(state.elements[0].name).toBe('商品类型');
  });

  it('combobox 有效 name 不触发回退（保留原 name）', async () => {
    const { session, calls } = fakeSession({
      ax: [{ role: 'combobox', name: '业务主体', backendDOMNodeId: 12 }],
      fallbackName: '不该用上',
    });
    const state = await collectPageState(session);
    expect(calls).toContain('Runtime.callFunctionOn');
    expect(state.elements[0].name).toBe('业务主体');
  });
});

describe('collectPageState radio/checkbox fieldLabel 补字段名', () => {
  it('radio 触发 fillFieldLabels，fieldLabel 用 fallback 值填充（name 保持选项）', async () => {
    // fakeSession 的 callFunctionOn 对所有调用返同一 fallbackName；
    // radio name=选项已有信息不进 needsFallback，但进 fieldLabelTargets，callFunctionOn 仍被调一次填 fieldLabel
    const { session, calls } = fakeSession({
      ax: [{ role: 'radio', name: '全国控', backendDOMNodeId: 20 }],
      fallbackName: '总分管理归属',
    });
    const state = await collectPageState(session);
    expect(state.elements[0].name).toBe('全国控'); // name 保持选项文本
    expect(state.elements[0].fieldLabel).toBe('总分管理归属'); // fieldLabel 填字段名
    expect(calls).toContain('Runtime.callFunctionOn');
  });

  it('checkbox 同样补 fieldLabel', async () => {
    const { session } = fakeSession({
      ax: [{ role: 'checkbox', name: '仅闪购', backendDOMNodeId: 21 }],
      fallbackName: '销售信息',
    });
    const state = await collectPageState(session);
    expect(state.elements[0].name).toBe('仅闪购');
    expect(state.elements[0].fieldLabel).toBe('销售信息');
  });

  it('非选项类控件(combobox)不填 fieldLabel', async () => {
    const { session } = fakeSession({
      ax: [{ role: 'combobox', name: '业务主体', backendDOMNodeId: 22 }],
      fallbackName: '业务主体',
    });
    const state = await collectPageState(session);
    expect(state.elements[0].fieldLabel).toBeUndefined();
  });
});

describe('collectPageState 截断计数', () => {
  it('>150 元素截断：elements.length===150 + truncated + total_elements=实际合格数', async () => {
    const ax: FakeAx[] = Array.from({ length: 160 }, (_, i) => ({
      role: 'combobox',
      name: `控件${i}`,
      backendDOMNodeId: 100 + i,
    }));
    const { session } = fakeSession({ ax, fallbackName: 'x' });
    const state = await collectPageState(session);
    expect(state.elements).toHaveLength(150);
    expect(state.truncated).toBe(true);
    expect(state.total_elements).toBe(160);
  });

  it('<150 元素不截断：无 truncated/total_elements 字段', async () => {
    const ax: FakeAx[] = Array.from({ length: 10 }, (_, i) => ({
      role: 'combobox',
      name: `控件${i}`,
      backendDOMNodeId: 200 + i,
    }));
    const { session } = fakeSession({ ax, fallbackName: 'x' });
    const state = await collectPageState(session);
    expect(state.elements).toHaveLength(10);
    expect(state.truncated).toBeUndefined();
    expect(state.total_elements).toBeUndefined();
  });

  it('恰好 150 个合格元素 + 后面跟非交互节点 → 无 truncated/total_elements', async () => {
    const ax: FakeAx[] = [
      ...Array.from({ length: 150 }, (_, i) => ({
        role: 'combobox',
        name: `控件${i}`,
        backendDOMNodeId: 300 + i,
      })),
      // 后面跟几个非交互节点（generic / ignored），不应触发截断也不计入总数
      { role: 'generic', name: '非交互', backendDOMNodeId: 999 },
      { role: 'text', name: '文本', backendDOMNodeId: 998 },
    ];
    const { session } = fakeSession({ ax, fallbackName: 'x' });
    const state = await collectPageState(session);
    expect(state.elements).toHaveLength(150);
    expect(state.truncated).toBeUndefined();
    expect(state.total_elements).toBeUndefined();
  });

  it('160 合格元素里掺 generic/ignored 节点 → total 仍是 160', async () => {
    const ax: FakeAx[] = [
      ...Array.from({ length: 160 }, (_, i) => ({
        role: 'combobox',
        name: `控件${i}`,
        backendDOMNodeId: 500 + i,
      })),
      // 掺入非交互/ignored 节点，不应计入 total_elements
      { role: 'generic', name: '噪声', backendDOMNodeId: 888 },
      { role: 'text', name: '噪声2', backendDOMNodeId: 887 },
      { role: 'combobox', name: 'ignored节点', backendDOMNodeId: 886, ignored: true },
    ];
    const { session } = fakeSession({ ax, fallbackName: 'x' });
    const state = await collectPageState(session);
    expect(state.elements).toHaveLength(150);
    expect(state.truncated).toBe(true);
    expect(state.total_elements).toBe(160);
  });
});

describe('internal AX role 公开映射', () => {
  it.each(['Date', 'InputTime', 'DateTime'])(
    '%s internalRole 映射为可交互 textbox，roleLocator 同步使用公开 role',
    async (internalRole) => {
      const { session } = fakeSession({
        ax: [{ role: internalRole, roleType: 'internalRole', name: '日期', backendDOMNodeId: 40 }],
      });

      const state = await collectPageState(session);

      expect(state.elements).toHaveLength(1);
      expect(state.elements[0].role).toBe('textbox');
      expect(state.elements[0].roleLocator).toEqual({ role: 'textbox', name: '日期' });
    },
  );

  it('Date 与同名真实 textbox 按映射后 role+name 计为重复，均不产出假唯一 roleLocator', async () => {
    const { session } = fakeSession({
      ax: [
        { role: 'Date', roleType: 'internalRole', name: '日期', backendDOMNodeId: 41 },
        { role: 'textbox', roleType: 'role', name: '日期', backendDOMNodeId: 42 },
      ],
    });

    const state = await collectPageState(session);

    expect(state.elements.map((element) => element.role)).toEqual(['textbox', 'textbox']);
    expect(state.elements.map((element) => element.roleLocator)).toEqual([undefined, undefined]);
  });

  it('非目标 internalRole 与 MenuListPopup 中原生 option 仍按原规则过滤', async () => {
    const { session } = fakeSession({
      ax: [
        { role: 'MenuListPopup', roleType: 'internalRole', name: '', backendDOMNodeId: 43 },
        { role: 'option', roleType: 'role', name: '选项', backendDOMNodeId: 44, parentId: '1' },
        { role: 'Time', roleType: 'internalRole', name: '非目标内部角色', backendDOMNodeId: 45 },
      ],
    });

    const state = await collectPageState(session);

    expect(state.elements).toEqual([]);
  });

  it('probeBackendNode 的 partial AX role 使用同一公开映射', async () => {
    const { session } = fakeSession({
      ax: [],
      partialAx: [{ role: 'Date', roleType: 'internalRole', name: '日期', backendDOMNodeId: 46 }],
    });

    const probe = await probeBackendNode(session, 46);

    expect(probe).toMatchObject({ state: 'present', visible: true, role: 'textbox', name: '日期' });
  });

  it('debug_ax 仍保留 raw internal role/role_type', async () => {
    const { session } = fakeSession({
      ax: [{ role: 'Date', roleType: 'internalRole', name: '日期', backendDOMNodeId: 47 }],
    });

    const state = await collectPageState(session, { debugAx: true });

    expect(state.elements[0].role).toBe('textbox');
    expect(state.debug_ax).toContainEqual(expect.objectContaining({
      backend_node_id: 47,
      role: 'Date',
      role_type: 'internalRole',
    }));
  });
});
