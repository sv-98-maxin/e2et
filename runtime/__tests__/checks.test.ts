import { describe, it, expect, vi } from 'vitest';
import { executeChecks } from '../checks.js';
import type { Check } from '../types.js';
import { createValueContext } from '../value.js';
import { RequestTracker } from '../request-tracker.js';
import { makeCdpPage } from './cdp-mock.js';

function mockLocatorProxy(inner: Record<string, any> = {}) {
  const proxy: any = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then') return undefined;
      return inner[prop as string] ?? vi.fn(() => proxy);
    },
    apply() { return proxy; },
  });
  return proxy;
}

function mockPage() {
  const calls: { method: string; args: any[] }[] = [];
  const record = (method: string) => (...args: any[]) => {
    calls.push({ method, args });
    return mockLocatorProxy();
  };
  const page: any = {
    getByRole: record('getByRole'),
    getByLabel: record('getByLabel'),
    getByText: record('getByText'),
    getByTestId: record('getByTestId'),
    locator: record('locator'),
    url: vi.fn(() => 'https://example.com/dashboard'),
    waitForTimeout: vi.fn(() => Promise.resolve()),
    on: vi.fn(),
    off: vi.fn(),
    isClosed: vi.fn(() => false),
  };
  return { page, calls };
}

/** 可控 ARIA 通知 fake：getByRole('alert'/'status') 返回 count/nth/innerText 可控 locator。
 *  readFails=true 时 innerText 抛错（模拟 detached 元素读取失败）。 */
function ariaPage(messages: string[], readFails = false) {
  const loc: any = {
    count: async () => messages.length,
    nth: (i: number) => ({ innerText: async () => {
      if (readFails) throw new Error('element detached');
      return messages[i] ?? '';
    } }),
    or: () => loc,
  };
  const page: any = {
    getByRole: vi.fn(() => loc),
    // 无组件库 class 的页面：locator('.next-message, .next-toast') 找不到可读文本
    locator: vi.fn(() => ({ innerText: async () => { throw new Error('no .next-message element'); } })),
    url: vi.fn(() => 'https://example.com/dashboard'),
    waitForTimeout: vi.fn(() => Promise.resolve()),
  };
  return page;
}

describe('assert.toast（标准 ARIA alert/status）', () => {
  it('无组件库 class 的 role=alert 通知能命中（不再认 .next-message/.next-toast）', async () => {
    const page = ariaPage(['', '提交成功']);
    const checks: Check[] = [{ assert: { toast: '提交成功' } }];
    await executeChecks(page, checks, createValueContext(), new RequestTracker(), 1000);
    expect(page.getByRole).toHaveBeenCalledWith('alert');
    expect(page.getByRole).toHaveBeenCalledWith('status');
  });

  it('role=status 通知能命中', async () => {
    const page = ariaPage(['已保存']);
    const checks: Check[] = [{ assert: { toast: '已保存' } }];
    await executeChecks(page, checks, createValueContext(), new RequestTracker(), 1000);
  });

  it('多个通知分别读取，命中任意一个即通过（避免 innerText strict-multiple）', async () => {
    const page = ariaPage(['第一条通知', '包含目标的第二条通知', '第三条']);
    const checks: Check[] = [{ assert: { toast: '目标' } }];
    await executeChecks(page, checks, createValueContext(), new RequestTracker(), 1000);
  });

  it('无 ARIA 通知 → poll 超时抛错', async () => {
    vi.useFakeTimers();
    try {
      const page = ariaPage([]);
      const checks: Check[] = [{ assert: { toast: '不存在' } }];
      const outcome = executeChecks(page, checks, createValueContext(), new RequestTracker(), 5000)
        .then(() => null, (e: Error) => e);
      await vi.advanceTimersByTimeAsync(5200);
      const error = await outcome;
      expect(error).toBeInstanceOf(Error);
    } finally {
      vi.useRealTimers();
    }
  });

  it('innerText 读取抛错 → 仍失败（读失败不是空文本，空期望也不能伪造 pass）', async () => {
    vi.useFakeTimers();
    try {
      // 有通知但读取失败；空串期望下 ''.includes('') 若把读异常当空文本会伪造 pass
      const page = ariaPage(['x'], true);
      const checks: Check[] = [{ assert: { toast: '' } }];
      const outcome = executeChecks(page, checks, createValueContext(), new RequestTracker(), 5000)
        .then(() => null, (e: Error) => e);
      await vi.advanceTimersByTimeAsync(5200);
      const error = await outcome;
      expect(error).toBeInstanceOf(Error);
      // 真实读取错误在超时后作为 lastErr 抛出，不是 'poll timeout' 兜底
      expect((error as Error).message).toContain('element detached');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('checks', () => {
  it('assert.url pass', async () => {
    const { page } = mockPage();
    const checks: Check[] = [{ assert: { url: { contains: '/dashboard' } } }];
    await executeChecks(page, checks, createValueContext(), new RequestTracker(), 5000);
    // no throw = pass
  });

  it('assert.url fail', async () => {
    const { page } = mockPage();
    const checks: Check[] = [{ assert: { url: { contains: '/nope' } } }];
    await expect(executeChecks(page, checks, createValueContext(), new RequestTracker(), 5000)).rejects.toThrow('assert.url');
  });

  it('assert.api pass with existing record', async () => {
    const { page } = mockPage();
    const reqTracker = new RequestTracker();
    (reqTracker as any).history = [{
      url: 'https://x.com/api/item',
      method: 'GET',
      path: '/api/item',
      nav: 'n1',
      call_index: 1,
      status: 200,
      body: JSON.stringify({ code: 200, data: { name: '苹果' } }),
    }];
    const checks: Check[] = [{
      assert: {
        api: { path: '/api/item', nav: 1, call_index: 1 },
        expect: [{ path: 'code', op: 'eq', value: 200 }],
      },
    }];
    await executeChecks(page, checks, createValueContext(), reqTracker, 5000);
  });

  // 反例：assert.api 早读 {}。旧实现在同步读 rec.body，undefined → {} 回退 → eq 报错。
  // 唯一 CDPSession 事件流：responseReceived（headers）不算完成，loadingFinished 后真实 getResponseBody 返回才算。
  it('assert.api waits for body completion before checking (no early-read {} fallback)', async () => {
    let releaseBody!: (b: { body: string }) => void;
    const bodyPromise = new Promise<{ body: string }>((r) => { releaseBody = r; });
    const { page, emit } = makeCdpPage({
      'Network.getResponseBody': () => bodyPromise,
    });
    const tracker = new RequestTracker();
    await tracker.start(page.context(), await page.context().__nativeEndpoint());
    await tracker.attach(page);
    emit('Network.requestWillBeSent', { requestId: 'req-1', request: { url: 'https://x.com/api/item', method: 'GET' }, type: 'XHR' });
    emit('Network.responseReceived', { requestId: 'req-1', response: { status: 200 } });
    const checks: Check[] = [{
      assert: {
        api: { path: '/api/item', nav: 0, call_index: 1 },
        expect: [{ path: 'code', op: 'eq', value: 200 }],
      },
    }];
    // 未释放 body → assert.api 必须 pending（跳过检查的 no-op mutant 不能绿）
    const p = executeChecks(page, checks, createValueContext(), tracker, 5000);
    const early = await Promise.race([p.then(() => 'resolved' as const), new Promise<'pending'>((r) => setTimeout(() => r('pending'), 20))]);
    expect(early).toBe('pending');
    // loadingFinished 才发起 getResponseBody；释放合法 body → 真实 resolve（不 catch/不 race 超时当成功）
    emit('Network.loadingFinished', { requestId: 'req-1' });
    releaseBody({ body: JSON.stringify({ code: 200 }) });
    await expect(p).resolves.toBeUndefined();
  });

  // 反例：capture.from_api 早读 {}。旧实现同步读 rec.body，undefined → {} → extractPath undefined → 报 'path 不存在'。
  it('capture.from_api waits for body completion before extracting (no early-read {} fallback)', async () => {
    const { page, emit } = makeCdpPage({
      'Network.getResponseBody': () => new Promise<{ body: string }>((r) => setTimeout(() => r({ body: JSON.stringify({ data: { id: '12345' } }) }), 60)),
    });
    const tracker = new RequestTracker();
    await tracker.start(page.context(), await page.context().__nativeEndpoint());
    await tracker.attach(page);
    emit('Network.requestWillBeSent', { requestId: 'req-1', request: { url: 'https://x.com/api/item', method: 'GET' }, type: 'XHR' });
    emit('Network.responseReceived', { requestId: 'req-1', response: { status: 200 } });
    emit('Network.loadingFinished', { requestId: 'req-1' });
    const vctx = createValueContext();
    const checks: Check[] = [{
      capture: {
        from_api: { path: '/api/item', nav: 0, call_index: 1 },
        path: 'data.id',
        as: 'itemId',
        lineage: 'queried',
      },
    }];
    await executeChecks(page, checks, vctx, tracker, 5000);
    expect(vctx.resolve({ ref: 'itemId' })).toBe('12345');
  });

  it('assert.api fail on mismatched value', async () => {
    const { page } = mockPage();
    const reqTracker = new RequestTracker();
    (reqTracker as any).history = [{
      url: 'https://x.com/api/item',
      method: 'GET',
      path: '/api/item',
      nav: 'n1',
      call_index: 1,
      status: 200,
      body: JSON.stringify({ code: 500 }),
    }];
    const checks: Check[] = [{
      assert: {
        api: { path: '/api/item', nav: 1, call_index: 1 },
        expect: [{ path: 'code', op: 'eq', value: 200 }],
      },
    }];
    await expect(executeChecks(page, checks, createValueContext(), reqTracker, 5000)).rejects.toThrow('eq');
  });

  it('assert.api missing record waits for future request then times out（不立即拒）', async () => {
    const { page } = mockPage();
    const checks: Check[] = [{
      assert: {
        api: { path: '/missing', nav: 1, call_index: 1 },
        expect: [{ path: 'code', op: 'eq', value: 200 }],
      },
    }];
    await expect(executeChecks(page, checks, createValueContext(), new RequestTracker(), 30)).rejects.toThrow('超时');
  });

  it('capture.from_api stores value in vctx', async () => {
    const { page } = mockPage();
    const reqTracker = new RequestTracker();
    (reqTracker as any).history = [{
      url: 'https://x.com/api/item',
      method: 'GET',
      path: '/api/item',
      nav: 'n1',
      call_index: 1,
      status: 200,
      body: JSON.stringify({ data: { id: '12345' } }),
    }];
    const vctx = createValueContext();
    const checks: Check[] = [{
      capture: {
        from_api: { path: '/api/item', nav: 1, call_index: 1 },
        path: 'data.id',
        as: 'itemId',
        lineage: 'queried',
      },
    }];
    await executeChecks(page, checks, vctx, reqTracker, 5000);
    expect(vctx.resolve({ ref: 'itemId' })).toBe('12345');
  });

  it('assert.op contains', async () => {
    const { page } = mockPage();
    const reqTracker = new RequestTracker();
    (reqTracker as any).history = [{
      url: 'https://x.com/api/item',
      method: 'GET',
      path: '/api/item',
      nav: 'n1',
      call_index: 1,
      status: 200,
      body: JSON.stringify({ msg: '操作成功' }),
    }];
    const checks: Check[] = [{
      assert: {
        api: { path: '/api/item', nav: 1, call_index: 1 },
        expect: [{ path: 'msg', op: 'contains', value: '成功' }],
      },
    }];
    await executeChecks(page, checks, createValueContext(), reqTracker, 5000);
  });

  it('assert.op exists', async () => {
    const { page } = mockPage();
    const reqTracker = new RequestTracker();
    (reqTracker as any).history = [{
      url: 'https://x.com/api/item',
      method: 'GET',
      path: '/api/item',
      nav: 'n1',
      call_index: 1,
      status: 200,
      body: JSON.stringify({ data: { name: 'x' } }),
    }];
    const checks: Check[] = [{
      assert: {
        api: { path: '/api/item', nav: 1, call_index: 1 },
        expect: [{ path: 'data', op: 'exists', value: null }],
      },
    }];
    await executeChecks(page, checks, createValueContext(), reqTracker, 5000);
  });

  it('assert.op gt', async () => {
    const { page } = mockPage();
    const reqTracker = new RequestTracker();
    (reqTracker as any).history = [{
      url: 'https://x.com/api/item',
      method: 'GET',
      path: '/api/item',
      nav: 'n1',
      call_index: 1,
      status: 200,
      body: JSON.stringify({ count: 10 }),
    }];
    const checks: Check[] = [{
      assert: {
        api: { path: '/api/item', nav: 1, call_index: 1 },
        expect: [{ path: 'count', op: 'gt', value: 5 }],
      },
    }];
    await executeChecks(page, checks, createValueContext(), reqTracker, 5000);
  });

  it('assert.op lt', async () => {
    const { page } = mockPage();
    const reqTracker = new RequestTracker();
    (reqTracker as any).history = [{
      url: 'https://x.com/api/item',
      method: 'GET',
      path: '/api/item',
      nav: 'n1',
      call_index: 1,
      status: 200,
      body: JSON.stringify({ count: 3 }),
    }];
    const checks: Check[] = [{
      assert: {
        api: { path: '/api/item', nav: 1, call_index: 1 },
        expect: [{ path: 'count', op: 'lt', value: 5 }],
      },
    }];
    await executeChecks(page, checks, createValueContext(), reqTracker, 5000);
  });

  it('assert.op ne', async () => {
    const { page } = mockPage();
    const reqTracker = new RequestTracker();
    (reqTracker as any).history = [{
      url: 'https://x.com/api/item',
      method: 'GET',
      path: '/api/item',
      nav: 'n1',
      call_index: 1,
      status: 200,
      body: JSON.stringify({ code: 200 }),
    }];
    const checks: Check[] = [{
      assert: {
        api: { path: '/api/item', nav: 1, call_index: 1 },
        expect: [{ path: 'code', op: 'ne', value: 500 }],
      },
    }];
    await executeChecks(page, checks, createValueContext(), reqTracker, 5000);
  });

  it('capture.from_api throws when path not found', async () => {
    const { page } = mockPage();
    const reqTracker = new RequestTracker();
    (reqTracker as any).history = [{
      url: 'https://x.com/api/item',
      method: 'GET',
      path: '/api/item',
      nav: 'n1',
      call_index: 1,
      status: 200,
      body: JSON.stringify({ data: {} }),
    }];
    const checks: Check[] = [{
      capture: {
        from_api: { path: '/api/item', nav: 1, call_index: 1 },
        path: 'data.missing',
        as: 'x',
        lineage: 'queried',
      },
    }];
    await expect(executeChecks(page, checks, createValueContext(), reqTracker, 5000)).rejects.toThrow('path');
  });

  it('assert.text within uses locator.innerText', async () => {
    const { page } = mockPage();
    const innerText = vi.fn(async () => '操作成功');
    // resolveLocatorWithFallback 走 page.locator → 返回带 innerText 的 proxy
    const locProxy: any = { innerText, waitFor: vi.fn(() => Promise.resolve()) };
    page.locator = vi.fn(() => locProxy) as any;
    page.getByRole = vi.fn(() => locProxy) as any;
    page.getByText = vi.fn(() => locProxy) as any;
    const checks: Check[] = [{
      assert: { text: { within: { css: '.toast' }, contains: '成功' } },
    }];
    await executeChecks(page, checks, createValueContext(), new RequestTracker(), 5000);
    expect(innerText).toHaveBeenCalled();
    expect(page.getByText).not.toHaveBeenCalled();
  });

  it('assert.text without within uses page.getByText().innerText', async () => {
    const { page, calls } = mockPage();
    const innerText = vi.fn(async () => '操作成功');
    page.locator = vi.fn(() => ({ innerText })) as any;
    const checks: Check[] = [{
      assert: { text: { contains: '成功' } },
    }];
    await executeChecks(page, checks, createValueContext(), new RequestTracker(), 5000);
    expect(page.locator).toHaveBeenCalledWith('body');
    expect(innerText).toHaveBeenCalled();
  });

  it.each([
    ['literal', { contains: '成功' }, (_ctx: ReturnType<typeof createValueContext>) => {}],
    ['ref', { contains: '旧值', value: { ref: 'expected' } }, (ctx: ReturnType<typeof createValueContext>) => ctx.set('expected', '成功')],
    ['from_action', { contains: '旧值', value: { from_action: 's1' } }, (ctx: ReturnType<typeof createValueContext>) => ctx.setActionValue('s1', '成功')],
  ])('assert.text %s 只解析一次并固定使用结果', async (_name, text, seed) => {
    const { page } = mockPage();
    const contents = ['操作成功', '操作旧值', '操作成功'];
    const innerText = vi.fn(async () => contents.shift() ?? '操作成功');
    page.locator = vi.fn(() => ({ innerText })) as any;
    const vctx = createValueContext();
    seed(vctx);
    const resolve = vi.spyOn(vctx, 'resolve');
    await executeChecks(page, [{ assert: { text } }], vctx, new RequestTracker(), 5000);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it.each(['', '   '])('assert.text 动态值 %j 在轮询前 fail closed', async (blank) => {
    const { page } = mockPage();
    const innerText = vi.fn(async () => '任意页面文本');
    page.locator = vi.fn(() => ({ innerText })) as any;
    const vctx = createValueContext();
    vctx.set('blank', blank);
    const checks: Check[] = [{ assert: { text: { contains: '任意', value: { ref: 'blank' } } } }];
    await expect(executeChecks(page, checks, vctx, new RequestTracker(), 5000))
      .rejects.toThrow('assert.text: 期望值为空或纯空白');
    expect(innerText).not.toHaveBeenCalled();
  });

  it('assert.api missing/null-intermediate 字段在 ne 也不能假通过', async () => {
    const { page } = mockPage();
    const reqTracker = new RequestTracker();
    (reqTracker as any).history = [{
      url: 'https://x.com/api/item', method: 'GET', path: '/api/item', nav: 'n0', call_index: 1,
      status: 200, body: JSON.stringify({ data: null }),
    }];
    const checks: Check[] = [{
      assert: {
        api: { path: '/api/item', nav: 0, call_index: 1 },
        expect: [{ path: 'data.id', op: 'ne', value: 1 }],
      },
    }];
    await expect(executeChecks(page, checks, createValueContext(), reqTracker, 5000)).rejects.toThrow('data.id');
  });

  it('pollUntil: truthy 在 deadline 后到达不放行（late-truthy rejection）', async () => {
    const { page } = mockPage();
    // innerText 50ms 后才返回含 "成功" 的文本，但 timeout=20 → 过期 truthy 不放行
    page.locator = vi.fn(() => ({ innerText: () => new Promise<string>((r) => setTimeout(() => r('操作成功'), 50)) })) as any;
    const checks: Check[] = [{ assert: { text: { contains: '成功' } } }];
    await expect(executeChecks(page, checks, createValueContext(), new RequestTracker(), 20)).rejects.toThrow('poll timeout');
  });

  it('checks 共享同一绝对 deadline：后续 native check 收到剩余预算而非全量', async () => {
    const { page } = mockPage();
    // 第一个 check：文本 40ms 后出现（timeout=100 内成功，耗 40ms）
    // 第二个 check：visible 的 waitFor 收到剩余预算（≈60），不是全量 100
    const waitForSpy = vi.fn<(options?: { timeout?: number }) => Promise<void>>(() => Promise.resolve());
    const visProxy: any = { waitFor: waitForSpy };
    page.locator = vi.fn((sel: string) =>
      sel === 'body' ? { innerText: () => new Promise<string>((r) => setTimeout(() => r('操作成功'), 40)) } : visProxy
    ) as any;
    const checks: Check[] = [
      { assert: { text: { contains: '成功' } } },
      { assert: { visible: { css: '.x' } } },
    ];
    await executeChecks(page, checks, createValueContext(), new RequestTracker(), 100);
    const receivedTimeout = (waitForSpy.mock.calls[0]?.[0] as { timeout?: number })?.timeout;
    expect(receivedTimeout).toBeDefined();
    expect(receivedTimeout!).toBeLessThan(100); // 剩余预算，非全量
    expect(receivedTimeout!).toBeGreaterThan(0); // 严格正，不到达 Playwright 零哨兵
  });
});

describe('assert.api / capture.from_api 根前缀 $ 路径（$ 是 root，不是字段名）', () => {
  function trackerWith(records: any[]) {
    const reqTracker = new RequestTracker();
    (reqTracker as any).history = records;
    return reqTracker;
  }

  it('assert.api $.success 命中已完成的 call_index=11 record（原 IR ref 不改也能通过）', async () => {
    const { page } = mockPage();
    const reqTracker = trackerWith([{
      url: 'https://x.com/common/canaryRelease.json',
      method: 'GET',
      path: '/common/canaryRelease.json',
      nav: 'n1',
      call_index: 11,
      status: 200,
      body: JSON.stringify({ success: true }),
    }]);
    const checks: Check[] = [{
      assert: {
        api: { path: '/common/canaryRelease.json', nav: 1, call_index: 11 },
        expect: [{ path: '$.success', op: 'eq', value: true }],
      },
    }];
    await executeChecks(page, checks, createValueContext(), reqTracker, 5000);
  });

  it('capture.from_api $.errorDesc 能取空串（空串是值不是缺失）', async () => {
    const { page } = mockPage();
    const reqTracker = trackerWith([{
      url: 'https://x.com/api/audit.json',
      method: 'GET',
      path: '/api/audit.json',
      nav: 'n1',
      call_index: 1,
      status: 200,
      body: JSON.stringify({ errorDesc: '' }),
    }]);
    const vctx = createValueContext();
    const checks: Check[] = [{
      capture: {
        from_api: { path: '/api/audit.json', nav: 1, call_index: 1 },
        path: '$.errorDesc',
        as: 'errDesc',
        lineage: 'queried',
      },
    }];
    await executeChecks(page, checks, vctx, reqTracker, 5000);
    expect(vctx.resolve({ ref: 'errDesc' })).toBe('');
  });

  it('assert.request $.nested.enabled 能取 false', async () => {
    const { page } = mockPage();
    const reqTracker = trackerWith([{
      url: 'https://x.com/api/save.json',
      method: 'POST',
      path: '/api/save.json',
      nav: 'n0',
      call_index: 1,
      status: 200,
      requestBody: JSON.stringify({ nested: { enabled: false } }),
    }]);
    const checks: Check[] = [{
      assert: {
        request: { path: '/api/save.json', nav: 0, call_index: 1 },
        body: [{ path: '$.nested.enabled', op: 'eq', value: false }],
      },
    }];
    await executeChecks(page, checks, createValueContext(), reqTracker, 5000);
  });

  it('capture.from_api 裸 $ 得到完整 JSON root（不再把 $ 当字段查）', async () => {
    const { page } = mockPage();
    const reqTracker = trackerWith([{
      url: 'https://x.com/api/root.json',
      method: 'GET',
      path: '/api/root.json',
      nav: 'n1',
      call_index: 1,
      status: 200,
      body: JSON.stringify([1, 2, 3]),
    }]);
    const vctx = createValueContext();
    const checks: Check[] = [{
      capture: {
        from_api: { path: '/api/root.json', nav: 1, call_index: 1 },
        path: '$',
        as: 'root',
        lineage: 'queried',
      },
    }];
    await executeChecks(page, checks, vctx, reqTracker, 5000);
    // 数组 root 整体 JSON.stringify 为 '[1,2,3]'：修复前 $ 被当字段查 → throw path 不存在
    expect(vctx.resolve({ ref: 'root' })).toBe('[1,2,3]');
  });

  it('assert.api 裸 $ + exists 对 root 成立', async () => {
    const { page } = mockPage();
    const reqTracker = trackerWith([{
      url: 'https://x.com/api/root.json',
      method: 'GET',
      path: '/api/root.json',
      nav: 'n1',
      call_index: 1,
      status: 200,
      body: JSON.stringify({ success: true }),
    }]);
    const checks: Check[] = [{
      assert: {
        api: { path: '/api/root.json', nav: 1, call_index: 1 },
        expect: [{ path: '$', op: 'exists', value: null }],
      },
    }];
    await executeChecks(page, checks, createValueContext(), reqTracker, 5000);
  });

  it('无前缀与普通 $abc 字段仍按原 dot 遍历成功（不盲删首个 $）', async () => {
    const { page } = mockPage();
    const reqTracker = trackerWith([{
      url: 'https://x.com/api/fields.json',
      method: 'GET',
      path: '/api/fields.json',
      nav: 'n1',
      call_index: 1,
      status: 200,
      body: JSON.stringify({ '$abc': 'ok', normal: 1, data: { id: 'x1' } }),
    }]);
    const vctx = createValueContext();
    const checks: Check[] = [
      {
        assert: {
          api: { path: '/api/fields.json', nav: 1, call_index: 1 },
          expect: [
            { path: '$abc', op: 'eq', value: 'ok' },
            { path: 'normal', op: 'eq', value: 1 },
          ],
        },
      },
      {
        capture: {
          from_api: { path: '/api/fields.json', nav: 1, call_index: 1 },
          path: 'data.id',
          as: 'id',
          lineage: 'queried',
        },
      },
    ];
    await executeChecks(page, checks, vctx, reqTracker, 5000);
    expect(vctx.resolve({ ref: 'id' })).toBe('x1');
  });

  it('$.missing 在 ne 也不能假通过（剥前缀不等于把缺失变存在）', async () => {
    const { page } = mockPage();
    const reqTracker = trackerWith([{
      url: 'https://x.com/api/x.json',
      method: 'GET',
      path: '/api/x.json',
      nav: 'n1',
      call_index: 1,
      status: 200,
      body: JSON.stringify({ success: true }),
    }]);
    const checks: Check[] = [{
      assert: {
        api: { path: '/api/x.json', nav: 1, call_index: 1 },
        expect: [{ path: '$.missing', op: 'ne', value: 1 }],
      },
    }];
    await expect(executeChecks(page, checks, createValueContext(), reqTracker, 5000)).rejects.toThrow('$.missing');
  });

  it('$.nullIntermediate.x 中间 null 仍判缺失', async () => {
    const { page } = mockPage();
    const reqTracker = trackerWith([{
      url: 'https://x.com/api/n.json',
      method: 'GET',
      path: '/api/n.json',
      nav: 'n1',
      call_index: 1,
      status: 200,
      body: JSON.stringify({ data: null }),
    }]);
    const checks: Check[] = [{
      assert: {
        api: { path: '/api/n.json', nav: 1, call_index: 1 },
        expect: [{ path: '$.data.id', op: 'ne', value: 1 }],
      },
    }];
    await expect(executeChecks(page, checks, createValueContext(), reqTracker, 5000)).rejects.toThrow('$.data.id');
  });

  it('capture.from_api $.missing 仍失败（不能伪绿）', async () => {
    const { page } = mockPage();
    const reqTracker = trackerWith([{
      url: 'https://x.com/api/m.json',
      method: 'GET',
      path: '/api/m.json',
      nav: 'n1',
      call_index: 1,
      status: 200,
      body: JSON.stringify({ data: {} }),
    }]);
    const checks: Check[] = [{
      capture: {
        from_api: { path: '/api/m.json', nav: 1, call_index: 1 },
        path: '$.data.missing',
        as: 'x',
        lineage: 'queried',
      },
    }];
    await expect(executeChecks(page, checks, createValueContext(), reqTracker, 5000)).rejects.toThrow('path');
  });

  it('falsy 值 0/false 语义不变（eq 不受 $ 前缀影响）', async () => {
    const { page } = mockPage();
    const reqTracker = trackerWith([{
      url: 'https://x.com/api/f.json',
      method: 'GET',
      path: '/api/f.json',
      nav: 'n1',
      call_index: 1,
      status: 200,
      body: JSON.stringify({ count: 0, flag: false }),
    }]);
    const checks: Check[] = [{
      assert: {
        api: { path: '/api/f.json', nav: 1, call_index: 1 },
        expect: [
          { path: '$.count', op: 'eq', value: 0 },
          { path: '$.flag', op: 'eq', value: false },
        ],
      },
    }];
    await executeChecks(page, checks, createValueContext(), reqTracker, 5000);
  });
});

describe('compare 合同：missing/null/值边界', () => {
  function trackerWith(records: any[]) {
    const reqTracker = new RequestTracker();
    (reqTracker as any).history = records;
    return reqTracker;
  }

  it('null root 裸 $ eq null 通过（null 是已存在的值）', async () => {
    const { page } = mockPage();
    const reqTracker = trackerWith([{
      url: 'https://x.com/api/n.json', method: 'GET', path: '/api/n.json', nav: 'n0', call_index: 1,
      status: 200, body: 'null',
    }]);
    const checks: Check[] = [{
      assert: { api: { path: '/api/n.json', nav: 0, call_index: 1 }, expect: [{ path: '$', op: 'eq', value: null }] },
    }];
    await executeChecks(page, checks, createValueContext(), reqTracker, 5000);
  });

  it('null root 裸 $ exists 不通过（null 不算 exists）', async () => {
    const { page } = mockPage();
    const reqTracker = trackerWith([{
      url: 'https://x.com/api/n.json', method: 'GET', path: '/api/n.json', nav: 'n0', call_index: 1,
      status: 200, body: 'null',
    }]);
    const checks: Check[] = [{
      assert: { api: { path: '/api/n.json', nav: 0, call_index: 1 }, expect: [{ path: '$', op: 'exists', value: null }] },
    }];
    await expect(executeChecks(page, checks, createValueContext(), reqTracker, 5000)).rejects.toThrow('exists');
  });

  it('null 叶子 eq null 通过', async () => {
    const { page } = mockPage();
    const reqTracker = trackerWith([{
      url: 'https://x.com/api/n.json', method: 'GET', path: '/api/n.json', nav: 'n0', call_index: 1,
      status: 200, body: JSON.stringify({ data: null }),
    }]);
    const checks: Check[] = [{
      assert: { api: { path: '/api/n.json', nav: 0, call_index: 1 }, expect: [{ path: 'data', op: 'eq', value: null }] },
    }];
    await executeChecks(page, checks, createValueContext(), reqTracker, 5000);
  });

  it('null 叶子 ne 非null 通过', async () => {
    const { page } = mockPage();
    const reqTracker = trackerWith([{
      url: 'https://x.com/api/n.json', method: 'GET', path: '/api/n.json', nav: 'n0', call_index: 1,
      status: 200, body: JSON.stringify({ data: null }),
    }]);
    const checks: Check[] = [{
      assert: { api: { path: '/api/n.json', nav: 0, call_index: 1 }, expect: [{ path: 'data', op: 'ne', value: 'x' }] },
    }];
    await executeChecks(page, checks, createValueContext(), reqTracker, 5000);
  });

  it('数字字符串 eq 数字 通过（1 == "1"）', async () => {
    const { page } = mockPage();
    const reqTracker = trackerWith([{
      url: 'https://x.com/api/n.json', method: 'GET', path: '/api/n.json', nav: 'n0', call_index: 1,
      status: 200, body: JSON.stringify({ code: 200 }),
    }]);
    const checks: Check[] = [{
      assert: { api: { path: '/api/n.json', nav: 0, call_index: 1 }, expect: [{ path: 'code', op: 'eq', value: '200' }] },
    }];
    await executeChecks(page, checks, createValueContext(), reqTracker, 5000);
  });

  it('deep JSON eq 通过（对象按 JSON.stringify 比较）', async () => {
    const { page } = mockPage();
    const reqTracker = trackerWith([{
      url: 'https://x.com/api/n.json', method: 'GET', path: '/api/n.json', nav: 'n0', call_index: 1,
      status: 200, body: JSON.stringify({ data: { a: 1, b: [2, 3] } }),
    }]);
    const checks: Check[] = [{
      assert: { api: { path: '/api/n.json', nav: 0, call_index: 1 }, expect: [{ path: 'data', op: 'eq', value: { a: 1, b: [2, 3] } }] },
    }];
    await executeChecks(page, checks, createValueContext(), reqTracker, 5000);
  });

  it('array contains 命中', async () => {
    const { page } = mockPage();
    const reqTracker = trackerWith([{
      url: 'https://x.com/api/n.json', method: 'GET', path: '/api/n.json', nav: 'n0', call_index: 1,
      status: 200, body: JSON.stringify({ tags: ['a', 'b', 'c'] }),
    }]);
    const checks: Check[] = [{
      assert: { api: { path: '/api/n.json', nav: 0, call_index: 1 }, expect: [{ path: 'tags', op: 'contains', value: 'b' }] },
    }];
    await executeChecks(page, checks, createValueContext(), reqTracker, 5000);
  });

  it('gt/lt 数字字符串转换', async () => {
    const { page } = mockPage();
    const reqTracker = trackerWith([{
      url: 'https://x.com/api/n.json', method: 'GET', path: '/api/n.json', nav: 'n0', call_index: 1,
      status: 200, body: JSON.stringify({ count: '10' }),
    }]);
    const checks: Check[] = [{
      assert: {
        api: { path: '/api/n.json', nav: 0, call_index: 1 },
        expect: [
          { path: 'count', op: 'gt', value: 5 },
          { path: 'count', op: 'lt', value: 20 },
        ],
      },
    }];
    await executeChecks(page, checks, createValueContext(), reqTracker, 5000);
  });

  it('捕获 null 拒绝', async () => {
    const { page } = mockPage();
    const reqTracker = trackerWith([{
      url: 'https://x.com/api/n.json', method: 'GET', path: '/api/n.json', nav: 'n0', call_index: 1,
      status: 200, body: JSON.stringify({ data: null }),
    }]);
    const checks: Check[] = [{
      capture: { from_api: { path: '/api/n.json', nav: 0, call_index: 1 }, path: 'data', as: 'nul', lineage: 'queried' },
    }];
    await expect(executeChecks(page, checks, createValueContext(), reqTracker, 5000)).rejects.toThrow('null');
  });

  it('捕获 object → JSON 序列化存储', async () => {
    const { page } = mockPage();
    const reqTracker = trackerWith([{
      url: 'https://x.com/api/n.json', method: 'GET', path: '/api/n.json', nav: 'n0', call_index: 1,
      status: 200, body: JSON.stringify({ data: { id: 1, name: 'x' } }),
    }]);
    const vctx = createValueContext();
    const checks: Check[] = [{
      capture: { from_api: { path: '/api/n.json', nav: 0, call_index: 1 }, path: 'data', as: 'obj', lineage: 'queried' },
    }];
    await executeChecks(page, checks, vctx, reqTracker, 5000);
    expect(vctx.resolve({ ref: 'obj' })).toBe('{"id":1,"name":"x"}');
  });

  it('捕获 数组 → JSON 序列化存储', async () => {
    const { page } = mockPage();
    const reqTracker = trackerWith([{
      url: 'https://x.com/api/n.json', method: 'GET', path: '/api/n.json', nav: 'n0', call_index: 1,
      status: 200, body: JSON.stringify({ items: [1, 2, 3] }),
    }]);
    const vctx = createValueContext();
    const checks: Check[] = [{
      capture: { from_api: { path: '/api/n.json', nav: 0, call_index: 1 }, path: 'items', as: 'arr', lineage: 'queried' },
    }];
    await executeChecks(page, checks, vctx, reqTracker, 5000);
    expect(vctx.resolve({ ref: 'arr' })).toBe('[1,2,3]');
  });

  it('assert.request 缺 body 拒（不补 {}）', async () => {
    const { page } = mockPage();
    const reqTracker = trackerWith([{
      url: 'https://x.com/api/save.json', method: 'POST', path: '/api/save.json',
      nav: 'n0', call_index: 1, status: 200, requestBody: undefined as any,
    }]);
    const checks: Check[] = [{
      assert: { request: { path: '/api/save.json', nav: 0, call_index: 1 }, body: [{ path: 'x', op: 'eq', value: 1 }] },
    }];
    await expect(executeChecks(page, checks, createValueContext(), reqTracker, 5000)).rejects.toThrow('请求体缺失');
  });

  it('assert.request 非 JSON body 拒', async () => {
    const { page } = mockPage();
    const reqTracker = trackerWith([{
      url: 'https://x.com/api/save.json', method: 'POST', path: '/api/save.json',
      nav: 'n0', call_index: 1, status: 200, requestBody: 'not-json',
    }]);
    const checks: Check[] = [{
      assert: { request: { path: '/api/save.json', nav: 0, call_index: 1 }, body: [{ path: 'x', op: 'eq', value: 1 }] },
    }];
    await expect(executeChecks(page, checks, createValueContext(), reqTracker, 5000)).rejects.toThrow('非合法 JSON');
  });
});
