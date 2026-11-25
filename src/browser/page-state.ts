/**
 * Page State Snapshot（组件库无关）
 *
 * 数据源是 CDP Accessibility 域的 AX 树 —— Chrome 自己算好的 role / accessible name /
 * required / disabled 语义。不依赖任何组件库的 class name，纯标准 DOM/ARIA/原生 HTML
 * 一视同仁。操控靠 backendNodeId 定位，不靠 CSS 路径。
 */
import type { CdpSession } from './daemon-client.js';
import { nativeDOMFunction } from './locator-query.js';
import { randomUUID } from 'node:crypto';

/** ARIA role → 交互语义。只认 W3C role，组件库私有 class 一概不看。 */
export const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'listbox',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'spinbutton',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'treeitem',
]);

/**
 * 可选中的单元格（日历格子这类）。role=gridcell 不能一概收 —— 普通表格的单元格
 * 只是数据，收进来就把快照灼爆；判据走 ARIA 的 aria-selected（日历格子有、
 * 星期表头与数据表格没有），不认组件库 class。
 */
function isSelectableCell(node: AXNode, role: string): boolean {
  return role === 'gridcell' && node.properties?.some((p) => p.name === 'selected') === true;
}

/** 弹层容器 role —— 有打开的弹层时只采集弹层内部，避免背景页噪声 */
const CONTAINER_ROLES = new Set(['dialog', 'alertdialog']);

/** 通知类 role */
const STATUS_ROLES = new Set(['alert', 'status']);

/**
 * 原生 <select> 的 <option> 会出现在 AX 树里（role=option），但它们从未渲染成
 * 独立盒子 —— DOM.getBoxModel 对它们直接报 "Could not compute box model"。
 * 把它们留在快照里会误导 Host LLM 去点一个根本点不了的元素。
 *
 * 区分依据是 DOM 事实而非组件库约定：原生 select 的选项父节点是 Chrome
 * 内部 role MenuListPopup（role.type = internalRole），而自定义组件展开后的
 * 选项父节点是标准 listbox（role.type = role）。
 */
const NATIVE_SELECT_POPUP_ROLE = 'MenuListPopup';

/**
 * 无信息量的 accessible name。组件库常把 aria-label 写死成控件类型名
 * （如 aria-label="select"），此时要回退到 placeholder / title / label。
 */
const USELESS_NAMES = new Set(['select', 'input', 'button', 'combobox', 'textbox', 'checkbox', 'radio', 'switch', '']);

export interface InteractiveElement {
  index: number;
  role: string;
  name: string;
  value: string;
  required: boolean;
  disabled: boolean;
  /** combobox/tab 等可展开控件的展开态；不适用时省略 */
  expanded?: boolean;
  checked?: boolean;
  /** 操控句柄 —— 直接喂给 DOM.resolveNode / DOM.getBoxModel */
  backendNodeId: number;
  /** 选项类控件(radio/checkbox)所属字段名 —— name 是选项文本，fieldLabel 是字段 label */
  fieldLabel?: string;
  /** 录制时全树唯一的真实 AX role/name（回放身份事实，与回退后的显示 name 无关）；
   *  name 保存 raw AX 字符串（含零宽字符），不存展示 axString 结果（R1/LC3：
   *  axString 会把零宽改空格，PW exact 自身的 normalizeWhiteSpace 是删除语义） */
  roleLocator?: { role: string; name: string };
}

export interface FrameDesc {
  /** iframe 元素的 name 属性 */
  name: string;
  /** iframe src 的 pathname（可跨会话重放） */
  url_contains: string;
  /** iframe 的 CSS 选择器（id 或 name 属性推导） */
  selector: string;
}

/** AX 诊断条目（仅 --debug-ax 启用时产出）：保留同一次 getFullAXTree 的节点身份、
 *  已有 probe 结果与实际过滤理由。不含 AX value，不泄露密码，不伪造未 probe 的布局。 */
export interface DebugAxEntry {
  node_id: string;
  parent_id?: string;
  role?: string;
  role_type?: string;
  ignored: boolean;
  backend_node_id?: number;
  parent_role?: string;
  related_nodes?: Array<{ node_id?: string; backend_node_id?: number; role?: string; source: 'controls' | 'owns' | 'activedescendant' | 'parent' }>;
  probe?: BackendProbe;
  excluded_by?: 'ignored' | 'scope' | 'role' | 'native-popup' | 'no-backend' | 'gone' | 'not-visible' | 'accepted' | 'limit';
}

/** 真实 backend 探测结果：用 DOM 连接/布局事实判定存在性，不靠过滤快照推断。
 *  - gone   : backend 失效或节点已脱离 DOM（isConnected=false）→ 正常消失
 *  - present: 仍连接 DOM；visible 由布局盒子决定；role/name 取该 backend 真实局部 AX（缺则 undefined，不造假）
 *  必须在 collectPageState 之后调用（AX 已 enable）。非消失型 CDP 失败抛错，不当消失 PASS。 */
/** 真实 backend 读取失败（非节点消失型）：必须传播，不当消失/PASS。
 *  与 InvalidRefError 同为类型化传播错误，不是 daemon 错误码策略。 */
export class CdpReadError extends Error {
  readonly code = 'CDP_READ';
  constructor(message: string) { super(message); this.name = 'CdpReadError'; }
}

export type BackendProbe =
  | { state: 'gone' }
  | { state: 'present'; visible: boolean; backendNodeId: number; role?: string; name?: string };

/** 单次快照的可见性闭包 owner：独立 objectGroup，完整 PW 源只注入一次。
 *  每个节点仍现读当前 DOM；不跨快照/导航缓存。 */
function createSnapshotVisibilityProbe(session: CdpSession): {
  read(backendNodeId: number): Promise<BackendProbe>;
  dispose(): Promise<void>;
} {
  const objectGroup = 'e2et-page-state-' + randomUUID();
  let visibilityFunctionId: string | undefined;
  return {
    async read(backendNodeId) {
      let objectId: string;
      try {
        const { object } = await session.send<{ object: { objectId?: string } | null }>('DOM.resolveNode', { backendNodeId, objectGroup });
        if (typeof object?.objectId !== 'string' || object.objectId === '') {
          throw new CdpReadError('DOM.resolveNode 缺少 objectId');
        }
        objectId = object.objectId;
      } catch (e) {
        if (e instanceof CdpReadError) throw e;
        const msg = (e as Error).message;
        // 只有后端节点真的不存在才算消失；空对象/缺字段是协议读取失败
        if (/No node with given id|Could not find node|node not found/i.test(msg)) return { state: 'gone' };
        throw new CdpReadError(msg);
      }
      if (!visibilityFunctionId) {
        let init: {
          result?: { type?: string; objectId?: string };
          exceptionDetails?: { text: string; exception?: { description?: string } };
        };
        try {
          init = await session.send('Runtime.callFunctionOn', {
            objectId,
            functionDeclaration: nativeDOMFunction(
              'return function readSnapshotVisibility(element) { if (!element || !element.isConnected) return null; return { connected: true, visible: isElementVisible(element) }; }',
            ),
            returnByValue: false,
            objectGroup,
          });
        } catch (e) {
          throw new CdpReadError((e as Error).message);
        }
        if (init.exceptionDetails) {
          throw new CdpReadError(init.exceptionDetails.exception?.description || init.exceptionDetails.text);
        }
        if (init.result?.type !== 'function' || typeof init.result.objectId !== 'string' || init.result.objectId === '') {
          throw new CdpReadError('可见性闭包初始化未返回函数句柄');
        }
        visibilityFunctionId = init.result.objectId;
      }
      let probe: {
        result?: { value?: { connected?: unknown; visible?: unknown } | null };
        exceptionDetails?: { text: string; exception?: { description?: string } };
      };
      try {
        probe = await session.send('Runtime.callFunctionOn', {
          objectId: visibilityFunctionId,
          functionDeclaration: 'function(element) { return this(element); }',
          arguments: [{ objectId }],
          returnByValue: true,
          objectGroup,
        });
      } catch (e) {
        throw new CdpReadError((e as Error).message);
      }
      if (probe.exceptionDetails) {
        throw new CdpReadError(probe.exceptionDetails.exception?.description || probe.exceptionDetails.text);
      }
      const v = probe.result?.value;
      // 函数真实返回 null 才是 disconnected；undefined/形状非法都是协议读取失败
      if (v === null) return { state: 'gone' };
      if (!v || typeof v.connected !== 'boolean' || typeof v.visible !== 'boolean') {
        throw new CdpReadError('可见性闭包返回非法结果');
      }
      if (!v.connected) return { state: 'gone' };
      return { state: 'present', visible: v.visible, backendNodeId };
    },
    async dispose() {
      await session.send('Runtime.releaseObjectGroup', { objectGroup });
    },
  };
}

/** 用真实 backend 查 DOM 连接/布局可见性 + 局部 AX，不靠过滤快照推断存在。
 *  - backend 失效（节点已移除并回收）/ 节点未连接 → gone
 *  - 连接且有布局盒子 → present + visible=true（读真实局部 AX，不造假 role）
 *  - 连接但无盒子（display:none 等）→ present + visible=false
 *  - 其他 CDP 读取失败 → throw（调用方不当消失/PASS）
 *  AX 不可读只留 undefined，不当消失。 */
export async function probeBackendNode(session: CdpSession, backendNodeId: number): Promise<BackendProbe> {
  let objectId: string;
  try {
    const { object } = await session.send<{ object: { objectId: string } | null }>('DOM.resolveNode', { backendNodeId });
    if (!object?.objectId) return { state: 'gone' };
    objectId = object.objectId;
  } catch (e) {
    // backend 失效（节点已移除并回收）→ gone；其他 CDP 失败传播，不当消失
    const msg = (e as Error).message;
    if (/No node with given id|Could not find node|node not found/i.test(msg)) return { state: 'gone' };
    throw new CdpReadError(msg);
  }
  // isConnected + 布局盒子：真实 DOM 事实（与 clickNode 的 getClientRects 判据一致）。
  // callFunctionOn reject 或函数抛 exceptionDetails 都属于读取失败 → CdpReadError 传播，不当消失。
  // null/connected=false 才是函数实际确认的 disconnected → gone。
  let probe: { result: { value: { connected: boolean; visible: boolean } | null }; exceptionDetails?: { text: string; exception?: { description?: string } } };
  try {
    probe = await session.send(
      'Runtime.callFunctionOn',
      {
        objectId,
        functionDeclaration: nativeDOMFunction('if(!this||!this.isConnected) return null; return { connected:true, visible:isElementVisible(this) };'),
        returnByValue: true,
      },
    );
  } catch (e) {
    throw new CdpReadError((e as Error).message);
  }
  if (probe.exceptionDetails) {
    throw new CdpReadError(probe.exceptionDetails.exception?.description || probe.exceptionDetails.text);
  }
  const v = probe.result?.value;
  if (!v || !v.connected) return { state: 'gone' };
  // 读该 backend 真实局部 AX（不造假 role）；AX 不可读留 undefined。只取 backendDOMNodeId===请求 backend 的节点，不拿别人的 role/name。
  let role: string | undefined;
  let name: string | undefined;
  try {
    const ax = await session.send<{ nodes: AXNode[] }>('Accessibility.getPartialAXTree', { backendNodeId, fetchRelatives: false });
    const node = ax.nodes?.find((n) => !n.ignored && n.backendDOMNodeId === backendNodeId);
    if (node) { role = publicRole(node) || undefined; name = axString(node.name) || undefined; }
  } catch { /* AX 不可读不算消失 */ }
  return { state: 'present', visible: v.visible, backendNodeId, role, name };
}

/** --debug-ax 专属：补该 backend 的真实局部 AX role/name；AX 不可读只留 undefined。 */
async function withLocalAx(session: CdpSession, backendNodeId: number, probe: BackendProbe): Promise<BackendProbe> {
  if (probe.state !== 'present') return probe;
  try {
    const ax = await session.send<{ nodes: AXNode[] }>('Accessibility.getPartialAXTree', { backendNodeId, fetchRelatives: false });
    const node = ax.nodes?.find((n) => !n.ignored && n.backendDOMNodeId === backendNodeId);
    if (node) return { ...probe, role: publicRole(node) || undefined, name: axString(node.name) || undefined };
  } catch { /* AX 不可读不算消失 */ }
  return probe;
}

export interface PageState {
  url: string;
  title: string;
  busy: boolean;
  container: 'dialog' | 'page';
  container_name?: string;
  elements: InteractiveElement[];
  messages: string[];
  /** 页面内所有 iframe 的可跨会话重放描述 */
  frames: FrameDesc[];
  /** 元素超过上限被截断 —— 快照不完整，想要的控件可能不在列表里 */
  truncated?: boolean;
  /** 截断时过滤后的合格元素总数（elements.length 只是上限 150） */
  total_elements?: number;
  /** --debug-ax 启用时的诊断条目；普通调用不产出 */
  debug_ax?: DebugAxEntry[];
}

/**
 * 单次快照的元素上限。长列表弹层（几百个 checkbox 的店群/门店选择器）会吃光配额，
 * 把后面的「确定」按钮挤出快照；截断必须显式告知调用方，否则表现为「元素凭空消失」。
 */
const MAX_ELEMENTS = 150;

interface AXValue {
  type: string;
  value?: unknown;
  relatedNodes?: Array<{ backendDOMNodeId?: number }>;
}

interface AXProperty {
  name: string;
  value: AXValue;
}

interface AXNode {
  nodeId: string;
  parentId?: string;
  ignored: boolean;
  role?: AXValue;
  name?: AXValue;
  value?: AXValue;
  properties?: AXProperty[];
  childIds?: string[];
  backendDOMNodeId?: number;
}

const INTERNAL_TEXTBOX_ROLES = new Set(['Date', 'InputTime', 'DateTime']);

export function publicRole(node: AXNode): string {
  const role = axString(node.role);
  return node.role?.type === 'internalRole' && INTERNAL_TEXTBOX_ROLES.has(role) ? 'textbox' : role;
}

/** R1/LC4（T1）：absent 身份重查需要原始 AX 树节点的 raw name —— type-only 导出，
 *  不把原始 AX dump 加进 CLI 对外 PageState DTO。 */
export type { AXNode };

/** 零宽/不间断空格归一化为普通空格，再 trim。
 *  组件库 frequently 在中文字符间插 \u200B（零宽空格）或 \u00A0（不间断空格），
 *  导致 role exact 命中失败。只在这里做一次，所有 accessible name/value/message 统一消费。 */
function normalizeText(s: string): string {
  return s.replace(/[\u200B\u200C\u200D\uFEFF\u00A0]/g, ' ').trim();
}

function axString(v?: AXValue): string {
  if (!v || v.value === undefined || v.value === null) return '';
  return normalizeText(String(v.value));
}

/** raw AX 字符串（不归一化零宽/空白）：身份事实（roleLocator/唯一性统计）用 raw 值，
 *  展示值继续走 axString。 */
function axRawString(v?: AXValue): string {
  if (!v || v.value === undefined || v.value === null) return '';
  return String(v.value);
}

function propBool(node: AXNode, name: string): boolean | undefined {
  const p = node.properties?.find((x) => x.name === name);
  if (!p) return undefined;
  if (p.value.type === 'booleanOrUndefined' && p.value.value === undefined) return undefined;
  return p.value.value === true || p.value.value === 'true';
}

/** 采集 AX 树并压成带索引的可交互元素清单 */
import { normalizeAccessibleName, normalizeRoleName } from '../shared/accessible-name.js';

export async function collectPageState(session: CdpSession, options?: { debugAx?: boolean }): Promise<PageState> {
  const probe = createSnapshotVisibilityProbe(session);
  let failure: unknown;
  try {
    return await collectPageStateWithProbe(session, probe, options);
  } catch (e) {
    failure = e;
    throw e;
  } finally {
    try {
      await probe.dispose();
    } catch (e) {
      // 主错优先；成功路径的清理失败必须暴露，不能假 PASS
      if (failure === undefined) throw e;
    }
  }
}

async function collectPageStateWithProbe(
  session: CdpSession,
  probe: ReturnType<typeof createSnapshotVisibilityProbe>,
  options?: { debugAx?: boolean },
): Promise<PageState> {
  const debugAx = options?.debugAx === true;
  const debugEntries: DebugAxEntry[] = [];

  await session.send('Accessibility.enable');
  const { nodes } = await session.send<{ nodes: AXNode[] }>('Accessibility.getFullAXTree');

  const byId = new Map(nodes.map((n) => [n.nodeId, n]));

  // 真实 AX role/name 唯一性必须在 dialog 过滤/截断/显示名回退之前统计：过滤快照证明不了全页唯一
  // R1/LC3：唯一性按 raw node.name.value + normalizeRoleName（与 PW exact 同义）统计；
  // candidates 保存 raw 身份名，Playwright matcher 自身规范化后 exact 匹配
  const axPairCount = new Map<string, number>();
  for (const n of nodes) {
    if (n.ignored || n.backendDOMNodeId === undefined) continue;
    const role = publicRole(n);
    const rawName = axRawString(n.name);
    if (!role || !rawName) continue;
    const key = role + '\u0000' + normalizeRoleName(rawName);
    axPairCount.set(key, (axPairCount.get(key) ?? 0) + 1);
  }

  // debug-ax 用：backendDOMNodeId → AXNode 映射，只建一次
  const byBackend = debugAx ? new Map<number, AXNode>(
    nodes.filter(n => n.backendDOMNodeId !== undefined).map(n => [n.backendDOMNodeId!, n])
  ) : null;

  // 找最内层打开的 dialog：AX 树里 modal 弹层会带 dialog role，关闭的会被 ignored
  let containerNode: AXNode | undefined;
  for (const n of nodes) {
    if (n.ignored) continue;
    if (CONTAINER_ROLES.has(axString(n.role))) containerNode = n;
  }

  const scopeIds = containerNode ? collectSubtreeIds(containerNode, byId) : null;

  const elements: InteractiveElement[] = [];
  const needsFallback: InteractiveElement[] = [];
  const fieldLabelTargets: InteractiveElement[] = [];
  let truncated = false;
  let totalElements = 0;
  for (const node of nodes) {
    if (debugAx && node.ignored) debugEntries.push(makeDebugEntry(node, byId, byBackend!, 'ignored'));
    if (node.ignored) continue;
    if (scopeIds && !scopeIds.has(node.nodeId)) {
      if (debugAx) debugEntries.push(makeDebugEntry(node, byId, byBackend!, 'scope'));
      continue;
    }
    const role = publicRole(node);
    if (!INTERACTIVE_ROLES.has(role) && !isSelectableCell(node, role)) {
      if (debugAx) debugEntries.push(makeDebugEntry(node, byId, byBackend!, 'role'));
      continue;
    }
    if (node.backendDOMNodeId === undefined) {
      if (debugAx) debugEntries.push(makeDebugEntry(node, byId, byBackend!, 'no-backend'));
      continue;
    }
    if (role === 'option' && isNativeSelectOption(node, byId)) {
      if (debugAx) debugEntries.push(makeDebugEntry(node, byId, byBackend!, 'native-popup'));
      continue;
    }
    let visibility = await probe.read(node.backendDOMNodeId);
    if (debugAx) visibility = await withLocalAx(session, node.backendDOMNodeId, visibility);
    if (visibility.state === 'gone' || !visibility.visible) {
      if (debugAx) debugEntries.push({ ...makeDebugEntry(node, byId, byBackend!, visibility.state === 'gone' ? 'gone' : 'not-visible'), probe: visibility });
      continue;
    }
    // 截断后不再构造元素/不做 fallback，但继续用同一套过滤条件计数
    totalElements += 1;
    if (elements.length >= MAX_ELEMENTS) {
      truncated = true;
      if (debugAx) debugEntries.push({ ...makeDebugEntry(node, byId, byBackend!, 'limit'), probe: visibility });
      continue;
    }

    // 组件库普遍不写 aria-required（必填星号常是 CSS ::before），但 Chrome 会把
    // 伪元素内容计入 accessible name，于是 name 开头的 "*" 就是可用的必填信号。
    // 没这个标记，调用方分不出「必填但填不上」和「压根不用填」，会卡在非必填字段上硬磕。
    const axName = axString(node.name);
    const el: InteractiveElement = {
      index: elements.length,
      role,
      name: axName,
      value: axString(node.value),
      required: propBool(node, 'required') === true || axName.startsWith('*'),
      disabled: propBool(node, 'disabled') === true,
      backendNodeId: node.backendDOMNodeId,
    };
    const expanded = propBool(node, 'expanded');
    if (expanded !== undefined) el.expanded = expanded;
    const checked = propBool(node, 'checked');
    if (checked !== undefined) el.checked = checked;
    // 全树唯一（规范化后）且有信息量的真实 AX role/name 才记身份（回退显示名不冒充 AX 事实）；
    // roleLocator.name 保存 raw AX 字符串（零宽字符保留，PW exact 同义规范化后匹配）
    const rawName = axRawString(node.name);
    if (axName && !USELESS_NAMES.has(axName.toLowerCase()) && axPairCount.get(role + '\u0000' + normalizeRoleName(rawName)) === 1) {
      el.roleLocator = { role, name: rawName };
    }

    elements.push(el);
    if (debugAx) debugEntries.push({ ...makeDebugEntry(node, byId, byBackend!, 'accepted'), probe: visibility });
    // 日历格子的 AX name 是光秃日号（"1"），完整日期在 title 上，不回退没法用
    if (USELESS_NAMES.has(el.name.toLowerCase()) || role === 'gridcell') needsFallback.push(el);
    // 选项类控件(radio/checkbox)的 name 是选项文本，额外找字段 label 填 fieldLabel
    if (role === 'radio' || role === 'checkbox') fieldLabelTargets.push(el);
  }

  if (needsFallback.length > 0) {
    await fillNameFallbacks(session, needsFallback);
  }
  if (fieldLabelTargets.length > 0) {
    await fillFieldLabels(session, fieldLabelTargets);
  }

  const messages = await collectStatusMessages(session, nodes);

  const busy = nodes.some((n) => !n.ignored && propBool(n, 'busy') === true);

  const { url, title } = await session.evaluate<{ url: string; title: string }>(
    '({ url: location.href, title: document.title })',
  );

  // 采集页面内所有 iframe 的可跨会话重放描述
  const frames = await collectIframeDescs(session);

  return {
    url,
    title,
    busy,
    container: containerNode ? 'dialog' : 'page',
    ...(containerNode ? { container_name: axString(containerNode.name) } : {}),
    elements,
    messages,
    frames,
    ...(truncated ? { truncated: true, total_elements: totalElements } : {}),
    ...(debugAx ? { debug_ax: debugEntries } : {}),
  };
}

function makeDebugEntry(node: AXNode, byId: Map<string, AXNode>, byBackend: Map<number, AXNode>, excludedBy: DebugAxEntry['excluded_by']): DebugAxEntry {
  const role = axString(node.role) || undefined;
  const roleType = node.role?.type || undefined;
  const parent = node.parentId ? byId.get(node.parentId) : undefined;
  const parentRole = parent ? (axString(parent.role) || undefined) : undefined;
  // 标准关联根：controls/owns/activedescendant（properties[].value.relatedNodes[].backendDOMNodeId）+ 父链
  const relatedNodes: NonNullable<DebugAxEntry['related_nodes']> = [];
  if (node.properties) {
    for (const prop of node.properties) {
      if ((prop.name === 'controls' || prop.name === 'owns' || prop.name === 'activedescendant') && prop.value.relatedNodes) {
        for (const rn of prop.value.relatedNodes) {
          const rnNode = rn.backendDOMNodeId !== undefined ? byBackend.get(rn.backendDOMNodeId) : undefined;
          relatedNodes.push({
            ...(rn.backendDOMNodeId !== undefined ? { backend_node_id: rn.backendDOMNodeId } : {}),
            ...(rnNode ? { node_id: rnNode.nodeId } : {}),
            ...(rnNode ? { role: axString(rnNode.role) || undefined } : {}),
            source: prop.name as 'controls' | 'owns' | 'activedescendant',
          });
        }
      }
    }
  }
  if (parent) {
    relatedNodes.push({
      node_id: parent.nodeId,
      ...(parent.backendDOMNodeId !== undefined ? { backend_node_id: parent.backendDOMNodeId } : {}),
      role: axString(parent.role) || undefined,
      source: 'parent',
    });
  }
  return {
    node_id: node.nodeId,
    ...(node.parentId ? { parent_id: node.parentId } : {}),
    ...(role ? { role } : {}),
    ...(roleType ? { role_type: roleType } : {}),
    ignored: node.ignored,
    ...(node.backendDOMNodeId !== undefined ? { backend_node_id: node.backendDOMNodeId } : {}),
    ...(parentRole ? { parent_role: parentRole } : {}),
    ...(relatedNodes.length > 0 ? { related_nodes: relatedNodes } : {}),
    ...(excludedBy ? { excluded_by: excludedBy } : {}),
  };
}

/**
 * 补齐无信息量的 accessible name。回退链走标准 HTML 属性：
 * placeholder → title → <label for> / 祖先 label → 前置兄弟文本。
 * 用的都是 HTML/ARIA 语义，不认任何组件库的 class。
 */
async function fillNameFallbacks(session: CdpSession, targets: InteractiveElement[]): Promise<void> {
  const FALLBACK_FN = `function () {
    const el = this;
    const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim().replace(/[:：*]\\s*$/, '').slice(0, 60);
    // 祖先里可能藏着 inline <script>/<style>，其文本不是可读标签
    const readable = (node) => {
      if (!node) return '';
      const tag = node.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return '';
      return clean(node.innerText);
    };

    const NOISE = new Set(['请选择','请输入','请填写','请搜索','请输入或选择','请选择或输入','请下拉','please select','please input','please enter','please choose']);
    const isNoise = (s) => !s || NOISE.has((s || '').trim().toLowerCase());
    // placeholder 优先，但通用占位词（请选择/请输入…）无信息量，跳过继续找真 label
    const ph = clean(el.getAttribute('placeholder'));
    if (ph && !isNoise(ph)) return ph;
    const direct = clean(el.getAttribute('title') || el.getAttribute('name'));
    if (direct) return direct;

    // 容器型控件（listbox/menu 等）自身文本就是内容，优先于向上找标签
    const own = readable(el);
    if (own && !isNoise(own)) return own;

    if (el.id) {
      const forLabel = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      const t = readable(forLabel);
      if (t) return t;
    }

    // 组件库 FormItem：label 是控件兄弟（同在 .form-item 内），用 htmlFor 关联，
    // 但复合控件 input id 不一定等于 htmlFor，label[for] 命中不了；
    // 向上找祖先，取祖先直接子 <label> 文本（通用，不认组件库 class）
    for (let node = el.parentElement, depth = 0; node && depth < 3; node = node.parentElement, depth++) {
      const lbl = node.querySelector(':scope > label');
      if (lbl) { const t = readable(lbl); if (t) return t; }
    }

    const wrapping = el.closest('label');
    if (wrapping) { const t = readable(wrapping); if (t) return t; }

    // 复合控件：真正的 placeholder 常在兄弟/子节点上（同样过滤通用占位词）
    const nested = el.querySelector && el.querySelector('[placeholder]');
    if (nested) { const p = clean(nested.getAttribute('placeholder')); if (p && !isNoise(p)) return p; }

    for (let node = el.parentElement, depth = 0; node && depth < 3; node = node.parentElement, depth++) {
      const ph2 = node.querySelector('[placeholder]');
      if (ph2) { const p = clean(ph2.getAttribute('placeholder')); if (p && !isNoise(p)) return p; }
      const t = readable(node.previousElementSibling);
      if (t) return t;
    }

    return '';
  }`;

  for (const target of targets) {
    try {
      const { object } = await session.send<{ object: { objectId: string } }>('DOM.resolveNode', {
        backendNodeId: target.backendNodeId,
      });
      const res = await session.send<{ result: { value?: string } }>('Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: FALLBACK_FN,
        returnByValue: true,
      });
      const name = res.result.value;
      if (name) target.name = name;
    } catch {
      // 节点已消失或无法解析：保留原 name，不影响其余元素
    }
  }
}

/**
 * 给选项类控件(radio/checkbox)补字段 label。name 是选项文本(全国控/大区控)，
 * fieldLabel 是所属字段(总分管理归属)——走祖先直接子 <label>，跳过包裹 this 的选项 label。
 */
async function fillFieldLabels(session: CdpSession, targets: InteractiveElement[]): Promise<void> {
  const FN = `function () {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim().replace(/[:：*]\s*$/, '').slice(0, 60);
    const readable = (node) => { if (!node) return ''; const tag = node.tagName; if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return ''; return clean(node.innerText); };
    for (let node = this.parentElement, depth = 0; node && depth < 5; node = node.parentElement, depth++) {
      const lbls = node.querySelectorAll(':scope > label');
      for (const lbl of lbls) {
        if (lbl.contains(this)) continue;
        if (lbl.querySelector('input')) continue;
        const t = readable(lbl);
        if (t) return t;
      }
    }
    return '';
  }`
  for (const target of targets) {
    try {
      const { object } = await session.send<{ object: { objectId: string } }>('DOM.resolveNode', {
        backendNodeId: target.backendNodeId,
      });
      const res = await session.send<{ result: { value?: string } }>('Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: FN,
        returnByValue: true,
      });
      const fl = res.result.value;
      if (fl) target.fieldLabel = fl;
    } catch {
      // 节点已消失：跳过
    }
  }
}

/**
 * 采集提示文本（toast / 校验错误 / 成功提示）。
 *
 * 不能只看 AX name：按 ARIA 规范，alert/status 的 accessible name 只来自
 * aria-label，正文文本不在其中（实测 <div role="status">已提交</div> 的 name 为空）。
 * 而提示文本正是 E2E 断言成败的核心证据，所以回退到读 DOM 文本。
 */
async function collectStatusMessages(session: CdpSession, nodes: AXNode[]): Promise<string[]> {
  const statusNodes = nodes.filter(
    (n) => !n.ignored && STATUS_ROLES.has(axString(n.role)) && n.backendDOMNodeId !== undefined,
  );
  if (statusNodes.length === 0) return [];

  const READ_TEXT_FN = `function () {
    const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim().slice(0, 200);
    return clean(this.innerText || this.textContent);
  }`;

  const messages: string[] = [];
  for (const node of statusNodes) {
    // aria-label 优先（语义更明确），其次读正文
    const labelled = axString(node.name);
    if (labelled) {
      messages.push(labelled);
      continue;
    }

    try {
      const { object } = await session.send<{ object: { objectId: string } }>('DOM.resolveNode', {
        backendNodeId: node.backendDOMNodeId,
      });
      const res = await session.send<{ result: { value?: string } }>('Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: READ_TEXT_FN,
        returnByValue: true,
      });
      const text = res.result.value;
      if (text) messages.push(text);
    } catch {
      // 节点已消失：跳过，不影响其余提示
    }
  }

  return messages;
}

function isNativeSelectOption(node: AXNode, byId: Map<string, AXNode>): boolean {
  if (!node.parentId) return false;
  const parent = byId.get(node.parentId);
  if (!parent) return false;
  // 双条件：role 名匹配 + 确认是 Chrome 内部 role，避免误杀同名的自定义 role
  return axString(parent.role) === NATIVE_SELECT_POPUP_ROLE && parent.role?.type === 'internalRole';
}

function collectSubtreeIds(root: AXNode, byId: Map<string, AXNode>): Set<string> {
  const ids = new Set<string>();
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (ids.has(node.nodeId)) continue;
    ids.add(node.nodeId);
    for (const childId of node.childIds || []) {
      const child = byId.get(childId);
      if (child) stack.push(child);
    }
  }
  return ids;
}

/**
 * 采集页面内所有 iframe 的可跨会话重放描述。
 *
 * 不用 CDP frame id（会话级不稳定），改用 name/src/id 推导可重放选择器。
 * 只看主文档直接子 iframe（嵌套 iframe 罕见且选择器不好写），
 * trace-ir-spec 要求 frame 描述不含 CDP frame id。
 */

/** CSS 标识符安全转义（用于 #id 场景），确保特殊字符 .:[]等不破坏选择器语法 */
function cssIdent(s: string): string {
  // 1. 转义非 CSS 标识符字符（非 [-a-zA-Z0-9_]）
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (/[a-zA-Z0-9_-]/.test(ch) && (i > 0 || ch !== '-')) {
      out += ch;
    } else {
      const hex = ch.codePointAt(0)!.toString(16);
      out += `\\${hex} `;
    }
  }
  return out;
}

async function collectIframeDescs(session: CdpSession): Promise<FrameDesc[]> {
  try {
    const iframes = await session.evaluate<Array<{ name: string; src: string; id: string }>>(
      `Array.from(document.querySelectorAll('iframe')).map(el => ({ name: el.name || '', src: el.src || el.getAttribute('src') || '', id: el.id || '' }))`,
    );
    return iframes.map((f) => {
      let selector: string;
      if (f.id) {
        selector = `iframe#${cssIdent(f.id)}`;
      } else if (f.name) {
        selector = `iframe[name=${JSON.stringify(f.name)}]`;
      } else {
        try {
          const pathname = new URL(f.src, 'https://placeholder/').pathname;
          selector = `iframe[src*=${JSON.stringify(pathname)}]`;
        } catch {
          selector = 'iframe';
        }
      }
      let urlContains: string;
      try {
        urlContains = new URL(f.src, 'https://placeholder/').pathname;
      } catch {
        urlContains = f.src;
      }
      return { name: f.name, url_contains: urlContains, selector };
    });
  } catch {
    return [];
  }
}
