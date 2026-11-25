/**
 * report-render.ts — 自包含 HTML 报告渲染器。
 *
 * 从 handleReport 组装的结构化数据生成单个 HTML 文件：
 * - CSS/JS 全部内联，不引用外部 CDN
 * - 深浅主题自适应（prefers-color-scheme）
 * - 每步时间线（action/observation/api 截图）
 * - API 面板（method + path + 状态码 + focused 字段 + 证据默认折叠）
 * - 截图 base64 内嵌 + 点击放大（lightbox）
 */

import { jsonPath } from './assertion.js';

// ── 类型 ──

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
  /** 路径 + nav + call_index（精确引用来源，核验用）。 */
  path?: string;
  nav?: string;
  callIndex?: number;
  /** 请求开始时间 ISO（backendInfo 用）。 */
  time?: string;
}

export interface ReportStep {
  sourceStatus?: ReportStep['status'];
  group?: string;
  assertions?: Record<string, unknown>[];
  captures?: Record<string, unknown>[];
  actionIds?: string[];
  screenshotPath?: string;
  screenshotAfter?: string;
  index: number;
  status: 'pass' | 'fail' | 'blocked';
  action: string;
  observation: string;
  duration: string;
  /** 多个显式引用接口（C2 finding 7）。旧 api 字段保留兼容。 */
  apis?: ReportStepApi[];
  api?: ReportStepApi;
  /** 非结构化网络证据，仅在没填 api 时降级渲染。 */
  evidence?: string;
  screenshot?: string; // base64 data URI
  screenshotNotice?: string;
  /** execute 返回证据（pretty JSON，HTML 转义由渲染器负责）。 */
  executeResult?: { json: string; truncated?: boolean };
  /** assert 期望/实际明细，折叠显示。observation 优先展示 capture 值（业务实际值）。 */
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

export interface ReportCase {
  id: string;
  name: string;
  result: 'PASS' | 'FAIL' | 'BLOCKED';
  steps: ReportStep[];
  /** 用例总耗时（多用例卡片展示）。 */
  duration?: string;
  /** 用例一句话结论。 */
  summary?: string;
  /** 没带 --group 的探查动作，默认折叠，不计入结论与通过率。 */
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
}

export interface ReportCoverage {
  plan: string[] | null;
  executed: string[];
  missing: string[];
  unplanned: string[];
}

export interface ReportData {
  title: string;
  url: string;
  env: string;
  result: 'PASS' | 'FAIL' | 'BLOCKED';
  summary: string;
  sessionId: string;
  toolVersion: string;
  mocked: boolean;
  cases: ReportCase[];
  /** 需求级覆盖边界；runtime replay 没有外部计划时固定为 plan: null。 */
  coverage?: ReportCoverage;
  /** 顶层发现列表（来自 --findings），旧格式兼容。 */
  findings?: string[];
  /** 附加链接（trace/详情入口），CLI 不传。 */
  links?: Array<{ label: string; url: string }>;
}

// ── helpers ──

function assertionRefsApi(assertion: Record<string, unknown>, api: ReportStepApi): boolean {
  const evidence = Array.isArray(assertion.evidence) ? assertion.evidence : [];
  if (api.reqId && evidence.some((item) => item && typeof item === 'object' && (item as Record<string, unknown>).req_id === api.reqId)) return true;
  const expect = assertion.expect && typeof assertion.expect === 'object'
    ? assertion.expect as Record<string, unknown>
    : undefined;
  const ref = expect?.req && typeof expect.req === 'object' ? expect.req as Record<string, unknown> : undefined;
  return Boolean(ref
    && typeof ref.path === 'string'
    && typeof ref.nav === 'string'
    && ref.call_index !== undefined
    && ref.path === api.path
    && ref.nav === api.nav
    && Number(ref.call_index) === api.callIndex);
}

/** 只提取明确属于该请求的断言字段；来源缺失或错配时不猜。 */
function extractFocusedPaths(step: ReportStep, api: ReportStepApi, kind: 'api' | 'request', body: string | undefined): Map<string, unknown> | null {
  const assertions = step.assertions;
  if (!assertions?.length || !body) return null;
  const paths = assertions
    .filter((assertion) => assertion.kind === kind && assertionRefsApi(assertion, api))
    .flatMap((assertion) => {
      const expect = assertion.expect && typeof assertion.expect === 'object'
        ? assertion.expect as Record<string, unknown>
        : undefined;
      return typeof expect?.path === 'string' && expect.path ? [expect.path] : [];
    });
  if (!paths.length) return null;
  let respObj: unknown;
  try { respObj = JSON.parse(body); } catch { return null; }
  const focused = new Map<string, unknown>();
  for (const p of paths) {
    const val = jsonPath(respObj, p);
    if (val !== undefined) focused.set(p, val);
  }
  return focused.size > 0 ? focused : null;
}

/** 递归渲染 JSON 值：基础类型内联，对象/数组用嵌套 details 折叠。 */
function renderFocusedValue(val: unknown, indent = 0, fullTree = false): string {
  if (val === null) return '<span class="api-tree-null">null</span>';
  if (val === undefined) return '<span class="api-tree-null">undefined</span>';
  if (typeof val === 'string') return `<span class="api-tree-str">${esc(JSON.stringify(val))}</span>`;
  if (typeof val === 'number' || typeof val === 'boolean') return `<span class="api-tree-${typeof val}">${esc(String(val))}</span>`;
  if (Array.isArray(val)) {
    if (val.length === 0) return '<span class="api-tree-null">[]</span>';
    const items = val.map((v, i) => {
      const comma = i < val.length - 1 ? '<span class="api-tree-comma">,</span>' : '';
      return `<div class="api-tree-indent">${renderFocusedValue(v, indent + 1, fullTree)}${comma}</div>`;
    }).join('');
    return `<details${fullTree && indent === 0 ? ' open' : ''}><summary class="api-tree-summary">[${val.length} 项]</summary>${items}</details>`;
  }
  if (typeof val === 'object') {
    const entries = Object.entries(val as Record<string, unknown>);
    if (entries.length === 0) return '<span class="api-tree-null">{}</span>';
    const keys = entries.map(([k]) => k).join(', ');
    const rows = entries.map(([k, v], i) => {
      const comma = i < entries.length - 1 ? '<span class="api-tree-comma">,</span>' : '';
      const key = fullTree ? JSON.stringify(k) : k;
      return `<div class="api-tree-indent"><span class="api-focused-key">${esc(key)}: </span>${renderFocusedValue(v, indent + 1, fullTree)}${comma}</div>`;
    }).join('');
    const summary = fullTree ? `{…} · ${entries.length}项` : `{${esc(keys)}}`;
    return `<details${fullTree && indent === 0 ? ' open' : ''}><summary class="api-tree-summary">${summary}</summary>${rows}</details>`;
  }
  return esc(String(val));
}

const esc = (s: string): string =>
  String(s ?? '').replace(/[&<>"']/g, (c: string) => (({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  } as Record<string, string>)[c] ?? c));

function now(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function effectiveCoverage(data: Pick<ReportData, 'coverage'>, steps: ReportStep[]): ReportCoverage {
  return data.coverage ?? {
    plan: null,
    executed: [...new Set(steps.map(step => step.action).filter(Boolean))],
    missing: [],
    unplanned: [],
  };
}

function coverageNames(names: string[]): string {
  if (!names.length) return '<span class="coverage-empty">无</span>';
  return `<span class="coverage-names">${names.map(name => `<span>${esc(name)}</span>`).join('')}</span>`;
}

function coverageSection(data: Pick<ReportData, 'coverage'>, steps: ReportStep[]): string {
  const coverage = effectiveCoverage(data, steps);
  if (coverage.plan === null) {
    return `<section class="coverage-section">
    <h2>验证范围与边界</h2>
    <div class="coverage-boundary"><b>未提供覆盖计划</b><span>仅代表已执行断言，不能证明完整需求覆盖。</span></div>
    <div class="coverage-grid compact">
      <div class="coverage-cell"><span class="coverage-label">实际执行</span><strong>${coverage.executed.length} 个业务场景</strong>${coverageNames(coverage.executed)}</div>
    </div>
  </section>`;
  }
  const cells: Array<{ label: string; names: string[]; warning?: boolean }> = [
    { label: '计划范围', names: coverage.plan },
    { label: '实际执行', names: coverage.executed },
    { label: '缺失', names: coverage.missing, warning: coverage.missing.length > 0 },
    { label: '计划外', names: coverage.unplanned, warning: coverage.unplanned.length > 0 },
  ];
  return `<section class="coverage-section">
    <h2>验证范围与边界</h2>
    <div class="coverage-grid">${cells.map(cell =>
      `<div class="coverage-cell${cell.warning ? ' warning' : ''}"><span class="coverage-label">${cell.label}</span><strong>${cell.names.length} 项</strong>${coverageNames(cell.names)}</div>`,
    ).join('')}</div>
  </section>`;
}

function riskAlerts(data: ReportData, steps: ReportStep[]): string {
  const coverage = effectiveCoverage(data, steps);
  const risks: string[] = [];
  if (data.mocked) risks.push('Mock 结果不可作为真实后端落库依据');
  const blocked = [...new Set(steps.filter(step => step.status === 'blocked').map(step => step.action))];
  if (blocked.length) risks.push(`存在 ${blocked.length} 个阻塞业务步骤：${blocked.join('、')}`);
  if (coverage.plan !== null && coverage.missing.length) {
    risks.push(`覆盖计划缺失 ${coverage.missing.length} 项：${coverage.missing.join('、')}`);
  }
  return risks.length
    ? `<ul class="risk-list" aria-label="风险提示">${risks.map(risk => `<li>${esc(risk)}</li>`).join('')}</ul>`
    : '';
}

// ── CSS ──

function css(): string {
  return `
:root {
  --bg: #fafafa; --card: #ffffff; --card-2: #f5f5f5;
  --border: #ebebeb; --border-strong: #e0e0e0;
  --text: #171717; --muted: #666666; --subtle: #8f8f8f;
  --accent: #5e6ad2; --accent-soft: #edeffc;
  --pass: #14804a; --pass-soft: #e3f6ec; --pass-line: #b8e6cc;
  --fail: #d1242f; --fail-soft: #ffebe9; --fail-line: #ffc9c4;
  --warn: #9a6700; --warn-soft: #fff8e6; --warn-line: #f5e2a8;
  --blocked: #6b7280; --blocked-soft: #f0f1f3; --blocked-line: #dfe1e6;
  --code-bg: #f6f8fa;
  --shadow-sm: 0 1px 2px rgba(0,0,0,.04);
  --shadow-md: 0 1px 3px rgba(0,0,0,.06), 0 8px 24px rgba(0,0,0,.04);
  --shadow-lg: 0 16px 48px rgba(0,0,0,.16);
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #08090a; --card: #0f1011; --card-2: #141516;
    --border: #23252a; --border-strong: #34343a;
    --text: #f7f8f8; --muted: #a0a4ab; --subtle: #737780;
    --accent: #828fff; --accent-soft: #1b1d2e;
    --pass: #3fb950; --pass-soft: #12261a; --pass-line: #1f3d29;
    --fail: #ff6b64; --fail-soft: #2b1517; --fail-line: #46201f;
    --warn: #e3b341; --warn-soft: #2a2113; --warn-line: #453a1c;
    --blocked: #8b949e; --blocked-soft: #1a1c20; --blocked-line: #2a2d33;
    --code-bg: #0b0d0f;
    --shadow-sm: 0 1px 2px rgba(0,0,0,.4);
    --shadow-md: 0 1px 3px rgba(0,0,0,.5), 0 8px 24px rgba(0,0,0,.35);
    --shadow-lg: 0 16px 48px rgba(0,0,0,.6);
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  line-height: 1.55; font-size: 14px; -webkit-font-smoothing: antialiased; }
.wrap { max-width: 1080px; margin: 0 auto; padding: 32px 20px 96px; }

/* header */
header { position: relative; background: var(--card); border: 1px solid var(--border);
  border-radius: 16px; padding: 28px 28px 24px; margin-bottom: 16px;
  box-shadow: var(--shadow-md); overflow: hidden; }
header::before { content: ""; position: absolute; inset: 0 0 auto 0; height: 3px;
  background: linear-gradient(90deg, var(--accent), #8b5cf6 55%, #ec4899); }
h1 { margin: 6px 0 10px; font-size: 24px; font-weight: 650; letter-spacing: -.5px; line-height: 1.2; }
.meta { color: var(--muted); font-size: 13px; margin: 3px 0; }
.meta::before { content: ""; display: inline-block; width: 5px; height: 5px; border-radius: 50%;
  background: var(--border-strong); margin-right: 8px; vertical-align: middle; }
.badge { display: inline-flex; align-items: center; gap: 6px; padding: 5px 13px 5px 11px;
  border-radius: 999px; font-weight: 650; font-size: 12.5px; letter-spacing: .3px; border: 1px solid transparent; }
.badge::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
.badge.pass { background: var(--pass-soft); color: var(--pass); border-color: var(--pass-line); }
.badge.fail { background: var(--fail-soft); color: var(--fail); border-color: var(--fail-line); }
.badge.blocked { background: var(--blocked-soft); color: var(--blocked); border-color: var(--blocked-line); }
.summary { margin: 14px 0 0; color: var(--muted); font-size: 13.5px; line-height: 1.6; }

/* section */
section { background: var(--card); border: 1px solid var(--border);
  border-radius: 14px; padding: 22px 26px; margin-bottom: 16px; box-shadow: var(--shadow-sm); }
h2 { margin: 0 0 18px; font-size: 15px; font-weight: 650; letter-spacing: -.2px;
  display: flex; align-items: center; gap: 9px; }
h2::before { content: ""; width: 3px; height: 15px; border-radius: 2px; background: var(--accent); }

/* header details */
.header-info { margin-top: 14px; border: 1px solid var(--border); border-radius: 9px; overflow: hidden; }
.summary-stats { display: flex; gap: 14px; flex-wrap: wrap; margin: 10px 0 0; color: var(--subtle); font-size: 12px; }
.summary-stats b { color: var(--text); font-size: 13px; margin-left: 3px; }
.summary-stats b.pass { color: var(--pass); }
.summary-stats b.fail { color: var(--fail); }
.summary-stats b.blocked { color: var(--blocked); }
.risk-list { display: grid; gap: 6px; margin: 14px 0 0; padding: 0; list-style: none; }
.risk-list li { padding: 8px 11px; border: 1px solid var(--warn-line); border-radius: 8px;
  background: var(--warn-soft); color: var(--warn); font-size: 12.5px; font-weight: 600; }

/* coverage */
.coverage-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
.coverage-grid.compact { grid-template-columns: minmax(0, 1fr); }
.coverage-cell { min-width: 0; padding: 12px 14px; border: 1px solid var(--border); border-radius: 10px;
  background: var(--card-2); }
.coverage-cell.warning { border-color: var(--warn-line); background: var(--warn-soft); }
.coverage-label { display: block; color: var(--subtle); font-size: 11px; font-weight: 650; }
.coverage-cell strong { display: block; margin-top: 4px; font-size: 13.5px; }
.coverage-cell.warning strong { color: var(--warn); }
.coverage-names { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 7px; }
.coverage-names span { padding: 2px 7px; border: 1px solid var(--border); border-radius: 5px;
  background: var(--card); color: var(--muted); font-size: 11.5px; }
.coverage-empty { display: block; margin-top: 6px; color: var(--subtle); font-size: 12px; }
.coverage-boundary { display: flex; gap: 10px; align-items: baseline; padding: 11px 13px;
  border: 1px solid var(--warn-line); border-radius: 9px; background: var(--warn-soft);
  color: var(--muted); font-size: 12.5px; }
.coverage-boundary b { color: var(--warn); white-space: nowrap; }
@media (max-width: 760px) { .coverage-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 480px) { .coverage-grid { grid-template-columns: 1fr; } .coverage-boundary { display: block; } }

/* step timeline */
.step { position: relative; border-left: 2px solid var(--border); padding: 4px 0 18px 20px; }
.step:last-child { padding-bottom: 2px; }
.step::before { content: ""; position: absolute; left: -6px; top: 6px; width: 10px; height: 10px;
  border-radius: 50%; background: var(--card); border: 2px solid var(--border); }
.step.pass { border-left-color: var(--pass-line); }
.step.pass::before { border-color: var(--pass); background: var(--pass); }
.step.fail { border-left-color: var(--fail-line); }
.step.fail::before { border-color: var(--fail); background: var(--fail); }
.step.blocked { border-left-color: var(--blocked-line); }
.step.blocked::before { border-color: var(--blocked); }
.step-head { display: flex; align-items: baseline; gap: 8px; }
.step-no { font-family: var(--mono); font-size: 11px; color: var(--subtle); flex-shrink: 0; }
.ico { font-size: 13px; line-height: 1; }
.step-action { font-weight: 600; font-size: 13.5px; }
.step-obs { color: var(--muted); margin: 6px 0 0; font-size: 13px; line-height: 1.6; }
.assert-list { margin: 4px 0 0 16px; padding: 0; list-style: disc; color: var(--muted); line-height: 1.6; font-size: 12px; }
.assert-table-wrap { margin: 10px 0 0; border: 1px solid var(--border); border-radius: 10px;
  overflow-x: auto; background: var(--card); }
.assert-table { width: 100%; min-width: 720px; border-collapse: collapse; font-size: 12.5px; }
.assert-table th, .assert-table td { padding: 9px 11px; text-align: left; vertical-align: top;
  border-bottom: 1px solid var(--border); }
.assert-table th { background: var(--card-2); color: var(--subtle); font-size: 11px; font-weight: 650;
  letter-spacing: .35px; white-space: nowrap; }
.assert-table tbody tr:last-child td { border-bottom: none; }
.assert-table td { word-break: break-word; overflow-wrap: anywhere; white-space: pre-wrap; }
.assert-table .assert-row-fail td { background: var(--fail-soft); box-shadow: inset 0 1px 0 var(--fail-line); }
.assert-table .assert-row-fail td:first-child { box-shadow: inset 3px 0 0 var(--fail), inset 0 1px 0 var(--fail-line); }
.assert-result-pass { color: var(--pass); font-weight: 650; }
.assert-result-fail { color: var(--fail); font-weight: 700; }
.raw-evidence .evidence { margin: 8px 0 0; max-height: 320px; overflow: auto; }
.raw-evidence-label { margin-top: 8px; color: var(--subtle); font-size: 11px; font-weight: 600; }
.step-dur { margin-left: auto; color: var(--subtle); font-size: 11px; font-family: var(--mono);
  background: var(--card-2); border: 1px solid var(--border); padding: 2px 8px; border-radius: 6px; white-space: nowrap; }

/* API panel */
.api-panel { margin: 12px 0 0; border: 1px solid var(--border); border-radius: 10px; overflow: hidden; background: var(--card); }
.api-line { display: flex; align-items: center; gap: 8px; padding: 10px 14px; background: var(--card-2); flex-wrap: wrap; }
.method { font-weight: 700; font-size: 10.5px; padding: 3px 8px; border-radius: 5px;
  background: var(--accent); color: #fff; letter-spacing: .5px; }
.api-url { font-family: var(--mono); font-size: 12px; word-break: break-all; flex: 1; min-width: 0; }
.code-tag { font-size: 10.5px; font-weight: 700; padding: 3px 9px; border-radius: 5px; border: 1px solid transparent; }
.code-tag.code-ok { background: var(--pass-soft); color: var(--pass); border-color: var(--pass-line); }
.code-tag.code-warn { background: var(--warn-soft); color: var(--warn); border-color: var(--warn-line); }
.code-tag.code-err { background: var(--fail-soft); color: var(--fail); border-color: var(--fail-line); }
.trace-box { display: flex; align-items: center; gap: 10px; padding: 9px 14px; flex-wrap: wrap;
  background: var(--fail-soft); border-top: 1px solid var(--fail-line); }
.trace-box.warn { background: var(--warn-soft); border-top-color: var(--warn-line); }
.trace-label { font-size: 10px; font-weight: 700; color: var(--fail); letter-spacing: .5px;
  border: 1px solid var(--fail-line); padding: 2px 7px; border-radius: 5px; background: var(--card); }
.trace-box.warn .trace-label { color: var(--warn); border-color: var(--warn-line); }
.trace-id { font-family: var(--mono); font-size: 12.5px; color: var(--fail); font-weight: 600;
  user-select: all; word-break: break-all; cursor: text; }
.trace-box.warn .trace-id { color: var(--warn); }
.trace-copy { margin-left: auto; font: inherit; font-size: 11px; cursor: pointer; padding: 3px 11px;
  border-radius: 6px; border: 1px solid var(--border-strong); background: var(--card); color: var(--muted);
  white-space: nowrap; transition: .12s; }
.trace-copy:hover { color: var(--text); border-color: var(--subtle); }
.trace-copy.ok { color: var(--pass); border-color: var(--pass-line); background: var(--pass-soft); }
.trace-copy.err { color: var(--warn); border-color: var(--warn-line); background: var(--warn-soft); }
.api-bodies { display: grid; grid-template-columns: 1fr 1fr; }
.api-bodies.single { grid-template-columns: 1fr; }
@media (max-width: 640px) { .api-bodies { grid-template-columns: 1fr; } }
.api-body { border-top: 1px solid var(--border); min-width: 0; }
.api-body + .api-body { border-left: 1px solid var(--border); }
@media (max-width: 640px) { .api-body + .api-body { border-left: none; } }
.api-body-cap { font-size: 10.5px; color: var(--subtle); padding: 8px 14px 0; font-weight: 600;
  text-transform: uppercase; letter-spacing: .5px; }
.api-body .evidence { margin: 8px; }
.headers { border-top: 1px solid var(--border); }
.headers > summary { cursor: pointer; padding: 8px 14px; font-size: 10.5px; font-weight: 600; color: var(--subtle);
  text-transform: uppercase; letter-spacing: .5px; list-style: none; display: flex; align-items: center; gap: 8px; }
.headers > summary::-webkit-details-marker { display: none; }
.headers > summary::before { content: "\\25B8"; font-size: 9px; }
.headers[open] > summary::before { content: "\\25BE"; }
.headers > summary:hover { color: var(--text); }
.headers .hn { font-family: var(--mono); font-size: 10px; opacity: .7; }
.headers .evidence { margin: 0 8px 8px; }
.hl-trace { color: var(--fail); font-weight: 700; }
.evidence { background: var(--code-bg); padding: 12px 14px; border-radius: 8px; border: 1px solid var(--border);
  overflow-x: auto; font-size: 12px; font-family: var(--mono); line-height: 1.55;
  white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere; margin: 10px 0 0; }

/* screenshot */
.shot { max-width: 100%; display: block; border: 1px solid var(--border); border-radius: 10px;
  margin-top: 12px; cursor: zoom-in; box-shadow: var(--shadow-sm); }
.step.pass .shot { width: 100%; height: 480px; max-height: 480px; object-fit: cover; object-position: top; }
.shot-missing { background: var(--warn-soft); border: 1px solid var(--warn-line); padding: 10px 14px;
  border-radius: 8px; color: var(--warn); font-size: 12px; margin-top: 12px; }
.tech-evidence { margin-top: 12px; border: 1px solid var(--border); border-radius: 10px; background: var(--card); overflow: hidden; }
.tech-evidence > summary { padding: 9px 14px; background: var(--card-2); cursor: pointer; font-size: 12px; font-weight: 650; color: var(--muted); }
.tech-evidence-body { padding: 0 10px 10px; }
.tech-evidence-body .api-panel:first-child { margin-top: 10px; }
.tech-evidence-body .raw-evidence-label:first-child { margin-top: 10px; }

/* lightbox */
.lightbox { position: fixed; inset: 0; z-index: 60; background: rgba(0,0,0,.86);
  display: none; align-items: center; justify-content: center; padding: 32px; cursor: zoom-out; }
.lightbox.on { display: flex; }
.lightbox img { max-width: 100%; max-height: 100%; border-radius: 8px; }

/* uiChecks / fixes / findings / backendInfo */
h3 { margin: 22px 0 10px; font-size: 12px; font-weight: 600; color: var(--subtle); text-transform: uppercase; letter-spacing: .6px; }
h3:first-child { margin-top: 0; }
.ui-summary { color: var(--muted); font-size: 13.5px; margin: 0 0 12px; }
.plain-list { list-style: none; padding: 0; margin: 0; }
.plain-list li { padding: 9px 0; border-bottom: 1px solid var(--border); font-size: 13.5px; line-height: 1.6; }
.plain-list li:last-child { border-bottom: none; }
.tag { font-size: 10.5px; font-weight: 600; padding: 2px 8px; border-radius: 5px; border: 1px solid var(--border); background: var(--card-2); color: var(--muted); }
.tag.fixed { background: var(--accent-soft); color: var(--accent); border-color: var(--accent); }
.fix { margin: 0 0 12px; padding: 14px 16px; background: var(--card-2); border: 1px solid var(--border); border-left: 3px solid var(--accent); border-radius: 10px; }
.fix:last-child { margin-bottom: 0; }
.fix div { margin: 5px 0; font-size: 13.5px; line-height: 1.6; }
.fix b { color: var(--subtle); font-weight: 600; }
.find-list { padding-left: 0; list-style: none; margin: 0; }
.find-list li { margin: 8px 0; color: var(--muted); font-size: 13.5px; padding-left: 18px; position: relative; }
.find-list li::before { content: "→"; position: absolute; left: 0; color: var(--accent); font-weight: 700; }
.be-card { display: flex; flex-direction: column; border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
.be-row { display: grid; grid-template-columns: 84px 1fr; gap: 14px; padding: 11px 16px; }
.be-row + .be-row { border-top: 1px solid var(--border); }
.be-row:nth-child(even) { background: var(--card-2); }
.be-key { color: var(--subtle); font-size: 11.5px; font-weight: 600; padding-top: 1px; text-transform: uppercase; letter-spacing: .4px; }
.be-val { word-break: break-word; overflow-wrap: anywhere; font-size: 13px; line-height: 1.55; }
.be-val.be-trace { font-family: var(--mono); color: var(--fail); font-weight: 600; user-select: all; }
@media (max-width: 520px) { .be-row { grid-template-columns: 1fr; gap: 3px; } }

/* case list */
.toolbar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 16px; }
.chips { display: flex; gap: 6px; flex-wrap: wrap; }
.chip { font: inherit; font-size: 12.5px; cursor: pointer; padding: 6px 12px; border-radius: 999px; background: var(--card-2); border: 1px solid var(--border); color: var(--muted); display: inline-flex; align-items: center; gap: 6px; transition: .12s; }
.chip:hover { border-color: var(--border-strong); color: var(--text); }
.chip[aria-pressed="true"] { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); font-weight: 600; }
.chip .n { font-family: var(--mono); font-size: 11px; opacity: .75; }
.search { margin-left: auto; position: relative; }
.search input { font: inherit; font-size: 13px; width: 220px; max-width: 100%; padding: 7px 12px 7px 32px; border-radius: 9px; border: 1px solid var(--border); background: var(--card-2); color: var(--text); outline: none; }
.search input:focus { border-color: var(--accent); background: var(--card); }
.search svg { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); color: var(--subtle); }
.cases { display: flex; flex-direction: column; gap: 10px; }
.case { display: block; width: 100%; text-align: left; font: inherit; color: inherit; cursor: pointer; background: var(--card); border: 1px solid var(--border); border-left: 3px solid var(--border-strong); border-radius: 12px; padding: 14px 18px; box-shadow: var(--shadow-sm); transition: .14s; }
.case:hover { border-color: var(--border-strong); transform: translateY(-1px); box-shadow: var(--shadow-md); }
.case.pass { border-left-color: var(--pass); }
.case.fail { border-left-color: var(--fail); }
.case.blocked { border-left-color: var(--blocked); }
.case-top { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.case-id { font-family: var(--mono); font-size: 11.5px; font-weight: 650; color: var(--subtle); background: var(--card-2); border: 1px solid var(--border); padding: 2px 7px; border-radius: 5px; }
.case-name { font-weight: 600; font-size: 14.5px; }
.case-dur { margin-left: auto; font-family: var(--mono); font-size: 11px; color: var(--subtle); background: var(--card-2); border: 1px solid var(--border); padding: 2px 8px; border-radius: 6px; }
.case-sum { color: var(--muted); font-size: 13px; margin-top: 6px; }
.case-foot { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-top: 10px; }
.minibar { display: flex; gap: 2px; }
.minibar i { width: 14px; height: 5px; border-radius: 2px; background: var(--border-strong); }
.minibar i.pass { background: var(--pass); } .minibar i.fail { background: var(--fail); } .minibar i.blocked { background: var(--blocked); }
.case-count { font-size: 11.5px; color: var(--subtle); }
.case-more { margin-left: auto; font-size: 12px; color: var(--accent); font-weight: 600; }
.empty { padding: 40px 20px; text-align: center; color: var(--subtle); font-size: 13.5px; border: 1px dashed var(--border-strong); border-radius: 12px; }

/* drawer */
.backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.42); opacity: 0; pointer-events: none; transition: opacity .18s; z-index: 40; }
.backdrop.on { opacity: 1; pointer-events: auto; }
.drawer { position: fixed; top: 0; right: 0; bottom: 0; width: min(760px, 100%); z-index: 50; background: var(--bg); border-left: 1px solid var(--border); box-shadow: var(--shadow-lg); transform: translateX(100%); transition: transform .22s cubic-bezier(.32,.72,0,1); display: flex; flex-direction: column; }
.drawer.on { transform: none; }
.drawer-head { padding: 20px 24px 16px; border-bottom: 1px solid var(--border); background: var(--card); }
.drawer-head .row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.drawer-title { font-size: 18px; font-weight: 650; margin: 10px 0 0; }
.drawer-title::before { content: none; }
.drawer-body { overflow-y: auto; padding: 20px 24px 60px; flex: 1; }
.close { margin-left: auto; font: inherit; cursor: pointer; width: 30px; height: 30px; border-radius: 8px; border: 1px solid var(--border); background: var(--card-2); color: var(--muted); line-height: 1; font-size: 16px; }
.close:hover { color: var(--text); }

/* info grid */
.info-grid { display: grid; grid-template-columns: auto 1fr; gap: 6px 14px; font-size: 13px; margin-top: 12px; }
.info-key { color: var(--subtle); font-weight: 600; white-space: nowrap; }
.info-val { word-break: break-all; }

footer { text-align: center; color: var(--subtle); font-size: 11.5px; margin-top: 28px; }
.api-focused { margin: 8px 14px; }
.api-focused-row { display: flex; gap: 8px; padding: 4px 0; font-size: 12px; line-height: 1.5; border-bottom: 1px solid var(--border); }
.api-focused-row:last-child { border-bottom: none; }
.api-focused-key { font-family: var(--mono); color: var(--subtle); flex-shrink: 0; word-break: break-all; }
.api-focused-val { font-family: var(--mono); color: var(--text); word-break: break-word; overflow-wrap: anywhere; }
.api-tree-indent { margin-left: 16px; }
.api-tree-comma { color: var(--subtle); }
.api-tree-summary { cursor: pointer; font-family: var(--mono); font-size: 12px; color: var(--subtle); user-select: none; }
.api-tree-summary::-webkit-details-marker { display: none; }
.api-tree-summary::before { content: "\\25B8"; font-size: 9px; margin-right: 4px; }
details[open] > .api-tree-summary::before { content: "\\25BE"; }
.api-tree-str { color: var(--pass); }
.api-tree-number { color: var(--accent); }
.api-tree-boolean { color: var(--warn); }
.api-tree-null { color: var(--subtle); font-style: italic; }
.full-response { border-top: 1px solid var(--border); }
.full-response > summary { cursor: pointer; padding: 8px 14px; font-size: 10.5px; font-weight: 600; color: var(--subtle); text-transform: uppercase; letter-spacing: .5px; list-style: none; display: flex; align-items: center; gap: 8px; }
.full-response > summary::-webkit-details-marker { display: none; }
.full-response > summary::before { content: "\\25B8"; font-size: 9px; }
.full-response[open] > summary::before { content: "\\25BE"; }
.full-response > summary:hover { color: var(--text); }
.full-response .evidence { margin: 0 8px 8px; }
.json-response-tree { margin: 8px 14px; padding: 10px 12px; background: var(--code-bg);
  border: 1px solid var(--border); border-radius: 8px; overflow-x: auto;
  font-family: var(--mono); font-size: 12px; line-height: 1.55; }
.response-source { border-top: 1px solid var(--border); }
.response-source > summary { cursor: pointer; padding: 8px 14px; font-size: 10.5px; font-weight: 600;
  color: var(--subtle); letter-spacing: .5px; }
.response-source .evidence { margin: 0 8px 8px; }
`;
}

// ── JS ──

function js(isSingle: boolean): string {
  const base = `
const $ = id => document.getElementById(id);

/* copy traceId */
document.addEventListener('click', e => {
  const b = e.target.closest('.trace-copy'); if(!b)return;
  e.stopPropagation();
  const text = b.dataset.copy;
  const flash = (cls,msg) => { b.classList.add(cls); b.textContent=msg; setTimeout(()=>{b.classList.remove(cls);b.textContent='复制';},1500); };
  const selectFallback = () => {
    const code = b.parentElement.querySelector('.trace-id');
    const r = document.createRange(); r.selectNodeContents(code);
    const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
    flash('err','已选中 · ⌘C');
  };
  const legacy = () => {
    const ta = document.createElement('textarea'); ta.value=text; ta.style.cssText='position:fixed;opacity:0';
    document.body.appendChild(ta); ta.select();
    let ok=false; try{ok=document.execCommand('copy');}catch(_){}
    ta.remove(); ok ? flash('ok','已复制') : selectFallback();
  };
  if (navigator.clipboard&&navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(()=>flash('ok','已复制'),legacy);
  else legacy();
});

/* lightbox */
document.addEventListener('click', e => {
  const img = e.target.closest('.shot'); if(!img)return;
  e.stopPropagation();
  $('lightbox-img').src = img.src;
  $('lightbox').classList.add('on');
});
$('lightbox').addEventListener('click', () => $('lightbox').classList.remove('on'));
document.addEventListener('keydown', e => {
  if (e.key==='Escape' && $('lightbox').classList.contains('on')) {
    $('lightbox').classList.remove('on');
  }
});
`;
  if (isSingle) return base;
  return base + `
/* 多用例：列表 + 筛选 + 搜索 + 抽屉。DETAILS[id]=该用例详情主体 HTML。 */
const CASES = window.__E2ET_CASES__;
const DETAILS = window.__E2ET_DETAILS__;
const lower = r => String(r).toLowerCase();
const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const badge = r => '<span class="badge '+escapeHtml(lower(r))+'">'+escapeHtml(r)+'</span>';
const icon = s => s==='pass'?'✅':s==='fail'?'❌':'⚠️';
let filter = 'all', keyword = '';
function renderFilters() {
  const n = {all:CASES.length,pass:0,fail:0,blocked:0};
  CASES.forEach(c => n[lower(c.result)]++);
  $('chips').innerHTML = [['all','全部'],['fail','失败'],['blocked','阻塞'],['pass','通过']]
    .map(([k,l]) => '<button class="chip" type="button" data-filter="'+k+'" aria-pressed="'+(k===filter)+'">'+l+'<span class="n">'+n[k]+'</span></button>').join('');
}
function searchable(c) { return [c.id,c.name,c.summary,...c.steps.flatMap(s=>(s.apis || (s.api ? [s.api] : [])).map(a=>a.url))].join(' ').toLowerCase(); }

function caseCard(c) {
  const bar = c.steps.map(s=>'<i class="'+escapeHtml(s.status)+'"></i>').join('');
  const p = c.steps.filter(s=>s.status==='pass').length;
  return '<button class="case '+escapeHtml(lower(c.result))+'" type="button" data-id="'+escapeHtml(c.id)+'">'
    +'<div class="case-top"><span class="case-id">'+escapeHtml(c.id)+'</span>'+badge(c.result)
    +'<span class="case-name">'+escapeHtml(c.name)+'</span>'
    +(c.duration?'<span class="case-dur">'+escapeHtml(c.duration)+'</span>':'')+'</div>'
    +(c.summary?'<div class="case-sum">'+escapeHtml(c.summary)+'</div>':'')
    +'<div class="case-foot"><span class="minibar">'+bar+'</span><span class="case-count">'+p+'/'+c.steps.length+' 步骤通过</span><span class="case-more">查看详情 →</span></div></button>';
}
function renderList() {
  renderFilters();
  const kw = keyword.trim().toLowerCase();
  const shown = CASES.filter(c => (filter==='all'||lower(c.result)===filter) && (!kw||searchable(c).includes(kw)));
  $('cases').innerHTML = shown.map(caseCard).join('');
  $('empty').hidden = shown.length > 0;
}
renderList();
$('chips').addEventListener('click', e => { const b=e.target.closest('.chip'); if(!b)return; filter=b.dataset.filter; renderList(); });
$('q').addEventListener('input', e => { keyword=e.target.value; renderList(); });

let lastFocus = null;
function openCase(id) {
  const c = CASES.find(x=>x.id===id); if(!c)return;
  lastFocus = document.activeElement;
  $('d-id').textContent = c.id;
  $('d-badge').innerHTML = badge(c.result);
  $('d-dur').textContent = c.duration||'—';
  $('drawer-title').textContent = c.name;
  $('d-summary').textContent = c.summary||'';
  $('d-body').innerHTML = DETAILS[id] || '<p class="empty">详情不可用</p>';
  $('d-body').scrollTop = 0;
  $('drawer').classList.add('on'); $('backdrop').classList.add('on');
  document.body.style.overflow = 'hidden';
  $('d-close').focus();
}
function closeCase() {
  $('drawer').classList.remove('on'); $('backdrop').classList.remove('on');
  document.body.style.overflow = '';
  if (lastFocus&&lastFocus.isConnected) lastFocus.focus();
}
$('cases').addEventListener('click', e => { const card=e.target.closest('.case'); if(card) openCase(card.dataset.id); });
$('d-close').addEventListener('click', closeCase);
$('backdrop').addEventListener('click', closeCase);
document.addEventListener('keydown', e => {
  if (e.key!=='Escape') return;
  if ($('drawer').classList.contains('on')) { closeCase(); }
});
`;
}

// ── step HTML ──

function shortValue(value: unknown, limit = 160): string {
  if (value === undefined) return '未采集';
  const raw = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  return raw.length > limit ? `${raw.slice(0, limit)}…` : raw;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function assertionExpect(assertion: Record<string, unknown>): Record<string, unknown> | undefined {
  const expect = recordOf(assertion.expect);
  return recordOf(expect?.[String(assertion.kind ?? '')]) ?? expect;
}

function assertionTarget(assertion: Record<string, unknown>): string {
  const targetName = recordOf(assertion.target)?.name;
  if (typeof targetName === 'string' && targetName) return targetName;
  const actualName = recordOf(assertion.actual)?.name;
  if (typeof actualName === 'string' && actualName) return actualName;
  if (typeof assertion.expect === 'string') return assertion.expect;
  const expect = assertionExpect(assertion);
  return shortValue(expect?.target ?? expect?.locator ?? expect);
}

function fieldParts(assertion: Record<string, unknown>): { label: string; expected: unknown; actual: unknown } {
  const expect = assertionExpect(assertion);
  const actualRecord = recordOf(assertion.actual);
  const actual = actualRecord && Object.hasOwn(actualRecord, 'value')
    ? actualRecord.value
    : typeof actualRecord?.snippet === 'string'
      ? actualRecord.snippet
      : actualRecord ? undefined : assertion.actual;
  const expectedRecord = recordOf(expect?.value);
  const expectedValue = expectedRecord && Object.hasOwn(expectedRecord, 'literal')
    ? expectedRecord.literal
    : expect?.value;
  return {
    label: shortValue(expect?.label ?? assertion.label ?? ''),
    expected: expectedValue,
    actual,
  };
}

function visibilityState(assertion: Record<string, unknown>): unknown {
  const actual = recordOf(assertion.actual);
  if (!actual) return undefined;
  if (typeof actual.visible === 'boolean') return actual.visible ? '可见' : '不可见';
  const evidence = Array.isArray(assertion.evidence) ? assertion.evidence : [];
  const evidenceVisibility = evidence
    .map(item => recordOf(item)?.visible)
    .find((visible): visible is boolean => typeof visible === 'boolean');
  if (evidenceVisibility !== undefined) return evidenceVisibility ? '可见' : '不可见';
  if (actual.resolved === false) return '不可见';
  if (actual.resolved === true) return assertion.pass === true ? '可见' : '不可见';
  return undefined;
}

function assertionRow(assertion: Record<string, unknown>): {
  item: string;
  expected: unknown;
  actual: unknown;
  pass: boolean;
} {
  const expect = assertionExpect(assertion);
  const kind = String(assertion.kind ?? '');
  const pass = assertion.pass === true;
  if (kind === 'visible' || kind === 'absent') {
    return {
      item: `${assertionTarget(assertion)} · 可见性`,
      expected: kind === 'visible' ? '可见' : '不可见',
      actual: visibilityState(assertion),
      pass,
    };
  }
  if (assertion.kind === 'api' || assertion.kind === 'request') {
    const actual = assertion.path_status === 'missing'
      ? '路径未命中'
      : assertion.path_status === 'BODY_UNAVAILABLE'
        ? 'BODY_UNAVAILABLE'
        : assertion.actual;
    return {
      item: `${kind === 'api' ? '响应字段' : '请求字段'}:${shortValue(expect?.path)}`,
      expected: `${shortValue(expect?.op)} ${shortValue(expect?.value)}`,
      actual,
      pass,
    };
  }
  if (kind === 'field' || kind === 'field_value') {
    const field = fieldParts(assertion);
    return {
      item: `字段:${field.label}`,
      expected: field.expected,
      actual: field.actual,
      pass,
    };
  }
  if (kind === 'text') {
    const actualRecord = recordOf(assertion.actual);
    const actual = typeof assertion.actual === 'string' && assertion.actual !== '通过'
      ? assertion.actual
      : actualRecord?.snippet;
    return {
      item: `文案:${shortValue(expect?.contains)}`,
      expected: `包含 ${shortValue(expect?.contains)}`,
      actual: pass ? '已命中' : actual,
      pass,
    };
  }
  if (kind === 'element') {
    const op = String(expect?.op ?? 'eq');
    const prop = String(expect?.property ?? '');
    const val = shortValue(expect?.value);
    const actualRecord = recordOf(assertion.actual);
    const matches = typeof actualRecord?.matches === 'number' ? actualRecord.matches : undefined;
    const values = Array.isArray(actualRecord?.values) ? actualRecord.values : [];
    const snippet = values.length ? shortValue(String(values[0]), 80) : undefined;
    // 业务化 property 标签
    const propMap: Record<string, string> = {
      text: '文本', count: '数量',
      'rect.width': '宽度', 'rect.height': '高度',
      'rect.top': '顶部位置', 'rect.left': '左侧位置',
      'rect.right': '右侧位置', 'rect.bottom': '底部位置',
      scrollWidth: '滚动宽度', scrollHeight: '滚动高度',
      clientWidth: '可视宽度', clientHeight: '可视高度',
      'image.complete': '图片加载', 'image.naturalWidth': '图片原始宽度', 'image.naturalHeight': '图片原始高度',
      overflowX: '横向溢出',
    };
    // 业务化 op 标签
    const opMap: Record<string, string> = {
      eq: '等于', ne: '不等于', gt: '大于', lt: '小于', exists: '存在', contains: '包含',
    };
    const propLabel = propMap[prop] ?? prop;
    const opLabel = opMap[op] ?? op;
    // count 属性特殊处理：item 和 actual 不同
    if (prop === 'count') {
      const actualNum = matches ?? (values.length ? Number(values[0]) : undefined);
      return {
        item: '元素数量',
        expected: `${opLabel} ${val}`,
        actual: actualNum !== undefined ? String(actualNum) : '未采集',
        pass,
      };
    }
    return {
      item: `元素${propLabel}`,
      expected: `${opLabel} ${val}`,
      actual: pass ? '匹配' : (snippet ?? '未采集'),
      pass,
    };
  }
  return {
    item: `断言:${kind || 'unknown'}`,
    expected: expect,
    actual: assertion.actual,
    pass,
  };
}

function assertionTable(assertions: Record<string, unknown>[]): string {
  const rows = assertions.map(assertion => {
    const row = assertionRow(assertion);
    return `<tr class="${row.pass ? 'assert-row-pass' : 'assert-row-fail'}">`
      + `<td class="assert-item">${esc(row.item)}</td>`
      + `<td class="assert-expected">${esc(shortValue(row.expected))}</td>`
      + `<td class="assert-actual">${esc(shortValue(row.actual))}</td>`
      + `<td class="assert-result"><span class="${row.pass ? 'assert-result-pass' : 'assert-result-fail'}">${row.pass ? '通过' : '失败'}</span></td>`
      + `</tr>`;
  }).join('');
  return `<div class="assert-table-wrap" role="region" aria-label="断言验证结果" tabindex="0">`
    + `<table class="assert-table"><thead><tr>`
    + `<th scope="col">验证项</th><th scope="col">期望</th><th scope="col">实际</th><th scope="col">结果</th>`
    + `</tr></thead><tbody>${rows}</tbody></table></div>`;
}

function rawAssertionEvidence(s: ReportStep): string {
  if (!s.observation && !s.assertDetails?.length) return '';
  const observation = s.observation
    ? `<div class="raw-evidence-label">观察证据（原始）</div><pre class="evidence">${esc(s.observation)}</pre>`
    : '';
  const details = s.assertDetails?.length
    ? `<div class="raw-evidence-label">断言明细（原始 ${s.assertDetails.length} 条）</div><ul class="assert-list">${s.assertDetails.map(a => `<li>${esc(a)}</li>`).join('')}</ul>`
    : '';
  return `<div class="raw-evidence">${observation}${details}</div>`;
}

function focusedRows(focused: Map<string, unknown> | null | undefined): string {
  if (!focused?.size) return '';
  return `<div class="api-focused">${[...focused.entries()].map(([key, value]) =>
    `<div class="api-focused-row"><span class="api-focused-key">${esc(key)}</span><span class="api-focused-val">${renderFocusedValue(value)}</span></div>`,
  ).join('')}</div>`;
}

function apiBody(label: string, body: string | undefined, focused: Map<string, unknown> | null, fullLabel: string, jsonTree = false): string {
  if (!body) return '';
  let bodyHtml = `<pre class="evidence">${esc(body)}</pre>`;
  if (jsonTree) {
    try {
      const parsed = JSON.parse(body);
      bodyHtml = `<div class="json-response-tree">${renderFocusedValue(parsed, 0, true)}</div>`
        + `<details class="response-source"><summary>响应原文</summary><pre class="evidence">${esc(body)}</pre></details>`;
    } catch {
      // 非 JSON 保留原始文本展示。
    }
  }
  return `<div class="api-body"><div class="api-body-cap">${label}</div>${focusedRows(focused)}`
    + `<details class="full-response"><summary>${fullLabel}</summary>${bodyHtml}</details></div>`;
}

/** 单个 API 面板渲染（C2 finding 7：多接口逐项渲染）。 */
function apiPanel(api: ReportStepApi, opts?: {
  stepStatus?: string;
  focusedRequest?: Map<string, unknown> | null;
  focusedResponse?: Map<string, unknown> | null;
}): string {
  const n = parseInt(api.status, 10);
  const cls = (isNaN(n) || n >= 500) ? 'code-err' : n >= 400 ? 'code-warn' : 'code-ok';
  const both = api.reqBody && api.respBody;
  const reqBodyHtml = apiBody('请求 (Request)', api.reqBody, opts?.focusedRequest ?? null, '完整请求 (Full Request)');
  const respBodyHtml = apiBody('响应 (Response)', api.respBody, opts?.focusedResponse ?? null, '完整响应 (Full Response)', true);
  const bodies = (api.reqBody || api.respBody) ? `<div class="api-bodies${both ? '' : ' single'}">`
    + reqBodyHtml
    + respBodyHtml
    + '</div>' : '';
  let traceHtml = '';
  const showTrace = opts?.stepStatus === 'fail' || opts?.stepStatus === 'blocked' || (parseInt(api.status, 10) >= 400);
  if (api.traceId && showTrace) {
    traceHtml = `<div class="trace-box">`
      + `<span class="trace-label">Eagleeye-Traceid</span>`
      + `<code class="trace-id">${esc(api.traceId)}</code>`
      + `<button class="trace-copy" type="button" data-copy="${esc(api.traceId)}">复制</button></div>`;
  }
  let headersHtml = '';
  if (api.respHeaders) {
    const hdrLines = api.respHeaders.trim().split('\n').length;
    const highlighted = esc(api.respHeaders).replace(
      /^(\s*)(eagleeye-traceid)(:)(.*)$/gim,
      (_, sp, k, colon, v) => sp + '<span class="hl-trace">' + k + colon + v + '</span>',
    );
    headersHtml = `<details class="headers"><summary>响应头 (Response Headers) <span class="hn">${hdrLines} 项</span></summary><pre class="evidence">${highlighted}</pre></details>`;
  }
  const visiblePath = api.path || api.url;
  const urlHtml = api.url && api.url !== visiblePath
    ? `<details class="full-response"><summary>完整 URL</summary><pre class="evidence">${esc(api.url)}</pre></details>`
    : '';
  return `<div class="api-panel"><div class="api-line">`
    + (api.method ? `<span class="method">${esc(api.method)}</span>` : '')
    + `<span class="api-url">${esc(visiblePath)}</span>`
    + (api.status ? `<span class="code-tag ${cls}">${esc(api.status)}</span>` : '')
    + `</div>${traceHtml}${bodies}${headersHtml}${urlHtml}</div>`;
}

function stepBlock(s: ReportStep): string {
  const icon = s.status === 'pass' ? '✅' : s.status === 'fail' ? '❌' : '⚠️';
  // C2 finding 7：多 API 面板。apis 优先，旧 api 字段兼容。
  const apiList: ReportStepApi[] = s.apis?.length ? s.apis : (s.api ? [s.api] : []);
  const apiHtml = apiList.map(api => {
    const focusedRequest = extractFocusedPaths(s, api, 'request', api.reqBody);
    const focusedResponse = extractFocusedPaths(s, api, 'api', api.respBody);
    return apiPanel(api, { stepStatus: s.status, focusedRequest, focusedResponse });
  }).join('');
  const hasAssertions = Boolean(s.assertions?.length);
  const assertionsHtml = hasAssertions ? assertionTable(s.assertions!) : '';

  const screenshotHtml = s.screenshot
    ? `<img class="shot" src="${esc(s.screenshot)}" alt="步骤 ${esc(String(s.index))} 截图" loading="lazy">`
    : (s.screenshotNotice ? `<div class="shot-missing">${esc(s.screenshotNotice)}</div>` : '');

  const longObservation = s.observation.length > 320;
  const observation = longObservation ? shortValue(s.observation, 320) : s.observation;
  const historicalObservationDetails = !hasAssertions && longObservation
    ? `<div class="raw-evidence-label">观察证据（原始）</div><pre class="evidence">${esc(s.observation)}</pre>`
    : '';
  const directObservation = hasAssertions && s.status === 'pass' ? '' : observation;
  const historicalAssertDetails = !hasAssertions && s.assertDetails?.length
    ? `<div class="raw-evidence-label">断言明细（原始 ${s.assertDetails.length} 条）</div><ul class="assert-list">${s.assertDetails.map(a => `<li>${esc(a)}</li>`).join('')}</ul>`
    : '';
  const rawEvidence = hasAssertions ? rawAssertionEvidence(s) : '';
  const historicalEvidence = hasAssertions ? rawEvidence : historicalObservationDetails + historicalAssertDetails;
  const networkObservation = s.evidence
    ? `<div class="raw-evidence-label">网络观测证据（原始）</div><pre class="evidence">${esc(s.evidence)}</pre>`
    : '';
  const directApiHtml = s.status === 'pass' ? '' : apiHtml;
  const technicalBody = (s.status === 'pass' ? apiHtml : '') + historicalEvidence + networkObservation;
  const technicalEvidence = technicalBody
    ? `<details class="tech-evidence"><summary>技术证据${s.status === 'pass' && apiList.length ? ` · ${apiList.length} 个接口` : ' · 原始验证记录'}</summary>`
      + `<div class="tech-evidence-body">${technicalBody}</div></details>`
    : '';

  return `<div class="step ${s.status}"><div class="step-head">`
    + `<span class="step-no">#${s.index}</span><span class="ico">${icon}</span>`
    + `<span class="step-action">${esc(s.action)}</span>`
    + (s.duration ? `<span class="step-dur">${esc(s.duration)}</span>` : '')
    + `</div>`
    + (directObservation ? `<div class="step-obs">${esc(directObservation)}</div>` : '')
    + assertionsHtml
    + directApiHtml
    + screenshotHtml
    + technicalEvidence
    + `</div>`;
}

// ── case detail body（业务结果 + uiChecks + fixes + findings + 失败诊断）──

const stepIcon = (s: string): string => s === 'pass' ? '✅' : s === 'fail' ? '❌' : '⚠️';

/** 单个 case 的详情主体，单用例平铺与多用例抽屉共用。 */
function detailBody(c: ReportCase, includeHeading = true): string {
  const out: string[] = [];
  if (c.source) {
    const rows = [['会话', c.sessionId], ['原 case id', c.source.caseId], ['原报告', c.source.report],
      ['URL', c.url], ['环境', c.env], ['工具版本', c.toolVersion], ['原用例结论', c.sourceResult],
      ['原报告结论', c.source.result], ['trace 终态', c.source.sessionResult ?? '未结束'],
      ['meta 终态', c.source.metaMissing ? '元数据缺失' : c.source.metaResult ?? '未结束'], ['汇总会话终态', c.sessionResult]];
    out.push(`<details class="headers"><summary>来源与终态 · ${esc(c.sessionId ?? '')}</summary><div class="info-grid">${rows.map(([k, v]) => `<span class="info-key">${esc(k ?? '')}</span><span class="info-val">${esc(v ?? '')}</span>`).join('')}</div></details>`);
    out.push(coverageSection({ coverage: c.coverage }, c.steps));
  }
  if (includeHeading) out.push(`<h3>业务验证结果（${c.steps.length}）</h3>`);
  out.push(c.steps.map(s => stepBlock(s)).join('\n'));

  const diagnostics = [
    ['诊断断言', c.diagnostic_assertions], ['孤立观察', c.diagnostic_observations], ['全局诊断', c.diagnostic_events],
  ] as const;
  if (c.appendix?.length || diagnostics.some(([, evs]) => evs?.length)) {
    out.push(`<details class="tech-evidence"><summary>诊断附录 · 不计业务统计</summary><div class="tech-evidence-body">`
      + (c.appendix ?? []).map(s => stepBlock(s)).join('\n')
      + diagnostics.filter(([, evs]) => evs?.length).map(([label, evs]) => `<h3>${label}</h3><pre class="evidence">${esc(JSON.stringify(evs, null, 2))}</pre>`).join('')
      + '</div></details>');
  }

  if (c.uiChecks) {
    const u = c.uiChecks;
    out.push(`<h3>UI 与交互检查</h3><p class="ui-summary">${esc(u.summary || '无明显异常')}</p>`);
    if (u.items?.length) {
      out.push(`<ul class="plain-list">${u.items.map(it =>
        `<li>${stepIcon(it.status)} ${esc(it.description)}${it.fixed ? ' <span class="tag fixed">已修复</span>' : ''}`
        + (it.screenshot ? `<img class="shot" src="${esc(it.screenshot)}" alt="UI 截图" loading="lazy">` : '')
        + `</li>`).join('')}</ul>`);
    }
    if (u.interactions?.length) {
      out.push(`<h3>交互验收</h3><ul class="plain-list">${u.interactions.map(it =>
        `<li>${stepIcon(it.status)} <b>${esc(it.expect)}</b> → ${esc(it.actual)}</li>`).join('')}</ul>`);
    }
  }

  if (c.fixes?.length) {
    out.push(`<h3>修复记录</h3>${c.fixes.map(f =>
      `<div class="fix"><div><b>问题：</b>${esc(f.problem)}</div><div><b>改动：</b>${esc(f.change)}</div><div><b>复验：</b>${esc(f.reverify)}</div>`
      + (f.screenshot ? `<img class="shot" src="${esc(f.screenshot)}" alt="复验截图" loading="lazy">` : '')
      + `</div>`).join('')}`);
  }

  if (c.findings?.length) {
    out.push(`<h3>发现</h3><ul class="find-list">${c.findings.map(f => `<li>${esc(f)}</li>`).join('')}</ul>`);
  }

  if (c.backendInfo && c.result !== 'PASS') {
    const b = c.backendInfo;
    const row = (k: string, v: string, cls = '') => `<div class="be-row"><span class="be-key">${k}</span><span class="be-val ${cls}">${esc(v)}</span></div>`;
    out.push(`<details class="tech-evidence backend-diagnostics"><summary>技术证据 · 后端失败诊断</summary><div class="tech-evidence-body"><div class="be-card">`
      + row('接口', b.api || '')
      + row('traceId', b.traceId || '(无)', 'be-trace')
      + row('时间', b.time || '')
      + (b.failure ? row('失败摘要', b.failure) : '')
      + (b.analysis ? row('分析', b.analysis) : '')
      + (b.response ? `<details class="full-response"><summary>完整响应</summary><pre class="evidence">${esc(b.response)}</pre></details>` : '')
      + (b.params ? `<details class="full-response"><summary>完整入参</summary><pre class="evidence">${esc(b.params)}</pre></details>` : '')
      + `</div></div></details>`);
  }

  return out.join('\n');
}

// ── main render ──

export function renderReportHtml(data: ReportData): string {
  if (!data.cases.length) throw new Error('report data must have at least one case');
  const isSingle = data.cases.length === 1;
  const allSteps = data.cases.flatMap(c => c.steps);
  const allAssertions = allSteps.flatMap(step => step.assertions ?? []);
  const stepStats = {
    pass: allSteps.filter(s => s.status === 'pass').length,
    fail: allSteps.filter(s => s.status === 'fail').length,
    blocked: allSteps.filter(s => s.status === 'blocked').length,
  };
  const caseStats = {
    pass: data.cases.filter(c => c.result === 'PASS').length,
    fail: data.cases.filter(c => c.result === 'FAIL').length,
    blocked: data.cases.filter(c => c.result === 'BLOCKED').length,
  };
  const stats = isSingle ? stepStats : caseStats;

  const resultMap: Record<string, { cls: string; label: string }> = {
    PASS: { cls: 'pass', label: 'PASS' },
    FAIL: { cls: 'fail', label: 'FAIL' },
    BLOCKED: { cls: 'blocked', label: 'BLOCKED' },
  };
  const r = resultMap[data.result] ?? resultMap.BLOCKED;
  const c0 = data.cases[0];
  const assertionStats = {
    total: allAssertions.length,
    pass: allAssertions.filter(assertion => assertion.pass === true).length,
  };
  const headerCount = isSingle ? `${allSteps.length} 个业务步骤` : `${data.cases.length} 个用例`;

  // 单用例：平铺详情主体
  const singlePanel = isSingle
    ? `<section><h2>业务验证结果</h2><div id="single-body">${detailBody(c0, false)}</div></section>`
    : '';

  // 多用例：列表 + 抽屉（数据内联给前端 JS 渲染）
  const listPanel = isSingle ? '' : `
  <section id="list-panel">
    <h2>用例列表</h2>
    <div class="toolbar">
      <div class="chips" id="chips"></div>
      <div class="search">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.6-3.6"/></svg>
        <input id="q" type="search" placeholder="搜索用例 / 模块 / 接口" autocomplete="off">
      </div>
    </div>
    <div class="cases" id="cases"></div>
    <div class="empty" id="empty" hidden>没有匹配的用例。</div>
  </section>`;

  const drawerHtml = isSingle ? '' : `
<div class="backdrop" id="backdrop"></div>
<aside class="drawer" id="drawer" role="dialog" aria-modal="true" tabindex="-1">
  <div class="drawer-head">
    <div class="row">
      <span class="case-id" id="d-id"></span>
      <span id="d-badge"></span>
      <span class="case-dur" id="d-dur"></span>
      <button class="close" id="d-close" type="button" aria-label="关闭">✕</button>
    </div>
    <h2 class="drawer-title" id="drawer-title"></h2>
    <p class="summary" id="d-summary"></p>
  </div>
  <div class="drawer-body" id="d-body"></div>
</aside>`;

  // HTML raw-text 先解码脚本：用 JSON unicode escape 保留字面值，阻止 </script> 提前封口。
  const scriptJson = (value: unknown): string => JSON.stringify(value).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(data.title)}</title>
<style>${css()}</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>${esc(data.title)}</h1>
    ${data.env ? `<p class="meta">环境: ${esc(data.env)}</p>` : ''}
    <p class="meta">生成时间: ${esc(now())} (UTC+8)</p>
    <p><span class="badge ${r.cls}">${r.label}</span> <span style="color:var(--subtle);font-size:12px;margin-left:8px">${headerCount}</span></p>
    <p class="summary-stats"><span>${isSingle ? '业务步骤' : '用例'}<b class="${r.cls}">${stats.pass}/${isSingle ? allSteps.length : data.cases.length}</b></span><span>断言<b>${assertionStats.pass}/${assertionStats.total}</b></span><span class="fail">失败<b>${stats.fail}</b></span><span class="blocked">阻塞<b>${stats.blocked}</b></span></p>
    ${data.summary ? `<p class="summary">${esc(data.summary)}</p>` : ''}
    ${riskAlerts(data, allSteps)}
    <details class="headers header-info"><summary>会话与运行信息</summary><div class="info-grid">
      ${data.url ? `<span class="info-key">URL</span><span class="info-val">${esc(data.url)}</span>` : ''}
      <span class="info-key">会话</span><span class="info-val">${esc(data.sessionId)}</span>
      ${data.toolVersion ? `<span class="info-key">工具版本</span><span class="info-val">${esc(data.toolVersion)}</span>` : ''}
      ${data.links?.length ? `<span class="info-key">链接</span><span class="info-val">${data.links.map(l => `<a href="${esc(l.url)}" style="color:var(--link,#2563eb)">${esc(l.label)}</a>`).join(' · ')}</span>` : ''}
    </div></details>
  </header>

  ${coverageSection(data, allSteps)}
  ${singlePanel}${listPanel}

  <footer>由 e2et report 生成 · 自包含 HTML 报告</footer>
</div>

${drawerHtml}

${isSingle ? '' : `<script>window.__E2ET_CASES__=${scriptJson(data.cases.map(c => ({ id: c.id, name: c.name, result: c.result, duration: c.duration ?? '', summary: c.summary ?? '', steps: c.steps.map(s => ({ status: s.status, apis: s.apis?.map(a => ({ url: a.url })), api: s.api ? { url: s.api.url } : undefined })) })))};window.__E2ET_DETAILS__=${scriptJson(Object.fromEntries(data.cases.map(c => [c.id, detailBody(c)])))};</script>`}

<div class="lightbox" id="lightbox"><img id="lightbox-img" alt="截图放大"></div>

<script>
${js(isSingle)}
</script>
</body>
</html>`;
}
