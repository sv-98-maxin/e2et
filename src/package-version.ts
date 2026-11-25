/**
 * 读本包版本号。
 *
 * 不能写死相对路径：同一份源码存在两套产物布局，层级不同 ——
 *   tsc 产物   dist/setup/cli.js  →  ../../ = 包根 ✓
 *   esbuild    dist/cli.js        →  ../../ = 包的上一级 ✗
 * 后者在开发机会读到仓库根的 package.json（实测报 1.0.0），
 * 装进 node_modules 后上一级没有 package.json，catch 兜底报 0.0.0。
 * 两种错法根因同一个，所以改成从所在目录向上找「本包的」package.json。
 *
 * 必须校验 name：否则上溯过程中撞见宿主工程的 package.json 就会汇报别人的版本，
 * 这比报 0.0.0 更难发现。合法 scoped 包名去 scope 后比对。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_NAME = 'e2et';
/** 两套布局最深也只差两层，6 层足够且不至于一路翻到用户家目录 */
const MAX_DEPTH = 6;

function isOwnPackage(name: unknown): boolean {
  return typeof name === 'string' && name.replace(/^@[^/]+\//, '') === PKG_NAME;
}

function moduleDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

/**
 * 本包根目录（含 package.json 的那一层）。找不到返回 null —— 由调用方决定兜底，
 * 这里不猜一个可能指向包外的路径。
 */
export function packageRoot(startDir?: string): string | null {
  let dir = startDir ?? moduleDir();
  for (let i = 0; i < MAX_DEPTH; i++) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      if (isOwnPackage(pkg.name)) return dir;
    } catch {
      // 该层没有 package.json 或读不动：继续上溯
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * 包内资源的绝对路径。相对 import.meta.url 写死会跟着产物布局漂（见文件头），
 * 一律从包根拼。包根找不到时退回旧的相对解析，保持原行为而不是直接崩。
 */
export function packageAsset(...segments: string[]): string {
  const root = packageRoot() ?? path.dirname(path.dirname(moduleDir()));
  return path.join(root, ...segments);
}

export function readPackageVersion(startDir?: string): string {
  const root = packageRoot(startDir);
  if (!root) return '0.0.0';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (typeof pkg.version === 'string') return pkg.version;
  } catch {
    // 刚读成功过又读不动：当作无版本
  }
  return '0.0.0';
}
