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
const planFile = path.join(artifacts, 'plan.json');
const acceptanceFile = path.join(artifacts, 'acceptance.json');
const acceptanceDocument = { schemaVersion: 1, scenarios: [
  { id: 'click', goal: '一次可信点击产生精确请求', source: { kind: 'contract', text: 'loopback 可信点击合同' },
    preconditions: ['新页面点击计数为 0，尚无可信点击'], checks: [
      { id: 'click-before', expectation: '点击0;trusted:false' },
      { id: 'click-after', expectation: '点击1;trusted:true' },
      { id: 'request-id', expectation: '请求 body.id 为 beta-click' },
      { id: 'request-count', expectation: '请求 body.count 为 1' },
      { id: 'request-trusted', expectation: '请求 body.trusted 为 true' },
    ] },
  { id: 'native', goal: '名称与描述使用本次动态输入', source: { kind: 'contract', text: 'loopback 原生输入合同' },
    preconditions: ['新页面商品名称为空'], checks: [
      { id: 'native-empty', expectation: '商品名称初始为空' },
      { id: 'native-name', expectation: '商品名称等于本次生成动作的值' },
      { id: 'native-description', expectation: '工具描述等于本次 pkgName 的值' },
    ] },
  { id: 'aria', goal: '只改变目标选择池并消费本次动态选项名', source: { kind: 'contract', text: 'loopback 标准 ARIA 合同' },
    preconditions: ['主池与竞争池均未选择'], checks: [
      { id: 'aria-empty', expectation: '主池初始未选择' },
      { id: 'aria-selected', expectation: '主池选择蔬菜' },
      { id: 'aria-competing-pool', expectation: '竞争池仍未选择' },
      { id: 'aria-dynamic-assert', expectation: '动态选项状态等于本次选择动作的值' },
    ] },
] };
const acceptanceBytes = Buffer.from(JSON.stringify(acceptanceDocument, null, 2));
const caseName = `pkg_${randomUUID().replaceAll('-', '')}`;
const caseRoot = path.join(defaultRoot, 'library', caseName);
const cli = path.join(prefix, 'bin', 'e2et');
const installedRoot = path.join(prefix, 'lib', 'node_modules', expectedPackage.name);
const sourceCli = path.join(root, 'dist', 'cli.js');
const cleanEnv = { ...process.env };
for (const key of Object.keys(cleanEnv)) {
  if (/^(E2ET_|WDK_|PLAYWRIGHT_|CHROME_|PUPPETEER_|BROWSER_|CDP_)/.test(key)
    || ['HEADLESS', 'AUTH_STATE', 'USER_DATA_DIR', 'NODE_OPTIONS', 'NODE_PATH', 'NODE_TLS_REJECT_UNAUTHORIZED', 'TEST_ENV'].includes(key)) delete cleanEnv[key];
}
const env = { ...cleanEnv, E2ET_HOME: workRoot, E2ET_AUTH_STATE: state, E2ET_MANAGED_HEADLESS: 'true', HEADLESS: 'true' };
const receipt = { status: 'running', package: expectedPackage.name, version: expectedPackage.version, tarball, artifacts, case: caseName,
  work_root: workRoot, default_work_root: defaultRoot, input_state_format: 'empty_standard_storage_state', commands: [], startups: [], reports: [], http_observations: [], cleanup: [] };
const sessions = new Set();
let fixture;
let origin;
let savedManifest;
let ir;
let irFile;
let irSha;
const replayNames = new Set();
const replayOptions = new Set();
let defaultOutputOwned = false;
const defaultOutput = path.join(defaultRoot, 'workspace', 'verify', `${caseName}-default`);
fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(artifacts, 'commands'));
fs.mkdirSync(path.join(artifacts, 'observations'));
fs.writeFileSync(state, '{"cookies":[],"origins":[]}', { mode: 0o600, flag: 'wx' });
fs.writeFileSync(planFile, '["click","native","aria"]', { mode: 0o600, flag: 'wx' });
fs.writeFileSync(acceptanceFile, acceptanceBytes, { mode: 0o600, flag: 'wx' });
fs.writeFileSync(path.join(artifacts, 'acceptance-v1.json'), acceptanceBytes, { mode: 0o600, flag: 'wx' });

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
  if (json.ok && args[0] === 'assert') assert.equal(json.data?.pass, options.pass ?? true, `${label}: assertion did not pass`);
  if (json.ok && args[0] === 'session' && args[1] === 'start') {
    const sid = json.data.session_id;
    sessions.add(sid);
    const metaFile = path.join(workRoot, 'sessions', `${sid}.json`);
    const traceFile = path.join(workRoot, 'workspace', 'traces', sid, 'trace.jsonl');
    const meta = readJson(metaFile);
    const startup = JSON.parse(fs.readFileSync(traceFile, 'utf8').split('\n').find(line => line.trim()));
    assert.equal(meta.id, sid);
    assert.equal(startup.t, 'session');
    assert.equal(startup.session_id, sid);
    assert.equal(meta.cli_sha256, receipt.installed.cli_sha256, 'Managed bootstrap lost the startup CLI hash');
    assert.equal(startup.cli_sha256, receipt.installed.cli_sha256, 'Trace startup lost the actual CLI hash');
    const acceptanceIndex = args.indexOf('--acceptance');
    let frozenFile;
    if (acceptanceIndex >= 0) {
      frozenFile = path.join(path.dirname(traceFile), 'acceptance.json');
      const frozen = readJson(path.join(path.dirname(traceFile), 'acceptance-meta.json'));
      assert.equal(fileSha(frozenFile), fileSha(args[acceptanceIndex + 1]), 'Startup acceptance bytes changed');
      assert.equal(frozen.sha256, fileSha(frozenFile));
      assert(Number.isFinite(frozen.frozenAt) && frozen.frozenAt > 0);
      for (const original of [meta, startup]) {
        assert.equal(original.acceptance_sha256, frozen.sha256, 'Managed bootstrap lost the frozen acceptance hash');
        assert.equal(original.acceptance_frozen_at, frozen.frozenAt, 'Managed bootstrap lost the acceptance freeze time');
      }
    } else {
      assert.equal(meta.acceptance_sha256, undefined);
      assert.equal(startup.acceptance_sha256, undefined);
    }
    receipt.startups.push({ session_id: sid, meta: metaFile, trace: traceFile, cli_sha256: startup.cli_sha256,
      acceptance: frozenFile, acceptance_sha256: startup.acceptance_sha256, acceptance_frozen_at: startup.acceptance_frozen_at });
    writeReceipt();
  }
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
function fieldValues(assertions, mode = 'source') {
  return Object.fromEntries(assertions.filter(item => item.kind === 'field_value' && item.executed === true && item.actual?.value !== '')
    .map(item => [mode === 'replay' ? item.expect.field_value.label : item.expect.label, item.actual.value]));
}
function reportFacts(runDir, paths) {
  assert.equal(typeof paths.facts_json, 'string', 'CLI did not return final facts_json');
  assert.equal(path.dirname(paths.facts_json), runDir, 'Final facts do not belong to this run');
  const bytes = fs.readFileSync(paths.facts_json);
  const report = JSON.parse(bytes.toString('utf8'));
  assert.equal(report.report_schema_version, 2);
  assert.equal(report.cases.length, 1);
  assert.equal(report.sessionId, path.basename(runDir));
  assert.equal(report.cases[0].run.id, report.sessionId);
  assert.equal(report.cases[0].run.mode, 'replay');
  assert.equal(report.toolVersion, expectedPackage.version);
  assert.equal(report.cases[0].run.toolVersion, expectedPackage.version);
  assert(fs.statSync(paths.html).size > 0, 'Missing final report HTML');
  const archive = path.join(runDir, 'facts', 'report.json');
  fs.mkdirSync(path.dirname(archive));
  fs.copyFileSync(paths.facts_json, archive, fs.constants.COPYFILE_EXCL);
  execFileSync('cmp', [paths.facts_json, archive], { cwd: root });
  assert.equal(fileSha(archive), sha(bytes), 'Archived final facts changed');
  const runReceipt = paths.run_receipt ?? path.join(runDir, 'run.json');
  const run = readJson(runReceipt);
  assert.equal(run.id, report.sessionId);
  assert.equal(run.mode, 'replay');
  assert.equal(run.status, report.cases[0].run.status);
  assert.equal(run.toolVersion, expectedPackage.version);
  return { report, evidence: { facts_json: paths.facts_json, facts_archive: archive, facts_sha256: sha(bytes),
    report_html: paths.html, report_html_sha256: fileSha(paths.html), run_receipt: runReceipt, run_receipt_sha256: fileSha(runReceipt) } };
}
function factContract(reportCase) {
  const events = reportCase.events;
  const images = reportCase.images;
  assert(Array.isArray(events) && Array.isArray(images), 'Missing events/images facts');
  const eventIds = new Map();
  let previous = -1;
  for (const event of events) {
    assert.equal(typeof event.id, 'string');
    assert(!eventIds.has(event.id), 'Duplicate event ID');
    assert(Number.isInteger(event.sequence) && event.sequence > previous, 'Unordered event sequence');
    previous = event.sequence;
    eventIds.set(event.id, event);
    if (event.status === 'not_run') {
      assert.equal(event.executed, false);
      assert.equal(event.actualStatus, 'not_collected');
      for (const key of ['actual', 'resolvedExpected', 'startedAt', 'endedAt', 'imageId']) assert(!Object.hasOwn(event, key), `not_run has ${key}`);
    }
    if (event.type === 'assert' && reportCase.run.mode === 'replay') {
      const ref = event.evidence.irRef;
      assert.equal(ref.irSha256, irSha);
      const step = ir.steps.find(step => step.id === ref.stepId);
      const check = step?.checks?.[ref.checkIndex];
      assert(check?.assert, 'Replay event has no real IR check');
      assert.equal(event.actionId, `${reportCase.run.id}:${step.id}`);
      assert.equal(event.group, check.report_ref?.group ?? step.report_ref?.group);
      assert.equal(event.checkId, check.report_ref?.check_id);
    }
  }
  const imageIds = new Set();
  for (const image of images) {
    assert(!imageIds.has(image.id), 'Duplicate image ID');
    imageIds.add(image.id);
    const event = eventIds.get(image.eventId);
    assert.equal(event?.type, 'screenshot', 'Image is not linked to its screenshot event');
    assert.equal(event.imageId, image.id);
    assert.equal(image.sequence, event.sequence);
    assert.equal(image.actionId, event.actionId);
    screenshot(image.src);
    if (reportCase.run.mode === 'replay') {
      assert(['after_action', 'after_checks'].includes(image.phase));
      const checks = events.filter(event => event.type === 'assert' && event.actionId === image.actionId && event.executed === true);
      assert.equal(image.phase, checks.length ? 'after_checks' : 'after_action');
      assert(checks.every(check => check.sequence < image.sequence), 'Completion image precedes its checks');
    }
  }
  for (const event of events) {
    if (event.actionId) assert.equal(eventIds.get(event.actionId)?.type, 'action', 'Broken action reference');
    if (event.imageId) assert(imageIds.has(event.imageId), 'Broken image reference');
    if (event.type === 'action' && event.status === 'not_run') assert(!images.some(image => image.actionId === event.id), 'Unexecuted action borrowed an image');
  }
  for (const step of reportCase.steps) {
    for (const id of step.eventIds ?? []) assert(eventIds.has(id), 'Broken step event reference');
    for (const id of step.actionIds ?? []) assert.equal(eventIds.get(id)?.type, 'action');
  }
}
function acceptanceContract(reportCase, document = acceptanceDocument) {
  assert.deepEqual(reportCase.acceptance.document, document);
  assert.equal(reportCase.acceptance.sha256, sha(Buffer.from(JSON.stringify(document, null, 2))));
  assert(Number.isFinite(reportCase.acceptance.frozenAt) && reportCase.acceptance.frozenAt > 0);
  const coverage = reportCase.acceptanceCoverage;
  const checks = document.scenarios.flatMap(scenario => scenario.checks);
  assert.equal(coverage.total, checks.length);
  assert.equal(coverage.bound, checks.length);
  assert.equal(coverage.result, 'PASS');
  assert.deepEqual(coverage.scenarios.map(scenario => scenario.id), document.scenarios.map(scenario => scenario.id));
  for (const scenario of coverage.scenarios) for (const check of scenario.checks) {
    assert.equal(check.status, 'pass');
    assert.equal(check.eventIds.length, 1, 'Check must bind exactly one real assertion');
    const event = reportCase.events.find(event => event.id === check.eventIds[0]);
    assert.equal(event?.type, 'assert');
    assert.equal(event.group, scenario.id);
    assert.equal(event.checkId, check.id);
    assert.equal(event.status, 'pass');
    assert.equal(event.executed, true);
    assert.equal(event.actualStatus, 'present');
    assert(!event.error);
  }
}
function nativeReport(runDir, paths, expectedStatus, earlyError) {
  const jsonFile = paths.json;
  assert.equal(path.dirname(jsonFile), runDir);
  const raw = readJson(jsonFile);
  const tests = realTests(raw.suites);
  assert.equal(tests.length, 1, 'Expected exactly one real test');
  assert.equal(tests[0].results.length, 1, 'Retries/flaky results are not acceptance');
  const result = tests[0].results.at(-1);
  assert.equal(result.status, expectedStatus);
  assert.equal(raw.stats.skipped, 0);
  assert.equal(raw.stats.flaky, 0);
  assert.equal(raw.stats.expected, expectedStatus === 'passed' ? 1 : 0);
  assert.equal(raw.stats.unexpected, expectedStatus === 'passed' ? 0 : 1);
  if (expectedStatus === 'passed') {
    assert.deepEqual(raw.errors ?? [], [], 'Native report has global errors');
    assert.deepEqual(result.errors, [], 'Final test result has errors');
  } else assert(result.errors.length > 0, 'Failed test is missing its original errors');
  const htmlFile = paths.playwright_html;
  assert.equal(path.dirname(path.dirname(htmlFile)), runDir);
  const html = fs.readFileSync(htmlFile, 'utf8');
  assert(html.includes('playwrightReportBase64'), 'Missing native HTML template');
  const zipData = /data:application\/zip;base64,([A-Za-z0-9+/=]+)/.exec(html);
  assert(zipData, 'Missing embedded report ZIP');
  const zip = Buffer.from(zipData[1], 'base64');
  assert(zip.length > 100 && zip.readUInt32LE(0) === 0x04034b50, 'Invalid embedded report ZIP');
  const { report, evidence: facts } = reportFacts(runDir, paths);
  assert.equal(report.result, expectedStatus === 'passed' ? 'PASS' : 'FAIL');
  assert.equal(report.cases[0].result, report.result);
  assert.equal(report.cases[0].run.status, report.result);
  const evidence = { run_dir: runDir, status: expectedStatus, json: jsonFile, html: htmlFile, ...facts,
    json_sha256: fileSha(jsonFile), html_sha256: fileSha(htmlFile), tests: tests.length };
  receipt.reports.push(evidence);
  if (earlyError) {
    assert.match(JSON.stringify(result.errors), earlyError, 'Wrong state rejection');
    writeReceipt();
    return evidence;
  }
  const intermediate = attachment(result, 'ir-report');
  const replay = attachment(result, 'replay-environment');
  const runtime = attachment(result, 'runtime-environment');
  assert.equal(replay.auth_source, 'imported');
  assert.equal(replay.browser_source, 'managed');
  assert.equal(raw.config.metadata.e2et_version, expectedPackage.version);
  assert.equal(raw.config.metadata.playwright_version, receipt.installed.dependencies['@playwright/test']);
  assert.equal(runtime.id, path.basename(runDir));
  assert.equal(runtime.mode, 'replay');
  assert.equal(runtime.status, 'BLOCKED', 'Startup snapshot is not a final result');
  assert.equal(runtime.toolVersion, expectedPackage.version);
  assert.equal(runtime.cliSha256, receipt.installed.cli_sha256);
  assert.equal(runtime.runtimeSha256, receipt.installed.runtime_digest);
  assert.equal(runtime.authSource, 'imported');
  assert.equal(runtime.browserSource, 'managed');
  assert.equal(runtime.env, 'default');
  assert.equal(report.sessionId, runtime.id);
  assert.notEqual(report.sessionId, ir.provenance.session_id);
  assert.equal(report.cases[0].run.cliSha256, runtime.cliSha256);
  assert.equal(report.cases[0].run.runtimeSha256, runtime.runtimeSha256);
  assert.equal(report.cases[0].run.authSource, replay.auth_source);
  assert.equal(report.cases[0].run.browserSource, replay.browser_source);
  assert.equal(report.cases[0].run.browserVersion, runtime.browserVersion);
  assert.match(runtime.browserVersion, /^\d+\./, 'Missing actual browser version');
  if (replay.browser_version !== undefined) assert.equal(replay.browser_version, runtime.browserVersion);
  assert.deepEqual(report.cases[0].recording, ir.provenance);
  assert.equal(intermediate.sessionId, runtime.id);
  assert.deepEqual(report.cases[0].steps, intermediate.cases[0].steps, 'Final report lost original step facts');
  assert.deepEqual(report.cases[0].events.slice(0, intermediate.cases[0].events.length), intermediate.cases[0].events, 'Final report lost original events');
  assert.deepEqual(report.cases[0].images, intermediate.cases[0].images, 'Final report changed original screenshots');
  for (const error of [...(raw.errors ?? []), ...result.errors]) {
    assert(report.cases[0].events.some(event => event.error?.message === error.message), 'Final report lost a native execution error');
  }
  assert.equal(report.mocked, false);
  assert.equal(report.cases.length, 1);
  assert.equal(report.cases[0].name, caseName);
  assert.equal(report.cases[0].result, report.result);
  assert.equal(report.cases[0].steps.length, ir.steps.length);
  const steps = report.cases[0].steps;
  factContract(report.cases[0]);
  steps.forEach((step, i) => assert.equal(step.action, ir.steps[i].intent));
  if (expectedStatus === 'passed') {
    acceptanceContract(report.cases[0]);
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
    const action = report.cases[0].events.find(event => event.type === 'action' && event.intent === 'ARIA选择蔬菜');
    assert.equal(action?.status, 'error');
    assert.equal(action.executed, true);
    assert.match(action.error.message, /OPTION_NOT_FOUND/);
    const skipped = report.cases[0].events.filter(event => event.type === 'assert' && event.actionId === action.id);
    assert(skipped.length > 0, 'Failed selection lost its declared checks');
    assert(skipped.every(event => event.status === 'not_run' && event.executed === false && event.actualStatus === 'not_collected'));
  }
  const fields = fieldValues(steps.flatMap(step => step.assertions), 'replay');
  if (expectedStatus === 'passed') {
    assert.match(fields['商品名称'], /^pkg-.+/);
    assert.equal(fields['商品名称'], fields['工具描述']);
    const name = report.cases[0].events.find(event => event.checkId === 'native-name');
    const description = report.cases[0].events.find(event => event.checkId === 'native-description');
    assert.equal(name.resolvedExpected, fields['商品名称']);
    assert.equal(description.resolvedExpected, fields['商品名称']);
    const option = report.cases[0].events.find(event => event.checkId === 'aria-dynamic-assert');
    assert.match(option.resolvedExpected, /^label-.+/);
    assert.equal(option.actual, option.resolvedExpected);
    const seed = report.cases[0].events.find(event => event.type === 'action' && event.intent === '生成动态选项名');
    assert.equal(seed.actual.resolvedValue, option.resolvedExpected);
    assert(!receipt.source_names.includes(fields['商品名称']), 'Replay reused a Source input');
    assert(!receipt.source_options.includes(option.resolvedExpected), 'Replay reused a Source option');
    assert(!replayNames.has(fields['商品名称']), 'Replays reused the same dynamic input');
    assert(!replayOptions.has(option.resolvedExpected), 'Replays reused the same dynamic option');
    replayNames.add(fields['商品名称']);
    replayOptions.add(option.resolvedExpected);
    evidence.dynamic_option = option.resolvedExpected;
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
async function rejected(label, args, options, output, stateError, expectedDelta = 0) {
  const before = await observations();
  const runs = entries(output);
  const result = await invoke(label, [...args, '--output', output], options);
  if (options.code === 2) {
    assert.deepEqual(entries(output), runs, 'Usage error created a run directory');
    assert.equal(result.error.evidence, undefined, 'Preflight rejection unexpectedly returned run files');
  }
  else {
    const added = entries(output).filter(name => !runs.includes(name));
    assert.equal(added.length, 1, 'Cannot locate exclusive failure run_dir');
    const files = result.error.evidence;
    const runDir = path.dirname(files.json);
    assert.equal(runDir, path.join(output, added[0]), 'Failure files do not match the exclusive run');
    assert.equal(files.run_dir, undefined, 'Failure evidence must contain real file fields');
    for (const file of Object.values(files)) assert(fs.statSync(file).isFile(), 'Failure evidence contains a non-file');
    assert.equal(fileSha(files.ir), irSha);
    if (savedManifest) assert.equal(fileSha(files.test_ts), savedManifest[path.join('__tests__', `${caseName}.test.ts`)]);
    nativeReport(runDir, files, 'failed', stateError);
  }
  await delta(before, expectedDelta);
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
  const proof = nativeReport(data.run_dir, data.report, 'passed');
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
  const skillFiles = ['SKILL.md', 'references/setup-auth.md', 'references/operations.md',
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
  const runtimeDigest = sha(Object.keys(runtimeHashes).sort().map(file => `${file.split(path.sep).join('/')}\0${runtimeHashes[file]}\n`).join(''));
  receipt.installed = { prefix, cli, real_cli: fs.realpathSync(cli), cli_sha256: installedCliSha, runtime_sha256: runtimeHashes, runtime_digest: runtimeDigest, skill_sha256: installedSkillHashes,
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
  const falseFacts = readJson(falseReport.json);
  assert.equal(falseFacts.report_schema_version, 2);
  assert.equal(falseFacts.result, 'FAIL');
  factContract(falseFacts.cases[0]);
  const falseCheck = falseFacts.cases[0].events.find(event => event.type === 'assert');
  assert.equal(falseCheck.status, 'fail');
  assert.equal(falseCheck.executed, true);
  assert.equal(falseCheck.actualStatus, 'present');
  assert.equal(falseCheck.resolvedExpected, '点击1;trusted:true');
  assert.match(falseCheck.actual, /点击0;trusted:false/);
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

  const sidData = await invoke('source-start', ['session', 'start', '--auth', 'imported', '--browser', 'managed', '--acceptance', acceptanceFile]);
  const sid = sidData.session_id;
  sessions.add(sid);
  receipt.source_session = sid;
  assert.equal(sidData.auth_source, 'imported');
  assert.equal(sidData.browser_source, 'managed');
  const changedAcceptance = { ...acceptanceDocument, scenarios: acceptanceDocument.scenarios.map(scenario => ({ ...scenario, goal: `${scenario.goal}（启动后修改）` })) };
  const changedBytes = Buffer.from(JSON.stringify(changedAcceptance, null, 2));
  fs.writeFileSync(path.join(artifacts, 'acceptance-v2.json'), changedBytes, { mode: 0o600, flag: 'wx' });
  fs.writeFileSync(acceptanceFile, changedBytes);
  assert.notEqual(sha(changedBytes), sha(acceptanceBytes));
  receipt.acceptance = { input: acceptanceFile, v1: path.join(artifacts, 'acceptance-v1.json'), v1_sha256: sha(acceptanceBytes),
    v2: path.join(artifacts, 'acceptance-v2.json'), v2_sha256: sha(changedBytes) };
  const page = (label, sub, args, group) => invoke(label, ['page', sub, '-s', sid, ...args, ...(group ? ['--group', group] : [])]);
  const check = (label, sub, args, group) => invoke(label, ['assert', sub, '-s', sid, ...args, '--group', group, '--check-id', label]);
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
  const sourceReport = await invoke('source-report', ['report', '-s', sid, '--plan', planFile]);
  assert.equal(sourceReport.conclusion, 'PASS');
  const report = readJson(sourceReport.json);
  assert.equal(report.report_schema_version, 2);
  assert.equal(report.result, 'PASS');
  assert.equal(report.cases.length, 1);
  assert.deepEqual(report.cases[0].steps.map(step => [step.group, step.status]), [['click', 'pass'], ['native', 'pass'], ['aria', 'pass']]);
  assert.deepEqual(report.coverage.missing, []);
  assert.deepEqual(report.coverage.unplanned, []);
  assert.equal(report.asserts.total, 12);
  assert.equal(report.asserts.pass, 12);
  factContract(report.cases[0]);
  acceptanceContract(report.cases[0]);
  assert.equal(report.cases[0].run.id, sid);
  assert.equal(report.cases[0].run.mode, 'source');
  assert.equal(report.cases[0].run.status, 'PASS');
  assert.equal(report.cases[0].run.cliSha256, receipt.installed.cli_sha256);
  assert.equal(report.cases[0].run.toolVersion, expectedPackage.version);
  assert.equal(report.cases[0].run.env, 'default');
  assert.equal(report.cases[0].run.authSource, sidData.auth_source);
  assert.equal(report.cases[0].run.browserSource, sidData.browser_source);
  report.cases[0].steps.forEach(step => screenshot(step.screenshot));
  const sourceFields = fieldValues(report.cases[0].steps.flatMap(step => step.assertions));
  assert.equal(sourceFields['商品名称'], fill.saved.value);
  assert.equal(sourceFields['工具描述'], fill.saved.value);
  assert(fs.statSync(sourceReport.html).size > 0);
  const traceFile = path.join(workRoot, 'workspace', 'traces', sid, 'trace.jsonl');
  const events = fs.readFileSync(traceFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const frozenFile = path.join(path.dirname(traceFile), 'acceptance.json');
  const frozenMeta = readJson(path.join(path.dirname(traceFile), 'acceptance-meta.json'));
  assert.equal(fileSha(frozenFile), sha(acceptanceBytes), 'Source acceptance input was not frozen');
  assert.equal(events[0].acceptance_sha256, sha(acceptanceBytes));
  assert.equal(events[0].acceptance_frozen_at, frozenMeta.frozenAt);
  assert.equal(report.cases[0].acceptance.frozenAt, frozenMeta.frozenAt);
  const meta = readJson(path.join(workRoot, 'sessions', `${sid}.json`));
  assert.equal(meta.acceptance_sha256, sha(acceptanceBytes));
  assert.equal(meta.acceptance_frozen_at, frozenMeta.frozenAt);
  assert.equal(events.at(-1).t, 'session_end');
  assert.equal(events.at(-1).result, 'pass');
  for (const group of ['click', 'native', 'aria']) assert.equal(events.filter(event => event.group === group).at(-1).t, 'screenshot');
  for (const shot of shots) {
    const checks = report.cases[0].events.filter(event => event.type === 'assert' && event.group === shot.group);
    const images = report.cases[0].images.filter(image => report.cases[0].events.find(event => event.id === image.eventId)?.group === shot.group);
    assert.equal(screenshot(images.at(-1).src).sha256, shot.sha256, 'Source completion screenshot bytes changed');
    assert(images.at(-1).sequence > checks.at(-1).sequence, 'Source completion screenshot precedes its last assertion');
  }
  await delta(sourceBefore, 1);
  receipt.source = { ...sourceReport, trace: traceFile, trace_sha256: fileSha(traceFile), screenshots: shots, fields: sourceFields };
  const sourceOption = report.cases[0].events.find(event => event.checkId === 'aria-dynamic-assert').resolvedExpected;
  assert.match(sourceOption, /^label-.+/);
  receipt.source_names = [fill.saved.value];
  receipt.source_options = [sourceOption];
  fs.writeFileSync(acceptanceFile, acceptanceBytes);

  // 第二次独立录制只复验动态输入，主链路的 12 个正式检查保持完整。
  const dynamicIds = new Set(['native-name', 'native-description', 'aria-dynamic-assert']);
  const dynamicAcceptance = { schemaVersion: 1, scenarios: acceptanceDocument.scenarios.filter(scenario => scenario.id !== 'click')
    .map(scenario => ({ ...scenario, checks: scenario.checks.filter(check => dynamicIds.has(check.id)) })) };
  const dynamicFile = path.join(artifacts, 'dynamic-acceptance.json');
  fs.writeFileSync(dynamicFile, JSON.stringify(dynamicAcceptance, null, 2), { mode: 0o600, flag: 'wx' });
  const secondSid = (await invoke('second-source-start', ['session', 'start', '--auth', 'imported', '--browser', 'managed', '--acceptance', dynamicFile])).session_id;
  sessions.add(secondSid);
  const secondPage = (label, sub, args, group) => invoke(`second-${label}`, ['page', sub, '-s', secondSid, ...args, '--group', group]);
  const secondCheck = (label, sub, args, group) => invoke(`second-${label}`, ['assert', sub, '-s', secondSid, ...args, '--group', group, '--check-id', label]);
  await secondPage('native-open', 'open', [`${origin}/`, '--intent', '打开原生输入夹具'], 'native');
  await invoke('second-native-state', ['page', 'state', '-s', secondSid]);
  const secondFill = await secondPage('native-template', 'fill', ['css=#name-input', '', '--value-template', 'pkg-${random}', '--save-as', 'pkgName', '--intent', '生成本次输入'], 'native');
  await secondPage('native-ref', 'type', ['css=#desc-input', '', '--value-ref', 'pkgName', '--intent', '消费本次输入'], 'native');
  await secondPage('native-blur', 'press', ['Tab', '--intent', '输入失焦'], 'native');
  await secondCheck('native-name', 'field', ['商品名称', '--value-from-action', secondFill.action_id], 'native');
  await secondCheck('native-description', 'field', ['工具描述', '--value-ref', 'pkgName'], 'native');
  await secondPage('native-screenshot', 'screenshot', ['--intent', '原生输入完成态'], 'native');
  await secondPage('aria-open', 'open', [`${origin}/contract-selection`, '--intent', '打开标准ARIA夹具'], 'aria');
  await invoke('second-aria-state', ['page', 'state', '-s', secondSid]);
  await secondPage('aria-template', 'fill', ['css=#dyn-seed', '', '--value-template', 'label-${random}', '--save-as', 'optionName', '--intent', '生成动态选项名'], 'aria');
  const secondSelected = await secondPage('aria-select', 'select', ['role=button:动态类目', '--value-ref', 'optionName', '--intent', '选择本次动态选项'], 'aria');
  await secondCheck('aria-dynamic-assert', 'text', ['--within', 'css=#dyn-status', '--value-from-action', secondSelected.action_id], 'aria');
  await secondPage('aria-screenshot', 'screenshot', ['--intent', 'ARIA完成态'], 'aria');
  assert.equal((await invoke('second-source-stop', ['session', 'stop', '-s', secondSid])).result, 'pass');
  sessions.delete(secondSid);
  const secondReport = await invoke('second-source-report', ['report', '-s', secondSid]);
  const secondFacts = readJson(secondReport.json);
  assert.equal(secondFacts.result, 'PASS');
  factContract(secondFacts.cases[0]);
  acceptanceContract(secondFacts.cases[0], dynamicAcceptance);
  const secondFields = fieldValues(secondFacts.cases[0].steps.flatMap(step => step.assertions));
  assert.equal(secondFields['商品名称'], secondFill.saved.value);
  assert.equal(secondFields['工具描述'], secondFill.saved.value);
  const secondOption = secondFacts.cases[0].events.find(event => event.checkId === 'aria-dynamic-assert').resolvedExpected;
  assert.notEqual(secondFill.saved.value, fill.saved.value, 'Independent recordings reused a dynamic input');
  assert.notEqual(secondOption, sourceOption, 'Independent recordings reused a dynamic option');
  receipt.source_names.push(secondFill.saved.value);
  receipt.source_options.push(secondOption);
  receipt.second_source = secondReport;

  const blockedSid = (await invoke('blocked-source-start', ['session', 'start', '--auth', 'imported', '--browser', 'managed', '--acceptance', acceptanceFile])).session_id;
  sessions.add(blockedSid);
  await invoke('blocked-source-open', ['page', 'open', '-s', blockedSid, `${origin}/contract-beta-actions`, '--intent', '打开缺绑定夹具', '--group', 'click']);
  await invoke('blocked-source-assert', ['assert', 'text', '-s', blockedSid, '点击0;trusted:false', '--within', 'css=#beta-click-status', '--group', 'click']);
  await invoke('blocked-source-screenshot', ['page', 'screenshot', '-s', blockedSid, '--intent', '缺绑定完成态', '--group', 'click']);
  assert.equal((await invoke('blocked-source-stop', ['session', 'stop', '-s', blockedSid])).result, 'pass');
  sessions.delete(blockedSid);
  const blockedReport = await invoke('blocked-source-report', ['report', '-s', blockedSid]);
  const blockedFacts = readJson(blockedReport.json);
  assert.equal(blockedFacts.result, 'BLOCKED');
  assert.equal(blockedFacts.cases[0].run.status, 'PASS', 'Execution and acceptance coverage must stay distinct');
  assert.equal(blockedFacts.cases[0].acceptanceCoverage.bound, 0);
  assert.equal(blockedFacts.cases[0].acceptanceCoverage.total, 12);
  assert.equal(blockedFacts.cases[0].acceptanceCoverage.result, 'UNVERIFIED');
  assert(blockedFacts.cases[0].acceptanceCoverage.scenarios.every(scenario => scenario.checks.every(check => check.status === 'unbound')));
  factContract(blockedFacts.cases[0]);
  const merged = await invoke('source-merge', ['report', 'merge', sid, falseSid, blockedSid, '--title', '包验证 Source 汇总']);
  const mergedFacts = readJson(merged.json);
  assert.equal(mergedFacts.report_schema_version, 2);
  assert.equal(mergedFacts.result, 'FAIL');
  assert.equal(merged.conclusion, 'FAIL');
  assert.equal(mergedFacts.cases.length, 3);
  for (const [i, original] of [report, falseFacts, blockedFacts].entries()) {
    const current = mergedFacts.cases[i];
    assert.equal(current.result, original.result);
    for (const key of ['run', 'events', 'images', 'flow', 'acceptance', 'acceptanceCoverage']) assert.deepEqual(current[key], original.cases[0][key], `Merge changed ${key}`);
  }
  receipt.source_merge = merged;
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
  for (const check of ir.steps.flatMap(step => step.checks ?? []).filter(check => check.assert)) {
    const event = report.cases[0].events.find(event => event.checkId === check.report_ref.check_id);
    assert.equal(check.report_ref.group, event.group);
    assert.equal(check.report_ref.source_event_id, event.id);
  }
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
  const auth = ['--auth', 'imported', '--browser', 'managed', '--auth-state', state, '--acceptance', acceptanceFile];
  const skipBefore = await observations();
  const skipped = await invoke('verify-skip-test', ['verify', irFile, '--skip-test', ...auth]);
  assert.equal(skipped.status, 'skipped');
  assert.equal(skipped.report.json, undefined);
  assert.equal(skipped.report.playwright_html, undefined);
  assert(!fs.existsSync(path.join(skipped.run_dir, 'report.json')), 'Skipped run fabricated a Playwright report');
  assert.equal(fileSha(skipped.ir_snapshot), irSha);
  const skipFacts = reportFacts(skipped.run_dir, skipped.report);
  assert.equal(skipFacts.report.result, 'BLOCKED');
  assert.equal(skipFacts.report.cases[0].run.status, 'BLOCKED');
  assert.deepEqual(skipFacts.report.cases[0].steps, []);
  assert.deepEqual(skipFacts.report.cases[0].images, []);
  assert(!skipFacts.report.cases[0].events.some(event => event.executed === true || event.type === 'action' || event.type === 'assert'));
  assert.equal(skipFacts.report.cases[0].acceptanceCoverage.bound, 0);
  assert.equal(skipFacts.report.cases[0].acceptanceCoverage.total, 12);
  receipt.reports.push({ run_dir: skipped.run_dir, status: 'skipped', ...skipFacts.evidence });
  await delta(skipBefore, 0);
  intactCase();
  const verified = await replay('verify', ['verify', irFile, ...auth]);
  assert.notEqual(verified.fields['商品名称'], fill.saved.value, 'Replay reused the recorded literal');
  const firstNegative = await fetch(`${origin}/fixture-mode`, { method: 'POST', body: '{"negative":true,"category_noop":false}' });
  assert.equal(firstNegative.status, 200);
  assert.deepEqual(await firstNegative.json(), { negative: true, category_noop: false });
  await rejected('land-first-failure', ['land', irFile, ...auth], { code: 1, error: 'TEST_FAILED' },
    path.join(workRoot, 'workspace', 'verify', `${caseName}-first-land-failure`), undefined, 1);
  const restoredMode = await fetch(`${origin}/fixture-mode`, { method: 'POST', body: '{"negative":false,"category_noop":false}' });
  assert.equal(restoredMode.status, 200);
  assert.deepEqual(await restoredMode.json(), { negative: false, category_noop: false });
  const landBefore = await observations();
  const landed = await invoke('land', ['land', irFile, ...auth]);
  assert.equal(landed.status, 'landed');
  assert.equal(landed.case_root, caseRoot);
  savedManifest = manifest(caseRoot);
  assert.equal(savedManifest[`${caseName}.ir.json`], irSha);
  assert.equal(landed.verification.status, 'passed');
  assert.equal(fileSha(landed.verification.ir_snapshot), irSha);
  assert.equal(fileSha(landed.verification.test_ts), savedManifest[path.join('__tests__', `${caseName}.test.ts`)]);
  nativeReport(landed.verification.run_dir, landed.verification.report, 'passed');
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
  defaultProof.execution_files = Object.fromEntries(['json', 'html', 'facts_json', 'facts_archive', 'report_html', 'run_receipt'].map(key => [key, defaultProof[key]]));
  defaultProof.execution_run_dir = defaultProof.run_dir;
  for (const key of ['json', 'html', 'facts_json', 'facts_archive', 'report_html', 'run_receipt']) {
    defaultProof[key] = path.join(archivedDefault, path.relative(defaultProof.run_dir, defaultProof[key]));
  }
  defaultProof.run_dir = archivedDefault;
  assert.equal(fileSha(defaultProof.json), defaultProof.json_sha256);
  assert.equal(fileSha(defaultProof.html), defaultProof.html_sha256);
  assert.equal(fileSha(defaultProof.facts_json), defaultProof.facts_sha256);
  assert.equal(fileSha(defaultProof.facts_archive), defaultProof.facts_sha256);
  assert.equal(fileSha(defaultProof.report_html), defaultProof.report_html_sha256);
  assert.equal(fileSha(defaultProof.run_receipt), defaultProof.run_receipt_sha256);
  await rejected('case-empty-state', ['case', 'run', caseName, '--auth', 'imported', '--browser', 'managed', '--auth-state', ''], { code: 2, error: 'USAGE' }, path.join(workRoot, 'workspace', 'verify', `${caseName}-case-empty`));
  await rejected('case-profile-state', ['case', 'run', caseName, '--auth', 'profile', '--browser', 'chrome', '--auth-state', state], { code: 2, error: 'USAGE' }, path.join(workRoot, 'workspace', 'verify', `${caseName}-case-conflict`));
  for (const bad of badStates) await rejected(`case-${bad.name}`, ['case', 'run', caseName, '--auth', 'imported', '--browser', 'managed', '--auth-state', bad.file], { code: 1, error: 'TEST_FAILED' }, path.join(workRoot, 'workspace', 'verify', `${caseName}-case-${bad.name}`), bad.error);
  await replay('case-explicit-overrides-env', ['case', 'run', caseName, '--auth', 'auto', '--browser', 'managed', '--auth-state', state, '--acceptance', acceptanceFile], { E2ET_REPLAY_AUTH: 'invalid', E2ET_REPLAY_BROWSER: 'invalid', E2ET_AUTH_STATE: badStates[0].file });
  const negativeMode = await fetch(`${origin}/fixture-mode`, { method: 'POST', body: '{"negative":true,"category_noop":false}' });
  assert.equal(negativeMode.status, 200);
  assert.deepEqual(await negativeMode.json(), { negative: true, category_noop: false });
  const negativeOutput = path.join(workRoot, 'workspace', 'verify', `${caseName}-negative`);
  await rejected('case-negative', ['case', 'run', caseName, ...auth], { code: 1, error: 'TEST_FAILED' }, negativeOutput, undefined, 1);
  await rejected('land-force-failure', ['land', irFile, ...auth, '--force'], { code: 1, error: 'TEST_FAILED' },
    path.join(workRoot, 'workspace', 'verify', `${caseName}-force-failure`), undefined, 1);
  intactCase();
  assert(replayNames.size >= 2 && replayOptions.size >= 2, 'Missing independent dynamic replays');
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
