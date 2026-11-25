/**
 * IR 回放报告：把 step 执行结果、断言、接口证据和截图装成共享 ReportData，
 * 与 CLI `e2et report` 用同一个 HTML 模板（runtime/shared/report-render.ts）。
 */
import type { ApiRef, IRv2, Step } from './types.js';
import type { RequestRecord } from './request-tracker.js';
import type { ReportCase, ReportData, ReportStep, ReportStepApi } from './shared/report-render.js';
import { jsonPath, diagnoseMissingPath, queryParamValues } from './shared/assertion.js';
import { redactText, redactUrl } from './shared/url-safety.js';

export interface StepOutcome {
  step: Step;
  status: 'pass' | 'fail' | 'blocked';
  durationMs: number;
  error?: string;
  screenshot?: string;
  screenshotNotice?: string;
  apis: ReportStepApi[];
  assertions: Record<string, unknown>[];
  captures: Record<string, unknown>[];
}

/** step 里声明的全部接口引用：wait、assert、capture，按 path+nav+call_index 去重。 */
export function collectApiRefs(step: Step): ApiRef[] {
  const refs: ApiRef[] = [];
  for (const wait of step.wait ?? []) {
    if ('api' in wait && wait.api) refs.push(wait.api);
  }
  for (const check of step.checks ?? []) {
    if ('assert' in check) {
      if ('api' in check.assert) refs.push(check.assert.api);
      if ('request' in check.assert) refs.push(check.assert.request);
    } else if ('capture' in check && 'from_api' in check.capture) {
      refs.push(check.capture.from_api);
    }
  }
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.path}|${ref.nav}|${ref.call_index}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function toReportApi(record: RequestRecord): ReportStepApi {
  const headers = record.responseHeaders
    ? Object.entries(record.responseHeaders).map(([key, value]) => `${key}: ${value}`).join('\n')
    : undefined;
  const traceId = headers?.match(/^\s*eagleeye-traceid\s*:\s*(\S+)/im)?.[1];
  return {
    method: record.method,
    url: redactUrl(record.url),
    status: record.status === undefined ? '' : String(record.status),
    path: record.path,
    nav: record.nav,
    callIndex: record.call_index,
    reqBody: record.requestBody === undefined ? undefined : redactText(record.requestBody),
    respBody: record.body === undefined
      ? (record.failed === undefined ? undefined : redactText(record.failed))
      : redactText(record.body),
    ...(headers ? { respHeaders: headers } : {}),
    ...(traceId ? { traceId } : {}),
    ...(record.started !== undefined ? { time: new Date(record.started).toISOString() } : {}),
  };
}

/** 解析 body → jsonPath 取值。返回 { ok, parsed, actual, diagnostic }：
 *  body 缺失/非 JSON → BODY_UNAVAILABLE；path 命中 → ok；未命中 → missing + evidence。
 */
interface ResolveResult {
  ok: boolean;
  actual?: unknown;
  diagnostic?: Record<string, unknown>;
}

function resolveValue(body: string | undefined, path: string): ResolveResult {
  if (body === undefined) {
    return { ok: false, diagnostic: { path_status: 'BODY_UNAVAILABLE', reason: 'no_body' } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, diagnostic: { path_status: 'BODY_UNAVAILABLE', reason: 'non_json' } };
  }
  const actual = jsonPath(parsed, path);
  if (actual === undefined) {
    return { ok: false, diagnostic: diagnoseMissingPath(parsed, path) };
  }
  return { ok: true, actual };
}

/** query 断言报告取值：完整键名 → 有序 string[]；缺失给 missing 诊断。 */
function resolveQuery(url: string | undefined, key: string): ResolveResult {
  if (!url) return { ok: false, diagnostic: { path_status: 'missing', resolved_prefix: '' } };
  const values = queryParamValues(url, key);
  if (values === undefined) return { ok: false, diagnostic: { path_status: 'missing', resolved_prefix: '' } };
  return { ok: true, actual: values.map((value) => redactText(value)) };
}

/** 按声明把 checks 展开成报告断言：每条 expect 一条，actual 从真实响应体解析。 */
export function collectAssertions(step: Step, passed: boolean, records: RequestRecord[]): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const check of step.checks ?? []) {
    if (!('assert' in check)) continue;
    const assertion = check.assert;
    if ('api' in assertion || 'request' in assertion) {
      const ref = 'api' in assertion ? assertion.api : assertion.request;
      const record = records.find((r) => r.path === ref.path && r.nav === 'n' + ref.nav && r.call_index === ref.call_index);
      const isApi = 'api' in assertion;
      const isQuery = !isApi && assertion.query !== undefined;
      const entries = (isApi ? assertion.expect : (assertion.query ?? assertion.body)) ?? [];
      for (const entry of entries) {
        const bodyStr = isApi ? record?.body : record?.requestBody;
        const resolved = isApi
          ? resolveValue(bodyStr, entry.path)
          : isQuery
            ? resolveQuery(record?.url, entry.path)
            : resolveValue(bodyStr, entry.path);
        rows.push({
          kind: isApi ? 'api' : 'request',
          expect: { path: entry.path, op: entry.op, value: 'value' in entry ? entry.value : ('value_ref' in entry ? entry.value_ref : entry.value_from_action) },
          ...(resolved.ok
            ? { actual: resolved.actual, path_status: 'ok' }
            : { actual: null, ...(resolved.diagnostic ?? {}) }),
          pass: passed,
        });
      }
    } else {
      rows.push({ kind: Object.keys(assertion)[0] ?? 'assert', expect: assertion, actual: passed ? '通过' : undefined, pass: passed });
    }
  }
  return rows;
}

export function collectCaptures(step: Step, records: RequestRecord[]): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const check of step.checks ?? []) {
    if (!('capture' in check) || !('from_api' in check.capture)) continue;
    const capture = check.capture;
    const record = records.find((r) => r.path === capture.from_api.path
      && r.nav === 'n' + capture.from_api.nav && r.call_index === capture.from_api.call_index);
    const resolved = resolveValue(record?.body, capture.path);
    rows.push({
      as: capture.as,
      path: capture.path,
      value: resolved.ok ? resolved.actual : undefined,
      ...(resolved.ok ? {} : resolved.diagnostic ?? {}),
      lineage: capture.lineage,
    });
  }
  return rows;
}

export function buildReportStep(outcome: StepOutcome, index: number): ReportStep & { assertions: Record<string, unknown>[] } {
  const facts: string[] = [];
  for (const api of outcome.apis) {
    facts.push(`${api.method} ${api.path} → ${api.status || '无响应'}`);
  }
  const passedAssertions = outcome.assertions.filter((a) => a.pass === true).length;
  if (outcome.assertions.length) facts.push(`${passedAssertions}/${outcome.assertions.length} 断言通过`);
  if (outcome.error) facts.push(outcome.error);
  if (!outcome.assertions.length) facts.push('未校验（0 断言）');
  return {
    index,
    status: outcome.status,
    action: outcome.step.intent,
    observation: facts.join('；'),
    duration: `${outcome.durationMs}ms`,
    apis: outcome.apis,
    assertions: outcome.assertions,
    captures: outcome.captures,
    assertDetails: outcome.assertions.map((a) => {
      const expect = a.expect as Record<string, unknown> | undefined;
      const pathStatus = a.path_status as string | undefined;
      const actualStr = pathStatus === 'missing'
        ? `missing(prefix=${a.resolved_prefix ?? ''})`
        : pathStatus === 'BODY_UNAVAILABLE'
          ? 'BODY_UNAVAILABLE'
          : a.actual !== undefined
            ? JSON.stringify(a.actual)
            : '缺失';
      const diagParts: string[] = [];
      if (a.available_keys) diagParts.push(`keys=[${(a.available_keys as string[]).join(',')}]`);
      if (a.array_length !== undefined) diagParts.push(`length=${String(a.array_length)}`);
      const diagStr = diagParts.length ? ` ${diagParts.join(' ')}` : '';
      const executed = a.executed === false ? '未执行' : '';
      return `${String(a.kind)}；期望：${expect?.path ? `${String(expect.path)} ${String(expect.op)} ${String(expect.value)}` : JSON.stringify(a.expect)}；实际：${executed || actualStr}${diagStr}${a.pass === true ? '' : ' [失败]'}`;
    }),
    ...(outcome.screenshot ? { screenshot: outcome.screenshot } : {}),
    ...(outcome.screenshotNotice ? { screenshotNotice: outcome.screenshotNotice } : {}),
  };
}

export function buildReport(ir: IRv2, outcomes: StepOutcome[]): ReportData {
  const steps = outcomes.map((outcome, index) => buildReportStep(outcome, index + 1));
  const failed = steps.some((s) => s.status === 'fail');
  const blocked = steps.some((s) => s.status === 'blocked');
  const result: ReportData['result'] = failed ? 'FAIL' : blocked || !steps.length ? 'BLOCKED' : 'PASS';
  const totalAssertions = steps.reduce((sum, s) => sum + s.assertions.length, 0);
  const passedAssertions = steps.reduce((sum, s) => sum + s.assertions.filter((a) => a.pass === true).length, 0);
  const summary = `${steps.filter((s) => s.status === 'pass').length}/${steps.length} 业务步骤通过；`
    + (totalAssertions ? `已覆盖 ${totalAssertions} 条断言，${passedAssertions} 条通过；` : '未覆盖任何断言；')
    + '未提供覆盖计划，仅代表已执行断言，不能证明完整需求覆盖';
  const reportCase: ReportCase = {
    id: 'TC-01',
    name: ir.name,
    result,
    steps,
    duration: `${steps.reduce((sum, s) => sum + Number(String(s.duration).replace('ms', '') || 0), 0)}ms`,
    summary,
  };
  return {
    title: ir.name,
    url: ir.url,
    env: ir.env,
    result,
    summary: reportCase.summary!,
    sessionId: ir.provenance.session_id,
    toolVersion: ir.provenance.tool_version,
    mocked: ir.provenance.mocked,
    cases: [reportCase],
    coverage: {
      plan: null,
      executed: outcomes.map(outcome => outcome.step.intent),
      missing: [],
      unplanned: [],
    },
  };
}
