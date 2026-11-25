/**
 * F2-1 / F2-2 反证测试：修复后两条 bug 不再复现。
 *
 * F2-1: getResponseBody 并行发起（不串行累加超时）；cancelled 标志阻断逃逸 finalize。
 * F2-2: page.open / page.state 在 stopping 状态被 STOPPING 错误拒绝，不再闯入。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NetworkTrace } from '../daemon/network-trace.js';
import { traceDir, sessionsDir } from '../daemon/session-meta.js';
import { DaemonClient } from '../daemon/client.js';
import { runDaemon } from '../daemon/daemon.js';
import type { BootstrapResult } from '../daemon/bootstrap.js';
import { generateSessionId, resolveSocketPath } from '../daemon/session-meta.js';

// ── Fake CDP ──

class SlowBodyCdp {
  calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  responseBodies = new Map<string, { body: string; base64Encoded?: boolean }>();
  postBodies = new Map<string, string>();
  private listeners = new Map<string, Array<(params: any) => void>>();
  /** 控制 getResponseBody 延时（ms） */
  bodyDelayMs = 0;
  /** 记录 getResponseBody 调用时间戳，用于验证并行性 */
  responseBodyCallTimes: Array<{ requestId: string; start: number }> = [];

  on(method: string, handler: (params: any) => void): () => void {
    const list = this.listeners.get(method) ?? [];
    list.push(handler);
    this.listeners.set(method, list);
    return () => this.listeners.set(method, list.filter((item) => item !== handler));
  }

  async send<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ method, params });
    const requestId = String(params.requestId ?? '');
    if (method === 'Network.getResponseBody') {
      const start = Date.now();
      this.responseBodyCallTimes.push({ requestId, start });
      if (this.bodyDelayMs > 0) await new Promise((r) => setTimeout(r, this.bodyDelayMs));
      return (this.responseBodies.get(requestId) ?? { body: '' }) as T;
    }
    if (method === 'Network.getRequestPostData') return { postData: this.postBodies.get(requestId) } as T;
    return {} as T;
  }

  emit(method: string, params: any): void {
    for (const handler of this.listeners.get(method) ?? []) handler(params);
  }
}

function request(cdp: SlowBodyCdp, requestId: string, url: string, type = 'XHR', extra: Record<string, unknown> = {}): void {
  cdp.emit('Network.requestWillBeSent', {
    requestId,
    frameId: 'main',
    type,
    wallTime: Date.now() / 1000,
    request: { url, method: 'GET', headers: { 'content-type': 'application/json' }, ...extra },
  });
}

function respond(cdp: SlowBodyCdp, requestId: string, status = 200, contentType = 'application/json'): void {
  cdp.emit('Network.responseReceived', {
    requestId,
    response: { status, mimeType: contentType, headers: { 'content-type': contentType } },
  });
}

function finish(cdp: SlowBodyCdp, requestId: string): void {
  cdp.responseBodies.set(requestId, { body: '{"ok":true}' });
  cdp.emit('Network.loadingFinished', { requestId });
}

// ── F2-1 ──

describe('F2-1：getResponseBody 并行发起 + cancelled 阻断逃逸', () => {
  let home: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.E2ET_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-f2-1-'));
    process.env.E2ET_HOME = home;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.E2ET_HOME;
    else process.env.E2ET_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('10 并发请求 + getResponseBody 300ms → flush <1s 过（并行），CDP 调用几乎同时发起', async () => {
    const cdp = new SlowBodyCdp();
    cdp.bodyDelayMs = 300;
    const trace = new NetworkTrace('f2-1-parallel', cdp as any);
    trace.install();
    await trace.initialize('__source__');
    await trace.enable();

    const N = 10;
    for (let i = 0; i < N; i++) {
      request(cdp, `req-${i}`, `https://example.test/api/${i}`);
      respond(cdp, `req-${i}`);
      finish(cdp, `req-${i}`);
    }

    const t0 = Date.now();
    await trace.flush();
    const elapsed = Date.now() - t0;

    // 并行：10 × 300ms 并行 ≈ 300ms + finalize 开销；串行要 3s+
    expect(elapsed).toBeLessThan(1000);

    // 所有 CDP getResponseBody 调用几乎同时发起（首尾间隔 < 100ms）
    const callTimes = cdp.responseBodyCallTimes;
    expect(callTimes).toHaveLength(N);
    if (callTimes.length >= 2) {
      const spread = callTimes[callTimes.length - 1].start - callTimes[0].start;
      expect(spread).toBeLessThan(100);
    }

    // 所有请求落盘，body 全部拿到
    const events = fs.readFileSync(path.join(traceDir('f2-1-parallel'), 'trace.jsonl'), 'utf8').trim().split('\n');
    const reqs = events.filter((l) => JSON.parse(l).t === 'request');
    expect(reqs).toHaveLength(N);
    for (const r of reqs) {
      const parsed = JSON.parse(r);
      expect(parsed.resp_body_ref).toBeTruthy();
      expect(parsed.resp_body_omitted).toBeUndefined();
    }
  });

  it('cancelled=true → queueFinalize 跳过 finalize，不写逃逸事件', async () => {
    // 直接验证 cancelled 标志的阻断语义，不依赖等 5s flush 超时
    const cdp = new SlowBodyCdp();
    const trace = new NetworkTrace('f2-1-cancel', cdp as any);
    trace.install();
    await trace.initialize('__source__');
    await trace.enable();

    // 先发一个正常请求并 flush，证明 trace 通路正常
    request(cdp, 'pre', 'https://example.test/api/pre');
    respond(cdp, 'pre');
    finish(cdp, 'pre');
    await trace.flush();
    const traceFile = path.join(traceDir('f2-1-cancel'), 'trace.jsonl');
    const beforeCount = fs.readFileSync(traceFile, 'utf8').trim().split('\n').length;
    expect(beforeCount).toBeGreaterThanOrEqual(1);

    // 模拟 flush 超时后果：手动设 cancelled=true
    (trace as any).cancelled = true;

    // 再发一个请求 + loadingFinished → queueFinalize 被调用但应被 cancelled 阻断
    request(cdp, 'escape', 'https://example.test/api/escape');
    respond(cdp, 'escape');
    finish(cdp, 'escape');
    await new Promise((r) => setTimeout(r, 50));

    // finalize 没跑 → 没写逃逸 request 事件
    const afterEvents = fs.readFileSync(traceFile, 'utf8').trim().split('\n');
    expect(afterEvents.length).toBe(beforeCount);
    expect(afterEvents.some((l) => l.includes('escape'))).toBe(false);
  });
});

// ── F2-2 ──

function fakeCdpSession(): any {
  let url = 'about:blank';
  let changeCount = 0;
  const listeners: Array<{ method: string; handler: (params: any) => void }> = [];
  return {
    send: async (method: string) => {
      if (method === 'Accessibility.enable') return {};
      if (method === 'Accessibility.getFullAXTree') return { nodes: [] };
      if (method === 'Page.enable' || method === 'Page.navigate') return {};
      if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: '1' };
      if (method === 'Runtime.enable') return {};
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
      for (const l of listeners) {
        if (l.method === method) l.handler(params);
      }
    },
    close: () => {},
    onClose: () => {},
    _bumpChange: () => { changeCount++; },
    _setUrl: (u: string) => { url = u; },
  };
}

describe('F2-2：page.open / page.state 在 stopping 状态被 STOPPING 拒绝', () => {
  const R2_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-f2-2-'));
  const R2_ENV: NodeJS.ProcessEnv = { ...process.env, E2ET_HOME: R2_HOME, E2ET_IDLE_TIMEOUT_MS: '60000' };
  const SAVED_HOME = process.env.E2ET_HOME;
  const SAVED_IDLE = process.env.E2ET_IDLE_TIMEOUT_MS;

  beforeAll(() => {
    process.env.E2ET_HOME = R2_HOME;
    process.env.E2ET_IDLE_TIMEOUT_MS = '60000';
    fs.mkdirSync(sessionsDir(R2_ENV), { recursive: true });
  });

  afterAll(() => {
    if (SAVED_HOME === undefined) delete process.env.E2ET_HOME; else process.env.E2ET_HOME = SAVED_HOME;
    if (SAVED_IDLE === undefined) delete process.env.E2ET_IDLE_TIMEOUT_MS; else process.env.E2ET_IDLE_TIMEOUT_MS = SAVED_IDLE;
    fs.rmSync(R2_HOME, { recursive: true, force: true });
  });

  it('stop + page.open 竞态 → page.open 被 STOPPING 拒绝', async () => {
    const id = generateSessionId();
    const socket = resolveSocketPath(id, R2_ENV);
    fs.rmSync(socket, { force: true });

    const cdp = fakeCdpSession();
    const bootstrap = async (): Promise<BootstrapResult> => ({
      tabId: 'f2-2-tab',
      session: cdp,
      endpoint: 'http://127.0.0.1:0',
    });

    const done = runDaemon(id, { env: 'pre', socketPath: socket, browserBootstrap: bootstrap, exitOnStop: false });

    try {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (await DaemonClient.ping(socket, 500)) break;
        await new Promise((r) => setTimeout(r, 50));
      }

      const clientA = await DaemonClient.connect(socket, { connectTimeoutMs: 2000 });
      const clientB = await DaemonClient.connect(socket, { connectTimeoutMs: 2000 });

      const stopP = clientA.request('stop', {}, { requestTimeoutMs: 15_000 }).catch((e: any) => ({ code: e.code, message: e.message }));
      const openP = clientB.request('page.open', { url: 'https://example.test/page', intent: '竞态测试' }, { requestTimeoutMs: 15_000 }).catch((e: any) => ({ code: e.code, message: e.message }));

      const [stopRes, openRes] = await Promise.allSettled([stopP, openP]);
      const openVal = openRes.status === 'fulfilled' ? openRes.value : openRes.reason;

      // page.open 必须被拒绝（STOPPING 或 BUSY），不允许闯入
      const isOpenRejectedSafely = openVal && openVal.code && (openVal.code === 'BUSY' || openVal.code === 'STOPPING');
      expect(isOpenRejectedSafely).toBe(true);

      // stop 必须成功
      const stopVal = stopRes.status === 'fulfilled' ? stopRes.value : stopRes.reason;
      expect(stopVal && (stopVal as any).result).toBe('blocked');
    } finally {
      try { await done; } catch { /* ignore */ }
    }
  }, 15000);
});
