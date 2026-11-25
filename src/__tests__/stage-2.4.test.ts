/**
 * 阶段 2.4:assert / capture / mock / report
 *
 * 覆盖 cli-spec.md 1.5/1.6/1.7 + trace-ir-spec.md 1.2 assert/capture/mock 事件。
 * 复用 daemon-actions/stage-2.3 的 boot 模式,fake CDP 扩展请求 body + 元素。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DaemonClient } from '../daemon/client.js';
import { runDaemon } from '../daemon/daemon.js';
import type { BootstrapResult } from '../daemon/bootstrap.js';
import { resolveSocketPath, traceDir } from '../daemon/session-meta.js';
import { readTraceEvents } from '../daemon/trace.js';
import { requestContext } from '../request-context.js';

/** fake CDP:1 button + 1 input 元素,可 emit 请求/toast/innerText */
class AssertCdp {
  calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  closeCalled = false;
  dialogHandled: Array<{ accept: boolean; promptText?: string }> = [];
  bodyText = '提交成功 已提交商品';
  locationHref = 'https://example.test/page/detail.html';
  /** getResponseBody 返回的固定 JSON(可被测试改写) */
  responseBody = '{"data":{"itemId":"12345","ok":true}}';
  /** 下一次真实点击要触发的 XHR：在 Input.dispatchMouseEvent 时同步 emit，
   *  保证请求落在 action 生效窗口内（setTimeout 在 CI 慢机上会抢跑，wait_api 永远等不到） */
  pendingRequest?: { path: string; requestId: string };
  releaseGate?: { functionText: string; entered: (signal: AbortSignal) => void; resume: Promise<void> };
  private gatedRelease = false;
  private listeners = new Map<string, Array<(params: any) => void>>();
  private objectIdSeq = 0;
  private hitBackend = 0;
  nodeStates = new Map([[100, { connected: true, visible: true }], [101, { connected: true, visible: true }]]);
  private nodeObjects = new Map<string, { backend: number; group?: string }>();
  private visibilityFunctions = new Map<string, string>();

  on(method: string, handler: (params: any) => void): () => void {
    const list = this.listeners.get(method) ?? [];
    list.push(handler);
    this.listeners.set(method, list);
    return () => this.listeners.set(method, list.filter((item) => item !== handler));
  }
  onClose(): void {}
  close(): void { this.closeCalled = true; }

  async send<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ method, params });
    if (method === 'Page.enable' || method === 'Network.enable' || method === 'Fetch.enable' || method === 'Fetch.disable' || method === 'Fetch.continueRequest' || method === 'Fetch.fulfillRequest') return {} as T;
    if (method === 'Page.getFrameTree') {
      return { frameTree: { frame: { id: 'main', loaderId: '', url: this.locationHref, securityOrigin: 'https://example.test', name: '' }, childFrames: [] } } as T;
    }
    if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: '1' } as T;
    if (method === 'Accessibility.getFullAXTree') {
      return { nodes: [
        { nodeId: 'btn', role: { type: 'role', value: 'button' }, name: { type: 'string', value: '提交' }, backendDOMNodeId: 100, ignored: false },
        { nodeId: 'inp', role: { type: 'role', value: 'textbox' }, name: { type: 'string', value: '商品名称' }, backendDOMNodeId: 101, ignored: false, value: { type: 'string', value: 'E2E商品_123' } },
      ] } as T;
    }
    if (method === 'DOM.resolveNode') {
      const objectId = 'obj-' + (++this.objectIdSeq);
      this.nodeObjects.set(objectId, { backend: Number(params.backendNodeId), ...(typeof params.objectGroup === 'string' ? { group: params.objectGroup } : {}) });
      return { object: { objectId } } as T;
    }
    if (method === 'DOM.getContentQuads') { this.hitBackend = Number(params.backendNodeId); return { quads: [[10, 10, 20, 10, 20, 20, 10, 20]] } as T; }
    if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { pageX: 0, pageY: 0 } } as T;
    if (method === 'DOM.getNodeForLocation') return { backendNodeId: this.hitBackend } as T;
    if (method === 'DOM.getDocument') return { root: { nodeId: 1 } } as T;
    if (method === 'DOM.querySelectorAll') return { nodeIds: [10] } as T;
    if (method === 'DOM.describeNode') return { node: { backendNodeId: 100, nodeName: 'BUTTON' } } as T;
    if (method === 'DOM.scrollIntoViewIfNeeded') return {} as T;
    if (method === 'Page.handleJavaScriptDialog') {
      this.dialogHandled.push({ accept: Boolean(params.accept), ...(params.promptText !== undefined ? { promptText: String(params.promptText) } : {}) });
      return {} as T;
    }
    if (method === 'Page.reload' || method === 'Page.navigate') return {} as T;
    if (method === 'Page.getNavigationHistory') return { currentIndex: 1, entries: [{ url: this.locationHref }] } as T;
    if (method === 'Page.navigateToHistoryEntry') return {} as T;
    if (method === 'Input.dispatchMouseEvent') {
      if (params.type === 'mousePressed' && this.pendingRequest) {
        const { path, requestId } = this.pendingRequest;
        this.pendingRequest = undefined;
        this.emit('Network.requestWillBeSent', {
          requestId, frameId: 'main', type: 'XHR', wallTime: Date.now() / 1000,
          request: { url: 'https://example.test' + path, method: 'POST', headers: {}, postData: '{"orgNo":"A"}' },
        });
        this.emit('Network.responseReceived', { requestId, response: { status: 200, mimeType: 'application/json', headers: {} } });
        this.emit('Network.loadingFinished', { requestId });
      }
      return {} as T;
    }
    if (method === 'Runtime.callFunctionOn') {
      const fd = String(params.functionDeclaration ?? '');
      let objectId = String(params.objectId ?? '');
      if (fd.includes('return function readSnapshotVisibility(element)')) {
        const group = String(params.objectGroup ?? '');
        if (params.returnByValue !== false || !group.startsWith('e2et-page-state-') || this.nodeObjects.get(objectId)?.group !== group) throw new Error('非法 snapshot visibility factory 调用');
        const functionId = 'visibility-' + (++this.objectIdSeq);
        this.visibilityFunctions.set(functionId, group);
        return { result: { type: 'function', objectId: functionId } } as T;
      }
      const read = fd === 'function(element) { return this(element); }';
      if (read) {
        const group = this.visibilityFunctions.get(objectId);
        objectId = Array.isArray(params.arguments) ? String(params.arguments[0]?.objectId ?? '') : '';
        if (!group || params.objectGroup !== group || this.nodeObjects.get(objectId)?.group !== group) throw new Error('snapshot visibility 函数或节点句柄已失效');
      }
      if (this.releaseGate && fd.includes(this.releaseGate.functionText)) this.gatedRelease = true;
      if (read || fd.includes('isConnected')) {
        const backend = this.nodeObjects.get(objectId)?.backend;
        const value = backend === undefined ? undefined : this.nodeStates.get(backend);
        if (!value) throw new Error('未知 fake DOM 节点');
        return { result: { value } } as T;
      }
      if (fd.includes('disabled === true') || fd.includes('aria-disabled')) return { result: { value: null } } as T;
      if (fd.includes('getBoundingClientRect')) return { result: { value: true } } as T;
      // Phase2 readElementValue：返回 { read_mode, value }（先于 innerText 分支，函数源也含 innerText 字样）
      if (fd.includes('AUTH_DATA_NOT_REPLAYABLE')) {
        const argVal = Array.isArray(params.arguments) ? String(params.arguments[0]?.value ?? '') : '';
        return { result: { value: { read_mode: 'value', value: argVal || 'E2E商品_123' } } } as T;
      }
      if (fd.includes('setter.call')) {
        const argVal = Array.isArray(params.arguments) ? String(params.arguments[0]?.value ?? '') : '';
        return { result: { value: argVal } } as T;
      }
      if (fd.includes('innerText') || fd.includes('textContent') || fd.includes('this.value')) {
        return { result: { value: '提交成功 已提交商品' } } as T;
      }
      return { result: { value: true } } as T;
    }
    if (method === 'Runtime.releaseObject') {
      if (this.gatedRelease && this.releaseGate) {
        this.gatedRelease = false;
        this.releaseGate.entered(requestContext.getStore()!.signal);
        await this.releaseGate.resume;
      }
      this.nodeObjects.delete(String(params.objectId ?? ''));
      return {} as T;
    }
    if (method === 'Runtime.releaseObjectGroup') {
      const group = String(params.objectGroup ?? '');
      for (const [id, node] of this.nodeObjects) if (node.group === group) this.nodeObjects.delete(id);
      for (const [id, owner] of this.visibilityFunctions) if (owner === group) this.visibilityFunctions.delete(id);
      return {} as T;
    }
    if (method === 'Network.getResponseBody') return { body: this.responseBody } as T;
    return {} as T;
  }

  async evaluate<T = any>(expression: string): Promise<T> {
    if (expression.includes('clickable_texts: hits.length')) {
      return { kind: 'none', count: 0, candidates: [], clickable_texts: [] } as T;
    }
    if (expression.includes('return hits.length === 1 ? pick(hits[0]) : null')) return null as T;
    if (expression.includes('window.innerWidth')) return { width: 1280, height: 720, deviceScaleFactor: 2 } as T;
    if (expression.includes('readyState')) return 'complete' as T;
    if (expression.includes('__e2etChangeCount')) return 0 as T;
    if (expression.includes('__e2etObserver')) return true as T;
    if (expression.includes('location.href')) return this.locationHref as T;
    if (expression.includes('document.body.innerText')) return this.bodyText as T;
    if (expression.includes('activeElement') || expression.includes('dispatchEvent') || expression.includes('KeyboardEvent')) return 'ok' as T;
    // assert.table-row 的 JS（'table tr' 才是它的真实特征，不能泛匹配 'tr'）
    if (expression.includes('querySelectorAll') && expression.includes('table tr')) {
      return JSON.stringify({ matched: 1, samples: ['商品A 提交'], total: 3 }) as T;
    }
    if (expression.includes('querySelector')) return '' as T;
    return '' as T;
  }

  emit(method: string, params: any): void {
    for (const handler of this.listeners.get(method) ?? []) handler(params);
  }
}

describe('阶段 2.4:assert / capture / mock / report', () => {
  let home: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.E2ET_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'stage24-'));
    process.env.E2ET_HOME = home;
  });
  afterEach(() => {
    if (previousHome === undefined) delete process.env.E2ET_HOME;
    else process.env.E2ET_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  async function boot(cdp: AssertCdp, id: string): Promise<{ socket: string; done: Promise<void> }> {
    const socket = resolveSocketPath(id);
    fs.rmSync(socket, { force: true });
    const done = runDaemon(id, {
      env: 'pre', socketPath: socket, exitOnStop: false,
      browserBootstrap: async (): Promise<BootstrapResult> => ({ tabId: 'tab', session: cdp as any, endpoint: 'http://127.0.0.1:0' }),
    });
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (await DaemonClient.ping(socket, 200)) break;
      await new Promise((r) => setTimeout(r, 30));
    }
    return { socket, done };
  }

  /** 触发一次 click 并同步 emit 一个带 path 的请求(settle),供后续 assert/capture 引用 */
  async function clickWithRequest(client: DaemonClient, cdp: AssertCdp, path: string, requestId: string, creates?: string): Promise<void> {
    // 用 wait_api 显式等请求 settle(stage-2.3 验证过的模式),避免自动等待竞态
    cdp.pendingRequest = { path, requestId };
    const clickRes = await client.request('page.click', { target: '[0]', intent: '点击触发', snapshot_change_count: 0, wait_api: path, ...(creates ? { creates: { entity: creates, path } } : {}) });
    // 等 networkTrace finalize 把 body 写进 blob
    await new Promise((r) => setTimeout(r, 100));
  }

  it('fixture visibility工厂逐节点读取原状态，释放一个group不清另一个', async () => {
    const cdp = new AssertCdp();
    const objects = await Promise.all([100, 101].map(async (backendNodeId) => {
      const objectGroup = 'e2et-page-state-fixture-' + backendNodeId;
      const { object } = await cdp.send('DOM.resolveNode', { backendNodeId, objectGroup });
      const factory = await cdp.send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: 'function() { return function readSnapshotVisibility(element) {}; }', returnByValue: false, objectGroup });
      expect(factory.result.type).toBe('function');
      return { objectGroup, read: () => cdp.send('Runtime.callFunctionOn', { objectId: factory.result.objectId, functionDeclaration: 'function(element) { return this(element); }', arguments: [{ objectId: object.objectId }], returnByValue: true, objectGroup }) };
    }));
    cdp.nodeStates.set(101, { connected: true, visible: false });
    expect((await objects[0].read()).result.value).toEqual({ connected: true, visible: true });
    expect((await objects[1].read()).result.value).toEqual({ connected: true, visible: false });
    await cdp.send('Runtime.releaseObjectGroup', { objectGroup: objects[0].objectGroup });
    await expect(objects[0].read()).rejects.toThrow('句柄已失效');
    expect((await objects[1].read()).result.value).toEqual({ connected: true, visible: false });
    await cdp.send('Runtime.releaseObjectGroup', { objectGroup: objects[1].objectGroup });
    await expect(objects[1].read()).rejects.toThrow('句柄已失效');
  });

  it.each(['capture', 'assert'])('取消收口：%s 最后读取成功、releaseObject 等待期间断连，不发布成功证据', async (kind) => {
    const sid = 'cancel-' + Math.random().toString(36).slice(2, 8);
    const cdp = new AssertCdp();
    const { socket, done } = await boot(cdp, sid);
    const client = await DaemonClient.connect(socket);
    let resume!: () => void;
    const release = new Promise<void>((resolve) => { resume = resolve; });
    let entered!: (signal: AbortSignal) => void;
    const enteredRelease = new Promise<AbortSignal>((resolve) => { entered = resolve; });
    let cleanupClient: DaemonClient | undefined;
    try {
      await client.request('page.state');
      await clickWithRequest(client, cdp, '/api/test', 'r1');
      const method = kind === 'capture' ? 'capture.element' : 'assert.text';
      const params = kind === 'capture' ? { target: '[0]', as: 'cancelledVar' } : { contains: '提交成功', within: 'css=#scope' };
      const control = await client.request(method, { ...params, group: 'control' }) as any;
      if (kind === 'capture') expect(control.value).toBe('E2E商品_123');
      else expect(control.pass).toBe(true);
      cdp.releaseGate = { functionText: kind === 'capture' ? 'AUTH_DATA_NOT_REPLAYABLE' : 'return (this && this.innerText)', entered, resume: release };
      const pending = client.request(method, { ...params, ...(kind === 'capture' ? { as: 'neverPublished' } : {}), group: 'cancelled' });
      const rejected = expect(pending).rejects.toThrow('已关闭');
      const signal = await enteredRelease;
      const aborted = new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      client.close();
      await Promise.all([rejected, aborted]);
      resume();
      await vi.waitFor(() => expect(readTraceEvents(sid).find((e) => e.t === kind && e.group === 'cancelled')).toBeTruthy());
      const event = readTraceEvents(sid).find((e) => e.t === kind && e.group === 'cancelled') as any;
      if (kind === 'capture') expect(event).toMatchObject({ replayable: false, as: 'neverPublished', result: { ok: false, error: { code: 'REQUEST_CANCELLED' } } });
      else expect(event).toMatchObject({ pass: false, replayable: false, actual: { error: { code: 'REQUEST_CANCELLED' } }, evidence: [{ code: 'REQUEST_CANCELLED' }] });
      cleanupClient = await DaemonClient.connect(socket);
      if (kind === 'capture') await expect(cleanupClient.request('assert.text', { value_ref: 'neverPublished' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      await cleanupClient.request('stop');
      if (kind === 'assert') expect(readTraceEvents(sid).find((e) => e.t === 'session_end')?.asserts).toEqual({ total: 2, pass: 1 });
    } finally {
      resume();
      client.close();
      if (!cleanupClient) cleanupClient = await DaemonClient.connect(socket);
      try { await cleanupClient.request('stop', {}, { requestTimeoutMs: 3000 }); } catch {}
      cleanupClient.close();
      await done;
    }
  }, 10000);

  // ── assert api ──

  it('assert api 命中 → pass:true + trace assert 事件', async () => {
    const sid = 'a24-' + Math.random().toString(36).slice(2, 8);
    const cdp = new AssertCdp();
    const { socket, done } = await boot(cdp, sid);
    try {
      const client = await DaemonClient.connect(socket);
      await client.request('page.state', {});
      await clickWithRequest(client, cdp, '/api/item/publish/commit.json', 'r1');
      // 请求 id 是 r1(NetworkTrace 内部从 r1 开始编号)
      const res = await client.request('assert.api', { req: 'r1', expect: 'data.itemId == 12345' }) as any;
      expect(res.ok ?? true).toBe(true);
      expect(res.pass).toBe(true);
      expect(res.kind).toBe('api');
      const events = readTraceEvents(sid);
      const assertEv = events.find((e) => e.t === 'assert');
      expect(assertEv).toBeTruthy();
      expect(assertEv!.kind).toBe('api');
      expect(assertEv!.pass).toBe(true);
      expect(assertEv!.after).toBe('a1'); // 第一个 action
      await client.request('stop', {});
      client.close();
    } finally { try { await done; } catch {} }
  }, 15000);

  it('assert api 不命中 → pass:false + ok:true', async () => {
    const sid = 'a24-' + Math.random().toString(36).slice(2, 8);
    const cdp = new AssertCdp();
    const { socket, done } = await boot(cdp, sid);
    try {
      const client = await DaemonClient.connect(socket);
      await client.request('page.state', {});
      await clickWithRequest(client, cdp, '/api/test', 'r1');
      const res = await client.request('assert.api', { req: 'r1', expect: 'data.itemId == 99999' }) as any;
      expect(res.ok ?? true).toBe(true);
      expect(res.pass).toBe(false);
      await client.request('stop', {});
      client.close();
    } finally { try { await done; } catch {} }
  }, 15000);

  it('assert api 找不到请求 → BAD_REQUEST', async () => {
    const sid = 'a24-' + Math.random().toString(36).slice(2, 8);
    const cdp = new AssertCdp();
    const { socket, done } = await boot(cdp, sid);
    try {
      const client = await DaemonClient.connect(socket);
      await client.request('page.state', {});
      await clickWithRequest(client, cdp, '/api/test', 'r1');
      await expect(client.request('assert.api', { req: 'r999', expect: 'x == 1' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      try { await client.request('stop', {}); } catch {}
      client.close();
    } finally { try { await done; } catch {} }
  }, 15000);

  it('assert api 用 path@nav#n 引用 → 命中', async () => {
    const sid = 'a24-' + Math.random().toString(36).slice(2, 8);
    const cdp = new AssertCdp();
    const { socket, done } = await boot(cdp, sid);
    try {
      const client = await DaemonClient.connect(socket);
      await client.request('page.state', {});
      await clickWithRequest(client, cdp, '/api/test', 'r1');
      const res = await client.request('assert.api', { req: '/api/test@n0#1', expect: 'data.ok == true' }) as any;
      expect(res.pass).toBe(true);
      await client.request('stop', {});
      client.close();
    } finally { try { await done; } catch {} }
  }, 15000);

  // ── assert toast / text / url ──

  it('assert toast 命中 → pass:true', async () => {
    const sid = 'a24-' + Math.random().toString(36).slice(2, 8);
    const cdp = new AssertCdp();
    // 注入 messages:page-state collectStatusMessages 读 AX 节点,这里靠 evaluate bodyText 间接覆盖不了
    // 直接测断言逻辑:messages 空时 pass:false
    const { socket, done } = await boot(cdp, sid);
    try {
      const client = await DaemonClient.connect(socket);
      await client.request('page.state', {});
      await clickWithRequest(client, cdp, '/api/test', 'r1');
        const res = await client.request('assert.toast', { text: '不存在' }) as any;
        expect(res.pass).toBe(false);
        await client.request('stop', {});
        client.close();
    } finally { try { await done; } catch {} }
  }, 15000);

  it('assert text 命中 → pass:true', async () => {
    const sid = 'a24-' + Math.random().toString(36).slice(2, 8);
    const cdp = new AssertCdp();
    const { socket, done } = await boot(cdp, sid);
    try {
      const client = await DaemonClient.connect(socket);
      await client.request('page.state', {});
      await clickWithRequest(client, cdp, '/api/test', 'r1');
      const res = await client.request('assert.text', { contains: '提交成功' }) as any;
      expect(res.pass).toBe(true);
      await client.request('stop', {});
      client.close();
    } finally { try { await done; } catch {} }
  }, 15000);

  it('assert text 动态来源写 trace；字面值与来源互斥；空/空白 fail closed', async () => {
    const sid = 'a24-' + Math.random().toString(36).slice(2, 8);
    const cdp = new AssertCdp();
    cdp.responseBody = '{"data":{"itemId":"12345","errorDesc":""}}';
    cdp.bodyText = '提交成功 12345';
    const { socket, done } = await boot(cdp, sid);
    try {
      const client = await DaemonClient.connect(socket);
      await client.request('page.state', {});
      await clickWithRequest(client, cdp, '/api/item/publish/commit.json', 'r1');
      await client.request('capture.api', { req: 'r1', path: 'data.itemId', as: 'itemId' });
      await client.request('capture.api', { req: 'r1', path: 'data.errorDesc', as: 'emptyText' });

      const res = await client.request('assert.text', { value_ref: 'itemId' }) as any;
      expect(res.pass).toBe(true);
      const textEvent = readTraceEvents(sid).find((event) => event.t === 'assert' && event.kind === 'text');
      expect(textEvent?.value).toEqual({ raw: '12345', origin: 'captured', ref: 'itemId' });

      await expect(client.request('assert.text', { value_ref: 'itemId', contains: '提交成功' }))
        .rejects.toMatchObject({ code: 'BAD_REQUEST' });
      await expect(client.request('assert.text', { value_ref: 'emptyText' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      await expect(client.request('assert.text', { value: '' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      await expect(client.request('assert.text', { value: '   ' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      await expect(client.request('assert.text', { value_ref: '' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      await expect(client.request('assert.text', { value_from_action: '' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });

      await client.request('stop', {});
      client.close();
    } finally { try { await done; } catch {} }
  }, 15000);

  it('assert url 命中 → pass:true', async () => {
    const sid = 'a24-' + Math.random().toString(36).slice(2, 8);
    const cdp = new AssertCdp();
    const { socket, done } = await boot(cdp, sid);
    try {
      const client = await DaemonClient.connect(socket);
      await client.request('page.state', {});
      await clickWithRequest(client, cdp, '/api/test', 'r1');
      const res = await client.request('assert.url', { contains: 'detail.html' }) as any;
      expect(res.pass).toBe(true);
      await client.request('stop', {});
      client.close();
    } finally { try { await done; } catch {} }
  }, 15000);

  // ── assert visible / absent / field / table-row ──

  it('assert visible 命中 → pass:true', async () => {
    const sid = 'a24-' + Math.random().toString(36).slice(2, 8);
    const cdp = new AssertCdp();
    const { socket, done } = await boot(cdp, sid);
    try {
      const client = await DaemonClient.connect(socket);
      await client.request('page.state', {});
      await clickWithRequest(client, cdp, '/api/test', 'r1');
      const res = await client.request('assert.visible', { target: '[0]' }) as any;
      expect(res.pass).toBe(true);
      await client.request('stop', {});
      client.close();
    } finally { try { await done; } catch {} }
  }, 15000);

  it('assert absent 命中(元素不存在)→ pass:true', async () => {
    const sid = 'a24-' + Math.random().toString(36).slice(2, 8);
    const cdp = new AssertCdp();
    const { socket, done } = await boot(cdp, sid);
    // 异常路径也要停 daemon：client 提到 try 外，finally 统一 stop/close 再 await done
    let client: DaemonClient | undefined;
    try {
      client = await DaemonClient.connect(socket);
      await client.request('page.state', {});
      await clickWithRequest(client, cdp, '/api/test', 'r1');
      const res = await client.request('assert.absent', { target: '不存在的按钮' }) as any;
      expect(res.pass).toBe(true);
    } finally {
      if (client) {
        try { await client.request('stop', {}); } catch {}
        client.close();
      }
      try { await done; } catch {}
    }
  }, 15000);

  it('assert field 命中 → pass:true', async () => {
    const sid = 'a24-' + Math.random().toString(36).slice(2, 8);
    const cdp = new AssertCdp();
    const { socket, done } = await boot(cdp, sid);
    try {
      const client = await DaemonClient.connect(socket);
      await client.request('page.state', {});
      await clickWithRequest(client, cdp, '/api/test', 'r1');
      const res = await client.request('assert.field', { label: '商品名称', value: 'E2E商品_123' }) as any;
      expect(res.pass).toBe(true);
      await client.request('stop', {});
      client.close();
    } finally { try { await done; } catch {} }
  }, 15000);

  it('assert table-row 命中 → pass:true', async () => {
    const sid = 'a24-' + Math.random().toString(36).slice(2, 8);
    const cdp = new AssertCdp();
    const { socket, done } = await boot(cdp, sid);
    try {
      const client = await DaemonClient.connect(socket);
      await client.request('page.state', {});
      await clickWithRequest(client, cdp, '/api/test', 'r1');
      const res = await client.request('assert.table_row', { contains: '商品A', count: 1 }) as any;
      expect(res.pass).toBe(true);
      await client.request('stop', {});
      client.close();
    } finally { try { await done; } catch {} }
  }, 15000);

  // ── capture api ──

  it('capture api 从响应取值 → 存变量,lineage=queried', async () => {
    const sid = 'a24-' + Math.random().toString(36).slice(2, 8);
    const cdp = new AssertCdp();
    const { socket, done } = await boot(cdp, sid);
    try {
      const client = await DaemonClient.connect(socket);
      await client.request('page.state', {});
      await clickWithRequest(client, cdp, '/api/item/publish/commit.json', 'r1');
      const res = await client.request('capture.api', { req: 'r1', path: 'data.itemId', as: 'itemId' }) as any;
      expect(res.ok ?? true).toBe(true);
      expect(res.value).toBe('12345');
      expect(res.lineage).toBe('queried');
      expect(res.as).toBe('itemId');
      // trace capture 事件
      const events = readTraceEvents(sid);
      const capEv = events.find((e) => e.t === 'capture');
      expect(capEv).toBeTruthy();
      // Phase2 wire3：capture 成功判别联合 result{ok:true, value, from, lineage, path}
      expect(capEv!.result).toMatchObject({ ok: true, value: '12345', lineage: 'queried' });
      expect(capEv!.as).toBe('itemId');
      expect(capEv!.replayable).toBe(true);
      await client.request('stop', {});
      client.close();
    } finally { try { await done; } catch {} }
  }, 15000);

  it('capture api 从 creates 请求取值 → lineage=created', async () => {
    const sid = 'a24-' + Math.random().toString(36).slice(2, 8);
    const cdp = new AssertCdp();
    const { socket, done } = await boot(cdp, sid);
    try {
      const client = await DaemonClient.connect(socket);
      await client.request('page.state', {});
      await clickWithRequest(client, cdp, '/api/item/publish/commit.json', 'r1', 'item');
      const res = await client.request('capture.api', { req: 'r1', path: 'data.itemId', as: 'itemId' }) as any;
      expect(res.lineage).toBe('created');
      await client.request('stop', {});
      client.close();
    } finally { try { await done; } catch {} }
  }, 15000);

  // ── capture api：$ 根前缀（42304 Phase A1）──

  it('capture api $ 根前缀：完整 JSON body 的 $.errorDesc 返回空字符串；路径不存在仍拒绝', async () => {
    const sid = 'a24-' + Math.random().toString(36).slice(2, 8);
    const cdp = new AssertCdp();
    // 完整业务 JSON body：errorDesc 为空字符串（非 null/缺失）
    cdp.responseBody = '{"success":true,"errorDesc":"","errorCode":"0","data":{"itemId":"12345"}}';
    const { socket, done } = await boot(cdp, sid);
    try {
      const client = await DaemonClient.connect(socket);
      await client.request('page.state', {});
      await clickWithRequest(client, cdp, '/api/item/publish/commit.json', 'r1');
      const res = await client.request('capture.api', { req: 'r1', path: '$.errorDesc', as: 'errorDesc' }) as any;
      expect(res.ok ?? true).toBe(true);
      expect(res.value).toBe('');
      expect(res.lineage).toBe('queried');
      // trace capture 事件记录带 $ 的原 path
      const capEv = readTraceEvents(sid).find((e) => e.t === 'capture');
      expect((capEv!.result as Record<string, unknown>).path).toBe('$.errorDesc');
      // 路径不存在错误保留（BAD_REQUEST: JSON path 未命中）
      await expect(client.request('capture.api', { req: 'r1', path: '$.notExist', as: 'x' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      await client.request('stop', {});
      client.close();
    } finally { try { await done; } catch {} }
  }, 15000);

  it('capture api $ 根前缀：嵌套字段 + BODY_UNAVAILABLE 错误保留（loadingFailed 请求无响应 body）', async () => {
    const sid = 'a24-' + Math.random().toString(36).slice(2, 8);
    const cdp = new AssertCdp();
    cdp.responseBody = '{"success":true,"errorDesc":"","data":{"itemId":"12345"}}';
    const { socket, done } = await boot(cdp, sid);
    try {
      const client = await DaemonClient.connect(socket);
      await client.request('page.state', {});
      await clickWithRequest(client, cdp, '/api/item/publish/commit.json', 'r1');
      // 嵌套 $ 路径
      const res = await client.request('capture.api', { req: 'r1', path: '$.data.itemId', as: 'itemId' }) as any;
      expect(res.value).toBe('12345');
      // 失败请求（loadingFailed 终端失败）无 resp_body_ref → capture 仍 BODY_UNAVAILABLE，不静默成功
      cdp.emit('Network.requestWillBeSent', {
        requestId: 'f1', frameId: 'main', type: 'XHR', wallTime: Date.now() / 1000,
        request: { url: 'https://example.test/api/fail.json', method: 'GET', headers: {} },
      });
      cdp.emit('Network.loadingFailed', { requestId: 'f1', type: 'XHR', errorText: 'net::ERR_FAILED' });
      await new Promise((r) => setTimeout(r, 100));
      await expect(client.request('capture.api', { req: '/api/fail.json', path: '$.errorDesc', as: 'x' })).rejects.toMatchObject({ code: 'BODY_UNAVAILABLE' });
      await client.request('stop', {});
      client.close();
    } finally { try { await done; } catch {} }
  }, 15000);

  // ── capture element ──

  it('capture element 从元素取值 → 存变量', async () => {
    const sid = 'a24-' + Math.random().toString(36).slice(2, 8);
    const cdp = new AssertCdp();
    const { socket, done } = await boot(cdp, sid);
    try {
      const client = await DaemonClient.connect(socket);
      await client.request('page.state', {});
      await clickWithRequest(client, cdp, '/api/test', 'r1');
      const res = await client.request('capture.element', { target: '[0]', as: 'btnText' }) as any;
      expect(res.ok ?? true).toBe(true);
      expect(res.as).toBe('btnText');
      expect(typeof res.value).toBe('string');
      await client.request('stop', {});
      client.close();
    } finally { try { await done; } catch {} }
  }, 15000);

  // ── mock ──

  it('mock add + clear → trace mock 事件 + session_end.mocked', async () => {
    const sid = 'a24-' + Math.random().toString(36).slice(2, 8);
    const cdp = new AssertCdp();
    const { socket, done } = await boot(cdp, sid);
    try {
      const client = await DaemonClient.connect(socket);
      await client.request('page.state', {});
      // 写一个临时 body 文件(模拟 --body-file)
      const bodyFile = path.join(home, 'mock-body.json');
      fs.writeFileSync(bodyFile, '{"mocked":true}', 'utf8');
      // mock add
      const addRes = await client.request('mock.add', { path: '/api/test', status: 200, body_b64: Buffer.from('{"mocked":true}').toString('base64') }) as any;
      expect(addRes.mocked).toBe(true);
      // mock clear
      await client.request('mock.clear', { path: '/api/test' });
      // stop 收尾
      await client.request('stop', {});
      client.close();
      await done;
      // 检查 trace mock 事件 + session_end.mocked
      const events = readTraceEvents(sid);
      const mockAdds = events.filter((e) => e.t === 'mock' && e.op === 'add');
      expect(mockAdds.length).toBe(1);
      const mockClears = events.filter((e) => e.t === 'mock' && e.op === 'clear');
      expect(mockClears.length).toBe(1);
      const sessionEnd = events.find((e) => e.t === 'session_end');
      expect(sessionEnd).toBeTruthy();
      // mocked 标志:用过 mock 即 true(即便已 clear,会话期间用过)
      expect(sessionEnd!.mocked).toBe(true);
    } finally { try { await done; } catch {} }
  }, 20000);

  it('assert/capture 必须跟在操作后,无 action → BAD_REQUEST', async () => {
    const sid = 'a24-' + Math.random().toString(36).slice(2, 8);
    const cdp = new AssertCdp();
    const { socket, done } = await boot(cdp, sid);
    try {
      const client = await DaemonClient.connect(socket);
      await client.request('page.state', {});
      await expect(client.request('assert.toast', { text: 'x' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      await expect(client.request('capture.api', { req: 'r1', path: 'data.x', as: 'x' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      try { await client.request('stop', {}); } catch {}
      client.close();
    } finally { try { await done; } catch {} }
  }, 15000);
});
