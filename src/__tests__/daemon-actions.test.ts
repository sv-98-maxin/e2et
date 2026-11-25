import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DaemonClient } from '../daemon/client.js';
import { runDaemon } from '../daemon/daemon.js';
import type { BootstrapResult } from '../daemon/bootstrap.js';
import { resolveSocketPath, traceDir } from '../daemon/session-meta.js';

/** fake CDP：带 1 个 button 元素的 AX 树，记录所有 send/callFunctionOn 调用 */
class ActionCdp {
  calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  closeCalled = false;
  /** DOM iframe 采集事实（主世界 querySelectorAll('iframe') 返回值）；子类按需覆盖 */
  domIframes: Array<{ name: string; src: string; id: string }> = [];
  /** root DOM owner 的 DOM.describeNode.frameId */
  ownerFrameId = 'main';
  private listeners = new Map<string, Array<(params: any) => void>>();
  private objectIdSeq = 0;
  lastBackendNodeId = 0;
  private hitBackend = 0;
  hitError?: string;
  private selectedBackends = new Set<number>();
  /** fake 无真实 DOM：记录最后一次写值，供回读函数模拟“写入未被受控组件吞掉” */
  lastWritten = '';
  /** F04/resolver 的 RemoteObject 图（returnByValue:false 链）：objectId → descriptor 集合 */
  private objectProps = new Map<string, Array<{ name: string; value: { type?: string; objectId?: string; value?: unknown } }>>();
  /** 远程元素 objectId → 真实 backend（describeNode(objectId) 用） */
  private objectBackend = new Map<string, number>();
  /** 选择子集 mock 形状：原生读取结果（null → custom 分流） */
  nativeSelect: { multiple: boolean; labels: string[]; disabled: boolean[] } | null = { multiple: true, labels: ['选项A', '选项B'], disabled: [false, false] };
  /** 选择子集 mock 形状：custom 根状态（ariaExpanded true 免点根；ariaControls 指向 fake 池 backend 100） */
  rootState = { native: false, multiple: false, ariaControls: ['sel-cat-pool'], ariaOwns: [], ariaExpanded: true, role: 'tree', activeDescendantId: null, focusable: true, focused: true, disabled: false, connected: true };
  /** 选择子集 mock 形状：fake 池 AX 子树选项 */
  axPoolOptions: Array<{ role: string; name: string; disabled?: boolean }> = [];

  on(method: string, handler: (params: any) => void): () => void {
    const list = this.listeners.get(method) ?? [];
    list.push(handler);
    this.listeners.set(method, list);
    return () => this.listeners.set(method, list.filter((item) => item !== handler));
  }
  /** 注册一个 RemoteObject（属性集），返回 objectId */
  private registerObject(props: Array<{ name: string; value: { type?: string; objectId?: string; value?: unknown } }>): string {
    const id = 'ro-' + (++this.objectIdSeq);
    this.objectProps.set(id, props);
    return id;
  }
  /** 注册数组 RemoteObject（length + 索引元素），元素为原始值或对象引用 */
  private registerArray(items: Array<{ type?: string; objectId?: string; value?: unknown }>): string {
    const props = [{ name: 'length', value: { type: 'number', value: items.length } }];
    items.forEach((item, i) => props.push({ name: String(i), value: item }));
    return this.registerObject(props);
  }
  /** 注册远程元素（真实 backend），返回其 objectId */
  private registerElement(backend: number): string {
    const id = 'el-' + (++this.objectIdSeq);
    this.objectBackend.set(id, backend);
    return id;
  }
  onClose(): void {}
  close(): void { this.closeCalled = true; }

  async send<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ method, params });
    if (method === 'Input.insertText') { this.lastWritten = String(params.text ?? ''); return {} as T; }
    if (method === 'Input.dispatchKeyEvent' && params.type === 'char') {
      this.lastWritten += params.key === 'Enter' ? '\n' : String(params.text ?? '');
      return {} as T;
    }
    if (method === 'Input.dispatchKeyEvent' && params.key === 'Backspace') { this.lastWritten = ''; return {} as T; }
    if (method === 'Page.enable') return {} as T;
    if (method === 'Network.enable') return {} as T;
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main', loaderId: '', url: 'about:blank', securityOrigin: '' } } } as T;
    if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: '1' } as T;
    if (method === 'Accessibility.getFullAXTree') {
      const poolChildren = this.axPoolOptions.map((o, i) => ({
        nodeId: 'opt-' + i,
        role: { type: 'role', value: o.role },
        name: { type: 'string', value: o.name },
        backendDOMNodeId: 200 + i,
        ignored: false,
        ...(o.disabled ? { properties: [{ name: 'disabled', value: { type: 'boolean', value: true } }] } : {}),
      }));
      return { nodes: [
        { nodeId: 'btn', role: { type: 'role', value: 'button' }, name: { type: 'string', value: '确定' }, backendDOMNodeId: 100, ignored: false },
        { nodeId: 'inp', role: { type: 'role', value: 'textbox' }, name: { type: 'string', value: '商品名称' }, backendDOMNodeId: 101, ignored: false, properties: [{ name: 'required', value: { type: 'boolean', value: false } }] },
        { nodeId: 'file', role: { type: 'role', value: 'button' }, name: { type: 'string', value: '上传文件' }, backendDOMNodeId: 102, ignored: false },
        { nodeId: 'pool', role: { type: 'role', value: 'listbox' }, name: { type: 'string', value: 'fake-pool' }, backendDOMNodeId: 100, ignored: false, childIds: poolChildren.map((c) => c.nodeId) },
        ...poolChildren,
      ] } as T;
    }
    if (method === 'DOM.resolveNode') {
      this.lastBackendNodeId = Number(params.backendNodeId ?? 0);
      return { object: { objectId: 'obj-' + (++this.objectIdSeq) } } as T;
    }
    if (method === 'Runtime.getProperties') {
      const objectId = String(params.objectId ?? '');
      const props = this.objectProps.get(objectId);
      if (!props) return { result: [] } as T;
      return { result: props } as T;
    }
    if (method === 'DOM.getDocument') return { root: { nodeId: 1 } } as T;
    if (method === 'DOM.querySelectorAll') {
      // selector 'option'（native 选项下标链）按需多个；池锚点 [id=...] 唯一命中
      const selector = String(params.selector ?? '');
      return { nodeIds: selector === 'option' ? [10, 11, 12, 13] : [10] } as T;
    }
    if (method === 'DOM.describeNode') {
      if (params.backendNodeId !== undefined) {
        return { node: { backendNodeId: Number(params.backendNodeId), frameId: this.ownerFrameId } } as T;
      }
      // objectId 路径（远程元素引用）：按 objectBackend 图返回真实 backend；nodeId 路径维持旧行为
      if (typeof params.objectId === 'string') {
        const backend = this.objectBackend.get(String(params.objectId));
        return { node: { backendNodeId: backend ?? 0, nodeName: 'DIV' } } as T;
      }
      return { node: { backendNodeId: 100, nodeName: 'BUTTON' } } as T;
    }
    if (method === 'Runtime.releaseObject') return {} as T;
    // iframe owner 事实：与 describeNode 的 backend 100 对齐（CDP name 兜底链）
    if (method === 'DOM.getFrameOwner') return { backendNodeId: 100, nodeId: 1 } as T;
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 } as T;
    if (method === 'DOM.requestNode') return { nodeId: 42 } as T;
    if (method === 'Runtime.evaluate') {
      const expr = String(params.expression ?? '');
      if (expr.includes('location.href') && expr.includes('location.origin'))
        return { result: { value: { url: 'https://example.com', origin: 'https://example.com', merchant_code: null, env: null } } } as T;
      if (expr.includes('__e2etChangeCount')) return { result: { value: 0 } } as T;
      if (expr.includes('readyState')) return { result: { value: 'complete' } } as T;
      if (expr.includes('document.body')) return { result: { value: '' } } as T;
      if (expr.includes('document') && !expr.includes('body')) return { result: { value: undefined }, exceptionDetails: undefined } as T;
      return { result: { value: null } } as T;
    }
    if (method === 'DOM.scrollIntoViewIfNeeded') return {} as T;
    if (method === 'DOM.getContentQuads') { this.hitBackend = Number(params.backendNodeId); return { quads: [[10, 10, 20, 10, 20, 20, 10, 20]] } as T; }
    if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { pageX: 0, pageY: 0 } } as T;
    if (method === 'DOM.getNodeForLocation') {
      if (this.hitError) throw new Error(this.hitError);
      return { backendNodeId: this.hitBackend } as T;
    }
    if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') { this.selectedBackends.add(this.hitBackend); return {} as T; }
    if (method === 'DOM.setFileInputFiles') return {} as T;
    if (method === 'Page.reload') return {} as T;
    if (method === 'Page.getNavigationHistory') {
      return { currentIndex: 1, entries: [{ url: 'https://example.test/a' }, { url: 'https://example.test/b' }] } as T;
    }
    if (method === 'Page.navigateToHistoryEntry') return {} as T;
    if (method === 'Runtime.callFunctionOn') {
      const fd = String(params.functionDeclaration ?? '');
      // 快照可见性工厂：首个节点返回 function RemoteObject，后续节点调用该函数
      if (params.returnByValue === false && fd.includes('isElementVisible')) {
        return { result: { type: 'function', objectId: 'snapshot-visibility-fn' } } as T;
      }
      if (fd.includes('return this(element)')) {
        return { result: { value: { connected: true, visible: true } } } as T;
      }
      if (fd.includes('function readOptionState') && fd.includes('getElementAccessibleNameText(this, true)')) {
        const option = this.axPoolOptions[this.lastBackendNodeId - 200];
        return { result: { value: { id: 'option-' + this.lastBackendNodeId, role: option?.role, name: option?.name, connected: true,
          selected: this.selectedBackends.has(this.lastBackendNodeId), checked: null, expanded: null, posinset: null, setsize: null } } } as T;
      }
      if (params.returnByValue === false && fd.includes('function resolveWriteTarget')) return { result: { type: 'object', objectId: this.registerElement(this.lastBackendNodeId) } } as T;
      if (fd.includes('function prepareWriteTarget')) { this.lastWritten = ''; return { result: { value: 'text' } } as T; }
      if (fd.includes('function assertWriteReady')) return { result: { value: 'text' } } as T;
      if (fd.includes('function readWriteTarget')) return { result: { value: this.lastWritten } } as T;
      // F04/resolver 原子提交与池解析桥：returnByValue:false 返回 RemoteObject 图
      // （getProperties → picked/nodes/scope/pools → describeNode(objectId) 取真实 backend）
      if (params.returnByValue === false) {
        if (fd.includes('resolveOptionPools')) {
          // resolver：{scope:'related', pools:[poolEl]}；池元素 backend 100（与 AX 树 pool 对齐）
          const poolEl = this.registerElement(100);
          const poolsArr = this.registerArray([{ type: 'object', objectId: poolEl }]);
          const resultObj = this.registerObject([
            { name: 'scope', value: { type: 'string', value: 'related' } },
            { name: 'pools', value: { type: 'object', objectId: poolsArr } },
          ]);
          return { result: { type: 'object', objectId: resultObj } } as T;
        }
        if (fd.includes('input.indexes.map')) {
          // APPLY_NATIVE_COMMIT_FN：多选原子提交（事件前捕获 input.indexes 指向的真实 option）。
          // 必须先于 SELECT 分支判别：APPLY 源内也含 select.options[idx]
          const input = Array.isArray(params.arguments) ? (params.arguments[0]?.value as { labels: string[]; indexes: number[] } | undefined) : undefined;
          const pickedLabels = (input ? input.indexes.map((i) => input.labels[i]) : []) as string[];
          const nodes = pickedLabels.map((_, i) => this.registerElement(300 + i));
          const pickedArr = this.registerArray(pickedLabels.map((label) => ({ type: 'string', value: label })));
          const nodesArr = this.registerArray(nodes.map((objectId) => ({ type: 'object', objectId })));
          const alreadyArr = this.registerArray(pickedLabels.map(() => ({ type: 'boolean', value: false })));
          const resultObj = this.registerObject([
            { name: 'picked', value: { type: 'object', objectId: pickedArr } },
            { name: 'nodes', value: { type: 'object', objectId: nodesArr } },
            { name: 'alreadySelected', value: { type: 'object', objectId: alreadyArr } },
            { name: 'observedCount', value: { type: 'number', value: input?.labels.length } },
          ]);
          return { result: { type: 'object', objectId: resultObj } } as T;
        }
        if (fd.includes('select.options[idx]')) {
          // SELECT_NATIVE_COMMIT_FN：单选原子提交（matcher 捕获该次实际 option 引用）
          const wanted = String((Array.isArray(params.arguments) ? params.arguments[0]?.value : undefined) ?? '');
          const labels = this.nativeSelect?.labels ?? [];
          const index = labels.indexOf(wanted);
          const pickedLabels = index >= 0 ? [labels[index]] : [];
          const nodes = pickedLabels.map((_, i) => this.registerElement(300 + i));
          const pickedArr = this.registerArray(pickedLabels.map((label) => ({ type: 'string', value: label })));
          const nodesArr = this.registerArray(nodes.map((objectId) => ({ type: 'object', objectId })));
          const alreadyArr = this.registerArray(pickedLabels.map(() => ({ type: 'boolean', value: false })));
          const resultObj = this.registerObject([
            { name: 'picked', value: { type: 'object', objectId: pickedArr } },
            { name: 'nodes', value: { type: 'object', objectId: nodesArr } },
            { name: 'alreadySelected', value: { type: 'object', objectId: alreadyArr } },
            { name: 'observedCount', value: { type: 'number', value: labels.length } },
          ]);
          return { result: { type: 'object', objectId: resultObj } } as T;
        }
      }
      // SELECT_NATIVE_OPTION_FN（共源原生 select）：按真实 DOM 属性语义组合辨认（selectedIndex + tagName），返回真实 picked label 形状
      if (fd.includes('selectedIndex') && fd.includes('tagName')) {
        return { result: { value: '选项A' } } as T;
      }
      if (fd.includes('readNativeOptions')) {
        return { result: { value: this.nativeSelect } } as T;
      }
      if (fd.includes('applyNativeSelection')) {
        const input = Array.isArray(params.arguments) ? (params.arguments[0]?.value as { labels: string[]; indexes: number[] } | undefined) : undefined;
        return { result: { value: input ? input.indexes.map((i) => input.labels[i]) : [] } } as T;
      }
      if (fd.includes('readSelectRootState')) {
        return { result: { value: this.rootState } } as T;
      }
      if (fd.includes('isDirectCategoryChild') || fd.includes('this.nodeType === 1 && this.isConnected === true')) {
        return { result: { value: true } } as T;
      }
      if (fd.includes('return { connected:true, visible:isElementVisible(this) };')) {
        return { result: { value: { connected: true, visible: true } } } as T;
      }
      if (fd.includes('optionDisabledReason')) {
        return { result: { value: null } } as T;
      }
      if (fd.includes('isElementVisible')) {
        return { result: { value: true } } as T;
      }
      // assertEnabled 的 CHECK_FN：返回 null（元素未禁用）
      if (fd.includes('disabled === true') || fd.includes('aria-disabled')) {
        return { result: { value: null } } as T;
      }
      // READ_ELEMENT_VALUE_FN：回读最后写入值（fake 用写入记录模拟真实 DOM 未被吞值）
      if (fd.includes('inner.value')) {
        return { result: { value: this.lastWritten } } as T;
      }
      // SET_FILE_INPUT_FN：file 专属特征判定，避免抢占写值/回读函数
      if (fd.includes("this.type === 'file'")) {
        return { result: { value: this.lastBackendNodeId === 102 } } as T;
      }
      // CLICK_FN：返回 ok（派发成功）
      if (fd.includes('getBoundingClientRect')) {
        return { result: { value: true } } as T;
      }
      return { result: { value: true } } as T;
    }
    if (method === 'Network.getResponseBody') return { body: '{"ok":true}' } as T;
    return {} as T;
  }

  async evaluate<T = any>(expression: string): Promise<T> {
    // DOM iframe 采集（collectIframeDescs 走 session.evaluate 方法调用）
    if (expression.includes("querySelectorAll('iframe')")) return this.domIframes as T;
    // back/refresh §8：动作成功结束时读实际当前 URL（fake 历史条目 a）
    if (expression.includes('location.href')) return 'https://example.test/a' as T;
    if (expression.includes('window.innerWidth')) return { width: 1280, height: 720, deviceScaleFactor: 2 } as T;
    if (expression.includes('readyState')) return 'complete' as T;
    if (expression.includes('__e2etChangeCount')) return 0 as T;
    if (expression.includes('__e2etObserver')) return true as T;
    if (expression.includes('activeElement') || expression.includes('dispatchEvent') || expression.includes('KeyboardEvent')) return 'ok' as T;
    return '' as T;
  }

  emit(method: string, params: any): void {
    for (const handler of this.listeners.get(method) ?? []) handler(params);
  }
}

describe('操作命令集成（daemon + fake CDP）', () => {
  let home: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.E2ET_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-actions-'));
    process.env.E2ET_HOME = home;
  });
  afterEach(() => {
    if (previousHome === undefined) delete process.env.E2ET_HOME;
    else process.env.E2ET_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  async function boot(cdp: ActionCdp): Promise<{ socket: string; done: Promise<void> }> {
    const id = 'act-' + Math.random().toString(36).slice(2, 8);
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

  it('click [0] 索引 → clickNode + DOM 派发 + settled_by idle（无请求）', async () => {
    const cdp = new ActionCdp();
    const { socket, done } = await boot(cdp);
    try {
      const client = await DaemonClient.connect(socket);
      // 先 page state 拿快照（change_count=0）
      const st = await client.request('page.state', {}) as any;
      expect(st.change_count).toBe(0);

      const res = await client.request('page.click', {
        target: '[0]', intent: '点击确定按钮', snapshot_change_count: 0,
      }) as any;
      expect(res.ok ?? true).toBe(true);
      expect(res.action_id).toMatch(/^a\d+$/);
      expect(res.target).toMatchObject({ resolved_by: 'index', role: 'button', name: '确定', matches: 1 });
      // 坐标点击协议：非退化 quad + pressed/released
      expect(cdp.calls.some((c) => c.method === 'DOM.scrollIntoViewIfNeeded')).toBe(true);
      expect(cdp.calls.some((c) => c.method === 'DOM.getContentQuads')).toBe(true);
      const presses = cdp.calls.filter((c) => c.method === 'Input.dispatchMouseEvent');
      expect(presses.map((c) => c.params?.type)).toEqual(['mousePressed', 'mouseReleased']);
      // 无触发请求 → settled_by 不含 request，可能有 idle 兜底
      const reqSettled = (res.settled_by ?? []).filter((s: any) => s.kind === 'request');
      expect(reqSettled).toHaveLength(0);

      await client.request('stop', {});
      client.close();
    } finally { try { await done; } catch {} }
  }, 15000);

  it('click 命中探测 CDP 异常 → NOT_INTERACTABLE，不冒泡成 DAEMON_ERROR', async () => {
    const cdp = new ActionCdp();
    cdp.hitError = 'No node with given location';
    const { socket, done } = await boot(cdp);
    try {
      const client = await DaemonClient.connect(socket);
      await client.request('page.state', {});
      await expect(client.request('page.click', {
        target: '[0]', intent: '点击确定按钮', snapshot_change_count: 0,
      })).rejects.toMatchObject({
        code: 'NOT_INTERACTABLE',
        message: expect.stringContaining('No node with given location'),
      });
      await client.request('stop', {});
      client.close();
    } finally { try { await done; } catch {} }
  }, 15000);

  it('STALE_INDEX：snapshot_change_count 不匹配 → 拒绝', async () => {
    const cdp = new ActionCdp();
    const { socket, done } = await boot(cdp);
    try {
      const client = await DaemonClient.connect(socket);
      await client.request('page.state', {});
      await expect(client.request('page.click', {
        target: '[0]', intent: '点击', snapshot_change_count: 999,
      })).rejects.toMatchObject({ code: 'STALE_INDEX' });
      await client.request('stop', {});
      client.close();
    } finally { try { await done; } catch {} }
  }, 15000);

  it('缺 intent → BAD_REQUEST', async () => {
    const cdp = new ActionCdp();
    const { socket, done } = await boot(cdp);
    try {
      const client = await DaemonClient.connect(socket);
      await expect(client.request('page.click', { target: '[0]' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      await client.request('stop', {});
      client.close();
    } finally { try { await done; } catch {} }
  }, 15000);

  it('fill 文本 → callFunctionOn 写值（不逐字符）', async () => {
    const cdp = new ActionCdp();
    const { socket, done } = await boot(cdp);
    try {
      const client = await DaemonClient.connect(socket);
      await client.request('page.state', {});
      const res = await client.request('page.fill', {
        target: '[1]', value: 'E2E商品', intent: '填商品名称', snapshot_change_count: 0,
      }) as any;
      expect(res.action_id).toMatch(/^a\d+$/);
      expect(res.target.role).toBe('textbox');
      // callFunctionOn 至少一次（FILL_FN）
      const calls = cdp.calls.filter((c) => c.method === 'Runtime.callFunctionOn');
      expect(calls.length).toBeGreaterThanOrEqual(1);
      await client.request('stop', {});
      client.close();
    } finally { try { await done; } catch {} }
  }, 15000);

  it('type 换行 → dispatched Enter key，不发送换行 char', async () => {
    const cdp = new ActionCdp();
    const { socket, done } = await boot(cdp);
    try {
      const client = await DaemonClient.connect(socket);
      await client.request('page.state', {});
      await client.request('page.type', {
        target: '[1]', value: '第一行\n第二行', intent: '输入多行文本', snapshot_change_count: 0,
      });
      const keys = cdp.calls
        .filter((call) => call.method === 'Input.dispatchKeyEvent')
        .map((call) => call.params);
      expect(keys).toContainEqual(expect.objectContaining({ type: 'keyDown', key: 'Enter' }));
      expect(keys).toContainEqual(expect.objectContaining({ type: 'char', key: 'Enter', text: '\r' }));
      expect(keys).toContainEqual(expect.objectContaining({ type: 'keyUp', key: 'Enter' }));
      expect(keys.some((params) => params?.type === 'char' && params?.text === '\n')).toBe(false);
      expect(cdp.lastWritten).toBe('第一行\n第二行');
      await client.request('stop', {});
      client.close();
    } finally { try { await done; } catch {} }
  }, 15000);

  it('press Enter → evaluate 派发 KeyboardEvent', async () => {
    const cdp = new ActionCdp();
    const { socket, done } = await boot(cdp);
    try {
      const client = await DaemonClient.connect(socket);
      const res = await client.request('page.press', { key: 'Enter', intent: '回车提交' }) as any;
      expect(res.action_id).toMatch(/^a\d+$/);
      await client.request('stop', {});
      client.close();
    } finally { try { await done; } catch {} }
  }, 15000);

  it('select 选项 → selectOption 调用', async () => {
    const cdp = new ActionCdp();
    const { socket, done } = await boot(cdp);
    try {
      const client = await DaemonClient.connect(socket);
      await client.request('page.state', {});
      const res = await client.request('page.select', {
        target: '[0]', option: '选项A', intent: '选下拉', snapshot_change_count: 0,
      }) as any;
      expect(res.action_id).toMatch(/^a\d+$/);
      await client.request('stop', {});
      client.close();
    } finally { try { await done; } catch {} }
  }, 20000);

  it('upload → DOM.setFileInputFiles（target 为 file input）', async () => {
    const cdp = new ActionCdp();
    const { socket, done } = await boot(cdp);
    const tmpFile = path.join(home, 'test-upload.txt');
    fs.writeFileSync(tmpFile, 'upload-content');
    try {
      const client = await DaemonClient.connect(socket);
      await client.request('page.state', {});
      const res = await client.request('page.upload', {
        target: '[2]', files: [tmpFile], intent: '上传文件', snapshot_change_count: 0,
      }) as any;
      expect(res.action_id).toMatch(/^a\d+$/);
      const call = cdp.calls.find((c) => c.method === 'DOM.setFileInputFiles');
      expect(call).toBeTruthy();
      expect(Array.isArray(call!.params?.files)).toBe(true);
      expect(call!.params!.files).toEqual([tmpFile]);
      try {
        await client.request('stop', {});
        client.close();
      } catch { /* upload 失败也要尝试 stop，stop 失败不阻塞测试退出 */ }
    } finally { try { await done; } catch {} }
  }, 20000);

  it('settled_by：动作触发请求 → waitForActionRequests 记 request ref + ms', async () => {
    // 单元测 NetworkTrace.waitForActionRequests：emit 请求在 action 内 → settle 后 ref 正确
    const { NetworkTrace } = await import('../daemon/network-trace.js');
    const cdp = new ActionCdp();
    const trace = new NetworkTrace('act-settled', cdp as any);
    trace.install();
    await trace.initialize('__source__');
    await trace.enable();
    const action = trace.beginAction('click', '点击触发请求', { target: '[0]' })!;
    // action 期间 emit 请求
    cdp.emit('Network.requestWillBeSent', {
      requestId: 'xhr-1', frameId: 'main', type: 'XHR', wallTime: Date.now() / 1000,
      request: { url: 'https://example.test/api/save', method: 'POST', headers: {} },
    });
    cdp.emit('Network.responseReceived', { requestId: 'xhr-1', response: { status: 200, mimeType: 'application/json', headers: {} } });
    cdp.emit('Network.loadingFinished', { requestId: 'xhr-1' });
    // 请求已 settle，waitForActionRequests 应立即返回 ref
    const { settled_by, timedOut } = await trace.waitForActionRequests(action, 2000);
    expect(timedOut).toBe(false);
    expect(settled_by).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'request', ref: 'r1' }),
    ]));
    trace.finishAction(action, true, { settled_by });
  });

  it('hover → DOM 派发 mouseover/mousemove', async () => {
    const cdp = new ActionCdp();
    const { socket, done } = await boot(cdp);
    try {
      const client = await DaemonClient.connect(socket);
      await client.request('page.state', {});
      const res = await client.request('page.hover', { target: '[0]', intent: '悬停按钮', snapshot_change_count: 0 }) as any;
      expect(res.action_id).toMatch(/^a\d+$/);
      expect(cdp.calls.some((c) => c.method === 'DOM.scrollIntoViewIfNeeded')).toBe(true);
      expect(cdp.calls.some((c) => c.method === 'Runtime.callFunctionOn')).toBe(true);
      try { await client.request('stop', {}); } catch {}
      client.close();
    } finally { try { await done; } catch {} }
  }, 15000);

  it('scroll dir=down → evaluate window.scrollBy', async () => {
    const cdp = new ActionCdp();
    const { socket, done } = await boot(cdp);
    try {
      const client = await DaemonClient.connect(socket);
      const res = await client.request('page.scroll', { dir: 'down', intent: '向下滚' }) as any;
      expect(res.action_id).toMatch(/^a\d+$/);
      try { await client.request('stop', {}); } catch {}
      client.close();
    } finally { try { await done; } catch {} }
  }, 15000);

  it('scroll target → scrollIntoViewIfNeeded + callFunctionOn', async () => {
    const cdp = new ActionCdp();
    const { socket, done } = await boot(cdp);
    try {
      const client = await DaemonClient.connect(socket);
      await client.request('page.state', {});
      const res = await client.request('page.scroll', { target: '[0]', intent: '滚到按钮', snapshot_change_count: 0 }) as any;
      expect(res.action_id).toMatch(/^a\d+$/);
      expect(cdp.calls.some((c) => c.method === 'Runtime.callFunctionOn')).toBe(true);
      try { await client.request('stop', {}); } catch {}
      client.close();
    } finally { try { await done; } catch {} }
  }, 15000);

  it('back → Page.navigateToHistoryEntry', async () => {
    const cdp = new ActionCdp();
    const { socket, done } = await boot(cdp);
    try {
      const client = await DaemonClient.connect(socket);
      const res = await client.request('page.back', { intent: '后退' }) as any;
      expect(res.action_id).toMatch(/^a\d+$/);
      expect(res.switched_to).toBe('https://example.test/a');
      expect(cdp.calls.some((c) => c.method === 'Page.navigateToHistoryEntry')).toBe(true);
      try { await client.request('stop', {}, { requestTimeoutMs: 3000 }); } catch {}
      client.close();
    } finally { try { await done; } catch {} }
  }, 15000);

  it('refresh → Page.reload', async () => {
    const cdp = new ActionCdp();
    const { socket, done } = await boot(cdp);
    try {
      const client = await DaemonClient.connect(socket);
      const res = await client.request('page.refresh', { intent: '刷新页面' }) as any;
      expect(res.action_id).toMatch(/^a\d+$/);
      expect(cdp.calls.some((c) => c.method === 'Page.reload')).toBe(true);
      try { await client.request('stop', {}); } catch {}
      client.close();
    } finally { try { await done; } catch {} }
  }, 15000);

  it('switch-tab 单 tab 无匹配 → NOT_FOUND（不再走历史导航）', async () => {
    const cdp = new ActionCdp();
    const { socket, done } = await boot(cdp);
    let client: any = null;
    try {
      client = await DaemonClient.connect(socket);
      // 真 switch-tab：单 tab 无匹配 → NOT_FOUND，不再退回历史导航假成功
      await expect(client.request('page.switch-tab', { url_contains: '/b', intent: '切到 b' }))
        .rejects.toMatchObject({ code: 'NOT_FOUND' });
      // 不再调用 Page.getNavigationHistory / navigateToHistoryEntry
      expect(cdp.calls.some((c) => c.method === 'Page.getNavigationHistory')).toBe(false);
      expect(cdp.calls.some((c) => c.method === 'Page.navigateToHistoryEntry')).toBe(false);
    } finally {
      try { if (client) await client.request('stop', {}, { requestTimeoutMs: 3000 }); } catch {}
      client?.close();
      try { await done; } catch {}
    }
  }, 15000);

  it('choose 多选项 → selectOption 循环调用', async () => {
    const cdp = new ActionCdp();
    const { socket, done } = await boot(cdp);
    try {
      const client = await DaemonClient.connect(socket);
      await client.request('page.state', {});
      const res = await client.request('page.choose', { target: '[0]', options: ['选项A', '选项B'], intent: '多选', snapshot_change_count: 0 }) as any;
      expect(res.action_id).toMatch(/^a\d+$/);
      try { await client.request('stop', {}); } catch {}
      client.close();
    } finally { try { await done; } catch {} }
  }, 15000);

  it('date 文本框 → fillNode 输入', async () => {
    const cdp = new ActionCdp();
    const { socket, done } = await boot(cdp);
    try {
      const client = await DaemonClient.connect(socket);
      await client.request('page.state', {});
      const res = await client.request('page.date', { target: '[1]', value: '2026-01-15', intent: '选日期', snapshot_change_count: 0 }) as any;
      expect(res.action_id).toMatch(/^a\d+$/);
      try { await client.request('stop', {}); } catch {}
      client.close();
    } finally { try { await done; } catch {} }
  }, 15000);

  it('category 多级 → pickCategory 循环', async () => {
    const cdp = new ActionCdp();
    // custom 级联路径：根状态声明 fake 池（backend 100），AX 树按 path 逐级给出 treeitem
    cdp.nativeSelect = null;
    cdp.axPoolOptions = [
      { role: 'treeitem', name: '生鲜' },
      { role: 'treeitem', name: '蔬菜' },
      { role: 'treeitem', name: '叶菜' },
    ];
    const { socket, done } = await boot(cdp);
    try {
      const client = await DaemonClient.connect(socket);
      await client.request('page.state', {});
      const res = await client.request('page.category', { target: '[0]', path: ['生鲜', '蔬菜', '叶菜'], intent: '选类目', snapshot_change_count: 0 }) as any;
      expect(res.action_id).toMatch(/^a\d+$/);
      try { await client.request('stop', {}); } catch {}
      client.close();
    } finally {
      try { await done; } catch (error) { throw error; }
    }
  }, 15000);

  it('fill-form scope=targeted 显式字段 → 逐字段写前身份 + filled/output_value', async () => {
    const cdp = new ActionCdp();
    const { socket, done } = await boot(cdp);
    try {
      const client = await DaemonClient.connect(socket);
      const res = await client.request('page.fill-form', { scope: 'targeted', fields: { '商品名称': 'E2E名称' }, skip: [], intent: '填表单' }) as any;
      expect(res.action_id).toMatch(/^a\d+$/);
      expect(res.output_value).toBe(JSON.stringify({ '商品名称': 'E2E名称' }));
      expect(Array.isArray(res.filled)).toBe(true);
      expect(res.filled[0]).toMatchObject({ name: '商品名称', value: 'E2E名称', target: { resolved_by: 'ax', role: 'textbox', name: '商品名称', matches: 1, candidates: [{ by: 'role', role: 'textbox', name: '商品名称', matches: 1 }] } });
      try { await client.request('stop', {}); } catch {}
      client.close();
    } finally { try { await done; } catch {} }
  }, 15000);

  it('trace action 事件写入 jsonl，kind 对应命令', async () => {
    const cdp = new ActionCdp();
    const id = 'act-trace';
    const socket = resolveSocketPath(id);
    fs.rmSync(socket, { force: true });
    const done = runDaemon(id, {
      env: 'pre', socketPath: socket, exitOnStop: false,
      browserBootstrap: async (): Promise<BootstrapResult> => ({ tabId: 'tab', session: cdp as any, endpoint: 'http://127.0.0.1:0' }),
    });
    try {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (await DaemonClient.ping(socket, 200)) break;
        await new Promise((r) => setTimeout(r, 30));
      }
      const client = await DaemonClient.connect(socket);
      await client.request('page.state', {});
      await client.request('page.click', { target: '[0]', intent: '点击', snapshot_change_count: 0 });
      await client.request('stop', {});
      client.close();

      const events = fs.readFileSync(path.join(traceDir(id), 'trace.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      const clickAction = events.find((e) => e.t === 'action' && e.kind === 'click');
      expect(clickAction).toBeDefined();
      expect(clickAction.intent).toBe('点击');
      expect(clickAction.result).toEqual({ ok: true });
    } finally { try { await done; } catch {} }
  }, 15000);

  it('page.state 返回通用快照：context 只含主文档身份字段（无业务字段），不执行业务 localStorage/env 表达式', async () => {
    let evaluatedExpr = '';
    class ContextCdp extends ActionCdp {
      override async send<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
        if (method === 'Runtime.evaluate') {
          const prev = evaluatedExpr;
          evaluatedExpr = prev + String(params.expression ?? '') + '\n';
        }
        return super.send(method, params);
      }
    }
    const cdp = new ContextCdp();
    const { socket, done } = await boot(cdp);
    try {
      const client = await DaemonClient.connect(socket);
      const res = await client.request('page.state', {}) as any;
      // P2：context 是主文档身份（target_id/frame_id/loader_id/nav/url/origin），无业务字段
      expect(res.context).toBeDefined();
      expect(Object.keys(res.context).sort()).toEqual(['frame_id', 'loader_id', 'nav', 'origin', 'target_id', 'url']);
      expect(res.snapshot_id).toBeDefined();
      expect(res.tabs).toBeDefined();
      // 不再读 example_login_info / _APP_ENV / window.env
      expect(evaluatedExpr).not.toContain('example_login_info');
      expect(evaluatedExpr).not.toContain('_APP_ENV');
      expect(evaluatedExpr).not.toContain('merchant_code');
      try { await client.request('stop', {}); } catch {}
      client.close();
    } finally { try { await done; } catch {} }
  }, 15000);


  it('--frame OOPIF → FRAME_UNSUPPORTED (createIsolatedWorld rejects)', async () => {
    class OopifCdp extends ActionCdp {
      override domIframes = [{ name: 'cross-origin', src: 'https://cross.example/x', id: '' }];
      override ownerFrameId = 'oopif';
      override async send<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
        if (method === 'Page.getFrameTree') {
          return { frameTree: { frame: { id: 'main', loaderId: '', url: 'https://example.com', securityOrigin: 'https://example.com' }, childFrames: [{ frame: { id: 'oopif', name: 'cross-origin', parentId: 'main' } }] } } as T;
        }
        if (method === 'Page.createIsolatedWorld') {
          throw new Error('Not found'); // OOPIF rejection
        }
        return super.send(method, params);
      }
    }
    const cdp = new OopifCdp();
    const { socket, done } = await boot(cdp);
    try {
      const client = await DaemonClient.connect(socket);
      await expect(client.request('page.click', { target: 'text=确定', intent: '跨域frame点击', snapshot_change_count: 0, frame: 'cross-origin' })).rejects.toMatchObject({ code: 'FRAME_UNSUPPORTED' });
      try { await client.request('stop', {}); } catch {}
      client.close();
    } finally { try { await done; } catch {} }
  }, 15000);

  it('--frame + [N] index → BAD_REQUEST', async () => {
    class SimpleFrameCdp extends ActionCdp {
      override domIframes = [{ name: 'f1', src: 'https://example.com/frame', id: '' }];
      override ownerFrameId = 'cf';
      override async send<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
        if (method === 'Page.getFrameTree') {
          return { frameTree: { frame: { id: 'main', loaderId: '', url: 'https://example.com', securityOrigin: 'https://example.com' }, childFrames: [{ frame: { id: 'cf', name: 'f1', parentId: 'main' } }] } } as T;
        }
        if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 } as T;
        return super.send(method, params);
      }
    }
    const cdp = new SimpleFrameCdp();
    const { socket, done } = await boot(cdp);
    try {
      const client = await DaemonClient.connect(socket);
      await expect(client.request('page.click', { target: '[0]', intent: '点', snapshot_change_count: 0, frame: 'f1' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      try { await client.request('stop', {}); } catch {}
      client.close();
    } finally { try { await done; } catch {} }
  }, 15000);

  it('--frame not found → BAD_FRAME', async () => {
    const cdp = new ActionCdp();
    const { socket, done } = await boot(cdp);
    try {
      const client = await DaemonClient.connect(socket);
      await expect(client.request('page.click', { target: 'text=确定', intent: '点', snapshot_change_count: 0, frame: 'nonexist' })).rejects.toMatchObject({ code: 'BAD_FRAME' });
      try { await client.request('stop', {}); } catch {}
      client.close();
    } finally { try { await done; } catch {} }
  }, 15000);

  // §1 预算控制：小预算 → WAIT_TIMEOUT；大预算 → 成功（证明 budget 门控显式等待）
  it('wait_api 预算控制：budget 1000 + 1500ms 完成 → WAIT_TIMEOUT', async () => {
    const cdp = new ActionCdp();
    const { socket, done } = await boot(cdp);
    try {
      const client = await DaemonClient.connect(socket);
      await client.request('page.state', {});
      // action 后 50ms emit 请求，1500ms 后 loadingFinished（超过 budget 1000）
      setTimeout(() => {
        cdp.emit('Network.requestWillBeSent', { requestId: 'late-1', frameId: 'main', type: 'XHR', wallTime: Date.now() / 1000, request: { url: 'https://example.test/api/late', method: 'GET', headers: {} } });
        setTimeout(() => { cdp.emit('Network.loadingFinished', { requestId: 'late-1' }); }, 1450);
      }, 50);
      await expect(client.request('page.click', {
        target: '[0]', intent: '点', snapshot_change_count: 0,
        wait_api: '/api/late', wait_timeout_ms: 1000,
      })).rejects.toMatchObject({ code: 'WAIT_TIMEOUT' });
      try { await client.request('stop', {}); } catch {}
      client.close();
    } finally { try { await done; } catch {} }
  }, 20000);

  it('wait_api 预算控制：budget 3000 + 1500ms 完成 → 成功', async () => {
    const cdp = new ActionCdp();
    const { socket, done } = await boot(cdp);
    try {
      const client = await DaemonClient.connect(socket);
      await client.request('page.state', {});
      setTimeout(() => {
        cdp.emit('Network.requestWillBeSent', { requestId: 'late-2', frameId: 'main', type: 'XHR', wallTime: Date.now() / 1000, request: { url: 'https://example.test/api/late', method: 'GET', headers: {} } });
        setTimeout(() => { cdp.emit('Network.loadingFinished', { requestId: 'late-2' }); }, 1450);
      }, 50);
      const res = await client.request('page.click', {
        target: '[0]', intent: '点', snapshot_change_count: 0,
        wait_api: '/api/late', wait_timeout_ms: 3000,
      }) as any;
      expect(res.settled_by?.some((s: any) => s.kind === 'request')).toBe(true);
      try { await client.request('stop', {}); } catch {}
      client.close();
    } finally { try { await done; } catch {} }
  }, 15000);

  // note13：headers 立即、body 12s 后完成，声明 20s 预算 → action 在 body 完成后 resolve（非 headers、非 10s auto-settle）
  it('wait_api：headers 立即 + loadingFinished 12s 后，budget 20s → 成功（body 完成驱动）', async () => {
    const cdp = new ActionCdp();
    const { socket, done } = await boot(cdp);
    try {
      const client = await DaemonClient.connect(socket);
      await client.request('page.state', {});
      const t0 = Date.now();
      // 50ms 后 emit 请求 + headers（立即），12s 后 loadingFinished（body 完成）
      setTimeout(() => {
        cdp.emit('Network.requestWillBeSent', { requestId: 'late-12', frameId: 'main', type: 'XHR', wallTime: Date.now() / 1000, request: { url: 'https://example.test/api/late12', method: 'GET', headers: {} } });
        cdp.emit('Network.responseReceived', { requestId: 'late-12', response: { status: 200, mimeType: 'application/json', headers: {} } });
        setTimeout(() => { cdp.emit('Network.loadingFinished', { requestId: 'late-12' }); }, 12_000);
      }, 50);
      const res = await client.request('page.click', {
        target: '[0]', intent: '点', snapshot_change_count: 0,
        wait_api: '/api/late12', wait_timeout_ms: 20_000,
      }) as any;
      const elapsed = Date.now() - t0;
      expect(res.settled_by?.some((s: any) => s.kind === 'request')).toBe(true);
      expect(res.action_id).toMatch(/^a\d+$/);
      // body 12s 后完成 → elapsed >= 12s（非 headers 立即返回，也非 10s auto-settle）
      expect(elapsed).toBeGreaterThanOrEqual(11_000);
      try { await client.request('stop', {}); } catch {}
      client.close();
    } finally { try { await done; } catch {} }
  }, 20_000);

});
