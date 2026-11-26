#!/usr/bin/env node
// 所有页面操作只用本次 tarball 安装后的 CLI；HTTP/原生文件提供独立证据。
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const expectedPackage = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const [tarballInput, extra] = process.argv.slice(2);
if (!tarballInput || extra || !fs.existsSync(tarballInput) || !tarballInput.endsWith('.tgz')) {
  console.error('Usage: npm run test:package -- /absolute/path/e2et-VERSION.tgz');
  process.exit(2);
}
assert(Number(process.versions.node.split('.')[0]) >= 20, 'Node.js 20+ required');
const tarball = path.resolve(tarballInput);
const defaultRoot = path.join(os.homedir(), '.e2et');
const artifactParent = path.join(defaultRoot, 'workspace');
fs.mkdirSync(artifactParent, { recursive: true });
const artifacts = fs.mkdtempSync(path.join(artifactParent, 'package-verification-'));
const privateDir = path.join(artifacts, 'private');
const prefix = path.join(privateDir, 'prefix');
const workRoot = path.join(artifacts, 'work-root');
const state = path.join(privateDir, 'state.json');
const caseName = `pkg_${randomUUID().replaceAll('-', '')}`;
const caseRoot = path.join(defaultRoot, 'library', caseName);
const cli = path.join(prefix, 'bin', 'e2et');
const installedRoot = path.join(prefix, 'lib', 'node_modules', expectedPackage.name);
const sourceCli = path.join(root, 'dist', 'cli.js');
const cleanEnv = { ...process.env };
for (const key of Object.keys(cleanEnv)) {
  if (/^(E2ET_|WDK_|PLAYWRIGHT_|CHROME_|PUPPETEER_|BROWSER_|CDP_)/.test(key)
    || ['HEADLESS', 'AUTH_STATE', 'USER_DATA_DIR', 'NODE_OPTIONS', 'NODE_PATH', 'NODE_TLS_REJECT_UNAUTHORIZED'].includes(key)) delete cleanEnv[key];
}
const env = { ...cleanEnv, E2ET_HOME: workRoot, E2ET_AUTH_STATE: state, E2ET_MANAGED_HEADLESS: 'true', HEADLESS: 'true' };
const receipt = { status: 'running', package: expectedPackage.name, version: expectedPackage.version, tarball, artifacts, case: caseName,
  work_root: workRoot, default_work_root: defaultRoot, input_state_format: 'empty_standard_storage_state', commands: [], reports: [], http_observations: [], cleanup: [] };
const sessions = new Set();
let fixture;
let origin;
let savedManifest;
let ir;
let irFile;
let irSha;
let defaultOutputOwned = false;
const defaultOutput = path.join(defaultRoot, 'workspace', 'verify', `${caseName}-default`);
fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(artifacts, 'commands'));
fs.mkdirSync(path.join(artifacts, 'observations'));
fs.writeFileSync(state, '{"cookies":[],"origins":[]}', { mode: 0o600, flag: 'wx' });

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fileSha = file => sha(fs.readFileSync(file));
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeReceipt = () => fs.writeFileSync(path.join(artifacts, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
const entries = dir => fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
function manifest(dir, relative = '') {
  return Object.fromEntries(entries(path.join(dir, relative)).flatMap(name => {
    const rel = path.join(relative, name);
    const file = path.join(dir, rel);
    const stat = fs.lstatSync(file);
    assert(!stat.isSymbolicLink(), `Unexpected symlink: ${file}`);
    return stat.isDirectory() ? Object.entries(manifest(dir, rel)) : [[rel, fileSha(file)]];
  }));
}

async function command(label, executable, args, childEnv = env) {
  const stem = `${String(receipt.commands.length + 1).padStart(3, '0')}-${label}`;
  const stdoutFile = path.join(artifacts, 'commands', `${stem}.stdout`);
  const stderrFile = path.join(artifacts, 'commands', `${stem}.stderr`);
  const record = { label, executable, args, environment: Object.fromEntries(Object.entries(childEnv)
    .filter(([key]) => key.startsWith('E2ET_') || ['BROWSER_EXECUTABLE_PATH', 'HEADLESS'].includes(key))), stdout: stdoutFile, stderr: stderrFile };
  receipt.commands.push(record);
  writeReceipt();
  const child = spawn(executable, args, { cwd: root, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', bytes => stdout.push(bytes));
  child.stderr.on('data', bytes => stderr.push(bytes));
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, 180_000);
  const forceTimer = setTimeout(() => child.kill('SIGKILL'), 185_000);
  const result = await new Promise(resolve => {
    child.once('error', error => resolve({ code: null, error: error.message }));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
  clearTimeout(forceTimer);
  const output = Buffer.concat(stdout).toString('utf8');
  fs.writeFileSync(stdoutFile, output);
  fs.writeFileSync(stderrFile, Buffer.concat(stderr));
  Object.assign(record, result, { timed_out: timedOut });
  writeReceipt();
  console.log(`${label}: exit ${result.code}`);
  assert(!timedOut && !result.error && result.signal === null, `${label}: ${JSON.stringify(result)}`);
  return { code: result.code, stdout: output, stderr: Buffer.concat(stderr).toString('utf8') };
}

async function invoke(label, args, options = {}) {
  const result = await command(label, cli, args, { ...env, ...options.env });
  const json = JSON.parse(result.stdout.trim());
  assert.equal(result.code, options.code ?? 0, `${label}: ${result.stdout}\n${result.stderr}`);
  assert.equal(json.ok, (options.code ?? 0) === 0, `${label}: bad envelope`);
  if (options.error) assert.equal(json.error?.code, options.error, `${label}: wrong error`);
  if (args[0] === 'assert') assert.equal(json.data?.pass, options.pass ?? true, `${label}: assertion did not pass`);
  return json.data ?? json;
}

function commandShape(commands) {
  assert.equal(commands.length, 58, 'Expected 58 actual command definitions');
  return commands.map(({ name, subcommand, args }) => ({ name, subcommand: subcommand ?? null,
    args: args.map(arg => ({ name: arg.name, kind: arg.kind, required: arg.required ?? false,
      variadic: arg.variadic ?? false, enum: arg.enum ?? null })) }))
    .sort((a, b) => `${a.name}/${a.subcommand}`.localeCompare(`${b.name}/${b.subcommand}`));
}

function png(bytes) {
  assert(bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')), 'Missing PNG signature');
  let header;
  let ended = false;
  const chunks = [];
  for (let offset = 8; offset < bytes.length;) {
    assert(offset + 12 <= bytes.length, 'Truncated PNG chunk');
    const size = bytes.readUInt32BE(offset);
    const kind = bytes.toString('ascii', offset + 4, offset + 8);
    assert(offset + size + 12 <= bytes.length, 'Truncated PNG payload');
    const body = bytes.subarray(offset + 8, offset + 8 + size);
    let crc = 0xffffffff;
    for (const byte of bytes.subarray(offset + 4, offset + 8 + size)) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    assert.equal((crc ^ 0xffffffff) >>> 0, bytes.readUInt32BE(offset + 8 + size), 'PNG CRC mismatch');
    if (kind === 'IHDR') { assert.equal(offset, 8); header = body; }
    if (kind === 'IDAT') chunks.push(body);
    if (kind === 'IEND') { assert.equal(size, 0); assert.equal(offset + 12, bytes.length); ended = true; }
    offset += size + 12;
  }
  assert(ended && header?.length === 13 && chunks.length > 0, 'Incomplete PNG');
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  assert(width > 0 && height > 0 && header[8] === 8 && [2, 6].includes(header[9]) && header[10] === 0 && header[11] === 0 && header[12] === 0, 'Unsupported screenshot PNG');
  const stride = width * (header[9] === 6 ? 4 : 3) + 1;
  const pixels = inflateSync(Buffer.concat(chunks));
  assert.equal(pixels.length, stride * height, 'PNG scanline length mismatch');
  for (let i = 0; i < pixels.length; i += stride) assert(pixels[i] <= 4, 'Invalid PNG scanline filter');
  return { width, height, sha256: sha(bytes) };
}
const screenshot = data => {
  assert.match(data, /^data:image\/png;base64,/);
  return png(Buffer.from(data.slice(data.indexOf(',') + 1), 'base64'));
};

function realTests(suites) {
  assert(Array.isArray(suites), 'Native report missing suites');
  return suites.flatMap(suite => [...realTests(suite.suites ?? []), ...(suite.specs ?? []).flatMap(spec => spec.tests ?? [])]);
}
function attachment(result, name) {
  const matches = (result.attachments ?? []).filter(item => item.name === name);
  assert.equal(matches.length, 1, `Missing or duplicate ${name} attachment`);
  assert.equal(matches[0].contentType, 'application/json');
  const bytes = matches[0].body !== undefined ? Buffer.from(matches[0].body, 'base64') : fs.readFileSync(matches[0].path);
  return JSON.parse(bytes.toString('utf8'));
}
function fieldValues(assertions) {
  return Object.fromEntries(assertions.filter(item => item.kind === 'field_value' && item.expect.value !== '')
    .map(item => [item.expect.label, item.actual.value]));
}
function nativeReport(runDir, expectedStatus, earlyError) {
  const jsonFile = path.join(runDir, 'report.json');
  const raw = readJson(jsonFile);
  const tests = realTests(raw.suites);
  assert.equal(tests.length, 1, 'Expected exactly one real test');
  assert.equal(tests[0].results.length, 1, 'Retries/flaky results are not acceptance');
  const result = tests[0].results[0];
  assert.equal(result.status, expectedStatus);
  assert.equal(raw.stats.skipped, 0);
  assert.equal(raw.stats.flaky, 0);
  assert.equal(raw.stats.expected, expectedStatus === 'passed' ? 1 : 0);
  assert.equal(raw.stats.unexpected, expectedStatus === 'passed' ? 0 : 1);
  const htmlFile = path.join(runDir, 'html-report', 'index.html');
  const html = fs.readFileSync(htmlFile, 'utf8');
  assert(html.includes('playwrightReportBase64'), 'Missing native HTML template');
  const zipData = /data:application\/zip;base64,([A-Za-z0-9+/=]+)/.exec(html);
  assert(zipData, 'Missing embedded report ZIP');
  const zip = Buffer.from(zipData[1], 'base64');
  assert(zip.length > 100 && zip.readUInt32LE(0) === 0x04034b50, 'Invalid embedded report ZIP');
  const evidence = { run_dir: runDir, status: expectedStatus, json: jsonFile, html: htmlFile,
    json_sha256: fileSha(jsonFile), html_sha256: fileSha(htmlFile), tests: tests.length };
  receipt.reports.push(evidence);
  if (earlyError) {
    assert.match(JSON.stringify(result.errors), earlyError, 'Wrong state rejection');
    writeReceipt();
    return evidence;
  }
  const report = attachment(result, 'ir-report');
  const replay = attachment(result, 'replay-environment');
  const runtime = attachment(result, 'runtime-environment');
  assert.deepEqual(replay, { auth_source: 'imported', browser_source: 'managed' });
  assert.equal(runtime.e2et_version, expectedPackage.version);
  assert.equal(runtime.playwright_version, expectedPackage.dependencies['@playwright/test']);
  assert.equal(report.result, expectedStatus === 'passed' ? 'PASS' : 'FAIL');
  assert.equal(report.sessionId, ir.provenance.session_id);
  assert.equal(report.mocked, false);
  assert.equal(report.cases.length, 1);
  assert.equal(report.cases[0].name, caseName);
  assert.equal(report.cases[0].result, report.result);
  assert.equal(report.cases[0].steps.length, ir.steps.length);
  const steps = report.cases[0].steps;
  steps.forEach((step, i) => assert.equal(step.action, ir.steps[i].intent));
  if (expectedStatus === 'passed') {
    steps.forEach((step, i) => {
      assert.equal(step.status, 'pass', `Step ${i + 1} was not executed successfully`);
      assert.equal(step.assertions.length, (ir.steps[i].checks ?? []).filter(check => check.assert).length);
      step.assertions.forEach(item => { assert.equal(item.pass, true); assert.equal(item.executed, true); });
      screenshot(step.screenshot);
    });
  } else {
    const failed = steps.find(step => step.action === 'ARIA选择蔬菜');
    assert.equal(failed?.status, 'fail', 'Wrong step failed');
    assert.match(failed.observation, /OPTION_NOT_FOUND/, 'Wrong ARIA failure');
    screenshot(failed.screenshot);
  }
  const fields = fieldValues(steps.flatMap(step => step.assertions));
  if (expectedStatus === 'passed') {
    assert.match(fields['商品名称'], /^pkg-.+/);
    assert.equal(fields['商品名称'], fields['工具描述']);
  }
  Object.assign(evidence, { ir_result: report.result, steps: steps.length,
    assertions: steps.reduce((sum, step) => sum + step.assertions.length, 0), png_count: steps.filter(step => step.screenshot).length,
    fields, replay_environment: replay, runtime_environment: runtime });
  assert.deepEqual(manifest(path.join(runDir, 'runtime')), receipt.installed.runtime_sha256);
  writeReceipt();
  return evidence;
}

async function observations() {
  const response = await fetch(`${origin}/fixture-beta-observations`);
  assert.equal(response.status, 200);
  const raw = await response.text();
  const records = JSON.parse(raw);
  const file = path.join(artifacts, 'observations', `${String(receipt.http_observations.length + 1).padStart(3, '0')}.json`);
  fs.writeFileSync(file, raw);
  receipt.http_observations.push({ path: file, sha256: sha(raw), records });
  return records;
}
async function delta(before, expected) {
  const after = await observations();
  assert.deepEqual(after.slice(0, before.length), before, 'Existing HTTP observations changed');
  assert.equal(after.length - before.length, expected, 'Wrong number of real click events');
  for (const record of after.slice(before.length)) {
    assert.equal(record.path, '/fixture-beta-event');
    assert.deepEqual(JSON.parse(record.body), { id: 'beta-click', count: 1, trusted: true, frame: false });
  }
  return after;
}
function intactCase() {
  assert.equal(fileSha(irFile), irSha, 'Recorded IR changed');
  if (savedManifest) assert.deepEqual(manifest(caseRoot), savedManifest, 'Saved IR/test/fixtures changed');
  else assert(!fs.existsSync(caseRoot), 'Failed land created a case');
}
async function rejected(label, args, options, output, stateError) {
  const before = await observations();
  const runs = entries(output);
  const result = await invoke(label, [...args, '--output', output], options);
  if (options.code === 2) assert.deepEqual(entries(output), runs, 'Usage error created a run directory');
  else {
    const added = entries(output).filter(name => !runs.includes(name));
    assert.equal(added.length, 1, 'Cannot locate exclusive failure run_dir');
    nativeReport(path.join(output, added[0]), 'failed', stateError);
  }
  await delta(before, 0);
  intactCase();
  return result;
}
async function replay(label, args, childEnv = {}) {
  const before = await observations();
  const data = await invoke(label, args, { env: childEnv });
  assert.equal(data.status, 'passed', 'Skipped replay is not acceptance');
  const expectedRoot = childEnv.E2ET_HOME === undefined && Object.hasOwn(childEnv, 'E2ET_HOME') ? defaultRoot : workRoot;
  assert(path.resolve(data.run_dir).startsWith(path.join(expectedRoot, 'workspace', 'verify') + path.sep));
  assert.equal(data.case.name, caseName);
  assert.equal(fileSha(data.ir_snapshot), irSha, 'Replay IR snapshot changed');
  if (savedManifest) assert.equal(fileSha(data.test_ts), savedManifest[path.join('__tests__', `${caseName}.test.ts`)]);
  const proof = nativeReport(data.run_dir, 'passed');
  await delta(before, 1);
  intactCase();
  return proof;
}

async function main() {
  assert(!fs.existsSync(caseRoot) && !fs.existsSync(defaultOutput), 'Unique case already exists');
  const lock = readJson(path.join(root, 'package-lock.json'));
  assert.equal(lock.name, expectedPackage.name);
  assert.equal(lock.version, expectedPackage.version);
  assert(Object.values(lock.packages).every(pkg => !pkg.resolved || pkg.resolved.startsWith('https://registry.npmjs.org/')), 'Private lockfile registry');
  const archiveFiles = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).trim().split('\n');
  assert(archiveFiles.every(file => file.startsWith('package/') && !file.split('/').includes('..')), 'Unsafe archive path');
  assert(archiveFiles.every(file => /^package\/(dist\/|skills\/e2et\/|runtime_assets\/runtime\/|third-party-notices\/|package\.json$|README(?:\.zh-CN)?\.md$|CHANGELOG\.md$|LICENSE$|THIRD_PARTY_NOTICES\.md$)/.test(file)), 'Unexpected package content');
  const archive = name => execFileSync('tar', ['-xOf', tarball, `package/${name}`], { maxBuffer: 32 * 1024 * 1024 });
  const packed = JSON.parse(archive('package.json').toString('utf8'));
  assert.equal(packed.name, expectedPackage.name);
  assert.equal(packed.version, expectedPackage.version);
  assert.deepEqual(packed.dependencies, expectedPackage.dependencies);
  assert.deepEqual(packed.bin, { e2et: 'dist/cli.js' });
  assert.equal(packed.engines.node, '>=20');
  assert.equal(packed.publishConfig.registry, 'https://registry.npmjs.org');
  assert.equal(packed.publishConfig.access, 'public');
  assert.equal(packed.repository.url, 'https://github.com/sv-98-maxin/e2et.git');
  receipt.tarball_sha256 = fileSha(tarball);
  receipt.tarball_files = archiveFiles;
  const install = await command('install-tarball', 'npm', ['install', '--global', '--prefix', prefix, '--registry=https://registry.npmjs.org', '--no-fund', '--no-audit', tarball], cleanEnv);
  assert.equal(install.code, 0, install.stderr);
  assert.equal(fs.realpathSync(cli), path.join(installedRoot, 'dist', 'cli.js'));
  const installed = readJson(path.join(installedRoot, 'package.json'));
  assert.equal(installed.name, packed.name);
  assert.equal(installed.version, packed.version);
  assert.deepEqual(installed.dependencies, packed.dependencies);
  const runtimeHashes = manifest(path.join(installedRoot, 'runtime_assets', 'runtime'));
  assert(Object.keys(runtimeHashes).length > 0, 'Empty runtime');
  assert.deepEqual(runtimeHashes, manifest(path.join(root, 'runtime_assets', 'runtime')));
  const archivedRuntime = Object.fromEntries(archiveFiles.filter(file => file.startsWith('package/runtime_assets/runtime/')).map(file =>
    [file.slice('package/runtime_assets/runtime/'.length), sha(archive(file.slice('package/'.length)))]));
  assert.deepEqual(runtimeHashes, archivedRuntime);
  const skillFiles = ['SKILL.md', 'agents/openai.yaml', 'references/setup-auth.md', 'references/operations.md',
    'references/ui-check.md', 'references/acceptance.md', 'references/tool-issues.md', 'references/cases.md'].sort();
  const sourceSkillHashes = manifest(path.join(root, 'skills', 'e2et'));
  assert.deepEqual(Object.keys(sourceSkillHashes).sort(), skillFiles, 'Unexpected Skill manifest');
  const archivedSkill = Object.fromEntries(archiveFiles.filter(file => file.startsWith('package/skills/e2et/')).map(file =>
    [file.slice('package/skills/e2et/'.length), sha(archive(file.slice('package/'.length)))]));
  assert.deepEqual(sourceSkillHashes, archivedSkill, 'Tarball Skill files mismatch');
  const installedSkillHashes = manifest(path.join(installedRoot, 'skills', 'e2et'));
  assert.deepEqual(installedSkillHashes, sourceSkillHashes, 'Installed Skill files mismatch');
  const installedCliSha = fileSha(fs.realpathSync(cli));
  assert.equal(installedCliSha, sha(archive('dist/cli.js')));
  assert.equal(installedCliSha, fileSha(sourceCli), 'Tarball does not match the current source build');
  const requireInstalled = createRequire(path.join(installedRoot, 'package.json'));
  const playwrightPackage = requireInstalled.resolve('@playwright/test/package.json');
  const playwrightVersion = readJson(playwrightPackage).version;
  assert.equal(playwrightVersion, expectedPackage.dependencies['@playwright/test']);
  for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'third-party-notices/ws.LICENSE', 'third-party-notices/zod.LICENSE', 'third-party-notices/playwright.NOTICE', 'third-party-notices/playwright.ThirdPartyNotices.txt', 'third-party-notices/playwright-core.ThirdPartyNotices.txt']) {
    assert(fs.statSync(path.join(installedRoot, file)).size > 0, `Missing license: ${file}`);
  }
  for (const dependency of ['@playwright/test', 'playwright', 'playwright-core']) {
    const depRoot = path.dirname(requireInstalled.resolve(`${dependency}/package.json`));
    assert(fs.statSync(path.join(depRoot, 'LICENSE')).size > 1000);
    assert(fs.statSync(path.join(depRoot, 'NOTICE')).size > 0);
    if (dependency !== '@playwright/test') assert(fs.statSync(path.join(depRoot, 'ThirdPartyNotices.txt')).size > 0);
  }
  receipt.installed = { prefix, cli, real_cli: fs.realpathSync(cli), cli_sha256: installedCliSha, runtime_sha256: runtimeHashes, skill_sha256: installedSkillHashes,
    dependencies: { '@playwright/test': playwrightVersion, ws: readJson(requireInstalled.resolve('ws/package.json')).version } };
  const browserPath = await command('chromium-path', process.execPath, ['-e', 'const {createRequire}=require("node:module"); const r=createRequire(process.argv[1]); console.log(r("@playwright/test").chromium.executablePath());', path.join(installedRoot, 'package.json')], cleanEnv);
  assert.equal(browserPath.code, 0);
  env.BROWSER_EXECUTABLE_PATH = browserPath.stdout.trim();
  if (!fs.existsSync(env.BROWSER_EXECUTABLE_PATH)) {
    const browserInstall = await command('install-chromium', process.execPath, [path.join(path.dirname(playwrightPackage), 'cli.js'), 'install', 'chromium'], cleanEnv);
    assert.equal(browserInstall.code, 0, browserInstall.stderr);
  }
  fs.accessSync(env.BROWSER_EXECUTABLE_PATH, fs.constants.X_OK);
  receipt.browser_executable_path = env.BROWSER_EXECUTABLE_PATH;
  const version = await command('installed-version', cli, ['--version']);
  assert.equal(version.code, 0);
  assert.equal(version.stdout.trim(), expectedPackage.version);
  // 在私有目录编译 src，命令形状独立于 esbuild bundle；不覆盖并发构建的 dist。
  const sourceBuild = path.join(privateDir, 'source-build');
  const compiled = await command('compile-source-contract', process.execPath, [path.join(root, 'node_modules', 'typescript', 'lib', 'tsc.js'), '-p', path.join(root, 'tsconfig.json'), '--outDir', sourceBuild, '--declaration', 'false', '--sourceMap', 'false'], cleanEnv);
  assert.equal(compiled.code, 0, compiled.stderr);
  fs.writeFileSync(path.join(sourceBuild, 'package.json'), JSON.stringify(expectedPackage));
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(sourceBuild, 'node_modules'), 'dir');
  const sourceBuildCli = path.join(sourceBuild, 'cli.js');
  receipt.source_build = { cli: sourceBuildCli, sha256: fileSha(sourceBuildCli) };
  const sourceCommands = await command('source-commands', process.execPath, [sourceBuildCli, 'commands', '--json']);
  assert.equal(sourceCommands.code, 0);
  const sourceEnvelope = JSON.parse(sourceCommands.stdout.trim());
  assert.equal(sourceEnvelope.ok, true);
  const definitions = await invoke('installed-commands', ['commands', '--json']);
  assert.deepEqual(commandShape(definitions.commands), commandShape(sourceEnvelope.data.commands));
  receipt.command_shape = commandShape(definitions.commands);
  assert.equal((await invoke('setup-override', ['setup'])).workspace, path.join(workRoot, 'workspace'));
  assert.equal((await invoke('setup-default', ['setup'], { env: { E2ET_HOME: undefined } })).workspace, path.join(defaultRoot, 'workspace'));
  fixture = spawn(process.execPath, [path.join(root, 'scripts', 'cli-loopback-fixture.mjs')], { cwd: root, env: { ...cleanEnv, E2ET_FIXTURE_PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const fixtureLog = fs.createWriteStream(path.join(artifacts, 'fixture.stdout.log'));
  const fixtureErrors = fs.createWriteStream(path.join(artifacts, 'fixture.stderr.log'));
  fixture.stdout.pipe(fixtureLog);
  fixture.stderr.pipe(fixtureErrors);
  origin = await new Promise((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => reject(new Error('Fixture did not start')), 10_000);
    fixture.once('error', reject);
    fixture.once('exit', code => reject(new Error(`Fixture exited: ${code}`)));
    fixture.stdout.on('data', bytes => {
      text += bytes;
      const line = text.split('\n')[0];
      try { const url = new URL(JSON.parse(line).url); assert.equal(url.hostname, '127.0.0.1'); clearTimeout(timer); resolve(url.origin); } catch { /* 等待完整启动行 */ }
    });
  });
  receipt.fixture_origin = origin;
  const mode = await fetch(`${origin}/fixture-mode`, { method: 'POST', body: JSON.stringify({ negative: false, category_noop: false }) });
  assert.equal(mode.status, 200);
  assert.deepEqual(await mode.json(), { negative: false, category_noop: false });

  // 校准 assert.false：exit 0 不代表断言通过，且使用独立会话。
  const falseSid = (await invoke('false-session-start', ['session', 'start', '--auth', 'imported', '--browser', 'managed'])).session_id;
  sessions.add(falseSid);
  await invoke('false-open', ['page', 'open', '-s', falseSid, `${origin}/contract-beta-actions`, '--intent', '打开负断言夹具', '--group', 'false']);
  await invoke('false-assert', ['assert', 'text', '-s', falseSid, '点击1;trusted:true', '--within', 'css=#beta-click-status', '--group', 'false'], { pass: false });
  await invoke('false-screenshot', ['page', 'screenshot', '-s', falseSid, '--intent', '负断言完成态', '--group', 'false']);
  assert.equal((await invoke('false-stop', ['session', 'stop', '-s', falseSid])).result, 'fail');
  sessions.delete(falseSid);
  const falseReport = await invoke('false-report', ['report', '-s', falseSid]);
  assert.equal(falseReport.conclusion, 'FAIL');
  assert.equal(readJson(falseReport.json).result, 'FAIL');
  assert.equal((await observations()).length, 0);

  const badStates = [
    { name: 'missing', file: path.join(privateDir, 'missing.json'), error: /登录态文件读取失败/ },
    { name: 'non-json', file: path.join(privateDir, 'non-json.json'), text: '{', error: /登录态文件不是合法 JSON/ },
    { name: 'bad-shape', file: path.join(privateDir, 'bad-shape.json'), text: '{"cookies":"bad","origins":[]}', error: /登录态不是标准 storageState/ },
  ];
  receipt.bad_state_inputs = badStates.map(bad => ({ name: bad.name, path: bad.file, content: bad.text ?? null }));
  for (const bad of badStates) if (bad.text !== undefined) fs.writeFileSync(bad.file, bad.text, { mode: 0o600 });
  for (const test of [
    { name: 'invalid-auth', args: ['--auth', 'invalid', '--browser', 'managed'] },
    { name: 'empty-state', args: ['--auth', 'imported', '--browser', 'managed'], env: { E2ET_AUTH_STATE: '' } },
    { name: 'profile-managed', args: ['--auth', 'profile', '--browser', 'managed'] },
  ]) {
    const before = await observations();
    const existing = entries(path.join(workRoot, 'sessions'));
    await invoke(`source-${test.name}`, ['session', 'start', ...test.args], { code: 2, error: 'USAGE', env: test.env });
    assert.deepEqual(entries(path.join(workRoot, 'sessions')), existing, 'Usage error created a session');
    await delta(before, 0);
  }
  for (const bad of badStates) {
    const before = await observations();
    const previous = entries(path.join(workRoot, 'sessions'));
    await invoke(`source-${bad.name}`, ['session', 'start', '--auth', 'imported', '--browser', 'managed'], { code: 3, error: 'ENV_UNAVAILABLE', env: { E2ET_AUTH_STATE: bad.file } });
    for (const file of entries(path.join(workRoot, 'sessions')).filter(file => file.endsWith('.json') && !previous.includes(file))) {
      const failed = readJson(path.join(workRoot, 'sessions', file));
      const trace = path.join(workRoot, 'workspace', 'traces', failed.id, 'trace.jsonl');
      if (fs.existsSync(trace)) assert(fs.readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).every(event => event.t !== 'action'), 'Bad state performed an action');
    }
    await delta(before, 0);
    assert(!fs.existsSync(caseRoot));
  }

  const sidData = await invoke('source-start', ['session', 'start', '--auth', 'imported', '--browser', 'managed']);
  const sid = sidData.session_id;
  sessions.add(sid);
  receipt.source_session = sid;
  assert.equal(sidData.auth_source, 'imported');
  assert.equal(sidData.browser_source, 'managed');
  const page = (label, sub, args, group) => invoke(label, ['page', sub, '-s', sid, ...args, ...(group ? ['--group', group] : [])]);
  const check = (label, sub, args, group) => invoke(label, ['assert', sub, '-s', sid, ...args, '--group', group]);
  const shots = [];
  const shot = async (label, group) => { const data = await page(label, 'screenshot', ['--intent', `${group}完成态`], group); shots.push({ group, path: data.path, ...png(fs.readFileSync(data.path)) }); };
  const sourceBefore = await observations();
  await page('click-open', 'open', [`${origin}/contract-beta-actions`, '--intent', '打开点击夹具'], 'click');
  await page('click-state', 'state', []);
  await check('click-before', 'text', ['点击0;trusted:false', '--within', 'css=#beta-click-status'], 'click');
  await page('trusted-click', 'click', ['css=#beta-click', '--wait-api', '/fixture-beta-event', '--intent', '可信点击'], 'click');
  await check('click-after', 'text', ['点击1;trusted:true', '--within', 'css=#beta-click-status'], 'click');
  for (const body of ['id == beta-click', 'count == 1', 'trusted == true']) await check(`request-${body.split(' ')[0]}`, 'request', ['/fixture-beta-event', '--body', body], 'click');
  await shot('click-screenshot', 'click');
  await page('native-open', 'open', [`${origin}/`, '--intent', '打开原生输入夹具'], 'native');
  await page('native-state', 'state', []);
  await check('native-empty', 'field', ['商品名称', ''], 'native');
  const fill = await page('native-template', 'fill', ['css=#name-input', '', '--value-template', 'pkg-${random}', '--save-as', 'pkgName', '--intent', '生成本次输入'], 'native');
  assert.match(fill.saved.value, /^pkg-.+/);
  assert.equal(typeof fill.action_id, 'string');
  await page('native-ref', 'type', ['css=#desc-input', '', '--value-ref', 'pkgName', '--intent', '消费本次输入'], 'native');
  await page('native-blur', 'press', ['Tab', '--intent', '输入失焦'], 'native');
  await check('native-name', 'field', ['商品名称', '--value-from-action', fill.action_id], 'native');
  await check('native-description', 'field', ['工具描述', '--value-ref', 'pkgName'], 'native');
  await shot('native-screenshot', 'native');
  await page('aria-open', 'open', [`${origin}/contract-selection`, '--intent', '打开标准ARIA夹具'], 'aria');
  await page('aria-state', 'state', []);
  await check('aria-empty', 'text', ['未选择', '--within', 'css=#sel-cs-status'], 'aria');
  await page('aria-select', 'select', ['role=button:单选类目', '蔬菜', '--intent', 'ARIA选择蔬菜'], 'aria');
  await check('aria-selected', 'text', ['蔬菜', '--within', 'css=#sel-cs-status'], 'aria');
  await check('aria-competing-pool', 'text', ['未选择', '--within', 'css=#sel-other-status'], 'aria');
  await page('aria-dynamic-template', 'fill', ['css=#dyn-seed', '', '--value-template', 'label-${random}', '--save-as', 'optionName', '--intent', '生成动态选项名'], 'aria');
  const selected = await page('aria-dynamic-select', 'select', ['role=button:动态类目', '--value-ref', 'optionName', '--intent', '选择本次动态选项'], 'aria');
  await check('aria-dynamic-assert', 'text', ['--within', 'css=#dyn-status', '--value-from-action', selected.action_id], 'aria');
  await shot('aria-screenshot', 'aria');
  assert.equal((await invoke('source-stop', ['session', 'stop', '-s', sid])).result, 'pass');
  sessions.delete(sid);
  const planFile = path.join(workRoot, 'plan.json');
  fs.writeFileSync(planFile, '["click","native","aria"]');
  const sourceReport = await invoke('source-report', ['report', '-s', sid, '--plan', planFile]);
  assert.equal(sourceReport.conclusion, 'PASS');
  const report = readJson(sourceReport.json);
  assert.equal(report.result, 'PASS');
  assert.equal(report.cases.length, 1);
  assert.deepEqual(report.cases[0].steps.map(step => [step.group, step.status]), [['click', 'pass'], ['native', 'pass'], ['aria', 'pass']]);
  assert.deepEqual(report.coverage.missing, []);
  assert.deepEqual(report.coverage.unplanned, []);
  assert.equal(report.asserts.total, 12);
  assert.equal(report.asserts.pass, 12);
  report.cases[0].steps.forEach(step => screenshot(step.screenshot));
  const sourceFields = fieldValues(report.cases[0].steps.flatMap(step => step.assertions));
  assert.equal(sourceFields['商品名称'], fill.saved.value);
  assert.equal(sourceFields['工具描述'], fill.saved.value);
  assert(fs.statSync(sourceReport.html).size > 0);
  const traceFile = path.join(workRoot, 'workspace', 'traces', sid, 'trace.jsonl');
  const events = fs.readFileSync(traceFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events.at(-1).t, 'session_end');
  assert.equal(events.at(-1).result, 'pass');
  for (const group of ['click', 'native', 'aria']) assert.equal(events.filter(event => event.group === group).at(-1).t, 'screenshot');
  await delta(sourceBefore, 1);
  receipt.source = { ...sourceReport, trace: traceFile, trace_sha256: fileSha(traceFile), screenshots: shots, fields: sourceFields };
  const built = await invoke('ir-build', ['ir', 'build', '-s', sid, '--name', caseName]);
  assert.deepEqual(built.unmapped_actions, []);
  assert.deepEqual(built.dropped_steps, []);
  irFile = built.ir_path;
  ir = readJson(irFile);
  irSha = fileSha(irFile);
  assert.equal(ir.schema_version, 3);
  assert.equal(ir.name, caseName);
  assert.equal(ir.provenance.session_id, sid);
  assert.equal(ir.provenance.tool_version, expectedPackage.version);
  assert.equal(ir.provenance.mocked, false);
  const fillStep = ir.steps.find(step => step.trace_ref === fill.action_id);
  assert.deepEqual(fillStep.value, { template: 'pkg-${random}' });
  assert.equal(fillStep.save_as, 'pkgName');
  assert(ir.steps.some(step => step.action === 'type' && step.value.ref === 'pkgName'));
  assert(ir.steps.some(step => step.save_as === 'optionName' && step.value.template === 'label-${random}'));
  assert(ir.steps.some(step => step.action === 'select' && step.value.ref === 'optionName'));
  const checks = ir.steps.flatMap(step => step.checks ?? []).filter(check => check.assert).map(check => check.assert);
  assert.equal(checks.length, 12);
  assert(checks.some(check => check.field_value?.label === '商品名称' && check.field_value.value.from_action === fillStep.id));
  assert(checks.some(check => check.field_value?.label === '工具描述' && check.field_value.value.ref === 'pkgName'));
  assert(checks.some(check => check.text?.value?.from_action === ir.steps.find(step => step.trace_ref === selected.action_id).id));
  const checked = await invoke('ir-check', ['ir', 'check', irFile, '--trace', sid]);
  assert.equal(checked.passed, true);
  assert.deepEqual(checked.failures, []);
  assert.deepEqual(checked.skipped, []);
  const judged = await invoke('judge', ['judge', irFile]);
  assert.equal(judged.regressible, true);
  assert.deepEqual(judged.reasons, []);
  receipt.ir = { path: irFile, sha256: irSha, steps: ir.steps.length, assertions: checks.length };

  // land 的所有 auth 负例在初次落库前执行，避免 ALREADY_EXISTS 抢先拒绝。
  for (const verb of ['verify', 'land']) {
    await rejected(`${verb}-empty-state`, [verb, irFile, '--auth', 'imported', '--browser', 'managed', '--auth-state', ''], { code: 2, error: 'USAGE' }, path.join(workRoot, 'workspace', 'verify', `${caseName}-${verb}-empty`));
    await rejected(`${verb}-profile-state`, [verb, irFile, '--auth', 'profile', '--browser', 'chrome', '--auth-state', state], { code: 2, error: 'USAGE' }, path.join(workRoot, 'workspace', 'verify', `${caseName}-${verb}-conflict`));
    for (const bad of badStates) await rejected(`${verb}-${bad.name}`, [verb, irFile, '--auth', 'imported', '--browser', 'managed', '--auth-state', bad.file], { code: 1, error: 'TEST_FAILED' }, path.join(workRoot, 'workspace', 'verify', `${caseName}-${verb}-${bad.name}`), bad.error);
  }
  const auth = ['--auth', 'imported', '--browser', 'managed', '--auth-state', state];
  const verified = await replay('verify', ['verify', irFile, ...auth]);
  assert.notEqual(verified.fields['商品名称'], fill.saved.value, 'Replay reused the recorded literal');
  const landBefore = await observations();
  const landed = await invoke('land', ['land', irFile, ...auth]);
  assert.equal(landed.status, 'landed');
  assert.equal(landed.case_root, caseRoot);
  savedManifest = manifest(caseRoot);
  assert.equal(savedManifest[`${caseName}.ir.json`], irSha);
  assert.equal(landed.verification.status, 'passed');
  assert.equal(fileSha(landed.verification.ir_snapshot), irSha);
  assert.equal(fileSha(landed.verification.test_ts), savedManifest[path.join('__tests__', `${caseName}.test.ts`)]);
  nativeReport(landed.verification.run_dir, 'passed');
  await delta(landBefore, 1);
  receipt.saved = { root: caseRoot, sha256: savedManifest };
  intactCase();
  for (const childEnv of [{}, { E2ET_HOME: undefined }]) {
    const cases = await invoke(Object.hasOwn(childEnv, 'E2ET_HOME') ? 'case-list-default' : 'case-list-override', ['case', 'list'], { env: childEnv });
    assert.equal(cases.cases.filter(item => item.name === caseName).length, 1);
    assert(!cases.invalid.some(item => item.name === caseName));
    assert.equal(cases.cases.find(item => item.name === caseName).ir_file, path.join(caseRoot, `${caseName}.ir.json`));
  }
  assert(!fs.existsSync(path.join(workRoot, 'library')), 'E2ET_HOME redirected the personal library');
  await replay('case-run', ['case', 'run', caseName, ...auth]);
  assert(!fs.existsSync(defaultOutput), 'Default output already exists');
  defaultOutputOwned = true;
  const defaultProof = await replay('case-run-default', ['case', 'run', caseName, ...auth, '--output', defaultOutput], { E2ET_HOME: undefined });
  const defaultRun = entries(defaultOutput);
  assert.equal(defaultRun.length, 1);
  const archivedDefault = path.join(artifacts, 'default-root-run');
  fs.cpSync(path.join(defaultOutput, defaultRun[0]), archivedDefault, { recursive: true, filter: file => path.basename(file) !== 'node_modules' });
  defaultProof.execution_run_dir = defaultProof.run_dir;
  defaultProof.run_dir = archivedDefault;
  defaultProof.json = path.join(archivedDefault, 'report.json');
  defaultProof.html = path.join(archivedDefault, 'html-report', 'index.html');
  assert.equal(fileSha(defaultProof.json), defaultProof.json_sha256);
  assert.equal(fileSha(defaultProof.html), defaultProof.html_sha256);
  await rejected('case-empty-state', ['case', 'run', caseName, '--auth', 'imported', '--browser', 'managed', '--auth-state', ''], { code: 2, error: 'USAGE' }, path.join(workRoot, 'workspace', 'verify', `${caseName}-case-empty`));
  await rejected('case-profile-state', ['case', 'run', caseName, '--auth', 'profile', '--browser', 'chrome', '--auth-state', state], { code: 2, error: 'USAGE' }, path.join(workRoot, 'workspace', 'verify', `${caseName}-case-conflict`));
  for (const bad of badStates) await rejected(`case-${bad.name}`, ['case', 'run', caseName, '--auth', 'imported', '--browser', 'managed', '--auth-state', bad.file], { code: 1, error: 'TEST_FAILED' }, path.join(workRoot, 'workspace', 'verify', `${caseName}-case-${bad.name}`), bad.error);
  await replay('case-explicit-overrides-env', ['case', 'run', caseName, '--auth', 'auto', '--browser', 'managed', '--auth-state', state], { E2ET_REPLAY_AUTH: 'invalid', E2ET_REPLAY_BROWSER: 'invalid', E2ET_AUTH_STATE: badStates[0].file });
  const negativeMode = await fetch(`${origin}/fixture-mode`, { method: 'POST', body: '{"negative":true,"category_noop":false}' });
  assert.equal(negativeMode.status, 200);
  assert.deepEqual(await negativeMode.json(), { negative: true, category_noop: false });
  const beforeNegative = await observations();
  const negativeOutput = path.join(workRoot, 'workspace', 'verify', `${caseName}-negative`);
  await invoke('case-negative', ['case', 'run', caseName, ...auth, '--output', negativeOutput], { code: 1, error: 'TEST_FAILED' });
  const negativeRuns = entries(negativeOutput);
  assert.equal(negativeRuns.length, 1, 'No exclusive negative run_dir');
  nativeReport(path.join(negativeOutput, negativeRuns[0]), 'failed');
  assert.equal(fileSha(path.join(negativeOutput, negativeRuns[0], '__tests__', `${caseName}.test.ts`)), savedManifest[path.join('__tests__', `${caseName}.test.ts`)]);
  await delta(beforeNegative, 1);
  intactCase();
  receipt.status = 'passed';
}

writeReceipt();
try {
  await main();
} catch (error) {
  receipt.status = 'failed';
  receipt.error = { message: error.message, stack: error.stack };
  console.error(error.stack);
  process.exitCode = 1;
} finally {
  for (const sid of sessions) {
    try { await invoke('cleanup-stop', ['session', 'stop', '-s', sid]); } catch (error) { receipt.cleanup.push({ session: sid, error: error.message }); process.exitCode = 1; }
  }
  if (fixture) {
    fixture.kill('SIGTERM');
    await new Promise(resolve => {
      const timer = setTimeout(() => { fixture.kill('SIGKILL'); resolve(); }, 5000);
      fixture.once('close', () => { clearTimeout(timer); resolve(); });
    });
  }
  if (savedManifest) {
    try {
      assert.match(caseName, /^pkg_[a-f0-9]{32}$/);
      assert.equal(caseRoot, path.join(defaultRoot, 'library', caseName));
      assert.deepEqual(manifest(caseRoot), savedManifest, 'Cleanup refused: saved case changed');
      fs.rmSync(caseRoot, { recursive: true });
      receipt.cleanup.push({ case: caseName, removed: true });
    } catch (error) { receipt.cleanup.push({ case: caseName, error: error.message }); process.exitCode = 1; }
  }
  if (defaultOutputOwned && fs.existsSync(defaultOutput)) {
    const archived = path.join(artifacts, 'default-root-run');
    if (!fs.existsSync(archived)) fs.cpSync(defaultOutput, path.join(artifacts, 'default-root-failure'), { recursive: true, filter: file => path.basename(file) !== 'node_modules' });
    fs.rmSync(defaultOutput, { recursive: true });
  }
  fs.rmSync(privateDir, { recursive: true, force: true });
  if (process.exitCode) receipt.status = 'failed';
  writeReceipt();
  console.log(JSON.stringify({ status: receipt.status, receipt: path.join(artifacts, 'receipt.json') }));
}
