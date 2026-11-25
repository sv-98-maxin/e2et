/**
 * 动作等待绑定与查询：locator/ref/epoch 准备、frame 生命周期与显式等待读取。
 * 只搬现有等待绑定/查询逻辑，不重写等待算法。
 */
import type { CdpSession } from '../browser/daemon-client.js';
import { createFrameView, FrameUnavailableError } from '../browser/frame-view.js';
import { parseTargetSpec, parseDeclaredWaitLocator } from '../browser/actions.js';
import type { Locator, RefIdentity } from '../shared/types.js';
import { queryLocator, queryAccessibleName, type LocatorObservation } from '../browser/locator-query.js';
import { candidateToLocator } from '../shared/wait-locator.js';
import { InvalidRefError } from '../browser/assert.js';
import { DEFAULT_WAIT_TIMEOUT_MS } from '../wait-timeout.js';
import type { FrameDesc } from '../browser/page-state.js';
import type { WaitSpec } from './network-trace.js';
import type { PageContext } from './page-context.js';
import type { PageObservers } from './page-observers.js';

export const NAV_TIMEOUT_MS = 20_000;
export const SETTLE_MS = 600;
export const ACTION_SETTLE_TIMEOUT_MS = 10_000;
export const DOM_IDLE_MS = 300;

export interface WaitBinding {
  locator?: Locator;
  identity?: RefIdentity;
  targetId?: string;
  epoch?: number;
}

export interface WaitDeps {
  page: PageContext;
  observers: () => PageObservers | null;
}

export interface WaitError {
  code: string;
  message: string;
}

/** daemon 路径导航完成等待：用 CDP 事件替代旧的 href 轮询。 */
export async function waitForLoad(cdp: CdpSession, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => resolve(), timeoutMs);
    const off = cdp.on('Page.loadEventFired', () => {
      clearTimeout(timer);
      off();
      resolve();
    });
  });
  const ready = await cdp.evaluate<string>('document.readyState').catch(() => 'complete');
  if (ready !== 'complete') {
    await new Promise((r) => setTimeout(r, SETTLE_MS));
  }
}

/** DOM 静默：连续 idleMs 内 __e2etChangeCount 无变化。 */
export async function waitForDomIdle(cdp: CdpSession, idleMs: number): Promise<void> {
  let last = await cdp.evaluate<number>('window.__e2etChangeCount || 0').catch(() => 0);
  const deadline = Date.now() + idleMs * 4;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, idleMs));
    const cur = await cdp.evaluate<number>('window.__e2etChangeCount || 0').catch(() => 0);
    if (cur === last) return;
    last = cur;
  }
}

/** --wait-* 参数 → WaitSpec；解析 #n 后缀（path#3 → nth=3）。无任何 wait_* 返回 undefined。 */
export function parseWaitSpec(params: Record<string, unknown> | undefined): WaitSpec | undefined {
  if (!params) return undefined;
  const api = params.wait_api as string | undefined;
  const element = params.wait_element as string | undefined;
  const gone = params.wait_gone as string | undefined;
  const text = params.wait_text as string | undefined;
  const url = params.wait_url as string | undefined;
  if (!api && !element && !gone && !text && !url) return undefined;
  const spec: WaitSpec = {};
  if (api) {
    spec.apis = api.split(',').map((token) => {
      const hash = token.indexOf('#');
      if (hash > 0) {
        const n = Number(token.slice(hash + 1));
        return { path: token.slice(0, hash), ...(Number.isFinite(n) && n > 0 ? { nth: n } : {}) };
      }
      return { path: token };
    }).filter((a) => a.path !== '');
  }
  if (element) spec.element = element;
  if (gone) spec.gone = gone;
  if (text) spec.text = text;
  if (url) spec.url = url;
  return spec;
}

/** 等待名称 → canonical locator 首次绑定（不唯一/不可还原即拒绝）。 */
async function bindName(raw: string, binding: WaitBinding, context: CdpSession, deadlineMs: number): Promise<LocatorObservation> {
  const result = await queryAccessibleName(context, raw, deadlineMs);
  if (result.matches > 1) throw new Error('BAD_REQUEST: 等待名称不唯一');
  if (!result.candidate) return { matches: 0 };
  const locator = candidateToLocator(result.candidate);
  if (!locator) throw new Error('INSUFFICIENT_EVIDENCE: 名称不能转换为 canonical locator');
  const observation = await queryLocator(context, locator, true, deadlineMs);
  if (observation.matches !== 1) throw new Error('INSUFFICIENT_EVIDENCE: 首次名称绑定 canonical 复查不唯一');
  binding.locator = locator;
  binding.identity = { source: 'collector', candidate: result.candidate };
  return observation;
}

/** 每个 await 后按 root DOM owner 重新解析 frame，避免缓存旧 frame 视图。 */
export async function freshWaitContext(
  deps: WaitDeps,
  frameDesc: FrameDesc | undefined,
  deadlineMs: number,
): Promise<CdpSession> {
  const current = deps.page.activeCdp();
  if (!current) throw new FrameUnavailableError('当前 page 会话未就绪');
  if (!frameDesc?.selector) return current;
  const selector = frameDesc.selector;
  const response = await current.send<{ result?: { objectId?: string }; exceptionDetails?: unknown }>('Runtime.evaluate', {
    expression: `(() => { const owners = document.querySelectorAll(${JSON.stringify(selector)}); if (owners.length !== 1) throw new Error('frame owner 不唯一或已失效'); return owners[0]; })()`,
    returnByValue: false, timeout: Math.max(1, deadlineMs - Date.now()),
  }, deadlineMs);
  if (response.exceptionDetails || !response.result?.objectId) throw new FrameUnavailableError('当前 frame owner 查询失败');
  const objectId = response.result.objectId;
  try {
    const described = await current.send<{ node?: { frameId?: string } }>('DOM.describeNode', { objectId }, deadlineMs);
    if (!described.node?.frameId) throw new FrameUnavailableError('当前 owner 无 frameId');
    const resolvedFrameId = described.node.frameId;
    const channel = await deps.observers()!.selectFrameChannel(deps.page.activeId() ?? deps.page.sourceId(), resolvedFrameId, deadlineMs);
    return await createFrameView(channel.session, resolvedFrameId, deadlineMs);
  } finally {
    if (Date.now() < deadlineMs) await current.send('Runtime.releaseObject', { objectId }, deadlineMs);
  }
}

/** exec 前准备显式等待的绑定事实（locator/identity/target/epoch）。 */
export async function prepareWaitBindings(
  deps: WaitDeps,
  waitSpec: WaitSpec | undefined,
  kind: string,
  actionCdp: CdpSession,
  declaredBudget: number | undefined,
): Promise<{ ok: true; bindings: Map<string, WaitBinding> } | { ok: false; error: WaitError }> {
  const waitBindings = new Map<string, WaitBinding>();
  try {
    for (const raw of [waitSpec?.element, waitSpec?.gone]) {
      if (raw === undefined || waitBindings.has(raw)) continue;
      const binding: WaitBinding = {};
      const declared = parseDeclaredWaitLocator(raw);
      const spec = parseTargetSpec(raw);
      const preparationDeadline = Date.now() + (declaredBudget ?? DEFAULT_WAIT_TIMEOUT_MS);
      if (declared) {
        binding.locator = declared;
        await queryLocator(actionCdp, declared, true, preparationDeadline);
      } else if (spec?.kind === 'index') {
        if (['open', 'back', 'refresh', 'switch_tab'].includes(kind)) throw new InvalidRefError(`${kind} 不能携带历史 ref 等待`);
        const mapped = deps.page.resolveRef(spec.index);
        const activeId = deps.page.activeId() ?? deps.page.sourceId();
        if (!mapped || mapped.targetId !== activeId) throw new InvalidRefError('等待 ref 已失效或跨 tab');
        binding.identity = mapped.identity;
        binding.locator = mapped.identity && candidateToLocator(mapped.identity.candidate) || undefined;
        if (!binding.locator) throw new Error('INSUFFICIENT_EVIDENCE: 等待 ref 缺少可还原身份');
        binding.targetId = activeId;
        binding.epoch = deps.page.documentEpoch();
        const observation = await queryLocator(actionCdp, binding.locator, true, preparationDeadline);
        if (observation.matches > 1) throw new Error('BAD_REQUEST: 等待 ref canonical 不唯一');
      } else {
        if (!raw.trim()) throw new Error('BAD_REQUEST: 等待名称不能为空');
        await bindName(raw, binding, actionCdp, preparationDeadline);
        if (binding.locator && ['open', 'back', 'refresh', 'switch_tab'].includes(kind)) throw new InvalidRefError(`${kind} 不能携带旧文档已绑定名称等待`);
        if (binding.locator) {
          binding.targetId = deps.page.activeId() ?? deps.page.sourceId();
          binding.epoch = deps.page.documentEpoch();
        }
        if (raw === waitSpec?.gone && !binding.locator) throw new Error('INSUFFICIENT_EVIDENCE: 裸名称 gone 未绑定；请声明 role/label/text/testid/css');
      }
      waitBindings.set(raw, binding);
    }
  } catch (error) {
    const message = (error as Error).message;
    if (error instanceof InvalidRefError || /^(BAD_REQUEST|INSUFFICIENT_EVIDENCE):/.test(message) || (error as { code?: string }).code === 'BAD_REQUEST') {
      return { ok: false, error: { code: message.startsWith('INSUFFICIENT_EVIDENCE:') ? 'INSUFFICIENT_EVIDENCE' : 'BAD_REQUEST', message } };
    }
    throw error;
  }
  return { ok: true, bindings: waitBindings };
}

/** 显式等待的单次查询：ref/epoch 漂移拒绝，名称按当前 frame 重新绑定。 */
export async function queryWaitTarget(
  deps: WaitDeps,
  frameDesc: FrameDesc | undefined,
  bindings: Map<string, WaitBinding>,
  raw: string,
  deadlineMs: number,
): Promise<{ locator?: Locator; identity?: RefIdentity; observation: LocatorObservation }> {
  const binding = bindings.get(raw);
  if (!binding) throw new Error('INSUFFICIENT_EVIDENCE: 等待缺少准备事实');
  if (binding.targetId !== undefined && (binding.targetId !== (deps.page.activeId() ?? deps.page.sourceId()) || binding.epoch !== deps.page.documentEpoch())) {
    throw new InvalidRefError('等待历史 ref 已跨文档或 target');
  }
  const context = await freshWaitContext(deps, frameDesc, deadlineMs);
  const observation = binding.locator
    ? await queryLocator(context, binding.locator, true, deadlineMs)
    : await bindName(raw, binding, context, deadlineMs);
  if (binding.identity && binding.targetId === undefined && binding.locator) {
    binding.targetId = deps.page.activeId() ?? deps.page.sourceId();
    binding.epoch = deps.page.documentEpoch();
  }
  return { ...(binding.locator ? { locator: binding.locator } : {}), ...(binding.identity ? { identity: binding.identity } : {}), observation };
}

export async function readWaitValue(
  deps: WaitDeps,
  frameDesc: FrameDesc | undefined,
  deadlineMs: number,
  expression: 'document.body.innerText' | 'location.href',
  errorMessage: string,
): Promise<string> {
  const context = await freshWaitContext(deps, frameDesc, deadlineMs);
  const result = await context.send<{ result?: { value?: unknown }; exceptionDetails?: unknown }>('Runtime.evaluate', { expression, returnByValue: true, timeout: Math.max(1, deadlineMs - Date.now()) }, deadlineMs);
  if (result.exceptionDetails || typeof result.result?.value !== 'string') throw new Error(errorMessage);
  return result.result.value;
}
