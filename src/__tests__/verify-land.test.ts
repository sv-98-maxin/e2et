/** 本地个人库、render 纯编译、verify 完整证据与 land 原子发布；浏览器执行器只用既有 DI。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { dispatch as rawDispatch } from '../cli/router.js';
import type { RouterDeps } from '../cli/context.js';
import * as packageVersion from '../package-version.js';
import { irDigest, renderIR, testDigest } from '../render/render.js';
import { type IRv2, type Step } from '../ir/schema.js';
import { loadStaticCase } from '../cases/snapshot.js';

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    renameSync: vi.fn(actual.renameSync),
    writeFileSync: vi.fn(actual.writeFileSync),
    openSync: vi.fn(actual.openSync),
    closeSync: vi.fn(actual.closeSync),
  };
});

const cliRoot = path.resolve(import.meta.dirname, '../..');
const cliRequire = createRequire(path.join(cliRoot, 'package.json'));

function caseIR(): IRv2 {
  const step = (partial: Partial<Step> & { id: string; action: Step['action']; trace_ref: string }): Step =>
    ({ intent: partial.id, ...partial }) as Step;
  return {
    schema_version: 3, name: 'verify-case', url: 'http://127.0.0.1:1234/', covered_pages: [], env: 'pre',
    provenance: { session_id: 's_verify', auth_source: 'imported', browser_source: 'managed', tool_version: '0.6.0', generated_at: '2026-10-27T00:00:00Z', mocked: false },
    steps: [
      step({ id: 's1', action: 'open', value: { literal: 'http://127.0.0.1:1234/' }, args: { url: 'http://127.0.0.1:1234/' }, trace_ref: 'a1' }),
      step({ id: 's2', action: 'fill', locator: { label: '名称' }, value: { template: 'CLI_${ts}' }, trace_ref: 'a2' }),
      step({
        id: 's3', action: 'click', locator: { role: 'button', name: '提交' },
        creates: { entity: 'tool', path: '/create' },
        wait: [{ api: { path: '/create', nav: 1, call_index: 1 } }],
        checks: [
          { assert: { api: { path: '/create', nav: 1, call_index: 1 }, expect: [{ path: 'success', op: 'eq', value: true }] } },
          { assert: { text: { contains: '提交成功' } } },
        ],
        trace_ref: 'a3',
      }),
    ],
  };
}

function caseTrace(): any[] {
  return [
    { t: 'session', session_id: 's_verify', schema_version: 3, env: 'pre', tool_version: '0.6.0', auth_source: 'imported', browser_source: 'managed' },
    { t: 'action', id: 'a1', kind: 'open', result: { ok: true }, replayable: true },
    { t: 'action', id: 'a2', kind: 'fill', result: { ok: true }, replayable: true, target: { matches: 1, candidates: [{ by: 'label', name: '名称', matches: 1 }] } },
    { t: 'action', id: 'a3', kind: 'click', creates: { entity: 'tool', path: '/create' }, result: { ok: true }, replayable: true, settled_by: [{ kind: 'request', ref: 'r1', ms: 100 }], target: { matches: 1, candidates: [{ by: 'role', role: 'button', name: '提交', matches: 1 }] } },
    { t: 'request', id: 'r1', path: '/create', nav: 'n1', call_index: 1, creates: 'tool', triggered_by: 'a3', mocked: false },
    { t: 'assert', after: 'a3', kind: 'api', expect: { path: 'success', op: '==', value: true, req: { path: '/create', nav: 'n1', call_index: 1 } }, pass: true, replayable: true },
    { t: 'assert', after: 'a3', kind: 'text', expect: { contains: '提交成功' }, pass: true, replayable: true },
    { t: 'session_end', result: 'pass', mocked: false },
  ];
}

let home: string, library: string, source: string, traceFile: string, previous: string | undefined;
let ir: IRv2, events: any[], stdout: string[], deps: RouterDeps;
let uploadName = '', blobSha = '';

async function dispatch(argv: string[], input: RouterDeps): Promise<number> {
  if (!input.homeDir || path.resolve(input.homeDir) !== path.resolve(home)) {
    throw new Error('测试门禁：RouterDeps.homeDir 必须指向本用例隔离目录');
  }
  return rawDispatch(argv, input);
}

function writeSources() {
  fs.writeFileSync(source, JSON.stringify(ir));
  fs.writeFileSync(traceFile, events.map((event) => JSON.stringify(event)).join('\n') + '\n');
}
const envelope = () => JSON.parse(stdout.at(-1)!);
const expectedTest = () => { const snapshot = loadStaticCase(source); if (!snapshot || !('ir' in snapshot)) throw Error('bad fixture'); return Buffer.from(renderIR(snapshot.ir)); };
const targetRoot = () => path.join(library, 'verify-case');
const target = (kind: 'ir' | 'test' | 'fixture') => kind === 'ir'
  ? path.join(targetRoot(), 'verify-case.ir.json')
  : kind === 'test'
    ? path.join(targetRoot(), '__tests__/verify-case.test.ts')
    : path.join(targetRoot(), 'cases/fixtures/verify-case', uploadName);
const INITIAL_FD_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0);

/** 假 runner 必须产出与真 runtime 同构的 Playwright 产物，否则新验收链路判定 BLOCKED。 */
function writePassingEvidence(runDir: string): void {
  const runId = path.basename(runDir);
  const attachment = (name: string, value: unknown) => ({
    name, contentType: 'application/json', body: Buffer.from(JSON.stringify(value)).toString('base64'),
  });
  fs.writeFileSync(path.join(runDir, 'report.json'), JSON.stringify({
    suites: [{ specs: [{ id: 'spec-1', title: 'verify-case', tests: [{ results: [{
      status: 'passed', duration: 1,
      attachments: [
        attachment('ir-report', {
          report_schema_version: 2, result: 'PASS', mocked: false,
          cases: [{
            id: 'case-1', name: 'verify-case', result: 'PASS',
            steps: [{ id: 's1', status: 'pass' }],
            events: [{ id: 'e1', sequence: 0, type: 'action', kind: 'open', status: 'pass' }],
            images: [], run: { id: runId, mode: 'replay', status: 'PASS' },
          }],
        }),
        attachment('replay-environment', { auth_source: 'imported', browser_source: 'managed' }),
      ],
    }] }] }] }],
    stats: { expected: 1, unexpected: 0, skipped: 0, flaky: 0 },
  }));
  fs.mkdirSync(path.join(runDir, 'html-report'), { recursive: true });
  fs.writeFileSync(path.join(runDir, 'html-report', 'index.html'),
    '<html><template id="playwrightReportBase64">data:application/zip;base64,fixture</template></html>');
}

const passingRunner = async (_env: NodeJS.ProcessEnv, _root: string, testFile: string): Promise<number> => {
  writePassingEvidence(path.dirname(path.dirname(testFile)));
  return 0;
};

function writeOldCase(bytes = 'old') {
  fs.mkdirSync(path.dirname(target('test')), { recursive: true });
  fs.writeFileSync(target('test'), bytes);
  fs.mkdirSync(targetRoot(), { recursive: true });
}

function openedInitialFd(): number | undefined {
  const index = vi.mocked(fs.openSync).mock.calls.findIndex(([file, flags]) =>
    String(file) === targetRoot() && Number(flags) === INITIAL_FD_FLAGS
  );
  return index >= 0 ? vi.mocked(fs.openSync).mock.results[index]?.value as number : undefined;
}

function initialFdClosed(): boolean {
  const fd = openedInitialFd();
  return fd !== undefined && vi.mocked(fs.closeSync).mock.calls.some(([closed]) => closed === fd);
}

beforeEach(() => {
  previous = process.env.E2ET_HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-land-'));
  process.env.E2ET_HOME = home;
  library = path.join(home, '.e2et/library');
  source = path.join(home, 'workspace/ir/verify-case.ir.json');
  traceFile = path.join(home, 'workspace/traces/s_verify/trace.jsonl');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.mkdirSync(path.dirname(traceFile), { recursive: true });
  ir = caseIR(); events = caseTrace(); stdout = [];
  writeSources();
  deps = { env: process.env, homeDir: home, stdout: (line) => stdout.push(line), stderr: () => {}, playwrightRunner: passingRunner };
});
afterEach(() => {
  if (previous === undefined) delete process.env.E2ET_HOME;
  else process.env.E2ET_HOME = previous;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('render / verify / land 分层', () => {
  it('缺少或改写 homeDir 时在 dispatch 前拒绝，禁止写真实 HOME', async () => {
    await expect(dispatch(['case', 'list'], { ...deps, homeDir: undefined })).rejects.toThrow('homeDir');
    await expect(dispatch(['land', source], { ...deps, homeDir: path.join(home, 'other') })).rejects.toThrow('homeDir');
    expect(fs.existsSync(library)).toBe(false);
  });
  it('render 静态纯编译；verify 完整门禁；land 写固定个人库', async () => {
    expect(await dispatch(['render', source, '--output', path.join(home, 'render')], deps)).toBe(0);
    expect(envelope().data).toMatchObject({ status: 'compiled', replay: 'not_run' });
    expect(await dispatch(['verify', source, '--skip-test'], deps)).toBe(0);
    expect(envelope().data.status).toBe('skipped');
    expect(await dispatch(['land', source], deps)).toBe(0);
    expect(envelope().data).toMatchObject({ status: 'landed', case_root: targetRoot() });
    expect(fs.readFileSync(target('ir'))).toEqual(fs.readFileSync(source));
    expect(fs.readFileSync(target('test'))).toEqual(expectedTest());
  });
  it.each(['failed-action', 'failed-assert', 'timeout', 'mock', 'missing-ref', 'missing-action'])('%s：render 只看静态 IR，verify/land 拒绝', async (defect) => {
    if (defect === 'failed-action') events[1].result.ok = false;
    if (defect === 'failed-assert') events[5].pass = false;
    if (defect === 'timeout') events[1].settled_by = [{ kind: 'timeout' }];
    if (defect === 'mock') events.splice(1, 0, { t: 'mock', op: 'add' });
    if (defect === 'missing-action') ir.steps[0].trace_ref = 'nonexistent';
    if (defect === 'missing-ref') ir.steps[2].wait = [{ api: { path: '/missing', nav: 1, call_index: 1 } }];
    writeSources();
    const runner = vi.fn(async () => 0); deps.playwrightRunner = runner;
    expect(await dispatch(['render', source, '--output', path.join(home, 'render')], deps)).toBe(defect === 'missing-ref' ? 1 : 0);
    if (defect !== 'missing-ref') expect(envelope().data.status).toBe('compiled');
    expect(await dispatch(['verify', source, '--skip-test'], deps)).toBe(1);
    expect(await dispatch(['land', source, '--force'], deps)).toBe(1);
    expect(runner).not.toHaveBeenCalled();
    expect(fs.existsSync(targetRoot())).toBe(false);
  });
  it('缺 trace：render 可用，verify/land 仍拒绝', async () => {
    fs.unlinkSync(traceFile);
    expect(await dispatch(['render', source, '--output', path.join(home, 'render')], deps)).toBe(0);
    expect(await dispatch(['verify', source, '--skip-test'], deps)).toBe(1);
    expect(envelope().error.code).toBe('CHECK_FAILED');
    expect(await dispatch(['land', source], deps)).toBe(1);
  });
  it('no-creates 只读用例可编译、验证和落库', async () => {
    delete ir.steps[2].creates;
    writeSources();
    expect(await dispatch(['render', source, '--output', path.join(home, 'render')], deps)).toBe(0);
    expect(await dispatch(['verify', source, '--skip-test'], deps)).toBe(0);
    expect(await dispatch(['land', source], deps)).toBe(0);
  });
  it('坏 JSON/schema/静态 check 在 render 写入前拒绝', async () => {
    fs.writeFileSync(source, '{broken');
    expect(await dispatch(['render', source, '--output', path.join(home, 'render')], deps)).toBe(1);
    expect(fs.existsSync(path.join(home, 'render/verify-case.test.ts'))).toBe(false);
    fs.writeFileSync(source, JSON.stringify({ schema_version: 99 }));
    expect(await dispatch(['render', source, '--output', path.join(home, 'render')], deps)).toBe(1);
    expect(envelope().error.code).toBe('SCHEMA');
  });
  it('编译头按首个空行完整解析，不因 env 标签超过 4KB 截断', async () => {
    ir.env = 'a'.repeat(5000);
    writeSources();
    expect(await dispatch(['land', source], deps)).toBe(0);
    expect(await dispatch(['case', 'list'], deps)).toBe(0);
    expect(envelope().data.cases[0].name).toBe('verify-case');
  });
});

describe('upload 与 fixture 证据', () => {
  const uploadBytes2 = Buffer.from([0, 255, 7]);
  function uploadLocal() {
    blobSha = createHash('sha256').update(uploadBytes2).digest('hex');
    uploadName = `${blobSha}-input.bin`;
    events.splice(3, 0, { t: 'action', id: 'upload', kind: 'upload', result: { ok: true }, args: { files: [{ name: 'input.bin', blob_ref: `blobs/${blobSha}` }] }, target: { matches: 1, candidates: [{ by: 'role', role: 'button', name: '上传', matches: 1 }] } });
    ir.steps.splice(2, 0, { id: 'upload', intent: '上传', action: 'upload', locator: { role: 'button', name: '上传' }, args: { files: [uploadName] }, trace_ref: 'upload' });
    fs.mkdirSync(path.join(path.dirname(source), 'cases/fixtures/verify-case'), { recursive: true });
    fs.writeFileSync(path.join(path.dirname(source), 'cases/fixtures/verify-case', uploadName), uploadBytes2);
    fs.mkdirSync(path.join(home, 'workspace/traces/s_verify/blobs'), { recursive: true });
    fs.writeFileSync(path.join(home, 'workspace/traces/s_verify/blobs', blobSha), uploadBytes2);
    writeSources();
  }
  it('verify/land 保留 fixture 原字节，执行失败不碰个人库', async () => {
    uploadLocal();
    writeOldCase('library-old');
    expect(await dispatch(['verify', source, '--skip-test'], deps)).toBe(0);
    expect(fs.readFileSync(target('test'), 'utf8')).toBe('library-old');
    expect(await dispatch(['land', source, '--force'], deps)).toBe(0);
    expect(fs.readFileSync(target('fixture'))).toEqual(uploadBytes2);
    expect(fs.readFileSync(target('ir'))).toEqual(fs.readFileSync(source));
    expect(fs.readFileSync(target('test'))).toEqual(expectedTest());
  });
  it.each(['tampered', 'missing', 'blob-gone'])('upload 证据链断裂 %s：land 拒且不占目标', async (defect) => {
    uploadLocal();
    if (defect === 'missing') fs.unlinkSync(path.join(path.dirname(source), 'cases/fixtures/verify-case', uploadName));
    if (defect === 'tampered') fs.writeFileSync(path.join(path.dirname(source), 'cases/fixtures/verify-case', uploadName), 'tampered');
    if (defect === 'blob-gone') fs.unlinkSync(path.join(home, 'workspace/traces/s_verify/blobs', blobSha));
    expect(await dispatch(['land', source], deps)).toBe(1);
    expect(envelope().error.code).toBe('FIXTURE_UNAVAILABLE');
    expect(fs.existsSync(targetRoot())).toBe(false);
  });
  it('候选文件按 trace 索引与 blob/name 对照：[A,A] 或 [B,A] 不能冒充 [A,B]', async () => {
    const a = Buffer.from('A'), b = Buffer.from('B');
    const ah = createHash('sha256').update(a).digest('hex');
    const bh = createHash('sha256').update(b).digest('hex');
    const an = `${ah}-a.bin`, bn = `${bh}-b.bin`;
    events.splice(3, 0, { t: 'action', id: 'upload', kind: 'upload', result: { ok: true }, args: { files: [{ name: 'a.bin', blob_ref: `blobs/${ah}` }, { name: 'b.bin', blob_ref: `blobs/${bh}` }] }, target: { matches: 1, candidates: [{ by: 'role', role: 'button', name: '上传', matches: 1 }] } });
    ir.steps.splice(2, 0, { id: 'upload', intent: '上传', action: 'upload', locator: { role: 'button', name: '上传' }, args: { files: [an, bn] }, trace_ref: 'upload' });
    const fixtureDir = path.join(path.dirname(source), 'cases/fixtures/verify-case');
    fs.mkdirSync(fixtureDir, { recursive: true });
    fs.writeFileSync(path.join(fixtureDir, an), a); fs.writeFileSync(path.join(fixtureDir, bn), b);
    fs.mkdirSync(path.join(home, 'workspace/traces/s_verify/blobs'), { recursive: true });
    fs.writeFileSync(path.join(home, 'workspace/traces/s_verify/blobs', ah), a);
    fs.writeFileSync(path.join(home, 'workspace/traces/s_verify/blobs', bh), b);
    writeSources();
    expect(await dispatch(['verify', source, '--skip-test'], deps)).toBe(0);
    for (const files of [[an, an], [bn, an]]) {
      ir.steps[2].args = { files };
      writeSources();
      expect(await dispatch(['verify', source, '--skip-test'], deps)).toBe(1);
      expect(envelope().error.code).toBe('FIXTURE_UNAVAILABLE');
    }
    events.find((event) => event.id === 'upload').args.files = [
      { name: 'a.bin', blob_ref: `blobs/${ah}` }, { name: 'a.bin', blob_ref: `blobs/${ah}` },
    ];
    ir.steps[2].args = { files: [an, an] };
    writeSources();
    expect(await dispatch(['verify', source, '--skip-test'], deps)).toBe(0);
  });
});

describe('verify 私有运行与 bytes 快照', () => {
  it.each([0, 1, 'throw'])('执行器 %s：个人库同名文件不变，私有 run 保留证据', async (outcome) => {
    writeOldCase('dirty library');
    let runDir = '';
    deps = { ...deps, env: { E2ET_HOME: home, E2ET_REPLAY_AUTH: 'profile', E2ET_REPLAY_BROWSER: 'chrome' } };
    deps.playwrightRunner = async (runnerDeps, cliPackageRoot, testFile, testTimeoutMs) => {
      runDir = path.dirname(path.dirname(testFile));
      expect(cliPackageRoot).toBe(cliRoot);
      expect(runnerDeps.env.E2ET_HOME).toBe(home);
      expect(runnerDeps.env.E2ET_REPLAY_AUTH).toBe('imported');
      expect(runnerDeps.env.E2ET_REPLAY_BROWSER).toBe('managed');
      expect(testTimeoutMs).toBeGreaterThan(0);
      expect(runDir.startsWith(path.join(home, 'workspace/verify/'))).toBe(true);
      expect(fs.readFileSync(path.join(runDir, 'verify-case.ir.json'))).toEqual(fs.readFileSync(source));
      expect(fs.existsSync(path.join(runDir, 'runtime/runner.ts'))).toBe(true);
      for (const name of ['@playwright/test', 'playwright', 'playwright-core', 'ws']) {
        expect(fs.realpathSync(path.join(runDir, 'node_modules', name))).toBe(fs.realpathSync(path.dirname(cliRequire.resolve(`${name}/package.json`))));
      }
      if (outcome === 'throw') throw new Error('runner boom');
      if (outcome === 0) writePassingEvidence(runDir);
      return outcome as number;
    };
    expect(await dispatch(['verify', source, '--auth', 'imported', '--browser', 'managed'], deps)).toBe(outcome === 0 ? 0 : 1);
    expect(fs.readFileSync(target('test'), 'utf8')).toBe('dirty library');
    expect(fs.existsSync(path.join(runDir, '__tests__/verify-case.test.ts'))).toBe(true);
  });
  it.each(['root', 'output'])('verify %s symlink 在写入前拒绝', async kind => {
    const outside = path.join(home, 'outside'); fs.mkdirSync(outside);
    const link = kind === 'root' ? path.join(home, 'workspace/verify') : path.join(home, 'workspace/verify/output');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(outside, link, 'dir');
    const runner = vi.fn(async () => 0);
    expect(await dispatch(['verify', source, ...(kind === 'output' ? ['--output', link] : [])], { ...deps, playwrightRunner: runner })).toBe(1);
    expect(envelope().error.code).toBe('SYMLINK');
    expect(runner).not.toHaveBeenCalled();
    expect(fs.readdirSync(outside)).toEqual([]);
  });
});

describe('land 目标预检、原子替换与回滚', () => {
  beforeEach(() => {
    vi.mocked(fs.openSync).mockClear();
    vi.mocked(fs.closeSync).mockClear();
  });
  it('无 force 已存在：不跑浏览器且旧字节不变', async () => {
    writeOldCase('protected');
    const runner = vi.fn(async () => 0);
    expect(await dispatch(['land', source], { ...deps, playwrightRunner: runner })).toBe(1);
    expect(envelope().error.code).toBe('ALREADY_EXISTS');
    expect(runner).not.toHaveBeenCalled();
    expect(fs.readFileSync(target('test'), 'utf8')).toBe('protected');
  });
  it('验证期间目标出现：拒绝且不覆盖竞争目录', async () => {
    deps.playwrightRunner = async (_env, _root, testFile) => { writeOldCase('racer'); writePassingEvidence(path.dirname(path.dirname(testFile))); return 0; };
    expect(await dispatch(['land', source, '--force'], deps)).toBe(1);
    expect(envelope().error.code).toBe('ALREADY_EXISTS');
    expect(fs.readFileSync(target('test'), 'utf8')).toBe('racer');
  });
  it.each(['inode', 'symlink'])('stage 写入期间目标被替换为 %s：拒绝、保留竞争目标并清 stage', async kind => {
    writeOldCase('initial');
    const victim = path.join(home, 'victim');
    fs.mkdirSync(victim);
    fs.writeFileSync(path.join(victim, 'marker'), 'original');
    const writeFile = vi.mocked(fs.writeFileSync);
    const original = writeFile.getMockImplementation()!;
    let swapped = false;
    writeFile.mockImplementation(((file: fs.PathLike, data: any, options?: any) => {
      if (!swapped && String(file).includes('-stage-') && String(file).endsWith('__tests__/verify-case.test.ts')) {
        swapped = true;
        fs.rmSync(targetRoot(), { recursive: true, force: true });
        if (kind === 'symlink') {
          fs.symlinkSync(victim, targetRoot(), 'dir');
        } else {
          fs.mkdirSync(path.dirname(target('test')), { recursive: true });
          original(target('test'), 'racer');
        }
      }
      return original(file, data, options);
    }) as typeof fs.writeFileSync);
    try {
      expect(await dispatch(['land', source, '--force'], deps)).toBe(1);
    } finally {
      writeFile.mockImplementation(original);
    }
    expect(envelope().error.code).toBe(kind === 'symlink' ? 'SYMLINK' : 'ALREADY_EXISTS');
    if (kind === 'symlink') expect(fs.readFileSync(path.join(victim, 'marker'), 'utf8')).toBe('original');
    else expect(fs.readFileSync(target('test'), 'utf8')).toBe('racer');
    expect(fs.readdirSync(library).filter((name) => name.startsWith('.'))).toEqual([]);
  });
  it('发布前目标被替换：拒绝并恢复竞争目录', async () => {
    writeOldCase('initial');
    const original = vi.mocked(fs.renameSync).getMockImplementation()!;
    let swapped = false;
    vi.mocked(fs.renameSync).mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      if (!swapped && String(from) === targetRoot() && String(to).includes('-backup-')) {
        swapped = true;
        fs.rmSync(targetRoot(), { recursive: true, force: true });
        fs.mkdirSync(path.dirname(target('test')), { recursive: true });
        fs.writeFileSync(target('test'), 'racer');
      }
      return original(from, to);
    }) as typeof fs.renameSync);
    try {
      expect(await dispatch(['land', source, '--force'], deps)).toBe(1);
    } finally {
      vi.mocked(fs.renameSync).mockImplementation(original);
    }
    expect(envelope().error.code).toBe('ALREADY_EXISTS');
    expect(fs.readFileSync(target('test'), 'utf8')).toBe('racer');
    expect(fs.readdirSync(library).filter((name) => name.startsWith('.'))).toEqual([]);
    expect(initialFdClosed()).toBe(true);
  });
  it('force 成功 land 关闭初始目录 fd', async () => {
    writeOldCase('old');
    expect(await dispatch(['land', source, '--force'], deps)).toBe(0);
    expect(initialFdClosed()).toBe(true);
  });
  it('verify 失败也关闭初始目录 fd', async () => {
    writeOldCase('old');
    deps.playwrightRunner = async () => 1;
    expect(await dispatch(['land', source, '--force'], deps)).toBe(1);
    expect(envelope().error.code).toBe('TEST_FAILED');
    expect(initialFdClosed()).toBe(true);
  });
  it('无初始目标 land 不打开目录 fd', async () => {
    expect(await dispatch(['land', source], deps)).toBe(0);
    expect(openedInitialFd()).toBeUndefined();
  });
  it('force 目录级替换，坏 gate 不绕且旧目录保留', async () => {
    writeOldCase('old');
    expect(await dispatch(['land', source, '--force'], deps)).toBe(0);
    const saved = fs.readFileSync(target('test'));
    expect(saved).toEqual(expectedTest());
    events[1].result.ok = false; writeSources();
    expect(await dispatch(['land', source, '--force'], deps)).toBe(1);
    expect(fs.readFileSync(target('test'))).toEqual(saved);
  });
  it('发布 rename 失败先恢复旧目录，再清 staging', async () => {
    writeOldCase('old-before-publish');
    const original = vi.mocked(fs.renameSync).getMockImplementation()!;
    vi.mocked(fs.renameSync).mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      if (String(from).includes('-stage-') && String(to) === targetRoot()) throw new Error('publish boom');
      return original(from, to);
    }) as typeof fs.renameSync);
    try {
      expect(await dispatch(['land', source, '--force'], deps)).toBe(1);
    } finally {
      vi.mocked(fs.renameSync).mockImplementation(original);
    }
    expect(envelope().error.message).toContain('已恢复旧用例');
    expect(fs.readFileSync(target('test'), 'utf8')).toBe('old-before-publish');
    expect(fs.readdirSync(library).filter((name) => name.startsWith('.'))).toEqual([]);
  });
  it('发布与恢复同时失败：保留 backup 并返回实际路径', async () => {
    writeOldCase('recover-me');
    const original = vi.mocked(fs.renameSync).getMockImplementation()!;
    vi.mocked(fs.renameSync).mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      if (String(from).includes('-stage-') && String(to) === targetRoot()) throw new Error('publish boom');
      if (String(from).includes('-backup-') && String(to) === targetRoot()) throw new Error('restore boom');
      return original(from, to);
    }) as typeof fs.renameSync);
    try {
      expect(await dispatch(['land', source, '--force'], deps)).toBe(1);
    } finally {
      vi.mocked(fs.renameSync).mockImplementation(original);
    }
    const failure = envelope().error;
    expect(failure.message).toContain('自动恢复失败');
    const backup = /旧用例备份保留在: (.+)$/.exec(failure.hint ?? '')?.[1];
    expect(backup).toBeTruthy();
    expect(fs.readFileSync(path.join(backup!, '__tests__/verify-case.test.ts'), 'utf8')).toBe('recover-me');
  });
  it.each(['library-link', 'target-link', 'child-link', 'fixture-link'])('land %s 在写入前拒绝', async kind => {
    const victim = path.join(home, 'victim'); fs.mkdirSync(victim); fs.writeFileSync(path.join(victim, 'marker'), 'original');
    if (kind === 'library-link') {
      fs.mkdirSync(path.join(home, '.e2et'), { recursive: true });
      fs.symlinkSync(victim, library, 'dir');
    } else if (kind === 'target-link') {
      fs.mkdirSync(library, { recursive: true });
      fs.symlinkSync(victim, targetRoot(), 'dir');
    } else if (kind === 'child-link') {
      writeOldCase();
      fs.symlinkSync(path.join(victim, 'marker'), target('ir'));
    } else {
      const bytes = Buffer.from('x'); const sha = createHash('sha256').update(bytes).digest('hex'); uploadName = `${sha}-a.bin`; blobSha = sha;
      fs.mkdirSync(path.join(home, 'workspace/traces/s_verify/blobs'), { recursive: true });
      fs.writeFileSync(path.join(home, 'workspace/traces/s_verify/blobs', sha), bytes);
      fs.mkdirSync(path.join(path.dirname(source), 'cases/fixtures/verify-case'), { recursive: true });
      fs.symlinkSync(path.join(victim, 'marker'), path.join(path.dirname(source), 'cases/fixtures/verify-case', uploadName));
      events.splice(3, 0, { t: 'action', id: 'upload', kind: 'upload', result: { ok: true }, args: { files: [{ name: 'a.bin', blob_ref: `blobs/${sha}` }] }, target: { matches: 1, candidates: [{ by: 'role', role: 'button', name: '上传', matches: 1 }] } });
      ir.steps.splice(2, 0, { id: 'upload', intent: '上传', action: 'upload', locator: { role: 'button', name: '上传' }, args: { files: [uploadName] }, trace_ref: 'upload' });
      writeSources();
    }
    expect(await dispatch(['land', source, '--force'], deps)).toBe(1);
    expect(envelope().error.code).toBe('SYMLINK');
    expect(fs.readFileSync(path.join(victim, 'marker'), 'utf8')).toBe('original');
  });
});

describe('case list / case run', () => {
  it('空库返回两个空数组；land 后 list 返回元数据并忽略点号 staging', async () => {
    expect(await dispatch(['case', 'list'], deps)).toBe(0);
    expect(envelope().data).toEqual({ cases: [], invalid: [] });
    expect(await dispatch(['land', source], deps)).toBe(0);
    fs.mkdirSync(path.join(library, '.orphan-stage'));
    expect(await dispatch(['case', 'list'], deps)).toBe(0);
    expect(envelope().data).toMatchObject({
      cases: [{ name: 'verify-case', url: ir.url, covered_pages: [], ir_file: target('ir'), test_file: target('test') }],
      invalid: [],
    });
  });
  it('坏 name/普通文件/symlink 条目进入 invalid', async () => {
    fs.mkdirSync(library, { recursive: true });
    fs.writeFileSync(path.join(library, 'plain-file'), 'x');
    fs.writeFileSync(path.join(library, 'bad name'), 'x');
    const outside = path.join(home, 'outside'); fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(library, 'linked'), 'dir');
    expect(await dispatch(['case', 'list'], deps)).toBe(0);
    expect(envelope().data.cases).toEqual([]);
    expect(envelope().data.invalid.map((item: any) => item.name)).toEqual(['bad name', 'linked', 'plain-file']);
  });
  it('case run 校验 name/存在性；跑保存 test 原字节且不读 trace', async () => {
    expect(await dispatch(['case', 'run', '../escape'], deps)).toBe(2);
    expect(await dispatch(['case', 'run', 'missing'], deps)).toBe(1);
    expect(await dispatch(['land', source], deps)).toBe(0);
    const savedTest = fs.readFileSync(target('test'));
    fs.unlinkSync(traceFile);
    let executed: Buffer | undefined;
    deps = { ...deps, env: { E2ET_HOME: home, E2ET_REPLAY_AUTH: 'profile', E2ET_REPLAY_BROWSER: 'chrome' } };
    deps.playwrightRunner = async (runnerDeps, _root, testFile, testTimeoutMs) => {
      expect(runnerDeps.env.E2ET_HOME).toBe(home);
      expect(runnerDeps.env.E2ET_REPLAY_AUTH).toBe('imported');
      expect(runnerDeps.env.E2ET_REPLAY_BROWSER).toBe('managed');
      expect(testTimeoutMs).toBeGreaterThan(0);
      executed = fs.readFileSync(testFile);
      writePassingEvidence(path.dirname(path.dirname(testFile)));
      return 0;
    };
    expect(await dispatch(['case', 'run', 'verify-case', '--auth', 'imported', '--browser', 'managed'], deps)).toBe(0);
    expect(executed).toEqual(savedTest);
    expect(envelope().data).toMatchObject({ status: 'passed', case: { name: 'verify-case', test_file: target('test') }, runtime: { playwright_version: '1.64.1' } });
  });
  it('保存 fixture 缺失时 case run 在浏览器前拒绝', async () => {
    const bytes = Buffer.from('fixture'); const sha = createHash('sha256').update(bytes).digest('hex');
    const name = `${sha}-input.bin`;
    events.splice(3, 0, { t: 'action', id: 'upload', kind: 'upload', result: { ok: true }, args: { files: [{ name: 'input.bin', blob_ref: `blobs/${sha}` }] }, target: { matches: 1, candidates: [{ by: 'role', role: 'button', name: '上传', matches: 1 }] } });
    ir.steps.splice(2, 0, { id: 'upload', intent: '上传', action: 'upload', locator: { role: 'button', name: '上传' }, args: { files: [name] }, trace_ref: 'upload' });
    fs.mkdirSync(path.join(home, 'workspace/traces/s_verify/blobs'), { recursive: true }); fs.writeFileSync(path.join(home, 'workspace/traces/s_verify/blobs', sha), bytes);
    fs.mkdirSync(path.join(path.dirname(source), 'cases/fixtures/verify-case'), { recursive: true }); fs.writeFileSync(path.join(path.dirname(source), 'cases/fixtures/verify-case', name), bytes);
    writeSources();
    expect(await dispatch(['land', source], deps)).toBe(0);
    fs.unlinkSync(path.join(targetRoot(), 'cases/fixtures/verify-case', name));
    const runner = vi.fn(async () => 0); deps.playwrightRunner = runner;
    expect(await dispatch(['case', 'run', 'verify-case'], deps)).toBe(1);
    expect(envelope().error.code).toBe('FIXTURE_UNAVAILABLE');
    expect(runner).not.toHaveBeenCalled();
  });
  it('TEST 摘要覆盖首行后全部原始字节；任意执行内容变化摘要即变', () => {
    const sourceIR = caseIR();
    const original = Buffer.from(renderIR(sourceIR));
    const lf = original.indexOf(0x0a);
    const tampered = Buffer.from(original);
    tampered[tampered.length - 1] ^= 1;
    expect(testDigest(original.subarray(lf + 1))).not.toBe(testDigest(tampered.subarray(lf + 1)));
    expect(original.subarray(0, lf).toString()).toContain(testDigest(original.subarray(lf + 1)));
    expect(renderIR(sourceIR)).toContain(irDigest(sourceIR));
  });
});

describe('CLI 依赖与 render 原子写', () => {
  it.each([0, 7])('CLI 安装依赖绝对 CLI 退出 %s：私有 config metadata 与输出路径', async status => {
    const fixtureCli = path.join(home, 'fixture-cli');
    fs.mkdirSync(fixtureCli);
    fs.writeFileSync(path.join(fixtureCli, 'package.json'), JSON.stringify({ name: 'e2et', version: '0.1.0-beta', type: 'module' }));
    fs.cpSync(path.join(cliRoot, 'runtime_assets'), path.join(fixtureCli, 'runtime_assets'), { recursive: true });
    for (const name of ['@playwright/test', 'playwright', 'playwright-core', 'ws']) {
      const dir = path.join(fixtureCli, 'node_modules', name); fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: name === 'ws' ? '8.21.3' : '1.64.1', type: 'module', exports: { './package.json': './package.json', './cli': './cli.js' } }));
    }
    const probe = path.join(home, 'runner-probe.json');
    const cli = path.join(fixtureCli, 'node_modules/@playwright/test/cli.js');
    fs.writeFileSync(cli, [
      "import * as fs from 'node:fs';", "import * as path from 'node:path';",
      "const config = process.argv.at(-1);", "const runDir = path.dirname(config);",
      'fs.writeFileSync(' + JSON.stringify(probe) + ', JSON.stringify({exec:process.execPath,argv:process.argv,cwd:process.cwd(),config,content:fs.readFileSync(config,"utf8")}));',
      "const att = (name, value) => ({ name, contentType: 'application/json', body: Buffer.from(JSON.stringify(value)).toString('base64') });",
      "const runId = path.basename(runDir);",
      "const ir = { report_schema_version: 2, result: 'PASS', mocked: false, cases: [{ id: 'c1', name: 'verify-case', result: 'PASS', steps: [{ id: 's1', status: 'pass' }], events: [{ id: 'e1', sequence: 0, type: 'action', kind: 'open', status: 'pass' }], images: [], run: { id: runId, mode: 'replay', status: 'PASS' } }] };",
      "const attachments = " + (status === 0 ? "[att('ir-report', ir), att('replay-environment', { auth_source: 'imported', browser_source: 'managed' })]" : '[]') + ";",
      "fs.writeFileSync(path.join(runDir, 'report.json'), JSON.stringify({ suites: [{ specs: [{ id: 'spec-1', title: 'verify-case', tests: [{ results: [{ status: " + (status === 0 ? "'passed'" : "'failed'") + ", duration: 1, attachments }] }] }] }], stats: { expected: " + (status === 0 ? 1 : 0) + ", unexpected: " + (status === 0 ? 0 : 1) + ", skipped: 0, flaky: 0 } }));",
      "fs.mkdirSync(path.join(runDir, 'html-report'), {recursive:true});",
      "fs.writeFileSync(path.join(runDir, 'html-report', 'index.html'), '<html><template id=\"playwrightReportBase64\">data:application/zip;base64,fixture</template></html>');",
      'process.exit(' + status + ');',
    ].join('\n'));
    delete deps.playwrightRunner;
    const packageRootSpy = vi.spyOn(packageVersion, 'packageRoot').mockReturnValue(fixtureCli);
    try { expect(await dispatch(['verify', source], deps)).toBe(status === 0 ? 0 : 1); }
    finally { packageRootSpy.mockRestore(); }
    const evidence = JSON.parse(fs.readFileSync(probe, 'utf8'));
    expect(evidence.argv.slice(1, 4)).toEqual([fs.realpathSync(cli), 'test', '--config']);
    expect(evidence.content).toContain('metadata: {"e2et_version":"0.1.0-beta","playwright_version":"1.64.1","e2et_run":{"id":');
    expect(fs.existsSync(evidence.config)).toBe(false);
  });
  it('render 用同目录临时文件替换；rename 失败旧文件不变', async () => {
    const outDir = path.join(home, 'render'); fs.mkdirSync(outDir);
    const out = path.join(outDir, 'verify-case.test.ts'); fs.writeFileSync(out, 'old');
    const original = vi.mocked(fs.renameSync).getMockImplementation()!;
    vi.mocked(fs.renameSync).mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      if (String(to) === out) throw new Error('rename boom');
      return original(from, to);
    }) as typeof fs.renameSync);
    try { expect(await dispatch(['render', source, '--output', outDir], deps)).toBe(1); }
    finally { vi.mocked(fs.renameSync).mockImplementation(original); }
    expect(fs.readFileSync(out, 'utf8')).toBe('old');
    expect(fs.readdirSync(outDir)).toEqual(['verify-case.test.ts']);
  });
});
