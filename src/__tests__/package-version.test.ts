import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { packageAsset, packageRoot, readPackageVersion } from '../package-version.js';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** 造一个「包根 + dist 树」的临时布局，模拟真装后的目录结构 */
function fakeInstall(opts: { name: string; version: string; outerPkg?: { name: string; version: string } }): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e2et-pkgver-'));
  tempDirs.push(root);
  if (opts.outerPkg) {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(opts.outerPkg));
  }
  const pkgRoot = path.join(root, 'node_modules', opts.name);
  fs.mkdirSync(path.join(pkgRoot, 'dist', 'setup'), { recursive: true });
  fs.writeFileSync(path.join(pkgRoot, 'package.json'), JSON.stringify({ name: opts.name, version: opts.version }));
  return pkgRoot;
}

describe('readPackageVersion', () => {
  // 这两条就是 beta.1 的实锤现场：同一份源码、两套产物布局，
  // 写死 '../../package.json' 只能对其中一套。
  it('esbuild 布局（dist/cli.js，上一级是别人的 package.json）', () => {
    const pkgRoot = fakeInstall({
      name: 'e2et',
      version: '0.5.0-beta.2',
      outerPkg: { name: 'host-project', version: '1.0.0' },
    });
    expect(readPackageVersion(path.join(pkgRoot, 'dist'))).toBe('0.5.0-beta.2');
  });

  it('tsc 布局（dist/setup/cli.js，多一层）', () => {
    const pkgRoot = fakeInstall({ name: 'e2et', version: '0.5.0-beta.2' });
    expect(readPackageVersion(path.join(pkgRoot, 'dist', 'setup'))).toBe('0.5.0-beta.2');
  });

  it('合法的 @example/ scope 也认', () => {
    const pkgRoot = fakeInstall({ name: '@example/e2et', version: '0.5.0-beta.2' });
    expect(readPackageVersion(path.join(pkgRoot, 'dist'))).toBe('0.5.0-beta.2');
  });

  it('宁可报 0.0.0 也不汇报宿主工程的版本', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e2et-pkgver-'));
    tempDirs.push(root);
    fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'host-project', version: '1.0.0' }));
    expect(readPackageVersion(path.join(root, 'dist'))).toBe('0.0.0');
  });

  it('默认参数下读到的是本包真实版本（防回归：产物布局变了这条会红）', () => {
    const real = JSON.parse(
      fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    expect(readPackageVersion()).toBe(real.version);
  });
});

describe('packageRoot / packageAsset', () => {
  it('两套产物布局都定位到同一个包根', () => {
    const pkgRoot = fakeInstall({
      name: 'e2et',
      version: '0.5.0-beta.2',
      outerPkg: { name: 'host-project', version: '1.0.0' },
    });
    expect(packageRoot(path.join(pkgRoot, 'dist'))).toBe(pkgRoot);
    expect(packageRoot(path.join(pkgRoot, 'dist', 'setup'))).toBe(pkgRoot);
  });

  it('包根不可得时返回 null，不猜一个包外路径', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e2et-pkgver-'));
    tempDirs.push(root);
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'host-project' }));
    expect(packageRoot(root)).toBeNull();
  });

  // 正式 runtime 资产必须从包根定位，不随 tsc / bundle 产物层级漂移。
  it('包内资源路径指向真实存在的文件', () => {
    expect(fs.existsSync(packageAsset('runtime_assets', 'runtime', 'runner.ts'))).toBe(true);
    expect(fs.existsSync(packageAsset('runtime_assets', 'runtime', 'playwright.config.ts'))).toBe(true);
    expect(packageAsset('dist', 'cli.js').endsWith(path.join('dist', 'cli.js'))).toBe(true);
  });
});
