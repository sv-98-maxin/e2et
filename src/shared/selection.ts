/**
 * 选择合同共用（Phase3a 选择子集）：原生 select 与 custom 控件两侧共用同一匹配/采集源。
 *
 * 匹配：normalizeAccessibleName 归一后精确优先、否则唯一子串；零命中/多命中分别固定
 * OPTION_NOT_FOUND / OPTION_AMBIGUOUS 前缀错误；不 first/nth 绕过、不改写 wanted；
 * 合法空 label 允许精确命中，不 blanket 拒绝空字符串。
 *
 * 原生：单选保持 selectNativeOption 原子 DOM 写入合同（guard/selectedIndex/input+change
 * 同一次浏览器调用）；多选走 readNativeOptions（Node 公共 matcher 定下标）+
 * applyNativeSelection（guard/请求项选中且保留其他已选项/单次 input+change，列表漂移抛
 * SELECTION_TARGET_CHANGED，单选收到多项在写入前拒绝）。
 *
 * custom：AxOptionNode 五类角色（option/treeitem/menuitem/menuitemcheckbox/menuitemradio）
 * 递归消费；池根状态/页面可见池扫描/禁用 guard 均为无闭包 DOM 函数，序列化约束同
 * beta-native 子合同——进浏览器的函数体内嵌真实源，不引用本模块 import 名。
 */
import { normalizeAccessibleName } from './accessible-name.js';
import { resolveWriteTarget, type WriteTarget } from './dom-actions.js';

/** 五类可选项角色（W3C，不区分组件库；两侧同角色集合） */
export const OPTION_ROLES: readonly string[] = ['option', 'treeitem', 'menuitem', 'menuitemcheckbox', 'menuitemradio'];

/** AX 选项树消费形状：两侧（CDP AX 树转换 / PW ariaSnapshotJSON）喂同一结构给公共采集 */
export interface AxOptionNode {
  role?: string;
  name?: string;
  children?: AxOptionNode[];
  disabled?: boolean;
  selected?: boolean;
}

/** 采集后的选项候选：原 name 字符串（公共 matcher 负责归一化） */
export interface AxOptionCandidate {
  role: string;
  name: string;
  disabled: boolean;
  selected: boolean;
}

/** Node 侧公共采集：递归消费 AxOptionNode 根数组，只收五类角色（含其子树），
 *  跳过其它角色（text/ignored 中间层）但沿 children 继续遍历。
 *  CDP 侧先把 AX 树转换成同形状（穿越 ignored 中间节点），PW 直接喂 ariaSnapshotJSON 结果。 */
export function collectAxOptionCandidates(nodes: readonly AxOptionNode[]): AxOptionCandidate[] {
  const out: AxOptionCandidate[] = [];
  const walk = (list: readonly AxOptionNode[]): void => {
    for (const node of list) {
      if (!node || typeof node !== 'object') continue;
      const role = typeof node.role === 'string' ? node.role : '';
      if (OPTION_ROLES.includes(role)) {
        out.push({ role, name: typeof node.name === 'string' ? node.name : '', disabled: node.disabled === true, selected: node.selected === true });
      }
      if (Array.isArray(node.children)) walk(node.children);
    }
  };
  walk(nodes ?? []);
  return out;
}

/** 无闭包 matcher 工厂：Node 侧与浏览器现场共用同一源构造 (labels, wanted) → 命中索引 */
function createOptionMatcher(
  normalize: (text: string) => string,
): (labels: readonly string[], wanted: string) => number {
  return function chooseOptionIndex(labels: readonly string[], wanted: string): number {
    const want = normalize(wanted);
    const norm: string[] = [];
    for (let index = 0; index < labels.length; index++) norm.push(normalize(labels[index] ?? ''));
    const exact: number[] = [];
    const subs: number[] = [];
    for (let index = 0; index < norm.length; index++) {
      if (norm[index] === want) exact.push(index);
      if (norm[index].includes(want)) subs.push(index);
    }
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) throw new Error('OPTION_AMBIGUOUS: 选项 "' + wanted + '" 精确匹配 ' + exact.length + ' 个同名选项，无法唯一确定');
    if (subs.length === 1) return subs[0];
    if (subs.length > 1) {
      const names = subs.slice(0, 3).map((index) => '"' + labels[index] + '"').join('、');
      throw new Error('OPTION_AMBIGUOUS: 选项 "' + wanted + '" 子串匹配 ' + subs.length + ' 个选项（' + names + '…），需要完整名称');
    }
    const pool = labels.filter((label) => (label ?? '').trim() !== '').join(' | ');
    throw new Error('OPTION_NOT_FOUND: 没有匹配的选项 "' + wanted + '"，可选: ' + pool);
  };
}

/** Node 侧纯函数入口：与浏览器现场构造同一源、同一 normalize */
export const chooseOptionIndex = createOptionMatcher(normalizeAccessibleName);

/** 匹配模式：归一化相等为 exact，否则唯一子串（供 selection 事实记录） */
export function matchModeOf(name: string, wanted: string): 'exact' | 'substring' {
  return normalizeAccessibleName(name) === normalizeAccessibleName(wanted) ? 'exact' : 'substring';
}

// ── 原生单选（beta-native 已自证原子合同，保持不变）──

/** 无闭包原生 DOM 选取：非 SELECT 返回 null（保持 Source 既有 custom 分流）。
 *  matcher 由调用方构造注入（真实依赖注入，非 import 闭包）。 */
export function selectNativeOption(
  element: Element,
  matcher: (labels: readonly string[], wanted: string) => number,
  wanted: string,
): string | null {
  if (!element) throw new Error('目标不是元素');
  if (element.tagName !== 'SELECT') return null;
  const select = element as HTMLSelectElement;
  if (select.matches(':disabled')) {
    throw new Error('NOT_INTERACTABLE: 目标下拉框已禁用（disabled 或禁用 fieldset），无法选择 "' + wanted + '"');
  }
  if (select.closest('[aria-disabled="true"]') !== null) {
    throw new Error('NOT_INTERACTABLE: 目标下拉框处于 aria-disabled="true" 祖先内，无法选择 "' + wanted + '"');
  }
  const opts = Array.from(select.options);
  const labels = opts.map((option) => (option.label || option.textContent || '').trim());
  const index = matcher(labels, wanted);
  const hit = opts[index];
  if (hit.matches(':disabled')) {
    throw new Error('NOT_INTERACTABLE: 选项 "' + wanted + '" 已禁用（自身 disabled、禁用 optgroup 或 aria-disabled），不能选择');
  }
  if (hit.closest('[aria-disabled="true"]') !== null) {
    throw new Error('NOT_INTERACTABLE: 选项 "' + wanted + '" 处于 aria-disabled="true" 祖先内，不能选择');
  }
  if (!hit.selected) {
    select.selectedIndex = index;
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }
  if (select.isConnected === false || select.options[index] !== hit || (hit.label || hit.textContent || '').trim() !== labels[index]) {
    throw new Error('SELECTION_TARGET_CHANGED: 原生选择提交后原选项身份已变化');
  }
  if (!hit.selected) throw new Error('SELECTION_NOT_COMMITTED: 原生选择提交后原选项未选中');
  return labels[index];
}

/** CDP callFunctionOn 专用：以 this 为元素、wanted 为唯一实参；matcher 在浏览器现场由两个真实源重建 */
export const SELECT_NATIVE_OPTION_FN = `function (wanted) {
  const matcher = (${createOptionMatcher.toString()})(${normalizeAccessibleName.toString()});
  return (${selectNativeOption.toString()})(this, matcher, wanted);
}`;

/** PW locator.evaluate 专用：由同一函数源派生的无闭包二元函数（el, wanted） */
export function selectNativeOptionEval(): (el: never, wanted: string) => string | null {
  return new Function(
    'el',
    'arg',
    `const matcher = (${createOptionMatcher.toString()})(${normalizeAccessibleName.toString()}); return (${selectNativeOption.toString()})(el, matcher, arg);`,
  ) as (el: never, wanted: string) => string | null;
}

// ── 原生多选（§10 F1/F3/F4：读 → Node 公共 matcher → 原子写入）──

/** 无闭包原生选项读取：非 SELECT 返回 null。labels 取真实 option.label/textContent；
 *  disabled 覆盖自身 disabled、禁用 optgroup（:disabled 实际语义）与 aria-disabled 祖先。 */
export function readNativeOptions(element: Element): { multiple: boolean; labels: string[]; disabled: boolean[] } | null {
  if (!element) throw new Error('目标不是元素');
  if (element.tagName !== 'SELECT') return null;
  const select = element as HTMLSelectElement;
  const opts = Array.from(select.options);
  return {
    multiple: select.multiple,
    labels: opts.map((option) => (option.label || option.textContent || '').trim()),
    disabled: opts.map((option) => option.matches(':disabled') || option.closest('[aria-disabled="true"]') !== null),
  };
}

/** 无闭包原子写入：核当前 labels 与读取时一致（漂移抛 SELECTION_TARGET_CHANGED）、所选项仍
 *  enabled、单选收到多项在写入前拒绝；多选只把请求项设 selected=true 保留其他已选项，
 *  单选清其它项；同一次调用派 input/change，返回请求项实际完整 label。 */
export function applyNativeSelection(element: Element, input: { labels: string[]; indexes: number[]; add: boolean }): string[] {
  if (!element) throw new Error('目标不是元素');
  if (element.tagName !== 'SELECT') throw new Error('SELECTION_TARGET_NOT_NATIVE: 目标不是原生下拉框，无法按原生多选写入');
  const select = element as HTMLSelectElement;
  if (select.matches(':disabled')) {
    throw new Error('NOT_INTERACTABLE: 目标下拉框已禁用（disabled 或禁用 fieldset），无法选择');
  }
  if (select.closest('[aria-disabled="true"]') !== null) {
    throw new Error('NOT_INTERACTABLE: 目标下拉框处于 aria-disabled="true" 祖先内，无法选择');
  }
  const opts = Array.from(select.options);
  const current = opts.map((option) => (option.label || option.textContent || '').trim());
  if (current.length !== input.labels.length || current.some((label, i) => label !== input.labels[i])) {
    throw new Error('SELECTION_TARGET_CHANGED: 原生选项列表在读取与写入之间发生变化，拒绝按旧下标写入');
  }
  for (const idx of input.indexes) {
    if (!Number.isInteger(idx) || idx < 0 || idx >= opts.length) {
      throw new Error('SELECTION_TARGET_CHANGED: 选项下标越界（' + String(idx) + '/' + opts.length + '），列表已变化');
    }
    if (opts[idx].matches(':disabled')) {
      throw new Error('NOT_INTERACTABLE: 选项 "' + input.labels[idx] + '" 已禁用（自身 disabled、禁用 optgroup 或 aria-disabled），不能选择');
    }
    if (opts[idx].closest('[aria-disabled="true"]') !== null) {
      throw new Error('NOT_INTERACTABLE: 选项 "' + input.labels[idx] + '" 处于 aria-disabled="true" 祖先内，不能选择');
    }
  }
  if (!select.multiple && input.indexes.length > 1) {
    throw new Error('OPTION_MULTIPLE_ON_SINGLE: 单选下拉框收到多项选择输入，已在写入前拒绝');
  }
  const alreadySelected = input.indexes.every((idx) => opts[idx].selected)
    && (input.add || opts.every((opt, idx) => opt.selected === input.indexes.includes(idx)));
  if (!alreadySelected) {
    if (select.multiple) {
      if (!input.add) {
        for (const opt of opts) opt.selected = false;
      }
      for (const idx of input.indexes) opts[idx].selected = true;
    } else {
      opts[input.indexes[0]].selected = true;
    }
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }
  for (const idx of input.indexes) {
    if (select.isConnected === false || select.options[idx] !== opts[idx] || (opts[idx].label || opts[idx].textContent || '').trim() !== input.labels[idx]) {
      throw new Error('SELECTION_TARGET_CHANGED: 原生选择提交后原选项身份已变化');
    }
    if (!opts[idx].selected) throw new Error('SELECTION_NOT_COMMITTED: 原生选择提交后选项 "' + input.labels[idx] + '" 未选中');
  }
  return input.indexes.map((idx) => current[idx]);
}

/** CDP callFunctionOn 专用：READ/APPLY 两个原生函数的 this 包装 */
export const READ_NATIVE_OPTIONS_FN = `function () { return (${readNativeOptions.toString()})(this); }`;
export const APPLY_NATIVE_SELECTION_FN = `function (input) { return (${applyNativeSelection.toString()})(this, input); }`;

// ── 原子提交包装（F04：写前捕获实际 option 引用，事件后不再重查当前列表）──

/** CDP callFunctionOn 专用：单选原子提交包装。同一同步 DOM 调用内构造 matcher，
 *  包装 matcher 把该次 index 命中的真实 option Node（写前引用）先保存，再调用原内核
  * selectNativeOption(this, wrappedMatcher, wanted)；返回 null（非 SELECT 分流原样透传）
  * 或 {picked:[内核返回 label], nodes:[捕获的该次实际 option]}。不再次匹配、不重读当前 options。 */
export const SELECT_NATIVE_COMMIT_FN = `function (wanted) {
  const select = this;
  const captured = [];
  const alreadySelected = [];
  const observedCount = this.tagName === 'SELECT' ? this.options.length : 0;
  const base = (${createOptionMatcher.toString()})(${normalizeAccessibleName.toString()});
  const matcher = function (labels, w) {
    const idx = base(labels, w);
    captured.push(select.options[idx]);
    alreadySelected.push(select.options[idx].selected === true);
    return idx;
  };
  const label = (${selectNativeOption.toString()})(this, matcher, wanted);
  if (label === null) return null;
  return { picked: [label], nodes: captured, alreadySelected: alreadySelected, observedCount: observedCount };
}`;

/** CDP callFunctionOn 专用：多选原子提交包装。同一同步调用、input/change 事件派发之前，
  * 先捕获 input.indexes 指向的真实 option 引用，再调用原内核 applyNativeSelection(this, input)；
  * 成功返回 {picked:内核返回 label 数组, nodes:捕获数组}；guard 抛错原样传播，不返回成功结果。 */
export const APPLY_NATIVE_COMMIT_FN = `function (input) {
  const select = this;
  const nodes = input.indexes.map(function (idx) { return select.options[idx]; });
  const alreadySelected = nodes.map(function (node) { return node && node.selected === true; });
  const observedCount = select.options.length;
  const picked = (${applyNativeSelection.toString()})(this, input);
  return { picked: picked, nodes: nodes, alreadySelected: alreadySelected, observedCount: observedCount };
}`;

/** PW locator.evaluate 专用派生 */
export function readNativeOptionsEval(): (el: never) => { multiple: boolean; labels: string[]; disabled: boolean[] } | null {
  return new Function('el', `return (${readNativeOptions.toString()})(el);`) as (el: never) => { multiple: boolean; labels: string[]; disabled: boolean[] } | null;
}
export function applyNativeSelectionEval(): (el: never, input: { labels: string[]; indexes: number[]; add: boolean }) => string[] {
  return new Function('el', 'input', `return (${applyNativeSelection.toString()})(el, input);`) as (el: never, input: { labels: string[]; indexes: number[]; add: boolean }) => string[];
}

// ── custom 控件（根状态 / 池扫描 / 禁用 guard，全部无闭包）──

/** 无闭包根状态读取：native 分流 + 声明关联 ID（aria-controls/aria-owns，空白分隔多 ID）
 *  + 真实 aria-expanded（缺属性为 null）。 */
export interface SelectRootState {
  native: boolean;
  multiple: boolean;
  ariaControls: string[];
  ariaOwns: string[];
  ariaExpanded: boolean | null;
  role: string | null;
  activeDescendantId: string | null;
  focusable: boolean;
  focused: boolean;
  disabled: boolean;
  connected: boolean;
}

export function readSelectRootState(element: Element): SelectRootState | null {
  if (!element) throw new Error('目标不是元素');
  if (element.nodeType !== 1) return null;
  const ids = (attr: string): string[] => (element.getAttribute(attr) || '').split(/\s+/).filter(Boolean);
  if (element.tagName === 'SELECT') {
    return {
      native: true,
      multiple: (element as HTMLSelectElement).multiple,
      ariaControls: [],
      ariaOwns: [],
      ariaExpanded: null,
      role: null,
      activeDescendantId: null,
      focusable: true,
      focused: element.ownerDocument.activeElement === element,
      disabled: element.matches(':disabled') || element.closest('[aria-disabled="true"]') !== null,
      connected: element.isConnected,
    };
  }
  const expanded = element.getAttribute('aria-expanded');
  const role = (element.getAttribute('role') || '').trim().split(/\s+/)[0] || null;
  const activeDescendantId = element.getAttribute('aria-activedescendant');
  return {
    native: false,
    multiple: false,
    ariaControls: ids('aria-controls'),
    ariaOwns: ids('aria-owns'),
    ariaExpanded: expanded === null ? null : expanded === 'true',
    role: role,
    activeDescendantId: activeDescendantId,
    focusable: (element as HTMLElement).tabIndex >= 0 || element.hasAttribute('tabindex'),
    focused: element.ownerDocument.activeElement === element,
    disabled: element.matches(':disabled') || element.closest('[aria-disabled="true"]') !== null,
    connected: element.isConnected,
  };
}

/** 唯一 DOM resolver（F05-F09）：声明池按 root.ownerDocument + 真实 CSS.escape(id) 查询、
 *  核唯一，按 Element 身份去重并剔除被祖先声明池覆盖的子池（嵌套声明不 double-count）；
 *  不同真实节点同名不合并。fallback 先数当前 document 全部真实可见选项池（不过滤 owned），
 *  优先归并到最近显式 listbox/menu/tree/menubar 容器（内部 group/包装不另算池），
 *  无显式容器才退 group/list/grid、再退 parentElement 实际节点身份；多池或唯一他方 owned
 *  池明确拒绝；合法暂时无池返回 page + []（调用方展开/等待），不吞协议错误。 */
export function resolveOptionPools(root: Element): { scope: 'related' | 'page'; pools: Element[] } {
  if (!root) throw new Error('目标不是元素');
  if (root.nodeType !== 1) throw new Error('SELECTION_ROOT_INVALID: 选择根不是元素节点');
  const doc = root.ownerDocument;
  if (!doc) throw new Error('SELECTION_ROOT_INVALID: 选择根没有所属 document');
  const escapeId = (id: string): string => {
    const view = doc.defaultView;
    if (view && view.CSS && typeof view.CSS.escape === 'function') return view.CSS.escape(id);
    throw new Error('SELECTION_ROOT_INVALID: 当前 document 不支持 CSS.escape，无法解析声明池 id');
  };
  const declared: string[] = [];
  for (const attr of ['aria-controls', 'aria-owns']) {
    for (const id of (root.getAttribute(attr) || '').split(/\s+/)) {
      if (id && !declared.includes(id)) declared.push(id);
    }
  }
  if (declared.length > 0) {
    const pools: Element[] = [];
    for (const id of declared) {
      const hits = Array.from(doc.querySelectorAll('#' + escapeId(id)));
      if (hits.length === 0) {
        throw new Error('OPTION_POOL_DECLARED_MISSING: 声明池 id "' + id + '" 在当前 document 未找到节点，展开/等待后仍缺失');
      }
      if (hits.length > 1) {
        throw new Error('OPTION_POOL_DECLARED_AMBIGUOUS: 声明池 id "' + id + '" 命中 ' + hits.length + ' 个节点，歧义拒绝');
      }
      if (!pools.some((p) => p === hits[0])) pools.push(hits[0]);
    }
    if (pools.length > 0) {
      const kept = pools.filter((p) => !pools.some((other) => other !== p && other.contains(p)));
      return { scope: 'related', pools: kept };
    }
  }
  // 显式根自身 role=listbox/tree/menu/menubar → related pool 自己
  const rootRole = root.getAttribute('role');
  if (rootRole && ['listbox', 'tree', 'menu', 'menubar'].includes(rootRole)) {
    return { scope: 'related', pools: [root] };
  }
  const ROLE_SEL = '[role="option"],[role="treeitem"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"]';
  const EXPLICIT_SEL = '[role="listbox"],[role="menu"],[role="tree"],[role="menubar"]';
  const WRAPPER_SEL = '[role="group"],[role="list"],[role="grid"]';
  const visible = (el: Element): boolean => el.getClientRects().length > 0;
  const poolOf = (el: Element): Element => {
    const explicit = el.closest(EXPLICIT_SEL);
    if (explicit && explicit !== el) return explicit;
    const wrapper = el.closest(WRAPPER_SEL);
    if (wrapper && wrapper !== el) return wrapper;
    return el.parentElement ?? el;
  };
  const pools = new Map<Element, number>();
  for (const el of Array.from(doc.querySelectorAll(ROLE_SEL))) {
    if (!visible(el)) continue;
    const pool = poolOf(el);
    pools.set(pool, (pools.get(pool) ?? 0) + 1);
  }
  if (pools.size === 0) return { scope: 'page', pools: [] };
  if (pools.size > 1) {
    throw new Error('OPTION_AMBIGUOUS: 当前 document 有 ' + pools.size + ' 个可见选项池，无声明关联时拒绝猜测');
  }
  const pool = pools.keys().next().value as Element;
  const referencedByOther = new Set<string>();
  for (const el of Array.from(doc.querySelectorAll('[aria-controls],[aria-owns]'))) {
    if (el === root) continue;
    for (const attr of ['aria-controls', 'aria-owns']) {
      for (const id of (el.getAttribute(attr) || '').split(/\s+/)) {
        if (id) referencedByOther.add(id);
      }
    }
  }
  let node: Element | null = pool;
  while (node) {
    if (node.id && referencedByOther.has(node.id)) {
      throw new Error('OPTION_AMBIGUOUS: 唯一可见选项池被其它控件 aria-controls/owns 拥有，不属于本控件，拒绝选择');
    }
    node = node.parentElement;
  }
  return { scope: 'page', pools: [pool] };
}

// ── category 层级 predicate（F13：相连层级，不整树搜索）──

/** 共源纯 DOM predicate：option 是 scopeRoot 真子孙且不是 scopeRoot 本身；沿真实父链走到
  * scopeRoot，遇到更近的五类可选项祖先即不是本层（generic/group 包装忽略，不限层数）。
  * Source/PW 两侧用同一源执行，不用 innerText 判断名称。 */
export function isDirectCategoryChild(option: Element, scopeRoot: Element, roles: readonly string[]): boolean {
  if (!option || !scopeRoot) return false;
  if (option === scopeRoot) return false;
  if (!scopeRoot.contains(option)) return false;
  let node: Element | null = option.parentElement;
  while (node && node !== scopeRoot) {
    if (roles.includes(node.getAttribute('role') || '')) return false;
    node = node.parentElement;
  }
  return node === scopeRoot;
}

/** CDP callFunctionOn 专用（this=候选 option；scopeRoot 走 objectId 实参，roles 走 by-value） */
export const IS_DIRECT_CATEGORY_CHILD_FN = `function (scopeRoot, roles) { return (${isDirectCategoryChild.toString()})(this, scopeRoot, roles); }`;

/** CDP resolver 包装（this=根）：returnByValue:false 返回 RemoteObject {scope, pools:Element[]} */
export const RESOLVE_OPTION_POOLS_FN = `function () { return (${resolveOptionPools.toString()})(this); }`;

/** PW locator.evaluate 专用：同 resolver 的 related 分支返回 containment 去重后真实声明池的
  * CSS.escape selector（在根所在 document 转义）；fallback 分支 selectors 为空，调用方走固定 engine。 */
export function resolveOptionPoolsMetaEval(): (el: never) => { scope: 'related' | 'page'; selectors: string[]; self: boolean } {
  return new Function('el', `const r = (${resolveOptionPools.toString()})(el);
    const self = r.scope === 'related' && r.pools.length === 1 && r.pools[0] === el;
    return { scope: r.scope, selectors: r.scope === 'related' && !self ? r.pools.map(function (p) { return '#' + (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(p.id || '') : p.id); }) : [], self: self }`) as (el: never) => { scope: 'related' | 'page'; selectors: string[]; self: boolean };
}

/** PW ElementHandle.evaluate 专用：isDirectCategoryChild 适配（arg=[scopeRoot, roles]） */
export function isDirectCategoryChildEval(): (el: never, arg: [Element, readonly string[]]) => boolean {
  return new Function('el', 'arg', `return (${isDirectCategoryChild.toString()})(el, arg[0], arg[1]);`) as (el: never, arg: [Element, readonly string[]]) => boolean;
}

// ── 固定选择池 engine（PW fallback 绑定；唯一 body=unique，无 ID/JSON/索引 DSL）──

/** engine 名称（[a-zA-Z0-9_]）：仅服务本次实际池绑定，不加用户配置 */
export const E2ET_SELECTION_POOL_ENGINE_NAME = 'e2et_selection_pool';
/** fallback 绑定的固定 selector（root.locator 用，root 必须是已定位的本次选择控件） */
export const E2ET_SELECTION_POOL_UNIQUE = 'e2et_selection_pool=unique';

/** Selectors.register 专用：无闭包 engine 工厂源（queryAll 调同一 resolver，仅接受 fallback：
  * 合法暂时无池返回 []；唯一且未 owned 返回该真实 Element 单元素数组；多池/他方拥有原样抛明确
  * 错误。query 同结果：空返回 null、唯一返回实际 Element，不在多个结果中取第一个）。 */
export const E2ET_SELECTION_POOL_ENGINE_FN = `function () {
  const resolver = (${resolveOptionPools.toString()});
  const uniquePools = function (root) {
    const r = resolver(root);
    if (r.scope !== 'page') throw new Error('OPTION_POOL_ENGINE_SCOPE: e2et_selection_pool 只解析 fallback 池，根声明了关联池');
    return r.pools;
  };
  return {
    query: function (root, selector) {
      if (selector !== 'unique') throw new Error('OPTION_POOL_ENGINE_BODY: e2et_selection_pool 只支持 unique，无 ID/JSON/索引查询 DSL');
      const pools = uniquePools(root);
      if (pools.length === 0) return null;
      return pools[0];
    },
    queryAll: function (root, selector) {
      if (selector !== 'unique') throw new Error('OPTION_POOL_ENGINE_BODY: e2et_selection_pool 只支持 unique，无 ID/JSON/索引查询 DSL');
      return uniquePools(root);
    },
  };
}`;

/** 实际注册用的 engine 工厂（closure-free：源内嵌 resolver，可被 Playwright 序列化） */
export function e2etSelectionPoolEngine(): () => { query: (root: Element, selector: string) => Element | null; queryAll: (root: Element, selector: string) => Element[] } {
  return new Function('return (' + E2ET_SELECTION_POOL_ENGINE_FN + ')')() as () => { query: (root: Element, selector: string) => Element | null; queryAll: (root: Element, selector: string) => Element[] };
}

/** 无闭包可见性判定：真实布局盒子（getClientRects），与 collectPageState 展示通道无关 */
export function isElementVisible(element: Element): boolean {
  if (!element) return false;
  return Array.from(element.getClientRects()).some((rect) => rect.width * rect.height > 0.99);
}

/** 无闭包选项禁用 guard：:disabled（覆盖 disabled 属性/fieldset/optgroup 实际语义）
 *  与真实 aria-disabled 祖先；返回原因或 null。 */
export function optionDisabledReason(element: Element): string | null {
  if (!element) throw new Error('目标不是元素');
  if (element.matches(':disabled')) return 'disabled 属性';
  if (element.getAttribute('aria-disabled') === 'true') return 'aria-disabled="true"';
  if (element.closest('[aria-disabled="true"]')) return '祖先节点 aria-disabled="true"';
  return null;
}

/** filter_text 前置 guard：在 focus/展开前核原 native input 的 password/readonly/:disabled，
 *  防止 focus handler 把 password 改 text 绕过 writer 初始 guard。返回 null 表示可写，
 *  否则返回原因字符串。password 必须由调用方转 AUTH_DATA_NOT_REPLAYABLE 固定前缀。 */
export function filterPreflightGuard(element: Element, resolve: (element: Element) => WriteTarget): string | null {
  if (!element) throw new Error('目标不是元素');
  const input = resolve(element);
  if (input instanceof HTMLInputElement && input.type === 'password') return 'password';
  if (!(input instanceof HTMLSelectElement) && input.readOnly || input.getAttribute('aria-readonly') === 'true') return 'readonly';
  if (input.matches(':disabled') || input.closest('[aria-disabled="true"]')) return 'disabled';
  return null;
}

/** CDP callFunctionOn 专用（this 包装） */
export const READ_SELECT_ROOT_STATE_FN = `function () { return (${readSelectRootState.toString()})(this); }`;
export const OPTION_DISABLED_REASON_FN = `function () { return (${optionDisabledReason.toString()})(this); }`;
export const FILTER_PREFLIGHT_GUARD_FN = `function () { return (${filterPreflightGuard.toString()})(this, (${resolveWriteTarget.toString()})); }`;

/** A8: 幂等性检查 - 选项是否已选中（避免重复 Enter 导致反选） */
export function optionIsSelected(element: Element): boolean {
  return element.getAttribute('aria-selected') === 'true'
    || (element.tagName === 'OPTION' && (element as HTMLOptionElement).selected)
    || element.getAttribute('aria-checked') === 'true';
}

export const OPTION_IS_SELECTED_FN = `function () { return (${optionIsSelected.toString()})(this); }`;

export const IS_ELEMENT_VISIBLE_FN = `function () { return (${isElementVisible.toString()})(this); }`;

/** PW locator.evaluate 专用派生 */
export function readSelectRootStateEval(): (el: never) => SelectRootState | null {
  return new Function('el', `return (${readSelectRootState.toString()})(el);`) as (el: never) => ReturnType<typeof readSelectRootState>;
}
export function optionDisabledReasonEval(): (el: never) => string | null {
  return new Function('el', `return (${optionDisabledReason.toString()})(el);`) as (el: never) => string | null;
}
export function filterPreflightGuardEval(): (el: never) => string | null {
  return new Function('el', `return (${filterPreflightGuard.toString()})(el, (${resolveWriteTarget.toString()}));`) as (el: never) => string | null;
}
export function isElementVisibleEval(): (el: never) => boolean {
  return new Function('el', `return (${isElementVisible.toString()})(el);`) as (el: never) => boolean;
}

export interface OptionState {
  id: string;
  role: string;
  connected: boolean;
  selected: boolean | null;
  checked: boolean | null;
  expanded: boolean | null;
  posinset: number | null;
  setsize: number | null;
}

/** 只读取标准状态；没有属性与明确 false 必须分开。 */
export function readOptionState(element: Element): OptionState {
  const flag = (attr: string): boolean | null => element.hasAttribute(attr) ? element.getAttribute(attr) === 'true' : null;
  const ordinal = (attr: string): number | null => {
    const raw = element.getAttribute(attr);
    if (raw === null || raw === '-1') return null;
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) throw new Error('INSUFFICIENT_EVIDENCE: 非法标准 ' + attr + '=' + raw);
    return value;
  };
  return {
    id: element.id,
    role: (element.getAttribute('role') || '').trim().split(/\s+/)[0] || (element.tagName === 'OPTION' ? 'option' : ''),
    connected: element.isConnected,
    selected: element.tagName === 'OPTION' ? (element as HTMLOptionElement).selected : flag('aria-selected'),
    checked: flag('aria-checked'),
    expanded: flag('aria-expanded'),
    posinset: ordinal('aria-posinset'),
    setsize: ordinal('aria-setsize'),
  };
}

export const READ_OPTION_STATE_FN = `function () { return (${readOptionState.toString()})(this); }`;
export function readOptionStateEval(): (el: never) => OptionState {
  return new Function('el', `return (${readOptionState.toString()})(el);`) as (el: never) => OptionState;
}

export interface KeyboardOption extends OptionState {
  name: string;
  eligible?: boolean;
}
export interface KeyboardSnapshot { active_id: string; options: KeyboardOption[]; }

/** 每轮用原根、原池和标准 id 核身份。名称由两侧的标准可访问名称读取补齐。 */
export function readKeyboardContext(
  root: Element,
  expectedPool: Element,
  resolver: (element: Element) => { scope: 'related' | 'page'; pools: Element[] },
  readState: (element: Element) => OptionState,
  roles: readonly string[],
): { active_id: string; options: OptionState[] } {
  if (!root.isConnected || !expectedPool.isConnected) throw new Error('INSUFFICIENT_EVIDENCE: 键盘遍历中原根或原池被替换');
  const rootRole = (root.getAttribute('role') || '').trim().split(/\s+/)[0];
  if (!['combobox', 'listbox', 'tree', 'menu', 'menubar'].includes(rootRole)) throw new Error('INSUFFICIENT_EVIDENCE: 原根缺少支持此选择的标准复合角色');
  if (root.ownerDocument.activeElement !== root) throw new Error('INSUFFICIENT_EVIDENCE: 键盘选择的真实焦点不在原根');
  if (root.matches(':disabled') || root.closest('[aria-disabled="true"]')) throw new Error('NOT_INTERACTABLE: 键盘选择根已禁用');
  let pools: { scope: 'related' | 'page'; pools: Element[] };
  try { pools = resolver(root); }
  catch (error) {
    if ((error as Error).message.startsWith('OPTION_POOL_DECLARED_MISSING')) throw new Error('INSUFFICIENT_EVIDENCE: 键盘遍历中原声明池已消失');
    throw error;
  }
  if (pools.scope !== 'related' || pools.pools.length !== 1 || pools.pools[0] !== expectedPool) {
    throw new Error('INSUFFICIENT_EVIDENCE: 键盘遍历必须保持唯一声明关联池，原池已变化');
  }
  const doc = root.ownerDocument;
  const escape = (id: string): string => doc.defaultView!.CSS.escape(id);
  const activeId = root.getAttribute('aria-activedescendant') || '';
  const active = activeId ? Array.from(doc.querySelectorAll('#' + escape(activeId))) : [];
  if (active.length !== 1 || !expectedPool.contains(active[0]) || !roles.includes(readState(active[0]).role)) {
    throw new Error('INSUFFICIENT_EVIDENCE: 当前 aria-activedescendant 不是原声明池内唯一标准可选项');
  }
  for (const owner of Array.from(doc.querySelectorAll('[aria-controls],[aria-owns],[aria-activedescendant]'))) {
    if (owner === root) continue;
    const ids = ['aria-controls', 'aria-owns'].flatMap((attr) => (owner.getAttribute(attr) || '').split(/\s+/).filter(Boolean));
    const otherActive = owner.getAttribute('aria-activedescendant');
    const otherNode = otherActive ? doc.querySelector('#' + escape(otherActive)) : null;
    if (ids.some((id) => expectedPool.id === id) || (otherNode && expectedPool.contains(otherNode))) {
      throw new Error('INSUFFICIENT_EVIDENCE: 声明池存在另一个标准交互根，拒绝代理键盘选择');
    }
  }
  const hidden = (element: Element): boolean => {
    for (let node: Element | null = element; node; node = node.parentElement) {
      const style = doc.defaultView!.getComputedStyle(node);
      if (node.hasAttribute('hidden') || node.getAttribute('aria-hidden') === 'true' || style.display === 'none' || style.visibility === 'hidden') return true;
    }
    return false;
  };
  const selector = roles.map((role) => '[role="' + role + '"]').join(',');
  const options: OptionState[] = [];
  for (const element of Array.from(expectedPool.querySelectorAll(selector))) {
    if (hidden(element)) continue;
    const state = readState(element);
    if (!state.id || doc.querySelectorAll('#' + escape(state.id)).length !== 1) {
      throw new Error('INSUFFICIENT_EVIDENCE: 键盘可达库存缺少唯一标准 id');
    }
    options.push(state);
  }
  if (!options.some((option) => option.id === activeId)) throw new Error('INSUFFICIENT_EVIDENCE: active descendant 未暴露标准语义');
  return { active_id: activeId, options };
}

export function readKeyboardContextEval(): (el: never, pool: Element) => { active_id: string; options: OptionState[] } {
  return new Function('el', 'pool', `return (${readKeyboardContext.toString()})(el, pool, (${resolveOptionPools.toString()}), (${readOptionState.toString()}), ${JSON.stringify(OPTION_ROLES)});`) as (el: never, pool: Element) => { active_id: string; options: OptionState[] };
}

/** 同一预算内证明完整键盘可达集合，再按原 id 导航；不解析 id 后缀或虚拟窗口下标。 */
export async function reachKeyboardSelection(
  wanted: string,
  read: () => Promise<KeyboardSnapshot>,
  press: (key: 'ArrowDown' | 'ArrowUp') => Promise<void>,
  deadline: number,
): Promise<{ id: string; role: string; name: string; observed_count: number }> {
  const observed = new Map<string, KeyboardOption>();
  const visited = new Set<string>();
  const evidence = (): string => ' (inventory_scope=keyboard-reachable, observed_count=' + observed.size + ')';
  const fail = (reason: string): never => { throw new Error('INSUFFICIENT_EVIDENCE: ' + reason + evidence()); };
  const observe = async (): Promise<KeyboardSnapshot> => {
    if (Date.now() >= deadline) fail('键盘可达集合遍历预算耗尽，未证明终止');
    const snapshot = await read();
    const local = new Set<string>();
    for (const option of snapshot.options) {
      if (!option.id || local.has(option.id)) fail('当前池标准 id 缺失或重复');
      if (!OPTION_ROLES.includes(option.role) || typeof option.name !== 'string') fail('当前候选没有真实标准角色或完整可访问名称');
      local.add(option.id);
      const old = observed.get(option.id);
      if (old && (old.role !== option.role || old.name !== option.name)) {
        throw new Error('SELECTION_TARGET_CHANGED: 标准 id "' + option.id + '" 的角色或完整名称漂移' + evidence());
      }
      if (old && (old.posinset !== option.posinset || old.setsize !== option.setsize || old.eligible !== option.eligible)) fail('标准位置或本层关系在遍历中变化');
      if (option.setsize !== null && option.posinset !== null && option.posinset > option.setsize) fail('aria-posinset 超过 aria-setsize');
      observed.set(option.id, option);
    }
    if (!local.has(snapshot.active_id)) fail('当前 active descendant 未在本轮实际库存中');
    visited.add(snapshot.active_id);
    return snapshot;
  };
  let current = await observe();
  const move = async (key: 'ArrowDown' | 'ArrowUp'): Promise<boolean> => {
    const previous = current.active_id;
    await press(key);
    const settleDeadline = Math.min(deadline, Date.now() + 100);
    do {
      current = await observe();
      if (current.active_id !== previous) return true;
      if (Date.now() >= settleDeadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 20));
    } while (true);
  };
  const start = current.active_id;
  const down = new Set([start]);
  let cyclic = false;
  while (await move('ArrowDown')) {
    if (current.active_id === start) { cyclic = true; break; }
    if (down.has(current.active_id)) fail('键盘导航进入未回起点的子循环');
    down.add(current.active_id);
  }
  if (!cyclic) {
    const up = new Set([current.active_id]);
    while (await move('ArrowUp')) {
      if (up.has(current.active_id)) fail('反向导航未能到达另一端');
      up.add(current.active_id);
    }
  }
  const reachable = [...observed.values()].filter((option) => visited.has(option.id) && option.eligible !== false);
  const unseenActive = [...observed.values()].filter((option) => !visited.has(option.id));
  if (unseenActive.length > 0) {
    try {
      chooseOptionIndex(reachable.map((option) => option.name), wanted);
    } catch (error) {
      if ((error as Error).message.startsWith('OPTION_NOT_FOUND')) {
        const all = [...observed.values()].filter((option) => option.eligible !== false);
        try {
          const target = all[chooseOptionIndex(all.map((option) => option.name), wanted)];
          if (!visited.has(target.id)) throw new Error('NOT_INTERACTABLE: 目标 "' + target.name + '" 仅在窗口出现，从未成为 active descendant' + evidence());
        } catch (observedError) {
          if ((observedError as Error).message.startsWith('NOT_INTERACTABLE')) throw observedError;
        }
      }
    }
    fail('导航无响应后仍有已观察但未访问的候选');
  }
  const sizes = new Set(reachable.map((option) => option.setsize).filter((size): size is number => size !== null));
  if (sizes.size > 1 || (sizes.size === 1 && [...sizes][0] !== reachable.length)) fail('标准 aria-setsize 与可达库存不一致，不能推断未观察的禁用项');
  const positions = reachable.map((option) => option.posinset).filter((position): position is number => position !== null);
  if (sizes.size === 1 && (new Set(positions).size !== positions.length || (positions.length === reachable.length && (!positions.includes(1) || !positions.includes(reachable.length))))) fail('标准 aria-posinset 与观察库存不一致');
  let target: KeyboardOption;
  try {
    target = reachable[chooseOptionIndex(reachable.map((option) => option.name), wanted)];
  } catch (error) {
    throw new Error((error as Error).message + evidence());
  }
  const navigation = new Set<string>();
  while (current.active_id !== target.id) {
    if (navigation.has(current.active_id)) fail('无法再次导航到原目标 id');
    navigation.add(current.active_id);
    if (!await move('ArrowDown')) fail('再次导航到目标时按键无响应');
  }
  current = await observe();
  const actual = current.options.find((option) => option.id === target.id);
  if (current.active_id !== target.id || !actual || actual.role !== target.role || actual.name !== target.name) {
    throw new Error('SELECTION_TARGET_CHANGED: 提交前原 id、角色或完整名称不一致' + evidence());
  }
  return { id: target.id, role: target.role, name: target.name, observed_count: observed.size };
}

export type SelectionVerificationMethod = 'native-selected' | 'aria-selected' | 'aria-checked' | 'aria-expanded' | 'child-pool';

export function selectionVerification(state: OptionState, intermediate: boolean, childPool: boolean): { method: SelectionVerificationMethod; result: boolean } | undefined {
  if (state.selected === true) return { method: 'aria-selected', result: true };
  if (state.checked === true) return { method: 'aria-checked', result: true };
  if (intermediate && state.expanded === true) return { method: 'aria-expanded', result: true };
  if (intermediate && childPool) return { method: 'child-pool', result: true };
  if (state.selected !== null) return { method: 'aria-selected', result: false };
  if (state.checked !== null) return { method: 'aria-checked', result: false };
  if (intermediate && state.expanded !== null) return { method: 'aria-expanded', result: false };
  return undefined;
}
