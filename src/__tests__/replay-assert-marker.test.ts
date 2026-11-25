/**
 * P4 data 断言无损回放标记（replayable）生产链单测：
 * socket assert.data → trace 事件携带 replayable（equalsScrubbed === expected）→
 * build 在写 IR 前拒绝 replayable !== true（ASSERT_NOT_REPLAYABLE，固定安全提示，
 * 不保存原始敏感期望）→ check 核对同一真事件标记（双方相同 marker 不充当原始证据）。
 *
 * 正例：非敏感常规值（含字面值 marker 文本、JSON envelope + path 的 null/0/false/空串）
 * 不改写 → replayable=true → 录制 pass、build ok、check passed；
 * 反例：普通 key 的 Bearer 值被同源脱敏改写 → 录制仍 pass（业务断言按原值比较），
 * 但 build 拒绝、check 拒绝；旧 trace 缺标记（改本次 fake-CDP 临时 fixture trace 文件）
 * 同样拒绝，不补推断/默认 true。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runDaemon } from '../daemon/daemon.js';
import type { BootstrapResult } from '../daemon/bootstrap.js';
import { DaemonClient } from '../daemon/client.js';
import { resolveSocketPath, traceRoot } from '../daemon/session-meta.js';
import { readTraceEvents } from '../daemon/trace.js';
import { buildIr } from '../ir/build.js';
import { checkIr } from '../ir/check.js';
import { parseTrace } from '../ir/trace-reader.js';

class PageDataCdp {
  calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  storageEntries: string[][] = [];
  frameTreeQueue: Array<Record<string, unknown>> = [];
  private listeners = new Map<string, Array<(params: any) => void>>();
  private objectIdSeq = 0;
  private hitBackend = 0;
  private textProbeCount = 0;

  on(method: string, handler: (params: any) => void): () => void {
    const list = this.listeners.get(method) ?? [];
    list.push(handler);
    this.listeners.set(method, list);
    return () => this.listeners.set(method, list.filter((item) => item !== handler));
  }
  onClose(): void {}
  close(): void {}
  emit(method: string, params: any): void {
    for (const handler of this.listeners.get(method) ?? []) handler(params);
  }
  async evaluate<T = any>(expression: string): Promise<T> {
    if (expression.includes('const want = "确定"')) {
      return { kind: 'exact', count: 1, candidates: [{ text: '确定', path: 'BUTTON', role: 'button' }], clickable_texts: [] } as T;
    }
    if (expression.includes('window.innerWidth')) return { width: 1280, height: 720, deviceScaleFactor: 2 } as T;
    if (expression.includes('readyState')) return 'complete' as T;
    if (expression.includes('__e2etChangeCount')) return 0 as T;
    if (expression.includes('__e2etObserver')) return true as T;
    if (expression.includes('location.href')) return 'https://page.test/app' as T;
    return '' as T;
  }

  async send<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ method, params });
    switch (method) {
      case 'Page.enable':
      case 'Network.enable':
      case 'Page.addScriptToEvaluateOnNewDocument':
      case 'Page.navigate':
        setTimeout(() => this.emit('Page.loadEventFired', {}), 0);
        return {} as T;
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
        if (params.returnByValue === false && expr.includes('const want = "确定"')) {
          this.textProbeCount++;
          return { result: { objectId: `text-${this.textProbeCount}` } } as T;
        }
        if (expr.includes('location.href')) return { result: { value: 'https://page.test/app' } } as T;
        if (expr.includes('__e2etChangeCount')) return { result: { value: 0 } } as T;
        if (expr.includes('readyState')) return { result: { value: 'complete' } } as T;
        if (expr.includes('document.body')) return { result: { value: '' } } as T;
        if (expr.includes('innerWidth')) return { result: { value: { width: 1280, height: 720 } } } as T;
        return { result: { type: 'undefined' } } as T;
      }
      case 'Runtime.callFunctionOn': {
        const fd = String(params.functionDeclaration ?? '');
        if (params.returnByValue === false && fd.includes('isElementVisible')) return { result: { type: 'function', objectId: 'snapshot-visibility-fn' } } as T;
        if (fd.includes('return this(element)')) return { result: { value: { connected: true, visible: true } } } as T;
        if (fd.includes('function optionDisabledReason')) return { result: { value: null } } as T;
        if (fd.includes('isConnected')) return { result: { value: { connected: true, visible: true } } } as T;
        if (fd.includes("if (el.disabled === true) return 'disabled 属性';")) return { result: { value: null } } as T;
        return { result: { value: true } } as T;
      }
      case 'DOM.resolveNode':
        return { object: { objectId: 'obj-' + (++this.objectIdSeq) } } as T;
      case 'DOM.describeNode':
        return { node: { backendNodeId: 100 } } as T;
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
}

describe('P4 data 断言 replayable 标记（socket → build/check 生产链）', () => {
  let home: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.E2ET_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-marker-'));
    process.env.E2ET_HOME = home;
  });
  afterEach(() => {
    if (previousHome === undefined) delete process.env.E2ET_HOME;
    else process.env.E2ET_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  interface Booted { socket: string; done: Promise<void>; id: string }

  async function boot(cdp: PageDataCdp): Promise<Booted> {
    const id = 'rm-' + Math.random().toString(36).slice(2, 8);
    const socket = resolveSocketPath(id);
    fs.rmSync(socket, { force: true });
    const done = runDaemon(id, {
      env: 'pre', socketPath: socket, exitOnStop: false,
      browserBootstrap: async (): Promise<BootstrapResult> => ({
        tabId: 'tab', session: cdp as any, endpoint: 'http://127.0.0.1:0',
        authSource: 'imported', browserSource: 'managed',
      }),
    });
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (await DaemonClient.ping(socket, 200)) break;
      await new Promise((r) => setTimeout(r, 30));
    }
    return { socket, done, id };
  }

  /** 无论红绿都收资源：连接 stop + close + await done */
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

  async function recordAssert(cdp: PageDataCdp, params: Record<string, unknown>): Promise<{ result: any; traceEvents: Array<Record<string, unknown>>; sessionId: string }> {
    const booted = await boot(cdp);
    const result = await runWith(booted, async (client) => {
      await client.request('page.open', { url: 'https://page.test/app', intent: '打开页面' });
      // 第二个动作（同 Lead 生产链 repro）：open 后有后续步骤，不触发既有 refine 规则
      await client.request('page.click', { target: 'text=确定', intent: '执行受控操作', snapshot_change_count: 0 });
      return await client.request('assert.data', params) as any;
    });
    return { result, traceEvents: readTraceEvents(booted.id), sessionId: booted.id };
  }

  function traceFile(sessionId: string): string {
    return path.join(traceRoot(), sessionId, 'trace.jsonl');
  }

  it('正例：非敏感常规值不改写 → 事件带 replayable=true，build ok、check passed、IR equals 原值', async () => {
    const cdp = new PageDataCdp();
    cdp.storageEntries = [['mode', 'fast']];
    const { result, traceEvents, sessionId } = await recordAssert(cdp, { local_storage: 'mode', equals: 'fast' });
    expect(result.pass).toBe(true);
    const ev = traceEvents.filter((e) => e.t === 'assert' && e.kind === 'data');
    expect(ev).toHaveLength(1);
    expect(ev[0].replayable).toBe(true);
    const built = await buildIr(sessionId, { name: 'replay-ok' });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const dataCheck = built.ir.steps.flatMap((s) => s.checks ?? []).find((c) => 'assert' in c && 'data' in (c as { assert: { data?: unknown } }).assert);
    expect(dataCheck).toMatchObject({ assert: { data: { equals: 'fast' } } });
    const checked = checkIr(built.ir, { trace: parseTrace(traceEvents) });
    expect(checked.passed).toBe(true);
    expect(checked.failures).toEqual([]);
  }, 15000);

  it.each([
    ['null', { data: null }],
    ['0', { data: 0 }],
    ['false', { data: false }],
    ['empty-string', { data: '' }],
  ] as Array<[string, Record<string, unknown>]>)('正例：JSON envelope + path 的 %s 标量不改写 → replayable=true 可回放', async (_name, scalar) => {
    const cdp = new PageDataCdp();
    cdp.storageEntries = [['cfg', JSON.stringify(scalar)]];
    const { result, traceEvents, sessionId } = await recordAssert(cdp, { local_storage: 'cfg', path: 'data', equals: scalar.data });
    expect(result.pass).toBe(true);
    const ev = traceEvents.filter((e) => e.t === 'assert' && e.kind === 'data');
    expect(ev).toHaveLength(1);
    expect(ev[0].replayable).toBe(true);
    const built = await buildIr(sessionId, { name: `replay-scalar-${_name}` });
    expect(built.ok).toBe(true);
  }, 15000);

  it('正例：字面值 marker 文本（原值即 marker，未被改写）→ replayable=true（不按字符串包含 REDACTED 做启发式）', async () => {
    const cdp = new PageDataCdp();
    const literal = 'Bearer [REDACTED]';
    cdp.storageEntries = [['mode', literal]];
    const { result, traceEvents, sessionId } = await recordAssert(cdp, { local_storage: 'mode', equals: literal });
    expect(result.pass).toBe(true);
    const ev = traceEvents.filter((e) => e.t === 'assert' && e.kind === 'data');
    expect(ev[0].replayable).toBe(true);
    const built = await buildIr(sessionId, { name: 'replay-literal-marker' });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const dataCheck = built.ir.steps.flatMap((st) => st.checks ?? []).find((c) => 'assert' in c && 'data' in (c as { assert: { data?: unknown } }).assert);
    expect(dataCheck).toMatchObject({ assert: { data: { equals: literal } } });
  }, 15000);

  it('反例：普通 key 的 Bearer 值被同源脱敏改写 → 录制仍 pass，但 build 拒绝 ASSERT_NOT_REPLAYABLE', async () => {
    const cdp = new PageDataCdp();
    const original = 'Bearer controlled-original-123456789';
    cdp.storageEntries = [['mode', original]];
    const { result, traceEvents, sessionId } = await recordAssert(cdp, { local_storage: 'mode', equals: original });
    // 录制侧断言按原值比较 → pass（脱敏是事实，不是业务失败）
    expect(result.pass).toBe(true);
    const ev = traceEvents.filter((e) => e.t === 'assert' && e.kind === 'data');
    expect(ev[0].replayable).toBe(false);
    // 期望展示值已脱敏，原敏感期望不进 trace
    expect(JSON.stringify(ev[0])).not.toContain('controlled-original');
    const built = await buildIr(sessionId, { name: 'replay-redacted' });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error.code).toBe('ASSERT_NOT_REPLAYABLE');
    expect(built.error.hint).toBe('该 data 断言必须用当前 CLI 重新录制');
    expect(JSON.stringify(built.error)).not.toContain('controlled-original');
  }, 15000);

  it('反例：check 对 replayable=false 的 trace 拒绝（IR/trace 双方相同 marker 不充当原始证据）', async () => {
    const cdp = new PageDataCdp();
    const original = 'Bearer controlled-original-123456789';
    cdp.storageEntries = [['mode', original]];
    const { traceEvents, sessionId } = await recordAssert(cdp, { local_storage: 'mode', equals: original });
    const trace = parseTrace(traceEvents);
    // 手造与 trace 脱敏值完全一致的 IR（双方相同 marker 的伪造正样本）
    const marker = (trace.asserts[0].expect as any).equals;
    const ir = {
      schema_version: 3,
      name: 'same-marker-ir',
      url: 'https://page.test/app',
      covered_pages: [],
      env: 'pre',
      provenance: { session_id: sessionId, auth_source: 'imported', browser_source: 'managed', tool_version: '0.6.0', generated_at: '2026-11-02T00:00:00Z', mocked: false },
      steps: [{
        id: 's1', intent: '打开', action: 'open',
        args: { url: 'https://page.test/app' }, value: { literal: 'https://page.test/app' },
        checks: [{ assert: { data: { source: { local_storage: 'mode' }, equals: marker } } }],
        trace_ref: trace.actions[1].id,
      }],
    };
    const checked = checkIr(ir, { trace });
    expect(checked.passed).toBe(false);
    expect(checked.failures.some((f) => f.rule === 'data-assert' && f.message.includes('replayable'))).toBe(true);
  }, 15000);

  it('反例：旧 trace data 断言缺 replayable 标记 → build/check 拒绝（不补推断/默认 true）', async () => {
    const cdp = new PageDataCdp();
    cdp.storageEntries = [['mode', 'fast']];
    const { traceEvents, sessionId } = await recordAssert(cdp, { local_storage: 'mode', equals: 'fast' });
    // 模拟旧 trace：改本次 fake-CDP 临时 fixture trace 文件（剥掉 replayable 标记），buildIr 读盘核对
    const file = traceFile(sessionId);
    const stripped = traceEvents.map((ev) => {
      if (ev.t === 'assert' && ev.kind === 'data') {
        const { replayable: _omit, ...rest } = ev;
        return rest;
      }
      return ev;
    });
    fs.writeFileSync(file, stripped.map((ev) => JSON.stringify(ev)).join('\n') + '\n');
    const built = await buildIr(sessionId, { name: 'replay-legacy' });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error.code).toBe('ASSERT_NOT_REPLAYABLE');
    const trace = parseTrace(readTraceEvents(sessionId));
    const ir = {
      schema_version: 3,
      name: 'legacy-ir',
      url: 'https://page.test/app',
      covered_pages: [],
      env: 'pre',
      provenance: { session_id: sessionId, auth_source: 'imported', browser_source: 'managed', tool_version: '0.6.0', generated_at: '2026-11-02T00:00:00Z', mocked: false },
      steps: [{
        id: 's1', intent: '打开', action: 'open',
        args: { url: 'https://page.test/app' }, value: { literal: 'https://page.test/app' },
        checks: [{ assert: { data: { source: { local_storage: 'mode' }, equals: 'fast' } } }],
        trace_ref: trace.actions[1].id,
      }],
    };
    const checked = checkIr(ir, { trace });
    expect(checked.passed).toBe(false);
    expect(checked.failures.some((f) => f.rule === 'data-assert' && f.message.includes('replayable'))).toBe(true);
  }, 15000);
});
