/**
 * auth-resolve 单测：import 三格式 + --domain 作用域 / profile→imported 顺序 / probe 语义 / status / doctor。
 * 不起真浏览器；注入探测用注入 probeAuth 函数模拟。
 * 新语义：auth 只报告标准数据事实，不判定业务登录页/业务 cookie。
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { dispatch } from '../cli/router.js';
import type { RouterDeps } from '../cli/context.js';
import { authStatePath, injectAndProbeAuthState, probeAuthState } from '../browser/managed-browser.js';
import {
  importAuth,
  parseAuthInput,
  parseDomainArg,
  AuthUsageError,
  resolveAndProbeAuth,
  preflightAuthSources,
  staticAuthSourceState,
  resolveAuthPath,
  importedAuthPath,
  type AuthSource,
  type ProbeAuthFn,
  type ProbeResult,
} from '../auth-resolve.js';

const NOW = 1_800_000_000; // 固定 now（2027 年），cookie expires 相对此构造
const SECRET = 'SECRET_VALUE_xyz789';
const EMPTY_STATE_ERROR = 'E2ET_AUTH_STATE 是空字符串或纯空白（显式空值不是合法 state 输入）';

function cookie(name: string, expires = NOW + 3600) {
  return { name, value: SECRET, domain: '.example.test', path: '/', expires, httpOnly: true, secure: true, sameSite: 'Lax' as const };
}

const VALID_COOKIES = [cookie('SESSION_A'), cookie('SESSION_B'), cookie('OTHER')];

function expectNoSecret(text: string): void {
  expect(text).not.toContain(SECRET);
  expect(text).not.toMatch(/"value"\s*:\s*"[^"]*SECRET/i);
}

// —— import 三格式 + --domain 作用域 ——

describe('auth import 三格式', () => {
  let home: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-import-'));
    env = { ...process.env, E2ET_HOME: home };
    delete env.E2ET_CDP_URL;
    delete env.E2ET_AUTH_STATE;
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it('P4 格式1：Playwright storageState JSON（{cookies,origins}，origins 保留）', () => {
    const origins = [{ origin: 'https://example.test', localStorage: [{ name: 'k', value: 'v' }] }];
    const input = JSON.stringify({ cookies: VALID_COOKIES, origins });
    const r = importAuth({ input, env });
    expect(r.path).toBe(importedAuthPath(env));
    const onDisk = JSON.parse(fs.readFileSync(r.path, 'utf-8'));
    expect(onDisk.cookies).toHaveLength(3);
    expect(onDisk.origins).toEqual(origins);
    expectNoSecret(JSON.stringify(r.summary));
    // 权限 0600
    const stat = fs.statSync(r.path);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('格式2：cookies 数组 JSON', () => {
    const input = JSON.stringify(VALID_COOKIES);
    const r = importAuth({ input, env });
    expect(r.summary.cookies).toBe(3);
    expectNoSecret(JSON.stringify(r.summary));
  });

  it('格式3：cookie 头字符串 + 显式 --domain → 任意调用方域生效', () => {
    const input = `SESSION_A=${SECRET}; X-XSRF-TOKEN=abc123`;
    const r = importAuth({ input, env, domain: 'caller.example.org' });
    expect(r.summary.cookies).toBe(2);
    const onDisk = JSON.parse(fs.readFileSync(r.path, 'utf-8'));
    expect(onDisk.cookies[0].domain).toBe('caller.example.org');
    expect(onDisk.cookies[0].path).toBe('/');
    expect(onDisk.cookies[0].expires).toBeUndefined();
    // cookie 头解析产出的 cookie 必须带 sameSite=None + secure=true，
    // 否则跨站导航会被 Chromium 静默丢弃
    expect(onDisk.cookies[0].sameSite).toBe('None');
    expect(onDisk.cookies[0].secure).toBe(true);
    expectNoSecret(JSON.stringify(r.summary));
  });

  it('格式3：--domain 带前导点 → 原样落盘（域 cookie 表示）', () => {
    const r = importAuth({ input: 'a=b', env, domain: '.example.org' });
    const onDisk = JSON.parse(fs.readFileSync(r.path, 'utf-8'));
    expect(onDisk.cookies[0].domain).toBe('.example.org');
  });

  it('格式3：缺 --domain → AuthUsageError，目标文件不落盘（写盘前拒绝）', () => {
    expect(() => importAuth({ input: `a=${SECRET}; b=c`, env })).toThrow(AuthUsageError);
    expect(() => importAuth({ input: `a=${SECRET}; b=c`, env })).toThrow(/--domain/);
    expect(fs.existsSync(importedAuthPath(env))).toBe(false);
  });

  it('格式1/2 的 domain 来自输入，不被 --domain 改写', () => {
    const input = JSON.stringify({ cookies: VALID_COOKIES, origins: [] });
    const r = importAuth({ input, env, domain: 'other.example.org' });
    const onDisk = JSON.parse(fs.readFileSync(r.path, 'utf-8'));
    expect(onDisk.cookies[0].domain).toBe('.example.test');
  });

  it('--domain 拒绝 URL / 带路径 / 带端口 / 空值 / 通配符', () => {
    expect(() => importAuth({ input: 'a=b', env, domain: 'https://example.org' })).toThrow(AuthUsageError);
    expect(() => importAuth({ input: 'a=b', env, domain: 'example.org:8080' })).toThrow(AuthUsageError);
    expect(() => importAuth({ input: 'a=b', env, domain: 'example.org/path' })).toThrow(AuthUsageError);
    expect(() => importAuth({ input: 'a=b', env, domain: '' })).toThrow(AuthUsageError);
    expect(() => importAuth({ input: 'a=b', env, domain: '*.example.org' })).toThrow(AuthUsageError);
    expect(fs.existsSync(importedAuthPath(env))).toBe(false);
  });

  it('parseDomainArg：合法 host 与带前导点 host 通过', () => {
    expect(parseDomainArg('example.org')).toBe('example.org');
    expect(parseDomainArg('.example.org')).toBe('.example.org');
    expect(parseDomainArg('sub.example.org')).toBe('sub.example.org');
  });

  it('没有业务 cookie 的标准 state → 可加载（不因缺固定 cookie 拒绝）', () => {
    const input = JSON.stringify({ cookies: [cookie('ANY_OTHER')], origins: [] });
    const r = importAuth({ input, env });
    expect(r.summary.cookies).toBe(1);
    expect(fs.existsSync(r.path)).toBe(true);
  });

  it('输入 cookie 全部到期 → 仍可加载（到期是事实不是拒绝理由）', () => {
    // 相对真实 now 过期（buildAuthSummary 默认用当前时间）
    const realNow = Math.floor(Date.now() / 1000);
    const expired = [cookie('SESSION_A', realNow - 100)];
    const r = importAuth({ input: JSON.stringify(expired), env });
    expect(r.summary.cookies).toBe(1);
    expect(r.summary.cookieFacts.find((f) => f.name === 'SESSION_A')?.expired).toBe(true);
  });

  it('空输入 → 报错', () => {
    expect(() => importAuth({ input: '   ', env })).toThrow(/为空/);
  });

  it('显式空 cookies 数组 → 合法 state 落盘（不静默匿名降级）', () => {
    const r = importAuth({ input: JSON.stringify([]), env });
    expect(r.summary.cookies).toBe(0);
    const onDisk = JSON.parse(fs.readFileSync(r.path, 'utf-8'));
    expect(onDisk).toEqual({ cookies: [], origins: [] });
  });

  it('坏格式（仅 name 缺 value/domain）→ 写盘前拒绝，不覆盖已有 imported.json', () => {
    // 预置一个旧合法 imported.json
    const target = importedAuthPath(env);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify({ cookies: VALID_COOKIES, origins: [] }));
    expect(() => importAuth({ input: JSON.stringify([{ name: 'A' }]), env })).toThrow(/不构成标准 storageState/);
    // 旧文件不被覆盖
    const onDisk = JSON.parse(fs.readFileSync(target, 'utf-8'));
    expect(onDisk.cookies).toHaveLength(3);
  });

  it('非法 JSON 且非 cookie 头 → 报错', () => {
    expect(() => importAuth({ input: 'not-json-not-cookie', env })).toThrow();
  });

  it('parseAuthInput 单独：storageState 提取 cookies，origins 丢弃', () => {
    const arr = parseAuthInput(JSON.stringify({ cookies: [{ name: 'a', value: '1' }], origins: [{ x: 1 }] }));
    expect(arr).toHaveLength(1);
    expect(arr[0].name).toBe('a');
  });

  it('parseAuthInput 单独：非法 JSON 解析为 cookie 头（需显式 domain）', () => {
    const arr = parseAuthInput('a=b; c=d', 'x.test');
    expect(arr).toHaveLength(2);
    expect(arr[0].domain).toBe('x.test');
    expect(() => parseAuthInput('a=b; c=d')).toThrow(AuthUsageError);
  });
});

// —— T1: 空 name cookie 接受 + 非字符串 name 拒绝 ——

describe('auth import 空 name cookie（T1）', () => {
  let home: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-empty-name-'));
    env = { ...process.env, E2ET_HOME: home };
    delete env.E2ET_CDP_URL;
    delete env.E2ET_AUTH_STATE;
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  /** 真实 storageState 里那条 name="" 的 cookie（子域 host-only） */
  function emptyNameCookie() {
    return {
      name: '',
      value: SECRET,
      domain: 'loginhm.example.test',
      path: '/',
      expires: NOW + 3600,
      httpOnly: true,
      secure: true,
      sameSite: 'Lax' as const,
    };
  }

  it('storageState 含 name:"" → 落盘后空 name 条目仍在，输出不含 SECRET', () => {
    const input = JSON.stringify({
      cookies: [...VALID_COOKIES, emptyNameCookie()],
      origins: [],
    });
    const r = importAuth({ input, env });
    const onDisk = JSON.parse(fs.readFileSync(r.path, 'utf-8'));
    const empty = onDisk.cookies.find((c: any) => c.name === '');
    expect(empty).toBeDefined();
    expect(empty.domain).toBe('loginhm.example.test');
    expectNoSecret(JSON.stringify(r.summary));
  });

  it('cookies 数组含 name:"" → 落盘后空 name 条目仍在，输出不含 SECRET', () => {
    const input = JSON.stringify([...VALID_COOKIES, emptyNameCookie()]);
    const r = importAuth({ input, env });
    const onDisk = JSON.parse(fs.readFileSync(r.path, 'utf-8'));
    expect(onDisk.cookies.find((c: any) => c.name === '')).toBeDefined();
    expectNoSecret(JSON.stringify(r.summary));
  });

  it('name 非字符串（123）→ 被拒，不落盘', () => {
    const bad = [...VALID_COOKIES, { name: 123, value: SECRET, domain: '.example.test', path: '/', expires: NOW + 3600 }];
    expect(() => importAuth({ input: JSON.stringify(bad), env })).toThrow(/name 不是字符串/);
    expect(fs.existsSync(importedAuthPath(env))).toBe(false);
  });
});

// —— 解析顺序与降级 ——

describe('解析顺序 + --auth 强制 + 降级', () => {
  let home: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-resolve-'));
    env = { ...process.env, E2ET_HOME: home };
    delete env.E2ET_CDP_URL;
    delete env.E2ET_AUTH_STATE;
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  function writeImported(cookies: object[]) {
    const p = importedAuthPath(env);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ cookies, origins: [] }));
    return p;
  }
  function writeExplicitState(cookies: object[]) {
    const p = path.join(home, 'explicit-imported.json');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ cookies, origins: [] }));
    env.E2ET_AUTH_STATE = p;
    return p;
  }

  /** 探测桩：probeErrorMap 命中则返探测失败（技术性失败），否则返回 finalUrl 事实 */
  function fakeProbe(probeErrorMap: Record<string, string> = {}): ProbeAuthFn {
    return async (authPath: string): Promise<ProbeResult> => {
      if (probeErrorMap[authPath]) {
        return { finalUrl: '', probeError: probeErrorMap[authPath] };
      }
      return { finalUrl: 'https://example.test/' };
    };
  }

  it('只有 imported → auto 选 imported', async () => {
    writeImported(VALID_COOKIES);
    const r = await resolveAndProbeAuth({ baseUrl: 'http://127.0.0.1:0', authMode: 'auto', env, probeAuth: fakeProbe() });
    expect(r.authSource).toBe('imported');
  });

  it('显式 state 且 auto → 直接选 imported', async () => {
    writeImported([cookie('DEFAULT')]);
    writeExplicitState(VALID_COOKIES);
    const r = await resolveAndProbeAuth({ baseUrl: 'http://127.0.0.1:0', authMode: 'auto', env, probeAuth: fakeProbe() });
    expect(r.authSource).toBe('imported');
  });

  it('显式 state 与默认 imported 都有 → auto 只消费显式 state', async () => {
    writeImported(VALID_COOKIES);
    writeExplicitState([cookie('EXPLICIT')]);
    const r = await resolveAndProbeAuth({ baseUrl: 'http://127.0.0.1:0', authMode: 'auto', env, probeAuth: fakeProbe() });
    expect(r.authSource).toBe('imported');
  });

  it('都没有 → AuthResolveError 列出两个来源（profile 母本不存在也计入）', async () => {
    await expect(resolveAndProbeAuth({ baseUrl: 'http://127.0.0.1:0', authMode: 'auto', env, probeAuth: fakeProbe() }))
      .rejects.toThrow(/auth resolve 失败/);
    try {
      await resolveAndProbeAuth({ baseUrl: 'http://127.0.0.1:0', authMode: 'auto', env, probeAuth: fakeProbe() });
    } catch (e: any) {
      expect(e.failures).toHaveLength(2);
      expect(e.failures[0].source).toBe('profile');
      expect(e.failures[1].source).toBe('imported');
      expect(e.failures.every((f: any) => f.reason === 'file_missing')).toBe(true);
      expectNoSecret(e.message);
    }
  });

  it('--auth imported 显式 → 只试 imported，不降级', async () => {
    writeImported(VALID_COOKIES);
    fs.mkdirSync(path.join(home, 'e2e-profile', 'Default'), { recursive: true });
    fs.writeFileSync(path.join(home, 'e2e-profile', 'Default', 'Cookies'), 'profile-test-only');
    const importedPath = importedAuthPath(env);
    fs.writeFileSync(path.join(home, 'e2e-profile', 'Local State'), '{}');
    await expect(resolveAndProbeAuth({
      baseUrl: 'http://127.0.0.1:0', authMode: 'imported', env,
      probeAuth: fakeProbe({ [importedPath]: '导航失败: net::ERR_FAILED' }),
    })).rejects.toThrow(/auth resolve 失败/);
    try {
      await resolveAndProbeAuth({
        baseUrl: 'http://127.0.0.1:0', authMode: 'imported', env,
        probeAuth: fakeProbe({ [importedPath]: '导航失败: net::ERR_FAILED' }),
      });
    } catch (e: any) {
      expect(e.failures).toHaveLength(1);
      expect(e.failures[0].source).toBe('imported');
      expect(e.failures[0].reason).toBe('probe_failed');
    }
  });

  it('显式 state 坏格式 → auto 静态拒绝，不回退默认 imported', async () => {
    writeImported(VALID_COOKIES);
    env.E2ET_AUTH_STATE = path.join(home, 'bad-explicit.json');
    fs.writeFileSync(env.E2ET_AUTH_STATE, JSON.stringify({ cookies: [{ name: 'A', value: 'v', domain: '.example.test' }] }));
    try {
      await resolveAndProbeAuth({ baseUrl: 'http://127.0.0.1:0', authMode: 'auto', env, probeAuth: fakeProbe() });
      expect.fail('should throw');
    } catch (e: any) {
      expect(e.failures).toHaveLength(1);
      expect(e.failures.find((failure: any) => failure.source === 'imported')?.reason).toBe('invalid_format');
    }
  });

  it('imported 过期 cookie → 不再静态跳过（到期只是事实），探测通过即选 imported', async () => {
    writeImported([cookie('SESSION_A', NOW - 100)]);
    const r = await resolveAndProbeAuth({ baseUrl: 'http://127.0.0.1:0', authMode: 'auto', env, probeAuth: fakeProbe() });
    expect(r.authSource).toBe('imported');
  });

  it('全部来源探测失败 → AuthResolveError 逐来源列出', async () => {
    const ip = writeExplicitState(VALID_COOKIES);
    fs.mkdirSync(path.join(home, 'e2e-profile', 'Default'), { recursive: true });
    fs.writeFileSync(path.join(home, 'e2e-profile', 'Default', 'Cookies'), 'profile-test-only');
    fs.writeFileSync(path.join(home, 'e2e-profile', 'Local State'), '{}');
    await expect(resolveAndProbeAuth({
      baseUrl: 'http://127.0.0.1:0', authMode: 'auto', env,
      profileProbe: async () => ({ finalUrl: '', probeError: 'profile probe fail' }),
      probeAuth: fakeProbe({ [ip]: 'nav2 fail' }),
    })).rejects.toThrow(/auth resolve 失败/);
  });

  it('N1: --auth imported 探测失败 → AuthResolveError 且 reason=probe_failed', async () => {
    writeImported(VALID_COOKIES);
    const ip = importedAuthPath(env);
    try {
      await resolveAndProbeAuth({
        baseUrl: 'http://127.0.0.1:0', authMode: 'imported', env,
        probeAuth: fakeProbe({ [ip]: '导航抛错: timeout' }),
      });
    } catch (e: any) {
      expect(e.failures).toHaveLength(1);
      expect(e.failures[0].source).toBe('imported');
      expect(e.failures[0].reason).toBe('probe_failed');
      expectNoSecret(e.message);
    }
  });

  it('N1: 两来源都探测失败 → 两条 failure 都列出且 reason=probe_failed', async () => {
    writeImported(VALID_COOKIES);
    const ip = importedAuthPath(env);
    fs.mkdirSync(path.join(home, 'e2e-profile', 'Default'), { recursive: true });
    fs.writeFileSync(path.join(home, 'e2e-profile', 'Default', 'Cookies'), 'profile-test-only');
    fs.writeFileSync(path.join(home, 'e2e-profile', 'Local State'), '{}');
    try {
      await resolveAndProbeAuth({
        baseUrl: 'http://127.0.0.1:0', authMode: 'auto', env,
        profileProbe: async () => ({ finalUrl: '', probeError: 'profile probe fail' }),
        probeAuth: fakeProbe({ [ip]: 'nav2 fail' }),
      });
    } catch (e: any) {
      const probeFails = (e.failures as any[]).filter((f: any) => f.reason === 'probe_failed');
      expect(probeFails).toHaveLength(2);
      expect(probeFails.map((f: any) => f.source)).toEqual(['profile', 'imported']);
    }
  });

  it('preflightAuthSources：全部不可用时不返 valid', () => {
    const pre = preflightAuthSources('auto', env, NOW);
    expect(pre.valid).toEqual([]);
    expect(pre.failures).toHaveLength(2);
  });

  it('preflightAuthSources：imported 可用时返 valid', () => {
    writeImported(VALID_COOKIES);
    const pre = preflightAuthSources('auto', env, NOW);
    expect(pre.valid).toEqual(['imported']);
  });

  it('preflightAuthSources：imported 坏格式 → invalid_format 失败项', () => {
    const p = importedAuthPath(env);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ cookies: [{ name: 'A', value: 'v', domain: '.example.test' }] }));
    const pre = preflightAuthSources('auto', env, NOW);
    expect(pre.valid).toEqual([]);
    const importedFailure = pre.failures.find((f) => f.source === 'imported');
    expect(importedFailure?.reason).toBe('invalid_format');
  });

  it('显式 state 空串或纯空白 → 路径拒绝、诊断明确且不回退 profile', () => {
    fs.mkdirSync(path.join(home, 'e2e-profile', 'Default'), { recursive: true });
    fs.writeFileSync(path.join(home, 'e2e-profile', 'Default', 'Cookies'), 'profile-test-only');
    fs.writeFileSync(path.join(home, 'e2e-profile', 'Local State'), '{}');
    for (const state of ['', ' \t ']) {
      env.E2ET_AUTH_STATE = state;
      expect(() => authStatePath(env)).toThrow(EMPTY_STATE_ERROR);
      expect(preflightAuthSources('auto', env, NOW)).toEqual({
        valid: [],
        failures: [{ source: 'imported', reason: 'invalid_format', detail: EMPTY_STATE_ERROR }],
      });
      expect(staticAuthSourceState('imported', env)).toMatchObject({
        path: '',
        present: false,
        valid: false,
        reason: EMPTY_STATE_ERROR,
      });
    }
  });
});

// —— status 输出形态 ——

describe('auth status', () => {
  let home: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-status-'));
    const executable = path.join(home, 'browser');
    fs.writeFileSync(executable, '#!/bin/sh\n');
    env = { ...process.env, E2ET_HOME: home, BROWSER_REMOTE_DEBUGGING_PORT: '0', BROWSER_EXECUTABLE_PATH: executable };
    delete env.E2ET_CDP_URL;
    delete env.E2ET_AUTH_STATE;
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  function capture(overrides: Partial<RouterDeps> = {}) {
    const stdout: string[] = [];
    return { stdout, deps: { env, homeDir: home, stdout: (s: string) => stdout.push(s), stderr: () => {}, ...overrides } as RouterDeps };
  }
  function envelope(stdout: string[]) { return JSON.parse(stdout.join('')); }

  it('status → exit 0，输出 sources/browser/auto_selected', async () => {
    const c = capture();
    const code = await dispatch(['auth', 'status'], c.deps);
    expect(code).toBe(0);
    const d = envelope(c.stdout).data;
    expect(d.sources).toHaveLength(2);
    expect(d.sources[0].source).toBe('profile');
    expect(d.sources[1].source).toBe('imported');
    expect(d.auto_selected).toBeNull();
  });

  it('status → 都不可用时 auto_selected = null + remediation', async () => {
    const c = capture();
    const code = await dispatch(['auth', 'status'], c.deps);
    expect(code).toBe(0);
    const d = envelope(c.stdout).data;
    expect(d.auto_selected).toBeNull();
    expect(d.remediation.length).toBeGreaterThan(0);
  });

  it.each(['', ' \t '])('status/doctor 明确诊断显式空 state（%j）', async (state) => {
    env.E2ET_AUTH_STATE = state;

    const status = capture();
    expect(await dispatch(['auth', 'status'], status.deps)).toBe(0);
    const statusData = envelope(status.stdout).data;
    expect(statusData.auto_selected).toBeNull();
    expect(statusData.sources.find((source: any) => source.source === 'imported').reason).toBe(EMPTY_STATE_ERROR);

    const doctor = capture();
    expect(await dispatch(['doctor'], doctor.deps)).toBe(3);
    const doctorData = envelope(doctor.stdout);
    expect(doctorData.checks.find((check: any) => check.name === 'auth').detail).toContain(EMPTY_STATE_ERROR);
    expect(doctorData.auth.sources.find((source: any) => source.source === 'imported').reason).toBe(EMPTY_STATE_ERROR);
  });

  it('status → 有 imported 时 auto_selected 是 managed+imported', async () => {
    const p = importedAuthPath(env);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ cookies: VALID_COOKIES, origins: [] }));
    const c = capture();
    const code = await dispatch(['auth', 'status'], c.deps);
    expect(code).toBe(0);
    expect(envelope(c.stdout).data.auto_selected).toEqual({ browser_source: 'managed', auth_source: 'imported' });
  });

  it('9222 可达时 status/doctor 统一选 existing+imported，只读 /json/version', async () => {
    const imported = importedAuthPath(env);
    fs.mkdirSync(path.dirname(imported), { recursive: true });
    fs.writeFileSync(imported, JSON.stringify({ cookies: VALID_COOKIES, origins: [] }));
    env.BROWSER_REMOTE_DEBUGGING_PORT = '9222';
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      requests.push(String(url));
      return { ok: true, json: async () => ({ Browser: 'Chromium/test', webSocketDebuggerUrl: 'ws://browser' }) };
    }));
    try {
      const status = capture();
      expect(await dispatch(['auth', 'status'], status.deps)).toBe(0);
      expect(envelope(status.stdout).data.auto_selected).toEqual({ browser_source: 'existing', auth_source: 'imported' });
      const doctor = capture();
      expect(await dispatch(['doctor'], doctor.deps)).toBe(0);
      expect(envelope(doctor.stdout).data.auth.auto_selected).toEqual({ browser_source: 'existing', auth_source: 'imported' });
      expect(requests).toEqual(['http://127.0.0.1:9222/json/version', 'http://127.0.0.1:9222/json/version']);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('9222 可达但只有 profile 时 status/doctor 都预判 chrome+profile', async () => {
    const cookieFile = path.join(home, 'e2e-profile', 'Default', 'Cookies');
    fs.mkdirSync(path.dirname(cookieFile), { recursive: true });
    fs.writeFileSync(cookieFile, 'encrypted-test-only');
    fs.writeFileSync(path.join(home, 'e2e-profile', 'Local State'), '{}');
    env.CHROME_EXECUTABLE_PATH = env.BROWSER_EXECUTABLE_PATH;
    env.BROWSER_REMOTE_DEBUGGING_PORT = '9222';
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ webSocketDebuggerUrl: 'ws://browser' }) })));
    try {
      const status = capture();
      expect(await dispatch(['auth', 'status'], status.deps)).toBe(0);
      const selected = envelope(status.stdout).data.auto_selected;
      expect(selected).toEqual({ browser_source: 'chrome-profile', auth_source: 'profile' });
      const doctor = capture();
      expect(await dispatch(['doctor'], doctor.deps)).toBe(0);
      expect(envelope(doctor.stdout).data.auth.auto_selected).toEqual(selected);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('staticAuthSourceState：imported 坏格式 → present=true, valid=false', () => {
    const p = importedAuthPath(env);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ cookies: [{ name: 'A', value: 'v', domain: '.example.test' }] }));
    const st = staticAuthSourceState('imported', env);
    expect(st.present).toBe(true);
    expect(st.valid).toBe(false);
  });

  it('staticAuthSourceState：imported 过期 cookie → valid=true（到期是事实）', () => {
    const p = importedAuthPath(env);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    // 相对真实 now 过期（staticAuthSourceState 内部用当前时间）
    const realNow = Math.floor(Date.now() / 1000);
    fs.writeFileSync(p, JSON.stringify({ cookies: [cookie('SESSION_A', realNow - 100)], origins: [] }));
    const st = staticAuthSourceState('imported', env);
    expect(st.present).toBe(true);
    expect(st.valid).toBe(true);
    expect(st.expired).toEqual(['SESSION_A']);
  });

  it('staticAuthSourceState：profile 母本不完整 → valid=false，reason 含缺少项', () => {
    const master = path.join(home, 'e2e-profile');
    fs.mkdirSync(path.join(master, 'Default'), { recursive: true });
    fs.writeFileSync(path.join(master, 'Default', 'Cookies'), 'enc');
    // 缺 Local State
    const st = staticAuthSourceState('profile', env);
    expect(st.present).toBe(true);
    expect(st.valid).toBe(false);
    expect(st.reason).toContain('Local State');
  });

  it('staticAuthSourceState：profile 完整 → valid=null（业务有效性留待探测）', () => {
    const master = path.join(home, 'e2e-profile');
    fs.mkdirSync(path.join(master, 'Default'), { recursive: true });
    fs.writeFileSync(path.join(master, 'Default', 'Cookies'), 'enc');
    fs.writeFileSync(path.join(master, 'Local State'), '{}');
    const st = staticAuthSourceState('profile', env);
    expect(st.present).toBe(true);
    expect(st.valid).toBeNull();
    expect(st.reason).toBeUndefined();
  });
});

// —— doctor auth 检查形态 ——

describe('doctor auth 多来源', () => {
  let home: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-auth-'));
    const executable = path.join(home, 'browser');
    fs.writeFileSync(executable, '#!/bin/sh\n');
    env = { ...process.env, E2ET_HOME: home, BROWSER_REMOTE_DEBUGGING_PORT: '0', BROWSER_EXECUTABLE_PATH: executable };
    delete env.E2ET_CDP_URL;
    delete env.E2ET_AUTH_STATE;
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  function capture(overrides: Partial<RouterDeps> = {}) {
    const stdout: string[] = [];
    return { stdout, deps: { env, homeDir: home, stdout: (s: string) => stdout.push(s), stderr: () => {}, ...overrides } as RouterDeps };
  }
  function envelope(stdout: string[]) { return JSON.parse(stdout.join('')); }

  it('都不可用 + managed 模式 → auth fail + exit 3', async () => {
    const c = capture();
    const code = await dispatch(['doctor'], c.deps);
    expect(code).toBe(3);
    const e = envelope(c.stdout);
    expect(e.ok).toBe(false);
    const authCheck = e.checks.find((x: any) => x.name === 'auth');
    expect(authCheck.status).toBe('fail');
    expect(e.auth.auto_selected).toBeNull();
    expect(e.auth.sources).toHaveLength(2);
  });

  it('imported 可用 → auth ok', async () => {
    const p = importedAuthPath(env);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ cookies: VALID_COOKIES, origins: [] }));
    const c = capture();
    const code = await dispatch(['doctor'], c.deps);
    expect(code).toBe(0);
    const e = envelope(c.stdout);
    const authCheck = e.data.checks.find((x: any) => x.name === 'auth');
    expect(authCheck.status).toBe('ok');
    expect(e.data.auth.auto_selected).toEqual({ browser_source: 'managed', auth_source: 'imported' });
  });
});

// —— session start 响应带 auth_source / browser_source ——

describe('session start 响应 auth_source / browser_source', () => {
  let home: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-auth-'));
    env = { ...process.env, E2ET_HOME: home };
    delete env.E2ET_CDP_URL;
    delete env.E2ET_AUTH_STATE;
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it('readyWaiter 写入带 auth_source/browser_source 的 meta → 响应含字段', async () => {
    const stdout: string[] = [];
    const deps: RouterDeps = {
      env,
      homeDir: home,
      stdout: (s) => stdout.push(s),
      stderr: () => {},
      spawner: () => void 0,
      readyWaiter: async (_socket, id, _timeout) => {
        const { writeMeta, resolveSocketPath } = await import('../daemon/session-meta.js');
        writeMeta({
          id,
          pid: 12345,
          socket: resolveSocketPath(id, env),
          started_at: Date.now(),
          env: 'pre',
          auth_source: 'imported',
          browser_source: 'managed',
        }, env);
        return { ready: true };
      },
    };
    const code = await dispatch(['session', 'start', '--auth', 'imported'], deps);
    expect(code).toBe(0);
    const e = JSON.parse(stdout.join(''));
    expect(e.ok).toBe(true);
    expect(e.data.auth_source).toBe('imported');
    expect(e.data.browser_source).toBe('managed');
  });

  it('readyWaiter 写入无 auth_source 的 meta → 响应不含字段', async () => {
    const stdout: string[] = [];
    const deps: RouterDeps = {
      env,
      homeDir: home,
      stdout: (s) => stdout.push(s),
      stderr: () => {},
      spawner: () => void 0,
      readyWaiter: async (_socket, id, _timeout) => {
        const { writeMeta, resolveSocketPath } = await import('../daemon/session-meta.js');
        writeMeta({
          id,
          pid: 12345,
          socket: resolveSocketPath(id, env),
          started_at: Date.now(),
          env: 'pre',
          browser_source: 'existing',
        }, env);
        return { ready: true };
      },
    };
    const code = await dispatch(['session', 'start'], deps);
    expect(code).toBe(0);
    const e = JSON.parse(stdout.join(''));
    expect(e.data.auth_source).toBeUndefined();
    expect(e.data.browser_source).toBe('existing');
  });

  it('session start --auth invalid → exit 2', async () => {
    const stdout: string[] = [];
    const deps: RouterDeps = { env, homeDir: home, stdout: (s) => stdout.push(s), stderr: () => {} };
    const code = await dispatch(['session', 'start', '--auth', 'bogus'], deps);
    expect(code).toBe(2);
  });

  it('commands --json 含 auth import / auth status / session start --auth', async () => {
    const stdout: string[] = [];
    const deps: RouterDeps = { env, homeDir: home, stdout: (s) => stdout.push(s), stderr: () => {} };
    await dispatch(['commands', '--json'], deps);
    const cmds = JSON.parse(stdout.join('')).data.commands;
    const names = cmds.map((c: any) => (c.subcommand ? `${c.name} ${c.subcommand}` : c.name));
    expect(names).toContain('auth import');
    expect(names).toContain('auth status');
    const ssArgs = cmds.find((c: any) => c.name === 'session' && c.subcommand === 'start').args.map((a: any) => a.name);
    expect(ssArgs).toContain('--auth');
  });
});


// —— B2: auth import CLI dispatch 级 + N7 auth status 多余参数 ——

describe('auth import dispatch（B2）', () => {
  let home: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-import-cli-'));
    env = { ...process.env, E2ET_HOME: home };
    delete env.E2ET_CDP_URL;
    delete env.E2ET_AUTH_STATE;
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  function capture(overrides: Partial<RouterDeps> = {}) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    return {
      stdout, stderr,
      deps: { env, homeDir: home, stdout: (s: string) => stdout.push(s), stderr: (s: string) => stderr.push(s), ...overrides } as RouterDeps,
    };
  }
  function writeFile(name: string, content: string): string {
    const fp = path.join(home, name);
    fs.writeFileSync(fp, content, 'utf-8');
    return fp;
  }
  function envelope(stdout: string[]) { return JSON.parse(stdout.join('')); }

  it('P4 文件 格式1 storageState JSON（合法 origins）→ exit 0，stdout/stderr 不含 SECRET', async () => {
    const input = JSON.stringify({ cookies: VALID_COOKIES, origins: [{ origin: 'https://example.test', localStorage: [{ name: 'k', value: 'v' }] }] });
    const fp = writeFile('ss.json', input);
    const c = capture();
    const code = await dispatch(['auth', 'import', fp], c.deps);
    expect(code).toBe(0);
    const d = envelope(c.stdout).data;
    expect(d.summary.cookies).toBe(3);
    expectNoSecret(c.stdout.join(''));
    expectNoSecret(c.stderr.join(''));
  });

  it('文件 格式2 cookies 数组 → exit 0，stdout/stderr 不含 SECRET', async () => {
    const fp = writeFile('arr.json', JSON.stringify(VALID_COOKIES));
    const c = capture();
    const code = await dispatch(['auth', 'import', fp], c.deps);
    expect(code).toBe(0);
    expect(envelope(c.stdout).data.summary.cookies).toBe(3);
    expectNoSecret(c.stdout.join(''));
    expectNoSecret(c.stderr.join(''));
  });

  it('文件 格式3 cookie 头字符串 + --domain → exit 0，落盘 domain 来自 --domain', async () => {
    const fp = writeFile('header.txt', `SESSION_A=${SECRET}; X-XSRF-TOKEN=abc123`);
    const c = capture();
    const code = await dispatch(['auth', 'import', fp, '--domain', 'caller.example.org'], c.deps);
    expect(code).toBe(0);
    expect(envelope(c.stdout).data.summary.cookies).toBe(2);
    const onDisk = JSON.parse(fs.readFileSync(importedAuthPath(env), 'utf-8'));
    expect(onDisk.cookies[0].domain).toBe('caller.example.org');
    expectNoSecret(c.stdout.join(''));
    expectNoSecret(c.stderr.join(''));
  });

  it('文件 格式3 cookie 头字符串缺 --domain → exit 2（USAGE），目标文件不落盘', async () => {
    const fp = writeFile('header.txt', `SESSION_A=${SECRET}; X-XSRF-TOKEN=abc123`);
    const c = capture();
    const code = await dispatch(['auth', 'import', fp], c.deps);
    expect(code).toBe(2);
    const e = envelope(c.stdout);
    expect(e.ok).toBe(false);
    expect(e.error.code).toBe('USAGE');
    expect(e.error.message).toContain('--domain');
    expect(e.error.message).toContain('操作指引');
    expect(fs.existsSync(importedAuthPath(env))).toBe(false);
    expectNoSecret(c.stdout.join(''));
    expectNoSecret(c.stderr.join(''));
  });

  it('stdin 注入（readStdin）→ exit 0，stdout/stderr 不含 SECRET', async () => {
    const c = capture({ readStdin: async () => JSON.stringify(VALID_COOKIES) });
    const code = await dispatch(['auth', 'import'], c.deps);
    expect(code).toBe(0);
    expect(envelope(c.stdout).data.summary.cookies).toBe(3);
    expectNoSecret(c.stdout.join(''));
    expectNoSecret(c.stderr.join(''));
  });

  it('过期 cookie 输入 → exit 0（到期是事实），落盘成功，stdout/stderr 不含 SECRET', async () => {
    // dispatch 不传 nowSec，按真实时间校验；过期 cookie 相对真实 now 过期
    const realNow = Math.floor(Date.now() / 1000);
    const expired = [cookie('SESSION_A', realNow - 100)];
    const fp = writeFile('expired.json', JSON.stringify(expired));
    const c = capture();
    const code = await dispatch(['auth', 'import', fp], c.deps);
    expect(code).toBe(0);
    expect(fs.existsSync(importedAuthPath(env))).toBe(true);
    expectNoSecret(c.stdout.join(''));
    expectNoSecret(c.stderr.join(''));
  });

  it('文件不存在 → exit 1（AUTH_FAILED），stdout/stderr 不含 SECRET', async () => {
    const c = capture();
    const code = await dispatch(['auth', 'import', path.join(home, 'nope.json')], c.deps);
    expect(code).toBe(1);
    expect(envelope(c.stdout).ok).toBe(false);
    expectNoSecret(c.stdout.join(''));
    expectNoSecret(c.stderr.join(''));
  });
});

// —— N6: CDP_URL status 脱敏 + N7: auth status 多余参数 ——

describe('auth status CDP_URL 脱敏 + 多余参数（N6/N7）', () => {
  let home: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-status-cdp-'));
    env = { ...process.env, E2ET_HOME: home };
    delete env.E2ET_CDP_URL;
    delete env.E2ET_AUTH_STATE;
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  function capture() {
    const stdout: string[] = [];
    return { stdout, deps: { env, homeDir: home, stdout: (s: string) => stdout.push(s), stderr: () => {} } as RouterDeps };
  }
  function envelope(stdout: string[]) { return JSON.parse(stdout.join('')); }

  it('设 E2ET_CDP_URL → endpoint 已 redactEndpoint 脱敏（只显示 origin/host）', async () => {
    const SECRET_URL = 'http://token-user:secret-pass@cdp.example.com:9222/devtools/page/abc?token=hunter2';
    env.E2ET_CDP_URL = SECRET_URL;
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ webSocketDebuggerUrl: 'ws://browser' }) })));
    const c = capture();
    const code = await dispatch(['auth', 'status'], c.deps);
    vi.unstubAllGlobals();
    expect(code).toBe(0);
    const d = envelope(c.stdout).data;
    expect(d.browser.kind).toBe('existing');
    const ep = d.browser.endpoint as string;
    // 只保留 protocol//host[:port]，不含 userinfo/query/path token
    expect(ep).toBe('http://cdp.example.com:9222');
    const all = c.stdout.join('');
    expect(all).not.toContain('token-user');
    expect(all).not.toContain('secret-pass');
    expect(all).not.toContain('hunter2');
    expect(all).not.toContain('/devtools/page/abc');
  });

  it('auth status 多余位置参数 → exit 2（N7）', async () => {
    const c = capture();
    const code = await dispatch(['auth', 'status', 'unexpected'], c.deps);
    expect(code).toBe(2);
    expect(envelope(c.stdout).ok).toBe(false);
  });
});

// —— B2: injectAndProbeAuthState 注入与探测语义（假 CDP ws，不起 Chrome）——

describe('injectAndProbeAuthState 非通过即清（B2）', () => {
  let home: string;
  let env: NodeJS.ProcessEnv;
  let httpServer: http.Server;
  let wss: WebSocketServer;
  let httpPort = 0;
  let wsPort = 0;
  // N2: 被测函数读 process.env.E2ET_AUTH_PROBE_URL（不是局部 env），要存删 process.env
  let savedProbeUrl: string | undefined;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'b2-fakecdp-'));
    env = { ...process.env, E2ET_HOME: home };
    delete env.E2ET_CDP_URL;
    delete env.E2ET_AUTH_STATE;
    // N2: 保存并删除 process.env 上的探测 URL，避免开发机 shell 设置污染假 CDP
    savedProbeUrl = process.env.E2ET_AUTH_PROBE_URL;
    delete process.env.E2ET_AUTH_PROBE_URL;
  });
  afterEach(async () => {
    await new Promise<void>((r) => wss.close(() => r()));
    await new Promise<void>((r) => httpServer.close(() => r()));
    fs.rmSync(home, { recursive: true, force: true });
    // N2: 恢复 process.env
    if (savedProbeUrl === undefined) delete process.env.E2ET_AUTH_PROBE_URL;
    else process.env.E2ET_AUTH_PROBE_URL = savedProbeUrl;
  });

  function writeAuthFile(cookies: object[]): string {
    const p = path.join(home, 'state.json');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    // expires 用 -1（session 级），到期不算失败（新语义下到期只是事实）
    const session = cookies.map((c: any) => ({ ...c, expires: -1 }));
    fs.writeFileSync(p, JSON.stringify({ cookies: session, origins: [] }));
    return p;
  }

  /** 启动假 CDP：http /json/version + ws，按 opts 脚本化响应，记录所有 method */
  async function startFakeCdp(opts: {
    navErrorText?: string;
    emitLoadAfterNav?: boolean;
    finalUrl?: string;
  }): Promise<{ methods: string[]; baseUrl: string }> {
    const methods: string[] = [];
    await new Promise<void>((resolve) => {
      httpServer = http.createServer((req, res) => {
        if (req.url === '/json/version') {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${wsPort}/cdp` }));
        } else {
          res.statusCode = 404;
          res.end();
        }
      });
      httpServer.listen(0, '127.0.0.1', () => {
        httpPort = (httpServer.address() as any).port;
        resolve();
      });
    });
    await new Promise<void>((resolve) => {
      wss = new WebSocketServer({ port: 0, host: '127.0.0.1', path: '/cdp' });
      wss.on('listening', () => {
        wsPort = (wss.address() as any).port;
        resolve();
      });
      wss.on('connection', (ws: WebSocket) => {
        ws.on('message', (raw: Buffer) => {
          const msg = JSON.parse(raw.toString());
          const { id, method, params, sessionId } = msg;
          methods.push(method);
          const reply = (result: any) => {
            ws.send(JSON.stringify({ id, result, ...(sessionId ? { sessionId } : {}) }));
          };
          if (method === 'Target.getTargets') {
            reply({ targetInfos: [{ targetId: 'p1', type: 'page' }] });
          } else if (method === 'Target.attachToTarget') {
            reply({ sessionId: 's1' });
          } else if (method === 'Page.navigate' && params.url && params.url !== 'about:blank') {
            // 显式探测导航
            if (opts.navErrorText) {
              reply({ errorText: opts.navErrorText });
              return;
            }
            reply({});
            if (opts.emitLoadAfterNav) {
              setTimeout(() => ws.send(JSON.stringify({ method: 'Page.loadEventFired', params: {} })), 5);
            }
          } else if (method === 'Runtime.evaluate') {
            reply({ result: { value: opts.finalUrl ?? 'https://example.test/after-probe' } });
          } else {
            reply({});
          }
        });
      });
    });
    return { methods, baseUrl: `http://127.0.0.1:${httpPort}` };
  }

  it('无 E2ET_AUTH_PROBE_URL → 不导航任何页面，返回当前 URL，注入后不清 cookie', async () => {
    const authPath = writeAuthFile(VALID_COOKIES);
    const { methods, baseUrl } = await startFakeCdp({ finalUrl: 'about:blank' });
    const r = await injectAndProbeAuthState(baseUrl, authPath);
    expect(r.probeError).toBeUndefined();
    expect(r.finalUrl).toBe('about:blank');
    // 没有显式探测 URL：不导航业务页面（只有 about:blank 的回退导航也不该有）
    expect(methods).not.toContain('Page.navigate');
    expect(methods).toContain('Network.setCookies');
    expect(methods).not.toContain('Network.clearBrowserCookies');
  });

  it('probeError（导航 errorText）→ finally 调 clearBrowserCookies', async () => {
    process.env.E2ET_AUTH_PROBE_URL = 'https://probe.example.test/';
    const authPath = writeAuthFile(VALID_COOKIES);
    const { methods, baseUrl } = await startFakeCdp({ navErrorText: 'net::ERR_FAILED' });
    const r = await injectAndProbeAuthState(baseUrl, authPath);
    expect(r.probeError).toMatch(/导航失败/);
    expect(methods).toContain('Network.clearBrowserCookies');
  });

  it('显式探测 URL 导航成功 → 通过，不调 clearBrowserCookies', async () => {
    process.env.E2ET_AUTH_PROBE_URL = 'https://probe.example.test/';
    const authPath = writeAuthFile(VALID_COOKIES);
    const { methods, baseUrl } = await startFakeCdp({
      emitLoadAfterNav: true,
      finalUrl: 'https://probe.example.test/',
    });
    const r = await injectAndProbeAuthState(baseUrl, authPath);
    expect(r.probeError).toBeUndefined();
    expect(r.finalUrl).toBe('https://probe.example.test/');
    expect(methods).not.toContain('Network.clearBrowserCookies');
  });

  it('非法 E2ET_AUTH_PROBE_URL → 导航前拒绝（不触达 Page.navigate）', async () => {
    process.env.E2ET_AUTH_PROBE_URL = 'ftp://bad.example.test/';
    const authPath = writeAuthFile(VALID_COOKIES);
    const { methods, baseUrl } = await startFakeCdp({});
    await expect(injectAndProbeAuthState(baseUrl, authPath)).rejects.toThrow(/E2ET_AUTH_PROBE_URL/);
    expect(methods).not.toContain('Page.navigate');
  });
});

// —— probeAuthState 语义单测（假 session）——

describe('probeAuthState（显式/缺省 URL 语义）', () => {
  function fakeSession(handlers: Record<string, (params?: any) => any>) {
    const calls: string[] = [];
    const listeners: Array<{ method: string; handler: (params: any) => void }> = [];
    return {
      calls,
      session: {
        send: async (method: string, params?: any) => {
          calls.push(method);
          const h = handlers[method];
          if (h) return h(params);
          return {};
        },
        addEventListener: (method: string, handler: (params: any) => void) => {
          listeners.push({ method, handler });
          return () => {};
        },
        close: () => {},
      } as any,
      emitLoad: () => { for (const l of listeners) if (l.method === 'Page.loadEventFired') l.handler({}); },
    };
  }

  it('缺省 URL：只读当前 location.href，不导航', async () => {
    const { session, calls } = fakeSession({
      'Runtime.evaluate': () => ({ result: { value: 'https://current.example.test/page' } }),
    });
    const r = await probeAuthState(session, 'sid');
    expect(r).toEqual({ finalUrl: 'https://current.example.test/page' });
    expect(calls).not.toContain('Page.navigate');
  });

  it('缺省 URL：读 URL 抛错 → probeError', async () => {
    const { session } = fakeSession({
      'Runtime.evaluate': () => { throw new Error('context destroyed'); },
    });
    const r = await probeAuthState(session, 'sid');
    expect(r.probeError).toContain('读取当前 URL 失败');
    expect(r.finalUrl).toBe('');
  });

  it('load 事件不触发、中间 URL 不算，最终 origin+pathname 命中才成功', async () => {
    let reads = 0;
    const listeners: string[] = [];
    const session = {
      send: async (method: string) => {
        if (method === 'Runtime.evaluate') {
          reads++;
          return {
            result: {
              value: reads < 3
                ? 'https://login.example.test/preLogin2.htm'
                : 'https://app.example.test/home?token=secret',
            },
          };
        }
        return {};
      },
      addEventListener: (method: string) => { listeners.push(method); return () => {}; },
      close: () => {},
    };
    const r = await probeAuthState(
      session as any,
      'sid',
      'https://app.example.test/home?input=secret',
      { expectedUrl: 'https://app.example.test/home', totalTimeoutMs: 300, pollIntervalMs: 10 },
    );
    expect(r.probeError).toBeUndefined();
    expect(r.finalUrl).toBe('https://app.example.test/home?token=secret');
    expect(reads).toBe(3);
    expect(listeners).not.toContain('Page.loadEventFired');
  });

  it('expected URL 未命中 → 超时失败且诊断 URL 去 query', async () => {
    const session = {
      send: async (method: string) => {
        if (method === 'Runtime.evaluate') {
          return { result: { value: 'https://login.example.test/preLogin2.htm?token=secret' } };
        }
        return {};
      },
      addEventListener: () => () => {},
      close: () => {},
    };
    const r = await probeAuthState(
      session as any,
      'sid',
      'https://app.example.test/home',
      { expectedUrl: 'https://app.example.test/home', totalTimeoutMs: 40, pollIntervalMs: 10 },
    );
    expect(r.probeError).toContain('未在 1s 内到达期望 URL');
    expect(r.probeError).toContain('https://login.example.test/preLogin2.htm');
    expect(r.probeError).not.toContain('secret');
  });

  it('Page.navigate 15s CDP timeout 后继续轮询，URL 最终命中仍成功', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      let reads = 0;
      const session = {
        send: async (method: string, params?: { url?: string }) => {
          if (method === 'Page.navigate' && params?.url !== 'about:blank') {
            return await new Promise((_resolve, reject) => {
              setTimeout(() => reject(new Error('CDP Page.navigate 超时')), 15_000);
            });
          }
          if (method === 'Runtime.evaluate') {
            reads++;
            return {
              result: {
                value: reads <= 15
                  ? 'https://login.example.test/preLogin2.htm'
                  : 'https://app.example.test/home',
              },
            };
          }
          return {};
        },
        addEventListener: () => () => {},
        close: () => {},
      };
      const pending = probeAuthState(
        session as any,
        'sid',
        'https://app.example.test/home',
        { expectedUrl: 'https://app.example.test/home', totalTimeoutMs: 60_000, pollIntervalMs: 1_000 },
      );
      await vi.advanceTimersByTimeAsync(21_000);
      const r = await pending;
      expect(r.probeError).toBeUndefined();
      expect(r.finalUrl).toBe('https://app.example.test/home');
      expect(reads).toBeGreaterThanOrEqual(16);
    } finally {
      vi.useRealTimers();
    }
  });
});
