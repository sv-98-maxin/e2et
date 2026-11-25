import { describe, it, expect, vi } from 'vitest';
import { RequestTracker } from '../request-tracker.js';
import { executeWaits } from '../waits.js';
import { executeChecks } from '../checks.js';
import { createValueContext } from '../value.js';
import { makeCdpPage } from './cdp-mock.js';

/**
 * 反例：response 归因错误。同 path 同 nav 连发 A(1)、B(2)，A 响应先到。
 * 正确：按 requestId 精确反查（responseReceived 只设本 hop）→ A 的 body 归 A。
 * 机械迁移：唯一公开 CDPSession 协议事件流（requestWillBeSent/responseReceived/
 * loadingFinished/loadingFailed），body 来自 Network.getResponseBody。
 */

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 5));
}

function requestWillBeSent(requestId: string, url: string, extra: Record<string, unknown> = {}): any {
  return { requestId, request: { url, method: 'GET' }, type: 'XHR', ...extra };
}

describe('RequestTracker completion attribution', () => {
  it('attributes body to the exact request, not the newest same-path record', async () => {
    const { page, emit } = makeCdpPage({
      'Network.getResponseBody': (p: any) =>
        p.requestId === 'req-a' ? { body: JSON.stringify({ who: 'A' }) } : { body: JSON.stringify({ who: 'B' }) },
    });
    const tracker = new RequestTracker();
    await tracker.start(page.context(), await page.context().__nativeEndpoint());
    await tracker.attach(page);

    emit('Network.requestWillBeSent', requestWillBeSent('req-a', 'https://x.com/api/item')); // nav n0, call_index 1
    emit('Network.requestWillBeSent', requestWillBeSent('req-b', 'https://x.com/api/item')); // nav n0, call_index 2

    // A 的响应先到（精确归因：responseReceived 只设 req-a 的 hop）
    emit('Network.responseReceived', { requestId: 'req-a', response: { status: 200 } });
    emit('Network.loadingFinished', { requestId: 'req-a' });
    await flush(); // 等 getResponseBody settle 回填 body

    const recA = tracker.query('/api/item', 0, 1);
    const recB = tracker.query('/api/item', 0, 2);

    expect(recA?.status).toBe(200);
    expect(recA?.body).toBe(JSON.stringify({ who: 'A' }));
    expect(recB?.status).toBeUndefined();
    expect(recB?.body).toBeUndefined();
  });

  it('waitForComplete: loadingFailed 终态失败立即拒绝，WaitApiFailure', async () => {
    const { page, emit } = makeCdpPage();
    const tracker = new RequestTracker();
    await tracker.start(page.context(), await page.context().__nativeEndpoint());
    await tracker.attach(page);
    emit('Network.requestWillBeSent', requestWillBeSent('req-1', 'https://x.com/api/x'));
    emit('Network.loadingFailed', { requestId: 'req-1', errorText: 'net::ERR_FAILED' });
    const { WaitApiFailure } = await import('../request-tracker.js');
    await expect(tracker.waitForComplete(page, { path: '/api/x', nav: 0, call_index: 1 }, 1000)).rejects.toBeInstanceOf(WaitApiFailure);
  });

  it('waitForComplete: body 读取拒绝记 failed 并拒绝', async () => {
    const { page, emit } = makeCdpPage({
      'Network.getResponseBody': () => { throw new Error('boom'); },
    });
    const tracker = new RequestTracker();
    await tracker.start(page.context(), await page.context().__nativeEndpoint());
    await tracker.attach(page);
    emit('Network.requestWillBeSent', requestWillBeSent('req-1', 'https://x.com/api/x'));
    emit('Network.responseReceived', { requestId: 'req-1', response: { status: 200 } });
    emit('Network.loadingFinished', { requestId: 'req-1' });
    await flush();
    const { WaitApiFailure } = await import('../request-tracker.js');
    await expect(tracker.waitForComplete(page, { path: '/api/x', nav: 0, call_index: 1 }, 1000)).rejects.toBeInstanceOf(WaitApiFailure);
  });

  it('waitForComplete: page 关闭拒绝且清理监听', async () => {
    const { page, emit, pageEmit, pageListeners } = makeCdpPage();
    const tracker = new RequestTracker();
    await tracker.start(page.context(), await page.context().__nativeEndpoint());
    await tracker.attach(page);
    emit('Network.requestWillBeSent', requestWillBeSent('req-1', 'https://x.com/api/x'));
    const p = tracker.waitForComplete(page, { path: '/api/x', nav: 0, call_index: 1 }, 5000);
    pageEmit('close', undefined);
    await expect(p).rejects.toThrow('page 已关闭');
    await tracker.dispose();
    expect((pageListeners['close'] ?? []).length).toBe(0);
  });

  it('waitForComplete: 超时拒绝且清理监听/定时器', async () => {
    const { page, emit, pageListeners } = makeCdpPage();
    const tracker = new RequestTracker();
    await tracker.start(page.context(), await page.context().__nativeEndpoint());
    await tracker.attach(page);
    emit('Network.requestWillBeSent', requestWillBeSent('req-1', 'https://x.com/api/x'));
    await expect(tracker.waitForComplete(page, { path: '/api/x', nav: 0, call_index: 1 }, 30)).rejects.toThrow('超时');
    await tracker.dispose();
    expect((pageListeners['close'] ?? []).length).toBe(0);
  });

  it('waitForComplete: AbortSignal 中止拒绝且清理', async () => {
    const { page, emit } = makeCdpPage();
    const tracker = new RequestTracker();
    await tracker.start(page.context(), await page.context().__nativeEndpoint());
    await tracker.attach(page);
    emit('Network.requestWillBeSent', requestWillBeSent('req-1', 'https://x.com/api/x'));
    const ac = new AbortController();
    const p = tracker.waitForComplete(page, { path: '/api/x', nav: 0, call_index: 1 }, 5000, ac.signal);
    ac.abort();
    await expect(p).rejects.toThrow('中止');
    await tracker.dispose();
  });

  it('waitForComplete: 空 body 字符串是完成（非 pending），但 JSON 断言层判失败', async () => {
    const { page, emit } = makeCdpPage({
      'Network.getResponseBody': () => ({ body: '' }),
    });
    const tracker = new RequestTracker();
    await tracker.start(page.context(), await page.context().__nativeEndpoint());
    await tracker.attach(page);
    emit('Network.requestWillBeSent', requestWillBeSent('req-1', 'https://x.com/api/x'));
    emit('Network.responseReceived', { requestId: 'req-1', response: { status: 200 } });
    emit('Network.loadingFinished', { requestId: 'req-1' });
    await flush();
    const rec = await tracker.waitForComplete(page, { path: '/api/x', nav: 0, call_index: 1 }, 1000);
    expect(rec.body).toBe('');
  });

  it('waitForComplete: 请求延后发起——订阅后请求才 emit，body 完成后 resolve', async () => {
    let releaseBody!: (b: { body: string }) => void;
    const bodyPromise = new Promise<{ body: string }>((r) => { releaseBody = r; });
    const { page, emit } = makeCdpPage({
      'Network.getResponseBody': () => bodyPromise,
    });
    const tracker = new RequestTracker();
    await tracker.start(page.context(), await page.context().__nativeEndpoint());
    await tracker.attach(page);
    // 调用时请求未发起
    const p = tracker.waitForComplete(page, { path: '/api/late', nav: 0, call_index: 1 }, 2000);
    const early = await Promise.race([p.then(() => 'resolved' as const), new Promise<'pending'>((r) => setTimeout(() => r('pending'), 20))]);
    expect(early).toBe('pending');
    // 下游才发起请求 + 响应（getResponseBody 返回挂起的真实 body promise）
    emit('Network.requestWillBeSent', requestWillBeSent('req-1', 'https://x.com/api/late'));
    emit('Network.responseReceived', { requestId: 'req-1', response: { status: 200 } });
    emit('Network.loadingFinished', { requestId: 'req-1' });
    releaseBody({ body: JSON.stringify({ ok: true }) });
    const rec = await p;
    expect(rec.body).toBe(JSON.stringify({ ok: true }));
  });

  it('waitForComplete: page 已关闭立即拒绝（订阅后不可观察过去事件）', async () => {
    const { page } = makeCdpPage({}, { isClosed: () => true });
    const tracker = new RequestTracker();
    await tracker.start(page.context(), await page.context().__nativeEndpoint());
    await tracker.attach(page);
    await expect(tracker.waitForComplete(page, { path: '/api/x', nav: 0, call_index: 1 }, 1000)).rejects.toThrow('page 已关闭');
    await tracker.dispose();
  });

  it('waitForComplete: AbortSignal 已中止立即拒绝', async () => {
    const { page } = makeCdpPage();
    const tracker = new RequestTracker();
    await tracker.start(page.context(), await page.context().__nativeEndpoint());
    await tracker.attach(page);
    const ac = new AbortController();
    ac.abort();
    await expect(tracker.waitForComplete(page, { path: '/api/x', nav: 0, call_index: 1 }, 1000, ac.signal)).rejects.toThrow('中止');
    await tracker.dispose();
  });

  // note14：三个真实生产入口（executeWaits / executeChecks assert.api / executeChecks capture.from_api）+
  // tracker 直读，均在 body 释放前并发启动；5s checkpoint 每个 均 pending；31s body 完成后真实 resolve。
  it('31s body 完成：executeWaits/assert.api/capture.from_api/tracker 并发在 body 完成前 pending，完成后真实 resolve', async () => {
    const waitForTimeoutSpy = vi.fn();
    let releaseBody!: (b: { body: string }) => void;
    const bodyPromise = new Promise<{ body: string }>((r) => { releaseBody = r; });
    const { page, emit } = makeCdpPage({
      'Network.getResponseBody': () => bodyPromise,
    }, { waitForTimeout: waitForTimeoutSpy });
    const tracker = new RequestTracker();
    await tracker.start(page.context(), await page.context().__nativeEndpoint());
    await tracker.attach(page);
    emit('Network.requestWillBeSent', requestWillBeSent('req-1', 'https://x.com/api/slow'));
    emit('Network.responseReceived', { requestId: 'req-1', response: { status: 200 } });
    emit('Network.loadingFinished', { requestId: 'req-1' });
    // body 31s 后完成；releaseBody 留存供 finally 失败清理（同有效 JSON）
    const bodyTimer = setTimeout(() => releaseBody({ body: JSON.stringify({ data: { id: 'slow-x' } }) }), 31_000);
    const ref = { path: '/api/slow', nav: 0, call_index: 1 };
    const vctxAssert = createValueContext();
    const vctxCapture = createValueContext();
    const timers: ReturnType<typeof setTimeout>[] = [bodyTimer];
    const checkpoint = (p: Promise<unknown>, label: string): Promise<void> => {
      return Promise.race([
        p.then(() => { throw new Error(`${label} 提前 resolve，应在 body 完成前 pending`); }, () => { throw new Error(`${label} 提前 reject，应在 body 完成前 pending`); }),
        new Promise<void>((r) => { const t = setTimeout(() => r(), 5_000); timers.push(t); }),
      ]);
    };
    // body 释放前并发启动三个生产入口 + tracker 直读
    const trackerP = tracker.waitForComplete(page, ref, 40_000);
    const waitsP = executeWaits(page, [{ api: ref }], tracker, 40_000);
    const assertP = executeChecks(page, [{ assert: { api: ref, expect: [{ path: 'data.id', op: 'eq', value: 'slow-x' }] } }], vctxAssert, tracker, 40_000);
    const captureP = executeChecks(page, [{ capture: { from_api: ref, path: 'data.id', as: 'sid', lineage: 'queried' } }], vctxCapture, tracker, 40_000);
    try {
      // 同一 5s checkpoint 并发观测四个消费者（串行会变 5/10/15/20s）
      await Promise.all([
        checkpoint(trackerP, 'tracker'),
        checkpoint(waitsP, 'executeWaits'),
        checkpoint(assertP, 'assert.api'),
        checkpoint(captureP, 'capture.from_api'),
      ]);
      // 真实 await 全部完成（不 race 超时当成功）
      const [rec] = await Promise.all([trackerP, waitsP, assertP, captureP]);
      expect(rec.body).toBe(JSON.stringify({ data: { id: 'slow-x' } }));
      expect(vctxCapture.resolve({ ref: 'sid' })).toBe('slow-x');
      // Page.waitForTimeout 从未被调用
      expect(waitForTimeoutSpy).not.toHaveBeenCalled();
    } finally {
      // 失败清理：先清 body/观察 timer，再释放同有效 JSON 让未决消费者完成，最后 settle；timeout/失败不当 success
      for (const t of timers) clearTimeout(t);
      try { releaseBody({ body: JSON.stringify({ data: { id: 'slow-x' } }) }); } catch { /* 已释放 */ }
      await Promise.allSettled([trackerP, waitsP, assertP, captureP]);
      await tracker.dispose();
    }
  }, 45_000);
});
