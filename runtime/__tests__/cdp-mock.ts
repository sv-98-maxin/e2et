/**
 * 最小 CDP session/page mock helper（真实协议形状）：
 * 多个既有 test factory 模拟同一 CDPSession 时复用，仅 emit 协议事件形状。
 * 生产代码不依赖本文件（不保留 PW 兼容 transport）。
 */
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

export interface CdpMock {
  cdp: any;
  /** 按协议方法名触发已注册监听（复制快照迭代，off 安全） */
  emit: (method: string, params: any) => void;
  /** 记录全部 send 调用（attach 顺序断言用） */
  sends: Array<{ method: string; params?: any }>;
  /** 可变 send 行为表：测试可在事后注入/改写（如延后的 getResponseBody） */
  handlers: Record<string, (params: any) => any>;
}

/** handlers 配置 send 行为（如 Network.getResponseBody / getRequestPostData）；
 *  默认 Page.getFrameTree 返回非空主帧，其余返回空对象。 */
export function createCdpMock(handlers: Record<string, (params: any) => any> = {}): CdpMock {
  const listeners: Record<string, Array<(p: any) => void>> = {};
  const sends: Array<{ method: string; params?: any }> = [];
  const cdp: any = {
    on: (ev: string, fn: (p: any) => void) => { (listeners[ev] ??= []).push(fn); },
    off: (ev: string, fn: (p: any) => void) => { const arr = listeners[ev]; if (arr) listeners[ev] = arr.filter((h) => h !== fn); },
    send: async (method: string, params?: any) => {
      sends.push({ method, params });
      if (handlers[method]) return handlers[method](params);
      if (method === 'Page.getFrameTree') {
        return { frameTree: { frame: { id: 'main-frame-1', url: 'https://x.com/', loaderId: 'loader-1' } } };
      }
      return {};
    },
    detach: async () => {},
  };
  const emit = (method: string, params: any) => {
    for (const h of [...(listeners[method] ?? [])]) h(params);
  };
  return { cdp, emit, sends, handlers };
}

/** mock page：真实 on/off/isClosed + context().newCDPSession(page) → cdp。 */
export function makeCdpPage(
  handlers: Record<string, (params: any) => any> = {},
  pageProps: Record<string, unknown> = {},
): { page: any; emit: (method: string, params: any) => void; pageEmit: (ev: string, arg: any) => void; cdp: any; sends: Array<{ method: string; params?: any }>; handlers: Record<string, (params: any) => any>; pageListeners: Record<string, Array<(arg: any) => void>>; endpoint: () => Promise<string> } {
  const { cdp, emit, sends } = createCdpMock(handlers);
  const pageListeners: Record<string, Array<(arg: any) => void>> = {};
  const page: any = {
    on: (ev: string, fn: (arg: any) => void) => { (pageListeners[ev] ??= []).push(fn); },
    off: (ev: string, fn: (arg: any) => void) => { const arr = pageListeners[ev]; if (arr) pageListeners[ev] = arr.filter((h) => h !== fn); },
    isClosed: () => false,
    context: () => context,
    ...pageProps,
  };
  /** 触发 page 级事件（如 close） */
  const pageEmit = (ev: string, arg: any) => {
    if (ev === 'close') rootEmit('Target.detachedFromTarget', { sessionId: 'child-0' });
    for (const h of [...(pageListeners[ev] ?? [])]) h(arg);
  };
  page.__cdpMock = { cdp, emit, sends, handlers };
  const context = makeCdpContext([page]);
  const rootEmit = context.__rootEmit;
  const emitChild = (method: string, params: any) => context.__emitChild('child-0', method, params);
  return { page, emit: emitChild, pageEmit, cdp, sends, handlers, pageListeners, endpoint: context.__nativeEndpoint };
}

export function makeCdpContext(pages: any[], context: any = {}, emitOnStart = true): any {
  const { cdp: root, emit: rootEmit, handlers: rootHandlers, sends: rootSends } = createCdpMock();
  const { WebSocketServer } = nodeRequire('ws') as { WebSocketServer: any };
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  (server as any).unref?.();
  (server as any)._server?.unref?.();
  let client: any;
  const endpoint = new Promise<string>((resolve, reject) => {
    server.once('listening', () => resolve(`ws://127.0.0.1:${server.address().port}/devtools/browser/mock`));
    server.once('error', reject);
  });
  const broadcast = (method: string, params: any) => {
    if (client?.readyState === 1) client.send(JSON.stringify({ method, params }));
  };
  const emitRoot = (method: string, params: any) => {
    rootEmit(method, params);
    broadcast(method, params);
  };
  const emitChild = (sessionId: string, method: string, params: any) => {
    if (client?.readyState === 1) client.send(JSON.stringify({ sessionId, method, params }));
  };
  const identity = { isClosed: () => false };
  const targetInfo = (index: number) => ({ targetId: `target-${index}`, browserContextId: 'context-1', type: 'page', ...(index ? { openerId: 'target-0' } : {}) });
  let armed = false;
  const attach = (index: number) => emitRoot('Target.attachedToTarget', { sessionId: `child-${index}`, waitingForDebugger: true, targetInfo: targetInfo(index) });
  rootHandlers['Target.getTargets'] = () => ({ targetInfos: [] });
  rootHandlers['Target.setAutoAttach'] = (params) => {
    armed = params.autoAttach;
    if (armed && emitOnStart) pages.forEach((_page, index) => attach(index));
    return {};
  };
  server.on('connection', (socket: any) => {
    client = socket;
    socket.on('message', (raw: Buffer) => {
      const command = JSON.parse(raw.toString()) as { id: number; method: string; params?: any; sessionId?: string };
      void Promise.resolve().then(async () => {
        try {
          const result = command.sessionId
            ? await pages[Number(command.sessionId.split('-')[1])].__cdpMock.cdp.send(command.method, command.params)
            : await rootHandlers[command.method]?.(command.params);
          if (socket.readyState === 1) {
            socket.send(JSON.stringify({
              id: command.id,
              result: result ?? {},
              ...(command.sessionId === undefined ? {} : { sessionId: command.sessionId }),
            }));
          }
        } catch (error) {
          if (socket.readyState === 1) {
            socket.send(JSON.stringify({
              id: command.id,
              error: { message: (error as Error).message },
              ...(command.sessionId === undefined ? {} : { sessionId: command.sessionId }),
            }));
          }
        }
      });
    });
  });
  const originalPages = context.pages?.bind(context) ?? (() => pages);
  const originalNewPage = context.newPage?.bind(context) ?? (async () => pages[0]);
  context.browser = () => ({ newBrowserCDPSession: async () => root });
  context.pages = () => armed ? originalPages() : [identity];
  context.newCDPSession = (page: any) => Promise.resolve(createCdpMock({
    'Target.getTargetInfo': () => ({ targetInfo: page === identity ? { browserContextId: 'context-1', targetId: 'identity', type: 'page' } : targetInfo(pages.indexOf(page)) }),
  }).cdp);
  context.newPage = async () => {
    const page = await originalNewPage();
    if (!emitOnStart) pages.forEach((_page, index) => attach(index));
    return page;
  };
  context.on ??= () => context;
  context.off ??= () => context;
  context.__rootEmit = emitRoot;
  context.__emitChild = emitChild;
  context.__rootHandlers = rootHandlers;
  context.__rootCdp = root;
  context.__rootCdp.sends = rootSends;
  context.__nativeEndpoint = () => endpoint;
  context.__closeNative = () => new Promise<void>((resolve) => server.close(() => resolve()));
  for (const page of pages) page.context = () => context;
  return context;
}
