import { describe, it, expect, vi } from 'vitest';
import { executeWaits } from '../waits.js';
import type { Wait } from '../types.js';
import { RequestTracker } from '../request-tracker.js';
import { makeCdpPage } from './cdp-mock.js';

function makeChainable(): any {
  const proxy: any = vi.fn(() => proxy);
  proxy.waitFor = vi.fn(() => Promise.resolve());
  proxy.filter = vi.fn(() => proxy);
  proxy.or = vi.fn(() => proxy);
  proxy.innerText = vi.fn(() => Promise.resolve('加载完成'));
  return proxy;
}

function mockPage() {
  const page: any = {
    getByRole: vi.fn(() => makeChainable()),
    getByText: vi.fn(() => makeChainable()),
    getByTestId: vi.fn(() => makeChainable()),
    getByLabel: vi.fn(() => makeChainable()),
    locator: vi.fn(() => makeChainable()),
    waitForResponse: vi.fn(() => Promise.resolve({})),
    waitForURL: vi.fn(() => Promise.resolve()),
    waitForFunction: vi.fn(() => Promise.resolve()),
    isClosed: vi.fn(() => false),
  };
  return page;
}

describe('waits', () => {
  it('element visible', async () => {
    const page = mockPage();
    const waits: Wait[] = [{ element: { css: '.x' }, state: 'visible' as const }];
    await executeWaits(page, waits, new RequestTracker(), 5000);
    expect(page.locator).toHaveBeenCalledWith('.x');
  });

  it('element hidden', async () => {
    const page = mockPage();
    const waits: Wait[] = [{ element: { css: '.x' }, state: 'hidden' as const }];
    await executeWaits(page, waits, new RequestTracker(), 5000);
    expect(page.locator).toHaveBeenCalledWith('.x');
  });

  it('text wait', async () => {
    const page = mockPage();
    const waits: Wait[] = [{ text: '加载完成' }];
    await executeWaits(page, waits, new RequestTracker(), 5000);
    expect(page.locator).toHaveBeenCalledWith('body');
  });

  it('url wait', async () => {
    const page = mockPage();
    const waits: Wait[] = [{ url: { contains: '/dashboard' } }];
    await executeWaits(page, waits, new RequestTracker(), 5000);
    expect(page.waitForURL).toHaveBeenCalled();
  });

  it('dom_quiet', async () => {
    const page = mockPage();
    const waits: Wait[] = [{ dom_quiet: { ms: 500 } }];
    await executeWaits(page, waits, new RequestTracker(), 5000);
    expect(page.waitForFunction).toHaveBeenCalled();
  });

  it('empty waits does nothing', async () => {
    const page = mockPage();
    await executeWaits(page, [], new RequestTracker(), 5000);
    expect(page.waitForResponse).not.toHaveBeenCalled();
  });

  it('api wait when record exists', async () => {
    const page = mockPage();
    const reqTracker = new RequestTracker();
    (reqTracker as any).history = [{
      url: 'https://x.com/api/list',
      method: 'GET',
      path: '/api/list',
      nav: 'n1',
      call_index: 1,
      status: 200,
      body: '{}',
    }];
    const waits: Wait[] = [{ api: { path: '/api/list', nav: 1, call_index: 1 } }];
    await executeWaits(page, waits, reqTracker, 5000);
    expect(page.waitForResponse).not.toHaveBeenCalled();
  });

  // 反例：headers-only 早放行。唯一 CDPSession 事件流：responseReceived（headers）不算完成，
  // loadingFinished 后真实 getResponseBody 返回才算 body 完成。
  it('api wait must NOT release on headers-only; stays pending until body completes', async () => {
    let releaseBody!: (b: { body: string }) => void;
    const bodyPromise = new Promise<{ body: string }>((r) => { releaseBody = r; });
    const { page, emit } = makeCdpPage({
      'Network.getResponseBody': () => bodyPromise,
    });
    const tracker = new RequestTracker();
    await tracker.start(page.context(), await page.context().__nativeEndpoint());
    await tracker.attach(page);
    emit('Network.requestWillBeSent', { requestId: 'req-1', request: { url: 'https://x.com/api/list', method: 'GET' }, type: 'XHR' });
    // headers-only：responseReceived 到（status 200），loadingFinished 未到 → 未完成
    emit('Network.responseReceived', { requestId: 'req-1', response: { status: 200 } });
    const waits: Wait[] = [{ api: { path: '/api/list', nav: 0, call_index: 1 } }];
    const p = executeWaits(page, waits, tracker, 5000);
    // body 未释放 → wait 必须仍 pending（headers/status 不当完成）
    const early = await Promise.race([
      p.then(() => 'resolved-early' as const),
      new Promise<'pending'>((r) => setTimeout(() => r('pending'), 30)),
    ]);
    expect(early).toBe('pending');
    // loadingFinished 才发起 getResponseBody；释放真实 body → 必须真实 resolve（防“永不完成”mutant）
    emit('Network.loadingFinished', { requestId: 'req-1' });
    releaseBody({ body: JSON.stringify({ ok: true }) });
    await expect(p).resolves.toBeUndefined();
  });

  // api wait 按 (path,nav,call_index) 精确匹配目标请求：同 path 不同 nav 不误放行。
  // 走真实 tracker 事件路径：other(nav1) body 先完成也不释放 target(nav2) 的等待。
  it('api wait matches exact (path,nav,call_index) via tracker completion, not waitForResponse', async () => {
    const { page, emit } = makeCdpPage({
      'Network.getResponseBody': (p: any) => ({ body: JSON.stringify({ who: p.requestId === 'req-target' ? 'target' : 'other' }) }),
    }, { waitForResponse: vi.fn(() => new Promise(() => {})) });
    const tracker = new RequestTracker();
    await tracker.start(page.context(), await page.context().__nativeEndpoint());
    await tracker.attach(page);
    emit('Network.requestWillBeSent', { requestId: 'req-other', request: { url: 'https://x.com/api/list', method: 'GET' }, type: 'XHR' }); // n0 call1
    emit('Network.requestWillBeSent', { requestId: 'req-target', request: { url: 'https://x.com/api/list', method: 'GET' }, type: 'XHR' }); // n0 call2 (同 nav 第二个同 path 请求)
    // 让 other(call_index 1) 的 body 先完成
    emit('Network.responseReceived', { requestId: 'req-other', response: { status: 200 } });
    emit('Network.loadingFinished', { requestId: 'req-other' });
    await new Promise((r) => setTimeout(r, 5));
    // 等待 target(call_index 2)：other 完成不能释放它
    const waits: Wait[] = [{ api: { path: '/api/list', nav: 0, call_index: 2 } }];
    const p = executeWaits(page, waits, tracker, 5000);
    const early = await Promise.race([p.then(() => 'resolved' as const), new Promise<'pending'>((r) => setTimeout(() => r('pending'), 20))]);
    expect(early).toBe('pending');
    expect(page.waitForResponse).not.toHaveBeenCalled();
    // 释放 target body
    emit('Network.responseReceived', { requestId: 'req-target', response: { status: 200 } });
    emit('Network.loadingFinished', { requestId: 'req-target' });
    await expect(p).resolves.toBeUndefined();
  });

  // ── P3 回放事实 2.3：waits 消费 action frame，主文档不能假满足 frame 声明 ──

  /** fake 反映真实 FrameLocator owner/handle/Frame API：owner().elementHandle() → handle.contentFrame() → frame.waitForURL()，handle.dispose() 释放 */
  function makeFrameWorld(opts: { ownerRejects?: boolean; ownerHandleNull?: boolean; contentFrameNull?: boolean } = {}) {
    const calls: string[] = [];
    const frameLoc: Record<string, unknown> = { waitFor: vi.fn((o: any) => { calls.push(String(o.state)); return Promise.resolve(); }), innerText: vi.fn(() => Promise.resolve('frame-only')) };
    const frame = { waitForURL: vi.fn(() => { calls.push('frame-url'); return Promise.resolve(); }) };
    const handle = {
      contentFrame: vi.fn(() => Promise.resolve(opts.contentFrameNull ? null : frame)),
      dispose: vi.fn(() => { calls.push('disposed'); return Promise.resolve(); }),
    };
    const scope: any = {
      getByText: vi.fn(() => frameLoc),
      locator: vi.fn(() => frameLoc),
      owner: vi.fn(() => ({
        elementHandle: vi.fn(() => opts.ownerRejects ? Promise.reject(new Error('owner 解析拒绝')) : Promise.resolve(opts.ownerHandleNull ? null : handle)),
      })),
    };
    const page: any = {
      frameLocator: vi.fn(() => scope),
      getByText: vi.fn(() => { throw new Error('main document cannot satisfy the declared frame condition'); }),
      locator: vi.fn(() => { throw new Error('main document cannot satisfy the declared frame condition'); }),
      waitForURL: vi.fn(() => { throw new Error('main URL is not the declared frame URL'); }),
    };
    return { page, calls, frame, handle, scope, frameLoc };
  }

  it('frame 声明的 text wait 走 frame 作用域，主文档不能满足', async () => {
    const { page, frameLoc } = makeFrameWorld();
    const waits: Wait[] = [{ text: 'frame-only' }];
    await executeWaits(page, waits, new RequestTracker(), 1000, [{ selector: 'iframe#f' }]);
    expect(page.frameLocator).toHaveBeenCalledWith('iframe#f');
  });

  it('frame 声明的 element wait 走 frame 作用域，主文档不能满足', async () => {
    const { page, frameLoc } = makeFrameWorld();
    const waits: Wait[] = [{ element: { css: '#frame-input' }, state: 'visible' as const }];
    await executeWaits(page, waits, new RequestTracker(), 1000, [{ selector: 'iframe#f' }]);
    expect(frameLoc.waitFor).toHaveBeenCalledWith({ state: 'visible', timeout: 1000 });
  });

  it('frame 声明的 url wait：owner→contentFrame→frame.waitForURL，不回退主 Page，handle 用完释放', async () => {
    const { page, calls, frame, handle } = makeFrameWorld();
    const waits: Wait[] = [{ url: { contains: '/frame-url' } }];
    await executeWaits(page, waits, new RequestTracker(), 1000, [{ selector: 'iframe#f' }]);
    expect(frame.waitForURL).toHaveBeenCalled();
    expect(handle.contentFrame).toHaveBeenCalled();
    expect(handle.dispose).toHaveBeenCalled();
    // dispose 在 waitForURL 之后（finally 释放本次 handle）
    expect(calls.indexOf('frame-url')).toBeLessThan(calls.indexOf('disposed'));
  });

  it('无 frame 声明的 url wait 仍走主 Page（page.waitForURL）', async () => {
    const page = mockPage();
    const waits: Wait[] = [{ url: { contains: '/dashboard' } }];
    await executeWaits(page, waits, new RequestTracker(), 5000);
    expect(page.waitForURL).toHaveBeenCalled();
  });

  it('owner elementHandle 返回 null → 失败，不回退主 Page', async () => {
    const { page } = makeFrameWorld({ ownerHandleNull: true });
    const waits: Wait[] = [{ url: { contains: '/frame-url' } }];
    await expect(executeWaits(page, waits, new RequestTracker(), 1000, [{ selector: 'iframe#f' }])).rejects.toThrow();
    expect(page.waitForURL).not.toHaveBeenCalled();
  });

  it('owner 解析拒绝 → 失败，不回退主 Page', async () => {
    const { page } = makeFrameWorld({ ownerRejects: true });
    const waits: Wait[] = [{ url: { contains: '/frame-url' } }];
    await expect(executeWaits(page, waits, new RequestTracker(), 1000, [{ selector: 'iframe#f' }])).rejects.toThrow('owner 解析拒绝');
    expect(page.waitForURL).not.toHaveBeenCalled();
  });

  it('contentFrame 返回 null → 失败且 handle 释放', async () => {
    const { page, handle } = makeFrameWorld({ contentFrameNull: true });
    const waits: Wait[] = [{ url: { contains: '/frame-url' } }];
    await expect(executeWaits(page, waits, new RequestTracker(), 1000, [{ selector: 'iframe#f' }])).rejects.toThrow();
    expect(handle.dispose).toHaveBeenCalled();
  });

  it('frame url wait 预算耗尽（0）→ 拒绝，不把 0 传给 Playwright，也不碰 owner', async () => {
    const zero = makeFrameWorld();
    const waits: Wait[] = [{ url: { contains: '/frame-url' } }];
    await expect(executeWaits(zero.page, waits, new RequestTracker(), 0, [{ selector: 'iframe#f' }])).rejects.toThrow('预算耗尽');
    expect(zero.scope.owner).not.toHaveBeenCalled();
  });

  it('owner 解析刚好耗尽 → 不再调用 contentFrame，失败且 handle 释放', async () => {
    const { page, handle } = makeFrameWorld();
    // elementHandle 耗尽剩余预算（resolve 晚于 deadline）
    page.frameLocator = vi.fn(() => ({
      owner: vi.fn(() => ({ elementHandle: vi.fn(() => new Promise((r) => setTimeout(() => r(handle), 60)) ) })),
    }));
    const waits: Wait[] = [{ url: { contains: '/frame-url' } }];
    await expect(executeWaits(page, waits, new RequestTracker(), 30, [{ selector: 'iframe#f' }])).rejects.toThrow('预算耗尽');
    expect(handle.contentFrame).not.toHaveBeenCalled();
    expect(handle.dispose).toHaveBeenCalled();
  });

  it('frame url wait 解析耗时扣预算：waitForURL 收到的 timeout 严格小于初始预算', async () => {
    const { page, frame } = makeFrameWorld();
    const waits: Wait[] = [{ url: { contains: '/frame-url' } }];
    await executeWaits(page, waits, new RequestTracker(), 1000, [{ selector: 'iframe#f' }]);
    const t = (frame.waitForURL as any).mock.calls[0][1].timeout;
    expect(t).toBeLessThanOrEqual(1000);
    expect(t).toBeGreaterThan(0);
  });

  it('空 frame 描述（{}）不能在主文档满足 text/element wait（不静默落回主 Page）', async () => {
    const frameLoc = { waitFor: vi.fn(() => Promise.resolve()) };
    const page: any = {
      getByText: vi.fn(() => frameLoc),  // 主文档能正常满足 —— 但声明了 frame 就不许用
      locator: vi.fn(() => frameLoc),
      waitForURL: vi.fn(() => Promise.resolve()),
    };
    await expect(executeWaits(page, [{ text: 'x' }], new RequestTracker(), 1000, [{}])).rejects.toThrow(/frame/);
    await expect(executeWaits(page, [{ element: { css: '.x' }, state: 'visible' as const }], new RequestTracker(), 1000, [{}])).rejects.toThrow(/frame/);
  });
});
