import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseAcceptance, validateAcceptanceRefs } from '../shared/acceptance.js';
import type { AcceptanceDocument, AcceptanceSnapshot } from '../shared/acceptance.js';
import type { IRv2 } from '../shared/types.js';
import { ensurePrivateDir } from '../daemon/trace.js';
import { linkedPath } from '../path-safety.js';

export interface AcceptanceInput {
  raw: Buffer;
  document: AcceptanceDocument;
  sha256: string;
  frozenAt: number;
}

export class AcceptanceInputError extends Error {
  readonly code = 'ACCEPTANCE_INPUT';
  constructor(message: string) {
    super(message);
    this.name = 'AcceptanceInputError';
  }
}

const digest = (raw: Buffer): string => crypto.createHash('sha256').update(raw).digest('hex');
const noFollow = (fs.constants as unknown as Record<string, number>).O_NOFOLLOW ?? 0;

function readFile(file: string): Buffer {
  if (linkedPath(file)) throw new AcceptanceInputError(`验收输入或父目录不能是 symlink：${file}`);
  if (!fs.lstatSync(file).isFile()) throw new AcceptanceInputError(`验收输入不是普通文件：${file}`);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
  try {
    if (!fs.fstatSync(fd).isFile()) throw new AcceptanceInputError(`验收输入不是普通文件：${file}`);
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}

function parse(raw: Buffer): AcceptanceDocument {
  const parsed = parseAcceptance(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)));
  if (!parsed.ok) throw new AcceptanceInputError(parsed.error);
  return parsed.data;
}

export function readAcceptanceInput(file?: string, ir?: IRv2, irSha256?: string): AcceptanceInput | undefined {
  if (file === undefined) return undefined;
  try {
    const raw = readFile(file);
    const document = parse(raw);
    if (document.scenarios.some(scenario => scenario.checks.some(check => check.irRef))) {
      if (!ir || !irSha256) throw new AcceptanceInputError('验收说明提供了 irRef，但本次没有可核对的 IR/SHA');
      const error = validateAcceptanceRefs(document, ir, irSha256);
      if (error) throw new AcceptanceInputError(error);
    }
    return { raw, document, sha256: digest(raw), frozenAt: Date.now() };
  } catch (error) {
    if (error instanceof AcceptanceInputError) throw error;
    throw new AcceptanceInputError(`读取验收输入失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

function exists(file: string): boolean {
  try { fs.lstatSync(file); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export function readAcceptanceSnapshot(directory: string): AcceptanceSnapshot | undefined {
  try {
    if (linkedPath(directory)) throw new AcceptanceInputError('验收快照目录或父目录不能是 symlink');
    const traceFile = path.join(directory, 'trace.jsonl');
    const startup = exists(traceFile) ? JSON.parse(readFile(traceFile).toString('utf8').split('\n').find(line => line.trim()) ?? 'null') : undefined;
    if (startup && (startup.t !== 'session' || (typeof startup.session_id === 'string' && startup.session_id !== path.basename(directory)))) {
      throw new AcceptanceInputError('验收快照与会话启动来源不一致');
    }
    const documentFile = path.join(directory, 'acceptance.json');
    const metadataFile = path.join(directory, 'acceptance-meta.json');
    const hasDocument = exists(documentFile);
    const hasMetadata = exists(metadataFile);
    if (!hasDocument && !hasMetadata) {
      if (startup?.acceptance_sha256 !== undefined) throw new AcceptanceInputError('会话启动时冻结的验收快照已缺失');
      return undefined;
    }
    if (!hasDocument || !hasMetadata) throw new AcceptanceInputError('验收快照损坏：acceptance.json/acceptance-meta.json 缺失一个');
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new AcceptanceInputError('验收快照目录不安全');
    const raw = readFile(documentFile);
    const metadata = JSON.parse(readFile(metadataFile).toString('utf8')) as { sha256?: unknown; frozenAt?: unknown };
    if (!metadata || typeof metadata.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(metadata.sha256)
      || typeof metadata.frozenAt !== 'number' || !Number.isFinite(metadata.frozenAt) || metadata.frozenAt < 0
      || digest(raw) !== metadata.sha256) throw new AcceptanceInputError('验收快照损坏：摘要或冻结时间无效');
    if (startup && (startup.acceptance_sha256 !== metadata.sha256 || startup.acceptance_frozen_at !== metadata.frozenAt)) {
      throw new AcceptanceInputError('验收快照摘要/冻结时间与会话启动记录不一致');
    }
    return { document: parse(raw), sha256: metadata.sha256, frozenAt: metadata.frozenAt };
  } catch (error) {
    if (error instanceof AcceptanceInputError) throw error;
    throw new AcceptanceInputError(`读取验收快照失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

export function acceptanceCheckError(snapshot: AcceptanceSnapshot | undefined, checkId: unknown, group: unknown): string | undefined {
  if (checkId === undefined) return undefined;
  if (typeof checkId !== 'string' || !checkId.trim() || /[\u0000-\u001f\u007f]/.test(checkId)) return 'check-id 必须是非空且无控制符的 ID';
  if (!snapshot) return '本会话未冻结验收说明，不能绑定 check-id';
  if (typeof group !== 'string' || !group.trim() || /[\u0000-\u001f\u007f]/.test(group)) return '绑定 check-id 必须有非空且无控制符的有效 group';
  const scenario = snapshot.document.scenarios.find(item => item.id === group);
  if (!scenario?.checks.some(check => check.id === checkId)) return `check-id ${checkId} 不属于当前冻结说明的 group ${group}`;
  return undefined;
}

export function freezeAcceptance(input: AcceptanceInput | undefined, directory: string): AcceptanceSnapshot | undefined {
  if (!input) return undefined;
  try {
    ensurePrivateDir(directory, true);
    const existing = readAcceptanceSnapshot(directory);
    if (existing) {
      if (existing.sha256 !== input.sha256 || existing.frozenAt !== input.frozenAt) throw new AcceptanceInputError('验收快照已存在且与本次输入不一致');
      return existing;
    }
    if (digest(input.raw) !== input.sha256 || JSON.stringify(parse(input.raw)) !== JSON.stringify(input.document)) {
      throw new AcceptanceInputError('验收输入原字节/摘要/来源不一致');
    }
    fs.writeFileSync(path.join(directory, 'acceptance.json'), input.raw, { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(path.join(directory, 'acceptance-meta.json'), JSON.stringify({ sha256: input.sha256, frozenAt: input.frozenAt }), { flag: 'wx', mode: 0o600 });
    return readAcceptanceSnapshot(directory);
  } catch (error) {
    if (error instanceof AcceptanceInputError) throw error;
    throw new AcceptanceInputError(`冻结验收输入失败：${error instanceof Error ? error.message : String(error)}`);
  }
}
