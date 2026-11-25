export interface WriteInput {
  value: string;
  mode: 'type' | 'fill';
}

/** PW locator.evaluate 专用：由 scrollWindow 函数源派生的无闭包二元函数（el, input）。
 *  el 仅满足 frame 作用域 locator('html').evaluate 的 (element, arg) 签名，滚动算法不复制。 */
export function scrollWindowEval(): (el: never, arg: ScrollInput) => boolean {
  return new Function('el', 'input', `return (${scrollWindow.toString()})(input);`) as (el: never, arg: ScrollInput) => boolean;
}

export interface ScrollInput {
  axis: 'x' | 'y';
  delta: number;
}

/** 共源滚动（Phase3a Scroll 子集）：Source 与 runtime 同用真实 scrollElement/centerElement/scrollWindow */
export function scrollElement(element: Element, input: ScrollInput): { found: boolean; moved: boolean } {
  if (!element) throw new Error('目标不是元素');
  let el: HTMLElement | null = element.nodeType === 1 ? (element as HTMLElement) : element.parentElement;
  while (el) {
    const style = getComputedStyle(el);
    const overflowAxis = input.axis === 'x' ? style.overflowX : style.overflowY;
    const isScrollRoot = el === document.scrollingElement;
    const canOverflow = overflowAxis === 'auto' || overflowAxis === 'scroll' || overflowAxis === 'overlay';
    const canScroll = isScrollRoot || canOverflow;
    if (canScroll && (input.axis === 'x' ? el.scrollWidth > el.clientWidth : el.scrollHeight > el.clientHeight)) {
      const before = input.axis === 'x' ? el.scrollLeft : el.scrollTop;
      const opts: ScrollToOptions = { behavior: 'instant' };
      if (input.axis === 'x') opts.left = input.delta;
      else opts.top = input.delta;
      el.scrollBy(opts);
      const after = input.axis === 'x' ? el.scrollLeft : el.scrollTop;
      return { moved: after !== before, found: true };
    }
    el = el.parentElement;
  }
  return { moved: false, found: false };
}

/** 两侧同用 block:center + behavior:instant，不用 PW scrollIntoViewIfNeeded 冒充。
 *  moved 由同一 DOM 调用中原 element 各真实祖先（含自身）scrollLeft/scrollTop 与 window
 *  坐标的前后比较判定（instant 同步滚动），已居中再次 center 返回 false，不恒真。 */
export function centerElement(element: Element): boolean {
  if (!element) throw new Error('目标不是元素');
  const positions = (): number[] => {
    const out: number[] = [window.scrollX, window.scrollY];
    let el: Element | null = element;
    while (el) {
      out.push(el.scrollLeft, el.scrollTop);
      el = el.parentElement;
    }
    return out;
  };
  const before = positions();
  (element as HTMLElement).scrollIntoView({ block: 'center', behavior: 'instant' });
  const after = positions();
  return before.some((v, i) => v !== after[i]);
}

/** 两侧同用 window.scrollBy，按真实坐标变化返回 moved；横向滚动 top 不斜滚 */
export function scrollWindow(input: ScrollInput): boolean {
  const beforeX = window.scrollX;
  const beforeY = window.scrollY;
  const opts: ScrollToOptions = { behavior: 'instant' };
  if (input.axis === 'x') opts.left = input.delta;
  else opts.top = input.delta;
  window.scrollBy(opts);
  return input.axis === 'x' ? window.scrollX !== beforeX : window.scrollY !== beforeY;
}

export function hoverEnter(element: Element): void {
  if (!element.isConnected) throw new Error('hover 目标已断开');
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) throw new Error('hover 目标不可见');
  const base = { bubbles: true, cancelable: true, view: window, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, button: 0 };
  const pointer = { ...base, pointerType: 'mouse', isPrimary: true, pointerId: 1 };
  if (element instanceof HTMLElement) element.focus();
  element.dispatchEvent(new PointerEvent('pointerover', pointer));
  element.dispatchEvent(new MouseEvent('mouseover', base));
  element.dispatchEvent(new PointerEvent('pointerenter', pointer));
  element.dispatchEvent(new MouseEvent('mouseenter', base));
  element.dispatchEvent(new PointerEvent('pointermove', pointer));
  element.dispatchEvent(new MouseEvent('mousemove', base));
}

export function hoverLeave(element: Element): void {
  if (!element.isConnected) throw new Error('hover 目标已断开');
  const rect = element.getBoundingClientRect();
  const base = { bubbles: true, cancelable: true, view: window, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, button: 0 };
  const pointer = { ...base, pointerType: 'mouse', isPrimary: true, pointerId: 1 };
  element.dispatchEvent(new PointerEvent('pointermove', { ...pointer, clientX: rect.left - 1, clientY: rect.top - 1 }));
  element.dispatchEvent(new MouseEvent('mousemove', { ...base, clientX: rect.left - 1, clientY: rect.top - 1 }));
  element.dispatchEvent(new PointerEvent('pointerout', pointer));
  element.dispatchEvent(new MouseEvent('mouseout', base));
  element.dispatchEvent(new PointerEvent('pointerleave', pointer));
  element.dispatchEvent(new MouseEvent('mouseleave', base));
}

export function isHoverRelated(element: Element, target: Element): boolean {
  if (!element.isConnected || !target.isConnected) throw new Error('hover 关联目标已断开');
  if (element.contains(target)) return true;
  for (let node: Element | null = element; node && node !== element.ownerDocument.body; node = node.parentElement) {
    for (const attr of ['aria-controls', 'aria-owns', 'aria-describedby']) {
      for (const id of (node.getAttribute(attr) || '').split(/\s+/)) {
        const root = element.ownerDocument.getElementById(id);
        if (root && root.contains(target)) return true;
      }
    }
  }
  return false;
}

export type WriteTarget = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

/** 只解析唯一原生叶节点；取得句柄并登记后，调用方才能聚焦。 */
export function resolveWriteTarget(element: Element): WriteTarget {
  if (!element || element.nodeType !== 1) throw new Error('NOT_INTERACTABLE: 目标不是元素');
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) return element;
  const leaves = element.querySelectorAll('input,textarea');
  if (leaves.length > 1) throw new Error('BAD_REQUEST: wrapper 内多个 input/textarea，歧义拒绝写入');
  const leaf = leaves[0];
  if (!(leaf instanceof HTMLInputElement) && !(leaf instanceof HTMLTextAreaElement)) {
    throw new Error('NOT_INTERACTABLE: 目标不是原生表单元素，也未找到内部 input/textarea');
  }
  return leaf;
}

function guardWriteTarget(leaf: WriteTarget): 'text' | 'native' {
  if (!leaf.isConnected) throw new Error('FILL_NOT_COMMITTED: 实际写入叶节点已断开');
  if (leaf instanceof HTMLInputElement && leaf.type === 'password') throw new Error('AUTH_DATA_NOT_REPLAYABLE');
  if (!(leaf instanceof HTMLSelectElement) && leaf.readOnly) throw new Error('NOT_INTERACTABLE: 叶节点为 readonly，不可写入');
  if (leaf.matches(':disabled') || leaf.closest('[aria-disabled="true"]')) throw new Error('NOT_INTERACTABLE: 叶节点为 disabled，不可写入');
  if (leaf.getAttribute('aria-readonly') === 'true') throw new Error('NOT_INTERACTABLE: 叶节点为 aria-readonly，不可写入');
  if (leaf instanceof HTMLTextAreaElement) return 'text';
  if (leaf instanceof HTMLSelectElement) return 'native';
  if (['text', 'search', 'email', 'url', 'tel'].includes(leaf.type)) return 'text';
  if (['date', 'datetime-local', 'month', 'week', 'time', 'number', 'range', 'color'].includes(leaf.type)) return 'native';
  throw new Error('NOT_INTERACTABLE: 此原生 input 类型不支持值输入');
}

export function assertWriteReady(leaf: WriteTarget): 'text' | 'native' {
  const kind = guardWriteTarget(leaf);
  const root = leaf.getRootNode();
  const active = root instanceof Document || root instanceof ShadowRoot ? root.activeElement : null;
  if (active !== leaf) throw new Error('NOT_INTERACTABLE: activeElement 不是实际写入叶节点，拒绝写入');
  return kind;
}

/** 密码/只读/禁用在聚焦前后分别核；select 事件也不能把后续字符转给替换叶。 */
export function prepareWriteTarget(leaf: WriteTarget): 'text' | 'native' {
  const kind = guardWriteTarget(leaf);
  leaf.focus();
  if (assertWriteReady(leaf) !== kind) throw new Error('FILL_NOT_COMMITTED: 聚焦后原生控件类型改变');
  if (kind === 'text') (leaf as HTMLInputElement | HTMLTextAreaElement).select();
  if (assertWriteReady(leaf) !== kind) throw new Error('FILL_NOT_COMMITTED: 选中旧值后原生控件类型改变');
  return kind;
}

/** 非文本原生值控件由 HTML value setter 提交；文本控件必须走浏览器编辑协议。 */
export function writeNativeValue(leaf: WriteTarget, value: string): void {
  if (assertWriteReady(leaf) !== 'native') throw new Error('NOT_INTERACTABLE: 目标不是非文本原生值控件');
  if (leaf instanceof HTMLSelectElement && value !== '') {
    const option = Array.from(leaf.options).find((item) => item.value === value);
    if (!option) throw new Error('BAD_REQUEST: native select 没有指定 value');
    if (option.disabled || (option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled)) {
      throw new Error('NOT_INTERACTABLE: native select 目标选项为 disabled');
    }
  }
  const proto = leaf instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (!setter) throw new Error('NOT_INTERACTABLE: 原生控件没有 value setter');
  setter.call(leaf, value);
  leaf.dispatchEvent(new Event('input', { bubbles: true }));
  leaf.dispatchEvent(new Event('change', { bubbles: true }));
  if (leaf instanceof HTMLInputElement && ['date', 'time', 'month', 'week', 'datetime-local'].includes(leaf.type)) {
    const root = leaf.getRootNode();
    const active = root instanceof Document || root instanceof ShadowRoot ? root.activeElement : null;
    if (active === leaf) leaf.blur();
  }
}

/** 回读固定叶；密码守卫与 value 读取在同一调用内完成。 */
export function readWriteTarget(leaf: WriteTarget): string {
  if (!leaf.isConnected) throw new Error('FILL_NOT_COMMITTED: 回读时实际写入叶节点已断开');
  if (leaf instanceof HTMLInputElement && leaf.type === 'password') throw new Error('AUTH_DATA_NOT_REPLAYABLE');
  return leaf.value;
}

const writeGuardSource = `const guardWriteTarget = (${guardWriteTarget.toString()}); const assertWriteReady = (${assertWriteReady.toString()});`;
export const RESOLVE_WRITE_TARGET_FN = `function () { return (${resolveWriteTarget.toString()})(this); }`;
export const PREPARE_WRITE_TARGET_FN = `function () { ${writeGuardSource} return (${prepareWriteTarget.toString()})(this); }`;
export const ASSERT_WRITE_READY_FN = `function () { ${writeGuardSource} return assertWriteReady(this); }`;
export const WRITE_NATIVE_VALUE_FN = `function (value) { ${writeGuardSource} return (${writeNativeValue.toString()})(this, value); }`;
export const READ_WRITE_TARGET_FN = `function () { return (${readWriteTarget.toString()})(this); }`;

export function prepareWriteTargetEval(): (leaf: WriteTarget) => 'text' | 'native' {
  return new Function('leaf', `${writeGuardSource} return (${prepareWriteTarget.toString()})(leaf);`) as (leaf: WriteTarget) => 'text' | 'native';
}

export function assertWriteReadyEval(): (leaf: WriteTarget) => 'text' | 'native' {
  return new Function('leaf', `${writeGuardSource} return assertWriteReady(leaf);`) as (leaf: WriteTarget) => 'text' | 'native';
}

export function writeNativeValueEval(): (leaf: WriteTarget, value: string) => void {
  return new Function('leaf', 'value', `${writeGuardSource} return (${writeNativeValue.toString()})(leaf, value);`) as (leaf: WriteTarget, value: string) => void;
}
