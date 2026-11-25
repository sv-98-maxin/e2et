/**
 * §8 输出合同：build/check 共用的保存值验证（唯一实现，不分别抄一套输出推断）。
 * 未 save_as 返回空数组；保存时核允许 kind、真实成功 saved_value、与输入五 kind 的
 * value.raw 或明确 output_value 一致。choose/category 核实际 picks.name JSON；
 * fill_form 核实际 fields 的 raw map JSON；scroll 核实际 moved bool；导航输出核
 * 现有 URL 无损 guard。不从 exec 对象第一个属性猜值。
 */
import type { ActionEvent } from './trace-reader.js';
import { ACTION_OUTPUT_KINDS } from '../shared/types.js';
import { redactUrlWithEvidence } from '../shared/url-safety.js';

const VALUE_INPUT_KINDS = new Set(['open', 'type', 'fill', 'select', 'date']);

export function validateActionSavedValue(action: ActionEvent): string[] {
  if (!action.save_as) return [];
  const errs: string[] = [];
  if (!ACTION_OUTPUT_KINDS.includes(action.kind)) {
    errs.push(`save_as "${action.save_as}" 的动作 kind ${action.kind} 不在输出白名单`);
    return errs;
  }
  if (typeof action.saved_value !== 'string') {
    errs.push(`save_as "${action.save_as}" 缺 trace saved_value（输出未提交或失败动作）`);
    return errs;
  }
  const args = (action.args ?? {}) as Record<string, unknown>;
  let expected: string | undefined;
  if (VALUE_INPUT_KINDS.has(action.kind)) {
    expected = typeof action.value?.raw === 'string' ? action.value.raw : undefined;
    if (action.kind === 'select' && expected === undefined && typeof args.option === 'string') expected = args.option;
  } else if (action.kind === 'choose' || action.kind === 'category') {
    const picks = ((args.selection ?? {}) as Record<string, unknown>).picks;
    expected = Array.isArray(picks) ? JSON.stringify(picks.map((p) => (p as { name?: unknown }).name)) : undefined;
  } else if (action.kind === 'fill_form') {
    const fields = args.fields;
    expected = fields && typeof fields === 'object'
      ? JSON.stringify(Object.fromEntries(Object.entries(fields as Record<string, unknown>).map(([name, field]) => [name, (field as { raw?: unknown }).raw])))
      : undefined;
  } else if (action.kind === 'scroll') {
    expected = typeof args.moved === 'boolean' ? String(args.moved) : undefined;
  } else {
    // back/refresh/switch_tab：输出是动作完成时实际产出（URL 等），saved_value 必须与 output_value 一致
    expected = action.output_value;
  }
  if (expected === undefined) {
    errs.push(`save_as "${action.save_as}" 无法还原保存值期望（${action.kind} 缺实际输出事实）`);
  } else if (action.saved_value !== expected) {
    errs.push(`saved_value 与实际输出不一致（${JSON.stringify(action.saved_value)} vs ${JSON.stringify(expected)}）`);
  }
  if (action.output_value !== undefined && action.saved_value !== action.output_value) {
    errs.push(`output_value 与实际保存值不一致（${JSON.stringify(action.output_value)} vs ${JSON.stringify(action.saved_value)}）`);
  }
  if ((action.kind === 'back' || action.kind === 'refresh') && redactUrlWithEvidence(action.saved_value).redacted) {
    errs.push(`导航输出 URL 含认证来源字段（实际被改写），不可无损保存`);
  }
  return errs;
}
