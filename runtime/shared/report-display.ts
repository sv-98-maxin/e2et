import type { ReportData } from './report-model.js';
import { projectReportValue } from './acceptance.js';

function safeFields<T extends object>(record: T, keys: readonly (keyof T)[]): T {
  const copy = { ...record };
  for (const key of keys) {
    if (Object.hasOwn(record, key)) copy[key] = projectReportValue(record[key]).value as T[keyof T];
  }
  return copy;
}

export function displayData(data: ReportData): ReportData {
  const displayStep = (step: ReportData['cases'][number]['steps'][number], hasImages: boolean) => {
    const safe = safeFields(step, ['action', 'observation', 'assertions', 'captures', 'apis', 'api',
      'evidence', 'executeResult', 'assertDetails', 'screenshotNotice']);
    if (hasImages) { delete safe.screenshot; delete safe.screenshots; }
    return safe;
  };
  return {
    ...safeFields(data, ['title', 'url', 'summary', 'findings', 'links']),
    cases: data.cases.map(testCase => ({
      ...safeFields(testCase, ['name', 'summary', 'url', 'findings', 'backendInfo', 'uiChecks', 'fixes', 'recording',
        'diagnostic_assertions', 'diagnostic_observations', 'diagnostic_events']),
      steps: testCase.steps.map(step => displayStep(step, data.report_schema_version === 2 && Boolean(testCase.images))),
      appendix: testCase.appendix?.map(step => displayStep(step, data.report_schema_version === 2 && Boolean(testCase.images))),
      flow: testCase.flow && {
        startedAt: testCase.flow.startedAt,
        endedAt: testCase.flow.endedAt,
        frames: testCase.flow.frames.map(frame => ({
          src: frame.src,
          startedAt: frame.startedAt,
          ...(frame.label ? { label: frame.label } : {}),
        })),
      },
      events: testCase.events?.map(event => {
        const keys = ['intent', 'target', 'args', 'input', 'valueSource', 'expect', 'resolvedExpected',
          'actual', 'evidence', 'frame', 'error'] as const;
        return { ...safeFields(event, keys), redacted: event.redacted || keys.some(key =>
          Object.hasOwn(event, key) && projectReportValue(event[key]).redacted) };
      }),
      images: testCase.images?.map(image => safeFields(image, ['label'])),
      run: testCase.run && safeFields(testCase.run, ['errors']),
      acceptance: testCase.acceptance && {
        ...testCase.acceptance,
        document: { ...testCase.acceptance.document, scenarios: testCase.acceptance.document.scenarios.map(scenario => ({
          ...safeFields(scenario, ['goal', 'source', 'preconditions', 'actions']),
          checks: scenario.checks.map(check => safeFields(check, ['expectation'])),
        })) },
      },
      acceptanceCoverage: testCase.acceptanceCoverage && {
        ...testCase.acceptanceCoverage,
        scenarios: testCase.acceptanceCoverage.scenarios.map(scenario => ({
          ...safeFields(scenario, ['goal']), checks: scenario.checks.map(check => safeFields(check, ['expectation'])),
        })),
      },
    })),
  };
}
