/**
 * P2 daemon 集成红前测试:page read / assert data / observation trace / 身份绑定 / stop 终态。
 *
 * fake CDP 按 protocol.d.ts 真实形状返回(见 page-data.test.ts harness 说明),
 * 并支持 page.open/click 驱动(assert data 的 after 前置)与身份漂移注入。
 *
 * equals 语义:CLI(router)对 flag 字符串 parseValue 一次,socket params 传真实 JSON scalar;
 * daemon 只验 scalar 不再解析字符串。资源清理:每个用例 finally 里 stop + close 再 await done,
 * 失败也不留 daemon/浏览器进程。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DaemonClient } from '../daemon/client.js';
import { runDaemon } from '../daemon/daemon.js';
import type { BootstrapResult } from '../daemon/bootstrap.js';
import { resolveSocketPath, traceRoot } from '../daemon/session-meta.js';
import { readTraceEvents } from '../daemon/trace.js';
import { PageObservers } from '../daemon/page-observers.js';
import { requestContext } from '../request-context.js';

/** 集成 fake:ActionCdp 精简底座 + page-data 协议 + 可注入漂移 */
class PageDataCdp {
  calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  closeCalled = false;
  getterCalls = 0;
  releasedGroups: string[] = [];
  /** localStorage 条目 */
  storageEntries: string[][] = [];
  /** global 自身属性 */
  globalProps: Record<string, Record<string, unknown>> = {};
  /** 每次读取的 frame 树(按调用序消费;长度不足取末位) */
  frameTreeQueue: Array<Record<string, unknown>> = [];
  private listeners = new Map<string, Array<(params: any) => void>>();
  private objectIdSeq = 0;
  private hitBackend = 0;
  nodeStates = new Map([[100, { connected: true, visible: true }]]);
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
  emit(method: string, params: any): void {
    for (const handler of this.listeners.get(method) ?? []) handler(params);
  }

  async send<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ method, params });
    switch (method) {
      case 'Page.enable':
      case 'Network.enable':
      case 'Page.addScriptToEvaluateOnNewDocument':
      case 'DOM.scrollIntoViewIfNeeded':
      case 'Page.reload':
      case 'Page.navigate': {
        // macrotask 触发 loadEventFired：waitForLoad 在 navigate 返回后才注册监听
        setTimeout(() => this.emit('Page.loadEventFired', {}), 0);
        return {} as T;
      }
      case 'Page.getFrameTree': {
        const frame = (this.frameTreeQueue.length > 1 ? this.frameTreeQueue.shift() : this.frameTreeQueue[0]) ?? { id: 'F1', loaderId: 'LD1', url: 'https://page.test/app', urlFragment: '', securityOrigin: 'https://page.test' };
        return { frameTree: { frame } } as T;
      }
      case 'Page.captureScreenshot':
        return { data: Buffer.from('png').toString('base64') } as T;
      case 'Storage.getStorageKeyForFrame':
        return { storageKey: 'https://page.test' } as T;
      case 'DOMStorage.getDOMStorageItems':
        return { entries: this.storageEntries.map(([k, v]) => [String(k), String(v)]) } as T;
      case 'Runtime.evaluate': {
        const expr = String(params.expression ?? '');
        if (expr === 'this') {
          return { result: { type: 'object', className: 'globalThis', objectId: 'g-' + (++this.objectIdSeq) } } as T;
        }
        if (expr.includes('location.href') && expr.includes('location.origin')) {
          return { result: { value: { url: 'https://page.test/app', origin: 'https://page.test' } } } as T;
        }
        if (expr.includes('location.href')) return { result: { value: 'https://page.test/app' } } as T;
        if (expr.includes('__e2etChangeCount')) return { result: { value: 0 } } as T;
        if (expr.includes('readyState')) return { result: { value: 'complete' } } as T;
        if (expr.includes('document.body')) return { result: { value: '' } } as T;
        if (expr.includes('innerWidth')) return { result: { value: { width: 1280, height: 720 } } } as T;
        if (expr.includes('getBoundingClientRect')) return { result: { value: true } } as T;
        this.getterCalls++;
        return { result: { type: 'undefined' } } as T;
      }
      case 'Runtime.getProperties': {
        const out = Object.entries(this.globalProps).map(([name, d]) => ({ name, ...d }));
        return { result: out } as T;
      }
      case 'Runtime.releaseObjectGroup': {
        const group = String(params.objectGroup ?? '');
        this.releasedGroups.push(group);
        for (const [id, node] of this.nodeObjects) if (node.group === group) this.nodeObjects.delete(id);
        for (const [id, owner] of this.visibilityFunctions) if (owner === group) this.visibilityFunctions.delete(id);
        return {} as T;
      }
      case 'Runtime.callFunctionOn': {
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
        if (read || fd.includes('isConnected')) {
          const backend = this.nodeObjects.get(objectId)?.backend;
          const value = backend === undefined ? undefined : this.nodeStates.get(backend);
          if (!value) throw new Error('未知 fake DOM 节点');
          return { result: { value } } as T;
        }
        if (fd.includes('disabled === true') || fd.includes('aria-disabled')) return { result: { value: null } } as T;
        return { result: { value: true } } as T;
      }
      case 'DOM.resolveNode': {
        const objectId = 'obj-' + (++this.objectIdSeq);
        this.nodeObjects.set(objectId, { backend: Number(params.backendNodeId), ...(typeof params.objectGroup === 'string' ? { group: params.objectGroup } : {}) });
        return { object: { objectId } } as T;
      }
      case 'Runtime.releaseObject':
        this.nodeObjects.delete(String(params.objectId ?? ''));
        return {} as T;
      case 'DOM.getContentQuads':
        this.hitBackend = Number(params.backendNodeId);
        return { quads: [[10, 10, 20, 10, 20, 20, 10, 20]] } as T;
      case 'Page.getLayoutMetrics':
        return { cssVisualViewport: { pageX: 0, pageY: 0 } } as T;
      case 'DOM.getNodeForLocation':
        return { backendNodeId: this.hitBackend } as T;
      case 'DOM.getDocument':
        return { root: { nodeId: 1 } } as T;
      case 'DOM.querySelector':
      case 'DOM.querySelectorAll':
        return { nodeIds: [] } as T;
      case 'Accessibility.getFullAXTree':
        return { nodes: [
          { nodeId: 'btn', role: { type: 'role', value: 'button' }, name: { type: 'string', value: '确定' }, backendDOMNodeId: 100, ignored: false },
        ] } as T;
      case 'Network.getResponseBody':
        return { body: '{"ok":true}' } as T;
      default:
        return {} as T;
    }
  }

  async evaluate<T = any>(expression: string): Promise<T> {
    if (expression.includes('window.innerWidth')) return { width: 1280, height: 720, deviceScaleFactor: 2 } as T;
    if (expression.includes('readyState')) return 'complete' as T;
    if (expression.includes('__e2etChangeCount')) return 0 as T;
    if (expression.includes('__e2etObserver')) return true as T;
    if (expression.includes('location.href')) return 'https://page.test/app' as T;
    return '' as T;
  }
}

describe('P2 page read / assert data(daemon 集成)', () => {
  let home: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.E2ET_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-page-data-'));
    process.env.E2ET_HOME = home;
  });
  afterEach(() => {
    if (previousHome === undefined) delete process.env.E2ET_HOME;
    else process.env.E2ET_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  interface Booted { socket: string; done: Promise<void>; id: string }

  async function boot(cdp: PageDataCdp): Promise<Booted> {
    const id = 'pd-' + Math.random().toString(36).slice(2, 8);
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
    return { socket, done, id };
  }

  /** 无论红绿都收资源:连接 stop + close + await done */
  async function runWith<T>(booted: Booted, fn: (client: DaemonClient) => Promise<T>): Promise<T> {
    const client = await DaemonClient.connect(booted.socket);
    try {
      return await fn(client);
    } finally {
      try { await client.request('stop', {}, { requestTimeoutMs: 10000 }); } catch { /* 已停/失败也继续清理 */ }
      client.close();
      try { await booted.done; } catch { /* keep-alive 已结束 */ }
    }
  }

  function traceEvents(): Array<Record<string, unknown>> {
    const sids = fs.readdirSync(traceRoot());
    expect(sids).toHaveLength(1);
    return readTraceEvents(sids[0]);
  }

  it('fixture visibility工厂绑定实际节点状态，group释放后不能复用句柄', async () => {
    const cdp = new PageDataCdp();
    const objectGroup = 'e2et-page-state-fixture';
    const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: 100, objectGroup });
    const factory = await cdp.send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: 'function() { return function readSnapshotVisibility(element) {}; }', returnByValue: false, objectGroup });
    expect(factory.result.type).toBe('function');
    const read = () => cdp.send('Runtime.callFunctionOn', { objectId: factory.result.objectId, functionDeclaration: 'function(element) { return this(element); }', arguments: [{ objectId: object.objectId }], returnByValue: true, objectGroup });
    cdp.nodeStates.set(100, { connected: true, visible: false });
    expect((await read()).result.value).toEqual({ connected: true, visible: false });
    cdp.nodeStates.set(100, { connected: false, visible: false });
    expect((await read()).result.value).toEqual({ connected: false, visible: false });
    await cdp.send('Runtime.releaseObjectGroup', { objectGroup });
    await expect(read()).rejects.toThrow('句柄已失效');
  });

  it('取消收口：assertData 的最终观察返回边界取消，不能增加 pass 或写成功 assert', async () => {
    const cdp = new PageDataCdp();
    cdp.storageEntries = [['mode', 'simple']];
    const booted = await boot(cdp);
    let enter!: (signal: AbortSignal) => void;
    const entered = new Promise<AbortSignal>((resolve) => { enter = resolve; });
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    const readObserved = PageObservers.prototype.readPageDataObserved;
    let pause = false;
    const observed = vi.spyOn(PageObservers.prototype, 'readPageDataObserved').mockImplementation(async function (...args) {
      const read = await readObserved.apply(this, args);
      if (pause) { enter(requestContext.getStore()!.signal); await gate; }
      return read;
    });
    const client = await DaemonClient.connect(booted.socket);
    let cleanupClient: DaemonClient | undefined;
    try {
      await client.request('page.open', { url: 'https://page.test/app', intent: '打开' });
      const control = await client.request('assert.data', { local_storage: 'mode', equals: 'simple' }) as any;
      expect(control.pass).toBe(true);
      pause = true;
      const pending = client.request('assert.data', { local_storage: 'mode', equals: 'simple', group: 'cancelled' });
      const rejected = expect(pending).rejects.toThrow('已关闭');
      const signal = await entered;
      const aborted = new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      client.close();
      await Promise.all([rejected, aborted]);
      resume();
      await vi.waitFor(() => expect(readTraceEvents(booted.id).find((e) => e.t === 'assert' && e.group === 'cancelled')).toBeTruthy());
      expect(readTraceEvents(booted.id).find((e) => e.t === 'assert' && e.group === 'cancelled')).toMatchObject({ kind: 'data', pass: false, replayable: false, actual: { error: { code: 'REQUEST_CANCELLED' } }, evidence: [{ code: 'REQUEST_CANCELLED' }] });
      cleanupClient = await DaemonClient.connect(booted.socket);
      await cleanupClient.request('stop');
      expect(readTraceEvents(booted.id).find((e) => e.t === 'session_end')?.asserts).toEqual({ total: 2, pass: 1 });
    } finally {
      resume();
      pause = false;
      observed.mockRestore();
      client.close();
      if (!cleanupClient) cleanupClient = await DaemonClient.connect(booted.socket);
      try { await cleanupClient.request('stop', {}, { requestTimeoutMs: 3000 }); } catch {}
      cleanupClient.close();
      await booted.done;
    }
  }, 10000);

  it('page read local-storage raw → present/value(稳定 value 键)+ context + observation 事件', async () => {
    const cdp = new PageDataCdp();
    cdp.storageEntries = [['mode', 'simple']];
    const booted = await boot(cdp);
    await runWith(booted, async (client) => {
      const res = await client.request('page.read', { local_storage: 'mode' }) as any;
      expect(res.present).toBe(true);
      expect(res.value).toBe('simple');
      expect(res.context).toMatchObject({ frame_id: 'F1', loader_id: 'LD1', url: 'https://page.test/app', origin: 'https://page.test' });
      expect(typeof res.context.target_id).toBe('string');
      expect(res.context.nav).toMatch(/^n\d+$/);
      // 协议链
      expect(cdp.calls.some((c) => c.method === 'Storage.getStorageKeyForFrame')).toBe(true);
      expect(cdp.calls.some((c) => c.method === 'DOMStorage.getDOMStorageItems')).toBe(true);
    });
  }, 15000);

  it('page read observation trace 事件:t/observation,source/身份,不输出全量 entries', async () => {
    const cdp = new PageDataCdp();
    cdp.storageEntries = [['secret_token', 'T0PS3CRET'], ['mode', 'simple']];
    const booted = await boot(cdp);
    await runWith(booted, async (client) => {
      await client.request('page.read', { local_storage: 'mode', group: '读配置' }) as any;
      const ev = traceEvents().filter((e) => e.t === 'observation');
      expect(ev).toHaveLength(1);
      const o = ev[0];
      expect(o.source).toEqual({ local_storage: 'mode' });
      expect(o.group).toBe('读配置');
      expect(o.target_id).toBeDefined();
      expect(o.document).toMatchObject({ frame_id: 'F1', loader_id: 'LD1' });
      expect(o.nav).toMatch(/^n\d+$/);
      expect((o.result as any).ok).toBe(true);
      expect((o.result as any).present).toBe(true);
      expect((o.result as any).value).toBe('simple');
      // 敏感源值不进 trace:读其它 key 的值不被整组输出
      const json = JSON.stringify(o);
      expect(json).not.toContain('T0PS3CRET');
    });
  }, 15000);

  it('敏感 key 的值被 scrub(临时键含 token → REDACTED,回填稳定 value)', async () => {
    const cdp = new PageDataCdp();
    cdp.storageEntries = [['auth_token', 'T0PS3CRET']];
    const booted = await boot(cdp);
    await runWith(booted, async (client) => {
      const res = await client.request('page.read', { local_storage: 'auth_token' }) as any;
      expect(res.present).toBe(true);
      expect(res.value).toBe('[REDACTED]');
    });
  }, 15000);

  it('敏感 key 的 assert data：expect.equals 脱敏展示，严格比较用原值，secret 不进返回/trace', async () => {
    const cdp = new PageDataCdp();
    cdp.storageEntries = [['secret', 'S3CR3T9']];
    const booted = await boot(cdp);
    await runWith(booted, async (client) => {
      await client.request('page.open', { url: 'https://page.test/app', intent: '打开' }, { requestTimeoutMs: 10000 });
      const res = await client.request('assert.data', { local_storage: 'secret', equals: 'S3CR3T9' }) as any;
      // 比较用原值：值相等 → pass true
      expect(res.pass).toBe(true);
      // 展示层脱敏：expect/actual 都不携带明文
      expect(res.expect.equals).toBe('[REDACTED]');
      expect(res.actual.value).toBe('[REDACTED]');
      const events = traceEvents();
      const json = JSON.stringify(events);
      expect(json).not.toContain('S3CR3T9');
      const asserts = events.filter((e) => e.t === 'assert');
      expect((asserts[0].expect as any).equals).toBe('[REDACTED]');
    });
  }, 20000);

  it('超过 60 字符且敏感后缀的 key：临时键不截断敏感语义，值仍 REDACTED', async () => {
    const cdp = new PageDataCdp();
    const longKey = 'x'.repeat(70) + '_password';
    cdp.storageEntries = [[longKey, 'PW123']];
    const booted = await boot(cdp);
    await runWith(booted, async (client) => {
      const res = await client.request('page.read', { local_storage: longKey }) as any;
      expect(res.present).toBe(true);
      expect(res.value).toBe('[REDACTED]');
    });
  }, 15000);

  it('敏感 path 末段：值按末段脱敏', async () => {
    const cdp = new PageDataCdp();
    cdp.storageEntries = [['cfg', JSON.stringify({ auth_token: 'T0K3N' })]];
    const booted = await boot(cdp);
    await runWith(booted, async (client) => {
      const res = await client.request('page.read', { local_storage: 'cfg', path: 'auth_token' }) as any;
      expect(res.present).toBe(true);
      expect(res.value).toBe('[REDACTED]');
      const json = JSON.stringify(traceEvents());
      expect(json).not.toContain('T0K3N');
    });
  }, 15000);

  it('读取失败 + 敏感 equals：失败 assert 的 expect.equals 也脱敏', async () => {
    const cdp = new PageDataCdp();
    const origSend = cdp.send.bind(cdp);
    cdp.send = async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'DOMStorage.getDOMStorageItems') throw new Error('boom');
      return origSend(method, params);
    };
    const booted = await boot(cdp);
    const client = await DaemonClient.connect(booted.socket);
    try {
      await client.request('page.open', { url: 'https://page.test/app', intent: '打开' }, { requestTimeoutMs: 10000 });
      await expect(client.request('assert.data', { local_storage: 'secret', equals: 'S3CR3T9' })).rejects.toMatchObject({ code: 'READ_UNAVAILABLE' });
      const events = traceEvents();
      const json = JSON.stringify(events);
      expect(json).not.toContain('S3CR3T9');
      const asserts = events.filter((e) => e.t === 'assert');
      expect((asserts[0].expect as any).equals).toBe('[REDACTED]');
    } finally {
      try { await client.request('stop', {}, { requestTimeoutMs: 10000 }); } catch { /* 已停 */ }
      client.close();
      try { await booted.done; } catch { /* keep-alive 已结束 */ }
    }
  }, 20000);

  it('socket assert.data 缺 equals → 读取前 BAD_REQUEST（不上协议不计 FAIL）', async () => {
    const cdp = new PageDataCdp();
    cdp.storageEntries = [['mode', 'simple']];
    const booted = await boot(cdp);
    await runWith(booted, async (client) => {
      await client.request('page.open', { url: 'https://page.test/app', intent: '打开' }, { requestTimeoutMs: 10000 });
      await expect(client.request('assert.data', { local_storage: 'mode' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      // 读取前拒绝：无存储协议调用
      expect(cdp.calls.some((c) => c.method === 'DOMStorage.getDOMStorageItems')).toBe(false);
      // 无 assert 落 trace
      expect(traceEvents().some((e) => e.t === 'assert')).toBe(false);
    });
  }, 20000);

  it('page read 缺源/双源/global+path/非法 path → BAD_REQUEST(daemon 端参数合同)', async () => {
    const cdp = new PageDataCdp();
    const booted = await boot(cdp);
    await runWith(booted, async (client) => {
      await expect(client.request('page.read', {})).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      await expect(client.request('page.read', { local_storage: 'a', global: 'g' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      await expect(client.request('page.read', { global: 'g', path: 'a.b' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      await expect(client.request('page.read', { local_storage: 'a', path: 'x[0]' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });
  }, 15000);

  it('assert data 无前置 action → BAD_REQUEST(必须跟在 open 等真实 action 后)', async () => {
    const cdp = new PageDataCdp();
    const booted = await boot(cdp);
    await runWith(booted, async (client) => {
      await expect(client.request('assert.data', { local_storage: 'mode', equals: 'simple' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });
  }, 15000);

  it('assert data 匹配 → pass:true + observation_ref 指向真实 observation;统计入 asserts', async () => {
    const cdp = new PageDataCdp();
    cdp.storageEntries = [['mode', 'simple']];
    const booted = await boot(cdp);
    await runWith(booted, async (client) => {
      await client.request('page.open', { url: 'https://page.test/app', intent: '打开页面' }, { requestTimeoutMs: 10000 });
      const res = await client.request('assert.data', { local_storage: 'mode', equals: 'simple', group: '校验' }) as any;
      expect(res.pass).toBe(true);
      expect(res.kind).toBe('data');
      expect(res.expect).toEqual({ source: { local_storage: 'mode' }, equals: 'simple' });
      expect(res.observation_ref).toMatch(/^o/);
      const stop = await client.request('stop', {}) as any;
      expect(stop.result).toBe('pass');
      const events = traceEvents();
      const obs = events.filter((e) => e.t === 'observation');
      expect(obs).toHaveLength(1);
      expect(obs[0].after).toMatch(/^a\d+$/);
      expect(obs[0].group).toBe('校验');
      const asserts = events.filter((e) => e.t === 'assert');
      expect(asserts).toHaveLength(1);
      expect(asserts[0].kind).toBe('data');
      expect(asserts[0].observation_ref).toBe(obs[0].id);
      expect(asserts[0].pass).toBe(true);
      const end = events.find((e) => e.t === 'session_end')!;
      expect(end.asserts).toEqual({ total: 1, pass: 1 });
    });
  }, 20000);

  it('assert data equals 严格比较:missing ≠ null;字符串值与数字期望不相等', async () => {
    const cdp = new PageDataCdp();
    cdp.storageEntries = [['num', '123']];
    const booted = await boot(cdp);
    await runWith(booted, async (client) => {
      await client.request('page.open', { url: 'https://page.test/app', intent: '打开' }, { requestTimeoutMs: 10000 });
      // missing key,期望 null(socket 传真实 null scalar)→ 不相等(missing 不是 null)
      const r1 = await client.request('assert.data', { global: 'nope', equals: null }) as any;
      expect(r1.pass).toBe(false);
      // 存储值是字符串 '123',期望字符串 '123' → 相等
      const r2 = await client.request('assert.data', { local_storage: 'num', equals: '123' }) as any;
      expect(r2.pass).toBe(true);
      // 期望数字 123 → 严格类型不相等
      const r3 = await client.request('assert.data', { local_storage: 'num', equals: 123 }) as any;
      expect(r3.pass).toBe(false);
    });
  }, 20000);

  it("assert data 'true' 字符串与 true 布尔透传不混淆", async () => {
    const cdp = new PageDataCdp();
    cdp.storageEntries = [['flag', 'true'], ['raw', 'yes']];
    const booted = await boot(cdp);
    await runWith(booted, async (client) => {
      await client.request('page.open', { url: 'https://page.test/app', intent: '打开' }, { requestTimeoutMs: 10000 });
      // 存储 raw 字符串 'true' 与期望字符串 'true' 相等
      const r1 = await client.request('assert.data', { local_storage: 'flag', equals: 'true' }) as any;
      expect(r1.pass).toBe(true);
      // 期望布尔 true 与字符串 'true' 严格不相等
      const r2 = await client.request('assert.data', { local_storage: 'flag', equals: true }) as any;
      expect(r2.pass).toBe(false);
      // 字符串 'yes' 与布尔 true 也不相等
      const r3 = await client.request('assert.data', { local_storage: 'raw', equals: true }) as any;
      expect(r3.pass).toBe(false);
    });
  }, 20000);

  it('assert data equals 非标量(socket 直接传 object/array)→ BAD_REQUEST', async () => {
    const cdp = new PageDataCdp();
    const booted = await boot(cdp);
    await runWith(booted, async (client) => {
      await client.request('page.open', { url: 'https://page.test/app', intent: '打开' }, { requestTimeoutMs: 10000 });
      await expect(client.request('assert.data', { local_storage: 'a', equals: { a: 1 } })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      await expect(client.request('assert.data', { local_storage: 'a', equals: [1] })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      // 字符串 '{"a":1}' 是合法 scalar(已解析字符串),不拒
      const r = await client.request('assert.data', { local_storage: 'a', equals: '{"a":1}' }) as any;
      expect(r.pass).toBe(false);
    });
  }, 20000);

  it('同 URL 重载(loaderId 变)→ STALE_CONTEXT,不返回旧数据,留失败 observation', async () => {
    const cdp = new PageDataCdp();
    cdp.storageEntries = [['mode', 'simple']];
    // 第 1 次初始身份;读前/读后两次:读前同身份,读后 loaderId 变(重载)
    cdp.frameTreeQueue = [
      { id: 'F1', loaderId: 'LD1', url: 'https://page.test/app', urlFragment: '', securityOrigin: 'https://page.test' },
      { id: 'F1', loaderId: 'LD1', url: 'https://page.test/app', urlFragment: '', securityOrigin: 'https://page.test' },
      { id: 'F1', loaderId: 'LD2', url: 'https://page.test/app', urlFragment: '', securityOrigin: 'https://page.test' },
    ];
    const booted = await boot(cdp);
    await runWith(booted, async (client) => {
      await expect(client.request('page.read', { local_storage: 'mode' })).rejects.toMatchObject({ code: 'STALE_CONTEXT' });
      const obs = traceEvents().filter((e) => e.t === 'observation');
      expect(obs).toHaveLength(1);
      expect((obs[0].result as any).ok).toBe(false);
      expect((obs[0].result as any).error.code).toBe('STALE_CONTEXT');
    });
  }, 15000);

  it('读取失败(协议抛错)→ READ_UNAVAILABLE + 失败 observation;stop 终态 blocked(不是 pass/fail)', async () => {
    const cdp = new PageDataCdp();
    cdp.storageEntries = [['mode', 'simple']];
    const origSend = cdp.send.bind(cdp);
    cdp.send = async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'DOMStorage.getDOMStorageItems') throw new Error('boom');
      return origSend(method, params);
    };
    const booted = await boot(cdp);
    const client = await DaemonClient.connect(booted.socket);
    try {
      await expect(client.request('page.read', { local_storage: 'mode' })).rejects.toMatchObject({ code: 'READ_UNAVAILABLE' });
      const stop = await client.request('stop', {}) as any;
      // 普通 page read 失败不算业务断言 FAIL,但不得 pass → blocked
      expect(stop.result).toBe('blocked');
      const obs = traceEvents().filter((e) => e.t === 'observation');
      expect(obs).toHaveLength(1);
      expect((obs[0].result as any).ok).toBe(false);
      expect((obs[0].result as any).error.code).toBe('READ_UNAVAILABLE');
    } finally {
      try { await client.request('stop', {}, { requestTimeoutMs: 10000 }); } catch { /* 已停 */ }
      client.close();
      try { await booted.done; } catch { /* keep-alive 已结束 */ }
    }
  }, 15000);

  it('assert data 读取失败 → 留失败 observation + 失败 assert + 顶层结构化读取错误;会话 fail', async () => {
    const cdp = new PageDataCdp();
    const origSend = cdp.send.bind(cdp);
    cdp.send = async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'Runtime.getProperties') throw new Error('boom');
      return origSend(method, params);
    };
    const booted = await boot(cdp);
    const client = await DaemonClient.connect(booted.socket);
    try {
      await client.request('page.open', { url: 'https://page.test/app', intent: '打开' }, { requestTimeoutMs: 10000 });
      await expect(client.request('assert.data', { global: 'gStr', equals: 'v' })).rejects.toMatchObject({ code: 'READ_UNAVAILABLE' });
      const stop = await client.request('stop', {}) as any;
      expect(stop.result).toBe('fail');
      const events = traceEvents();
      const obs = events.filter((e) => e.t === 'observation');
      expect(obs).toHaveLength(1);
      expect((obs[0].result as any).ok).toBe(false);
      const asserts = events.filter((e) => e.t === 'assert');
      expect(asserts).toHaveLength(1);
      expect(asserts[0].pass).toBe(false);
      expect(asserts[0].observation_ref).toBe(obs[0].id);
    } finally {
      try { await client.request('stop', {}, { requestTimeoutMs: 10000 }); } catch { /* 已停 */ }
      client.close();
      try { await booted.done; } catch { /* keep-alive 已结束 */ }
    }
  }, 20000);

  it('BUSY:action 执行中拒绝读取(isActionActive);finally 兜底释放挂起 click 再 stop', async () => {
    const cdp = new PageDataCdp();
    cdp.storageEntries = [['mode', 'simple']];
    let releaseClick: (() => void) | undefined;
    const origSend = cdp.send.bind(cdp);
    cdp.send = async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed' && releaseClick === undefined) {
        await new Promise<void>((resolve) => { releaseClick = resolve; });
      }
      return origSend(method, params);
    };
    const booted = await boot(cdp);
    const c1 = await DaemonClient.connect(booted.socket);
    const c2 = await DaemonClient.connect(booted.socket);
    try {
      await c1.request('page.state', {});
      const clickP = c1.request('page.click', { target: '[0]', intent: '点击' }, { requestTimeoutMs: 20000 }).catch(() => null);
      await new Promise((r) => setTimeout(r, 200));
      await expect(c2.request('page.read', { local_storage: 'mode' })).rejects.toMatchObject({ code: 'BUSY' });
      releaseClick?.();
      await clickP;
    } finally {
      releaseClick?.();
      try { await c1.request('stop', {}, { requestTimeoutMs: 10000 }); } catch { /* click 失败也停 */ }
      c1.close();
      c2.close();
      try { await booted.done; } catch { /* keep-alive 已结束 */ }
    }
  }, 30000);

  it('并发边界：read 挂起期间另一 click 开始且未结束 → 最终 BUSY（中间值不当稳定事实）', async () => {
    const cdp = new PageDataCdp();
    cdp.storageEntries = [['mode', 'simple']];
    let releaseRead: (() => void) | undefined;
    let releaseClick: (() => void) | undefined;
    const origSend = cdp.send.bind(cdp);
    cdp.send = async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'DOMStorage.getDOMStorageItems' && releaseRead === undefined) {
        await new Promise<void>((resolve) => { releaseRead = resolve; });
      }
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed' && releaseClick === undefined) {
        await new Promise<void>((resolve) => { releaseClick = resolve; });
      }
      return origSend(method, params);
    };
    const booted = await boot(cdp);
    const c1 = await DaemonClient.connect(booted.socket);
    const c2 = await DaemonClient.connect(booted.socket);
    try {
      await c2.request('page.state', {});
      const readP = c1.request('page.read', { local_storage: 'mode' }, { requestTimeoutMs: 20000 }).catch((e: any) => e);
      await new Promise((r) => setTimeout(r, 200));
      // read 挂起中：另一 socket 启动 click（挂起未结束）
      const clickP = c2.request('page.click', { target: '[0]', intent: '点击' }, { requestTimeoutMs: 20000 }).catch(() => null);
      await new Promise((r) => setTimeout(r, 300));
      // 释放 read：最终核验发现 action 仍 active → BUSY
      releaseRead?.();
      const readResult = await readP;
      expect(readResult).toMatchObject({ code: 'BUSY' });
      // 失败 observation 留痕
      const obs = traceEvents().filter((e) => e.t === 'observation');
      expect((obs[0].result as any).error.code).toBe('BUSY');
      releaseClick?.();
      await clickP;
    } finally {
      releaseRead?.();
      releaseClick?.();
      try { await c1.request('stop', {}, { requestTimeoutMs: 10000 }); } catch { /* 兼容资源清理 */ }
      c1.close();
      c2.close();
      try { await booted.done; } catch { /* keep-alive 已结束 */ }
    }
  }, 30000);

  it('并发边界：read 挂起期间另一 click 开始并结束 → 最终 STALE_CONTEXT（不关联旧 after）', async () => {
    const cdp = new PageDataCdp();
    cdp.storageEntries = [['mode', 'simple']];
    let releaseRead: (() => void) | undefined;
    const origSend = cdp.send.bind(cdp);
    cdp.send = async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'DOMStorage.getDOMStorageItems' && releaseRead === undefined) {
        await new Promise<void>((resolve) => { releaseRead = resolve; });
      }
      return origSend(method, params);
    };
    const booted = await boot(cdp);
    const c1 = await DaemonClient.connect(booted.socket);
    const c2 = await DaemonClient.connect(booted.socket);
    try {
      await c2.request('page.state', {});
      const readP = c1.request('page.read', { local_storage: 'mode' }, { requestTimeoutMs: 20000 }).catch((e: any) => e);
      await new Promise((r) => setTimeout(r, 200));
      // read 挂起中：另一 socket 的 click 完整开始并结束（lastFinished 变化）
      await c2.request('page.click', { target: '[0]', intent: '点击' }, { requestTimeoutMs: 20000 });
      // 释放 read：最终核验发现 finished id 改变 → STALE_CONTEXT
      releaseRead?.();
      const readResult = await readP;
      expect(readResult).toMatchObject({ code: 'STALE_CONTEXT' });
      const obs = traceEvents().filter((e) => e.t === 'observation');
      expect((obs[0].result as any).error.code).toBe('STALE_CONTEXT');
    } finally {
      releaseRead?.();
      try { await c1.request('stop', {}, { requestTimeoutMs: 10000 }); } catch { /* 兼容资源清理 */ }
      c1.close();
      c2.close();
      try { await booted.done; } catch { /* keep-alive 已结束 */ }
    }
  }, 30000);

  it('page read 不产生 action 事件、不改变 lastFinishedActionId', async () => {
    const cdp = new PageDataCdp();
    cdp.storageEntries = [['mode', 'simple']];
    const booted = await boot(cdp);
    await runWith(booted, async (client) => {
      await client.request('page.open', { url: 'https://page.test/app', intent: '打开' }, { requestTimeoutMs: 10000 });
      await client.request('page.read', { local_storage: 'mode' });
      // page.read 之后 assert data 仍以 open 的 action 为 after
      const res = await client.request('assert.data', { local_storage: 'mode', equals: 'simple' }) as any;
      const events = traceEvents();
      const actions = events.filter((e) => e.t === 'action');
      expect(actions).toHaveLength(1);
      const obs = events.filter((e) => e.t === 'observation');
      expect(obs[0].after).toBe(actions[0].id);
      expect(res.pass).toBe(true);
    });
  }, 20000);

  it('global getter 不被执行(读取走协议,不调 getter)', async () => {
    const cdp = new PageDataCdp();
    cdp.globalProps = { gAcc: { get: { type: 'function' }, set: { type: 'function' } } };
    const booted = await boot(cdp);
    await runWith(booted, async (client) => {
      await expect(client.request('page.read', { global: 'gAcc' })).rejects.toMatchObject({ code: 'READ_UNSUPPORTED_TYPE' });
      expect(cdp.getterCalls).toBe(0);
    });
  }, 15000);
});
