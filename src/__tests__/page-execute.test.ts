import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';
import { DaemonClient } from '../daemon/client.js';
import { runDaemon } from '../daemon/daemon.js';
import { resolveSocketPath } from '../daemon/session-meta.js';
import { readTraceEvents } from '../daemon/trace.js';
import { dispatch } from '../cli/router.js';
import type { RouterDeps } from '../cli/context.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

class ExecuteCdp {
  calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  result: Record<string, unknown> = { type: 'object', value: { count: 3 } };
  exception?: { text: string; exception?: { description: string } };
  screenshotError?: string;
  evaluateGenerated = false;
  evaluationContext: Record<string, unknown> = {};
  private listeners = new Map<string, Array<(params: any) => void>>();
  on(method: string, handler: (params: any) => void): () => void {
    const list = this.listeners.get(method) ?? [];
    list.push(handler);
    this.listeners.set(method, list);
    return () => this.listeners.set(method, list.filter(item => item !== handler));
  }
  onClose(): void {}
  close(): void {}
  async send<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ method, params });
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main', loaderId: '', url: 'about:blank', securityOrigin: '' } } } as T;
    if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: '1' } as T;
    if (method === 'Runtime.evaluate') {
      if (!this.evaluateGenerated) return { result: this.result, exceptionDetails: this.exception } as T;
      try {
        let value = runInNewContext(String(params.expression), this.evaluationContext);
        if (params.awaitPromise) value = await value;
        return { result: { value, type: typeof value } } as T;
      } catch (error) {
        return { result: {}, exceptionDetails: { text: (error as Error).message } } as T;
      }
    }
    if (method === 'Page.captureScreenshot') {
      if (this.screenshotError) throw new Error(this.screenshotError);
      return { data: PNG } as T;
    }
    return {} as T;
  }
  async evaluate<T = any>(expression: string): Promise<T> {
    if (expression.includes('readyState')) return 'complete' as T;
    if (expression.includes('__e2etChangeCount')) return 0 as T;
    if (expression.includes('__e2etObserver')) return true as T;
    return '' as T;
  }
}

describe('page.execute 回归（daemon + fake CDP）', () => {
  let home: string;
  let previousHome: string | undefined;
  beforeEach(() => {
    previousHome = process.env.E2ET_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'page-execute-'));
    process.env.E2ET_HOME = home;
  });
  afterEach(() => {
    if (previousHome === undefined) delete process.env.E2ET_HOME;
    else process.env.E2ET_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  async function withDaemon(cdp: ExecuteCdp, check: (client: DaemonClient, id: string) => Promise<void>): Promise<void> {
    const id = 'execute-' + Math.random().toString(36).slice(2, 8);
    const socket = resolveSocketPath(id);
    const done = runDaemon(id, {
      env: 'pre', socketPath: socket, exitOnStop: false,
      browserBootstrap: async () => ({ tabId: 'tab', session: cdp as any, endpoint: 'http://127.0.0.1:0' }),
    });
    const deadline = Date.now() + 5000;
    while (!await DaemonClient.ping(socket, 200)) {
      if (Date.now() >= deadline) throw new Error('daemon 未就绪');
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    const client = await DaemonClient.connect(socket);
    try { await check(client, id); }
    finally {
      try { if (await DaemonClient.ping(socket, 200)) await client.request('stop', {}); }
      finally { client.close(); await done; }
    }
  }
  const action = (id: string): any => readTraceEvents(id).filter(e => e.t === 'action').at(-1);
  const execute = (client: DaemonClient, params = {}): Promise<any> => client.request('page.execute', {
    expression: 'readData()', intent: '读取页面数据', ...params,
  });

  it.each([
    ['object', { count: 3, nested: { name: '商品' } }],
    ['array', [false, 0, null, '']],
    ['false', false], ['zero', 0], ['null', null], ['empty', ''],
    ['string', '123'], ['business false', { ok: false }],
  ])('%s 原值保留，与 action.result={ok:true} 分离', async (_name, value) => {
    const cdp = new ExecuteCdp();
    cdp.result = { type: typeof value, value };
    await withDaemon(cdp, async (client, id) => {
      const res = await execute(client);
      expect(res.result).toEqual(value);
      expect(action(id)).toMatchObject({ result: { ok: true }, execute_result: value });
      expect(action(id).screenshot_path).toBe(res.screenshot_path);
      expect(fs.readFileSync(res.screenshot_path).toString('base64')).toBe(PNG);
      expect(fs.statSync(res.screenshot_path).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(res.screenshot_path)).mode & 0o777).toBe(0o700);
    });
  });

  it.each([
    { expression: 'Promise.resolve(42)', await_promise: false, fails: true },
    { expression: 'Promise.resolve(42)', await_promise: true, fails: false },
    { expression: 'Promise.resolve(undefined)', await_promise: true, fails: true },
    { expression: 'undefined', await_promise: false, fails: true },
    { expression: '()=>42', await_promise: false, fails: true },
    { expression: 'Symbol("test")', await_promise: false, fails: true },
  ])('实际执行页面包装器：$expression await=$await_promise', async ({ expression, await_promise, fails }) => {
    const cdp = new ExecuteCdp();
    cdp.evaluateGenerated = true;
    await withDaemon(cdp, async (client, id) => {
      const result = execute(client, { expression, await_promise });
      if (fails) {
        await expect(result).rejects.toMatchObject({ code: 'EXEC_ERROR' });
        expect(action(id).result).toMatchObject({ ok: false, error: { code: 'EXEC_ERROR' } });
      } else expect((await result).result).toBe(42);
    });
  });

  it.each([
    '({nested:{value:NaN}})', '({nested:[Infinity]})', '({nested:[-Infinity]})',
    '({nested:{fn:()=>42}})', '({nested:[undefined]})',
    '({nested:{value:Symbol("test")}})', '({nested:{value:1n}})',
    '({nested:Promise.resolve(42)})',
  ])('页面 JSON.stringify 拒绝嵌套非 JSON 值：%s', async expression => {
    const cdp = new ExecuteCdp();
    cdp.evaluateGenerated = true;
    await withDaemon(cdp, async (client, id) => {
      await expect(execute(client, { expression })).rejects.toMatchObject({ code: 'EXEC_ERROR' });
      expect(action(id).result).toMatchObject({ ok: false, error: { code: 'EXEC_ERROR' } });
      expect(action(id)).not.toHaveProperty('execute_result');
    });
  });

  it.each([false, true])('跨 realm Promise await=%s：未等待拒绝，显式等待保留值', async await_promise => {
    const cdp = new ExecuteCdp();
    cdp.evaluateGenerated = true;
    cdp.evaluationContext.foreignPromise = runInNewContext('Promise.resolve(42)');
    expect(runInNewContext('foreignPromise instanceof Promise', cdp.evaluationContext)).toBe(false);
    await withDaemon(cdp, async client => {
      const res = execute(client, { expression: 'foreignPromise', await_promise });
      if (await_promise) expect((await res).result).toBe(42);
      else await expect(res).rejects.toMatchObject({ code: 'EXEC_ERROR' });
    });
  });

  it.each([false, true])('普通 thenable await=%s 与 Promise 契约一致', async await_promise => {
    const cdp = new ExecuteCdp();
    cdp.evaluateGenerated = true;
    await withDaemon(cdp, async client => {
      const res = execute(client, { expression: '({then(resolve){resolve(42)}})', await_promise });
      if (await_promise) expect((await res).result).toBe(42);
      else await expect(res).rejects.toMatchObject({ code: 'EXEC_ERROR' });
    });
  });

  it.each(['failed-action', 'failed-assert', 'timeout', 'zero', 'broken'])('收尾读取生产 trace：%s 不得误 PASS', async defect => {
    const cdp = new ExecuteCdp();
    await withDaemon(cdp, async (client, id) => {
      await execute(client);
      const file = path.join(home, 'workspace/traces', id, 'trace.jsonl');
      if (defect === 'failed-action') {
        cdp.exception = { text: 'actual execute failed' };
        await expect(execute(client)).rejects.toMatchObject({ code: 'EXEC_ERROR' });
      }
      if (defect === 'failed-assert') fs.appendFileSync(file, JSON.stringify({ t: 'assert', pass: false }) + '\n');
      if (defect === 'timeout') fs.appendFileSync(file, JSON.stringify({ t: 'action', result: { ok: true }, settled_by: [{ kind: 'timeout' }] }) + '\n');
      if (defect === 'broken') fs.appendFileSync(file, '{broken\n');
      const result: any = await client.request('stop', {});
      expect(result.result).toBe(defect === 'zero' ? 'blocked' : defect === 'broken' ? 'aborted' : 'fail');
      if (defect !== 'broken') expect(readTraceEvents(id).at(-1)?.result).toBe(result.result);
    });
  });

  it('JS exception 明确 EXEC_ERROR，trace action 失败，无 execute_result', async () => {
    const cdp = new ExecuteCdp();
    cdp.exception = { text: 'Error', exception: { description: 'Error: password=private-value' } };
    await withDaemon(cdp, async (client, id) => {
      await expect(execute(client)).rejects.toMatchObject({ code: 'EXEC_ERROR' });
      expect(action(id).result).toMatchObject({ ok: false, error: { code: 'EXEC_ERROR' } });
      expect(action(id)).not.toHaveProperty('execute_result');
      expect(cdp.calls.some(c => c.method === 'Page.captureScreenshot')).toBe(false);
    });
  });

  it.each([
    { type: 'undefined' }, { type: 'function' }, { type: 'symbol' },
    { type: 'bigint', unserializableValue: '1n' },
    { type: 'number', unserializableValue: 'NaN' },
    { type: 'number', unserializableValue: 'Infinity' },
    { type: 'object', subtype: 'promise', value: {} },
  ])('非 JSON 返回 $type / $unserializableValue 拒绝，不伪造 null 或成功对象', async result => {
    const cdp = new ExecuteCdp();
    cdp.result = result;
    await withDaemon(cdp, async (client, id) => {
      await expect(execute(client)).rejects.toMatchObject({ code: 'EXEC_ERROR' });
      expect(action(id).result).toMatchObject({ ok: false, error: { code: 'EXEC_ERROR' } });
      expect(action(id)).not.toHaveProperty('execute_result');
    });
  });

  it.each([undefined, true, false])('await_promise=%s：默认关闭，显式开启，args 记录实际值', async awaitPromise => {
    const cdp = new ExecuteCdp();
    await withDaemon(cdp, async (client, id) => {
      await execute(client, awaitPromise === undefined ? {} : { await_promise: awaitPromise });
      expect(cdp.calls.find(c => c.method === 'Runtime.evaluate')?.params).toMatchObject({
        awaitPromise: awaitPromise === true, returnByValue: true,
      });
      expect(action(id).args.await_promise).toBe(awaitPromise === true);
    });
  });

  it('execute_result 递归脱敏；expression 是已声明动作参数原样落盘（F1 投影），实际 CDP expression 不改写', async () => {
    const cdp = new ExecuteCdp();
    cdp.result = { type: 'object', value: { token: 'result-secret', nested: { cookie: 'cookie-secret', count: 0 } } };
    const expression = 'fetch("https://x.test/api?token=expression-secret")';
    await withDaemon(cdp, async (client, id) => {
      const res = await execute(client, { expression });
      expect(res.result).toEqual({ token: '[REDACTED]', nested: { cookie: '[REDACTED]', count: 0 } });
      expect(String(cdp.calls.find(c => c.method === 'Runtime.evaluate')?.params.expression)).toContain(`(0, eval)(${JSON.stringify(expression)})`);
      const ev = action(id);
      // Phase2 F1：args 是契约字段投影（调用方已声明参数），execute_result 仍是来源处理后的脱敏值
      expect(JSON.stringify(ev)).not.toMatch(/result-secret|cookie-secret/);
      expect(ev.args.expression).toBe(expression);
      expect(ev.execute_result).toEqual({ token: '[REDACTED]', nested: { cookie: '[REDACTED]', count: 0 } });
    });
  });

  it('100KB 按 UTF-8 字节截断，响应和 trace 共享截断值', async () => {
    const cdp = new ExecuteCdp();
    cdp.result = { type: 'string', value: '中'.repeat(35000) };
    await withDaemon(cdp, async (client, id) => {
      const res = await execute(client);
      expect(res.result).toMatchObject({ _truncated: true, original_type: 'string' });
      expect(res.result.preview).toHaveLength(500);
      expect(action(id).execute_result).toEqual(res.result);
    });
  });

  it('先递归脱敏再截断：preview 里不泄露 token/password（含转义字符）', async () => {
    const cdp = new ExecuteCdp();
    cdp.result = { type: 'object', value: {
      token: 'token-\"secret', nested: { password: 'password-\\secret' },
      items: [{ token: 'array-secret' }], padding: 'x'.repeat(110000),
    } };
    await withDaemon(cdp, async (client, id) => {
      const res = await execute(client);
      expect(res.result._truncated).toBe(true);
      expect(res.result.preview).toHaveLength(500);
      expect(res.result.preview).toContain('[REDACTED]');
      expect(res.result.preview).not.toContain('secret');
      expect(action(id).execute_result).toMatchObject({ _truncated: true, original_type: 'object' });
      expect(action(id).execute_result.preview).toContain('[REDACTED]');
      expect(JSON.stringify(action(id).execute_result)).not.toContain('secret');
    });
  });

  it('脱敏后不足100KB保留结构，不按敏感原值大小误截断', async () => {
    const cdp = new ExecuteCdp();
    cdp.result = { type: 'object', value: { token: 's'.repeat(110000), count: 0 } };
    await withDaemon(cdp, async (client, id) => {
      const res = await execute(client);
      expect(res.result).toEqual({ token: '[REDACTED]', count: 0 });
      expect(action(id).execute_result).toEqual(res.result);
    });
  });

  it('截图失败显式返回并记录 screenshot_error，JS 执行结果仍保留', async () => {
    const cdp = new ExecuteCdp();
    cdp.screenshotError = 'Target closed';
    await withDaemon(cdp, async (client, id) => {
      const res = await execute(client);
      expect(res.screenshot_error).toBe('Target closed');
      expect(res).not.toHaveProperty('screenshot_path');
      expect(action(id)).toMatchObject({ result: { ok: true }, screenshot_error: 'Target closed' });
    });
  });

  it('截图目录 symlink 拒绝，不写到目录外', async () => {
    const cdp = new ExecuteCdp();
    const outside = path.join(home, 'outside');
    fs.mkdirSync(outside);
    fs.mkdirSync(path.join(home, 'workspace'), { recursive: true });
    fs.symlinkSync(outside, path.join(home, 'workspace', 'screenshots'));
    await withDaemon(cdp, async client => {
      const res = await execute(client);
      expect(res.screenshot_error).toContain('unsafe');
      expect(fs.readdirSync(outside)).toEqual([]);
    });
  });

  it.each([{ flags: [] }, { flags: ['--await-promise'] }, { flags: ['--await-promise=false'] }])('CLI 参数 $flags 只影响 execute，不扩张 parser', async ({ flags }) => {
    const cdp = new ExecuteCdp();
    await withDaemon(cdp, async (_client, id) => {
      const stdout: string[] = [];
      const deps: RouterDeps = { stdout: s => stdout.push(s), stderr: () => {}, env: process.env };
      expect(await dispatch(['page', 'execute', '-s', id, 'readData()', '--intent', '读数据', ...flags], deps)).toBe(0);
      expect(JSON.parse(stdout.join('')).ok).toBe(true);
      expect(action(id).args.await_promise).toBe(flags[0] === '--await-promise');
      expect(await dispatch(['page', 'execute', '-s', id, '1', '--intent', '读数据', '--no-await-promise'], deps)).toBe(2);
    });
  });
});
