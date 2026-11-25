import { spawn } from 'node:child_process';
import { emitOk, emitError, EXIT_USAGE, EXIT_VALIDATION, type Deps } from './context.js';
import { parseArgs } from './args.js';
import { commandDefinitions } from './commands.js';
import { generateSessionReport } from '../report/session.js';
import { mergeReports, ReportMergeError } from '../report/merge.js';
import { linkedPath } from '../path-safety.js';

function getArgs(name: string, sub?: string) {
  return commandDefinitions().find((c) => c.name === name && c.subcommand === sub)?.args ?? [];
}

export async function handleReport(d: Deps, argv: string[]): Promise<number> {
  if (argv[0] === 'merge') {
    const { values, positional, errors } = parseArgs(argv.slice(1), getArgs('report', 'merge'));
    if (errors.length) return emitError(d, 'USAGE', errors.join('; '), undefined, EXIT_USAGE);
    try {
      const result = mergeReports(positional, d.env, linkedPath, values['--title']);
      if (values['--open']) {
        try { spawn('open', [result.html], { detached: true, stdio: 'ignore' }).unref(); } catch { /* open 不可用不算致命 */ }
      }
      return emitOk(d, result);
    } catch (e) {
      if (e instanceof ReportMergeError) return emitError(d, e.code, e.message, undefined, e.code === 'USAGE' ? EXIT_USAGE : EXIT_VALIDATION);
      return emitError(d, 'REPORT_INPUT', '报告读取或汇总失败，请检查原生输入文件', undefined, EXIT_VALIDATION);
    }
  }
  const { values, errors } = parseArgs(argv, getArgs('report'));
  if (errors.length) return emitError(d, 'USAGE', errors.join('; '), undefined, EXIT_USAGE);
  const sid = values['-s'];
  if (!sid) return emitError(d, 'USAGE', '缺 -s 会话 id', undefined, EXIT_USAGE);
  const result = generateSessionReport(d.env, sid, {
    title: values['--title'],
    summary: values['--summary'],
    findings: values['--findings'],
    plan: values['--plan'],
    stepTitles: values['--step-titles'],
  });
  if (!result.ok) {
    const kind = result.error.kind;
    const exit = kind === 'usage' ? EXIT_USAGE : EXIT_VALIDATION;
    return emitError(d, result.error.code, result.error.message, result.error.hint, exit);
  }
  if (values['--open']) {
    try { spawn('open', [result.data.html], { detached: true, stdio: 'ignore' }).unref(); } catch { /* open 不可用不算致命 */ }
  }
  return emitOk(d, result.data);
}
