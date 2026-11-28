import type { ElementProperty } from './dom-inspection.js';
import type { ConsoleCheck } from './console.js';

export interface RoleLocator { role: string; name?: string; within?: WithinLocator; }
export interface RowLocator { row: { contains: string }; role?: string; name?: string; }
export interface LabelLocator { label: string; }
export interface TextLocator { text: string; normalize?: boolean; }
export interface TestidLocator { testid: string; }
export interface CssLocator { css: string; }
export type WithinLocator = RoleLocator | RowLocator | LabelLocator;
export type Locator = RoleLocator | RowLocator | LabelLocator | TextLocator | TestidLocator | CssLocator;

export interface Frame { name?: string; url_contains?: string; selector?: string; }

export interface ValueLiteral { literal: string | number; }
export interface ValueTemplate { template: string; }
export interface ValueRef { ref: string; }
export interface ValueFromAction { from_action: string; }
export type Value = ValueLiteral | ValueTemplate | ValueRef | ValueFromAction;

export interface ApiRef { path: string; nav: number; call_index: number; }
export interface WaitApi { api: ApiRef; }
export interface WaitElementVisible { element: Locator; state: 'visible'; }
export interface WaitElementHidden { element: Locator; state: 'hidden'; }
export interface WaitElementAttached { element: Locator; state: 'attached'; }
export interface WaitElementDetached { element: Locator; state: 'detached'; }
export interface WaitText { text: string; }
export interface WaitUrl { url: { contains: string }; }
export interface WaitDomQuiet { dom_quiet: { ms: number }; }
export type Wait = WaitApi | WaitElementVisible | WaitElementHidden | WaitElementAttached | WaitElementDetached | WaitText | WaitUrl | WaitDomQuiet;

export type AssertOp = 'eq' | 'ne' | 'exists' | 'contains' | 'gt' | 'lt';

export interface ExpectEntryLiteral { path: string; op: AssertOp; value: unknown; }
export interface ExpectEntryRef { path: string; op: AssertOp; value_ref: string; }
export interface ExpectEntryFromAction { path: string; op: AssertOp; value_from_action: string; }
export type ExpectEntry = ExpectEntryLiteral | ExpectEntryRef | ExpectEntryFromAction;

/** body 或 header 恰好一个（schema 与 runtime 双守卫）。 */
export interface AssertApi { api: ApiRef; expect?: ExpectEntry[]; header?: ExpectEntry[]; }
/** body/query 恰好一个（schema 与 runtime 双守卫）。 */
export interface AssertRequest { request: ApiRef; body?: ExpectEntry[]; query?: ExpectEntry[]; }
export interface AssertToast { toast: string; }
export interface AssertText { text: { within?: Locator; contains: string; value?: Value }; }
export interface AssertVisible { visible: Locator; }
export interface AssertAbsent { absent: Locator; }
export interface AssertTableRow { table_row: { contains: string; count?: number }; }
export interface AssertFieldValue { field_value: { label: string; value: Value; locator: Locator; read_mode: 'value' | 'text' }; }
export interface AssertUrl { url: { contains: string }; }
export type PageDataSource = { local_storage: string; path?: string } | { global: string };
export interface AssertData { data: { source: PageDataSource; equals: string | number | boolean | null }; }
/** 计算样式断言：默认唯一目标，all 才逐个核对。 */
export interface AssertStyle { style: { locator: Locator; property: string; equals: string; pseudo?: 'before' | 'after'; all?: boolean }; }
export type ElementAssertValue = string | number | boolean | null | unknown[] | Record<string, unknown>;
/** 标准 DOM 属性断言；count 统计全部匹配且可为 0，其余属性零匹配不通过。 */
export interface AssertElement { element: { locator: Locator; property: ElementProperty | 'count'; op: AssertOp; value: ElementAssertValue; all?: boolean }; }
/** Console 断言：session 保留先前错误，action 显式收窄到当前/刚完成 action。 */
export interface AssertConsole { console: { check: ConsoleCheck; scope: 'session' | 'action' }; }
export type Assert =
  | AssertApi | AssertRequest | AssertToast | AssertText
  | AssertVisible | AssertAbsent | AssertTableRow | AssertFieldValue | AssertUrl | AssertData
  | AssertStyle | AssertElement | AssertConsole;

export type Lineage = 'created' | 'generated' | 'queried';
export interface CaptureFromApi { from_api: ApiRef; path: string; as: string; lineage: Lineage; }
export interface CaptureFromElement { from_element: Locator; as: string; lineage: Lineage; read_mode: 'value' | 'text'; }
export type Capture = CaptureFromApi | CaptureFromElement;

export interface ReportRef { group?: string; source_event_id?: string; check_id?: string; }
export interface CheckAssert { assert: Assert; frame?: Frame[]; report_ref?: ReportRef; }
export interface CheckCapture { capture: Capture; frame?: Frame[]; report_ref?: ReportRef; }
export type Check = CheckAssert | CheckCapture;

export type Action =
  | 'open' | 'click' | 'double_click' | 'type' | 'fill' | 'press' | 'select' | 'choose'
  | 'date' | 'category' | 'upload' | 'fill_form' | 'hover' | 'scroll'
  | 'switch_tab' | 'back' | 'refresh';

export interface Creates { entity: string; path: string; }

export interface Step {
  id: string;
  intent: string;
  action: Action;
  report_ref?: ReportRef;
  frame?: Frame[];
  locator?: Locator;
  fallback?: Locator[];
  args?: Record<string, unknown>;
  value?: Value;
  save_as?: string;
  creates?: Creates;
  wait?: Wait[];
  checks?: Check[];
  wait_timeout_ms?: number;
  trace_ref: string;
}

export interface Provenance {
  session_id: string;
  /** 录制事实标签，非空且只含安全字符；ci 仅为历史合法值，不表示运行模式。 */
  auth_source: string;
  browser_source: 'chrome-profile' | 'managed' | 'existing';
  tool_version: string;
  generated_at: string;
  mocked: boolean;
}

// ── 选择合同（Phase3a 选择子集）：原 src/browser/actions.ts 的定位候选/解析结果
// 两个原数据接口完整搬到此作 SSOT，agents 侧按原名字 type re-export，调用方不变。
// type-only 边界：不引入运行时 wrapper/DTO 转换，共享镜像仅 sync。──

/** 定位候选（ir build 选 fallback 用）。by 反映通道，matches==1 才进 candidates。 */
export interface TargetCandidate {
  by: 'role' | 'label' | 'text' | 'css';
  role?: string;
  name?: string;
  value?: string;
  selector?: string;
  matches: number;
}

/** daemon 返回给 CLI 的 target 摘要（resolved_by + role/name/matches）。
 *  selector：resolved_by==css 时回填入参 selector 原文，供 ir build 还原 css locator。
 *  candidates：matches==1 的候选定位，按优先级排，主定位排首，ir build 取非主定位进 fallback。 */
export interface ResolvedTargetInfo {
  backendNodeId: number;
  resolved_by: string;
  role: string;
  name: string;
  matches?: number;
  selector?: string;
  candidates?: TargetCandidate[];
}

/** 每次真实选择事实：pick 只在该次标准提交验证通过后追加。
 *  target 是本次实际选项自己的已验证候选（同一 ResolvedTargetInfo），不借根控件候选伪装选项。 */
export interface SelectionPick {
  input: string;
  role: string;
  name: string;
  match_mode: 'exact' | 'substring';
  target: ResolvedTargetInfo;
  /** 选择交互事实：mode=pointer 为点击 option，keyboard 为键盘导航提交，native 为原生 select。 */
  interaction: {
    mode: 'pointer' | 'keyboard' | 'native';
    /** 选择根与实际接收指针/按键/原生提交的节点，分别记录。 */
    root_backend: number;
    target_backend: number;
    active_descendant_id?: string;
    active_descendant_backend?: number;
    verification: { method: 'native-selected' | 'aria-selected' | 'aria-checked' | 'aria-expanded' | 'child-pool'; result: true };
    already_selected: boolean;
    inventory_scope: 'keyboard-reachable' | 'dom-pool' | 'native-options';
    observed_count: number;
  };
}

/** 选择作用域：related=根 aria-controls/owns 声明的关联池；page=无声明时全页唯一可见池。 */
export interface SelectionFact {
  scope: 'related' | 'page';
  picks: SelectionPick[];
}

/** 选择事实即时记录器（F03：每项真实成功后立即通知，失败动作也保留已发生 picks）。
  * scope 是本动作初始根的实际池决策，category 子层关系不改写。 */
export type SelectionRecorder = (scope: SelectionFact['scope'], pick: SelectionPick) => void;

/** ref 稳定身份（§7）：candidate 只收已验证事实（录制时全树唯一 roleLocator / 实际
 *  解析返回的 collector 候选），source 记录身份来源，不猜角色、不后补旧证据。 */
export interface RefIdentity {
  candidate: TargetCandidate;
  source: 'snapshot' | 'collector';
}

/** §8 输出合同：明确可保存输出的 action kind（switch_tab 输出接线归 B 批，仅常量占位） */
export const ACTION_OUTPUT_KINDS: readonly string[] = [
  'open', 'type', 'fill', 'select', 'date', 'choose', 'category', 'fill_form', 'scroll', 'back', 'refresh', 'switch_tab',
];


/** 输入提交登记：writer 取得实际写入叶后立即通过 recordInput 回调登记。
 *  step 持有 InputCommit[]，不构造 registry class/framework。
 *  verify 在原闭包回读实际叶当前值，actual===expected 才成功，否则 FILL_NOT_COMMITTED。
 *  verify 返回纯数据证据（原 leaf、actual/expected、after-wait 时点），不返回 void。
 *  dispose 释放句柄（CDP objectId / PW ElementHandle），释放失败不覆盖原始错误。 */
export interface InputCommit {
  verify(): Promise<Omit<InputCommitEvidence, 'phase'>>;
  dispose(): Promise<void>;
}

/** 输入提交证据：verify 返回的纯数据，用于 trace/JSON/报告展示。 */
export interface InputCommitEvidence {
  /** 实际写入叶节点描述 */
  target: { backend_node_id?: number; selector?: string; role?: string; name?: string };
  /** 期望值（writer 入参） */
  expected: string;
  /** 回读实际值 */
  actual: string;
  /** 读取时点：after-wait = wait+dialog 完成后、completedActionValues 发布前 */
  phase: 'after-wait';
  /** Source 侧 CDP 输入后端 */
  backend?: 'insertText' | 'dispatchKeyEvent' | 'native';
}

/** 输入登记回调：writer 取得实际写入叶后立即调用，传入 verify/dispose 闭包。 */
export type RecordInputCallback = (commit: InputCommit) => void;
export interface IRv2 {
  schema_version: 3;
  name: string;
  description?: string;
  url: string;
  covered_pages: string[];
  env: string;
  provenance: Provenance;
  steps: Step[];
}
