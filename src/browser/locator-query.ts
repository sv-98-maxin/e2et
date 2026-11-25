import type { CdpSession } from './daemon-client.js';
import type { Locator, TargetCandidate } from '../shared/types.js';
import { PW_INJECTED_SOURCE } from './native-dom-source.js';
import { INTERACTIVE_ROLES } from './page-state.js';

export interface LocatorObservation {
  matches: number;
  role?: string;
  name?: string;
  visible?: boolean;
}

export class WaitLocatorInputError extends Error {
  readonly code = 'BAD_REQUEST';
}

export function nativeDOMFunction(body: string): string {
  return `function() { const module = { exports: {} }; ${PW_INJECTED_SOURCE}\n{\n${body}\n}\n}`;
}

const QUERY_SETUP = `
  const evaluator = new SelectorEvaluatorImpl();
  const factory = { _evaluator: evaluator };
  const bodyOf = selector => parseSelector(selector).parts[0].body;
  const roleEngine = createRoleEngine(true);
  const labelEngine = InjectedScript.prototype._createInternalLabelEngine.call(factory);
  const textEngine = InjectedScript.prototype._createTextEngine.call(factory, true, true);
  const testidEngine = InjectedScript.prototype._createTestIdEngine.call(factory);
  const roleQuery = (root, role, name) => roleEngine.queryAll(root, bodyOf(getByRoleSelector(role, { name, exact: true, includeHidden })));
  const query = (root, locator) => {
    if ('row' in locator) {
      const matcher = createTextMatcher(bodyOf(getByTextSelector(locator.row.contains)), true).matcher;
      const rows = roleQuery(root, 'row').filter(element => matcher(elementText(evaluator._cacheText, element)));
      return locator.role ? [...new Set(rows.flatMap(row => roleQuery(row, locator.role, locator.name)))] : rows;
    }
    if ('role' in locator) {
      const elements = roleQuery(root, locator.role, locator.name);
      return locator.within ? elements.filter(element => query(element, locator.within).length > 0) : elements;
    }
    if ('label' in locator) return labelEngine.queryAll(root, bodyOf(getByLabelSelector(locator.label)));
    if ('text' in locator) return textEngine.queryAll(root, bodyOf(getByTextSelector(locator.normalize ? locator.text.normalize('NFC') : locator.text)));
    if ('testid' in locator) return testidEngine.queryAll(root, bodyOf(getByTestIdSelector('data-testid', locator.testid)));
    if ('css' in locator) return evaluator.query({ scope: root, pierceShadow: true }, parseCSS(locator.css, customCSSNames).selector);
    throw new Error('unsupported locator');
  };
  const observe = elements => elements.length === 1 ? {
    matches: 1, role: getAriaRole(elements[0]) || '',
    name: getElementAccessibleNameText(elements[0], includeHidden), visible: isElementVisible(elements[0])
  } : { matches: elements.length };
  evaluator.begin();
  beginAriaCaches();
`;

export const BACKEND_PLACEHOLDER_CANDIDATES_FN = nativeDOMFunction(`
  if (!this.isConnected) return [];
  const raw = this.getAttribute('placeholder');
  if (raw === null || !raw.trim()) return [];
  const includeHidden = true;
  ${QUERY_SETUP}
  try {
    const selector = '[placeholder="' + CSS.escape(raw) + '"]';
    const hits = query(document, { css: selector });
    return hits.length === 1 && hits[0] === this ? [{ by: 'css', selector, matches: 1 }] : [];
  } finally { endAriaCaches(); evaluator.end(); }
`);

async function evaluateQuery<T>(cdp: CdpSession, body: string, deadlineMs?: number): Promise<T> {
  const remaining = deadlineMs === undefined ? undefined : deadlineMs - Date.now();
  if (remaining !== undefined && remaining <= 0) throw new Error('等待查询预算耗尽');
  const result = await cdp.send<{
    result?: { value?: T };
    exceptionDetails?: { text: string; exception?: { description?: string } };
  }>('Runtime.evaluate', {
    expression: `(${nativeDOMFunction(body)})()`, returnByValue: true,
    ...(remaining !== undefined ? { timeout: remaining } : {}),
  }, deadlineMs);
  if (result.exceptionDetails) {
    const message = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
    if (/InvalidSelectorError|Error while parsing|Malformed.*selector|Role must not be empty|Unknown attribute|Unsupported attribute|Unknown role/.test(message)) throw new WaitLocatorInputError(message);
    throw new Error(message);
  }
  if (!result.result || !('value' in result.result)) throw new Error('等待查询缺少返回值');
  return result.result.value as T;
}

export async function queryLocator(cdp: CdpSession, locator: Locator, includeHidden: boolean, deadlineMs?: number): Promise<LocatorObservation> {
  const observation = await evaluateQuery<LocatorObservation>(cdp, `
    const includeHidden = ${includeHidden};
    ${QUERY_SETUP}
    try { return observe(query(document, ${JSON.stringify(locator)})); }
    finally { endAriaCaches(); evaluator.end(); }
  `, deadlineMs);
  if (!observation || !Number.isInteger(observation.matches) || observation.matches < 0
    || (observation.matches === 1 && (typeof observation.role !== 'string' || typeof observation.name !== 'string' || typeof observation.visible !== 'boolean'))) throw new Error('等待查询返回非法观察事实');
  return observation;
}

/** 在页面里按 canonical locator 取全部匹配元素并执行自包含 mapper；用于标准 DOM 属性读取。 */
export async function mapLocatorElements<T>(cdp: CdpSession, locator: Locator, mapperSource: string, deadlineMs?: number): Promise<T> {
  return evaluateQuery<T>(cdp, `
    const includeHidden = true;
    ${QUERY_SETUP}
    try { return (${mapperSource})(query(document, ${JSON.stringify(locator)})); }
    finally { endAriaCaches(); evaluator.end(); }
  `, deadlineMs);
}

export async function queryAccessibleName(cdp: CdpSession, name: string, deadlineMs?: number): Promise<{ matches: number; candidate?: TargetCandidate }> {
  const result = await evaluateQuery<{ matches: number; candidate?: TargetCandidate }>(cdp, `
    const includeHidden = true;
    const wanted = ${JSON.stringify(name)};
    const roles = new Set(${JSON.stringify([...INTERACTIVE_ROLES])});
    ${QUERY_SETUP}
    try {
      const elements = evaluator._queryCSS({ scope: document, pierceShadow: true }, '*').filter(element => roles.has(getAriaRole(element)));
      const names = elements.map(element => ({ element, name: getElementAccessibleNameText(element, true) }));
      const normalized = normalizeWhitespace(wanted);
      let hits = names.filter(hit => normalizeWhitespace(hit.name) === normalized);
      if (!hits.length) hits = names.filter(hit => normalizeWhitespace(hit.name).includes(normalized));
      if (hits.length) return { matches: hits.length, ...(hits.length === 1 ? { candidate: { by: 'role', role: getAriaRole(hits[0].element), name: hits[0].name, matches: 1 } } : {}) };
      const texts = query(document, { text: wanted, normalize: true });
      return { matches: texts.length, ...(texts.length === 1 ? { candidate: { by: 'text', value: wanted, matches: 1 } } : {}) };
    } finally { endAriaCaches(); evaluator.end(); }
  `, deadlineMs);
  if (!result || !Number.isInteger(result.matches) || result.matches < 0 || (result.matches === 1 && result.candidate?.matches !== 1)) throw new Error('名称查询返回非法身份事实');
  return result;
}
