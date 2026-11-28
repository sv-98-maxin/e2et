/**
 * 16 种 action → Playwright API。
 * 每个动作结束后 resolve wait[] → run checks[]（由 runner 编排）。
 */
import type { Page, BrowserContext, ElementHandle } from '@playwright/test';
import type { Locator as PlaywrightLocator, FrameLocator } from '@playwright/test';
import type { Step, Value } from './types.js';
import type { ValueContext } from './value.js';
import type { RequestTracker } from './request-tracker.js';
import { resolveLocatorWithFallback, resolveFrame } from './locator.js';
import { AUTH_DATA_NOT_REPLAYABLE } from './shared/element-value.js';
import { resolveWriteTarget, prepareWriteTargetEval, assertWriteReadyEval, writeNativeValueEval, readWriteTarget, scrollWindowEval, type WriteInput, type WriteTarget, scrollElement, centerElement, scrollWindow, type ScrollInput } from './shared/dom-actions.js';
import {
  selectNativeOptionEval, readNativeOptionsEval, applyNativeSelectionEval,
  readSelectRootStateEval, optionDisabledReasonEval, isElementVisibleEval,
  resolveOptionPoolsMetaEval, isDirectCategoryChildEval, E2ET_SELECTION_POOL_UNIQUE,
  readOptionStateEval, readKeyboardContextEval, filterPreflightGuardEval,
  reachKeyboardSelection, selectionVerification,
  chooseOptionIndex, collectAxOptionCandidates,
  OPTION_ROLES,
  type AxOptionCandidate, type AxOptionNode, type OptionState, type SelectRootState, type KeyboardSnapshot,
} from './shared/selection.js';
import { redactUrlWithEvidence } from './shared/url-safety.js';
import { ACTION_OUTPUT_KINDS, type InputCommit, type RecordInputCallback } from './shared/types.js';
import { validateStepInputs } from './shared/step-input.js';
import { resolveLocator } from './locator.js';
import type { Locator } from './types.js';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { hoverEnter, hoverLeave, isHoverRelated } from './shared/dom-actions.js';
import type { ReportEvent } from './shared/report-model.js';

const prepareInputEval = prepareWriteTargetEval();
const inputReadyEval = assertWriteReadyEval();
const nativeInputEval = writeNativeValueEval();

/** 共源整页滚动：scrollWindow（无闭包二参适配，供 frame 作用域 locator('html').evaluate） */
const scrollEval = scrollWindowEval();

/** 共源原生 select：单次 RPC 内完成匹配/guard/真实 selectedIndex 写入（Phase3a 原生选择子集） */
const selectEval = selectNativeOptionEval();
const readNativeEval = readNativeOptionsEval();
const applyNativeEval = applyNativeSelectionEval();
const rootStateEval = readSelectRootStateEval();
const optionDisabledEval = optionDisabledReasonEval();
const visibleEval = isElementVisibleEval();
const optionStateEval = readOptionStateEval();
const keyboardContextEval = readKeyboardContextEval();
const filterGuardEval = filterPreflightGuardEval();
/** PW 池解析 meta eval：同 resolver related 分支（containment 去重声明 ID + CSS.escape selector） */
const poolsMetaEval = resolveOptionPoolsMetaEval();
/** PW 层级 predicate：与 Source 同源 isDirectCategoryChild（arg=[scopeRoot, roles]） */
const directChildEval = isDirectCategoryChildEval();

/** wrapper 只用于无副作用解析；固定真实 ElementHandle 后立即登记整步凭据。 */
async function writeValue(
  page: Page,
  loc: PlaywrightLocator,
  input: WriteInput,
  recordInput: RecordInputCallback,
  options?: { timeout: number },
): Promise<string> {
  const wrapper = await loc.elementHandle(options);
  if (!wrapper) throw new Error('NOT_INTERACTABLE: 写入目标不存在');
  let leaf: ElementHandle<WriteTarget> | undefined;
  let registered = false;
  try {
    const resolved = await wrapper.evaluateHandle(resolveWriteTarget);
    const element = resolved.asElement();
    if (!element) {
      await resolved.dispose().catch(() => undefined);
      throw new Error('NOT_INTERACTABLE: resolveWriteTarget 未返回实际叶节点');
    }
    leaf = element as ElementHandle<WriteTarget>;
    const fixedLeaf = leaf;
    const expected = input.value;
    let target: { selector?: string } = {};
    let backend: 'insertText' | 'dispatchKeyEvent' | 'native' = input.mode === 'type' ? 'dispatchKeyEvent' : 'insertText';
    recordInput({
      verify: async () => {
        let actual: string;
        try {
          actual = await fixedLeaf.evaluate(readWriteTarget);
        } catch (error) {
          if (error instanceof Error && error.message.includes(AUTH_DATA_NOT_REPLAYABLE)) throw new Error(AUTH_DATA_NOT_REPLAYABLE);
          if (error instanceof Error && error.message.includes('FILL_NOT_COMMITTED:')) {
            throw new Error('FILL_NOT_COMMITTED: ' + JSON.stringify({ expected, target, actual_unavailable: true, reason: 'detached' }));
          }
          throw error;
        }
        if (actual !== expected) throw new Error('FILL_NOT_COMMITTED: ' + JSON.stringify({ expected, actual, target }));
        return { target, expected, actual, backend };
      },
      dispose: async () => { await fixedLeaf.dispose(); },
    });
    registered = true;
    target = await fixedLeaf.evaluate((el) => ({ selector: el.id ? '#' + CSS.escape(el.id) : el.tagName.toLowerCase() }));
    const kind = await fixedLeaf.evaluate(prepareInputEval);
    if (kind === 'native') {
      backend = 'native';
      await fixedLeaf.evaluate(nativeInputEval, expected);
    } else {
      if (await fixedLeaf.evaluate(inputReadyEval) !== kind) throw new Error('FILL_NOT_COMMITTED: 输入前原生控件类型改变');
      if (expected === '') {
        backend = 'dispatchKeyEvent';
        await page.keyboard.press('Backspace');
      } else if (input.mode === 'fill') {
        await page.keyboard.insertText(expected);
      } else {
        for (const char of expected) {
          if (await fixedLeaf.evaluate(inputReadyEval) !== kind) throw new Error('FILL_NOT_COMMITTED: 输入期间原生控件类型改变');
          if (char === '\n') {
            await page.keyboard.press('Enter');
            continue;
          }
          await page.keyboard.type(char);
        }
      }
    }
    return expected;
  } catch (error) {
    if (error instanceof Error && error.message.includes(AUTH_DATA_NOT_REPLAYABLE)) throw new Error(AUTH_DATA_NOT_REPLAYABLE);
    throw error;
  } finally {
    await wrapper.dispose().catch(() => undefined);
    if (leaf && !registered) await leaf.dispose().catch(() => undefined);
  }
}

export interface ActionResult {
  /** switch_tab 等动作返回的新 page */
  page?: Page;
  /** step.value 解析后的实际值（同一步只解析一次） */
  resolvedValue?: string;
  /** §8 输出合同：choose/category 实际 picked label 数组 JSON（save_as 绑定源） */
  outputValue?: string;
}

export type ActionObservation = Partial<Pick<ReportEvent, 'target' | 'input' | 'valueSource'>>;

export interface HoverState {
  target?: ElementHandle<SVGElement | HTMLElement>;
  page?: Page;
}

export async function clearHover(state: HoverState): Promise<void> {
  if (!state.target) return;
  const target = state.target;
  let failed = false;
  try {
    await target.evaluate(hoverLeave);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    state.target = undefined;
    state.page = undefined;
    try { await target.dispose(); } catch (error) {
      if (!failed) throw error;
      console.error('❌ hover handle cleanup:', error);
    }
  }
}

const POOL_WAIT_MS = 5000;

// ── custom 选择（PW 侧，F05-F09/F13/F16/F17：同 Source 的 prepare/pick 阶段镜像）──

/** PW 池引用：related=同 resolver 的 containment 去重声明 ID 在根所在 document 用 CSS.escape
 *  生成 selector、再实际 frame 的 Locator 逐池采集；page=固定 engine 绑定
 *  （root.locator('e2et_selection_pool=unique')，root 必须是已定位的本次选择控件）。 */
interface PwPools { scope: 'related' | 'page'; locators: PlaywrightLocator[]; }
type OptionHandle = ElementHandle<SVGElement | HTMLElement>;
interface PwPick { name: string; target: OptionHandle; }
interface PwPoolView { locator: PlaywrightLocator; handle: OptionHandle; }
interface PwRound { scope: 'related' | 'page'; pools: PwPoolView[]; scopeRoots: OptionHandle[]; owned: OptionHandle[]; }
interface PwCandidate extends AxOptionCandidate { handle: OptionHandle; }

async function resolvePoolsPw(root: PlaywrightLocator, frame: Page | FrameLocator): Promise<PwPools> {
  const meta = await root.evaluate(poolsMetaEval as unknown as (el: Element) => { scope: 'related' | 'page'; selectors: string[]; self: boolean });
  if (meta.scope === 'related') return { scope: 'related', locators: meta.self ? [root] : meta.selectors.map(selector => frame.locator(selector)) };
  return { scope: 'page', locators: [root.locator(E2ET_SELECTION_POOL_UNIQUE)] };
}

async function anyPoolVisiblePw(pools: PwPools): Promise<boolean> {
  for (const pool of pools.locators) {
    if (await pool.count() === 0) continue;
    if (await pool.evaluate(visibleEval as unknown as (el: Element) => boolean)) return true;
  }
  return false;
}

async function prepareCustomSelectionPw(
  page: Page,
  root: PlaywrightLocator,
  frame: Page | FrameLocator,
  filterText: string | undefined,
  budget: () => number,
): Promise<void> {
  const original = await root.elementHandle({ timeout: budget() });
  if (!original) throw new Error('NOT_INTERACTABLE: 选择根不存在');
  try {
    const state = await original.evaluate(rootStateEval as unknown as (el: Element) => SelectRootState | null);
    if (!state?.connected || state.disabled) throw new Error('NOT_INTERACTABLE: 选择根已禁用或脱离文档');
    if (filterText !== undefined) {
      const reason = await original.evaluate(filterGuardEval as unknown as (el: Element) => string | null);
      if (reason === 'password') throw new Error(AUTH_DATA_NOT_REPLAYABLE);
      if (reason) throw new Error('NOT_INTERACTABLE: filter_text 目标处于 ' + reason + ' 状态');
    }
    const deadline = Date.now() + Math.min(POOL_WAIT_MS, budget());
    let attemptedExpand = false;
    const expand = async (): Promise<void> => {
      attemptedExpand = true;
      if (state.role === 'combobox') {
        await original.focus();
        await original.press('ArrowDown', { timeout: budget() });
      } else await original.click({ timeout: budget() });
    };
    if (state.ariaExpanded === false && !['listbox', 'tree', 'menu', 'menubar'].includes(state.role || '')) await expand();
    let pools: PwPools;
    for (;;) {
      try { pools = await resolvePoolsPw(root, frame); break; }
      catch (error) {
        if (!(error as Error).message.includes('OPTION_POOL_DECLARED_MISSING')) throw error;
        if (!attemptedExpand && state.role === 'combobox' && state.ariaExpanded !== true) await expand();
        else if (!attemptedExpand) throw error;
        if (Date.now() >= deadline) throw new Error('OPTION_POOL_DECLARED_MISSING: 展开后声明池仍缺失 (attempted_expand=true)');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    const selfPool = pools.scope === 'related' && pools.locators.length === 1 && pools.locators[0] === root;
    if (state.ariaExpanded !== true && !selfPool && !await anyPoolVisiblePw(pools) && !attemptedExpand) {
      await expand();
      await resolvePoolsPw(root, frame);
    }
    if (!await root.evaluate((element, expected) => element === expected, original)) throw new Error('SELECTION_TARGET_CHANGED: 展开中原选择根被替换');
    if (filterText !== undefined) {
      const inputs: InputCommit[] = [];
      try {
        await writeValue(page, root, { value: filterText, mode: 'type' }, input => inputs.push(input), { timeout: budget() });
        for (const input of inputs) await input.verify();
      } finally {
        for (const input of inputs) await input.dispose().catch(() => undefined);
      }
    }
  } finally { await original.dispose().catch(() => undefined); }
}

async function resolveRoundPw(root: PlaywrightLocator, frame: Page | FrameLocator, category: boolean, parent: OptionHandle | undefined): Promise<PwRound> {
  const owned: OptionHandle[] = [];
  try {
    let scopeRoots: OptionHandle[] = [];
    let pools: PwPools;
    if (category && parent) {
      const state = await parent.evaluate(rootStateEval as unknown as (el: Element) => SelectRootState | null);
      if (!state?.connected) throw new Error('SELECTION_TARGET_CHANGED: 上次类目项已脱离文档，拒绝同名替身');
      if (state.ariaControls.length || state.ariaOwns.length) {
        const meta = await parent.evaluate(poolsMetaEval as unknown as (el: Element) => { scope: 'related' | 'page'; selectors: string[]; self: boolean });
        if (meta.self) {
          // body 只提供标准 ARIA 名称，实际池与本层作用域始终是原 parent handle。
          return { scope: 'related', pools: [{ locator: frame.locator('body'), handle: parent }], scopeRoots: [parent], owned };
        }
        pools = { scope: meta.scope, locators: meta.selectors.map(selector => frame.locator(selector)) };
      } else {
        pools = await resolvePoolsPw(root, frame);
        scopeRoots = [parent];
      }
    } else pools = await resolvePoolsPw(root, frame);
    const views: PwPoolView[] = [];
    for (const locator of pools.locators) {
      if (await locator.count() === 0) continue;
      const handle = await locator.elementHandle() as OptionHandle | null;
      if (!handle) throw new Error('INSUFFICIENT_EVIDENCE: 当前池未取得真实节点');
      owned.push(handle);
      views.push({ locator, handle });
    }
    if (category && scopeRoots.length === 0) scopeRoots = views.map(view => view.handle);
    return { scope: pools.scope, pools: views, scopeRoots, owned };
  } catch (error) {
    for (const handle of owned) await handle.dispose().catch(() => undefined);
    throw error;
  }
}

async function poolCandidatesPw(round: PwRound, category: boolean): Promise<PwCandidate[]> {
  const candidates: PwCandidate[] = [];
  for (const pool of round.pools) {
    const snapshot = await pool.locator.ariaSnapshotJSON();
    if (!Array.isArray(snapshot)) throw new Error('INSUFFICIENT_EVIDENCE: 池 ariaSnapshotJSON 不是根数组');
    const queried = new Set<string>();
    for (const candidate of collectAxOptionCandidates(snapshot as AxOptionNode[])) {
      const key = candidate.role + '\u0001' + candidate.name;
      if (queried.has(key)) continue;
      queried.add(key);
      const handles = await pool.locator.getByRole(candidate.role as never, { name: candidate.name, exact: true, includeHidden: true }).elementHandles() as OptionHandle[];
      for (const handle of handles) {
        round.owned.push(handle);
        if (!await pool.handle.evaluate((element, target) => element.contains(target), handle)) continue;
        if (category) {
          let direct = false;
          for (const scope of round.scopeRoots) {
            if (await handle.evaluate(directChildEval as never, [scope, OPTION_ROLES] as never)) { direct = true; break; }
          }
          if (!direct) continue;
        }
        let duplicate = false;
        for (const existing of candidates) {
          if (await existing.handle.evaluate((element, other) => element === other, handle)) { duplicate = true; break; }
        }
        if (!duplicate) candidates.push({ ...candidate, handle });
      }
    }
  }
  return candidates;
}

async function idLocatorPw(root: OptionHandle, frame: Page | FrameLocator, id: string): Promise<PlaywrightLocator> {
  const selector = await root.evaluate((element, value) => '#' + element.ownerDocument.defaultView!.CSS.escape(value), id);
  return frame.locator(selector);
}

async function keyboardReaderPw(root: OptionHandle, pool: OptionHandle, frame: Page | FrameLocator, scope: OptionHandle | undefined): Promise<() => Promise<KeyboardSnapshot>> {
  const initial = await root.evaluate(rootStateEval as unknown as (el: Element) => SelectRootState | null);
  return async () => {
    const state = await root.evaluate(rootStateEval as unknown as (el: Element) => SelectRootState | null);
    if (!state?.connected || state.role !== initial?.role || JSON.stringify([state.ariaControls, state.ariaOwns]) !== JSON.stringify([initial?.ariaControls, initial?.ariaOwns])) throw new Error('INSUFFICIENT_EVIDENCE: 键盘遍历中原根身份或声明关系变化');
    const context = await root.evaluate(keyboardContextEval as never, pool as never) as { active_id: string; options: OptionState[] };
    const options: KeyboardSnapshot['options'] = [];
    for (const option of context.options) {
      const locator = await idLocatorPw(root, frame, option.id);
      if (await locator.count() !== 1) throw new Error('INSUFFICIENT_EVIDENCE: 当前标准 id 不唯一或已缺席');
      const handle = await locator.elementHandle() as OptionHandle | null;
      if (!handle) throw new Error('INSUFFICIENT_EVIDENCE: 当前标准 id 未取得节点');
      try {
        if (!await pool.evaluate((element, target) => element.contains(target), handle)) throw new Error('INSUFFICIENT_EVIDENCE: 当前 id 已离开原声明池');
        const snapshot = await locator.ariaSnapshotJSON({ depth: 1 });
        const semantic = collectAxOptionCandidates(snapshot as AxOptionNode[])[0];
        if (!semantic || semantic.role !== option.role) throw new Error('SELECTION_TARGET_CHANGED: 原标准 id 不再暴露同一角色');
        const eligible = !scope || await handle.evaluate(directChildEval as never, [scope, OPTION_ROLES] as never) as boolean;
        options.push({ ...option, role: semantic.role, name: semantic.name, eligible });
      } finally { await handle.dispose().catch(() => undefined); }
    }
    return { active_id: context.active_id, options };
  };
}

async function assertOptionIdentityPw(target: OptionHandle, frame: Page | FrameLocator, role: string, name: string, id: string): Promise<OptionState> {
  const state = await target.evaluate(optionStateEval as unknown as (el: Element) => OptionState);
  if (!state.connected) return state;
  if (state.role !== role || state.id !== id) throw new Error('SELECTION_TARGET_CHANGED: 原选项 id 或角色变化');
  const handles = await frame.getByRole(role as never, { name, exact: true, includeHidden: true }).elementHandles() as OptionHandle[];
  try {
    for (const handle of handles) if (await target.evaluate((element, other) => element === other, handle)) return state;
  } finally { for (const handle of handles) await handle.dispose().catch(() => undefined); }
  throw new Error('SELECTION_TARGET_CHANGED: 原选项完整名称变化');
}

async function childPoolVisiblePw(target: OptionHandle, frame: Page | FrameLocator): Promise<boolean> {
  const state = await target.evaluate(rootStateEval as unknown as (el: Element) => SelectRootState | null);
  const pools: OptionHandle[] = [];
  const owned: OptionHandle[] = [];
  try {
    if (state && (state.ariaControls.length || state.ariaOwns.length)) {
      let meta: { scope: 'related' | 'page'; selectors: string[]; self: boolean };
      try { meta = await target.evaluate(poolsMetaEval as unknown as (el: Element) => { scope: 'related' | 'page'; selectors: string[]; self: boolean }); }
      catch (error) { if ((error as Error).message.includes('OPTION_POOL_DECLARED_MISSING')) return false; throw error; }
      if (meta.self) pools.push(target);
      else for (const selector of meta.selectors) {
        const handle = await frame.locator(selector).elementHandle() as OptionHandle | null;
        if (handle) { pools.push(handle); owned.push(handle); }
      }
    } else pools.push(target);
    for (const pool of pools) {
      const children = await pool.$$(OPTION_ROLES.map(role => '[role="' + role + '"]').join(',')) as OptionHandle[];
      owned.push(...children);
      for (const child of children) if (await child.evaluate(visibleEval as unknown as (el: Element) => boolean)
        && await child.evaluate(directChildEval as never, [pool, OPTION_ROLES] as never)) return true;
    }
    return false;
  } finally { for (const handle of owned) await handle.dispose().catch(() => undefined); }
}

async function verifyCustomSelectionPw(root: OptionHandle, target: OptionHandle, frame: Page | FrameLocator, hit: { role: string; name: string; id: string }, intermediate: boolean, deadline: number): Promise<void> {
  let verifyTarget = target;
  let reopened = false;
  let failed = false;
  let verification: ReturnType<typeof selectionVerification>;
  const owned: OptionHandle[] = [];
  try {
    for (;;) {
      const state = await assertOptionIdentityPw(verifyTarget, frame, hit.role, hit.name, hit.id);
      if (state.connected) {
        verification = selectionVerification(state, intermediate, false);
        if (verification?.result !== true && intermediate) verification = selectionVerification(state, true, await childPoolVisiblePw(verifyTarget, frame));
        if (verification?.result === true) return;
      }
      const rootState = await root.evaluate(rootStateEval as unknown as (el: Element) => SelectRootState | null);
      if (!rootState?.connected) throw new Error('SELECTION_TARGET_CHANGED: 提交后原选择根被替换');
      if (!reopened && rootState.role === 'combobox' && rootState.ariaExpanded === false && hit.id) {
        reopened = true;
        await root.focus();
        const focused = await root.evaluate(rootStateEval as unknown as (el: Element) => SelectRootState | null);
        if (focused?.ariaExpanded !== true) await root.press('ArrowDown', { timeout: Math.max(1, deadline - Date.now()) });
        const locator = await idLocatorPw(root, frame, hit.id);
        if (await locator.count() === 0) {
          const meta = await root.evaluate(poolsMetaEval as unknown as (el: Element) => { scope: 'related' | 'page'; selectors: string[]; self: boolean });
          if (meta.scope === 'related' && (meta.self || meta.selectors.length === 1)) {
            const pool = meta.self ? root : await frame.locator(meta.selectors[0]).elementHandle({ timeout: Math.max(1, deadline - Date.now()) }) as OptionHandle | null;
            if (pool) {
              if (pool !== root) owned.push(pool);
              const read = await keyboardReaderPw(root, pool, frame, undefined);
              let reached: Awaited<ReturnType<typeof reachKeyboardSelection>>;
              try { reached = await reachKeyboardSelection(hit.name, read, key => root.press(key, { timeout: Math.max(1, deadline - Date.now()) }), deadline); }
              catch (error) {
                if (/OPTION_NOT_FOUND|NOT_INTERACTABLE/.test((error as Error).message)) throw new Error('INSUFFICIENT_EVIDENCE: 重开后无法观察原选项提交状态', { cause: error });
                throw error;
              }
              if (reached.id !== hit.id || reached.role !== hit.role || reached.name !== hit.name) throw new Error('SELECTION_TARGET_CHANGED: 重开验证未能确认原标准 id');
            }
          }
        }
        const count = await locator.count();
        if (count > 1) throw new Error('INSUFFICIENT_EVIDENCE: 重开后原标准 id 不唯一');
        const replacement = count === 1 ? await locator.elementHandle({ timeout: Math.max(1, deadline - Date.now()) }) as OptionHandle | null : null;
        if (replacement) { owned.push(replacement); verifyTarget = replacement; }
      }
      if (Date.now() >= deadline) throw new Error((verification?.result === false ? 'SELECTION_NOT_COMMITTED' : 'INSUFFICIENT_EVIDENCE') + ': 选择后未观察到原项标准 selected/checked' + (intermediate ? '/expanded/下一层连接' : '') + ' 事实');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  } catch (error) { failed = true; throw error; }
  finally {
    for (const handle of owned) await handle.dispose().catch(() => undefined);
    if (reopened) {
      try {
        await root.focus();
        await root.press('Escape', { timeout: Math.max(1, deadline - Date.now()) });
        const restored = await root.evaluate(rootStateEval as unknown as (el: Element) => SelectRootState | null);
        if (restored?.ariaExpanded !== false) throw new Error('INSUFFICIENT_EVIDENCE: 重开验证后未能恢复原关闭状态');
      } catch (error) { if (!failed) throw error; console.error('❌ 选择验证状态恢复:', error); }
    }
  }
}

async function pickCustomOptionPw(
  root: PlaywrightLocator,
  frame: Page | FrameLocator,
  wanted: string,
  category: boolean,
  parent: OptionHandle | undefined,
  intermediate: boolean,
  budget: () => number,
): Promise<PwPick> {
  const deadline = Date.now() + Math.min(budget(), POOL_WAIT_MS);
  const original = await root.elementHandle({ timeout: budget() }) as OptionHandle | null;
  if (!original) throw new Error('NOT_INTERACTABLE: 原选择根不存在');
  let keep: OptionHandle | undefined;
  try {
    for (;;) {
      const round = await resolveRoundPw(root, frame, category, parent);
      try {
        const state = await original.evaluate(rootStateEval as unknown as (el: Element) => SelectRootState | null);
        if (!state?.connected || state.disabled || !await root.evaluate((element, expected) => element === expected, original)) throw new Error('INSUFFICIENT_EVIDENCE: 原选择根被替换或禁用');
        let hit: PwCandidate | undefined;
        let keyboard = false;
        let readKeyboard: (() => Promise<KeyboardSnapshot>) | undefined;
        if (state.activeDescendantId && round.scope === 'related' && round.pools.length === 1) {
          const rootPools = await resolvePoolsPw(root, frame);
          const currentPool = rootPools.locators.length === 1 ? await rootPools.locators[0].elementHandle() as OptionHandle | null : null;
          if (currentPool) {
            round.owned.push(currentPool);
            if (rootPools.scope === 'related' && await currentPool.evaluate((element, layer) => element === layer || element.contains(layer), round.pools[0].handle)) {
              await original.focus();
              readKeyboard = await keyboardReaderPw(original, currentPool, frame, category ? round.scopeRoots[0] : undefined);
              const reached = await reachKeyboardSelection(wanted, readKeyboard, key => original.press(key, { timeout: Math.max(1, deadline - Date.now()) }), deadline);
              const locator = await idLocatorPw(original, frame, reached.id);
              const handle = await locator.elementHandle({ timeout: Math.max(1, deadline - Date.now()) }) as OptionHandle | null;
              if (!handle) throw new Error('SELECTION_TARGET_CHANGED: 导航后原标准 id 已缺席');
              round.owned.push(handle);
              await assertOptionIdentityPw(handle, frame, reached.role, reached.name, reached.id);
              hit = { role: reached.role, name: reached.name, disabled: false, selected: false, handle };
              keyboard = true;
            }
          }
        }
        if (!hit) {
          const candidates = await poolCandidatesPw(round, category);
          let index: number;
          try { index = chooseOptionIndex(candidates.map(candidate => candidate.name), wanted); }
          catch (error) {
            if ((error as Error).message.startsWith('OPTION_NOT_FOUND') && Date.now() < deadline) {
              await new Promise(resolve => setTimeout(resolve, 50));
              continue;
            }
            throw error;
          }
          hit = candidates[index];
          const fresh = await poolCandidatesPw(round, category);
          const exact = fresh.filter(candidate => candidate.role === hit!.role && candidate.name === hit!.name);
          if (exact.length !== 1) throw new Error('OPTION_AMBIGUOUS: 提交前同池角色与完整名称不唯一');
          if (!await hit.handle.evaluate((element, expected) => element === expected, exact[0].handle)) throw new Error('SELECTION_TARGET_CHANGED: 提交前原选项被同名节点替换');
        }
        const current = await hit.handle.evaluate(optionStateEval as unknown as (el: Element) => OptionState);
        await assertOptionIdentityPw(hit.handle, frame, hit.role, hit.name, current.id);
        const disabled = await hit.handle.evaluate(optionDisabledEval as unknown as (el: Element) => string | null);
        if (hit.disabled || disabled) throw new Error('NOT_INTERACTABLE: 选项 "' + wanted + '" 已禁用');
        const visible = await hit.handle.evaluate(visibleEval as unknown as (el: Element) => boolean);
        if (!visible && !keyboard) throw new Error('NOT_INTERACTABLE: 零布局项没有唯一声明根与真实 active descendant 证据');
        let before = selectionVerification(current, intermediate, false);
        if (before?.result !== true && intermediate) before = selectionVerification(current, true, await childPoolVisiblePw(hit.handle, frame));
        if (before?.result !== true) {
          if (Date.now() >= deadline) throw new Error('INSUFFICIENT_EVIDENCE: 提交前选择预算耗尽');
          const currentRound = await resolveRoundPw(root, frame, category, parent);
          try {
            if (currentRound.pools.length !== round.pools.length) throw new Error((readKeyboard ? 'INSUFFICIENT_EVIDENCE' : 'SELECTION_TARGET_CHANGED') + ': 提交前原池关联已变化');
            for (let index = 0; index < round.pools.length; index++) if (!await currentRound.pools[index].handle.evaluate((element, expected) => element === expected, round.pools[index].handle)) throw new Error((readKeyboard ? 'INSUFFICIENT_EVIDENCE' : 'SELECTION_TARGET_CHANGED') + ': 提交前原池已被替换');
          } finally { for (const handle of currentRound.owned) await handle.dispose().catch(() => undefined); }
          const currentRoot = await original.evaluate(rootStateEval as unknown as (el: Element) => SelectRootState | null);
          if (!currentRoot?.connected || currentRoot.disabled || !await root.evaluate((element, expected) => element === expected, original)) throw new Error('NOT_INTERACTABLE: 提交前选择根已禁用或被替换');
          if (readKeyboard) {
            const snapshot = await readKeyboard();
            const active = snapshot.options.find(option => option.id === current.id);
            if (snapshot.active_id !== current.id || !active || active.role !== hit.role || active.name !== hit.name) throw new Error('SELECTION_TARGET_CHANGED: 提交前原 id、角色或完整名称不一致');
          }
          if (visible) await hit.handle.click({ timeout: Math.max(1, deadline - Date.now()) });
          else {
            await original.press('Enter', { timeout: Math.max(1, deadline - Date.now()) });
          }
        }
        await verifyCustomSelectionPw(original, hit.handle, frame, { role: hit.role, name: hit.name, id: current.id }, intermediate, deadline);
        keep = hit.handle;
        return { name: hit.name, target: hit.handle };
      } finally {
        for (const handle of round.owned) if (handle !== keep) await handle.dispose().catch(() => undefined);
      }
    }
  } finally { await original.dispose().catch(() => undefined); }
}

export async function executeAction(
  page: Page,
  context: BrowserContext,
  step: Step,
  vctx: ValueContext,
  reqTracker: RequestTracker,
  fixtureDir: string,
  hoverState: HoverState | undefined,
  recordInput: RecordInputCallback,
  observed?: (fact: ActionObservation) => void,
): Promise<ActionResult> {
  hoverState ??= {};
  const action = step.action;
  const args = (step.args ?? {}) as Record<string, unknown>;
  // R1/LC4：必需输入中央守卫（与 StepSchema 超级 refine 同源 shared/step-input）——
  // 在任何日志/定位/DOM 副作用之前拒绝，失败抛带 step/action 的错误
  const inputErrors = validateStepInputs(step);
  if (inputErrors.length > 0) {
    throw new Error(`❌ 必需输入缺失 (step: ${step.id}, action: ${action}): ${inputErrors.join('; ')}`);
  }
  // §8 输出白名单：无输出 kind 带 save_as 在真实写入前拒绝（不伪造空串）
  if (step.save_as && !ACTION_OUTPUT_KINDS.includes(action)) {
    throw new Error(`❌ ${action} 无输出值，不支持 save_as (step: ${step.id})`);
  }

  // fallback 动作入口一次 30s 原生预算（沿用 runner Page 原生默认，不用 step.wait_timeout_ms）：
  // 定位选择与原生调用共用同一 deadline；无 fallback 维持旧默认不显式传 timeout
  // （options=undefined 与省略 options 在 Playwright 中默认语义一致）
  const hasFallback = (step.fallback?.length ?? 0) > 0;
  const deadline = Date.now() + 30_000;
  // 耗尽即抛错，不把 0 当无限哨兵传给 Playwright
  const remaining = (): number => {
    const rem = deadline - Date.now();
    if (rem <= 0) throw new Error(`❌ 预算耗尽：无法继续 ${action} 动作 (step: ${step.id})`);
    return rem;
  };
  const actionOptions = (): { timeout: number } | undefined => (hasFallback ? { timeout: remaining() } : undefined);
  const recordTarget = (target: import('./locator.js').LocatorObservation): void => { observed?.({ target }); };
  const resolveValue = (value: Value): string => {
    const resolved = vctx.resolve(value);
    observed?.({ input: resolved, valueSource: value });
    return resolved;
  };

  let interactionLocator: PlaywrightLocator | undefined;
  if (hoverState.target) {
    if (['open', 'hover', 'back', 'refresh', 'switch_tab'].includes(action) || !step.locator || hoverState.page !== page) {
      await clearHover(hoverState);
    } else {
      interactionLocator = await resolveLocatorWithFallback(page, step.locator, step.fallback, step.frame, hasFallback ? remaining() : undefined, recordTarget);
      const target = await interactionLocator.elementHandle({ timeout: remaining() });
      if (!target) throw new Error('hover 关联判断缺少实际目标');
      let related: boolean;
      try {
        related = await hoverState.target.evaluate(isHoverRelated, target);
      } finally {
        await target.dispose();
      }
      if (!related) await clearHover(hoverState);
    }
  }
  const actionLocator = (): Promise<PlaywrightLocator> => interactionLocator
    ? Promise.resolve(interactionLocator)
    : resolveLocatorWithFallback(page, step.locator, step.fallback, step.frame, hasFallback ? remaining() : undefined, recordTarget);

  switch (action) {
    case 'open': {
      // 中央守卫保证 step.value 存在（open 必需 Value，不回退 args.url 槽）
      const url = resolveValue(step.value!);
      // URL 守卫（已审合同）：一次 resolve 后按实际替换事实判定，真改写即固定错误码，
      // 在任何 URL 日志/goto 前失败；非改写继续用原串，返回同一 resolvedValue
      const evidence = redactUrlWithEvidence(url);
      if (evidence.redacted) throw new Error(AUTH_DATA_NOT_REPLAYABLE);
      console.log(`⏳ 打开页面: ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      return { resolvedValue: url };
    }
    case 'click': {
      const loc = await actionLocator();
      console.log(`🖱️ 点击: ${step.intent}`);
      await loc.click(actionOptions());
      return {};
    }
    case 'double_click': {
      const loc = await actionLocator();
      console.log(`🖱️ 双击: ${step.intent}`);
      const handle = await loc.elementHandle(actionOptions() ?? {});
      if (!handle) throw new Error(`❌ 双击目标未解析到元素 (step: ${step.id})`);
      try {
        for (const clickCount of [1, 2] as const) {
          await handle.click({ ...(actionOptions() ?? {}), trial: true });
          const box = await handle.boundingBox();
          if (!box) throw new Error(`❌ 双击目标没有可点击布局盒子 (step: ${step.id})`);
          const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
          await page.mouse.move(point.x, point.y);
          const moved = await handle.boundingBox();
          if (!moved) throw new Error(`❌ 双击目标鼠标移动后失去布局盒子 (step: ${step.id})`);
          if (moved.x + moved.width / 2 !== point.x || moved.y + moved.height / 2 !== point.y) {
            throw new Error(`❌ 双击目标鼠标移动后位置变化 (step: ${step.id})`);
          }
          const hit = await handle.evaluate((el) => {
            if (!el.isConnected) return false;
            const r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) return false;
            const target = el.ownerDocument.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            if (!target) return false;
            const contains = (owner: Element, node: Element): boolean => {
              if (owner === node || owner.contains(node)) return true;
              for (let cur: Element | null = owner; cur;) {
                const root = cur.getRootNode();
                cur = cur.parentElement || (root instanceof ShadowRoot ? root.host : null);
                if (cur === node) return true;
              }
              return false;
            };
            return contains(el, target);
          });
          if (!hit) throw new Error(`❌ 双击目标 dispatch 点实际命中非原元素 (step: ${step.id})`);
          await page.mouse.down({ button: 'left', clickCount });
          await page.mouse.up({ button: 'left', clickCount });
        }
      } finally {
        await handle.dispose().catch(() => undefined);
      }
      return {};
    }
    case 'type': {
      const loc = await actionLocator();
      // 中央守卫保证 step.value 存在（不回退 args.text 槽）
      const val = resolveValue(step.value!);
      // 输入日志只打印动作与 step.id，不打印 val（原值不入 stdout）
      console.log(`📝 输入 (step: ${step.id})`);
      await writeValue(page, loc, { value: val, mode: 'type' }, recordInput, actionOptions());
      return { resolvedValue: val };
    }
    case 'fill': {
      const loc = await actionLocator();
      // 中央守卫保证 step.value 存在（不回退 args.text 槽）
      const val = resolveValue(step.value!);
      console.log(`📝 填写 (step: ${step.id})`);
      await writeValue(page, loc, { value: val, mode: 'fill' }, recordInput, actionOptions());
      return { resolvedValue: val };
    }
    case 'press': {
      const key = String(args.key ?? '');
      console.log(`🖱️ 按键: ${key}`);
      if (step.locator) {
        const loc = await actionLocator();
        await loc.press(key, actionOptions());
      } else {
        await page.keyboard.press(key);
      }
      return {};
    }
    case 'select': {
      const loc = await actionLocator();
      // 中央守卫保证 step.value 存在（不回退 args.option 槽）
      const val = resolveValue(step.value!);
      console.log(`📝 选择 (step: ${step.id})`);
      // 共源原生 select（单次 evaluate，透传预算 options）；非原生走 custom 同池合同；
      // resolvedValue 保留真正 used-input wanted，不换 picked label
      const picked = await loc.evaluate(selectEval as unknown as (el: Element, arg: string) => string | null, val, actionOptions());
      if (picked === null) {
        const filterText = args.filter_text !== undefined ? String(args.filter_text) : undefined;
        // custom：prepare（根状态/池解析/展开/filter）→ pick(category=false, parent=undefined)
        const frame = resolveFrame(page, step.frame);
        await prepareCustomSelectionPw(page, loc, frame, filterText, remaining);
        const { target } = await pickCustomOptionPw(loc, frame, val, false, undefined, false, remaining);
        await target.dispose().catch(() => undefined);
      }
      return { resolvedValue: val };
    }
    case 'choose': {
      const loc = await actionLocator();
      const options = Array.isArray(args.options) ? args.options.map((o) => String(o)) : [];
      if (options.length === 0) throw new Error(`choose 需要非空 options 输入 (step: ${step.id})`);
      const filterText = args.filter_text !== undefined ? String(args.filter_text) : undefined;
      console.log(`📝 选择(choose) (step: ${step.id})`);
      // 原生 multiple：请求项全部真实选中且保留其他已选项（原子写入）；单选多项写入前拒绝
      const native = await loc.evaluate(readNativeEval as unknown as (el: Element) => { multiple: boolean; labels: string[]; disabled: boolean[] } | null, null, actionOptions());
      if (native !== null) {
        const indexes: number[] = [];
        for (const opt of options) {
          const index = chooseOptionIndex(native.labels, opt);
          if (native.disabled[index]) throw new Error(`NOT_INTERACTABLE: 选项 "${opt}" 已禁用（disabled/optgroup/aria-disabled 祖先），不能选择`);
          indexes.push(index);
        }
        if (!native.multiple && options.length > 1) {
          throw new Error('OPTION_MULTIPLE_ON_SINGLE: 单选下拉框收到多项选择输入，已在写入前拒绝');
        }
        const picked = await loc.evaluate(applyNativeEval as unknown as (el: Element, arg: { labels: string[]; indexes: number[]; add: boolean }) => string[], { labels: native.labels, indexes, add: true }, actionOptions());
        return { outputValue: JSON.stringify(picked) };
      }
      // custom：每项 prepare（filter 仅首项）→ pick → 消费 name 后释放 handle
      const frame = resolveFrame(page, step.frame);
      const picked: string[] = [];
      try {
        for (let i = 0; i < options.length; i++) {
          await prepareCustomSelectionPw(page, loc, frame, i === 0 ? filterText : undefined, remaining);
          const res = await pickCustomOptionPw(loc, frame, options[i], false, undefined, false, remaining);
          picked.push(res.name);
          await res.target.dispose().catch(() => undefined);
        }
      } catch (error) {
        throw new Error((error as Error).message + ' (committed_picks=' + JSON.stringify(picked) + ')', { cause: error });
      }
      return { outputValue: JSON.stringify(picked) };
    }
    case 'date': {
      // 基础版：fill ISO 日期字符串（中央守卫保证 step.value 存在，不回退 args.value 槽）
      const loc = await actionLocator();
      const val = resolveValue(step.value!);
      console.log(`📝 日期 (step: ${step.id})`);
      await writeValue(page, loc, { value: val, mode: 'fill' }, recordInput, actionOptions());
      return { resolvedValue: val };
    }
    case 'category': {
      const loc = await actionLocator();
      const path = Array.isArray(args.path) ? args.path.map(String) : [];
      if (path.length === 0) throw new Error(`category 需要非空 path 输入 (step: ${step.id})`);
      console.log(`🖱️ 分类选择: ${path.join(' > ')}`);
      const native = await loc.evaluate(readNativeEval as unknown as (el: Element) => { multiple: boolean; labels: string[]; disabled: boolean[] } | null, null, actionOptions());
      if (native !== null) throw new Error('category 目标是原生下拉框（无级联池），不支持多级类目选择');
      // 仅首层 prepare；下一层来自上次实际点击 parent（其声明子池或实际子树），逐级真实 click；
      // 保留最近 parent handle 供下一层关系校验，成功替换后释放旧 handle
      const frame = resolveFrame(page, step.frame);
      const picked: string[] = [];
      let parent: OptionHandle | undefined;
      try {
        await prepareCustomSelectionPw(page, loc, frame, undefined, remaining);
        for (let index = 0; index < path.length; index++) {
          const res = await pickCustomOptionPw(loc, frame, path[index], true, parent, index < path.length - 1, remaining);
          picked.push(res.name);
          if (parent) await parent.dispose().catch(() => undefined);
          parent = res.target;
        }
      } catch (error) {
        throw new Error((error as Error).message + ' (committed_picks=' + JSON.stringify(picked) + ')', { cause: error });
      } finally {
        if (parent) await parent.dispose().catch(() => undefined);
      }
      return { outputValue: JSON.stringify(picked) };
    }
    case 'upload': {
      const loc = await actionLocator();
      const files = Array.isArray(args.files) ? args.files.map(String) : [];
      const uploadDir = fs.mkdtempSync(path.join(fixtureDir, '.upload-'));
      const cleanup = () => {
        try {
          fs.rmSync(uploadDir, { recursive: true, force: true });
        } catch (error) {
          console.error('❌ upload 临时目录清理失败:', error);
        }
      };
      context.once('close', cleanup);
      try {
        const paths = files.map((file, index) => {
          const dir = path.join(uploadDir, String(index));
          fs.mkdirSync(dir);
          const staged = path.join(dir, file.slice(65));
          fs.copyFileSync(path.resolve(fixtureDir, file), staged);
          return staged;
        });
        console.log(`📝 上传: ${paths.join(', ')}`);
        await loc.setInputFiles(paths, actionOptions());
        return {};
      } catch (error) {
        context.off('close', cleanup);
        cleanup();
        throw error;
      }
    }
    case 'fill_form': {
      const fields = (args.fields ?? {}) as Record<string, Value>;
      const fieldLocators = (args.field_locators ?? {}) as Record<string, unknown>;
      const order = Array.isArray(args.field_order) ? args.field_order.map(String) : [];
      if (order.length === 0) throw new Error(`❌ fill_form 缺 field_order 执行事实 (step: ${step.id})`);
      console.log(`📝 填表单: ${order.join(', ')}`);
      // §4：严格按 field_order 依次 resolveLocator(page, field_locators[name], step.frame)
      // + vctx.resolve + 共源 writeValue；不调用 page.getByLabel、不重排（数字 key 的
      // Object.entries 顺序不是录制时真实写入顺序）
      const used: Array<[string, string]> = [];
      for (const name of order) {
        const locator = fieldLocators[name] as Locator | undefined;
        if (!locator) throw new Error(`❌ fill_form 字段 "${name}" 缺 field_locators (step: ${step.id})`);
        const loc = resolveLocator(page, locator, step.frame);
        const val = fields[name];
        if (val === undefined) throw new Error(`❌ fill_form 字段 "${name}" 缺 fields 值声明 (step: ${step.id})`);
        const resolved = vctx.resolve(val);
        observed?.({ target: { candidate: locator }, input: { field: name, value: resolved }, valueSource: val });
        await writeValue(page, loc, { value: resolved, mode: 'fill' }, recordInput);
        used.push([name, resolved]);
      }
      // §8：收集本次实际 used input 后产与 Source 相同 JSON 的 outputValue
      return { outputValue: JSON.stringify(Object.fromEntries(used)) };
    }
    case 'hover': {
      if (!step.locator) throw new Error(`hover action requires a locator (step: ${step.id})`);
      const loc = await resolveLocatorWithFallback(page, step.locator, step.fallback, step.frame, hasFallback ? remaining() : undefined, recordTarget);
      console.log(`🖱️ 悬停: ${step.intent}`);
      const target = await loc.elementHandle({ timeout: remaining() });
      if (!target) throw new Error('hover 未取得实际目标');
      try {
        await target.evaluate(hoverEnter);
      } catch (error) {
        await target.dispose().catch(() => undefined);
        throw error;
      }
      hoverState.target = target;
      hoverState.page = page;
      return {};
    }
    case 'scroll': {
      const direction = args.direction != null ? String(args.direction) : undefined;
      const amount = Number(args.amount ?? 600);
      // 有 locator 无 direction：共源 centerElement 滚到视口中心
      if (step.locator && !direction) {
        const loc = await actionLocator();
        console.log(`🖱️ 滚动到元素: ${step.intent}`);
        // §8：centerElement 返回真实 moved（同一 DOM 调用前后坐标比较，已居中为 false）
        const moved = await loc.evaluate(centerElement as unknown as (el: Element) => boolean, undefined, actionOptions());
        return { outputValue: String(moved) };
      }
      // 有 locator + direction：共源 scrollElement 滚最近同轴可滚祖先；found=false 真实失败，边界 moved=false 是成功
      if (step.locator && direction) {
        const loc = await actionLocator();
        console.log(`🖱️ 滚动元素: ${direction}`);
        const axis = direction === 'up' || direction === 'down' ? 'y' : 'x';
        const sign = direction === 'up' || direction === 'left' ? -1 : 1;
        const input: ScrollInput = { axis, delta: amount * sign };
        const result = await loc.evaluate(scrollElement as unknown as (el: Element, arg: ScrollInput) => { found: boolean; moved: boolean }, input, actionOptions());
        if (!result.found) throw new Error(`目标及其祖先在 ${axis} 轴上无可滚动容器，scroll 未生效`);
        return { outputValue: String(result.moved) };
      }
      // 无 locator：共源 scrollWindow 滚整页（window.scrollBy，不用 mouse.wheel）；
      // 有 frame 声明时在 frame realm 执行同一 scrollWindow（Source 用 frame view 滚 iframe window），主文档不动
      const dir = direction ?? 'down';
      const axis = dir === 'up' || dir === 'down' ? 'y' : 'x';
      const sign = dir === 'up' || dir === 'left' ? -1 : 1;
      const input: ScrollInput = { axis, delta: amount * sign };
      console.log(`🖱️ 滚动整页: ${dir}`);
      if (step.frame?.length) {
        const moved = await resolveFrame(page, step.frame).locator('html').evaluate(scrollEval as unknown as (el: Element, arg: ScrollInput) => boolean, input);
        return { outputValue: String(moved) };
      } else {
        const moved = await page.evaluate(scrollWindow as unknown as (arg: ScrollInput) => boolean, input);
        return { outputValue: String(moved) };
      }
    }
    case 'switch_tab': {
      const pages = await reqTracker.ownedPages();
      const urlContains = args.url_contains !== undefined ? String(args.url_contains) : undefined;
      const index = args.index !== undefined ? Number(args.index) : undefined;
      const target = urlContains
        ? pages.find((candidate) => candidate.url().includes(urlContains))
        : index !== undefined ? pages[index] : pages.filter((candidate) => candidate !== page).at(-1);
      if (!target) throw new Error('NOT_FOUND: 没有符合选择条件的存活非 active tab');
      await reqTracker.attach(target);
      const url = target.url();
      if (redactUrlWithEvidence(url).redacted) throw new Error(AUTH_DATA_NOT_REPLAYABLE);
      console.log(`⏳ 切换到 tab[${pages.indexOf(target)}]`);
      return { page: target, outputValue: url };
    }
    case 'back': {
      console.log(`🖱️ 后退`);
      await page.goBack();
      // §8：动作成功结束时读实际当前 URL；含认证来源字段（实际被改写）拒绝，不返回原 URL
      const url = page.url();
      const evidence = redactUrlWithEvidence(url);
      if (evidence.redacted) throw new Error(AUTH_DATA_NOT_REPLAYABLE);
      return { outputValue: url };
    }
    case 'refresh': {
      console.log(`🖱️ 刷新`);
      await page.reload();
      // §8：动作成功结束时读实际当前 URL；含认证来源字段拒绝
      const url = page.url();
      const evidence = redactUrlWithEvidence(url);
      if (evidence.redacted) throw new Error(AUTH_DATA_NOT_REPLAYABLE);
      return { outputValue: url };
    }
    default: {
      throw new Error(`unsupported action: ${action}`);
    }
  }
}
