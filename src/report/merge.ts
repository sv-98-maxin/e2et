import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { sessionsDir, traceDir, e2etRoot } from '../daemon/session-meta.js';
import { ensurePrivateDir } from '../daemon/trace.js';
import { renderReportHtml } from '../shared/report-render.js';
import type { ReportCase, ReportCoverage, ReportData, ReportStep } from '../shared/report-model.js';
import { projectReportValue } from '../shared/acceptance.js';
import { buildReportApis } from './apis.js';
import { AcceptanceInputError, readAcceptanceSnapshot } from './acceptance.js';
import { SourceFactsError, buildSourceFacts, projectSourceRecord, type SourceFacts } from './source-facts.js';
import { readReportFlow } from './flow.js';
export { buildReportApis } from './apis.js';

type Ev = Record<string, unknown>;
type Result = ReportCase['result'];
const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const results = ['PASS', 'BLOCKED', 'FAIL'];
const record = (v: unknown): v is Ev => !!v && typeof v === 'object' && !Array.isArray(v);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(s => typeof s === 'string');
const tighten = (...rs: Result[]): Result => results[Math.max(...rs.map(r => results.indexOf(r)))] as Result;
const terminal = (r: unknown): Result => r === 'fail' ? 'FAIL' : r === 'pass' ? 'PASS' : 'BLOCKED';

export class ReportMergeError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

function requireInput(ok: unknown, message: string, code = 'REPORT_INPUT'): asserts ok {
  if (!ok) throw new ReportMergeError(code, message);
}

function validCoverage(v: unknown): v is ReportCoverage {
  return record(v) && (v.plan === null || strings(v.plan)) && strings(v.executed) && strings(v.missing) && strings(v.unplanned);
}

function validStep(v: unknown): v is ReportStep {
  return record(v) && Number.isInteger(v.index) && Number(v.index) > 0
    && ['pass', 'fail', 'blocked'].includes(String(v.status))
    && ['action', 'observation', 'duration'].every(k => typeof v[k] === 'string')
    && (v.group === undefined || typeof v.group === 'string')
    && (v.actionIds === undefined || strings(v.actionIds))
    && strings(v.eventIds)
    && (v.assertDetails === undefined || strings(v.assertDetails))
    && (v.assertions === undefined || Array.isArray(v.assertions) && v.assertions.every(a => record(a) && a.t === 'assert'
      && (a.id === undefined || typeof a.id === 'string') && typeof a.kind === 'string' && typeof a.pass === 'boolean'))
    && (v.captures === undefined || Array.isArray(v.captures) && v.captures.every(record))
    && (v.apis === undefined || Array.isArray(v.apis) && v.apis.every(record))
    && ['screenshot', 'screenshotPath', 'screenshotAfter', 'screenshotNotice'].every(k => v[k] === undefined || typeof v[k] === 'string');
}

/** 只核原生报告消费的 JSON 结构；业务身份与证据在最终 trace 上逐项核。 */
function validReport(v: unknown): v is ReportData & Ev {
  return record(v) && v.report_schema_version === 2 && ['title', 'url', 'env', 'summary', 'sessionId', 'session_id', 'toolVersion'].every(k => typeof v[k] === 'string')
    && results.includes(String(v.result)) && results.includes(String(v.conclusion)) && typeof v.mocked === 'boolean'
    && validCoverage(v.coverage) && strings(v.findings)
    && record(v.actions) && typeof v.actions.total === 'number' && typeof v.actions.success === 'number'
    && ['assert_details', 'diagnostic_assertions', 'diagnostic_observations'].every(k => Array.isArray(v[k]) && (v[k] as unknown[]).every(record))
    && Array.isArray(v.cases) && v.cases.length > 0 && v.cases.every(c => record(c)
      && typeof c.id === 'string' && !!c.id && typeof c.name === 'string' && results.includes(String(c.result))
      && Array.isArray(c.steps) && c.steps.every(validStep)
      && Array.isArray(c.events) && c.events.every(event => record(event) && typeof event.id === 'string' && Number.isInteger(event.sequence)
        && ['action', 'assert', 'capture', 'screenshot', 'observation', 'error'].includes(String(event.type))
        && ['pass', 'fail', 'error', 'not_run'].includes(String(event.status)))
      && Array.isArray(c.images) && c.images.every(image => record(image) && typeof image.id === 'string' && typeof image.eventId === 'string' && typeof image.src === 'string')
      && (c.flow === undefined || record(c.flow) && Number.isFinite(c.flow.startedAt) && Number.isFinite(c.flow.endedAt)
        && Array.isArray(c.flow.frames) && c.flow.frames.every(frame => record(frame)
          && typeof frame.src === 'string' && Number.isFinite(frame.startedAt)))
      && record(c.run) && c.run.mode === 'source' && typeof c.run.id === 'string' && results.includes(String(c.run.status))
      && (c.appendix === undefined || Array.isArray(c.appendix) && c.appendix.every(validStep))
      && (c.summary === undefined || typeof c.summary === 'string') && (c.duration === undefined || typeof c.duration === 'string')
      && (c.findings === undefined || strings(c.findings)) && (c.coverage === undefined || validCoverage(c.coverage)));
}

export function mergeReports(sids: string[], env: NodeJS.ProcessEnv, linkedPath: (file: string) => boolean, title?: string) {
  requireInput(sids.length > 0, 'merge 至少需要一个会话 id', 'USAGE');
  requireInput(sids.every(s => /^s_[a-f0-9]{8}$/.test(s)), 'merge 会话 id 必须是 s_ 加 8 位小写 hex', 'USAGE');
  requireInput(new Set(sids).size === sids.length, 'merge 不接受重复会话 id', 'USAGE');

  const readFile = (file: string): Buffer => {
    requireInput(!linkedPath(file), `输入或父目录是 symlink: ${file}`, 'SYMLINK');
    const st = fs.lstatSync(file, { throwIfNoEntry: false });
    requireInput(st, `输入不存在: ${file}`, 'NOT_FOUND');
    requireInput(st.isFile(), `输入不是普通文件: ${file}`);
    const fd = fs.openSync(file, fs.constants.O_RDONLY | NO_FOLLOW);
    try {
      requireInput(fs.fstatSync(fd).isFile(), `输入不是普通文件: ${file}`);
      return fs.readFileSync(fd);
    } finally { fs.closeSync(fd); }
  };
  const readJson = (file: string): unknown => {
    const raw = readFile(file);
    try { return JSON.parse(raw.toString('utf8')); }
    catch { throw new ReportMergeError('REPORT_INPUT', `JSON 损坏: ${file}`); }
  };

  const sources = sids.map(sid => {
    const dir = traceDir(sid, env);
    const json = path.join(dir, 'report', 'report.json');
    const report = readJson(json);
    requireInput(record(report) && report.report_schema_version === 2, `merge 只接受 report_schema_version=2 的 Source 报告: ${sid}`, 'REPORT_SCHEMA');
    requireInput(validReport(report), `原生报告结构无效: ${sid}`);
    requireInput(report.cases.length === 1 && report.cases[0].run?.id === sid, `Source case/run 来源不符: ${sid}`);
    requireInput(report.sessionId === sid && report.session_id === sid, `报告来源会话不符: ${sid}`);
    requireInput(new Set(report.cases.map(c => c.id)).size === report.cases.length, `原 case id 重复: ${sid}`);
    const trace = readFile(path.join(dir, 'trace.jsonl')).toString('utf8');
    let events: Ev[];
    try { events = trace.split('\n').filter(s => s.trim()).map(s => JSON.parse(s)); }
    catch { throw new ReportMergeError('REPORT_INPUT', `trace JSON 损坏: ${sid}`); }
    requireInput(events.every(e => record(e) && typeof e.t === 'string'), `trace 事件结构无效: ${sid}`);
    const session = events[0];
    requireInput(session?.t === 'session' && session.session_id === sid, `trace 来源会话不符: ${sid}`);
    requireInput(report.env === session.env && report.toolVersion === session.tool_version
      && report.url === String(events.find(e => e.t === 'navigation')?.to ?? ''), `报告来源 URL/env/version 与 trace 不符: ${sid}`);
    const end = events.filter(e => e.t === 'session_end').at(-1);
    requireInput(!end || ['pass', 'fail', 'blocked', 'aborted'].includes(String(end.result)), `trace 终态无效: ${sid}`);
    const metaFile = path.join(sessionsDir(env), `${sid}.json`);
    requireInput(!linkedPath(metaFile), `meta 或父目录是 symlink: ${sid}`, 'SYMLINK');
    const metaMissing = !fs.lstatSync(metaFile, { throwIfNoEntry: false });
    const meta = metaMissing ? undefined : readJson(metaFile);
    requireInput(metaMissing || record(meta) && meta.id === sid, `meta 结构或来源会话不符: ${sid}`);
    const metaEnd = record(meta) ? meta.session_end : undefined;
    requireInput(metaEnd === undefined || record(metaEnd) && ['pass', 'fail', 'blocked', 'aborted'].includes(String(metaEnd.result))
      && typeof metaEnd.ended_at === 'number' && Number.isFinite(metaEnd.ended_at), `meta 终态无效: ${sid}`);
    const sessionResult = tighten(terminal(end?.result), terminal(record(metaEnd) ? metaEnd.result : undefined));

    const actions = events.filter(e => e.t === 'action');
    requireInput(actions.every(a => typeof a.id === 'string' && !!a.id) && new Set(actions.map(a => a.id)).size === actions.length, `trace 动作身份无效: ${sid}`);
    const byId = new Map(actions.map(a => [String(a.id), a]));
    const groupOf = (e: Ev): string => typeof e.group === 'string' && e.group ? e.group : String(byId.get(String(e.after ?? ''))?.group ?? '');
    const evidence = events.filter(e => ['assert', 'capture', 'screenshot', 'hover_cleanup_error', 'observation', 'inspect'].includes(String(e.t)));
    const groups = [...new Set(events.flatMap(e => {
      const g = e.t === 'action' ? String(e.group ?? '') : evidence.includes(e) ? groupOf(e) : '';
      return g ? [g] : [];
    }))];
    const buckets = groups.map(group => {
      const owned = actions.filter(a => a.group === group);
      const evs = evidence.filter(e => groupOf(e) === group);
      const related = [...new Set([...owned, ...evs.flatMap(e => { const a = byId.get(String(e.after ?? '')); return a ? [a] : []; })])];
      return { group, owned, related: related.sort((first, second) => events.indexOf(first) - events.indexOf(second)), evidence: evs };
    });
    const diagnostics = actions.filter(a => !a.group).map(a => ({
      group: undefined, owned: [a], related: [a], evidence: evidence.filter(e => e.after === a.id && !groupOf(e)),
    }));
    const business = groups.length ? buckets : diagnostics;
    const appendix = groups.length ? diagnostics : [];
    const shape = (value: unknown): unknown => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
    const checkSame = (saved: unknown, actual: unknown, field: string) => requireInput(isDeepStrictEqual(saved, shape(actual)), `报告与最终 trace 的 ${field} 不一致（陈旧或证据损坏）: ${sid}`, 'REPORT_STALE');
    const readImage = (file: string): string | undefined => {
      requireInput(path.dirname(file) === path.resolve(e2etRoot(env), 'workspace', 'screenshots')
        && path.basename(file).startsWith(`${sid}_`) && file.endsWith('.png'), `截图来源路径不符: ${sid}`);
      requireInput(!linkedPath(file), `截图或父目录是 symlink: ${sid}`, 'SYMLINK');
      if (!fs.lstatSync(file, { throwIfNoEntry: false })) return undefined;
      const bytes = readFile(file);
      return bytes.length <= 2 * 1024 * 1024 ? `data:image/png;base64,${bytes.toString('base64')}` : undefined;
    };
    let sourceFacts: SourceFacts;
    try { sourceFacts = buildSourceFacts(sid, trace, readImage, readAcceptanceSnapshot(dir)); }
    catch (error) {
      if (error instanceof SourceFactsError || error instanceof AcceptanceInputError) throw new ReportMergeError(error.code, error.message);
      throw error;
    }
    const sourceCase = report.cases[0];
    checkSame(sourceCase.events, sourceFacts.events, 'events 安全投影');
    checkSame(sourceCase.images, sourceFacts.images, 'images/引用/截图字节');
    if (sourceCase.flow !== undefined) checkSame(sourceCase.flow, readReportFlow(sid, env, linkedPath), 'flow/原始帧字节/顺序/时间');
    checkSame(sourceCase.run, sourceFacts.run, 'Source run/启动版本/身份');
    checkSame(sourceCase.acceptance, sourceFacts.acceptance, '启动时冻结的 acceptance');
    checkSame(sourceCase.acceptanceCoverage, sourceFacts.acceptanceCoverage, 'acceptanceCoverage 全部尝试');
    requireInput(new Set(sourceCase.events!.map(event => event.id)).size === sourceCase.events!.length, `Source event id 重复: ${sid}`);
    checkSame(report.assert_details, business.flatMap(b => b.evidence.filter(e => e.t === 'assert')).map(projectSourceRecord), 'assert_details');
    checkSame(report.diagnostic_assertions, appendix.flatMap(b => b.evidence.filter(e => e.t === 'assert')).map(projectSourceRecord), 'diagnostic_assertions');
    const orphanObservations = events.filter(e => e.t === 'observation' && !groupOf(e) && !byId.has(String(e.after ?? '')));
    checkSame(report.diagnostic_observations, orphanObservations.map(projectSourceRecord), 'diagnostic_observations');
    checkSame(report.actions, { total: actions.length, success: actions.filter(a => record(a.result) && a.result.ok === true).length }, 'actions');
    checkSame(report.asserts, { total: events.filter(event => event.t === 'assert').length, pass: events.filter(event => event.t === 'assert' && event.pass === true).length }, '正式检查统计');
    checkSame(report.captures, { total: events.filter(event => event.t === 'capture').length, pass: events.filter(event => event.t === 'capture' && record(event.result) && event.result.ok === true).length }, 'capture 独立统计');
    const orphanEvidence = evidence.filter(e => !groupOf(e) && !byId.has(String(e.after ?? '')) && e.t !== 'observation');
    for (const e of orphanEvidence) {
      if (e.t === 'hover_cleanup_error') requireInput(!e.after && report.findings?.includes(`会话清理失败：${String(e.error)}`), `全局诊断未保存在原生报告中: ${sid}`, 'REPORT_STALE');
    }

    const requests = events.filter(e => e.t === 'request');
    const readBody = (ref: unknown): string | undefined => {
      if (typeof ref !== 'string') return undefined;
      requireInput(/^blobs\/[a-f0-9]{64}$/.test(ref), `请求 body 引用无效: ${sid}`);
      const file = path.join(dir, ref);
      requireInput(!linkedPath(file), `请求 body 或父目录是 symlink: ${sid}`, 'SYMLINK');
      if (!fs.lstatSync(file, { throwIfNoEntry: false })) return undefined;
      const bytes = readFile(file);
      requireInput(createHash('sha256').update(bytes).digest('hex') === ref.slice(6), `请求 body 摘要不符: ${sid}`);
      return bytes.toString('utf8');
    };
    const seen = new Set<object>();
    const checkSteps = (steps: ReportStep[], expected: typeof business, isBusiness: boolean): ReportStep[] => steps.map(step => {
      const b = expected.find(b => b.group ? b.group === step.group : !step.group && step.actionIds?.[0] === b.related[0]?.id);
      if (!b) {
        requireInput(isBusiness && step.group && step.status === 'blocked' && !step.actionIds?.length && !step.assertions?.length
          && !step.captures?.length && !step.apis?.length && !step.screenshot && report.coverage?.missing.includes(step.action), `步骤没有原生 trace 来源: ${sid}/${step.index}`, 'REPORT_STALE');
        return { ...step, sourceStatus: step.status };
      }
      requireInput(!seen.has(b), `trace 分组被多个步骤重复消费: ${sid}`, 'REPORT_STALE');
      seen.add(b);
      const assertions = b.evidence.filter(e => e.t === 'assert');
      const captures = b.evidence.filter(e => e.t === 'capture');
      checkSame(step.actionIds ?? [], b.related.map(a => String(a.id)), 'actionIds');
      checkSame(step.assertions ?? [], assertions.map(projectSourceRecord), 'assertions');
      checkSame(step.captures ?? [], captures.map(projectSourceRecord), 'captures');
      const associated = new Set([...b.owned, ...b.evidence].flatMap(event => {
        const id = sourceFacts.traceEventIds.get(sourceFacts.traceEvents[events.indexOf(event)]);
        return id ? event.t === 'action' ? [id, `${id}:screenshot`] : [id] : [];
      }));
      checkSame(step.eventIds, sourceFacts.events.filter(event => associated.has(event.id)).map(event => event.id), 'step.eventIds 显式引用');
      for (const event of b.evidence.filter(e => e.t === 'hover_cleanup_error')) {
        requireInput(step.observation.includes(`hover 清理失败：${String(event.error)}`), `分组 hover 清理失败未保存在原生报告中: ${sid}/${step.index}`, 'REPORT_STALE');
      }
      const lastValidation = Math.max(-1, ...b.evidence.filter(e => e.t !== 'screenshot').map(e => events.indexOf(e)));
      const lastAction = Math.max(-1, ...b.owned.map(e => events.indexOf(e)));
      const completion = b.evidence.filter(e => e.t === 'screenshot' && events.indexOf(e) > Math.max(lastValidation, lastAction)).at(-1);
      const image = completion ?? b.related.filter(a => a.screenshot_path || a.screenshot_error).at(-1);
      checkSame(step.screenshotPath, completion ? String(completion.path) : undefined, 'screenshotPath');
      checkSame(step.screenshotAfter, completion ? String(completion.after) : undefined, 'screenshotAfter');
      let screenshot: string | undefined;
      const imagePath = image?.path ?? image?.screenshot_path;
      if (image && !image.error && !image.screenshot_error && typeof imagePath === 'string') {
        requireInput(path.dirname(imagePath) === path.resolve(e2etRoot(env), 'workspace', 'screenshots')
          && path.basename(imagePath).startsWith(`${sid}_`) && imagePath.endsWith('.png'), `截图来源路径不符: ${sid}`);
        requireInput(!linkedPath(imagePath), `截图或父目录是 symlink: ${sid}`, 'SYMLINK');
        if (fs.lstatSync(imagePath, { throwIfNoEntry: false })) {
          const bytes = readFile(imagePath);
          if (bytes.length <= 2 * 1024 * 1024) screenshot = `data:image/png;base64,${bytes.toString('base64')}`;
        }
      }
      checkSame(step.screenshot, screenshot, '截图字节');
      const ids = [...new Set([...b.evidence.flatMap(e => {
        if (e.t === 'capture') return record(e.result) && record(e.result.from) && typeof e.result.from.req_id === 'string' ? [e.result.from.req_id] : [];
        return Array.isArray(e.evidence) ? e.evidence.flatMap(x => record(x) && typeof x.req_id === 'string' ? [x.req_id] : []) : [];
      }), ...b.owned.flatMap(a => Array.isArray(a.explicit_wait_api) ? a.explicit_wait_api.flatMap(w => record(w) && typeof w.req_id === 'string' ? [w.req_id] : []) : [])])];
      const apis = buildReportApis(requests, ids, readBody);
      // 比较 JSON 落盘形态，省略 undefined 并保留实际证据值。
      checkSame(step.apis ?? [], JSON.parse(JSON.stringify(apis)), '显式请求原始证据');
      const execute = b.related.filter(a => a.kind === 'execute' && Object.hasOwn(a, 'execute_result')).at(-1);
      checkSame(step.executeResult, execute ? { json: JSON.stringify(projectReportValue(execute.execute_result).value) ?? '缺失', truncated: record(execute.execute_result) && execute.execute_result._truncated === true } : undefined, 'executeResult');
      const failed = b.owned.some(a => record(a.result) && a.result.ok === false) || assertions.some(a => a.pass !== true && a.status !== 'not_run')
        || captures.some(capture => record(capture.result) && capture.result.ok === false)
        || b.evidence.some(e => e.t === 'hover_cleanup_error');
      const blocked = !assertions.length || assertions.some(assertion => assertion.status === 'not_run') || !screenshot || report.coverage?.plan !== null && !completion
        || b.owned.some(a => Array.isArray(a.settled_by) && a.settled_by.some(s => record(s) && s.kind === 'timeout'))
        || ids.some(id => !apis.some(a => a.reqId === id && a.respBody));
      const result = tighten(terminal(step.status), failed ? 'FAIL' : blocked ? 'BLOCKED' : 'PASS');
      return { ...step, sourceStatus: step.status, status: result.toLowerCase() as ReportStep['status'] };
    });
    const cases = report.cases.map(c => {
      const steps = checkSteps(c.steps, business, true);
      const diagnosticSteps = checkSteps(c.appendix ?? [], appendix, false);
      const acceptanceResult = sourceFacts.acceptanceCoverage?.result === 'FAIL' ? 'FAIL' : sourceFacts.acceptanceCoverage?.result === 'UNVERIFIED' ? 'BLOCKED' : 'PASS';
      const imageResult = sourceFacts.events.some(event => event.type === 'screenshot' && event.status === 'error') ? 'BLOCKED' : 'PASS';
      const result = tighten(c.result, report.result, report.conclusion as Result, sessionResult, sourceFacts.run.status, acceptanceResult, imageResult, ...steps.map(s => terminal(s.status)));
      return { ...c, id: `${sid}:${c.id}`, name: `[${sid}] ${c.name}`, steps, result,
        ...(c.appendix ? { appendix: diagnosticSteps } : {}), summary: c.summary ?? report.summary,
        url: report.url, env: report.env, toolVersion: report.toolVersion, sessionId: sid,
        coverage: c.coverage ?? report.coverage, sourceResult: c.result, sessionResult,
        source: { caseId: c.id, report: json, result: report.result, sessionResult: end?.result as string | undefined,
          metaResult: record(metaEnd) ? metaEnd.result as string : undefined, metaMissing },
        findings: [...new Set([...(report.findings ?? []), ...(c.findings ?? []), ...(metaMissing ? ['会话元数据缺失；汇总按 BLOCKED 保留'] : [])])],
        diagnostic_assertions: report.diagnostic_assertions as Ev[], diagnostic_observations: report.diagnostic_observations as Ev[],
        diagnostic_events: orphanEvidence,
      };
    });
    requireInput(seen.size === business.length + appendix.length, `最终 trace 存在未覆盖动作或分组: ${sid}`, 'REPORT_STALE');
    const steps = cases.flatMap(c => c.steps);
    const assertions = steps.flatMap(s => s.assertions ?? []);
    return { cases, mocked: report.mocked, source: { session_id: sid, json, html: path.join(dir, 'report', 'report.html'),
      source_result: report.result, trace_result: end?.result ?? null, meta_result: record(metaEnd) ? metaEnd.result : null,
      meta_missing: metaMissing, conclusion: tighten(...cases.map(c => c.result)), cases: cases.length, steps: steps.length,
      asserts: { total: assertions.length, pass: assertions.filter(a => a.pass === true).length } } };
  });

  const cases = sources.flatMap(s => s.cases);
  const steps = cases.flatMap(c => c.steps);
  const assertions = steps.flatMap(s => s.assertions ?? []);
  const conclusion = tighten(...cases.map(c => c.result));
  const report: ReportData = {
    report_schema_version: 2, title: String(projectReportValue(title || 'E2E 原生会话报告汇总').value), url: '', env: [...new Set(cases.map(c => c.env))].join(' / '),
    toolVersion: [...new Set(cases.map(c => c.toolVersion))].join(' / '), sessionId: sids.join(', '),
    result: conclusion, mocked: sources.some(s => s.mocked),
    summary: `聚合 ${sids.length} 份原生报告、${cases.length} 个用例、${steps.length} 个业务步骤、${assertions.length} 条断言；仅代表输入报告的验证范围，不能证明完整需求覆盖。各来源终态、环境和覆盖边界见用例详情。`,
    cases, coverage: {
      plan: null,
      executed: cases.flatMap(c => (c.coverage?.executed ?? c.steps.map(s => s.action)).map(n => `[${c.id}] ${n}`)),
      missing: cases.flatMap(c => (c.coverage?.missing ?? []).map(n => `[${c.id}] ${n}`)),
      unplanned: cases.flatMap(c => (c.coverage?.unplanned ?? []).map(n => `[${c.id}] ${n}`)),
    },
  };
  const data = { ...report, conclusion, sources: sources.map(s => s.source), stats: { cases: cases.length, steps: steps.length,
    asserts: { total: assertions.length, pass: assertions.filter(a => a.pass === true).length } } };
  const html = renderReportHtml(report);
  const reportsDir = path.join(e2etRoot(env), 'workspace', 'reports');
  requireInput(!linkedPath(reportsDir), '报告输出目录或父目录是 symlink', 'SYMLINK');
  ensurePrivateDir(reportsDir, true);
  const outDir = fs.mkdtempSync(path.join(reportsDir, 'merge-'));
  fs.chmodSync(outDir, 0o700);
  const jsonPath = path.join(outDir, 'report.json'), htmlPath = path.join(outDir, 'report.html');
  for (const [file, content] of [[jsonPath, JSON.stringify(data, null, 2)], [htmlPath, html]]) {
    fs.writeFileSync(file, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  }
  return { report_dir: outDir, json: jsonPath, html: htmlPath, conclusion, ...data.stats, sources: data.sources };
}
