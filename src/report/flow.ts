import * as fs from 'node:fs';
import * as path from 'node:path';
import { e2etRoot } from '../daemon/session-meta.js';
import type { ReportFlow } from '../shared/report-model.js';

export function readReportFlow(sid: string, env: NodeJS.ProcessEnv, linkedPath: (file: string) => boolean): ReportFlow | undefined {
  const flowDir = path.resolve(e2etRoot(env), 'workspace', 'flow', sid);
  const noFollow = (fs.constants as unknown as Record<string, number>).O_NOFOLLOW ?? 0;
  function encodeFlowFrame(file: string): string | undefined {
    if (path.dirname(file) !== flowDir || !/^frame_\d+\.jpe?g$/.test(path.basename(file))) throw new Error('全流程帧路径不属于本会话');
    if (linkedPath(file)) throw new Error('全流程帧或父目录不能是 symlink');
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!stat) return undefined;
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('全流程帧不是安全的普通文件');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.size > 2 * 1024 * 1024) return undefined;
      return 'data:image/jpeg;base64,' + fs.readFileSync(fd).toString('base64');
    } finally { fs.closeSync(fd); }
  }
  const manifestPath = path.join(flowDir, 'manifest.json');
  try {
    if (linkedPath(manifestPath)) return undefined;
    const stat = fs.lstatSync(manifestPath, { throwIfNoEntry: false });
    if (!stat?.isFile()) return undefined;
    const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      startedAt?: unknown; endedAt?: unknown;
      frames?: Array<{ file?: unknown; t?: unknown }>;
    };
    const startedAt = typeof raw.startedAt === 'number' && Number.isFinite(raw.startedAt) ? raw.startedAt : undefined;
    const endedAt = typeof raw.endedAt === 'number' && Number.isFinite(raw.endedAt) ? raw.endedAt : undefined;
    if (startedAt === undefined || endedAt === undefined || !Array.isArray(raw.frames)) return undefined;
    const frames = raw.frames.flatMap((frame, index) => {
      if (typeof frame.file !== 'string' || typeof frame.t !== 'number' || !Number.isFinite(frame.t)) return [];
      const src = encodeFlowFrame(path.join(flowDir, frame.file));
      return src ? [{ src, startedAt: frame.t, label: '全流程帧 ' + (index + 1) }] : [];
    });
    return frames.length ? { startedAt, endedAt, frames } : undefined;
  } catch {
    return undefined;
  }
}
