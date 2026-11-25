import { emitError, EXIT_USAGE, type Deps } from './context.js';
import { parseArgs } from './args.js';
import { commandDefinitions } from './commands.js';
import { callDaemon, collectCommon, parsePageDataSourceFlags, parseEqualsScalar } from './daemon-call.js';

function getArgs(name: string, sub?: string) {
  return commandDefinitions().find((c) => c.name === name && c.subcommand === sub)?.args ?? [];
}

export async function handlePage(d: Deps, argv: string[]): Promise<number> {
  const sub = argv[0];
  if (!sub) return emitError(d, 'USAGE', 'page 需要子命令 (open|state)', undefined, EXIT_USAGE);
  switch (sub) {
    case 'open': return await pageOpen(d, argv.slice(1));
    case 'state': return await pageState(d, argv.slice(1));
    case 'read': return await pageRead(d, argv.slice(1));
    case 'inspect': return await pageInspect(d, argv.slice(1));
    case 'console': return await pageConsole(d, argv.slice(1));
    case 'execute': return await pageExecute(d, argv.slice(1));
    case 'click': return await pageClick(d, argv.slice(1));
    case 'fill': return await pageFill(d, argv.slice(1));
    case 'type': return await pageType(d, argv.slice(1));
    case 'press': return await pagePress(d, argv.slice(1));
    case 'select': return await pageSelect(d, argv.slice(1));
    case 'upload': return await pageUpload(d, argv.slice(1));
    case 'hover': return await pageHover(d, argv.slice(1));
    case 'scroll': return await pageScroll(d, argv.slice(1));
    case 'screenshot': return await pageScreenshot(d, argv.slice(1));
    case 'switch-tab': return await pageSwitchTab(d, argv.slice(1));
    case 'back': return await pageBack(d, argv.slice(1));
    case 'refresh': return await pageRefresh(d, argv.slice(1));
    case 'choose': return await pageChoose(d, argv.slice(1));
    case 'category': return await pageCategory(d, argv.slice(1));
    case 'fill-form': return await pageFillForm(d, argv.slice(1));
    default: return emitError(d, 'USAGE', 'page 未知子命令: ' + sub, 'open|state|read|inspect|console|execute|click|fill|type|press|select|upload|hover|scroll|screenshot|switch-tab|back|refresh|choose|category|fill-form', EXIT_USAGE);
  }
}

async function pageOpen(d: Deps, argv: string[]): Promise<number> {
  const { values, errors } = parseArgs(argv, getArgs('page', 'open'));
  if (errors.length) return emitError(d, 'USAGE', errors.join('; '), undefined, EXIT_USAGE);
  const params: Record<string, unknown> = { url: values['url'], intent: values['--intent'], ...collectCommon(values) };
  return callDaemon(d, values['-s'], 'page.open', params);
}

async function pageState(d: Deps, argv: string[]): Promise<number> {
  const { values, errors } = parseArgs(argv, getArgs('page', 'state'));
  if (errors.length) return emitError(d, 'USAGE', errors.join('; '), undefined, EXIT_USAGE);
  const params: Record<string, unknown> = { debug_ax: values['--debug-ax'] === 'true' };
  if (values['--frame']) params.frame = values['--frame'];
  return callDaemon(d, values['-s'], 'page.state', params);
}

async function pageInspect(d: Deps, argv: string[]): Promise<number> {
  const { values, errors } = parseArgs(argv, getArgs('page', 'inspect'));
  if (errors.length) return emitError(d, 'USAGE', errors.join('; '), undefined, EXIT_USAGE);
  const params: Record<string, unknown> = { check: values['--check'] };
  if (values['--within']) params.within = values['--within'];
  if (values['--frame']) params.frame = values['--frame'];
  if (values['--group']) params.group = values['--group'];
  return callDaemon(d, values['-s'], 'page.inspect', params);
}

async function pageConsole(d: Deps, argv: string[]): Promise<number> {
  const { values, errors } = parseArgs(argv, getArgs('page', 'console'));
  if (errors.length) return emitError(d, 'USAGE', errors.join('; '), undefined, EXIT_USAGE);
  const params: Record<string, unknown> = {};
  if (values['--frame']) params.frame = values['--frame'];
  return callDaemon(d, values['-s'], 'page.console', params);
}

async function pageRead(d: Deps, argv: string[]): Promise<number> {
  const { values, errors } = parseArgs(argv, getArgs('page', 'read'));
  if (errors.length) return emitError(d, 'USAGE', errors.join('; '), undefined, EXIT_USAGE);
  const sid = values['-s'];
  if (!sid) return emitError(d, 'USAGE', '缺 -s 会话 id', undefined, EXIT_USAGE);
  const parsed = parsePageDataSourceFlags(values);
  if (!parsed.ok) return emitError(d, 'USAGE', parsed.message, undefined, EXIT_USAGE);
  const params: Record<string, unknown> = { ...parsed.source };
  if (values['--group']) params.group = values['--group'];
  if (values['--frame']) params.frame = values['--frame'];
  return callDaemon(d, sid, 'page.read', params);
}

async function pageExecute(d: Deps, argv: string[]): Promise<number> {
  const { values, errors } = parseArgs(argv, getArgs('page', 'execute'));
  if (errors.length) return emitError(d, 'USAGE', errors.join('; '), undefined, EXIT_USAGE);
  return callDaemon(d, values['-s'], 'page.execute', {
    expression: values['expression'],
    intent: values['--intent'],
    await_promise: values['--await-promise'] === 'true',
  });
}

async function pageClick(d: Deps, argv: string[]): Promise<number> {
  const { values, errors } = parseArgs(argv, getArgs('page', 'click'));
  if (errors.length) return emitError(d, 'USAGE', errors.join('; '), undefined, EXIT_USAGE);
  const method = values['--clicks'] === '2' ? 'page.double_click' : 'page.click';
  return callDaemon(d, values['-s'], method, { target: values['target'], intent: values['--intent'], ...collectCommon(values) });
}

async function pageFill(d: Deps, argv: string[]): Promise<number> {
  const { values, errors } = parseArgs(argv, getArgs('page', 'fill'));
  if (errors.length) return emitError(d, 'USAGE', errors.join('; '), undefined, EXIT_USAGE);
  return callDaemon(d, values['-s'], 'page.fill', { target: values['target'], value: values['value'], intent: values['--intent'], ...collectCommon(values) });
}

async function pageType(d: Deps, argv: string[]): Promise<number> {
  const { values, errors } = parseArgs(argv, getArgs('page', 'type'));
  if (errors.length) return emitError(d, 'USAGE', errors.join('; '), undefined, EXIT_USAGE);
  return callDaemon(d, values['-s'], 'page.type', { target: values['target'], value: values['value'], intent: values['--intent'], ...collectCommon(values) });
}

async function pagePress(d: Deps, argv: string[]): Promise<number> {
  const { values, errors } = parseArgs(argv, getArgs('page', 'press'));
  if (errors.length) return emitError(d, 'USAGE', errors.join('; '), undefined, EXIT_USAGE);
  return callDaemon(d, values['-s'], 'page.press', { key: values['key'], intent: values['--intent'], ...collectCommon(values) });
}

async function pageSelect(d: Deps, argv: string[]): Promise<number> {
  const { values, errors } = parseArgs(argv, getArgs('page', 'select'));
  if (errors.length) return emitError(d, 'USAGE', errors.join('; '), undefined, EXIT_USAGE);
  if (values['option'] === undefined && values['--value-ref'] === undefined && values['--value-template'] === undefined) {
    return emitError(d, 'USAGE', 'select 需要 option、--value-ref 或 --value-template 之一', undefined, EXIT_USAGE);
  }
  const params: Record<string, unknown> = { target: values['target'], option: values['option'], intent: values['--intent'], ...collectCommon(values) };
  if (values['--filter-text'] !== undefined) params.filter_text = values['--filter-text'];
  return callDaemon(d, values['-s'], 'page.select', params);
}

async function pageUpload(d: Deps, argv: string[]): Promise<number> {
  const { values, positional, errors } = parseArgs(argv, getArgs('page', 'upload'));
  if (errors.length) return emitError(d, 'USAGE', errors.join('; '), undefined, EXIT_USAGE);
  const files = positional.slice(1);
  return callDaemon(d, values['-s'], 'page.upload', { target: values['target'], files, intent: values['--intent'], ...collectCommon(values) });
}

async function pageHover(d: Deps, argv: string[]): Promise<number> {
  const { values, errors } = parseArgs(argv, getArgs('page', 'hover'));
  if (errors.length) return emitError(d, 'USAGE', errors.join('; '), undefined, EXIT_USAGE);
  return callDaemon(d, values['-s'], 'page.hover', { target: values['target'], intent: values['--intent'], ...collectCommon(values) });
}

async function pageScroll(d: Deps, argv: string[]): Promise<number> {
  const { values, errors } = parseArgs(argv, getArgs('page', 'scroll'));
  if (errors.length) return emitError(d, 'USAGE', errors.join('; '), undefined, EXIT_USAGE);
  const params: Record<string, unknown> = { intent: values['--intent'], ...collectCommon(values) };
  if (values['target']) params.target = values['target'];
  if (values['--direction']) params.dir = values['--direction'];
  return callDaemon(d, values['-s'], 'page.scroll', params);
}

async function pageScreenshot(d: Deps, argv: string[]): Promise<number> {
  const { values, errors } = parseArgs(argv, getArgs('page', 'screenshot'));
  if (errors.length) return emitError(d, 'USAGE', errors.join('; '), undefined, EXIT_USAGE);
  const params: Record<string, unknown> = { intent: values['--intent'], full_page: values['--full-page'] === 'true' };
  if (values['--group']) params.group = values['--group'];
  return callDaemon(d, values['-s'], 'page.screenshot', params);
}

async function pageSwitchTab(d: Deps, argv: string[]): Promise<number> {
  const { values, errors } = parseArgs(argv, getArgs('page', 'switch-tab'));
  if (errors.length) return emitError(d, 'USAGE', errors.join('; '), undefined, EXIT_USAGE);
  const params: Record<string, unknown> = { intent: values['--intent'], ...collectCommon(values) };
  if (values['index'] !== undefined) params.index = Number(values['index']);
  if (values['--url-contains']) params.url_contains = values['--url-contains'];
  return callDaemon(d, values['-s'], 'page.switch-tab', params);
}

async function pageBack(d: Deps, argv: string[]): Promise<number> {
  const { values, errors } = parseArgs(argv, getArgs('page', 'back'));
  if (errors.length) return emitError(d, 'USAGE', errors.join('; '), undefined, EXIT_USAGE);
  return callDaemon(d, values['-s'], 'page.back', { intent: values['--intent'], ...collectCommon(values) });
}

async function pageRefresh(d: Deps, argv: string[]): Promise<number> {
  const { values, errors } = parseArgs(argv, getArgs('page', 'refresh'));
  if (errors.length) return emitError(d, 'USAGE', errors.join('; '), undefined, EXIT_USAGE);
  return callDaemon(d, values['-s'], 'page.refresh', { intent: values['--intent'], ...collectCommon(values) });
}

async function pageChoose(d: Deps, argv: string[]): Promise<number> {
  const { values, positional, errors } = parseArgs(argv, getArgs('page', 'choose'));
  if (errors.length) return emitError(d, 'USAGE', errors.join('; '), undefined, EXIT_USAGE);
  const options = positional.slice(1);
  if (options.length === 0) return emitError(d, 'USAGE', 'choose 需要至少一个选项位置参数', undefined, EXIT_USAGE);
  const params: Record<string, unknown> = { target: values['target'], options, intent: values['--intent'], ...collectCommon(values) };
  if (values['--filter-text'] !== undefined) params.filter_text = values['--filter-text'];
  return callDaemon(d, values['-s'], 'page.choose', params);
}

async function pageCategory(d: Deps, argv: string[]): Promise<number> {
  const { values, positional, errors } = parseArgs(argv, getArgs('page', 'category'));
  if (errors.length) return emitError(d, 'USAGE', errors.join('; '), undefined, EXIT_USAGE);
  const path = positional.slice(1);
  if (path.length === 0) return emitError(d, 'USAGE', 'category 需要至少一级路径位置参数', undefined, EXIT_USAGE);
  return callDaemon(d, values['-s'], 'page.category', { target: values['target'], path, intent: values['--intent'], ...collectCommon(values) });
}

async function pageFillForm(d: Deps, argv: string[]): Promise<number> {
  const { values, errors } = parseArgs(argv, getArgs('page', 'fill-form'));
  if (errors.length) return emitError(d, 'USAGE', errors.join('; '), undefined, EXIT_USAGE);
  const params: Record<string, unknown> = { scope: values['--scope'] ?? 'required', intent: values['--intent'], ...collectCommon(values) };
  const fields: Record<string, string> = Object.create(null);
  const skip: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const fieldArg = argv[i].startsWith('--field=') ? argv[i].slice(8)
      : argv[i] === '--field' ? (i + 1 < argv.length ? argv[i + 1] : '')
      : undefined;
    if (fieldArg !== undefined && fieldArg.indexOf('=') <= 0) {
      return emitError(d, 'USAGE', `--field 需要 名称=值 形式（非空名称 + =），收到: "${fieldArg}"`, undefined, EXIT_USAGE);
    }
    if (argv[i].startsWith('--field=')) {
      const kv = argv[i].slice(8);
      const eq = kv.indexOf('=');
      if (eq > 0) fields[kv.slice(0, eq)] = kv.slice(eq + 1);
    } else if (argv[i] === '--field' && i + 1 < argv.length) {
      i++;
      const eq = argv[i].indexOf('=');
      if (eq > 0) fields[argv[i].slice(0, eq)] = argv[i].slice(eq + 1);
    } else if (argv[i].startsWith('--skip=')) {
      skip.push(argv[i].slice(7));
    } else if (argv[i] === '--skip' && i + 1 < argv.length) {
      i++; skip.push(argv[i]);
    }
  }
  params.fields = fields;
  params.skip = skip;
  return callDaemon(d, values['-s'], 'page.fill-form', params);
}
