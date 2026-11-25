import * as fs from 'node:fs';
import * as path from 'node:path';
import { traceDir, e2etRoot } from '../daemon/session-meta.js';
import { ensurePrivateDir, readTraceBody, readTraceEvents } from '../daemon/trace.js';
import type { OperationResult } from '../operation-result.js';
import { buildReportApis } from './merge.js';
import { renderReportHtml, type ReportCase, type ReportData, type ReportStep, type ReportStepApi } from '../shared/report-render.js';

export interface SessionReportOptions {
  title?: string;
  summary?: string;
  findings?: string;
  plan?: string;
  stepTitles?: string;
}

export interface SessionReportData {
  report_dir: string;
  json: string;
  html: string;
  conclusion: 'PASS' | 'FAIL' | 'BLOCKED';
  asserts: { total: number; pass: number };
  mocked: boolean;
  timeouts: number;
}

type Ev = Record<string, unknown>;

function failure(code: string, message: string, hint: string | undefined, kind: 'usage' | 'validation' | 'environment') {
  return { ok: false as const, error: hint ? { code, message, hint, kind } : { code, message, kind } };
}

/** 生成会话报告；文件系统未捕获异常继续抛给 CLI 转 FATAL。 */
export function generateSessionReport(env: NodeJS.ProcessEnv, sid: string, options: SessionReportOptions = {}): OperationResult<SessionReportData> {
  const dir = traceDir(sid, env);
  const traceFile = path.join(dir, 'trace.jsonl');
  if (!fs.existsSync(traceFile)) {
    return failure('NOT_FOUND', `会话 trace 不存在: ${sid}`, 'e2et session list', 'validation');
  }
  const events = readTraceEvents(sid);
  // ── 分类事件 ──
  const sessionEv = events.find(e => e.t === 'session') as Record<string, unknown> | undefined;
  const navEvents = events.filter(e => e.t === 'navigation');
  const actionEvents = events.filter(e => e.t === 'action');
  const requestEvents = events.filter(e => e.t === 'request');
  const assertEvents = events.filter(e => e.t === 'assert');
  const sessionEndEv = events.find(e => e.t === 'session_end') as Record<string, unknown> | undefined;

  // ── 基础信息 ──
  const envStr = String(sessionEv?.env ?? 'pre');
  const toolVersion = String(sessionEv?.tool_version ?? '');
  const firstNav = navEvents[0] as Record<string, unknown> | undefined;
  const url = String(firstNav?.to ?? '');
  let mocked = events.some(e => e.t === 'mock' && e.op === 'add');
  if (sessionEndEv?.mocked === true) mocked = true;

  // 一条证据只归一个组：自身 group 优先，缺字段才继承 after action。
  type Ev = Record<string, unknown>;
  const actionsById = new Map(actionEvents.map(a => [String(a.id), a]));
  const groupOf = (ev: Ev): string => {
    if (typeof ev.group === 'string' && ev.group) return ev.group;
    const action = actionsById.get(String(ev.after ?? ''));
    return typeof action?.group === 'string' ? action.group : '';
  };
  const evidenceEvents = events.filter(e => ['assert', 'capture', 'screenshot', 'hover_cleanup_error', 'observation', 'inspect'].includes(String(e.t)));
  const groupNames = [...new Set(events.flatMap(e => {
    const g = e.t === 'action' ? String(e.group ?? '') : evidenceEvents.includes(e) ? groupOf(e) : '';
    return g ? [g] : [];
  }))];
  type Bucket = { name: string; owned: Ev[]; related: Ev[]; evidence: Ev[] };
  const buckets: Bucket[] = groupNames.map(name => {
    const owned = actionEvents.filter(a => a.group === name);
    const evidence = evidenceEvents.filter(e => groupOf(e) === name);
    const related = [...new Set([...owned, ...evidence.flatMap(e => {
      const a = actionsById.get(String(e.after ?? ''));
      return a ? [a] : [];
    })])];
    return { name, owned, related, evidence };
  });
  const diagnostics: Bucket[] = actionEvents.filter(a => !a.group).map(a => ({
    name: String(a.intent ?? a.kind ?? ''), owned: [a], related: [a],
    evidence: evidenceEvents.filter(e => String(e.after ?? '') === String(a.id) && !groupOf(e)),
  }));
  // 无 group 的调试也使用同一判定，capture-only 不再保留旧假绿分支。
  const business = groupNames.length ? buckets : diagnostics;
  const appendixBuckets = groupNames.length ? diagnostics : [];
  const format = (v: unknown): string => typeof v === 'string' ? v : JSON.stringify(v) ?? '缺失';
  const brief = (v: unknown, limit = 160): string => {
    const raw = format(v);
    return raw.length > limit ? `${raw.slice(0, limit)}…共${raw.length}字` : raw;
  };
  const recordOf = (value: unknown): Ev | undefined =>
    value && typeof value === 'object' && !Array.isArray(value) ? value as Ev : undefined;
  const kindExpect = (a: Ev): Ev | undefined => {
    const expect = recordOf(a.expect);
    return recordOf(expect?.[String(a.kind ?? '')]) ?? expect;
  };
  const targetOf = (a: Ev): string => {
    const name = recordOf(a.target)?.name;
    if (typeof name === 'string' && name) return name;
    const actualName = recordOf(a.actual)?.name;
    if (typeof actualName === 'string' && actualName) return actualName;
    if (typeof a.expect === 'string') return a.expect;
    const expect = kindExpect(a);
    return format(expect?.target ?? expect?.locator ?? expect);
  };
  /** 路径未命中诊断文案：从 evidence 里找 path_status='missing' 的条目，拼前缀 + keys/length。无证据返回空串。 */
  const formatMissingDiag = (a: Ev): string => {
    if (a.path_status !== 'missing') return '';
    const ev = Array.isArray(a.evidence) ? a.evidence.find((e: Ev) => e?.path_status === 'missing') : undefined;
    if (!ev) return '（路径未命中）';
    const prefix = ev.resolved_prefix;
    const prefixStr = typeof prefix === 'string' && prefix ? prefix : '（根）';
    if (Array.isArray(ev.available_keys)) return `（路径未命中；最长前缀 ${prefixStr}，该层可用键 ${ev.available_keys.slice(0, 5).join(', ')}）`;
    if (typeof ev.array_length === 'number') return `（路径未命中；最长前缀 ${prefixStr}，数组长度 ${ev.array_length}）`;
    return `（路径未命中；最长前缀 ${prefixStr}）`;
  };
  function observed(a: Ev): string {
    const actual = a.actual as Record<string, unknown> | undefined;
    if (a.kind === 'text') {
      const expect = kindExpect(a);
      const wanted = typeof a.expect === 'string' ? a.expect : expect?.contains;
      const got = typeof a.actual === 'string' ? a.actual : actual?.snippet;
      if (a.pass === true) return `文案${wanted !== undefined ? `命中“${brief(wanted)}”` : '命中'}`;
      return `文案${wanted !== undefined ? `期望“${brief(wanted)}”` : ''}：未命中；实际片段：${got === undefined ? '未采集' : brief(got)}`;
    }
    if (a.kind === 'field' || a.kind === 'field_value') {
      const expect = kindExpect(a);
      const got = recordOf(a.actual)?.value;
      return `字段“${format(expect?.label ?? a.label)}”实际值：${got === undefined ? '未采集' : brief(got)}`;
    }
    if (a.kind === 'absent') return `目标“${targetOf(a)}”：${a.pass === true ? '不可见；无该校验错误/浮层' : '仍可见'}`;
    if (a.kind === 'visible') return `目标“${targetOf(a)}”：${a.pass === true ? '可见' : '不可见'}`;
    if (a.kind === 'data') {
      // P2：页面数据断言展示源 + present/实际值（actual 已脱敏）
      const expect = a.expect as Ev | undefined;
      const present = actual?.present === true;
      const err = (actual as { error?: { code?: string } } | undefined)?.error;
      const src = JSON.stringify((expect as { source?: unknown } | undefined)?.source ?? '');
      if (err) return `页面数据断言（${src}）读取失败（${String(err.code ?? 'unknown')}）`;
      return `页面数据断言（${src}）：实测 present=${present}${actual?.value !== undefined ? `, value=${format(actual.value)}` : ''}`;
    }
    if (a.kind === 'api' || a.kind === 'request') {
      const expect = kindExpect(a);
      const expected = `${format(expect?.op)} ${brief(expect?.value)}`;
      if (a.path_status === 'missing') return `接口字段 ${format(expect?.path)}：期望 ${expected} ${formatMissingDiag(a)}`;
      return `接口字段 ${format(expect?.path)}：期望 ${expected}；实际 ${a.actual === undefined ? '未采集' : brief(a.actual)}`;
    }
    return `实测${String(a.kind ?? '')}：${format(a.actual)}`;
  }
  function observedObservation(o: Ev): string {
    const result = o.result as Ev | undefined;
    const src = JSON.stringify(o.source ?? '');
    const doc = o.document as Ev | undefined;
    const where = `${String(o.target_id ?? '')}${doc ? `/${String(doc.frame_id ?? '')}` : ''}${o.nav ? `/${String(o.nav)}` : ''}`;
    if (result?.ok !== true) {
      const err = (result as { error?: { code?: string } } | undefined)?.error;
      return `页面数据观察（${src}，${where}）读取失败（${String(err?.code ?? 'unknown')}）`;
    }
    return `页面数据观察（${src}，${where}）：present=${result.present === true}${result.value !== undefined ? `, value=${brief(result.value)}` : ', value=未采集'}`;
  }
  function observedInspect(i: Ev): string {
    const candidates = Array.isArray(i.candidates) ? i.candidates.length : 0;
    const total = typeof i.total === 'number' ? i.total : 0;
    return `UI 诊断 ${String(i.check ?? '')}${i.frame ? `（frame）` : ''}：候选 ${candidates}/${total}${i.truncated === true ? '（截断）' : ''}`;
  }
  const shotsDir = path.resolve(e2etRoot(env), 'workspace', 'screenshots');
  const noFollow = (fs.constants as unknown as Record<string, number>).O_NOFOLLOW ?? 0;
  function encodeImage(p: string): string {
    if (path.dirname(p) !== shotsDir || !path.basename(p).startsWith(sid + '_') || !p.endsWith('.png')) throw new Error('截图路径不属于本会话截图目录');
    ensurePrivateDir(shotsDir);
    if (!fs.lstatSync(p).isFile() || fs.lstatSync(p).isSymbolicLink()) throw new Error('截图不是安全的普通文件');
    const fd = fs.openSync(p, fs.constants.O_RDONLY | noFollow);
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile()) throw new Error('截图不是普通文件');
      if (st.size > 2 * 1024 * 1024) throw new Error('截图超过 2MB，未嵌入报告');
      return 'data:image/png;base64,' + fs.readFileSync(fd).toString('base64');
    } finally { fs.closeSync(fd); }
  }
  function buildApis(ids: string[]): ReportStepApi[] {
    return buildReportApis(requestEvents, ids, ref => typeof ref === 'string' ? readTraceBody(sid, ref) ?? undefined : undefined);
  }
  const idsOf = (e: Ev): string[] => {
    if (e.t === 'capture') {
      const id = (e.from as Ev | undefined)?.req_id;
      return typeof id === 'string' ? [id] : [];
    }
    return Array.isArray(e.evidence) ? e.evidence.flatMap((x: Ev) => typeof x.req_id === 'string' ? [x.req_id] : []) : [];
  };
  function buildStep(b: Bucket, index: number): ReportStep {
    const assertions = b.evidence.filter(e => e.t === 'assert');
    const errors = b.evidence.filter(e => e.t === 'hover_cleanup_error');
    // P2：观察证据进已有证据归组（after/显式 group 原单归属策略）
    const observations = b.evidence.filter(e => e.t === 'observation');
    const inspections = b.evidence.filter(e => e.t === 'inspect');
    const actionFailed = b.owned.some(a => (a.result as Ev)?.ok === false);
    const timeout = b.owned.some(a => Array.isArray(a.settled_by) && a.settled_by.some((s: Ev) => s.kind === 'timeout'));
    const obsFailed = observations.some(o => (o.result as Ev)?.ok !== true);
    const fail = actionFailed || assertions.some(a => a.pass !== true) || errors.length > 0;
    const facts = assertions.map(observed);
    facts.push(...observations.map(observedObservation));
    facts.push(...inspections.map(observedInspect));
    if (actionFailed) facts.push('动作执行失败');
    if (timeout) facts.push('执行超时');
    facts.push(...errors.map(e => `hover 清理失败：${String(e.error)}`));
    if (obsFailed) facts.push('页面数据观察读取失败（诊断性证据，不改写断言结论）');
    if (!assertions.length) facts.push('未校验（0 断言），不代表需求通过');
    const captures = b.evidence.filter(e => e.t === 'capture');
    // capture 原始结构留明细，不把 DOM JSON 或机器变量名堆在主体。
    const details = [...assertions.map(a => { const missingDiag = (a.kind === 'api' || a.kind === 'request') && a.path_status === 'missing' ? formatMissingDiag(a) : ''; return `${String(a.kind)}；期望：${format(a.expect)}；${missingDiag ? missingDiag : `实际：${format(a.actual)}`}${a.pass === true ? '' : ' [失败]'}`; }), ...observations.map(o => `observation ${String(o.id ?? '')}；${observedObservation(o)}`), ...inspections.map(i => `inspect ${String(i.check ?? '')}；${observedInspect(i)}`), ...captures.map(c => `capture ${String(c.as)}：${format(c.value)}；来源：${format(c.from)}`)];
    const lastValidation = Math.max(-1, ...b.evidence.filter(e => e.t !== 'screenshot').map(e => events.indexOf(e)));
    const lastAction = Math.max(-1, ...b.owned.map(e => events.indexOf(e)));
    const completion = b.evidence.filter(e => e.t === 'screenshot' && events.indexOf(e) > Math.max(lastValidation, lastAction)).at(-1);
    const lastAuto = b.related.filter(e => e.screenshot_path || e.screenshot_error).at(-1);
    let screenshot: string | undefined;
    let screenshotNotice: string | undefined;
    const image = completion ?? lastAuto;
    if (image?.error || image?.screenshot_error) screenshotNotice = `截图失败：${String(image.error ?? image.screenshot_error)}`;
    else if (typeof (image?.path ?? image?.screenshot_path) === 'string') {
      try { screenshot = encodeImage(String(image?.path ?? image?.screenshot_path)); }
      catch (e) { screenshotNotice = `截图失败：${(e as Error).message}`; }
    }
    if (!screenshotNotice && !screenshot) screenshotNotice = '截图缺失';
    if (options.plan && !completion) screenshotNotice = `${screenshotNotice ? screenshotNotice + '；' : ''}完成态截图缺失（自动动作截图不能替代断言后截图）`;
    const waitIds = b.owned.flatMap(a => Array.isArray(a.explicit_wait_api) ? a.explicit_wait_api.flatMap((w: Ev) => typeof w.req_id === 'string' ? [w.req_id] : []) : []);
    const referenced = [...new Set([...b.evidence.flatMap(idsOf), ...waitIds])];
    const apis = buildApis(referenced);
    const missingApi = referenced.some(id => !apis.some(a => a.reqId === id && a.respBody));
    if (missingApi) facts.push('引用接口的原始响应证据缺失');
    const status: ReportStep['status'] = fail ? 'fail' : !assertions.length || timeout || !screenshot || (options.plan && !completion) || missingApi ? 'blocked' : 'pass';
    const first = b.related[0], last = b.related.at(-1);
    const ms = Number(last?.ts_end ?? last?.ts ?? 0) - Number(first?.ts ?? 0);
    const execute = b.related.filter(a => a.kind === 'execute' && Object.hasOwn(a, 'execute_result')).at(-1);
    return { index, status, group: groupNames.includes(b.name) ? b.name : undefined, action: b.name,
      observation: facts.join('；'), duration: ms > 0 ? `${ms}ms` : '', assertDetails: details,
      assertions, captures, actionIds: b.related.map(a => String(a.id)), apis,
      ...(screenshot ? { screenshot } : {}), ...(screenshotNotice ? { screenshotNotice } : {}),
      ...(completion ? { screenshotPath: String(completion.path), screenshotAfter: String(completion.after) } : {}),
      ...(execute ? { executeResult: { json: typeof execute.execute_result === 'string' ? JSON.stringify(execute.execute_result) : JSON.stringify(execute.execute_result) ?? '缺失', truncated: (execute.execute_result as Ev)?._truncated === true } } : {}),
    };
  }
  let steps = business.map((b, i) => buildStep(b, i + 1));
  let stepTitles: Record<string, string> | undefined;
  const appendix = appendixBuckets.map((b,i) => buildStep(b,i+1));
  let planNames: string[] | undefined;
  if (options.plan) {
    let raw: unknown;
    try { raw = JSON.parse(fs.readFileSync(options.plan, 'utf8')); }
    catch (e) { return failure('USAGE', `plan 文件读取/解析失败: ${(e as Error).message}`, undefined, 'usage'); }
    if (!Array.isArray(raw) || !raw.length) return failure('USAGE', 'plan 必须是非空 JSON 字符串数组，不能是空数组', undefined, 'usage');
    if (raw.some(n => typeof n !== 'string' || !n.trim())) return failure('USAGE', 'plan 元素必须是非空字符串', undefined, 'usage');
    if (new Set(raw).size !== raw.length) return failure('USAGE', 'plan 含重复 group', undefined, 'usage');
    planNames = raw as string[];
    const byGroup = new Map(steps.filter(s => s.group).map(s => [s.group!, s]));
    // plan 只安排顺序和补漏，不投影删除任何真实业务步骤，也不重建已有 FAIL。
    const planned = planNames.map(name => byGroup.get(name) ?? { index: 0, group: name, status: 'blocked' as const, action: name, observation: '未执行（plan 核销：该业务步骤未出现在 trace 中）', duration: '', screenshotNotice: '完成态截图缺失' });
    const extras = steps.filter(s => !s.group || !planNames!.includes(s.group)).map(s => ({ ...s, observation: `计划外已执行；${s.observation}` }));
    steps = [...planned, ...extras].map((s,i) => ({ ...s, index: i + 1 }));
  }
  if (options.stepTitles) {
    let raw: unknown;
    try { raw = JSON.parse(fs.readFileSync(options.stepTitles, 'utf8')); }
    catch (e) { return failure('USAGE', `step-titles 文件读取/解析失败: ${(e as Error).message}`, undefined, 'usage'); }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return failure('USAGE', 'step-titles 必须是非空 JSON 对象', undefined, 'usage');
    }
    const entries = Object.entries(raw as Record<string, unknown>);
    if (!entries.length) return failure('USAGE', 'step-titles 不能是空对象', undefined, 'usage');
    if (entries.some(([, title]) => typeof title !== 'string' || !title.trim())) {
      return failure('USAGE', 'step-titles 的值必须是非空字符串', undefined, 'usage');
    }
    const finalGroups = new Set(steps.flatMap(s => typeof s.group === 'string' && s.group ? [s.group] : []));
    const unknown = entries.map(([group]) => group).filter(group => !finalGroups.has(group));
    if (unknown.length) {
      return failure('USAGE', `step-titles 含未知 group: ${unknown.join(', ')}`, undefined, 'usage');
    }
    stepTitles = Object.fromEntries(entries) as Record<string, string>;
    steps = steps.map(s => s.group && Object.hasOwn(stepTitles!, s.group)
      ? { ...s, action: stepTitles![s.group] }
      : s);
  }
  const conclusion = steps.some(s => s.status === 'fail') ? 'FAIL' : !steps.length || steps.some(s => s.status === 'blocked') ? 'BLOCKED' : 'PASS';
  const asserts = business.flatMap(b => b.evidence.filter(e => e.t === 'assert'));
  const assertTotal = asserts.length, assertPass = asserts.filter(a => a.pass === true).length;
  const timeouts = business.flatMap(b => b.owned.filter(a => Array.isArray(a.settled_by) && a.settled_by.some((s: Ev) => s.kind === 'timeout')).map(a => ({ action_id: String(a.id), intent: String(a.intent) })));
  const findingsList = [...(options.findings?.split(';').map(s => s.trim()).filter(Boolean) ?? []),
    ...appendix.filter(s => s.status === 'fail').map(s => `诊断失败（不改写业务结论）：${s.action}；${s.observation}`),
    ...events.filter(e => e.t === 'hover_cleanup_error' && !e.after).map(e => `会话清理失败：${String(e.error)}`),
    // P2：孤立观察（无 group 且 after 不指向任何 action）进诊断附录，不伪造 action 计数或业务 PASS
    ...events.filter(e => e.t === 'observation' && !groupOf(e) && !actionEvents.some(a => String(a.id) === String(e.after ?? ''))).map(e => `孤立观察（诊断附录，不计入业务步骤）：${observedObservation(e)}`)];
  const failedApi = asserts.filter(a => a.pass !== true && (a.kind === 'api' || a.kind === 'request'));
  const backendRows = failedApi.flatMap(a => {
    const ids = idsOf(a), apis = buildApis(ids);
    return (apis.length ? apis : [{ url: '缺失：未取得接口', traceId: '', time: '', respBody: '', reqBody: '' }]).map(api => ({
      api: api.url, traceId: api.traceId || '缺失：响应头未取得 traceId', time: api.time || '缺失：请求时间',
      failure: `字段 ${format(kindExpect(a)?.path)}；期望 ${format(kindExpect(a)?.op)} ${brief(kindExpect(a)?.value)}；实际 ${a.actual === undefined ? '未采集' : brief(a.actual)}`,
      response: api.respBody || '缺失：响应 body',
      params: api.reqBody || '缺失：未采集请求入参',
    }));
  });
  const backendInfo = backendRows.length ? {
    api: backendRows.map(b => b.api).join('\n'), traceId: backendRows.map(b => b.traceId).join('\n'),
    time: backendRows.map(b => b.time).join('\n'), failure: backendRows.map(b => b.failure).join('\n'),
    response: backendRows.map(b => b.response).join('\n'), params: backendRows.map(b => b.params).join('\n'),
  } : undefined;
  const title = options.title || `E2E 会话报告 ${sid}`;
  function byNameExists(n: string): boolean { return buckets.some(b => b.name === n); }
  const businessTitle = (group: string): string =>
    stepTitles?.[group] ?? steps.find(step => step.group === group)?.action ?? group;
  const coverage: ReportData['coverage'] = {
    plan: planNames?.map(businessTitle) ?? null,
    executed: buckets.map(bucket => businessTitle(bucket.name)),
    missing: planNames?.filter(name => !byNameExists(name)).map(businessTitle) ?? [],
    unplanned: buckets.filter(bucket => planNames && !planNames.includes(bucket.name)).map(bucket => businessTitle(bucket.name)),
  };
  const reportCase: ReportCase = { id: 'TC-01', name: title, result: conclusion, steps,
    ...(appendix.length ? { appendix } : {}), ...(findingsList.length ? { findings: findingsList } : {}), ...(backendInfo ? { backendInfo } : {}) };
  const executed = actionEvents.filter(a => (a.result as Ev)?.ok === true).length;
  const assertionSummary = assertTotal
    ? `已覆盖 ${assertTotal} 条断言，${assertPass} 条通过`
    : '未覆盖任何断言';
  const coverageBoundary = planNames
    ? `覆盖计划 ${planNames.filter(byNameExists).length}/${planNames.length} 项已执行；缺失 ${coverage.missing.length} 项；计划外 ${coverage.unplanned.length} 项`
    : '未提供覆盖计划，仅代表已执行断言，不能证明完整需求覆盖';
  const summaryParts = [
    `${steps.filter(s => s.status === 'pass').length}/${steps.length} 业务步骤通过`,
    assertionSummary,
    coverageBoundary,
    ...(options.summary ? [`补充说明：${options.summary}`] : []),
  ];
  const reportData: ReportData = { title, url, env: envStr, result: conclusion, summary: summaryParts.join('；'), sessionId: sid, toolVersion, mocked, cases: [reportCase], coverage, findings: findingsList };

  // ── 写文件 ──
  const reportDir = path.join(dir, 'report');
  ensurePrivateDir(reportDir);
  const jsonPath = path.join(reportDir, 'report.json');
  const htmlPath = path.join(reportDir, 'report.html');
  const report = {
    ...reportData,
    coverage,
    actions: { total: actionEvents.length, success: executed },
    diagnostic_assertions: appendixBuckets.flatMap(b => b.evidence.filter(e => e.t === "assert")),
    // P2：孤立观察完整留档（无 group 且 after 不指向任何 action；0 断言仍 BLOCKED，不伪造 PASS）
    diagnostic_observations: events.filter(e => e.t === 'observation' && !groupOf(e) && !actionEvents.some(a => String(a.id) === String(e.after ?? ''))),
    session_id: sid,
    conclusion,
    mocked,
    asserts: { total: assertTotal, pass: assertPass },
    timeouts: timeouts.length,
    assert_details: asserts,
    timeout_actions: timeouts,
  };
  for (const [file, content] of [[jsonPath, JSON.stringify(report, null, 2)], [htmlPath, renderReportHtml(reportData)]]) {
    if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error('unsafe report file');
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | noFollow, 0o600);
    try {
      if (!fs.fstatSync(fd).isFile()) throw new Error('unsafe report file');
      fs.fchmodSync(fd, 0o600);
      fs.ftruncateSync(fd);
      fs.writeFileSync(fd, content, 'utf8');
    } finally { fs.closeSync(fd); }
  }
  return { ok: true, data: { report_dir: reportDir, json: jsonPath, html: htmlPath, conclusion, asserts: { total: assertTotal, pass: assertPass }, mocked, timeouts: timeouts.length } };
}
