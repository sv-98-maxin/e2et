import { describe, it, expect, afterEach, vi } from 'vitest';
import * as net from 'node:net';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DaemonClient, DaemonClientError } from '../daemon/client.js';
import { encodeLine, type DaemonResponse } from '../daemon/protocol.js';
import { MAX_WAIT_TIMEOUT_MS } from '../wait-timeout.js';

function tmpSocket(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-')), 's.sock');
}

function startServer(socketPath: string, onLine: (line: string, write: (s: string) => void) => void, onCancel?: (msg: { id: number; cancel: true }) => void): net.Server {
  const server = net.createServer((conn) => {
    let buf = '';
    conn.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const msg = JSON.parse(line);
        if (msg.cancel === true) { onCancel?.(msg); continue; }
        onLine(line, (s) => conn.write(s));
      }
    });
  });
  server.listen(socketPath);
  return server;
}

describe('DaemonClient wait-start 续命', () => {
  let servers: net.Server[] = [];
  let sockets: string[] = [];
  afterEach(() => {
    vi.useRealTimers();
    for (const s of servers) { try { s.close(); } catch {} }
    for (const s of sockets) { try { fs.rmSync(s, { force: true }); } catch {} }
    servers = [];
    sockets = [];
  });

  it('负数 deadline 不续命：保留初始短超时，请求仍按时超时', async () => {
    const sock = tmpSocket();
    sockets.push(sock);
    const server = startServer(sock, (_line, write) => {
      // 收到请求后发负数 wait_deadline_ms 通知
      write(encodeLine({ id: 1, wait_deadline_ms: -1 }));
    });
    servers.push(server);
    await new Promise<void>((r) => server.once('listening', () => r()));
    const client = await DaemonClient.connect(sock, { connectTimeoutMs: 2000 });
    // 初始超时 200ms；负数通知不应续命 → 200ms 后超时
    await expect(client.request('page.click', {}, { requestTimeoutMs: 200 })).rejects.toThrow('超时');
    client.close();
  }, 5000);

  it('合法 deadline 续命：请求存活超过初始超时，直到响应到达', async () => {
    const sock = tmpSocket();
    sockets.push(sock);
    const server = startServer(sock, (line, write) => {
      // 先发合法 wait-start（未来 5s）→ 续命；初始超时 200ms 不应杀掉
      write(encodeLine({ id: 1, wait_deadline_ms: Date.now() + 5000 }));
      // 400ms 后再回响应（超过初始 200ms，证明续命生效）
      setTimeout(() => {
        const res: DaemonResponse = { id: 1, ok: true, data: { survived: true } };
        write(encodeLine(res));
      }, 400);
    });
    servers.push(server);
    await new Promise<void>((r) => server.once('listening', () => r()));
    const client = await DaemonClient.connect(sock, { connectTimeoutMs: 2000 });
    const data = await client.request('page.click', {}, { requestTimeoutMs: 200 });
    expect(data).toEqual({ survived: true });
    client.close();
  }, 5000);

  it('负数预算被忽略，之后合法通知仍能续命', async () => {
    const sock = tmpSocket();
    sockets.push(sock);
    const server = startServer(sock, (_line, write) => {
      // 先发负数（不续命），再发合法（续命）
      write(encodeLine({ id: 1, wait_deadline_ms: -1 }));
      write(encodeLine({ id: 1, wait_deadline_ms: Date.now() + 5000 }));
      // 400ms 后回响应（超过初始 200ms，证明合法通知续命生效）
      setTimeout(() => {
        const res: DaemonResponse = { id: 1, ok: true, data: { ok: true } };
        write(encodeLine(res));
      }, 400);
    });
    servers.push(server);
    await new Promise<void>((r) => server.once('listening', () => r()));
    const client = await DaemonClient.connect(sock, { connectTimeoutMs: 2000 });
    const data = await client.request('page.click', {}, { requestTimeoutMs: 200 });
    expect(data).toEqual({ ok: true });
    client.close();
  }, 5000);

  it('多次预算只延长：较短通知不缩短，停止进展后按最后 deadline 超时并发送 cancel', async () => {
    const sock = tmpSocket();
    sockets.push(sock);
    let writeLine!: (s: string) => void;
    let received!: () => void;
    const requestReceived = new Promise<void>((r) => { received = r; });
    let cancelled!: (line: unknown) => void;
    const cancelReceived = new Promise<unknown>((r) => { cancelled = r; });
    const server = startServer(sock, (line, write) => {
      const msg = JSON.parse(line);
      if (msg.method === 'barrier') { write(encodeLine({ id: msg.id, ok: true, data: null })); return; }
      writeLine = write;
      received();
    }, cancelled);
    servers.push(server);
    await new Promise<void>((r) => server.once('listening', () => r()));
    const client = await DaemonClient.connect(sock, { connectTimeoutMs: 2000 });
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    let settled = false;
    const pending = client.request('page.click', {}, { requestTimeoutMs: 200 }).catch((e) => { settled = true; return e; });
    await requestReceived;
    const notify = async (deadline: number): Promise<void> => {
      // 回显 barrier 保证真实 socket 的通知已被解析，再推进虚拟时间。
      writeLine(encodeLine({ id: 1, wait_deadline_ms: deadline }));
      await client.request('barrier');
    };
    await notify(Date.now() - 1);
    await vi.advanceTimersByTimeAsync(20_000);
    await notify(Date.now() + 50_000);
    await notify(Date.now() - 1);
    await vi.advanceTimersByTimeAsync(79_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toBeInstanceOf(DaemonClientError);
    expect(await pending).toMatchObject({ code: 'REQUEST_TIMEOUT', message: expect.stringContaining('执行结果未知'), hint: expect.stringContaining('禁止自动重试') });
    expect(await cancelReceived).toEqual({ id: 1, cancel: true });
    client.close();
  }, 5000);

  it('被动断连是结构化 REQUEST_INTERRUPTED，保留结果未知与禁重试提示', async () => {
    const sock = tmpSocket();
    sockets.push(sock);
    const server = net.createServer((conn) => { conn.once('data', () => conn.destroy()); });
    servers.push(server);
    await new Promise<void>((r) => server.listen(sock, r));
    const client = await DaemonClient.connect(sock);
    try {
      await expect(client.request('page.click')).rejects.toMatchObject({ code: 'REQUEST_INTERRUPTED', message: expect.stringContaining('执行结果未知'), hint: expect.stringContaining('禁止自动重试') });
    } finally { client.close(); }
  });

  it('无效 wait-start 通知（wrong id/零/小数/unsafe/超 duration）全忽略，保留初始超时', async () => {
    const sock = tmpSocket();
    sockets.push(sock);
    const server = startServer(sock, (_line, write) => {
      write(encodeLine({ id: 999, wait_deadline_ms: Date.now() + 100_000 })); // wrong id
      write(encodeLine({ id: 1, wait_deadline_ms: 0 })); // 零
      write(encodeLine({ id: 1, wait_deadline_ms: 1.5 })); // 小数
      write(encodeLine({ id: 1, wait_deadline_ms: Number.MAX_SAFE_INTEGER + 1 })); // unsafe
      write(encodeLine({ id: 1, wait_deadline_ms: Date.now() + 5_000_000_000 })); // 超 duration
    });
    servers.push(server);
    await new Promise<void>((r) => server.once('listening', () => r()));
    const client = await DaemonClient.connect(sock, { connectTimeoutMs: 2000 });
    await expect(client.request('page.click', {}, { requestTimeoutMs: 300 })).rejects.toThrow('超时');
    client.close();
  }, 5000);

  it('close() 清理当前 re-armed timer 与 pending：拒绝 "已关闭"', async () => {
    const sock = tmpSocket();
    sockets.push(sock);
    const server = startServer(sock, (_line, write) => {
      // 合法 far-future → 续命（re-armed timer 很长）
      write(encodeLine({ id: 1, wait_deadline_ms: Date.now() + 100_000 }));
    });
    servers.push(server);
    await new Promise<void>((r) => server.once('listening', () => r()));
    const client = await DaemonClient.connect(sock, { connectTimeoutMs: 2000 });
    const p = client.request('page.click', {}, { requestTimeoutMs: 200 });
    // 稍等续命生效后 close
    await new Promise((r) => setTimeout(r, 50));
    client.close();
    await expect(p).rejects.toThrow('已关闭');
  }, 5000);
});

// ── Phase D：open 执行+等待总预算通知的 deadline 形状被 client 接受 ──
describe('DaemonClient Phase D：open 最大合法预算通知', () => {
  let servers: net.Server[] = [];
  let sockets: string[] = [];
  afterEach(() => {
    for (const s of servers) { try { s.close(); } catch {} }
    for (const s of sockets) { try { fs.rmSync(s, { force: true }); } catch {} }
    servers = [];
    sockets = [];
  });

  it('deadline = MAX_WAIT_TIMEOUT_MS + 52.4s（open 导航+等待总预算）被接受并续命，不被 duration 上限校验拒绝', async () => {
    // client reArm duration = (deadline - now) + 30s = MAX_WAIT + 82.4s ≤ MAX_TIMER_MS（= MAX_WAIT + 90s 预留）
    const sock = tmpSocket();
    sockets.push(sock);
    const server = startServer(sock, (_line, write) => {
      write(encodeLine({ id: 1, wait_deadline_ms: Date.now() + MAX_WAIT_TIMEOUT_MS + 52_400 }));
      // 400ms 后回响应（超过初始 200ms，证明最大预算通知的续命生效而非被拒）
      setTimeout(() => {
        const res: DaemonResponse = { id: 1, ok: true, data: { survived: true } };
        write(encodeLine(res));
      }, 400);
    });
    servers.push(server);
    await new Promise<void>((r) => server.once('listening', () => r()));
    const client = await DaemonClient.connect(sock, { connectTimeoutMs: 2000 });
    const data = await client.request('page.open', { url: 'https://x', intent: 'x' }, { requestTimeoutMs: 200 });
    expect(data).toEqual({ survived: true });
    client.close();
  }, 5000);
});
