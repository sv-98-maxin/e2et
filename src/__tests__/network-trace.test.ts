import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NetworkTrace } from '../daemon/network-trace.js';
import { traceDir } from '../daemon/session-meta.js';

class FakeCdp {
  calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  responseBodies = new Map<string, { body: string; base64Encoded?: boolean }>();
  postBodies = new Map<string, string>();
  private listeners = new Map<string, Array<(params: any) => void>>();
  // CDP Frame.url 不含 fragment，urlFragment 单独字段（含 '#'）；必须拼接完整 URL
  frame: { id: string; url: string; urlFragment?: string } = { id: 'main', url: 'https://example.test/home' };

  on(method: string, handler: (params: any) => void): () => void {
    const list = this.listeners.get(method) ?? [];
    list.push(handler);
    this.listeners.set(method, list);
    return () => this.listeners.set(method, list.filter((item) => item !== handler));
  }

  async send<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ method, params });
    const requestId = String(params.requestId ?? '');
    if (method === 'Network.getResponseBody') return (this.responseBodies.get(requestId) ?? { body: '' }) as T;
    if (method === 'Network.getRequestPostData') return { postData: this.postBodies.get(requestId) } as T;
    if (method === 'Page.getFrameTree') return { frameTree: { frame: this.frame } } as T;
    return {} as T;
  }

  emit(method: string, params: any): void {
    for (const handler of this.listeners.get(method) ?? []) handler(params);
  }
}

function request(cdp: FakeCdp, requestId: string, url: string, type = 'XHR', extra: Record<string, unknown> = {}): void {
  cdp.emit('Network.requestWillBeSent', {
    requestId,
    frameId: 'main',
    type,
    wallTime: Date.now() / 1000,
    request: { url, method: 'POST', headers: { 'content-type': 'application/json' }, ...extra },
  });
}

function respond(cdp: FakeCdp, requestId: string, status = 200, contentType = 'application/json'): void {
  cdp.emit('Network.responseReceived', {
    requestId,
    response: { status, mimeType: contentType, headers: { 'content-type': contentType } },
  });
}

function finish(cdp: FakeCdp, requestId: string): void {
  cdp.responseBodies.set(requestId, { body: '{"ok":true}' });
  cdp.emit('Network.loadingFinished', { requestId });
}

function readEvents(id: string): any[] {
  return fs.readFileSync(path.join(traceDir(id), 'trace.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

function docRequest(cdp: FakeCdp, requestId: string, url: string, frameId: string): void {
  cdp.emit('Network.requestWillBeSent', { requestId, frameId, type: 'Document', wallTime: Date.now() / 1000, request: { url, method: 'GET', headers: {} } });
}

describe('NetworkTrace', () => {
  let home: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.E2ET_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'network-trace-'));
    process.env.E2ET_HOME = home;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.E2ET_HOME;
    else process.env.E2ET_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('loadingFinished 后取 response body；缺 postData 时补取；loadingFailed 无 body 也落事件', async () => {
    const cdp = new FakeCdp();
    const trace = new NetworkTrace('lifecycle', cdp as any);
    trace.install();
    await trace.initialize('__source__');
    await trace.enable();

    cdp.postBodies.set('ok', '{"password":"request-secret"}');
    request(cdp, 'ok', 'https://example.test/api/save', 'Fetch', { hasPostData: true });
    respond(cdp, 'ok');
    cdp.responseBodies.set('ok', { body: '{"token":"response-secret","ok":true}' });
    cdp.emit('Network.loadingFinished', { requestId: 'ok' });

    request(cdp, 'failed', 'https://example.test/api/fail');
    cdp.emit('Network.loadingFailed', { requestId: 'failed', errorText: 'net::ERR_ABORTED' });
    await trace.flush();

    expect(cdp.calls).toContainEqual({ method: 'Network.enable', params: {} });
    expect(cdp.calls.some((call) => call.method === 'Network.getRequestPostData' && call.params.requestId === 'ok')).toBe(true);
    expect(cdp.calls.some((call) => call.method === 'Network.getResponseBody' && call.params.requestId === 'ok')).toBe(true);
    expect(cdp.calls.some((call) => call.method === 'Network.getResponseBody' && call.params.requestId === 'failed')).toBe(false);

    const events = readEvents('lifecycle').filter((event) => event.t === 'request');
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ id: 'r1', req_body_ref: expect.any(String), resp_body_ref: expect.any(String), status: 200 });
    expect(events[1]).toMatchObject({ id: 'r2', failed: 'net::ERR_ABORTED' });
    expect(events[1].resp_body_ref).toBeUndefined();
    const all = fs.readFileSync(path.join(traceDir('lifecycle'), 'trace.jsonl'), 'utf8')
      + fs.readdirSync(path.join(traceDir('lifecycle'), 'blobs')).map((name) => fs.readFileSync(path.join(traceDir('lifecycle'), 'blobs', name), 'utf8')).join('');
    expect(all).not.toContain('request-secret');
    expect(all).not.toContain('response-secret');
  });

  it('call_index 按 nav/path 发起顺序递增；主 document 先切 n1；SPA 再切新 nav', async () => {
    const cdp = new FakeCdp();
    cdp.frame = { id: 'main', url: 'https://example.test/start' };
    const trace = new NetworkTrace('navigation', cdp as any);
    trace.install();
    await trace.initialize('__source__');

    for (const id of ['a', 'b']) {
      request(cdp, id, 'https://example.test/api/list');
      respond(cdp, id);
      finish(cdp, id);
    }
    request(cdp, 'doc', 'https://example.test/next', 'Document');
    cdp.emit('Page.frameNavigated', { frame: { id: 'main', url: 'https://example.test/next' } });
    respond(cdp, 'doc');
    finish(cdp, 'doc');
    request(cdp, 'after', 'https://example.test/api/list');
    respond(cdp, 'after');
    finish(cdp, 'after');
    cdp.emit('Page.navigatedWithinDocument', { frameId: 'main', url: 'https://example.test/next#tab' });
    request(cdp, 'spa', 'https://example.test/api/list');
    respond(cdp, 'spa');
    finish(cdp, 'spa');
    await trace.flush();

    const events = readEvents('navigation');
    const requests = events.filter((event) => event.t === 'request');
    expect(requests.map((event) => [event.id, event.nav, event.path, event.call_index])).toEqual([
      ['r1', 'n0', '/api/list', 1],
      ['r2', 'n0', '/api/list', 2],
      ['r3', 'n1', '/next', 1],
      ['r4', 'n1', '/api/list', 1],
      ['r5', 'n2', '/api/list', 1],
    ]);
    expect(events.filter((event) => event.t === 'navigation')).toMatchObject([
      { id: 'n1', kind: 'same_page', from: 'https://example.test/start', to: 'https://example.test/next' },
      { id: 'n2', kind: 'spa_route', to: 'https://example.test/next#tab' },
    ]);
  });

  it('finding 13：action 保留完整 creates 标注，请求只记录匹配的实体', async () => {
    const cdp = new FakeCdp();
    cdp.frame = { id: 'main', url: 'https://example.test/start' };
    const trace = new NetworkTrace('creates', cdp as any);
    trace.install();
    await trace.initialize('__source__');
    const creates = { entity: 'item', path: '/api/create' };
    const action = trace.beginAction('click', '创建实体', {}, { creates })!;
    request(cdp, 'create', 'https://example.test/api/create');
    respond(cdp, 'create');
    finish(cdp, 'create');
    trace.finishAction(action, true);
    await trace.flush();
    const events = readEvents('creates');
    expect(events.find((event) => event.t === 'action').creates).toEqual(creates);
    expect(events.find((event) => event.t === 'request')).toMatchObject({ creates: 'item', triggered_by: action.id });
  });

  it('requestWillBeSent 当场固化 action 归因，动作前在途不抢；并发 action 拒绝', async () => {
    const cdp = new FakeCdp();
    cdp.frame = { id: 'main', url: 'https://example.test/start' };
    const trace = new NetworkTrace('attribution', cdp as any);
    trace.install();
    await trace.initialize('__source__');

    request(cdp, 'before', 'https://example.test/api/before');
    // Phase2：生产点（runAction URL 来源守卫）在 beginAction 前已按实际替换事实处理 URL——
    // 凭证 query 会被整条命令拒绝，能落 trace 的只有无实际替换的 URL；此处模拟生产点已处理后的输入
    const action = trace.beginAction('open', '打开页面', { url: 'https://example.test/next' })!;
    expect(trace.beginAction('open', '并发动作', { url: 'https://example.test/other' })).toBeNull();
    cdp.emit('Network.requestWillBeSent', {
      requestId: 'before', frameId: 'main', type: 'XHR', wallTime: Date.now() / 1000,
      redirectResponse: { status: 302, headers: { location: 'https://example.test/api/after-redirect' } },
      request: { url: 'https://example.test/api/after-redirect', method: 'GET', headers: {} },
    });
    request(cdp, 'during', 'https://example.test/api/during');
    respond(cdp, 'before');
    finish(cdp, 'before');
    respond(cdp, 'during');
    finish(cdp, 'during');
    await trace.flush();
    trace.finishAction(action, true);
    const afterFailure = trace.beginAction('open', '失败后重试', { url: 'https://example.test/retry' })!;
    expect(afterFailure.id).toBe('a2');
    trace.finishAction(afterFailure, false);

    const events = readEvents('attribution');
    expect(events.find((event) => event.id === 'r1').triggered_by).toBeNull();
    expect(events.find((event) => event.id === 'r2').triggered_by).toBeNull();
    expect(events.find((event) => event.id === 'r3').triggered_by).toBe('a1');
    expect(events.find((event) => event.id === 'a1')).toMatchObject({ kind: 'open', requests: ['r3'], result: { ok: true } });
  });

  it('redirect 每跳保留；图片和既有埋点过滤；未知响应体不落 blob', async () => {
    const cdp = new FakeCdp();
    const trace = new NetworkTrace('redirect', cdp as any);
    trace.install();
    await trace.initialize('__source__');

    request(cdp, 'nav', 'https://example.test/start', 'Document');
    cdp.emit('Network.requestWillBeSent', {
      requestId: 'nav', frameId: 'main', type: 'Document', wallTime: Date.now() / 1000,
      redirectResponse: { status: 302, headers: { location: 'https://example.test/final' } },
      request: { url: 'https://example.test/final', method: 'GET', headers: {} },
    });
    cdp.emit('Page.frameNavigated', { frame: { id: 'main', url: 'https://example.test/final' } });
    respond(cdp, 'nav');
    finish(cdp, 'nav');
    request(cdp, 'image', 'https://example.test/logo.png', 'Fetch');
    request(cdp, 'telemetry', 'https://example.test/arms-retcode/log', 'XHR');
    request(cdp, 'binary', 'https://example.test/api/file', 'Fetch');
    respond(cdp, 'binary', 200, 'application/octet-stream');
    cdp.responseBodies.set('binary', { body: Buffer.from([0, 1, 2]).toString('base64'), base64Encoded: true });
    cdp.emit('Network.loadingFinished', { requestId: 'binary' });
    await trace.flush();

    const events = readEvents('redirect');
    const requests = events.filter((event) => event.t === 'request');
    expect(requests.map((event) => [event.id, event.path, event.nav])).toEqual([
      ['r1', '/start', 'n1'],
      ['r2', '/final', 'n1'],
      ['r3', '/api/file', 'n1'],
    ]);
    expect(requests[0]).toMatchObject({ status: 302, resp_body_omitted: 'body_unavailable' });
    expect(requests[0].resp_body_ref).toBeUndefined();
    expect(requests[1]).toMatchObject({ status: 200, resp_body_ref: expect.any(String) });
    expect(cdp.calls.filter((call) => call.method === 'Network.getResponseBody')).toHaveLength(2);
    expect(requests[2]).toMatchObject({ resp_body_omitted: 'unsupported_content_type' });
    expect(requests[2].resp_body_ref).toBeUndefined();
    expect(events.find((event) => event.t === 'navigation')).toMatchObject({ id: 'n1', to: 'https://example.test/final' });
  });
});

describe('NetworkTrace 多 target', () => {
  let home: string;
  let previousHome: string | undefined;
  beforeEach(() => {
    previousHome = process.env.E2ET_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-multi-'));
    process.env.E2ET_HOME = home;
  });
  afterEach(() => {
    if (previousHome === undefined) delete process.env.E2ET_HOME;
    else process.env.E2ET_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('双 target 相同 cdpRequestId 不同 body：全局 r/n 唯一、不串 body、getResponseBody 路由到所属 pageWS', async () => {
    const sourceCdp = new FakeCdp();
    const popupCdp = new FakeCdp();
    const trace = new NetworkTrace('multi', sourceCdp as any, 'source-tab');
    sourceCdp.frame = { id: 'main-s', url: 'https://example.test/source' };
    trace.install();
    await trace.initialize('source-tab');
    await trace.enable();
    // 注册 popup target（独立 pageWS）
    trace.addTarget('popup-tab', popupCdp as any, 'main-p', 'https://example.test/popup');
    await popupCdp.send('Network.enable').catch(() => {});

    // 两个 target 用相同 cdpRequestId 'shared-1'，但 URL/body 不同
    sourceCdp.postBodies.set('shared-1', '{"src":"source-body"}');
    sourceCdp.responseBodies.set('shared-1', { body: '{"resp":"source-resp"}' });
    popupCdp.postBodies.set('shared-1', '{"src":"popup-body"}');
    popupCdp.responseBodies.set('shared-1', { body: '{"resp":"popup-resp"}' });

    request(sourceCdp, 'shared-1', 'https://example.test/api/save', 'Fetch', { hasPostData: true });
    request(popupCdp, 'shared-1', 'https://example.test/api/save', 'Fetch', { hasPostData: true });
    respond(sourceCdp, 'shared-1');
    respond(popupCdp, 'shared-1');
    // 手动 emit loadingFinished（不用 finish helper，避免覆盖 responseBodies）
    sourceCdp.emit('Network.loadingFinished', { requestId: 'shared-1' });
    popupCdp.emit('Network.loadingFinished', { requestId: 'shared-1' });
    await trace.flush();

    const events = readEvents('multi');
    const reqs = events.filter((e) => e.t === 'request');
    expect(reqs).toHaveLength(2);
    // 全局 r id 唯一（不重号）
    const ids = reqs.map((r) => r.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids).toEqual(['r1', 'r2']);
    // 各自带 target_id，不串
    const srcReq = reqs.find((r) => r.target_id === 'source-tab')!;
    const popReq = reqs.find((r) => r.target_id === 'popup-tab')!;
    expect(srcReq).toBeDefined();
    expect(popReq).toBeDefined();
    // getResponseBody 路由到各自 cdp：source 的 requestId 'shared-1' 发到 sourceCdp，popup 的发到 popupCdp
    expect(sourceCdp.calls.some((c) => c.method === 'Network.getResponseBody' && c.params.requestId === 'shared-1')).toBe(true);
    expect(popupCdp.calls.some((c) => c.method === 'Network.getResponseBody' && c.params.requestId === 'shared-1')).toBe(true);
    // getRequestPostData 也各自路由
    expect(sourceCdp.calls.some((c) => c.method === 'Network.getRequestPostData' && c.params.requestId === 'shared-1')).toBe(true);
    expect(popupCdp.calls.some((c) => c.method === 'Network.getRequestPostData' && c.params.requestId === 'shared-1')).toBe(true);
    // body 不串：source 存 source-body，popup 存 popup-body
    const allText = fs.readFileSync(path.join(traceDir('multi'), 'trace.jsonl'), 'utf8')
      + fs.readdirSync(path.join(traceDir('multi'), 'blobs')).map((n) => fs.readFileSync(path.join(traceDir('multi'), 'blobs', n), 'utf8')).join('');
    expect(allText).toContain('source-body');
    expect(allText).toContain('popup-body');
    expect(allText).toContain('source-resp');
    expect(allText).toContain('popup-resp');
  });

  it('setActiveTarget 切换 active：currentNav 用 active target 的 nav，popup 后台导航不改 source nav', async () => {
    const sourceCdp = new FakeCdp();
    const popupCdp = new FakeCdp();
    const trace = new NetworkTrace('active', sourceCdp as any, 'source-tab');
    sourceCdp.frame = { id: 'main-s', url: 'https://example.test/source' };
    trace.install();
    await trace.initialize('source-tab');
    await trace.enable();
    trace.addTarget('popup-tab', popupCdp as any, 'main-p', 'https://example.test/popup');
    await popupCdp.send('Network.enable').catch(() => {});

    // source active 时 beginAction → action.nav 用 source 的 nav
    const act = trace.beginAction('click', '点 source 按钮')!;
    expect(trace.currentNav()).toBe('n0');
    // popup 后台主文档导航 → 分配新 nav，只改 popup 的 currentNavId，不改 source
    request(popupCdp, 'doc-p', 'https://example.test/popup/next', 'Document');
    popupCdp.emit('Page.frameNavigated', { frame: { id: 'main-p', url: 'https://example.test/popup/next' } });
    respond(popupCdp, 'doc-p');
    finish(popupCdp, 'doc-p');
    // source 仍 active，currentNav 仍是 n0（popup 导航没改 source）
    expect(trace.currentNav()).toBe('n0');
    trace.finishAction(act, true);
    await trace.flush();

    // 切到 popup → currentNav 变 popup 的 nav
    trace.setActiveTarget('popup-tab');
    expect(trace.currentNav()).not.toBe('n0');
    // 切回 source → 恢复 source nav
    trace.setActiveTarget('source-tab');
    expect(trace.currentNav()).toBe('n0');
  });
});

describe('NetworkTrace R1 修复', () => {
  let home: string;
  let previousHome: string | undefined;
  beforeEach(() => {
    previousHome = process.env.E2ET_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-r1-'));
    process.env.E2ET_HOME = home;
  });
  afterEach(() => {
    if (previousHome === undefined) delete process.env.E2ET_HOME;
    else process.env.E2ET_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });


  it('隐式 path resolveReqRef 只查 active target/currentNav，不跨页 fallback', async () => {
    const sourceCdp = new FakeCdp();
    const popupCdp = new FakeCdp();
    const trace = new NetworkTrace('r1ref', sourceCdp as any, 'src');
    sourceCdp.frame = { id: 'ms', url: 'https://example.test/source' };
    trace.install();
    await trace.initialize('src');
    await trace.enable();
    trace.addTarget('pop', popupCdp as any, 'mp', 'https://example.test/popup');
    await popupCdp.send('Network.enable').catch(() => {});
    // 两个 target 都有 /api/list 请求（不同 nav）
    for (const [cdp, tid] of [[sourceCdp, 'src'], [popupCdp, 'pop']] as any) {
      request(cdp, 'r-' + tid, 'https://example.test/api/list');
      respond(cdp, 'r-' + tid);
      cdp.emit('Network.loadingFinished', { requestId: 'r-' + tid });
    }
    await trace.flush();
    // active=src：隐式 /api/list 只匹配 src 的请求，不放开 popup
    expect(trace.resolveReqRef('/api/list')?.target_id).toBe('src');
    // 切到 popup：隐式 /api/list 只匹配 popup
    trace.setActiveTarget('pop');
    expect(trace.resolveReqRef('/api/list')?.target_id).toBe('pop');
    // 显式 nav 仍可查会话内历史（src 的 nav）
    const srcNav = readEvents('r1ref').filter((e) => e.t === 'request' && e.target_id === 'src')[0].nav;
    expect(trace.resolveReqRef('/api/list@' + srcNav)?.target_id).toBe('src');
  });

  it('后台请求（其他 target）不偷继承 activeAction creates/等待', async () => {
    const sourceCdp = new FakeCdp();
    const popupCdp = new FakeCdp();
    const trace = new NetworkTrace('r1bg', sourceCdp as any, 'src');
    sourceCdp.frame = { id: 'ms', url: 'https://example.test/source' };
    trace.install();
    await trace.initialize('src');
    await trace.enable();
    trace.addTarget('pop', popupCdp as any, 'mp', 'https://example.test/popup');
    await popupCdp.send('Network.enable').catch(() => {});
    // source active，beginAction(click, creates=/api/create)
    const action = trace.beginAction('click', '点 source 按钮', {}, { creates: { entity: 'item', path: '/api/create' } })!;
    expect(action.targetId).toBe('src');
    // source 的 /api/create → 带 creates=item，归属 action
    request(sourceCdp, 'src-create', 'https://example.test/api/create');
    respond(sourceCdp, 'src-create');
    sourceCdp.emit('Network.loadingFinished', { requestId: 'src-create' });
    // popup 后台同 path /api/create → 不偷继承 creates，不归属 action.requests
    request(popupCdp, 'pop-create', 'https://example.test/api/create');
    respond(popupCdp, 'pop-create');
    popupCdp.emit('Network.loadingFinished', { requestId: 'pop-create' });
    trace.finishAction(action, true);
    await trace.flush();
    const reqs = readEvents('r1bg').filter((e) => e.t === 'request');
    const srcReq = reqs.find((r) => r.target_id === 'src')!;
    const popReq = reqs.find((r) => r.target_id === 'pop')!;
    expect(srcReq.creates).toBe('item');
    expect(srcReq.triggered_by).toBe(action.id);
    expect(popReq.creates).toBeUndefined();
    expect(popReq.triggered_by).toBeNull();
    // action.requests 只含 source 的，不含 popup 后台请求
    expect(action.requests).toHaveLength(1);
    expect(action.requests).toContain(srcReq.id);
  });

  it('per-target pendingNavigation：A/B 未提交导航不互相覆盖', async () => {
    const aCdp = new FakeCdp();
    aCdp.frame = { id: 'ma', url: 'https://example.test/a0' };
    const bCdp = new FakeCdp();
    const trace = new NetworkTrace('r1nav', aCdp as any, 'src');
    trace.install();
    await trace.initialize('src');
    await trace.enable();
    trace.addTarget('b', bCdp as any, 'mb', 'https://example.test/b0');
    await bCdp.send('Network.enable').catch(() => {});
    // A 主文档请求（pending A），未 finish
    docRequest(aCdp, 'doc-a', 'https://example.test/a1', 'ma');
    // B 主文档请求（pending B），未 finish
    docRequest(bCdp, 'doc-b', 'https://example.test/b1', 'mb');
    // A frameNavigated → 提交 A 的 nav（不影响 B 的 pending）
    aCdp.emit('Page.frameNavigated', { frame: { id: 'ma', url: 'https://example.test/a1' } });
    respond(aCdp, 'doc-a');
    aCdp.emit('Network.loadingFinished', { requestId: 'doc-a' });
    // B frameNavigated → 提交 B 的 nav（A 已提交，B 仍 pending 不丢）
    bCdp.emit('Page.frameNavigated', { frame: { id: 'mb', url: 'https://example.test/b1' } });
    respond(bCdp, 'doc-b');
    bCdp.emit('Network.loadingFinished', { requestId: 'doc-b' });
    await trace.flush();
    const navs = readEvents('r1nav').filter((e) => e.t === 'navigation');
    // A、B 各自一条 nav，不互相覆盖
    expect(navs).toHaveLength(2);
    const aNav = navs.find((n) => n.target_id === 'src')!;
    const bNav = navs.find((n) => n.target_id === 'b')!;
    expect(aNav.to).toBe('https://example.test/a1');
    expect(bNav.to).toBe('https://example.test/b1');
  });

  it('导航种类：非 source 首次主文档 new_tab，SPA spa_route，后续 doc same_page', async () => {
    const sourceCdp = new FakeCdp();
    const popupCdp = new FakeCdp();
    const trace = new NetworkTrace('r1kind', sourceCdp as any, 'src');
    sourceCdp.frame = { id: 'ms', url: 'https://example.test/source' };
    trace.install();
    await trace.initialize('src');
    await trace.enable();
    trace.addTarget('pop', popupCdp as any, 'mp', 'https://example.test/popup');
    await popupCdp.send('Network.enable').catch(() => {});
    // popup 首次主文档 → new_tab
    docRequest(popupCdp, 'doc1', 'https://example.test/popup', 'mp');
    popupCdp.emit('Page.frameNavigated', { frame: { id: 'mp', url: 'https://example.test/popup' } });
    respond(popupCdp, 'doc1');
    popupCdp.emit('Network.loadingFinished', { requestId: 'doc1' });
    // popup SPA 路由 → spa_route（不误 new_tab）
    popupCdp.emit('Page.navigatedWithinDocument', { frameId: 'mp', url: 'https://example.test/popup#tab' });
    // popup 第二次主文档（reload/back）→ same_page（不 new_tab）
    docRequest(popupCdp, 'doc2', 'https://example.test/popup', 'mp');
    popupCdp.emit('Page.frameNavigated', { frame: { id: 'mp', url: 'https://example.test/popup' } });
    respond(popupCdp, 'doc2');
    popupCdp.emit('Network.loadingFinished', { requestId: 'doc2' });
    await trace.flush();
    const navs = readEvents('r1kind').filter((e) => e.t === 'navigation' && e.target_id === 'pop');
    expect(navs).toHaveLength(3);
    expect(navs[0].kind).toBe('new_tab');
    expect(navs[1].kind).toBe('spa_route');
    expect(navs[2].kind).toBe('same_page');
  });
});

describe('NetworkTrace R2 修复', () => {
  let home: string;
  let previousHome: string | undefined;
  beforeEach(() => {
    previousHome = process.env.E2ET_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-r2-'));
    process.env.E2ET_HOME = home;
  });
  afterEach(() => {
    if (previousHome === undefined) delete process.env.E2ET_HOME;
    else process.env.E2ET_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('removeTarget 清本 target pendingNavigations：不误提交到其他 target', async () => {
    const sourceCdp = new FakeCdp();
    const popupCdp = new FakeCdp();
    const trace = new NetworkTrace('r2rm', sourceCdp as any, 'src');
    sourceCdp.frame = { id: 'ms', url: 'https://example.test/source' };
    trace.install();
    await trace.initialize('src');
    await trace.enable();
    trace.addTarget('pop', popupCdp as any, 'mp', 'https://example.test/popup');
    await popupCdp.send('Network.enable').catch(() => {});
    // popup 主文档请求（pending popup），未 finish
    docRequest(popupCdp, 'doc-p', 'https://example.test/popup', 'mp');
    // 移除 popup target（pending popup 未提交）→ 清 popup 的 pendingNavigation
    trace.removeTarget('pop');
    // source 后续主文档导航正常提交，不误把 popup 的 pending 提交到 source
    docRequest(sourceCdp, 'doc-s', 'https://example.test/source2', 'ms');
    sourceCdp.emit('Page.frameNavigated', { frame: { id: 'ms', url: 'https://example.test/source2' } });
    respond(sourceCdp, 'doc-s');
    sourceCdp.emit('Network.loadingFinished', { requestId: 'doc-s' });
    await trace.flush();
    const navs = readEvents('r2rm').filter((e) => e.t === 'navigation');
    // 只有 source 的导航，没有 popup 的（pending 已随 removeTarget 清掉）
    expect(navs.every((n) => n.target_id === 'src')).toBe(true);
    expect(navs.some((n) => n.target_id === 'pop')).toBe(false);
  });
});

describe('NetworkTrace urlFragment 保留', () => {
  let home: string;
  let previousHome: string | undefined;
  beforeEach(() => {
    previousHome = process.env.E2ET_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-frag-'));
    process.env.E2ET_HOME = home;
  });
  afterEach(() => {
    if (previousHome === undefined) delete process.env.E2ET_HOME;
    else process.env.E2ET_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('source initialize 保留 base+fragment 完整 URL；无 fragment 字节级不变', async () => {
    const cdp = new FakeCdp();
    cdp.frame = { id: 'main', url: 'https://portalpro.test/pages/productLicense.html', urlFragment: '#/new' };
    const trace = new NetworkTrace('frag-src', cdp as any);
    trace.install();
    await trace.initialize('__source__');
    expect(trace.getTargetUrl('__source__')).toBe('https://portalpro.test/pages/productLicense.html#/new');
    const cdp2 = new FakeCdp();
    cdp2.frame = { id: 'main', url: 'https://portalpro.test/pages/productLicense.html' };
    const trace2 = new NetworkTrace('frag-src-ctrl', cdp2 as any);
    trace2.install();
    await trace2.initialize('__source__');
    expect(trace2.getTargetUrl('__source__')).toBe('https://portalpro.test/pages/productLicense.html');
  });

  it('popup initialize 用独立 base+fragment 完整 URL，不污染 source', async () => {
    const sourceCdp = new FakeCdp();
    const popupCdp = new FakeCdp();
    sourceCdp.frame = { id: 'ms', url: 'https://example.test/source' };
    popupCdp.frame = { id: 'mp', url: 'https://example.test/license/page', urlFragment: '#/edit' };
    const trace = new NetworkTrace('frag-pop', sourceCdp as any, 'src');
    trace.install();
    await trace.initialize('src');
    await trace.enable();
    trace.addTarget('pop', popupCdp as any, 'mp', 'about:blank');
    await trace.initialize('pop');
    expect(trace.getTargetUrl('pop')).toBe('https://example.test/license/page#/edit');
    expect(trace.getTargetUrl('src')).toBe('https://example.test/source');
  });

  it('frameNavigated 无 pending 文档导航：写入 base+fragment 完整 URL', async () => {
    const cdp = new FakeCdp();
    cdp.frame = { id: 'main', url: 'https://example.test/start' };
    const trace = new NetworkTrace('frag-nav', cdp as any);
    trace.install();
    await trace.initialize('__source__');
    cdp.emit('Page.frameNavigated', { frame: { id: 'main', url: 'https://example.test/page', urlFragment: '#/new' } });
    expect(trace.getTargetUrl('__source__')).toBe('https://example.test/page#/new');
  });

  it('frameNavigated 有 pending 文档导航：navigation.to 用 base+fragment 完整 URL', async () => {
    const cdp = new FakeCdp();
    cdp.frame = { id: 'main', url: 'https://example.test/start' };
    const trace = new NetworkTrace('frag-pnav', cdp as any);
    trace.install();
    await trace.initialize('__source__');
    docRequest(cdp, 'doc', 'https://example.test/page', 'main');
    cdp.emit('Page.frameNavigated', { frame: { id: 'main', url: 'https://example.test/page', urlFragment: '#/new' } });
    respond(cdp, 'doc');
    finish(cdp, 'doc');
    await trace.flush();
    const navs = readEvents('frag-pnav').filter((e) => e.t === 'navigation');
    expect(navs).toHaveLength(1);
    expect(navs[0].to).toBe('https://example.test/page#/new');
    expect(trace.getTargetUrl('__source__')).toBe('https://example.test/page#/new');
  });

  it('子 frame 与其他 target 的 frameNavigated 不能污染主 frame URL', async () => {
    const sourceCdp = new FakeCdp();
    const popupCdp = new FakeCdp();
    sourceCdp.frame = { id: 'ms', url: 'https://example.test/source' };
    const trace = new NetworkTrace('frag-iso', sourceCdp as any, 'src');
    trace.install();
    await trace.initialize('src');
    await trace.enable();
    trace.addTarget('pop', popupCdp as any, 'mp', 'https://example.test/popup');
    sourceCdp.emit('Page.frameNavigated', { frame: { id: 'sub', url: 'https://example.test/source/sub', urlFragment: '#x', parentId: 'ms' } });
    expect(trace.getTargetUrl('src')).toBe('https://example.test/source');
    popupCdp.emit('Page.frameNavigated', { frame: { id: 'mp', url: 'https://example.test/popup', urlFragment: '#tab' } });
    expect(trace.getTargetUrl('src')).toBe('https://example.test/source');
    expect(trace.getTargetUrl('pop')).toBe('https://example.test/popup#tab');
  });
});

describe('NetworkTrace waitForExplicit（绝对 deadline / nth / 失败）', () => {
  let home: string;
  let previousHome: string | undefined;
  beforeEach(() => {
    previousHome = process.env.E2ET_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-wfe-'));
    process.env.E2ET_HOME = home;
  });
  afterEach(() => {
    if (previousHome === undefined) delete process.env.E2ET_HOME;
    else process.env.E2ET_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  async function bootTrace(id: string) {
    const { NetworkTrace, WaitApiFailure } = await import('../daemon/network-trace.js');
    const cdp = new FakeCdp();
    const trace = new NetworkTrace(id, cdp as any);
    trace.install();
    await trace.initialize('__source__');
    await trace.enable();
    return { cdp, trace, WaitApiFailure };
  }

  const deps = { queryTarget: async () => { throw new Error('no'); }, readText: async () => '', readUrl: async () => '' };

  it('headers-alone 不释放：仅有 responseReceived 无 loadingFinished → 超时不放行', async () => {
    const { cdp, trace } = await bootTrace('wfe-headers');
    const action = trace.beginAction('click', '点', { target: '[0]' })!;
    request(cdp, 'xhr-1', 'https://example.test/api/save');
    respond(cdp, 'xhr-1'); // 仅 headers，未 loadingFinished
    const deadline = Date.now() + 200;
    const out = await trace.waitForExplicit(action, { apis: [{ path: '/api/save' }] }, deps as any, deadline);
    expect(out.some((s) => s.kind === 'timeout')).toBe(true);
    trace.finishAction(action, false, { settled_by: out });
    await trace.flush();
  }, 5000);

  it('nth=2：1st loadingFailed + 2nd finished → 选 2nd 成功（前序失败不替换）', async () => {
    const { cdp, trace } = await bootTrace('wfe-nth2');
    const action = trace.beginAction('click', '点', { target: '[0]' })!;
    request(cdp, 'a', 'https://example.test/api/save');
    request(cdp, 'b', 'https://example.test/api/save');
    cdp.emit('Network.loadingFailed', { requestId: 'a', errorText: 'net::ERR' });
    finish(cdp, 'b'); // 2nd finished
    const out = await trace.waitForExplicit(action, { apis: [{ path: '/api/save', nth: 2 }] }, deps as any, Date.now() + 2000);
    expect(out.some((s) => s.kind === 'request')).toBe(true);
    expect(out.some((s) => s.kind === 'timeout')).toBe(false);
    trace.finishAction(action, true, { settled_by: out });
    await trace.flush();
  }, 5000);

  it('nth=1 选中即失败 → reject WaitApiFailure（不被吞成 timeout）', async () => {
    const { cdp, trace, WaitApiFailure } = await bootTrace('wfe-fail');
    const action = trace.beginAction('click', '点', { target: '[0]' })!;
    request(cdp, 'a', 'https://example.test/api/save');
    cdp.emit('Network.loadingFailed', { requestId: 'a', errorText: 'net::ERR_ABORTED' });
    await expect(trace.waitForExplicit(action, { apis: [{ path: '/api/save' }] }, deps as any, Date.now() + 2000)).rejects.toBeInstanceOf(WaitApiFailure);
    trace.finishAction(action, false, { settled_by: [] });
    await trace.flush();
  }, 5000);
});

describe('NetworkTrace R1 修复', () => {
  let home: string;
  let previousHome: string | undefined;
  beforeEach(() => {
    previousHome = process.env.E2ET_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-r1-'));
    process.env.E2ET_HOME = home;
  });
  afterEach(() => {
    if (previousHome === undefined) delete process.env.E2ET_HOME;
    else process.env.E2ET_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });


  it('隐式 path resolveReqRef 只查 active target/currentNav，不跨页 fallback', async () => {
    const sourceCdp = new FakeCdp();
    const popupCdp = new FakeCdp();
    const trace = new NetworkTrace('r1ref', sourceCdp as any, 'src');
    sourceCdp.frame = { id: 'ms', url: 'https://example.test/source' };
    trace.install();
    await trace.initialize('src');
    await trace.enable();
    trace.addTarget('pop', popupCdp as any, 'mp', 'https://example.test/popup');
    await popupCdp.send('Network.enable').catch(() => {});
    // 两个 target 都有 /api/list 请求（不同 nav）
    for (const [cdp, tid] of [[sourceCdp, 'src'], [popupCdp, 'pop']] as any) {
      request(cdp, 'r-' + tid, 'https://example.test/api/list');
      respond(cdp, 'r-' + tid);
      cdp.emit('Network.loadingFinished', { requestId: 'r-' + tid });
    }
    await trace.flush();
    // active=src：隐式 /api/list 只匹配 src 的请求，不放开 popup
    expect(trace.resolveReqRef('/api/list')?.target_id).toBe('src');
    // 切到 popup：隐式 /api/list 只匹配 popup
    trace.setActiveTarget('pop');
    expect(trace.resolveReqRef('/api/list')?.target_id).toBe('pop');
    // 显式 nav 仍可查会话内历史（src 的 nav）
    const srcNav = readEvents('r1ref').filter((e) => e.t === 'request' && e.target_id === 'src')[0].nav;
    expect(trace.resolveReqRef('/api/list@' + srcNav)?.target_id).toBe('src');
  });

  it('后台请求（其他 target）不偷继承 activeAction creates/等待', async () => {
    const sourceCdp = new FakeCdp();
    const popupCdp = new FakeCdp();
    const trace = new NetworkTrace('r1bg', sourceCdp as any, 'src');
    sourceCdp.frame = { id: 'ms', url: 'https://example.test/source' };
    trace.install();
    await trace.initialize('src');
    await trace.enable();
    trace.addTarget('pop', popupCdp as any, 'mp', 'https://example.test/popup');
    await popupCdp.send('Network.enable').catch(() => {});
    // source active，beginAction(click, creates=/api/create)
    const action = trace.beginAction('click', '点 source 按钮', {}, { creates: { entity: 'item', path: '/api/create' } })!;
    expect(action.targetId).toBe('src');
    // source 的 /api/create → 带 creates=item，归属 action
    request(sourceCdp, 'src-create', 'https://example.test/api/create');
    respond(sourceCdp, 'src-create');
    sourceCdp.emit('Network.loadingFinished', { requestId: 'src-create' });
    // popup 后台同 path /api/create → 不偷继承 creates，不归属 action.requests
    request(popupCdp, 'pop-create', 'https://example.test/api/create');
    respond(popupCdp, 'pop-create');
    popupCdp.emit('Network.loadingFinished', { requestId: 'pop-create' });
    trace.finishAction(action, true);
    await trace.flush();
    const reqs = readEvents('r1bg').filter((e) => e.t === 'request');
    const srcReq = reqs.find((r) => r.target_id === 'src')!;
    const popReq = reqs.find((r) => r.target_id === 'pop')!;
    expect(srcReq.creates).toBe('item');
    expect(srcReq.triggered_by).toBe(action.id);
    expect(popReq.creates).toBeUndefined();
    expect(popReq.triggered_by).toBeNull();
    // action.requests 只含 source 的，不含 popup 后台请求
    expect(action.requests).toHaveLength(1);
    expect(action.requests).toContain(srcReq.id);
  });

  it('per-target pendingNavigation：A/B 未提交导航不互相覆盖', async () => {
    const aCdp = new FakeCdp();
    aCdp.frame = { id: 'ma', url: 'https://example.test/a0' };
    const bCdp = new FakeCdp();
    const trace = new NetworkTrace('r1nav', aCdp as any, 'src');
    trace.install();
    await trace.initialize('src');
    await trace.enable();
    trace.addTarget('b', bCdp as any, 'mb', 'https://example.test/b0');
    await bCdp.send('Network.enable').catch(() => {});
    // A 主文档请求（pending A），未 finish
    docRequest(aCdp, 'doc-a', 'https://example.test/a1', 'ma');
    // B 主文档请求（pending B），未 finish
    docRequest(bCdp, 'doc-b', 'https://example.test/b1', 'mb');
    // A frameNavigated → 提交 A 的 nav（不影响 B 的 pending）
    aCdp.emit('Page.frameNavigated', { frame: { id: 'ma', url: 'https://example.test/a1' } });
    respond(aCdp, 'doc-a');
    aCdp.emit('Network.loadingFinished', { requestId: 'doc-a' });
    // B frameNavigated → 提交 B 的 nav（A 已提交，B 仍 pending 不丢）
    bCdp.emit('Page.frameNavigated', { frame: { id: 'mb', url: 'https://example.test/b1' } });
    respond(bCdp, 'doc-b');
    bCdp.emit('Network.loadingFinished', { requestId: 'doc-b' });
    await trace.flush();
    const navs = readEvents('r1nav').filter((e) => e.t === 'navigation');
    // A、B 各自一条 nav，不互相覆盖
    expect(navs).toHaveLength(2);
    const aNav = navs.find((n) => n.target_id === 'src')!;
    const bNav = navs.find((n) => n.target_id === 'b')!;
    expect(aNav.to).toBe('https://example.test/a1');
    expect(bNav.to).toBe('https://example.test/b1');
  });

  it('导航种类：非 source 首次主文档 new_tab，SPA spa_route，后续 doc same_page', async () => {
    const sourceCdp = new FakeCdp();
    const popupCdp = new FakeCdp();
    const trace = new NetworkTrace('r1kind', sourceCdp as any, 'src');
    sourceCdp.frame = { id: 'ms', url: 'https://example.test/source' };
    trace.install();
    await trace.initialize('src');
    await trace.enable();
    trace.addTarget('pop', popupCdp as any, 'mp', 'https://example.test/popup');
    await popupCdp.send('Network.enable').catch(() => {});
    // popup 首次主文档 → new_tab
    docRequest(popupCdp, 'doc1', 'https://example.test/popup', 'mp');
    popupCdp.emit('Page.frameNavigated', { frame: { id: 'mp', url: 'https://example.test/popup' } });
    respond(popupCdp, 'doc1');
    popupCdp.emit('Network.loadingFinished', { requestId: 'doc1' });
    // popup SPA 路由 → spa_route（不误 new_tab）
    popupCdp.emit('Page.navigatedWithinDocument', { frameId: 'mp', url: 'https://example.test/popup#tab' });
    // popup 第二次主文档（reload/back）→ same_page（不 new_tab）
    docRequest(popupCdp, 'doc2', 'https://example.test/popup', 'mp');
    popupCdp.emit('Page.frameNavigated', { frame: { id: 'mp', url: 'https://example.test/popup' } });
    respond(popupCdp, 'doc2');
    popupCdp.emit('Network.loadingFinished', { requestId: 'doc2' });
    await trace.flush();
    const navs = readEvents('r1kind').filter((e) => e.t === 'navigation' && e.target_id === 'pop');
    expect(navs).toHaveLength(3);
    expect(navs[0].kind).toBe('new_tab');
    expect(navs[1].kind).toBe('spa_route');
    expect(navs[2].kind).toBe('same_page');
  });
});

describe('NetworkTrace R2 修复', () => {
  let home: string;
  let previousHome: string | undefined;
  beforeEach(() => {
    previousHome = process.env.E2ET_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-r2-'));
    process.env.E2ET_HOME = home;
  });
  afterEach(() => {
    if (previousHome === undefined) delete process.env.E2ET_HOME;
    else process.env.E2ET_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('removeTarget 清本 target pendingNavigations：不误提交到其他 target', async () => {
    const sourceCdp = new FakeCdp();
    const popupCdp = new FakeCdp();
    const trace = new NetworkTrace('r2rm', sourceCdp as any, 'src');
    sourceCdp.frame = { id: 'ms', url: 'https://example.test/source' };
    trace.install();
    await trace.initialize('src');
    await trace.enable();
    trace.addTarget('pop', popupCdp as any, 'mp', 'https://example.test/popup');
    await popupCdp.send('Network.enable').catch(() => {});
    // popup 主文档请求（pending popup），未 finish
    docRequest(popupCdp, 'doc-p', 'https://example.test/popup', 'mp');
    // 移除 popup target（pending popup 未提交）→ 清 popup 的 pendingNavigation
    trace.removeTarget('pop');
    // source 后续主文档导航正常提交，不误把 popup 的 pending 提交到 source
    docRequest(sourceCdp, 'doc-s', 'https://example.test/source2', 'ms');
    sourceCdp.emit('Page.frameNavigated', { frame: { id: 'ms', url: 'https://example.test/source2' } });
    respond(sourceCdp, 'doc-s');
    sourceCdp.emit('Network.loadingFinished', { requestId: 'doc-s' });
    await trace.flush();
    const navs = readEvents('r2rm').filter((e) => e.t === 'navigation');
    // 只有 source 的导航，没有 popup 的（pending 已随 removeTarget 清掉）
    expect(navs.every((n) => n.target_id === 'src')).toBe(true);
    expect(navs.some((n) => n.target_id === 'pop')).toBe(false);
  });
});

describe('NetworkTrace urlFragment 保留', () => {
  let home: string;
  let previousHome: string | undefined;
  beforeEach(() => {
    previousHome = process.env.E2ET_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-frag-'));
    process.env.E2ET_HOME = home;
  });
  afterEach(() => {
    if (previousHome === undefined) delete process.env.E2ET_HOME;
    else process.env.E2ET_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('source initialize 保留 base+fragment 完整 URL；无 fragment 字节级不变', async () => {
    const cdp = new FakeCdp();
    cdp.frame = { id: 'main', url: 'https://portalpro.test/pages/productLicense.html', urlFragment: '#/new' };
    const trace = new NetworkTrace('frag-src', cdp as any);
    trace.install();
    await trace.initialize('__source__');
    expect(trace.getTargetUrl('__source__')).toBe('https://portalpro.test/pages/productLicense.html#/new');
    const cdp2 = new FakeCdp();
    cdp2.frame = { id: 'main', url: 'https://portalpro.test/pages/productLicense.html' };
    const trace2 = new NetworkTrace('frag-src-ctrl', cdp2 as any);
    trace2.install();
    await trace2.initialize('__source__');
    expect(trace2.getTargetUrl('__source__')).toBe('https://portalpro.test/pages/productLicense.html');
  });

  it('popup initialize 用独立 base+fragment 完整 URL，不污染 source', async () => {
    const sourceCdp = new FakeCdp();
    const popupCdp = new FakeCdp();
    sourceCdp.frame = { id: 'ms', url: 'https://example.test/source' };
    popupCdp.frame = { id: 'mp', url: 'https://example.test/license/page', urlFragment: '#/edit' };
    const trace = new NetworkTrace('frag-pop', sourceCdp as any, 'src');
    trace.install();
    await trace.initialize('src');
    await trace.enable();
    trace.addTarget('pop', popupCdp as any, 'mp', 'about:blank');
    await trace.initialize('pop');
    expect(trace.getTargetUrl('pop')).toBe('https://example.test/license/page#/edit');
    expect(trace.getTargetUrl('src')).toBe('https://example.test/source');
  });

  it('frameNavigated 无 pending 文档导航：写入 base+fragment 完整 URL', async () => {
    const cdp = new FakeCdp();
    cdp.frame = { id: 'main', url: 'https://example.test/start' };
    const trace = new NetworkTrace('frag-nav', cdp as any);
    trace.install();
    await trace.initialize('__source__');
    cdp.emit('Page.frameNavigated', { frame: { id: 'main', url: 'https://example.test/page', urlFragment: '#/new' } });
    expect(trace.getTargetUrl('__source__')).toBe('https://example.test/page#/new');
  });

  it('frameNavigated 有 pending 文档导航：navigation.to 用 base+fragment 完整 URL', async () => {
    const cdp = new FakeCdp();
    cdp.frame = { id: 'main', url: 'https://example.test/start' };
    const trace = new NetworkTrace('frag-pnav', cdp as any);
    trace.install();
    await trace.initialize('__source__');
    docRequest(cdp, 'doc', 'https://example.test/page', 'main');
    cdp.emit('Page.frameNavigated', { frame: { id: 'main', url: 'https://example.test/page', urlFragment: '#/new' } });
    respond(cdp, 'doc');
    finish(cdp, 'doc');
    await trace.flush();
    const navs = readEvents('frag-pnav').filter((e) => e.t === 'navigation');
    expect(navs).toHaveLength(1);
    expect(navs[0].to).toBe('https://example.test/page#/new');
    expect(trace.getTargetUrl('__source__')).toBe('https://example.test/page#/new');
  });

  it('子 frame 与其他 target 的 frameNavigated 不能污染主 frame URL', async () => {
    const sourceCdp = new FakeCdp();
    const popupCdp = new FakeCdp();
    sourceCdp.frame = { id: 'ms', url: 'https://example.test/source' };
    const trace = new NetworkTrace('frag-iso', sourceCdp as any, 'src');
    trace.install();
    await trace.initialize('src');
    await trace.enable();
    trace.addTarget('pop', popupCdp as any, 'mp', 'https://example.test/popup');
    sourceCdp.emit('Page.frameNavigated', { frame: { id: 'sub', url: 'https://example.test/source/sub', urlFragment: '#x', parentId: 'ms' } });
    expect(trace.getTargetUrl('src')).toBe('https://example.test/source');
    popupCdp.emit('Page.frameNavigated', { frame: { id: 'mp', url: 'https://example.test/popup', urlFragment: '#tab' } });
    expect(trace.getTargetUrl('src')).toBe('https://example.test/source');
    expect(trace.getTargetUrl('pop')).toBe('https://example.test/popup#tab');
  });
});

describe('NetworkTrace loadingFailed 诊断日志（42304 A2）', () => {
  let home: string;
  let previousHome: string | undefined;
  beforeEach(() => {
    previousHome = process.env.E2ET_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-diag-'));
    process.env.E2ET_HOME = home;
  });
  afterEach(() => {
    if (previousHome === undefined) delete process.env.E2ET_HOME;
    else process.env.E2ET_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('诊断字段可取、不泄露 URL/query，真实失败仍落 summary.failed/trace failed', async () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: any) => { writes.push(String(chunk)); return true; }) as any);
    const cdp = new FakeCdp();
    const trace = new NetworkTrace('diag-fail', cdp as any);
    trace.install();
    await trace.initialize('__source__');
    await trace.enable();
    try {
      request(cdp, 'cors-1', 'https://example.test/api/save?token=query-secret');
      cdp.emit('Network.loadingFailed', {
        requestId: 'cors-1', type: 'Fetch', errorText: 'net::ERR_FAILED',
        blockedReason: 'cors',
        corsErrorStatus: { corsError: 'NoCorsAllowed2', failedParameter: 'response:header:access-control-allow-origin' },
      });
      await trace.flush();
      const line = (writes.join('').split('\n')).find((l) => l.includes('loadingFailed')) ?? '';
      expect(line).toContain('targetId=__source__');
      expect(line).toContain('requestId=cors-1');
      expect(line).toContain('type=Fetch');
      expect(line).toContain('errorText=net::ERR_FAILED');
      expect(line).toContain('blockedReason=cors');
      expect(line).toContain('corsError=NoCorsAllowed2');
      expect(line).toContain('failedParameter=response:header:access-control-allow-origin');
      // 诊断不泄露 URL/query（trace 文件是本地证据，不受此限）
      expect(writes.join('')).not.toContain('query-secret');
      expect(writes.join('')).not.toContain('https://example.test/api/save');
      // 真实失败语义保留：loadingFailed 仍写 failed，不因诊断改动变成功
      const events = readEvents('diag-fail').filter((e) => e.t === 'request');
      expect(events).toHaveLength(1);
      expect(events[0].failed).toBe('net::ERR_FAILED');
      expect(events[0].resp_body_ref).toBeUndefined();
      expect(trace.resolveReqRef('/api/save')?.failed).toBe('net::ERR_FAILED');
    } finally {
      spy.mockRestore();
    }
  });
});
