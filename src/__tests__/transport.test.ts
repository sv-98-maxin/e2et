/**
 * transport 三态 + managed 纯函数单测（不起真实浏览器）。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { CdpSession, resolveBrowserChoices, incompatibleBrowserAuth, nativeBaseUrl, configuredCdpAvailable } from '../browser/daemon-client.js';
import { loadAuthState, resolveChromiumExecutable, LINUX_SYSTEM_CHROMIUM } from '../browser/managed-browser.js';
import { requestContext, releaseRequestInputs, type RequestContext } from '../request-context.js';
import { FrameSessionRegistry } from '../browser/frame-sessions.js';
import { ActionRunner } from '../daemon/action-runner.js';
import { PageContext } from '../daemon/page-context.js';
import { NetworkTrace } from '../daemon/network-trace.js';
import { SessionValues } from '../daemon/session-values.js';
import { InvalidRefError } from '../browser/assert.js';
import { readTraceEvents } from '../daemon/trace.js';

const tmp = (name: string) => path.join(os.tmpdir(), `transport-${process.pid}-${name}`);
const written: string[] = [];
afterEach(() => {
  while (written.length) fs.rmSync(written.pop()!, { recursive: true, force: true });
});

interface WireSend { id: number; method: string; params: Record<string, unknown>; sessionId?: string }

async function cdpFixture(ctx: RequestContext, reply: (msg: WireSend, peer: WebSocket) => boolean = () => true) {
  const messages: WireSend[] = [];
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => wss.once('listening', resolve));
  let peer!: WebSocket;
  wss.on('connection', (ws) => {
    peer = ws;
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as WireSend;
      messages.push(msg);
      if (reply(msg, ws)) ws.send(JSON.stringify({ id: msg.id, sessionId: msg.sessionId, result: {} }));
    });
  });
  const discovery = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify([{ id: 'tab', webSocketDebuggerUrl: `ws://127.0.0.1:${(wss.address() as { port: number }).port}` }]));
  });
  await new Promise<void>((resolve) => discovery.listen(0, '127.0.0.1', resolve));
  const cdp = await requestContext.run(ctx, () => CdpSession.connect('tab', `http://127.0.0.1:${(discovery.address() as { port: number }).port}`));
  return {
    cdp, messages,
    event: (method: string, params: Record<string, unknown> = {}) => peer.send(JSON.stringify({ method, params })),
    close: async () => {
      cdp.close();
      for (const client of wss.clients) client.terminate();
      await Promise.all([
        new Promise<void>((resolve) => wss.close(() => resolve())),
        new Promise<void>((resolve) => discovery.close(() => resolve())),
      ]);
    },
  };
}

describe('请求级 CDP transport 收口（真实 WebSocket，有限协议时序）', () => {
  function context(controller: AbortController, onProgress = vi.fn()): RequestContext {
    return { signal: controller.signal, onProgress, inputCleanups: new Map() };
  }

  it('dispose开始到dialog：dispose80ms完成后仍等dismiss450ms，并drain等待期间新增dialog', async () => {
    const previousHome = process.env.E2ET_HOME;
    const traceHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dispose-dialog-'));
    written.push(traceHome);
    process.env.E2ET_HOME = traceHome;
    const controller = new AbortController();
    const ctx = context(controller);
    let enterDispose!: () => void;
    const disposalStarted = new Promise<void>((resolve) => { enterDispose = resolve; });
    let firstDismissAck!: () => void;
    const firstDismissCompleted = new Promise<void>((resolve) => { firstDismissAck = resolve; });
    let disposed = false;
    let dismissCount = 0;
    let secondDismissDone = false;
    const replies: Promise<void>[] = [];
    const wire = await cdpFixture(ctx, (msg, peer) => {
      if (msg.params.type === 'mousePressed') return false;
      const isDispose = msg.method === 'Runtime.releaseObject';
      const dialog = msg.method === 'Page.handleJavaScriptDialog' ? ++dismissCount : 0;
      if (isDispose) {
        peer.send(JSON.stringify({ method: 'Page.javascriptDialogOpening', params: { type: 'prompt', message: 'during dispose' } }));
        enterDispose();
      }
      if (!isDispose && !dialog) return true;
      replies.push(new Promise<void>((resolve) => setTimeout(() => {
        if (isDispose) disposed = true;
        peer.send(JSON.stringify({ id: msg.id, result: {} }));
        if (dialog === 1) firstDismissAck();
        if (dialog === 2) secondDismissDone = true;
        resolve();
      }, isDispose ? 80 : 450)));
      return false;
    });
    const sid = 'dispose-dialog';
    const nt = new NetworkTrace(sid, wire.cdp, 'tab');
    const snapshot = () => ({ state: 'running' as const, stopped: false });
    const page = new PageContext({ sessionId: sid, sourceTabId: 'tab', networkTrace: () => nt, observers: () => null, lifecycleSnapshot: snapshot, onAbort: () => {}, trace: () => {} });
    page.initRegistry();
    page.registerSource(wire.cdp, { captureMode: 'existing_late' });
    page.setActivePageWs('tab');
    const runner = new ActionRunner({ sessionId: sid, page, networkTrace: () => nt, observers: () => null, values: new SessionValues(), lifecycleSnapshot: snapshot });
    runner.installDialogHandler(wire.cdp);
    const reason = Object.assign(new Error('original cancellation'), { code: 'REQUEST_CANCELLED' });
    const dispose = vi.fn(() => wire.cdp.send('Runtime.releaseObject', { objectId: 'input-leaf' }).then(() => {}));
    const first = requestContext.run(ctx, () => runner.run({ id: 1, method: 'page.click', params: { intent: 'cancel', dialog: { accept: true, prompt_text: 'forbidden' } } }, 'click', () => {}, async ({ cdp, recordInput }) => {
      recordInput({ verify: async () => { throw new Error('cancelled input must not verify'); }, dispose });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 1, y: 2, button: 'left', buttons: 1 });
      return {};
    }));
    let nextExecutions = 0;
    const next = () => requestContext.run(context(new AbortController()), () => runner.run({ id: 2, method: 'page.click', params: { intent: 'next' } }, 'click', () => {}, async () => {
      nextExecutions++;
      throw new InvalidRefError('execution accepted');
    }));
    try {
      await vi.waitFor(() => expect(wire.messages.some((msg) => msg.params.type === 'mousePressed')).toBe(true));
      controller.abort(reason);
      await disposalStarted;
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(disposed).toBe(true);
      expect(dismissCount).toBe(1);
      expect(await next()).toMatchObject({ ok: false, error: { code: 'BUSY' } });
      expect(nextExecutions).toBe(0);
      wire.event('Page.javascriptDialogOpening', { type: 'prompt', message: 'during drain' });
      await firstDismissCompleted;
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(secondDismissDone).toBe(false);
      expect(await next()).toMatchObject({ ok: false, error: { code: 'BUSY' } });
      expect(nextExecutions).toBe(0);
      expect(await first).toMatchObject({ ok: false, error: { code: 'REQUEST_CANCELLED', message: 'original cancellation' } });
      expect(secondDismissDone).toBe(true);
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(wire.messages.filter((msg) => msg.method === 'Page.handleJavaScriptDialog').map((msg) => msg.params)).toEqual([{ accept: false }, { accept: false }]);
      expect(readTraceEvents(sid).filter((event) => event.t === 'dialog').map((event) => event.registered)).toEqual([true, true]);
      expect(await next()).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
      expect(nextExecutions).toBe(1);
    } finally {
      controller.abort(reason);
      await first.catch(() => undefined);
      await Promise.all(replies);
      runner.clearDialogHandlers();
      await wire.close();
      if (previousHome === undefined) delete process.env.E2ET_HOME;
      else process.env.E2ET_HOME = previousHome;
    }
  });

  it.each([false, true])('取消 cleanup 完成前保持 BUSY：release100ms/dismiss450ms/dispose80ms，dispose失败=%s', async (disposeFailed) => {
    const previousHome = process.env.E2ET_HOME;
    const traceHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cancel-busy-'));
    written.push(traceHome);
    process.env.E2ET_HOME = traceHome;
    const controller = new AbortController();
    const ctx = context(controller);
    const order: string[] = [];
    let disposeStarted!: () => void;
    const disposalStarted = new Promise<void>((resolve) => { disposeStarted = resolve; });
    const wire = await cdpFixture(ctx, (msg, peer) => {
      if (msg.params.type === 'mousePressed') return false;
      const cleanup = msg.params.type === 'mouseReleased' ? ['release', 100] as const
        : msg.method === 'Page.handleJavaScriptDialog' ? ['dismiss', 450] as const
        : msg.method === 'Runtime.releaseObject' ? ['dispose', 80] as const : undefined;
      if (!cleanup) return true;
      order.push(cleanup[0] + '-sent');
      if (cleanup[0] === 'dispose') disposeStarted();
      setTimeout(() => {
        order.push(cleanup[0] + '-acked');
        peer.send(JSON.stringify({ id: msg.id, ...(disposeFailed && cleanup[0] === 'dispose' ? { error: { message: 'dispose failed' } } : { result: {} }) }));
      }, cleanup[1]);
      return false;
    });
    const sid = 'cancel-busy';
    const nt = new NetworkTrace(sid, wire.cdp, 'tab');
    const snapshot = () => ({ state: 'running' as const, stopped: false });
    const page = new PageContext({ sessionId: sid, sourceTabId: 'tab', networkTrace: () => nt, observers: () => null, lifecycleSnapshot: snapshot, onAbort: () => {}, trace: () => {} });
    page.initRegistry();
    page.registerSource(wire.cdp, { captureMode: 'existing_late' });
    page.setActivePageWs('tab');
    const runner = new ActionRunner({ sessionId: sid, page, networkTrace: () => nt, observers: () => null, values: new SessionValues(), lifecycleSnapshot: snapshot });
    runner.installDialogHandler(wire.cdp);
    const reason = Object.assign(new Error('original cancellation'), { code: 'REQUEST_CANCELLED' });
    const dispose = vi.fn(() => wire.cdp.send('Runtime.releaseObject', { objectId: 'input-leaf' }).then(() => {}));
    const first = requestContext.run(ctx, () => runner.run({ id: 1, method: 'page.click', params: { intent: 'cancel', dialog: { accept: true, prompt_text: 'forbidden' } } }, 'click', () => {}, async ({ cdp, recordInput }) => {
      recordInput({ verify: async () => { throw new Error('cancelled input must not verify'); }, dispose });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 1, y: 2, button: 'left', buttons: 1 });
      return {};
    }));
    let nextExecutions = 0;
    const next = () => requestContext.run(context(new AbortController()), () => runner.run({ id: 2, method: 'page.click', params: { intent: 'next' } }, 'click', () => {}, async () => {
      nextExecutions++;
      throw new InvalidRefError('execution accepted');
    }));
    try {
      await vi.waitFor(() => expect(wire.messages.some((msg) => msg.params.type === 'mousePressed')).toBe(true));
      const cancelledAt = Date.now();
      controller.abort(reason);
      wire.event('Page.javascriptDialogOpening', { type: 'prompt', message: 'cancelled dialog' });
      await disposalStarted;
      expect(order).not.toContain('dispose-acked');
      expect(await next()).toMatchObject({ ok: false, error: { code: 'BUSY' } });
      expect(nextExecutions).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, 250 - (Date.now() - cancelledAt))));
      expect(order).toContain('release-acked');
      expect(order).not.toContain('dismiss-acked');
      expect(await next()).toMatchObject({ ok: false, error: { code: 'BUSY' } });
      expect(nextExecutions).toBe(0);
      const failed = await first;
      expect(failed).toMatchObject({ ok: false, error: { code: 'REQUEST_CANCELLED', message: 'original cancellation' } });
      if (disposeFailed) expect(failed.error?.hint).toContain('请求资源清理失败');
      expect(order.indexOf('dispose-sent')).toBeGreaterThan(order.indexOf('release-acked'));
      expect(order.indexOf('dispose-acked')).toBeLessThan(order.indexOf('dismiss-acked'));
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(wire.messages.find((msg) => msg.method === 'Page.handleJavaScriptDialog')?.params).toEqual({ accept: false });
      expect(readTraceEvents(sid).find((event) => event.t === 'action')?.result).toMatchObject({ ok: false, error: { code: 'REQUEST_CANCELLED', message: 'original cancellation' } });
      expect(await next()).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
      expect(nextExecutions).toBe(1);
      expect(ctx.onProgress).toHaveBeenCalledTimes(1);
    } finally {
      controller.abort(reason);
      await first.catch(() => undefined);
      runner.clearDialogHandlers();
      await wire.close();
      if (previousHome === undefined) delete process.env.E2ET_HOME;
      else process.env.E2ET_HOME = previousHome;
    }
  });

  it('releaseObjectGroup 在取消前后都按资源清理执行，不被 abort 中断或续期', async () => {
    const controller = new AbortController();
    const ctx = context(controller);
    const wire = await cdpFixture(ctx, (msg, peer) => {
      if (msg.method !== 'Runtime.releaseObjectGroup') return true;
      setTimeout(() => peer.send(JSON.stringify({ id: msg.id, result: {} })), 100);
      return false;
    });
    const reason = new Error('cancelled');
    try {
      const cleanup = requestContext.run(ctx, () => wire.cdp.send('Runtime.releaseObjectGroup', { objectGroup: 'snapshot' }));
      const completed = expect(cleanup).resolves.toEqual({});
      await vi.waitFor(() => expect(wire.messages).toHaveLength(1));
      controller.abort(reason);
      await completed;
      await requestContext.run(ctx, () => wire.cdp.send('Runtime.releaseObjectGroup', { objectGroup: 'snapshot-after-cancel' }));
      expect(wire.messages.map((msg) => msg.params.objectGroup)).toEqual(['snapshot', 'snapshot-after-cancel']);
      expect(ctx.onProgress).not.toHaveBeenCalled();
    } finally { await wire.close(); }
  });

  it('down 无回包即取消：root/child/不同 transport 的配对释放仍有效，普通 up 无清理资格', async () => {
    const controller = new AbortController();
    const ctx = context(controller);
    const holdsDown = (msg: WireSend) => !['mousePressed', 'rawKeyDown'].includes(String(msg.params.type));
    const a = await cdpFixture(ctx, holdsDown);
    const b = await cdpFixture(ctx, holdsDown);
    const reason = Object.assign(new Error('cancelled'), { code: 'REQUEST_CANCELLED' });
    try {
      await requestContext.run(ctx, async () => {
        const mouse = { type: 'mousePressed', x: 12, y: 34, button: 'left', buttons: 1, clickCount: 1 };
        const key = { type: 'rawKeyDown', key: 'A', code: 'KeyA', windowsVirtualKeyCode: 65 };
        const downs = [a.cdp.send('Input.dispatchMouseEvent', mouse), a.cdp.child('frame').send('Input.dispatchMouseEvent', mouse), b.cdp.send('Input.dispatchKeyEvent', key)];
        const failures = downs.map((down) => expect(down).rejects.toBe(reason));
        await vi.waitFor(() => { expect(a.messages).toHaveLength(2); expect(b.messages).toHaveLength(1); });
        expect(ctx.inputCleanups.size).toBe(2);
        controller.abort(reason);
        await Promise.all(failures);
        await expect(a.cdp.send('Input.dispatchMouseEvent', { ...mouse, type: 'mouseReleased' })).rejects.toBe(reason);
        expect(await releaseRequestInputs()).toBe(true);
        expect(ctx.inputCleanups.size).toBe(0);
        expect(await releaseRequestInputs()).toBe(true);
      });
      expect(a.messages).toHaveLength(4);
      expect(a.messages.slice(2)).toEqual(expect.arrayContaining([
        expect.objectContaining({ method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', x: 12, y: 34, button: 'left', buttons: 0, clickCount: 1 } }),
        expect.objectContaining({ sessionId: 'frame', params: { type: 'mouseReleased', x: 12, y: 34, button: 'left', buttons: 0, clickCount: 1 } }),
      ]));
      expect(b.messages).toHaveLength(2);
      expect(b.messages[1]).toMatchObject({ method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', key: 'A', code: 'KeyA', windowsVirtualKeyCode: 65 } });
      expect(ctx.onProgress).toHaveBeenCalledTimes(3);
    } finally { await a.close(); await b.close(); }
  });

  it('取消隔离：另一请求与建连时绑定的后台 observer 不受旧 signal 污染', async () => {
    const controller = new AbortController();
    const ctx = context(controller);
    const other = context(new AbortController());
    const wire = await cdpFixture(ctx, (msg) => msg.method !== 'Runtime.evaluate');
    const reason = new Error('cancelled');
    try {
      const pending = requestContext.run(ctx, () => wire.cdp.send('Runtime.evaluate'));
      const rejected = expect(pending).rejects.toBe(reason);
      await vi.waitFor(() => expect(wire.messages).toHaveLength(1));
      controller.abort(reason);
      await rejected;
      await requestContext.run(other, () => wire.cdp.send('DOM.getDocument'));
      let backgroundContext: RequestContext | undefined;
      const observed = new Promise<void>((resolve, reject) => wire.cdp.on('Network.loadingFinished', () => {
        backgroundContext = requestContext.getStore();
        void wire.cdp.send('Network.getResponseBody').then(() => resolve(), reject);
      }));
      wire.event('Network.loadingFinished');
      await observed;
      expect(backgroundContext).toBeUndefined();
      expect(wire.messages.map((msg) => msg.method)).toEqual(['Runtime.evaluate', 'DOM.getDocument', 'Network.getResponseBody']);
      expect(ctx.onProgress).toHaveBeenCalledTimes(1);
      expect(other.onProgress).toHaveBeenCalledTimes(1);
    } finally { await wire.close(); }
  });

  it('正常 up 交给 transport 即撤销登记；发送前取消没有 down/release', async () => {
    const controller = new AbortController();
    const ctx = context(controller);
    const wire = await cdpFixture(ctx);
    try {
      await requestContext.run(ctx, async () => {
        await wire.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter' });
        await wire.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter' });
        controller.abort(new Error('cancelled'));
        await expect(wire.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'A', code: 'KeyA' })).rejects.toThrow('cancelled');
        expect(await releaseRequestInputs()).toBe(true);
      });
      expect(wire.messages.map((msg) => msg.params.type)).toEqual(['keyDown', 'keyUp']);
    } finally { await wire.close(); }
  });

  it.each(['throw', 'callback'])('down write %s 失败撤销登记，不生成伪 release', async (failure) => {
    const controller = new AbortController();
    const ctx = context(controller);
    const wire = await cdpFixture(ctx);
    const ws = (wire.cdp as any).ws as WebSocket;
    const send = vi.spyOn(ws, 'send').mockImplementationOnce((...args: any[]) => {
      const error = new Error('write failed');
      if (failure === 'throw') throw error;
      args.at(-1)(error);
    });
    try {
      await requestContext.run(ctx, async () => {
        await expect(wire.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 1, y: 2, button: 'left' })).rejects.toThrow('write failed');
        controller.abort(new Error('cancelled'));
        expect(await releaseRequestInputs()).toBe(true);
      });
      expect(wire.messages).toEqual([]);
      expect(send).toHaveBeenCalledTimes(1);
    } finally { send.mockRestore(); await wire.close(); }
  });

  it('frame resolve 轮询取消保留原原因，25ms 轮询内退出', async () => {
    const controller = new AbortController();
    const ctx = context(controller);
    const registry = new FrameSessionRegistry({ page: {} as CdpSession, pageTargetId: 'root', onAttach: async () => {}, onDetach: () => {} });
    const reason = new Error('cancelled');
    const pending = requestContext.run(ctx, () => registry.resolve('missing', Date.now() + 30_000));
    const rejected = expect(pending).rejects.toBe(reason);
    controller.abort(reason);
    await rejected;
  });
});

describe('browser × auth 端点解析', () => {
  const ready = vi.fn(async () => ({ Browser: 'Chromium/135', webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/browser/1' }));
  afterEach(() => ready.mockClear());

  it('auto+profile 跳过现成端点，直接选 chrome', async () => {
    expect(await resolveBrowserChoices('auto', 'profile', true, {}, ready)).toEqual([{ kind: 'chrome' }]);
    expect(ready).not.toHaveBeenCalled();
  });
  it('auto+imported 优先现成端点，不可达选 managed', async () => {
    expect((await resolveBrowserChoices('auto', 'imported', true, {}, ready)).map((choice) => choice.kind)).toEqual(['existing']);
    expect(ready).toHaveBeenCalledWith('http://127.0.0.1:9222');
    expect(await resolveBrowserChoices('auto', 'imported', true, {}, async () => null)).toEqual([{ kind: 'managed' }]);
  });
  it('auto+auto：有 profile 时 chrome→existing→managed；无 profile 时 existing→managed', async () => {
    expect((await resolveBrowserChoices('auto', 'auto', true, {}, ready)).map((choice) => choice.kind)).toEqual(['chrome', 'existing', 'managed']);
    expect(await resolveBrowserChoices('auto', 'auto', true, {}, async () => null)).toEqual([{ kind: 'chrome' }, { kind: 'managed' }]);
    expect(await resolveBrowserChoices('auto', 'auto', false, {}, ready)).toEqual([
      { kind: 'existing', endpoint: 'http://127.0.0.1:9222', version: 'Chromium/135' },
      { kind: 'managed' },
    ]);
  });
  it('显式 URL 优先，未指定才用 loopback 环境端口', async () => {
    await resolveBrowserChoices('existing', 'imported', false, { E2ET_CDP_URL: 'http://host:9333/json/version', BROWSER_REMOTE_DEBUGGING_PORT: '4444' }, ready);
    expect(ready).toHaveBeenCalledWith('http://host:9333');
    await resolveBrowserChoices('existing', 'imported', false, { BROWSER_REMOTE_DEBUGGING_PORT: '9333' }, ready);
    expect(ready).toHaveBeenCalledWith('http://127.0.0.1:9333');
  });
  it('强制 existing 不可达直接失败；强制 managed 不探测', async () => {
    await expect(resolveBrowserChoices('existing', 'auto', false, {}, async () => null)).rejects.toThrow(/不可达/);
    expect(await resolveBrowserChoices('managed', 'auto', true, {}, ready)).toEqual([{ kind: 'managed' }]);
    expect(ready).not.toHaveBeenCalled();
  });
  it('默认 HTTP 探测只读 /json/version：可达选 existing，不可达自动降级', async () => {
    const originalFetch = globalThis.fetch;
    const requests: string[] = [];
    try {
      globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
        requests.push(String(input));
        return { ok: true, json: async () => ({ Browser: 'Chromium/test', webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/browser/test' }) } as Response;
      }) as typeof fetch;
      expect(await resolveBrowserChoices('auto', 'auto', true, {})).toEqual([
        { kind: 'chrome' }, { kind: 'existing', endpoint: 'http://127.0.0.1:9222', version: 'Chromium/test' }, { kind: 'managed' },
      ]);
      expect(requests).toEqual(['http://127.0.0.1:9222/json/version']);
      globalThis.fetch = vi.fn(async () => { throw new Error('connection refused'); }) as typeof fetch;
      expect(await resolveBrowserChoices('auto', 'auto', true, {})).toEqual([{ kind: 'chrome' }, { kind: 'managed' }]);
      expect(await resolveBrowserChoices('auto', 'imported', true, {})).toEqual([{ kind: 'managed' }]);
      await expect(resolveBrowserChoices('existing', 'auto', false, {})).rejects.toThrow(/不可达/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
  it('仅拒绝明确不兼容组合', () => {
    expect(incompatibleBrowserAuth('existing', 'profile')).toBeTruthy();
    expect(incompatibleBrowserAuth('managed', 'profile')).toBeTruthy();
    expect(incompatibleBrowserAuth('chrome', 'imported')).toBeTruthy();
    expect(incompatibleBrowserAuth('chrome', 'vendor' as any)).toBeNull();
    expect(incompatibleBrowserAuth('chrome', 'auto')).toBeNull();
  });
});

describe('nativeBaseUrl', () => {
  it('剥掉 /json/* 尾巴与多余斜杠', () => {
    expect(nativeBaseUrl('http://host:9222/')).toBe('http://host:9222');
    expect(nativeBaseUrl('http://host:9222/json/version')).toBe('http://host:9222');
    expect(nativeBaseUrl('http://host:9222/json/list')).toBe('http://host:9222');
    expect(nativeBaseUrl('http://host:9222/json')).toBe('http://host:9222');
    expect(nativeBaseUrl('https://proxy.example.com/cdp/')).toBe('https://proxy.example.com/cdp');
  });
});

describe('configuredCdpAvailable', () => {
  it('未配置 URL 不探测', async () => {
    const probe = vi.fn(async () => null);
    expect(await configuredCdpAvailable({}, probe)).toBe(false);
    expect(probe).not.toHaveBeenCalled();
  });

  it('配置 URL 后以 /json/version 实际可达为可用，不把非空配置直接当可用', async () => {
    const ready = vi.fn(async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/browser/x' }));
    expect(await configuredCdpAvailable({ E2ET_CDP_URL: 'http://host:9333/json/version' }, ready)).toBe(true);
    expect(ready).toHaveBeenCalledWith('http://host:9333');
    expect(await configuredCdpAvailable({ E2ET_CDP_URL: 'http://host:9333' }, async () => null)).toBe(false);
    expect(await configuredCdpAvailable({ E2ET_CDP_URL: 'http://host:9333' }, async () => {
      throw new Error('refused');
    })).toBe(false);
    expect(await configuredCdpAvailable({ E2ET_CDP_URL: 'ws://host:9333/devtools/browser/x' }, ready)).toBe(true);
  });
});

describe('loadAuthState cookie 投影（同一快照 cookies+origins）', () => {
  it('转成 CDP setCookieParams，保留 domain/path/flags/expires', () => {
    const p = tmp('cookies.json');
    fs.writeFileSync(
      p,
      JSON.stringify({
        cookies: [
          { name: 'EXAMPLE_SESSION', value: 'v', domain: '.example.invalid', path: '/', expires: 1900000000, httpOnly: true, secure: true, sameSite: 'Lax' },
          { name: 'plain', value: 'v2', url: 'https://x.com' },
        ],
      }),
    );
    written.push(p);
    const out = loadAuthState(p).cookies;
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ name: 'EXAMPLE_SESSION', domain: '.example.invalid', path: '/', expires: 1900000000, httpOnly: true, secure: true, sameSite: 'Lax' });
    expect(out[1]).toMatchObject({ name: 'plain', url: 'https://x.com' });
  });

  it('P4：不可注入 cookie（无 domain/url）在标准校验层拒绝，不进投影', () => {
    const p = tmp('drop.json');
    fs.writeFileSync(p, JSON.stringify({ cookies: [{ name: 'orphan', value: 'v' }] }));
    written.push(p);
    expect(() => loadAuthState(p)).toThrow(/不是标准 storageState/);
  });

  it('cookies 为空数组 → []', () => {
    const p = tmp('empty.json');
    fs.writeFileSync(p, JSON.stringify({ cookies: [] }));
    written.push(p);
    expect(loadAuthState(p).cookies).toEqual([]); expect(loadAuthState(p).origins).toEqual([]);
  });

  it('P4：非法 sameSite 在标准校验层拒绝（合法值才进投影）', () => {
    const p = tmp('samesite.json');
    fs.writeFileSync(p, JSON.stringify({ cookies: [{ name: 'a', value: 'v', domain: 'x.com', path: '/', sameSite: 'Bogus' }] }));
    written.push(p);
    expect(() => loadAuthState(p)).toThrow(/不是标准 storageState/);
  });

  // Playwright 分区字段需投影为 CDP partitionKey 对象，其余私有字段不能透传
  it('CDP partitionKey 对象保真，_crHasCrossSiteAncestor/其它私有字段不透传', () => {
    const p = tmp('regression.json');
    fs.writeFileSync(
      p,
      JSON.stringify({
        cookies: [
          {
            name: 'EXAMPLE_SESSION',
            value: 'v',
            domain: '.example.invalid',
            path: '/',
            secure: true,
            httpOnly: true,
            expires: -1,
            sameSite: 'Lax',
            partitionKey: 'https://example.invalid',
            _crHasCrossSiteAncestor: true,
            someOtherPrivate: 42,
          },
          { name: 'url-only', value: 'v2', url: 'https://x.com' },
        ],
      }),
    );
    written.push(p);
    const out = loadAuthState(p).cookies;
    expect(out).toHaveLength(2);
    const WHITELIST = new Set(['name', 'value', 'domain', 'path', 'secure', 'httpOnly', 'expires', 'sameSite', 'url', 'partitionKey']);
    for (const c of out) {
      for (const key of Object.keys(c)) {
        expect(WHITELIST.has(key)).toBe(true);
      }
    }
    // expires=-1 不出现（HEAD 语义：expires>0 才传）
    expect(out[0]).not.toHaveProperty('expires');
    expect(out[0]).toMatchObject({ partitionKey: { topLevelSite: 'https://example.invalid', hasCrossSiteAncestor: true } });
    // Playwright 私有布尔仍不能直接透传
    expect(out[0]).not.toHaveProperty('_crHasCrossSiteAncestor');
    expect(out[0]).not.toHaveProperty('someOtherPrivate');
    // 只有 url 的 cookie 保留 url
    expect(out[1]).toMatchObject({ name: 'url-only', url: 'https://x.com' });
    expect(out[1]).not.toHaveProperty('domain');
  });
});

describe('resolveChromiumExecutable', () => {
  it('沙箱变量优先级：BROWSER → PUPPETEER → CHROME → 现有缓存/系统', () => {
    const browser = tmp('browser-bin');
    const puppeteer = tmp('puppeteer-bin');
    const chrome = tmp('chrome-priority-bin');
    for (const executable of [browser, puppeteer, chrome]) {
      fs.writeFileSync(executable, '#!/bin/sh\n');
      written.push(executable);
    }
    const env = { BROWSER_EXECUTABLE_PATH: browser, PUPPETEER_EXECUTABLE_PATH: puppeteer, CHROME_EXECUTABLE_PATH: chrome };
    expect(resolveChromiumExecutable(env, 'linux')).toBe(browser);
    expect(resolveChromiumExecutable({ ...env, BROWSER_EXECUTABLE_PATH: '/nonexistent/browser' }, 'linux')).toBe(puppeteer);
    expect(resolveChromiumExecutable({ ...env, BROWSER_EXECUTABLE_PATH: '/nonexistent/browser', PUPPETEER_EXECUTABLE_PATH: '/nonexistent/puppeteer' }, 'linux')).toBe(chrome);
  });
  it('CHROME_EXECUTABLE_PATH 存在则用', () => {
    const fake = tmp('chrome-bin');
    fs.writeFileSync(fake, '#!/bin/sh\n');
    written.push(fake);
    expect(resolveChromiumExecutable({ CHROME_EXECUTABLE_PATH: fake } as NodeJS.ProcessEnv)).toBe(fake);
  });
  it('CHROME_EXECUTABLE_PATH 指向不存在文件 → 回退探测（不 crash）', () => {
    // 结果取决于本机是否装了 Chrome/Playwright 缓存，只验证不抛错、返回 string|null
    const r = resolveChromiumExecutable({ CHROME_EXECUTABLE_PATH: '/nonexistent/chrome' } as NodeJS.ProcessEnv);
    expect(r === null || typeof r === 'string').toBe(true);
  });

  it('env 覆盖优先于一切（linux 分支）', () => {
    const envBin = tmp('env-chrome-linux');
    fs.writeFileSync(envBin, '#!/bin/sh\n');
    written.push(envBin);
    // env 命中时与 platform/缓存/系统路径无关，直接返回
    expect(resolveChromiumExecutable({ CHROME_EXECUTABLE_PATH: envBin } as NodeJS.ProcessEnv, 'linux')).toBe(envBin);
  });

  it('ms-playwright 缓存精确命中：darwin chrome-mac 布局', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-darwin-'));
    written.push(home);
    const bin = path.join(home, 'Library', 'Caches', 'ms-playwright', 'chromium-1100', 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium');
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, '#!/bin/sh\n');
    expect(resolveChromiumExecutable({} as NodeJS.ProcessEnv, 'darwin', home)).toBe(bin);
  });

  it('ms-playwright 缓存精确命中：linux chrome-linux 布局', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-linux-'));
    written.push(home);
    const bin = path.join(home, '.cache', 'ms-playwright', 'chromium-1100', 'chrome-linux', 'chrome');
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, '#!/bin/sh\n');
    expect(resolveChromiumExecutable({} as NodeJS.ProcessEnv, 'linux', home)).toBe(bin);
  });

  it('多版本缓存取高版本（chromium-1120 > chromium-1100）', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-multi-'));
    written.push(home);
    for (const v of ['chromium-1100', 'chromium-1120']) {
      const bin = path.join(home, '.cache', 'ms-playwright', v, 'chrome-linux', 'chrome');
      fs.mkdirSync(path.dirname(bin), { recursive: true });
      fs.writeFileSync(bin, '#!/bin/sh\n');
    }
    const r = resolveChromiumExecutable({} as NodeJS.ProcessEnv, 'linux', home);
    expect(r).toContain('chromium-1120');
  });

  it('缓存优先于系统路径（cache>system 顺序不断言源码断言行为）', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-order-'));
    written.push(home);
    const cacheBin = path.join(home, '.cache', 'ms-playwright', 'chromium-1100', 'chrome-linux', 'chrome');
    fs.mkdirSync(path.dirname(cacheBin), { recursive: true });
    fs.writeFileSync(cacheBin, '#!/bin/sh\n');
    // 即使系统路径存在，缓存命中就必须返回缓存
    const r = resolveChromiumExecutable({} as NodeJS.ProcessEnv, 'linux', home);
    expect(r).toBe(cacheBin);
  });

  it('darwin 无 env 时返回 null 或存在路径（去宿主依赖）', () => {
    const r = resolveChromiumExecutable({} as NodeJS.ProcessEnv, 'darwin');
    if (r !== null) expect(fs.existsSync(r)).toBe(true);
  });

  it('linux 系统路径列表含沙箱实测的 chromium-browser，且 stable 命名在 generic 前', () => {
    // 盒雁沙箱实测 /usr/bin/chromium-browser（Chromium 135）必须第一个命中；
    // Debian 系 google-chrome-stable 命名常见，排在 google-chrome 前。
    expect(LINUX_SYSTEM_CHROMIUM).toEqual([
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome',
    ]);
  });

  it('linux 无 env 无缓存时回退系统路径或 null（不 crash）', () => {
    // 本机（darwin）跑 linux 分支：缓存目录是 ~/.cache/ms-playwright（darwin 下通常不存在），
    // 系统 /usr/bin/chromium* 也不存在 → null；若存在则为 /usr/bin/ 前缀。两种都合法，断言不抛错。
    const r = resolveChromiumExecutable({} as NodeJS.ProcessEnv, 'linux');
    if (r !== null) expect(r.startsWith('/usr/bin/')).toBe(true);
  });
});
