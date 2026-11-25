/**
 * createTabIn 协议回归测试（纯逻辑 mock，不起真浏览器）。
 * 修一个真实回归：旧实现用默认 GET 调 /json/new 并在失败时回退同 URL GET，
 * 现代 Chrome CDP 要求 PUT，GET 被拒导致真实 bootstrap 全挂。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createTabIn } from '../browser/daemon-client.js';

type FetchCall = { url: string; method: string };

function mockFetch(opts: {
  ok?: boolean;
  status?: number;
  body?: unknown;
  throwOnce?: boolean;
}): { calls: FetchCall[]; restore: () => void } {
  const calls: FetchCall[] = [];
  let thrown = false;
  const original = globalThis.fetch;
  const impl = async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: (init?.method as string) ?? 'GET' });
    if (opts.throwOnce && !thrown) {
      thrown = true;
      throw new Error('network-down');
    }
    const ok = opts.ok ?? true;
    const status = opts.status ?? 200;
    return {
      ok,
      status,
      json: async () => opts.body ?? { id: 'TAB-1', url: 'about:blank' },
    } as Response;
  };
  globalThis.fetch = impl as typeof globalThis.fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createTabIn HTTP 方法回归', () => {
  it('成功：使用 PUT /json/new（不是 GET）', async () => {
    const { calls, restore } = mockFetch({ ok: true, body: { id: 'TAB-1', url: 'about:blank' } });
    const tab = await createTabIn('http://127.0.0.1:9222', 'https://example.com/');
    restore();
    expect(tab.id).toBe('TAB-1');
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('PUT');
    expect(calls[0].url).toContain('/json/new?');
  });

  it('网络异常：抛错且不第二次 GET 同 URL', async () => {
    const { calls, restore } = mockFetch({ throwOnce: true });
    await expect(createTabIn('http://127.0.0.1:9222', 'https://example.com/')).rejects.toThrow(/创建标签页失败/);
    restore();
    // 关键回归断言：失败不回退同 URL GET
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('PUT');
  });

  it('HTTP 非 2xx：抛安全错误（含状态码，不含 endpoint/token）', async () => {
    const { calls, restore } = mockFetch({ ok: false, status: 405 });
    const err = await createTabIn('http://127.0.0.1:9222', 'https://example.com/').catch((e) => e as Error);
    restore();
    expect(err.message).toContain('HTTP 405');
    expect(err.message).not.toContain('127.0.0.1');
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('PUT');
  });
});
