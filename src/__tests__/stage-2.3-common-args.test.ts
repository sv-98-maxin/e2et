/**
 * 阶段 2.3 第三批：公共参数（--wait-* / --creates / --dialog / --frame / --save-as / --value-template / --value-ref）
 *
 * 覆盖 spec cli-spec.md 1.4 公共参数表 + trace-ir-spec.md 1.3/1.4 字段。
 * 复用 daemon-actions.test.ts 的 boot 模式，fake CDP 扩展 dialog/frame/text/url emit 能力。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DaemonClient } from '../daemon/client.js';
import { runDaemon } from '../daemon/daemon.js';
import type { BootstrapResult } from '../daemon/bootstrap.js';
import { resolveSocketPath, traceDir } from '../daemon/session-meta.js';
import { readTraceEvents } from '../daemon/trace.js';
import { BACKEND_PLACEHOLDER_CANDIDATES_FN } from '../browser/locator-query.js';

/** fake CDP：1 个 button 元素 + 子 frame + 可 emit dialog/text/url；frame 作用域按 frameId/contextId 分流 */
class CommonCdp {
  calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  closeCalled = false;
  dialogHandled: Array<{ accept: boolean; promptText?: string }> = [];
  /** 控制 body.innerText 与 location.href 的返回值（供 --wait-text/--wait-url 测试） */
  bodyText = '';
  locationHref = 'https://example.test/page';
  /** 点击时同步 emit 的弹窗（null=不弹）。设后 clickNode 触发 javascriptDialogOpening */
  dialogToEmit: { type: string; message: string } | null = null;
  /** frame isolated world（contextId=1）状态：frame 专属 body/AX/probe，供 --frame 作用域测试 */
  frameBodyText = '';
  frameHref = 'https://example.test/frame';
  /** frame 世界 body 文本读取抛错开关(只影响 wait_text 的 readText,不影响定位采集) */
  frameBodyEvalFails = false;
  frameProbe: { kind: 'none' | 'exact'; count: number; candidates: Array<{ text: string; path: string; role: string }>; clickable_texts: string[] } = { kind: 'none', count: 0, candidates: [], clickable_texts: [] };
  frameResolveObjectId = 'frame-text-el';
  /** DOM iframe 采集事实（主世界 querySelectorAll('iframe')）：默认与 CDP tree 子 frame 对齐 */
  domIframes: Array<{ name: string; src: string; id: string }> = [{ name: 'contentFrame', src: 'https://example.test/embed#edit', id: '' }];
  /** CDP frame tree 子 frame 的 Frame.name（可覆盖成与 DOM name 不同，验证不伪造 desc） */
  childFrameName = 'contentFrame';
  /** DOM.getFrameOwner 返回的 iframe owner backendNodeId */
  frameOwnerBackend = 30;
  /** collector desc selector 经 DOM.querySelectorAll/describeNode 解析的 backendNodeId */
  iframeBackend = 30;
  /** root DOM owner 的 DOM.describeNode.frameId */
  ownerFrameId = 'frame-child';
  /** root DOM owner 的 DOM.describeNode 协议拒绝开关 */
  ownerDescribeFails = false;
  private listeners = new Map<string, Array<(params: any) => void>>();
  private objectIdSeq = 0;
  private hitBackend = 0;
  /** fake 无真实 DOM：记录最后一次写值，供回读函数模拟“写入未被受控组件吞掉” */
  lastWritten = '';

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
    if (method === 'Input.insertText') { this.lastWritten = String(params.text ?? ''); return {} as T; }
    if (method === 'Input.dispatchKeyEvent' && params.type === 'char') { this.lastWritten += String(params.text ?? ''); return {} as T; }
    if (method === 'Input.dispatchKeyEvent' && params.key === 'Backspace') { this.lastWritten = ''; return {} as T; }
    if (method === 'Page.enable') return {} as T;
    if (method === 'Network.enable') return {} as T;
    if (method === 'Page.getFrameTree') {
      return {
        frameTree: {
          frame: { id: 'main', loaderId: '', url: 'https://example.test/page', securityOrigin: 'https://example.test', name: '' },
          childFrames: [{ frame: { id: 'frame-child', url: 'https://example.test/embed', urlFragment: '#edit', name: this.childFrameName, parentId: 'main' } }],
        },
      } as T;
    }
    if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: '1' } as T;
    if (method === 'Accessibility.getFullAXTree') {
      // frame 作用域（强制 frameId）返回 frame 世界 AX 树：同名“确定”不同 backend + frame 专属元素
      if (params.frameId === 'frame-child') {
        return { nodes: [
          { nodeId: 'fbtn', role: { type: 'role', value: 'button' }, name: { type: 'string', value: '确定' }, backendDOMNodeId: 200, ignored: false },
          { nodeId: 'fbtn2', role: { type: 'role', value: 'button' }, name: { type: 'string', value: 'frame-only-确定' }, backendDOMNodeId: 210, ignored: false },
        ] } as T;
      }
      return { nodes: [
        { nodeId: 'btn', role: { type: 'role', value: 'button' }, name: { type: 'string', value: '确定' }, backendDOMNodeId: 100, ignored: false },
      ] } as T;
    }
    if (method === 'DOM.resolveNode') return { object: { objectId: 'obj-' + (++this.objectIdSeq) } } as T;
    if (method === 'DOM.getContentQuads') { this.hitBackend = Number(params.backendNodeId); return { quads: [[10, 10, 20, 10, 20, 20, 10, 20]] } as T; }
    if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { pageX: 0, pageY: 0 } } as T;
    if (method === 'DOM.getNodeForLocation') return { backendNodeId: this.hitBackend } as T;
    if (method === 'DOM.getDocument') return { root: { nodeId: 1 } } as T;
    if (method === 'DOM.getFrameOwner') {
      if (params.frameId === 'frame-child') return { backendNodeId: this.frameOwnerBackend, nodeId: 1 } as T;
      throw new Error('CDP error: no such frame');
    }
    if (method === 'DOM.querySelectorAll') {
      // frame 世界根（nodeId 500）与主文档根（nodeId 1）分流；iframe owner selector 按 selector 分流
      if (params.nodeId === 500) return { nodeIds: [501] } as T;
      const sel = String(params.selector ?? '');
      if (sel === 'iframe[name="contentFrame"]') return { nodeIds: [11] } as T;
      if (sel === 'iframe#child-frame') return { nodeIds: [12] } as T;
      if (sel === 'iframe[name="dup-a"]' || sel === 'iframe[name="dup-b"]') return { nodeIds: [13] } as T;
      if (sel === 'iframe[name="multi"]') return { nodeIds: [14, 15] } as T;
      return { nodeIds: [10] } as T;
    }
    if (method === 'DOM.describeNode') {
      if (params.backendNodeId !== undefined) {
        if (this.ownerDescribeFails) throw new Error('CDP error: DOM.describeNode protocol error');
        return { node: { backendNodeId: Number(params.backendNodeId), ...(this.ownerFrameId ? { frameId: this.ownerFrameId } : {}) } } as T;
      }
      if (params.nodeId === 501) return { node: { backendNodeId: 200, nodeName: 'BUTTON' } } as T;
      if (params.objectId === 'frame-text-el') return { node: { backendNodeId: 250, nodeName: 'DIV' } } as T;
      // iframe owner selector 解析（matches>1 的 selector 只 describe 第一个，与真实 resolveSelector 一致）
      if ([11, 12, 13, 14].includes(Number(params.nodeId))) return { node: { backendNodeId: this.iframeBackend, nodeName: 'IFRAME' } } as T;
      if (params.objectId === 'main-frame-owner') return { node: { frameId: 'frame-child' } } as T;
      return { node: { backendNodeId: 100, nodeName: 'BUTTON' } } as T;
    }
    if (method === 'DOM.scrollIntoViewIfNeeded') return {} as T;
    if (method === 'Page.handleJavaScriptDialog') {
      this.dialogHandled.push({ accept: Boolean(params.accept), ...(params.promptText !== undefined ? { promptText: String(params.promptText) } : {}) });
      return {} as T;
    }
    if (method === 'Page.reload') return {} as T;
    if (method === 'Page.getNavigationHistory') return { currentIndex: 1, entries: [{ url: 'https://example.test/a' }] } as T;
    if (method === 'Page.navigateToHistoryEntry') return {} as T;
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 } as T;
    if (method === 'DOM.requestNode') {
      // 真实协议形状：顶层 nodeId
      if (params.objectId === 'frame-doc') return { nodeId: 500 } as T;
      return { nodeId: 42 } as T;
    }
    // Runtime.evaluate：frame isolated world（contextId=1）与主世界分流；主世界走同一套 evaluate 规则
    if (method === 'Runtime.evaluate') {
      if (params.contextId === undefined && String(params.expression ?? '').includes('frame owner 不唯一或已失效')) {
        return { result: { objectId: 'main-frame-owner' } } as T;
      }
      if (params.contextId === 1) {
        const expr = String(params.expression ?? '');
        // 协议拒绝只在 wait 的 body 读取抛(定位采集阶段正常,别在前置就全 evaluate 炸)
        if (this.frameBodyEvalFails && /document\.body\.innerText;?\s*$/.test(expr)) {
          throw new Error('CDP error: Cannot find context with specified id');
        }
        if (expr === 'document') return { result: { objectId: 'frame-doc' } } as T;
        if (expr.includes('return hits.length === 1 ? pick(hits[0]) : null')) {
          return { result: { objectId: this.frameResolveObjectId } } as T;
        }
        if (expr.includes('clickable_texts: hits.length')) {
          const wanted = /const want = ("(?:[^"\\]|\\.)*")/.exec(expr)?.[1];
          const value = wanted === '"确定"' ? this.textProbe : this.frameProbe;
          if (params.returnByValue === false) {
            return { result: { objectId: this.frameProbe.kind === 'exact' ? this.frameResolveObjectId : '' } } as T;
          }
          return { result: { value } } as T;
        }
        if (expr.includes('try { return observe(query(document') && params.contextId === 1) {
          return { result: { value: { matches: 0 } } } as T;
        }
        if (expr.includes('document.body.innerText')) return { result: { value: this.frameBodyText } } as T;
        if (expr.includes('location.href')) return { result: { value: this.frameHref } } as T;
        if (expr.includes('querySelector') || expr.includes('iframe')) return { result: { value: [] } } as T;
        return { result: { value: null } } as T;
      }
      const value = await this.evaluate<T>(String(params.expression ?? ''));
      return { result: { value } } as T;
    }
    if (method === 'Runtime.callFunctionOn') {
      const fd = String(params.functionDeclaration ?? '');
      if (fd === BACKEND_PLACEHOLDER_CANDIDATES_FN) return { result: { value: [] } } as T;
      if (params.returnByValue === false && fd.includes('isElementVisible')) return { result: { type: 'function', objectId: 'snapshot-visibility-fn' } } as T;
      if (fd.includes('return this(element)')) return { result: { value: { connected: true, visible: true } } } as T;
      if (params.returnByValue === false && fd.includes('function resolveWriteTarget')) return { result: { type: 'object', objectId: 'input-leaf' } } as T;
      if (fd.includes('function prepareWriteTarget')) { this.lastWritten = ''; return { result: { value: 'text' } } as T; }
      if (fd.includes('function assertWriteReady')) return { result: { value: 'text' } } as T;
      if (fd.includes('function readWriteTarget')) return { result: { value: this.lastWritten } } as T;
      if (fd.includes('isConnected')) return { result: { value: { connected: true, visible: true } } } as T;
      if (fd.includes('disabled === true') || fd.includes('aria-disabled')) return { result: { value: null } } as T;
      // READ_ELEMENT_VALUE_FN：回读最后写入值（fake 用写入记录模拟真实 DOM 未被吞值）
      if (fd.includes('inner.value')) return { result: { value: this.lastWritten } } as T;
      return { result: { value: true } } as T;
    }
    if (method === 'Network.getResponseBody') return { body: '{"ok":true}' } as T;
    if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased' && this.dialogToEmit) {
      const dialog = this.dialogToEmit;
      this.dialogToEmit = null;
      queueMicrotask(() => this.emit('Page.javascriptDialogOpening', { type: dialog.type, message: dialog.message }));
    }
    return {} as T;
  }

  async evaluate<T = any>(expression: string): Promise<T> {
    if (expression.includes('clickable_texts: hits.length')) {
      const wanted = /const want = ("(?:[^"\\]|\\.)*")/.exec(expression)?.[1];
      return (wanted === '"确定"' ? this.textProbe : this.frameProbe) as T;
    }
    if (expression.includes('return hits.length === 1 ? pick(hits[0]) : null')) {
      return { result: { objectId: this.frameResolveObjectId } } as unknown as T;
    }
    // DOM iframe 采集事实（collectIframeDescs）：先于通用 querySelector 分支
    if (expression.includes("querySelectorAll('iframe')")) return this.domIframes as T;
    if (expression.includes('window.innerWidth')) return { width: 1280, height: 720, deviceScaleFactor: 2 } as T;
    if (expression.includes('readyState')) return 'complete' as T;
    if (expression.includes('__e2etChangeCount')) return 0 as T;
    if (expression.includes('__e2etObserver')) return true as T;
    if (expression.includes('location.href')) return this.locationHref as T;
    if (expression.includes('document.body.innerText')) return this.bodyText as T;
    if (expression.includes('activeElement') || expression.includes('dispatchEvent') || expression.includes('KeyboardEvent')) return 'ok' as T;
    if (expression.includes('function() { const module') && expression.includes('return observe(query(document')) {
      return { matches: 1, role: 'button', name: '确定', visible: true } as T;
    }
    if (expression.includes('querySelector')) return '' as T;
    return '' as T;
  }
  private textProbe = { kind: 'none', count: 0, candidates: [], clickable_texts: [] };

  emit(method: string, params: any): void {
    for (const handler of this.listeners.get(method) ?? []) handler(params);
  }
}

describe('公共参数（阶段 2.3 第三批）', () => {
  let home: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.E2ET_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'common-args-'));
    process.env.E2ET_HOME = home;
  });
  afterEach(() => {
    if (previousHome === undefined) delete process.env.E2ET_HOME;
    else process.env.E2ET_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  async function boot(cdp: CommonCdp, id: string): Promise<{ socket: string; done: Promise<void> }> {
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

  // ── --wait-api ──

  it('--wait-api 命中 path → settled_by 含 request + ms', async () => {
    const sid = 'com-' + Math.random().toString(36).slice(2, 8);
    const cdp = new CommonCdp();
    const { socket, done } = await boot(cdp, sid);
    try {
      const client = await DaemonClient.connect(socket);
      await client.request('page.state', {});
      // click 后立即 emit 一个 path 匹配的请求
      setTimeout(() => {
        cdp.emit('Network.requestWillBeSent', { requestId: 'xhr-1', frameId: 'main', type: 'XHR', wallTime: Date.now() / 1000, request: { url: 'https://example.test/api/save', method: 'POST', headers: {} } });
        cdp.emit('Network.responseReceived', { requestId: 'xhr-1', response: { status: 200, mimeType: 'application/json', headers: {} } });
        cdp.emit('Network.loadingFinished', { requestId: 'xhr-1' });
      }, 50);
      const res = await client.request('page.click', {
        target: '[0]', intent: '点击触发保存', snapshot_change_count: 0,
        wait_api: '/api/save',
      }) as any;
      expect(res.ok ?? true).toBe(true);
      const reqSettled = (res.settled_by ?? []).filter((s: any) => s.kind === 'request');
      expect(reqSettled.length).toBeGreaterThan(0);
      expect(reqSettled[0].ref).toMatch(/^r\d+$/);
      await client.request('stop', {});
      client.close();
    } finally { try { await done; } catch {} }
  }, 15000);

  it('--wait-api 超时 → WAIT_TIMEOUT 失败', async () => {
    const sid = 'com-' + Math.random().toString(36).slice(2, 8);
    const cdp = new CommonCdp();
    const { socket, done } = await boot(cdp, sid);
    try {
      const client = await DaemonClient.connect(socket);
      await client.request('page.state', {});
      // 不 emit 任何请求 → wait_api 等不到；声明小预算 1000ms 快速超时（新契约：缺省 30s）
      await expect(client.request('page.click', {
        target: '[0]', intent: '点击', snapshot_change_count: 0,
        wait_api: '/api/never',
        wait_timeout_ms: 1000,
      })).rejects.toMatchObject({ code: 'WAIT_TIMEOUT' });
      try { await client.request('stop', {}); } catch {}
      client.close();
    } finally { try { await done; } catch {} }
  }, 20000);

  // ── --wait-text ──

  it('--wait-text 出现即解；超时 → WAIT_TIMEOUT', async () => {
    const sid = 'com-' + Math.random().toString(36).slice(2, 8);
    const cdp = new CommonCdp();
    const { socket, done } = await boot(cdp, sid);
    try {
      const client = await DaemonClient.connect(socket);
      await client.request('page.state', {});
      // 50ms 后 body 出现目标文本
      setTimeout(() => { cdp.bodyText = '保存成功'; }, 50);
      const res = await client.request('page.click', {
        target: '[0]', intent: '点击保存', snapshot_change_count: 0,
        wait_text: '保存成功',
      }) as any;
      expect(res.ok ?? true).toBe(true);
      const textSettled = (res.settled_by ?? []).filter((s: any) => s.kind === 'text');
      expect(textSettled.length).toBeGreaterThan(0);
      expect(textSettled[0].text).toBe('保存成功');
      try { await client.request('stop', {}); } catch {}
      client.close();
    } finally { try { await done; } catch {} }
  }, 15000);

  // ── --wait-url ──

  it('--wait-url 命中 → settled_by 含 url', async () => {
    const sid = 'com-' + Math.random().toString(36).slice(2, 8);
    const cdp = new CommonCdp();
    const { socket, done } = await boot(cdp, sid);
    try {
      const client = await DaemonClient.connect(socket);
      await client.request('page.state', {});
      setTimeout(() => { cdp.locationHref = 'https://example.test/result'; }, 50);
      const res = await client.request('page.click', {
        target: '[0]', intent: '点击跳转', snapshot_change_count: 0,
        wait_url: '/result',
      }) as any;
      expect(res.ok ?? true).toBe(true);
      const urlSettled = (res.settled_by ?? []).filter((s: any) => s.kind === 'url');
      expect(urlSettled.length).toBeGreaterThan(0);
      expect(urlSettled[0].url).toBe('/result');
      try { await client.request('stop', {}); } catch {}
      client.close();
    } finally { try { await done; } catch {} }
  }, 15000);

  // ── --creates ──

  it('--creates 仅 path 匹配的请求带 creates', async () => {
    const sid = 'com-' + Math.random().toString(36).slice(2, 8);
    const cdp = new CommonCdp();
    const { socket, done } = await boot(cdp, sid);
    try {
      const client = await DaemonClient.connect(socket);
      await client.request('page.state', {});
      setTimeout(() => {
        // path 匹配的提交请求
        cdp.emit('Network.requestWillBeSent', { requestId: 'r-submit', frameId: 'main', type: 'XHR', wallTime: Date.now() / 1000, request: { url: 'https://example.test/api/item/publish/commit.json', method: 'POST', headers: {} } });
        cdp.emit('Network.responseReceived', { requestId: 'r-submit', response: { status: 200, mimeType: 'application/json', headers: {} } });
        cdp.emit('Network.loadingFinished', { requestId: 'r-submit' });
        // path 不匹配的校验请求
        cdp.emit('Network.requestWillBeSent', { requestId: 'r-check', frameId: 'main', type: 'XHR', wallTime: Date.now() / 1000, request: { url: 'https://example.test/api/validate.json', method: 'POST', headers: {} } });
        cdp.emit('Network.responseReceived', { requestId: 'r-check', response: { status: 200, mimeType: 'application/json', headers: {} } });
        cdp.emit('Network.loadingFinished', { requestId: 'r-check' });
      }, 50);
      const res = await client.request('page.click', {
        target: '[0]', intent: '提交创建', snapshot_change_count: 0,
        creates: { entity: 'item', path: '/api/item/publish/commit.json' },
      }) as any;
      expect(res.ok ?? true).toBe(true);
      // 读 trace：提交请求带 creates=item，校验请求不带
      const events = readTraceEvents(sid).filter((e: any) => e.t === 'request');
      const submit = events.find((e: any) => e.path === '/api/item/publish/commit.json');
      const check = events.find((e: any) => e.path === '/api/validate.json');
      expect(submit?.creates).toBe('item');
      expect(check?.creates).toBeUndefined();
      try { await client.request('stop', {}); } catch {}
      client.close();
    } finally { try { await done; } catch {} }
  }, 15000);

  // ── --dialog ──

  it('--dialog accept 预登记 → handleJavaScriptDialog accept=true + trace registered=true', async () => {
    const sid = 'com-' + Math.random().toString(36).slice(2, 8);
    const cdp = new CommonCdp();
    const { socket, done } = await boot(cdp, sid);
    try {
      const client = await DaemonClient.connect(socket);
      await client.request('page.state', {});
      // click 期间弹 confirm
      cdp.dialogToEmit = { type: 'confirm', message: '确认提交？' };
      const res = await client.request('page.click', {
        target: '[0]', intent: '点击提交', snapshot_change_count: 0,
        dialog: { accept: true },
      }) as any;
      expect(cdp.dialogHandled).toHaveLength(1);
      expect(cdp.dialogHandled[0].accept).toBe(true);
      expect(res.dialog).toMatchObject({ registered: true, kind: 'confirm' });
      const dialogEvents = readTraceEvents(sid).filter((e: any) => e.t === 'dialog');
      expect(dialogEvents).toHaveLength(1);
      expect(dialogEvents[0]).toMatchObject({ handled: 'accept', registered: true });
      try { await client.request('stop', {}); } catch {}
      client.close();
    } finally { try { await done; } catch {} }
  }, 15000);

  it('未登记弹窗 → 自动 dismiss + trace registered=false + 命令返回 dialog 提示', async () => {
    const sid = 'com-' + Math.random().toString(36).slice(2, 8);
    const cdp = new CommonCdp();
    const { socket, done } = await boot(cdp, sid);
    try {
      const client = await DaemonClient.connect(socket);
      await client.request('page.state', {});
      cdp.dialogToEmit = { type: 'alert', message: '请先登录' };
      const res = await client.request('page.click', {
        target: '[0]', intent: '点击', snapshot_change_count: 0,
      }) as any;
      expect(cdp.dialogHandled).toHaveLength(1);
      expect(cdp.dialogHandled[0].accept).toBe(false);
      expect(res.dialog).toMatchObject({ registered: false, kind: 'alert' });
      const dialogEvents = readTraceEvents(sid).filter((e: any) => e.t === 'dialog');
      expect(dialogEvents[0]).toMatchObject({ handled: 'dismiss', registered: false });
      try { await client.request('stop', {}); } catch {}
      client.close();
    } finally { try { await done; } catch {} }
  }, 15000);

  // ── --frame ──

  it('--frame name 精确匹配 → frame_resolved 返回 frameId', async () => {
    const sid = 'com-' + Math.random().toString(36).slice(2, 8);
    const cdp = new CommonCdp();
    const { socket, done } = await boot(cdp, sid);
    try {
      const client = await DaemonClient.connect(socket);
      await client.request('page.state', {});
      const res = await client.request('page.click', {
        target: 'text=确定', intent: '在 iframe 内点击', snapshot_change_count: 0,
        frame: 'contentFrame',
      }) as any;
      expect(res.ok ?? true).toBe(true);
      expect(res.frame_resolved).toBe('frame-child');
      try { await client.request('stop', {}); } catch {}
      client.close();
    } finally { try { await done; } catch {} }
  }, 15000);

  it('--frame + [N] index → BAD_REQUEST', async () => {
    const sid = 'com-' + Math.random().toString(36).slice(2, 8);
    const cdp = new CommonCdp();
    const { socket, done } = await boot(cdp, sid);
    try {
      const client = await DaemonClient.connect(socket);
      await client.request('page.state', {});
      await expect(client.request('page.click', {
        target: '[0]', intent: '在 iframe 内点击', snapshot_change_count: 0,
        frame: 'contentFrame',
      })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      try { await client.request('stop', {}); } catch {}
      client.close();
    } finally { try { await done; } catch {} }
  }, 15000);

  it('--frame url 含 hash fragment → frame_resolved 返回 frameId（子 frame url 带 fragment）', async () => {
    const sid = 'com-' + Math.random().toString(36).slice(2, 8);
    const cdp = new CommonCdp();
    const { socket, done } = await boot(cdp, sid);
    const client = await DaemonClient.connect(socket);
    try {
      await client.request('page.state', {});
      const res = await client.request('page.click', {
        target: 'text=确定', intent: '在 hash iframe 内点击', snapshot_change_count: 0,
        frame: '#edit',
      }) as any;
      expect(res.ok ?? true).toBe(true);
      expect(res.frame_resolved).toBe('frame-child');
    } finally {
      try { await client.request('stop', {}); } catch {}
      client.close();
      try { await done; } catch {}
    }
  }, 15000);

  it('--frame 找不到 → BAD_FRAME', async () => {
    const sid = 'com-' + Math.random().toString(36).slice(2, 8);
    const cdp = new CommonCdp();
    const { socket, done } = await boot(cdp, sid);
    try {
      const client = await DaemonClient.connect(socket);
      await client.request('page.state', {});
      await expect(client.request('page.click', {
        target: '[0]', intent: '点', snapshot_change_count: 0,
        frame: 'not-exist',
      })).rejects.toMatchObject({ code: 'BAD_FRAME' });
      try { await client.request('stop', {}); } catch {}
      client.close();
    } finally { try { await done; } catch {} }
  }, 15000);

  // ── --frame：desc 必须来自实际 DOM owner（P3 回放事实）──

  it('--frame 传 id 推导 selector → desc 保留真实 DOM selector/name，不伪造', async () => {
    const sid = 'com-' + Math.random().toString(36).slice(2, 8);
    const cdp = new CommonCdp();
    // 真实事实：DOM iframe 无 name 属性、id 推导 selector（与 CDP Frame.name 无关）
    cdp.domIframes = [{ name: '', src: 'https://example.test/iframe-child.html', id: 'child-frame' }];
    const { socket, done } = await boot(cdp, sid);
    const client = await DaemonClient.connect(socket);
    try {
      await client.request('page.state', {});
      const res = await client.request('page.click', {
        target: 'text=确定', intent: '在 id iframe 内点击', snapshot_change_count: 0,
        frame: 'iframe#child-frame',
      }) as any;
      expect(res.ok ?? true).toBe(true);
      expect(res.frame_resolved).toBe('frame-child');
      const actionEvents = readTraceEvents(sid).filter((e: any) => e.t === 'action' && e.frame);
      expect(actionEvents[0]?.frame?.[0]).toEqual({ name: '', url_contains: '/iframe-child.html', selector: 'iframe#child-frame' });
    } finally {
      try { await client.request('stop', {}); } catch {}
      client.close();
      try { await done; } catch {}
    }
  }, 15000);

  it('--frame 传 CDP Frame.name（与 DOM name 不同）→ desc 来自 collector 真实 selector，不伪造 iframe[name]', async () => {
    const sid = 'com-' + Math.random().toString(36).slice(2, 8);
    const cdp = new CommonCdp();
    cdp.childFrameName = 'child-frame';
    cdp.domIframes = [{ name: '', src: 'https://example.test/iframe-child.html', id: 'child-frame' }];
    const { socket, done } = await boot(cdp, sid);
    const client = await DaemonClient.connect(socket);
    try {
      await client.request('page.state', {});
      const res = await client.request('page.click', {
        target: 'text=确定', intent: '在子 frame 点击', snapshot_change_count: 0,
        frame: 'child-frame',
      }) as any;
      expect(res.ok ?? true).toBe(true);
      expect(res.frame_resolved).toBe('frame-child');
      // desc 来自 collector（name 为空、selector 用 id 推导），不是从 CDP name 伪造的 iframe[name="child-frame"]
      const actionEvents = readTraceEvents(sid).filter((e: any) => e.t === 'action' && e.frame);
      expect(actionEvents[0]?.frame?.[0]).toEqual({ name: '', url_contains: '/iframe-child.html', selector: 'iframe#child-frame' });
    } finally {
      try { await client.request('stop', {}); } catch {}
      client.close();
      try { await done; } catch {}
    }
  }, 15000);

  it('--frame 传 url（DOM url_contains 层）→ desc 保留真实 selector，不用 CDP name 兑底伪造', async () => {
    const sid = 'com-' + Math.random().toString(36).slice(2, 8);
    const cdp = new CommonCdp();
    cdp.domIframes = [{ name: '', src: 'https://example.test/iframe-child.html', id: 'child-frame' }];
    const { socket, done } = await boot(cdp, sid);
    const client = await DaemonClient.connect(socket);
    try {
      await client.request('page.state', {});
      const res = await client.request('page.click', {
        target: 'text=确定', intent: '在 url iframe 内点击', snapshot_change_count: 0,
        frame: '/iframe-child.html',
      }) as any;
      expect(res.ok ?? true).toBe(true);
      expect(res.frame_resolved).toBe('frame-child');
      const actionEvents = readTraceEvents(sid).filter((e: any) => e.t === 'action' && e.frame);
      expect(actionEvents[0]?.frame?.[0]).toEqual({ name: '', url_contains: '/iframe-child.html', selector: 'iframe#child-frame' });
    } finally {
      try { await client.request('stop', {}); } catch {}
      client.close();
      try { await done; } catch {}
    }
  }, 15000);

  it('--frame DOM 匹配但 owner 不对齐 → BAD_FRAME（不猜）', async () => {
    const sid = 'com-' + Math.random().toString(36).slice(2, 8);
    const cdp = new CommonCdp();
    cdp.domIframes = [{ name: '', src: 'https://example.test/iframe-child.html', id: 'child-frame' }];
    cdp.ownerFrameId = 'other-frame';
    const { socket, done } = await boot(cdp, sid);
    const client = await DaemonClient.connect(socket);
    try {
      await client.request('page.state', {});
      await expect(client.request('page.click', {
        target: 'text=确定', intent: '在 iframe 内点击', snapshot_change_count: 0,
        frame: 'iframe#child-frame',
      })).rejects.toMatchObject({ code: 'BAD_FRAME' });
    } finally {
      try { await client.request('stop', {}); } catch {}
      client.close();
      try { await done; } catch {}
    }
  }, 15000);

  it('--frame owner backend 为 0（非正整数）→ BAD_FRAME，不能对齐成功', async () => {
    const sid = 'com-' + Math.random().toString(36).slice(2, 8);
    const cdp = new CommonCdp();
    cdp.domIframes = [{ name: '', src: 'https://example.test/iframe-child.html', id: 'child-frame' }];
    cdp.iframeBackend = 0;
    const { socket, done } = await boot(cdp, sid);
    const client = await DaemonClient.connect(socket);
    try {
      await client.request('page.state', {});
      await expect(client.request('page.click', {
        target: 'text=确定', intent: '在 iframe 内点击', snapshot_change_count: 0,
        frame: 'iframe#child-frame',
      })).rejects.toMatchObject({ code: 'BAD_FRAME' });
    } finally {
      try { await client.request('stop', {}); } catch {}
      client.close();
      try { await done; } catch {}
    }
  }, 15000);

  it('--frame CDP name 兑底时多个 collector desc 对齐同一 owner → BAD_FRAME（歧义不选）', async () => {
    const sid = 'com-' + Math.random().toString(36).slice(2, 8);
    const cdp = new CommonCdp();
    cdp.childFrameName = 'dup-frame';
    cdp.domIframes = [
      { name: 'dup-a', src: 'https://example.test/a.html', id: '' },
      { name: 'dup-b', src: 'https://example.test/b.html', id: '' },
    ];
    const { socket, done } = await boot(cdp, sid);
    const client = await DaemonClient.connect(socket);
    try {
      await client.request('page.state', {});
      await expect(client.request('page.click', {
        target: 'text=确定', intent: '在 iframe 内点击', snapshot_change_count: 0,
        frame: 'dup-frame',
      })).rejects.toMatchObject({ code: 'BAD_FRAME' });
    } finally {
      try { await client.request('stop', {}); } catch {}
      client.close();
      try { await done; } catch {}
    }
  }, 15000);

  it('--frame DOM 层同名多候选 → BAD_FRAME（不任选第一个）', async () => {
    const sid = 'com-' + Math.random().toString(36).slice(2, 8);
    const cdp = new CommonCdp();
    cdp.domIframes = [
      { name: 'dup', src: 'https://example.test/a.html', id: '' },
      { name: 'dup', src: 'https://example.test/b.html', id: '' },
    ];
    const { socket, done } = await boot(cdp, sid);
    const client = await DaemonClient.connect(socket);
    try {
      await client.request('page.state', {});
      await expect(client.request('page.click', {
        target: 'text=确定', intent: '在 iframe 内点击', snapshot_change_count: 0,
        frame: 'dup',
      })).rejects.toMatchObject({ code: 'BAD_FRAME' });
    } finally {
      try { await client.request('stop', {}); } catch {}
      client.close();
      try { await done; } catch {}
    }
  }, 15000);

  it('--frame selector 命中多个节点（matches>1）→ BAD_FRAME', async () => {
    const sid = 'com-' + Math.random().toString(36).slice(2, 8);
    const cdp = new CommonCdp();
    cdp.domIframes = [{ name: 'multi', src: 'https://example.test/multi.html', id: '' }];
    const { socket, done } = await boot(cdp, sid);
    const client = await DaemonClient.connect(socket);
    try {
      await client.request('page.state', {});
      await expect(client.request('page.click', {
        target: 'text=确定', intent: '在 iframe 内点击', snapshot_change_count: 0,
        frame: 'iframe[name="multi"]',
      })).rejects.toMatchObject({ code: 'BAD_FRAME' });
    } finally {
      try { await client.request('stop', {}); } catch {}
      client.close();
      try { await done; } catch {}
    }
  }, 15000);

  it('--frame owner 协议错误传播为 DAEMON_ERROR，不当无匹配吞掉', async () => {
    const sid = 'com-' + Math.random().toString(36).slice(2, 8);
    const cdp = new CommonCdp();
    cdp.domIframes = [{ name: '', src: 'https://example.test/iframe-child.html', id: 'child-frame' }];
    cdp.ownerDescribeFails = true;
    const { socket, done } = await boot(cdp, sid);
    const client = await DaemonClient.connect(socket);
    try {
      await client.request('page.state', {});
      await expect(client.request('page.click', {
        target: 'text=确定', intent: '在 iframe 内点击', snapshot_change_count: 0,
        frame: 'iframe#child-frame',
      })).rejects.toMatchObject({ code: 'DAEMON_ERROR' });
    } finally {
      try { await client.request('stop', {}); } catch {}
      client.close();
      try { await done; } catch {}
    }
  }, 15000);


  // ── --save-as / --value-template / --value-ref ──

  it('--value-template 渲染 ${ts}/${random} → 写入 args.value origin=generated', async () => {
    const sid = 'com-' + Math.random().toString(36).slice(2, 8);
    const cdp = new CommonCdp();
    const { socket, done } = await boot(cdp, sid);
    try {
      const client = await DaemonClient.connect(socket);
      await client.request('page.state', {});
      const res = await client.request('page.fill', {
        target: '[0]', value_template: 'E2E商品_${ts}', intent: '填名称', snapshot_change_count: 0,
      }) as any;
      expect(res.ok ?? true).toBe(true);
      // trace action.value.origin = generated
      const actionEvents = readTraceEvents(sid).filter((e: any) => e.t === 'action' && e.kind === 'fill');
      expect(actionEvents[0]?.value?.origin).toBe('generated');
      expect(actionEvents[0]?.value?.template).toBe('E2E商品_${ts}');
      expect(actionEvents[0]?.value?.raw).toMatch(/^E2E商品_\d+$/);
      try { await client.request('stop', {}); } catch {}
      client.close();
    } finally { try { await done; } catch {} }
  }, 15000);

  it('--save-as 存变量 → 后续 --value-ref 取到同一值', async () => {
    const sid = 'com-' + Math.random().toString(36).slice(2, 8);
    const cdp = new CommonCdp();
    const { socket, done } = await boot(cdp, sid);
    try {
      const client = await DaemonClient.connect(socket);
      await client.request('page.state', {});
      const r1 = await client.request('page.fill', {
        target: '[0]', value: 'myname', intent: '填名称', snapshot_change_count: 0,
        save_as: 'itemName',
      }) as any;
      expect(r1.saved).toMatchObject({ name: 'itemName', value: 'myname' });
      // 用 value_ref 引用
      const r2 = await client.request('page.fill', {
        target: '[0]', value_ref: 'itemName', intent: '再填', snapshot_change_count: 0,
      }) as any;
      expect(r2.ok ?? true).toBe(true);
      try { await client.request('stop', {}); } catch {}
      client.close();
    } finally { try { await done; } catch {} }
  }, 15000);

  it('--value-ref 未定义变量 → BAD_REQUEST', async () => {
    const sid = 'com-' + Math.random().toString(36).slice(2, 8);
    const cdp = new CommonCdp();
    const { socket, done } = await boot(cdp, sid);
    try {
      const client = await DaemonClient.connect(socket);
      await client.request('page.state', {});
      await expect(client.request('page.fill', {
        target: '[0]', value_ref: 'nope', intent: '填', snapshot_change_count: 0,
      })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      try { await client.request('stop', {}); } catch {}
      client.close();
    } finally { try { await done; } catch {} }
  }, 15000);
});

describe('frame 作用域集成反例（P3）', () => {
  let home: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.E2ET_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'common-args-'));
    process.env.E2ET_HOME = home;
  });
  afterEach(() => {
    if (previousHome === undefined) delete process.env.E2ET_HOME;
    else process.env.E2ET_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  async function boot(cdp: CommonCdp, id: string): Promise<{ socket: string; done: Promise<void> }> {
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

  const sid = (): string => 'com-' + Math.random().toString(36).slice(2, 8);

  it('主/frame 同名不同 backend：frame 内点击命中 frame 的 backend（200）而非主文档（100）', async () => {
    const cdp = new CommonCdp();
    const { socket, done } = await boot(cdp, sid());
    try {
      const client = await DaemonClient.connect(socket);
      try {
        await client.request('page.state', {});
        const res = await client.request('page.click', {
          target: 'text=确定', intent: 'iframe 内点确定', snapshot_change_count: 0,
          frame: 'contentFrame',
        }) as any;
        expect(res.ok ?? true).toBe(true);
        const clickSeq = cdp.calls.map((c) => c.method).lastIndexOf('Input.dispatchMouseEvent');
        expect(clickSeq).toBeGreaterThan(-1);
        const lastResolve = cdp.calls.slice(0, clickSeq).filter((c) => c.method === 'DOM.resolveNode').at(-1)?.params?.backendNodeId;
        expect(lastResolve).toBe(200);
      } finally {
        try { await client.request('stop', {}); } catch {}
        client.close();
      }
    } finally { try { await done; } catch {} }
  }, 15000);

  it('CSS 定位在 frame 作用域内命中：frame 世界 document 根 → querySelectorAll → backend 200', async () => {
    const cdp = new CommonCdp();
    const { socket, done } = await boot(cdp, sid());
    try {
      const client = await DaemonClient.connect(socket);
      try {
        await client.request('page.state', {});
        const res = await client.request('page.click', {
          target: 'css=.frame-btn', intent: 'iframe 内 CSS', snapshot_change_count: 0,
          frame: 'contentFrame',
        }) as any;
        expect(res.ok ?? true).toBe(true);
        // frame 世界 DOM.getDocument 走真实协议链：Runtime.evaluate('document') + DOM.requestNode
        expect(cdp.calls.some((c) => c.method === 'DOM.requestNode' && c.params?.objectId === 'frame-doc')).toBe(true);
        expect(cdp.calls.some((c) => c.method === 'DOM.querySelectorAll' && c.params?.nodeId === 500)).toBe(true);
        const resolveNodeCalls = cdp.calls.filter((c) => c.method === 'DOM.resolveNode');
        expect(resolveNodeCalls.some((c) => c.params?.backendNodeId === 200)).toBe(true);
      } finally {
        try { await client.request('stop', {}); } catch {}
        client.close();
      }
    } finally { try { await done; } catch {} }
  }, 15000);

  it('raw DOM-text 定位在 frame 作用域内命中：AX 未命中后回退 frame 世界文本探测', async () => {
    const cdp = new CommonCdp();
    cdp.frameProbe = { kind: 'exact', count: 1, candidates: [{ text: '专属按钮', path: 'div.clickable', role: 'button' }], clickable_texts: [] };
    const { socket, done } = await boot(cdp, sid());
    try {
      const client = await DaemonClient.connect(socket);
      try {
        await client.request('page.state', {});
        const res = await client.request('page.click', {
          target: 'text=专属按钮', intent: 'iframe 内 DOM 文本', snapshot_change_count: 0,
          frame: 'contentFrame',
        }) as any;
        expect(res.ok ?? true).toBe(true);
        // 文本探测在 frame 世界（contextId=1）真实执行，句柄链到 backend 250
        expect(cdp.calls.some((c) => c.method === 'DOM.describeNode' && c.params?.objectId === 'frame-text-el')).toBe(true);
        const resolveNodeCalls = cdp.calls.filter((c) => c.method === 'DOM.resolveNode');
        expect(resolveNodeCalls.some((c) => c.params?.backendNodeId === 250)).toBe(true);
      } finally {
        try { await client.request('stop', {}); } catch {}
        client.close();
      }
    } finally { try { await done; } catch {} }
  }, 15000);

  it('frame-only text 等待成功（readText 读 frame 世界）', async () => {
    const cdp = new CommonCdp();
    cdp.frameBodyText = '提交完成';
    const { socket, done } = await boot(cdp, sid());
    try {
      const client = await DaemonClient.connect(socket);
      try {
        await client.request('page.state', {});
        const res = await client.request('page.click', {
          target: 'text=确定', intent: 'iframe 内等待 frame 文本', snapshot_change_count: 0,
          frame: 'contentFrame', wait_text: '提交完成',
        }) as any;
        expect(res.ok ?? true).toBe(true);
        const textSettled = (res.settled_by ?? []).filter((s: any) => s.kind === 'text');
        expect(textSettled.length).toBeGreaterThan(0);
        // frame 世界（contextId=1）真实读取了 body 文本，主世界未被读
        const evals = cdp.calls.filter((c) => c.method === 'Runtime.evaluate' && String(c.params?.expression ?? '').includes('document.body.innerText'));
        expect(evals.some((c) => c.params?.contextId === 1)).toBe(true);
        expect(evals.every((c) => c.params?.contextId === 1)).toBe(true);
      } finally {
        try { await client.request('stop', {}); } catch {}
        client.close();
      }
    } finally { try { await done; } catch {} }
  }, 15000);

  it('main-only 不能成功：主文档无 frame 文本 → 等待超时失败', async () => {
    const cdp = new CommonCdp();
    cdp.bodyText = '主文档文本';
    cdp.frameBodyText = '';
    const { socket, done } = await boot(cdp, sid());
    try {
      const client = await DaemonClient.connect(socket);
      try {
        await client.request('page.state', {});
        await expect(client.request('page.click', {
          target: 'text=确定', intent: 'iframe 内等 frame 专属文本', snapshot_change_count: 0,
          frame: 'contentFrame', wait_text: '只在主文档的文本', wait_timeout_ms: 500,
        })).rejects.toMatchObject({ code: 'WAIT_TIMEOUT' });
      } finally {
        try { await client.request('stop', {}); } catch {}
        client.close();
      }
    } finally { try { await done; } catch {} }
  }, 15000);

  it('真 gone 成功：wait_gone 目标真实缺席（TargetNotFoundError）→ settled_by 含 element_gone', async () => {
    const cdp = new CommonCdp();
    cdp.frameProbe = { kind: 'none', count: 0, candidates: [], clickable_texts: [] };
    const { socket, done } = await boot(cdp, sid());
    try {
      const client = await DaemonClient.connect(socket);
      try {
        await client.request('page.state', {});
        const res = await client.request('page.click', {
          target: 'text=确定', intent: 'iframe 内等元素消失', snapshot_change_count: 0,
          frame: 'contentFrame', wait_gone: 'text=已被移除的元素',
        }) as any;
        expect(res.ok ?? true).toBe(true);
        const goneSettled = (res.settled_by ?? []).filter((s: any) => s.kind === 'element_gone');
        expect(goneSettled.length).toBeGreaterThan(0);
      } finally {
        try { await client.request('stop', {}); } catch {}
        client.close();
      }
    } finally { try { await done; } catch {} }
  }, 15000);

  it('wait_gone 失效 ref（InvalidRefError）不算 gone：拒绝而非假成功', async () => {
    const cdp = new CommonCdp();
    const sessionId = sid();
    const { socket, done } = await boot(cdp, sessionId);
    let events: any[] = [];
    try {
      const client = await DaemonClient.connect(socket);
      try {
        await client.request('page.state', {});
        // [99] 是不存在的 ref：InvalidRefError 是输入错误，不得被 resolveGone 吞成 gone 成功
        await expect(client.request('page.click', {
          target: 'text=确定', intent: '等失效 ref', snapshot_change_count: 0,
          wait_gone: '[99]', wait_timeout_ms: 500,
        })).rejects.toMatchObject({
          code: 'BAD_REQUEST',
          message: '等待 ref 已失效或跨 tab',
        });
      } finally {
        try { await client.request('stop', {}); } catch {}
        client.close();
      }
    } finally {
      try { await done; } catch (error) { throw error; }
      events = readTraceEvents(sessionId);
    }
    expect(events.some((e: any) => e.t === 'session' && e.session_id === sessionId)).toBe(true);
    expect(events.some((e: any) => e.t === 'session_end')).toBe(true);
    expect(events.some((e: any) => e.t === 'action' && e.kind === 'click')).toBe(false);
  }, 15000);

  it('context destroyed / 协议拒绝失败：frame readText 抛 CDP 错 → DAEMON_ERROR 向上传递（不吞成超时）', async () => {
    const cdp = new CommonCdp();
    cdp.frameBodyEvalFails = true;
    const { socket, done } = await boot(cdp, sid());
    try {
      const client = await DaemonClient.connect(socket);
      try {
        await client.request('page.state', {});
        // readText 协议拒绝从 pollUntil/settleWithin 一路上抛:不是 WAIT_TIMEOUT 超时,是 DAEMON_ERROR
        await expect(client.request('page.click', {
          target: 'text=确定', intent: 'frame 世界已销毁', snapshot_change_count: 0,
          frame: 'contentFrame', wait_text: '任何文本', wait_timeout_ms: 500,
        })).rejects.toMatchObject({ code: 'DAEMON_ERROR', message: expect.stringContaining('Cannot find context') });
      } finally {
        try { await client.request('stop', {}); } catch {}
        client.close();
      }
    } finally { try { await done; } catch {} }
  }, 15000);

  it('wait_element 的 [N] 索引 + frame → BAD_REQUEST', async () => {
    const cdp = new CommonCdp();
    const { socket, done } = await boot(cdp, sid());
    try {
      const client = await DaemonClient.connect(socket);
      try {
        await client.request('page.state', {});
        await expect(client.request('page.click', {
          target: 'text=确定', intent: 'iframe 内等元素', snapshot_change_count: 0,
          frame: 'contentFrame', wait_element: '[0]',
        })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      } finally {
        try { await client.request('stop', {}); } catch {}
        client.close();
      }
    } finally { try { await done; } catch {} }
  }, 15000);

  it('wait_gone 的 [N] 索引 + frame → BAD_REQUEST', async () => {
    const cdp = new CommonCdp();
    const { socket, done } = await boot(cdp, sid());
    try {
      const client = await DaemonClient.connect(socket);
      try {
        await client.request('page.state', {});
        await expect(client.request('page.click', {
          target: 'text=确定', intent: 'iframe 内等消失', snapshot_change_count: 0,
          frame: 'contentFrame', wait_gone: '[0]',
        })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      } finally {
        try { await client.request('stop', {}); } catch {}
        client.close();
      }
    } finally { try { await done; } catch {} }
  }, 15000);

  it('back + frame → BAD_REQUEST 且未发 Page.navigateToHistoryEntry', async () => {
    const cdp = new CommonCdp();
    const { socket, done } = await boot(cdp, sid());
    try {
      const client = await DaemonClient.connect(socket);
      try {
        await client.request('page.state', {});
        await expect(client.request('page.back', {
          intent: 'iframe 内后退', snapshot_change_count: 0,
          frame: 'contentFrame',
        })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
        expect(cdp.calls.some((c) => c.method === 'Page.navigateToHistoryEntry')).toBe(false);
        expect(cdp.calls.some((c) => c.method === 'Page.getNavigationHistory')).toBe(false);
      } finally {
        try { await client.request('stop', {}); } catch {}
        client.close();
      }
    } finally { try { await done; } catch {} }
  }, 15000);

  it('refresh + frame → BAD_REQUEST 且未发 Page.reload', async () => {
    const cdp = new CommonCdp();
    const { socket, done } = await boot(cdp, sid());
    try {
      const client = await DaemonClient.connect(socket);
      try {
        await client.request('page.state', {});
        await expect(client.request('page.refresh', {
          intent: 'iframe 内刷新', snapshot_change_count: 0,
          frame: 'contentFrame',
        })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
        expect(cdp.calls.some((c) => c.method === 'Page.reload')).toBe(false);
      } finally {
        try { await client.request('stop', {}); } catch {}
        client.close();
      }
    } finally { try { await done; } catch {} }
  }, 15000);
});
