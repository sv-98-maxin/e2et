import type {
  AcceptanceSnapshot, ReportCase, ReportData, ReportEvent, ReportRun,
} from './report-model.js';
import { computeAcceptanceCoverage, matchesAcceptanceRef, projectReportValue } from './acceptance.js';

export interface ReplayTestResult {
  id: string;
  name: string;
  status?: 'passed' | 'failed' | 'timedOut' | 'interrupted' | 'skipped';
  durationMs?: number;
  startedAt?: number;
  endedAt?: number;
  errors?: NonNullable<ReportRun['errors']>;
  report?: unknown;
  reportError?: string;
  blockedErrors?: NonNullable<ReportRun['errors']>;
  run?: ReportRun;
  environment?: { auth_source?: string; browser_source?: string; browser_version?: string };
}

export interface FinalizeInput {
  tests: ReplayTestResult[];
  run: ReportRun;
  exitCode?: number;
  status?: 'passed' | 'failed' | 'timedout' | 'interrupted';
  errors?: NonNullable<ReportRun['errors']>;
  blockedErrors?: NonNullable<ReportRun['errors']>;
  acceptance?: AcceptanceSnapshot;
  title?: string;
  url?: string;
  links?: ReportData['links'];
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export function stricterResult(...results: ReportRun['status'][]): ReportRun['status'] {
  return results.includes('FAIL') ? 'FAIL' : results.includes('BLOCKED') ? 'BLOCKED' : 'PASS';
}

export function projectReportFacts(data: ReportData): ReportData {
  const safe = projectReportValue(data).value as ReportData;
  safe.sessionId = data.sessionId;
  safe.cases = data.cases.map((original, index) => {
    const projected = safe.cases[index]!;
    projected.id = original.id;
    projected.sessionId = original.sessionId;
    if (original.run && projected.run) projected.run.id = original.run.id;
    if (original.recording && projected.recording && 'session_id' in original.recording) {
      projected.recording.session_id = original.recording.session_id;
    }
    projected.events = original.events?.map(event => {
      const projection = projectReportValue(event);
      const value = projection.value as ReportEvent;
      for (const key of ['id', 'actionId', 'checkId', 'group'] as const) {
        if (event[key] !== undefined) value[key] = event[key];
      }
      if (projection.redacted || event.redacted) value.redacted = true;
      if (record(value.evidence) && record(event.evidence) && record(value.evidence.irRef) && record(event.evidence.irRef)) {
        value.evidence.irRef.stepId = event.evidence.irRef.stepId;
      }
      return value;
    });
    projected.images = original.images?.map(image => ({
      ...projectReportValue(image).value as typeof image,
      id: image.id, eventId: image.eventId, actionId: image.actionId, src: image.src,
    }));
    projected.steps = projected.steps.map((step, stepIndex) => ({
      ...step,
      group: original.steps[stepIndex]?.group,
      actionIds: original.steps[stepIndex]?.actionIds,
      eventIds: original.steps[stepIndex]?.eventIds,
    }));
    if (original.acceptance && projected.acceptance) {
      projected.acceptance.document.scenarios.forEach((scenario, scenarioIndex) => {
        const originalScenario = original.acceptance!.document.scenarios[scenarioIndex]!;
        scenario.id = originalScenario.id;
        scenario.checks.forEach((check, checkIndex) => {
          const originalCheck = originalScenario.checks[checkIndex]!;
          check.id = originalCheck.id;
          if (check.irRef && originalCheck.irRef) check.irRef.stepId = originalCheck.irRef.stepId;
        });
      });
    }
    if (original.acceptanceCoverage && projected.acceptanceCoverage) {
      projected.acceptanceCoverage.scenarios.forEach((scenario, scenarioIndex) => {
        const originalScenario = original.acceptanceCoverage!.scenarios[scenarioIndex]!;
        scenario.id = originalScenario.id;
        scenario.checks.forEach((check, checkIndex) => {
          check.id = originalScenario.checks[checkIndex]!.id;
          check.eventIds = originalScenario.checks[checkIndex]!.eventIds;
        });
      });
    }
    return projected;
  });
  return safe;
}

function attachmentError(value: unknown, runId: string): string | undefined {
  if (!record(value) || value.report_schema_version !== 2 || !Array.isArray(value.cases) || !value.cases.length) {
    return 'ir-report 缺失 schema 2/cases';
  }
  if (!['PASS', 'FAIL', 'BLOCKED'].includes(String(value.result))) return 'ir-report result 无效';
  for (const reportCase of value.cases) {
    if (!record(reportCase) || typeof reportCase.id !== 'string' || typeof reportCase.name !== 'string'
      || !['PASS', 'FAIL', 'BLOCKED'].includes(String(reportCase.result)) || !Array.isArray(reportCase.steps)
      || !Array.isArray(reportCase.events) || !Array.isArray(reportCase.images) || !record(reportCase.run)
      || reportCase.run.mode !== 'replay' || reportCase.run.id !== runId
      || !['PASS', 'FAIL', 'BLOCKED'].includes(String(reportCase.run.status))) return 'ir-report case/运行身份不完整或不属于本次 run';
    const ids = new Set<string>();
    let previous = -1;
    for (const event of reportCase.events) {
      if (!record(event) || typeof event.id !== 'string' || ids.has(event.id)
        || typeof event.sequence !== 'number' || !Number.isInteger(event.sequence) || event.sequence <= previous
        || !['action', 'assert', 'capture', 'screenshot', 'observation', 'error'].includes(String(event.type))
        || !['pass', 'fail', 'error', 'not_run'].includes(String(event.status)) || typeof event.kind !== 'string') {
        return 'ir-report event 缺字段、身份重复或顺序无效';
      }
      ids.add(event.id);
      previous = event.sequence;
    }
    const imageIds = new Set<string>();
    for (const image of reportCase.images) {
      if (!record(image) || typeof image.id !== 'string' || imageIds.has(image.id)
        || typeof image.eventId !== 'string' || !ids.has(image.eventId) || typeof image.src !== 'string'
        || !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(image.src)) return 'ir-report image 引用或内容无效';
      imageIds.add(image.id);
    }
    for (const step of reportCase.steps) {
      if (!record(step) || !['pass', 'fail', 'blocked'].includes(String(step.status))) return 'ir-report step 无效';
      if (step.eventIds !== undefined && (!Array.isArray(step.eventIds) || step.eventIds.some(id => typeof id !== 'string' || !ids.has(id)))) {
        return 'ir-report step.eventIds 引用无效';
      }
    }
  }
  return undefined;
}

function bindAcceptance(events: ReportEvent[], acceptance: AcceptanceSnapshot): void {
  for (const scenario of acceptance.document.scenarios) {
    for (const check of scenario.checks) {
      const ref = check.irRef;
      if (!ref) continue;
      for (const event of events) {
        if (event.type !== 'assert' || !matchesAcceptanceRef(event, ref)
          || (event.group !== undefined && event.group !== scenario.id)
          || (event.checkId !== undefined && event.checkId !== check.id)) continue;
        event.checkId = check.id;
        event.group ??= scenario.id;
      }
    }
  }
}

function addError(reportCase: ReportCase, error: NonNullable<ReportRun['errors']>[number], failure: boolean): void {
  const events = reportCase.events ??= [];
  let sequence = (events.at(-1)?.sequence ?? -1) + 1;
  const ids = new Set(events.map(event => event.id));
  while (ids.has(`${reportCase.run!.id}:final:${sequence}`)) sequence++;
  events.push({
    id: `${reportCase.run!.id}:final:${sequence}`, sequence,
    type: 'error', kind: 'playwright', status: failure ? 'error' : 'not_run',
    executed: false, actualStatus: 'not_collected', error,
  });
}

export function finalizeReport(input: FinalizeInput): ReportData {
  const globalFailure = (input.exitCode !== undefined && input.exitCode !== 0)
    || (input.status !== undefined && input.status !== 'passed') || Boolean(input.errors?.length);
  const cases: ReportCase[] = [];
  const tests = input.tests.length ? input.tests : [{ id: input.run.id, name: input.title ?? '回放未执行', status: 'skipped' as const }];
  for (const test of tests) {
    const receipt = test.run ?? input.run;
    const failed = test.status === 'failed' || test.status === 'timedOut' || test.status === 'interrupted' || Boolean(test.errors?.length);
    const executionResult: ReportRun['status'] = failed ? 'FAIL' : test.status === 'passed' ? 'PASS' : 'BLOCKED';
    const invalid = test.reportError ?? (test.report === undefined ? '本次测试没有 ir-report 附件' : attachmentError(test.report, receipt.id));
    const attachmentFailed = record(test.report) && (test.report.result === 'FAIL'
      || (Array.isArray(test.report.cases) && test.report.cases.some(item => record(item) && item.result === 'FAIL')));
    const reportCases: ReportCase[] = invalid ? [{
      id: test.id, name: test.name, result: attachmentFailed ? 'FAIL' : 'BLOCKED', steps: [], events: [], images: [],
    }] : (test.report as ReportData).cases.map(reportCase => ({
      ...reportCase, steps: reportCase.steps.map(step => ({ ...step })),
      events: reportCase.events!.map(event => ({ ...event })), images: reportCase.images!.map(image => ({ ...image })),
    }));
    for (const reportCase of reportCases) {
      const attachedRun = reportCase.run;
      const run: ReportRun = {
        ...attachedRun,
        ...Object.fromEntries(Object.entries(receipt).filter(([, value]) => value !== undefined)),
        id: receipt.id, mode: 'replay', status: 'BLOCKED',
        toolVersion: receipt.toolVersion || attachedRun?.toolVersion || '', env: receipt.env,
      };
      run.authSource = test.environment?.auth_source ?? attachedRun?.authSource ?? receipt.authSource;
      run.browserSource = test.environment?.browser_source ?? attachedRun?.browserSource ?? receipt.browserSource;
      run.browserVersion = test.environment?.browser_version ?? attachedRun?.browserVersion ?? receipt.browserVersion;
      if (test.startedAt !== undefined) run.startedAt = test.startedAt;
      if (test.endedAt !== undefined) run.endedAt = test.endedAt;
      const eventFailure = reportCase.events?.some(event => event.type !== 'screenshot' && (event.status === 'fail' || event.status === 'error'));
      const evidenceFailure = reportCase.events?.some(event => event.type === 'screenshot' && event.status === 'error');
      const stepFailure = reportCase.steps.some(step => step.status === 'fail');
      run.status = stricterResult(executionResult, globalFailure || eventFailure || stepFailure ? 'FAIL' : 'PASS',
        attachedRun?.status ?? 'PASS');
      reportCase.run = run;
      reportCase.sessionResult = run.status;
      reportCase.result = stricterResult(reportCase.result, run.status, attachmentFailed ? 'FAIL' : 'PASS', invalid || evidenceFailure || input.blockedErrors?.length || test.blockedErrors?.length ? 'BLOCKED' : 'PASS');
      reportCase.duration = test.durationMs === undefined ? reportCase.duration : `${test.durationMs}ms`;
      delete reportCase.acceptance;
      delete reportCase.acceptanceCoverage;
      if (input.acceptance) {
        reportCase.acceptance = input.acceptance;
        bindAcceptance(reportCase.events ?? [], input.acceptance);
        reportCase.acceptanceCoverage = computeAcceptanceCoverage(input.acceptance.document, reportCase.events ?? []);
        reportCase.result = stricterResult(reportCase.result,
          reportCase.acceptanceCoverage.result === 'FAIL' ? 'FAIL' : reportCase.acceptanceCoverage.result === 'UNVERIFIED' ? 'BLOCKED' : 'PASS');
        reportCase.coverage = {
          plan: input.acceptance.document.scenarios.map(scenario => scenario.id),
          executed: reportCase.acceptanceCoverage.scenarios.filter(scenario => scenario.result !== 'UNVERIFIED').map(scenario => scenario.id),
          missing: reportCase.acceptanceCoverage.scenarios.filter(scenario => scenario.result === 'UNVERIFIED').map(scenario => scenario.id),
          unplanned: [...new Set((reportCase.events ?? []).flatMap(event => event.group ? [event.group] : []))]
            .filter(group => !input.acceptance!.document.scenarios.some(scenario => scenario.id === group)),
        };
      }
      const errors = [...(test.errors ?? []), ...(input.errors ?? [])];
      if (globalFailure && !errors.length) errors.push({ code: 'PLAYWRIGHT_FAILED', message: `Playwright 最终状态 ${input.status ?? '未提供'}；退出码 ${input.exitCode ?? '未提供'}` });
      for (const error of errors) addError(reportCase, error, true);
      if (invalid) addError(reportCase, { code: 'IR_REPORT_UNAVAILABLE', message: invalid }, false);
      if (!input.tests.length) addError(reportCase, { code: 'NO_TESTS', message: 'Playwright 最终测试列表为 0；没有动作执行证据' }, false);
      for (const error of [...(input.blockedErrors ?? []), ...(test.blockedErrors ?? [])]) addError(reportCase, error, false);
      run.errors = [...(attachedRun?.errors ?? []), ...errors];
      if (!run.errors.length) delete run.errors;
      const counts = reportCase.acceptanceCoverage;
      reportCase.summary = `执行 ${run.status}；报告 ${reportCase.result}；`
        + (counts ? `验收 ${counts.bound}/${counts.total} 项绑定，${counts.result}` : '未提供验收说明，仅代表本次执行，不证明需求覆盖');
      cases.push(reportCase);
    }
  }
  const result = stricterResult(...cases.map(reportCase => reportCase.result));
  return projectReportFacts({
    report_schema_version: 2,
    title: input.title ?? 'E2E 回放报告', url: input.url ?? '', env: input.run.env, result,
    summary: `${cases.filter(reportCase => reportCase.result === 'PASS').length}/${cases.length} 用例通过；报告 ${result}`,
    sessionId: input.run.id, toolVersion: input.run.toolVersion,
    mocked: input.tests.some(test => record(test.report) && test.report.mocked === true), cases,
    ...(input.links ? { links: input.links } : {}),
  });
}
