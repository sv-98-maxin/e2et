/**
 * checks 有序执行：9 assert + 2 capture。
 * 共享本次 checks 阶段的剩余预算（按已耗时递减）；fail-fast。
 * assert.api / capture.from_api 走 RequestTracker.waitForComplete（响应体完成驱动）。
 */
import type { Page } from '@playwright/test';
import type { Check, Assert, Capture } from './types.js';
import type { AssertOp, ExpectEntry } from './types.js';
import type { ValueContext } from './value.js';
import type { RequestTracker } from './request-tracker.js';
import { resolveFrame, resolveFrameObject, resolveLocator } from './locator.js';
import { readPageDataSource } from './page-data.js';
import { jsonPath, compare, compareQuery, queryParamValues, REPLAY_EVIDENCE_REDACTED, type AssertOp as SharedAssertOp } from './shared/assertion.js';
import { REDACTED, isSensitiveKey, redactUrlWithEvidence } from './shared/url-safety.js';
import { readComputedStyle, readElementProperty } from './shared/dom-inspection.js';
import { matchConsole, type ConsoleCheck } from './shared/console.js';

export interface AssertionResult {
  kind: string;
  expect: unknown;
  actual: unknown;
  pass: boolean;
  executed: boolean;
}

export async function executeChecks(
  page: Page,
  checks: Check[],
  vctx: ValueContext,
  reqTracker: RequestTracker,
  timeout: number,
  results: AssertionResult[] = [],
): Promise<void> {
  const start = Date.now();
  const list = checks ?? [];
  for (let index = 0; index < list.length; index++) {
    const check = list[index]!;
    const remaining = Math.max(0, timeout - (Date.now() - start));
    let recorded = false;
    try {
      if ('assert' in check) {
        const result = await executeAssert(page, check.assert, vctx, reqTracker, remaining, check.frame);
        results.push(result);
        recorded = true;
        if (!result.pass) throw new Error(`❌ ${result.kind} 断言失败`);
      } else if ('capture' in check) {
        await executeCapture(page, check.capture, vctx, reqTracker, remaining, check.frame);
      }
    } catch (error) {
      if (!recorded) {
        results.push({ kind: kindOf(check), expect: 'assert' in check ? check.assert : check.capture, actual: { error: (error as Error).message }, pass: false, executed: 'assert' in check });
      }
      for (const rest of list.slice(index + 1)) {
        results.push({ kind: kindOf(rest), expect: 'assert' in rest ? rest.assert : rest.capture, actual: null, pass: false, executed: false });
      }
      throw error;
    }
  }
}

function kindOf(check: Check): string {
  if ('assert' in check) return Object.keys(check.assert)[0] ?? 'assert';
  return 'capture';
}

async function executeAssert(
  page: Page,
  assert: Assert,
  vctx: ValueContext,
  reqTracker: RequestTracker,
  timeout: number,
  frames?: import('./types.js').Frame[],
): Promise<AssertionResult> {
  // assert.api（响应体完成驱动：请求可能延后发起，body 真正完成才判定）
  if ('api' in assert) {
    const rec = await reqTracker.waitForComplete(page, assert.api, timeout);
    if (assert.header !== undefined) {
      const actuals: Array<{ path: string; actual: unknown }> = [];
      for (const entry of assert.header as ExpectEntry[]) {
        const name = entry.path.toLowerCase();
        if (isSensitiveKey(name)) throw new Error(`${REPLAY_EVIDENCE_REDACTED}: 响应头名敏感`);
        if (!rec.responseHeaders || !Array.isArray(rec.responseHeadersRedacted)) {
          throw new Error('INSUFFICIENT_EVIDENCE: 响应头安全元数据缺失');
        }
        if (rec.responseHeadersRedacted.includes(name)) {
          throw new Error(`${REPLAY_EVIDENCE_REDACTED}: 响应头已被实际脱敏改写`);
        }
        const has = rec.responseHeaders !== undefined && Object.prototype.hasOwnProperty.call(rec.responseHeaders, name);
        const actual = has ? rec.responseHeaders![name] : undefined;
        if (typeof actual === 'string' && actual.includes(REDACTED)) {
          throw new Error(`${REPLAY_EVIDENCE_REDACTED}: 响应头已被实际脱敏改写`);
        }
        const expected = 'value_ref' in entry ? vctx.resolve({ ref: entry.value_ref })
          : 'value_from_action' in entry ? vctx.resolve({ from_action: entry.value_from_action })
          : entry.value;
        actuals.push({ path: name, actual: actual ?? null });
        if (!compare(mapOp(entry.op), actual, expected)) {
          throw new Error(`❌ header ${name} ${entry.op}: 期望=${JSON.stringify(expected)}，实际=${JSON.stringify(actual)}`);
        }
      }
      console.log(`✅ assert.api header: ${assert.api.path}`);
      return { kind: 'api', expect: { header: assert.header }, actual: actuals, pass: true, executed: true };
    }
    const body = parseBodyOrThrow(rec.body, assert.api.path);
    const actuals: Array<{ path: string; actual: unknown }> = [];
    for (const entry of assert.expect as ExpectEntry[]) {
      const sharedOp = mapOp(entry.op);
      const expected = 'value_ref' in entry ? vctx.resolve({ ref: entry.value_ref })
        : 'value_from_action' in entry ? vctx.resolve({ from_action: entry.value_from_action })
        : entry.value;
      const actual = jsonPath(body, entry.path);
      actuals.push({ path: entry.path, actual: actual === undefined ? null : actual });
      // missing(actual===undefined) 对所有 shared op 返回 false，ne 不假绿
      if (!compare(sharedOp, actual, expected)) {
        throw new Error(`❌ ${entry.path} ${entry.op}: 期望=${JSON.stringify(expected)}，实际=${JSON.stringify(actual)}`);
      }
    }
    console.log(`✅ assert.api: ${assert.api.path}`);
    return { kind: 'api', expect: assert.expect, actual: actuals, pass: true, executed: true };
  }

  // assert.request
  if ('request' in assert) {
    const rec = reqTracker.query(assert.request.path, assert.request.nav, assert.request.call_index);
    if (!rec) throw new Error(`❌ assert.request: 请求 {path:${assert.request.path},nav:${assert.request.nav},call_index:${assert.request.call_index}} 未找到`);
    const actuals: Array<{ path: string; actual: unknown }> = [];
    if (assert.query !== undefined) {
      // 与 Source 同义：来源 URL 实际被脱敏改写就不允许 query 断言，且不回显 raw URL。
      if (redactUrlWithEvidence(rec.url).redacted) throw new Error(`${REPLAY_EVIDENCE_REDACTED}: 来源 URL 已被实际脱敏改写`);
      for (const entry of assert.query as ExpectEntry[]) {
        if (isSensitiveKey(entry.path)) throw new Error(`${REPLAY_EVIDENCE_REDACTED}: query 键名敏感`);
        const sharedOp = mapOp(entry.op);
        const expected = 'value_ref' in entry ? vctx.resolve({ ref: entry.value_ref })
          : 'value_from_action' in entry ? vctx.resolve({ from_action: entry.value_from_action })
          : entry.value;
        const actual = queryParamValues(rec.url, entry.path);
        actuals.push({ path: entry.path, actual: actual ?? null });
        if (!compareQuery(sharedOp, actual, expected)) {
          throw new Error(`❌ ${entry.path} ${entry.op}: 期望=${JSON.stringify(expected)}，实际=${JSON.stringify(actual)}`);
        }
      }
    } else {
      if (!rec.requestBody) throw new Error(`❌ assert.request: ${assert.request.path} 请求体缺失`);
      let body: unknown;
      try { body = JSON.parse(rec.requestBody); } catch { throw new Error(`❌ assert.request: ${assert.request.path} 请求体非合法 JSON`); }
      for (const entry of assert.body as ExpectEntry[]) {
        const sharedOp = mapOp(entry.op);
        const expected = 'value_ref' in entry ? vctx.resolve({ ref: entry.value_ref })
          : 'value_from_action' in entry ? vctx.resolve({ from_action: entry.value_from_action })
          : entry.value;
        const actual = jsonPath(body, entry.path);
        actuals.push({ path: entry.path, actual: actual === undefined ? null : actual });
        if (!compare(sharedOp, actual, expected)) {
          throw new Error(`❌ ${entry.path} ${entry.op}: 期望=${JSON.stringify(expected)}，实际=${JSON.stringify(actual)}`);
        }
      }
    }
    console.log(`✅ assert.request: ${assert.request.path}`);
    return { kind: 'request', expect: assert.query ?? assert.body, actual: actuals, pass: true, executed: true };
  }

  // assert.toast：通过标准 ARIA alert/status 读取可见通知（组件库无关）。
  // 多个通知分别读取文本判断（nth 逐个取，避免 innerText strict-multiple）；
  // 无 ARIA 的组件通知由 Skill 用显式 text/visible 断言编排。
  if ('toast' in assert) {
    guardNativeBudget(timeout, 'toast');
    const expected = assert.toast;
    const notifications = page.getByRole('alert').or(page.getByRole('status'));
    await pollUntil(async (rem) => {
      const count = await notifications.count();
      for (let i = 0; i < count; i++) {
        const text = await notifications.nth(i).innerText({ timeout: rem });
        if (text.includes(expected)) return true;
      }
      return false;
    }, timeout);
    console.log(`✅ assert.toast: ${expected}`);
    return { kind: 'toast', expect: expected, actual: expected, pass: true, executed: true };
  }

  // assert.text
  if ('text' in assert) {
    guardNativeBudget(timeout, 'text');
    const text = vctx.resolve(assert.text.value ?? { literal: assert.text.contains });
    if (!text.trim()) throw new Error('❌ assert.text: 期望值为空或纯空白');
    // within 存在：ctx 是 Locator，用 innerText()；不存在：读主文档/frame body.innerText
    const within = assert.text.within;
    const withinLoc = within ? resolveLocator(page, within, frames) : undefined;
    const bodyLoc = frames?.length ? (resolveFrame(page, frames) as import('@playwright/test').FrameLocator).locator('body') : page.locator('body');
    await pollUntil(async (rem) => {
      const content = withinLoc ? await withinLoc.innerText({ timeout: rem }) : await bodyLoc.innerText({ timeout: rem });
      return content.includes(text);
    }, timeout);
    console.log(`✅ assert.text: ${text}`);
    return { kind: 'text', expect: text, actual: text, pass: true, executed: true };
  }

  // assert.visible
  if ('visible' in assert) {
    guardNativeBudget(timeout, 'visible');
    const loc = resolveLocator(page, assert.visible, frames);
    await loc.waitFor({ state: 'visible', timeout });
    console.log(`✅ assert.visible`);
    return { kind: 'visible', expect: assert.visible, actual: 'visible', pass: true, executed: true };
  }

  // assert.absent
  if ('absent' in assert) {
    guardNativeBudget(timeout, 'absent');
    const loc = resolveLocator(page, assert.absent, frames);
    await loc.waitFor({ state: 'hidden', timeout });
    console.log(`✅ assert.absent`);
    return { kind: 'absent', expect: assert.absent, actual: 'hidden', pass: true, executed: true };
  }

  // assert.table_row
  if ('table_row' in assert) {
    const contains = assert.table_row.contains;
    const allRows = (frames?.length ? (resolveFrame(page, frames) as any) : page).locator('table tr, [role="row"]');
    const total = await allRows.count();
    let matched = 0;
    for (let i = 0; i < total; i++) {
      const rowText = await allRows.nth(i).innerText().catch(() => '');
      if (rowText.includes(contains)) matched++;
    }
    if (matched === 0) throw new Error(`❌ table_row: 未找到包含 "${contains}" 的行`);
    if (assert.table_row.count !== undefined && matched !== assert.table_row.count) {
      throw new Error(`❌ table_row: 期望 ${assert.table_row.count} 行，实际 ${matched} 行`);
    }
    console.log(`✅ assert.table_row: ${matched} 行匹配 "${contains}"`);
    return { kind: 'table_row', expect: assert.table_row, actual: { matched }, pass: true, executed: true };
  }

  // assert.field_value
  if ('field_value' in assert) {
    guardNativeBudget(timeout, 'field_value');
    const expected = vctx.resolve(assert.field_value.value);
    const fv = assert.field_value;
    // Phase2：locator/read_mode 必需，删旧 getByLabel 兼容；label 仅作诊断
    const loc = resolveLocator(page, fv.locator, frames);
    let ev: ElementValue;
    try {
      ev = await loc.evaluate(readElementValue as (el: HTMLElement) => ElementValue);
    } catch (e) {
      if (e instanceof Error && e.message === AUTH_DATA_NOT_REPLAYABLE) {
        throw new Error(`❌ field_value: ${fv.label} 密码控件拒绝读取`);
      }
      throw e;
    }
    if (ev.read_mode !== fv.read_mode) {
      // ARIA combobox: 录制时 DOM .value 为空串会标记 read_mode='value'，修复后取 ARIA 语义文本标记 read_mode='text'；
      // 两者都是同一选中值的不同读取通道，不阻塞回放
      const comboboxModeOk = 'role' in fv.locator && fv.locator.role === 'combobox' && ((fv.read_mode === 'value' && ev.read_mode === 'text') || (fv.read_mode === 'text' && ev.read_mode === 'value'));
      if (!comboboxModeOk) {
        throw new Error(`❌ field_value: ${fv.label} 读取通道不一致（录制 ${fv.read_mode}，回放 ${ev.read_mode}），拒绝换通道凑值`);
      }
    }
    const actual = ev.value;
    if (actual !== expected) throw new Error(`❌ field_value: ${assert.field_value.label} 期望="${expected}"，实际="${actual}"`);
    console.log(`✅ assert.field_value: ${assert.field_value.label}="${expected}"`);
    return { kind: 'field_value', expect: { label: fv.label, value: expected }, actual: { value: actual, read_mode: ev.read_mode }, pass: true, executed: true };
  }

  // assert.url
  if ('url' in assert) {
    const url = page.url();
    if (!url.includes(assert.url.contains)) throw new Error(`❌ assert.url: "${url}" 不包含 "${assert.url.contains}"`);
    console.log(`✅ assert.url: ${assert.url.contains}`);
    return { kind: 'url', expect: assert.url, actual: url, pass: true, executed: true };
  }

  // assert.data（P2）：回放时从当前 Page 重新读取（标准 CDP 协议 + 标量合同），
  // 不用录制时的 actual 值。local-storage 只拿原字符串，JSON.parse + data-only
  // dot path 在这里做；global 直接是真实标量。严格 === 比较（missing≠null、数字字符串≠数字）。
  if ('data' in assert) {
    const source = assert.data.source;
    const expected = assert.data.equals;
    // 指定 --frame 时必须用该 frame 的真实 channel(同源 root / OOPIF child);无 frame 才读主文档。
    const dataTarget = frames?.length
      ? await reqTracker.resolvePageDataTarget(page, await resolveFrameObject(page, frames, timeout))
      : undefined;
    const read = await readPageDataSource(page, source, dataTarget);
    let actual: string | number | boolean | null;
    if ('local_storage' in source && source.path !== undefined) {
      if (!read.present) throw new Error(`❌ assert.data: localStorage key "${source.local_storage}" 缺失（缺失≠null）`);
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(read.value), nullProtoReviver);
      } catch {
        throw new Error(`❌ assert.data: localStorage "${source.local_storage}" 不是合法 JSON`);
      }
      const hit = dataDotPath(parsed, source.path);
      if (hit === undefined) throw new Error(`❌ assert.data: path "${source.path}" 未命中（缺失≠null）`);
      if (hit !== null && (typeof hit === 'object' || typeof hit === 'function')) {
        throw new Error(`❌ assert.data: path "${source.path}" 命中非标量（只支持 string/number/boolean/null）`);
      }
      if (typeof hit === 'number' && !Number.isFinite(hit)) {
        throw new Error(`❌ assert.data: path "${source.path}" 命中非有限数`);
      }
      actual = hit as string | number | boolean | null;
    } else {
      if (!read.present) throw new Error(`❌ assert.data: ${'local_storage' in source ? `localStorage key "${source.local_storage}"` : `global "${source.global}"`} 缺失（缺失≠null）`);
      actual = read.value as string | number | boolean | null;
    }
    if (actual !== expected) {
      // P4：诊断只带源与固定安全文案，不回显期望/实际值(防脱敏后敏感数据泄漏到 replay HTML)
      throw new Error(`❌ assert.data: ${JSON.stringify(source)} 期望值与实际值不一致`);
    }
    console.log(`✅ assert.data: ${JSON.stringify(source)} 与期望值一致`);
    return { kind: 'data', expect: assert.data, actual: { value: actual }, pass: true, executed: true };
  }

  // assert.style：计算样式（默认唯一目标；all 才逐个核对）
  if ('style' in assert) {
    const a = assert.style;
    const loc = resolveLocator(page, a.locator, frames);
    const count = await loc.count();
    const values: string[] = [];
    for (let i = 0; i < count; i++) {
      values.push(await loc.nth(i).evaluate(readComputedStyle, {
        property: a.property,
        ...(a.pseudo ? { pseudo: a.pseudo } : {}),
      }) as string);
    }
    const pass = count > 0 && (a.all === true ? values.every((v) => v === a.equals) : count === 1 && values[0] === a.equals);
    return { kind: 'style', expect: a, actual: { matches: count, values }, pass, executed: true };
  }

  // assert.element：标准 DOM 属性或 count
  if ('element' in assert) {
    const a = assert.element;
    const loc = resolveLocator(page, a.locator, frames);
    const count = await loc.count();
    if (a.property === 'count') {
      const pass = compare(mapOp(a.op), count, a.value);
      return { kind: 'element', expect: a, actual: { matches: count }, pass, executed: true };
    }
    const values: Array<string | number | boolean> = [];
    for (let i = 0; i < count; i++) {
      values.push(await loc.nth(i).evaluate(readElementProperty, a.property) as string | number | boolean);
    }
    const pass = count > 0 && (a.all === true
      ? values.every((v) => compare(mapOp(a.op), v, a.value))
      : count === 1 && compare(mapOp(a.op), values[0], a.value));
    return { kind: 'element', expect: a, actual: { matches: count, values }, pass, executed: true };
  }

  // assert.console：与 Source 同一 matchConsole 纯逻辑；范围 session/action 显式
  if ('console' in assert) {
    const a = assert.console;
    const frame = frames?.length ? await resolveFrameObject(page, frames, timeout) : undefined;
    const frameId = frame ? await reqTracker.resolveConsoleFrameId(page, frame) : undefined;
    const snap = await reqTracker.consoleSnapshot(page, frameId);
    const actionId = a.scope === 'action' ? reqTracker.consoleScopeId() : null;
    if (a.scope === 'action' && !actionId) throw new Error('❌ assert.console: action scope 缺 action 身份');
    const match = matchConsole(snap.snapshot, a.check as ConsoleCheck, {
      scope: a.scope,
      ...(actionId ? { actionId } : {}),
      ...(frameId ? { frameId } : {}),
    });
    return {
      kind: 'console',
      expect: a,
      actual: { expected: match.expected, actual: match.actual, counts: match.counts, incomplete: match.incomplete, complete: snap.complete, logs: match.logs },
      pass: match.pass && snap.complete,
      executed: true,
    };
  }

  throw new Error(`unsupported assert: ${JSON.stringify(assert)}`);
}

async function executeCapture(
  page: Page,
  capture: Capture,
  vctx: ValueContext,
  reqTracker: RequestTracker,
  timeout: number,
  frames?: import('./types.js').Frame[],
): Promise<void> {
  // capture.from_api（响应体完成驱动）
  if ('from_api' in capture) {
    const rec = await reqTracker.waitForComplete(page, capture.from_api, timeout);
    const body = parseBodyOrThrow(rec.body, capture.from_api.path);
    const val = jsonPath(body, capture.path);
    if (val === undefined) throw new Error(`❌ capture.from_api: path "${capture.path}" 不存在`);
    if (val === null) throw new Error(`❌ capture.from_api: path "${capture.path}" 值为 null，不允许 capture`);
    const strVal = (typeof val === 'object') ? JSON.stringify(val) : String(val);
    vctx.set(capture.as, strVal);
    // Phase2：捕值诊断只打印成功变量名，不打印值预览（URL/凭证来源值不落 stdout）
    console.log(`✅ capture.from_api: ${capture.as}`);
    return;
  }

  // capture.from_element
  if ('from_element' in capture) {
    guardNativeBudget(timeout, 'capture.from_element');
    const loc = resolveLocator(page, capture.from_element, frames);
    let text: string;
    try {
      const ev: ElementValue = await loc.evaluate(readElementValue as (el: HTMLElement) => ElementValue);
      if (ev.read_mode !== capture.read_mode) {
        throw new Error(`❌ capture.from_element: ${capture.as} 读取通道不一致（录制 ${capture.read_mode}，回放 ${ev.read_mode}），拒绝换通道凑值`);
      }
      text = ev.value;
    } catch (e) {
      if (e instanceof Error && e.message === AUTH_DATA_NOT_REPLAYABLE) {
        throw new Error(`❌ capture.from_element: ${capture.as} 密码控件拒绝读取`);
      }
      throw e;
    }
    vctx.set(capture.as, text);
    console.log(`✅ capture.from_element: ${capture.as}`);
    return;
  }

  throw new Error(`unsupported capture: ${JSON.stringify(capture)}`);
}

/** 解析响应体 JSON。空串/非 JSON 是失败（不回退 {}）；空对象 {} 合法但字段缺失由调用方判定。 */
function parseBodyOrThrow(body: string | undefined, path: string): unknown {
  if (body === undefined) throw new Error(`❌ ${path}: 响应体缺失`);
  if (body === '') throw new Error(`❌ ${path}: 响应体为空`);
  try {
    return JSON.parse(body);
  } catch (e) {
    throw new Error(`❌ ${path}: 响应体非合法 JSON (${(e as Error).message})`);
  }
}

/** P2 data-only dot path 遍历：对象精确自身 key；数组段按生成侧 jsonPath 的
 *  Number+integer 语义取 index（items.01 / items.1e0 → index 1；非数字段 missing）。
 *  不改既有 API 断言的 extractPath，不扩展 bracket/filter 语法。 */
function dataDotPath(root: unknown, dotPath: string): unknown {
  let cur: unknown = root;
  for (const seg of dotPath.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx)) return undefined;
      cur = cur[idx];
    } else {
      cur = (cur as Record<string, unknown>)[seg];
    }
  }
  return cur;
}

/** P2 data 分支专用 JSON.parse reviver：对象/数组原型置空，空 JSON 的 constructor.name
 *  等继承属性不误报；保留实际 JSON 自身同名字段（不做字段黑名单）。 */
function nullProtoReviver(_key: string, v: unknown): unknown {
  if (v !== null && typeof v === 'object') {
    if (Array.isArray(v)) {
      const copy = [...(v as unknown[])];
      Object.setPrototypeOf(copy, null);
      return copy;
    }
    return Object.assign(Object.create(null), v);
  }
  return v;
}

/** runtime assert op → shared AssertOp 映射 */
function mapOp(op: AssertOp): SharedAssertOp {
  switch (op) {
    case 'eq': return '==';
    case 'ne': return '!=';
    case 'gt': return '>';
    case 'lt': return '<';
    case 'exists': return 'exists';
    case 'contains': return 'contains';
  }
}

function guardNativeBudget(timeout: number, kind: string): void {
  if (timeout <= 0) throw new Error(`❌ 预算耗尽：无法开始 ${kind} 断言`);
}

/** 轮询条件直到 truthy 或 deadline。
 *  回调接收当前剩余预算（严格正），传给原生 innerText 等；truthy 必须在 deadline 内返回才接受。
 *  每次 predicate await 用一个剩余时间定时器 bound，finally 清理；retry sleep 截断到剩余 deadline。 */
async function pollUntil(fn: (remainingMs: number) => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: Error | null = null;
  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const ok = await Promise.race([
        fn(remaining),
        new Promise<false>((_, reject) => {
          timer = setTimeout(() => reject(new PredicateAwaitTimeout()), remaining);
        }),
      ]);
      if (ok && Date.now() < deadline) return;
    } catch (e) {
      // bound-timer 超时不记为 lastErr，仅在 deadline 到时报 'poll timeout'
      if (!(e instanceof PredicateAwaitTimeout)) lastErr = e as Error;
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (Date.now() >= deadline) break;
    const sleepRem = deadline - Date.now();
    await new Promise((r) => setTimeout(r, Math.min(100, Math.max(0, sleepRem))));
  }
  throw lastErr ?? new Error('poll timeout');
}

class PredicateAwaitTimeout extends Error {
  constructor() {
    super('predicate await 超过剩余预算');
    this.name = 'PredicateAwaitTimeout';
  }
}
import { AUTH_DATA_NOT_REPLAYABLE, readElementValue, type ElementValue } from './shared/element-value.js';
