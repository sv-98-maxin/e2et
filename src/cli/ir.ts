import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildIr } from '../ir/build.js';
import { checkIrFile, checkIr } from '../ir/check.js';
import { judgeIrFile, judgeIr } from '../ir/judge.js';
import { renderIR } from '../render/render.js';
import { irDigest, testDigest } from '../render/render.js';
import { e2etRoot } from '../daemon/session-meta.js';
import { emitOk, emitError, EXIT_USAGE, EXIT_VALIDATION, type Deps } from './context.js';
import { parseArgs } from './args.js';
import { commandDefinitions } from './commands.js';
import { loadStaticCase } from '../cases/snapshot.js';
import { linkedPath } from '../path-safety.js';

function getArgs(name: string, sub?: string) {
  return commandDefinitions().find((c) => c.name === name && c.subcommand === sub)?.args ?? [];
}

export async function handleIr(d: Deps, argv: string[]): Promise<number> {
  const sub = argv[0];
  if (!sub) return emitError(d, 'USAGE', 'ir 需要子命令 (build|check)', undefined, EXIT_USAGE);
  switch (sub) {
    case 'build': return await irBuild(d, argv.slice(1));
    case 'check': return await irCheck(d, argv.slice(1));
    default: return emitError(d, 'USAGE', `ir 未知子命令: ${sub}`, 'build|check', EXIT_USAGE);
  }
}

async function irBuild(d: Deps, argv: string[]): Promise<number> {
  const { values, errors } = parseArgs(argv, getArgs('ir', 'build'));
  if (errors.length) return emitError(d, 'USAGE', errors.join('; '), undefined, EXIT_USAGE);
  const sessionId = values['-s'];
  const name = values['--name'];
  const result = await buildIr(sessionId, name ? { name } : {});
  if (!result.ok) return emitError(d, result.error.code, result.error.message, result.error.hint, result.error.code === 'USAGE' ? EXIT_USAGE : EXIT_VALIDATION);
  return emitOk(d, {
    ir_path: result.ir_path,
    kept_steps: result.kept_steps,
    dropped_steps: result.dropped_steps,
    unmapped_actions: result.unmapped_actions,
    warnings: result.warnings,
  });
}

async function irCheck(d: Deps, argv: string[]): Promise<number> {
  const { values, errors } = parseArgs(argv, getArgs('ir', 'check'));
  if (errors.length) return emitError(d, 'USAGE', errors.join('; '), undefined, EXIT_USAGE);
  const irFile = values['ir-file'];
  if (!fs.existsSync(irFile)) {
    return emitError(d, 'NOT_FOUND', `IR 文件不存在: ${irFile}`, undefined, EXIT_VALIDATION);
  }
  const traceSession = values['--trace'];
  const result = checkIrFile(irFile, traceSession ? { sessionId: traceSession } : {});
  if (!result.passed) return emitError(d, 'CHECK_FAILED', `ir check 失败（${result.failures.length} 条）`, JSON.stringify(result.failures, null, 2), EXIT_VALIDATION);
  return emitOk(d, { passed: true, failures: [], skipped: result.skipped });
}

export async function handleJudge(d: Deps, argv: string[]): Promise<number> {
  const { values, errors } = parseArgs(argv, getArgs('judge'));
  if (errors.length) return emitError(d, 'USAGE', errors.join('; '), undefined, EXIT_USAGE);
  const irFile = values['ir-file'];
  if (!fs.existsSync(irFile)) {
    return emitError(d, 'NOT_FOUND', `IR 文件不存在: ${irFile}`, undefined, EXIT_VALIDATION);
  }
  const result = judgeIrFile(irFile);
  if (!result.regressible) return emitError(d, 'JUDGE_REJECTED', `judge 判拒（${result.reasons.length} 条）`, JSON.stringify(result.reasons, null, 2), EXIT_VALIDATION);
  return emitOk(d, { regressible: true, reasons: [] });
}

export async function handleRender(d: Deps, argv: string[]): Promise<number> {
  const { values, errors } = parseArgs(argv, getArgs('render'));
  if (errors.length) return emitError(d, 'USAGE', errors.join('; '), undefined, EXIT_USAGE);
  const snapshot = loadStaticCase(values['ir-file']);
  if (!('ir' in snapshot)) return emitError(d, snapshot.load_error.code, snapshot.load_error.message, snapshot.load_error.hint);
  const outDir = values['--output'] ?? path.join(e2etRoot(d.env), 'workspace', 'render');
  const outPath = path.join(outDir, `${snapshot.ir.name}.test.ts`);
  if (linkedPath(outPath)) return emitError(d, 'SYMLINK', `输出目标或父目录是 symlink: ${outPath}`);
  const test = Buffer.from(renderIR(snapshot.ir));
  const temp = path.join(outDir, `.${snapshot.ir.name}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.mkdirSync(outDir, { recursive: true });
    if (linkedPath(outDir)) return emitError(d, 'SYMLINK', `输出目录或父目录是 symlink: ${outDir}`);
    fs.writeFileSync(temp, test, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temp, outPath);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    return emitError(d, 'WRITE_FAILED', `render 写入失败: ${(error as Error).message}`);
  }
  return emitOk(d, {
    path: outPath,
    name: snapshot.ir.name,
    status: 'compiled',
    replay: 'not_run',
    ir_sha256: irDigest(snapshot.ir),
    test_sha256: testDigest(test.subarray(test.indexOf(0x0a) + 1)),
    compiler: null, // shortcut: parseTestHeader moved to cases/snapshot, not re-parsed here
  });
}
