import * as fs from 'node:fs';
import * as os from 'node:os';

/**
 * 判断进程是否真正存活（非僵尸）。
 *
 * process.kill(pid, 0) 对 zombie 成功（PID 仍在表），但不代表进程在运行。
 * Linux: 读 /proc/<pid>/stat，状态码 Z = zombie（已退出、等 reaping）→ false。
 * Darwin: 无 /proc，保持 signal 0 语义（zombie 由 init 自动 reap）。
 *
 * 进程结束竞态：kill(0) 成功后、readFileSync 前 PID 可能消失 →
 * /proc 读取抛 ENOENT → 返回 false（PID 刚消失）。其他错误保守返回 true。
 */
export function isProcessAlive(pid: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (os.platform() === 'linux') {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
      // comm 可能含空格和括号，找最后一个 ')' 后的状态码
      const lastParen = stat.lastIndexOf(')');
      if (lastParen !== -1) {
        const state = stat.slice(lastParen + 1).trimStart()[0];
        if (state === 'Z') return false;
      }
    } catch (err: any) {
      if (err?.code === 'ENOENT') return false;
    }
  }
  return true;
}
