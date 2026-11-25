/**
 * CLI 路由：子命令注册表 + 统一信封 + 退出码 + commands --json 自发现。
 * stdout 只打印一个 JSON 信封；诊断走 stderr；退出码 0/1/2/3。
 */
import { resolveDefaults, emitOk, emitError, EXIT_USAGE } from './context.js';
import { commandDefinitions } from './commands.js';
import { handleSession } from './session.js';
import { handleAuth } from './auth.js';
import { handleSetup, handleDoctor } from './system.js';
import { handlePage } from './page.js';
import { handleAssert, handleCapture, handleMock } from './evidence.js';
import { handleIr, handleJudge, handleRender } from './ir.js';
import { handleCase, handleVerify, handleLand } from './cases.js';
import { handleReport } from './report.js';

// ── dispatch ──

export async function dispatch(argv: string[], deps?: import('./context.js').RouterDeps): Promise<number> {
  const d = resolveDefaults(deps);
  const cmd = argv[0];
  if (!cmd) {
    return emitError(d, 'USAGE', '缺少子命令', 'e2et commands --json', EXIT_USAGE);
  }

  switch (cmd) {
    case 'commands': return handleCommands(d, argv.slice(1));
    case 'session': return await handleSession(d, argv.slice(1));
    case 'page': return await handlePage(d, argv.slice(1));
    case 'setup': return await handleSetup(d, argv.slice(1));
    case 'auth': return await handleAuth(d, argv.slice(1));
    case 'doctor': return await handleDoctor(d, argv.slice(1));
    case 'assert': return await handleAssert(d, argv.slice(1));
    case 'capture': return await handleCapture(d, argv.slice(1));
    case 'mock': return await handleMock(d, argv.slice(1));
    case 'report': return await handleReport(d, argv.slice(1));
    case 'ir': return await handleIr(d, argv.slice(1));
    case 'judge': return await handleJudge(d, argv.slice(1));
    case 'case': return await handleCase(d, argv.slice(1));
    case 'render': return await handleRender(d, argv.slice(1));
    case 'verify': return await handleVerify(d, argv.slice(1));
    case 'land': return await handleLand(d, argv.slice(1));
    default: return emitError(d, 'USAGE', `未知命令: ${cmd}`, 'e2et commands --json', EXIT_USAGE);
  }
}

// ── help ──

export function cliHelp(): string {
  return [
    'e2et — E2E CLI 工具',
    '',
    'Usage（stdout 输出 JSON 信封 {ok,data} / {ok:false,error}）：',
    '  e2et commands [group] [subcommand] --json  输出全部/分组/单命令及参数定义',
    '  e2et session start [--env <label>] [--browser auto|existing|chrome|managed] [--auth auto|profile|imported]  拉起本会话 daemon',
    '  e2et session stop -s <id>         结束会话',
    '  e2et session list                 列出全部会话',
    '  e2et page open -s <id> <url> --intent "<desc>"  导航并返回页面摘要',
    '  e2et page state -s <id>           当前页面快照',
    '  e2et page state -s <id> --frame <desc>  指定 iframe 快照（不发 [N] 索引）',
    '  e2et page inspect -s <id> --check <kind> [--within <target>] [--frame <desc>]  UI 异常诊断候选（不生成 PASS）',
    '  e2et page console -s <id> [--frame <desc>]  读取安全 Console 日志与完整性',
    '  e2et page execute -s <id> <expression> --intent "<desc>"  在页面上下文执行 JS 并返回结果',
    '  e2et page click -s <id> <target> --intent [--clicks 1|2]  点击元素（2 为真实双击）',
    '  e2et page fill -s <id> <target> <value> --intent  填充字段',
    '  e2et page press -s <id> <key> --intent  按键',
    '  e2et assert style -s <id> <target> --property <css> --equals <value> [--pseudo before|after] [--all] [--frame <desc>]',
    '  e2et assert element -s <id> <target> --property <attr|count> --expect "<op> <value>" [--all] [--frame <desc>]',
    '  e2et assert console -s <id> --no-error [--scope session|action] [--frame <desc>]',
    '  e2et setup                        准备 workspace + 探测 Chrome/CDP（Skill 独立安装）',
    '  e2et auth login --url <http(s)-url>  有头登录生成专用 profile（完成 URL 条件，不保证业务已登录）',
    '  e2et auth export --out <file> --domain <domain>  从 profile 导出指定作用域 cookie 到 storageState',
    '  e2et auth import [<file>] [--domain <domain>]  从文件/stdin 导入登录态（裸 cookie 头需 --domain）',
    '  e2et auth import --chrome --url <http(s)-url> [--profile <dir>]  复制并验证 macOS Chrome 完整 profile',
    '  e2et auth status                 探测现成端点、静态预判 auto 组合',
    '  e2et doctor                       只读端点与登录态检查（不启动浏览器）',
    '  e2et ir build -s <id> [--name <name>]   trace → 候选 IR v2（提炼结果供 Host 确认）',
    '  e2et ir check <ir-file> [--trace <id>]  对 IR 跑校验',
    '  e2et judge <ir-file>                     技术证据可执行性判据',
    '  e2et render <ir-file> [--output <dir>]   IR v2 → .test.ts（包裹式渲染）',
    '  e2et verify <ir-file> [--auth <mode>] [--browser <mode>] [--auth-state <file>] [--output <dir>] [--skip-test]   ir check + judge + render + 本地 Playwright',
    '  e2et land <ir-file> [--auth <mode>] [--browser <mode>] [--auth-state <file>] [--output <dir>] [--force]   verify 通过后落库（不自动 commit）',
    '  e2et --version',
    '',
    'Env:',
    '  E2ET_CDP_URL         直连已存活的 CDP endpoint',
    '  BROWSER_REMOTE_DEBUGGING_PORT  自动探测端口（默认 9222）',
    '  E2ET_AUTH_STATE      imported/verify/land 的显式标准 storageState 路径',
    '  BROWSER_EXECUTABLE_PATH   managed Chromium 可执行文件（优先）',
    '  PUPPETEER_EXECUTABLE_PATH managed Chromium 次优先',
    '  CHROME_EXECUTABLE_PATH    Chrome/Chromium 可执行文件覆盖',
    '',
    '输出约定: stdout 只出 JSON，诊断走 stderr；参数错误退出码 2，工具报错退出码 1，环境不可用退出码 3。',
  ].join('\n');
}

function handleCommands(d: import('./context.js').Deps, argv: string[]): number {
  const positional: string[] = [];
  for (const arg of argv) {
    if (arg === '--json' || arg === '-h' || arg === '--help') continue;
    if (!arg.startsWith('-') && positional.length < 2) {
      positional.push(arg);
      continue;
    }
    return emitError(d, 'USAGE', 'commands 只支持 [group] [subcommand] 和 --json/-h/--help', 'e2et commands [group] [subcommand] --json', EXIT_USAGE);
  }
  const all = commandDefinitions();
  if (positional.length === 0) return emitOk(d, { commands: all });
  const [group, subcommand] = positional;
  if (!all.some((command) => command.name === group)) {
    return emitError(d, 'USAGE', `未知命令组: ${group}`, 'e2et commands --json', EXIT_USAGE);
  }
  const commands = subcommand === undefined
    ? all.filter((command) => command.name === group)
    : all.filter((command) => command.name === group && command.subcommand === subcommand);
  if (commands.length === 0) {
    return emitError(d, 'USAGE', `未知命令: ${group} ${subcommand}`, 'e2et commands --json', EXIT_USAGE);
  }
  return emitOk(d, { commands });
}
