import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** 原样保留路径 symlink 拒绝语义，report/cases 共用。 */
export function linkedPath(target: string): boolean {
  let current = path.resolve(target);
  // 只豁免 macOS 固定系统 /var -> /private/var，不归一化用户 TMPDIR。
  if (os.platform() === 'darwin' && current.startsWith('/var' + path.sep) && fs.realpathSync('/var') === '/private/var') {
    current = '/private/var' + current.slice('/var'.length);
  }
  for (;; current = path.dirname(current)) {
    if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) return true;
    if (path.dirname(current) === current) return false;
  }
}
