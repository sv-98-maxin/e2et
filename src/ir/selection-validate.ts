/**
 * 选择证据共享 validator（F10/F11/F12 + S7-G16 同批共享，build/check 只留一套实现）。
 *
 * 从 raw args 自行提取输入（select→string option / choose→options / category→path 非空有序
 * string[]），保留合法空串、拒绝数字/缺失，不 String() 洗值；核 selection 对象/scope/picks
 * 数量、每项 input/name/五角色/match_mode、target 实体（backend 正整数、来源 ax/option-label、
 * matches===1、与 pick 同 role/name）、公共 singleton matcher 真命中且 matchModeOf 一致。
 * 不要求 trace 不存在的全页 candidates，不造新 ResolvedTargetInfo 包装。
 */
import { chooseOptionIndex, matchModeOf, OPTION_ROLES } from '../shared/selection.js';

const SELECTION_KINDS = new Set(['select', 'choose', 'category']);

/** 选择事实断言失败集合：空数组 = 通过。非三类选择动作返回 []。 */
export function validateSelectionFact(kind: string, args: Record<string, unknown>): string[] {
  if (!SELECTION_KINDS.has(kind)) return [];
  const failures: string[] = [];
  let inputs: string[];
  if (kind === 'select') {
    if (typeof args.option !== 'string') {
      failures.push(`select 需要字符串 option 输入（缺失或非字符串: ${JSON.stringify(args.option)}）`);
      return failures;
    }
    inputs = [args.option];
  } else {
    const key = kind === 'choose' ? 'options' : 'path';
    const raw = args[key];
    if (!Array.isArray(raw) || raw.length === 0 || raw.some((o) => typeof o !== 'string')) {
      failures.push(`${kind} 需要非空有序 string[] ${key} 输入（缺失/空数组/含非字符串: ${JSON.stringify(raw)}）`);
      return failures;
    }
    inputs = raw as string[];
  }
  const sel = args.selection;
  if (!sel || typeof sel !== 'object' || Array.isArray(sel)) {
    failures.push(`${kind} 缺 selection 选择事实（旧 trace 需重新录制）`);
    return failures;
  }
  const selection = sel as Record<string, unknown>;
  if (selection.scope !== 'related' && selection.scope !== 'page') {
    failures.push(`selection.scope 非法: ${JSON.stringify(selection.scope)}`);
  }
  const picks = selection.picks;
  if (!Array.isArray(picks) || picks.length !== inputs.length) {
    failures.push(`selection.picks 数量 ${Array.isArray(picks) ? picks.length : '缺失'} 与输入 ${inputs.length} 不一致`);
    return failures;
  }
  const names: string[] = [];
  for (let i = 0; i < picks.length; i++) {
    const pick = picks[i] as Record<string, unknown> | null;
    if (!pick || typeof pick !== 'object') {
      failures.push(`selection.picks[${i}] 非对象`);
      return failures;
    }
    if (typeof pick.input !== 'string' || pick.input !== inputs[i]) {
      failures.push(`selection.picks[${i}].input 与请求输入序列不一致（${JSON.stringify(pick.input)} vs ${JSON.stringify(inputs[i])}）`);
    }
    if (typeof pick.role !== 'string' || !OPTION_ROLES.includes(pick.role)) {
      failures.push(`selection.picks[${i}].role 非五类可选项角色: ${JSON.stringify(pick.role)}`);
    }
    if (typeof pick.name !== 'string') {
      failures.push(`selection.picks[${i}].name 非 string: ${JSON.stringify(pick.name)}`);
    }
    if (pick.match_mode !== 'exact' && pick.match_mode !== 'substring') {
      failures.push(`selection.picks[${i}].match_mode 非法: ${JSON.stringify(pick.match_mode)}`);
    }
    const target = pick.target as Record<string, unknown> | undefined;
    if (!target || typeof target !== 'object') {
      failures.push(`selection.picks[${i}].target 缺实体`);
      return failures;
    }
    if (typeof target.backendNodeId !== 'number' || !Number.isInteger(target.backendNodeId) || target.backendNodeId <= 0) {
      failures.push(`selection.picks[${i}].target.backendNodeId 非正整数: ${JSON.stringify(target.backendNodeId)}`);
    }
    if (target.resolved_by !== 'ax' && target.resolved_by !== 'aria-id' && target.resolved_by !== 'option-label') {
      failures.push(`selection.picks[${i}].target.resolved_by 非法（仅 ax/aria-id/option-label）: ${JSON.stringify(target.resolved_by)}`);
    } else if (target.resolved_by === 'option-label' && pick.role !== 'option') {
      failures.push(`selection.picks[${i}].target.resolved_by=option-label 只允许 option 角色，实际: ${JSON.stringify(pick.role)}`);
    }
    if (target.matches !== 1) {
      failures.push(`selection.picks[${i}].target.matches 非 1: ${JSON.stringify(target.matches)}`);
    }
    if (typeof target.role !== 'string' || target.role !== pick.role) {
      failures.push(`selection.picks[${i}].target.role 与 pick.role 不一致`);
    }
    if (typeof target.name !== 'string' || target.name !== pick.name) {
      failures.push(`selection.picks[${i}].target.name 与 pick.name 不一致`);
    }
    // interaction 字段：mode 三值枚举 + target_backend 正整数 + active_descendant_backend 可选正整数
    const interaction = pick.interaction as Record<string, unknown> | undefined;
    if (!interaction || typeof interaction !== 'object' || Array.isArray(interaction)) {
      failures.push(`selection.picks[${i}].interaction 缺交互事实`);
    } else {
      if (interaction.mode !== 'pointer' && interaction.mode !== 'keyboard' && interaction.mode !== 'native') {
        failures.push(`selection.picks[${i}].interaction.mode 非法: ${JSON.stringify(interaction.mode)}`);
      }
      if (typeof interaction.target_backend !== 'number' || !Number.isInteger(interaction.target_backend) || interaction.target_backend <= 0) {
        failures.push(`selection.picks[${i}].interaction.target_backend 非正整数: ${JSON.stringify(interaction.target_backend)}`);
      }
      if (typeof interaction.root_backend !== 'number' || !Number.isInteger(interaction.root_backend) || interaction.root_backend <= 0) {
        failures.push(`selection.picks[${i}].interaction.root_backend 非正整数`);
      }
      if (typeof interaction.already_selected !== 'boolean') failures.push(`selection.picks[${i}].interaction.already_selected 非 boolean`);
      if (!['keyboard-reachable', 'dom-pool', 'native-options'].includes(interaction.inventory_scope as string)) failures.push(`selection.picks[${i}].interaction.inventory_scope 非法`);
      if (typeof interaction.observed_count !== 'number' || !Number.isInteger(interaction.observed_count) || interaction.observed_count <= 0) failures.push(`selection.picks[${i}].interaction.observed_count 非正整数`);
      const verification = interaction.verification as Record<string, unknown> | undefined;
      if (!verification || typeof verification !== 'object' || Array.isArray(verification)
        || verification.result !== true || !['native-selected', 'aria-selected', 'aria-checked', 'aria-expanded', 'child-pool'].includes(verification.method as string)) {
        failures.push(`selection.picks[${i}].interaction.verification 缺成功的标准提交验证`);
      }
      if ((verification?.method === 'aria-expanded' || verification?.method === 'child-pool') && (kind !== 'category' || i === picks.length - 1)) failures.push(`selection.picks[${i}] 只有类目中间级允许 expanded/child-pool 验证`);
      if (interaction.inventory_scope === 'keyboard-reachable') {
        if (selection.scope !== 'related' || target.resolved_by !== 'aria-id'
          || typeof interaction.active_descendant_id !== 'string' || interaction.active_descendant_id.length === 0
          || interaction.active_descendant_backend !== target.backendNodeId) {
          failures.push(`selection.picks[${i}] 键盘库存缺唯一关联池、原标准 id 或真实 active descendant 证据`);
        }
      } else if (target.resolved_by === 'aria-id') failures.push(`selection.picks[${i}].target.resolved_by=aria-id 需要 keyboard-reachable 库存`);
      if (interaction.mode === 'keyboard' && (interaction.inventory_scope !== 'keyboard-reachable' || interaction.target_backend !== interaction.root_backend)) failures.push(`selection.picks[${i}] 键盘交互必须发给真实根且有可达库存`);
      if (interaction.mode === 'pointer' && interaction.target_backend !== target.backendNodeId) failures.push(`selection.picks[${i}] 指针交互节点与原语义目标不一致`);
      if (interaction.mode === 'native' && (interaction.inventory_scope !== 'native-options' || target.resolved_by !== 'option-label' || interaction.target_backend !== interaction.root_backend || verification?.method !== 'native-selected')) failures.push(`selection.picks[${i}] 原生交互证据不一致`);
      if (interaction.mode !== 'native' && (interaction.inventory_scope === 'native-options' || verification?.method === 'native-selected' || target.resolved_by === 'option-label')) failures.push(`selection.picks[${i}] 自定义交互不能使用原生提交证据`);
      if (interaction.active_descendant_backend !== undefined &&
        (typeof interaction.active_descendant_backend !== 'number' || !Number.isInteger(interaction.active_descendant_backend) || interaction.active_descendant_backend <= 0)) {
        failures.push(`selection.picks[${i}].interaction.active_descendant_backend 非正整数: ${JSON.stringify(interaction.active_descendant_backend)}`);
      }
    }
    if (typeof pick.name === 'string' && typeof pick.input === 'string') {
      const expectedMode = matchModeOf(pick.name, pick.input);
      if (pick.match_mode !== expectedMode) {
        failures.push(`selection.picks[${i}].match_mode 与公共 matcher 归一关系不一致（记录 ${JSON.stringify(pick.match_mode)}，实际 ${expectedMode}）`);
      }
    }
    names.push(typeof pick.name === 'string' ? pick.name : '');
  }
  // 每项是独立一次选择，不把不同类目层/不同轮次的 picks 冒充同一个候选池。
  for (let i = 0; i < names.length; i++) {
    try {
      chooseOptionIndex([names[i]], inputs[i]);
    } catch (e) {
      failures.push(`selection.picks[${i}].input 公共 matcher 未真命中: ${(e as Error).message.split('\n')[0]}`);
    }
  }
  return failures;
}
