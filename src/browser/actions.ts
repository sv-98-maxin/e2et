/**
 * 操作命令的 browser 层实现（阶段 2.3 第一批）。
 *
 * - parseTargetSpec：把 CLI target 写法分派成 spec，daemon 据此调 resolveTarget/resolveSelector。
 * - fillNode：真实浏览器输入（replace + insertText，不逐字符），区别于 typeIntoNode 的逐字符。
 * - uploadFiles：CDP DOM.setFileInputFiles，绕过 hidden input 的不可见限制。
 *
 * 不引入组件库依赖；DOM 派发同 interactions.ts 的既有模式（后台 tab 也能生效）。
 */
import type { CdpSession } from './daemon-client.js';
import type { PageState } from './page-state.js';
import { parseDeclaredWaitLocator } from '../shared/wait-locator.js';
export { parseDeclaredWaitLocator };
import { callOnNode, callNativeCommit, prepareCustomSelection, pickCustomOption, writeInputNode, type SelectionOutcome } from './interactions.js';
import { BACKEND_PLACEHOLDER_CANDIDATES_FN } from './locator-query.js';
import {
  READ_NATIVE_OPTIONS_FN, APPLY_NATIVE_COMMIT_FN,
  chooseOptionIndex, matchModeOf,
} from '../shared/selection.js';
import type { SelectionFact, SelectionPick, SelectionRecorder, RecordInputCallback } from '../shared/types.js';

/** target 写法分派结果。索引走快照，其余统一转文本/selector 交给 resolveTarget/resolveSelector */
export type TargetSpec =
  | { kind: 'index'; index: number; raw: string }
  | { kind: 'css'; selector: string; raw: string }
  | { kind: 'text'; value: string; raw: string };

// 选择合同 SSOT：TargetCandidate/ResolvedTargetInfo 完整源在 shared/types.ts（选择子集搬迁），
// 此处按原名字 type re-export，既有调用方不变；type-only 边界，无运行时 wrapper。
export type { TargetCandidate, ResolvedTargetInfo, SelectionPick, SelectionFact, SelectionRecorder } from '../shared/types.js';
import type { ResolvedTargetInfo, TargetCandidate } from '../shared/types.js';

/** 候选定位只收已验证事实：role 来自录制时全树唯一的 roleLocator；css 优先显式 selector
 *  且既有 resolver 已证单命中；两者皆无时读 resolved backend 的真实身份。无身份 → 空
 *  数组（fail closed），不拿快照名猜。断言与操作命令共用，保证 trace 里的候选口径一致。 */
export async function collectCandidates(
  ps: Pick<PageState, 'elements'>,
  hit: { backendNodeId: number; role: string; name: string; matches?: number; selector?: string },
  resolvedBy: string,
  c: CdpSession,
): Promise<TargetCandidate[]> {
  const out: TargetCandidate[] = [];
  const targetEl = ps.elements.find((e) => e.backendNodeId === hit.backendNodeId);
  if (targetEl?.roleLocator) {
    out.push({ by: 'role', role: targetEl.roleLocator.role, name: targetEl.roleLocator.name, matches: 1 });
  }
  if (resolvedBy === 'css' && hit.selector && (hit.matches ?? 1) === 1) {
    out.push({ by: 'css', selector: hit.selector, matches: 1 });
  }
  if (out.length === 0 && resolvedBy !== 'css') {
    const candidates = await callOnNode<unknown>(c, hit.backendNodeId, BACKEND_PLACEHOLDER_CANDIDATES_FN);
    if (!Array.isArray(candidates) || candidates.some((candidate) => !candidate
      || candidate.by !== 'css' || typeof candidate.selector !== 'string' || !candidate.selector
      || candidate.matches !== 1)) throw new Error('候选查询返回非法定位事实');
    out.push(...candidates);
  }
  return out;
}

/** 解析 target 写法：[N] / role=x:y / label= / text= / testid= / css= / 裸字符串
 *  裸字符串按 accessible name 处理（兼容旧用法）。 */
export function parseTargetSpec(raw: unknown): TargetSpec | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw < 0) return undefined;
    return { kind: 'index', index: Math.floor(raw), raw: String(raw) };
  }
  const s = String(raw).trim();
  if (!s) return undefined;

  // [N] 索引
  const idx = s.match(/^\[(\d+)\]$/);
  if (idx) {
    const n = Number(idx[1]);
    if (!Number.isFinite(n) || n < 0) return undefined;
    return { kind: 'index', index: n, raw: s };
  }

  // css=... 或 testid=...（testid 转 css）
  if (s.startsWith('css=')) return { kind: 'css', selector: s.slice(4), raw: s };
  if (s.startsWith('testid=')) return { kind: 'css', selector: '[data-testid="' + s.slice(7) + '"]', raw: s };

  // role=button:确定 / label=商品名称 → 取冒号/等号后的文本走 name 匹配
  // （AX 树 role 精确匹配由 resolveTarget 内部按 elements 找，这里不重复 role 校验，
  //   spec 的 role= 命中多个时拒绝由 resolveTarget 的 matches 语义承载）
  if (s.startsWith('role=')) {
    const rest = s.slice(5);
    const colon = rest.indexOf(':');
    return { kind: 'text', value: colon >= 0 ? rest.slice(colon + 1) : rest, raw: s };
  }
  if (s.startsWith('label=')) return { kind: 'text', value: s.slice(6), raw: s };
  if (s.startsWith('text=')) return { kind: 'text', value: s.slice(5), raw: s };

  // 裸字符串 → 按 accessible name
  return { kind: 'text', value: s, raw: s };
}

import { scrollElement, centerElement, scrollWindow, hoverEnter, hoverLeave } from '../shared/dom-actions.js';

/** fill 一次输入完整文本；真实叶与提交校验由统一 writer 持有。 */
export async function fillNode(
  session: CdpSession,
  backendNodeId: number,
  text: string,
  recordInput: RecordInputCallback,
): Promise<string> {
  return writeInputNode(session, backendNodeId, { value: text, mode: 'fill' }, recordInput);
}

const SET_FILE_INPUT_FN = `function () {
  return this instanceof HTMLInputElement && this.type === 'file';
}`;

/** file input 设文件：CDP DOM.setFileInputFiles 喂本地绝对路径给 hidden input。
 *  走 DOM 派发无法给 <input type=file> 赋值（安全限制），必须 CDP 域。 */
export async function setFileInputFiles(
  session: CdpSession,
  backendNodeId: number,
  files: string[],
): Promise<void> {
  // 校验目标确为 file input，避免误传
  const isFile = await callOnNode<boolean>(session, backendNodeId, SET_FILE_INPUT_FN);
  if (!isFile) throw new Error('目标不是 <input type="file">，无法上传');

  await session.send('DOM.setFileInputFiles', { files, backendNodeId });
}

/** uploadFiles：直接传绝对路径给 setFileInputFiles（CDP 接受 string[]）。
 *  文件路径由 CLI 端校验存在性与大小，daemon 只负责注入。 */
export async function uploadFiles(session: CdpSession, backendNodeId: number, filePaths: string[]): Promise<void> {
  if (filePaths.length === 0) throw new Error('缺上传文件路径');
  const { resolve } = await import('node:path');
  const files = filePaths.map((p) => resolve(p));
  await setFileInputFiles(session, backendNodeId, files);
}

// ── 第二批操作原语 ──

const HOVER_ENTER_FN = `function () { return (${hoverEnter.toString()})(this); }`;
const HOVER_LEAVE_FN = `function () { return (${hoverLeave.toString()})(this); }`;

/** hover：DOM 派发 mouseover/mousemove 触发 hover 态。后台 tab 也能生效。
 *  返回 cleanup 函数，调用后派发 mouseleave/pointerleave 收掉 hover 态（tooltip 等）。 */
export async function hoverNode(session: CdpSession, backendNodeId: number): Promise<() => Promise<void>> {
  await session.send('DOM.scrollIntoViewIfNeeded', { backendNodeId }).catch(() => undefined);
  await callOnNode(session, backendNodeId, HOVER_ENTER_FN);
  return () => callOnNode(session, backendNodeId, HOVER_LEAVE_FN);
}

const SCROLL_INTO_VIEW_FN = `function () {
  return (${centerElement.toString()})(this);
}`;

/** scroll：target（无 direction）滚到视口中心；dir 滚整页或 target 容器。
 *  dir 无 target：按轴滚整页，横向滚动 top 必须为 0（不斜滚）。
 *  dir + target：滚 target 或其最近可滚动祖先（按指定轴），用于 antd 表格水平滚动。
 *  无可滚动目标时不假成功；到边界 moved=false 但不报错。 */
export async function scrollNode(
  session: CdpSession,
  spec: { dir?: string; target?: number },
): Promise<{ moved: boolean }> {
  // target 但无 direction：保持 scrollIntoView 语义
  if (spec.target && !spec.dir) {
    const moved = await callOnNode<boolean>(session, spec.target, SCROLL_INTO_VIEW_FN);
    return { moved };
  }

  const dir = spec.dir ?? 'down';
  const axis = dir === 'up' || dir === 'down' ? 'y' : 'x';
  const sign = dir === 'up' || dir === 'left' ? -1 : 1;
  const delta = 600 * sign;

  // target + direction：滚 target 或最近可滚动祖先（按轴）
  if (spec.target) {
    const result = await callOnNode<{ moved: boolean; found: boolean }>(session, spec.target, SCROLL_ANCESTOR_FN, [axis, delta]);
    if (!result.found) throw new Error('目标及其祖先在 ' + axis + ' 轴上无可滚动容器，scroll 未生效');
    return { moved: result.moved };
  }

  // 无 target：滚整页，横向不斜滚（scrollWindow 共源：显式 left/top，behavior instant）
  const moved = await session.evaluate(`((${scrollWindow.toString()})(${JSON.stringify({ axis, delta })}))`);
  return { moved };
}

/** 在 target 或其最近可滚动祖先上按轴滚动 delta。
 *  返回 { moved, found }：found=false=无可滚动容器；moved=false=到边界。
 *  纳入 document.scrollingElement（overflow:visible 的文档滚动根节点）。 */
// 导出供测试实际执行（CDP callFunctionOn 函数体字符串，非新 helper）；算法共源自 shared/dom-actions.ts::scrollElement
export const SCROLL_ANCESTOR_FN = `function (axis, delta) {
  return (${scrollElement.toString()})(this, { axis: axis, delta: delta });
}`;

/** back：历史后退一步（独立实现，不走 switch-tab；switch-tab 已改为真实 target 切换）。
 *  按 Page.getNavigationHistory 的 currentIndex-1 导航，越界返回 null。 */
export async function backHistory(session: CdpSession): Promise<string | null> {
  const { currentIndex, entries } = await session.send<{ currentIndex?: number; entries?: Array<{ url: string; id?: string | number }> }>('Page.getNavigationHistory').catch(() => ({ currentIndex: 0, entries: [] }));
  const list = entries ?? [];
  const target = (currentIndex ?? 0) - 1;
  if (target < 0 || target >= list.length) return null;
  await session.send('Page.navigateToHistoryEntry', { entryId: list[target].id ?? target });
  return list[target].url;
}

/** refresh：Page.reload。 */
export async function refreshPage(session: CdpSession): Promise<void> {
  await session.send('Page.reload', { ignoreCache: false });
}

type NativeOptionRead = { multiple: boolean; labels: string[]; disabled: boolean[] } | null;

/** choose：combobox/listbox 多选项。custom 可选 filter 一次替换后逐项真实选择（keep-open
 *  每轮重取池、已展开不盲点根）；原生 multiple 请求项全部真实选中且保留其他已选项，
 *  单选收到多项在写入前拒绝。recordSelection 为 required（F03）：每项真实成功后立即通知，
 *  失败动作也保留已发生 picks；返回的完整事实与累计事实同值。 */
export async function chooseOptions(
  session: CdpSession,
  backendNodeId: number,
  options: string[],
  filterText: string | undefined,
  recordSelection: SelectionRecorder,
): Promise<SelectionOutcome> {
  if (options.length === 0) throw new Error('choose 需要至少一个选项输入');
  const native = await callOnNode<NativeOptionRead>(session, backendNodeId, READ_NATIVE_OPTIONS_FN);
  if (native !== null) {
    const indexes: number[] = [];
    for (const opt of options) {
      const index = chooseOptionIndex(native.labels, opt);
      if (native.disabled[index]) {
        throw new Error(`NOT_INTERACTABLE: 选项 "${opt}" 已禁用（disabled/optgroup/aria-disabled 祖先），不能选择`);
      }
      indexes.push(index);
    }
    if (!native.multiple && options.length > 1) {
      throw new Error('OPTION_MULTIPLE_ON_SINGLE: 单选下拉框收到多项选择输入，已在写入前拒绝');
    }
    // F04：原子提交在同一调用、input/change 事件前捕获实际 option 引用，之后不重查当前列表
    const commit = await callNativeCommit(session, backendNodeId, APPLY_NATIVE_COMMIT_FN, [{ labels: native.labels, indexes, add: true }]);
    if (commit === null) {
      throw new Error('SELECTION_TARGET_CHANGED: 原生多选原子提交返回非原生分流（APPLY 无分流语义），目标可能已被替换');
    }
    const picks: SelectionPick[] = commit.picked.map((name, i) => pickOptionFact(options[i], name, matchModeOf(name, options[i]), commit.backends[i], backendNodeId, commit.alreadySelected[i], commit.observedCount));
    // native choose：原子桥成功后逐 pick 通知
    for (const pick of picks) recordSelection('related', pick);
    return { picked: commit.picked, selection: { scope: 'related', picks } };
  }
  // custom：每项 prepare（filter 仅首项）→ pick → 立即 recorder；initialRootScope 首次 prepare 成功后确定
  const picked: string[] = [];
  const picks: SelectionPick[] = [];
  let initialRootScope: SelectionFact['scope'] | undefined;
  for (let i = 0; i < options.length; i++) {
    const pools = await prepareCustomSelection(session, backendNodeId, i === 0 ? filterText : undefined);
    if (initialRootScope === undefined) initialRootScope = pools.scope;
    const pick = await pickCustomOption(session, backendNodeId, options[i], false, undefined, false);
    picks.push(pick.fact);
    picked.push(pick.name);
    recordSelection(initialRootScope, pick.fact);
  }
  return { picked, selection: { scope: initialRootScope ?? 'related', picks } };
}

/** date 保持通用值输入，不替控件执行 Enter、失焦或业务提交。 */
export async function setDateValue(
  session: CdpSession,
  backendNodeId: number,
  value: string,
  recordInput: RecordInputCallback,
): Promise<string> {
  return fillNode(session, backendNodeId, value, recordInput);
}

/** category：多级类目在同一控件的实际级联池逐级执行（每级重取当前池、已展开不盲点根）。
 *  原生 select 没有级联池，明确拒绝。recordSelection 为 required（F03）：每项真实 click
 *  返回后、下一项前立即通知；下一层只来自上次实际点击项（其声明子池或实际子树），不整树搜索。 */
export async function pickCategory(
  session: CdpSession,
  backendNodeId: number,
  path: string[],
  recordSelection: SelectionRecorder,
): Promise<SelectionOutcome> {
  if (path.length === 0) throw new Error('category 需要至少一级 path 输入');
  const native = await callOnNode<NativeOptionRead>(session, backendNodeId, READ_NATIVE_OPTIONS_FN);
  if (native !== null) throw new Error('category 目标是原生下拉框（无级联池），不支持多级类目选择');
  const picked: string[] = [];
  const picks: SelectionPick[] = [];
  // 仅首层 prepare（根展开）；后续层不再点原根/重置 filter
  const pools = await prepareCustomSelection(session, backendNodeId, undefined);
  let parentBackend: number | undefined = undefined;
  for (let index = 0; index < path.length; index++) {
    const pick = await pickCustomOption(session, backendNodeId, path[index], true, parentBackend, index < path.length - 1);
    picks.push(pick.fact);
    picked.push(pick.name);
    recordSelection(pools.scope, pick.fact);
    parentBackend = pick.fact.target.backendNodeId;
  }
  return { picked, selection: { scope: pools.scope, picks } };
}

/** 选项事实（native 路径）：DOM option.label + 公共 matcher 下标通道，不冒称已验证 AX 角色全局唯一 */
function pickOptionFact(input: string, name: string, matchMode: 'exact' | 'substring', backendNodeId: number, rootBackend: number, alreadySelected: boolean, observedCount: number): SelectionPick {
  return {
    input,
    role: 'option',
    name,
    match_mode: matchMode,
    target: {
      backendNodeId,
      resolved_by: 'option-label',
      role: 'option',
      name,
      matches: 1,
    },
    interaction: {
      mode: 'native', root_backend: rootBackend, target_backend: rootBackend,
      verification: { method: 'native-selected', result: true }, already_selected: alreadySelected,
      inventory_scope: 'native-options', observed_count: observedCount,
    },
  };
}

/** fill-form 单字段事实：name 是原请求名（字段 map key），target 是实际写时自身已验证身份。 */
export interface FilledField {
  name: string;
  value: string;
  target: ResolvedTargetInfo;
}

/** fill-form：批量填充。scope=required/all 只填显式输入（all 额外清空未提供的可填字段），
 *  targeted 只填 --field 指定的。
 *  预检先固定待写列表（真实 DOM 顺序）：显式字段缺失/歧义、待写 name 重复、空列表一律写前 BAD_REQUEST；
 *  显式空串有效（Object.hasOwn 判定，不按 falsy）。每字段写前按当前状态重取自身已验证身份
 *  （前一字段事件可改后一字段 AX name，字段 map key 仍是原请求名，target 是实际写时的新身份），
 *  无可还原身份 INSUFFICIENT_EVIDENCE。实际写失败原样传播（不 catch 跳过、不事务回滚）；
 *  每字段成功后立即 filled.push + recordFilled。 */
export async function fillFormByScope(
  session: CdpSession,
  opts: { scope: "required" | "all" | "targeted"; fields: Record<string, string>; skip: string[]; within?: string },
  getElements: () => Promise<PageState['elements']>,
  recordFilled: (field: FilledField) => void,
  recordInput: RecordInputCallback,
): Promise<FilledField[]> {
  const filled: FilledField[] = [];
  const elements = await getElements();
  const skipSet = new Set(opts.skip);
  const fillable = (el: PageState['elements'][number]): boolean =>
    !el.disabled && (el.role === "textbox" || el.role === "searchbox" || el.role === "combobox") && !skipSet.has(el.name);
  // targeted 显式字段必须在符合过滤的真实字段中恰好一个；缺失/歧义写前拒绝
  if (opts.scope === "targeted") {
    for (const key of Object.keys(opts.fields)) {
      const hits = elements.filter((el) => el.name === key && fillable(el));
      if (hits.length === 0) throw new Error('BAD_REQUEST: targeted 字段不存在或不可填: ' + key);
      if (hits.length > 1) throw new Error('BAD_REQUEST: targeted 字段名歧义（' + hits.length + ' 个同名可填字段）: ' + key);
    }
  }
  // 待写列表先固定（真实元素顺序）；实际待写 name 必须唯一，重复 key 写前拒绝
  const pending: Array<{ name: string; value: string; backendNodeId: number }> = [];
  const seenNames = new Set<string>();
  for (const el of elements) {
    if (!fillable(el)) continue;
    const explicit = Object.hasOwn(opts.fields, el.name) ? opts.fields[el.name] : undefined;
    if (opts.scope !== "all" && explicit === undefined) continue;
    if (seenNames.has(el.name)) throw new Error('BAD_REQUEST: 待写表单字段名重复: ' + el.name);
    seenNames.add(el.name);
    pending.push({ name: el.name, value: explicit ?? "", backendNodeId: el.backendNodeId });
  }
  if (pending.length === 0) throw new Error('BAD_REQUEST: 没有可写字段（scope=' + opts.scope + '），拒绝空表单执行');
  for (const item of pending) {
    // 每字段写前按当前状态找真实 role/name（前一字段事件可改后一字段 AX name）
    const currentElements = await getElements();
    const el = currentElements.find((e) => e.backendNodeId === item.backendNodeId);
    if (!el) throw new Error('INSUFFICIENT_EVIDENCE: 字段 ' + item.name + ' 写前状态中无可还原身份');
    const cands = await collectCandidates({ elements: currentElements }, { backendNodeId: el.backendNodeId, role: el.role, name: el.name, matches: 1 }, "ax", session);
    if (cands.length === 0) throw new Error('INSUFFICIENT_EVIDENCE: 字段 ' + item.name + ' 写前无可验证定位身份');
    const target: ResolvedTargetInfo = { backendNodeId: el.backendNodeId, resolved_by: "ax", role: el.role, name: el.name, matches: 1, candidates: cands };
    await fillNode(session, el.backendNodeId, item.value, recordInput);
    const field: FilledField = { name: item.name, value: item.value, target };
    filled.push(field);
    recordFilled(field);
  }
  return filled;
}
