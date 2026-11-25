/**
 * P4 窄修：restoreStorageOrigins 协议时序单测（协议模型，非真机——真机验收归 tester）。
 *
 * 覆盖 auth-navigation-race 合同的正反例：
 * - committed 正例：frame 事件 + 真实导航响应双事实后才操作 localStorage
 * - frame-before-navigation-ack：事件先于 navigate ack 到达时不提前操作
 * - navigation-errorText：事件已匹配但响应 errorText 非空 → 固定安全文案拒绝
 * - favicon / late-favicon：初始化与 about:blank 收尾期非 Document 请求零外发（惰性应答）
 * - 监听/定时器/Fetch 全清；回滚（clearOnly）路径不写值
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { restoreStorageOrigins, type CdpLowSession } from '../browser/managed-browser.js';

afterEach(() => { vi.useRealTimers(); });

const origin = 'http://127.0.0.1:18923';

/** 协议模型：与真实 CDP 语义对齐（事件先于 ack、errorText 合法返回、favicon 可被拦截） */
class Model implements CdpLowSession {
  listeners = new Map<string, Set<(p: unknown) => void>>();
  calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  committed = false;
  enabled = false;
  patterns: Array<Record<string, unknown>> = [];
  outbound: string[] = [];
  fulfilled: string[] = [];
  constructor(public mode: string) {}
  addEventListener(method: string, callback: (p: unknown) => void): () => void {
    const list = this.listeners.get(method) ?? new Set();
    list.add(callback);
    this.listeners.set(method, list);
    return () => { list.delete(callback); };
  }
  emit(method: string, params: unknown): void {
    for (const fn of this.listeners.get(method) ?? []) fn(params);
  }
  favicon(): void {
    const covered = this.enabled && (!this.patterns.length || this.patterns.some((p) => !p.resourceType || p.resourceType === 'Other'));
    if (covered) this.emit('Fetch.requestPaused', { requestId: 'favicon', frameId: 'owned-main', resourceType: 'Other', request: { url: `${origin}/favicon.ico` } });
    else this.outbound.push('/favicon.ico');
  }
  onClose(): void {}
  close(): void {}
  async waitClosed(): Promise<boolean> { return true; }
  forceClose(): void {}
  async send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ method, params });
    if (method === 'Page.getFrameTree') {
      return { frameTree: { frame: { id: 'owned-main', url: this.committed ? origin : 'about:blank', securityOrigin: this.committed ? origin : '://', loaderId: this.committed ? 'committed' : 'initial' } } } as T;
    }
    if (method === 'Fetch.enable') { this.enabled = true; this.patterns = (params.patterns ?? []) as Array<Record<string, unknown>>; return {} as T; }
    if (method === 'Fetch.disable') { this.enabled = false; return {} as T; }
    if (method === 'Fetch.continueRequest' && params.requestId === 'favicon') this.outbound.push('/favicon.ico');
    if (method === 'Fetch.fulfillRequest') this.fulfilled.push(String(params.requestId));
    if (method === 'Page.navigate') {
      if (params.url === 'about:blank') {
        if (this.mode === 'late-favicon') this.favicon();
        return {} as T;
      }
      this.emit('Fetch.requestPaused', { requestId: 'document', frameId: 'owned-main', resourceType: 'Document', request: { url: origin } });
      const frame = { id: 'owned-main', url: origin, securityOrigin: origin, loaderId: 'committed' };
      if (this.mode === 'frame-before-navigation-ack') {
        this.emit('Page.frameNavigated', { frame });
        await new Promise((r) => setTimeout(r, 25));
        this.committed = true;
      } else {
        this.committed = true;
        this.emit('Page.frameNavigated', { frame });
      }
      if (this.mode === 'favicon') this.favicon();
      if (this.mode === 'navigation-errorText') return { errorText: 'controlled navigation failure' } as T;
      return { frameId: 'owned-main', loaderId: 'committed' } as T;
    }
    if (method === 'Runtime.evaluate') {
      if (!this.committed) return { exceptionDetails: { text: 'No execution context' } } as T;
      return {} as T;
    }
    return {} as T;
  }
}

describe('P4 窄修：restoreStorageOrigins 协议时序（零外发初始化合同）', () => {
  it('正例：frame 事件 + 真实导航响应双事实后才操作 localStorage；监听/Fetch 全清', async () => {
    const m = new Model('committed-positive');
    await restoreStorageOrigins(m, 'owned-session', [{ origin, localStorage: [{ name: 'k', value: 'v' }] }]);
    expect([...m.listeners.values()].reduce((n, s) => n + s.size, 0)).toBe(0);
    expect(m.enabled).toBe(false);
    expect(m.outbound).toEqual([]);
    expect(m.fulfilled).toContain('document');
    const evaluate = m.calls.find((c) => c.method === 'Runtime.evaluate');
    expect(evaluate?.params.expression).toContain('localStorage.clear()');
    expect(evaluate?.params.expression).toContain('localStorage.setItem("k","v")');
    const fulfillDoc = m.calls.find((c) => c.method === 'Fetch.fulfillRequest' && c.params.requestId === 'document');
    expect(fulfillDoc?.params.responseHeaders).toEqual([{ name: 'Content-Type', value: 'text/html; charset=utf-8' }]);
    // Fetch.enable 不限 patterns：拦截全部资源类型
    expect(m.calls.find((c) => c.method === 'Fetch.enable')?.params.patterns).toBeUndefined();
    // 先回 about:blank（拦截仍在线）再 Fetch.disable
    const blankIdx = m.calls.findIndex((c) => c.method === 'Page.navigate' && c.params.url === 'about:blank');
    const disableIdx = m.calls.findIndex((c) => c.method === 'Fetch.disable');
    expect(blankIdx).toBeGreaterThan(-1);
    expect(disableIdx).toBeGreaterThan(blankIdx);
  });

  it('事件先于 navigate ack：不提前操作（等真实响应后 committed 才操作）', async () => {
    const m = new Model('frame-before-navigation-ack');
    await expect(restoreStorageOrigins(m, 'owned-session', [{ origin, localStorage: [{ name: 'k', value: 'v' }] }])).resolves.toBeUndefined();
    expect([...m.listeners.values()].reduce((n, s) => n + s.size, 0)).toBe(0);
    expect(m.enabled).toBe(false);
  });

  it('errorText 非空（事件已匹配）：固定安全文案拒绝，不透传原 errorText', async () => {
    const m = new Model('navigation-errorText');
    await expect(restoreStorageOrigins(m, 'owned-session', [{ origin, localStorage: [] }])).rejects.toThrow('导航失败（固定安全文案，不透传 errorText）');
    // 不应有 Runtime.evaluate 调（导航失败则不操作 localStorage）
    const evalCalls = m.calls.filter((c) => c.method === 'Runtime.evaluate');
    expect(evalCalls.length).toBe(0);
    expect([...m.listeners.values()].reduce((n, s) => n + s.size, 0)).toBe(0);
    expect(m.enabled).toBe(false);
    expect(m.outbound).toEqual([]);
  });

  it.each(['favicon', 'late-favicon'])('%s：初始化/收尾期非 Document 请求零外发（惰性应答封住）', async (mode) => {
    const m = new Model(mode);
    await restoreStorageOrigins(m, 'owned-session', [{ origin, localStorage: [{ name: 'k', value: 'v' }] }]);
    expect(m.outbound).toEqual([]);
    expect(m.fulfilled).toContain('favicon');
    expect([...m.listeners.values()].reduce((n, s) => n + s.size, 0)).toBe(0);
    expect(m.enabled).toBe(false);
  });

  it('回滚（clearOnly）：只 clear 不写值，同样零外发 + 全清', async () => {
    const m = new Model('committed-positive');
    await restoreStorageOrigins(m, 'owned-session', [{ origin, localStorage: [{ name: 'k', value: 'v' }] }], true);
    const evaluate = m.calls.find((c) => c.method === 'Runtime.evaluate');
    expect(evaluate?.params.expression).toBe('localStorage.clear()');
    expect(evaluate?.params.expression).not.toContain('setItem');
    expect(m.outbound).toEqual([]);
    expect(m.enabled).toBe(false);
    expect([...m.listeners.values()].reduce((n, s) => n + s.size, 0)).toBe(0);
  });

  it('收尾失败（Fetch.disable 拒绝）：安全拒绝不吞成功', async () => {
    const m = new Model('committed-positive');
    const origSend = m.send.bind(m);
    m.send = async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'Fetch.disable') throw new Error('disable failed');
      return origSend(method, params);
    };
    await expect(restoreStorageOrigins(m, 'owned-session', [{ origin, localStorage: [] }])).rejects.toThrow('收尾失败');
    // 监听仍被移除（每步都尝试）
    expect([...m.listeners.values()].reduce((n, s) => n + s.size, 0)).toBe(0);
  });

  it('foreign frame/target 的请求不借用：不 fulfill 也不 continue（惰性 204 也不发）', async () => {
    const m = new Model('foreign-frame');
    await restoreStorageOrigins(m, 'owned-session', [{ origin, localStorage: [{ name: 'k', value: 'v' }] }]);
    expect(m.calls.some((c) => c.method === 'Fetch.fulfillRequest' && c.params.requestId === 'foreign-document')).toBe(false);
    expect(m.calls.some((c) => c.method === 'Fetch.continueRequest' && c.params.requestId === 'foreign-document')).toBe(false);
    // owned 主请求照常惰性/文档应答
    expect(m.fulfilled).toContain('document');
    expect(m.outbound).toEqual([]);
    expect(m.enabled).toBe(false);
    expect([...m.listeners.values()].reduce((n, s) => n + s.size, 0)).toBe(0);
  });

  it('Promise.all 时序：nav 响应永悬空时，frame 10s 超时立即安全拒绝并清理（不等 nav 完成）', async () => {
    vi.useFakeTimers();
    const m = new Model('committed-positive');
    const origSend = m.send.bind(m);
    let navPending = false;
    m.send = <T>(method: string, params: Record<string, unknown> = {}) => {
      // origin 导航响应永悬空（模拟 15s CDP 等待未到）；about:blank 收尾照常返回
      if (method === 'Page.navigate' && params.url === origin) {
        navPending = true;
        return new Promise<T>(() => {});
      }
      return origSend(method, params) as Promise<T>;
    };
    const pending = restoreStorageOrigins(m, 'owned-session', [{ origin, localStorage: [] }]);
    // 拒绝断言先挂上（advance 期间定时器即拒绝，后挂会有 unhandled 窗口），再推进定时器
    const rejected = expect(pending).rejects.toThrow('导航等待提交超时');
    // 推进到 frame 10s 定时器：应立即拒绝
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    expect(navPending).toBe(true);
    // 未操作 localStorage（提交事实未成立就拒绝了）
    expect(m.calls.some((c) => c.method === 'Runtime.evaluate')).toBe(false);
    // 收尾仍执行：监听移除、Fetch 关闭
    expect([...m.listeners.values()].reduce((n, s) => n + s.size, 0)).toBe(0);
    expect(m.enabled).toBe(false);
    expect(m.outbound).toEqual([]);
  });
});
