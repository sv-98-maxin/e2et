import * as fs from 'node:fs';
import { emitError, EXIT_USAGE, EXIT_VALIDATION, type Deps } from './context.js';
import { parseArgs } from './args.js';
import { commandDefinitions } from './commands.js';
import { callDaemon, parsePageDataSourceFlags, parseEqualsScalar } from './daemon-call.js';

function getArgs(name: string, sub?: string) {
  return commandDefinitions().find((c) => c.name === name && c.subcommand === sub)?.args ?? [];
}

export async function handleAssert(d: Deps, argv: string[]): Promise<number> {
  const sub = argv[0];
  const valid = ['api', 'request', 'toast', 'text', 'visible', 'absent', 'table-row', 'field', 'url', 'data', 'style', 'element', 'console'];
  if (!sub || !valid.includes(sub)) {
    return emitError(d, 'USAGE', `assert 未知子命令: ${sub ?? '空'}`, valid.join('|'), EXIT_USAGE);
  }
  const subNorm = sub.replace('-', '_');
  const { values, errors } = parseArgs(argv.slice(1), getArgs('assert', sub as any));
  if (errors.length) return emitError(d, 'USAGE', errors.join('; '), undefined, EXIT_USAGE);
  const sid = values['-s'];
  if (!sid) return emitError(d, 'USAGE', '缺 -s 会话 id', undefined, EXIT_USAGE);
  if (sub === 'data') {
    const parsed = parsePageDataSourceFlags(values);
    if (!parsed.ok) return emitError(d, 'USAGE', parsed.message, undefined, EXIT_USAGE);
    const equals = parseEqualsScalar(values['--equals'] ?? '');
    if (!equals.ok) return emitError(d, 'USAGE', equals.message, undefined, EXIT_USAGE);
    const params: Record<string, unknown> = { ...parsed.source, equals: equals.value };
    if (values['--group']) params.group = values['--group'];
    if (values['--frame']) params.frame = values['--frame'];
    return callDaemon(d, sid, 'assert.data', params);
  }
  const params: Record<string, unknown> = {};
  if (values['req']) params.req = values['req'];
  if (values['--expect']) params.expect = values['--expect'];
  if (values['--header']) params.header = values['--header'];
  if (values['--body']) params.body = values['--body'];
  if (values['--query']) params.query = values['--query'];
  if (sub === 'request' && (values['--body'] === undefined) === (values['--query'] === undefined)) {
    return emitError(d, 'USAGE', '--body 与 --query 必须恰好提供一个', undefined, EXIT_USAGE);
  }
  if (values['text']) params.text = values['text'];
  if (sub !== 'text' && values['contains'] !== undefined) params.contains = values['contains'];
  if (values['--within']) params.within = values['--within'];
  if (values['target']) params.target = values['target'];
  if (values['--count'] !== undefined) {
    if (sub === 'console') {
      const raw = String(values['--count']).trim();
      const count = raw === '' ? NaN : Number(raw);
      if (!Number.isInteger(count) || count < 0) {
        return emitError(d, 'USAGE', '--count 必须是非负整数', undefined, EXIT_USAGE);
      }
      params.count = count;
    } else {
      params.count = Number(values['--count']);
    }
  }
  if (values['label']) params.label = values['label'];
  if (values['--property']) params.property = values['--property'];
  if (values['--equals'] !== undefined) params.equals = values['--equals'];
  if (values['--pseudo']) params.pseudo = values['--pseudo'];
  if (values['--level']) params.level = values['--level'];
  if (values['--contains'] !== undefined) params.contains = values['--contains'];
  if (values['--scope']) params.scope = values['--scope'];
  if (values['--all'] === 'true') params.all = true;
  if (values['--no-error'] === 'true') params.no_error = true;
  if (values['--frame']) params.frame = values['--frame'];
  if (sub === 'api' && (values['--expect'] === undefined) === (values['--header'] === undefined)) {
    return emitError(d, 'USAGE', '--expect 与 --header 必须恰好提供一个', undefined, EXIT_USAGE);
  }
  if (['field', 'api', 'request', 'text'].includes(sub)) {
    const literalValue = sub === 'text' ? values['contains'] : values['value'];
    const hasValue = literalValue !== undefined;
    const hasRef = values['--value-ref'] !== undefined;
    const hasFromAction = values['--value-from-action'] !== undefined;
    const sources = (hasValue ? 1 : 0) + (hasRef ? 1 : 0) + (hasFromAction ? 1 : 0);
    if (sources > 1) {
      return emitError(d, 'USAGE', 'value / --value-ref / --value-from-action 必须恰好提供一个', undefined, EXIT_USAGE);
    }
    if (sub === 'field' && sources === 0) {
      return emitError(d, 'USAGE', '缺期望值：value、--value-ref、--value-from-action 恰好选一个（value 可为空串）', undefined, EXIT_USAGE);
    }
    if (sub === 'text' && sources === 0) {
      return emitError(d, 'USAGE', '缺期望值：contains(文本)、--value-ref、--value-from-action 恰好选一个', undefined, EXIT_USAGE);
    }
    if (hasValue) params.value = literalValue;
    if (hasRef) params.value_ref = values['--value-ref'];
    if (hasFromAction) params.value_from_action = values['--value-from-action'];
  }
  if (values['--group']) params.group = values['--group'];
  return callDaemon(d, sid, 'assert.' + subNorm, params);
}

export async function handleCapture(d: Deps, argv: string[]): Promise<number> {
  const sub = argv[0];
  if (!sub || !['api', 'element'].includes(sub)) {
    return emitError(d, 'USAGE', `capture 未知子命令: ${sub ?? '空'}`, 'api|element', EXIT_USAGE);
  }
  const { values, errors } = parseArgs(argv.slice(1), getArgs('capture', sub as any));
  if (errors.length) return emitError(d, 'USAGE', errors.join('; '), undefined, EXIT_USAGE);
  const sid = values['-s'];
  if (!sid) return emitError(d, 'USAGE', '缺 -s 会话 id', undefined, EXIT_USAGE);
  const params: Record<string, unknown> = {};
  if (values['req']) params.req = values['req'];
  if (values['path']) params.path = values['path'];
  if (values['target']) params.target = values['target'];
  if (values['--as']) params.as = values['--as'];
  if (values['--frame']) params.frame = values['--frame'];
  if (values['--group']) params.group = values['--group'];
  return callDaemon(d, sid, 'capture.' + sub, params);
}

export async function handleMock(d: Deps, argv: string[]): Promise<number> {
  const sub = argv[0];
  if (!sub || !['add', 'clear'].includes(sub)) {
    return emitError(d, 'USAGE', `mock 未知子命令: ${sub ?? '空'}`, 'add|clear', EXIT_USAGE);
  }
  const { values, errors } = parseArgs(argv.slice(1), getArgs('mock', sub as any));
  if (errors.length) return emitError(d, 'USAGE', errors.join('; '), undefined, EXIT_USAGE);
  const sid = values['-s'];
  if (!sid) return emitError(d, 'USAGE', '缺 -s 会话 id', undefined, EXIT_USAGE);
  if (sub === 'add') {
    const bodyFile = values['--body-file'];
    if (!bodyFile) return emitError(d, 'USAGE', '缺 --body-file', undefined, EXIT_USAGE);
    let bodyBuffer: Buffer;
    try {
      bodyBuffer = fs.readFileSync(bodyFile);
    } catch (e) {
      return emitError(d, 'FILE_NOT_FOUND', `读取 body-file 失败: ${(e as Error).message}`, undefined, EXIT_VALIDATION);
    }
    const params: Record<string, unknown> = {
      path: values['path'],
      body_b64: bodyBuffer.toString('base64'),
      status: values['--status'] !== undefined ? Number(values['--status']) : 200,
    };
    if (values['--call-index'] !== undefined) params.call_index = Number(values['--call-index']);
    if (values['--content-type']) params.content_type = values['--content-type'];
    return callDaemon(d, sid, 'mock.add', params);
  }
  const params: Record<string, unknown> = {};
  if (values['path']) params.path = values['path'];
  return callDaemon(d, sid, 'mock.clear', params);
}
