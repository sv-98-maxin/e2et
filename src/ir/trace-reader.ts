/**
 * trace 事件强类型读取（trace-ir-spec.md 第 1 节）。
 * 只覆盖 ir build / ir check / judge 需要的字段，不重复 trace 落盘逻辑。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { traceRoot } from '../daemon/session-meta.js';
import { TRACE_SCHEMA_VERSION } from '../shared/versions.js';
import type { Value } from '../shared/types.js';
import type { RefIdentity } from '../shared/types.js';
import type { FrameDesc } from '../browser/page-state.js';
import type { Locator } from './schema.js';

export class TraceVersionError extends Error {
  readonly code = 'TRACE_VERSION_UNSUPPORTED';
}

function validateVersion(events: TraceEvent[]): void {
  const session = events[0];
  if (session?.t !== 'session' || session.schema_version !== TRACE_SCHEMA_VERSION) {
    throw new TraceVersionError(`trace schema_version 必须是 ${TRACE_SCHEMA_VERSION}，实际 ${session?.schema_version ?? '缺失'}；请重新录制会话`);
  }
}

export interface TraceEvent {
  t: string;
  id?: string;
  ts?: number;
  [k: string]: unknown;
}

export interface SessionEvent extends TraceEvent {
  t: 'session';
  session_id: string;
  schema_version: number;
  env: string;
  tool_version: string;
  auth_source?: string;
  /** P4：真实浏览器来源（chrome-profile / managed / existing；session 事件已记录的字段） */
  browser_source?: string;
}

export interface SessionEndEvent extends TraceEvent {
  t: 'session_end';
  result: 'pass' | 'fail' | 'blocked' | 'aborted';
  mocked?: boolean;
  asserts?: { total: number; pass: number };
  timeouts?: number;
}

export interface ActionEvent extends TraceEvent {
  t: 'action';
  id: string;
  kind: string;
  intent: string;
  nav: string;
  args?: Record<string, unknown>;
  value?: { raw: string; origin: 'literal' | 'generated' | 'captured'; template?: string; ref?: string };
  save_as?: string;
  creates?: { entity: string; path: string };
  frame?: FrameDesc[];
  settled_by?: Array<{ kind: string; ref?: string; ms?: number; quiet_ms?: number; target?: string; resolved?: ActionEvent['target']; locator?: Locator; identity?: RefIdentity; observation?: { matches: number; role?: string; name?: string; visible?: boolean }; text?: string; url?: string }>;
  target?: {
    resolved_by: 'index' | 'css' | 'ax' | 'dom-text' | string;
    role?: string;
    name?: string;
    matches?: number;
    backendNodeId?: number;
    selector?: string;
    within?: Locator;
    candidates?: Array<{ by: 'role' | 'label' | 'text' | 'css'; role?: string; name?: string; value?: string; selector?: string; within?: Locator; matches: number }>;
  };
  requests?: string[];
  result?: { ok: boolean };
  /** switch-tab 真实目标证据（IR build/check 据此区分真实 switch 与旧假 history switch） */
  resolved_tab?: { target_id: string; url: string; resolved_index: number; from_target_id?: string };
  replayable?: boolean;
  resolved_value?: string;
  /** §8 输出合同：choose/category 的实际 picked label 数组 JSON（save_as 绑定源） */
  output_value?: string;
  /** save_as 成功提交的值（仅成功事件；失败事件无该字段） */
  saved_value?: string;
  source_action?: string;
}

/** Phase2：trace 事件携带的 ActionValue（assert 事件的显式期望来源；source_action 是引用动作 id） */
export type TraceActionValue = NonNullable<ActionEvent['value']> & { source_action?: string };

/** trace value → IR value（spec 3.4，S7 共享转换）。generated→template, captured→ref,
 *  literal 原样。build/check 复用同一函数，比较声明，不二次生成值。 */
export function traceValueToIR(v: ActionEvent['value']): Value | undefined {
  if (!v) return undefined;
  if (v.origin === 'generated' && v.template) return { template: v.template };
  if (v.origin === 'captured' && v.ref) return { ref: v.ref };
  if (v.origin !== 'literal') return undefined;
  return { literal: v.raw };
}

export interface RequestEvent extends TraceEvent {
  t: 'request';
  id: string;
  path: string;
  nav: string;
  call_index: number;
  method?: string;
  url?: string;
  url_redacted?: boolean;
  status?: number;
  failed?: string | null;
  creates?: string;
  triggered_by?: string | null;
  req_body_ref?: string;
  resp_body_ref?: string;
  req_body_omitted?: string;
  resp_body_omitted?: string;
  req_body_redacted_paths?: string[][];
  resp_body_redacted_paths?: string[][];
}

export interface NavigationEvent extends TraceEvent {
  t: 'navigation';
  id: string;
  from: string;
  to: string;
  kind: 'same_page' | 'spa_route' | 'new_tab';
  triggered_by?: string | null;
}

export interface AssertEvent extends TraceEvent {
  t: 'assert';
  after: string;
  kind: string;
  expect: unknown;
  actual: unknown;
  pass: boolean;
  evidence?: unknown[];
  target?: ActionEvent['target'];
  within?: ActionEvent['target'];
  value?: TraceActionValue;
  /** P2：data 断言指向的观察证据（observation.id）；只 data 断言必须有 */
  observation_ref?: string;
  /** P4：data 断言期望值是否未被脱敏改写（replayable=equalsScrubbed===expected）。
   *  无损回放技术门禁的标记：false/缺失部不可作为可回放断言入 IR（build/check 拒绝），
   *  不保存原始敏感期望、不做字符串启发式。只 data 断言写入。 */
  replayable?: boolean;
  read_mode?: 'value' | 'text';
  /** §7：本 assert 自身使用的 ref 稳定身份（indexed absent 重查依据；builder 据此产 absent locator） */
  identity?: RefIdentity;
  /** 路径未命中诊断：missing 表示 jsonPath 返回 undefined（路径不存在）；ok 正常。only api/request。 */
  path_status?: 'ok' | 'missing';
  /** 该检查自身的 frame 作用域，独立于 action.frame。 */
  frame?: FrameDesc[];
}

/** P2 观察事件：page read / assert data 的构造受限协议读取证据（不是 action，
 *  不改变 lastFinishedActionId/creates/计数）。旧 trace 无此事件 → observations 为空数组。 */
export interface ObservationEvent extends TraceEvent {
  t: 'observation';
  id: string;
  ts: number;
  source: { local_storage: string; path?: string } | { global: string };
  after?: string;
  group?: string;
  target_id?: string;
  document?: { frame_id: string; loader_id: string };
  nav?: string;
  url?: string;
  origin?: string;
  result: { ok: true; present: boolean; value?: string | number | boolean | null } | { ok: false; error: { code: string; message: string } };
  replayable?: boolean; // event-level
}

export interface CaptureEvent extends TraceEvent {
  t: 'capture';
  after: string;
  as: string;
  replayable: boolean;
  result: { ok: true; value: string; from: unknown; lineage: 'created' | 'generated' | 'queried'; path?: string; target?: ActionEvent['target']; read_mode?: 'value' | 'text' } | { ok: false; error: { code: string } };
  frame?: FrameDesc[];
}

export interface DialogEvent extends TraceEvent {
  t: 'dialog';
  after: string;
  kind: string;
  message: string;
  handled: 'accept' | 'dismiss';
  registered: boolean;
}

export interface MockEvent extends TraceEvent {
  t: 'mock';
  op: 'add' | 'clear';
  path?: string;
}

/** 读完整 trace；文件不存在返回 null，损坏证据拒绝读取。 */
export function readTrace(sessionId: string): TraceEvent[] | null {
  const file = path.join(traceRoot(), sessionId, 'trace.jsonl');
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY);
  } catch {
    return null;
  }
  try {
    const content = fs.readFileSync(fd, 'utf8');
    const out: TraceEvent[] = [];
    for (const line of content.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      out.push(JSON.parse(t) as TraceEvent);
    }
    validateVersion(out);
    return out;
  } finally {
    fs.closeSync(fd);
  }
}

export interface ParsedTrace {
  session?: SessionEvent;
  sessionEnd?: SessionEndEvent;
  actions: ActionEvent[];
  requests: RequestEvent[];
  navigations: NavigationEvent[];
  asserts: AssertEvent[];
  captures: CaptureEvent[];
  dialogs: DialogEvent[];
  mocks: MockEvent[];
  /** P2 观察事件（旧 trace 无 → 空数组） */
  observations: ObservationEvent[];
  /** Phase2：assert/capture 事件按原 trace 顺序（checks 一对一核对用） */
  checkEvents: Array<AssertEvent | CaptureEvent>;
}

/** 按类型分桶。session_end 缺失视为 aborted（spec 1.2）。 */
export function parseTrace(events: TraceEvent[]): ParsedTrace {
  validateVersion(events);
  const out: ParsedTrace = {
    actions: [], requests: [], navigations: [], asserts: [], captures: [], dialogs: [], mocks: [], observations: [], checkEvents: [],
  };
  for (const ev of events) {
    switch (ev.t) {
      case 'session': out.session = ev as unknown as SessionEvent; break;
      case 'session_end': out.sessionEnd = ev as unknown as SessionEndEvent; break;
      case 'action': out.actions.push(ev as unknown as ActionEvent); break;
      case 'request': out.requests.push(ev as unknown as RequestEvent); break;
      case 'navigation': out.navigations.push(ev as unknown as NavigationEvent); break;
      case 'assert': out.asserts.push(ev as unknown as AssertEvent); out.checkEvents.push(ev as unknown as AssertEvent); break;
      case 'observation': out.observations.push(ev as unknown as ObservationEvent); break;
      case 'capture': out.captures.push(ev as unknown as CaptureEvent); out.checkEvents.push(ev as unknown as CaptureEvent); break;
      case 'dialog': out.dialogs.push(ev as unknown as DialogEvent); break;
      case 'mock': out.mocks.push(ev as unknown as MockEvent); break;
    }
  }
  return out;
}
