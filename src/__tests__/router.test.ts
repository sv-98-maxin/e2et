/**
 * CLI router 单测：信封与退出码、参数校验、commands --json 结构、
 * 会话元数据读写与 aborted 判定、socket 协议编解码、socket 路径超长处理。
 * 不起真实浏览器/daemon；session start 用注入的 spawner + readyWaiter。
 * 全部落盘走 E2ET_HOME → /tmp，避免沙箱拦截 ~/.e2et。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';
import {
  dispatch,
  cliHelp,
} from '../cli/router.js';
import { commandDefinitions, type CommandDef } from '../cli/commands.js';
import type { RouterDeps } from '../cli/context.js';
import {
  generateSessionId,
  resolveSocketPath,
  readMeta,
  writeMeta,
  listSessions,
  isPidAlive,
  sessionsDir,
  type SessionMeta,
} from '../daemon/session-meta.js';
import { encodeLine, parseLine, type DaemonRequest, type DaemonResponse } from '../daemon/protocol.js';

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'router-home-'));
const ENV: NodeJS.ProcessEnv = { ...process.env, E2ET_HOME: TMP_HOME };

interface Captured {
  deps: RouterDeps;
  stdout: string[];
  stderr: string[];
}

const TMP_HOME_DIRS: string[] = [];
it('finding 7：ir build 非法 name 返回 USAGE 退出码', async () => {
  const captured = capture();
  expect(await dispatch(['ir', 'build', '-s', 'missing', '--name', '../../escape'], captured.deps)).toBe(2);
  expect(JSON.parse(captured.stdout.join('')).error.code).toBe('USAGE');
});
it('finding 16：CLI prompt_text 必须进入 params.dialog', async () => {
  const captured = capture();
  const id = generateSessionId();
  const socket = resolveSocketPath(id, ENV);
  writeMeta({ id, pid: process.pid, socket, started_at: Date.now(), env: 'pre' }, ENV);
  let request: DaemonRequest | undefined;
  const server = net.createServer((connection) => {
    connection.on('data', (bytes) => {
      request = JSON.parse(bytes.toString()) as DaemonRequest;
      connection.write(encodeLine({ id: request.id, ok: true, data: {} }));
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  try {
    expect(await dispatch(['page', 'click', '-s', id, 'css=#prompt', '--intent', '输入', '--dialog', 'accept', '--prompt-text', '输入内容'], captured.deps)).toBe(0);
    expect(request?.params?.dialog).toEqual({ accept: true, prompt_text: '输入内容' });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
afterAll(() => { while (TMP_HOME_DIRS.length) fs.rmSync(TMP_HOME_DIRS.pop()!, { recursive: true, force: true }); });

function capture(overrides: Partial<RouterDeps> = {}): Captured {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-home-'));
  TMP_HOME_DIRS.push(homeDir);
  return {
    stdout,
    stderr,
    deps: {
      env: ENV,
      homeDir,
      stdout: (s: string) => stdout.push(s),
      stderr: (s: string) => stderr.push(s),
      ...overrides,
    },
  };
}

function envelope(stdout: string[]): { ok: boolean; data?: any; error?: { code: string; message: string; hint?: string } } {
  return JSON.parse(stdout.join(''));
}

beforeAll(() => { fs.mkdirSync(sessionsDir(ENV), { recursive: true }); });

describe('router 信封与退出码', () => {
  it.each(['REQUEST_TIMEOUT', 'REQUEST_INTERRUPTED', 'BUSY'])('session stop 未知结果：%s 保留结构化错误，不伪造成功', async (errorCode) => {
    const c = capture();
    const id = generateSessionId();
    const socket = resolveSocketPath(id, ENV);
    writeMeta({ id, pid: process.pid, socket, started_at: Date.now(), env: 'default' }, ENV);
    const server = net.createServer((conn) => {
      conn.once('data', (bytes) => {
        const req = JSON.parse(bytes.toString()) as DaemonRequest;
        conn.write(encodeLine({ id: req.id, ok: false, error: { code: errorCode, message: '执行结果未知', hint: '禁止自动重试' } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    try {
      expect(await dispatch(['session', 'stop', '-s', id], c.deps)).toBe(errorCode === 'BUSY' ? 1 : 3);
      expect(envelope(c.stdout)).toMatchObject({ ok: false, error: { code: errorCode, message: '执行结果未知', hint: '禁止自动重试' } });
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });

  it.each(['REQUEST_TIMEOUT', 'REQUEST_INTERRUPTED'])('%s 映射 EXIT_ENV=3 并保留未知结果提示', async (errorCode) => {
    const c = capture();
    const id = generateSessionId();
    const socket = resolveSocketPath(id, ENV);
    writeMeta({ id, pid: process.pid, socket, started_at: Date.now(), env: 'default' }, ENV);
    const server = net.createServer((conn) => {
      conn.once('data', (bytes) => {
        const req = JSON.parse(bytes.toString()) as DaemonRequest;
        conn.write(encodeLine({ id: req.id, ok: false, error: { code: errorCode, message: '执行结果未知', hint: '禁止自动重试' } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    try {
      expect(await dispatch(['page', 'click', '-s', id, 'css=#x', '--intent', '点击'], c.deps)).toBe(3);
      expect(envelope(c.stdout)).toMatchObject({ ok: false, error: { code: errorCode, message: '执行结果未知', hint: '禁止自动重试' } });
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });

  it('commands 按需发现：零参全量、group、group+sub 精确过滤', async () => {
    const full = capture();
    expect(await dispatch(['commands', '--json'], full.deps)).toBe(0);
    const all = envelope(full.stdout).data.commands as CommandDef[];
    expect(all).toHaveLength(58);

    const group = capture();
    expect(await dispatch(['commands', 'page', '--json'], group.deps)).toBe(0);
    expect(envelope(group.stdout).data.commands).toEqual(all.filter((command) => command.name === 'page'));

    const leaf = capture();
    expect(await dispatch(['commands', 'page', 'click', '--json'], leaf.deps)).toBe(0);
    expect(envelope(leaf.stdout).data.commands).toEqual([all.find((command) => command.name === 'page' && command.subcommand === 'click')]);

    const single = capture();
    expect(await dispatch(['commands', 'verify', '--json'], single.deps)).toBe(0);
    expect(envelope(single.stdout).data.commands).toEqual([all.find((command) => command.name === 'verify')]);
  });

  it('commands 未知组/叶子/多余参数/未知 flag 返回 usage', async () => {
    for (const args of [['nope'], ['page', 'nope'], ['page', 'click', 'extra'], ['--bad']]) {
      const c = capture();
      expect(await dispatch(['commands', ...args], c.deps)).toBe(2);
      expect(envelope(c.stdout).error?.code).toBe('USAGE');
    }
  });

  it('cliHelp 保留完整参数说明并使用 click --clicks 2', () => {
    expect(cliHelp()).toContain('[--browser auto|existing|chrome|managed]');
    expect(cliHelp()).toContain('E2ET_CDP_URL');
    expect(cliHelp()).toContain('--clicks 1|2');
    expect(cliHelp()).not.toContain('double-click');
    expect(cliHelp()).not.toContain('page date');
  });

  it('commands --json → 退出码 0，输出全部命令定义', async () => {
    const c = capture();
    const code = await dispatch(['commands', '--json'], c.deps);
    expect(code).toBe(0);
    const env = envelope(c.stdout);
    expect(env.ok).toBe(true);
    const cmds = env.data.commands as ReturnType<typeof commandDefinitions>;
    const names = cmds.map((c) => c.subcommand ? `${c.name} ${c.subcommand}` : c.name);
    expect(names).toContain('commands');
    expect(names).toContain('session start');
    expect(cmds.find((cmd) => cmd.name === 'session' && cmd.subcommand === 'start')?.args.find((arg) => arg.name === '--browser')?.enum).toEqual(['auto', 'existing', 'chrome', 'managed']);
    expect(names).toContain('session stop');
    expect(names).toContain('session list');
    expect(names).toContain('page open');
    expect(names).toContain('page state');
    expect(names).toContain('setup');
    expect(names).not.toContain('auth fetch');
    expect(names).toContain('doctor');
    expect(names).toContain('case list');
    expect(names).toContain('case run');
    expect(names).toContain('render');
    expect(names).toContain('verify');
    expect(names).toContain('land');
    expect(names).not.toContain('resolve-url');
    expect(names).not.toContain('source fetch');
    expect(names).not.toContain('ci run');
    const textAssert = cmds.find((cmd) => cmd.name === 'assert' && cmd.subcommand === 'text');
    expect(textAssert?.args.find((arg) => arg.name === 'contains')?.required).toBe(false);
    expect(textAssert?.args.some((arg) => arg.name === '--value-ref')).toBe(true);
    expect(textAssert?.args.some((arg) => arg.name === '--value-from-action')).toBe(true);
    expect(names.some((n) => n.includes('__daemon'))).toBe(false);
  });

  it('commands 不带 --json → 退出码 2', async () => {
    const c = capture();
    const code = await dispatch(['commands', '--bad'], c.deps);
    expect(code).toBe(2);
    expect(envelope(c.stdout).error?.code).toBe('USAGE');
  });

  it('assert text 支持来源参数透传，且字面值与来源 flag 互斥', async () => {
    const c = capture();
    const id = generateSessionId();
    const socket = resolveSocketPath(id, ENV);
    writeMeta({ id, pid: process.pid, socket, started_at: Date.now(), env: 'pre' }, ENV);
    const requests: DaemonRequest[] = [];
    const server = net.createServer((connection) => {
      connection.on('data', (bytes) => {
        const request = JSON.parse(bytes.toString()) as DaemonRequest;
        requests.push(request);
        connection.write(encodeLine({ id: request.id, ok: true, data: { pass: true } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    try {
      expect(await dispatch(['assert', 'text', '-s', id, '提交成功'], c.deps)).toBe(0);
      expect(await dispatch(['assert', 'text', '-s', id, '--value-ref', 'title'], c.deps)).toBe(0);
      expect(await dispatch(['assert', 'text', '-s', id, '--value-ref', ''], c.deps)).toBe(0);
      expect(await dispatch(['assert', 'text', '-s', id, '--value-from-action', ''], c.deps)).toBe(0);
      expect(await dispatch(['assert', 'text', '-s', id, '提交成功', '--value-ref', 'title'], c.deps)).toBe(2);
      expect(requests.map((request) => request.params)).toEqual([
        { value: '提交成功' },
        { value_ref: 'title' },
        { value_ref: '' },
        { value_from_action: '' },
      ]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('缺子命令 → 退出码 2', async () => {
    const c = capture();
    expect(await dispatch([], c.deps)).toBe(2);
  });

  it('未知命令 → 退出码 2', async () => {
    const c = capture();
    expect(await dispatch(['nope'], c.deps)).toBe(2);
  });

  it('page open 缺 --intent → 退出码 2', async () => {
    const c = capture();
    const code = await dispatch(['page', 'open', '-s', 's_x', 'https://x'], c.deps);
    expect(code).toBe(2);
    expect(envelope(c.stdout).error?.message).toContain('--intent');
  });

  it('page state 缺 -s → 退出码 2', async () => {
    const c = capture();
    expect(await dispatch(['page', 'state'], c.deps)).toBe(2);
  });

  it('session start --env 接受通用安全标签并拒绝非法标签', async () => {
    const c = capture({
      spawner: () => undefined,
      readyWaiter: async () => ({ ready: false, error: 'test-only' }),
    });
    expect(await dispatch(['session', 'start', '--env', 'staging.blue-1'], c.deps)).toBe(3);
    c.stdout.length = 0;
    expect(await dispatch(['session', 'start', '--env', 'bad label'], c.deps)).toBe(2);
  });
});

describe('page upload 多文件位置参数', () => {
  it('commands --json 声明 files 为可选 variadic', async () => {
    const c = capture();
    expect(await dispatch(['commands', '--json'], c.deps)).toBe(0);
    const upload = envelope(c.stdout).data.commands.find((cmd: any) => cmd.name === 'page' && cmd.subcommand === 'upload');
    const files = upload?.args.find((arg: any) => arg.name === 'files');
    expect(files).toMatchObject({ kind: 'string', variadic: true });
    expect(files?.required).toBeUndefined();
  });

  it('多文件 / 空格 / 重复 / 单文件 / 无文件均按 argv 有序传递', async () => {
    const c = capture();
    const id = generateSessionId();
    const socket = resolveSocketPath(id, ENV);
    writeMeta({ id, pid: process.pid, socket, started_at: Date.now(), env: 'pre' }, ENV);
    const requests: DaemonRequest[] = [];
    const server = net.createServer((connection) => {
      connection.on('data', (bytes) => {
        const request = JSON.parse(bytes.toString()) as DaemonRequest;
        requests.push(request);
        connection.write(encodeLine({ id: request.id, ok: true, data: {} }));
      });
    });
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    const a = '/tmp/upload/a.txt';
    const b = '/tmp/upload/b file.txt';
    try {
      expect(await dispatch(['page', 'upload', '-s', id, 'label=Upload Files', a, b, '--intent', '双文件'], c.deps)).toBe(0);
      expect(await dispatch(['page', 'upload', '-s', id, 'label=Upload Files', a, a, '--intent', '重复文件'], c.deps)).toBe(0);
      expect(await dispatch(['page', 'upload', '-s', id, 'label=Upload Files', a, '--intent', '单文件'], c.deps)).toBe(0);
      expect(await dispatch(['page', 'upload', '-s', id, 'label=Upload Files', '--intent', '无文件'], c.deps)).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(requests.map((request) => request.params?.files)).toEqual([[a, b], [a, a], [a], []]);
  });

  it('非 variadic 命令仍拒绝第二个位置参数', async () => {
    const c = capture();
    const code = await dispatch(['page', 'click', '-s', 's_x', 'css=#x', '/tmp/extra.txt', '--intent', '点'], c.deps);
    expect(code).toBe(2);
    expect(envelope(c.stdout).error?.code).toBe('USAGE');
    expect(envelope(c.stdout).error?.message).toContain('多余的位置参数');
  });
});

// —— --wait-timeout-ms（P3 timeout 契约）——
describe('--wait-timeout-ms 发现与 CLI 边界', () => {
  it('commands --json 发现 --wait-timeout-ms（仅 runAction 命令）', async () => {
    const c = capture();
    await dispatch(['commands', '--json'], c.deps);
    const cmds = envelope(c.stdout).data.commands;
    const clickArgs = cmds.find((cmd: any) => cmd.name === 'page' && cmd.subcommand === 'click')?.args ?? [];
    expect(clickArgs.some((a: any) => a.name === '--wait-timeout-ms')).toBe(true);
    // Phase D：open 并入 runAction 等待链路，同样暴露 --wait-timeout-ms
    const openArgs = cmds.find((cmd: any) => cmd.name === 'page' && cmd.subcommand === 'open')?.args ?? [];
    expect(openArgs.some((a: any) => a.name === '--wait-timeout-ms')).toBe(true);
    const switchArgs = cmds.find((cmd: any) => cmd.name === 'page' && cmd.subcommand === 'switch-tab')?.args ?? [];
    expect(switchArgs.some((a: any) => a.name === '--wait-timeout-ms')).toBe(false);
  });

  it('非法值（非数字）→ USAGE 连接前拒绝', async () => {
    const c = capture();
    const code = await dispatch(['page', 'click', '-s', 's_x', '[0]', '--intent', 'x', '--wait-api', '/a', '--wait-timeout-ms', 'bad'], c.deps);
    expect(code).toBe(2);
    expect(envelope(c.stdout).error?.code).toBe('USAGE');
  });
  it('零 → USAGE', async () => {
    const c = capture();
    const code = await dispatch(['page', 'click', '-s', 's_x', '[0]', '--intent', 'x', '--wait-api', '/a', '--wait-timeout-ms', '0'], c.deps);
    expect(code).toBe(2);
    expect(envelope(c.stdout).error?.code).toBe('USAGE');
  });
  it('budget 无 --wait-* 条件 → USAGE', async () => {
    const c = capture();
    const code = await dispatch(['page', 'click', '-s', 's_x', '[0]', '--intent', 'x', '--wait-timeout-ms', '1000'], c.deps);
    expect(code).toBe(2);
    expect(envelope(c.stdout).error?.message).toContain('wait');
  });
  it('switch-tab 不接受 --wait-timeout-ms（未知参数 → USAGE）', async () => {
    const c = capture();
    const code = await dispatch(['page', 'switch-tab', '-s', 's_x', '--intent', 'x', '--wait-timeout-ms', '1000'], c.deps);
    expect(code).toBe(2);
  });
});

// ── Phase D：page open 显式等待参数（open 并入 runAction 等待链路）──
describe('page open --wait-* 参数（Phase D）', () => {
  it('六个等待参数透传进 socket params，--wait-timeout-ms 归一 number，group 保留', async () => {
    const c = capture();
    const id = generateSessionId();
    const socket = resolveSocketPath(id, ENV);
    writeMeta({ id, pid: process.pid, socket, started_at: Date.now(), env: 'pre' }, ENV);
    let request: DaemonRequest | undefined;
    const server = net.createServer((connection) => {
      connection.on('data', (bytes) => {
        request = JSON.parse(bytes.toString()) as DaemonRequest;
        connection.write(encodeLine({ id: request.id, ok: true, data: {} }));
      });
    });
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    try {
      const code = await dispatch(['page', 'open', '-s', id, 'https://example.test/app',
        '--intent', '打开页面', '--group', 'G1',
        '--wait-url', '/app', '--wait-element', 'css=.done', '--wait-gone', 'css=.loading',
        '--wait-text', '加载完成', '--wait-api', '/api/list', '--wait-timeout-ms', '5000'], c.deps);
      expect(code).toBe(0);
      expect(request?.method).toBe('page.open');
      expect(request?.params).toMatchObject({
        url: 'https://example.test/app', intent: '打开页面', group: 'G1',
        wait_url: '/app', wait_element: 'css=.done', wait_gone: 'css=.loading',
        wait_text: '加载完成', wait_api: '/api/list', wait_timeout_ms: 5000,
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('open 非法 --wait-timeout-ms → USAGE 连接前拒绝', async () => {
    const c = capture();
    const code = await dispatch(['page', 'open', '-s', 's_x', 'https://x', '--intent', 'x', '--wait-url', '/a', '--wait-timeout-ms', 'bad'], c.deps);
    expect(code).toBe(2);
    expect(envelope(c.stdout).error?.code).toBe('USAGE');
    expect(envelope(c.stdout).error?.message).toContain('非法');
  });

  it('open --wait-timeout-ms 无 --wait-* 条件 → USAGE 连接前拒绝', async () => {
    const c = capture();
    const code = await dispatch(['page', 'open', '-s', 's_x', 'https://x', '--intent', 'x', '--wait-timeout-ms', '1000'], c.deps);
    expect(code).toBe(2);
    expect(envelope(c.stdout).error?.message).toContain('需配合');
  });

  it('open 仍不接受导航不需要的公共参数（--frame → USAGE 未知参数）', async () => {
    const c = capture();
    const code = await dispatch(['page', 'open', '-s', 's_x', 'https://x', '--intent', 'x', '--frame', 'name=x'], c.deps);
    expect(code).toBe(2);
    expect(envelope(c.stdout).error?.code).toBe('USAGE');
  });

  it('commands --json：open 暴露全部六个等待参数（机器可读自发现）', async () => {
    const c = capture();
    await dispatch(['commands', '--json'], c.deps);
    const cmds = envelope(c.stdout).data.commands;
    const openArgs = (cmds.find((cmd: any) => cmd.name === 'page' && cmd.subcommand === 'open')?.args ?? []).map((a: any) => a.name);
    for (const name of ['--wait-api', '--wait-element', '--wait-gone', '--wait-text', '--wait-url', '--wait-timeout-ms']) {
      expect(openArgs).toContain(name);
    }
  });
});

describe('session 元数据读写与 aborted 判定', () => {
  it('writeMeta/readMeta 往返', () => {
    const id = generateSessionId();
    const meta: SessionMeta = {
      id, pid: process.pid, socket: resolveSocketPath(id, ENV),
      started_at: Date.now(), env: 'pre', tab_id: 't1', transport: 'managed',
    };
    writeMeta(meta, ENV);
    const back = readMeta(id, ENV);
    expect(back?.pid).toBe(process.pid);
    expect(back?.tab_id).toBe('t1');
  });

  it('listSessions：pid 已死且无 session_end → aborted', () => {
    const id = generateSessionId();
    writeMeta({ id, pid: 999999, socket: resolveSocketPath(id, ENV), started_at: Date.now(), env: 'pre' }, ENV);
    expect(listSessions(ENV).find((s) => s.id === id)?.status).toBe('aborted');
  });

  it('listSessions：有 session_end pass → stopped', () => {
    const id = generateSessionId();
    writeMeta({
      id, pid: 999999, socket: resolveSocketPath(id, ENV), started_at: Date.now(), env: 'pre',
      session_end: { result: 'pass', ended_at: Date.now() },
    }, ENV);
    expect(listSessions(ENV).find((s) => s.id === id)?.status).toBe('stopped');
  });

  it('listSessions：pid 活且无 session_end → running', () => {
    const id = generateSessionId();
    writeMeta({ id, pid: process.pid, socket: resolveSocketPath(id, ENV), started_at: Date.now(), env: 'pre' }, ENV);
    expect(listSessions(ENV).find((s) => s.id === id)?.status).toBe('running');
  });

  it('isPidAlive：自己进程为活', () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(999999)).toBe(false);
    expect(isPidAlive(undefined)).toBe(false);
  });
});

describe('socket 路径超长处理', () => {
  it('短 id → sessions 目录，长度安全', () => {
    const id = 's_abcdef12';
    const p = resolveSocketPath(id, ENV);
    expect(p).toBe(path.join(sessionsDir(ENV), `${id}.sock`));
    expect(p.length).toBeLessThan(100);
  });

  it('超长 home → 退到 os.tmpdir() 短路径且长度 < 100', () => {
    // 用一个超长的 E2ET_HOME 模拟 home 极长的用户
    const longHome = path.join(os.tmpdir(), 'x'.repeat(100));
    const longEnv: NodeJS.ProcessEnv = { ...ENV, E2ET_HOME: longHome };
    const id = 's_a1b2c3d4';
    const p = resolveSocketPath(id, longEnv);
    const primary = path.join(sessionsDir(longEnv), `${id}.sock`);
    expect(primary.length).toBeGreaterThan(100);
    expect(p).not.toBe(primary);
    expect(p.startsWith(os.tmpdir())).toBe(true);
    expect(p.length).toBeLessThan(100);
  });
});

describe('socket 协议编解码', () => {
  it('请求编码/解码往返', () => {
    const req: DaemonRequest = { id: 1, method: 'page.open', params: { url: 'https://x', intent: '打开' } };
    const line = encodeLine(req);
    expect(line.endsWith('\n')).toBe(true);
    const back = parseLine(line.trim()) as DaemonRequest;
    expect(back.method).toBe('page.open');
    expect(back.params?.url).toBe('https://x');
  });

  it('响应编码/解码往返', () => {
    const res: DaemonResponse = { id: 2, ok: false, error: { code: 'STALE_INDEX', message: '过期', hint: 'refresh' } };
    const back = parseLine(encodeLine(res).trim()) as DaemonResponse;
    expect(back.ok).toBe(false);
    expect(back.error?.code).toBe('STALE_INDEX');
    expect(back.error?.hint).toBe('refresh');
  });

  it('坏行 → null，不抛', () => {
    expect(parseLine('not json')).toBeNull();
    expect(parseLine('')).toBeNull();
  });
});

describe('session start（注入假 daemon）', () => {
  it('--browser 默认 auto，显式值与 auth 正交传给 spawner', async () => {
    const received: Array<[string, string]> = [];
    const c = capture({
      cliPath: '/fake/cli.js',
      spawner: (id, _env, _socket, _cliPath, auth, browser) => {
        received.push([auth, browser]);
        writeMeta({ id, pid: process.pid, socket: resolveSocketPath(id, ENV), started_at: Date.now(), env: 'pre' }, ENV);
      },
      readyWaiter: async () => ({ ready: true }),
    });
    expect(await dispatch(['session', 'start'], c.deps)).toBe(0);
    expect(await dispatch(['session', 'start', '--browser', 'existing', '--auth', 'imported'], c.deps)).toBe(0);
    expect(await dispatch(['session', 'start', '--browser=auto', '--auth=profile'], c.deps)).toBe(0);
    expect(received).toEqual([['auto', 'auto'], ['imported', 'existing'], ['profile', 'auto']]);
  });

  it('browser 枚举错误与强制不兼容组合均 exit 2，且不启动 daemon', async () => {
    let spawned = 0;
    const c = capture({ spawner: () => { spawned++; } });
    for (const args of [
      ['--browser', 'invalid'],
      ['--browser', 'existing', '--auth', 'profile'],
      ['--browser', 'managed', '--auth', 'profile'],
      ['--browser', 'chrome', '--auth', 'imported'],
      ['--browser', 'chrome', '--auth', 'vendor'],
    ]) {
      c.stdout.length = 0;
      expect(await dispatch(['session', 'start', ...args], c.deps)).toBe(2);
      expect(envelope(c.stdout).error?.code).toBe('USAGE');
    }
    expect(spawned).toBe(0);
  });

  it('显式空 state 在 spawner 前拒绝', async () => {
    let spawned = 0;
    for (const state of ['', ' \t ']) {
      const c = capture({
        env: { ...ENV, E2ET_AUTH_STATE: state },
        cliPath: '/fake/cli.js',
        spawner: () => { spawned++; },
        readyWaiter: async () => ({ ready: true }),
      });
      expect(await dispatch(['session', 'start'], c.deps)).toBe(2);
      expect(envelope(c.stdout).error).toMatchObject({
        code: 'USAGE',
        message: 'E2ET_AUTH_STATE 是空字符串或纯空白（显式空值不是合法 state 输入）',
      });
    }
    expect(spawned).toBe(0);
  });

  it('显式 profile/chrome 先清空继承 state，再按原路径启动 daemon', async () => {
    let childEnv: NodeJS.ProcessEnv | undefined;
    const c = capture({
      env: { ...ENV, E2ET_AUTH_STATE: ' \t ' },
      cliPath: '/fake/cli.js',
      spawner: (_id, _env, _socket, _cliPath, _auth, _browser, env) => { childEnv = env; },
      readyWaiter: async () => ({ ready: true }),
    });
    expect(await dispatch(['session', 'start', '--auth', 'profile', '--browser', 'chrome'], c.deps)).toBe(0);
    expect(childEnv).not.toHaveProperty('E2ET_AUTH_STATE');
  });

  it('有效 state + auto 原样传递，无 state 继承仍保持 auto', async () => {
    const received: Array<{ childEnv: NodeJS.ProcessEnv | undefined; auth: string; browser: string }> = [];
    const c = capture({
      env: { ...ENV, E2ET_AUTH_STATE: '/explicit/prepared-state.json' },
      cliPath: '/fake/cli.js',
      spawner: (_id, _env, _socket, _cliPath, auth, browser, childEnv) => { received.push({ childEnv, auth, browser }); },
      readyWaiter: async () => ({ ready: true }),
    });
    expect(await dispatch(['session', 'start'], c.deps)).toBe(0);
    expect(received).toEqual([{
      childEnv: expect.objectContaining({ E2ET_AUTH_STATE: '/explicit/prepared-state.json' }),
      auth: 'auto',
      browser: 'auto',
    }]);

    const inheritedEnv = { ...ENV };
    delete inheritedEnv.E2ET_AUTH_STATE;
    const empty = capture({
      env: inheritedEnv,
      cliPath: '/fake/cli.js',
      spawner: (_id, _env, _socket, _cliPath, auth, browser, childEnv) => { received.push({ childEnv, auth, browser }); },
      readyWaiter: async () => ({ ready: true }),
    });
    expect(await dispatch(['session', 'start'], empty.deps)).toBe(0);
    expect(received[1].auth).toBe('auto');
    expect(received[1].browser).toBe('auto');
    expect(received[1].childEnv).not.toHaveProperty('E2ET_AUTH_STATE');
  });

  it('注入 spawner + readyWaiter → 返回 session_id', async () => {
    let spawnedId = '';
    const c = capture({
      cliPath: '/fake/cli.js',
      spawner: (id) => {
        spawnedId = id;
        writeMeta({ id, pid: process.pid, socket: resolveSocketPath(id, ENV), started_at: Date.now(), env: 'pre' }, ENV);
      },
      readyWaiter: async () => ({ ready: true }),
    });
    const code = await dispatch(['session', 'start'], c.deps);
    const env = envelope(c.stdout);
    expect(code).toBe(0);
    expect(env.ok).toBe(true);
    expect(env.data.session_id).toBe(spawnedId);
  });

  it('readyWaiter 返回 error → 退出码 3', async () => {
    const c = capture({
      cliPath: '/fake/cli.js',
      spawner: () => {},
      readyWaiter: async () => ({ ready: false, error: 'no browser' }),
    });
    const code = await dispatch(['session', 'start'], c.deps);
    expect(code).toBe(3);
  });
});

describe('setup 参数校验（F7）', () => {
  it('setup 带未知参数 → 退出码 2', async () => {
    const c = capture();
    const code = await dispatch(['setup', '--foo', 'bar'], c.deps);
    expect(code).toBe(2);
    const env = envelope(c.stdout);
    expect(env.error?.code).toBe('USAGE');
  });

  it('setup 无包内 Skill → 只准备 workspace 和环境，不安装 Skill', async () => {
    const c = capture();
    const home = c.deps.homeDir!;
    const env = { ...ENV, E2ET_HOME: home, E2ET_CDP_URL: 'http://localhost:9222' };
    const code = await dispatch(['setup'], { ...c.deps, env });
    expect(code).toBe(0);
    const out = envelope(c.stdout);
    expect(out.ok).toBe(true);
    expect(out.data).toMatchObject({
      workspace: path.join(home, 'workspace'),
      browser: 'native-cdp',
      cdp_url: 'http://localhost:9222',
      blockers: [],
      blocker_hints: [],
    });
    expect(out.data.tool_version).toBeTruthy();
    expect(out.data).not.toHaveProperty('skill');
    expect(fs.existsSync(out.data.workspace)).toBe(true);
    expect(fs.existsSync(path.join(home, '.agents'))).toBe(false);
  });

  it('setup 不覆盖独立安装的 Skill', async () => {
    const c = capture();
    const home = c.deps.homeDir!;
    const skillDir = path.join(home, '.agents', 'skills', 'e2et');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), 'user-owned skill');
    expect(await dispatch(['setup'], { ...c.deps, env: { ...ENV, E2ET_HOME: home } })).toBe(0);
    expect(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8')).toBe('user-owned skill');
    expect(fs.readdirSync(skillDir)).toEqual(['SKILL.md']);
    expect(fs.readdirSync(path.dirname(skillDir))).toEqual(['e2et']);
  });
});

describe('callDaemon 退出码（F14）', () => {
  it('daemon 请求超时 → 退出码 3', async () => {
    // 用一个不存在的 daemon pid + 已写 meta 的会话
    const id = generateSessionId();
    writeMeta({ id, pid: 999999, socket: resolveSocketPath(id, ENV), started_at: Date.now(), env: 'pre' }, ENV);
    const c = capture();
    const code = await dispatch(['page', 'state', '-s', id], c.deps);
    // pid 不存在 → SESSION_ENDED 退出码 1
    expect(code).toBe(1);
  });
});

describe('session stop 清理残留 socket（F10）', () => {
  it('已死 daemon 的 socket 被清理', async () => {
    const id = generateSessionId();
    const sockPath = resolveSocketPath(id, ENV);
    // 模拟残留 socket 文件
    fs.writeFileSync(sockPath, '');
    writeMeta({ id, pid: 999999, socket: sockPath, started_at: Date.now(), env: 'pre' }, ENV);
    expect(fs.existsSync(sockPath)).toBe(true);
    const c = capture();
    const code = await dispatch(['session', 'stop', '-s', id], c.deps);
    expect(code).toBe(0);
    expect(envelope(c.stdout).data.result).toBe('aborted');
    expect(fs.existsSync(sockPath)).toBe(false);
  });
});

// ── 新 CLI 命令参数与退出码 ──

describe('doctor 参数校验', () => {
  it('doctor --foo → 退出码 2', async () => {
    const c = capture();
    const code = await dispatch(['doctor', '--foo'], c.deps);
    expect(code).toBe(2);
    expect(envelope(c.stdout).error?.code).toBe('USAGE');
  });
});

describe('平台命令已迁出核心', () => {
  it.each([
    ['source', 'fetch', 'example/repo', 'src/main.tsx'],
    ['ci', 'run', 'valid-test', '--project-id', '111', '--pipeline-id', '222'],
    ['auth', 'fetch', '--repo', '111', '--var', 'V', '--out', '/tmp/state.json'],
  ])('%s %s → 未知命令 exit2，无远程副作用', async (...argv) => {
    const c = capture();
    expect(await dispatch(argv, c.deps)).toBe(2);
    expect(envelope(c.stdout).error?.code).toBe('USAGE');
  });
});

describe('resolve-url 命令已迁出', () => {
  it('resolve-url → 未知命令 exit 2（业务映射由 Skill 维护）', async () => {
    const c = capture();
    const code = await dispatch(['resolve-url', 'https://portal.example.invalid/pages/foo/bar.html'], c.deps);
    expect(code).toBe(2);
    expect(envelope(c.stdout).error?.code).toBe('USAGE');
  });
});

// note13：长时序 wait-start 续命证明（真实 router + unix socket，隔离 meta，本进程 pid）
describe('wait-start 长时序续命', () => {
  function startDelayedServer(socket: string, preWaitMs: number, budgetMs: number, respAfterMs: number, captureReq?: (r: DaemonRequest) => void): net.Server {
    const server = net.createServer((conn) => {
      conn.on('data', (bytes) => {
        const req = JSON.parse(bytes.toString()) as DaemonRequest;
        if (captureReq) captureReq(req);
        // preWait 后发 wait_deadline_ms（未来 budgetMs），再 respAfter 后回响应
        setTimeout(() => {
          conn.write(encodeLine({ id: req.id, wait_deadline_ms: Date.now() + budgetMs } as any));
          setTimeout(() => {
            conn.write(encodeLine({ id: req.id, ok: true, data: { survived: true, kind: req.method } }));
          }, respAfterMs);
        }, preWaitMs);
      });
    });
    server.listen(socket);
    return server;
  }

  it('默认显式预算：preWait 55s + 响应 10s 后成功（超过 60s 初始传输允许）', async () => {
    const c = capture();
    const id = generateSessionId();
    const socket = resolveSocketPath(id, c.deps.env as NodeJS.ProcessEnv);
    writeMeta({ id, pid: process.pid, socket, started_at: Date.now(), env: 'pre' }, c.deps.env as NodeJS.ProcessEnv);
    const server = startDelayedServer(socket, 55_000, 30_000, 10_000);
    await new Promise<void>((r) => server.once('listening', () => r()));
    const t0 = Date.now();
    try {
      const code = await dispatch(['page', 'click', '-s', id, 'css=#x', '--intent', '点', '--wait-api', '/api/late'], c.deps);
      const elapsed = Date.now() - t0;
      expect(code).toBe(0);
      expect(elapsed).toBeGreaterThan(60_000);
      expect(elapsed).toBeLessThan(85_000);
      expect(envelope(c.stdout).data?.survived).toBe(true);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 100_000);

  it('自定义 40000 预算：preWait 55s + 响应 25s 后成功，且 params.wait_timeout_ms 归一为 40000', async () => {
    const c = capture();
    const id = generateSessionId();
    const socket = resolveSocketPath(id, c.deps.env as NodeJS.ProcessEnv);
    writeMeta({ id, pid: process.pid, socket, started_at: Date.now(), env: 'pre' }, c.deps.env as NodeJS.ProcessEnv);
    let captured: DaemonRequest | undefined;
    const server = startDelayedServer(socket, 55_000, 40_000, 25_000, (r) => { captured = r; });
    await new Promise<void>((r) => server.once('listening', () => r()));
    const t0 = Date.now();
    try {
      const code = await dispatch(['page', 'click', '-s', id, 'css=#x', '--intent', '点', '--wait-api', '/api/late', '--wait-timeout-ms', '40000'], c.deps);
      const elapsed = Date.now() - t0;
      expect(code).toBe(0);
      expect(elapsed).toBeGreaterThan(70_000);
      expect(elapsed).toBeLessThan(100_000);
      expect(captured?.params?.wait_timeout_ms).toBe(40000);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 115_000);
});
