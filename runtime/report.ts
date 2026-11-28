/**
 * IR 回放报告：把 step 执行结果、断言、接口证据和截图装成共享 ReportData，
 * 与 CLI `e2et report` 用同一个 HTML 模板（runtime/shared/report-render.ts）。
 */
import type { ApiRef, IRv2, Step } from './types.js';
import type { RequestRecord } from './request-tracker.js';
import type { AcceptanceSnapshot, ReportCase, ReportData, ReportEvent, ReportImage, ReportRun, ReportStep, ReportStepApi } from './shared/report-model.js';
import { projectReportFacts } from './shared/report-finalize.js';
import { redactText, redactUrl } from './shared/url-safety.js';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

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
  events?: ReportEvent[];
}

export function runtimeDigest(directory: string): string {
  const files: string[] = [];
  const visit = (parent: string): void => {
    for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
      if (entry.name === '__tests__') continue;
      const file = path.join(parent, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) files.push(file);
    }
  };
  visit(directory);
  const manifest = files.map(file => ({ relative: path.relative(directory, file).split(path.sep).join('/'), file }))
    .sort((first, second) => first.relative < second.relative ? -1 : first.relative > second.relative ? 1 : 0)
    .map(entry => `${entry.relative}\0${createHash('sha256').update(fs.readFileSync(entry.file)).digest('hex')}\n`).join('');
  return createHash('sha256').update(manifest).digest('hex');
}

export function createReplayRun(input: Partial<ReportRun> = {}): ReportRun {
  return {
    id: input.id ?? process.env.E2ET_RUN_ID ?? randomUUID(), mode: 'replay', status: 'BLOCKED',
    startedAt: Date.now(), toolVersion: '',
    env: process.env.E2ET_RUN_ENV ?? process.env.TEST_ENV ?? 'default',
    ...input,
  };
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
    ...(outcome.step.report_ref?.group ? { group: outcome.step.report_ref.group } : {}),
    actionIds: outcome.events?.filter(event => event.type === 'action').map(event => event.id),
    eventIds: outcome.events?.map(event => event.id),
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

export function buildReport(ir: IRv2, outcomes: StepOutcome[], options: {
  run?: ReportRun; acceptance?: AcceptanceSnapshot; events?: ReportEvent[]; images?: ReportImage[];
} = {}): ReportData {
  const steps = outcomes.map((outcome, index) => buildReportStep(outcome, index + 1));
  const failed = steps.some((s) => s.status === 'fail') || Boolean(options.run?.errors?.length);
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
    events: options.events ?? outcomes.flatMap(outcome => outcome.events ?? []),
    images: options.images ?? [],
    run: { ...(options.run ?? createReplayRun()), status: result },
    sessionResult: result,
    recording: { ...ir.provenance },
    ...(options.acceptance ? { acceptance: options.acceptance } : {}),
  };
  return projectReportFacts({
    report_schema_version: 2,
    title: ir.name,
    url: ir.url,
    env: reportCase.run!.env,
    result,
    summary: reportCase.summary!,
    sessionId: reportCase.run!.id,
    toolVersion: reportCase.run!.toolVersion,
    mocked: ir.provenance.mocked,
    cases: [reportCase],
    coverage: {
      plan: null,
      executed: outcomes.map(outcome => outcome.step.intent),
      missing: [],
      unplanned: [],
    },
  });
}
