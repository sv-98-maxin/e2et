/**
 * ir build：trace → 候选 IR v2（trace-ir-spec.md 第 3 节提炼规则）。
 * 输出提炼结果（保留/删除/不可映射动作）供 Host 确认，IR 写到 workspace。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { candidateToLocator, parseDeclaredWaitLocator } from '../shared/wait-locator.js';
import { traceRoot, e2etRoot } from '../daemon/session-meta.js';
import { readPackageVersion } from '../package-version.js';
import { parseTrace, readTrace, traceValueToIR, TraceVersionError, type ActionEvent, type AssertEvent, type CaptureEvent, type ParsedTrace, type RequestEvent } from './trace-reader.js';
import { AuthSourceSchema, LocatorSchema, ReportRefSchema, type IRv2, type Locator, type WithinLocator, type Wait, type Assert, type Capture, type Check, type Value, type Creates, type Frame, type ExpectEntry, type ReportRef } from './schema.js';
import { ELEMENT_PROPERTIES } from '../shared/dom-inspection.js';
import type { ElementAssertValue } from '../shared/types.js';
import { IR_SCHEMA_VERSION } from '../shared/versions.js';
import { parseTargetSpec } from '../browser/actions.js';
import { validateSelectionFact } from './selection-validate.js';
import type { FrameDesc } from '../browser/page-state.js';
import { parseWaitTimeoutMs } from '../wait-timeout.js';
import { readTraceBlob } from '../daemon/trace.js';
import { validateActionSavedValue } from './action-output.js';

export interface BuildFailure {
  ok: false;
  error: { code: string; message: string; hint?: string };
}

export interface BuildSuccess {
  ok: true;
  ir: IRv2;
  ir_path: string;
  kept_steps: string[];
  dropped_steps: string[];
  unmapped_actions: string[];
  warnings: string[];
}

export type BuildResult = BuildFailure | BuildSuccess;

// spec 2.3 action 集合
const ACTION_SET = new Set([
  'open', 'click', 'double_click', 'type', 'fill', 'press', 'select', 'choose',
  'date', 'category', 'upload', 'fill_form', 'hover', 'scroll',
  'switch_tab', 'back', 'refresh',
]);

export function recordedReportRef(event: ActionEvent | AssertEvent | CaptureEvent): ReportRef | undefined {
  const ref: ReportRef = {
    ...(typeof event.group === 'string' && event.group.trim() ? { group: event.group } : {}),
    ...(typeof event.id === 'string' && event.id.trim() ? { source_event_id: event.id } : {}),
    ...(typeof event.check_id === 'string' && event.check_id.trim() ? { check_id: event.check_id } : {}),
  };
  return Object.keys(ref).length ? ref : undefined;
}

// spec 2.3 action 集合（ACTION_SET 上面已定义）


/** trace target.resolved_by + candidates → IR 主 locator（spec 2.4）。
 *  入参收窄为 Pick<ActionEvent,'target'> 供 fill_form 字段级复用（无完整假 ActionEvent）。 */
export function targetToLocator(action: Pick<ActionEvent, 'target'>): Locator | undefined {
  const t = action.target;
  if (!t) return undefined;
  // resolved_by 反映实际命中的通道：css → css；dom-text → text；index/ax → 已验证 candidates
  if (t.resolved_by === 'css') {
    if (t.within) return undefined;
    // CSS class 名易随 DOM 版本漂移：candidates 里有 matches==1 的 role 定位时优先用 role
    const roleCand = t.candidates?.find((c) => c.by === 'role' && c.matches === 1);
    if (roleCand && roleCand.role) {
      return { role: roleCand.role, ...(roleCand.name !== undefined ? { name: roleCand.name } : {}) };
    }
    // selector 原文在 target.selector / candidates.css 里
    const sel = t.selector ?? t.candidates?.find((c) => c.by === 'css')?.selector;
    return sel ? { css: sel } : undefined;
  }
  if (t.resolved_by === 'dom-text') {
    if (t.within) return undefined;
    // AX 语义缺失，弱通道；name 作为 text 锚
    return t.name ? { text: t.name, normalize: true } : undefined;
  }
  // index/ax → 第一个可接受的已验证候选（录制时生产的事实）；无候选不制造定位 → 上层
  // INSUFFICIENT_EVIDENCE（fail closed），不从 display role/name 拼一个
  const primary = t.candidates?.map((c) => candidateToLocator(c)).find((l) => l !== undefined);
  if (!primary) return undefined;
  if (t.within && !('within' in primary)) {
    const w = toWithinLocator(t.within);
    if (w) return { ...primary, within: w };
  }
  return primary;
}

/** IR within 限定器只收 role/row/label（Locator 合同）；其余形态不制造定位（fail closed）。 */
function toWithinLocator(loc: Locator | undefined): WithinLocator | undefined {
  if (loc === undefined) return undefined;
  if ('role' in loc || 'row' in loc || 'label' in loc) return loc;
  return undefined;
}


/** trace frame FrameDesc[] → IR Frame[]（空字段不落 IR；check 侧同源归一化）。 */
export function parseFrame(frameDesc?: FrameDesc[]): Frame[] | undefined {
  if (!frameDesc || frameDesc.length === 0) return undefined;
  return frameDesc.map((f) => ({
    ...(f.name ? { name: f.name } : {}),
    ...(f.url_contains ? { url_contains: f.url_contains } : {}),
    ...(f.selector ? { selector: f.selector } : {}),
  }));
}

/** trace settled_by.kind → IR wait（spec 2.5）。request ref 转成 {path,nav,call_index}。
 *  Phase2：within/断言定位只从自身事件解析证据映射，不借 actionTarget/frame。 */
function traceTargetToLocator(raw: unknown, resolved?: ActionEvent['target']): Locator | undefined {
  const spec = parseTargetSpec(raw);
  if (spec?.kind === 'css') {
    if (resolved?.within) return undefined;
    // Phase2：CSS within 易随 DOM 版本漂移，优先用断言自身解析证据里 matches==1 的 role 候选
    // 降级（不借 actionTarget）；找不到保留 CSS（不能丢断言）
    const roleCand = resolved?.candidates?.find((c) => c.by === 'role' && c.matches === 1);
    if (roleCand && roleCand.role) {
      return { role: roleCand.role, ...(roleCand.name !== undefined ? { name: roleCand.name } : {}) };
    }
    return { css: spec.selector };
  }
  if (resolved) return targetToLocator({ target: resolved });
  if (typeof raw !== 'string') return undefined;
  if (raw.startsWith('label=')) return { label: raw.slice(6) };
  if (raw.startsWith('text=')) return { text: raw.slice(5), normalize: true };
  const role = raw.match(/^role=([^:]+)(?::(.+))?$/);
  if (role) return { role: role[1], ...(role[2] ? { name: role[2] } : {}) };
  return undefined;
}

export function settledToWait(
  action: ActionEvent,
  requests: Map<string, RequestEvent>,
  warnings: string[],
): Wait[] | null {
  const out: Wait[] = [];
  for (const s of action.settled_by ?? []) {
    switch (s.kind) {
      case 'request': {
        const req = s.ref ? requests.get(s.ref) : undefined;
        if (!req) {
          warnings.push(`动作 ${action.id} 的 settled_by request ref ${s.ref ?? '(空)'} 在 trace 中找不到`);
          return null;
        }
        out.push({ api: { path: req.path, nav: Number(req.nav.replace('n', '')), call_index: req.call_index } });
        break;
      }
      case 'element':
      case 'element_gone': {
        const locator = s.locator;
        if (!locator || !LocatorSchema.safeParse(locator).success) return null;
        if (s.observation?.matches !== (s.kind === 'element' ? 1 : 0)) return null;
        if (s.kind === 'element' && (typeof s.observation.role !== 'string' || typeof s.observation.name !== 'string' || typeof s.observation.visible !== 'boolean')) return null;
        if (s.kind === 'element_gone' && (s.observation.role !== undefined || s.observation.name !== undefined || s.observation.visible !== undefined)) return null;
        if (typeof s.target !== 'string') return null;
        let declared: Locator | undefined;
        try { declared = parseDeclaredWaitLocator(s.target); } catch { return null; }
        if (declared) {
          if (!isDeepStrictEqual(declared, locator) || s.identity !== undefined) return null;
        } else {
          if (!s.identity || !isDeepStrictEqual(candidateToLocator(s.identity.candidate), locator)) return null;
          const spec = parseTargetSpec(s.target);
          if (spec?.kind !== 'index' && s.identity.source !== 'collector') return null;
        }
        // §4：wait-element 真实 presence → attached；wait-gone 真实 DOM 缺席 → detached
        //（hidden 但 attached 必须等待成功语义，布局 absent 与 DOM 缺席不是同一语义）
        out.push({ element: locator, state: s.kind === 'element' ? 'attached' : 'detached' });
        break;
      }
      case 'text':
        if (!s.text?.trim()) return null;
        out.push({ text: s.text }); break;
      case 'url':
        if (!s.url?.trim()) return null;
        out.push({ url: { contains: s.url } }); break;
      case 'dom_quiet': {
        const ms = s.quiet_ms;
        if (!ms || !Number.isInteger(ms) || ms <= 0) return null;
        out.push({ dom_quiet: { ms } }); break;
      }
      default: return null;
    }
  }
  return out;
}

/** Phase2：显式期望来源（事件 value: TraceActionValue）→ IR Value。
 *  from_action 映射到唯一先前/当前来源 step.id：真实 trace 顺序（后续动作未定义即拒绝）、
 *  来源动作成功、resolved_value 与 raw 一致、来源只允许五类输入动作。
 *  value-ref 做前向校验（ref 当前绑定 === raw，重绑定冲突拒绝）；literal 不转引用。 */
function traceAssertValueToIR(
  v: NonNullable<AssertEvent['value']>,
  bindings: Map<string, string>,
  stepIdByActionId: Map<string, string>,
  actionsById: Map<string, ActionEvent>,
): Value | null {
  if (v.source_action) {
    const source = actionsById.get(v.source_action);
    const stepId = stepIdByActionId.get(v.source_action);
    if (!source || !stepId) return null;
    if (source.result?.ok !== true) return null;
    if (!VALUE_ACTION_KINDS.has(source.kind)) return null;
    if (source.resolved_value === undefined || source.resolved_value !== v.raw) return null;
    return { from_action: stepId };
  }
  if (v.origin === 'generated' && v.template) return { template: v.template };
  if (v.origin === 'captured' && v.ref) {
    if (bindings.get(v.ref) !== v.raw) return null; // 重绑定冲突
    return { ref: v.ref };
  }
  if (v.origin === 'literal') return { literal: v.raw };
  return null;
}

/** Phase2：值来源可引用的动作（只允许明确产生字符串输入值的五类） */
const VALUE_ACTION_KINDS = new Set(['open', 'type', 'fill', 'select', 'date']);

/** trace assert.expect → IR assert（spec 2.6）。kind 一一对应，结构转译。
 *  bindings: 当前用户变量名→raw 绑定（按事件时序更新，仅前向校验用，不做 raw 反查）。 */
function traceAssertToIR(ev: AssertEvent, bindings: Map<string, string>, stepIdByActionId: Map<string, string>, actionsById: Map<string, ActionEvent>): Assert | null {
  const e = ev.expect as Record<string, unknown>;
  switch (ev.kind) {
    case 'api':
    case 'request': {
      const op = ASSERT_OPS[String(e.op)];
      if (!op) return null;
      const req = e.req as { path: string; nav: string; call_index: number };
      const ref = { path: req.path, nav: Number(req.nav.replace('n', '')), call_index: req.call_index };
      // Phase2：显式来源 → value_ref / value_from_action；无来源保持 literal（不转引用）
      const irVal = ev.value ? traceAssertValueToIR(ev.value, bindings, stepIdByActionId, actionsById) : undefined;
      if (irVal === null) return null;
      let entry: ExpectEntry;
      if (irVal && 'ref' in irVal) entry = { path: String(e.path), op, value_ref: irVal.ref };
      else if (irVal && 'from_action' in irVal) entry = { path: String(e.path), op, value_from_action: irVal.from_action };
      else entry = { path: String(e.path), op, value: e.value };
      const expect = [entry];
      if (ev.kind === 'api') return e.source === 'header' ? { api: ref, header: expect } : { api: ref, expect };
      return e.source === 'query' ? { request: ref, query: expect } : { request: ref, body: expect };
    }
    case 'toast': return { toast: String(e) };
    case 'text': {
      const within = e.within ? traceTargetToLocator(e.within, ev.within) : undefined;
      if (e.within && (!within || !LocatorSchema.safeParse(within).success)) return null;
      const irVal = ev.value ? traceAssertValueToIR(ev.value, bindings, stepIdByActionId, actionsById) : undefined;
      if (irVal === null) return null;
      // 仅显式来源时加 value；转换返回 null 时拒绝提炼，不降级回 literal
      return { text: { contains: String(e.contains), ...(within ? { within } : {}), ...(irVal ? { value: irVal } : {}) } };
    }
    case 'visible':
    case 'absent': {
      // §7：absent 有自身 ref 身份时，locator 从该 assert 自身 identity.candidate 产
      //（不借前一 action target）；显式 CSS/text 声明式缺席规则保留
      let locator = traceTargetToLocator(ev.expect, ev.target);
      if (ev.kind === 'absent' && ev.identity) {
        locator = candidateToLocator(ev.identity.candidate);
      }
      if (!locator || !LocatorSchema.safeParse(locator).success) return null;
      return ev.kind === 'visible' ? { visible: locator } : { absent: locator };
    }
    case 'table_row': return { table_row: { contains: String((e as { contains: string }).contains), ...((e as { count: number | null }).count ? { count: (e as { count: number }).count } : {}) } };
    case 'field_value': {
      const raw = String(e.value);
      // Phase2：locator/read_mode 必需——从事件自身候选映射，缺证据拒绝
      const locator = ev.target ? targetToLocator({ target: ev.target }) : undefined;
      if (!locator || !LocatorSchema.safeParse(locator).success) return null;
      if (!ev.read_mode) return null;
      const irVal = ev.value ? traceAssertValueToIR(ev.value, bindings, stepIdByActionId, actionsById) : { literal: raw };
      if (irVal === null) return null;
      return { field_value: { label: String(e.label), value: irVal, locator, read_mode: ev.read_mode } };
    }
    case 'url': return { url: { contains: String((e as { contains: string }).contains) } };
    case 'data': {
      // P2：expect = { source, equals }（equals 是调用方期望标量，不复制观察时的实际值）
      const source = e.source as Record<string, unknown> | undefined;
      if (!source || typeof source !== 'object') return null;
      if (typeof source.local_storage === 'string') {
        if (source.global !== undefined) return null;
        if (source.path !== undefined && typeof source.path !== 'string') return null;
      } else if (typeof source.global !== 'string') {
        return null;
      }
      const equals = e.equals;
      if (equals !== null && (typeof equals !== 'string' && typeof equals !== 'number' && typeof equals !== 'boolean')) return null;
      if (typeof equals === 'number' && !Number.isFinite(equals)) return null;
      return { data: { source: source as { local_storage: string; path?: string } | { global: string }, equals: equals as string | number | boolean | null } };
    }
    case 'style': {
      const loc = e.locator;
      if (!loc || typeof loc !== 'object' || !LocatorSchema.safeParse(loc).success) return null;
      if (typeof e.property !== 'string' || e.property === '' || typeof e.equals !== 'string') return null;
      if (e.pseudo !== undefined && e.pseudo !== 'before' && e.pseudo !== 'after') return null;
      if (e.all !== undefined && typeof e.all !== 'boolean') return null;
      return {
        style: {
          locator: loc as Locator,
          property: e.property,
          equals: e.equals,
          ...(e.pseudo !== undefined ? { pseudo: e.pseudo } : {}),
          ...(e.all === true ? { all: true } : {}),
        },
      };
    }
    case 'element': {
      const loc = e.locator;
      if (!loc || typeof loc !== 'object' || !LocatorSchema.safeParse(loc).success) return null;
      if (typeof e.property !== 'string') return null;
      if (e.property !== 'count' && !(ELEMENT_PROPERTIES as readonly string[]).includes(e.property)) return null;
      const op = ASSERT_OPS[String(e.op)];
      if (!op || !('value' in e)) return null;
      const value = e.value;
      if (!(value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'object')) return null;
      if (e.all !== undefined && typeof e.all !== 'boolean') return null;
      return {
        element: {
          locator: loc as Locator,
          property: e.property as (typeof ELEMENT_PROPERTIES)[number] | 'count',
          op,
          value: value as ElementAssertValue,
          ...(e.all === true ? { all: true } : {}),
        },
      };
    }
    case 'console': {
      const scope = e.scope;
      if (scope !== 'session' && scope !== 'action') return null;
      const check = e.check as Record<string, unknown> | undefined;
      if (!check || typeof check !== 'object') return null;
      if (check.noError === true && !('level' in check) && !('contains' in check) && !('count' in check)) {
        return { console: { check: { noError: true }, scope } };
      }
      const level = CONSOLE_LEVELS.has(String(check.level)) ? String(check.level) as 'log' | 'debug' | 'info' | 'warning' | 'error' | 'trace' : undefined;
      if (!level) return null;
      if (check.contains !== undefined && typeof check.contains !== 'string') return null;
      if (!Number.isInteger(check.count) || (check.count as number) < 0) return null;
      return {
        console: {
          check: { level, ...(check.contains !== undefined ? { contains: check.contains } : {}), count: check.count as number },
          scope,
        },
      };
    }
    default: return null;
  }
}

const CONSOLE_LEVELS = new Set(['log', 'debug', 'info', 'warning', 'error', 'trace']);
const ASSERT_OPS: Record<string, 'eq' | 'ne' | 'exists' | 'contains' | 'gt' | 'lt'> = {
  '==': 'eq', '!=': 'ne', '>': 'gt', '<': 'lt', exists: 'exists', contains: 'contains',
};

/** trace capture.from → IR capture（spec 2.6）。 */
function traceCaptureToIR(ev: CaptureEvent): Capture | null {
  if (ev.result.ok !== true) return null;
  const r = ev.result;
  const fromObj = r.from as Record<string, unknown>;
  if (fromObj && typeof fromObj.path === 'string' && typeof fromObj.nav === 'string' && typeof fromObj.call_index === 'number') {
    return { from_api: { path: fromObj.path, nav: Number((fromObj.nav as string).replace('n', '')), call_index: fromObj.call_index }, path: r.path ?? 'data', as: ev.as, lineage: r.lineage };
  }
  // Phase2：from_element 的 locator 只从事件自身 matches=1 候选映射，read_mode 必需
  if (!r.target) return null;
  const locator = targetToLocator({ target: r.target });
  if (!locator || !LocatorSchema.safeParse(locator).success) return null;
  if (!r.read_mode) return null;
  return { from_element: locator, as: ev.as, lineage: r.lineage, read_mode: r.read_mode };
}

/** 选择子集门禁：唯一共享 validator（selection-validate.ts）——build 只包装本层错误，
 *  不保留第二套结构循环（S7-G16）。 */
function selectionEvidenceGate(action: ActionEvent, args: Record<string, unknown>): BuildFailure | null {
  const errs = validateSelectionFact(action.kind, args);
  if (errs.length === 0) return null;
  return { ok: false, error: { code: 'INSUFFICIENT_EVIDENCE', message: `动作 ${action.id}（${action.kind}）选择证据不完整: ${errs[0]}${errs.length > 1 ? `（共 ${errs.length} 项失败断言）` : ''}` } };
}

export interface BuildOptions {
  name?: string;
  /** 覆盖 traceRoot（测试注入） */
  traceRootDir?: string;
  /** 覆盖 IR 输出目录（测试注入） */
  outDir?: string;
  /** 覆盖 tool version（测试注入） */
  toolVersion?: string;
}

export async function buildIr(sessionId: string, opts: BuildOptions = {}): Promise<BuildResult> {
  const name = opts.name ?? `case-${sessionId}`;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) return { ok: false, error: { code: 'USAGE', message: 'name 必须匹配 ^[a-zA-Z0-9][a-zA-Z0-9_-]*$' } };
  let events: ReturnType<typeof readTrace>;
  try {
    events = readTrace(sessionId);
  } catch (error) {
    if (error instanceof TraceVersionError) return { ok: false, error: { code: error.code, message: error.message } };
    throw error;
  }
  if (!events) {
    return { ok: false, error: { code: 'TRACE_NOT_FOUND', message: `会话 trace 不存在: ${sessionId}`, hint: 'trace 仅存本地 7 天，可能已过期或会话未在本机' } };
  }
  const trace = parseTrace(events);

  // P4：provenance 真实来源校验——只消费 session 事件已记录的字段；
  // 缺失/非法组合在生成 provenance 前拒绝（不补 unknown/default，不读本机状态文件猜来源）
  const sessionAuth = trace.session?.auth_source;
  const sessionBrowser = trace.session?.browser_source;
  if (typeof sessionAuth !== 'string' || sessionAuth === '' || typeof sessionBrowser !== 'string' || sessionBrowser === '') {
    return { ok: false, error: { code: 'AUTH_PROVENANCE_MISSING', message: 'trace session 事件缺失真实 auth_source/browser_source，无法生成可回放 provenance', hint: '旧 trace 不带来源，需用当前 CLI 重新录制会话' } };
  }
  const validBrowser = new Set(['chrome-profile', 'managed', 'existing']);
  if (!AuthSourceSchema.safeParse(sessionAuth).success || !validBrowser.has(sessionBrowser) || (sessionBrowser === 'chrome-profile') !== (sessionAuth === 'profile')) {
    return { ok: false, error: { code: 'AUTH_PROVENANCE_INVALID', message: `trace session 来源或组合不合法: auth_source=${sessionAuth} + browser_source=${sessionBrowser}`, hint: '会话启动来源与登录态来源不一致，需重新录制' } };
  }

  // 规则 1：前提 session_end.result == pass 且 mocked == false
  const result = trace.sessionEnd?.result ?? 'aborted';
  if (result !== 'pass') {
    return { ok: false, error: { code: 'SESSION_NOT_PASS', message: `会话结论不是 pass: ${result}`, hint: result === 'aborted' ? 'trace 缺 session_end（进程中途被杀），需重跑会话' : undefined } };
  }
  const mocked = trace.sessionEnd?.mocked === true;
  if (mocked) {
    return { ok: false, error: { code: 'SESSION_MOCKED', message: '会话使用过 mock，不可落库' } };
  }
  if (trace.mocks.some((event) => event.op === 'add') || trace.requests.some((request) => request.mocked === true)) return { ok: false, error: { code: 'SESSION_MOCKED', message: 'trace 使用过 mock，不可落库' } };
  if (trace.actions.some((action) => action.result?.ok === false || action.settled_by?.some((wait) => wait.kind === 'timeout')) || trace.asserts.some((assert) => !assert.pass) || (trace.sessionEnd?.timeouts ?? 0) > 0 || (trace.sessionEnd?.asserts && trace.sessionEnd.asserts.pass < trace.sessionEnd.asserts.total)) {
    return { ok: false, error: { code: 'SESSION_NOT_PASS', message: 'trace 含失败动作、断言或 timeout，不接受旧误 pass 终态' } };
  }
  if (trace.asserts.length === 0) return { ok: false, error: { code: 'SESSION_NOT_PASS', message: 'trace 无断言，未验证' } };
  // P2：失败观察拒绝——observation 不是 action，但不能因它不是 action 而忽略
  if (trace.observations.some((o) => o.result?.ok !== true)) {
    return { ok: false, error: { code: 'OBSERVATION_FAILED', message: 'trace 含失败观察（页面数据读取错误），不可生成 IR', hint: '重跑会话修复读取错误后再 build' } };
  }
  const unmapped = trace.actions.filter((action) => !ACTION_SET.has(action.kind)).map((action) => `${action.id}:${action.kind}`);
  if (unmapped.length > 0) return { ok: false, error: { code: 'UNMAPPED_ACTIONS', message: `不可映射动作: ${unmapped.join(', ')}` } };

  // F1/F2：wire3 逐事件 replayable 事实门禁——来源被改写(false)或缺事实(旧 trace)的
  // 动作/断言/捕获/观察不可入 IR（data 断言沿用自身 ASSERT_NOT_REPLAYABLE 门禁）
  const replayGate = (label: string, id: string, replayable: boolean | undefined): BuildFailure | null => {
    if (replayable === false) return { ok: false, error: { code: 'REPLAY_EVIDENCE_REDACTED', message: `${label} ${id} 来源被脱敏改写（replayable=false），不可无损回放` } };
    if (replayable !== true) return { ok: false, error: { code: 'INSUFFICIENT_EVIDENCE', message: `${label} ${id} 缺 replayable 事实（旧 trace），不可回放`, hint: '需用当前 CLI 重新录制会话' } };
    return null;
  };
  for (const a of trace.actions) {
    const gate = replayGate('动作', a.id, a.replayable);
    if (gate) return gate;
  }
  for (const ev of trace.asserts) {
    if (ev.kind === 'data') continue; // data 断言在 checks 映射处有专门门禁
    const gate = replayGate('断言', `${ev.after}:${ev.kind}`, ev.replayable);
    if (gate) return gate;
  }
  for (const ev of trace.captures) {
    const gate = replayGate('捕获', `${ev.after}:${ev.as}`, ev.replayable);
    if (gate) return gate;
  }
  // data 断言引用的观察由 checks 映射处的 ASSERT_NOT_REPLAYABLE 门禁精确核对（含其 replayable），
  // 不落入通用观察 gate 的粗粒度拒绝
  const dataObsRefs = new Set<string>();
  for (const ev of trace.asserts) {
    if (ev.kind === 'data' && typeof ev.observation_ref === 'string') dataObsRefs.add(ev.observation_ref);
  }
  for (const o of trace.observations) {
    if (dataObsRefs.has(o.id)) continue;
    const gate = replayGate('观察', o.id, o.replayable);
    if (gate) return gate;
  }

  const requests = new Map<string, RequestEvent>();
  for (const r of trace.requests) requests.set(r.id, r);

  // switch_tab 证据预检：所有 switch_tab action 必须有真实 target 证据（resolved_tab / args.target_id）。
  // 在 step 构建前校验，拒绝旧假 history switch（不静默丢）。
  for (const a of trace.actions) {
    if (a.kind !== 'switch_tab') continue;
    if (!a.resolved_tab && !(a.args && (a.args.target_id || a.args.to_target_id))) {
      return { ok: false, error: { code: 'INSUFFICIENT_EVIDENCE', message: `动作 ${a.id}（switch_tab）缺少真实 target 证据（resolved_tab/target_id），旧假 history switch 不再接受` } };
    }
  }

  // 已录制、已映射动作全部按真实 trace.actions 顺序生成 step（P3 回放事实：依赖剪枝会删回放必需的输入动作）；dropped_steps 恒空
  const kept: ActionEvent[] = trace.actions;
  const dropped: string[] = [];
  const warnings: string[] = [];

  // 构建 steps
  let seq = 0;
  const steps: IRv2['steps'] = [];
  const fixtures: Array<{ name: string; bytes: Buffer }> = [];
  const checkEvents = events.filter((event): event is AssertEvent | CaptureEvent => event.t === 'assert' || event.t === 'capture');
  // Phase2：按事件时序单次遍历。bindings 只做用户变量前向校验与 capture.as 顺序，
  // 不做 raw 反查；from-action 来源按 action.id→step.id 精确映射
  const bindings = new Map<string, string>(); // variable name -> current raw
  const stepIdByActionId = new Map<string, string>(); // action.id -> step.id
  const actionsById = new Map<string, ActionEvent>();
  for (const a of kept) actionsById.set(a.id, a);
  for (const a of kept) {
    seq++;
    // switch_tab 必须有真实 target 证据（resolved_tab / args.target_id），拒绝旧假 history switch
    if (a.kind === 'switch_tab' && !a.resolved_tab && !(a.args && (a.args.target_id || a.args.to_target_id))) {
      return { ok: false, error: { code: 'INSUFFICIENT_EVIDENCE', message: `动作 ${a.id}（switch_tab）缺少真实 target 证据（resolved_tab/target_id），旧假 history switch 不再接受` } };
    }
    const locator = targetToLocator(a);
    if (a.target && !locator) return { ok: false, error: { code: 'INSUFFICIENT_EVIDENCE', message: `动作 ${a.id} 的目标或作用域无法还原` } };
    const wait = settledToWait(a, requests, warnings);
    if (!wait) return { ok: false, error: { code: 'INSUFFICIENT_EVIDENCE', message: `动作 ${a.id} 的等待条件无法从 trace 还原` } };
    const value = traceValueToIR(a.value);
    if (a.value && !value) return { ok: false, error: { code: 'INSUFFICIENT_EVIDENCE', message: `动作 ${a.id} 缺失值来源` } };
    const args = { ...(a.args ?? {}) };
    // save_as 绑定在遍历到 action 时更新（覆盖旧值，空字符串也是有效重绑；先于本 step
    // checks 的前向校验）。§8：build/check 共用 validateActionSavedValue（唯一保存值验证
    // 源）——选择输出/输入五 kind/fill_form map/scroll moved/导航 URL 各按实际事实核，
    // 再用已验证的 a.saved_value 更新前向 bindings。
    if (a.save_as) {
      const errs = validateActionSavedValue(a);
      if (errs.length > 0) {
        const code = errs[0].includes('缺 trace saved_value') || errs[0].includes('无法还原') ? 'INSUFFICIENT_EVIDENCE' : 'VALUE_CONTRACT_MISMATCH';
        return { ok: false, error: { code, message: `动作 ${a.id}（${a.kind}）${errs[0]}` } };
      }
      bindings.set(a.save_as, a.saved_value as string);
    }
    if (a.kind === 'fill_form' && args.fields && typeof args.fields === 'object') {
      // 用户字段名 map 用 null 原型对象：__proto__ key 保留为自有属性
      const fields: Record<string, Value> = Object.create(null);
      for (const [label, field] of Object.entries(args.fields)) {
        const value = traceValueToIR(field as ActionEvent['value']);
        if (!value) return { ok: false, error: { code: 'INSUFFICIENT_EVIDENCE', message: `表单字段 ${label} 缺失值来源` } };
        fields[label] = value;
      }
      args.fields = fields;
    }
    // §4/F10：每字段用自身 field_targets 还原 field_locators[name]（实际写时已验证候选，
    // 不按 action target/字段名猜 locator）；field_order 原样透传，Source 记录真实顺序
    if (a.kind === 'fill_form' && args.field_targets && typeof args.field_targets === 'object') {
      const fieldLocators: Record<string, unknown> = Object.create(null);
      for (const [name, raw] of Object.entries(args.field_targets as Record<string, unknown>)) {
        const loc = raw && typeof raw === 'object' ? targetToLocator({ target: raw as ActionEvent['target'] }) : undefined;
        if (!loc || !LocatorSchema.safeParse(loc).success) {
          return { ok: false, error: { code: 'INSUFFICIENT_EVIDENCE', message: `表单字段 ${name} 缺可还原定位（field_targets 无已验证候选）` } };
        }
        fieldLocators[name] = loc;
      }
      args.field_locators = fieldLocators;
    }
    if (a.kind === 'select' || a.kind === 'choose' || a.kind === 'category') {
      const gate = selectionEvidenceGate(a, args);
      if (gate) return gate;
    }
    if (a.kind === 'upload') {
      if (!Array.isArray(args.files) || args.files.length === 0) return { ok: false, error: { code: 'FIXTURE_UNAVAILABLE', message: `上传动作 ${a.id} 缺文件副本` } };
      const files: string[] = [];
      for (const file of args.files) {
        const bytes = typeof file?.blob_ref === 'string' ? readTraceBlob(sessionId, file.blob_ref) : null;
        if (!bytes || typeof file.name !== 'string' || !file.name || /[/\\\x00-\x1f\x7f]/.test(file.name) || file.name === '.' || file.name === '..') {
          return { ok: false, error: { code: 'FIXTURE_UNAVAILABLE', message: `上传动作 ${a.id} 的文件副本缺失、不安全或已损坏` } };
        }
        const filename = `${file.blob_ref.slice(6)}-${file.name}`;
        fixtures.push({ name: filename, bytes });
        files.push(filename);
      }
      args.files = files;
    }
    // 提取显式完成预算：从 trace action.args.wait_timeout_ms 复制到 step 级，校验；非法 → INSUFFICIENT_EVIDENCE
    let stepWaitTimeout: number | undefined;
    if (args.wait_timeout_ms !== undefined) {
      try { stepWaitTimeout = parseWaitTimeoutMs(args.wait_timeout_ms); }
      catch { return { ok: false, error: { code: 'INSUFFICIENT_EVIDENCE', message: `动作 ${a.id} 的 wait_timeout_ms 非法: ${JSON.stringify(args.wait_timeout_ms)}` } }; }
      delete args.wait_timeout_ms; // step 级表达，args 不重复携带
    }
    const actionReportRef = recordedReportRef(a);
    if (actionReportRef && !ReportRefSchema.safeParse(actionReportRef).success) {
      return { ok: false, error: { code: 'REPORT_METADATA', message: `动作 ${a.id} 的报告引用元数据无效` } };
    }
    const step: IRv2['steps'][number] = {
      id: 's' + seq,
      intent: a.intent,
      action: a.kind as IRv2['steps'][number]['action'],
      ...(actionReportRef ? { report_ref: actionReportRef } : {}),
      ...(parseFrame(a.frame) ? { frame: parseFrame(a.frame)! } : {}),
      ...(() => {
        const loc = locator;
        if (!loc) return {};
        const cands = a.target?.candidates ?? [];
        const fb: Locator[] = [];
        for (const c of cands) {
          if (fb.length >= 2) break;
          const cl = candidateToLocator(c);
          if (cl && JSON.stringify(cl) !== JSON.stringify(loc)) fb.push(cl);
        }
        return fb.length > 0 ? { locator: loc, fallback: fb } : { locator: loc };
      })(),
      args,
      ...(value ? { value } : {}),
      ...(a.save_as ? { save_as: a.save_as } : {}),
      ...(a.creates ? { creates: a.creates as Creates } : {}),
      ...(wait.length > 0 ? { wait } : {}),
      ...(stepWaitTimeout !== undefined ? { wait_timeout_ms: stepWaitTimeout } : {}),
      trace_ref: a.id,
    };

    // 先登记本 step 的 id 映射（同 step checks 的 from_action 可引用当前动作）
    stepIdByActionId.set(a.id, step.id);
    // 规则 6：assert/capture 按 after 挂到对应步骤的 checks，保持 trace 顺序
    const checks: Check[] = [];
    for (const ev of checkEvents) {
      if (ev.after !== a.id) continue;
      const reportRef = recordedReportRef(ev);
      if (reportRef && !ReportRefSchema.safeParse(reportRef).success) {
        return { ok: false, error: { code: 'REPORT_METADATA', message: `检查 ${ev.id ?? ev.after} 的报告引用元数据无效` } };
      }
      if (ev.t === 'assert') {
        // P4 无损回放门禁：脱敏改写过期望（或旧 trace 缺真标记）的 data 断言拒绝入 IR，
        // 不补推断/默认 true；缺标记旧 data trace 必须重新录制。
        if (ev.kind === 'data' && ev.replayable !== true) {
          return { ok: false, error: { code: 'ASSERT_NOT_REPLAYABLE', message: `断言 ${ev.after}:data 的期望值被脱敏改写或缺少 replayable 标记，不可无损回放`, hint: '该 data 断言必须用当前 CLI 重新录制' } };
        }
        const ir = traceAssertToIR(ev, bindings, stepIdByActionId, actionsById);
        if (ir) checks.push({ assert: ir, ...(parseFrame(ev.frame) ? { frame: parseFrame(ev.frame)! } : {}), ...(reportRef ? { report_ref: reportRef } : {}) });
        else return { ok: false, error: { code: 'INSUFFICIENT_EVIDENCE', message: `断言 ${ev.after}:${ev.kind} 无法从 trace 还原` } };
      } else {
        const ir = traceCaptureToIR(ev);
        if (ir) {
          checks.push({ capture: ir, ...(parseFrame(ev.frame) ? { frame: parseFrame(ev.frame)! } : {}), ...(reportRef ? { report_ref: reportRef } : {}) });
          if (ev.result.ok === true) bindings.set(ev.as, ev.result.value);
        } else {
          // Phase2：capture 不能漏、不能被 warning 吃掉
          return { ok: false, error: { code: 'INSUFFICIENT_EVIDENCE', message: `capture after=${ev.after} 无法从 trace 还原（缺 locator/read_mode 或候选证据）` } };
        }
      }
    }
    if (checks.length > 0) step.checks = checks;

    steps.push(step);
  }

  // dialog 事件转触发动作的 args.dialog（规则 6）
  for (const d of trace.dialogs) {
    const step = steps.find((s) => s.trace_ref === d.after);
    if (step) {
      step.args = { ...(step.args ?? {}), dialog: { ...((step.args?.dialog ?? {}) as Record<string, unknown>), accept: d.handled === 'accept', ...(d.registered ? {} : { note: '未预登记，自动 dismiss' }) } };
    }
  }

  // covered_pages：从 navigation.to 去重，排除 url 本身
  const session = trace.session;
  const topLevelUrl = session ? inferSessionUrl(trace) : '';
  const covered = new Set<string>();
  for (const n of trace.navigations) {
    if (n.to && n.to !== topLevelUrl) covered.add(n.to);
  }

  const ir: IRv2 = {
    schema_version: IR_SCHEMA_VERSION,
    name,
    url: topLevelUrl,
    covered_pages: [...covered],
    env: session?.env ?? 'default',
    provenance: {
      session_id: sessionId,
      auth_source: sessionAuth as IRv2['provenance']['auth_source'],
      browser_source: sessionBrowser as IRv2['provenance']['browser_source'],
      tool_version: opts.toolVersion ?? readPackageVersion(),
      generated_at: new Date().toISOString(),
      mocked: false,
    },
    steps,
  };

  const outDir = opts.outDir ?? path.join(e2etRoot(), 'workspace', 'ir');
  fs.mkdirSync(outDir, { recursive: true });
  if (fixtures.length > 0) {
    const fixtureDir = path.join(outDir, 'cases', 'fixtures', name);
    fs.mkdirSync(fixtureDir, { recursive: true });
    for (const fixture of fixtures) fs.writeFileSync(path.join(fixtureDir, fixture.name), fixture.bytes, { mode: 0o600 });
  }
  const irPath = path.join(outDir, `${name}.ir.json`);
  fs.writeFileSync(irPath, JSON.stringify(ir, null, 2), 'utf8');

  return {
    ok: true,
    ir,
    ir_path: irPath,
    kept_steps: kept.map((a) => a.id),
    dropped_steps: dropped,
    unmapped_actions: unmapped,
    warnings,
  };
}

/** 从 trace 推断用例入口 URL：第一个 action（open）的 args.url，或第一个 navigation 的 from。 */
function inferSessionUrl(trace: ParsedTrace): string {
  const openAction = trace.actions.find((a) => a.kind === 'open');
  if (openAction?.args?.url) return String(openAction.args.url);
  if (trace.navigations.length > 0) return trace.navigations[0].from;
  return '';
}
