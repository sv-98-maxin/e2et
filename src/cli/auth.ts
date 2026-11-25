import * as fs from 'node:fs';
import { commandDefinitions } from './commands.js';
import { parseArgs } from './args.js';
import { emitError, emitOk, EXIT_ENV, EXIT_USAGE, EXIT_VALIDATION, type Deps } from './context.js';
import {
  importAuth,
  resolveSessionCandidates,
  autoAuthOrder,
  staticAuthSourceState,
  resolveAuthPath,
  AuthUsageError,
} from '../auth-resolve.js';
import { resolveSystemChrome } from '../browser/managed-browser.js';
import {
  profileMasterPath,
  AuthLoginError,
  stripQuery,
  writeExportResult,
} from '../browser/profile-browser.js';
import { ChromeAuthError } from '../browser/chrome-auth.js';

function getArgs(name: string, sub?: string) {
  return commandDefinitions().find((c) => c.name === name && c.subcommand === sub)?.args ?? [];
}

/** 脱敏 CDP endpoint：公开输出只展示 origin/host/port，不回显 userinfo/query/path token */
export function redactEndpoint(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return '[invalid-url]';
  }
}

export async function handleAuth(d: Deps, argv: string[]): Promise<number> {
  const sub = argv[0];
  if (!sub) return emitError(d, 'USAGE', 'auth 需要子命令 (import|login|export|status)', undefined, EXIT_USAGE);
  switch (sub) {
    case 'import': return await authImport(d, argv.slice(1));
    case 'login': return await authLoginCmd(d, argv.slice(1));
    case 'export': return await authExportCmd(d, argv.slice(1));
    case 'status': return authStatus(d, argv.slice(1));
    default: return emitError(d, 'USAGE', `auth 未知子命令: ${sub}`, 'login|export|import|status', EXIT_USAGE);
  }
}

async function authImport(d: Deps, argv: string[]): Promise<number> {
  const { values, errors } = parseArgs(argv, getArgs('auth', 'import'));
  if (errors.length) return emitError(d, 'USAGE', errors.join('; '), undefined, EXIT_USAGE);
  const hasFile = Object.hasOwn(values, 'file');
  const chrome = values['--chrome'];
  const profile = values['--profile'];
  const url = values['--url'];
  const domain = values['--domain'];
  if (hasFile && chrome !== undefined) {
    return emitError(d, 'USAGE', 'auth import 的 file 参数与 --chrome 互斥', undefined, EXIT_USAGE);
  }
  if (chrome !== undefined && chrome !== 'true') {
    return emitError(d, 'USAGE', '--chrome 不接受值；Chrome 模式请直接传 --chrome', undefined, EXIT_USAGE);
  }
  if (profile !== undefined && chrome === undefined) {
    return emitError(d, 'USAGE', '--profile 仅可与 --chrome 一起使用', undefined, EXIT_USAGE);
  }
  if (url !== undefined && chrome === undefined) {
    return emitError(d, 'USAGE', '--url 仅可与 --chrome 一起使用', undefined, EXIT_USAGE);
  }
  if (chrome === 'true' && domain !== undefined) {
    return emitError(d, 'USAGE', '--domain 只用于文件/stdin 导入，Chrome 模式请用 --url', undefined, EXIT_USAGE);
  }
  if (chrome === 'true') return await authImportChrome(d, url, profile);
  if (url !== undefined) {
    return emitError(d, 'USAGE', '--url 仅可与 --chrome 一起使用', undefined, EXIT_USAGE);
  }

  const file = values['file'];
  let input: string;
  if (hasFile) {
    try { input = fs.readFileSync(file, 'utf-8'); } catch (e) {
      return emitError(d, 'AUTH_FAILED', `读取文件失败: ${(e as Error).message}`, undefined, EXIT_VALIDATION);
    }
  } else {
    input = await d.readStdin();
  }
  try {
    const result = importAuth({ input, env: d.env, ...(domain !== undefined ? { domain } : {}) });
    return emitOk(d, { action: 'import', path: result.path, summary: result.summary });
  } catch (e) {
    if (e instanceof AuthUsageError) {
      // USAGE 类（裸 cookie 头缺 --domain / 非法 --domain）：写盘前拒绝，exit 2
      const hint = d.platform === 'darwin'
        ? '操作指引：在已登录业务页复制 Cookie → pbpaste | e2et auth import --domain <host>'
        : '操作指引：将 Cookie 保存文件 → e2et auth import <file> --domain <host>';
      return emitError(d, 'USAGE', `${e.message}\n${hint}`, undefined, EXIT_USAGE);
    }
    return emitError(d, 'AUTH_FAILED', `auth import 失败: ${(e as Error).message}`, '确保输入为 Playwright storageState JSON、cookies JSON 或 cookie 头（需 --domain）', EXIT_VALIDATION);
  }
}

function validHttpUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

async function authImportChrome(d: Deps, url: string | undefined, profileArg: string | undefined): Promise<number> {
  if (!validHttpUrl(url)) {
    return emitError(d, 'USAGE', 'auth import --chrome 需要 --url <http(s) URL>', undefined, EXIT_USAGE);
  }
  if (profileArg !== undefined && (profileArg === '' || profileArg === '.' || profileArg === '..' || /[/\\\0]/.test(profileArg))) {
    return emitError(d, 'USAGE', '--profile 只接受 Chrome 用户数据根下的单个目录名', undefined, EXIT_USAGE);
  }
  if (d.platform !== 'darwin') {
    return emitError(d, 'ENV_UNAVAILABLE', 'auth import --chrome 首版仅支持 macOS', undefined, EXIT_ENV);
  }
  const executable = resolveSystemChrome(d.env, d.platform);
  if (!executable) {
    return emitError(d, 'ENV_UNAVAILABLE', '找不到系统 Google Chrome', '安装 Google Chrome 后重试', EXIT_ENV);
  }

  let chromeProfiles: ReturnType<typeof d.discoverChromeProfiles>;
  try {
    chromeProfiles = d.discoverChromeProfiles(d.homeDir);
  } catch (e) {
    if (e instanceof ChromeAuthError) return emitError(d, e.code, e.message, undefined, EXIT_ENV);
    return emitError(d, 'ENV_UNAVAILABLE', '系统 Chrome 用户数据不可用', undefined, EXIT_ENV);
  }
  if (chromeProfiles.profiles.length === 0) {
    return emitError(d, 'ENV_UNAVAILABLE', '系统 Chrome 没有可读取的 profile', undefined, EXIT_ENV);
  }
  let profileDirectory: string;
  if (profileArg !== undefined) {
    if (!chromeProfiles.profiles.includes(profileArg)) {
      return emitError(d, 'ENV_UNAVAILABLE', `系统 Chrome profile 不存在: ${profileArg}`, `可用 profile: ${chromeProfiles.profiles.join(', ')}`, EXIT_ENV);
    }
    profileDirectory = profileArg;
  } else if (chromeProfiles.profiles.length === 1) {
    profileDirectory = chromeProfiles.profiles[0];
  } else {
    return emitError(d, 'USAGE', `系统 Chrome 有多个 profile，请用 --profile 选择: ${chromeProfiles.profiles.join(', ')}`, undefined, EXIT_USAGE);
  }

  try {
    const result = await d.importChromeProfile({
      executable,
      userDataDir: chromeProfiles.userDataDir,
      profileDirectory,
      url,
      env: d.env,
    });
    return emitOk(d, {
      action: 'import',
      auth_source: 'profile',
      profile_path: result.profilePath,
      profile_directory: result.profileDirectory,
      final_url: stripQuery(result.finalUrl),
      next: 'session start --auth profile --browser chrome',
    });
  } catch (e) {
    if (e instanceof ChromeAuthError) {
      return emitError(d, e.code, e.message, e.code === 'AUTH_FAILED' ? '先核本人 Chrome 目标页是否仍已登录；未登录先完成登录再导入。导入会自动解密 cookie 并以当前 Chrome 的加密方案写回，不需要手工处理；仅复制/复用确实不可用才 login（新登录可能使原 Chrome 下线）' : undefined, e.code === 'ENV_UNAVAILABLE' ? EXIT_ENV : EXIT_VALIDATION);
    }
    return emitError(d, 'AUTH_FAILED', 'Chrome profile 导入失败；旧 profile 未改变', undefined, EXIT_VALIDATION);
  }
}

async function authLoginCmd(d: Deps, argv: string[]): Promise<number> {
  const { values, errors } = parseArgs(argv, getArgs('auth', 'login'));
  if (errors.length) return emitError(d, 'USAGE', errors.join('; '), undefined, EXIT_USAGE);
  const url = values['--url'];
  if (!url || !/^https?:\/\//.test(url)) {
    return emitError(d, 'USAGE', 'auth login 需要 --url <http(s)-url>（登录后应到达的 URL，无业务默认）', undefined, EXIT_USAGE);
  }
  const executable = resolveSystemChrome(d.env);
  if (!executable) {
    return emitError(d, 'ENV_UNAVAILABLE', '找不到系统 Google Chrome：auth login 需要系统 Chrome（不能用 Playwright Chromium，钥匙串不同）', '装 Google Chrome 或设 CHROME_EXECUTABLE_PATH', EXIT_ENV);
  }
  d.stderr('⚠️ 新登录可能使目标站在原 Chrome 中的登录态失效（单会话限制）。');
  try {
    const result = await d.loginProfileAndInstall(executable, d.env, { url, onStatus: (message) => d.stderr(message) });
    return emitOk(d, { action: 'login', profile_path: result.profilePath, final_url: result.finalUrl, duration_ms: result.durationMs });
  } catch (e) {
    if (e instanceof AuthLoginError) {
      return emitError(
        d,
        e.code,
        `auth login 失败: ${e.message}`,
        e.code === 'AUTH_FAILED' ? '请在弹出的浏览器窗口完成登录，或检查目标 URL' : '检查系统 Chrome、profile 目录和文件权限',
        e.code === 'AUTH_FAILED' ? EXIT_VALIDATION : EXIT_ENV,
      );
    }
    return emitError(d, 'ENV_UNAVAILABLE', 'auth login 环境失败（未识别异常）', '检查系统 Chrome、profile 目录和文件权限', EXIT_ENV);
  }
}

async function authExportCmd(d: Deps, argv: string[]): Promise<number> {
  const { values, errors } = parseArgs(argv, getArgs('auth', 'export'));
  if (errors.length) return emitError(d, 'USAGE', errors.join('; '), undefined, EXIT_USAGE);
  const out = values['--out'];
  if (!out) return emitError(d, 'USAGE', 'auth export 需要 --out <file>', undefined, EXIT_USAGE);
  const domain = values['--domain'];
  if (!domain) return emitError(d, 'USAGE', 'auth export 需要 --domain <domain>（导出作用域，不导出全部 profile）', undefined, EXIT_USAGE);
  const executable = resolveSystemChrome(d.env);
  if (!executable) {
    return emitError(d, 'ENV_UNAVAILABLE', '找不到系统 Google Chrome：auth export 需要系统 Chrome（钥匙串不同）', '装 Google Chrome 或设 CHROME_EXECUTABLE_PATH', EXIT_ENV);
  }
  const masterDir = profileMasterPath(d.env);
  const sessionId = `export-${Date.now()}`;
  try {
    // 只导出 --domain 作用域内 cookie，不导出全部 profile
    const cookies = await d.exportCookiesFromProfile(executable, masterDir, sessionId, d.env, domain);
    // B3: 落盘抽纯函数 writeExportResult（stdout 不含 cookie 值）
    const summary = writeExportResult(out, cookies);
    return emitOk(d, { action: 'export', path: out, summary });
  } catch (e) {
    return emitError(d, 'AUTH_FAILED', `auth export 失败: ${(e as Error).message}`, '先 e2et auth login --url <url>', EXIT_ENV);
  }
}

export async function autoSelection(env: NodeJS.ProcessEnv) {
  const candidates = await resolveSessionCandidates('auto', 'auto', env);
  const candidate = candidates.find((item) => item.valid.length > 0 && !item.unavailable);
  const selected = candidate ? {
    browser_source: candidate.browser.kind === 'chrome' ? 'chrome-profile' : candidate.browser.kind,
    auth_source: candidate.valid[0],
  } : null;
  return { candidates, candidate, selected };
}

async function authStatus(d: Deps, argv: string[]): Promise<number> {
  const { errors } = parseArgs(argv, getArgs('auth', 'status'));
  if (errors.length) return emitError(d, 'USAGE', errors.join('; '), undefined, EXIT_USAGE);
  const env = d.env;
  const sources = autoAuthOrder().map((source) => staticAuthSourceState(source, env));
  const { candidates, candidate, selected } = await autoSelection(env);
  const visibleBrowser = candidate ?? candidates.find((item) => !item.unavailable);
  return emitOk(d, {
    sources,
    browser: visibleBrowser ? { kind: visibleBrowser.browser.kind, ...(visibleBrowser.browser.kind === 'existing' ? { endpoint: redactEndpoint(visibleBrowser.browser.endpoint) } : {}) } : null,
    auto_selected: selected,
    remediation: selected ? [] : ['auth login', 'auth import'],
  });
}

