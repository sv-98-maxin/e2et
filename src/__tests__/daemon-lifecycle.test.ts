/**
 * daemon 生命周期集成测试。
 *
 * start→state→stop / 空闲超时 / 并发两个会话：进程内注入假浏览器层（不连真实 CDP），
 *   exitOnStop=false 让 gracefulStop 不调 process.exit，改为 resolve keep-alive。
 * SIGTERM→aborted：必须真实子进程 + 真实信号，无浏览器时 skipIf。
 *
 * F1/F2 隔离测试：用 node -e 常驻子进程模拟浏览器进程组，验证 pid 回收与目录清理。
 * F5 DOM 计数：注入假 CdpSession 模拟 DOM 变化 + frameNavigated 事件，验证 change_count 递增。
 * F6 孤儿防误杀：校验 user-data-dir 前缀与 pid 命令行。
 *
 * 真实 defaultBootstrap + exitOnStop:true 集成测试（需 Chrome，skipIf）：
 *   并发 session start / stop A 后 B 可用 / SIGKILL 回收 / bootstrap 失败不留孤儿。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { DaemonClient } from '../daemon/client.js';
import { runDaemon } from '../daemon/daemon.js';
import type { BootstrapResult } from '../daemon/bootstrap.js';
import { resolveChromiumExecutable } from '../browser/managed-browser.js';
import { isProcessAlive } from '../browser/process-utils.js';
import {
  generateSessionId,
  resolveSocketPath,
  readMeta,
  writeMeta,
  sessionsDir,
  traceDir,
  cleanupOrphanBrowser,
  listSessions,
} from '../daemon/session-meta.js';

// 私有 TMPDIR：所有 mkdtemp / daemon spawn 的 os.tmpdir() 都落这里，afterAll 只清这一个目录
const PRIVATE_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-tmp-'));
const TMP_HOME = path.join(PRIVATE_TMP, 'home');
fs.mkdirSync(TMP_HOME, { recursive: true });

// managed/SIGTERM 真实子进程用：本文件私有的合法 storageState fixture（非用户凭据）。
// 生命周期测试只访问 about:blank，不应依赖本机/CI 真实账号 cookie。
const LIFECYCLE_AUTH_STATE = path.join(PRIVATE_TMP, 'lifecycle-auth-state.json');
const ENV: NodeJS.ProcessEnv = { ...process.env, E2ET_HOME: TMP_HOME, E2ET_IDLE_TIMEOUT_MS: '1500', TMPDIR: PRIVATE_TMP };
const SAVED_HOME = process.env.E2ET_HOME;
const SAVED_IDLE = process.env.E2ET_IDLE_TIMEOUT_MS;
const SAVED_TMPDIR = process.env.TMPDIR;

// 进程内 daemon 用 process.env 解析路径，故在此注入；afterAll 还原
beforeAll(() => {
  process.env.E2ET_HOME = TMP_HOME;
  process.env.E2ET_IDLE_TIMEOUT_MS = '1500';
  process.env.TMPDIR = PRIVATE_TMP;
  fs.mkdirSync(sessionsDir(ENV), { recursive: true });
  // 写合法 storageState fixture：EXAMPLE_SESSION + X-XSRF-TOKEN，未来过期，.example.invalid /
  // 字面值 lifecycle-test-fixture，不是用户凭据 —— 只过 auth-check 新鲜度校验
  const futureExpires = Math.floor(Date.now() / 1000) + 86400;
  fs.writeFileSync(LIFECYCLE_AUTH_STATE, JSON.stringify({
    cookies: [
      { name: 'EXAMPLE_SESSION', value: 'lifecycle-test-fixture', domain: '.example.invalid', path: '/', expires: futureExpires, httpOnly: true, secure: true, sameSite: 'Lax' },
      { name: 'X-XSRF-TOKEN', value: 'lifecycle-test-fixture', domain: '.example.invalid', path: '/', expires: futureExpires, httpOnly: false, secure: true, sameSite: 'Lax' },
    ],
    origins: [],
  }));
});
afterAll(() => {
  if (SAVED_HOME === undefined) delete process.env.E2ET_HOME; else process.env.E2ET_HOME = SAVED_HOME;
  if (SAVED_IDLE === undefined) delete process.env.E2ET_IDLE_TIMEOUT_MS; else process.env.E2ET_IDLE_TIMEOUT_MS = SAVED_IDLE;
  if (SAVED_TMPDIR === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = SAVED_TMPDIR;
  fs.rmSync(PRIVATE_TMP, { recursive: true, force: true });
});

/** 沙箱可能禁止 ps（EPERM），无法校验 pid 命令行 → orphan 回收相关用例 skip */
const canRunPs = (() => {
  try {
    execSync(`ps -o command= -p ${process.pid}`, { encoding: 'utf8', timeout: 2000 });
    return true;
  } catch { return false; }
})();

/** 桩 CdpSession：支持事件监听（_emit）+ DOM 计数控制（_bumpChange）。 */
function fakeCdpSession(axNodes: any[] = []): any {
  let url = 'about:blank';
  let changeCount = 0;
  let objectId = 0;
  const listeners: Array<{ method: string; handler: (params: any) => void }> = [];
  return {
    send: async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'Accessibility.enable') return {};
      if (method === 'Accessibility.getFullAXTree') return { nodes: axNodes };
      if (method === 'Page.enable' || method === 'Page.navigate') return {};
      if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: '1' };
      if (method === 'Runtime.enable') return {};
      // P2：page.state 身份合同需要主 frame 身份（loaderId 空串 = 初始 about:blank 合法）
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main', loaderId: '', url, urlFragment: '', securityOrigin: '' } } };
      if (method === 'DOM.resolveNode') return { object: { objectId: 'obj-' + (++objectId) } };
      if (method === 'Runtime.callFunctionOn') {
        const fd = String(params.functionDeclaration);
        if (params.returnByValue === false && fd.includes('isElementVisible')) return { result: { type: 'function', objectId: 'snapshot-visibility-fn' } };
        if (fd.includes('return this(element)') || fd.includes('isConnected')) return { result: { value: { connected: true, visible: true } } };
      }
      return {};
    },
    evaluate: async (expr: string) => {
      if (expr.includes('location.href')) return url;
      if (expr.includes('readyState')) return 'complete';
      if (expr.includes('__e2etChangeCount')) return changeCount;
      if (expr.includes('__e2etObserver')) return true;
      return '';
    },
    on: (method: string, handler: (params: any) => void) => {
      const entry = { method, handler };
      listeners.push(entry);
      return () => {
        const i = listeners.indexOf(entry);
        if (i !== -1) listeners.splice(i, 1);
      };
    },
    _emit: (method: string, params: any) => {
      // 模拟新 document：frameNavigated 后 __e2etChangeCount 归零（addScriptToEvaluateOnNewDocument 重注入）
      if (method === 'Page.frameNavigated' && params?.frame?.parentId === undefined) {
        changeCount = 0;
      }
      for (const l of listeners) {
        if (l.method === method) l.handler(params);
      }
    },
    close: () => {},
    onClose: () => {},
    // 测试辅助：模拟 DOM 变化
    _bumpChange: () => { changeCount++; },
    // 测试辅助：模拟 URL 变化
    _setUrl: (u: string) => { url = u; },
  };
}

/** 返回 bootstrap 函数 + 内部 fake cdp 引用（测试可控制 DOM 变化 / 事件） */
function fakeBootstrap(axNodes: any[] = []): { bootstrap: () => Promise<BootstrapResult>; cdp: any } {
  const cdp = fakeCdpSession(axNodes);
  return {
    bootstrap: async () => ({
      tabId: 'fake-tab-' + Math.random().toString(36).slice(2, 6),
      session: cdp,
      endpoint: 'http://127.0.0.1:0',
    }),
    cdp,
  };
}

async function startDaemon(id: string, axNodes: any[] = []): Promise<{ socket: string; done: Promise<void>; stop: () => Promise<any> }> {
  const socket = resolveSocketPath(id, ENV);
  fs.rmSync(socket, { force: true });
  const { bootstrap, cdp } = fakeBootstrap(axNodes);
  const done = runDaemon(id, { env: 'pre', socketPath: socket, browserBootstrap: bootstrap, exitOnStop: false });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await DaemonClient.ping(socket, 500)) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  return {
    socket,
    done,
    cdp, // 暴露 fake cdp 供测试控制 DOM 变化 / 事件
    stop: async () => {
      try {
        const c = await DaemonClient.connect(socket, { connectTimeoutMs: 2000 });
        const res = await c.request('stop', {}, { requestTimeoutMs: 15_000 }) as { result?: string };
        c.close();
        try { await done; } catch { /* ignore */ }
        return res;
      } catch {
        try { await done; } catch { /* ignore */ }
        return { result: 'error' };
      }
    },
  };
}

describe('daemon 生命周期（注入假浏览器层，进程内）', () => {
  it('start → page.state → stop：0 断言 session_end 为 blocked，stop 响应带 result', async () => {
    const id = generateSessionId();
    const { socket, stop } = await startDaemon(id);

    const c = await DaemonClient.connect(socket, { connectTimeoutMs: 2000 });
    const data = await c.request('page.state', {}, { requestTimeoutMs: 5000 });
    c.close();
    expect((data as any).snapshot_id).toBe(1);

    const res = await stop() as { result?: string };
    expect(res.result).toBe('blocked');

    const meta = readMeta(id, ENV);
    expect(meta?.session_end?.result).toBe('blocked');

    const trace = fs.readFileSync(path.join(traceDir(id, ENV), 'trace.jsonl'), 'utf8').trim().split('\n');
    expect(trace.length).toBeGreaterThanOrEqual(2);
    expect(JSON.parse(trace[0]).t).toBe('session');
    expect(JSON.parse(trace[trace.length - 1]).t).toBe('session_end');
  }, 15000);

  it('空闲超时 → session_end aborted', async () => {
    const id = generateSessionId();
    await startDaemon(id);
    // IDLE=1500ms，等 3s
    await new Promise((r) => setTimeout(r, 3000));
    const meta = readMeta(id, ENV);
    expect(meta?.session_end?.result).toBe('aborted');
  }, 15000);

  it('并发两个会话互不影响（各自 socket + 各自 stop）', async () => {
    const id1 = generateSessionId();
    const id2 = generateSessionId();
    const a = await startDaemon(id1);
    const b = await startDaemon(id2);

    expect(a.socket).not.toBe(b.socket);

    const ca = await DaemonClient.connect(a.socket, { connectTimeoutMs: 2000 });
    const cb = await DaemonClient.connect(b.socket, { connectTimeoutMs: 2000 });
    const da = await ca.request('page.state', {}, { requestTimeoutMs: 5000 });
    const db = await cb.request('page.state', {}, { requestTimeoutMs: 5000 });
    ca.close();
    cb.close();
    expect((da as any).snapshot_id).toBe(1);
    expect((db as any).snapshot_id).toBe(1);

    // 停 a，b 仍活
    const resA = await a.stop() as { result?: string };
    expect(resA.result).toBe('blocked');
    const metaB = readMeta(id2, ENV);
    expect(metaB?.session_end).toBeUndefined();

    // b 的 page.state 仍可用
    const cb2 = await DaemonClient.connect(b.socket, { connectTimeoutMs: 2000 });
    const db2 = await cb2.request('page.state', {}, { requestTimeoutMs: 5000 });
    cb2.close();
    expect((db2 as any).snapshot_id).toBe(2);

    const resB = await b.stop() as { result?: string };
    expect(resB.result).toBe('blocked');
    expect(readMeta(id1, ENV)?.session_end?.result).toBe('blocked');
    expect(readMeta(id2, ENV)?.session_end?.result).toBe('blocked');
  }, 20000);

  it('F3：stop 响应的 result 与 meta 落盘一致', async () => {
    const id = generateSessionId();
    const { stop } = await startDaemon(id);
    const res = await stop() as { result?: string };
    const meta = readMeta(id, ENV);
    expect(res.result).toBe(meta?.session_end?.result);
  }, 15000);

  it('F5：DOM 变化后连读两次只增 1；无变化时不增；reload 计入', async () => {
    const id = generateSessionId();
    const { socket, cdp, stop } = await startDaemon(id);

    const c = await DaemonClient.connect(socket, { connectTimeoutMs: 2000 });

    // 第一次 page.state：无导航无 DOM 变化 → change_count = 0
    const d1 = await c.request('page.state', {}, { requestTimeoutMs: 5000 }) as any;
    expect(d1.change_count).toBe(0);

    // 第二次 page.state（无变化）→ 仍 0
    const d2 = await c.request('page.state', {}, { requestTimeoutMs: 5000 }) as any;
    expect(d2.change_count).toBe(0);

    // 触发一次 DOM 变化
    cdp._bumpChange();

    // 第三次 page.state → +1
    const d3 = await c.request('page.state', {}, { requestTimeoutMs: 5000 }) as any;
    expect(d3.change_count).toBe(1);

    // 第四次 page.state（无新变化）→ 不增
    const d4 = await c.request('page.state', {}, { requestTimeoutMs: 5000 }) as any;
    expect(d4.change_count).toBe(1);

    // 模拟 reload：主帧 frameNavigated 事件
    cdp._emit('Page.frameNavigated', { frame: { parentId: undefined } });

    // 第五次 page.state → reload 计入 +1 = 2
    const d5 = await c.request('page.state', {}, { requestTimeoutMs: 5000 }) as any;
    expect(d5.change_count).toBe(2);

    c.close();
    try { await stop(); } catch { /* ignore */ }
  }, 15000);

  it('daemon 路径不触发 discoveryBase / ensureManagedBrowser', async () => {
    // fakeBootstrap 带 endpoint，doCleanup 走 closeTabIn(endpoint, tabId)，
    // 不应回落到 discoveryBase → ensureManagedBrowser（会拉起真实 Chrome）
    // 间接验证：endpoint 已必填（BootstrapResult.endpoint: string），无 endpoint 的 bootstrap 编译不过
    const id = generateSessionId();
    const { socket, stop } = await startDaemon(id);

    // page.state 能正常工作
    const c = await DaemonClient.connect(socket, { connectTimeoutMs: 2000 });
    const data = await c.request('page.state', {}, { requestTimeoutMs: 5000 });
    c.close();
    expect((data as any).snapshot_id).toBe(1);

    // stop 正常返回 blocked（0 断言，closeTabIn 没走 discoveryBase）
    const res = await stop() as { result?: string };
    expect(res.result).toBe('blocked');

    // 全局 managed-browser.json 不应被改动（验证在 reviewer 本机做：这里只验证 stop 不报错）
    const meta = readMeta(id, ENV);
    expect(meta?.session_end?.result).toBe('blocked');
  }, 15000);

  it('start → stop 后 SIGTERM/SIGINT 监听恢复 baseline（第三方监听保留）', async () => {
    const termBefore = process.listenerCount('SIGTERM');
    const intBefore = process.listenerCount('SIGINT');
    // 预先添加第三方监听，确认 daemon 收尾后它仍在
    const thirdParty = () => {};
    process.on('SIGTERM', thirdParty);
    try {
      const id = generateSessionId();
      const { stop } = await startDaemon(id);
      const res = await stop() as { result?: string };
      expect(res.result).toBe('blocked');
      // daemon 注册的 handler 已在 doCleanup finally 中 off 掉
      expect(process.listenerCount('SIGTERM')).toBe(termBefore + 1); // 第三方仍在
      expect(process.listenerCount('SIGINT')).toBe(intBefore);       // daemon 的已移除
    } finally {
      process.off('SIGTERM', thirdParty);
    }
    // finally 后恢复完全 baseline
    expect(process.listenerCount('SIGTERM')).toBe(termBefore);
    expect(process.listenerCount('SIGINT')).toBe(intBefore);
  }, 15000);

  it('digest 截断时 page.state 响应含 total_elements，未截断时不含', async () => {
    // 160 个交互节点 → 截断
    const manyNodes = Array.from({ length: 160 }, (_, i) => ({
      nodeId: String(i + 1),
      ignored: false,
      role: { type: 'role', value: 'combobox' },
      name: { type: 'computedString', value: `控件${i}` },
      backendDOMNodeId: 100 + i,
      properties: [],
      childIds: [],
    }));
    const id1 = generateSessionId();
    const { socket: s1, stop: stop1 } = await startDaemon(id1, manyNodes);
    try {
      const c = await DaemonClient.connect(s1, { connectTimeoutMs: 2000 });
      const data = await c.request('page.state', {}, { requestTimeoutMs: 5000 }) as any;
      c.close();
      expect(data.truncated).toBe(true);
      expect(data.total_elements).toBe(160);
      expect(data.elements).toHaveLength(150);
    } finally {
      await stop1();
    }

    // 10 个交互节点 → 未截断
    const fewNodes = Array.from({ length: 10 }, (_, i) => ({
      nodeId: String(i + 1),
      ignored: false,
      role: { type: 'role', value: 'combobox' },
      name: { type: 'computedString', value: `控件${i}` },
      backendDOMNodeId: 200 + i,
      properties: [],
      childIds: [],
    }));
    const id2 = generateSessionId();
    const { socket: s2, stop: stop2 } = await startDaemon(id2, fewNodes);
    try {
      const c = await DaemonClient.connect(s2, { connectTimeoutMs: 2000 });
      const data = await c.request('page.state', {}, { requestTimeoutMs: 5000 }) as any;
      c.close();
      expect(data.truncated).toBeUndefined();
      expect(data.total_elements).toBeUndefined();
      expect(data.elements).toHaveLength(10);
    } finally {
      await stop2();
    }
  }, 15000);
});

// auth_source / browser_source 落 meta + trace（fakeBootstrap 返回带字段）
describe('auth_source / browser_source 落 meta + trace', () => {
  it('fakeBootstrap 带 authSource/browserSource → meta + trace session 事件含字段', async () => {
    const id = generateSessionId();
    const socket = resolveSocketPath(id, ENV);
    fs.rmSync(socket, { force: true });
    const cdp = fakeCdpSession();
    const bootstrap = async () => ({
      tabId: 'fake-auth-tab',
      session: cdp,
      endpoint: 'http://127.0.0.1:0',
      authSource: 'imported' as const,
      browserSource: 'managed' as const,
    });
    const done = runDaemon(id, { env: 'pre', socketPath: socket, browserBootstrap: bootstrap, exitOnStop: false });
    try {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (await DaemonClient.ping(socket, 500)) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      const meta = readMeta(id, ENV);
      expect(meta?.auth_source).toBe('imported');
      expect(meta?.browser_source).toBe('managed');
      const trace = fs.readFileSync(path.join(traceDir(id, ENV), 'trace.jsonl'), 'utf8').trim().split('\n');
      const sessionEvt = JSON.parse(trace[0]);
      expect(sessionEvt.t).toBe('session');
      expect(sessionEvt.auth_source).toBe('imported');
      expect(sessionEvt.browser_source).toBe('managed');
    } finally {
      try {
        const cl = await DaemonClient.connect(socket, { connectTimeoutMs: 2000 });
        await cl.request('stop', {}, { requestTimeoutMs: 15_000 });
        cl.close();
      } catch { /* ignore */ }
      try { await done; } catch { /* ignore */ }
    }
  }, 15000);

  it('fakeBootstrap 不带 authSource/browserSource → meta + trace 不含字段（native-cdp 语义）', async () => {
    const id = generateSessionId();
    const socket = resolveSocketPath(id, ENV);
    fs.rmSync(socket, { force: true });
    const cdp = fakeCdpSession();
    const bootstrap = async () => ({
      tabId: 'fake-native-tab',
      session: cdp,
      endpoint: 'http://127.0.0.1:0',
      browserSource: 'existing' as const,
    });
    const done = runDaemon(id, { env: 'pre', socketPath: socket, browserBootstrap: bootstrap, exitOnStop: false });
    try {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (await DaemonClient.ping(socket, 500)) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      const meta = readMeta(id, ENV);
      expect(meta?.auth_source).toBeUndefined();
      expect(meta?.browser_source).toBe('existing');
      const trace = fs.readFileSync(path.join(traceDir(id, ENV), 'trace.jsonl'), 'utf8').trim().split('\n');
      const sessionEvt = JSON.parse(trace[0]);
      expect(sessionEvt.auth_source).toBeUndefined();
      expect(sessionEvt.browser_source).toBe('existing');
    } finally {
      try {
        const cl = await DaemonClient.connect(socket, { connectTimeoutMs: 2000 });
        await cl.request('stop', {}, { requestTimeoutMs: 15_000 });
        cl.close();
      } catch { /* ignore */ }
      try { await done; } catch { /* ignore */ }
    }
  }, 15000);
});

// F1/F2：每会话浏览器隔离测试
// 用 node -e 常驻子进程模拟浏览器，验证 daemon 收尾时杀自己的进程组 + 删临时目录
describe.skipIf(!canRunPs)('F1/F2 每会话浏览器隔离（node -e 模拟浏览器进程组）', () => {
  it('stop A 后 B 的浏览器进程不受影响', async () => {
    const id1 = generateSessionId();
    const id2 = generateSessionId();

    // 起两个独立 node 子进程模拟浏览器
    const tmpDir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'e2et-test-1-'));
    const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'e2et-test-2-'));
    const child1 = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { detached: true, stdio: 'ignore' });
    const child2 = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { detached: true, stdio: 'ignore' });
    child1.unref();
    child2.unref();

    const pid1 = child1.pid!;
    const pid2 = child2.pid!;

    // 注入 bootstrap 返回各自浏览器信息
    const boot1 = async (): Promise<BootstrapResult> => ({
      tabId: 'tab-1', session: fakeCdpSession(),
      browserPid: pid1, endpoint: 'http://127.0.0.1:9999', browserUserDataDir: tmpDir1,
    });
    const boot2 = async (): Promise<BootstrapResult> => ({
      tabId: 'tab-2', session: fakeCdpSession(),
      browserPid: pid2, endpoint: 'http://127.0.0.1:9998', browserUserDataDir: tmpDir2,
    });

    const sock1 = resolveSocketPath(id1, ENV);
    const sock2 = resolveSocketPath(id2, ENV);
    fs.rmSync(sock1, { force: true });
    fs.rmSync(sock2, { force: true });

    const done1 = runDaemon(id1, { env: 'pre', socketPath: sock1, browserBootstrap: boot1, exitOnStop: false });
    const done2 = runDaemon(id2, { env: 'pre', socketPath: sock2, browserBootstrap: boot2, exitOnStop: false });

    // 失败路径兜底：任一 expect 挂掉都回收本用例启动的两个子进程 + 两个临时目录，
    // 不靠 60s 空闲自退，也不吞断言失败（finally 只清进程/目录，不改 expect 结果）
    const cleanup = async () => {
      for (const sock of [sock1, sock2]) {
        try { const c = await DaemonClient.connect(sock, { connectTimeoutMs: 1000 }); await c.request('stop', {}, { requestTimeoutMs: 15_000 }); c.close(); } catch { /* daemon 已不可达 */ }
      }
      try { await done1; } catch { /* ignore */ }
      try { await done2; } catch { /* ignore */ }
      for (const p of [pid1, pid2]) { try { process.kill(p, 'SIGKILL'); } catch { /* 已死 */ } }
      for (const d of [tmpDir1, tmpDir2]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
    };

    try {
      // 等两个都就绪
      for (const sock of [sock1, sock2]) {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          if (await DaemonClient.ping(sock, 500)) break;
          await new Promise((r) => setTimeout(r, 50));
        }
      }

      // 确认两个浏览器进程都活
      expect(isAlive(pid1)).toBe(true);
      expect(isAlive(pid2)).toBe(true);

      // stop A
      const c1 = await DaemonClient.connect(sock1, { connectTimeoutMs: 2000 });
      await c1.request('stop', {}, { requestTimeoutMs: 15_000 });
      c1.close();
      try { await done1; } catch { /* ignore */ }

      // A 的浏览器进程应该被杀
      await new Promise((r) => setTimeout(r, 500));
      expect(isAlive(pid1)).toBe(false);
      expect(fs.existsSync(tmpDir1)).toBe(false);

      // B 的浏览器进程应该还活着
      expect(isAlive(pid2)).toBe(true);
      expect(fs.existsSync(tmpDir2)).toBe(true);

      // 清理 B
      const c2 = await DaemonClient.connect(sock2, { connectTimeoutMs: 2000 });
      await c2.request('stop', {}, { requestTimeoutMs: 15_000 });
      c2.close();
      try { await done2; } catch { /* ignore */ }

      await new Promise((r) => setTimeout(r, 500));
      expect(isAlive(pid2)).toBe(false);
      expect(fs.existsSync(tmpDir2)).toBe(false);
    } finally {
      await cleanup();
    }
  }, 20000);

  it('F6：SIGKILL 后 session list 收掉孤儿浏览器（正确前缀 + 命令行校验）', async () => {
    const id = generateSessionId();
    // 临时目录前缀带 sid（与 defaultBootstrap 一致）
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `e2et-${id}-`));
    // 进程命令行包含 --user-data-dir=<该目录>（用 -- 分隔，避免 node 把它当 flag）
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)', '--', `--user-data-dir=${tmpDir}`], { detached: true, stdio: 'ignore' });
    child.unref();
    const browserPid = child.pid!;

    // 写 meta：daemon pid 已死（用不存在的 pid），browser_pid 指向真实子进程
    const sock = resolveSocketPath(id, ENV);
    writeMeta({
      id, pid: 999999, socket: sock,
      started_at: Date.now(), env: 'pre', transport: 'managed',
      browser_pid: browserPid, browser_user_data_dir: tmpDir, browser_endpoint: 'http://127.0.0.1:9997',
    }, ENV);

    try {
      // 确认浏览器进程活 + 目录存在
      expect(isAlive(browserPid)).toBe(true);
      expect(fs.existsSync(tmpDir)).toBe(true);

      // session list 应该标 aborted + 收掉孤儿浏览器
      const sessions = listSessions(ENV);
      const s = sessions.find((x) => x.id === id);
      expect(s?.status).toBe('aborted');

      // 给 cleanupOrphanBrowser 的 SIGTERM + 轮询一点时间
      await new Promise((r) => setTimeout(r, 1000));
      expect(isAlive(browserPid)).toBe(false);
      expect(fs.existsSync(tmpDir)).toBe(false);

      // 确认 meta 已写回 session_end + orphan_cleaned
      const metaAfter = readMeta(id, ENV);
      expect(metaAfter?.session_end?.result).toBe('aborted');
      expect(metaAfter?.orphan_cleaned).toBe(true);

      // 第二次 list 不应再尝试杀（进程已死）
      listSessions(ENV);
    } finally {
      // 失败路径兜底：断言挂在 listSessions 之前时，本会话 list 回收孤儿浏览器与目录（幂等）
      listSessions(ENV);
    }
  }, 15000);

  it('F6：孤儿防误杀 — 命令行不含 --user-data-dir 时不杀不删', async () => {
    const id = generateSessionId();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `e2et-${id}-`));
    // 进程命令行不含 --user-data-dir=<该目录>（但目录前缀匹配，只靠 cmdline 校验拦截）
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { detached: true, stdio: 'ignore' });
    child.unref();
    const browserPid = child.pid!;

    const sock = resolveSocketPath(id, ENV);
    writeMeta({
      id, pid: 999999, socket: sock,
      started_at: Date.now(), env: 'pre', transport: 'managed',
      browser_pid: browserPid, browser_user_data_dir: tmpDir, browser_endpoint: 'http://127.0.0.1:9996',
    }, ENV);

    try {
      expect(isAlive(browserPid)).toBe(true);

      // session list 标 aborted 但不杀不删（命令行校验不通过）
      const sessions = listSessions(ENV);
      const s = sessions.find((x) => x.id === id);
      expect(s?.status).toBe('aborted');

      // 进程应该还活着 + 目录还在
      await new Promise((r) => setTimeout(r, 500));
      expect(isAlive(browserPid)).toBe(true);
      expect(fs.existsSync(tmpDir)).toBe(true);
    } finally {
      // listSessions 不会杀这个进程（命令行校验不通过），失败路径手动回收本用例的子进程 + 目录
      try { process.kill(browserPid, 'SIGKILL'); } catch { /* ignore */ }
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }, 15000);

  it('F6：孤儿防误杀 — 目录前缀不匹配时不杀不删', async () => {
    const id = generateSessionId();
    // 目录前缀不匹配（不含本会话 sid）
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2et-misfire-'));
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)', '--', `--user-data-dir=${tmpDir}`], { detached: true, stdio: 'ignore' });
    child.unref();
    const browserPid = child.pid!;

    const sock = resolveSocketPath(id, ENV);
    writeMeta({
      id, pid: 999999, socket: sock,
      started_at: Date.now(), env: 'pre', transport: 'managed',
      browser_pid: browserPid, browser_user_data_dir: tmpDir, browser_endpoint: 'http://127.0.0.1:9995',
    }, ENV);

    try {
      expect(isAlive(browserPid)).toBe(true);

      const sessions = listSessions(ENV);
      const s = sessions.find((x) => x.id === id);
      expect(s?.status).toBe('aborted');

      // 前缀不匹配 → 不杀不删
      await new Promise((r) => setTimeout(r, 500));
      expect(isAlive(browserPid)).toBe(true);
      expect(fs.existsSync(tmpDir)).toBe(true);
    } finally {
      // listSessions 不会杀这个进程（目录前缀不匹配），失败路径手动回收本用例的子进程 + 目录
      try { process.kill(browserPid, 'SIGKILL'); } catch { /* ignore */ }
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }, 15000);
});

// SIGTERM→aborted 必须真实子进程 + 真实信号；进程内无法安全模拟。
// 无浏览器环境（沙箱）跳过；有浏览器（E2ET_CDP_URL 或 managed 可起）时跑。

/** 探测能否实际启动 headless Chrome（不只是找到二进制）。
 *  沙箱可能找到 Chrome 但不让它跑，这里做一次真实启动探测。 */
const canLaunchChrome = (() => {
  const exe = resolveChromiumExecutable();
  if (!exe) return false;
  try {
    const { spawnSync } = require('node:child_process');
    const r = spawnSync(exe, ['--headless=new', '--no-sandbox', '--disable-gpu', '--dump-dom', 'data:text/html,<p>ok</p>'], { timeout: 8000, encoding: 'utf8' });
    return r.status === 0 && r.stdout.includes('ok');
  } catch { return false; }
})();

const hasChromium = canLaunchChrome;
const hasCdpUrl = !!process.env.E2ET_CDP_URL;
const hasBrowser = hasCdpUrl || hasChromium;
describe.skipIf(!hasBrowser)('daemon SIGTERM→aborted（真实子进程，需浏览器）', () => {
  it('SIGTERM → session_end aborted', async () => {
    const id = generateSessionId();
    const socket = resolveSocketPath(id, ENV);
    fs.rmSync(socket, { force: true });
    const cliPath = path.resolve(__dirname, '../../dist/cli.js');
    const child = spawn(process.execPath, [cliPath, '__daemon', id, '--env', 'pre', '--socket', socket], {
      detached: true, stdio: 'ignore', env: { ...ENV, TMPDIR: PRIVATE_TMP, E2ET_AUTH_STATE: LIFECYCLE_AUTH_STATE } as any,
    });
    child.unref();
    try {
      // 等就绪
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        if (await DaemonClient.ping(socket, 500)) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const meta = readMeta(id, ENV);
      expect(meta?.pid).toBeGreaterThan(0);
      process.kill(meta!.pid, 'SIGTERM');
      await new Promise((r) => setTimeout(r, 2000));
      const after = readMeta(id, ENV);
      expect(after?.session_end?.result).toBe('aborted');
    } finally {
      // 失败路径兜底：daemon 仍活则停掉，已死则 listSessions 回收孤儿浏览器（本会话私有 HOME）
      const m = readMeta(id, ENV);
      if (m?.pid && isAlive(m.pid)) {
        try { const c = await DaemonClient.connect(socket, { connectTimeoutMs: 3000 }); await c.request('stop', {}, { requestTimeoutMs: 15_000 }); c.close(); } catch { try { process.kill(m.pid, 'SIGKILL'); } catch { /* ignore */ } }
        await new Promise((r) => setTimeout(r, 500));
      }
      listSessions(ENV);
    }
  }, 30000);
});

// 真实 defaultBootstrap 集成测试：拆成 managed 组与 native-cdp 组
// managed 组：有 Chromium 可执行文件且未设 E2ET_CDP_URL
// native-cdp 组：设了 E2ET_CDP_URL（直连已有浏览器）
// hasChromium / hasCdpUrl 在 SIGTERM 块前声明

// managed 组：spawn daemon 时从 env 删除 E2ET_CDP_URL
describe.skipIf(!hasChromium || hasCdpUrl)('真实 defaultBootstrap managed 组（exitOnStop:true）', () => {
  const REAL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-managed-'));
  const realEnv: NodeJS.ProcessEnv = {
    ...process.env,
    E2ET_HOME: REAL_HOME,
    E2ET_IDLE_TIMEOUT_MS: '60000',
    E2ET_MANAGED_HEADLESS: '1',
    TMPDIR: PRIVATE_TMP,
    E2ET_AUTH_STATE: LIFECYCLE_AUTH_STATE,
  };
  // managed 组：删除 E2ET_CDP_URL，确保走 managed 路径
  delete realEnv.E2ET_CDP_URL;

  afterAll(() => {
    fs.rmSync(REAL_HOME, { recursive: true, force: true });
  });

  function spawnDaemon(id: string, envOverride?: Partial<NodeJS.ProcessEnv>): { child: any; socket: string } {
    const socket = resolveSocketPath(id, realEnv);
    fs.rmSync(socket, { force: true });
    const cliPath = path.resolve(__dirname, '../../dist/cli.js');
    const child = spawn(process.execPath, [cliPath, '__daemon', id, '--env', 'pre', '--socket', socket, '--browser', 'managed'], {
      detached: true, stdio: 'ignore', env: { ...realEnv, ...envOverride } as any,
    });
    child.unref();
    return { child, socket };
  }

  async function waitReady(socket: string, id: string, timeoutMs = 20000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const meta = readMeta(id, realEnv);
      if (meta?.error) return false;
      if (await DaemonClient.ping(socket, 500)) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  }

  async function stopDaemon(socket: string): Promise<void> {
    try {
      const c = await DaemonClient.connect(socket, { connectTimeoutMs: 3000 });
      await c.request('stop', {}, { requestTimeoutMs: 15_000 });
      c.close();
    } catch { /* ignore */ }
  }

  it('并发两个 session start（managed）都成功，各自独立浏览器', async () => {
    const id1 = generateSessionId();
    const id2 = generateSessionId();
    const a = spawnDaemon(id1);
    const b = spawnDaemon(id2);
    try {
      const ready1 = await waitReady(a.socket, id1);
      const ready2 = await waitReady(b.socket, id2);
      expect(ready1).toBe(true);
      expect(ready2).toBe(true);

      const meta1 = readMeta(id1, realEnv);
      const meta2 = readMeta(id2, realEnv);
      expect(meta1?.browser_pid).toBeGreaterThan(0);
      expect(meta2?.browser_pid).toBeGreaterThan(0);
      expect(meta1?.browser_pid).not.toBe(meta2?.browser_pid);
      expect(meta1?.browser_endpoint).toBeTruthy();
      expect(meta2?.browser_endpoint).toBeTruthy();
    } finally {
      // 失败路径兜底：任一 expect 挂掉也停掉两个 daemon，避免孤儿浏览器
      await stopDaemon(a.socket);
      await stopDaemon(b.socket);
    }
  }, 30000);

  it('stop A 返回 blocked（0 断言）且与 meta / trace 一致；stop A 后 B 可用', async () => {
    const id1 = generateSessionId();
    const id2 = generateSessionId();
    const a = spawnDaemon(id1);
    const b = spawnDaemon(id2);

    try {
      await waitReady(a.socket, id1);
      await waitReady(b.socket, id2);

      // stop A
      const c1 = await DaemonClient.connect(a.socket, { connectTimeoutMs: 3000 });
      const stopRes = await c1.request('stop', {}, { requestTimeoutMs: 15_000 }) as { result?: string };
      c1.close();

      expect(stopRes.result).toBe('blocked');
      const metaA = readMeta(id1, realEnv);
      expect(metaA?.session_end?.result).toBe('blocked');

      // trace 末行也是 blocked
      const tracePath = path.join(traceDir(id1, realEnv), 'trace.jsonl');
      const trace = fs.readFileSync(tracePath, 'utf8').trim().split('\n');
      expect(JSON.parse(trace[trace.length - 1]).result).toBe('blocked');

      // B 仍可用
      const cb = await DaemonClient.connect(b.socket, { connectTimeoutMs: 3000 });
      const state = await cb.request('page.state', {}, { requestTimeoutMs: 5000 });
      cb.close();
      expect((state as any).snapshot_id).toBe(1);
    } finally {
      // 失败路径兜底：A 在断言中途挂掉也要停，B 无论成败都停
      await stopDaemon(a.socket);
      await stopDaemon(b.socket);
    }
  }, 30000);

  it('SIGKILL daemon 后 session list 回收浏览器与临时目录', async () => {
    const id = generateSessionId();
    const { socket } = spawnDaemon(id);
    try {
      await waitReady(socket, id);

      const meta = readMeta(id, realEnv);
      const browserPid = meta?.browser_pid;
      const tmpDir = meta?.browser_user_data_dir;
      expect(browserPid).toBeGreaterThan(0);
      expect(tmpDir).toBeTruthy();
      expect(isAlive(browserPid!)).toBe(true);

      // SIGKILL daemon
      try { process.kill(meta!.pid, 'SIGKILL'); } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, 500));

      expect(isAlive(meta!.pid)).toBe(false);
      expect(isAlive(browserPid!)).toBe(true);

      // session list 回收（sync：SIGTERM→SIGKILL→删目录都在里面完成）
      // pre-listSessions 只读诊断快照（仅 assertion 失败时输出）
      const preDiag = collectSigkillDiag('pre-listSessions', meta!.pid, browserPid!, meta!);
      const sessions = listSessions(realEnv);
      const s = sessions.find((x) => x.id === id);
      try {
        expect(s?.status).toBe('aborted');
        expect(isAlive(browserPid!)).toBe(false);
        expect(fs.existsSync(tmpDir!)).toBe(false);
        // CDP 端点关闭验证：browser 杀后端口不可达（managed meta 写 browser_endpoint，不一定写 browser_port）
        if (meta?.browser_endpoint) {
          await expect(fetch(`${meta.browser_endpoint}/json/version`, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
        }
        // Linux: 同 PGID 无非 Z 成员（detached spawn → PGID=browserPid，不依赖 /proc/<leader> 存在）
        if (os.platform() === 'linux' && browserPid! > 0) {
          expect(samePgidNonZ(browserPid!)).toEqual([]);
        }
      } catch (err) {
        try {
          const postMeta = readMeta(id, realEnv);
          const postDiag = collectSigkillDiag('post-listSessions', meta!.pid, browserPid!, postMeta ?? meta!);
          console.error(`${preDiag}\n${postDiag}`);
        } catch (diagErr) {
          console.error('[SIGKILL-diag] diagnostics collection failed:', diagErr);
          console.error(preDiag);
        }
        throw err;
      }
    } finally {
      // 失败路径兜底：daemon 仍活则停掉，已死则 listSessions 回收孤儿浏览器与临时目录
      const m = readMeta(id, realEnv);
      if (m?.pid && isAlive(m.pid)) {
        await stopDaemon(socket);
        await new Promise((r) => setTimeout(r, 500));
      }
      listSessions(realEnv);
    }
  }, 30000);

  it('F5 真实浏览器：open → 改 DOM → 连读两次只 +1 → reload → 再改 → +1', async () => {
    const id = generateSessionId();
    const { socket } = spawnDaemon(id);
    try {
      await waitReady(socket, id);

      const c = await DaemonClient.connect(socket, { connectTimeoutMs: 3000 });

      // 打开一个简单页面
      const openRes = await c.request('page.open', { url: 'about:blank', intent: '打开空白页' }, { requestTimeoutMs: 15_000 });
      expect((openRes as any).change_count).toBe(1);

      // 连读两次：change_count 不变
      const s1 = await c.request('page.state', {}, { requestTimeoutMs: 5000 }) as any;
      const s2 = await c.request('page.state', {}, { requestTimeoutMs: 5000 }) as any;
      expect(s1.change_count).toBe(1);
      expect(s2.change_count).toBe(1);

      // 通过外部 CDP 连同一 tab 做 DOM 修改
      const meta = readMeta(id, realEnv);
      const endpoint = meta!.browser_endpoint!;
      const tabId = meta!.tab_id!;
      const { CdpSession } = await import('../browser/daemon-client.js');
      const extCdp = await CdpSession.connect(tabId, endpoint);
      await extCdp.evaluate('document.body.appendChild(document.createElement("div"))');
      extCdp.close();

      // 连读两次：只 +1
      const s3 = await c.request('page.state', {}, { requestTimeoutMs: 5000 }) as any;
      const s4 = await c.request('page.state', {}, { requestTimeoutMs: 5000 }) as any;
      expect(s3.change_count).toBe(2);
      expect(s4.change_count).toBe(2);

      // reload：同 URL page.open → frameNavigated → +1
      await c.request('page.open', { url: 'about:blank', intent: 'reload' }, { requestTimeoutMs: 15_000 });
      const s5 = await c.request('page.state', {}, { requestTimeoutMs: 5000 }) as any;
      expect(s5.change_count).toBe(3);

      // 再改 DOM → +1
      const extCdp2 = await CdpSession.connect(tabId, endpoint);
      await extCdp2.evaluate('document.body.appendChild(document.createElement("div"))');
      extCdp2.close();
      const s6 = await c.request('page.state', {}, { requestTimeoutMs: 5000 }) as any;
      expect(s6.change_count).toBe(4);

      c.close();
    } finally {
      await stopDaemon(socket);
    }
  }, 30000);
});

// native-cdp 组：设了 E2ET_CDP_URL
describe.skipIf(!hasCdpUrl)('真实 defaultBootstrap native-cdp 组（exitOnStop:true）', () => {
  const REAL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-native-'));
  const realEnv: NodeJS.ProcessEnv = {
    ...process.env,
    E2ET_HOME: REAL_HOME,
    E2ET_AUTH_STATE: LIFECYCLE_AUTH_STATE,
    E2ET_IDLE_TIMEOUT_MS: '60000',
    TMPDIR: PRIVATE_TMP,
  };

  afterAll(() => {
    fs.rmSync(REAL_HOME, { recursive: true, force: true });
  });

  function spawnDaemon(id: string): { child: any; socket: string } {
    const socket = resolveSocketPath(id, realEnv);
    fs.rmSync(socket, { force: true });
    const cliPath = path.resolve(__dirname, '../../dist/cli.js');
    const child = spawn(process.execPath, [cliPath, '__daemon', id, '--env', 'pre', '--socket', socket, '--browser', 'existing'], {
      detached: true, stdio: 'ignore', env: realEnv as any,
    });
    child.unref();
    return { child, socket };
  }

  async function waitReady(socket: string, id: string, timeoutMs = 20000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const meta = readMeta(id, realEnv);
      if (meta?.error) return false;
      if (await DaemonClient.ping(socket, 500)) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  }

  async function stopDaemon(socket: string): Promise<void> {
    try {
      const c = await DaemonClient.connect(socket, { connectTimeoutMs: 3000 });
      await c.request('stop', {}, { requestTimeoutMs: 15_000 });
      c.close();
    } catch { /* ignore */ }
  }

  it('native-cdp：无 browser_pid、有隔离 context，stop 只销毁自己的 context', async () => {
    const id = generateSessionId();
    const { socket } = spawnDaemon(id);
    try {
      await waitReady(socket, id);
      const meta = readMeta(id, realEnv);
      expect(meta?.browser_endpoint).toBeTruthy();
      // native-cdp 不自起浏览器，不应有 browser_pid
      expect(meta?.browser_pid).toBeUndefined();
      expect(meta?.transport).toBe('native-cdp');
      expect(meta?.browser_context_id).toBeTruthy();
      expect(meta?.browser_source).toBe('existing');
      expect(meta?.auth_source).toBe('imported');

      // page.state 可用
      const c = await DaemonClient.connect(socket, { connectTimeoutMs: 3000 });
      const state = await c.request('page.state', {}, { requestTimeoutMs: 5000 });
      c.close();
      expect((state as any).snapshot_id).toBe(1);
    } finally {
      await stopDaemon(socket);
    }
  }, 30000);
});


// bootstrap 失败不需要浏览器（auth 校验在 launch 之前），单独成块不 skip
describe('bootstrap 失败不留孤儿（真实 daemon 子进程）', () => {
  const FAIL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-fail-'));
  const failEnv: NodeJS.ProcessEnv = {
    ...process.env,
    E2ET_HOME: FAIL_HOME,
    E2ET_IDLE_TIMEOUT_MS: '60000',
    TMPDIR: PRIVATE_TMP,
  };
  // 删除 CDP_URL 确保 auth 校验在 launch 之前触发（不走 native-cdp）
  delete failEnv.E2ET_CDP_URL;

  afterAll(() => {
    fs.rmSync(FAIL_HOME, { recursive: true, force: true });
  });

  it('bootstrap 失败（auth 文件不存在）不留浏览器与目录', async () => {
    const id = generateSessionId();
    const socket = resolveSocketPath(id, failEnv);
    fs.rmSync(socket, { force: true });
    const cliPath = path.resolve(__dirname, '../../dist/cli.js');
    const child = spawn(process.execPath, [cliPath, '__daemon', id, '--env', 'pre', '--socket', socket], {
      detached: true, stdio: 'ignore', env: { ...failEnv, E2ET_AUTH_STATE: '/nonexistent/auth-state.json' } as any,
    });
    child.unref();

    try {
      // 等 daemon 退出（auth 校验失败 → 快速退出）
      await new Promise((r) => setTimeout(r, 3000));

      const meta = readMeta(id, failEnv);
      expect(meta).toBeTruthy();
      expect(meta?.error).toBeTruthy();

      // 不应留浏览器进程或临时目录
      expect(meta?.browser_pid).toBeUndefined();
      expect(meta?.browser_user_data_dir).toBeUndefined();

      // 检查 os.tmpdir() 下没有本会话的残留目录
      const sidPrefix = `e2et-${id}-`;
      const tmpDirs = fs.readdirSync(os.tmpdir(), { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name.startsWith(sidPrefix));
      expect(tmpDirs.length).toBe(0);
    } finally {
      // 失败路径兜底：daemon 没如期退出则停掉，已死则 listSessions 回收孤儿（本会话私有 HOME）
      const m = readMeta(id, failEnv);
      if (m?.pid && isAlive(m.pid)) {
        try { const c = await DaemonClient.connect(socket, { connectTimeoutMs: 3000 }); await c.request('stop', {}, { requestTimeoutMs: 15_000 }); c.close(); } catch { try { process.kill(m.pid, 'SIGKILL'); } catch { /* ignore */ } }
        await new Promise((r) => setTimeout(r, 500));
      }
      listSessions(failEnv);
    }
  }, 15000);
});

function isAlive(pid: number): boolean {
  return isProcessAlive(pid);
}

/** SIGKILL 用例专用：ps 查询，失败返回 null（跨 Darwin/Linux）。 */
function safePs(format: string, pid: number): string | null {
  try {
    return execSync(`ps -o ${format}= -p ${pid}`, { encoding: 'utf8', timeout: 2000 }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * SIGKILL 用例专用诊断收集器。只查询本会话 PID，不 pkill、不全局清理、不输出环境变量/凭据。
 * 收集：daemon/browser 的 PID/PPID/PGID/STAT/comm；PID1 comm（不含 args）；browser 命令行
 * 是否含 --user-data-dir=<dir>；目录父是否等于 os.tmpdir()；sid 前缀是否匹配；
 * meta.session_end/orphan_cleaned；同 browser PGID 残留进程（若方便）。
 * 诊断本身失败不掩盖原 assertion —— 调用方 try/catch 后 throw err。
 */
function collectSigkillDiag(
  label: string,
  daemonPid: number,
  browserPid: number,
  meta: { id: string; pid: number; browser_pid?: number; browser_user_data_dir?: string; session_end?: { result: string; ended_at: number }; orphan_cleaned?: boolean },
): string {
  const L: string[] = [`[SIGKILL-diag:${label}]`];
  const pid1Comm = safePs('comm', 1);
  L.push(`PID1 comm: ${pid1Comm ?? '(unavailable)'}`);
  for (const [name, pid] of [['daemon', daemonPid], ['browser', browserPid]] as const) {
    const row = safePs('pid,ppid,pgid,stat,comm', pid);
    L.push(`${name} pid=${pid}: ${row ?? '(pid not found or ps failed)'}`);
  }
  const dir = meta.browser_user_data_dir;
  L.push(`dir exists: ${dir ? fs.existsSync(dir) : '(no dir)'}`);
  if (dir) {
    const parent = path.dirname(path.resolve(dir));
    const tmp = path.resolve(os.tmpdir());
    L.push(`dir parent === os.tmpdir(): ${parent === tmp} (parent=${parent}, tmpdir=${tmp})`);
    const basename = path.basename(dir);
    const expectedPrefix = `e2et-${meta.id}-`;
    L.push(`dir basename startsWith expected prefix: ${basename.startsWith(expectedPrefix)} (got="${basename}", expected="${expectedPrefix}")`);
  }
  L.push(`meta.session_end: ${JSON.stringify(meta.session_end)}`);
  L.push(`meta.orphan_cleaned: ${meta.orphan_cleaned}`);
  // browser 命令行（仅本 session PID）
  const cmd = safePs('command', browserPid);
  if (cmd) {
    const includesUdd = dir ? cmd.includes(`--user-data-dir=${dir}`) : false;
    L.push(`browser cmdline includes --user-data-dir=<dir>: ${includesUdd}`);
  } else {
    L.push('browser cmdline: (pid not found or ps failed — browser already dead)');
  }
  // 同 browser PGID 残留进程（PGID=browserPid，仅输出 pid+stat，不输出 args）
  if (os.platform() === 'linux' && browserPid > 0) {
    try {
      const members = samePgidNonZ(browserPid);
      L.push(`same-PGID(${browserPid}) non-Z members: ${members.length ? members.join(', ') : '(none)'}`);
    } catch (e: any) {
      L.push(`same-PGID(${browserPid}) scan failed: ${e?.message}`);
    }
  }
  return L.join('\n');
}

// Linux: 扫 /proc 下所有 PID 的 stat 找同 PGID 的非 Z 成员。readdirSync 失败直接抛（不吞），
// 单个 /proc/<pid>/stat 读取失败跳过（进程刚退出）。只输出 pid+stat，不输出 args。
function samePgidNonZ(pgid: number): string[] {
  const out: string[] = [];
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const s = fs.readFileSync(`/proc/${d}/stat`, 'utf-8');
      const lp = s.lastIndexOf(')');
      if (lp === -1) continue;
      const f = s.slice(lp + 1).trim().split(/\s+/);
      if (f[2] === String(pgid) && f[0] !== 'Z') out.push(`pid=${d} stat=${f[0]}`);
    } catch { /* 进程刚退出 */ }
  }
  return out;
}
