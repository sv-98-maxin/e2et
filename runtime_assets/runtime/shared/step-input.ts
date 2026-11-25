/** 必需输入结构守卫（R1/LC4）：schema superRefine 与 runtime executeAction 前置共用。
 *  只核必需结构；fixture 路径/open 后 wait/creates/trace 一致性仍在 ir/check 原位置。
 *  `__proto__` 是普通 own key：不黑名单、不改 map 原型，执行顺序只认 field_order。 */
import type { Step } from './types.js';

const LOCATOR_REQUIRED_ACTIONS: ReadonlySet<string> = new Set([
  'click', 'double_click', 'type', 'fill', 'select', 'choose', 'date', 'category', 'upload', 'hover',
]);

const VALUE_REQUIRED_ACTIONS: ReadonlySet<string> = new Set(['open', 'type', 'fill', 'select', 'date']);

const SCROLL_DIRECTIONS: ReadonlySet<string> = new Set(['up', 'down', 'left', 'right']);

const FIXTURE_NAME_RE = /^[0-9a-f]{64}-.+$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateFillFormShape(args: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const fields = args.fields;
  const fieldLocators = args.field_locators;
  const fieldOrder = args.field_order;
  const scope = args.scope;
  if (!isPlainObject(fields) || Object.keys(fields).length === 0) {
    errors.push('fill_form 必须有非空对象 args.fields');
  }
  if (!isPlainObject(fieldLocators) || Object.keys(fieldLocators).length === 0) {
    errors.push('fill_form 必须有非空对象 args.field_locators');
  }
  if (isPlainObject(fields) && isPlainObject(fieldLocators)) {
    const fieldKeys = Object.keys(fields);
    const locatorKeys = Object.keys(fieldLocators);
    if (JSON.stringify([...fieldKeys].sort()) !== JSON.stringify([...locatorKeys].sort())) {
      errors.push(`fill_form fields 与 field_locators key 集合不一一对应（${JSON.stringify(fieldKeys)} vs ${JSON.stringify(locatorKeys)}）`);
    }
    if (!Array.isArray(fieldOrder) || fieldOrder.length === 0 || fieldOrder.some((fieldName) => typeof fieldName !== 'string' || fieldName === '')) {
      errors.push('fill_form 必须有非空字符串数组 args.field_order（真实写入顺序）');
    } else {
      const names = fieldOrder.map(String);
      if (new Set(names).size !== names.length) {
        errors.push('fill_form field_order 含重复字段名');
      }
      if (JSON.stringify([...names].sort()) !== JSON.stringify([...fieldKeys].sort())) {
        errors.push(`fill_form field_order 未恰好覆盖 fields key 集合（${JSON.stringify(names)} vs ${JSON.stringify(fieldKeys)}）`);
      }
    }
    for (const [fieldName, fieldValue] of Object.entries(fields)) {
      if (!isPlainObject(fieldValue)) errors.push(`fill_form fields["${fieldName}"] 缺失或非 Value 对象`);
    }
    for (const [locatorKey, locatorValue] of Object.entries(fieldLocators)) {
      if (!isPlainObject(locatorValue)) errors.push(`fill_form field_locators["${locatorKey}"] 缺失或非 Locator 对象`);
    }
  }
  if (scope !== 'required' && scope !== 'all' && scope !== 'targeted') {
    errors.push(`fill_form args.scope 必须是 required/all/targeted（收到 ${JSON.stringify(scope)}）`);
  }
  return errors;
}

export function isSafeFixtureName(value: unknown): value is string {
  return typeof value === 'string'
    && FIXTURE_NAME_RE.test(value)
    && !/[/\\\x00-\x1f\x7f]/.test(value);
}

/** 校验 step 必需输入结构。返回错误消息数组（空数组=通过）；不抛错。 */
export function validateStepInputs(step: Step): string[] {
  const errors: string[] = [];
  const action = step.action;
  const args = (step.args ?? {}) as Record<string, unknown>;

  // locator 必需（fallback 不能代替主 locator）；press 沿焦点执行、locator 非必需
  if (LOCATOR_REQUIRED_ACTIONS.has(action) && !step.locator) {
    errors.push(`${action} 必须有 locator`);
  }

  // 五输入 kind Value 必需：literal 空串/0 合法，不回退 args 槽
  if (VALUE_REQUIRED_ACTIONS.has(action) && step.value === undefined) {
    errors.push(`${action} 必须有 value 输入`);
  }

  if (action === 'choose') {
    const options = args.options;
    if (!Array.isArray(options) || options.length === 0) errors.push('choose 必须有非空 args.options');
  }
  if (action === 'category') {
    const pathValue = args.path;
    if (!Array.isArray(pathValue) || pathValue.length === 0) errors.push('category 必须有非空 args.path');
  }
  if (action === 'upload') {
    const files = args.files;
    if (!Array.isArray(files) || files.length === 0) {
      errors.push('upload 必须有非空字符串数组 args.files');
    } else {
      for (const file of files) {
        if (!isSafeFixtureName(file)) errors.push(`upload fixture 文件名非法: ${JSON.stringify(file)}`);
      }
    }
  }
  if (action === 'press') {
    if (typeof args.key !== 'string' || args.key === '') errors.push('press 必须有非空字符串 args.key');
  }
  if (action === 'scroll') {
    const direction = args.direction;
    // 显式 direction 必须四枚举；无 direction 保持 window 默认 down / target 居中
    if (direction !== undefined && !SCROLL_DIRECTIONS.has(String(direction))) {
      errors.push(`scroll args.direction 非法: ${JSON.stringify(direction)}`);
    }
  }
  if (action === 'fill_form') {
    errors.push(...validateFillFormShape(args));
  }
  return errors;
}
