/**
 * IR v2 schema —— trace-ir-spec.md 第 2 节的字段定义。
 * zod 既是类型源又是校验器，schema 修改后类型自动同步。
 */
import { z } from 'zod';
import { MAX_WAIT_TIMEOUT_MS, replayTimeoutMs } from '../wait-timeout.js';
import { IR_SCHEMA_VERSION } from '../shared/versions.js';
import { validateStepInputs } from '../shared/step-input.js';
import { ELEMENT_PROPERTIES } from '../shared/dom-inspection.js';
import type { IRv2 as SharedIRv2, Step as SharedStep, Value as SharedValue, ExpectEntry as SharedExpectEntry, Locator as SharedLocator, WithinLocator as SharedWithinLocator, Frame as SharedFrame, Wait as SharedWait, Check as SharedCheck, Assert as SharedAssert, Capture as SharedCapture, Creates as SharedCreates, Provenance as SharedProvenance } from '../shared/types.js';


// ── locator（spec 2.4）── discriminated union，按 by 字段分发 ──

// within 限定器：role 容器或 row 锚或 label 锚（递归用 z.lazy 打破循环引用）
// Phase2：递归 within 用共源 SharedWithinLocator 做类型约束，不透出 any
const WithinSchema: z.ZodType<SharedWithinLocator> = z.lazy(() => z.union([
  RoleLocator,
  RowLocator,
  LabelLocator,
]));

const RoleLocator = z.object({
  role: z.string().min(1),
  name: z.string().optional(),
  within: WithinSchema.optional(),
}).strict();
const RowLocator = z.object({
  row: z.object({ contains: z.string() }).strict(),
  role: z.string().optional(),
  name: z.string().optional(),
}).strict();
const LabelLocator = z.object({
  label: z.string().min(1),
}).strict();
const TextLocator = z.object({
  text: z.string().min(1),
  normalize: z.boolean().optional(),
}).strict();
const TestidLocator = z.object({
  testid: z.string().min(1),
}).strict();
const CssLocator = z.object({
  css: z.string().min(1),
}).strict();

export const LocatorSchema = z.union([
  RoleLocator,
  RowLocator,
  LabelLocator,
  TextLocator,
  TestidLocator,
  CssLocator,
]);
export type Locator = z.infer<typeof LocatorSchema>;
export type WithinLocator = SharedWithinLocator;

export const FrameSchema = z.object({
  name: z.string().optional(),
  url_contains: z.string().optional(),
  selector: z.string().optional(),
});
export type Frame = z.infer<typeof FrameSchema>;

// ── value（spec 2.5）──

const ValueLiteral = z.object({ literal: z.union([z.string(), z.number()]) }).strict();
const ValueTemplate = z.object({ template: z.string() }).strict();
const ValueRef = z.object({ ref: z.string() }).strict();

const ValueFromAction = z.object({ from_action: z.string() }).strict();

export const ValueSchema = z.union([ValueLiteral, ValueTemplate, ValueRef, ValueFromAction]);
export type Value = z.infer<typeof ValueSchema>;

// ── wait（spec 2.5）──

const ApiRef = z.object({
  path: z.string().min(1),
  nav: z.number().int().positive(),
  call_index: z.number().int().positive(),
});

const WaitApi = z.object({ api: ApiRef.strict() }).strict();
const WaitElementVisible = z.object({ element: LocatorSchema, state: z.literal('visible') }).strict();
const WaitElementHidden = z.object({ element: LocatorSchema, state: z.literal('hidden') }).strict();
const WaitElementAttached = z.object({ element: LocatorSchema, state: z.literal('attached') }).strict();
const WaitElementDetached = z.object({ element: LocatorSchema, state: z.literal('detached') }).strict();
const WaitText = z.object({ text: z.string().refine((text) => text.trim().length > 0) }).strict();
const WaitUrl = z.object({ url: z.object({ contains: z.string().refine((url) => url.trim().length > 0) }).strict() }).strict();
const WaitDomQuiet = z.object({ dom_quiet: z.object({ ms: z.number().int().positive() }).strict() }).strict();

export const WaitSchema = z.union([
  WaitApi,
  WaitElementVisible,
  WaitElementHidden,
  WaitElementAttached,
  WaitElementDetached,
  WaitText,
  WaitUrl,
  WaitDomQuiet,
]);
export type Wait = z.infer<typeof WaitSchema>;

// ── checks（spec 2.6）──

const AssertOp = z.enum(['eq', 'ne', 'exists', 'contains', 'gt', 'lt']);

const ExpectEntryLiteral = z.object({
  path: z.string().min(1),
  op: AssertOp,
  value: z.unknown(),
}).strict().superRefine((e, ctx) => {
  // Phase2：z.unknown 自身不保证键必填；先做 required-key 验证，再 transform 明确返回必填形态
  if (!('value' in e)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['value'], message: 'literal 期望必须携带 value 键' });
}).transform((e) => ({ path: e.path, op: e.op, value: e.value }));
const ExpectEntryRef = z.object({
  path: z.string().min(1),
  op: AssertOp,
  value_ref: z.string(),
}).strict();
const ExpectEntryFromAction = z.object({
  path: z.string().min(1),
  op: AssertOp,
  value_from_action: z.string(),
}).strict();
const ExpectEntry = z.union([ExpectEntryLiteral, ExpectEntryRef, ExpectEntryFromAction]);
// transform 后 zod 输出即必填形态，导出类型直接 z.infer，不用交集/any 把 gate 抹绿
export type ExpectEntryLiteral = z.infer<typeof ExpectEntryLiteral>;
export type ExpectEntryRef = z.infer<typeof ExpectEntryRef>;
export type ExpectEntryFromAction = z.infer<typeof ExpectEntryFromAction>;
export type ExpectEntry = z.infer<typeof ExpectEntry>;

const AssertApi = z.object({
  api: ApiRef,
  expect: z.array(ExpectEntry).min(1).optional(),
  header: z.array(ExpectEntry).min(1).optional(),
}).strict().superRefine((e, ctx) => {
  if ((e.expect === undefined) === (e.header === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'api 断言 body/header 必须恰好提供一个' });
  }
});
const AssertRequest = z.object({
  request: ApiRef,
  body: z.array(ExpectEntry).min(1).optional(),
  query: z.array(ExpectEntry).min(1).optional(),
}).strict().superRefine((e, ctx) => {
  if ((e.body === undefined) === (e.query === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'request 断言 body/query 必须恰好提供一个' });
  }
});
const AssertToast = z.object({ toast: z.string() });
const AssertText = z.object({
  text: z.object({ within: LocatorSchema.optional(), contains: z.string(), value: ValueSchema.optional() }),
});
const AssertVisible = z.object({ visible: LocatorSchema });
const AssertAbsent = z.object({ absent: LocatorSchema });
const AssertTableRow = z.object({
  table_row: z.object({ contains: z.string(), count: z.number().int().positive().optional() }),
});
const AssertFieldValue = z.object({
  field_value: z.object({
    label: z.string(),
    value: ValueSchema,
    locator: LocatorSchema,
    read_mode: z.enum(['value', 'text']),
  }),
});
const AssertUrl = z.object({ url: z.object({ contains: z.string() }) });

// P2：页面数据断言（dot path 合同与生成侧 isValidDotPath 一致：非空段、无 [] / 过滤 / 空白）
const JsonScalar = z.union([z.string(), z.number().refine(Number.isFinite), z.boolean(), z.null()]);
const PageDataSourceLocalStorage = z.object({
  local_storage: z.string().min(1),
  path: z.string().min(1).refine((p) => {
    const segs = p.split('.');
    return segs.length > 0 && segs.every((s) => s.length > 0 && !/[\[\]=\s]/.test(s));
  }, 'path 只支持 dot path（如 record.mode / items.0.id），不支持 [] / 过滤 / 空段').optional(),
}).strict();
const PageDataSourceGlobal = z.object({ global: z.string().min(1) }).strict();
export const PageDataSourceSchema = z.union([PageDataSourceLocalStorage, PageDataSourceGlobal]);
export type PageDataSourceIR = z.infer<typeof PageDataSourceSchema>;
const AssertData = z.object({
  data: z.object({
    source: PageDataSourceSchema,
    equals: JsonScalar,
  }),
});

const AssertStyle = z.object({
  style: z.object({
    locator: LocatorSchema,
    property: z.string().min(1),
    equals: z.string(),
    pseudo: z.enum(['before', 'after']).optional(),
    all: z.boolean().optional(),
  }).strict(),
});
const ElementProperty = z.enum([...ELEMENT_PROPERTIES, 'count']);
const ElementAssertValue = z.union([
  z.string(), z.number(), z.boolean(), z.null(), z.array(z.unknown()), z.record(z.unknown()),
]);
const AssertElement = z.object({
  element: z.object({
    locator: LocatorSchema,
    property: ElementProperty,
    op: AssertOp,
    value: ElementAssertValue,
    all: z.boolean().optional(),
  }).strict(),
});
const ConsoleCheck = z.union([
  z.object({ noError: z.literal(true) }).strict(),
  z.object({
    level: z.enum(['log', 'debug', 'info', 'warning', 'error', 'trace']),
    contains: z.string().optional(),
    count: z.number().int().nonnegative(),
  }).strict(),
]);
const AssertConsole = z.object({
  console: z.object({
    check: ConsoleCheck,
    scope: z.enum(['session', 'action']),
  }).strict(),
});

export const AssertSchema = z.union([
  AssertApi,
  AssertRequest,
  AssertToast,
  AssertText,
  AssertVisible,
  AssertAbsent,
  AssertTableRow,
  AssertFieldValue,
  AssertUrl,
  AssertData,
  AssertStyle,
  AssertElement,
  AssertConsole,
]);
export type Assert = z.infer<typeof AssertSchema>;

const Lineage = z.enum(['created', 'generated', 'queried']);

const CaptureFromApi = z.object({
  from_api: ApiRef,
  path: z.string().min(1),
  as: z.string().min(1),
  lineage: Lineage,
});
const CaptureFromElement = z.object({
  from_element: LocatorSchema,
  as: z.string().min(1),
  lineage: Lineage,
  read_mode: z.enum(['value', 'text']),
});

export const CaptureSchema = z.union([CaptureFromApi, CaptureFromElement]);
export type Capture = z.infer<typeof CaptureSchema>;

const ReportIdentity = z.string().refine(value => value.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value), '报告身份必须为非空且无控制符的字符串');
export const ReportRefSchema = z.object({
  group: ReportIdentity.optional(),
  source_event_id: ReportIdentity.optional(),
  check_id: ReportIdentity.optional(),
}).strict();
export type ReportRef = z.infer<typeof ReportRefSchema>;

export const CheckSchema = z.union([
  z.object({ assert: AssertSchema, frame: z.array(FrameSchema).optional(), report_ref: ReportRefSchema.optional() }),
  z.object({ capture: CaptureSchema, frame: z.array(FrameSchema).optional(), report_ref: ReportRefSchema.optional() }),
]);
export type Check = z.infer<typeof CheckSchema>;

// ── action（spec 2.3）──

export const ActionKind = z.enum([
  'open', 'click', 'double_click', 'type', 'fill', 'press', 'select', 'choose',
  'date', 'category', 'upload', 'fill_form', 'hover', 'scroll',
  'switch_tab', 'back', 'refresh',
]);
export type Action = z.infer<typeof ActionKind>;

// ── creates（spec 1.3，trace 已落盘）──

export const CreatesSchema = z.object({
  entity: z.string().min(1),
  path: z.string().min(1),
});
export type Creates = z.infer<typeof CreatesSchema>;

// ── step（spec 2.2）──

export const StepSchema = z.object({
  id: z.string().min(1),
  intent: z.string(),
  action: ActionKind,
  report_ref: ReportRefSchema.optional(),
  frame: z.array(FrameSchema).optional(),
  locator: LocatorSchema.optional(),
  fallback: z.array(LocatorSchema).max(2).optional(),
  args: z.record(z.unknown()).optional(),
  value: ValueSchema.optional(),
  save_as: z.string().optional(),
  creates: CreatesSchema.optional(),
  wait: z.array(WaitSchema).optional(),
  checks: z.array(CheckSchema).optional(),
  /** 显式完成预算（ms）：正整数，≤ MAX_WAIT_TIMEOUT_MS。 */
  wait_timeout_ms: z.number().int().positive().max(MAX_WAIT_TIMEOUT_MS).optional(),
  trace_ref: z.string().min(1),
}).superRefine((s, ctx) => {
  // R1/LC4：必需输入守卫与 runtime executeAction 前置共用（shared/step-input）
  for (const msg of validateStepInputs(s as SharedStep)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [], message: msg });
  }
  // fill_form 成员形态：逐成员 safeParse 报准确字段路径，不重建动态字段 map（会丢 __proto__）
  if (s.action === 'fill_form') {
    const args = (s.args ?? {}) as Record<string, unknown>;
    const fields = args.fields;
    const fieldLocators = args.field_locators;
    if (typeof fields === 'object' && fields !== null && !Array.isArray(fields)) {
      for (const [fieldKey, fieldValue] of Object.entries(fields)) {
        if (!ValueSchema.safeParse(fieldValue).success) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['args', 'fields', fieldKey], message: `fill_form fields["${fieldKey}"] 不是合法 Value` });
        }
      }
    }
    if (typeof fieldLocators === 'object' && fieldLocators !== null && !Array.isArray(fieldLocators)) {
      for (const [locatorKey, locatorValue] of Object.entries(fieldLocators)) {
        if (!LocatorSchema.safeParse(locatorValue).success) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['args', 'field_locators', locatorKey], message: `fill_form field_locators["${locatorKey}"] 不是合法 Locator` });
        }
      }
    }
  }
});
export type Step = z.infer<typeof StepSchema>;

// ── provenance ──

/** 录制来源是安全标签；ci 仅作为历史事实继续可读，不驱动运行模式。 */
export const AUTH_SOURCE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const AuthSourceSchema = z.string().regex(
  AUTH_SOURCE_RE,
  'auth_source 只允许字母数字开头，后续可为字母数字、点、下划线、连字符',
);
export const BrowserSourceEnum = z.enum(['chrome-profile', 'managed', 'existing']);

export const ProvenanceSchema = z.object({
  session_id: z.string().min(1),
  auth_source: AuthSourceSchema,
  browser_source: BrowserSourceEnum,
  tool_version: z.string(),
  generated_at: z.string(),
  mocked: z.boolean(),
}).superRefine((p, ctx) => {
  // P4：合法组合——chrome-profile 只配 profile；managed/existing 可配其它安全标签。
  // 回放环境组合是显式输入：IR 不嵌入私人 state 内容/profile 路径/CDP 凭据端点，只声明来源枚举。
  if ((p.browser_source === 'chrome-profile') !== (p.auth_source === 'profile')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['browser_source'],
      message: `provenance 来源组合不合法: auth_source=${p.auth_source} + browser_source=${p.browser_source}`,
    });
  }
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

// ── 顶层（spec 2.1）──

export const IRv2Schema = z.object({
  schema_version: z.literal(IR_SCHEMA_VERSION),
  name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
  description: z.string().optional(),
  url: z.string().min(1),
  covered_pages: z.array(z.string()).default([]),
  env: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'env 只允许字母数字开头，后续可为字母数字、点、下划线、连字符'),
  provenance: ProvenanceSchema,
  steps: z.array(StepSchema),
}).superRefine((ir, ctx) => {
  // 顶层聚合 replay 预算 overflow：复用共享 replayTimeoutMs，不重复公式
  try {
    replayTimeoutMs(ir.steps);
  } catch (e) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['steps'], message: `replay 预算溢出: ${(e as Error).message}` });
  }
});
export type IRv2 = z.infer<typeof IRv2Schema>;

export type ParseError = { ok: false; error: { code: 'SCHEMA'; issues: { path: string; message: string }[] } };
export type ParseOk = { ok: true; ir: IRv2 };
export type ParseResult = ParseOk | ParseError;

/** 解析并校验 IR v2。失败返回结构化错误，不抛。 */
export function parseIRv2(input: unknown): ParseResult {
  const res = IRv2Schema.safeParse(input);
  if (res.success) return { ok: true, ir: res.data };
  return {
    ok: false,
    error: {
      code: 'SCHEMA',
      issues: res.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    },
  };
}
// 编译期等价断言：zod output 类型与 shared/types.ts 必须双向 assignable
type _AssertValue = Value extends SharedValue ? SharedValue extends Value ? true : never : never;
type _AssertLoc = Locator extends SharedLocator ? SharedLocator extends Locator ? true : never : never;
type _AssertFrame = Frame extends SharedFrame ? SharedFrame extends Frame ? true : never : never;
type _AssertWait = Wait extends SharedWait ? SharedWait extends Wait ? true : never : never;
type _AssertProv = Provenance extends SharedProvenance ? SharedProvenance extends Provenance ? true : never : never;
type _AssertCreates = Creates extends SharedCreates ? SharedCreates extends Creates ? true : never : never;
type _AssertExpectEntry = ExpectEntry extends SharedExpectEntry ? SharedExpectEntry extends ExpectEntry ? true : never : never;
type _AssertAssert = Assert extends SharedAssert ? SharedAssert extends Assert ? true : never : never;
type _AssertCapture = Capture extends SharedCapture ? SharedCapture extends Capture ? true : never : never;
type _AssertCheck = Check extends SharedCheck ? SharedCheck extends Check ? true : never : never;
type _AssertStep = Step extends SharedStep ? SharedStep extends Step ? true : never : never;
type _AssertIr = IRv2 extends SharedIRv2 ? SharedIRv2 extends IRv2 ? true : never : never;
const _valueEq: _AssertValue = true;
const _locEq: _AssertLoc = true;
const _frameEq: _AssertFrame = true; const _waitEq: _AssertWait = true;
const _provEq: _AssertProv = true;
const _createsEq: _AssertCreates = true;
const _expectEntryEq: _AssertExpectEntry = true;
const _assertEq: _AssertAssert = true; const _captureEq: _AssertCapture = true; const _checkEq: _AssertCheck = true;
const _stepEq: _AssertStep = true; const _irEq: _AssertIr = true;
void _valueEq; void _locEq; void _frameEq;
void _waitEq; void _provEq; void _createsEq;
void _expectEntryEq; void _assertEq; void _captureEq; void _checkEq; void _stepEq; void _irEq;
