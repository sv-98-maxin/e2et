/**
 * IR Locator → Playwright Locator 转换。
 * 支持 role/label/text/testid/css/row/within/fallback/frame。
 */
import type { Page, Locator as PlaywrightLocator, FrameLocator, Frame as PlaywrightFrame } from '@playwright/test';
import type { Locator, Frame } from './types.js';

type AnyLocator = PlaywrightLocator;

export interface LocatorObservation {
  candidate: Locator;
  candidateIndex: number;
  matches?: number;
}

/** frame 声明 → FrameLocator 作用域。无声明返回主 Page；空描述（FrameSchema 允许 {}）无 selector 可解析，
 *  静默落回主文档会假满足，直接拒绝。 */
export function resolveFrame(page: Page, frames?: Frame[]): FrameLocator | Page {
  if (!frames?.length) return page;
  let frame: FrameLocator | Page = page;
  for (const f of frames) {
    const selector = f.selector ?? (f.url_contains ? `iframe[src*="${f.url_contains}"]` : f.name ? `iframe[name="${f.name}"]` : '');
    if (!selector) throw new Error('❌ frame 声明无法解析出 frame 作用域（空 frame 描述）');
    frame = (frame as Page).frameLocator(selector);
  }
  return frame;
}

export async function resolveFrameObject(page: Page, frames: Frame[], timeout = 30_000): Promise<PlaywrightFrame> {
  if (!frames.length) throw new Error('❌ 空 frame 描述');
  const deadline = Date.now() + timeout;
  let current = page.mainFrame();
  for (const desc of frames) {
    if (desc.selector) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('❌ frame 定位预算耗尽');
      const owner = await current.locator(desc.selector).elementHandle({ timeout: remaining });
      try {
        const child = owner ? await owner.contentFrame() : null;
        if (!child || child.isDetached() || child.parentFrame() !== current) {
          throw new Error(`❌ frame selector 未命中实际子 frame: ${desc.selector}`);
        }
        current = child;
      } finally {
        await owner?.dispose();
      }
    } else {
      if (!desc.name && !desc.url_contains) throw new Error('❌ 空 frame 描述');
      const hits = current.childFrames().filter((child) =>
        (!desc.name || child.name() === desc.name)
        && (!desc.url_contains || child.url().includes(desc.url_contains)));
      if (hits.length !== 1) throw new Error(`❌ frame 描述匹配 ${hits.length} 个实际子 frame，拒绝选择`);
      current = hits[0];
    }
    if (current.isDetached()) throw new Error('❌ frame 已失效');
  }
  return current;
}

export function resolveLocator(
  page: Page,
  loc: Locator,
  frames?: Frame[],
  includeHidden = false,
): AnyLocator {
  const ctx = resolveFrame(page, frames);
  return resolveOne(ctx, loc, includeHidden);
}

function resolveOne(ctx: Page | FrameLocator, loc: Locator, includeHidden: boolean): AnyLocator {
  // row — must check before role (RowLocator can carry role/name fields)
  if ('row' in loc) {
    let result = (ctx as Page).getByRole('row', { includeHidden }).filter({ hasText: loc.row.contains });
    if (loc.role) {
      const opts: Record<string, unknown> = { includeHidden };
      if (loc.name !== undefined) {
        opts.name = loc.name;
        opts.exact = true;
      }
      result = result.getByRole(loc.role as any, opts);
    }
    return result;
  }

  // role
  if ('role' in loc) {
    const opts: Record<string, unknown> = { includeHidden };
    if (loc.name !== undefined) {
      opts.name = loc.name;
      opts.exact = true;
    }
    let result = (ctx as Page).getByRole(loc.role as any, opts);
    if (loc.within) {
      const within = resolveOne(ctx, loc.within as Locator, includeHidden);
      result = result.filter({ has: within });
    }
    return result;
  }

  // label
  if ('label' in loc) {
    return (ctx as Page).getByLabel(loc.label);
  }

  // text
  if ('text' in loc) {
    const text = loc.normalize ? loc.text.normalize('NFC') : loc.text;
    return (ctx as Page).getByText(text);
  }

  // testid
  if ('testid' in loc) {
    return (ctx as Page).getByTestId(loc.testid);
  }

  // css
  if ('css' in loc) {
    return (ctx as Page).locator(loc.css);
  }

  throw new Error(`unsupported locator: ${JSON.stringify(loc)}`);
}

/** or/first 仅作“任一候选已 attached”的等待门；实际操作按候选声明优先级取唯一匹配。
 *  单候选直接返回，保留 Playwright 自身严格匹配/auto-wait。 */
export async function resolveLocatorWithFallback(
  page: Page,
  loc: Locator | undefined,
  fallback: Locator[] | undefined,
  frames?: Frame[],
  timeout = 30_000,
  observed?: (target: LocatorObservation) => void,
): Promise<AnyLocator> {
  const declarations = [...(loc ? [loc] : []), ...(fallback ?? [])];
  const candidates: AnyLocator[] = [];
  if (loc) candidates.push(resolveLocator(page, loc, frames));
  if (fallback?.length) {
    for (const f of fallback) candidates.push(resolveLocator(page, f, frames));
  }
  if (candidates.length === 0) throw new Error('no locator and no fallback provided');
  if (candidates.length === 1) {
    observed?.({ candidate: declarations[0]!, candidateIndex: 0 });
    return candidates[0];
  }

  if (timeout <= 0) throw new Error('❌ 预算耗尽：无法开始 fallback 定位选择');
  const deadline = Date.now() + timeout;
  const union = candidates.reduce((acc, cur) => acc.or(cur));

  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('❌ 预算耗尽：无法开始 fallback 定位等待');
    await union.first().waitFor({ state: 'attached', timeout: remaining });
    for (let i = 0; i < candidates.length; i++) {
      const count = await candidates[i].count();
      if (count === 1) {
        if (deadline - Date.now() <= 0) throw new Error('❌ 预算耗尽：候选唯一但预算已耗尽');
        observed?.({ candidate: declarations[i]!, candidateIndex: i, matches: count });
        return candidates[i];
      }
      if (count > 1) throw new Error(`❌ fallback 定位歧义：候选#${i + 1} 匹配 ${count} 个节点，拒绝选择 first`);
    }
    // 等待门后候选全部消失：同一 deadline 内回到等待，不重置预算
  }
}
