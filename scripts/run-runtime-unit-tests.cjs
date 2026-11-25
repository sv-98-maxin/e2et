#!/usr/bin/env node
/**
 * runtime 纯逻辑单测 runner。
 *
 * 扫 runtime/__tests__/*.test.ts，用 vitest 跑，排除 e2e-smoke
 * （后者是 @playwright/test 用例，归 Playwright 运行时，不该被 vitest 抓）。
 *
 * 只使用本仓库 node_modules/vitest/vitest.mjs。
 *
 * 跑法：
 *   npm run test:runtime
 *   node scripts/run-runtime-unit-tests.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const RUNTIME_DIR = path.join(ROOT, 'runtime');
const TESTS_DIR = path.join(RUNTIME_DIR, '__tests__');

const vitestEntry = path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');

function main() {
  if (!fs.existsSync(TESTS_DIR)) {
    console.error(`❌ 单测目录不存在: ${TESTS_DIR}`);
    process.exit(1);
  }

  // 列出要跑的测试文件（排除 e2e-smoke，它是 Playwright 用例）
  const files = fs
    .readdirSync(TESTS_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.test\.ts$/.test(e.name) && e.name !== 'e2e-smoke.test.ts')
    .map((e) => e.name)
    .sort();

  if (files.length === 0) {
    console.error('❌ 没有扫到任何单测，预期 runtime/__tests__/*.test.ts（除 e2e-smoke）');
    process.exit(1);
  }

  if (!fs.existsSync(vitestEntry)) {
    console.error('❌ 找不到 vitest，先 npm ci');
    process.exit(1);
  }

  console.log(`🧪 runtime 单测: ${files.length} 个文件（vitest: ${path.relative(ROOT, vitestEntry)}）\n`);

  // --dir 不会切换 config，必须显式使用 runtime 的 root/include。
  const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2et-runtime-tests-'));
  const reportFile = path.join(reportDir, 'vitest.json');
  const result = spawnSync(
    process.execPath,
    [vitestEntry, 'run', '--config', path.join(RUNTIME_DIR, 'vitest.config.ts'), '--pool=forks', '--no-cache', '--exclude', '**/e2e-smoke.test.ts', '--reporter=default', '--reporter=json', '--outputFile', reportFile],
    { cwd: ROOT, stdio: 'inherit' },
  );

  let passed = 0;
  try {
    passed = JSON.parse(fs.readFileSync(reportFile, 'utf8')).numPassedTests;
  } catch { /* 缺报告也拒绝零测试假绿 */ }
  fs.rmSync(reportDir, { recursive: true, force: true });
  if (result.status !== 0) {
    console.error(`❌ runtime 单测失败`);
    process.exit(result.status ?? 1);
  }
  if (!(passed > 0)) {
    console.error('❌ runtime 单测没有实际通过的测试');
    process.exit(1);
  }

  console.log(`✅ runtime 单测全部通过（${passed} 条实际测试）`);
}

main();
