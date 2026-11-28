import type { AcceptanceSnapshot } from './acceptance.js';

export type { AcceptanceDocument, AcceptanceSnapshot } from './acceptance.js';

export interface AcceptanceCheckCoverage {
  id: string;
  expectation: string;
  status: 'pass' | 'fail' | 'error' | 'not_run' | 'unbound';
  eventIds: string[];
}

export interface AcceptanceScenarioCoverage {
  id: string;
  goal: string;
  checks: AcceptanceCheckCoverage[];
  result: 'PASS' | 'FAIL' | 'UNVERIFIED';
}

export interface AcceptanceCoverage {
  scenarios: AcceptanceScenarioCoverage[];
  result: 'PASS' | 'FAIL' | 'UNVERIFIED';
  bound: number;
  total: number;
}

export interface ReportStepApi {
  reqId?: string;
  reqBodyRef?: string;
  respBodyRef?: string;
  method: string;
  url: string;
  status: string;
  reqBody?: string;
  respBody?: string;
  respHeaders?: string;
  traceId?: string;
  path?: string;
  nav?: string;
  callIndex?: number;
  time?: string;
}

export interface ReportStep {
  sourceStatus?: ReportStep['status'];
  group?: string;
  assertions?: Record<string, unknown>[];
  captures?: Record<string, unknown>[];
  actionIds?: string[];
  eventIds?: string[];
  screenshotPath?: string;
  screenshotAfter?: string;
  index: number;
  status: 'pass' | 'fail' | 'blocked';
  action: string;
  observation: string;
  duration: string;
  apis?: ReportStepApi[];
  api?: ReportStepApi;
  evidence?: string;
  screenshot?: string;
  screenshots?: Array<{ src: string; label?: string }>;
  screenshotNotice?: string;
  executeResult?: { json: string; truncated?: boolean };
  assertDetails?: string[];
}

export interface ReportUiChecks {
  summary: string;
  items?: Array<{ description: string; status: string; fixed?: boolean; screenshot?: string }>;
  interactions?: Array<{ expect: string; actual: string; status: string }>;
}

export interface ReportFix {
  problem: string;
  change: string;
  reverify: string;
  screenshot?: string;
}

export interface ReportBackendInfo {
  api: string;
  traceId: string;
  time: string;
  failure?: string;
  response: string;
  params: string;
  analysis?: string;
}

export interface ReportEvent {
  id: string;
  sequence: number;
  type: 'action' | 'assert' | 'capture' | 'screenshot' | 'observation' | 'error';
  kind: string;
  status: 'pass' | 'fail' | 'error' | 'not_run';
  group?: string;
  actionId?: string;
  checkId?: string;
  intent?: string;
  startedAt?: number;
  endedAt?: number;
  executed?: boolean;
  target?: unknown;
  args?: unknown;
  input?: unknown;
  valueSource?: unknown;
  expect?: unknown;
  resolvedExpected?: unknown;
  actual?: unknown;
  evidence?: unknown;
  frame?: unknown;
  actualStatus?: 'present' | 'missing' | 'unavailable' | 'not_collected';
  error?: { code?: string; message: string };
  imageId?: string;
  redacted?: boolean;
  truncated?: boolean;
}

export interface ReportImage {
  id: string;
  eventId: string;
  actionId?: string;
  sequence: number;
  src: string;
  phase?: 'after_action' | 'after_checks';
  startedAt?: number;
  endedAt?: number;
  width?: number;
  height?: number;
  label?: string;
}

export interface ReportFlowFrame {
  src: string;
  startedAt: number;
  label?: string;
}

export interface ReportFlow {
  startedAt: number;
  endedAt: number;
  frames: ReportFlowFrame[];
}

export interface ReportRun {
  id: string;
  mode: 'source' | 'replay';
  status: 'PASS' | 'FAIL' | 'BLOCKED';
  startedAt?: number;
  endedAt?: number;
  toolVersion: string;
  cliSha256?: string;
  runtimeSha256?: string;
  browserSource?: string;
  authSource?: string;
  browserVersion?: string;
  env: string;
  errors?: Array<{ code?: string; message: string }>;
}

export interface ReportCase {
  id: string;
  name: string;
  result: 'PASS' | 'FAIL' | 'BLOCKED';
  steps: ReportStep[];
  duration?: string;
  summary?: string;
  appendix?: ReportStep[];
  uiChecks?: ReportUiChecks;
  fixes?: ReportFix[];
  findings?: string[];
  backendInfo?: ReportBackendInfo;
  url?: string;
  env?: string;
  toolVersion?: string;
  sessionId?: string;
  coverage?: ReportCoverage;
  sourceResult?: ReportCase['result'];
  sessionResult?: ReportCase['result'];
  source?: { caseId: string; report: string; result: ReportCase['result']; sessionResult?: string; metaResult?: string; metaMissing: boolean };
  diagnostic_assertions?: Record<string, unknown>[];
  diagnostic_observations?: Record<string, unknown>[];
  diagnostic_events?: Record<string, unknown>[];
  events?: ReportEvent[];
  images?: ReportImage[];
  flow?: ReportFlow;
  run?: ReportRun;
  recording?: Record<string, unknown>;
  acceptance?: AcceptanceSnapshot;
  acceptanceCoverage?: AcceptanceCoverage;
}

export interface ReportCoverage {
  plan: string[] | null;
  executed: string[];
  missing: string[];
  unplanned: string[];
}

export interface ReportData {
  report_schema_version: 2;
  title: string;
  url: string;
  env: string;
  result: 'PASS' | 'FAIL' | 'BLOCKED';
  summary: string;
  sessionId: string;
  toolVersion: string;
  mocked: boolean;
  cases: ReportCase[];
  coverage?: ReportCoverage;
  findings?: string[];
  links?: Array<{ label: string; url: string }>;
}
