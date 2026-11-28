import type { AcceptanceSnapshot, AcceptanceCoverage, ReportEvent, ReportImage, ReportRun } from '../shared/report-model.js';
import { computeAcceptanceCoverage, projectReportValue } from '../shared/acceptance.js';

type Ev = Record<string, unknown>;
const record = (value: unknown): value is Ev => value !== null && typeof value === 'object' && !Array.isArray(value);
const time = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const identityKeys = new Set(['t', 'id', 'after', 'group', 'check_id', 'session_id', 'source_action']);

export class SourceFactsError extends Error {
  readonly code = 'REPORT_INPUT';
}

export function projectSourceRecord(event: Ev): Ev {
  return Object.fromEntries(Object.entries(event).map(([key, value]) => {
    if (identityKeys.has(key)) return [key, value];
    const projected = projectReportValue({ [key]: value }).value as Ev;
    return [key, projected[key]];
  }));
}

export interface SourceFacts {
  traceEvents: Ev[];
  traceEventIds: Map<Ev, string>;
  events: ReportEvent[];
  images: ReportImage[];
  run: ReportRun;
  acceptance?: AcceptanceSnapshot;
  acceptanceCoverage?: AcceptanceCoverage;
}

export function buildSourceFacts(sessionId: string, trace: string, readImage: (file: string) => string | undefined, acceptance?: AcceptanceSnapshot): SourceFacts {
  const rows = trace.split('\n').flatMap((line, index) => {
    if (!line.trim()) return [];
    let event: unknown;
    try { event = JSON.parse(line); } catch { throw new SourceFactsError(`trace 第 ${index + 1} 行 JSON 损坏`); }
    if (!record(event) || typeof event.t !== 'string') throw new SourceFactsError(`trace 第 ${index + 1} 行不是合法事件`);
    return [{ event, line: index + 1 }];
  });
  const session = rows[0]?.event;
  if (session?.t !== 'session' || (typeof session.session_id === 'string' && session.session_id !== sessionId) || rows.filter(row => row.event.t === 'session').length !== 1) {
    throw new SourceFactsError('trace 启动记录与本次 Source 会话不符');
  }
  if (session.acceptance_sha256 !== acceptance?.sha256 || session.acceptance_frozen_at !== acceptance?.frozenAt) {
    throw new SourceFactsError('验收快照与 Source 会话启动记录不符');
  }
  const events: ReportEvent[] = [];
  const traceEventIds = new Map<Ev, string>();
  const images: ReportImage[] = [];
  const ids = new Set<string>();
  const append = (event: ReportEvent): void => {
    if (ids.has(event.id)) throw new SourceFactsError(`trace 事件身份重复：${event.id}`);
    ids.add(event.id);
    events.push(event);
  };
  const safe = (event: ReportEvent): ReportEvent => {
    let redacted = false;
    const values = Object.fromEntries(Object.entries(event).map(([key, value]) => {
      if (['id', 'actionId', 'checkId', 'group', 'imageId'].includes(key)) return [key, value];
      const projected = projectReportValue(value);
      redacted ||= projected.redacted;
      return [key, projected.value];
    }));
    return { ...values, ...(redacted ? { redacted: true } : {}) } as unknown as ReportEvent;
  };
  const addImage = (event: ReportEvent, file: unknown, phase?: ReportImage['phase']): void => {
    if (typeof file !== 'string' || event.error) return;
    try {
      const src = readImage(file);
      if (!src) throw new Error('截图字节缺失或未嵌入');
      const id = `${event.id}:image`;
      event.imageId = id;
      images.push({ id, eventId: event.id, ...(event.actionId ? { actionId: event.actionId } : {}), sequence: event.sequence,
        src, ...(phase ? { phase } : {}), ...(event.startedAt !== undefined ? { startedAt: event.startedAt } : {}),
        ...(event.endedAt !== undefined ? { endedAt: event.endedAt } : {}), ...(event.intent ? { label: event.intent } : {}),
      });
    } catch (error) {
      event.status = 'error';
      event.actualStatus = 'unavailable';
      event.error = { code: 'REPORT_IMAGE', message: String(projectReportValue(error instanceof Error ? error.message : String(error)).value) };
    }
  };
  for (const { event: raw, line } of rows) {
    if (raw.t === 'session' || raw.t === 'session_end') continue;
    const id = typeof raw.id === 'string' && raw.id ? raw.id : `${sessionId}:trace:${line}`;
    traceEventIds.set(raw, id);
    const result = record(raw.result) ? raw.result : undefined;
    const actual = raw.t === 'capture' ? result?.value : raw.actual;
    const errorRaw = raw.error ?? (record(actual) ? actual.error : undefined) ?? result?.error;
    const error = errorRaw === undefined ? undefined : record(errorRaw)
      ? { ...(typeof errorRaw.code === 'string' ? { code: errorRaw.code } : {}), message: String(errorRaw.message ?? errorRaw.code ?? '未记录错误信息') }
      : { message: String(errorRaw) };
    const type: ReportEvent['type'] = raw.t === 'action' ? 'action' : raw.t === 'assert' ? 'assert'
      : raw.t === 'capture' ? 'capture' : raw.t === 'screenshot' ? 'screenshot'
      : String(raw.t).endsWith('_error') || raw.t === 'error' ? 'error' : 'observation';
    const status: ReportEvent['status'] = raw.status === 'error' || error ? 'error'
      : raw.status === 'fail' || raw.pass === false || result?.ok === false ? 'fail'
      : raw.status === 'not_run' || raw.executed === false || raw.t === 'assert' && raw.pass !== true ? 'not_run' : 'pass';
    const expected = record(raw.expect) ? raw.expect : undefined;
    const valueSource = record(raw.value) ? raw.value : undefined;
    const target = raw.t === 'capture' ? result?.target : raw.target;
    const requestPath = raw.t === 'request'
      ? (() => { try { return new URL(String(raw.url ?? '')).pathname; } catch { return String(raw.path ?? ''); } })()
      : '';
    const sensitiveRequest = raw.t === 'request' && /(?:cookie|token|password|passwd|pwd|secret|credential|authorization)/i.test(requestPath);
    const resolvedExpected = valueSource && Object.hasOwn(valueSource, 'raw') ? valueSource.raw
      : expected && Object.hasOwn(expected, 'value') ? expected.value
      : expected && Object.hasOwn(expected, 'equals') ? expected.equals
      : expected && Object.hasOwn(expected, 'contains') ? expected.contains : raw.expect;
    const event = safe({ id, sequence: line * 2, type, kind: String(raw.kind ?? raw.check ?? raw.t), status,
      ...(typeof raw.group === 'string' && raw.group ? { group: raw.group } : {}),
      ...(raw.t === 'action' ? { actionId: id } : typeof raw.after === 'string' && raw.after ? { actionId: raw.after } : {}),
      ...(typeof raw.check_id === 'string' && raw.check_id ? { checkId: raw.check_id } : {}),
      ...(typeof raw.intent === 'string' ? { intent: raw.intent } : {}),
      ...(time(raw.ts) !== undefined ? { startedAt: time(raw.ts) } : {}),
      ...(time(raw.ts_end) !== undefined ? { endedAt: time(raw.ts_end) } : {}),
      ...(typeof raw.executed === 'boolean' ? { executed: raw.executed } : raw.t === 'assert' && typeof raw.pass === 'boolean' || result?.ok === true ? { executed: true } : {}),
      ...(target !== undefined || raw.within !== undefined ? { target: { ...(target !== undefined ? { target } : {}), ...(raw.within !== undefined ? { within: raw.within } : {}) } } : {}),
      ...(raw.args !== undefined ? { args: raw.args } : {}),
      ...(raw.t === 'action' && (raw.resolved_value !== undefined || valueSource) ? { input: raw.resolved_value ?? valueSource?.raw } : {}),
      ...(valueSource ? { valueSource } : {}),
      ...(raw.expect !== undefined ? { expect: raw.expect, resolvedExpected } : {}),
      ...(raw.t === 'action' ? { actual: Object.hasOwn(raw, 'execute_result') ? raw.execute_result : {
        result: raw.result, resolvedValue: raw.resolved_value, outputValue: raw.output_value, savedValue: raw.saved_value, settledBy: raw.settled_by,
      } } : raw.t === 'capture' ? { actual: result?.value, valueSource: { from: result?.from, lineage: result?.lineage, as: raw.as, path: result?.path, readMode: result?.read_mode } }
        : type === 'observation' ? { actual: sensitiveRequest
          ? { method: raw.method, status: raw.status, sensitive: '敏感路径请求：已省略 URL、请求与响应内容' }
          : projectSourceRecord(raw) }
          : Object.hasOwn(raw, 'actual') ? { actual } : {}),
      actualStatus: raw.path_status === 'missing' || record(actual) && actual.present === false ? 'missing'
        : error ? 'unavailable' : raw.t === 'action' || type === 'observation' || actual !== undefined ? 'present' : 'not_collected',
      ...(raw.evidence !== undefined ? { evidence: raw.evidence } : {}),
      ...(raw.frame !== undefined ? { frame: raw.frame } : {}),
      ...(error ? { error } : {}),
      ...(record(raw.execute_result) && raw.execute_result._truncated === true || raw.truncated === true ? { truncated: true } : {}),
    });
    if (type === 'screenshot') addImage(event, raw.path, raw.phase === 'after_action' || raw.phase === 'after_checks' ? raw.phase : undefined);
    append(event);
    if (raw.t === 'action' && (raw.screenshot_path !== undefined || raw.screenshot_error !== undefined)) {
      const shot = safe({ id: `${id}:screenshot`, sequence: line * 2 + 1, type: 'screenshot', kind: 'screenshot',
        status: raw.screenshot_error ? 'error' : 'pass', actionId: id, ...(event.group ? { group: event.group } : {}),
        ...(event.intent ? { intent: event.intent } : {}),
        ...(time(raw.screenshot_started_at) !== undefined ? { startedAt: time(raw.screenshot_started_at) } : {}),
        ...(time(raw.screenshot_ended_at) !== undefined ? { endedAt: time(raw.screenshot_ended_at) } : {}),
        ...(raw.screenshot_error ? { error: { code: 'SCREENSHOT_ERROR', message: String(raw.screenshot_error) }, actualStatus: 'unavailable' } : {}),
      });
      addImage(shot, raw.screenshot_path, 'after_action');
      append(shot);
    }
  }
  const end = rows.filter(row => row.event.t === 'session_end').at(-1)?.event;
  const executionErrors = events.filter(event => event.type !== 'screenshot' && (event.status === 'fail' || event.status === 'error'));
  const status: ReportRun['status'] = end?.result === 'fail' || executionErrors.length ? 'FAIL'
    : end?.result !== 'pass' || events.some(event => event.status === 'not_run') ? 'BLOCKED' : 'PASS';
  const run: ReportRun = {
    id: sessionId, mode: 'source', status, env: String(session.env ?? 'default'), toolVersion: String(session.tool_version ?? ''),
    ...(time(session.ts) !== undefined ? { startedAt: time(session.ts) } : {}),
    ...(time(end?.ts) !== undefined ? { endedAt: time(end?.ts) } : {}),
    ...(typeof session.cli_sha256 === 'string' ? { cliSha256: session.cli_sha256 } : {}),
    ...(typeof session.browser_source === 'string' ? { browserSource: session.browser_source } : {}),
    ...(typeof session.auth_source === 'string' ? { authSource: session.auth_source } : {}),
    ...(record(session.browser) && typeof session.browser.version === 'string' ? { browserVersion: session.browser.version } : {}),
    ...(executionErrors.length ? { errors: executionErrors.map(event => event.error ?? { message: `${event.kind} 比较不符` }) } : {}),
  };
  const shownAcceptance: AcceptanceSnapshot | undefined = acceptance ? {
    ...acceptance, document: { schemaVersion: 1, scenarios: acceptance.document.scenarios.map(scenario => ({
      id: scenario.id, goal: String(projectReportValue(scenario.goal).value), source: projectReportValue(scenario.source).value as typeof scenario.source,
      preconditions: projectReportValue(scenario.preconditions).value as string[],
      ...(scenario.actions ? { actions: projectReportValue(scenario.actions).value as string[] } : {}),
      checks: scenario.checks.map(check => ({ id: check.id, expectation: String(projectReportValue(check.expectation).value), ...(check.irRef ? { irRef: check.irRef } : {}) })),
    })) },
  } : undefined;
  return { traceEvents: rows.map(row => row.event), traceEventIds, events, images, run,
    ...(shownAcceptance ? { acceptance: shownAcceptance, acceptanceCoverage: computeAcceptanceCoverage(shownAcceptance.document, events) } : {}),
  };
}
