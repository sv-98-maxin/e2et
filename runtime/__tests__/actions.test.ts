import { afterEach, describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { executeAction } from '../actions.js';
import type { InputCommit } from '../shared/types.js';
import type { Step } from '../types.js';
import { createValueContext } from '../value.js';
import { RequestTracker } from '../request-tracker.js';

const inputCommits: InputCommit[] = [];
const recordInput = (commit: InputCommit): void => { inputCommits.push(commit); };
afterEach(async () => { for (const commit of inputCommits.splice(0)) await commit.dispose(); });

function makeChainable(): any {
  const proxy: any = vi.fn(() => proxy);
  proxy.click = vi.fn(() => Promise.resolve());
  proxy.fill = vi.fn(() => Promise.resolve());
  proxy.press = vi.fn(() => Promise.resolve());
  proxy.selectOption = vi.fn(() => Promise.resolve());
  proxy.hover = vi.fn(() => Promise.resolve());
  proxy.setInputFiles = vi.fn(() => Promise.resolve());
  proxy.scrollIntoViewIfNeeded = vi.fn(() => Promise.resolve());
  proxy.evaluate = vi.fn(() => Promise.resolve());
  const leaf: any = {
    asElement: () => leaf,
    evaluate: vi.fn(async (fn: Function) => /prepareWriteTarget|assertWriteReady/.test(String(fn)) ? 'text' : {}),
    dispose: vi.fn(async () => {}),
  };
  proxy.elementHandle = vi.fn(async () => ({ evaluateHandle: vi.fn(async () => leaf), dispose: vi.fn(async () => {}) }));
  proxy.waitFor = vi.fn(() => Promise.resolve());
  proxy.filter = vi.fn(() => proxy);
  proxy.or = vi.fn(() => proxy);
  proxy.getByRole = vi.fn(() => proxy);
  return proxy;
}

function mockPage() {
  const page: any = {
    getByRole: vi.fn(() => makeChainable()),
    getByLabel: vi.fn(() => makeChainable()),
    getByText: vi.fn(() => makeChainable()),
    getByTestId: vi.fn(() => makeChainable()),
    locator: vi.fn(() => makeChainable()),
    goto: vi.fn(() => Promise.resolve()),
    reload: vi.fn(() => Promise.resolve()),
    goBack: vi.fn(() => Promise.resolve()),
    evaluate: vi.fn(() => Promise.resolve()),
    mouse: { wheel: vi.fn(() => Promise.resolve()) },
    keyboard: { insertText: vi.fn(async () => {}), type: vi.fn(async () => {}), press: vi.fn(async () => {}) },
    url: vi.fn(() => 'https://example.com'),
    waitForTimeout: vi.fn(() => Promise.resolve()),
  };
  return page;
}

function mockContext() {
  const closeListeners = new Set<() => void>();
  const context: any = {
    pages: vi.fn(() => []),
    waitForEvent: vi.fn(() => Promise.resolve({})),
    once: vi.fn((event: string, listener: () => void) => {
      if (event === 'close') closeListeners.add(listener);
      return context;
    }),
    off: vi.fn((event: string, listener: () => void) => {
      if (event === 'close') closeListeners.delete(listener);
      return context;
    }),
    emitClose: () => {
      const listeners = [...closeListeners];
      closeListeners.clear();
      for (const listener of listeners) listener();
    },
  };
  return context;
}

describe('actions', () => {
  it('open with url in args（合法 Value 正例）', async () => {
    const page = mockPage();
    const step: Step = {
      id: 's1', intent: '打开', action: 'open', trace_ref: 'a1',
      value: { literal: 'https://example.com' },
    };
    await executeAction(page, mockContext(), step, createValueContext(), new RequestTracker(), '/tmp', undefined, recordInput);
    expect(page.goto).toHaveBeenCalledWith('https://example.com', { waitUntil: 'domcontentloaded' });
  });

  it('open with value', async () => {
    const page = mockPage();
    const step: Step = {
      id: 's1', intent: '打开', action: 'open', trace_ref: 'a1',
      value: { literal: 'https://val.com' },
    };
    await executeAction(page, mockContext(), step, createValueContext(), new RequestTracker(), '/tmp', undefined, recordInput);
    expect(page.goto).toHaveBeenCalledWith('https://val.com', { waitUntil: 'domcontentloaded' });
  });

  it('click calls locator.click', async () => {
    const page = mockPage();
    const step: Step = {
      id: 's1', intent: '点击', action: 'click', trace_ref: 'a1',
      locator: { role: 'button', name: '保存' },
    };
    await executeAction(page, mockContext(), step, createValueContext(), new RequestTracker(), '/tmp', undefined, recordInput);
    expect(page.getByRole).toHaveBeenCalledWith('button', { name: '保存', exact: true, includeHidden: false });
  });

  it('fill resolves value', async () => {
    const page = mockPage();
    const step: Step = {
      id: 's1', intent: '填写', action: 'fill', trace_ref: 'a1',
      locator: { label: '名称' },
      value: { literal: '苹果' },
    };
    const vctx = createValueContext();
    await executeAction(page, mockContext(), step, vctx, new RequestTracker(), '/tmp', undefined, recordInput);
    expect(page.getByLabel).toHaveBeenCalledWith('名称');
  });

  it('type 换行 → keyboard.press(Enter)，不再逐字 keyboard.type(\\n)', async () => {
    const page = mockPage();
    const inputState = { value: '' };
    page.keyboard.type = vi.fn(async (char: string) => { inputState.value += char; });
    page.keyboard.press = vi.fn(async (key: string) => {
      if (key === 'Enter') inputState.value += '\n';
    });
    const locator = makeChainable();
    const leaf: any = {
      asElement: () => leaf,
      evaluate: vi.fn(async (fn: Function) => {
        if (fn.name === 'readWriteTarget') return inputState.value;
        return /prepareWriteTarget|assertWriteReady/.test(String(fn)) ? 'text' : {};
      }),
      dispose: vi.fn(async () => {}),
    };
    locator.elementHandle = vi.fn(async () => ({ evaluateHandle: vi.fn(async () => leaf), dispose: vi.fn(async () => {}) }));
    page.getByLabel = vi.fn(() => locator);
    const step: Step = {
      id: 's1', intent: '输入多行', action: 'type', trace_ref: 'a1',
      locator: { label: '备注' },
      value: { literal: '第一行\n第二行' },
    };

    await executeAction(page, mockContext(), step, createValueContext(), new RequestTracker(), '/tmp', undefined, recordInput);

    expect(page.keyboard.press).toHaveBeenCalledWith('Enter');
    expect(page.keyboard.type.mock.calls.some(([char]: [string]) => char === '\n')).toBe(false);
    expect(inputState.value).toBe('第一行\n第二行');
  });

  it('press with key', async () => {
    const page = mockPage();
    const step: Step = {
      id: 's1', intent: '按键', action: 'press', trace_ref: 'a1',
      locator: { css: 'input' },
      args: { key: 'Enter' },
    };
    await executeAction(page, mockContext(), step, createValueContext(), new RequestTracker(), '/tmp', undefined, recordInput);
    expect(page.locator).toHaveBeenCalledWith('input');
  });

  it('scroll down (整页, 无 locator)', async () => {
    const page = mockPage();
    const step: Step = {
      id: 's1', intent: '滚动', action: 'scroll', trace_ref: 'a1',
      args: { direction: 'down', amount: 300 },
    };
    await executeAction(page, mockContext(), step, createValueContext(), new RequestTracker(), '/tmp', undefined, recordInput);
    expect(page.evaluate).toHaveBeenCalledWith(expect.any(Function), { axis: 'y', delta: 300 });
  });

  it('scroll left (整页)', async () => {
    const page = mockPage();
    const step: Step = {
      id: 's1', intent: '左滚', action: 'scroll', trace_ref: 'a1',
      args: { direction: 'left', amount: 400 },
    };
    await executeAction(page, mockContext(), step, createValueContext(), new RequestTracker(), '/tmp', undefined, recordInput);
    expect(page.evaluate).toHaveBeenCalledWith(expect.any(Function), { axis: 'x', delta: -400 });
  });

  it('scroll 无 direction 无 locator → 默认 down', async () => {
    const page = mockPage();
    const step: Step = {
      id: 's1', intent: '滚动', action: 'scroll', trace_ref: 'a1',
    };
    await executeAction(page, mockContext(), step, createValueContext(), new RequestTracker(), '/tmp', undefined, recordInput);
    expect(page.evaluate).toHaveBeenCalledWith(expect.any(Function), { axis: 'y', delta: 600 });
  });

  it('scroll 有 locator 无 direction → 共源 centerElement evaluate', async () => {
    const page = mockPage();
    const locator = makeChainable();
    page.getByRole = vi.fn(() => locator);
    const step: Step = {
      id: 's1', intent: '滚到按钮', action: 'scroll', trace_ref: 'a1',
      locator: { role: 'button', name: '确定' },
    };
    await executeAction(page, mockContext(), step, createValueContext(), new RequestTracker(), '/tmp', undefined, recordInput);
    expect(locator.evaluate).toHaveBeenCalled();
  });

  it('scroll 有 locator + direction → evaluate 祖先滚动', async () => {
    const page = mockPage();
    const locator = makeChainable();
    locator.evaluate = vi.fn(() => Promise.resolve({ found: true, moved: true }));
    page.getByRole = vi.fn(() => locator);
    const step: Step = {
      id: 's1', intent: '水平滚表格', action: 'scroll', trace_ref: 'a1',
      locator: { role: 'table', name: '商品列表' },
      args: { direction: 'right', amount: 500 },
    };
    await executeAction(page, mockContext(), step, createValueContext(), new RequestTracker(), '/tmp', undefined, recordInput);
    expect(locator.evaluate).toHaveBeenCalled();
    // 验证传给 evaluate 的单 input 对象（axis 与 delta = amount * sign(right=1)）
    const call = locator.evaluate.mock.calls[0];
    expect(call[1]).toEqual({ axis: 'x', delta: 500 });
  });

  it('refresh', async () => {
    const page = mockPage();
    const step: Step = {
      id: 's1', intent: '刷新', action: 'refresh', trace_ref: 'a1',
    };
    await executeAction(page, mockContext(), step, createValueContext(), new RequestTracker(), '/tmp', undefined, recordInput);
    expect(page.reload).toHaveBeenCalled();
  });

  it('back', async () => {
    const page = mockPage();
    const step: Step = {
      id: 's1', intent: '后退', action: 'back', trace_ref: 'a1',
    };
    await executeAction(page, mockContext(), step, createValueContext(), new RequestTracker(), '/tmp', undefined, recordInput);
    expect(page.goBack).toHaveBeenCalled();
  });

  it('fill_form fills each field', async () => {
    const page = mockPage();
    const step: Step = {
      id: 's1', intent: '填表', action: 'fill_form', trace_ref: 'a1',
      args: {
        scope: 'targeted',
        fields: {
          '商品名': { literal: '苹果' },
          '价格': { literal: '9.9' },
        },
        field_locators: {
          '商品名': { role: 'textbox', name: '商品名' },
          '价格': { role: 'textbox', name: '价格' },
        },
        field_order: ['商品名', '价格'],
      },
    };
    const res = await executeAction(page, mockContext(), step, createValueContext(), new RequestTracker(), '/tmp', undefined, recordInput);
    expect(page.getByRole).toHaveBeenCalledTimes(2);
    expect(page.getByRole).toHaveBeenCalledWith('textbox', { name: '商品名', exact: true, includeHidden: false });
    expect(page.getByRole).toHaveBeenCalledWith('textbox', { name: '价格', exact: true, includeHidden: false });
    expect(res.outputValue).toBe(JSON.stringify({ '商品名': '苹果', '价格': '9.9' }));
  });
});

/** 预算正反例：fallback 路径原生 options timeout 递减不重置；无 fallback 不显式传 timeout */
describe('actions fallback 原生预算', () => {
  function makeBudgetLocator(clock: { now: number }, countStep = 200) {
    const writes: Array<{ op: string; value?: string; timeout?: number; files?: string[]; bytes?: Buffer[] }> = [];
    const gate = { calls: 0 };
    function locator(nodes: string[], opts: { countZero?: boolean } = {}): any {
      return {
        nodes,
        async count() {
          clock.now += countStep;
          if (opts.countZero) return 0;
          return nodes.length;
        },
        or(other: any) { return locator([...new Set([...nodes, ...other.nodes])]); },
        first() {
          return {
            async waitFor(o: { state: string; timeout: number }) {
              expect(o.state).toBe('attached');
              expect(o.timeout).toBeGreaterThan(0);
              clock.now += 100;
              gate.calls += 1;
            },
          };
        },
        async click(options?: { timeout?: number }) {
          if (nodes.length !== 1) throw new Error('strict mode violation: ' + nodes.join(','));
          writes.push({ op: 'click', timeout: options?.timeout });
          clock.now += 300;
        },
        async fill(value: string, options?: { timeout?: number }) {
          if (nodes.length !== 1) throw new Error('strict mode violation: ' + nodes.join(','));
          writes.push({ op: 'fill', value, timeout: options?.timeout });
        },
        async press(_key: string, options?: { timeout?: number }) {
          writes.push({ op: 'press', timeout: options?.timeout });
        },
        async selectOption(v: unknown, options?: { timeout?: number }) {
          writes.push({ op: 'selectOption', value: String(v), timeout: options?.timeout });
        },
        async hover(options?: { timeout?: number }) {
          writes.push({ op: 'hover', timeout: options?.timeout });
        },
        async elementHandle(options?: { timeout?: number }) {
          return {
            evaluate: vi.fn(async () => { writes.push({ op: 'hover', timeout: options?.timeout }); }),
            evaluateHandle: vi.fn(async () => {
              writes.push({ op: 'input-target', timeout: options?.timeout });
              const leaf: any = {
                asElement: () => leaf,
                evaluate: vi.fn(async (fn: Function) => /prepareWriteTarget|assertWriteReady/.test(String(fn)) ? 'text' : {}),
                dispose: vi.fn(async () => {}),
              };
              return leaf;
            }),
            dispose: vi.fn(async () => {}),
          };
        },
        async scrollIntoViewIfNeeded(options?: { timeout?: number }) {
          writes.push({ op: 'scrollIntoViewIfNeeded', timeout: options?.timeout });
        },
        async setInputFiles(files: string[], options?: { timeout?: number }) {
          writes.push({
            op: 'setInputFiles', files, timeout: options?.timeout,
            bytes: files.map(file => fs.readFileSync(file)),
          });
        },
        // Phase3a：select 走共源原生 select（evaluate(fn, wanted, options)，返回真实 picked label）；
        // choose 原生多选：evaluate(fn, null) 读形状 → evaluate(fn, {labels,indexes,add}) 原子写入
        async evaluate(_fn?: unknown, arg?: string | { value?: string; labels?: string[]; indexes?: number[] }, options?: { timeout?: number }) {
          if (typeof arg === 'string') {
            writes.push({ op: 'select', value: arg, timeout: options?.timeout });
            return arg;
          }
          if (arg && typeof arg.value === 'string') {
            writes.push({ op: 'fill', value: arg.value, timeout: options?.timeout });
            return arg.value;
          }
          if (arg === null || arg === undefined) {
            // readNativeOptions：null 实参读取，返回可回放的原生 multiple 形状
            writes.push({ op: 'evaluate', timeout: options?.timeout });
            return { multiple: true, labels: ['A'], disabled: [false] };
          }
          if (arg && Array.isArray(arg.labels) && Array.isArray(arg.indexes)) {
            // applyNativeSelection：返回请求项实际 label
            writes.push({ op: 'evaluate', timeout: options?.timeout });
            return arg.indexes.map((i) => arg.labels![i]);
          }
          writes.push({ op: 'evaluate', timeout: options?.timeout });
        },
      };
    }
    return { locator, writes };
  }

  function budgetPage(clock: { now: number }, countStep = 200) {
    const { locator, writes } = makeBudgetLocator(clock, countStep);
    const page: any = mockPage();
    page.keyboard.insertText = vi.fn(async (value: string) => { writes.push({ op: 'fill', value }); });
    page.getByRole = vi.fn(() => locator(['input']));
    page.getByText = vi.fn(() => locator(['label']));
    page.locator = vi.fn((sel: string) => locator(sel === '#missing' ? [] : ['input']));
    return { page, writes };
  }

  const useClock = () => {
    const clock = { now: 0 };
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => clock.now);
    return { clock, restore: () => spy.mockRestore() };
  };

  it('fill 带 fallback：固定输入叶时继承剩余定位预算', async () => {
    const { clock, restore } = useClock();
    try {
      const { page, writes } = budgetPage(clock);
      const step: Step = {
        id: 's1', intent: '填写', action: 'fill', trace_ref: 'a1',
        locator: { role: 'textbox', name: 'frame-input' },
        fallback: [{ text: 'frame-input' }],
        value: { literal: '42' },
      };
      await executeAction(page, mockContext(), step, createValueContext(), new RequestTracker(), '/tmp', undefined, recordInput);
      // 等待门 100 + 主候选 count 200 → 实际输入句柄解析拿剩余 29700 预算
      expect(writes.map((w) => [w.op, w.timeout])).toEqual([
        ['input-target', 29700], ['fill', undefined],
      ]);
      expect(writes[1].value).toBe('42');
    } finally { restore(); }
  });

  it('fill 无 fallback：options undefined，维持旧原生默认', async () => {
    const { clock, restore } = useClock();
    try {
      const { page, writes } = budgetPage(clock);
      const step: Step = {
        id: 's1', intent: '填写', action: 'fill', trace_ref: 'a1',
        locator: { role: 'textbox', name: 'frame-input' },
        value: { literal: '42' },
      };
      await executeAction(page, mockContext(), step, createValueContext(), new RequestTracker(), '/tmp', undefined, recordInput);
      expect(writes.map((w) => w.timeout)).toEqual([undefined, undefined]);
    } finally { restore(); }
  });

  it('解析耗尽：不开始任何写动作', async () => {
    const { clock, restore } = useClock();
    try {
      const { page, writes } = budgetPage(clock, 20000);
      const step: Step = {
        id: 's1', intent: '填写', action: 'fill', trace_ref: 'a1',
        locator: { css: '#missing' },
        fallback: [{ css: '#missing' }, { css: '#frame-input' }],
        value: { literal: '42' },
      };
      await expect(executeAction(page, mockContext(), step, createValueContext(), new RequestTracker(), '/tmp', undefined, recordInput))
        .rejects.toThrow(/预算耗尽/);
      expect(writes).toHaveLength(0);
    } finally { restore(); }
  });

  it.each([
    ['press', { action: 'press', args: { key: 'Enter' } }],
    ['select', { action: 'select', value: { literal: 'A' } }],
    ['choose', { action: 'choose', args: { options: ['A'] } }],
    ['hover', { action: 'hover' }],
    ['scrollIntoView', { action: 'scroll' }],
  ] as const)('%s 带 fallback：原生调用拿同一 deadline 剩余', async (_name, extra) => {
    const { clock, restore } = useClock();
    try {
      const { page, writes } = budgetPage(clock);
      const step: Step = {
        id: 's1', intent: '动作', trace_ref: 'a1',
        locator: { role: 'textbox', name: 'frame-input' },
        fallback: [{ text: 'frame-input' }],
        ...extra,
      } as Step;
      await executeAction(page, mockContext(), step, createValueContext(), new RequestTracker(), '/tmp', undefined, recordInput);
      // choose 原生多选 = read + apply 两次 evaluate；其余为一次首个原生调用
      expect(writes).toHaveLength(_name === 'choose' ? 2 : 1);
      // 等待门 100 + count 200 → 首个原生调用 29700
      expect(writes[0].timeout).toBe(29700);
    } finally { restore(); }
  });

  it('upload 按索引私有复制并恢复原名，字节和顺序不变，context close 后清理 staging', async () => {
    const { clock, restore } = useClock();
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-upload-'));
    const aSha = 'a'.repeat(64), bSha = 'b'.repeat(64);
    const names = [`${aSha}-same.txt`, `${bSha}-same.txt`, `${aSha}-proof.pdf`];
    for (const name of names) fs.writeFileSync(path.join(fixtureDir, name), name);
    try {
      const { page, writes } = budgetPage(clock);
      const context = mockContext();
      const step: Step = {
        id: 's1', intent: '上传', trace_ref: 'a1',
        action: 'upload', locator: { role: 'button', name: '上传' },
        fallback: [{ text: '上传' }], args: { files: names },
      };
      await executeAction(page, context, step, createValueContext(), new RequestTracker(), fixtureDir, undefined, recordInput);
      const staged = writes[0].files as string[];
      expect(staged.map(file => path.basename(file))).toEqual(['same.txt', 'same.txt', 'proof.pdf']);
      expect(staged.map(file => path.basename(path.dirname(file)))).toEqual(['0', '1', '2']);
      expect((writes[0].bytes as Buffer[]).map(bytes => bytes.toString('utf8'))).toEqual(names);
      expect(new Set(staged.map(file => path.dirname(file))).size).toBe(3);
      const uploadDir = path.dirname(path.dirname(staged[0]));
      expect(staged.map(file => fs.readFileSync(file, 'utf8'))).toEqual(names);
      expect(fs.readdirSync(fixtureDir).sort()).toEqual([...names, path.basename(uploadDir)].sort());
      expect(context.once).toHaveBeenCalledWith('close', expect.any(Function));
      expect(context.off).not.toHaveBeenCalled();
      context.emitClose();
      expect(fs.existsSync(uploadDir)).toBe(false);
      expect(fs.readdirSync(fixtureDir).sort()).toEqual(names.sort());
    } finally {
      restore();
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it('date 带 fallback：定位消耗预算后固定实际输入叶', async () => {
    const { clock, restore } = useClock();
    try {
      const { page, writes } = budgetPage(clock);
      const step: Step = {
        id: 's1', intent: '日期', action: 'date', trace_ref: 'a1',
        locator: { role: 'textbox', name: 'frame-input' },
        fallback: [{ text: 'frame-input' }],
        value: { literal: '2026-01-01' },
      };
      await executeAction(page, mockContext(), step, createValueContext(), new RequestTracker(), '/tmp', undefined, recordInput);
      expect(writes).toHaveLength(2);
      expect(writes[0]).toMatchObject({ op: 'input-target', timeout: 29700 });
      expect(writes[1]).toMatchObject({ op: 'fill', value: '2026-01-01' });
    } finally { restore(); }
  });
});
