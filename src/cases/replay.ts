import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import type { JSONReport, JSONReportSuite, JSONReportTestResult } from '@playwright/test/reporter';
import { packageRoot, readPackageVersion } from '../package-version.js';
import { PLAYWRIGHT_VERSION } from '../shared/versions.js';
import { resolveViewport } from '../shared/viewport.js';
import { replayTimeoutMs } from '../wait-timeout.js';
import { e2etRoot } from '../daemon/session-meta.js';
import { linkedPath } from '../path-safety.js';
import type { OperationResult } from '../operation-result.js';
import type { ReplaySelection } from '../shared/replay-env.js';
import { testFileDigest, type CaseSnapshot } from './snapshot.js';
import { AcceptanceInputError, freezeAcceptance, readAcceptanceSnapshot, type AcceptanceInput } from '../report/acceptance.js';
import { finalizeReport, type ReplayTestResult } from '../shared/report-finalize.js';
import { renderReportHtml } from '../shared/report-render.js';
import { projectReportValue } from '../shared/acceptance.js';
import type { AcceptanceSnapshot, ReportData, ReportRun } from '../shared/report-model.js';

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
  report?: { kind: 'replay'; json?: string; html: string; facts_json: string; playwright_html?: string };
}

function failure(code: string, message: string, hint: string | undefined, kind: 'usage' | 'validation' | 'environment', evidence?: Record<string, string>): Extract<OperationResult<never>, { ok: false }> {
  return { ok: false, error: { code, message, ...(hint ? { hint } : {}), kind, ...(evidence ? { evidence } : {}) } };
}

function validation(code: string, message: string, hint?: string): Extract<OperationResult<never>, { ok: false }> {
  return failure(code, message, hint, 'validation');
}

function environmentError(code: string, message: string, hint?: string): Extract<OperationResult<never>, { ok: false }> {
  return failure(code, message, hint, 'environment');
}

function usage(code: string, message: string, hint?: string): Extract<OperationResult<never>, { ok: false }> {
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
  options: { skip: boolean; output?: string; replay: ReplaySelection; acceptance?: AcceptanceInput },
): Promise<OperationResult<VerifyData>> {
  const verifyRoot = path.resolve(e2etRoot(environment.env), 'workspace', 'verify');
  const parent = path.resolve(options.output ?? verifyRoot);
  if (parent !== verifyRoot && !parent.startsWith(verifyRoot + path.sep)) return usage('USAGE', '--output 必须位于 workspace/verify 内');
  if (linkedPath(parent)) return validation('SYMLINK', 'verify 根、父目录或 output 是 symlink');
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const runDir = fs.mkdtempSync(path.join(parent, `${snapshot.ir.name}-`));
  const irPath = path.join(runDir, `${snapshot.ir.name}.ir.json`);
  const testPath = path.join(runDir, '__tests__', `${snapshot.ir.name}.test.ts`);
  const fixtureDir = path.join(runDir, 'cases', 'fixtures', snapshot.ir.name);
  const reportJson = path.join(runDir, 'report.json');
  const reportHtml = path.join(runDir, 'report.html');
  const factsJson = path.join(runDir, 'report-data.json');
  const playwrightHtml = path.join(runDir, 'html-report', 'index.html');
  const receiptFile = path.join(runDir, 'run.json');
  const errorFile = path.join(runDir, 'error-evidence.json');
  const run: ReportRun = {
    id: path.basename(runDir), mode: 'replay', status: 'BLOCKED', startedAt: Date.now(),
    toolVersion: readPackageVersion(), env: environment.env.TEST_ENV ?? 'default',
  };
  let acceptance: AcceptanceSnapshot | undefined;
  let finalReport: ReportData | undefined;
  let code: number | undefined;
  const errors: NonNullable<ReportRun['errors']> = [];
  const blockedErrors: NonNullable<ReportRun['errors']> = [];
  const paths = (): Record<string, string> => existingFiles({
    json: reportJson, html: reportHtml, facts_json: factsJson, playwright_html: playwrightHtml,
    run_receipt: receiptFile, error_json: errorFile, ir: irPath, test_ts: testPath,
  });
  const writeFinalReport = (): ReportData => {
    run.endedAt = Date.now();
    const original = options.skip ? { tests: [] as ReplayTestResult[], errors: [], blockedErrors: [] } : readFinalPlaywright(reportJson, runDir);
    finalReport = finalizeReport({
      tests: original.tests, run, exitCode: code, errors: [...original.errors, ...errors],
      blockedErrors: [...original.blockedErrors, ...blockedErrors], acceptance,
      title: snapshot.ir.name, url: snapshot.ir.url,
      links: fs.existsSync(playwrightHtml) ? [{ label: 'Playwright 原生详情', url: './html-report/index.html' }] : undefined,
    });
    fs.writeFileSync(factsJson, JSON.stringify(finalReport, null, 2), { mode: 0o600 });
    fs.writeFileSync(reportHtml, renderReportHtml(finalReport), { mode: 0o600 });
    fs.writeFileSync(receiptFile, JSON.stringify({
      ...run, status: finalReport.cases[0]?.run?.status ?? 'BLOCKED',
      runtime_hash_algorithm: 'sha256(sorted(relativePath + NUL + sha256(fileBytes) + LF)); __tests__ excluded',
      acceptance_sha256: acceptance?.sha256,
      replay_selection: options.replay,
    }, null, 2), { mode: 0o600 });
    return finalReport;
  };
  const failRun = (result: Extract<OperationResult<never>, { ok: false }>): OperationResult<never> => {
    try { if (!finalReport || finalReport.result === 'PASS') writeFinalReport(); } catch (error) {
      environment.diagnostic(`❌ 最终报告写入失败: ${error instanceof Error ? error.message : String(error)}`);
    }
    try { fs.writeFileSync(errorFile, JSON.stringify(projectReportValue(result.error).value, null, 2), { mode: 0o600 }); } catch {}
    return { ok: false, error: { ...result.error, evidence: paths() } };
  };
  const caseData = {
    name: snapshot.ir.name,
    ir_file: snapshot.sourceIrFile,
    test_file: snapshot.sourceTestFile ?? testPath,
    test_sha256: testFileDigest(snapshot.test),
    test_compiler: snapshot.compiler,
  };
  try {
    fs.writeFileSync(path.join(runDir, 'package.json'), '{"type":"module"}');
    fs.mkdirSync(path.dirname(testPath));
    fs.writeFileSync(irPath, snapshot.raw);
    fs.writeFileSync(testPath, snapshot.test);
    fs.mkdirSync(fixtureDir, { recursive: true });
    for (const [name, bytes] of snapshot.fixtures) fs.writeFileSync(path.join(fixtureDir, name), bytes);
    acceptance = freezeAcceptance(options.acceptance, runDir);
    if (options.skip) {
      writeFinalReport();
      return { ok: true, data: {
        case: caseData, ir: snapshot.ir.name, ir_snapshot: irPath, test_ts: testPath, run_dir: runDir,
        status: 'skipped', report: { kind: 'replay', html: reportHtml, facts_json: factsJson },
      } };
    }
    const cliPackageRoot = packageRoot();
    if (!cliPackageRoot) return failRun(environmentError('ENV_UNAVAILABLE', '无法定位 CLI 包根', '重新安装 e2et 后重试'));
    const cliRequire = createRequire(path.join(cliPackageRoot, 'package.json'));
    const cliPlaywright = readPlaywrightVersion(cliRequire);
    if (cliPlaywright !== PLAYWRIGHT_VERSION) {
      return failRun(validation('PLAYWRIGHT_VERSION_UNSUPPORTED', `CLI @playwright/test ${cliPlaywright || '未安装/不可解析'}，verify 需要精确 ${PLAYWRIGHT_VERSION}`, '重新安装 e2et 后重试'));
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
      return failRun(environmentError('ENV_UNAVAILABLE', 'CLI 安装依赖无法解析 ws，回放 runtime 需要 ws', '重新安装 e2et 后重试'));
    }
    fs.symlinkSync(path.dirname(cliWs), path.join(dependencies, 'ws'), 'dir');
    fs.cpSync(path.join(cliPackageRoot, 'runtime_assets', 'runtime'), path.join(runDir, 'runtime'), { recursive: true });
    run.runtimeSha256 = hashRuntime(path.join(runDir, 'runtime'));
    const cliFile = path.join(cliPackageRoot, 'dist', 'cli.js');
    if (fs.existsSync(cliFile)) run.cliSha256 = createHash('sha256').update(fs.readFileSync(cliFile)).digest('hex');
    fs.writeFileSync(receiptFile, JSON.stringify(run), { mode: 0o600 });
    const replayEnv: NodeJS.ProcessEnv = {
      ...environment.env,
      E2ET_REPLAY_AUTH: options.replay.auth,
      E2ET_REPLAY_BROWSER: options.replay.browser,
      E2ET_RUN_ID: run.id,
      E2ET_RUN_ENV: run.env,
      E2ET_RUN_ACCEPTANCE_DIR: acceptance ? runDir : undefined,
      ...(options.replay.authState !== undefined
        ? { E2ET_AUTH_STATE: options.replay.authState }
        : { E2ET_AUTH_STATE: undefined }),
    };
    code = await environment.playwrightRunner(replayEnv, cliPackageRoot, testPath, replayTimeoutMs(snapshot.ir.steps));
    const intact =
      !linkedPath(irPath) && fs.existsSync(irPath) && fs.readFileSync(irPath).equals(snapshot.raw) &&
      !linkedPath(testPath) && fs.existsSync(testPath) && fs.readFileSync(testPath).equals(snapshot.test) &&
      [...snapshot.fixtures].every(([name, bytes]) => { const file = path.join(fixtureDir, name); return !linkedPath(file) && fs.existsSync(file) && fs.readFileSync(file).equals(bytes); });
    if (!intact || hashRuntime(path.join(runDir, 'runtime')) !== run.runtimeSha256) {
      errors.push({ code: 'EVIDENCE_TAMPERED', message: '执行后 run 目录内 IR/.test.ts/fixture/runtime 被篡改或缺失' });
      return failRun(validation('EVIDENCE_TAMPERED', errors[0]!.message, `证据目录: ${runDir}`));
    }
    const frozen = readAcceptanceSnapshot(runDir);
    if (frozen?.sha256 !== acceptance?.sha256 || frozen?.frozenAt !== acceptance?.frozenAt) throw new AcceptanceInputError('执行后验收快照与本次冻结输入不一致');
    const nativeHtmlError = verifyReportHtml(playwrightHtml);
    if (nativeHtmlError) blockedErrors.push({ code: 'PLAYWRIGHT_HTML_UNAVAILABLE', message: nativeHtmlError });
    const data = writeFinalReport();
    if (data.result !== 'PASS') return failRun(validation(data.result === 'FAIL' ? 'TEST_FAILED' : 'TEST_BLOCKED',
      `Playwright 退出码 ${code}；最终报告 ${data.result}`, `证据目录: ${runDir}`));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    errors.push({ code: e instanceof AcceptanceInputError ? e.code : 'TEST_FAILED', message });
    return failRun(failure(errors.at(-1)!.code!, message, `证据目录: ${runDir}`, e instanceof AcceptanceInputError ? 'usage' : 'validation'));
  }
  return { ok: true, data: {
    case: caseData,
    runtime: { e2et_version: readPackageVersion(), playwright_version: PLAYWRIGHT_VERSION, source: 'bundled' },
    ir: snapshot.ir.name,
    ir_snapshot: irPath,
    test_ts: testPath,
    run_dir: runDir,
    status: 'passed',
    report: { kind: 'replay', json: reportJson, html: reportHtml, facts_json: factsJson, playwright_html: playwrightHtml },
  } };
}

function existingFiles(files: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(files).filter(([, file]) => {
    try { return !linkedPath(file) && fs.lstatSync(file).isFile(); } catch { return false; }
  }));
}

function hashRuntime(directory: string): string {
  const files: string[] = [];
  const visit = (parent: string): void => {
    for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
      if (entry.name === '__tests__') continue;
      const file = path.join(parent, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) files.push(file);
    }
  };
  visit(directory);
  const manifest = files.map(file => ({ relative: path.relative(directory, file).split(path.sep).join('/'), file }))
    .sort((first, second) => first.relative < second.relative ? -1 : first.relative > second.relative ? 1 : 0)
    .map(entry => `${entry.relative}\0${createHash('sha256').update(fs.readFileSync(entry.file)).digest('hex')}\n`).join('');
  return createHash('sha256').update(manifest).digest('hex');
}

function readAttachment(result: JSONReportTestResult, name: string, runDir: string): unknown {
  const attachments = result.attachments?.filter(attachment => attachment.name === name) ?? [];
  if (!attachments.length) return undefined;
  if (attachments.length !== 1) throw new Error(`${name} 附件重复`);
  const attachment = attachments[0]!;
  if (attachment.body !== undefined) return JSON.parse(Buffer.from(attachment.body, 'base64').toString('utf8'));
  if (!attachment.path) throw new Error(`${name} 附件没有 body/path`);
  const file = path.resolve(runDir, attachment.path);
  if (!file.startsWith(runDir + path.sep) || linkedPath(file) || !fs.lstatSync(file).isFile()) throw new Error(`${name} 附件路径不属于本次 run 普通文件`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readFinalPlaywright(file: string, runDir: string): {
  tests: ReplayTestResult[]; errors: NonNullable<ReportRun['errors']>; blockedErrors: NonNullable<ReportRun['errors']>;
} {
  const tests: ReplayTestResult[] = [];
  const errors: NonNullable<ReportRun['errors']> = [];
  const blockedErrors: NonNullable<ReportRun['errors']> = [];
  try {
    if (linkedPath(file) || !fs.lstatSync(file).isFile()) throw new Error('原生 JSON 报告不是普通文件');
    const report = JSON.parse(fs.readFileSync(file, 'utf8')) as JSONReport;
    const invalid = verifyReportJson(file);
    if (invalid && !invalid.startsWith('JSON 报告存在最终 ')) blockedErrors.push({ code: 'PLAYWRIGHT_JSON_INVALID', message: invalid });
    if (Array.isArray(report.errors)) for (const error of report.errors) if (typeof error?.message === 'string') errors.push({ message: error.message });
    const visit = (suite: JSONReportSuite): void => {
      if (!suite || typeof suite !== 'object') return;
      if (Array.isArray(suite.suites)) suite.suites.forEach(visit);
      if (!Array.isArray(suite.specs)) return;
      for (const spec of suite.specs) {
        if (!Array.isArray(spec?.tests)) continue;
        for (const test of spec.tests) {
          const result = Array.isArray(test?.results) ? test.results.at(-1) : undefined;
          const startedAt = result?.startTime ? Date.parse(result.startTime) : undefined;
          const item: ReplayTestResult = {
            id: spec.id, name: spec.title, status: result?.status,
            durationMs: result?.duration,
            startedAt: Number.isFinite(startedAt) ? startedAt : undefined,
            endedAt: Number.isFinite(startedAt) && typeof result?.duration === 'number' ? startedAt! + result.duration : undefined,
            errors: result?.errors?.filter(error => typeof error?.message === 'string').map(error => ({ message: error.message })),
          };
          if (result) {
            try {
              item.report = readAttachment(result, 'ir-report', runDir);
            } catch (error) { item.reportError = error instanceof Error ? error.message : String(error); }
            try {
              item.environment = readAttachment(result, 'replay-environment', runDir) as ReplayTestResult['environment'];
              if (!item.environment) item.blockedErrors = [{ code: 'REPLAY_ENVIRONMENT_UNAVAILABLE', message: '本次测试没有 replay-environment 附件；未用请求参数补造实际 auth/browser' }];
            } catch (error) { item.blockedErrors = [{ code: 'REPLAY_ENVIRONMENT_INVALID', message: error instanceof Error ? error.message : String(error) }]; }
          }
          tests.push(item);
        }
      }
    };
    if (Array.isArray(report.suites)) report.suites.forEach(visit);
  } catch (error) {
    blockedErrors.push({ code: 'PLAYWRIGHT_JSON_UNAVAILABLE', message: error instanceof Error ? error.message : String(error) });
  }
  return { tests, errors, blockedErrors };
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
    const acceptanceDir = env.E2ET_RUN_ACCEPTANCE_DIR;
    if (acceptanceDir !== undefined && (path.resolve(acceptanceDir) !== runDir || env.E2ET_RUN_ID !== path.basename(runDir))) {
      throw new AcceptanceInputError('回放子进程验收目录/运行身份不属于本次 run');
    }
    const acceptance = acceptanceDir === undefined ? undefined : readAcceptanceSnapshot(runDir);
    const safeAcceptance = acceptance ? projectReportValue(acceptance).value as AcceptanceSnapshot : undefined;
    safeAcceptance?.document.scenarios.forEach((scenario, index) => {
      scenario.id = acceptance!.document.scenarios[index]!.id;
      scenario.checks.forEach((check, checkIndex) => {
        const original = acceptance!.document.scenarios[index]!.checks[checkIndex]!;
        check.id = original.id;
        if (check.irRef && original.irRef) check.irRef.stepId = original.irRef.stepId;
      });
    });
    const receiptFile = path.join(runDir, 'run.json');
    const receipt = fs.existsSync(receiptFile) ? JSON.parse(fs.readFileSync(receiptFile, 'utf8')) as ReportRun : undefined;
    fs.writeFileSync(tmpConfig, [
      "import { defineConfig } from '@playwright/test';",
      'export default defineConfig({',
      `  testDir: ${JSON.stringify(path.dirname(testFile))},`,
      `  testMatch: ${JSON.stringify(path.basename(testFile))},`,
      `  outputDir: ${JSON.stringify(path.join(runDir, 'test-results'))},`,
      `  timeout: ${testTimeoutMs}, retries: 0,`,
      `  metadata: ${JSON.stringify({ e2et_version: readPackageVersion(packageRoot), playwright_version: PLAYWRIGHT_VERSION, e2et_run: receipt, e2et_acceptance: safeAcceptance })},`,
      `  reporter: [['line'], ['json', { outputFile: ${JSON.stringify(reportJson)} }], ['html', { open: 'never', outputFolder: ${JSON.stringify(reportHtml)} }]],`,
      `  use: { headless: true, viewport: ${JSON.stringify(resolveViewport(env))} },`,
      '});',
    ].join('\n'));
    const result = spawnSync(process.execPath, [cli, 'test', '--config', tmpConfig], {
      cwd: runDir, stdio: 'pipe', encoding: 'utf8', env,
    });
    if (result.stdout) diagnostic(result.stdout);
    if (result.stderr) diagnostic(result.stderr);
    if (result.error) throw result.error;
    if (result.signal) diagnostic(`❌ Playwright 进程由 ${result.signal} 终止`);
    return result.status ?? 1;
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
