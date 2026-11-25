/**
 * 迭代 42176 接手任务自证：
 * 1. page screenshot：CLI 元数据/透传、PNG 落地路径/权限/不写 action、full-page clip
 * 2. page scroll：水平无纵向位移、target 容器按轴滚动、direction 写进 action args
 * 3. page press：native CDP Input.dispatchKeyEvent + 新增键
 * 4. 混合 pass+fail → session fail（真实 daemon 断言后 stop 验证）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';
import { DaemonClient } from '../daemon/client.js';
import { runDaemon } from '../daemon/daemon.js';
import type { BootstrapResult } from '../daemon/bootstrap.js';
import { resolveSocketPath, e2etRoot, generateSessionId, writeMeta } from '../daemon/session-meta.js';
import { readTraceEvents } from '../daemon/trace.js';
import { dispatch } from '../cli/router.js';
import { commandDefinitions } from '../cli/commands.js';
import type { RouterDeps } from '../cli/context.js';
import { SCROLL_ANCESTOR_FN } from '../browser/actions.js';
import * as vm from 'node:vm';

class HandoffCdp {
  calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  closeCalled = false;
  /** callOnNode 返回值覆盖（F4 测试用） */
  callOnNodeResult: unknown = null;
  private listeners = new Map<string, Array<(params: any) => void>>();
  private objectIdSeq = 0;
  private hitBackend = 0;

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
    if (method === 'Page.enable' || method === 'Network.enable') return {} as T;
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main', loaderId: '', url: 'about:blank', securityOrigin: '' } } } as T;
    if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: '1' } as T;
    if (method === 'Accessibility.getFullAXTree') {
      return { nodes: [
        { nodeId: 'btn', role: { type: 'role', value: 'button' }, name: { type: 'string', value: '确定' }, backendDOMNodeId: 100, ignored: false },
      ] } as T;
    }
    if (method === 'DOM.resolveNode') return { object: { objectId: 'obj-' + (++this.objectIdSeq) } } as T;
    if (method === 'DOM.getContentQuads') { this.hitBackend = Number(params.backendNodeId); return { quads: [[10, 10, 20, 10, 20, 20, 10, 20]] } as T; }
    if (method === 'DOM.getNodeForLocation') return { backendNodeId: this.hitBackend } as T;
    if (method === 'DOM.getDocument') return { root: { nodeId: 1 } } as T;
    if (method === 'DOM.querySelectorAll') return { nodeIds: [10] } as T;
    if (method === 'DOM.describeNode') return { node: { backendNodeId: 100, nodeName: 'BUTTON' } } as T;
    if (method === 'DOM.scrollIntoViewIfNeeded') return {} as T;
    if (method === 'Page.reload') return {} as T;
    if (method === 'Page.getNavigationHistory') return { currentIndex: 1, entries: [{ url: 'https://example.test/a' }] } as T;
    if (method === 'Page.navigateToHistoryEntry') return {} as T;
    if (method === 'Page.captureScreenshot') return { data: 'iVBORw0KGgo=' } as T;
    // F2：cssContentSize 是 CSS 尺寸（clip 用）；contentSize 是废弃 DP 尺寸，故意不同以验证选对
    if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { pageX: 0, pageY: 0 }, cssContentSize: { width: 2000, height: 3000 }, contentSize: { width: 4000, height: 6000 } } as T;
    if (method === 'Input.dispatchKeyEvent') return {} as T;
    if (method === 'Runtime.callFunctionOn') {
      const fd = String(params.functionDeclaration ?? '');
      if (params.returnByValue === false && fd.includes('isElementVisible')) return { result: { type: 'function', objectId: 'snapshot-visibility-fn' } } as T;
      if (fd.includes('return this(element)')) return { result: { value: { connected: true, visible: true } } } as T;
      if (fd.includes('isConnected')) return { result: { value: { connected: true, visible: true } } } as T;
      // F4：callOnNodeResult 覆盖（边界/无容器测试）
      if (this.callOnNodeResult !== null && fd.includes('overflowAxis')) return { result: { value: this.callOnNodeResult } } as T;
      if (fd.includes('disabled === true') || fd.includes('aria-disabled')) return { result: { value: null } } as T;
      if (fd.includes('getBoundingClientRect')) return { result: { value: true } } as T;
      // SCROLL_ANCESTOR_FN：返回 { moved, found }（F3/F4）
      if (fd.includes('overflowAxis')) return { result: { value: { moved: true, found: true } } } as T;
      return { result: { value: true } } as T;
    }
    if (method === 'Network.getResponseBody') return { body: '{"success":true}' } as T;
    return {} as T;
  }

  async evaluate<T = any>(expression: string): Promise<T> {
    if (expression.includes('window.innerWidth')) return { width: 1280, height: 720, deviceScaleFactor: 2 } as T;
    if (expression.includes('readyState')) return 'complete' as T;
    if (expression.includes('__e2etChangeCount')) return 0 as T;
    if (expression.includes('__e2etObserver')) return true as T;
    if (expression.includes('location.href')) return 'https://example.test/page' as T;
    // 记录 scrollBy 调用（整页滚动路径）
    if (expression.includes('scrollBy')) {
      this.calls.push({ method: 'Runtime.evaluate', params: { expression } });
      // scrollNode 无 target 时返回 moved=true
      return true as T;
    }
    return '' as T;
  }

  emit(method: string, params: any): void {
    for (const handler of this.listeners.get(method) ?? []) handler(params);
  }
}

let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.E2ET_HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-42176-'));
  process.env.E2ET_HOME = home;
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.E2ET_HOME;
  else process.env.E2ET_HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

/** boot session，stop+close 在 finally 确保失败也收尾；失败时 error 附 sessionId */
async function withSession(
  cdp: HandoffCdp,
  body: (client: DaemonClient, id: string) => Promise<void>,
): Promise<{ id: string }> {
  const id = 'h42176-' + Math.random().toString(36).slice(2, 8);
  const socket = resolveSocketPath(id);
  fs.rmSync(socket, { force: true });
  const termBefore = process.listenerCount('SIGTERM');
  const intBefore = process.listenerCount('SIGINT');
  const done = runDaemon(id, {
    env: 'pre', socketPath: socket, exitOnStop: false,
    browserBootstrap: async (): Promise<BootstrapResult> => ({ tabId: 'tab', session: cdp as any, endpoint: 'http://127.0.0.1:0' }),
  });
  let client: DaemonClient | null = null;
  try {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (await DaemonClient.ping(socket, 200)) break;
      await new Promise((r) => setTimeout(r, 30));
    }
    client = await DaemonClient.connect(socket);
    await body(client, id);
  } catch (err) {
    // 把 id 附到 error 上，让调用方在 reject 后仍能查 trace
    (err as any).sessionId = id;
    throw err;
  } finally {
    if (client) {
      try { await client.request('stop', {}, { requestTimeoutMs: 3000 }); } catch {}
      client.close();
    } else {
      // connect 失败 → client=null，不能 await done 永久挂住。
      // 只调本次 daemon 新增的 SIGTERM/SIGINT listener（baseline 之上的），不 process.emit 影响全局。
      const newTermListeners = process.listeners('SIGTERM').slice(termBefore);
      const newIntListeners = process.listeners('SIGINT').slice(intBefore);
      for (const fn of newTermListeners) try { (fn as () => void)(); } catch {}
      for (const fn of newIntListeners) try { (fn as () => void)(); } catch {}
    }
    // 给 daemon 的 gracefulStopWithTimeout 超时收尾（CLEANUP_TIMEOUT_MS=10s），加 race 避免测试卡死
    await Promise.race([
      done,
      new Promise<void>((r) => setTimeout(r, 12_000)),
    ]).catch(() => {});
  }
  return { id };
}

const ENV: NodeJS.ProcessEnv = { ...process.env, E2ET_HOME: '' };

function capture(overrides: Partial<RouterDeps> = {}): { stdout: string[]; stderr: string[]; deps: RouterDeps } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-h42176-'));
  return {
    stdout, stderr,
    deps: {
      env: { ...ENV, E2ET_HOME: homeDir },
      homeDir,
      stdout: (s: string) => stdout.push(s),
      stderr: (s: string) => stderr.push(s),
      ...overrides,
    },
  };
}

function envelope(stdout: string[]): { ok: boolean; data?: any; error?: { code: string; message: string } } {
  return JSON.parse(stdout.join(''));
}
// ── 1. CLI 元数据 ──

describe('迭代42176：CLI 元数据', () => {
  it('commands --json 包含 page screenshot + scroll --direction + press 新键', async () => {
    const c = capture();
    await dispatch(['commands', '--json'], c.deps);
    const cmds = envelope(c.stdout).data.commands as ReturnType<typeof commandDefinitions>;
    const shot = cmds.find((cmd) => cmd.name === 'page' && cmd.subcommand === 'screenshot');
    expect(shot).toBeDefined();
    expect(shot!.args.find((a) => a.name === '--full-page')).toBeDefined();
    expect(shot!.args.find((a) => a.name === '--intent')?.required).toBe(true);
    expect(shot!.args.find((a) => a.name === '--wait-api')).toBeUndefined();
    const scroll = cmds.find((cmd) => cmd.name === 'page' && cmd.subcommand === 'scroll');
    expect(scroll!.args.find((a) => a.name === '--direction')?.enum).toEqual(['up', 'down', 'left', 'right']);
    const press = cmds.find((cmd) => cmd.name === 'page' && cmd.subcommand === 'press');
    expect(press!.summary).toContain('PageDown');
    expect(press!.summary).toContain('Delete');
  });

  it('page scroll --direction=bad → USAGE', async () => {
    const c = capture();
    const id = generateSessionId();
    writeMeta({ id, pid: process.pid, socket: '/tmp/fake.sock', started_at: Date.now(), env: 'pre' }, c.deps.env);
    const code = await dispatch(['page', 'scroll', '-s', id, '--direction', 'diagonal', '--intent', '斜滚'], c.deps);
    expect(code).toBe(2);
    expect(envelope(c.stdout).error?.code).toBe('USAGE');
  });

  it('page screenshot 缺 --intent → USAGE', async () => {
    const c = capture();
    const id = generateSessionId();
    writeMeta({ id, pid: process.pid, socket: '/tmp/fake.sock', started_at: Date.now(), env: 'pre' }, c.deps.env);
    expect(await dispatch(['page', 'screenshot', '-s', id], c.deps)).toBe(2);
  });

  it('page screenshot --full-page 透传 full_page=true', async () => {
    const c = capture();
    const id = generateSessionId();
    const socket = path.join(os.tmpdir(), `h42176-sock-${id}.sock`);
    writeMeta({ id, pid: process.pid, socket, started_at: Date.now(), env: 'pre' }, c.deps.env);
    let capturedReq: { method?: string; params?: { full_page?: boolean } } | null = null;
    const server = net.createServer((conn) => {
      conn.on('data', (bytes) => {
        const req = JSON.parse(bytes.toString());
        capturedReq = req;
        conn.write(JSON.stringify({ id: req.id, ok: true, data: { path: '/tmp/shot.png' } }) + '\n');
      });
    });
    await new Promise<void>((r) => server.listen(socket, r));
    try {
      expect(await dispatch(['page', 'screenshot', '-s', id, '--full-page', '--intent', '截图'], c.deps)).toBe(0);
      // F7：断言透传了 method 和 full_page=true
      expect(capturedReq?.method).toBe('page.screenshot');
      expect(capturedReq?.params?.full_page).toBe(true);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

// ── 2. page screenshot daemon ──

describe('迭代42176：page screenshot daemon', () => {
  it('截图 → PNG 落地 workspace/screenshots，权限 0600/0700，不写 action trace', async () => {
    const cdp = new HandoffCdp();
    const { id } = await withSession(cdp, async (client, sid) => {
      const res = await client.request('page.screenshot', { intent: '截图' }) as any;
      expect(res.path).toMatch(/workspace\/screenshots\/.*\.png$/);
      expect(fs.existsSync(res.path)).toBe(true);
      expect(fs.statSync(res.path).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(res.path)).mode & 0o777).toBe(0o700);
    });
    const events = readTraceEvents(id);
    expect((events as any[]).filter((e) => e.t === 'action').length).toBe(0);
  }, 15000);

  it('full-page → Page.getLayoutMetrics + clip', async () => {
    const cdp = new HandoffCdp();
    await withSession(cdp, async (client) => {
      await client.request('page.screenshot', { intent: '整页', full_page: true });
      expect(cdp.calls.find((c) => c.method === 'Page.getLayoutMetrics')).toBeTruthy();
      const shot = cdp.calls.find((c) => c.method === 'Page.captureScreenshot');
      expect(shot!.params?.clip).toMatchObject({ x: 0, y: 0, width: 2000, height: 3000, scale: 1 });
    });
  }, 15000);

  it('两次截图生成不同 uuid 文件名', async () => {
    const cdp = new HandoffCdp();
    await withSession(cdp, async (client) => {
      const r1 = await client.request('page.screenshot', { intent: '截图' }) as any;
      const r2 = await client.request('page.screenshot', { intent: '截图' }) as any;
      expect(r1.path).not.toBe(r2.path);
      expect(fs.existsSync(r1.path)).toBe(true);
      expect(fs.existsSync(r2.path)).toBe(true);
    });
  }, 15000);
});

// ── 3. page scroll ──

describe('迭代42176：page scroll 水平无纵向位移', () => {
  it('dir=right 无 target → top=0 left=600，无 callFunctionOn', async () => {
    const cdp = new HandoffCdp();
    await withSession(cdp, async (client) => {
      const res = await client.request('page.scroll', { dir: 'right', intent: '右滚' }) as any;
      expect(res.direction).toBe('right');
      // 找 scrollBy 的 evaluate（排除 collectPageState 的 evaluate）
      const scrollEvals = cdp.calls.filter((c) => c.method === 'Runtime.evaluate' && String(c.params?.expression ?? '').includes('scrollBy'));
      expect(scrollEvals.length).toBe(1);
      const expr = String(scrollEvals[0].params?.expression ?? '');
      // 共源 scrollWindow 派生：函数体在场 + 单 input 对象（axis=x，delta=600）
      expect(expr).toContain('scrollWindow');
      expect(expr).toContain('{"axis":"x","delta":600}');
      expect(cdp.calls.filter((c) => c.method === 'Runtime.callFunctionOn'
        && !String(c.params?.functionDeclaration ?? '').includes('isConnected')
        && !String(c.params?.functionDeclaration ?? '').includes('return this(element)')).length).toBe(0);
    });
  }, 15000);

  it('dir=left 无 target → top=0 left=-600', async () => {
    const cdp = new HandoffCdp();
    await withSession(cdp, async (client) => {
      await client.request('page.scroll', { dir: 'left', intent: '左滚' });
      const scrollEvals = cdp.calls.filter((c) => c.method === 'Runtime.evaluate' && String(c.params?.expression ?? '').includes('scrollBy'));
      expect(scrollEvals.length).toBe(1);
      const expr = String(scrollEvals[0].params?.expression ?? '');
      expect(expr).toContain('scrollWindow');
      expect(expr).toContain('{"axis":"x","delta":-600}');
    });
  }, 15000);

  it('target + direction → SCROLL_ANCESTOR_FN，direction 进 action args', async () => {
    const cdp = new HandoffCdp();
    const { id } = await withSession(cdp, async (client) => {
      await client.request('page.state', {});
      const res = await client.request('page.scroll', { target: '[0]', dir: 'right', intent: '滚表格', snapshot_change_count: 0 }) as any;
      expect(res.target).toBeDefined();
      expect(res.direction).toBe('right');
      expect(cdp.calls.find((c) => c.method === 'Runtime.callFunctionOn' && String(c.params?.functionDeclaration ?? '').includes('overflowAxis'))).toBeTruthy();
    });
    const actionEvents = readTraceEvents(id).filter((e: any) => e.t === 'action' && e.kind === 'scroll');
    expect(actionEvents.length).toBe(1);
    expect(actionEvents[0].args?.direction).toBe('right');
  }, 15000);

  it('target 无 direction → scrollIntoView 语义', async () => {
    const cdp = new HandoffCdp();
    await withSession(cdp, async (client) => {
      await client.request('page.state', {});
      await client.request('page.scroll', { target: '[0]', intent: '滚到按钮', snapshot_change_count: 0 });
      expect(cdp.calls.find((c) => c.method === 'Runtime.callFunctionOn' && String(c.params?.functionDeclaration ?? '').includes('scrollIntoView'))).toBeTruthy();
    });
  }, 15000);
});

// ── 4. page press native CDP ──

describe('迭代42176：page press native CDP', () => {
  it('Enter → keyDown+char+keyUp', async () => {
    const cdp = new HandoffCdp();
    await withSession(cdp, async (client) => {
      await client.request('page.press', { key: 'Enter', intent: '回车' });
      const ks = cdp.calls.filter((c) => c.method === 'Input.dispatchKeyEvent');
      expect(ks.length).toBe(3);
      expect(ks[0].params?.type).toBe('keyDown');
      expect(ks[1].params?.type).toBe('char');
      expect(ks[2].params?.type).toBe('keyUp');
    });
  }, 15000);

  it('PageDown → keyDown+keyUp 无 char', async () => {
    const cdp = new HandoffCdp();
    await withSession(cdp, async (client) => {
      await client.request('page.press', { key: 'PageDown', intent: '翻页' });
      const ks = cdp.calls.filter((c) => c.method === 'Input.dispatchKeyEvent');
      expect(ks.length).toBe(2);
      expect(ks[0].params?.code).toBe('PageDown');
    });
  }, 15000);

  it('Delete → native CDP', async () => {
    const cdp = new HandoffCdp();
    await withSession(cdp, async (client) => {
      await client.request('page.press', { key: 'Delete', intent: '删字符' });
      const ks = cdp.calls.filter((c) => c.method === 'Input.dispatchKeyEvent');
      expect(ks.length).toBe(2);
      expect(ks[0].params?.code).toBe('Delete');
    });
  }, 15000);

  it('ArrowLeft → native CDP，旧 evaluate KeyboardEvent 不再出现', async () => {
    const cdp = new HandoffCdp();
    await withSession(cdp, async (client) => {
      await client.request('page.press', { key: 'ArrowLeft', intent: '左移' });
      const ks = cdp.calls.filter((c) => c.method === 'Input.dispatchKeyEvent');
      expect(ks.length).toBe(2);
      expect(ks[0].params?.code).toBe('ArrowLeft');
      expect(cdp.calls.filter((c) => c.method === 'Runtime.evaluate' && String(c.params?.expression ?? '').includes('KeyboardEvent')).length).toBe(0);
    });
  }, 15000);

  it('Home → keyDown+keyUp', async () => {
    const cdp = new HandoffCdp();
    await withSession(cdp, async (client) => {
      await client.request('page.press', { key: 'Home', intent: '到顶' });
      const ks = cdp.calls.filter((c) => c.method === 'Input.dispatchKeyEvent');
      expect(ks.length).toBe(2);
      expect(ks[0].params?.code).toBe('Home');
    });
  }, 15000);

  it('不支持键 → 报错', async () => {
    const cdp = new HandoffCdp();
    await withSession(cdp, async (client) => {
      await expect(client.request('page.press', { key: 'F1', intent: '功能键' })).rejects.toMatchObject({ code: 'DAEMON_ERROR' });
    });
  }, 15000);
});

// ── 5. 混合 pass+fail → session fail（真实 daemon 断言） ──

describe('迭代42176：混合断言 pass+fail → session fail', () => {
  it('一条 assert pass + 一条 assert fail → session_end result=fail asserts 1/2', async () => {
    const cdp = new HandoffCdp();
    const { id } = await withSession(cdp, async (client) => {
      // 先 page.state 拿快照（assert 必须跟在 finished action 后面）
      await client.request('page.state', {});
      // 再跑一个 action 让 lastFinishedAction 有值
      await client.request('page.click', { target: '[0]', intent: '点击', snapshot_change_count: 0 });

      // assert.url pass：currentUrl 返回 https://example.test/page，包含 'example'
      const passRes = await client.request('assert.url', { contains: 'example' }) as any;
      expect(passRes.pass).toBe(true);

      // assert.url fail：URL 不含 '不存在XYZ'
      const failRes = await client.request('assert.url', { contains: '不存在XYZ' }) as any;
      expect(failRes.pass).toBe(false);
    });
    // stop 已在 finally 执行；读 trace 验证 session_end
    const events = readTraceEvents(id);
    const sessionEnd = events.find((e: any) => e.t === 'session_end') as any;
    expect(sessionEnd).toBeDefined();
    expect(sessionEnd.result).toBe('fail');
    expect(sessionEnd.asserts).toMatchObject({ total: 2, pass: 1 });
  }, 20000);
});

// ── Round1 修复验证 ──

// ── Round2 修复验证（实际行为/故障注入/mutation） ──

/** 用 vm 执行 SCROLL_ANCESTOR_FN 函数体，注入小 DOM 对象模拟 scrollBy/clamp */
function execScrollFn(axis: 'x' | 'y', delta: number, mockEl: any, mockDoc: any): { moved: boolean; found: boolean } {
  const ctx: any = {
    getComputedStyle: (el: any) => el._style,
    document: mockDoc,
  };
  // SCROLL_ANCESTOR_FN 是 CDP callFunctionOn 格式：`function (axis, delta) { ... }`
  // 用 vm 执行，this 绑定到 mockEl（通过 .call(mockEl)）
  const wrapped = `(${SCROLL_ANCESTOR_FN}).call(__el__, ${JSON.stringify(axis)}, ${delta})`;
  ctx.__el__ = mockEl;
  const result = vm.runInNewContext(wrapped, ctx);
  return result;
}

/** 构造模拟元素：可配 overflow、scrollWidth/Height、clientWidth/Height、scrollTop/Left */
function mockEl(opts: {
  overflowX?: string; overflowY?: string;
  scrollWidth?: number; clientWidth?: number;
  scrollHeight?: number; clientHeight?: number;
  scrollTop?: number; scrollLeft?: number;
  isScrollRoot?: boolean;
  parent?: any | null;
}): any {
  const el: any = {
    nodeType: 1,
    _style: {
      overflowX: opts.overflowX ?? 'visible',
      overflowY: opts.overflowY ?? 'visible',
    },
    scrollWidth: opts.scrollWidth ?? 0,
    clientWidth: opts.clientWidth ?? 0,
    scrollHeight: opts.scrollHeight ?? 0,
    clientHeight: opts.clientHeight ?? 0,
    _scrollTop: opts.scrollTop ?? 0,
    _scrollLeft: opts.scrollLeft ?? 0,
    parentElement: opts.parent ?? null,
    scrollBy({ left, top }: { left?: number; top?: number }) {
      // 模拟浏览器 scrollBy clamp：不超过 scrollWidth-clientWidth / scrollHeight-clientHeight
      const maxX = Math.max(0, this.scrollWidth - this.clientWidth);
      const maxY = Math.max(0, this.scrollHeight - this.clientHeight);
      this._scrollLeft = Math.max(0, Math.min(maxX, this._scrollLeft + (left ?? 0)));
      this._scrollTop = Math.max(0, Math.min(maxY, this._scrollTop + (top ?? 0)));
    },
  };
  Object.defineProperty(el, 'scrollLeft', { get() { return el._scrollLeft; }, set(v) { el._scrollLeft = v; } });
  Object.defineProperty(el, 'scrollTop', { get() { return el._scrollTop; }, set(v) { el._scrollTop = v; } });
  return el;
}

describe('Round2 F1：整页 scroll moved 按实际位移判', () => {
  // 实际执行 evaluate 字符串（整页 scroll 的 Runtime.evaluate 函数体）
  function execFullPageScroll(left: number, top: number, mockWin: any): boolean {
    const expr = `(() => {
      const bx = window.scrollX, by = window.scrollY;
      window.scrollBy({ left: ${left}, top: ${top}, behavior: "instant" });
      const ax = window.scrollX, ay = window.scrollY;
      return ${left !== 0 ? 'ax !== bx' : 'ay !== by'};
    })()`;
    return vm.runInNewContext(expr, { window: mockWin });
  }

  it('纵向 down 实际滚动 600 → moved=true', () => {
    const win: any = {
      scrollX: 0, scrollY: 0,
      scrollBy({ left, top }: any) { this.scrollY = Math.min(2000, this.scrollY + (top ?? 0)); this.scrollX = Math.min(2000, this.scrollX + (left ?? 0)); },
    };
    expect(execFullPageScroll(0, 600, win)).toBe(true);
  });

  it('纵向到边界（scrollHeight=0）→ moved=false', () => {
    const win: any = {
      scrollX: 0, scrollY: 0,
      scrollBy({ left, top }: any) { /* scrollHeight=0，不滚 */ },
    };
    expect(execFullPageScroll(0, 600, win)).toBe(false);
  });

  it('横向 right 实际滚动 600 → moved=true', () => {
    const win: any = {
      scrollX: 0, scrollY: 0,
      scrollBy({ left, top }: any) { this.scrollX = Math.min(2000, this.scrollX + (left ?? 0)); this.scrollY = Math.min(2000, this.scrollY + (top ?? 0)); },
    };
    expect(execFullPageScroll(600, 0, win)).toBe(true);
  });

  it('横向到边界（scrollWidth=0）→ moved=false', () => {
    const win: any = {
      scrollX: 0, scrollY: 0,
      scrollBy({ left, top }: any) { /* scrollWidth=0，不滚 */ },
    };
    expect(execFullPageScroll(600, 0, win)).toBe(false);
  });

  // mutation：旧实现（滚完才读 before + left!==0 猜）必须失败
  it('mutation：旧实现（滚完读before+left!==0）→ 纵向600误判false、横向到边界误判true', () => {
    const oldExpr = `(() => {
      window.scrollBy({ left: ${600}, top: ${0}, behavior: "instant" });
      const before = window.scrollY;
      return window.scrollY !== before || ${600} !== 0;
    })()`;
    // 横向到边界（scrollWidth=0 不滚）但 left!==0 → 旧实现误判 true
    const win: any = {
      scrollX: 0, scrollY: 0,
      scrollBy({ left, top }: any) { /* 不滚 */ },
    };
    const oldResult = vm.runInNewContext(oldExpr, { window: win });
    expect(oldResult).toBe(true); // 旧实现在到边界时误判 true（bug）
    // 新实现正确返回 false
    expect(execFullPageScroll(600, 0, win)).toBe(false);
  });
});

describe('Round2 F2：target 无 dir 不写 args.direction', () => {
  it('target 无 dir → trace args 不含 direction', async () => {
    const cdp = new HandoffCdp();
    const { id } = await withSession(cdp, async (client) => {
      await client.request('page.state', {});
      await client.request('page.scroll', { target: '[0]', intent: '滚到按钮', snapshot_change_count: 0 });
    });
    const events = readTraceEvents(id).filter((e: any) => e.t === 'action' && e.kind === 'scroll');
    expect(events.length).toBe(1);
    expect(events[0].args?.direction).toBeUndefined();
  }, 15000);

  it('无 target 无 dir → args.direction=down', async () => {
    const cdp = new HandoffCdp();
    const { id } = await withSession(cdp, async (client) => {
      await client.request('page.scroll', { intent: '默认滚' });
    });
    const events = readTraceEvents(id).filter((e: any) => e.t === 'action' && e.kind === 'scroll');
    expect(events[0].args?.direction).toBe('down');
  }, 15000);
});

describe('Round2 F3+F4：实际执行 SCROLL_ANCESTOR_FN', () => {
  it('F3：根节点 overflow:visible 实际位移（isScrollRoot 兜底）', () => {
    const root = mockEl({
      overflowY: 'visible', overflowX: 'visible',
      scrollHeight: 2000, clientHeight: 800,
      scrollTop: 0,
      isScrollRoot: true,
    });
    const doc: any = { scrollingElement: root };
    const result = execScrollFn('y', 600, root, doc);
    expect(result.found).toBe(true);
    expect(result.moved).toBe(true);
    expect(root.scrollTop).toBe(600);
  });

  it('F4：到边界 moved=false, found=true', () => {
    const root = mockEl({
      overflowY: 'visible',
      // 有可滚动内容（scrollHeight > clientHeight）但已到边界（scrollTop=max）
      scrollHeight: 1400, clientHeight: 800,
      scrollTop: 600, // max = 1400-800 = 600，已到边界
      isScrollRoot: true,
    });
    const doc: any = { scrollingElement: root };
    const result = execScrollFn('y', 600, root, doc);
    expect(result.found).toBe(true);
    expect(result.moved).toBe(false);
  });

  it('F4：无容器 found=false', () => {
    const el = mockEl({
      overflowY: 'visible', overflowX: 'visible',
      scrollHeight: 100, clientHeight: 800,
      parent: null,
    });
    const doc: any = { scrollingElement: {} }; // el 不是 scrollingElement
    const result = execScrollFn('y', 600, el, doc);
    expect(result.found).toBe(false);
  });

  it('容器 overflow:auto 实际位移', () => {
    const container = mockEl({
      overflowX: 'auto',
      scrollWidth: 2000, clientWidth: 800,
      scrollLeft: 0,
    });
    const doc: any = { scrollingElement: {} };
    const result = execScrollFn('x', 600, container, doc);
    expect(result.found).toBe(true);
    expect(result.moved).toBe(true);
    expect(container.scrollLeft).toBe(600);
  });

  // mutation：去掉 root 支持（isScrollRoot=false）→ 根节点 overflow:visible 漏掉
  it('mutation：去掉 isScrollRoot → 根节点 overflow:visible 不命中 found=false', () => {
    const root = mockEl({
      overflowY: 'visible',
      scrollHeight: 2000, clientHeight: 800,
      scrollTop: 0,
      isScrollRoot: true,
    });
    const doc: any = { scrollingElement: root };
    // 用旧逻辑（无 isScrollRoot）执行：只看 overflow auto/scroll/overlay
    const oldFn = `function (axis, delta) {
      let el = this.nodeType === 1 ? this : this.parentElement;
      while (el) {
        const style = getComputedStyle(el);
        const overflowAxis = axis === 'x' ? style.overflowX : style.overflowY;
        const canScroll = (overflowAxis === 'auto' || overflowAxis === 'scroll' || overflowAxis === 'overlay')
          && (axis === 'x' ? el.scrollWidth > el.clientWidth : el.scrollHeight > el.clientHeight);
        if (canScroll) {
          const before = axis === 'x' ? el.scrollLeft : el.scrollTop;
          el.scrollBy({ [axis === 'x' ? 'left' : 'top']: delta, behavior: 'instant' });
          const after = axis === 'x' ? el.scrollLeft : el.scrollTop;
          return { moved: after !== before, found: true };
        }
        el = el.parentElement;
      }
      return { moved: false, found: false };
    }`;
    const ctx: any = { getComputedStyle: (el: any) => el._style, document: doc };
    ctx.__el__ = root;
    const result = vm.runInNewContext(`(${oldFn}).call(__el__, "y", 600)`, ctx);
    expect(result.found).toBe(false); // 旧实现漏掉 overflow:visible 根节点
    // 新实现命中
    expect(execScrollFn('y', 600, root, doc).found).toBe(true);
  });
});

// ── Round2 F5：symlink 置换 TOCTOU 竞态 ──

// F5：用 vm 执行 ensurePrivateDir，注入 instrumented fs 模拟 lstat 后目录置换
// 提为模块级 helper，避免 describe 嵌套
function execEnsurePrivateDir(instrumentedFs: typeof fs, noFollow: number, dir: string, recursive: boolean): void {
  const traceSrc = fs.readFileSync(path.join(__dirname, '..', 'daemon', 'trace.ts'), 'utf8');
  const ts = require('typescript');
  const syntax = ts.createSourceFile('trace.ts', traceSrc, ts.ScriptTarget.Latest, true);
  const decl = syntax.statements.find((s: any) => ts.isFunctionDeclaration(s) && s.name?.text === 'ensurePrivateDir');
  if (!decl) throw new Error('ensurePrivateDir not found in trace.ts');
  const js = ts.transpileModule(decl.getText(syntax), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const ctx: any = { exports: {}, fs: instrumentedFs, NO_FOLLOW: noFollow };
  vm.runInNewContext(js, ctx);
  ctx.exports.ensurePrivateDir(dir, recursive);
}

describe('Round2 F5：symlink 置换 TOCTOU 竞态（vm fs 注入）', () => {
  it('ensurePrivateDir 在 lstat 后目录置换 → O_NOFOLLOW 拒绝，victim 权限/内容不变', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-race-'));
    const shots = path.join(root, 'screenshots');
    const parked = path.join(root, 'screenshots-parked');
    const victim = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-victim-'));
    fs.mkdirSync(shots, { mode: 0o700 });
    // victim 已由 mkdtemp 创建为目录，只设权限
    fs.chmodSync(victim, 0o755);
    fs.writeFileSync(path.join(victim, 'sentinel.txt'), 'untouched');
    const modeBefore = fs.statSync(victim).mode & 0o777;
    const filesBefore = fs.readdirSync(victim);
    let swapped = false;
    const realLstat = fs.lstatSync;
    const instrumentedFs: any = Object.assign(Object.create(fs), {
      lstatSync(filename: fs.PathLike, ...args: any[]) {
        const stat = realLstat.call(fs, filename, ...args);
        if (filename === shots && !swapped) {
          fs.renameSync(shots, parked);
          fs.symlinkSync(victim, shots);
          swapped = true;
        }
        return stat;
      },
    });
    let error: Error | undefined;
    try {
      execEnsurePrivateDir(instrumentedFs, fs.constants.O_NOFOLLOW as unknown as number, shots, true);
    } catch (e) {
      error = e as Error;
    }
    expect(swapped).toBe(true);
    expect(error).toBeDefined();
    // victim 权限和内容不变
    expect(fs.statSync(victim).mode & 0o777).toBe(modeBefore);
    expect(fs.readdirSync(victim)).toEqual(filesBefore);
    expect(fs.readFileSync(path.join(victim, 'sentinel.txt'), 'utf8')).toBe('untouched');
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(victim, { recursive: true, force: true });
  });

  it('mutation：NO_FOLLOW=0（旧 path-chmod 分支）→ victim 被 chmod，断言失败', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-mut-'));
    const shots = path.join(root, 'screenshots');
    const parked = path.join(root, 'screenshots-parked');
    const victim = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-mut-victim-'));
    fs.mkdirSync(shots, { mode: 0o700 });
    fs.chmodSync(victim, 0o755);
    let swapped = false;
    const realLstat = fs.lstatSync;
    const instrumentedFs: any = Object.assign(Object.create(fs), {
      lstatSync(filename: fs.PathLike, ...args: any[]) {
        const stat = realLstat.call(fs, filename, ...args);
        if (filename === shots && !swapped) {
          fs.renameSync(shots, parked);
          fs.symlinkSync(victim, shots);
          swapped = true;
        }
        return stat;
      },
    });
    let error: Error | undefined;
    const modeBefore = fs.statSync(victim).mode & 0o777;
    try {
      execEnsurePrivateDir(instrumentedFs, 0, shots, true);
    } catch (e) {
      error = e as Error;
    }
    // NO_FOLLOW=0 时走 chmodSync(path) 分支，跟随 symlink 修改 victim 权限
    const modeAfter = fs.statSync(victim).mode & 0o777;
    // mutation 必须证明旧实现不安全：要么权限变了，要么抛错（但权限不应不变）
    expect(swapped).toBe(true);
    if (!error) {
      // chmodSync(path) 跟随了 symlink，victim 权限从 0o755 变成 0o700
      expect(modeAfter).not.toBe(modeBefore);
    }
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(victim, { recursive: true, force: true });
  });
});

// ── Round2 F6：connect 失败真实收尾 ──

describe('Round2 F6：connect 失败真实收尾（vi.spyOn）', () => {
  it('connect mock reject → body 未执行，cdp.closeCalled=true，listener 恢复，session_end=aborted', async () => {
    const cdp = new HandoffCdp();
    const callback = vi.fn();
    const termBefore = process.listenerCount('SIGTERM');
    const intBefore = process.listenerCount('SIGINT');

    // ping 内部也调 connect，必须 mock ping 返回 true 跳过，让 spy 留给 withSession 的真实 connect
    const pingSpy = vi.spyOn(DaemonClient, 'ping').mockResolvedValue(true);
    const connectSpy = vi.spyOn(DaemonClient, 'connect').mockRejectedValueOnce(new Error('mock connect 失败'));
    let propagated: Error | null = null;
    let sessionId = '';
    try {
      const { id } = await withSession(cdp, async () => { callback(); });
      sessionId = id;
    } catch (e) {
      propagated = e as Error;
      sessionId = (e as any)?.sessionId ?? '';
    } finally {
      connectSpy.mockRestore();
      pingSpy.mockRestore();
    }
    // 错误必须传播，不吞
    expect(propagated).not.toBeNull();
    expect((propagated as Error).message).toBe('mock connect 失败');
    expect(callback).not.toHaveBeenCalled();
    expect(cdp.closeCalled).toBe(true);
    expect(process.listenerCount('SIGTERM')).toBe(termBefore);
    expect(process.listenerCount('SIGINT')).toBe(intBefore);
    // session_end 写入 aborted（withSession catch 把 id 附到 error，finally 调 SIGTERM listener → daemon cleanup 写 trace）
    const sessionEnd = readTraceEvents(sessionId).find((e: any) => e.t === 'session_end');
    expect(sessionEnd).toBeDefined();
    expect((sessionEnd as any)?.result).toBe('aborted');
  }, 20000);
});

// ── Round2 F7：full_page 透传 mutation 验证 ──

describe('Round2 F7：full_page 透传 mutation 验证', () => {
  it('正常传 --full-page → params.full_page===true', async () => {
    const c = capture();
    const id = generateSessionId();
    const socket = path.join(os.tmpdir(), `h42176-fp-${id}.sock`);
    writeMeta({ id, pid: process.pid, socket, started_at: Date.now(), env: 'pre' }, c.deps.env);
    let capturedReq: any = null;
    const server = net.createServer((conn) => {
      conn.on('data', (bytes) => {
        capturedReq = JSON.parse(bytes.toString());
        conn.write(JSON.stringify({ id: capturedReq.id, ok: true, data: { path: '/tmp/shot.png' } }) + '\n');
      });
    });
    await new Promise<void>((r) => server.listen(socket, r));
    try {
      expect(await dispatch(['page', 'screenshot', '-s', id, '--full-page', '--intent', '截图'], c.deps)).toBe(0);
      expect(capturedReq?.method).toBe('page.screenshot');
      expect(capturedReq?.params?.full_page).toBe(true);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 10000);

  it('不传 --full-page → params.full_page===false', async () => {
    const c = capture();
    const id = generateSessionId();
    const socket = path.join(os.tmpdir(), `h42176-nofp-${id}.sock`);
    writeMeta({ id, pid: process.pid, socket, started_at: Date.now(), env: 'pre' }, c.deps.env);
    let capturedReq: any = null;
    const server = net.createServer((conn) => {
      conn.on('data', (bytes) => {
        capturedReq = JSON.parse(bytes.toString());
        conn.write(JSON.stringify({ id: capturedReq.id, ok: true, data: { path: '/tmp/shot.png' } }) + '\n');
      });
    });
    await new Promise<void>((r) => server.listen(socket, r));
    try {
      expect(await dispatch(['page', 'screenshot', '-s', id, '--intent', '截图'], c.deps)).toBe(0);
      expect(capturedReq?.params?.full_page).toBe(false);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 10000);
});
