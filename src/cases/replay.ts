import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { packageRoot, readPackageVersion } from '../package-version.js';
import { PLAYWRIGHT_VERSION } from '../shared/versions.js';
import { replayTimeoutMs } from '../wait-timeout.js';
import { e2etRoot } from '../daemon/session-meta.js';
import { linkedPath } from '../path-safety.js';
import type { OperationResult } from '../operation-result.js';
import type { ReplaySelection } from '../shared/replay-env.js';
import { testFileDigest, type CaseSnapshot } from './snapshot.js';

export interface VerificationEnvironment {
  env: NodeJS.ProcessEnv;
  diagnostic: (text: string) => void;
  playwrightRunner: (
    env: NodeJS.ProcessEnv,
    packageRoot: string,
    testFile: string,
    testTimeoutMs: number,
  ) => Promise<number>;
}

export interface VerifyData {
  case: {
    name: string;
    ir_file: string;
    test_file: string;
    test_sha256: string;
    test_compiler: string;
  };
  ir: string;
  ir_snapshot: string;
  test_ts: string;
  run_dir: string;
  status: 'skipped' | 'passed';
  runtime?: { e2et_version: string; playwright_version: string; source: 'bundled' };
  report?: { kind: 'replay'; json: string; html: string };
}

function failure(code: string, message: string, hint: string | undefined, kind: 'usage' | 'validation' | 'environment'): OperationResult<never> {
  return { ok: false, error: { code, message, ...(hint ? { hint } : {}), kind } };
}

function validation(code: string, message: string, hint?: string): OperationResult<never> {
  return failure(code, message, hint, 'validation');
}

function environmentError(code: string, message: string, hint?: string): OperationResult<never> {
  return failure(code, message, hint, 'environment');
}

function usage(code: string, message: string, hint?: string): OperationResult<never> {
  return failure(code, message, hint, 'usage');
}

function readPlaywrightVersion(resolver: NodeRequire): string {
  try {
    const pkgPath = resolver.resolve('@playwright/test/package.json');
    return String(JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version ?? '');
  } catch {
    return '';
  }
}

export async function verifyCase(
  environment: VerificationEnvironment,
  snapshot: CaseSnapshot,
  options: { skip: boolean; output?: string; replay: ReplaySelection },
): Promise<OperationResult<VerifyData>> {
  const verifyRoot = path.resolve(e2etRoot(environment.env), 'workspace', 'verify');
  const parent = path.resolve(options.output ?? verifyRoot);
  if (parent !== verifyRoot && !parent.startsWith(verifyRoot + path.sep)) return usage('USAGE', '--output 必须位于 workspace/verify 内');
  if (linkedPath(parent)) return validation('SYMLINK', 'verify 根、父目录或 output 是 symlink');
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const runDir = fs.mkdtempSync(path.join(parent, `${snapshot.ir.name}-`));
  fs.writeFileSync(path.join(runDir, 'package.json'), '{"type":"module"}');
  const irPath = path.join(runDir, `${snapshot.ir.name}.ir.json`);
  const testPath = path.join(runDir, '__tests__', `${snapshot.ir.name}.test.ts`);
  fs.mkdirSync(path.dirname(testPath));
  fs.writeFileSync(irPath, snapshot.raw);
  fs.writeFileSync(testPath, snapshot.test);
  const fixtureDir = path.join(runDir, 'cases', 'fixtures', snapshot.ir.name);
  fs.mkdirSync(fixtureDir, { recursive: true });
  for (const [name, bytes] of snapshot.fixtures) fs.writeFileSync(path.join(fixtureDir, name), bytes);
  const caseData = {
    name: snapshot.ir.name,
    ir_file: snapshot.sourceIrFile,
    test_file: snapshot.sourceTestFile ?? testPath,
    test_sha256: testFileDigest(snapshot.test),
    test_compiler: snapshot.compiler,
  };
  if (options.skip) return { ok: true, data: { case: caseData, ir: snapshot.ir.name, ir_snapshot: irPath, test_ts: testPath, run_dir: runDir, status: 'skipped' } };
  try {
    const cliPackageRoot = packageRoot();
    if (!cliPackageRoot) return environmentError('ENV_UNAVAILABLE', '无法定位 CLI 包根', '重新安装 e2et 后重试');
    const cliRequire = createRequire(path.join(cliPackageRoot, 'package.json'));
    const cliPlaywright = readPlaywrightVersion(cliRequire);
    if (cliPlaywright !== PLAYWRIGHT_VERSION) {
      return validation('PLAYWRIGHT_VERSION_UNSUPPORTED', `CLI @playwright/test ${cliPlaywright || '未安装/不可解析'}，verify 需要精确 ${PLAYWRIGHT_VERSION}`, '重新安装 e2et 后重试');
    }
    const dependencies = path.join(runDir, 'node_modules');
    fs.mkdirSync(path.join(dependencies, '@playwright'), { recursive: true });
    let resolver = cliRequire;
    for (const name of ['@playwright/test', 'playwright', 'playwright-core']) {
      const pkg = resolver.resolve(`${name}/package.json`);
      fs.symlinkSync(path.dirname(pkg), path.join(dependencies, name), 'dir');
      resolver = createRequire(pkg);
    }
    let cliWs: string;
    try {
      cliWs = cliRequire.resolve('ws/package.json');
    } catch {
      return environmentError('ENV_UNAVAILABLE', 'CLI 安装依赖无法解析 ws，回放 runtime 需要 ws', '重新安装 e2et 后重试');
    }
    fs.symlinkSync(path.dirname(cliWs), path.join(dependencies, 'ws'), 'dir');
    fs.cpSync(path.join(cliPackageRoot, 'runtime_assets', 'runtime'), path.join(runDir, 'runtime'), { recursive: true });
    const replayEnv: NodeJS.ProcessEnv = {
      ...environment.env,
      E2ET_REPLAY_AUTH: options.replay.auth,
      E2ET_REPLAY_BROWSER: options.replay.browser,
      ...(options.replay.authState !== undefined
        ? { E2ET_AUTH_STATE: options.replay.authState }
        : { E2ET_AUTH_STATE: undefined }),
    };
    const code = await environment.playwrightRunner(replayEnv, cliPackageRoot, testPath, replayTimeoutMs(snapshot.ir.steps));
    const reportJson = path.join(runDir, 'report.json');
    const reportHtml = path.join(runDir, 'html-report');
    if (code !== 0) return validation('TEST_FAILED', `Playwright 退出码 ${code}`, `证据目录: ${runDir}；replay 报告: ${reportJson} / ${reportHtml}；若已确认目标站未登录，先核自己Chrome的目标页：仍已登录则直接 e2et auth import --chrome --url <目标业务URL>；也未登录则请用户在自己的Chrome登录，完成后再复制profile；保留失败证据，结束旧会话，新会话/回放显式 --auth profile --browser chrome；只有profile复制或复用确实不可用时选择 e2et auth login --url <目标业务URL>，新登录可能使原Chrome下线`);
    const intact =
      !linkedPath(irPath) && fs.existsSync(irPath) && fs.readFileSync(irPath).equals(snapshot.raw) &&
      !linkedPath(testPath) && fs.existsSync(testPath) && fs.readFileSync(testPath).equals(snapshot.test) &&
      [...snapshot.fixtures].every(([name, bytes]) => { const file = path.join(fixtureDir, name); return !linkedPath(file) && fs.existsSync(file) && fs.readFileSync(file).equals(bytes); });
    if (!intact) return validation('EVIDENCE_TAMPERED', '执行后 run 目录内 IR/.test.ts/fixture 被篡改或缺失', `证据目录: ${runDir}`);
  } catch (e) {
    return validation('TEST_FAILED', `Playwright 执行失败: ${(e as Error).message}`, `证据目录: ${runDir}；若已确认目标站未登录，先核自己Chrome的目标页：仍已登录则直接 e2et auth import --chrome --url <目标业务URL>；也未登录则请用户在自己的Chrome登录，完成后再复制profile；保留失败证据，结束旧会话，新会话/回放显式 --auth profile --browser chrome；只有profile复制或复用确实不可用时选择 e2et auth login --url <目标业务URL>，新登录可能使原Chrome下线`);
  }
  return { ok: true, data: {
    case: caseData,
    runtime: { e2et_version: readPackageVersion(), playwright_version: PLAYWRIGHT_VERSION, source: 'bundled' },
    ir: snapshot.ir.name,
    ir_snapshot: irPath,
    test_ts: testPath,
    run_dir: runDir,
    status: 'passed',
    report: { kind: 'replay', json: path.join(runDir, 'report.json'), html: path.join(runDir, 'html-report') },
  } };
}

export async function runPlaywright(
  env: NodeJS.ProcessEnv,
  packageRoot: string,
  testFile: string,
  testTimeoutMs: number,
  diagnostic: (text: string) => void,
): Promise<number> {
  const cli = createRequire(path.join(packageRoot, 'package.json')).resolve('@playwright/test/cli');
  const runDir = path.dirname(path.dirname(testFile));
  const tmpConfig = path.join(runDir, 'playwright.config.ts');
  const reportJson = path.join(runDir, 'report.json');
  const reportHtml = path.join(runDir, 'html-report');
  try {
    fs.writeFileSync(tmpConfig, [
      "import { defineConfig } from '@playwright/test';",
      'export default defineConfig({',
      `  testDir: ${JSON.stringify(path.dirname(testFile))},`,
      `  testMatch: ${JSON.stringify(path.basename(testFile))},`,
      `  outputDir: ${JSON.stringify(path.join(runDir, 'test-results'))},`,
      `  timeout: ${testTimeoutMs}, retries: 0,`,
      `  metadata: ${JSON.stringify({ e2et_version: readPackageVersion(packageRoot), playwright_version: PLAYWRIGHT_VERSION })},`,
      `  reporter: [['line'], ['json', { outputFile: ${JSON.stringify(reportJson)} }], ['html', { open: 'never', outputFolder: ${JSON.stringify(reportHtml)} }]],`,
      `  use: { headless: true, viewport: { width: 1280, height: 720 } },`,
      '});',
    ].join('\n'));
    const result = spawnSync(process.execPath, [cli, 'test', '--config', tmpConfig], {
      cwd: runDir, stdio: 'pipe', encoding: 'utf8', env,
    });
    if (result.stdout) diagnostic(result.stdout);
    if (result.stderr) diagnostic(result.stderr);
    if (result.error) diagnostic(result.error.message);
    const status = result.status ?? 1;
    if (status !== 0) return status;
    const jsonFailure = verifyReportJson(reportJson);
    if (jsonFailure) {
      diagnostic(`❌ verify replay 报告校验失败: ${jsonFailure}`);
      return 1;
    }
    const htmlFailure = verifyReportHtml(path.join(reportHtml, 'index.html'));
    if (htmlFailure) {
      diagnostic(`❌ verify replay 报告校验失败: ${htmlFailure}`);
      return 1;
    }
    return 0;
  } finally { fs.rmSync(tmpConfig, { force: true }); }
}

function verifyReportJson(reportJson: string): string | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(reportJson, 'utf8'));
  } catch {
    return 'JSON 报告缺失或坏格式';
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return 'JSON 报告不是对象';
  const report = raw as { suites?: unknown; stats?: Record<string, unknown> };
  if (!Array.isArray(report.suites)) return 'JSON 报告缺 suites 数组';
  if (!report.stats || typeof report.stats !== 'object' || Array.isArray(report.stats)) return 'JSON 报告缺 stats';
  for (const key of ['expected', 'unexpected', 'skipped', 'flaky'] as const) {
    const value = report.stats[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      return `JSON 报告 stats.${key} 缺失或不是非负整数`;
    }
  }
  let total = 0;
  let passed = 0;
  let finalFailure: string | undefined;
  const VALID_RESULT_STATUSES = new Set(['passed', 'skipped', 'failed', 'timedOut', 'interrupted']);
  const markFailure = (): void => { finalFailure ??= 'JSON 报告存在坏结构的测试节点'; };
  const visitSuite = (suite: unknown): void => {
    if (suite === null || typeof suite !== 'object' || Array.isArray(suite)) { markFailure(); return; }
    const s = suite as { suites?: unknown; specs?: unknown };
    if (s.suites !== undefined) {
      if (!Array.isArray(s.suites)) { markFailure(); return; }
      s.suites.forEach(visitSuite);
    }
    if (s.specs === undefined) return;
    if (!Array.isArray(s.specs)) { markFailure(); return; }
    for (const spec of s.specs) {
      if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) { markFailure(); continue; }
      const tests = (spec as { tests?: unknown }).tests;
      if (tests === undefined) continue;
      if (!Array.isArray(tests)) { markFailure(); continue; }
      for (const test of tests) {
        if (test === null || typeof test !== 'object' || Array.isArray(test)) { markFailure(); continue; }
        const results = (test as { results?: unknown }).results;
        if (!Array.isArray(results) || results.length === 0) { markFailure(); continue; }
        const last = results.at(-1);
        if (last === null || typeof last !== 'object' || Array.isArray(last)) { markFailure(); continue; }
        const status = (last as { status?: unknown }).status;
        if (typeof status !== 'string' || !VALID_RESULT_STATUSES.has(status)) { markFailure(); continue; }
        total++;
        if (status === 'failed' || status === 'timedOut' || status === 'interrupted') {
          finalFailure ??= `JSON 报告存在最终 ${status} 的测试`;
        }
        if (status === 'passed') passed++;
      }
    }
  };
  report.suites.forEach(visitSuite);
  if (finalFailure) return finalFailure;
  if (total === 0) return 'JSON 报告 0 测试';
  if (passed === 0) return 'JSON 报告无实际 passed 测试';
  return undefined;
}

function verifyReportHtml(htmlFile: string): string | undefined {
  let html: string;
  try {
    html = fs.readFileSync(htmlFile, 'utf8');
  } catch {
    return 'HTML 报告缺失';
  }
  if (html.length === 0) return 'HTML 报告为空';
  if (!html.includes('playwrightReportBase64') || !html.includes('data:application/zip;base64,')) {
    return 'HTML 报告缺嵌入数据模板（非 Playwright 原生结构）';
  }
  return undefined;
}
