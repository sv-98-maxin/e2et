import type { IRv2 } from './types.js';
import type { AcceptanceCoverage, AcceptanceCheckCoverage, ReportEvent } from './report-model.js';
import { REDACTED, isSensitiveKey, redactText } from './url-safety.js';

export interface AcceptanceDocument {
  schemaVersion: 1;
  scenarios: Array<{
    id: string;
    goal: string;
    source: { kind: 'user' | 'contract' | 'case' | 'host'; text?: string; ref?: string };
    preconditions: string[];
    actions?: string[];
    checks: Array<{
      id: string;
      expectation: string;
      irRef?: { irSha256: string; stepId: string; checkIndex: number; entryIndex?: number };
    }>;
  }>;
}

export interface AcceptanceSnapshot {
  document: AcceptanceDocument;
  sha256: string;
  frozenAt: number;
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const idText = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value);
const displayText = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
const displayStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every(displayText);
const index = (value: unknown): value is number => Number.isInteger(value) && Number(value) >= 0;
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);

export function parseAcceptance(input: unknown): { ok: true; data: AcceptanceDocument } | { ok: false; error: string } {
  const invalid = (error: string): { ok: false; error: string } => ({ ok: false, error });
  if (!record(input) || input.schemaVersion !== 1 || !Array.isArray(input.scenarios)) {
    return invalid('验收说明必须是 schemaVersion=1、scenarios 为数组的对象');
  }
  const scenarios = new Set<string>();
  const checks = new Set<string>();
  for (const [scenarioIndex, scenario] of input.scenarios.entries()) {
    const at = `scenarios[${scenarioIndex}]`;
    if (!record(scenario) || !idText(scenario.id) || !displayText(scenario.goal)) return invalid(`${at} 的 id 必须无控制符；goal 允许换行但不能为空`);
    if (scenarios.has(scenario.id)) return invalid(`${at} 的场景 ID 重复：${scenario.id}`);
    scenarios.add(scenario.id);
    const source = scenario.source;
    if (!record(source) || typeof source.kind !== 'string' || !['user', 'contract', 'case', 'host'].includes(source.kind)) return invalid(`${at}.source.kind 无效`);
    if ((source.text !== undefined && !displayText(source.text)) || (source.ref !== undefined && !displayText(source.ref))
      || (source.text === undefined && source.ref === undefined)) return invalid(`${at}.source 必须提供非空 text/ref`);
    if (!displayStrings(scenario.preconditions) || (scenario.actions !== undefined && !displayStrings(scenario.actions))) return invalid(`${at} 的 preconditions/actions 必须为字符串数组`);
    if (!Array.isArray(scenario.checks)) return invalid(`${at}.checks 必须为数组`);
    for (const [checkIndex, check] of scenario.checks.entries()) {
      const checkAt = `${at}.checks[${checkIndex}]`;
      if (!record(check) || !idText(check.id) || !displayText(check.expectation)) return invalid(`${checkAt} 的 id 必须无控制符；expectation 允许换行但不能为空`);
      if (checks.has(check.id)) return invalid(`${checkAt} 的检查 ID 全局重复：${check.id}`);
      checks.add(check.id);
      if (check.irRef !== undefined) {
        const ref = check.irRef;
        if (!record(ref) || !sha(ref.irSha256) || !idText(ref.stepId) || !index(ref.checkIndex)
          || (ref.entryIndex !== undefined && !index(ref.entryIndex))) return invalid(`${checkAt}.irRef 的 SHA/stepId/索引无效`);
      }
    }
  }
  return { ok: true, data: input as unknown as AcceptanceDocument };
}

export function validateAcceptanceRefs(document: AcceptanceDocument, ir: IRv2, irSha256: string): string | undefined {
  for (const scenario of document.scenarios) {
    for (const check of scenario.checks) {
      const ref = check.irRef;
      if (!ref) continue;
      if (ref.irSha256.toLowerCase() !== irSha256.toLowerCase()) return `检查 ${check.id} 的 IR SHA 不匹配`;
      const step = ir.steps.find(item => item.id === ref.stepId);
      const target = step?.checks?.[ref.checkIndex];
      if (!target) return `检查 ${check.id} 的 IR step/check 引用不存在`;
      if (!('assert' in target)) return `检查 ${check.id} 的 IR 引用不是正式断言`;
      if (ref.entryIndex !== undefined) {
        const assertion = 'assert' in target ? target.assert : undefined;
        const entries = assertion && ('api' in assertion ? assertion.expect ?? assertion.header
          : 'request' in assertion ? assertion.body ?? assertion.query : undefined);
        if (!entries || ref.entryIndex >= entries.length) return `检查 ${check.id} 的 IR entry 引用不存在`;
      }
    }
  }
  return undefined;
}

export function matchesAcceptanceRef(
  event: ReportEvent,
  ref: NonNullable<AcceptanceDocument['scenarios'][number]['checks'][number]['irRef']>,
): boolean {
  const actual = record(event.evidence) && record(event.evidence.irRef) ? event.evidence.irRef : undefined;
  return actual !== undefined && sha(actual.irSha256) && actual.irSha256.toLowerCase() === ref.irSha256.toLowerCase()
    && actual.stepId === ref.stepId && actual.checkIndex === ref.checkIndex
    && (ref.entryIndex === undefined || actual.entryIndex === ref.entryIndex);
}

export function computeAcceptanceCoverage(document: AcceptanceDocument, events: readonly ReportEvent[]): AcceptanceCoverage {
  const scenarios = document.scenarios.map(scenario => {
    const checks: AcceptanceCheckCoverage[] = scenario.checks.map(check => {
      const attempts = events.filter(event => event.type === 'assert' && event.group === scenario.id && event.checkId === check.id
        && (!check.irRef || matchesAcceptanceRef(event, check.irRef)))
        .sort((first, second) => first.sequence - second.sequence);
      const status = !attempts.length ? 'unbound'
        : attempts.some(event => event.status === 'error') ? 'error'
        : attempts.some(event => event.status === 'fail') ? 'fail'
        : attempts.some(event => event.status === 'not_run' || event.executed !== true) ? 'not_run' : 'pass';
      return { id: check.id, expectation: check.expectation, status, eventIds: attempts.map(event => event.id) };
    });
    const result = checks.some(check => check.status === 'fail' || check.status === 'error') ? 'FAIL'
      : !checks.length || checks.some(check => check.status !== 'pass') ? 'UNVERIFIED' : 'PASS';
    return { id: scenario.id, goal: scenario.goal, checks, result } as const;
  });
  const checks = scenarios.flatMap(scenario => scenario.checks);
  return {
    scenarios,
    result: scenarios.some(scenario => scenario.result === 'FAIL') ? 'FAIL'
      : !scenarios.length || scenarios.some(scenario => scenario.result === 'UNVERIFIED') ? 'UNVERIFIED' : 'PASS',
    bound: checks.filter(check => check.eventIds.some(id => events.some(event => event.id === id && event.executed === true))).length,
    total: checks.length,
  };
}

export function projectReportValue(value: unknown): { value: unknown; redacted: boolean } {
  let redacted = false;
  const project = (input: unknown, key?: string): unknown => {
    if (key && isSensitiveKey(key)) {
      if (input !== REDACTED) redacted = true;
      return REDACTED;
    }
    if (typeof input === 'string') {
      const safe = redactText(input);
      if (safe !== input) redacted = true;
      return safe;
    }
    if (Array.isArray(input)) return input.map(item => project(item));
    if (record(input)) return Object.fromEntries(Object.entries(input).map(([childKey, child]) => [childKey, project(child, childKey)]));
    return input;
  };
  return { value: project(value), redacted };
}
