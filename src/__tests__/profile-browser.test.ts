/**
 * profile-browser 单测：域名过滤 / 副本复制与回收 / resolve 顺序（profile 优先）。
 * 不起真浏览器；resolve 顺序用注入 profileProbe + probeAuth 模拟。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  domainMatches,
  isAtUrl,
  stripQuery,
  writeExportResult,
  copyProfileForSession,
  cleanupProfileCopy,
  profileMasterPath,
  PROFILE_SKIP_DIRS,
  profileMasterComplete,
  snapshotMasterMtimes,
  checkMasterMtimes,
} from '../browser/profile-browser.js';
import {
  resolveAndProbeAuth,
  preflightAuthSources,
  importedAuthPath,
  type ProbeResult,
  importAuth,
  parseAuthInput,
} from '../auth-resolve.js';
import { probeAuthState } from '../browser/managed-browser.js';
import { dispatch } from '../cli/router.js';
import type { RouterDeps } from '../cli/context.js';

const NOW = 1_800_000_000;
const SECRET = 'SECRET_VALUE_xyz789';
function cookie(name: string, expires = NOW + 3600) {
  return { name, value: SECRET, domain: '.example.test', path: '/', expires, httpOnly: true, secure: true, sameSite: 'Lax' as const };
}
const VALID_COOKIES = [cookie('SESSION_A'), cookie('SESSION_B'), cookie('OTHER')];

function okResult(): ProbeResult {
  return { finalUrl: 'https://example.test/' };
}
function failResult(msg = 'probe boom'): ProbeResult {
  return { finalUrl: '', probeError: msg };
}

// —— 通用域匹配边界（任意调用方域）——

describe('domainMatches（点边界后缀）', () => {
  it('精确与带前导点 cookie domain 通过', () => {
    expect(domainMatches('example.test', 'example.test')).toBe(true);
    expect(domainMatches('example.test', '.example.test')).toBe(true);
  });
  it('cookie 域作用于子域 host', () => {
    expect(domainMatches('sub.example.test', 'example.test')).toBe(true);
    expect(domainMatches('sub.example.test', '.example.test')).toBe(true);
    expect(domainMatches('a.b.example.test', 'example.test')).toBe(true);
  });
  it('更深的 cookie 域不作用于父域 host', () => {
    expect(domainMatches('example.test', 'sub.example.test')).toBe(false);
  });
  it('noexample.test 排除（后缀骗局）', () => {
    expect(domainMatches('noexample.test', 'example.test')).toBe(false);
  });
  it('example.test.evil.test 不被 example.test 的父域匹配 / 反向同拒', () => {
    // cookie domain=example.test.evil.test 不作用于 host=test.evil.test（点边界）
    expect(domainMatches('test.evil.test', 'example.test.evil.test')).toBe(false);
    // cookie domain=evil.test 作用于 host=example.test.evil.test 是 cookie 语义（子域收 cookie）
    expect(domainMatches('example.test.evil.test', 'evil.test')).toBe(true);
    // 但 cookie domain=evil.test 不作用于 host=test.evil（非点边界后缀）
    expect(domainMatches('test.evil', 'evil.test')).toBe(false);
  });
  it('空字符串排除', () => {
    expect(domainMatches('', 'example.test')).toBe(false);
    expect(domainMatches('example.test', '')).toBe(false);
    expect(domainMatches('example.test', '.')).toBe(false);
  });
});

// —— 副本复制与回收 ——

describe('copyProfileForSession / cleanupProfileCopy', () => {
  let master: string;
  let sid: string;

  beforeEach(() => {
    master = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-master-'));
    sid = 's_test1234';
    // 造母本目录结构
    fs.mkdirSync(path.join(master, 'Default'), { recursive: true });
    fs.writeFileSync(path.join(master, 'Default', 'Cookies'), 'fake-cookie-db');
    fs.writeFileSync(path.join(master, 'Default', 'Preferences'), '{}');
    fs.writeFileSync(path.join(master, 'Local State'), '{}');
    // 单例锁（副本必须删）
    for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      fs.writeFileSync(path.join(master, f), 'lock');
    }
    // 缓存类目录（副本必须跳过）
    for (const d of ['Cache', 'Code Cache', 'GPUCache', 'ShaderCache', 'Service Worker']) {
      fs.mkdirSync(path.join(master, d), { recursive: true });
      fs.writeFileSync(path.join(master, d, 'blob'), 'x');
    }
  });
  afterEach(() => { fs.rmSync(master, { recursive: true, force: true }); });

  it('副本删 Singleton*、跳过缓存目录、保留 Default/Cookies', () => {
    const copy = copyProfileForSession(master, sid);
    try {
      // 前缀符合孤儿回收约定
      expect(path.basename(copy)).toMatch(new RegExp(`^e2et-${sid}-`));
      expect(path.dirname(copy)).toBe(path.resolve(os.tmpdir()));
      // Singleton* 删除
      for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
        expect(fs.existsSync(path.join(copy, f))).toBe(false);
      }
      // 缓存目录跳过
      for (const d of ['Cache', 'Code Cache', 'GPUCache', 'ShaderCache', 'Service Worker']) {
        expect(fs.existsSync(path.join(copy, d))).toBe(false);
      }
      // 业务文件保留
      expect(fs.existsSync(path.join(copy, 'Default', 'Cookies'))).toBe(true);
      expect(fs.readFileSync(path.join(copy, 'Default', 'Cookies'), 'utf-8')).toBe('fake-cookie-db');
      expect(fs.existsSync(path.join(copy, 'Default', 'Preferences'))).toBe(true);
    } finally {
      cleanupProfileCopy(copy);
    }
  });

  it('cleanupProfileCopy 删除副本目录', () => {
    const copy = copyProfileForSession(master, sid);
    expect(fs.existsSync(copy)).toBe(true);
    cleanupProfileCopy(copy);
    expect(fs.existsSync(copy)).toBe(false);
  });

  it('PROFILE_SKIP_DIRS 覆盖关键缓存目录', () => {
    for (const d of ['Cache', 'Code Cache', 'GPUCache', 'ShaderCache', 'Service Worker']) {
      expect(PROFILE_SKIP_DIRS.has(d)).toBe(true);
    }
  });
});

// —— 工作包 2：母本完整性 + mtime 只读守卫 ——

describe('profileMasterComplete 母本完整性', () => {
  let home: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-complete-'));
    env = { ...process.env, E2ET_HOME: home };
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it('Default + Local State + Cookies 齐全 → complete', () => {
    const master = profileMasterPath(env);
    fs.mkdirSync(path.join(master, 'Default'), { recursive: true });
    fs.writeFileSync(path.join(master, 'Default', 'Cookies'), 'x');
    fs.writeFileSync(path.join(master, 'Local State'), '{}');
    expect(profileMasterComplete(env)).toEqual({ complete: true, missing: [] });
  });

  it('有 Network/Cookies 也算完整', () => {
    const master = profileMasterPath(env);
    fs.mkdirSync(path.join(master, 'Default', 'Network'), { recursive: true });
    fs.writeFileSync(path.join(master, 'Default', 'Network', 'Cookies'), 'x');
    fs.writeFileSync(path.join(master, 'Local State'), '{}');
    expect(profileMasterComplete(env)).toEqual({ complete: true, missing: [] });
  });

  it('缺 Local State → incomplete', () => {
    const master = profileMasterPath(env);
    fs.mkdirSync(path.join(master, 'Default'), { recursive: true });
    fs.writeFileSync(path.join(master, 'Default', 'Cookies'), 'x');
    const r = profileMasterComplete(env);
    expect(r.complete).toBe(false);
    expect(r.missing).toContain('Local State');
  });

  it('Default 目录不存在 → 缺 Default', () => {
    expect(profileMasterComplete(env)).toEqual({ complete: false, missing: ['Default'] });
  });
});

describe('mtime 只读守卫', () => {
  let home: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-mtime-'));
    env = { ...process.env, E2ET_HOME: home };
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  function writeProfile() {
    const master = profileMasterPath(env);
    fs.mkdirSync(path.join(master, 'Default'), { recursive: true });
    fs.writeFileSync(path.join(master, 'Default', 'Cookies'), 'enc');
    fs.writeFileSync(path.join(master, 'Local State'), '{}');
  }

  it('快照前后一致 → 无修改', () => {
    writeProfile();
    const snap = snapshotMasterMtimes(env);
    expect(checkMasterMtimes(snap, env)).toEqual([]);
  });

  it('修改 Local State 后 → 检测到变化', async () => {
    writeProfile();
    const snap = snapshotMasterMtimes(env);
    await new Promise((r) => setTimeout(r, 1100));
    fs.writeFileSync(path.join(profileMasterPath(env), 'Local State'), '{"modified":true}');
    const modified = checkMasterMtimes(snap, env);
    expect(modified).toContain('Local State');
  });

  it('删除文件 → 检测到变化', () => {
    writeProfile();
    const snap = snapshotMasterMtimes(env);
    fs.rmSync(path.join(profileMasterPath(env), 'Local State'));
    const modified = checkMasterMtimes(snap, env);
    expect(modified).toContain('Local State');
  });
});

// —— resolve 顺序：profile 优先 ——

describe('resolveAndProbeAuth profile 顺序', () => {
  let home: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-resolve-'));
    env = { ...process.env, E2ET_HOME: home };
    delete env.E2ET_CDP_URL;
    delete env.E2ET_AUTH_STATE;
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  function writeProfile() {
    const masterDir = profileMasterPath(env);
    fs.mkdirSync(path.join(masterDir, 'Default'), { recursive: true });
    fs.writeFileSync(path.join(masterDir, 'Default', 'Cookies'), 'enc-cookie-db');
    fs.writeFileSync(path.join(masterDir, 'Local State'), '{}');
  }
  function writeImported() {
    const p = importedAuthPath(env);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ cookies: VALID_COOKIES, origins: [] }));
  }

  it('auto 顺序：profile → imported（profile 成功即返回，不调 imported）', async () => {
    writeProfile();
    writeImported();
    let profileCalled = false;
    let importedCalled = false;
    const r = await resolveAndProbeAuth({
      baseUrl: 'http://127.0.0.1:0',
      authMode: 'auto',
      env,
      profileProbe: async () => { profileCalled = true; return okResult(); },
      probeAuth: async (ap: string) => {
        if (ap === importedAuthPath(env)) { importedCalled = true; return okResult(); }
        return okResult();
      },
    });
    expect(r.authSource).toBe('profile');
    expect(profileCalled).toBe(true);
    expect(importedCalled).toBe(false);
  });

  it('profile 探测失败（probeError）→ 降级到 imported', async () => {
    writeProfile();
    writeImported();
    const r = await resolveAndProbeAuth({
      baseUrl: 'http://127.0.0.1:0',
      authMode: 'auto',
      env,
      profileProbe: async () => failResult('profile nav fail'),
      probeAuth: async (ap: string) => ap === importedAuthPath(env) ? okResult() : failResult('ci fail'),
    });
    expect(r.authSource).toBe('imported');
  });

  it('--auth profile：只试 profile，失败抛 AuthResolveError', async () => {
    writeProfile();
    await expect(resolveAndProbeAuth({
      baseUrl: 'http://127.0.0.1:0',
      authMode: 'profile',
      env,
      profileProbe: async () => failResult('profile down'),
    })).rejects.toThrow(/auth resolve 失败/);
  });

  it('有 cdpUrl 时 profile 标 not_applicable，跳过', () => {
    writeProfile();
    const pre = preflightAuthSources('auto', { ...env, E2ET_CDP_URL: 'http://127.0.0.1:9222/json' }, NOW, 'http://127.0.0.1:9222/json');
    expect(pre.valid).not.toContain('profile');
    expect(pre.failures.some((f) => f.source === 'profile' && f.reason === 'not_applicable')).toBe(true);
  });

});

// —— auth login 落地判据 isAtUrl（调用方 URL 的 origin+pathname 相等）——

describe('isAtUrl（origin+pathname 相等）', () => {
  it('同 origin 同 path 落地（query/hash 不影响）', () => {
    expect(isAtUrl('https://app.example.test/', 'https://app.example.test/')).toBe(true);
    expect(isAtUrl('https://app.example.test/some/path?x=1', 'https://app.example.test/some/path')).toBe(true);
    expect(isAtUrl('https://app.example.test/p#frag', 'https://app.example.test/p')).toBe(true);
  });
  it('中间页（不同 origin）不算落地', () => {
    expect(isAtUrl('https://login.example.test/preLogin2.htm', 'https://app.example.test/')).toBe(false);
  });
  it('同 host 不同 path 不算落地', () => {
    expect(isAtUrl('https://app.example.test/other', 'https://app.example.test/home')).toBe(false);
  });
  it('about:blank / chrome-error / 空值不匹配', () => {
    expect(isAtUrl('about:blank', 'https://app.example.test/')).toBe(false);
    expect(isAtUrl('chrome-error://chromewebdata/', 'https://app.example.test/')).toBe(false);
    expect(isAtUrl('', 'https://app.example.test/')).toBe(false);
    expect(isAtUrl('https://app.example.test/', '')).toBe(false);
  });
  it('后缀骗局 host 不匹配', () => {
    expect(isAtUrl('https://app.example.test.evil.com/', 'https://app.example.test/')).toBe(false);
  });
});

// —— B3: writeExportResult 纯函数（落盘 + 0600 + 原子 + import 兼容 + 不含 SECRET + 失效 exit1）——

describe('writeExportResult（B3 落盘纯函数）', () => {
  let dir: string;
  const SECRET = 'SECRET_VALUE_xyz789';
  function cookies(expires = -1) {
    return [
      { name: 'SESSION_A', value: SECRET, domain: '.example.test', path: '/', expires, httpOnly: true, secure: true },
      { name: 'SESSION_B', value: SECRET, domain: '.example.test', path: '/', expires, httpOnly: true, secure: true },
    ];
  }

  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-export-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('原子写 0600 + 输出能被 parseAuthInput/importAuth 导入', () => {
    const out = path.join(dir, 'exported.json');
    const summary = writeExportResult(out, cookies());
    expect(summary.cookies).toBe(2);
    // 0600
    const st = fs.statSync(out);
    expect(st.mode & 0o777).toBe(0o600);
    // 内容是 storageState JSON
    const parsed = JSON.parse(fs.readFileSync(out, 'utf-8'));
    expect(parsed.cookies).toHaveLength(2);
    expect(parsed.origins).toEqual([]);
    // 喂 parseAuthInput/importAuth 通过
    const reimported = importAuth({ input: fs.readFileSync(out, 'utf-8'), env: { E2ET_HOME: dir } });
    const onDisk = JSON.parse(fs.readFileSync(reimported.path, 'utf-8'));
    expect(onDisk.cookies).toHaveLength(2);
  });

  it('返回值（summary）不含 SECRET', () => {
    const out = path.join(dir, 'exported.json');
    const summary = writeExportResult(out, cookies());
    expect(JSON.stringify(summary)).not.toContain(SECRET);
  });

  it('无业务 cookie 判据：只有任意 cookie → 正常写盘返回摘要', () => {
    const out = path.join(dir, 'exported.json');
    const summary = writeExportResult(out, [{ name: 'OTHER', value: 'x', domain: '.example.test', path: '/', expires: -1 }]);
    expect(summary.cookies).toBe(1);
    expect(fs.existsSync(out)).toBe(true);
    expect(JSON.parse(fs.readFileSync(out, 'utf-8')).cookies).toHaveLength(1);
  });

  it('到期是事实：过期 cookie → 正常写盘，摘要 expired=true', () => {
    const out = path.join(dir, 'exported.json');
    // expires 1（1970 年，早已过期）
    const summary = writeExportResult(out, cookies(1));
    expect(summary.cookies).toBe(2);
    expect(summary.cookieFacts.every((f) => f.expired)).toBe(true);
    expect(fs.existsSync(out)).toBe(true);
  });

  it('坏格式（缺 value/domain）→ 写盘前抛错，不覆盖已有输出文件', () => {
    const out = path.join(dir, 'exported.json');
    // 预置旧合法输出
    writeExportResult(out, cookies());
    expect(() => writeExportResult(out, [{ name: 'ONLY_NAME' } as any])).toThrow(/不构成标准 storageState/);
    const onDisk = JSON.parse(fs.readFileSync(out, 'utf-8'));
    expect(onDisk.cookies).toHaveLength(2);
    expect(onDisk.cookies[0].name).toBe('SESSION_A');
  });
});

// —— B5: auth export CLI dispatch 级验收（exit code / stdout / stderr）——

describe('auth export dispatch（B5）', () => {
  let home: string;
  let env: NodeJS.ProcessEnv;
  const SECRET = 'SECRET_VALUE_xyz789';
  const cookies = (expires: number) => [
    { name: 'SESSION_A', value: SECRET, domain: '.example.test', path: '/', expires },
    { name: 'SESSION_B', value: SECRET, domain: '.example.test', path: '/', expires },
  ];

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-export-cli-'));
    env = { ...process.env, E2ET_HOME: home };
    delete env.E2ET_CDP_URL;
    delete env.E2ET_AUTH_STATE;
    env.CHROME_EXECUTABLE_PATH = path.join(home, 'fake-chrome');
    fs.writeFileSync(env.CHROME_EXECUTABLE_PATH, 'fake');
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
  function envelope(stdout: string[]) { return JSON.parse(stdout.join('')); }
  function expectNoSecret(text: string) { expect(text).not.toContain(SECRET); }

  it('导出成功（--domain）→ exit 0，stdout/stderr 不含 SECRET', async () => {
    const out = path.join(home, 'exported.json');
    const exported = cookies(Math.floor(Date.now() / 1000) + 3600);
    const domainCalls: string[] = [];
    const c = capture({ exportCookiesFromProfile: async (_e, _m, _sid, _env, domain) => { domainCalls.push(domain); return exported; } });
    const code = await dispatch(['auth', 'export', '--out', out, '--domain', 'example.test'], c.deps);
    expect(code).toBe(0);
    expect(domainCalls).toEqual(['example.test']);
    const d = envelope(c.stdout).data;
    expect(d.summary.cookies).toBe(2);
    expect(fs.statSync(out).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(home).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect(JSON.parse(fs.readFileSync(out, 'utf-8'))).toEqual({ cookies: exported, origins: [] });
    const imported = importAuth({ input: fs.readFileSync(out, 'utf-8'), env });
    expect(JSON.parse(fs.readFileSync(imported.path, 'utf-8')).cookies).toEqual(exported);
    expectNoSecret(c.stdout.join(''));
    expectNoSecret(c.stderr.join(''));
  });

  it('缺 --domain → exit 2（USAGE），不触 exportCookiesFromProfile', async () => {
    const out = path.join(home, 'exported.json');
    let called = 0;
    const c = capture({ exportCookiesFromProfile: async () => { called++; return []; } });
    const code = await dispatch(['auth', 'export', '--out', out], c.deps);
    expect(code).toBe(2);
    expect(envelope(c.stdout).error?.code).toBe('USAGE');
    expect(envelope(c.stdout).error?.message).toContain('--domain');
    expect(called).toBe(0);
    expect(fs.existsSync(out)).toBe(false);
  });

  it('导出失败（母本不存在）→ exit 3，stdout/stderr 不含 SECRET', async () => {
    const out = path.join(home, 'exported.json');
    const c = capture();
    const code = await dispatch(['auth', 'export', '--out', out, '--domain', 'example.test'], c.deps);
    expect(code).toBe(3);
    expect(envelope(c.stdout).ok).toBe(false);
    expectNoSecret(c.stdout.join(''));
    expectNoSecret(c.stderr.join(''));
  });

  it('母本存在但过期 cookie → 正常导出 exit 0（到期是事实）', async () => {
    const out = path.join(home, 'exported.json');
    const c = capture({ exportCookiesFromProfile: async () => cookies(1) });
    const code = await dispatch(['auth', 'export', '--out', out, '--domain', 'example.test'], c.deps);
    expect(code).toBe(0);
    expect(fs.statSync(out).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(home).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect(JSON.parse(fs.readFileSync(out, 'utf-8')).cookies).toEqual(cookies(1));
    expectNoSecret(c.stdout.join(''));
    expectNoSecret(c.stderr.join(''));
  });
});

// —— B3: 15s 定时器，probeAuthState 导航报错路径不留定时器 ——

describe('probeAuthState 导航报错不留 15s 定时器（B3）', () => {
  let saved: string | undefined;
  beforeEach(() => { saved = process.env.E2ET_AUTH_PROBE_URL; process.env.E2ET_AUTH_PROBE_URL = 'https://probe.example.test/'; });
  afterEach(() => {
    if (saved === undefined) delete process.env.E2ET_AUTH_PROBE_URL;
    else process.env.E2ET_AUTH_PROBE_URL = saved;
  });
  it('导航 errorText → probeError + vi.getTimerCount() 归零', async () => {
    vi.useFakeTimers();
    try {
      const fakeSession = {
        send: async (method: string, params?: { url?: string }) => {
          if (method === 'Page.navigate' && params?.url && params.url !== 'about:blank') {
            return { errorText: 'net::ERR_FAILED' };
          }
          return {};
        },
        addEventListener: () => () => {},
        close: () => {},
      };
      const p = probeAuthState(fakeSession as any, 'sid');
      // finally 里有 200ms 等待，推进到完成
      await vi.advanceTimersByTimeAsync(300);
      const r = await p;
      expect(r.probeError).toMatch(/导航失败/);
      // 15s load 定时器在 cancelLoad 清掉，200ms 已推进完成 → 无遗留
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
