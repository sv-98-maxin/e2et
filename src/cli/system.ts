import { ensureWorkspace, blockerHints } from '../workspace.js';
import { readPackageVersion } from '../package-version.js';
import { autoAuthOrder, resolveAuthPath, staticAuthSourceState } from '../auth-resolve.js';
import { emitError, emitOk, EXIT_ENV, EXIT_USAGE, EXIT_VALIDATION, type Deps } from './context.js';
import { autoSelection, redactEndpoint } from './auth.js';

export async function handleSetup(d: Deps, argv: string[]): Promise<number> {
  if (argv.length > 0 && !argv.includes('-h') && !argv.includes('--help')) {
    return emitError(d, 'USAGE', `setup 不接受参数: ${argv.join(' ')}`, undefined, EXIT_USAGE);
  }
  let workspaceResult;
  try {
    workspaceResult = ensureWorkspace(d.env);
  } catch (e) {
    return emitError(d, 'SETUP_FAILED', `workspace 准备失败: ${(e as Error).message}`, undefined, EXIT_VALIDATION);
  }
  return emitOk(d, {
    workspace: workspaceResult.workspace,
    browser: workspaceResult.browser,
    cdp_url: redactEndpoint(workspaceResult.cdp_url),
    blockers: workspaceResult.blockers,
    blocker_hints: blockerHints(workspaceResult.blockers),
    tool_version: readPackageVersion(),
  });
}

export async function handleDoctor(d: Deps, argv: string[]): Promise<number> {
  if (argv.length > 0 && !argv.includes('-h') && !argv.includes('--help')) {
    return emitError(d, 'USAGE', `doctor 不接受参数: ${argv.join(' ')}`, undefined, EXIT_USAGE);
  }
  const env = d.env;
  const checks: Array<{ name: string; ok: boolean | 'warn'; detail: string }> = [];

  const { candidates, candidate, selected } = await autoSelection(env);
  const available = candidate ?? candidates.find((item) => !item.unavailable);
  checks.push({ name: 'browser', ok: !!available, detail: available
    ? `${available.browser.kind}${available.browser.kind === 'existing' ? ` ${redactEndpoint(available.browser.endpoint)}` : ''} 可用`
    : '找不到可用浏览器：设置 BROWSER_EXECUTABLE_PATH / PUPPETEER_EXECUTABLE_PATH / CHROME_EXECUTABLE_PATH，或开放 CDP endpoint' });

  const sources = autoAuthOrder().map((source) => staticAuthSourceState(source, env));
  const profileState = sources.find((source) => source.source === 'profile')!;
  const importedState = sources.find((source) => source.source === 'imported')!;
  const importedDetail = importedState.reason
    ?? (importedState.present ? (importedState.valid ? '可用' : '非标准格式') : '无文件');
  const authOk = !!selected;
  checks.push({
    name: 'auth',
    ok: authOk,
    detail: authOk
      ? `${resolveAuthPath(selected!.auth_source, env)} 可用（auto 组合：${selected!.browser_source}+${selected!.auth_source}）`
      : `没有可用组合 —— profile(${profileState.present ? '存在' : '无'}) / imported(${importedDetail})；补救：auth login / auth import`,
  });

  const failed = checks.some((check) => check.ok === false);
  if (failed) {
    d.stdout(JSON.stringify({
      ok: false,
      error: { code: 'ENV_UNAVAILABLE', message: 'doctor 检查存在 fail 项' },
      checks: checks.map((check) => ({ name: check.name, status: check.ok === true ? 'ok' : check.ok === false ? 'fail' : 'warn', detail: check.detail })),
      auth: {
        auto_selected: selected,
        remediation: selected ? [] : ['auth login', 'auth import'],
        sources,
      },
    }));
    return EXIT_ENV;
  }
  return emitOk(d, {
    checks: checks.map((check) => ({ name: check.name, status: check.ok === true ? 'ok' : check.ok === false ? 'fail' : 'warn', detail: check.detail })),
    auth: {
      auto_selected: selected,
      remediation: selected ? [] : ['auth login', 'auth import'],
      sources,
    },
  });
}

