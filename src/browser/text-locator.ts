/**
 * DOM 可见文本定位（AX 树的兜底通道，组件库无关）
 *
 * 为什么需要它：快照只收 AX 树里的标准 role（见 page-state.ts 的 INTERACTIVE_ROLES），
 * 而业务页面大量存在「无 <a>、无 role、无 aria-label 的 div 点击层」—— 这类节点压根
 * 进不了 AX 可交互清单，按名字定位必然报「找不到」，而 CSS selector 逃生口又要求
 * 调用方先知道选择器。
 *
 * 判据全部是 DOM/CSS 事实（标签语义、ARIA role 属性、onclick、tabindex、cursor），
 * 不认任何组件库的 class name。
 *
 * 歧义不猜：多处可见命中直接报错并列出各自的可点容器路径，让调用方改用 selector。
 */
import type { CdpSession } from './daemon-client.js';
import { nativeDOMFunction } from './locator-query.js';

export interface TextTarget {
  backendNodeId: number;
  role: string;
  name: string;
}

export class TextTargetError extends Error {
  constructor(
    message: string,
    /** true = 页面上确实没这段文本（调用方该换个说法）；false = 有但不唯一/已失效 */
    readonly notFound: boolean,
  ) {
    super(message);
    this.name = 'TextTargetError';
  }
}

interface Probe {
  kind: 'exact' | 'substring' | 'none';
  count: number;
  candidates: Array<{ text: string; path: string; role: string }>;
  /** count=0 时给的页面可点文本清单，省掉调用方再瞎猜一轮 */
  clickable_texts: string[];
}

/** 超过这个长度的文本是段落正文，不是可点控件的标签 */
const MAX_TEXT_LEN = 80;
/** 向上找可点祖先的层数上限 */
const MAX_LIFT = 4;
/** 候选集上限 —— 文本节点量级在长列表页能上万，无界遍历会拖慢每次定位 */
const MAX_CANDIDATES = 1500;

/**
 * 查找脚本。前半段（候选采集 + 匹配）两种用法共用，tail 决定返回诊断还是返回元素本身
 * —— DOM 节点不能 returnByValue，拿句柄必须单独跑一次不序列化的 Runtime.evaluate。
 */
function pageScript(want: string, tail: string): string {
  return `(${nativeDOMFunction(`
  const want = ${JSON.stringify(want)};
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TITLE', 'TEMPLATE']);
  const CLICK_TAGS = new Set(['A', 'BUTTON', 'SUMMARY', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL']);
  const CLICK_ROLES = new Set(['button', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
    'tab', 'option', 'treeitem', 'checkbox', 'radio', 'switch']);

  // 可点祖先。显式语义（标签/role/onclick/tabindex）从内向外优先命中；
  // cursor:pointer 只作兜底信号 —— 它是可继承属性，文本所在的 span 也会算出 pointer，
  // 拿它当主判据等于永远返回最内层节点，lift 就白做了。
  const clickable = (el) => {
    let pointer = null;
    for (let n = el, d = 0; n && n.nodeType === 1 && d <= ${MAX_LIFT}; n = n.parentElement, d++) {
      if (CLICK_TAGS.has(n.tagName)) return n;
      const role = n.getAttribute('role');
      if (role && CLICK_ROLES.has(role)) return n;
      if (n.hasAttribute('onclick')) return n;
      const ti = n.getAttribute('tabindex');
      if (ti !== null && ti !== '' && Number(ti) >= 0) return n;
      if (!pointer && getComputedStyle(n).cursor === 'pointer') pointer = n;
    }
    return pointer;
  };

  // 歧义报错里的路径必须能直接当 selector 用，否则列出来的几条同名同 class 路径
  // 对调用方毫无价值。逐层向上拼，一旦全局唯一就停 —— 取最短唯一路径。
  const path = (el) => {
    const seg = (n) => {
      if (n.id) return '#' + CSS.escape(n.id);
      let s = n.tagName.toLowerCase();
      const cls = (n.getAttribute('class') || '').split(/\\s+/).filter(Boolean).slice(0, 2);
      if (cls.length) s += '.' + cls.map((c) => CSS.escape(c)).join('.');
      const p = n.parentElement;
      if (p) s += ':nth-child(' + ([...p.children].indexOf(n) + 1) + ')';
      return s;
    };
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && n.tagName !== 'BODY' && parts.length < 8; n = n.parentElement) {
      parts.unshift(seg(n));
      const sel = parts.join(' > ');
      try {
        if (document.querySelectorAll(sel).length === 1) return sel;
      } catch (e) { /* 选择器不合法（怪异 class）：继续向上拼 */ }
      if (n.id) break;
    }
    return parts.join(' > ');
  };

  // 走文本节点而不是 querySelectorAll('*')：文本节点的 parentElement 天然是
  // 「自己承载这段文本」的最深元素，顺带避开祖先链上的重复命中。
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  const cands = [];
  for (let node = walker.nextNode(); node && cands.length < ${MAX_CANDIDATES}; node = walker.nextNode()) {
    const text = norm(node.nodeValue);
    if (!text || text.length > ${MAX_TEXT_LEN}) continue;
    const el = node.parentElement;
    if (!el || seen.has(el) || SKIP_TAGS.has(el.tagName)) continue;
    seen.add(el);
    // 关闭的弹层以 display:none 留在 DOM 里，里面的旧按钮点不得
    if (!isElementVisible(el)) continue;
    cands.push({ el: el, text: text });
  }

  // 精确优先再子串，与 AX 名字匹配语义保持一致
  let kind = 'exact';
  let hits = cands.filter((c) => c.text === want);
  if (hits.length === 0) { hits = cands.filter((c) => c.text.includes(want)); kind = 'substring'; }
  if (hits.length === 0) kind = 'none';
  const pick = (c) => clickable(c.el) || c.el;
  ${tail}
`)})()`;
}

const PROBE_TAIL = `return {
    kind: kind,
    count: hits.length,
    candidates: hits.slice(0, 5).map((c) => {
      const t = pick(c);
      return { text: c.text, path: path(t), role: t.getAttribute('role') || t.tagName.toLowerCase() };
    }),
    clickable_texts: hits.length > 0
      ? []
      : [...new Set(cands.filter((c) => clickable(c.el)).map((c) => c.text))].slice(0, 10),
  };`;

const RESOLVE_TAIL = `return hits.length === 1 ? pick(hits[0]) : null;`;

/**
 * 按可见文本定位可点节点。命中唯一才返回，其余情况一律抛 TextTargetError。
 */
export async function resolveTextTarget(session: CdpSession, want: string): Promise<TextTarget> {
  const probe = await session.evaluate<Probe>(pageScript(want, PROBE_TAIL));

  if (probe.count === 0) {
    const hint = probe.clickable_texts.length > 0 ? ` 页面可点文本候选: ${probe.clickable_texts.join(' | ')}` : '';
    throw new TextTargetError(`页面上没有可见文本 "${want}"（AX 树与 DOM 文本都没命中）。${hint}`, true);
  }

  if (probe.count > 1) {
    const list = probe.candidates.map((c, i) => `${i + 1}) "${c.text}" @ ${c.path}`).join('；');
    throw new TextTargetError(
      `文本 "${want}" 在页面上有 ${probe.count} 处可见命中（${probe.kind === 'exact' ? '精确' : '子串'}匹配），` +
        `不猜点哪个。把文本写得更完整，或用 selector 指定其中一个可点容器：${list}`,
      false,
    );
  }

  // 唯一命中：重跑同一段查找拿元素句柄
  const res = await session.send<{ result: { objectId?: string } }>('Runtime.evaluate', {
    expression: pageScript(want, RESOLVE_TAIL),
    returnByValue: false,
  });
  const objectId = res.result?.objectId;
  if (!objectId) {
    throw new TextTargetError(`文本 "${want}" 的命中节点在定位过程中消失了（页面刚变过），先 page state 刷新再重试`, false);
  }

  const { node } = await session.send<{ node: { backendNodeId: number } }>('DOM.describeNode', { objectId });
  const hit = probe.candidates[0];
  return { backendNodeId: node.backendNodeId, role: hit.role, name: hit.text };
}
