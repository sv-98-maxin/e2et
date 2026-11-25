/**
 * MockInterceptor 诊断日志（42304 Phase A2）。
 * stderr 记录 Fetch requestId / 可用 networkId / method / path / Origin 的 origin 部分与 fulfill 开始/ack/失败阶段；
 * 不泄完整 URL/query、任意请求头、body、cookie、token、stack。只做纯逻辑验证，不碰真实浏览器。
 */
import { describe, expect, it, vi } from 'vitest';
import { MockInterceptor } from '../mock.js';

class FakeCdp {
  calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  failFulfill = false;
  private listeners = new Map<string, Array<(params: any) => void>>();

  on(method: string, handler: (params: any) => void): () => void {
    const list = this.listeners.get(method) ?? [];
    list.push(handler);
    this.listeners.set(method, list);
    return () => this.listeners.set(method, list.filter((item) => item !== handler));
  }

  async send<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ method, params });
    if (method === 'Fetch.fulfillRequest' && this.failFulfill) throw new Error('boom-ish');
    return {} as T;
  }

  emit(method: string, params: any): void {
    for (const handler of this.listeners.get(method) ?? []) handler(params);
  }
}

function pauseParams(): any {
  return {
    requestId: 'fetch-1',
    networkId: 'net-1',
    request: {
      url: 'https://example.test/api/save?token=url-secret',
      method: 'POST',
      headers: { Origin: 'https://portal.example.invalid', Cookie: 'cookie-secret=x' },
    },
  };
}

/** spy stderr 收集写入内容，不污染测试输出 */
function spyStderr(): { writes: string[]; restore: () => void } {
  const writes: string[] = [];
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: any) => { writes.push(String(chunk)); return true; }) as any);
  return { writes, restore: () => spy.mockRestore() };
}

describe('MockInterceptor 诊断日志（A2）', () => {
  it('handlePaused 记录诊断字段与 fulfill 开始/ack 阶段，不泄露报文', async () => {
    const { writes, restore } = spyStderr();
    const intercepted: string[] = [];
    const cdp = new FakeCdp();
    try {
      const mock = new MockInterceptor(cdp as any, (requestId) => intercepted.push(requestId));
      await mock.add({ path: '/api/save', status: 200, bodyBuffer: Buffer.from('{"mocked":true}') });
      cdp.emit('Fetch.requestPaused', pauseParams());
      await new Promise((r) => setTimeout(r, 50));
      const all = writes.join('');
      // 诊断字段可取：Fetch requestId / networkId / method / path / Origin 的 origin 部分
      expect(all).toContain('cdpId=fetch-1');
      expect(all).toContain('networkId=net-1');
      expect(all).toContain('method=POST');
      expect(all).toContain('path=/api/save');
      expect(all).toContain('origin=https://portal.example.invalid');
      // fulfill 开始/ack 阶段可辨
      expect(all).toContain('START');
      expect(all).toContain('ACK');
      // 不泄露报文：完整 URL/query、请求头、body
      expect(all).not.toContain('url-secret');
      expect(all).not.toContain('https://example.test/api/save');
      expect(all).not.toContain('Cookie');
      expect(all).not.toContain('cookie-secret');
      expect(all).not.toContain('{"mocked":true}');
      expect(all).not.toContain('stack');
      // fulfill 真实发生；既有 onIntercept 回调保留
      expect(cdp.calls.some((c) => c.method === 'Fetch.fulfillRequest' && c.params.requestId === 'fetch-1')).toBe(true);
      expect(intercepted).toEqual(['fetch-1']);
      expect(mock.hasMocked()).toBe(true);
    } finally { restore(); }
  });

  it('fulfill 失败阶段：FAILED 记录 error 不带 stack，不做 console.error 双输出', async () => {
    const { writes, restore } = spyStderr();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cdp = new FakeCdp();
    cdp.failFulfill = true;
    try {
      const mock = new MockInterceptor(cdp as any);
      await mock.add({ path: '/api/save', status: 200, bodyBuffer: Buffer.from('{"mocked":true}') });
      cdp.emit('Fetch.requestPaused', pauseParams());
      await new Promise((r) => setTimeout(r, 50));
      const all = writes.join('');
      expect(all).toContain('FAILED');
      expect(all).toContain('error=boom-ish');
      expect(all).not.toContain('stack');
      expect(all).not.toContain('url-secret');
      expect(all).not.toContain('cookie-secret');
      // 诊断只写 stderr，不再 console.error 双输出
      expect(errorSpy).not.toHaveBeenCalled();
    } finally { errorSpy.mockRestore(); restore(); }
  });
});

/**
 * 42304 Phase B P0:mock CORS 预检阻断修复。
 * OPTIONS 预检(OPTIONS + Origin + Access-Control-Request-Method)命中规则时回 200 空 body + 预检 CORS 头,
 * 回显浏览器原始 Origin(含合法 null),不用 wildcard;预检不消耗 call 计数,
 * 业务请求保持 rule.status/body/Content-Type,带 Origin 时补 Allow-Origin/Credentials。
 * 依旧纯逻辑验证,不碰真实浏览器。
 */

/** CORS 预检 pause 事件参数:OPTIONS + Origin + Access-Control-Request-Method(可带 -Headers) */
function preflightParams(opts: { headers?: Record<string, string>; url?: string; requestId?: string } = {}): any {
  return {
    requestId: opts.requestId ?? 'fetch-preflight',
    networkId: 'net-preflight',
    request: {
      url: opts.url ?? 'https://item.example.invalid/api/save',
      method: 'OPTIONS',
      headers: opts.headers ?? {
        Origin: 'https://portal.example.invalid',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type,x-secreq-header',
      },
    },
  };
}

/** 业务 POST pause 事件参数(跨 origin,带 Origin) */
function postParams(requestId = 'fetch-post'): any {
  return {
    requestId,
    networkId: 'net-post',
    request: {
      url: 'https://item.example.invalid/api/save',
      method: 'POST',
      headers: { Origin: 'https://portal.example.invalid' },
    },
  };
}

/** 取某 requestId 的 Fetch.fulfillRequest 参数 */
function fulfillOf(cdp: FakeCdp, requestId: string): any {
  return cdp.calls.find((c) => c.method === 'Fetch.fulfillRequest' && c.params.requestId === requestId)?.params;
}

function responseHeadersOf(params: any): Array<{ name: string; value: string }> {
  return (params?.responseHeaders ?? []) as Array<{ name: string; value: string }>;
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 50));

describe('MockInterceptor CORS 预检(P0)', () => {
  it('预检命中规则:200 空 body + 完整预检 CORS 头,不消耗 call-index,第一个 POST 仍命中 mock', async () => {
    const { writes, restore } = spyStderr();
    const cdp = new FakeCdp();
    try {
      const mock = new MockInterceptor(cdp as any);
      await mock.add({ path: '/api/save', callIndex: 1, status: 200, bodyBuffer: Buffer.from('{"mocked":true}') });
      // 预检先到:按"下一次业务请求"的计数(#1)查规则,命中但按预检应答
      cdp.emit('Fetch.requestPaused', preflightParams());
      await flush();
      const preflight = fulfillOf(cdp, 'fetch-preflight');
      expect(preflight).toBeTruthy();
      expect(preflight?.responseCode).toBe(200);
      expect(preflight?.body).toBe('');
      const preflightHeaders = responseHeadersOf(preflight);
      expect(preflightHeaders).toContainEqual({ name: 'Access-Control-Allow-Origin', value: 'https://portal.example.invalid' });
      expect(preflightHeaders).toContainEqual({ name: 'Access-Control-Allow-Credentials', value: 'true' });
      expect(preflightHeaders).toContainEqual({ name: 'Access-Control-Allow-Methods', value: 'POST' });
      expect(preflightHeaders).toContainEqual({ name: 'Access-Control-Allow-Headers', value: 'content-type,x-secreq-header' });
      // 日志不泄露预检请求头列表值
      expect(writes.join('')).not.toContain('x-secreq-header');
      // 业务 POST 后到:预检没消耗 #1,本请求按 call-index 1 命中 mock
      cdp.emit('Fetch.requestPaused', postParams());
      await flush();
      const post = fulfillOf(cdp, 'fetch-post');
      expect(post).toBeTruthy();
      expect(post?.responseCode).toBe(200);
      expect(post?.body).toBe(Buffer.from('{"mocked":true}').toString('base64'));
      const postHeaders = responseHeadersOf(post);
      expect(postHeaders).toContainEqual({ name: 'Content-Type', value: 'application/json; charset=utf-8' });
      expect(postHeaders).toContainEqual({ name: 'Access-Control-Allow-Origin', value: 'https://portal.example.invalid' });
      expect(postHeaders).toContainEqual({ name: 'Access-Control-Allow-Credentials', value: 'true' });
      // #1 已被业务 POST 消耗:第二个 POST(counter=2)无 #2 规则 → 放行
      cdp.emit('Fetch.requestPaused', postParams('fetch-post-2'));
      await flush();
      expect(cdp.calls.some((c) => c.method === 'Fetch.continueRequest' && c.params.requestId === 'fetch-post-2')).toBe(true);
      expect(fulfillOf(cdp, 'fetch-post-2')).toBeUndefined();
    } finally { restore(); }
  });

  it('业务配置 500:预检仍 200 空 body,业务仍 500;诊断 status 与实际 responseCode 一致', async () => {
    const { writes, restore } = spyStderr();
    const cdp = new FakeCdp();
    try {
      const mock = new MockInterceptor(cdp as any);
      await mock.add({ path: '/api/save', status: 500, bodyBuffer: Buffer.from('{"err":1}') });
      cdp.emit('Fetch.requestPaused', preflightParams());
      await flush();
      const preflight = fulfillOf(cdp, 'fetch-preflight');
      expect(preflight?.responseCode).toBe(200);
      expect(preflight?.body).toBe('');
      expect(responseHeadersOf(preflight).some((h) => h.name === 'Access-Control-Allow-Origin')).toBe(true);
      cdp.emit('Fetch.requestPaused', postParams());
      await flush();
      const post = fulfillOf(cdp, 'fetch-post');
      expect(post?.responseCode).toBe(500);
      expect(post?.body).toBe(Buffer.from('{"err":1}').toString('base64'));
      // 诊断 status 与实际 responseCode 一致:预检记 200,业务记 500
      const all = writes.join('');
      expect(all).toContain('status=200');
      expect(all).toContain('status=500');
    } finally { restore(); }
  });

  it('混合大小写请求头:预检判定与原始 Origin 回显仍正确', async () => {
    const cdp = new FakeCdp();
    const { writes, restore } = spyStderr();
    try {
      const mock = new MockInterceptor(cdp as any);
      await mock.add({ path: '/api/save', status: 200, bodyBuffer: Buffer.from('{}') });
      cdp.emit('Fetch.requestPaused', preflightParams({
        headers: { oRiGiN: 'https://portal.example.invalid', 'aCcEsS-cOnTrOl-ReQuEsT-MeThOd': 'POST' },
      }));
      await flush();
      const preflight = fulfillOf(cdp, 'fetch-preflight');
      expect(preflight?.responseCode).toBe(200);
      expect(preflight?.body).toBe('');
      const headers = responseHeadersOf(preflight);
      expect(headers).toContainEqual({ name: 'Access-Control-Allow-Origin', value: 'https://portal.example.invalid' });
      expect(headers).toContainEqual({ name: 'Access-Control-Allow-Methods', value: 'POST' });
      // 无 Access-Control-Request-Headers 时不加 Access-Control-Allow-Headers
      expect(headers.some((h) => h.name === 'Access-Control-Allow-Headers')).toBe(false);
      // 日志照常用规范化 origin,不泄露其它请求头
      expect(writes.join('')).toContain('origin=https://portal.example.invalid');
    } finally { restore(); }
  });

  it('普通无预检头的 OPTIONS 不被特殊处理:按业务规则应答并消耗计数', async () => {
    const cdp = new FakeCdp();
    const { restore } = spyStderr();
    try {
      const mock = new MockInterceptor(cdp as any);
      await mock.add({ path: '/api/save', callIndex: 1, status: 200, bodyBuffer: Buffer.from('{"mocked":true}') });
      // OPTIONS + Origin 但无 Access-Control-Request-Method:不是预检,按业务请求处理
      cdp.emit('Fetch.requestPaused', preflightParams({ headers: { Origin: 'https://portal.example.invalid' } }));
      await flush();
      const plain = fulfillOf(cdp, 'fetch-preflight');
      expect(plain?.responseCode).toBe(200);
      expect(plain?.body).toBe(Buffer.from('{"mocked":true}').toString('base64'));
      expect(responseHeadersOf(plain)).toContainEqual({ name: 'Content-Type', value: 'application/json; charset=utf-8' });
      // 消耗了 #1:后续 POST 是 counter=2,无 #2 规则 → 放行
      cdp.emit('Fetch.requestPaused', postParams());
      await flush();
      expect(cdp.calls.some((c) => c.method === 'Fetch.continueRequest' && c.params.requestId === 'fetch-post')).toBe(true);
    } finally { restore(); }
  });

  it('无 Origin 的业务请求保持既有响应:不加任何 CORS 头', async () => {
    const cdp = new FakeCdp();
    const { restore } = spyStderr();
    try {
      const mock = new MockInterceptor(cdp as any);
      await mock.add({ path: '/api/save', status: 200, bodyBuffer: Buffer.from('{"mocked":true}') });
      cdp.emit('Fetch.requestPaused', {
        requestId: 'fetch-no-origin',
        networkId: 'net-no',
        request: { url: 'https://item.example.invalid/api/save', method: 'POST', headers: {} },
      });
      await flush();
      const post = fulfillOf(cdp, 'fetch-no-origin');
      expect(post?.responseCode).toBe(200);
      expect(post?.body).toBe(Buffer.from('{"mocked":true}').toString('base64'));
      expect(responseHeadersOf(post)).toEqual([{ name: 'Content-Type', value: 'application/json; charset=utf-8' }]);
    } finally { restore(); }
  });

  it('不匹配 path 的预检不被伪造:走 Fetch.continueRequest 放行', async () => {
    const cdp = new FakeCdp();
    const { restore } = spyStderr();
    try {
      const mock = new MockInterceptor(cdp as any);
      await mock.add({ path: '/api/save', status: 200, bodyBuffer: Buffer.from('{}') });
      cdp.emit('Fetch.requestPaused', preflightParams({ url: 'https://item.example.invalid/other/path' }));
      await flush();
      expect(cdp.calls.some((c) => c.method === 'Fetch.continueRequest' && c.params.requestId === 'fetch-preflight')).toBe(true);
      expect(fulfillOf(cdp, 'fetch-preflight')).toBeUndefined();
    } finally { restore(); }
  });

  it('Origin 为 null:响应头回显原始 null 值,日志仍只用规范化 origin', async () => {
    const cdp = new FakeCdp();
    const { writes, restore } = spyStderr();
    try {
      const mock = new MockInterceptor(cdp as any);
      await mock.add({ path: '/api/save', status: 200, bodyBuffer: Buffer.from('{}') });
      cdp.emit('Fetch.requestPaused', preflightParams({
        headers: { Origin: 'null', 'Access-Control-Request-Method': 'POST' },
      }));
      await flush();
      const preflight = fulfillOf(cdp, 'fetch-preflight');
      expect(preflight?.responseCode).toBe(200);
      expect(preflight?.body).toBe('');
      expect(responseHeadersOf(preflight)).toContainEqual({ name: 'Access-Control-Allow-Origin', value: 'null' });
      // 'null' 不是合法 URL,规范化失败记空串;日志不回显原始值
      const all = writes.join('');
      expect(all).toContain('origin=\n');
      expect(all).not.toContain('origin=null');
    } finally { restore(); }
  });
});
