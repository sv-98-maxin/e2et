import * as fs from 'node:fs';
import * as path from 'node:path';
import { linkedPath } from '../path-safety.js';
import type { OperationResult } from '../operation-result.js';
import { isLoadFailure, loadFailure, readStoredCase, type CaseSnapshot } from './snapshot.js';
import { verifyCase, type VerificationEnvironment, type VerifyData } from './replay.js';
import type { ReplaySelection } from '../shared/replay-env.js';
import type { AcceptanceInput } from '../report/acceptance.js';

export function caseLibraryRoot(homeDir: string): string {
  return path.join(homeDir, '.e2et', 'library');
}

export function listCases(libraryRoot: string): OperationResult<{ cases: Array<Record<string, unknown>>; invalid: Array<{ name: string; error: string }> }> {
  if (linkedPath(libraryRoot)) return validation('SYMLINK', `个人用例库或父目录是 symlink: ${libraryRoot}`);
  if (!fs.existsSync(libraryRoot)) return { ok: true, data: { cases: [], invalid: [] } };
  if (!fs.lstatSync(libraryRoot).isDirectory()) return validation('SCHEMA', `个人用例库不是目录: ${libraryRoot}`);
  const cases: Array<Record<string, unknown>> = [];
  const invalid: Array<{ name: string; error: string }> = [];
  for (const entry of fs.readdirSync(libraryRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.')) continue;
    let loaded: CaseSnapshot | ReturnType<typeof readStoredCase>;
    try { loaded = readStoredCase(libraryRoot, entry.name); } catch {
      invalid.push({ name: entry.name, error: 'READ_FAILED: 用例读取失败' });
      continue;
    }
    if (isLoadFailure(loaded)) {
      invalid.push({ name: entry.name, error: `${loaded.load_error.code}: ${loaded.load_error.message}` });
      continue;
    }
    cases.push({
      name: loaded.ir.name,
      url: loaded.ir.url,
      covered_pages: loaded.ir.covered_pages,
      ...(loaded.ir.description !== undefined ? { description: loaded.ir.description } : {}),
      ir_file: loaded.sourceIrFile,
      test_file: loaded.sourceTestFile,
    });
  }
  return { ok: true, data: { cases, invalid } };
}

interface ExistingCaseDir {
  exists: boolean;
  dev?: number;
  ino?: number;
}

function validation(code: string, message: string, hint?: string): OperationResult<never> {
  return { ok: false, error: { code, message, ...(hint ? { hint } : {}), kind: 'validation' } };
}

function inspectExistingCaseDir(caseRoot: string): ExistingCaseDir | ReturnType<typeof loadFailure> {
  if (linkedPath(caseRoot)) return loadFailure('SYMLINK', `land 目标或父目录是 symlink: ${caseRoot}`);
  const stat = fs.lstatSync(caseRoot, { throwIfNoEntry: false });
  if (!stat) return { exists: false };
  if (!stat.isDirectory()) return loadFailure('ALREADY_EXISTS', `land 目标已存在且不是目录: ${caseRoot}`);
  const visit = (file: string): void => {
    const current = fs.lstatSync(file, { throwIfNoEntry: false });
    if (current?.isSymbolicLink()) throw new Error(`symlink:${file}`);
    if (!current) return;
    if (current.isDirectory()) for (const entry of fs.readdirSync(file)) visit(path.join(file, entry));
  };
  try { visit(caseRoot); } catch (error) {
    return loadFailure('SYMLINK', (error as Error).message.replace(/^symlink:/, 'land 目标包含 symlink: '));
  }
  return { exists: true, dev: stat.dev, ino: stat.ino };
}

function writeStagedCase(stageRoot: string, snapshot: CaseSnapshot): void {
  const irFile = path.join(stageRoot, `${snapshot.ir.name}.ir.json`);
  const testFile = path.join(stageRoot, '__tests__', `${snapshot.ir.name}.test.ts`);
  fs.writeFileSync(irFile, snapshot.raw, { flag: 'wx', mode: 0o600 });
  fs.mkdirSync(path.dirname(testFile), { recursive: true });
  fs.writeFileSync(testFile, snapshot.test, { flag: 'wx', mode: 0o600 });
  if (snapshot.fixtures.size) {
    const fixtureDir = path.join(stageRoot, 'cases', 'fixtures', snapshot.ir.name);
    fs.mkdirSync(fixtureDir, { recursive: true });
    for (const [name, bytes] of snapshot.fixtures) {
      fs.writeFileSync(path.join(fixtureDir, name), bytes, { flag: 'wx', mode: 0o600 });
    }
  }
}

function stagedCaseIntact(stageRoot: string, snapshot: CaseSnapshot): boolean {
  const sameFile = (file: string, bytes: Buffer): boolean => {
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    return !!stat?.isFile() && fs.readFileSync(file).equals(bytes);
  };
  const irFile = path.join(stageRoot, `${snapshot.ir.name}.ir.json`);
  const testFile = path.join(stageRoot, '__tests__', `${snapshot.ir.name}.test.ts`);
  if (!sameFile(irFile, snapshot.raw) || !sameFile(testFile, snapshot.test)) return false;
  const fixtureDir = path.join(stageRoot, 'cases', 'fixtures', snapshot.ir.name);
  if (!snapshot.fixtures.size) return !fs.lstatSync(path.join(stageRoot, 'cases'), { throwIfNoEntry: false });
  const stat = fs.lstatSync(fixtureDir, { throwIfNoEntry: false });
  if (!stat?.isDirectory()) return false;
  const expected = [...snapshot.fixtures.keys()].sort();
  const actual = fs.readdirSync(fixtureDir).sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) return false;
  return [...snapshot.fixtures].every(([name, bytes]) => sameFile(path.join(fixtureDir, name), bytes));
}

export interface LandData {
  status: 'landed';
  case_root: string;
  files: string[];
  verification: VerifyData;
  cleanup_error?: string;
}

export async function landCase(
  environment: VerificationEnvironment & { homeDir: string },
  snapshot: CaseSnapshot,
  options: { force: boolean; output?: string; replay: ReplaySelection; acceptance?: AcceptanceInput },
): Promise<OperationResult<LandData>> {
  const library = caseLibraryRoot(environment.homeDir);
  const targetRoot = path.join(library, snapshot.ir.name);
  const initial = inspectExistingCaseDir(targetRoot);
  if (isLoadFailure(initial)) return validation(initial.load_error.code, initial.load_error.message, initial.load_error.hint);
  if (initial.exists && !options.force) return validation('ALREADY_EXISTS', `目标已存在: ${targetRoot}`);

  let initialFd: number | undefined;
  const closeInitialFd = (): void => {
    if (initialFd === undefined) return;
    const fd = initialFd;
    initialFd = undefined;
    try { fs.closeSync(fd); } catch (error) {
      environment.diagnostic(`关闭 land 目标 fd 失败: ${(error as Error).message}`);
    }
  };
  if (initial.exists) {
    try {
      initialFd = fs.openSync(
        targetRoot,
        fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0),
      );
      const opened = fs.fstatSync(initialFd);
      if (!opened.isDirectory() || opened.dev !== initial.dev || opened.ino !== initial.ino) {
        closeInitialFd();
        return validation('ALREADY_EXISTS', `land 目标在身份固定前被替换: ${targetRoot}`);
      }
    } catch (error) {
      closeInitialFd();
      return validation('WRITE_FAILED', `land 目标无法固定身份: ${(error as Error).message}`);
    }
  }

  try {
    const verification = await verifyCase(environment, snapshot, { skip: false, output: options.output, replay: options.replay, acceptance: options.acceptance });
    if (!verification.ok) return verification;
    const raced = inspectExistingCaseDir(targetRoot);
    if (isLoadFailure(raced)) return validation(raced.load_error.code, raced.load_error.message, raced.load_error.hint);
    if ((!initial.exists && raced.exists)
      || !!(initial.exists && (!raced.exists || raced.dev !== initial.dev || raced.ino !== initial.ino))) {
      return validation('ALREADY_EXISTS', '验证期间 land 目标出现或被替换');
    }

    if (linkedPath(library)) return validation('SYMLINK', `个人用例库或父目录是 symlink: ${library}`);
    try { fs.mkdirSync(library, { recursive: true, mode: 0o700 }); } catch (error) {
      return validation('WRITE_FAILED', `创建个人用例库失败: ${(error as Error).message}`);
    }
    if (linkedPath(library)) return validation('SYMLINK', `个人用例库或父目录是 symlink: ${library}`);
    let stageRoot: string;
    try { stageRoot = fs.mkdtempSync(path.join(library, `.${snapshot.ir.name}-stage-`)); } catch (error) {
      return validation('WRITE_FAILED', `staging 创建失败: ${(error as Error).message}`);
    }
    try { writeStagedCase(stageRoot, snapshot); } catch (error) {
      fs.rmSync(stageRoot, { recursive: true, force: true });
      return validation('WRITE_FAILED', `staging 写入失败: ${(error as Error).message}`);
    }
    if (!stagedCaseIntact(stageRoot, snapshot)) {
      let cleanupError = '';
      try { fs.rmSync(stageRoot, { recursive: true }); } catch { cleanupError = `，staging 清理失败: ${stageRoot}`; }
      return validation('EVIDENCE_TAMPERED', `staging 内的 IR/test/fixture 字节与快照不一致${cleanupError}`);
    }

    const publish = inspectExistingCaseDir(targetRoot);
    if (isLoadFailure(publish)
      || (!initial.exists && publish.exists)
      || !!(initial.exists && (!publish.exists || publish.dev !== initial.dev || publish.ino !== initial.ino))) {
      let cleanupError = '';
      try { fs.rmSync(stageRoot, { recursive: true }); } catch { cleanupError = `，staging 清理失败: ${stageRoot}`; }
      if (isLoadFailure(publish)) return validation(publish.load_error.code, `${publish.load_error.message}${cleanupError}`, publish.load_error.hint);
      return validation('ALREADY_EXISTS', `land 发布前目标出现或被替换${cleanupError}`);
    }

    const backupRoot = path.join(library, `.${snapshot.ir.name}-backup-${process.pid}-${Date.now()}`);
    let movedOld = false;
    try {
      if (options.force && initial.exists) {
        fs.renameSync(targetRoot, backupRoot);
        movedOld = true;
        const moved = fs.lstatSync(backupRoot, { throwIfNoEntry: false });
        if (!moved?.isDirectory() || moved.dev !== initial.dev || moved.ino !== initial.ino) {
          const replaced = new Error('land 发布前目标被替换') as NodeJS.ErrnoException;
          replaced.code = 'ALREADY_EXISTS';
          throw replaced;
        }
      }
      fs.renameSync(stageRoot, targetRoot);
      stageRoot = '';
    } catch (error) {
      const replacedBeforePublish = (error as NodeJS.ErrnoException).code === 'ALREADY_EXISTS';
      let restoreFailure: string | undefined;
      if (movedOld) {
        try {
          fs.renameSync(backupRoot, targetRoot);
        } catch {
          restoreFailure = replacedBeforePublish
            ? `竞争目标保留在: ${backupRoot}`
            : `旧用例备份保留在: ${backupRoot}`;
        }
      }
      let stageCleanupFailure = '';
      if (stageRoot) {
        try { fs.rmSync(stageRoot, { recursive: true }); } catch { stageCleanupFailure = `staging 清理失败: ${stageRoot}`; }
      }
      if (restoreFailure) {
        return validation('WRITE_FAILED', `land 发布失败且自动恢复失败${stageCleanupFailure ? `；${stageCleanupFailure}` : ''}`, restoreFailure);
      }
      const code = replacedBeforePublish || (!movedOld && ['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) ? 'ALREADY_EXISTS' : 'WRITE_FAILED';
      return validation(
        code,
        replacedBeforePublish
          ? `land 发布前目标被替换${stageCleanupFailure ? `；${stageCleanupFailure}` : ''}`
          : movedOld
            ? `land 发布失败，已恢复旧用例${stageCleanupFailure ? `；${stageCleanupFailure}` : ''}`
            : `land 发布失败: ${(error as Error).message}${stageCleanupFailure ? `；${stageCleanupFailure}` : ''}`,
      );
    }

    let cleanupError: string | undefined;
    if (movedOld) {
      try { fs.rmSync(backupRoot, { recursive: true }); } catch {
        cleanupError = `旧用例备份清理失败，保留在: ${backupRoot}`;
        environment.diagnostic(cleanupError);
      }
    }
    const fixtureDir = path.join(targetRoot, 'cases', 'fixtures', snapshot.ir.name);
    return { ok: true, data: {
      status: 'landed',
      case_root: targetRoot,
      files: [
        path.join(targetRoot, `${snapshot.ir.name}.ir.json`),
        path.join(targetRoot, '__tests__', `${snapshot.ir.name}.test.ts`),
        ...(snapshot.fixtures.size ? [fixtureDir] : []),
      ],
      verification: verification.data,
      ...(cleanupError ? { cleanup_error: cleanupError } : {}),
    } };
  } finally {
    closeInitialFd();
  }
}
