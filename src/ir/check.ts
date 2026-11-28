/**
 * ir check：技术校验道（trace-ir-spec.md + final-plan 2.3）。
 * 1 schema / 2 locator 可达性 / 3 请求引用完整性 / 4 value 一致性 / 5 wait 一致性 / 6 refine
 * 不做内容 DLP：正常 API/字段名/文案允许，不承诺识别业务文本中的未知秘密。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { targetToLocator, settledToWait, parseFrame, recordedReportRef } from './build.js';
import { candidateToLocator } from '../shared/wait-locator.js';
import { parseIRv2, ValueSchema, type IRv2, type Step, type Assert, type ExpectEntry } from './schema.js';
import { isValidTemplate } from '../value-template.js';
import { TRACE_SCHEMA_VERSION } from '../shared/versions.js';
import { parseTrace, readTrace, type ParsedTrace, type RequestEvent, type AssertEvent } from './trace-reader.js';
import { traceValueToIR } from './trace-reader.js';
import { validateSelectionFact } from './selection-validate.js';
import { validateActionSavedValue } from './action-output.js';

export interface CheckFailure {
  rule: string;
  step?: string;
  message: string;
}

export interface CheckResult {
  passed: boolean;
  failures: CheckFailure[];
  /** 有 trace 时跑动态校验道，无 trace 时跳过并在此列出 */
  skipped: string[];
}

export interface CheckOptions {
  /** 关联 trace 的 session id；提供时跑动态校验道（2/3/5），否则跳过 */
  sessionId?: string;
  /** 测试注入：直接提供 trace（覆盖 sessionId） */
  trace?: ParsedTrace;
  /** 测试注入：覆盖 traceRoot */
  traceRootDir?: string;
}

function collectApiRefs(step: Step): Array<{ ref: { path: string; nav: number; call_index: number }; where: string }> {
  const out: Array<{ ref: { path: string; nav: number; call_index: number }; where: string }> = [];
  for (const w of step.wait ?? []) {
    if ('api' in w) out.push({ ref: w.api, where: `step ${step.id} wait.api` });
  }
  for (const c of step.checks ?? []) {
    if ('assert' in c && c.assert) {
      const a = c.assert;
      if ('api' in a) out.push({ ref: a.api, where: `step ${step.id} assert.api` });
      if ('request' in a) out.push({ ref: a.request, where: `step ${step.id} assert.request` });
    }
    if ('capture' in c && c.capture) {
      if ('from_api' in c.capture) out.push({ ref: c.capture.from_api, where: `step ${step.id} capture.from_api` });
    }
  }
  return out;
}

export function checkIr(input: unknown, opts: CheckOptions = {}): CheckResult {
  const failures: CheckFailure[] = [];
  const skipped: string[] = [];

  // ── 道 1：Schema ──
  const parsed = parseIRv2(input);
  if (!parsed.ok) {
    for (const i of parsed.error.issues) {
      failures.push({ rule: 'schema', message: `${i.path}: ${i.message}` });
    }
    return { passed: false, failures, skipped };
  }
  const ir = parsed.ir;

  // 解析 trace（可选）
  let trace: ParsedTrace | undefined;
  if (opts.trace) {
    trace = opts.trace;
  } else if (opts.sessionId) {
    try {
      const events = readTrace(opts.sessionId);
      if (events) trace = parseTrace(events);
      else failures.push({ rule: 'trace-evidence', message: `关联 trace 不存在: ${opts.sessionId}` });
    } catch (error) {
      failures.push({ rule: 'trace-version', message: (error as Error).message });
    }
  }
  if (trace && trace.session?.schema_version !== TRACE_SCHEMA_VERSION) failures.push({ rule: 'trace-version', message: `trace schema_version 必须是 ${TRACE_SCHEMA_VERSION}` });
  if (!trace) skipped.push('trace-absent: 跳过 report-metadata 报告引用元数据核对');

  const reqByNav = new Map<string, RequestEvent[]>();
  if (trace) {
    for (const r of trace.requests) {
      const key = r.nav;
      const arr = reqByNav.get(key) ?? [];
      arr.push(r);
      reqByNav.set(key, arr);
    }
  }

  // ── P4 道：provenance 真实来源与 trace 严格一致（缺失/不一致拒绝）──
  if (trace) {
    const session = trace.session;
    if (typeof session?.auth_source !== 'string' || session.auth_source === '' || typeof session?.browser_source !== 'string' || session.browser_source === '') {
      failures.push({ rule: 'provenance', message: 'trace session 事件缺失 auth_source/browser_source（旧 trace 需重新录制）' });
    } else if (ir.provenance.auth_source !== session.auth_source || ir.provenance.browser_source !== session.browser_source) {
      failures.push({ rule: 'provenance', message: `IR provenance 来源与 trace 不一致: IR auth_source=${ir.provenance.auth_source}/browser_source=${ir.provenance.browser_source} vs trace auth_source=${session.auth_source}/browser_source=${session.browser_source}` });
    }
  } else {
    skipped.push('trace-absent: 跳过 provenance 来源核对');
  }

  const checkReportRef = (ref: Step['report_ref'], recorded: Step['report_ref'], step: Step, where: string): void => {
    for (const field of ['group', 'source_event_id', 'check_id'] as const) {
      if (ref?.[field] !== undefined && ref[field] !== recorded?.[field]) {
        failures.push({ rule: 'report-metadata', step: step.id, message: `${where}.report_ref.${field} 与 trace 不一致（IR=${JSON.stringify(ref[field])} vs trace=${JSON.stringify(recorded?.[field])}）` });
      }
    }
  };

  // ── 道 2：Locator 可达性（trace 存在时校验主定位 matches==1）──
  if (trace) {
    for (const s of ir.steps) {
      const action = trace.actions.find((a) => a.id === s.trace_ref);
      if (!action) failures.push({ rule: 'trace-evidence', step: s.id, message: `trace_ref ${s.trace_ref} 在 trace 中不存在` });
      checkReportRef(s.report_ref, action ? recordedReportRef(action) : undefined, s, 'step');
      if (!s.locator && !s.fallback?.length) continue;
      if (!action?.target?.candidates?.length) {
        failures.push({ rule: 'locator-reachable', step: s.id, message: '缺少对应 action 的候选定位证据' });
        continue;
      }
      if (action.target.matches !== undefined && action.target.matches !== 1) {
        failures.push({ rule: 'locator-reachable', step: s.id, message: `主定位 matches=${action.target.matches} != 1，元素不唯一` });
      }
      const candidates = action.target.candidates.map(candidateToLocator);
      for (const locator of [s.locator, ...(s.fallback ?? [])]) {
        if (locator && !candidates.some((candidate) => isDeepStrictEqual(candidate, locator))) {
          failures.push({ rule: 'locator-reachable', step: s.id, message: `IR locator ${JSON.stringify(locator)} 没有 matches=1 的对应候选证据` });
        }
      }
    }
    // 选择事实动态核对（F10/F12）：共享 validator 先跑；再核 step.action 与 trace kind、
    // option/options/path/filter_text/selection/save_as 与对应 trace 逐字段一致、select 的
    // step.value 与 traceValueToIR(action.value) 声明一致、以及同一成功保存值关系。
    for (const s of ir.steps) {
      if (s.action !== 'select' && s.action !== 'choose' && s.action !== 'category') continue;
      const action = trace.actions.find((a) => a.id === s.trace_ref);
      if (!action) continue;
      const stepArgs = (s.args ?? {}) as Record<string, unknown>;
      for (const err of validateSelectionFact(s.action, stepArgs)) {
        failures.push({ rule: 'selection-consistency', step: s.id, message: err });
      }
      if (action.kind !== s.action) {
        failures.push({ rule: 'selection-consistency', step: s.id, message: `step.action ${s.action} 与 trace action kind ${action.kind} 不一致` });
      }
      const traceArgs = (action.args ?? {}) as Record<string, unknown>;
      for (const key of ['option', 'options', 'path', 'filter_text', 'selection'] as const) {
        if (!isDeepStrictEqual(stepArgs[key], traceArgs[key])) {
          failures.push({ rule: 'selection-consistency', step: s.id, message: `args.${key} 与 trace action ${s.trace_ref} 不一致（IR=${JSON.stringify(stepArgs[key])} vs trace=${JSON.stringify(traceArgs[key])}）` });
        }
      }
      if (s.save_as !== action.save_as) {
        failures.push({ rule: 'selection-consistency', step: s.id, message: `step.save_as "${String(s.save_as)}" 与 trace action save_as "${String(action.save_as)}" 不一致` });
      }
      if (s.action === 'select' && !isDeepStrictEqual(s.value, traceValueToIR(action.value))) {
        failures.push({ rule: 'selection-consistency', step: s.id, message: `step.value 与 trace 值声明不一致（${JSON.stringify(s.value)} vs ${JSON.stringify(traceValueToIR(action.value))}）` });
      }
      // §8：保存值一致性统一走 validateActionSavedValue（build/check 共用，不留第二套输出推断）
      for (const err of validateActionSavedValue(action)) {
        failures.push({ rule: 'output-consistency', step: s.id, message: err });
      }
    }
  }

  // ── §8 道：非选择动作 save_as 输出一致性（trace 存在时）──
  if (trace) {
    for (const s of ir.steps) {
      if (!s.save_as) continue;
      if (s.action === 'select' || s.action === 'choose' || s.action === 'category') continue; // 已在 selection-consistency 核
      const action = trace.actions.find((a) => a.id === s.trace_ref);
      if (!action) continue;
      for (const err of validateActionSavedValue(action)) {
        failures.push({ rule: 'output-consistency', step: s.id, message: err });
      }
    }
  } else {
    skipped.push('trace-absent: 跳过非选择动作 save_as 输出核对');
  }

  // ── §4/F10 道：fill_form 字段定位/顺序与 trace 一致（trace 存在时）──
  if (trace) {
    for (const s of ir.steps) {
      if (s.action !== 'fill_form') continue;
      const action = trace.actions.find((a) => a.id === s.trace_ref);
      if (!action) continue;
      const stepArgs = (s.args ?? {}) as Record<string, unknown>;
      const traceArgs = (action.args ?? {}) as Record<string, unknown>;
      const stepFields = (stepArgs.fields ?? {}) as Record<string, unknown>;
      const traceFields = (traceArgs.fields ?? {}) as Record<string, unknown>;
      for (const [name, field] of Object.entries(stepFields)) {
        if (!isDeepStrictEqual(field, traceValueToIR(traceFields[name] as never))) {
          failures.push({ rule: 'fill-form-consistency', step: s.id, message: `fields["${name}"] 值声明与 trace 不一致（${JSON.stringify(field)} vs ${JSON.stringify(traceValueToIR(traceFields[name] as never))}）` });
        }
      }
      const traceTargets = (traceArgs.field_targets ?? {}) as Record<string, unknown>;
      const stepLocators = (stepArgs.field_locators ?? {}) as Record<string, unknown>;
      for (const [name, raw] of Object.entries(traceTargets)) {
        const expected = raw && typeof raw === 'object' ? targetToLocator({ target: raw as never }) : undefined;
        if (!expected || !isDeepStrictEqual(stepLocators[name], expected)) {
          failures.push({ rule: 'fill-form-consistency', step: s.id, message: `field_locators["${name}"] 与该 action 真实 field_targets 不一致（${JSON.stringify(stepLocators[name])} vs ${JSON.stringify(expected)}）` });
        }
      }
      if (!isDeepStrictEqual(stepArgs.field_order, traceArgs.field_order)) {
        failures.push({ rule: 'fill-form-consistency', step: s.id, message: `field_order 与 trace 实际写入顺序不一致（${JSON.stringify(stepArgs.field_order)} vs ${JSON.stringify(traceArgs.field_order)}）` });
      }
    }
  } else {
    skipped.push('trace-absent: 跳过 fill_form 字段定位/顺序核对');
  }

  // ── 道 3：请求引用完整性（path+nav+call_index 在 trace 中存在）──
  if (trace) {
    for (const s of ir.steps) {
      for (const { ref, where } of collectApiRefs(s)) {
        const inNav = (reqByNav.get('n' + ref.nav) ?? []).filter((r) => r.path === ref.path && r.call_index === ref.call_index);
        if (inNav.length === 0) {
          failures.push({ rule: 'request-ref', step: s.id, message: `${where} 引用 {path:${ref.path},nav:${ref.nav},call_index:${ref.call_index}} 在 trace 中不存在` });
        }
      }
    }
  } else {
    skipped.push('trace-absent: 跳过道 3(请求引用完整性)');
  }

  // ── 道 4：Value 一致性（template 语法合法；ref 指向存在变量）──
  const refTargets = new Set<string>();
  for (const s of ir.steps) {
    const checkRef = (name: string): void => {
      if (!refTargets.has(name)) failures.push({ rule: 'value-consistency', step: s.id, message: `value.ref "${name}" 在前序 save_as 或 capture.as 中找不到` });
    };
    // Value 位置 1：step.value（在 save_as 之前检查 ref，能引用前序定义的变量）
    if (s.value) {
      const value = s.value;
      if ('template' in value) {
        if (!isValidTemplate(value.template)) failures.push({ rule: 'value-consistency', step: s.id, message: `template "${value.template}" 不含合法占位符` });
      } else if ('ref' in value) checkRef(value.ref);
    }
    // Value 位置 2：fill_form args.fields（逐字段检查）
    if (s.action === 'fill_form' && s.args?.fields && typeof s.args.fields === 'object') {
      for (const field of Object.values(s.args.fields)) {
        const parsed = ValueSchema.safeParse(field);
        if (!parsed.success) continue;
        const value = parsed.data;
        if ('template' in value) {
          if (!isValidTemplate(value.template)) failures.push({ rule: 'value-consistency', step: s.id, message: `template "${value.template}" 不含合法占位符` });
        } else if ('ref' in value) checkRef(value.ref);
      }
    }
    if (s.save_as) refTargets.add(s.save_as);
    for (const check of s.checks ?? []) {
      if ('capture' in check) {
        refTargets.add(check.capture.as);
      } else if ('assert' in check && 'field_value' in check.assert) {
        const value = check.assert.field_value.value;
        if ('ref' in value) checkRef(value.ref);
        if ('from_action' in value) {
          // from_action 引用 step.id，运行时 ValueContext 独立验证；check 只确认语法非空
          if (!value.from_action) failures.push({ rule: 'value-consistency', step: s.id, message: `value.from_action 为空` });
        }
      } else if ('assert' in check && 'text' in check.assert) {
        const val = (check.assert as { text: { value?: unknown } }).text.value;
        if (val !== null && val !== undefined && typeof val === 'object') {
          if ('ref' in (val as object)) checkRef((val as { ref: string }).ref);
          if ('template' in (val as object) && !isValidTemplate((val as { template: string }).template)) {
            failures.push({ rule: 'value-consistency', step: s.id, message: `text.value.template "${(val as { template: string }).template}" 不含合法占位符` });
          }
          if ('from_action' in (val as object) && !(val as { from_action: string }).from_action) failures.push({ rule: 'value-consistency', step: s.id, message: `text.value.from_action 为空` });
        }
      }
    }
  }

  // ── 道 5：Wait 一致性（api 引用在 trace 中存在）──
  if (trace) {
    for (const s of ir.steps) {
      const action = trace.actions.find((event) => event.id === s.trace_ref);
      const expected = action && settledToWait(action, new Map(trace.requests.map((request) => [request.id, request])), []);
      if (!action || expected === null || !isDeepStrictEqual(expected, s.wait ?? [])) {
        failures.push({ rule: 'wait-consistency', step: s.id, message: 'wait 数量、顺序、定位或条件与该 trace_ref 的 settled_by 不一致' });
      }
      for (const w of s.wait ?? []) {
        if ('api' in w) {
          const inNav = (reqByNav.get('n' + w.api.nav) ?? []).filter((r) => r.path === w.api.path && r.call_index === w.api.call_index);
          if (inNav.length === 0) {
            failures.push({ rule: 'wait-consistency', step: s.id, message: `wait.api {path:${w.api.path},nav:${w.api.nav},call_index:${w.api.call_index}} 在 trace 中不存在` });
          }
        }
      }
    }
  } else {
    skipped.push('trace-absent: 跳过道 5(wait 一致性)');
  }

  // ── Phase2 道 6：checks 与原 trace assert/capture 事件一对一核对 ──
  // 拒绝孤儿、漏检查、重复借证据、错序与额外检查；即使 action 没 locator 也检查 checks。
  // capture 不能漏；field/api/request 的显式来源必须与事件 value（known source）一致。
  if (trace) {
    const stepByTraceRef = new Map<string, Step>();
    for (const s of ir.steps) stepByTraceRef.set(s.trace_ref, s);
    const stepIndex = new Map<string, number>();
    ir.steps.forEach((s, i) => stepIndex.set(s.id, i));
    const OP_MAP: Record<string, string> = { '==': 'eq', '!=': 'ne', '>': 'gt', '<': 'lt', exists: 'exists', contains: 'contains' };
    /** 事件显式来源（value: TraceActionValue）与 IR Value 一致性：literal/ref/from_action 三态 */
    const checkKnownSource = (evValue: AssertEvent['value'], irValue: unknown, what: string, s: Step, i: number): void => {
      if (!evValue) {
        // 无来源声明：IR 必须是 literal（不转引用）；与事件期望 raw 的一致性由 build 产出的 literal 保证
        if (irValue !== null && typeof irValue === 'object' && ('ref' in (irValue as object) || 'from_action' in (irValue as object) || 'value_ref' in (irValue as object) || 'value_from_action' in (irValue as object) || 'template' in (irValue as object))) {
          failures.push({ rule: 'checks-mapping', step: s.id, message: `checks[${i}] ${what} 无 trace 显式来源，IR 不得转引用` });
        }
        return;
      }
      if (evValue.source_action) {
        const sourceStep = stepByTraceRef.get(evValue.source_action);
        if (!sourceStep) {
          failures.push({ rule: 'checks-mapping', step: s.id, message: `checks[${i}] ${what} 的来源动作 ${evValue.source_action} 不在 trace 对应 step 中` });
          return;
        }
        const expectId = (irValue as Record<string, unknown> | null | undefined)?.value_from_action ?? (irValue as Record<string, unknown> | null | undefined)?.from_action;
        if (expectId !== sourceStep.id) {
          failures.push({ rule: 'checks-mapping', step: s.id, message: `checks[${i}] ${what} from_action 与 trace 来源动作映射不一致（期望 ${String(expectId)}，实际 ${sourceStep.id}）` });
        }
        return;
      }
      if (evValue.origin === 'captured' && evValue.ref) {
        const expectRef = (irValue as Record<string, unknown> | null | undefined)?.value_ref ?? (irValue as Record<string, unknown> | null | undefined)?.ref;
        if (expectRef !== evValue.ref) {
          failures.push({ rule: 'checks-mapping', step: s.id, message: `checks[${i}] ${what} value_ref 与 trace 事件来源不一致` });
        }
        return;
      }
      // generated template 来源：IR 应为 template（值一致性由 runtime resolve 保证）
      if (evValue.origin === 'generated' && evValue.template) {
        if (!(irValue !== null && typeof irValue === 'object' && 'template' in (irValue as object))) {
          failures.push({ rule: 'checks-mapping', step: s.id, message: `checks[${i}] ${what} trace 来源是 generated template，IR 应为 template` });
        }
      }
    };
    /** 收集 step 内全部 from_action 引用（step.value / fill_form fields / checks 期望） */
    const collectFromActionRefs = (s: Step): string[] => {
      const out: string[] = [];
      if (s.value && 'from_action' in s.value) out.push(s.value.from_action);
      if (s.action === 'fill_form' && s.args?.fields && typeof s.args.fields === 'object') {
        for (const field of Object.values(s.args.fields as Record<string, unknown>)) {
          if (field !== null && typeof field === 'object' && 'from_action' in (field as object)) out.push((field as { from_action: string }).from_action);
        }
      }
      for (const check of s.checks ?? []) {
        if ('assert' in check && 'field_value' in check.assert) {
          const v = check.assert.field_value.value;
          if ('from_action' in v) out.push(v.from_action);
        }
        if ('assert' in check && 'api' in check.assert) {
          for (const entry of check.assert.expect ?? []) if ('value_from_action' in entry) out.push(entry.value_from_action);
        }
        if ('assert' in check && 'request' in check.assert) {
          for (const entry of [...(check.assert.body ?? []), ...(check.assert.query ?? [])]) {
            if ('value_from_action' in entry) out.push(entry.value_from_action);
          }
        }
        if ('assert' in check && 'text' in check.assert) {
          const v = (check.assert as { text: { value?: unknown } }).text.value;
          if (v !== null && v !== undefined && typeof v === 'object' && 'from_action' in (v as object)) out.push((v as { from_action: string }).from_action);
        }
      }
      return out;
    };
    for (const s of ir.steps) {
      const evs = trace.checkEvents.filter((e) => e.after === s.trace_ref);
      const checks = s.checks ?? [];
      if (evs.length !== checks.length) {
        failures.push({ rule: 'checks-mapping', step: s.id, message: `checks 数量 ${checks.length} 与 trace assert/capture 事件数量 ${evs.length} 不一致（孤儿/漏检查/额外检查）` });
        continue;
      }
      for (let i = 0; i < evs.length; i++) {
        const ev = evs[i];
        const c = checks[i];
        checkReportRef(c.report_ref, recordedReportRef(ev), s, `checks[${i}]`);
        if (ev.t === 'assert') {
          if (!('assert' in c)) {
            failures.push({ rule: 'checks-mapping', step: s.id, message: `checks[${i}] 是 capture，trace 事件是 assert（错序/类型不符）` });
            continue;
          }
          const a = c.assert;
          const keyOf = (kind: string): string | undefined =>
            kind === 'api' ? 'api' : kind === 'request' ? 'request' : kind === 'toast' ? 'toast'
            : kind === 'text' ? 'text' : kind === 'visible' ? 'visible' : kind === 'absent' ? 'absent'
            : kind === 'table_row' ? 'table_row' : kind === 'field_value' ? 'field_value' : kind === 'url' ? 'url' : kind === 'data' ? 'data'
            : kind === 'style' ? 'style' : kind === 'element' ? 'element' : kind === 'console' ? 'console' : undefined;
          const key = keyOf(ev.kind);
          if (!key || !(key in a)) {
            failures.push({ rule: 'checks-mapping', step: s.id, message: `checks[${i}] 类型与 trace assert kind=${ev.kind} 不一致` });
            continue;
          }
          // §7：absent 有自身 ref 身份时，IR locator 必须来自该 assert 自身 identity 候选
          if (ev.kind === 'absent' && ev.identity) {
            const expected = candidateToLocator(ev.identity.candidate);
            const actual = (a as { absent?: unknown }).absent;
            if (!expected || !isDeepStrictEqual(actual, expected)) {
              failures.push({ rule: 'checks-mapping', step: s.id, message: `checks[${i}] absent locator 与该 assert 自身 identity 候选不一致（${JSON.stringify(actual)} vs ${JSON.stringify(expected)}）` });
            }
          }
          // field_value：label/read_mode 与事件一致；value 与事件显式来源一致
          if (ev.kind === 'field_value') {
            const fv = (a as unknown as { field_value: { label: string; value: unknown; read_mode: 'value' | 'text' } }).field_value;
            const e = ev.expect as Record<string, unknown>;
            if (String(e.label) !== fv.label) failures.push({ rule: 'checks-mapping', step: s.id, message: `checks[${i}] field_value label 与 trace 不一致` });
            if (ev.read_mode !== fv.read_mode) failures.push({ rule: 'checks-mapping', step: s.id, message: `checks[${i}] field_value read_mode 与 trace 不一致` });
            checkKnownSource(ev.value, fv.value, 'field_value', s, i);
          }
          if (ev.kind === 'api' || ev.kind === 'request') {
            const e = ev.expect as Record<string, unknown>;
            const isQuery = ev.kind === 'request' && e.source === 'query';
            const isHeader = ev.kind === 'api' && e.source === 'header';
            const entries = ev.kind === 'api'
              ? (isHeader ? (a as { header?: ExpectEntry[] }).header : (a as { expect?: ExpectEntry[] }).expect)
              : isQuery
                ? (a as { query?: ExpectEntry[] }).query
                : (a as { body?: ExpectEntry[] }).body;
            if (!entries || entries.length !== 1) {
              failures.push({ rule: 'checks-mapping', step: s.id, message: `checks[${i}] ${ev.kind} 期望条目数与 trace 事件（单条）不一致` });
              continue;
            }
            const entry = entries[0];
            if (String(e.path) !== entry.path || OP_MAP[String(e.op)] !== entry.op) {
              failures.push({ rule: 'checks-mapping', step: s.id, message: `checks[${i}] ${ev.kind} path/op 与 trace 不一致` });
            }
            checkKnownSource(ev.value, entry, ev.kind, s, i);
          }
          if (ev.kind === 'style') {
            const e = ev.expect as Record<string, unknown>;
            const st = (a as unknown as { style: { locator: unknown; property: string; equals: string; pseudo?: string; all?: boolean } }).style;
            if (!isDeepStrictEqual(st.locator, e.locator)) failures.push({ rule: 'checks-mapping', step: s.id, message: `checks[${i}] style locator 与 trace 不一致` });
            if (st.property !== e.property || st.equals !== e.equals) failures.push({ rule: 'checks-mapping', step: s.id, message: `checks[${i}] style property/equals 与 trace 不一致` });
            if ((st.pseudo ?? null) !== (e.pseudo ?? null) || (st.all === true) !== (e.all === true)) {
              failures.push({ rule: 'checks-mapping', step: s.id, message: `checks[${i}] style pseudo/all 与 trace 不一致` });
            }
          }
          if (ev.kind === 'element') {
            const e = ev.expect as Record<string, unknown>;
            const el = (a as unknown as { element: { locator: unknown; property: string; op: string; value: unknown; all?: boolean } }).element;
            if (!isDeepStrictEqual(el.locator, e.locator)) failures.push({ rule: 'checks-mapping', step: s.id, message: `checks[${i}] element locator 与 trace 不一致` });
            if (el.property !== e.property || OP_MAP[String(e.op)] !== el.op || !isDeepStrictEqual(el.value, e.value) || (el.all === true) !== (e.all === true)) {
              failures.push({ rule: 'checks-mapping', step: s.id, message: `checks[${i}] element property/op/value/all 与 trace 不一致` });
            }
          }
          if (ev.kind === 'console') {
            const e = ev.expect as Record<string, unknown>;
            const c = (a as unknown as { console: { check: unknown; scope: string } }).console;
            if (!isDeepStrictEqual(c.check, e.check) || c.scope !== e.scope) {
              failures.push({ rule: 'checks-mapping', step: s.id, message: `checks[${i}] console check/scope 与 trace 不一致` });
            }
          }
          if (!isDeepStrictEqual(c.frame, parseFrame(ev.frame))) {
            failures.push({ rule: 'checks-mapping', step: s.id, message: `checks[${i}] frame 与 trace 不一致（检查 frame 不得继承动作 frame）` });
          }
          if (ev.kind === 'text') {
            const textAssert = (a as unknown as { text: { contains: string; value?: unknown } }).text;
            checkKnownSource(ev.value, textAssert.value, 'text', s, i);
          }
        } else {
          if (!('capture' in c)) {
            failures.push({ rule: 'checks-mapping', step: s.id, message: `checks[${i}] 是 assert，trace 事件是 capture（错序/类型不符）` });
            continue;
          }
          if (c.capture.as !== ev.as) {
            failures.push({ rule: 'checks-mapping', step: s.id, message: `checks[${i}] capture.as 与 trace 不一致` });
          }
          if (ev.result.ok === true && 'from_element' in c.capture) {
            if (c.capture.read_mode !== ev.result.read_mode) {
              failures.push({ rule: 'checks-mapping', step: s.id, message: `checks[${i}] capture read_mode 与 trace 不一致` });
            }
          }
          if (!isDeepStrictEqual(c.frame, parseFrame(ev.frame))) {
            failures.push({ rule: 'checks-mapping', step: s.id, message: `checks[${i}] capture frame 与 trace 不一致（检查 frame 不得继承动作 frame）` });
          }
        }
      }
    }
    // from_action 来源核对：引用的 step 必须对应 trace 里成功且产出 resolved_value 的五类输入动作
    for (const s of ir.steps) {
      for (const fromStepId of collectFromActionRefs(s)) {
        const sourceStep = ir.steps.find((x) => x.id === fromStepId);
        if (!sourceStep) {
          failures.push({ rule: 'value-consistency', step: s.id, message: `from_action "${fromStepId}" 引用的 step 不存在` });
          continue;
        }
        if ((stepIndex.get(sourceStep.id) ?? -1) > (stepIndex.get(s.id) ?? -1)) {
          failures.push({ rule: 'value-consistency', step: s.id, message: `from_action "${fromStepId}" 引用后续 step（必须前序或当前已成功动作）` });
        }
        const action = trace.actions.find((a) => a.id === sourceStep.trace_ref);
        if (!action || action.result?.ok !== true || action.resolved_value === undefined || !['open', 'type', 'fill', 'select', 'date'].includes(action.kind)) {
          failures.push({ rule: 'value-consistency', step: s.id, message: `from_action "${fromStepId}" 对应 trace 动作不满足可引用条件（成功/有 resolved_value/五类输入动作）` });
        }
      }
    }
  } else {
    skipped.push('trace-absent: 跳过道 6(checks 一对一核对)');
  }

  // ── P2 道：data 断言观察证据核对（有 trace 时） ──
  // 读取成功 ok=true 不等于断言证据完整；未定义字段不能靠条件比较跳过：
  //  - observation 必须有 present=true 与自身 scalar value，且与 equals 严格一致
  //  - 断言 actual 的 present/value 与 equals 严格一致
  //  - obs 与 actual.context 的 target/document/nav/url/origin 必须齐全且一致
  //    （loader_id 空串允许=初始 about:blank，缺字段拒绝）
  //  - source/after 与 trace assert 一致；同名 observation 不等于证据一致
  if (trace) {
    for (const s of ir.steps) {
      const evs = trace.checkEvents.filter((e) => e.after === s.trace_ref);
      for (const [checkIndex, check] of (s.checks ?? []).entries()) {
        if (!('assert' in check) || !check.assert) continue;
        const a = check.assert;
        if (!('data' in a)) continue;
        const data = a.data;
        const ev = evs[checkIndex];
        if (!ev || ev.t !== 'assert' || ev.kind !== 'data'
          || !isDeepStrictEqual((ev.expect as Record<string, unknown> | undefined)?.source, data.source)) {
          failures.push({ rule: 'data-assert', step: s.id, message: `data 断言 source=${JSON.stringify(data.source)} 在 trace 中无匹配 assert 事件` });
          continue;
        }
        // P4：核对真实事件的无损回放标记——双方相同 marker 不能充当原始证据；
        // false/缺失（脱敏改写或旧 trace）部拒绝，不能以 IR/trace equals 相等物克原始性
        if (ev.replayable !== true) {
          failures.push({ rule: 'data-assert', step: s.id, message: `data 断言 replayable=${JSON.stringify(ev.replayable ?? null)}（期望被脱敏改写或旧 trace 缺标记，需重新录制），不可作为无损回放证据` });
          continue;
        }
        if (!isDeepStrictEqual((ev.expect as Record<string, unknown> | undefined)?.equals, data.equals)) {
          failures.push({ rule: 'data-assert', step: s.id, message: `data 断言 equals=${JSON.stringify(data.equals)} 与 trace assert (${JSON.stringify((ev.expect as Record<string, unknown> | undefined)?.equals)}) 不一致` });
          continue;
        }
        const ref = ev.observation_ref;
        const obs = typeof ref === 'string' ? trace.observations.find((o) => o.id === ref) : undefined;
        if (!obs) {
          failures.push({ rule: 'observation-ref', step: s.id, message: `data 断言 observation_ref ${JSON.stringify(ref ?? '缺失')} 在 trace 中不存在` });
          continue;
        }
        if (obs.result?.ok !== true) {
          const code = (obs.result as { error?: { code?: string } } | undefined)?.error?.code ?? 'unknown';
          failures.push({ rule: 'observation-ref', step: s.id, message: `观察 ${obs.id} 读取失败（${code}），不能作为断言证据` });
          continue;
        }
        // 观察证据完整：present=true + 自身 scalar value + 与 equals 严格一致
        const obsResult = obs.result as { present?: unknown; value?: unknown };
        if (obsResult.present !== true) {
          failures.push({ rule: 'observation-evidence', step: s.id, message: `观察 ${obs.id} present=${JSON.stringify(obsResult.present)}（成功断言证据必须 present=true）` });
        }
        if (obsResult.value === undefined || (obsResult.value !== null && typeof obsResult.value === 'object')) {
          failures.push({ rule: 'observation-evidence', step: s.id, message: `观察 ${obs.id} 缺自身 scalar value（读取成功必须带回值）` });
        } else if (!isDeepStrictEqual(obsResult.value, data.equals)) {
          failures.push({ rule: 'observation-evidence', step: s.id, message: `观察 ${obs.id} value=${JSON.stringify(obsResult.value)} 与 IR equals=${JSON.stringify(data.equals)} 不一致` });
        }
        // 断言 actual 证据完整：present/value 与 equals 严格一致
        const actual = ev.actual as { present?: unknown; value?: unknown; context?: Record<string, unknown> } | undefined;
        if (!actual || actual.present !== true) {
          failures.push({ rule: 'observation-evidence', step: s.id, message: `断言 actual 缺 present=true（${actual ? JSON.stringify(actual.present) : 'actual 缺失'}）` });
        }
        if (!actual || actual.value === undefined || (actual.value !== null && typeof actual.value === 'object')) {
          failures.push({ rule: 'observation-evidence', step: s.id, message: `断言 actual 缺自身 scalar value` });
        } else if (!isDeepStrictEqual(actual.value, data.equals)) {
          failures.push({ rule: 'observation-evidence', step: s.id, message: `断言 actual value=${JSON.stringify(actual.value)} 与 IR equals=${JSON.stringify(data.equals)} 不一致` });
        }
        // 身份证据齐全：actual.context 六字段（target_id/frame_id/loader_id/nav/url/origin）
        const ctx = actual?.context;
        const CTX_FIELDS = ['target_id', 'frame_id', 'loader_id', 'nav', 'url', 'origin'] as const;
        const ctxComplete = !!ctx && CTX_FIELDS.every((f) => typeof ctx[f] === 'string');
        if (!ctxComplete) {
          failures.push({ rule: 'observation-evidence', step: s.id, message: `断言 actual.context 缺身份字段（target_id/frame_id/loader_id/nav/url/origin）` });
        }
        // 观察身份证据齐全并与 actual.context 一致（loader_id 空串允许，缺字段拒绝）
        const obsDoc = obs.document as { frame_id?: unknown; loader_id?: unknown } | undefined;
        const obsIdentityComplete = typeof obs.target_id === 'string'
          && !!obsDoc && typeof obsDoc.frame_id === 'string' && typeof obsDoc.loader_id === 'string'
          && typeof obs.nav === 'string' && typeof obs.url === 'string' && typeof obs.origin === 'string';
        if (!obsIdentityComplete) {
          failures.push({ rule: 'observation-evidence', step: s.id, message: `观察 ${obs.id} 缺身份证据字段（target_id/document{frame_id,loader_id}/nav/url/origin）` });
        } else if (ctxComplete) {
          const mismatched = CTX_FIELDS.filter((f) => {
            const obsValue = f === 'target_id' ? obs.target_id
              : f === 'frame_id' ? obsDoc!.frame_id
              : f === 'loader_id' ? obsDoc!.loader_id
              : f === 'nav' ? obs.nav
              : f === 'url' ? obs.url
              : obs.origin;
            return obsValue !== ctx![f];
          });
          if (mismatched.length > 0) {
            failures.push({ rule: 'observation-evidence', step: s.id, message: `观察 ${obs.id} 与断言 actual.context 身份证据不一致（${mismatched.join('/')}）` });
          }
        }
        if (!isDeepStrictEqual(obs.source, data.source)) {
          failures.push({ rule: 'observation-evidence', step: s.id, message: `观察 ${obs.id} source(${JSON.stringify(obs.source)}) 与断言 source 不一致` });
        }
        if (obs.after !== ev.after) {
          failures.push({ rule: 'observation-evidence', step: s.id, message: `观察 ${obs.id} after(${obs.after ?? '缺失'}) 与断言 after(${ev.after}) 不一致` });
        }
      }
    }
  } else {
    skipped.push('trace-absent: 跳过 data 断言观察证据核对');
  }

  // ── 道 6：Refine（逻辑守卫）──
  for (const s of ir.steps) {
    if (s.action === 'select' || s.action === 'choose' || s.action === 'category') {
      const args = (s.args ?? {}) as Record<string, unknown>;
      // F10/F11：静态 refine 只调用同一共享 validator（S7-G16 不留第二套结构循环）。
      // select 缺 option/空 picks 不再靠空数组循环 PASS。
      for (const err of validateSelectionFact(s.action, args)) {
        failures.push({ rule: 'selection-consistency', step: s.id, message: err });
      }
    }
    // R1/LC4：fill_form 必需结构（fields/field_locators/field_order/scope）与各 action
    // locator/value/options/path/key/direction 已由 StepSchema 超级 refine（shared/step-input
    // 同源守卫）拒绝；此处不再重复维护第二套结构循环。有 trace 时逐字段核值声明/定位/
    // 顺序仍在下方 trace 证据道
    if (s.action === 'open') {
      const hasWait = (s.wait ?? []).length > 0;
      const hasNext = ir.steps[ir.steps.indexOf(s) + 1] !== undefined;
      if (!hasWait && !hasNext) {
        failures.push({ rule: 'refine', step: s.id, message: 'open 后必须有 wait 或后续步骤' });
      }
    }
    if (s.action === 'switch_tab') {
      const args = (s.args ?? {}) as Record<string, unknown>;
      if (!args.target_id && !args.to_target_id) {
        failures.push({ rule: 'refine', step: s.id, message: 'switch_tab 必须有真实 target 证据（args.target_id / to_target_id），旧假 history switch 不接受' });
      }
    }
    if (s.creates) {
      const createsPath = s.creates.path;
      const hasMatchingWait = (s.wait ?? []).some((w) => 'api' in w && w.api.path === createsPath);
      if (!hasMatchingWait) {
        failures.push({ rule: 'refine', step: s.id, message: `creates.path "${createsPath}" 没有对应的 wait.api` });
      }
    }
  }

  return { passed: failures.length === 0, failures, skipped };
}

/** CLI 入口：读 IR 文件 + 可选 trace，返回 CheckResult。 */
export function checkIrFile(irFile: string, opts: Omit<CheckOptions, 'trace'> = {}): CheckResult {
  const raw = JSON.parse(fs.readFileSync(irFile, 'utf8'));
  return checkIr(raw, opts);
}
