/**
 * 页面交互原语（组件库无关）
 *
 * 定位：AX 树的 backendNodeId → DOM.resolveNode 拿到页面内的元素句柄。
 * 点击：CDP Input.dispatchMouseEvent 真实指针事件（trusted=true），点击前验证 quad 坐标
 *      和 elementFromPoint 命中，确保命中目标或其子节点/shadow 子树。
 *
 * 全程不引用任何组件库的 class name。
 */
import type { CdpSession } from './daemon-client.js';
import { collectPageState, CdpReadError, type InteractiveElement, type PageState } from './page-state.js';
import { resolveTextTarget, TextTargetError } from './text-locator.js';
import { nativeDOMFunction } from './locator-query.js';
import { holdViewport, releaseViewport } from './viewport.js';

export interface ResolvedTarget {
  backendNodeId: number;
  role: string;
  name: string;
  /** selector 命中的节点数 —— >1 说明选择器有歧义，取的是第一个 */
  matches?: number;
  /** 走的哪条定位通道；dom-text 说明 AX 语义缺失，是弱通道 */
  matchedBy?: 'ax' | 'dom-text';
}

/** 真实目标缺席（CSS 空集 / 文本定位 notFound），区别于失效 ref（InvalidRefError）、
 *  协议读取失败（CdpReadError）与歧义（TextTargetError 非 notFound 分支自身已带文本）。
 *  daemon runAction 归 NOT_FOUND，wait_gone 只认这一类为 element gone。 */
export class TargetNotFoundError extends Error {
  constructor(message: string) { super(message); this.name = 'TargetNotFoundError'; }
}

/**
 * 目标解析。三种形态：
 * - number：当前快照的元素索引
 * - string：可交互元素的 accessible name（精确优先，再子串），AX 树没有时回退 DOM 可见文本
 * - { selector }：ARIA 语义缺失时的逃生口，由调用方显式提供
 */
export async function resolveTarget(
  session: CdpSession,
  target: number | string,
  state?: PageState,
): Promise<ResolvedTarget> {
  const snapshot = state || (await collectPageState(session));

  if (typeof target === 'number') {
    const el = snapshot.elements[target];
    if (!el) {
      throw new Error(
        `索引 ${target} 不存在（当前快照 ${snapshot.elements.length} 个元素），先调用 page state 刷新`,
      );
    }
    return { backendNodeId: el.backendNodeId, role: el.role, name: el.name, matchedBy: 'ax' };
  }

  const hit =
    snapshot.elements.find((e) => e.name === target) || snapshot.elements.find((e) => e.name.includes(target));
  if (hit) return { backendNodeId: hit.backendNodeId, role: hit.role, name: hit.name, matchedBy: 'ax' };

  // AX 树里没有 ≠ 页面上没有：无 role 无 aria-label 的 div 点击层进不了
  // INTERACTIVE_ROLES 白名单，回退到 DOM 可见文本定位。
  try {
    const byText = await resolveTextTarget(session, target);
    return { ...byText, matchedBy: 'dom-text' };
  } catch (e) {
    // 只有真实缺席（TextTargetError.notFound）才归 TargetNotFoundError（保留诊断文本 + AX 清单）；
    // 歧义（notFound=false）与协议/读取错误原样抛出，不当“元素没了”
    if (e instanceof TextTargetError && e.notFound) {
      throw new TargetNotFoundError(
        `${e.message}\nAX 树可交互元素: ${snapshot.elements
          .map((el) => `${el.index}:${el.role}:${el.name}`)
          .slice(0, 20)
          .join(' | ')}`,
      );
    }
    throw e;
  }
}

/**
 * CSS selector 逃生口：ARIA 语义缺失的自定义控件用这个转成 backendNodeId。
 *
 * 命中多个时取第一个（同 querySelector），但把命中数带回去 —— 像
 * `.menu-item:first-child` 这种写法会同时命中侧边导航和弹层，
 * 静默取第一个就是点错对象还以为成功。
 */
export async function resolveSelector(session: CdpSession, selector: string): Promise<ResolvedTarget> {
  const { root } = await session.send<{ root: { nodeId: number } }>('DOM.getDocument', { depth: -1 });
  const { nodeIds } = await session.send<{ nodeIds?: number[] }>('DOM.querySelectorAll', {
    nodeId: root.nodeId,
    selector,
  });
  // 只有合法数组且空集才是真实缺席；协议缺/非法字段是读取失败，不当“选择器未命中”
  if (!Array.isArray(nodeIds)) {
    throw new CdpReadError(`DOM.querySelectorAll 未返回合法 nodeIds（协议字段缺失/非法: ${JSON.stringify(nodeIds)}）`);
  }
  if (nodeIds.length === 0) throw new TargetNotFoundError(`选择器未命中任何节点: ${selector}`);
  const { node } = await session.send<{ node: { backendNodeId: number; nodeName: string } }>('DOM.describeNode', {
    nodeId: nodeIds[0],
  });
  return {
    backendNodeId: node.backendNodeId,
    role: node.nodeName.toLowerCase(),
    name: selector,
    ...(nodeIds.length > 1 ? { matches: nodeIds.length } : {}),
  };
}

/** 在目标节点上调一段页面函数，把异常原文向上抛 */
export async function callOnNode<T = unknown>(
  session: CdpSession,
  backendNodeId: number,
  functionDeclaration: string,
  args: unknown[] = [],
  userGesture: boolean = false,
): Promise<T> {
  const { object } = await session.send<{ object: { objectId: string } }>('DOM.resolveNode', { backendNodeId });
  try {
    const res = await session.send<{
    result: { value?: T };
    exceptionDetails?: { text: string; exception?: { description?: string } };
  }>('Runtime.callFunctionOn', {
    objectId: object.objectId,
    functionDeclaration,
    arguments: args.map((value) => ({ value })),
    returnByValue: true,
    userGesture,
  });

    if (res.exceptionDetails) {
      const desc = res.exceptionDetails.exception?.description || res.exceptionDetails.text;
      throw new Error(desc.split('\n')[0].replace(/^Error:\s*/, ''));
    }
    return res.result.value as T;
  } finally {
    await session.send('Runtime.releaseObject', { objectId: object.objectId }).catch(() => undefined);
  }
}

/**
 * 禁用态检查。坐标点击对禁用元素是静默空转 —— 事件照常派发、组件不响应，
 * 调用方只会收到一句「clicked xxx」，把「点了没生效」误读成组件坏了。
 * 判据是 HTML/ARIA 语义（disabled 属性、aria-disabled），不认组件库 class。
 */
async function assertEnabled(session: CdpSession, backendNodeId: number): Promise<void> {
  const reason = await callOnNode<string | null>(session, backendNodeId, OPTION_DISABLED_REASON_FN);
  if (reason) throw new Error(`NOT_INTERACTABLE: 元素处于禁用态（${reason}），点击不会生效`);
}

interface DomNodeDescription {
  backendNodeId: number;
  pseudoType?: string;
  children?: DomNodeDescription[];
  shadowRoots?: DomNodeDescription[];
  pseudoElements?: DomNodeDescription[];
}

async function resolveClickPoint(
  session: CdpSession,
  backendNodeId: number,
): Promise<{ x: number; y: number }> {
  await assertEnabled(session, backendNodeId);
  await session.send('DOM.scrollIntoViewIfNeeded', { backendNodeId });
  const content = await session.send<{ quads: number[][] }>('DOM.getContentQuads', { backendNodeId });
  if (!content?.quads || content.quads.length === 0) {
    throw new Error('NOT_INTERACTABLE: 元素没有有效布局盒子，拒绝指针点击');
  }
  let point: { x: number; y: number } | undefined;
  for (const quad of content.quads) {
    if (quad.length !== 8 || quad.some((value) => !Number.isFinite(value))) continue;
    const area = Math.abs(
      (quad[0] * quad[3] - quad[2] * quad[1]) +
      (quad[2] * quad[5] - quad[4] * quad[3]) +
      (quad[4] * quad[7] - quad[6] * quad[5]) +
      (quad[6] * quad[1] - quad[0] * quad[7])
    ) / 2;
    if (area > 0.99) {
      point = {
        x: (quad[0] + quad[2] + quad[4] + quad[6]) / 4,
        y: (quad[1] + quad[3] + quad[5] + quad[7]) / 4,
      };
      break;
    }
  }
  if (!point) {
    throw new Error('NOT_INTERACTABLE: 所有布局盒子面积 ≤ 0.99，拒绝指针点击');
  }
  // A1: 点击命中验证
  // frame-view 只对 Runtime/AX/Document 限定 frame，DOM 命令透传主 target。
  // getContentQuads 返回主 viewport 坐标，不能在 iframe document 调 elementFromPoint（坐标错位）。
  // 改用 DOM.getNodeForLocation（主 target）拿真实命中 backend，再用 DOM 引用比对。
  const viewportPoint = point;
  const metrics = await session.send<{ cssVisualViewport?: { pageX?: number; pageY?: number } }>('Page.getLayoutMetrics');
  const probePoint = {
    x: viewportPoint.x + (metrics.cssVisualViewport?.pageX ?? 0),
    y: viewportPoint.y + (metrics.cssVisualViewport?.pageY ?? 0),
  };
  const hitPoint = { x: Math.round(probePoint.x), y: Math.round(probePoint.y) };
  let hit: { backendNodeId?: number };
  try {
    hit = await session.send<{ backendNodeId?: number }>('DOM.getNodeForLocation', hitPoint);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `NOT_INTERACTABLE: 点击坐标 (viewport=${viewportPoint.x},${viewportPoint.y}; page=${probePoint.x},${probePoint.y}) 命中探测失败: ${reason}`,
    );
  }
  if (!hit.backendNodeId) {
    throw new Error(
      `NOT_INTERACTABLE: 点击坐标 (viewport=${viewportPoint.x},${viewportPoint.y}; page=${probePoint.x},${probePoint.y}) 未命中任何元素`,
    );
  }
  // 命中 backend 可能与目标相同（直接命中），也可能是目标的子节点/shadow 宿主
  if (hit.backendNodeId !== backendNodeId) {
    const hitBackendNodeId = hit.backendNodeId;
    const { node: hitDescription } = await session.send<{ node: DomNodeDescription }>('DOM.describeNode', {
      backendNodeId: hitBackendNodeId,
    });
    let isLegit = false;
    if (hitDescription.pseudoType) {
      // 伪元素是 CDP protocol node，不能传给 contains/ShadowRoot 逻辑；只沿目标已限定子树证明归属，不跨 document 扩大原有范围。
      const { node } = await session.send<{ node: DomNodeDescription }>('DOM.describeNode', {
        backendNodeId,
        depth: -1,
        pierce: true,
      });
      const stack = [node];
      for (let index = 0; index < stack.length; index++) {
        const current = stack[index];
        if (current.backendNodeId === hitBackendNodeId && current.pseudoType) {
          isLegit = true;
          break;
        }
        for (const child of current.children ?? []) stack.push(child);
        for (const shadowRoot of current.shadowRoots ?? []) stack.push(shadowRoot);
        for (const pseudoElement of current.pseudoElements ?? []) stack.push(pseudoElement);
      }
    } else {
      // 拿两个 DOM 引用做 contains/shadow 检查
      const hitResolve = await session.send<{ object: { objectId: string } }>(
        'DOM.resolveNode',
        { backendNodeId: hitBackendNodeId },
      );
      if (!hitResolve.object.objectId) {
        throw new Error(`无法解析命中节点 DOM 引用（target=${backendNodeId}, hit=${hitBackendNodeId}）`);
      }
      try {
        isLegit = await callOnNodeArgs<boolean>(session, backendNodeId, `function (hitObj) {
          for (let node = hitObj; node;) {
            if (node === this || this.contains(node)) return true;
            const root = node.getRootNode();
            node = node.parentElement || (root instanceof ShadowRoot ? root.host : null);
          }
          return false;
        }`, [{ objectId: hitResolve.object.objectId }]);
      } finally {
        await releaseRemote(session, [hitResolve.object.objectId]);
      }
    }
    if (!isLegit) {
      throw new Error(`NOT_INTERACTABLE: 点击命中非目标元素：坐标 (${probePoint.x}, ${probePoint.y}) 命中 backend=${hitBackendNodeId}，目标 backend=${backendNodeId}`);
    }
  }
  await assertEnabled(session, backendNodeId);
  return viewportPoint;
}

export async function clickNode(
  session: CdpSession,
  backendNodeId: number,
  options?: { clicks?: 1 | 2 },
): Promise<void> {
  const clicks = options?.clicks ?? 1;
  let viewportPoint = await resolveClickPoint(session, backendNodeId);
  for (let clickCount = 1; clickCount <= clicks; clickCount++) {
    if (clickCount > 1) viewportPoint = await resolveClickPoint(session, backendNodeId);
    await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...viewportPoint, button: 'left', buttons: 1, clickCount });
    await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...viewportPoint, button: 'left', buttons: 0, clickCount });
  }
}

import {
  SELECT_NATIVE_COMMIT_FN, APPLY_NATIVE_COMMIT_FN,
  READ_SELECT_ROOT_STATE_FN, RESOLVE_OPTION_POOLS_FN, IS_DIRECT_CATEGORY_CHILD_FN,
  OPTION_DISABLED_REASON_FN, IS_ELEMENT_VISIBLE_FN, FILTER_PREFLIGHT_GUARD_FN,
  readOptionState, readKeyboardContext, resolveOptionPools, selectionVerification,
  reachKeyboardSelection,
  chooseOptionIndex, matchModeOf, OPTION_ROLES,
  type AxOptionCandidate, type OptionState, type KeyboardSnapshot, type SelectRootState,
} from '../shared/selection.js';
import type { ResolvedTargetInfo, SelectionFact, SelectionPick, RecordInputCallback, InputCommitEvidence, InputCommit } from '../shared/types.js';
import { RESOLVE_WRITE_TARGET_FN, PREPARE_WRITE_TARGET_FN, ASSERT_WRITE_READY_FN, WRITE_NATIVE_VALUE_FN, READ_WRITE_TARGET_FN, type WriteInput } from '../shared/dom-actions.js';

/** 固定实际叶后立即登记；writer 不提前宣称提交，wait/dialog 后由 step 验值。 */
export async function writeInputNode(
  session: CdpSession,
  backendNodeId: number,
  input: WriteInput,
  recordInput: RecordInputCallback,
): Promise<string> {
  const { object } = await session.send<{ object: { objectId?: string } }>('DOM.resolveNode', { backendNodeId });
  if (!object.objectId) throw new CdpReadError('DOM.resolveNode 未返回写入目标 objectId');
  const wrapperObjectId = object.objectId;
  let leafObjectId: string | undefined;
  let registered = false;
  try {
    const resolved = await session.send<{
      result: { objectId?: string };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    }>('Runtime.callFunctionOn', { objectId: wrapperObjectId, functionDeclaration: RESOLVE_WRITE_TARGET_FN, returnByValue: false });
    if (resolved.exceptionDetails) {
      const message = resolved.exceptionDetails.exception?.description || resolved.exceptionDetails.text;
      throw new Error(message.split('\n')[0].replace(/^Error:\s*/, ''));
    }
    if (!resolved.result.objectId) throw new CdpReadError('resolveWriteTarget 未返回实际叶 objectId');
    leafObjectId = resolved.result.objectId;
    const fixedLeafId = leafObjectId;
    const expected = input.value;
    let backend: InputCommitEvidence['backend'] = input.mode === 'type' ? 'dispatchKeyEvent' : 'insertText';
    const callLeaf = async <T>(functionDeclaration: string, args: unknown[] = []): Promise<T> => {
      const response = await session.send<{
        result: { value?: T };
        exceptionDetails?: { text: string; exception?: { description?: string } };
      }>('Runtime.callFunctionOn', {
        objectId: fixedLeafId,
        functionDeclaration,
        arguments: args.map((value) => ({ value })),
        returnByValue: true,
      });
      if (response.exceptionDetails) {
        const message = response.exceptionDetails.exception?.description || response.exceptionDetails.text;
        throw new Error(message.split('\n')[0].replace(/^Error:\s*/, ''));
      }
      return response.result.value as T;
    };
    const { node } = await session.send<{ node: { backendNodeId?: number } }>('DOM.describeNode', { objectId: fixedLeafId });
    if (typeof node.backendNodeId !== 'number' || !Number.isInteger(node.backendNodeId) || node.backendNodeId <= 0) throw new CdpReadError('DOM.describeNode 未返回实际叶 backendNodeId');
    const leafBackendNodeId = node.backendNodeId;
    recordInput({
      verify: async () => {
        const target = { backend_node_id: leafBackendNodeId };
        let actual: unknown;
        try {
          actual = await callLeaf<unknown>(READ_WRITE_TARGET_FN);
        } catch (error) {
          if (error instanceof Error && error.message.startsWith('FILL_NOT_COMMITTED:')) {
            throw Object.assign(new Error('FILL_NOT_COMMITTED: ' + JSON.stringify({ expected, target, actual_unavailable: true, reason: 'detached' })), { expected, target, actual_unavailable: true });
          }
          throw error;
        }
        if (actual !== expected) {
          throw Object.assign(new Error('FILL_NOT_COMMITTED: ' + JSON.stringify({ expected, actual, target })), { expected, actual, target });
        }
        return { target, expected, actual, backend };
      },
      dispose: async () => { await session.send('Runtime.releaseObject', { objectId: fixedLeafId }); },
    });
    registered = true;
    const kind = await callLeaf<'text' | 'native'>(PREPARE_WRITE_TARGET_FN);
    if (kind === 'native') {
      backend = 'native';
      await callLeaf<void>(WRITE_NATIVE_VALUE_FN, [expected]);
    } else if (kind === 'text') {
      if (await callLeaf(ASSERT_WRITE_READY_FN) !== kind) throw new Error('FILL_NOT_COMMITTED: 输入前原生控件类型改变');
      if (expected === '') {
        backend = 'dispatchKeyEvent';
        await pressKey(session, 'Backspace');
      } else if (input.mode === 'fill') {
        await session.send('Input.insertText', { text: expected });
      } else {
        for (const char of expected) {
          if (await callLeaf(ASSERT_WRITE_READY_FN) !== kind) throw new Error('FILL_NOT_COMMITTED: 输入期间原生控件类型改变');
          if (char === '\n') {
            await pressKey(session, 'Enter');
            continue;
          }
          const key = { key: char };
          await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key });
          await session.send('Input.dispatchKeyEvent', { type: 'char', ...key, text: char, unmodifiedText: char });
          await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
        }
      }
    } else {
      throw new CdpReadError('prepareWriteTarget 未返回合法写入类型');
    }
    return expected;
  } finally {
    if (wrapperObjectId !== leafObjectId) await session.send('Runtime.releaseObject', { objectId: wrapperObjectId }).catch(() => undefined);
    if (leafObjectId && !registered) await session.send('Runtime.releaseObject', { objectId: leafObjectId }).catch(() => undefined);
  }
}

export async function typeIntoNode(
  session: CdpSession,
  backendNodeId: number,
  text: string,
  recordInput: RecordInputCallback,
): Promise<string> {
  return writeInputNode(session, backendNodeId, { value: text, mode: 'type' }, recordInput);
}

// 控制键：不发 char，只 keyDown/keyUp；PageDown/PageUp/Home/End 触发浏览器默认滚动，
// ArrowLeft/ArrowRight 移动光标，Delete 删字符 —— 这些默认行为只有 trusted 事件才执行。
const KEYS: Record<string, { code: string; vk: number }> = {
  Enter: { code: 'Enter', vk: 13 },
  Tab: { code: 'Tab', vk: 9 },
  Escape: { code: 'Escape', vk: 27 },
  Backspace: { code: 'Backspace', vk: 8 },
  ArrowDown: { code: 'ArrowDown', vk: 40 },
  ArrowUp: { code: 'ArrowUp', vk: 38 },
  ArrowLeft: { code: 'ArrowLeft', vk: 37 },
  ArrowRight: { code: 'ArrowRight', vk: 39 },
  PageDown: { code: 'PageDown', vk: 34 },
  PageUp: { code: 'PageUp', vk: 33 },
  Home: { code: 'Home', vk: 36 },
  End: { code: 'End', vk: 35 },
  Delete: { code: 'Delete', vk: 46 },
};

/** 按键发给当前 target session 的 CDP Input 域（trusted 事件，浏览器默认行为生效）。
 *  非旧版 dispatchEvent(KeyboardEvent)——后者 isTrusted=false，不触发默认滚动/删除/焦点切换。 */
export async function pressKey(session: CdpSession, key: string): Promise<void> {
  const info = KEYS[key];
  if (!info) throw new Error(`不支持的按键 "${key}"，可用: ${Object.keys(KEYS).join(', ')}`);

  // CDP text 不适用于控制键（PageDown/Home/Arrow 等），只对可打印字符传 text。
  // Enter 走 keyDown+char+keyUp（保持原有行为）。
  const common = {
    key,
    code: info.code,
    windowsVirtualKeyCode: info.vk,
    nativeVirtualKeyCode: info.vk,
  };
  await session.send('Input.dispatchKeyEvent', { type: 'keyDown', ...common });
  // 对 Enter 模拟 char 事件（旧行为有 keypress），其他控制键不发 char。
  if (key === 'Enter') {
    await session.send('Input.dispatchKeyEvent', { type: 'char', text: '\r', ...common });
  }
  await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common });
}

/** 选择结果统一合同：{ picked: 实际选中 label; selection: 每次真实选择事实 }（选择子集，无兼容分支） */
export interface SelectionOutcome {
  picked: string[];
  selection: SelectionFact;
}

/** 选项事实 target：本次实际选项自己的真实身份（backend + 匹配来源 + 池内唯一命中事实）。
 *  不伪造全局 role 候选：custom 是当前池 AX 子树内 role+原 name exact 重查唯一（resolved_by 'ax'），
 *  native 是 DOM option.label + 公共 matcher 下标通道（resolved_by 'option-label'）；
 *  实际池作用域由 SelectionFact.scope 携带，未经验证的候选不写。 */
function pickFact(
  input: string,
  role: string,
  name: string,
  matchMode: 'exact' | 'substring',
  backendNodeId: number,
  resolvedBy: string,
  interaction: SelectionPick['interaction'],
): SelectionPick {
  const target: ResolvedTargetInfo = {
    backendNodeId,
    resolved_by: resolvedBy,
    role,
    name,
    matches: 1,
  };
  return {
    input,
    role,
    name,
    match_mode: matchMode,
    target,
    interaction,
  };
}

/** 根状态的序列化形态返回类型 */

// ── 原生提交桥（F04：写前捕获的实际 option 引用，事件后不再重查当前列表）──

/** callOnNode 的原始 CallArgument 版：支持 {objectId} 远程对象实参（DOM predicate 传真实
 *  Element 时不能用 by-value 路径把 Element 序列化成 {}） */
export async function callOnNodeArgs<T = unknown>(
  session: CdpSession,
  backendNodeId: number,
  functionDeclaration: string,
  callArgs: Array<Record<string, unknown>>,
): Promise<T> {
  const { object } = await session.send<{ object: { objectId: string } }>('DOM.resolveNode', { backendNodeId });
  try {
    const res = await session.send<{
    result: { value?: T };
    exceptionDetails?: { text: string; exception?: { description?: string } };
  }>('Runtime.callFunctionOn', {
    objectId: object.objectId,
    functionDeclaration,
    arguments: callArgs,
    returnByValue: true,
  });
    if (res.exceptionDetails) {
      const desc = res.exceptionDetails.exception?.description || res.exceptionDetails.text;
      throw new Error(desc.split('\n')[0].replace(/^Error:\s*/, ''));
    }
    return res.result.value as T;
  } finally {
    await session.send('Runtime.releaseObject', { objectId: object.objectId }).catch(() => undefined);
  }
}

/** CDP RemoteObject / PropertyDescriptor 协议形状（原生提交桥与池桥共用，严格校验） */
interface RemoteObjectLike { type?: string; subtype?: string; objectId?: string; value?: unknown }
interface PropertyDescriptorLike { name: string; value?: RemoteObjectLike }

/** 私有数组读取器（原生桥与池桥共用）：严格核 length 与索引连续性，返回实际元素 RemoteObject。
 *  读过的 objectId 记入 remote 供统一释放。 */
async function readRemoteArray(session: CdpSession, objectId: string, remote: string[]): Promise<RemoteObjectLike[]> {
  const props = await session.send<{ result?: PropertyDescriptorLike[] }>('Runtime.getProperties', { objectId });
  remote.push(objectId);
  if (!Array.isArray(props.result)) {
    throw new CdpReadError(`Runtime.getProperties 未返回合法 result（协议字段缺失/非法: ${JSON.stringify(props.result)}）`);
  }
  const length = props.result.find((p) => p.name === 'length')?.value?.value;
  if (typeof length !== 'number' || !Number.isInteger(length) || length < 0) {
    throw new CdpReadError(`远程数组 length 非法: ${JSON.stringify(length)}`);
  }
  const out: RemoteObjectLike[] = [];
  for (let i = 0; i < length; i++) {
    const item = props.result.find((p) => p.name === String(i))?.value;
    if (!item) throw new CdpReadError(`远程数组缺索引 ${i}（length=${length}）`);
    out.push(item);
  }
  return out;
}

/** 数组元素转真实 backend：DOM.describeNode({objectId})，核正整数；objectId 记入 remote */
async function remoteObjectBackend(session: CdpSession, item: RemoteObjectLike, remote: string[]): Promise<number> {
  if (!item || typeof item.objectId !== 'string') {
    throw new CdpReadError(`远程数组元素不是对象引用（${JSON.stringify(item)}），无法取得真实 backend`);
  }
  remote.push(item.objectId);
  const dn = await session.send<{ node?: { backendNodeId?: number } }>('DOM.describeNode', { objectId: item.objectId });
  if (!dn.node || typeof dn.node.backendNodeId !== 'number' || !Number.isInteger(dn.node.backendNodeId) || dn.node.backendNodeId <= 0) {
    throw new CdpReadError(`DOM.describeNode 未返回合法 backendNodeId（${JSON.stringify(dn.node)}）`);
  }
  return dn.node.backendNodeId;
}

/** 原生提交结果：实际 label 与写前捕获的实际 option backend 配对 */
export interface NativeCommit { picked: string[]; backends: number[]; alreadySelected: boolean[]; observedCount: number; }

/** 唯一原生提交桥：DOM.resolveNode → Runtime.callFunctionOn(returnByValue:false) →
 *  getProperties(result) 取 picked/nodes 数组 → getProperties 各数组按实际索引读取 →
 *  describeNode({objectId:实际 option 引用}) → 返回配对 label/backend。
 *  只认真实 null（非原生分流）；非法 RemoteObject/descriptor/数组长度/label 类型/backend
 *  正整数报 CdpReadError，不能洗成 null。exceptionDetails 保留原业务错误第一行。
 *  finally 释放本次取得的所有 RemoteObject，清理失败不覆盖动作错误。 */
export async function callNativeCommit(
  session: CdpSession,
  backendNodeId: number,
  functionDeclaration: string,
  args: unknown[],
): Promise<NativeCommit | null> {
  const remote: string[] = [];
  try {
    const { object } = await session.send<{ object: { objectId: string } }>('DOM.resolveNode', { backendNodeId });
    if (!object || typeof object.objectId !== 'string') throw new CdpReadError('DOM.resolveNode 未返回合法 objectId');
    remote.push(object.objectId);
    const res = await session.send<{
      result?: RemoteObjectLike;
      exceptionDetails?: { text: string; exception?: { description?: string } };
    }>('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration,
      arguments: args.map((value) => ({ value })),
      returnByValue: false,
    });
    if (res.exceptionDetails) {
      const desc = res.exceptionDetails.exception?.description || res.exceptionDetails.text;
      throw new Error(desc.split('\n')[0].replace(/^Error:\s*/, ''));
    }
    const robj = res.result;
    if (!robj) throw new CdpReadError('原生提交未返回 RemoteObject');
    if (robj.type === 'null' || robj.value === null) return null;
    if (typeof robj.objectId !== 'string') {
      throw new CdpReadError(`原生提交返回非对象 RemoteObject（${JSON.stringify({ type: robj.type, subtype: robj.subtype })}）`);
    }
    remote.push(robj.objectId);
    const props = await session.send<{ result?: PropertyDescriptorLike[] }>('Runtime.getProperties', { objectId: robj.objectId });
    if (!Array.isArray(props.result)) {
      throw new CdpReadError(`Runtime.getProperties 未返回合法 result（协议字段缺失/非法: ${JSON.stringify(props.result)}）`);
    }
    const pickedDesc = props.result.find((p) => p.name === 'picked')?.value;
    const nodesDesc = props.result.find((p) => p.name === 'nodes')?.value;
    const alreadyDesc = props.result.find((p) => p.name === 'alreadySelected')?.value;
    const observedCount = props.result.find((p) => p.name === 'observedCount')?.value?.value;
    if (!pickedDesc || typeof pickedDesc.objectId !== 'string' || !nodesDesc || typeof nodesDesc.objectId !== 'string' || typeof alreadyDesc?.objectId !== 'string') {
      throw new CdpReadError(`原生提交结果缺 picked/nodes/alreadySelected 数组引用（属性: ${JSON.stringify(props.result.map((p) => p.name))}）`);
    }
    if (typeof observedCount !== 'number' || !Number.isInteger(observedCount) || observedCount <= 0) {
      throw new CdpReadError('原生提交未返回真实选项库存数');
    }
    const pickedItems = await readRemoteArray(session, pickedDesc.objectId, remote);
    const nodeItems = await readRemoteArray(session, nodesDesc.objectId, remote);
    const alreadyItems = await readRemoteArray(session, alreadyDesc.objectId, remote);
    if (pickedItems.length !== nodeItems.length || alreadyItems.length !== pickedItems.length || alreadyItems.some((item) => typeof item.value !== 'boolean')) {
      throw new CdpReadError('picked/nodes/alreadySelected 数组长度或选中状态不合法');
    }
    const picked: string[] = [];
    for (const item of pickedItems) {
      if (!item || typeof item.value !== 'string') {
        throw new CdpReadError(`picked 数组元素不是 string（${JSON.stringify(item)}）`);
      }
      picked.push(item.value);
    }
    const backends: number[] = [];
    for (const item of nodeItems) backends.push(await remoteObjectBackend(session, item, remote));
    return { picked, backends, alreadySelected: alreadyItems.map((item) => item.value as boolean), observedCount };
  } finally {
    for (const objectId of remote) {
      await session.send('Runtime.releaseObject', { objectId }).catch(() => undefined);
    }
  }
}

/** CDP AX 原始节点（仅选择消费字段） */
interface RawAxNode {
  /** 真实协议形状：AX NodeId 是 string（与 page-state 现有类型一致） */
  nodeId: string;
  backendDOMNodeId?: number;
  childIds?: string[];
  role?: { value?: unknown };
  name?: { value?: unknown };
  ignored?: boolean;
  properties?: Array<{ name: string; value?: { value?: unknown } }>;
}

/** 池候选：公共 AxOptionCandidate + 点击用的 backend */
interface PoolCandidate extends AxOptionCandidate { backendNodeId: number; }

/** 池引用：scope（related=声明关联 / page=全页唯一可见 fallback）+ 实际池 backend（不要求 id） */
export interface PoolRef { scope: SelectionFact['scope']; backends: number[]; }

const POOL_WAIT_MS = 5000;

/** getFullAXTree 索引：nodeId Map（childIds 遍历）+ backendDOMNodeId Map（池根/去重） */
async function getAxIndexes(session: CdpSession): Promise<{ byId: Map<string, RawAxNode>; byBackend: Map<number, RawAxNode> }> {
  const res = await session.send<{ nodes?: RawAxNode[] }>('Accessibility.getFullAXTree');
  if (!Array.isArray(res.nodes)) {
    throw new CdpReadError(`Accessibility.getFullAXTree 未返回合法 nodes（协议字段缺失/非法: ${JSON.stringify(res.nodes)}）`);
  }
  const byId = new Map<string, RawAxNode>();
  const byBackend = new Map<number, RawAxNode>();
  for (const node of res.nodes) {
    if (!node || typeof node.nodeId !== 'string' || node.nodeId === '') continue;
    byId.set(node.nodeId, node);
    if (typeof node.backendDOMNodeId === 'number') byBackend.set(node.backendDOMNodeId, node);
  }
  return { byId, byBackend };
}

function axProp(node: RawAxNode, name: string): unknown {
  for (const p of node.properties ?? []) if (p.name === name) return p.value?.value;
  return undefined;
}

/** 池 AX 子树候选：nodeId Map 沿 childIds 完整递归（穿过 ignored 中间节点），只采未 ignored
 *  五类角色并按 backendDOMNodeId 去重；角色集合与 PW ariaSnapshotJSON 消费同源 OPTION_ROLES。 */
async function collectPoolOptions(session: CdpSession, poolBackends: number[]): Promise<PoolCandidate[]> {
  const { byId, byBackend } = await getAxIndexes(session);
  const out: PoolCandidate[] = [];
  const seen = new Set<number>();
  const walk = (node: RawAxNode): void => {
    if (node.ignored !== true) {
      const role = typeof node.role?.value === 'string' ? (node.role.value as string) : '';
      if (OPTION_ROLES.includes(role) && typeof node.backendDOMNodeId === 'number' && !seen.has(node.backendDOMNodeId)) {
        seen.add(node.backendDOMNodeId);
        out.push({
          backendNodeId: node.backendDOMNodeId,
          role,
          name: typeof node.name?.value === 'string' ? (node.name.value as string) : '',
          disabled: axProp(node, 'disabled') === true,
          selected: axProp(node, 'selected') === true,
        });
      }
    }
    for (const childId of node.childIds ?? []) {
      const child = byId.get(childId);
      if (child) walk(child);
    }
  };
  for (const backend of poolBackends) {
    const root = byBackend.get(backend);
    if (!root) {
      throw new Error(`INSUFFICIENT_EVIDENCE: 关联池（backend ${backend}）在当前 AX 树没有对应 AX 根，无法采集选项`);
    }
    walk(root);
  }
  return out;
}

// ── 池解析（F05-F09：唯一 DOM resolver，真实池元素经 describeNode 取 backend，不要求 id）──

/** resolver 的原始远程结果：scope + 实际池元素引用（category predicate scopeRoot 用）；
 *  remote 为本次取得的全部 objectId，调用方消费完必须 releaseRemote */
interface RawPools {
  scope: SelectionFact['scope'];
  poolObjects: RemoteObjectLike[];
  poolBackends: number[];
  remote: string[];
}

async function releaseRemote(session: CdpSession, remote: string[]): Promise<void> {
  for (const objectId of remote) {
    await session.send('Runtime.releaseObject', { objectId }).catch(() => undefined);
  }
}

/** 共用 resolver eval（RESOLVE_OPTION_POOLS_FN，returnByValue:false）→ scope + 实际池元素
 *  引用；协议严格校验（scope 枚举/pools 数组/backend 正整数），非法形状报 CdpReadError；
 *  resolver 明确错误（声明缺失/歧义/多池/他方 owned）按 exceptionDetails 原样传播。 */
async function resolvePoolsRaw(session: CdpSession, ownerBackend: number): Promise<RawPools> {
  const remote: string[] = [];
  try {
    const { object } = await session.send<{ object: { objectId: string } }>('DOM.resolveNode', { backendNodeId: ownerBackend });
    if (!object || typeof object.objectId !== 'string') throw new CdpReadError('DOM.resolveNode 未返回合法 objectId');
    remote.push(object.objectId);
    const res = await session.send<{
      result?: RemoteObjectLike;
      exceptionDetails?: { text: string; exception?: { description?: string } };
    }>('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: RESOLVE_OPTION_POOLS_FN,
      returnByValue: false,
    });
    if (res.exceptionDetails) {
      const desc = res.exceptionDetails.exception?.description || res.exceptionDetails.text;
      throw new Error(desc.split('\n')[0].replace(/^Error:\s*/, ''));
    }
    const robj = res.result;
    if (!robj || typeof robj.objectId !== 'string') {
      throw new CdpReadError(`resolver 未返回对象 RemoteObject（${JSON.stringify(robj)}）`);
    }
    remote.push(robj.objectId);
    const props = await session.send<{ result?: PropertyDescriptorLike[] }>('Runtime.getProperties', { objectId: robj.objectId });
    if (!Array.isArray(props.result)) {
      throw new CdpReadError(`Runtime.getProperties 未返回合法 result（协议字段缺失/非法: ${JSON.stringify(props.result)}）`);
    }
    const scope = props.result.find((p) => p.name === 'scope')?.value?.value;
    if (scope !== 'related' && scope !== 'page') {
      throw new CdpReadError(`resolver scope 非法: ${JSON.stringify(scope)}`);
    }
    const poolsDesc = props.result.find((p) => p.name === 'pools')?.value;
    if (!poolsDesc || typeof poolsDesc.objectId !== 'string') {
      throw new CdpReadError('resolver 结果缺 pools 数组引用');
    }
    const poolObjects = await readRemoteArray(session, poolsDesc.objectId, remote);
    const poolBackends: number[] = [];
    for (const item of poolObjects) poolBackends.push(await remoteObjectBackend(session, item, remote));
    return { scope, poolObjects, poolBackends, remote };
  } catch (e) {
    await releaseRemote(session, remote);
    throw e;
  }
}

/** 池解析（消费方常规形态）：resolver 返回的真实池 RemoteObject 经 describeNode 取 backend，
 *  不要求或重查 id；读取完成即释放本次句柄。 */
export async function resolvePools(session: CdpSession, ownerBackend: number): Promise<PoolRef> {
  const raw = await resolvePoolsRaw(session, ownerBackend);
  try {
    return { scope: raw.scope, backends: raw.poolBackends };
  } finally {
    await releaseRemote(session, raw.remote);
  }
}

/** 任一池真实可见（布局盒子） */
async function anyPoolVisible(session: CdpSession, pools: PoolRef): Promise<boolean> {
  for (const backend of pools.backends) {
    const visible = await callOnNode<boolean>(session, backend, IS_ELEMENT_VISIBLE_FN);
    if (visible) return true;
  }
  return false;
}

// ── custom pick（F16/F17：等待绑定本次 wanted，每轮重解析当前真实池；错误不 catch-all）──

/** parent 连接性核验 FN（this=上次实际点击的类目项） */
const PARENT_CONNECTED_FN = `function () { return this.nodeType === 1 && this.isConnected === true; }`;

/** 一轮解析结果：本层当前池 backend + category 时 predicate 的 scopeRoot 真实元素引用 */
interface RoundPools {
  scope: SelectionFact['scope'];
  poolBackends: number[];
  poolObjects: RemoteObjectLike[];
  scopeRootObjects: RemoteObjectLike[];
  release: () => Promise<void>;
}

/** category 首层：根的当前真实池；scopeRoot=各池根元素（predicate 筛本层顶层可选项） */
async function resolveFirstCategoryRound(session: CdpSession, rootBackend: number): Promise<RoundPools> {
  const raw = await resolvePoolsRaw(session, rootBackend);
  return {
    scope: raw.scope,
    poolBackends: raw.poolBackends,
    poolObjects: raw.poolObjects,
    scopeRootObjects: raw.poolObjects,
    release: () => releaseRemote(session, raw.remote),
  };
}

/** category 后续层：以上次真实点击 parent 为准。parent 脱离直接 SELECTION_TARGET_CHANGED；
 *  parent 有 aria-controls/owns 时用同一 resolver 解其声明子池（池根为下一层 scopeRoot，
 *  可到 parent 子树外）；无声明时仍从原根当前真实池取候选，scopeRoot=parent 实际元素，
 *  只接受 parent 子树里的直接下一层；不按父项旧 name 重找、不回放录制 backend。 */
async function resolveCategoryRound(session: CdpSession, rootBackend: number, parentBackend: number): Promise<RoundPools> {
  const connected = await callOnNodeArgs<boolean>(session, parentBackend, PARENT_CONNECTED_FN, []);
  if (connected !== true) {
    throw new Error('SELECTION_TARGET_CHANGED: 上次点击的类目项已脱离当前文档，拒绝在全页/同名新节点继续猜路径');
  }
  const parentState = await callOnNode<RootStateRead>(session, parentBackend, READ_SELECT_ROOT_STATE_FN);
  if (parentState && (parentState.ariaControls.length > 0 || parentState.ariaOwns.length > 0)) {
    // parent 声明子池：同一 resolver 解析（池根为 scopeRoot，可到 parent 子树外）
    const raw = await resolvePoolsRaw(session, parentBackend);
    return {
      scope: raw.scope,
      poolBackends: raw.poolBackends,
      poolObjects: raw.poolObjects,
      scopeRootObjects: raw.poolObjects,
      release: () => releaseRemote(session, raw.remote),
    };
  }
  // 无声明：原根当前真实池 + parent 实际元素作 scopeRoot（只接受 parent 子树直接下一层）
  const parentRemote: string[] = [];
  try {
    const { object } = await session.send<{ object: { objectId: string } }>('DOM.resolveNode', { backendNodeId: parentBackend });
    if (!object || typeof object.objectId !== 'string') throw new CdpReadError('DOM.resolveNode 未返回合法 objectId');
    parentRemote.push(object.objectId);
    const pools = await resolvePoolsRaw(session, rootBackend);
    return {
      scope: pools.scope,
      poolBackends: pools.poolBackends,
      poolObjects: pools.poolObjects,
      scopeRootObjects: [{ objectId: object.objectId }],
      release: () => releaseRemote(session, [...parentRemote, ...pools.remote]),
    };
  } catch (e) {
    await releaseRemote(session, parentRemote);
    throw e;
  }
}

/** 本轮候选：当前池 AX 候选 + category 时真实 DOM 层级 predicate 筛本层（scopeRoot 用真实
 *  远程 Element 实参、roles by-value，不走 callOnNode 的 by-value 路径把 Element 序列化成 {}） */
async function collectRoundCandidates(
  session: CdpSession,
  round: RoundPools,
  category: boolean,
): Promise<PoolCandidate[]> {
  const candidates = await collectPoolOptions(session, round.poolBackends);
  if (!category || round.scopeRootObjects.length === 0) return candidates;
  const out: PoolCandidate[] = [];
  for (const c of candidates) {
    for (const scopeRoot of round.scopeRootObjects) {
      const direct = await callOnNodeArgs<boolean>(session, c.backendNodeId, IS_DIRECT_CATEGORY_CHILD_FN, [
        { objectId: scopeRoot.objectId },
        { value: OPTION_ROLES },
      ]);
      if (direct === true) {
        out.push(c);
        break;
      }
    }
  }
  return out;
}

const READ_SELECTION_NODE_FN = nativeDOMFunction(`
  const state = (${readOptionState.toString()})(this);
  return { ...state, role: getAriaRole(this) || '', name: getElementAccessibleNameText(this, true) };
`);

const READ_KEYBOARD_SNAPSHOT_FN = nativeDOMFunction(`
  const context = (${readKeyboardContext.toString()})(this, arguments[0], (${resolveOptionPools.toString()}), (${readOptionState.toString()}), ${JSON.stringify(OPTION_ROLES)});
  const scopeRoot = arguments[1];
  return { active_id: context.active_id, options: context.options.map(option => {
    const element = this.ownerDocument.querySelector('#' + this.ownerDocument.defaultView.CSS.escape(option.id));
    return { ...option, role: getAriaRole(element) || '', name: getElementAccessibleNameText(element, true),
      eligible: !scopeRoot || (${IS_DIRECT_CATEGORY_CHILD_FN}).call(element, scopeRoot, ${JSON.stringify(OPTION_ROLES)}) };
  }) };
`);

type SelectionNodeState = OptionState & { name: string };

async function readSelectionNode(session: CdpSession, backend: number): Promise<SelectionNodeState> {
  return callOnNode<SelectionNodeState>(session, backend, READ_SELECTION_NODE_FN);
}

/** 原标准 id 定位，返回真实节点 backend；不按名称换一个替身。 */
async function optionBackendById(session: CdpSession, rootBackend: number, id: string): Promise<number | undefined> {
  const remote: string[] = [];
  try {
    const { object } = await session.send<{ object: { objectId: string } }>('DOM.resolveNode', { backendNodeId: rootBackend });
    remote.push(object.objectId);
    const result = await session.send<{ result: RemoteObjectLike; exceptionDetails?: { text: string; exception?: { description?: string } } }>('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: `function (id) {
        const hits = this.ownerDocument.querySelectorAll('#' + this.ownerDocument.defaultView.CSS.escape(id));
        if (hits.length > 1) throw new Error('INSUFFICIENT_EVIDENCE: 原标准 id 当前不唯一');
        if (hits.length === 0) return null;
        const pools = (${resolveOptionPools.toString()})(this);
        return pools.pools.some(pool => pool.contains(hits[0])) ? hits[0] : null;
      }`,
      arguments: [{ value: id }], returnByValue: false,
    });
    if (result.exceptionDetails) throw new Error((result.exceptionDetails.exception?.description || result.exceptionDetails.text).split('\n')[0].replace(/^Error:\s*/, ''));
    if (result.result.value === null || result.result.subtype === 'null') return undefined;
    return await remoteObjectBackend(session, result.result, remote);
  } finally {
    await releaseRemote(session, remote);
  }
}

async function keyboardReader(session: CdpSession, rootBackend: number, round: RoundPools, category: boolean): Promise<() => Promise<KeyboardSnapshot>> {
  const initial = await callOnNode<RootStateRead>(session, rootBackend, READ_SELECT_ROOT_STATE_FN);
  return async () => {
    const current = await callOnNode<RootStateRead>(session, rootBackend, READ_SELECT_ROOT_STATE_FN);
    if (!current?.connected || current.role !== initial?.role || JSON.stringify([current.ariaControls, current.ariaOwns]) !== JSON.stringify([initial?.ariaControls, initial?.ariaOwns])) {
      throw new Error('INSUFFICIENT_EVIDENCE: 键盘遍历中原根身份或声明关系变化');
    }
    return callOnNodeArgs<KeyboardSnapshot>(session, rootBackend, READ_KEYBOARD_SNAPSHOT_FN, [
      { objectId: round.poolObjects[0].objectId },
      category ? { objectId: round.scopeRootObjects[0].objectId } : { value: null },
    ]);
  };
}

const HAS_CHILD_POOL_FN = `function () {
  const roles = ${JSON.stringify(OPTION_ROLES)};
  const direct = (${IS_DIRECT_CATEGORY_CHILD_FN});
  const visible = (${IS_ELEMENT_VISIBLE_FN});
  const declared = ['aria-controls', 'aria-owns'].some(attr => (this.getAttribute(attr) || '').trim());
  let scopes = [this];
  if (declared) {
    try { scopes = (${resolveOptionPools.toString()})(this).pools; }
    catch (error) { if (error.message.startsWith('OPTION_POOL_DECLARED_MISSING')) return false; throw error; }
  }
  return scopes.some(scope => Array.from(scope.querySelectorAll(roles.map(role => '[role="' + role + '"]').join(','))).some(option =>
    direct.call(option, scope, roles) && visible.call(option)));
}`;

async function verifyCustomSelection(
  session: CdpSession,
  rootBackend: number,
  hit: { backendNodeId: number; role: string; name: string; id: string },
  intermediate: boolean,
  deadline: number,
): Promise<SelectionPick['interaction']['verification']> {
  let verifyBackend = hit.backendNodeId;
  let reopened = false;
  let failed = false;
  let verification: ReturnType<typeof selectionVerification>;
  try {
    for (;;) {
      let state: SelectionNodeState | undefined;
      try { state = await readSelectionNode(session, verifyBackend); }
      catch (error) {
        if (!/Could not find node|No node with given id/.test((error as Error).message)) throw error;
      }
      if (state?.connected) {
        if (state.role !== hit.role || state.name !== hit.name || state.id !== hit.id) throw new Error('SELECTION_TARGET_CHANGED: 提交后原选项 id、角色或完整名称变化');
        verification = selectionVerification(state, intermediate, false);
        if (verification?.result !== true && intermediate) verification = selectionVerification(state, true, await callOnNode<boolean>(session, verifyBackend, HAS_CHILD_POOL_FN));
        if (verification?.result === true) return { method: verification.method, result: true };
      }
      const root = await callOnNode<RootStateRead>(session, rootBackend, READ_SELECT_ROOT_STATE_FN);
      if (!root?.connected) throw new Error('SELECTION_TARGET_CHANGED: 提交后原选择根被替换');
      if (!reopened && root.role === 'combobox' && root.ariaExpanded === false && hit.id) {
        reopened = true;
        await session.send('DOM.focus', { backendNodeId: rootBackend });
        const focused = await callOnNode<RootStateRead>(session, rootBackend, READ_SELECT_ROOT_STATE_FN);
        if (focused?.ariaExpanded !== true) await pressKey(session, 'ArrowDown');
        const pools = await resolveFirstCategoryRound(session, rootBackend);
        try {
          let backend = await optionBackendById(session, rootBackend, hit.id);
          if (backend === undefined && pools.scope === 'related' && pools.poolObjects.length === 1) {
            const read = await keyboardReader(session, rootBackend, pools, false);
            let reached: Awaited<ReturnType<typeof reachKeyboardSelection>>;
            try { reached = await reachKeyboardSelection(hit.name, read, key => pressKey(session, key), deadline); }
            catch (error) {
              if (/OPTION_NOT_FOUND|NOT_INTERACTABLE/.test((error as Error).message)) throw new Error('INSUFFICIENT_EVIDENCE: 重开后无法观察原选项提交状态', { cause: error });
              throw error;
            }
            if (reached.id !== hit.id || reached.role !== hit.role || reached.name !== hit.name) throw new Error('SELECTION_TARGET_CHANGED: 重开验证未能确认原标准 id');
            backend = await optionBackendById(session, rootBackend, hit.id);
          }
          if (backend !== undefined) verifyBackend = backend;
        } finally { await pools.release(); }
      }
      if (Date.now() >= deadline) {
        const prefix = verification?.result === false ? 'SELECTION_NOT_COMMITTED' : 'INSUFFICIENT_EVIDENCE';
        throw new Error(prefix + ': 选择后未观察到原选项的标准 selected/checked' + (intermediate ? '/expanded/下一层连接' : '') + ' 事实');
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  } catch (error) { failed = true; throw error; }
  finally {
    if (reopened) {
      try {
        await session.send('DOM.focus', { backendNodeId: rootBackend });
        await pressKey(session, 'Escape');
        const restored = await callOnNode<RootStateRead>(session, rootBackend, READ_SELECT_ROOT_STATE_FN);
        if (restored?.ariaExpanded !== false) throw new Error('INSUFFICIENT_EVIDENCE: 重开验证后未能恢复原关闭状态');
      } catch (error) { if (!failed) throw error; console.error('❌ 选择验证状态恢复:', error); }
    }
  }
}

/** 每项仅在标准提交验证通过后返回；键盘先证明可达全集，指针保留实际 AX 项。 */
export async function pickCustomOption(
  session: CdpSession,
  rootBackend: number,
  wanted: string,
  category: boolean,
  parentBackend: number | undefined,
  intermediate: boolean,
): Promise<{ name: string; fact: SelectionPick }> {
  const deadline = Date.now() + POOL_WAIT_MS;
  for (;;) {
    const round = category && parentBackend !== undefined
      ? await resolveCategoryRound(session, rootBackend, parentBackend)
      : await resolveFirstCategoryRound(session, rootBackend);
    let keyboardPools: RawPools | undefined;
    try {
      const root = await callOnNode<RootStateRead>(session, rootBackend, READ_SELECT_ROOT_STATE_FN);
      if (!root?.connected || root.disabled) throw new Error('NOT_INTERACTABLE: 原选择根已禁用或脱离文档');
      let hit: PoolCandidate | undefined;
      let inventoryScope: SelectionPick['interaction']['inventory_scope'] = 'dom-pool';
      let observedCount = 0;
      let activeId: string | undefined;
      let readKeyboard: (() => Promise<KeyboardSnapshot>) | undefined;
      if (root.activeDescendantId && round.scope === 'related' && round.poolObjects.length === 1) {
        const rootPools = await resolvePoolsRaw(session, rootBackend);
        keyboardPools = rootPools;
        const containsLayer = rootPools.scope === 'related' && rootPools.poolObjects.length === 1
          && await callOnNodeArgs<boolean>(session, rootPools.poolBackends[0], 'function (layer) { return this === layer || this.contains(layer); }', [{ objectId: round.poolObjects[0].objectId }]);
        if (containsLayer) {
          await session.send('DOM.focus', { backendNodeId: rootBackend });
          readKeyboard = await keyboardReader(session, rootBackend, { ...round, poolBackends: rootPools.poolBackends, poolObjects: rootPools.poolObjects }, category);
          const reached = await reachKeyboardSelection(wanted, readKeyboard, key => pressKey(session, key), deadline);
          const backend = await optionBackendById(session, rootBackend, reached.id);
          if (backend === undefined) throw new Error('SELECTION_TARGET_CHANGED: 导航后原标准 id 已缺席');
          const current = await readSelectionNode(session, backend);
          if (current.id !== reached.id || current.role !== reached.role || current.name !== reached.name) throw new Error('SELECTION_TARGET_CHANGED: 导航后原选项语义变化');
          hit = { backendNodeId: backend, role: current.role, name: current.name, disabled: false, selected: current.selected === true || current.checked === true };
          inventoryScope = 'keyboard-reachable';
          observedCount = reached.observed_count;
          activeId = reached.id;
        }
      }
      if (inventoryScope === 'dom-pool') {
        const candidates = await collectRoundCandidates(session, round, category);
        let index: number;
        try {
          index = chooseOptionIndex(candidates.map((c) => c.name), wanted);
        } catch (e) {
          const msg = (e as Error).message;
          if (msg.startsWith('OPTION_NOT_FOUND') && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 250));
            continue;
          }
          throw e;
        }
        hit = candidates[index];
        observedCount = candidates.length;
        const fresh = await collectRoundCandidates(session, round, category);
        const exact = fresh.filter((candidate) => candidate.role === hit!.role && candidate.name === hit!.name);
        if (exact.length !== 1) throw new Error(`OPTION_AMBIGUOUS: 点击前同池 role+原 name 重查命中 ${exact.length} 个节点`);
        if (exact[0].backendNodeId !== hit.backendNodeId) throw new Error('SELECTION_TARGET_CHANGED: 匹配项在点击前被同名节点替换');
      }
      if (!hit) throw new Error('INSUFFICIENT_EVIDENCE: 匹配后未取得实际语义项');
      const actual = await readSelectionNode(session, hit.backendNodeId);
      if (!actual.connected || actual.role !== hit.role || actual.name !== hit.name) throw new Error('SELECTION_TARGET_CHANGED: 提交前原选项角色或完整名称变化');
      const disabled = await callOnNode<string | null>(session, hit.backendNodeId, OPTION_DISABLED_REASON_FN);
      if (hit.disabled || disabled) throw new Error(`NOT_INTERACTABLE: 选项 "${wanted}" 处于禁用态（${disabled || 'AX disabled'}）`);
      const visible = await callOnNode<boolean>(session, hit.backendNodeId, IS_ELEMENT_VISIBLE_FN);
      const mode = visible ? 'pointer' : 'keyboard';
      if (!visible && inventoryScope !== 'keyboard-reachable') throw new Error('NOT_INTERACTABLE: 零布局语义项没有唯一声明根与真实 active descendant 证据');
      let before = selectionVerification(actual, intermediate, false);
      if (before?.result !== true && intermediate) before = selectionVerification(actual, true, await callOnNode<boolean>(session, hit.backendNodeId, HAS_CHILD_POOL_FN));
      if (before?.result !== true) {
        if (Date.now() >= deadline) throw new Error('INSUFFICIENT_EVIDENCE: 提交前选择预算耗尽');
        const currentRound = category && parentBackend !== undefined
          ? await resolveCategoryRound(session, rootBackend, parentBackend)
          : await resolveFirstCategoryRound(session, rootBackend);
        try {
          if (JSON.stringify(currentRound.poolBackends) !== JSON.stringify(round.poolBackends)) throw new Error((readKeyboard ? 'INSUFFICIENT_EVIDENCE' : 'SELECTION_TARGET_CHANGED') + ': 提交前原池关联已变化');
        } finally { await currentRound.release(); }
        const currentRoot = await callOnNode<RootStateRead>(session, rootBackend, READ_SELECT_ROOT_STATE_FN);
        if (!currentRoot?.connected || currentRoot.disabled) throw new Error('NOT_INTERACTABLE: 提交前选择根已禁用或被替换');
        if (readKeyboard) {
          const current = await readKeyboard();
          const active = current.options.find(option => option.id === activeId);
          if (current.active_id !== actual.id || !active || active.role !== actual.role || active.name !== actual.name) throw new Error('SELECTION_TARGET_CHANGED: 提交前原 id、角色或完整名称不一致');
        }
        if (visible) await clickNode(session, hit.backendNodeId);
        else {
          await pressKey(session, 'Enter');
        }
      }
      const verification = await verifyCustomSelection(session, rootBackend, { ...hit, id: actual.id }, intermediate, deadline);
      const fact: SelectionPick = pickFact(
        wanted, hit.role, hit.name, matchModeOf(hit.name, wanted), hit.backendNodeId,
        inventoryScope === 'keyboard-reachable' ? 'aria-id' : 'ax',
        { mode, root_backend: rootBackend, target_backend: mode === 'keyboard' ? rootBackend : hit.backendNodeId,
          ...(activeId ? { active_descendant_id: activeId, active_descendant_backend: hit.backendNodeId } : {}),
          verification, already_selected: actual.selected === true || actual.checked === true,
          inventory_scope: inventoryScope, observed_count: observedCount },
      );
      return { name: hit.name, fact };
    } finally {
      if (keyboardPools) await releaseRemote(session, keyboardPools.remote);
      await round.release();
    }
  }
}

/** custom 选择的根阶段（prepare）：根状态读取 → 池解析（先解析，明确错误优先）→ 已展开判定
 *  （真实 aria-expanded=true 或关联池真实可见；无展开依据时点根一次然后重新解析；
 *  aria-expanded=true 且暂时无池只等，不反点根）→ 根已打开后可选 filter 一次性替换写入。
 *  返回真实根 scope（调用方在匹配前捕获首轮 scope）。 */
export async function prepareCustomSelection(
  session: CdpSession,
  rootBackend: number,
  filterText: string | undefined,
): Promise<PoolRef> {
  const state = await callOnNode<RootStateRead>(session, rootBackend, READ_SELECT_ROOT_STATE_FN);
  if (!state) throw new Error('选择目标不是可展开的可选控件（非 select、无选项池语义）');
  if (!state.connected || state.disabled) throw new Error('NOT_INTERACTABLE: 选择根已禁用或脱离文档');
  const deadline = Date.now() + POOL_WAIT_MS;
  // filter_text 前置 guard：在 focus/展开前核原 native input 的 password/readonly/:disabled，
  // 防止 focus handler 把 password 改 text 绕过 writer 初始 guard
  if (filterText !== undefined) {
    const guardReason = await callOnNode<string | null>(session, rootBackend, FILTER_PREFLIGHT_GUARD_FN);
    if (guardReason === 'password') throw new Error('AUTH_DATA_NOT_REPLAYABLE');
    if (guardReason === 'readonly') throw new Error('NOT_INTERACTABLE: 目标处于 readonly 状态，无法写入 filter_text');
    if (guardReason === 'disabled') throw new Error('NOT_INTERACTABLE: 目标处于 disabled 状态，无法写入 filter_text');
  }
  let attemptedExpand = false;
  const expand = async (): Promise<void> => {
    attemptedExpand = true;
    if (state.role === 'combobox') {
      await session.send('DOM.focus', { backendNodeId: rootBackend });
      await pressKey(session, 'ArrowDown');
    } else {
      await clickNode(session, rootBackend);
    }
  };
  if (state.ariaExpanded === false && !['listbox', 'tree', 'menu', 'menubar'].includes(state.role || '')) await expand();
  let pools: PoolRef;
  for (;;) {
    try {
      pools = await resolvePools(session, rootBackend);
      break;
    } catch (error) {
      if (!(error as Error).message.startsWith('OPTION_POOL_DECLARED_MISSING')) throw error;
      if (!attemptedExpand && state.role === 'combobox' && state.ariaExpanded !== true) await expand();
      else if (!attemptedExpand) throw error;
      if (Date.now() >= deadline) throw new Error((error as Error).message + ' (attempted_expand=true)');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  const expanded = state.ariaExpanded === true || await anyPoolVisible(session, pools)
    || (pools.scope === 'related' && pools.backends.length === 1 && pools.backends[0] === rootBackend);
  if (!expanded && !attemptedExpand) {
    await expand();
    pools = await resolvePools(session, rootBackend);
  }
  if (filterText !== undefined) {
    const inputs: InputCommit[] = [];
    try {
      await typeIntoNode(session, rootBackend, filterText, commit => inputs.push(commit));
      for (const input of inputs) await input.verify();
    } finally {
      for (const input of inputs) await input.dispose().catch(() => undefined);
    }
  }
  return pools;
}

/**
 * 下拉选择：原生单选走原子提交桥（同一同步 DOM 调用内匹配/guard/写入/input+change 并写前
 * 捕获实际命中 option 引用）；custom 走 prepare → pick。返回 { picked; selection }，无兼容分支。
 */
export async function selectOption(
  session: CdpSession,
  backendNodeId: number,
  optionName: string,
  filterText?: string,
): Promise<SelectionOutcome> {
  // 原生 <select>：原子提交内核返回该次实际 label/backend 配对（F04：不写后重查当前列表）
  const native = await callNativeCommit(session, backendNodeId, SELECT_NATIVE_COMMIT_FN, [optionName]);
  if (native !== null) {
    const [label] = native.picked;
    const [backend] = native.backends;
    return {
      picked: native.picked,
      selection: {
        scope: 'related',
        picks: [pickFact(optionName, 'option', label, matchModeOf(label, optionName), backend, 'option-label', {
          mode: 'native', root_backend: backendNodeId, target_backend: backendNodeId,
          verification: { method: 'native-selected', result: true }, already_selected: native.alreadySelected[0],
          inventory_scope: 'native-options', observed_count: native.observedCount,
        })],
      },
    };
  }
  // custom：prepare（根状态/池解析/展开/filter）→ pick(category=false, parent=undefined)
  const pools = await prepareCustomSelection(session, backendNodeId, filterText);
  const pick = await pickCustomOption(session, backendNodeId, optionName, false, undefined, false);
  return { picked: [pick.name], selection: { scope: pools.scope, picks: [pick.fact] } };
}

async function poll<T>(fn: () => Promise<T | null>, timeoutMs: number): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

/**
 * 等待导航真正落地。
 *
 * 不能直接复用 waitForCondition(idle)：新建 tab 时 Chrome 先渲染 about:blank，
 * 其 readyState 已经是 complete，idle 会在目标页面加载之前就返回（实测 ~174ms，
 * 快照 0 个元素）。这里先确认 URL 已切过去，再等 readyState。
 *
 * previousUrl 用于复用已有 tab 的场景：导航前页面也可能是 complete，
 * 靠 URL 变化才能判断导航是否完成；同时兼容服务端重定向（pathname 对不上时
 * 退化为“URL 变了”这个信号）。
 */
export async function waitForNavigation(
  session: CdpSession,
  targetUrl: string,
  timeoutMs: number,
  previousUrl?: string,
): Promise<boolean> {
  const target = new URL(targetUrl);
  // 导航是否已提交：观察到过 readyState != complete，或 URL 已变
  let committed = !previousUrl;

  const ok = await poll(async () => {
    const href = await session.evaluate<string>('location.href').catch(() => '');
    const ready = await session.evaluate<boolean>('document.readyState').catch(() => '');
    if (ready !== 'complete') committed = true;
    if (!href || href === 'about:blank') return null;
    if (!committed && href === previousUrl) return null;

    let reachedTarget = false;
    try {
      const cur = new URL(href);
      reachedTarget = cur.origin === target.origin && cur.pathname === target.pathname;
    } catch {
      // href 不是合法 URL（如 data:），当作未到达
    }
    // 未提交时只认 pathname 匹配，避免把旧页面误判成导航完成
    if (!reachedTarget && !committed) return null;

    return ready === 'complete' ? true : null;
  }, timeoutMs);

  return ok === true;
}

export type WaitCondition =
  | { kind: 'element'; value: string }
  | { kind: 'element_gone'; value: string }
  | { kind: 'text'; value: string }
  | { kind: 'idle' };

/**
 * 等待条件。element/element_gone 按 accessible name 在 AX 树里判定，
 * idle 判定 readyState + aria-busy。
 */
export async function waitForCondition(
  session: CdpSession,
  condition: WaitCondition,
  timeoutMs: number,
): Promise<boolean> {
  const ok = await poll(async () => {
    if (condition.kind === 'text') {
      return session
        .evaluate<boolean>(`document.body.innerText.includes(${JSON.stringify(condition.value)})`)
        .then((v) => (v ? true : null));
    }

    const state = await collectPageState(session);

    if (condition.kind === 'idle') {
      if (state.busy) return null;
      const ready = await session.evaluate<boolean>("document.readyState === 'complete'");
      return ready ? true : null;
    }

    const present = state.elements.some((e) => e.name.includes(condition.value));
    const want = condition.kind === 'element' ? present : !present;
    return want ? true : null;
  }, timeoutMs);

  return ok === true;
}

export interface ExtractResult {
  url: string;
  title: string;
  text: string;
  tables: Array<{ headers: string[]; rows: string[][] }>;
}

/**
 * 提取页面文本与表格。
 *
 * 虚拟滚动表格常把表头和表体拆成两个 <table>（header 只有 th，body 只有 td），
 * 所以按"有 th 的表"和"有 td 的表"分别收集再配对，而不是假设同表。
 */
export async function extractContent(session: CdpSession, selector?: string): Promise<ExtractResult> {
  const scope = selector ? JSON.stringify(selector) : 'null';
  return session.evaluate<ExtractResult>(`(() => {
    const scopeSel = ${scope};
    const root = scopeSel ? document.querySelector(scopeSel) : document.body;
    if (!root) throw new Error('提取范围不存在: ' + scopeSel);

    const cellText = (c) => (c.innerText || '').trim();
    const all = Array.from(root.querySelectorAll('table, [role="table"], [role="grid"]'));
    const headerGroups = [];
    const rowGroups = [];
    for (const t of all) {
      const headers = Array.from(t.querySelectorAll('th, [role="columnheader"]')).map(cellText);
      const rows = Array.from(t.querySelectorAll('tr, [role="row"]'))
        .map((r) => Array.from(r.querySelectorAll('td, [role="gridcell"], [role="cell"]')).map(cellText))
        .filter((cells) => cells.length > 0)
        .slice(0, 20);
      if (headers.length > 0) headerGroups.push(headers);
      if (rows.length > 0) rowGroups.push(rows);
    }

    const count = Math.max(headerGroups.length, rowGroups.length);
    const tables = [];
    for (let i = 0; i < Math.min(count, 5); i++) {
      tables.push({ headers: headerGroups[i] || [], rows: rowGroups[i] || [] });
    }

    return {
      url: location.href,
      title: document.title,
      text: (root.innerText || '').trim().slice(0, 8000),
      tables,
    };
  })()`);
}

export async function screenshot(session: CdpSession, fullPage: boolean): Promise<string> {
  await session.send('Page.enable');
  await holdViewport(session);
  try {
    // captureBeyondViewport 单独不保证全页（Chrome 版本差异、内容视口裁剪）。
    // full-page 时先取 layout metrics 拿完整内容尺寸，用 clip 精确裁剪整页。
    if (fullPage) {
      const metrics = await session.send<{
        // cssContentSize 是 CSS 像素尺寸（clip 需要）；contentSize 是废弃 DP 尺寸。
        cssContentSize: { width: number; height: number };
      }>('Page.getLayoutMetrics');
      const w = Math.ceil(metrics.cssContentSize.width);
      const h = Math.ceil(metrics.cssContentSize.height);
      const res = await session.send<{ data: string }>('Page.captureScreenshot', {
        format: 'png',
        clip: { x: 0, y: 0, width: w, height: h, scale: 1 },
        captureBeyondViewport: true,
      });
      return res.data;
    }
    const res = await session.send<{ data: string }>('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: fullPage,
    });
    return res.data;
  } finally {
    await releaseViewport(session);
  }
}

export async function navigate(session: CdpSession, url: string): Promise<void> {
  await session.send('Page.enable');
  await session.send('Page.navigate', { url });
}

export type { InteractiveElement, PageState };
type RootStateRead = SelectRootState | null;
