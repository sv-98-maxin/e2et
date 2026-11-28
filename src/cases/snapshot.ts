import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { readTrace, parseTrace } from '../ir/trace-reader.js';
import { checkIr } from '../ir/check.js';
import { judgeIr } from '../ir/judge.js';
import { parseIRv2 } from '../ir/schema.js';
import { irDigest, renderIR, testDigest } from '../render/render.js';
import { isSafeFixtureName } from '../shared/step-input.js';
import { readTraceBlob } from '../daemon/trace.js';
import { linkedPath } from '../path-safety.js';
import type { IRv2 } from '../ir/schema.js';

export interface StaticCaseSnapshot {
  ir: IRv2;
  raw: Buffer;
}

export interface CaseSnapshot extends StaticCaseSnapshot {
  test: Buffer;
  fixtures: Map<string, Buffer>;
  compiler: string;
  sourceIrFile: string;
  sourceTestFile?: string;
}

export interface LoadFailure {
  load_error: { code: string; message: string; hint?: string };
}

export interface TestHeader {
  irDigest: string;
  compiler: string;
}

export function loadFailure(code: string, message: string, hint?: string): LoadFailure {
  return { load_error: { code, message, ...(hint ? { hint } : {}) } };
}

export function isLoadFailure(value: unknown): value is LoadFailure {
  return typeof value === 'object' && value !== null && 'load_error' in value;
}

export function isCaseName(name: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name);
}

export function loadStaticCase(irFile: string): StaticCaseSnapshot | LoadFailure {
  if (linkedPath(irFile)) return loadFailure('SYMLINK', `IR 文件或父目录是 symlink: ${irFile}`);
  let raw: Buffer;
  try { raw = fs.readFileSync(irFile); } catch {
    return loadFailure('NOT_FOUND', `IR 文件不存在或不可读: ${irFile}`);
  }
  let input: unknown;
  try { input = JSON.parse(raw.toString('utf8')); } catch {
    return loadFailure('SCHEMA', 'IR JSON 解析失败');
  }
  const parsed = parseIRv2(input);
  if (!parsed.ok) return loadFailure('SCHEMA', JSON.stringify(parsed.error.issues));
  const checked = checkIr(parsed.ir);
  if (!checked.passed) return loadFailure('CHECK_FAILED', 'ir 静态 check 未通过', JSON.stringify(checked.failures));
  const ir = isDeepStrictEqual(input, parsed.ir) ? input as IRv2 : parsed.ir;
  return { ir, raw };
}

export function parseTestHeader(test: Buffer): TestHeader | null {
  const firstLf = test.indexOf(0x0a);
  if (firstLf < 0) return null;
  const firstLine = test.subarray(0, firstLf).toString('ascii');
  const testMatch = /^\/\/ TEST-SHA256: ([0-9a-f]{64})$/.exec(firstLine);
  if (!testMatch) return null;
  const body = test.subarray(firstLf + 1);
  if (testDigest(body) !== testMatch[1]) return null;
  const headerEnd = body.indexOf('\n\n');
  if (headerEnd < 0) return null;
  const head = body.subarray(0, headerEnd).toString('utf8');
  const irMatch = /^\/\/ IR-SHA256: ([0-9a-f]{64})$/m.exec(head);
  const compilerMatch = /^\/\/ Compiler: (.+)$/m.exec(head);
  if (!irMatch || !compilerMatch) return null;
  return { irDigest: irMatch[1], compiler: compilerMatch[1] };
}

export function testFileDigest(test: Buffer): string {
  const firstLf = test.indexOf(0x0a);
  return testDigest(test.subarray(firstLf + 1));
}

export function readFullCase(irFile: string): CaseSnapshot | LoadFailure {
  const snapshot = loadStaticCase(irFile);
  if (isLoadFailure(snapshot)) return snapshot;
  const { ir, raw } = snapshot;
  let trace: ReturnType<typeof parseTrace>;
  try {
    const events = readTrace(ir.provenance.session_id);
    if (!events) return loadFailure('CHECK_FAILED', `关联 trace 不存在: ${ir.provenance.session_id}`);
    trace = parseTrace(events);
    if (trace.session?.session_id !== ir.provenance.session_id) return loadFailure('CHECK_FAILED', 'trace session_id 不匹配');
  } catch {
    return loadFailure('CHECK_FAILED', 'trace 读取失败');
  }
  const checked = checkIr(ir, { trace });
  if (!checked.passed || checked.skipped.length) return loadFailure('CHECK_FAILED', 'ir check 未通过', JSON.stringify(checked));
  const judged = judgeIr(ir, { trace });
  if (!judged.regressible) return loadFailure('JUDGE_REJECTED', 'judge 判拒', JSON.stringify(judged.reasons));

  const fixtures = new Map<string, Buffer>();
  const fixtureDir = path.join(path.dirname(path.resolve(irFile)), 'cases', 'fixtures', ir.name);
  try {
    for (const step of ir.steps.filter((step) => step.action === 'upload')) {
      const action = trace.actions.find((candidate) => candidate.id === step.trace_ref);
      const traceFiles = (Array.isArray(action?.args?.files) ? action.args.files : []) as Array<{ name?: unknown; blob_ref?: unknown }>;
      const files = step.args!.files as string[];
      if (action?.kind !== 'upload' || traceFiles.length !== files.length) {
        return loadFailure('FIXTURE_UNAVAILABLE', `upload 步骤 ${step.id} 的 trace 动作或文件证据不匹配`);
      }
      for (const [index, name] of files.entries()) {
        const evidence = traceFiles[index];
        if (!isSafeFixtureName(name) || typeof evidence?.name !== 'string' || typeof evidence.blob_ref !== 'string' || !evidence.blob_ref.startsWith('blobs/')) {
          return loadFailure('FIXTURE_UNAVAILABLE', `upload 步骤 ${step.id} 的文件证据非法`);
        }
        const expected = `${evidence.blob_ref.slice('blobs/'.length)}-${evidence.name}`;
        if (name !== expected) return loadFailure('FIXTURE_UNAVAILABLE', `fixture ${name} 与 trace 第 ${index + 1} 个文件证据不匹配`);
        const blob = readTraceBlob(ir.provenance.session_id, evidence.blob_ref);
        if (!blob) return loadFailure('FIXTURE_UNAVAILABLE', `trace blob 缺失: ${evidence.blob_ref}`);
        const current = path.join(fixtureDir, name);
        if (linkedPath(current)) return loadFailure('SYMLINK', `fixture 或父目录是 symlink: ${current}`);
        const bytes = fs.readFileSync(current);
        if (!blob.equals(bytes)) return loadFailure('FIXTURE_UNAVAILABLE', `fixture ${name} 与 trace blob 内容不一致`);
        fixtures.set(name, bytes);
      }
    }
  } catch {
    return loadFailure('FIXTURE_UNAVAILABLE', 'fixture 读取失败或不存在');
  }
  const test = Buffer.from(renderIR(ir));
  const header = parseTestHeader(test);
  if (!header) return loadFailure('SCHEMA', '当前编译器生成的测试摘要头非法');
  return { ...snapshot, test, fixtures, compiler: header.compiler, sourceIrFile: path.resolve(irFile) };
}

export function readStoredCase(libraryRoot: string, name: string): CaseSnapshot | LoadFailure {
  if (!isCaseName(name)) return loadFailure('USAGE', `非法用例名: ${name}`);
  const caseRoot = path.join(libraryRoot, name);
  if (linkedPath(caseRoot)) return loadFailure('SYMLINK', `用例目录或父目录是 symlink: ${caseRoot}`);
  const rootStat = fs.lstatSync(caseRoot, { throwIfNoEntry: false });
  if (!rootStat?.isDirectory()) return loadFailure('NOT_FOUND', `用例不存在: ${name}`);
  const irFile = path.join(caseRoot, `${name}.ir.json`);
  const testFile = path.join(caseRoot, '__tests__', `${name}.test.ts`);
  const stable = loadStaticCase(irFile);
  if (isLoadFailure(stable)) return stable;
  if (stable.ir.name !== name) return loadFailure('CASE_MISMATCH', '用例目录名与 IR name 不一致');
  if (linkedPath(testFile)) return loadFailure('SYMLINK', `保存的 test 或父目录是 symlink: ${testFile}`);
  let test: Buffer;
  try { test = fs.readFileSync(testFile); } catch {
    return loadFailure('NOT_FOUND', `保存的 test 不存在: ${testFile}`);
  }
  const header = parseTestHeader(test);
  if (!header) return loadFailure('CASE_MISMATCH', 'TEST-SHA256 缺失或与 test 原始字节不匹配');
  if (header.irDigest !== irDigest(stable.ir)) return loadFailure('CASE_MISMATCH', 'IR-SHA256 缺失或与保存的 IR 不匹配');

  const fixtures = new Map<string, Buffer>();
  const fixtureDir = path.join(caseRoot, 'cases', 'fixtures', name);
  const fixtureStat = fs.lstatSync(fixtureDir, { throwIfNoEntry: false });
  if (fixtureStat) {
    if (linkedPath(fixtureDir)) return loadFailure('SYMLINK', `fixture 目录或父目录是 symlink: ${fixtureDir}`);
    if (!fixtureStat.isDirectory()) return loadFailure('FIXTURE_UNAVAILABLE', `fixture 路径不是普通目录: ${fixtureDir}`);
    for (const entry of fs.readdirSync(fixtureDir)) {
      const file = path.join(fixtureDir, entry);
      const stat = fs.lstatSync(file, { throwIfNoEntry: false });
      if (stat?.isSymbolicLink()) return loadFailure('SYMLINK', `fixture 是 symlink: ${file}`);
      if (!stat?.isFile() || !isSafeFixtureName(entry)) return loadFailure('FIXTURE_UNAVAILABLE', `fixture 不是合法普通文件: ${entry}`);
      const bytes = fs.readFileSync(file);
      if (createHash('sha256').update(bytes).digest('hex') !== entry.slice(0, 64)) {
        return loadFailure('FIXTURE_UNAVAILABLE', `fixture 内容摘要不匹配: ${entry}`);
      }
      fixtures.set(entry, bytes);
    }
  }
  for (const step of stable.ir.steps.filter((step) => step.action === 'upload')) {
    for (const file of step.args!.files as string[]) {
      if (!fixtures.has(file)) return loadFailure('FIXTURE_UNAVAILABLE', `fixture 缺失: ${file}`);
    }
  }
  return { ...stable, test, fixtures, compiler: header.compiler, sourceIrFile: path.resolve(irFile), sourceTestFile: path.resolve(testFile) };
}
