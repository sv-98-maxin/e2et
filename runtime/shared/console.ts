import { redactText } from './url-safety.js';

export type ConsoleLevel = 'log' | 'debug' | 'info' | 'warning' | 'error' | 'trace';
export type ConsoleSource = 'console-api' | 'exception' | 'log-entry';

export interface ConsoleEntry {
  seq: number; ts: number; level: ConsoleLevel; source: ConsoleSource; text: string; target_id: string;
  frame_id?: string; nav?: string; action_id?: string; after_id?: string; group?: string;
}

export interface ConsoleSnapshot { active: boolean; truncated: boolean; entries: ConsoleEntry[]; }

const LEVELS: Record<string, ConsoleLevel> = {
  log: 'log', debug: 'debug', verbose: 'debug', info: 'info', warning: 'warning', warn: 'warning',
  error: 'error', trace: 'trace', assert: 'error',
  dir: 'log', dirxml: 'log', table: 'log', count: 'log', countreset: 'log', timeend: 'log',
  startgroup: 'log', startgroupcollapsed: 'log', endgroup: 'log', clear: 'log',
  profile: 'log', profileend: 'log', timestamp: 'log',
};

export function normalizeConsoleLevel(type: string): ConsoleLevel {
  const level = LEVELS[type.toLowerCase()];
  if (!level) throw new Error(`UNSUPPORTED_CONSOLE_LEVEL: ${type}`);
  return level;
}

function scalarText(value: unknown): string | undefined {
  if (value === null) return 'null';
  const kind = typeof value;
  if (kind === 'string' || kind === 'number' || kind === 'boolean' || kind === 'bigint') return String(value);
  return undefined;
}

/** 只取 CDP 标量/description，不展开对象、不触发 getter；输出统一过 redactText。 */
export function safeConsoleText(input: unknown): string {
  const values = input === undefined ? [] : Array.isArray(input) ? input : [input];
  const parts = values.map((arg) => {
    if (typeof arg === 'string') return arg;
    if (!arg || typeof arg !== 'object') return scalarText(arg) ?? '';
    const remote = arg as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(remote, 'value')) {
      const value = scalarText(remote.value);
      if (value !== undefined) return value;
    }
    if (typeof remote.unserializableValue === 'string') return remote.unserializableValue;
    if (typeof remote.description === 'string') return remote.description;
    return remote.type === 'undefined' ? 'undefined' : typeof remote.type === 'string' ? `<${remote.type}>` : '';
  });
  return redactText(parts.join(' '));
}

export interface ConsoleSelection { scope: 'session' | 'action'; actionId?: string; frameId?: string; }
export interface SelectedConsole { logs: ConsoleEntry[]; incomplete: boolean; }

export function selectConsoleEntries(snapshot: ConsoleSnapshot, selection: ConsoleSelection): SelectedConsole {
  const { scope, actionId, frameId } = selection;
  const logs = snapshot.entries.filter((entry) => {
    if (scope === 'action' && (!actionId || (entry.action_id !== actionId && entry.after_id !== actionId))) return false;
    return frameId === undefined || entry.frame_id === frameId;
  });
  const unknownAttribution = snapshot.entries.some((entry) =>
    (scope === 'action' && entry.action_id === undefined && entry.after_id === undefined)
    || (frameId !== undefined && entry.frame_id === undefined));
  return { logs, incomplete: !snapshot.active || snapshot.truncated || (scope === 'action' && !actionId) || unknownAttribution };
}

export type ConsoleCheck = { noError: true } | { level: ConsoleLevel; contains?: string; count: number };
export interface ConsoleMatch {
  pass: boolean; expected: string; actual: string;
  logs: ConsoleEntry[]; counts: Record<ConsoleLevel, number>; incomplete: boolean;
}

export function matchConsole(snapshot: ConsoleSnapshot, check: ConsoleCheck, selection: ConsoleSelection): ConsoleMatch {
  const { logs, incomplete } = selectConsoleEntries(snapshot, selection);
  const counts: Record<ConsoleLevel, number> = { log: 0, debug: 0, info: 0, warning: 0, error: 0, trace: 0 };
  for (const entry of logs) counts[entry.level]++;
  if ('noError' in check) {
    const errors = logs.filter((entry) => entry.level === 'error');
    return { pass: !incomplete && !errors.length, expected: 'no error console entries', actual: `${errors.length} error entries`, logs, counts, incomplete };
  }
  const matched = logs.filter((entry) => entry.level === check.level && (check.contains === undefined || entry.text.includes(check.contains)));
  return {
    pass: !incomplete && matched.length === check.count,
    expected: `${check.count} ${check.level}${check.contains === undefined ? '' : ` containing ${check.contains}`}`,
    actual: `${matched.length} ${check.level}`,
    logs: matched,
    counts,
    incomplete,
  };
}
