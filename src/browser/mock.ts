/**
 * 阶段 2.4 mock 命令的 browser 层实现。
 *
 * CDP Fetch.enable + Fetch.requestPaused 拦截匹配请求,返回伪造响应。
 * 规则按 path 匹配;--call-index 给定时再校验该请求的 call_index(spec 只给 path + call-index)。
 * 不支持 method 匹配(spec 没要求,加 method 是 speculative)。
 *
 * CORS 预检(42304 P0):OPTIONS + Origin + Access-Control-Request-Method 视为预检,
 * 按同套规则命中后回 200 空 body + 预检 CORS 头(回显原始 Origin,不用 wildcard),不消耗 call 计数;
 * 带 Origin 的业务 mock 响应补 Access-Control-Allow-Origin/-Credentials。
 *
 * session 级 mocked 标志:用过 mock 即不可落库,session stop 时 Fetch.disable + 清规则。
 */
import type { CdpSession } from './daemon-client.js';

interface MockRule {
  path: string;
  callIndex?: number;
  status: number;
  bodyBuffer: Buffer;
  contentType: string;
}

export class MockInterceptor {
  private rules = new Map<string, MockRule>();
  private enabled = false;
  private mocked = false;
  private offHandler: (() => void) | null = null;
  /** call_index 计数:nav+path → 当前已观察到的请求数(用于 --call-index 校验) */
  private callCounts = new Map<string, number>();
  /** 被拦截的请求 ID 集合，用于通知 NetworkTrace 不要标记为 failed */
  private interceptedRequests = new Set<string>();
  /** 通知 NetworkTrace 某个请求被 mock 拦截 */
  private onIntercept?: (requestId: string) => void;

  constructor(private readonly cdp: CdpSession, onIntercept?: (requestId: string) => void) {
    this.onIntercept = onIntercept;
  }

  /** 是否已注册过 mock(供 session_end.mocked) */
  hasMocked(): boolean { return this.mocked; }

  /** 注册拦截规则。bodyFile 已由 CLI 端读成 buffer 传入,daemon 不读任意路径。 */
  async add(rule: {
    path: string;
    callIndex?: number;
    status: number;
    bodyBuffer: Buffer;
    contentType?: string;
  }): Promise<void> {
    if (!this.enabled) {
      await this.cdp.send('Fetch.enable', {
        patterns: [{ requestStage: 'Request', urlPattern: '*' }],
      });
      this.enabled = true;
      this.offHandler = this.cdp.on('Fetch.requestPaused', (params: any) => {
        void this.handlePaused(params);
      });
    }
    const key = rule.path + (rule.callIndex !== undefined ? '#' + rule.callIndex : '');
    this.rules.set(key, {
      path: rule.path,
      callIndex: rule.callIndex,
      status: rule.status,
      bodyBuffer: rule.bodyBuffer,
      contentType: rule.contentType ?? 'application/json; charset=utf-8',
    });
    this.mocked = true;
  }

  /** 清除拦截规则:传 path 清该 path 全部规则(含 #n 变体);不传清全部。 */
  async clear(path?: string): Promise<void> {
    if (path === undefined) {
      this.rules.clear();
    } else {
      for (const key of [...this.rules.keys()]) {
        if (this.rules.get(key)?.path === path) this.rules.delete(key);
      }
    }
    // 无规则且已 enabled 时关 Fetch(减少对页面的拦截开销)
    if (this.rules.size === 0 && this.enabled) {
      await this.disable();
    }
  }

  /** session stop / clear-all 调用:关闭 Fetch domain + 清规则。 */
  async disable(): Promise<void> {
    if (this.offHandler) { this.offHandler(); this.offHandler = null; }
    if (this.enabled) {
      this.enabled = false;
      await this.cdp.send('Fetch.disable').catch(() => {});
    }
    if (this.rules.size > 0) this.rules.clear();
  }

  private async handlePaused(params: any): Promise<void> {
    const cdpId = String(params?.requestId ?? '');
    const url = String(params?.request?.url ?? '');
    const path = this.urlPath(url);
    const method = String(params?.request?.method ?? '');
    const networkId = params?.networkId !== undefined && params?.networkId !== null ? String(params.networkId) : '';
    // header 名就地规范化为小写(HTTP/2 全小写,HTTP/1.1 大小写不定),值保持 CDP 原值
    const headers = Object.fromEntries(
      Object.entries(params?.request?.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
    ) as Record<string, unknown>;
    // CORS 判定三件套;Origin 保留浏览器原始值(含合法 null)用于响应头回显,日志只用下面的规范化 origin
    const rawOrigin = String(headers['origin'] ?? '');
    const requestMethodHeader = String(headers['access-control-request-method'] ?? '');
    const requestHeadersHeader = String(headers['access-control-request-headers'] ?? '');
    // Origin 的 origin 部分(scheme://host[:port]);解析失败记空串,不输出其他请求头
    let origin = '';
    if (rawOrigin) { try { origin = new URL(rawOrigin).origin; } catch { origin = ''; } }
    // 诊断只写 stderr:不输出完整 URL/query、任意请求头、body、cookie、token、stack
    process.stderr.write(`[mock] handlePaused START: cdpId=${cdpId} networkId=${networkId} method=${method} path=${path} origin=${origin}\n`);
    // CORS 预检:OPTIONS + Origin + Access-Control-Request-Method;预检无业务语义
    const isPreflight = method === 'OPTIONS' && rawOrigin !== '' && requestMethodHeader !== '';
    // 计算 call_index:同 path 累计(不绑 nav,nav 在 NetworkTrace 维护,这里简单按 path 计数够用)
    // 预检只查看下一次业务请求的计数,不写入;非预检保持原计数行为
    const counter = (this.callCounts.get(path) ?? 0) + 1;
    if (!isPreflight) this.callCounts.set(path, counter);
    // 找匹配规则:path 精确;callIndex 给定时校验
    let rule: MockRule | undefined;
    const explicitKey = path + '#' + counter;
    rule = this.rules.get(explicitKey);
    if (!rule) rule = this.rules.get(path); // 无 #n 的通用规则
    if (!rule || (rule.callIndex !== undefined && rule.callIndex !== counter)) {
      // 不拦截,放行
      process.stderr.write(`[mock] No rule match, continue: cdpId=${cdpId} path=${path}\n`);
      await this.cdp.send('Fetch.continueRequest', { requestId: cdpId }).catch(() => {});
      return;
    }
    // 预检固定 200 空 body + 预检 CORS 头,不用业务规则的错误状态或 JSON body;业务响应保持 rule.status/body/Content-Type
    const status = isPreflight ? 200 : rule.status;
    const responseHeaders: Array<{ name: string; value: string }> = isPreflight
      ? []
      : [{ name: 'Content-Type', value: rule.contentType }];
    // 带 Origin 的两种 mock 响应都回显浏览器原始 Origin 并允许 credentials,不用 wildcard
    if (rawOrigin) {
      responseHeaders.push({ name: 'Access-Control-Allow-Origin', value: rawOrigin });
      responseHeaders.push({ name: 'Access-Control-Allow-Credentials', value: 'true' });
      if (isPreflight) {
        responseHeaders.push({ name: 'Access-Control-Allow-Methods', value: requestMethodHeader });
        if (requestHeadersHeader) {
          responseHeaders.push({ name: 'Access-Control-Allow-Headers', value: requestHeadersHeader });
        }
      }
    }
    const body = isPreflight ? '' : rule.bodyBuffer.toString('base64');
    // fulfill 开始阶段(诊断 status 与实际 responseCode 一致)
    process.stderr.write(`[mock] fulfill START: cdpId=${cdpId} networkId=${networkId} method=${method} path=${path} origin=${origin} status=${status}\n`);
    try {
      await this.cdp.send('Fetch.fulfillRequest', {
        requestId: cdpId,
        responseCode: status,
        responseHeaders,
        responsePhrase: status === 200 ? 'OK' : 'Error',
        body,
      });
      // fulfill ack 阶段
      process.stderr.write(`[mock] fulfill ACK: cdpId=${cdpId} networkId=${networkId} path=${path} status=${status}\n`);
      // 通知 NetworkTrace 这个请求被 mock 拦截了
      this.interceptedRequests.add(cdpId);
      if (this.onIntercept) this.onIntercept(cdpId);
    } catch (e) {
      // fulfill 失败阶段:只记 error message,不记 stack
      process.stderr.write(`[mock] fulfill FAILED: cdpId=${cdpId} networkId=${networkId} path=${path} status=${status} error=${e instanceof Error ? e.message : String(e)}\n`);
    }
  }

  private urlPath(url: string): string {
    try { return new URL(url).pathname; } catch { return url.split('?', 1)[0]; }
  }
}
