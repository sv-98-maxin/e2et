/**
 * P2 CLI 红前测试:page read / assert data 参数合同(源互斥/dot path/scalar equals)
 * 与 commands --json 命令表。合法路径走注入的 fake daemon socket,断言透传 params。
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';
import { dispatch } from '../cli/router.js';
import { commandDefinitions } from '../cli/commands.js';
import type { RouterDeps } from '../cli/context.js';
import { generateSessionId, resolveSocketPath, writeMeta } from '../daemon/session-meta.js';
import { encodeLine, type DaemonRequest } from '../daemon/protocol.js';

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cli-home-'));
const ENV: NodeJS.ProcessEnv = { ...process.env, E2ET_HOME: TMP_HOME };
const TMP_DIRS: string[] = [];

afterAll(() => { while (TMP_DIRS.length) fs.rmSync(TMP_DIRS.pop()!, { recursive: true, force: true }); });

function capture(): { deps: RouterDeps; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cli-'));
  TMP_DIRS.push(homeDir);
  return {
    stdout,
    stderr,
    deps: { env: ENV, homeDir, stdout: (s: string) => stdout.push(s), stderr: (s: string) => stderr.push(s) },
  };
}

function envelope(stdout: string[]): { ok: boolean; data?: any; error?: { code: string; message: string } } {
  return JSON.parse(stdout.join(''));
}

/** 起 fake daemon socket 捕获最后一条请求;返回关闭函数 */
async function fakeDaemon(): Promise<{ id: string; lastRequest: () => DaemonRequest | undefined; close: () => Promise<void> }> {
  const id = generateSessionId();
  const socket = resolveSocketPath(id, ENV);
  writeMeta({ id, pid: process.pid, socket, started_at: Date.now(), env: 'pre' }, ENV);
  let request: DaemonRequest | undefined;
  const server = net.createServer((connection) => {
    connection.on('data', (bytes) => {
      request = JSON.parse(bytes.toString()) as DaemonRequest;
      connection.write(encodeLine({ id: (request as DaemonRequest).id, ok: true, data: { ok: true } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  return {
    id,
    lastRequest: () => request,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('commands 表(P2 新命令)', () => {
  it('commands --json 含 page read 与 assert data', async () => {
    const c = capture();
    expect(await dispatch(['commands', '--json'], c.deps)).toBe(0);
    const names = (envelope(c.stdout).data.commands as ReturnType<typeof commandDefinitions>)
      .map((cmd) => cmd.subcommand ? `${cmd.name} ${cmd.subcommand}` : cmd.name);
    expect(names).toContain('page read');
    expect(names).toContain('assert data');
    const read = (envelope(c.stdout).data.commands as ReturnType<typeof commandDefinitions>)
      .find((cmd) => cmd.name === 'page' && cmd.subcommand === 'read')!;
    expect(read.args.map((a) => a.name)).toContain('--local-storage');
    expect(read.args.map((a) => a.name)).toContain('--global');
    const dataCmd = (envelope(c.stdout).data.commands as ReturnType<typeof commandDefinitions>)
      .find((cmd) => cmd.name === 'assert' && cmd.subcommand === 'data')!;
    expect(dataCmd.args.find((a) => a.name === '--equals')?.required).toBe(true);
  });
});

describe('page read 参数合同', () => {
  it('缺 -s → USAGE exit 2', async () => {
    const c = capture();
    expect(await dispatch(['page', 'read', '--local-storage', 'mode'], c.deps)).toBe(2);
  });

  it('缺数据源(两源都不给)→ USAGE', async () => {
    const c = capture();
    const code = await dispatch(['page', 'read', '-s', 's_x'], c.deps);
    expect(code).toBe(2);
    expect(envelope(c.stdout).error?.code).toBe('USAGE');
    expect(envelope(c.stdout).error?.message).toContain('local-storage');
  });

  it('双源同时给 → USAGE', async () => {
    const c = capture();
    const code = await dispatch(['page', 'read', '-s', 's_x', '--local-storage', 'mode', '--global', 'g'], c.deps);
    expect(code).toBe(2);
    expect(envelope(c.stdout).error?.code).toBe('USAGE');
  });

  it('--path 只能与 --local-storage 同用 → USAGE', async () => {
    const c = capture();
    const code = await dispatch(['page', 'read', '-s', 's_x', '--global', 'g', '--path', 'a.b'], c.deps);
    expect(code).toBe(2);
    expect(envelope(c.stdout).error?.code).toBe('USAGE');
  });

  it('--path 拒绝 bracket / 过滤 / 空段语法 → USAGE', async () => {
    for (const badPath of ['a[0]', 'a[b=c]', 'a..b', '.a', 'a.', 'a b']) {
      const c = capture();
      const code = await dispatch(['page', 'read', '-s', 's_x', '--local-storage', 'cfg', '--path', badPath], c.deps);
      expect(code).toBe(2);
      expect(envelope(c.stdout).error?.code).toBe('USAGE');
    }
  });

  it('空 key / 空 name → USAGE', async () => {
    const c = capture();
    expect(await dispatch(['page', 'read', '-s', 's_x', '--local-storage', ''], c.deps)).toBe(2);
    const c2 = capture();
    expect(await dispatch(['page', 'read', '-s', 's_x', '--global', ''], c2.deps)).toBe(2);
  });

  it('合法 local-storage + path → 透传 params(local_storage/path/group)', async () => {
    const daemon = await fakeDaemon();
    try {
      const c = capture();
      const code = await dispatch(['page', 'read', '-s', daemon.id, '--local-storage', 'cfg', '--path', 'record.mode', '--group', 'G1'], c.deps);
      expect(code).toBe(0);
      expect(daemon.lastRequest()?.method).toBe('page.read');
      expect(daemon.lastRequest()?.params).toEqual({ local_storage: 'cfg', path: 'record.mode', group: 'G1' });
    } finally { await daemon.close(); }
  });

  it('合法 global → 透传 params', async () => {
    const daemon = await fakeDaemon();
    try {
      const c = capture();
      const code = await dispatch(['page', 'read', '-s', daemon.id, '--global', 'gStr'], c.deps);
      expect(code).toBe(0);
      expect(daemon.lastRequest()?.params).toEqual({ global: 'gStr' });
    } finally { await daemon.close(); }
  });
});

describe('assert data 参数合同', () => {
  it('缺 --equals → USAGE(parseArgs 必填)', async () => {
    const c = capture();
    const code = await dispatch(['assert', 'data', '-s', 's_x', '--local-storage', 'mode'], c.deps);
    expect(code).toBe(2);
    expect(envelope(c.stdout).error?.message).toContain('--equals');
  });

  it('equals 拒绝 object/array/非有限数 → USAGE(parseValue 解析后非标量)', async () => {
    for (const bad of ['{"a":1}', '[1]', '1e999']) {
      const c = capture();
      const code = await dispatch(['assert', 'data', '-s', 's_x', '--local-storage', 'mode', '--equals', bad], c.deps);
      expect(code).toBe(2);
      expect(envelope(c.stdout).error?.code).toBe('USAGE');
    }
  });

  it("equals 字符串 '-Infinity' 非合法 JSON → 按字面字符串 scalar 透传(不拒)", async () => {
    const daemon = await fakeDaemon();
    try {
      const c = capture();
      const code = await dispatch(['assert', 'data', '-s', daemon.id, '--global', 'g', '--equals', '-Infinity'], c.deps);
      expect(code).toBe(0);
      expect(daemon.lastRequest()?.params?.equals).toBe('-Infinity');
    } finally { await daemon.close(); }
  });

  it('equals 只在 router parseValue 一次,socket 传真实 JSON scalar', async () => {
    const daemon = await fakeDaemon();
    try {
      for (const [raw, scalar] of [['', ''], ['null', null], ['false', false], ['true', true], ['0', 0], ['12.5', 12.5], ['text', 'text'], ['"true"', 'true']] as Array<[string, unknown]>) {
        const c = capture();
        const code = await dispatch(['assert', 'data', '-s', daemon.id, '--global', 'g', '--equals', raw], c.deps);
        expect(code).toBe(0);
        expect(daemon.lastRequest()?.method).toBe('assert.data');
        expect(daemon.lastRequest()?.params?.equals).toEqual(scalar);
      }
    } finally { await daemon.close(); }
  });

  it("'true' string 与 true bool 不混淆:--equals true → boolean,--equals 引号包裹的 true → 字符串", async () => {
    const daemon = await fakeDaemon();
    try {
      const c = capture();
      await dispatch(['assert', 'data', '-s', daemon.id, '--global', 'g', '--equals', 'true'], c.deps);
      expect(daemon.lastRequest()?.params?.equals).toBe(true);
      const c2 = capture();
      await dispatch(['assert', 'data', '-s', daemon.id, '--global', 'g', '--equals', '"true"'], c2.deps);
      expect(daemon.lastRequest()?.params?.equals).toBe('true');
    } finally { await daemon.close(); }
  });

  it('源互斥等校验与 page read 一致 → USAGE', async () => {
    const c = capture();
    expect(await dispatch(['assert', 'data', '-s', 's_x', '--equals', 'v'], c.deps)).toBe(2);
    const c2 = capture();
    expect(await dispatch(['assert', 'data', '-s', 's_x', '--local-storage', 'a', '--global', 'g', '--equals', 'v'], c2.deps)).toBe(2);
    const c3 = capture();
    expect(await dispatch(['assert', 'data', '-s', 's_x', '--global', 'g', '--path', 'a.b', '--equals', 'v'], c3.deps)).toBe(2);
  });
});
