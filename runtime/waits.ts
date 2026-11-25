/**
 * wait 数组执行：api / element visible+hidden / text / url / dom_quiet。
 * 按数组顺序、共同截止等待；结束时通过 AbortController 收尾 tracker 等待。
 * timeout 为本次 waits 阶段的剩余预算（相对 ms）。
 */
import type { Page, FrameLocator } from '@playwright/test';
import type { Wait, Frame } from './types.js';
import type { RequestTracker } from './request-tracker.js';
import { resolveLocator, resolveFrame } from './locator.js';

export async function executeWaits(
  page: Page,
  waits: Wait[],
  reqTracker: RequestTracker,
  timeout: number,
  frames?: Frame[],
): Promise<void> {
  if (!waits?.length) return;
  const ac = new AbortController();
  const signal = ac.signal;
  try {
    const deadline = Date.now() + timeout;
    for (const wait of waits) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('❌ 预算耗尽：无法开始下一等待');
      await executeWait(page, wait, reqTracker, remaining, signal, frames);
      if (Date.now() >= deadline) throw new Error('❌ 预算耗尽：等待结果已超时');
    }
  } finally {
    ac.abort();
  }
}

async function executeWait(
  page: Page,
  w: Wait,
  reqTracker: RequestTracker,
  timeout: number,
  signal: AbortSignal,
  frames?: Frame[],
): Promise<void> {
  // api：响应体完成驱动
  if ('api' in w) {
    await reqTracker.waitForComplete(page, w.api, timeout, signal);
    return;
  }

  // 非 API 原生等待：零预算不得传给 Playwright（其无限超时哨兵）
  if (timeout <= 0) {
    throw new Error(`❌ 预算耗尽：无法开始 ${('element' in w ? 'element' : 'text' in w ? 'text' : 'url' in w ? 'url' : 'dom_quiet')} 等待`);
  }

  // element visible/hidden（frame 声明时走 frame 作用域）
  if ('element' in w) {
    const loc = resolveLocator(page, w.element, frames, w.state === 'attached' || w.state === 'detached');
    await loc.waitFor({ state: w.state, timeout });
    return;
  }

  // text（frame 声明时走 frame 作用域）
  if ('text' in w) {
    const scope = resolveFrame(page, frames);
    const deadline = Date.now() + timeout;
    const text = w.text;
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`❌ 预算耗尽：等待文本 "${text}" 未出现`);
      const bodyText = await scope.locator('body').innerText({ timeout: remaining });
      if (Date.now() >= deadline) throw new Error(`❌ 预算耗尽：等待文本 "${text}" 未出现`);
      if (bodyText.includes(text)) break;
      const sleepRem = deadline - Date.now();
      if (sleepRem <= 0) throw new Error(`❌ 预算耗尽：等待文本 "${text}" 未出现`);
      await new Promise(r => setTimeout(r, Math.min(100, sleepRem)));
    }
    return;
  }

  // url：无 frame 走主 Page；有 frame 走 owner → contentFrame → 真实 Frame.waitForURL，不回退主 Page
  if ('url' in w) {
    if (!frames?.length) {
      await page.waitForURL(`**${w.url.contains}**`, { timeout });
      return;
    }
    // 进时记一次 deadline，owner 解析后及 contentFrame 后重算剩余，耗尽拒绝（不把 0 传给 Playwright）
    const deadline = Date.now() + timeout;
    // frames 非空且 resolveFrame 对空描述 throw，返回值必是 FrameLocator
    const fl = resolveFrame(page, frames) as FrameLocator;
    let remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('❌ 预算耗尽：无法解析 frame owner');
    const handle = await fl.owner().elementHandle({ timeout: remaining });
    try {
      // owner 解析后、contentFrame 前重算剩余；耗尽拒绝，不再调用 contentFrame
      remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('❌ 预算耗尽：无法获取 frame contentFrame');
      const frame = await handle.contentFrame();
      if (!frame) throw new Error('❌ frame owner 无 contentFrame（不是 iframe），不回退主 Page');
      remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('❌ 预算耗尽：无法开始 frame url 等待');
      await frame.waitForURL(`**${w.url.contains}**`, { timeout: remaining });
    } finally {
      await handle.dispose(); // 释放本次 handle
    }
    return;
  }

  // dom_quiet
  if ('dom_quiet' in w) {
    await waitForDomQuiet(page, w.dom_quiet.ms, timeout);
    return;
  }

  throw new Error(`unsupported wait: ${JSON.stringify(w)}`);
}

/** MutationObserver 注入：ms 内无 mutation 则 resolve。
 *  quietMs 是稳定条件，timeoutMs 是本次等待的剩余预算（替代原 ms*2 硬编码 deadline）。 */
async function waitForDomQuiet(page: Page, quietMs: number, timeoutMs: number): Promise<void> {
  await page.waitForFunction(
    (qMs) => {
      return new Promise<boolean>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => resolve(true), qMs);
        const observer = new MutationObserver(() => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => {
            observer.disconnect();
            resolve(true);
          }, qMs);
        });
        observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
        // 如果 DOM 已稳定（无 mutation），timer 直接到期
      });
    },
    quietMs,
    { timeout: timeoutMs },
  );
}
