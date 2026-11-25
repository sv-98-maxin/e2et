#!/usr/bin/env node
/**
 * e2et CLI 入口：全部命令走 router 统一信封。
 * stdout 只打印一个 JSON；诊断走 stderr；退出码 0/1/2/3。
 * 最外层 catch：任何未捕获异常输出安全 JSON 信封到 stdout + exit 3，
 * 不 Fatal stderr+空 stdout，不透出 A1/cookie/CDP 凭据。
 */
import { cliHelp, dispatch } from './cli/router.js';
import { runDaemonCommand } from './cli/daemon.js';

const arg = process.argv[2];

async function main() {
  if (arg === '--version' || arg === '-V') {
    const { readPackageVersion } = await import('./package-version.js');
    console.log(readPackageVersion());
    return;
  }

  if (arg === '__daemon') {
    const code = await runDaemonCommand(process.argv.slice(3));
    if (code !== 0) process.exitCode = code;
    return;
  }

  if (arg === '--help' || arg === '-h' || arg == null) {
    console.log(cliHelp());
    return;
  }

  const code = await dispatch(process.argv.slice(2));
  if (code !== 0) process.exitCode = code;
}

main().catch((err) => {
  // 安全信封：不透出原始异常文本（可能含 cookie/CDP 凭据/A1 响应）
  console.error(`[fatal] ${err?.name ?? 'Error'}`);
  console.log(JSON.stringify({ ok: false, error: { code: 'FATAL', message: 'CLI 内部错误，详见 stderr' } }));
  process.exitCode = 3;
});
