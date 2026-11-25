import { describe, it, expect, vi } from 'vitest';
import { runTest } from '../runner.js';
import type { IRv2 } from '../types.js';
import { createCdpMock, makeCdpContext } from './cdp-mock.js';

/** 机械迁移：runner attach 需要 context().newCDPSession 返回真实协议形状的 CDPSession mock */
async function runnerOptions(context: any): Promise<{ context: any; fixtureDir: string; cdpEndpoint: string }> {
  return { context, fixtureDir: '/tmp', cdpEndpoint: await context.__nativeEndpoint() };
}

function withCdp(page: any): any {
  page.__cdpMock = createCdpMock();
  page.isClosed = () => false;
  return page;
}

const minimalIR: IRv2 = {
  schema_version: 3,
  name: 'smoke-test',
  description: 'minimal smoke',
  url: 'https://example.com',
  covered_pages: [],
  env: 'pre',
  provenance: {
    session_id: 'test-session',
    auth_source: 'imported',
    browser_source: 'managed',
    tool_version: '0.0.0',
    generated_at: '2026-01-01T00:00:00Z',
    mocked: true,
  },
  steps: [
    {
      id: 's1',
      intent: '打开页面',
      action: 'open',
      trace_ref: 'a1',
      value: { literal: 'https://example.com' },
    },
    {
      id: 's2',
      intent: '填写名称',
      action: 'fill',
      trace_ref: 'a2',
      locator: { label: '名称' },
      value: { literal: '测试商品' },
      save_as: 'itemName',
    },
    {
      id: 's3',
      intent: '断言URL',
      action: 'refresh',
      trace_ref: 'a3',
      checks: [
        { assert: { url: { contains: 'example.com' } } },
      ],
    },
  ],
};

function makeChainable(state = { value: '' }) {
  const proxy: any = vi.fn(() => proxy);
  proxy.fill = vi.fn(() => Promise.resolve());
  proxy.click = vi.fn(() => Promise.resolve());
  proxy.waitFor = vi.fn(() => Promise.resolve());
  proxy.evaluate = vi.fn((_fn: unknown, arg: unknown) => Promise.resolve((arg as { value?: string } | undefined)?.value ?? ''));
  const leaf: any = {
    asElement: () => leaf,
    evaluate: vi.fn(async (fn: Function) => {
      if (fn.name === 'readWriteTarget') return state.value;
      return /prepareWriteTarget|assertWriteReady/.test(String(fn)) ? 'text' : {};
    }),
    dispose: vi.fn(async () => {}),
  };
  proxy.elementHandle = vi.fn(async () => ({ evaluateHandle: vi.fn(async () => leaf), dispose: vi.fn(async () => {}) }));
  return proxy;
}

function mockContext() {
  const inputState = { value: '' };
  const mockPage: any = {
    goto: vi.fn(() => Promise.resolve()),
    reload: vi.fn(() => Promise.resolve()),
    url: vi.fn(() => 'https://example.com/page'),
    on: vi.fn(),
    off: vi.fn(),
    setDefaultNavigationTimeout: vi.fn(),
    setDefaultTimeout: vi.fn(),
    getByRole: vi.fn(() => makeChainable(inputState)),
    getByLabel: vi.fn(() => makeChainable(inputState)),
    getByText: vi.fn(() => makeChainable(inputState)),
    getByTestId: vi.fn(() => makeChainable(inputState)),
    locator: vi.fn(() => makeChainable(inputState)),
    waitForResponse: vi.fn(() => Promise.resolve({})),
    waitForURL: vi.fn(() => Promise.resolve()),
    waitForFunction: vi.fn(() => Promise.resolve()),
    mouse: { wheel: vi.fn(() => Promise.resolve()) },
    keyboard: { insertText: vi.fn(async (value: string) => { inputState.value = value; }), type: vi.fn(async (char: string) => { inputState.value += char; }), press: vi.fn(async () => { inputState.value = ''; }) },
    waitForTimeout: vi.fn(() => Promise.resolve()),
  };
  const context: any = {
    newPage: vi.fn(() => Promise.resolve(mockPage)),
    pages: vi.fn(() => [mockPage]),
    waitForEvent: vi.fn(() => Promise.resolve(mockPage)),
  };
  withCdp(mockPage);
  return { context, mockPage };
}

describe('runner', () => {
  it('minimal IR smoke: open + fill + assert url', async () => {
    const { context, mockPage } = mockContext();
    makeCdpContext([mockPage], context, false);
    await runTest(minimalIR, await runnerOptions(context));
    expect(mockPage.goto).toHaveBeenCalledWith('https://example.com', { waitUntil: 'domcontentloaded' });
    expect(mockPage.getByLabel).toHaveBeenCalledWith('名称');
  });

  it('throws on unsupported action', async () => {
    const { context, mockPage } = mockContext();
    makeCdpContext([mockPage], context, false);
    const ir: IRv2 = {
      ...minimalIR,
      steps: [{
        id: 's1',
        intent: 'bad',
        action: 'bad' as any,
        trace_ref: 'a1',
      }],
    };
    await expect(runTest(ir, await runnerOptions(context))).rejects.toThrow('unsupported action');
  });

  it('switch_tab returns new page and runner reattaches tracker to it', async () => {
    const firstPage: any = {
      goto: vi.fn(() => Promise.resolve()),
      reload: vi.fn(() => Promise.resolve()),
      url: vi.fn(() => 'https://example.com/page'),
      on: vi.fn(),
      off: vi.fn(),
      setDefaultNavigationTimeout: vi.fn(),
      setDefaultTimeout: vi.fn(),
      getByRole: vi.fn(() => makeChainable()),
      getByLabel: vi.fn(() => makeChainable()),
      getByText: vi.fn(() => makeChainable()),
      getByTestId: vi.fn(() => makeChainable()),
      locator: vi.fn(() => makeChainable()),
      waitForResponse: vi.fn(() => Promise.resolve({})),
      waitForURL: vi.fn(() => Promise.resolve()),
      waitForFunction: vi.fn(() => Promise.resolve()),
      mouse: { wheel: vi.fn(() => Promise.resolve()) },
      waitForTimeout: vi.fn(() => Promise.resolve()),
    };
    withCdp(firstPage);
    const secondPage: any = {
      ...firstPage,
      on: vi.fn(),
      off: vi.fn(),
      setDefaultNavigationTimeout: vi.fn(),
      setDefaultTimeout: vi.fn(),
    };
    withCdp(secondPage);
    const context: any = {
      newPage: vi.fn(() => Promise.resolve(firstPage)),
      pages: vi.fn(() => [firstPage, secondPage]),
      waitForEvent: vi.fn(() => Promise.resolve(secondPage)),
    };
    const ir: IRv2 = {
      ...minimalIR,
      steps: [
        { id: 's1', intent: '开', action: 'open', trace_ref: 'a1', value: { literal: 'https://example.com' } },
        { id: 's2', intent: '切 tab', action: 'switch_tab', trace_ref: 'a2', args: { index: 1 } },
        {
          id: 's3', intent: '断言URL', action: 'refresh', trace_ref: 'a3',
          checks: [{ assert: { url: { contains: 'example.com' } } }],
        },
      ],
    };
    makeCdpContext([firstPage, secondPage], context, false);
    await runTest(ir, await runnerOptions(context));
    // secondPage 被后续 step 用作 page：refresh + assert.url 走 secondPage
    expect(secondPage.reload).toHaveBeenCalled();
    // tracker 通过 Browser root 的 non-flat child 采集新页，再按实际 targetInfo 绑定 Page。
    expect(secondPage.__cdpMock.sends.map((call: any) => call.method)).toContain('Network.enable');
  });

  it('设置初始 Page 原生超时为 30s（setDefaultNavigationTimeout/setDefaultTimeout）', async () => {
    const { context, mockPage } = mockContext();
    makeCdpContext([mockPage], context, false);
    await runTest(minimalIR, await runnerOptions(context));
    expect(mockPage.setDefaultNavigationTimeout).toHaveBeenCalledWith(30_000);
    expect(mockPage.setDefaultTimeout).toHaveBeenCalledWith(30_000);
  });

  it('switch_tab 后对新 Page 重设原生超时', async () => {
    const firstPage: any = {
      goto: vi.fn(() => Promise.resolve()),
      reload: vi.fn(() => Promise.resolve()),
      url: vi.fn(() => 'https://example.com/page'),
      on: vi.fn(), off: vi.fn(),
      setDefaultNavigationTimeout: vi.fn(), setDefaultTimeout: vi.fn(),
      getByRole: vi.fn(() => makeChainable()),
      getByLabel: vi.fn(() => makeChainable()),
      getByText: vi.fn(() => makeChainable()),
      getByTestId: vi.fn(() => makeChainable()),
      locator: vi.fn(() => makeChainable()),
      waitForResponse: vi.fn(() => Promise.resolve({})),
      waitForURL: vi.fn(() => Promise.resolve()),
      waitForFunction: vi.fn(() => Promise.resolve()),
      mouse: { wheel: vi.fn(() => Promise.resolve()) },
    };
    withCdp(firstPage);
    const secondPage: any = {
      ...firstPage, on: vi.fn(), off: vi.fn(),
      setDefaultNavigationTimeout: vi.fn(), setDefaultTimeout: vi.fn(),
    };
    withCdp(secondPage);
    const context: any = {
      newPage: vi.fn(() => Promise.resolve(firstPage)),
      pages: vi.fn(() => [firstPage, secondPage]),
      waitForEvent: vi.fn(() => Promise.resolve(secondPage)),
    };
    const ir: IRv2 = {
      ...minimalIR,
      steps: [
        { id: 's1', intent: '开', action: 'open', trace_ref: 'a1', value: { literal: 'https://example.com' } },
        { id: 's2', intent: '切 tab', action: 'switch_tab', trace_ref: 'a2', args: { index: 1 } },
      ],
    };
    makeCdpContext([firstPage, secondPage], context, false);
    await runTest(ir, await runnerOptions(context));
    expect(secondPage.setDefaultNavigationTimeout).toHaveBeenCalledWith(30_000);
    expect(secondPage.setDefaultTimeout).toHaveBeenCalledWith(30_000);
  });

  it('switch_tab 自带 check：新页 defaults 在本步 check 执行前已设', async () => {
    const order: string[] = [];
    const firstPage: any = {
      goto: vi.fn(() => Promise.resolve()),
      reload: vi.fn(() => Promise.resolve()),
      url: vi.fn(() => 'https://example.com/page'),
      on: vi.fn(), off: vi.fn(),
      setDefaultNavigationTimeout: vi.fn(() => order.push('first-nav')),
      setDefaultTimeout: vi.fn(() => order.push('first-to')),
      getByRole: vi.fn(() => makeChainable()),
      getByLabel: vi.fn(() => makeChainable()),
      getByText: vi.fn(() => makeChainable()),
      getByTestId: vi.fn(() => makeChainable()),
      locator: vi.fn(() => makeChainable()),
      waitForResponse: vi.fn(() => Promise.resolve({})),
      waitForURL: vi.fn(() => Promise.resolve()),
      waitForFunction: vi.fn(() => Promise.resolve()),
      mouse: { wheel: vi.fn(() => Promise.resolve()) },
    };
    withCdp(firstPage);
    const secondPage: any = {
      ...firstPage,
      on: vi.fn(), off: vi.fn(),
      setDefaultNavigationTimeout: vi.fn(() => order.push('second-nav')),
      setDefaultTimeout: vi.fn(() => order.push('second-to')),
      url: vi.fn(() => { order.push('check-url'); return 'https://example.com/switched'; }),
    };
    withCdp(secondPage);
    const context: any = {
      newPage: vi.fn(() => Promise.resolve(firstPage)),
      pages: vi.fn(() => [firstPage, secondPage]),
      waitForEvent: vi.fn(() => Promise.resolve(secondPage)),
    };
    const ir: IRv2 = {
      ...minimalIR,
      steps: [
        { id: 's1', intent: '开', action: 'open', trace_ref: 'a1', value: { literal: 'https://example.com' } },
        {
          id: 's2', intent: '切 tab 并断言', action: 'switch_tab', trace_ref: 'a2', args: { index: 1 },
          checks: [{ assert: { url: { contains: 'switched' } } }],
        },
      ],
    };
    makeCdpContext([firstPage, secondPage], context, false);
    await runTest(ir, await runnerOptions(context));
    // 本步 check（url）在 second page defaults 之后执行
    const navIdx = order.indexOf('second-nav');
    const toIdx = order.indexOf('second-to');
    const urlIdx = order.lastIndexOf('check-url');
    expect(navIdx).toBeGreaterThanOrEqual(0);
    expect(toIdx).toBeGreaterThanOrEqual(0);
    expect(urlIdx).toBeGreaterThan(navIdx);
    expect(urlIdx).toBeGreaterThan(toIdx);
  });

  it('wait_timeout_ms=0 的原生 wait 不到达 Playwright（预算耗尽先报错）', async () => {
    const { context, mockPage } = mockContext();
    makeCdpContext([mockPage], context, false);
    const ir: IRv2 = {
      ...minimalIR,
      steps: [
        { id: 's1', intent: '开', action: 'open', trace_ref: 'a1', value: { literal: 'https://example.com' } },
        {
          id: 's2', intent: '等元素', action: 'refresh', trace_ref: 'a2',
          wait_timeout_ms: 0,
          wait: [{ element: { css: '.x' }, state: 'visible' as const }],
        },
      ],
    };
    await expect(runTest(ir, await runnerOptions(context))).rejects.toThrow('预算耗尽');
  });

  // ── P3 回放事实 2.3：runner 把 step.frame 传给 waits；checks 不继承 frame ──

  it('step 带 frame 的 wait 走 frame 作用域（runner 传 step.frame 给 executeWaits）', async () => {
    const frameLoc = { waitFor: vi.fn(() => Promise.resolve()), innerText: vi.fn(() => Promise.resolve('frame-only')) };
    const scope: any = { getByText: vi.fn(() => frameLoc), locator: vi.fn(() => frameLoc) };
    const mockPage: any = {
      goto: vi.fn(() => Promise.resolve()),
      reload: vi.fn(() => Promise.resolve()),
      url: vi.fn(() => 'https://example.com/page'),
      on: vi.fn(), off: vi.fn(),
      setDefaultNavigationTimeout: vi.fn(), setDefaultTimeout: vi.fn(),
      frameLocator: vi.fn(() => scope),
      // 主文档不能满足 frame 声明的 wait
      getByText: vi.fn(() => { throw new Error('main document cannot satisfy the declared frame condition'); }),
      getByRole: vi.fn(() => { throw new Error('main document cannot satisfy the declared frame condition'); }),
      getByLabel: vi.fn(() => { throw new Error('main document cannot satisfy the declared frame condition'); }),
      getByTestId: vi.fn(() => { throw new Error('main document cannot satisfy the declared frame condition'); }),
      locator: vi.fn(() => { throw new Error('main document cannot satisfy the declared frame condition'); }),
      waitForResponse: vi.fn(() => Promise.resolve({})),
      waitForURL: vi.fn(() => Promise.resolve()),
      waitForFunction: vi.fn(() => Promise.resolve()),
    };
    withCdp(mockPage);
    const context: any = { newPage: vi.fn(() => Promise.resolve(mockPage)) };
    const ir: IRv2 = {
      ...minimalIR,
      steps: [
        { id: 's1', intent: '开', action: 'open', trace_ref: 'a1', value: { literal: 'https://example.com' } },
        {
          id: 's2', intent: '等 frame 文本', action: 'refresh', trace_ref: 'a2',
          frame: [{ selector: 'iframe#f' }],
          wait: [{ text: 'frame-only' }],
        },
      ],
    };
    makeCdpContext([mockPage], context, false);
    await runTest(ir, await runnerOptions(context));
    expect(mockPage.frameLocator).toHaveBeenCalledWith('iframe#f');
    expect(frameLoc.innerText).toHaveBeenCalled();
  });

  it('frame wait 之后主文档 checks 仍走主文档（不继承 frame）', async () => {
    const frameLoc = { waitFor: vi.fn(() => Promise.resolve()), innerText: vi.fn(() => Promise.resolve('frame-only')) };
    const scope: any = { getByText: vi.fn(() => frameLoc), locator: vi.fn(() => frameLoc) };
    const urlChecks: string[] = [];
    const mockPage: any = {
      goto: vi.fn(() => Promise.resolve()),
      reload: vi.fn(() => Promise.resolve()),
      url: vi.fn(() => { urlChecks.push('check-url'); return 'https://example.com/result'; }),
      on: vi.fn(), off: vi.fn(),
      setDefaultNavigationTimeout: vi.fn(), setDefaultTimeout: vi.fn(),
      frameLocator: vi.fn(() => scope),
      getByText: vi.fn(() => { throw new Error('main document cannot satisfy the declared frame condition'); }),
      locator: vi.fn(() => { throw new Error('main document cannot satisfy the declared frame condition'); }),
      waitForResponse: vi.fn(() => Promise.resolve({})),
      waitForURL: vi.fn(() => Promise.resolve()),
      waitForFunction: vi.fn(() => Promise.resolve()),
    };
    withCdp(mockPage);
    const context: any = { newPage: vi.fn(() => Promise.resolve(mockPage)) };
    const ir: IRv2 = {
      ...minimalIR,
      steps: [
        { id: 's1', intent: '开', action: 'open', trace_ref: 'a1', value: { literal: 'https://example.com' } },
        {
          id: 's2', intent: '等 frame 文本后主文档断言', action: 'refresh', trace_ref: 'a2',
          frame: [{ selector: 'iframe#f' }],
          wait: [{ text: 'frame-only' }],
          checks: [{ assert: { url: { contains: 'example.com/result' } } }],
        },
      ],
    };
    makeCdpContext([mockPage], context, false);
    await runTest(ir, await runnerOptions(context));
    // checks 用主文档 page.url()
    expect(urlChecks.length).toBeGreaterThan(0);
  });
});
