import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ChromeAuthError,
  chromeProfileCopyArgs,
  discoverChromeProfiles,
  importChromeProfile,
  mapChromeCopyError,
  normalizeStagedProfile,
} from '../browser/chrome-auth.js';
import {
  AuthLoginError,
  gcProfileVersions,
  profileCurrentPointerPath,
  loginProfileAndInstall,
  profileMasterExists,
  profileMasterPath,
  profileVersionsPath,
} from '../browser/profile-browser.js';
import { attachToPage } from '../browser/managed-browser.js';
import { preflightAuthSources, staticAuthSourceState } from '../auth-resolve.js';
import { dispatch } from '../cli/router.js';
import type { RouterDeps } from '../cli/context.js';

const SECRET = 'SECRET_VALUE_xyz789';
const TARGET_URL = 'https://app.example.test/home?token=' + SECRET;

function writeProfileFixture(stagingDir: string, includeCookies = true): void {
  const defaultDir = path.join(stagingDir, 'Default', 'Network');
  fs.mkdirSync(defaultDir, { recursive: true });
  if (includeCookies) fs.writeFileSync(path.join(defaultDir, 'Cookies'), 'encrypted');
  fs.mkdirSync(path.join(stagingDir, 'Default', 'Local Storage'), { recursive: true });
  fs.writeFileSync(path.join(stagingDir, 'Default', 'Local Storage', 'marker'), 'auth');
  fs.writeFileSync(path.join(stagingDir, 'SingletonLock'), 'lock');
  fs.writeFileSync(path.join(stagingDir, 'DevToolsActivePort'), '9222');
  fs.writeFileSync(path.join(stagingDir, 'Local State'), JSON.stringify({
    profile: {
      last_used: 'Profile 1',
      last_active_profiles: ['Profile 1'],
      info_cache: {
        'Profile 1': { name: 'Work' },
      },
    },
  }));
}

describe('Chrome profile copy plan', () => {
  it('profile -> Default；复制 Local State；排除个人数据/缓存并保留认证存储', () => {
    const commands = chromeProfileCopyArgs('/tmp/chrome-user-data', 'Profile 1', '/tmp/stage');
    expect(commands).toHaveLength(2);
    const profileArgs = commands[0];
    expect(profileArgs).toContain('--exclude=/History*');
    expect(profileArgs).toContain('--exclude=/Bookmarks*');
    expect(profileArgs).toContain('--exclude=/Favicons*');
    expect(profileArgs).toContain('--exclude=/Web Data*');
    expect(profileArgs).toContain('--exclude=/Extensions');
    expect(profileArgs).toContain('--exclude=/Service Worker');
    expect(profileArgs.at(-2)).toMatch(/Profile 1\/$/);
    expect(profileArgs.at(-1)).toMatch(/stage\/Default\/$/);
    const excludes = new Set(profileArgs.filter((arg) => arg.startsWith('--exclude=')));
    for (const keep of ['Cookies', 'Network', 'Local Storage', 'Session Storage', 'IndexedDB', 'WebStorage', 'Storage', 'Sessions', 'Sessions_Encrypted']) {
      expect(excludes.has(`--exclude=/${keep}`)).toBe(false);
    }
    expect(commands[1]).toContain('/tmp/chrome-user-data/Local State');
  });

  it('Profile N 归一化为 Default，info_cache 改键且保持 Local State 其他字段', () => {
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-normalize-'));
    try {
      writeProfileFixture(stage);
      const localState = JSON.parse(fs.readFileSync(path.join(stage, 'Local State'), 'utf-8'));
      localState.keep = { intact: true };
      fs.writeFileSync(path.join(stage, 'Local State'), JSON.stringify(localState));
      normalizeStagedProfile(stage, 'Profile 1');
      const normalized = JSON.parse(fs.readFileSync(path.join(stage, 'Local State'), 'utf-8'));
      expect(normalized.keep).toEqual({ intact: true });
      expect(normalized.profile.last_used).toBe('Default');
      expect(normalized.profile.last_active_profiles).toEqual(['Default']);
      expect(normalized.profile.info_cache).toEqual({ Default: { name: 'Work' } });
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
    }
  });

  it('TCC/权限拒绝映射 ENV_UNAVAILABLE，源文件变化映射 AUTH_FAILED', () => {
    expect(mapChromeCopyError(Object.assign(new Error('denied'), { code: 'EPERM' })).code).toBe('ENV_UNAVAILABLE');
    expect(mapChromeCopyError(Object.assign(new Error('rsync missing'), {
      code: 'ENOENT',
      path: '/usr/bin/rsync',
    })).code).toBe('ENV_UNAVAILABLE');
    expect(mapChromeCopyError(Object.assign(new Error('source changed'), { status: 24 })).code).toBe('AUTH_FAILED');
  });
});

describe('Chrome profile discovery and pointer', () => {
  let home: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-home-'));
    env = { ...process.env, E2ET_HOME: home };
    const chrome = path.join(home, 'Library', 'Application Support', 'Google', 'Chrome');
    fs.mkdirSync(path.join(chrome, 'Default', 'Network'), { recursive: true });
    fs.mkdirSync(path.join(chrome, 'Profile 1'), { recursive: true });
    fs.mkdirSync(path.join(chrome, 'Profile 2'), { recursive: true });
    fs.mkdirSync(path.join(chrome, 'System Profile'), { recursive: true });
    fs.writeFileSync(path.join(chrome, 'Default', 'Network', 'Cookies'), 'default');
    fs.writeFileSync(path.join(chrome, 'Profile 1', 'Cookies'), 'profile-1');
    fs.writeFileSync(path.join(chrome, 'Local State'), '{}');
  });

  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it('只发现带可读 Cookie 的 Default/Profile N，排除 System Profile 与空 profile', () => {
    expect(discoverChromeProfiles(home).profiles).toEqual(['Default', 'Profile 1']);
  });

  it('首次无指针回退 legacy；损坏或越界指针也回退', () => {
    const legacy = path.join(home, 'e2e-profile');
    expect(profileMasterPath(env)).toBe(legacy);
    fs.writeFileSync(profileCurrentPointerPath(env), '/tmp/not-our-version\n');
    expect(profileMasterPath(env)).toBe(legacy);
  });

  it('合法 pointer 使 profileMasterExists=true；目标删除后回退 legacy', () => {
    const version = path.join(profileVersionsPath(env), 'profile-current');
    const legacy = path.join(home, 'e2e-profile');
    fs.mkdirSync(path.join(version, 'Default'), { recursive: true });
    fs.writeFileSync(path.join(version, 'Local State'), '{}');
    fs.mkdirSync(path.join(legacy, 'Default'), { recursive: true });
    fs.writeFileSync(profileCurrentPointerPath(env), `${version}\n`);
    expect(profileMasterExists(env)).toBe(true);
    expect(profileMasterPath(env)).toBe(version);
    fs.rmSync(version, { recursive: true, force: true });
    expect(profileMasterExists(env)).toBe(true);
    expect(profileMasterPath(env)).toBe(legacy);
  });
});

describe('profile 恢复大量历史标签时选择探测 target', () => {
  it('优先 about:blank/about://blank，不把第一个历史业务标签当探测页', async () => {
    const attached: string[] = [];
    const session = {
      send: async (method: string, params?: { targetId?: string }) => {
        if (method === 'Target.getTargets') {
          return {
            targetInfos: [
              { targetId: 'history-page', type: 'page', url: 'https://history.example.test/' },
              { targetId: 'blank-page', type: 'page', url: 'about://blank' },
            ],
          };
        }
        if (method === 'Target.attachToTarget') {
          attached.push(params?.targetId ?? '');
          return { sessionId: 'probe-session' };
        }
        return {};
      },
      addEventListener: () => () => {},
      close: () => {},
    };
    await expect(attachToPage(session as any)).resolves.toBe('probe-session');
    expect(attached).toEqual(['blank-page']);
  });
});

describe('importChromeProfile', () => {
  let home: string;
  let env: NodeJS.ProcessEnv;
  let legacy: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-import-'));
    env = { ...process.env, E2ET_HOME: home };
    legacy = path.join(home, 'e2e-profile');
    fs.mkdirSync(path.join(legacy, 'Default', 'Network'), { recursive: true });
    fs.writeFileSync(path.join(legacy, 'Default', 'Network', 'Cookies'), 'old-profile');
  });

  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  function copyWithoutCookies(_userDataDir: string, _profileDirectory: string, stagingDir: string): void {
    writeProfileFixture(stagingDir, false);
  }

  it('URL 验证成功才原子切换；无 Cookie 也允许通过；legacy 目录保持不删', async () => {
    const result = await importChromeProfile({
      executable: '/fake/chrome',
      userDataDir: '/fake/user-data',
      profileDirectory: 'Profile 1',
      url: TARGET_URL,
      env,
      copy: copyWithoutCookies,
      verify: async () => TARGET_URL,
    });
    expect(result.profilePath).toBe(profileMasterPath(env));
    expect(path.dirname(result.profilePath)).toBe(profileVersionsPath(env));
    expect(fs.readFileSync(profileCurrentPointerPath(env), 'utf-8').trim()).toBe(result.profilePath);
    expect(fs.readFileSync(path.join(legacy, 'Default', 'Network', 'Cookies'), 'utf-8')).toBe('old-profile');
    expect(fs.readdirSync(profileVersionsPath(env)).some((name) => name.startsWith('.staging-'))).toBe(false);
    expect(fs.existsSync(path.join(result.profilePath, 'SingletonLock'))).toBe(false);
    expect(fs.existsSync(path.join(result.profilePath, 'DevToolsActivePort'))).toBe(false);
    const localState = JSON.parse(fs.readFileSync(path.join(result.profilePath, 'Local State'), 'utf-8'));
    expect(localState.profile.last_used).toBe('Default');
    expect(preflightAuthSources('profile', env).valid).toContain('profile');
    expect(staticAuthSourceState('profile', env).present).toBe(true);
  });

  it('真实 rsync 复制按黑名单过滤并保留认证相关目录', async () => {
    const userDataDir = path.join(home, 'source-chrome');
    const sourceProfile = path.join(userDataDir, 'Profile 1');
    const preserved = ['Network', 'Local Storage', 'Session Storage', 'IndexedDB', 'WebStorage', 'Storage', 'Sessions', 'Sessions_Encrypted'];
    for (const name of preserved) {
      fs.mkdirSync(path.join(sourceProfile, name), { recursive: true });
      fs.writeFileSync(path.join(sourceProfile, name, 'marker'), name);
    }
    fs.mkdirSync(path.join(sourceProfile, 'Network'), { recursive: true });
    fs.writeFileSync(path.join(sourceProfile, 'Network', 'Cookies'), 'encrypted');
    for (const name of ['Service Worker', 'Extensions', 'Favicons']) {
      fs.mkdirSync(path.join(sourceProfile, name), { recursive: true });
      fs.writeFileSync(path.join(sourceProfile, name, 'skip'), name);
    }
    for (const name of ['History', 'Bookmarks', 'Web Data', 'SingletonLock', 'DevToolsActivePort']) {
      fs.writeFileSync(path.join(sourceProfile, name), name);
    }
    fs.writeFileSync(path.join(userDataDir, 'Local State'), JSON.stringify({
      profile: {
        last_used: 'Profile 1',
        info_cache: { 'Profile 1': { name: 'Work' } },
      },
    }));

    const result = await importChromeProfile({
      executable: '/fake/chrome',
      userDataDir,
      profileDirectory: 'Profile 1',
      url: TARGET_URL,
      env,
      verify: async (_executable, profileDir) => {
        expect(profileDir).toContain('.staging-');
        return TARGET_URL;
      },
    });
    for (const name of preserved) {
      expect(fs.existsSync(path.join(result.profilePath, 'Default', name, 'marker'))).toBe(true);
    }
    expect(fs.existsSync(path.join(result.profilePath, 'Default', 'Network', 'Cookies'))).toBe(true);
    for (const name of ['Service Worker', 'Extensions', 'Favicons', 'History', 'Bookmarks', 'Web Data', 'SingletonLock', 'DevToolsActivePort']) {
      expect(fs.existsSync(path.join(result.profilePath, 'Default', name))).toBe(false);
    }
    expect((fs.statSync(result.profilePath).mode & 0o777)).toBe(0o700);
    expect(JSON.parse(fs.readFileSync(path.join(result.profilePath, 'Local State'), 'utf-8')).profile).toMatchObject({
      last_used: 'Default',
      info_cache: { Default: { name: 'Work' } },
    });
  });

  it('isAtUrl 不匹配时 exit-level AUTH_FAILED 且不切换、不触碰旧 profile', async () => {
    await expect(importChromeProfile({
      executable: '/fake/chrome',
      userDataDir: '/fake/user-data',
      profileDirectory: 'Profile 1',
      url: TARGET_URL,
      env,
      copy: copyWithoutCookies,
      verify: async () => 'https://login.example.test/preLogin2.htm',
    })).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    expect(fs.existsSync(profileCurrentPointerPath(env))).toBe(false);
    expect(profileMasterPath(env)).toBe(legacy);
    expect(fs.existsSync(path.join(legacy, 'Default', 'Network', 'Cookies'))).toBe(true);
    expect(fs.readdirSync(profileVersionsPath(env))).toEqual([]);
  });

  it('指针切换失败时旧 profile 继续有效，新版本与 staging 清理', async () => {
    fs.mkdirSync(profileCurrentPointerPath(env));
    await expect(importChromeProfile({
      executable: '/fake/chrome',
      userDataDir: '/fake/user-data',
      profileDirectory: 'Profile 1',
      url: TARGET_URL,
      env,
      copy: copyWithoutCookies,
      verify: async () => TARGET_URL,
    })).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    expect(profileMasterPath(env)).toBe(legacy);
    expect(fs.existsSync(path.join(legacy, 'Default', 'Network', 'Cookies'))).toBe(true);
    expect(fs.readdirSync(profileVersionsPath(env))).toEqual([]);
  });

  it('指针切换成功后只保留 current 与最近 1 个旧版本，不碰 operation/legacy 目录', async () => {
    const versions = profileVersionsPath(env);
    for (const [name, mtime] of [
      ['profile-old-1', '2020-01-01T00:00:00Z'],
      ['profile-old-2', '2021-01-01T00:00:00Z'],
      ['profile-old-3', '2022-01-01T00:00:00Z'],
    ] as const) {
      const dir = path.join(versions, name);
      fs.mkdirSync(path.join(dir, 'Default'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'Local State'), '{}');
      fs.utimesSync(dir, new Date(mtime), new Date(mtime));
    }
    fs.mkdirSync(path.join(versions, '.staging-live'));
    fs.mkdirSync(path.join(versions, '.login-live'));
    const result = await importChromeProfile({
      executable: '/fake/chrome',
      userDataDir: '/fake/user-data',
      profileDirectory: 'Profile 1',
      url: TARGET_URL,
      env,
      copy: copyWithoutCookies,
      verify: async () => TARGET_URL,
    });
    const remaining = fs.readdirSync(versions).sort();
    expect(remaining).toContain(path.basename(result.profilePath));
    expect(remaining).toContain('profile-old-3');
    expect(remaining).toContain('.staging-live');
    expect(remaining).toContain('.login-live');
    expect(remaining).not.toContain('profile-old-1');
    expect(remaining).not.toContain('profile-old-2');
    expect(fs.existsSync(legacy)).toBe(true);
  });

  it('旧版本删除失败被 GC 吞掉，current 永远保留', () => {
    const versions = profileVersionsPath(env);
    for (const [name, mtime] of [
      ['profile-keep', '2022-01-01T00:00:00Z'],
      ['profile-delete-fails', '2021-01-01T00:00:00Z'],
    ] as const) {
      const dir = path.join(versions, name);
      fs.mkdirSync(path.join(dir, 'Default'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'Local State'), '{}');
      fs.utimesSync(dir, new Date(mtime), new Date(mtime));
    }
    const current = path.join(versions, 'profile-current');
    fs.mkdirSync(path.join(current, 'Default'), { recursive: true });
    fs.writeFileSync(path.join(current, 'Local State'), '{}');
    fs.writeFileSync(profileCurrentPointerPath(env), `${current}\n`);
    expect(() => gcProfileVersions(current, env, () => { throw new Error('gc denied'); })).not.toThrow();
    expect(profileMasterExists(env)).toBe(true);
    expect(fs.existsSync(current)).toBe(true);
    expect(fs.existsSync(path.join(versions, 'profile-delete-fails'))).toBe(true);
  });
});

describe('loginProfileAndInstall', () => {
  let home: string;
  let env: NodeJS.ProcessEnv;
  let active: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'login-install-'));
    env = { ...process.env, E2ET_HOME: home };
    active = path.join(profileVersionsPath(env), 'profile-active');
    fs.mkdirSync(path.join(active, 'Default'), { recursive: true });
    fs.writeFileSync(path.join(active, 'Local State'), '{}');
    fs.writeFileSync(path.join(active, 'Default', 'marker'), 'old-current');
    fs.writeFileSync(profileCurrentPointerPath(env), `${active}\n`);
  });

  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it('login 写私有 .login staging，成功后原子安装版本并切换指针', async () => {
    const result = await loginProfileAndInstall('/fake/chrome', env, { url: TARGET_URL }, async (_executable, stagingDir) => {
      expect(path.basename(stagingDir)).toMatch(/^\.login-/);
      fs.mkdirSync(path.join(stagingDir, 'Default'), { recursive: true });
      fs.writeFileSync(path.join(stagingDir, 'Local State'), '{}');
      fs.writeFileSync(path.join(stagingDir, 'Default', 'marker'), 'new-current');
      fs.writeFileSync(path.join(stagingDir, 'SingletonLock'), 'lock');
      return { profilePath: stagingDir, finalUrl: TARGET_URL, durationMs: 10 };
    });
    expect(path.dirname(result.profilePath)).toBe(profileVersionsPath(env));
    expect(profileMasterPath(env)).toBe(result.profilePath);
    expect(fs.readFileSync(profileCurrentPointerPath(env), 'utf-8').trim()).toBe(result.profilePath);
    expect(fs.readFileSync(path.join(result.profilePath, 'Default', 'marker'), 'utf-8')).toBe('new-current');
    expect(fs.existsSync(path.join(result.profilePath, 'SingletonLock'))).toBe(false);
    expect(fs.existsSync(active)).toBe(true);
    expect(fs.readdirSync(profileVersionsPath(env)).some((name) => name.startsWith('.login-'))).toBe(false);
  });

  it('login 失败清理 staging，current 指针与旧版本不变', async () => {
    const pointerBefore = fs.readFileSync(profileCurrentPointerPath(env), 'utf-8');
    await expect(loginProfileAndInstall('/fake/chrome', env, { url: TARGET_URL }, async (_executable, stagingDir) => {
      fs.mkdirSync(path.join(stagingDir, 'Default'), { recursive: true });
      fs.writeFileSync(path.join(stagingDir, 'Local State'), '{}');
      throw new AuthLoginError('AUTH_FAILED', 'login failed');
    })).rejects.toMatchObject({ code: 'AUTH_FAILED', message: 'login failed' });
    expect(fs.readFileSync(profileCurrentPointerPath(env), 'utf-8')).toBe(pointerBefore);
    expect(fs.readFileSync(path.join(active, 'Default', 'marker'), 'utf-8')).toBe('old-current');
    expect(fs.readdirSync(profileVersionsPath(env))).toEqual(['profile-active']);
  });
});

describe('auth import --chrome CLI contract', () => {
  let home: string;
  let env: NodeJS.ProcessEnv;
  let fakeChrome: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-cli-'));
    fakeChrome = path.join(home, 'Google Chrome');
    fs.writeFileSync(fakeChrome, '');
    env = { ...process.env, E2ET_HOME: home, CHROME_EXECUTABLE_PATH: fakeChrome };
  });

  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  function capture(overrides: Partial<RouterDeps> = {}) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    return {
      stdout,
      stderr,
      deps: {
        env,
        homeDir: home,
        platform: 'darwin' as const,
        stdout: (value: string) => stdout.push(value),
        stderr: (value: string) => stderr.push(value),
        discoverChromeProfiles: () => ({ userDataDir: '/fake/chrome-user-data', profiles: ['Default', 'Profile 1'] }),
        ...overrides,
      } as RouterDeps,
    };
  }

  it('参数错误全部 exit 2：互斥、URL 协议、--domain 混用', async () => {
    for (const argv of [
      ['auth', 'import', '--chrome'],
      ['auth', 'import', '--chrome', '--url', 'ftp://example.test/'],
      ['auth', 'import', '--chrome', '--url', TARGET_URL, '--domain', 'example.test'],
      ['auth', 'import', 'payload.json', '--url', TARGET_URL],
      ['auth', 'import', 'payload.json', '--chrome', '--url', TARGET_URL],
      ['auth', 'import', '--url', TARGET_URL],
    ]) {
      const c = capture();
      expect(await dispatch(argv, c.deps)).toBe(2);
      expect(JSON.parse(c.stdout.join('')).error.code).toBe('USAGE');
    }
  });

  it('成功只输出 profile 契约，path/url 不泄露 secret', async () => {
    const c = capture({
      importChromeProfile: async () => ({
        profilePath: path.join(home, 'e2e-profiles', 'profile-1'),
        profileDirectory: 'Profile 1',
        finalUrl: TARGET_URL,
      }),
    });
    const code = await dispatch(['auth', 'import', '--chrome', '--url', TARGET_URL, '--profile', 'Profile 1'], c.deps);
    expect(code, c.stdout.join('')).toBe(0);
    const data = JSON.parse(c.stdout.join('')).data;
    expect(data).toEqual({
      action: 'import',
      auth_source: 'profile',
      profile_path: path.join(home, 'e2e-profiles', 'profile-1'),
      profile_directory: 'Profile 1',
      final_url: 'https://app.example.test/home',
      next: 'session start --auth profile --browser chrome',
    });
    expect(c.stdout.join('')).not.toContain(SECRET);
    expect(c.stderr.join('')).not.toContain(SECRET);
  });

  it('auth login 走私有 staging 安装器，不再传 current profile 目录', async () => {
    let received: { executable: string; env: NodeJS.ProcessEnv; url: string } | undefined;
    const c = capture({
      loginProfileAndInstall: async (executable, loginEnv, opts) => {
        received = { executable, env: loginEnv, url: opts.url };
        return {
          profilePath: path.join(home, 'e2e-profiles', 'profile-login'),
          finalUrl: 'https://app.example.test/home',
          durationMs: 42,
        };
      },
    });
    const code = await dispatch(['auth', 'login', '--url', TARGET_URL], c.deps);
    expect(code, c.stdout.join('')).toBe(0);
    expect(received).toEqual({ executable: fakeChrome, env, url: TARGET_URL });
    expect(JSON.parse(c.stdout.join('')).data.profile_path).toBe(path.join(home, 'e2e-profiles', 'profile-login'));
  });

  it('auth login 登录/URL 验证失败 exit 1，Chrome/profile 环境失败 exit 3', async () => {
    for (const [failureCode, expectedExit] of [
      ['AUTH_FAILED', 1],
      ['ENV_UNAVAILABLE', 3],
    ] as const) {
      const c = capture({
        loginProfileAndInstall: async () => {
          throw new AuthLoginError(failureCode, failureCode === 'AUTH_FAILED' ? 'login redirect' : 'profile permission denied');
        },
      });
      const code = await dispatch(['auth', 'login', '--url', TARGET_URL], c.deps);
      expect(code, c.stdout.join('')).toBe(expectedExit);
      expect(JSON.parse(c.stdout.join('')).error.code).toBe(failureCode);
    }
  });

  it('验证失败 exit 1，环境失败 exit 3，profile 不存在 exit 3', async () => {
    const authFailed = capture({
      importChromeProfile: async () => { throw new ChromeAuthError('AUTH_FAILED', 'login redirect'); },
    });
    const authCode = await dispatch(['auth', 'import', '--chrome', '--url', TARGET_URL, '--profile', 'Profile 1'], authFailed.deps);
    expect(authCode, authFailed.stdout.join('')).toBe(1);
    expect(JSON.parse(authFailed.stdout.join('')).error.code).toBe('AUTH_FAILED');

    const envFailed = capture({
      importChromeProfile: async () => { throw new ChromeAuthError('ENV_UNAVAILABLE', 'permission denied'); },
    });
    expect(await dispatch(['auth', 'import', '--chrome', '--url', TARGET_URL, '--profile', 'Profile 1'], envFailed.deps)).toBe(3);
    expect(JSON.parse(envFailed.stdout.join('')).error.code).toBe('ENV_UNAVAILABLE');

    const missing = capture();
    expect(await dispatch(['auth', 'import', '--chrome', '--url', TARGET_URL, '--profile', 'Profile 9'], missing.deps)).toBe(3);
    expect(JSON.parse(missing.stdout.join('')).error.code).toBe('ENV_UNAVAILABLE');
  });

  it('commands --json 暴露 chrome 的 --url 且 --domain 只描述文件模式', async () => {
    const c = capture();
    expect(await dispatch(['commands', '--json'], c.deps)).toBe(0);
    const command = JSON.parse(c.stdout.join('')).data.commands.find((item: any) => item.name === 'auth' && item.subcommand === 'import');
    expect(command.args.find((arg: any) => arg.name === '--url')?.description).toContain('仅 --chrome');
    expect(command.args.find((arg: any) => arg.name === '--domain')?.description).toContain('文件/stdin');
  });
});
