import { describe, it, expect, vi } from 'vitest';
import { resolveLocator, resolveLocatorWithFallback } from '../locator.js';
import type { Locator } from '../types.js';

function makeChainable(): any {
  const proxy: any = vi.fn(() => proxy);
  proxy.filter = vi.fn(() => proxy);
  proxy.getByRole = vi.fn(() => proxy);
  proxy.getByLabel = vi.fn(() => proxy);
  proxy.getByText = vi.fn(() => proxy);
  proxy.getByTestId = vi.fn(() => proxy);
  proxy.locator = vi.fn(() => proxy);
  proxy.frameLocator = vi.fn(() => proxy);
  proxy.or = vi.fn(() => proxy);
  return proxy;
}

function mockPage() {
  const page: any = {
    getByRole: vi.fn(() => makeChainable()),
    getByLabel: vi.fn(() => makeChainable()),
    getByText: vi.fn(() => makeChainable()),
    getByTestId: vi.fn(() => makeChainable()),
    locator: vi.fn(() => makeChainable()),
    frameLocator: vi.fn(() => makeChainable()),
  };
  return page;
}

/** 节点级 locator mock：候选间相互独立，count/waitFor 推进 clock 模拟耗时。
 *  gate 为跨 or 合并共享的等待门计数（模拟并集等待门推着全体候选出现）。 */
function nodeLocator(clock: { now: number }, nodes: string[], opts: { delayed?: boolean; disappearOnce?: boolean; neverAttaches?: boolean; protocolError?: Error | null } = {}, gate = { calls: 0 }) {
  let countCalls = 0;
  const loc: any = {
    nodes,
    get gateCalls() { return gate.calls; },
    get countCalls() { return countCalls; },
    async count() {
      countCalls += 1;
      clock.now += 200;
      if (opts.delayed && gate.calls === 0) return 0;
      if (opts.disappearOnce && gate.calls === 1) return 0;
      return nodes.length;
    },
    or(other: any) { return nodeLocator(clock, [...new Set([...nodes, ...other.nodes])], opts, gate); },
    first() {
      return {
        async waitFor(o: { state: string; timeout: number }) {
          expect(o.state).toBe('attached');
          expect(o.timeout).toBeGreaterThan(0);
          clock.now += 100;
          gate.calls += 1;
          if (opts.neverAttaches) throw new Error(`Timeout ${o.timeout}ms exceeded`);
          if (opts.protocolError) throw opts.protocolError;
        },
      };
    },
  };
  return loc;
}

/** 主定位→input、fallback getByText→label 相互独立节点的拓扑 page */
function nodePage(clock: { now: number }, opts: { primaryNodes?: string[]; labelNodes?: string[]; nodeOpts?: Record<string, unknown> } = {}) {
  const page: any = mockPage();
  page.getByRole = vi.fn(() => nodeLocator(clock, opts.primaryNodes ?? ['input'], opts.nodeOpts));
  page.getByText = vi.fn(() => nodeLocator(clock, opts.labelNodes ?? ['label'], opts.nodeOpts));
  page.locator = vi.fn((sel: string) => nodeLocator(clock, sel === '#missing' ? [] : ['input'], opts.nodeOpts));
  return page;
}

describe('locator', () => {
  it('role with name+exact', () => {
    const page = mockPage();
    const loc: Locator = { role: 'button', name: '提交' };
    resolveLocator(page, loc);
    expect(page.getByRole).toHaveBeenCalledWith('button', { name: '提交', exact: true, includeHidden: false });
  });

  it('role without name', () => {
    const page = mockPage();
    const loc: Locator = { role: 'row' };
    resolveLocator(page, loc);
    expect(page.getByRole).toHaveBeenCalledWith('row', { includeHidden: false });
  });

  it('label', () => {
    const page = mockPage();
    const loc: Locator = { label: '商品名称' };
    resolveLocator(page, loc);
    expect(page.getByLabel).toHaveBeenCalledWith('商品名称');
  });

  it('text without normalize', () => {
    const page = mockPage();
    const loc: Locator = { text: 'hello' };
    resolveLocator(page, loc);
    expect(page.getByText).toHaveBeenCalledWith('hello');
  });

  it('text with normalize', () => {
    const page = mockPage();
    const loc: Locator = { text: '\u00e9', normalize: true };
    resolveLocator(page, loc);
    expect(page.getByText).toHaveBeenCalledWith('\u00e9'.normalize('NFC'));
  });

  it('testid', () => {
    const page = mockPage();
    const loc: Locator = { testid: 'submit-btn' };
    resolveLocator(page, loc);
    expect(page.getByTestId).toHaveBeenCalledWith('submit-btn');
  });

  it('css', () => {
    const page = mockPage();
    const loc: Locator = { css: '.my-class' };
    resolveLocator(page, loc);
    expect(page.locator).toHaveBeenCalledWith('.my-class');
  });

  it('row with contains', () => {
    const page = mockPage();
    const loc: Locator = { row: { contains: '苹果' } };
    resolveLocator(page, loc);
    expect(page.getByRole).toHaveBeenCalledWith('row', { includeHidden: false });
  });

  it('row with role chain', () => {
    const page = mockPage();
    const loc: Locator = { row: { contains: '苹果' }, role: 'button', name: '编辑' };
    resolveLocator(page, loc);
    expect(page.getByRole).toHaveBeenNthCalledWith(1, 'row', { includeHidden: false });
  });

  it('role with within', () => {
    const page = mockPage();
    const loc: Locator = { role: 'button', name: '保存', within: { label: '表单区' } };
    resolveLocator(page, loc);
    expect(page.getByRole).toHaveBeenCalledWith('button', { name: '保存', exact: true, includeHidden: false });
    expect(page.getByLabel).toHaveBeenCalledWith('表单区');
  });

  it('fallback chain：主候选唯一时优先返回，不消费后备', async () => {
    const clock = { now: 0 };
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => clock.now);
    try {
      const page = mockPage();
      const aNode = nodeLocator(clock, ['a-node']);
      const bNode = nodeLocator(clock, ['b-node']);
      page.locator = vi.fn((sel: string) => (sel === '.a' ? aNode : bNode)) as any;
      const loc: Locator = { css: '.a' };
      const fallback: Locator[] = [{ css: '.b' }];
      const selected = await resolveLocatorWithFallback(page, loc, fallback);
      expect((selected as any).nodes).toEqual(['a-node']);
      expect(bNode.countCalls).toBe(0); // 有效主定位不消费后备
    } finally {
      spy.mockRestore();
    }
  });

  it('only fallback no locator：单候选直接返回', async () => {
    const page = mockPage();
    const node = nodeLocator({ now: 0 }, ['b-node']);
    page.locator = vi.fn(() => node) as any;
    const fallback: Locator[] = [{ css: '.b' }];
    const selected = await resolveLocatorWithFallback(page, undefined, fallback);
    expect(page.locator).toHaveBeenCalledWith('.b');
    expect((selected as any).nodes).toEqual(['b-node']);
    expect(node.gateCalls).toBe(0); // 单候选不进等待门
  });

  it('no locator no fallback throws', async () => {
    const page = mockPage();
    await expect(resolveLocatorWithFallback(page, undefined, undefined)).rejects.toThrow('no locator');
  });

  // P3 回放事实 2.3：FrameSchema 真实允许 {}（空描述），空 frame 不能静默落回主文档
  it('空 frame 描述 throw，不落回主文档（空 selector 不 continue）', () => {
    const page = mockPage();
    const loc: Locator = { css: '.x' };
    expect(() => resolveLocator(page, loc, [{}])).toThrow(/frame/);
    expect(page.locator).not.toHaveBeenCalled();
  });
});

describe('resolveLocatorWithFallback 候选选择', () => {
  const useClock = () => {
    const clock = { now: 0 };
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => clock.now);
    return { clock, restore: () => spy.mockRestore() };
  };

  it('主定位缺失时用声明顺序第一个唯一 fallback', async () => {
    const { clock, restore } = useClock();
    try {
      const page = nodePage(clock);
      const selected = await resolveLocatorWithFallback(page, { css: '#missing' }, [{ css: '#frame-input' }]);
      expect((selected as any).nodes).toEqual(['input']);
    } finally { restore(); }
  });

  it('主/后备指同一个节点：主优先，不合成两节点', async () => {
    const { clock, restore } = useClock();
    try {
      const page = nodePage(clock);
      const selected = await resolveLocatorWithFallback(page, { css: '#frame-input' }, [{ css: '#frame-input' }]);
      expect((selected as any).nodes).toEqual(['input']);
      expect((selected as any).countCalls).toBe(1);
    } finally { restore(); }
  });

  it('主/后备都晚到：等待门通过后 count 才有值', async () => {
    const { clock, restore } = useClock();
    try {
      const page = nodePage(clock, { nodeOpts: { delayed: true } });
      const selected = await resolveLocatorWithFallback(page, { role: 'textbox', name: 'frame-input' }, [{ text: 'frame-input' }], undefined, 5000);
      expect((selected as any).nodes).toEqual(['input']);
    } finally { restore(); }
  });

  it('等待门后候选全部消失：同一 deadline 内回到等待不重置预算', async () => {
    const { clock, restore } = useClock();
    try {
      const page = nodePage(clock, { nodeOpts: { disappearOnce: true } });
      const selected = await resolveLocatorWithFallback(page, { css: '#frame-input' }, [{ css: '#missing' }], undefined, 5000);
      expect((selected as any).nodes).toEqual(['input']);
      // 候选 count 被读 2 次：首次等待门后消失（0）→ 回环再等待后唯一匹配（1）
      expect((selected as any).countCalls).toBe(2);
    } finally { restore(); }
  });

  it('主定位歧义：明确拒绝，不选 first', async () => {
    const { clock, restore } = useClock();
    try {
      const page = nodePage(clock, { primaryNodes: ['input-a', 'input-b'] });
      await expect(resolveLocatorWithFallback(page, { role: 'textbox', name: 'frame-input' }, [{ text: 'frame-input' }]))
        .rejects.toThrow(/fallback 定位歧义：候选#1 匹配 2 个节点/);
    } finally { restore(); }
  });

  it('全部缺失：原生 waitFor timeout 错误原样传播', async () => {
    const { clock, restore } = useClock();
    try {
      const page = nodePage(clock, { nodeOpts: { neverAttaches: true } });
      await expect(resolveLocatorWithFallback(page, { css: '#missing' }, [{ css: '#also-missing' }], undefined, 5000))
        .rejects.toThrow(/Timeout 5000ms exceeded/);
    } finally { restore(); }
  });

  it('协议/关闭错误直接传播，不转换成功', async () => {
    const { clock, restore } = useClock();
    try {
      const protocolError = new Error('Target closed');
      const page = nodePage(clock, { nodeOpts: { protocolError } });
      await expect(resolveLocatorWithFallback(page, { css: '#frame-input' }, [{ css: '#missing' }], undefined, 5000))
        .rejects.toBe(protocolError);
    } finally { restore(); }
  });

  it('非正预算拒绝，不把 0 传给 Playwright', async () => {
    const { clock, restore } = useClock();
    try {
      const page = nodePage(clock);
      await expect(resolveLocatorWithFallback(page, { css: '#frame-input' }, [{ css: '#missing' }], undefined, 0))
        .rejects.toThrow(/预算耗尽/);
    } finally { restore(); }
  });

  it('候选唯一但预算耗尽：拒绝返回', async () => {
    const { clock, restore } = useClock();
    try {
      const page = nodePage(clock);
      // waitFor 100 + count 200 → deadline(300) 恰耗尽
      await expect(resolveLocatorWithFallback(page, { css: '#frame-input' }, [{ css: '#missing' }], undefined, 300))
        .rejects.toThrow(/预算耗尽/);
    } finally { restore(); }
  });

  it('空 frame 描述在 fallback 解析中同样拒绝', async () => {
    const { clock, restore } = useClock();
    try {
      const page = nodePage(clock);
      await expect(resolveLocatorWithFallback(page, { css: '#frame-input' }, [{ css: '#missing' }], [{}]))
        .rejects.toThrow(/frame/);
    } finally { restore(); }
  });
});
