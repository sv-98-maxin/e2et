/**
 * 3.2 ir build 单测：真实形态 trace → 合法 IR；废步骤删除并列出；mocked/未 pass 拒绝；不可映射动作列出。
 * 不依赖真实 CDP，直接写 trace.jsonl 到临时目录。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { buildIr } from '../build.js';
import { parseIRv2 } from '../schema.js';
import type { TraceEvent } from '../trace-reader.js';

interface Ctx {
  tmpHome: string;
  sessionDir: string;
  origHome: string | undefined;
}

function setupTrace(): Ctx {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ir-build-'));
  const sessionDir = path.join(tmpHome, 'workspace', 'traces', 's_test');
  fs.mkdirSync(sessionDir, { recursive: true });
  const origHome = process.env.E2ET_HOME;
  process.env.E2ET_HOME = tmpHome;
  return { tmpHome, sessionDir, origHome };
}

function writeTrace(ctx: Ctx, events: TraceEvent[]): void {
  const lines = wire3(events).map((e) => JSON.stringify(e)).join('\n');
  fs.writeFileSync(path.join(ctx.sessionDir, 'trace.jsonl'), lines + '\n', 'utf8');
}

/** Phase2：旧式夹具升格为 wire3 事件形状（新 CLI 落盘形态）——action/assert 补 replayable，
 *  capture 转成功判别联合 result。显式 replayable:false 的拒绝反例保持原样。 */
function wire3(events: TraceEvent[]): TraceEvent[] {
  return events.map((ev) => {
    if (ev.t === 'action' || ev.t === 'assert' || ev.t === 'observation') {
      return { ...ev, replayable: ev.replayable ?? true };
    }
    if (ev.t === 'capture') {
      if (ev.result !== undefined) return { ...ev, replayable: ev.replayable ?? true };
      const { from, value, lineage, path, as, after, ...rest } = ev as Record<string, unknown>;
      return { ...rest, t: 'capture', after, as, replayable: true,
        result: { ok: true, value, from, lineage, ...(path !== undefined ? { path } : {}) } } as TraceEvent;
    }
    return ev;
  });
}

function teardown(ctx: Ctx): void {
  if (ctx.origHome === undefined) delete process.env.E2ET_HOME;
  else process.env.E2ET_HOME = ctx.origHome;
  fs.rmSync(ctx.tmpHome, { recursive: true, force: true });
}

/** 一个完整业务闭环 trace：open → fill(creates) → assert api → assert toast → capture api。 */
function happyPathTrace(): TraceEvent[] {
  return [
    { t: 'session', id: 'session', ts: 1, session_id: 's_test', schema_version: 3, env: 'pre', tool_version: '0.6.0', auth_source: 'profile', browser_source: 'chrome-profile' },
    // 真正流程
    { t: 'action', id: 'a3', ts: 30, kind: 'open', intent: '打开新建商品页', nav: 'n0', args: { url: 'https://portal.example.invalid/@item/pages/publish/normal.html' }, value: { raw: 'https://portal.example.invalid/@item/pages/publish/normal.html', origin: 'literal' }, result: { ok: true }, settled_by: [{ kind: 'dom_quiet', quiet_ms: 300 }], requests: [] },
    { t: 'navigation', id: 'n1', ts: 31, from: 'about:blank', to: 'https://portal.example.invalid/@item/pages/publish/normal.html', kind: 'same_page', triggered_by: 'a3' },
    { t: 'action', id: 'a4', ts: 40, kind: 'fill', intent: '填写商品名称', nav: 'n1', args: {}, value: { raw: 'E2E商品_123', origin: 'generated', template: 'E2E商品_${ts}' }, save_as: 'title', creates: { entity: 'item', path: '/api/item/publish/commit.json' }, target: { resolved_by: 'ax', role: 'textbox', name: '商品名称', matches: 1, backendNodeId: 101, candidates: [{ by: 'role', role: 'textbox', name: '商品名称', matches: 1 }] }, result: { ok: true }, settled_by: [{ kind: 'request', ref: 'r1', ms: 840 }], requests: ['r1'], resolved_value: 'E2E商品_123', saved_value: 'E2E商品_123', source_action: 'a4' },
    { t: 'request', id: 'r1', ts: 41, path: '/api/item/publish/commit.json', nav: 'n1', call_index: 1, method: 'POST', url: 'https://portal.example.invalid/api/item/publish/commit.json', status: 200, failed: null, mocked: false, triggered_by: 'a4', creates: 'item' },
    { t: 'assert', after: 'a4', kind: 'api', expect: { path: 'success', op: '==', value: true, req: { path: '/api/item/publish/commit.json', nav: 'n1', call_index: 1 } }, actual: true, pass: true, evidence: [{ req_id: 'r1' }] },
    { t: 'assert', after: 'a4', kind: 'toast', expect: '提交成功', actual: '提交成功', pass: true, evidence: [] },
    { t: 'capture', after: 'a4', as: 'itemId', replayable: true, result: { ok: true, value: '12345', from: { path: '/api/item/publish/commit.json', nav: 'n1', call_index: 1, req_id: 'r1' }, lineage: 'created', path: 'data.itemId' } },
    { t: 'session_end', id: 'session_end', ts: 100, result: 'pass', mocked: false, asserts: { total: 2, pass: 2 }, timeouts: 0, ended_at: '2026-10-27T00:00:00.000Z' },
  ];
}

/** Phase2：field_value 断言事件（自身 target 候选 + read_mode 必需；extra 携带显式来源 value） */
function fieldAssert(after: string, value: string, extra: Record<string, unknown> = {}): TraceEvent {
  return {
    t: 'assert', after, kind: 'field_value', expect: { label: '商品名称', value }, pass: true,
    target: { resolved_by: 'ax', role: 'textbox', name: '商品名称', matches: 1, backendNodeId: 101, candidates: [{ by: 'role', role: 'textbox', name: '商品名称', matches: 1 }] },
    read_mode: 'value', ...extra,
  };
}

describe('ir build 正常提炼', () => {
  let ctx: Ctx;
  beforeEach(() => { ctx = setupTrace(); });
  afterEach(() => { teardown(ctx); });

  it.each([
    ['==', 'eq'], ['!=', 'ne'], ['>', 'gt'], ['<', 'lt'], ['exists', 'exists'], ['contains', 'contains'],
  ])('finding 13：真实 trace 的 API/request 运算符 %s 转译为 %s', async (traceOp, irOp) => {
    const events = happyPathTrace();
    const assertion = events.find((event) => event.t === 'assert' && event.kind === 'api')!;
    (assertion.expect as Record<string, unknown>).op = traceOp;
    events.splice(events.length - 1, 0, { ...assertion, kind: 'request' });
    writeTrace(ctx, events);
    const result = await buildIr('s_test');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(parseIRv2(result.ir).ok).toBe(true);
    const checks = result.ir.steps.at(-1)!.checks!;
    expect(checks[0]).toMatchObject({ assert: { expect: [{ op: irOp }] } });
    expect(checks.at(-1)).toMatchObject({ assert: { body: [{ op: irOp }] } });
  });

  it('finding 13：未知 trace 运算符拒绝提炼', async () => {
    const events = happyPathTrace();
    const assertion = events.find((event) => event.t === 'assert' && event.kind === 'api')!;
    (assertion.expect as Record<string, unknown>).op = 'bogus';
    writeTrace(ctx, events);
    expect((await buildIr('s_test')).ok).toBe(false);
  });

  it('finding 1：checks 保持 capture/assert 交错的原事件顺序', async () => {
    const events = happyPathTrace();
    const capture = events.find((event) => event.t === 'capture')!;
    events.splice(events.indexOf(capture), 1);
    events.splice(events.findIndex((event) => event.t === 'assert'), 0, capture);
    writeTrace(ctx, events);
    const result = await buildIr('s_test', { name: 'ordered-checks' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ir.steps.find((step) => step.trace_ref === 'a4')?.checks?.map((check) => Object.keys(check)[0]))
      .toEqual(['capture', 'assert', 'assert']);
  });

  it('finding 2：等待按真实 kind 和条件转译，不伪造 dialog 或空串', async () => {
    const events = happyPathTrace();
    events.find((event) => event.id === 'a4')!.settled_by = [
      { kind: 'element', target: 'css=#result', locator: { css: '#result' }, observation: { matches: 1, role: 'button', name: '结果', visible: true }, ms: 10 },
      { kind: 'element_gone', target: 'role=dialog:新建商品', locator: { role: 'dialog', name: '新建商品' }, observation: { matches: 0 }, ms: 20 },
      { kind: 'text', text: '保存成功', ms: 30 },
      { kind: 'url', url: '/result', ms: 40 },
      { kind: 'dom_quiet', ms: 50, quiet_ms: 250 },
    ];
    writeTrace(ctx, events);
    const result = await buildIr('s_test');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ir.steps.find((step) => step.trace_ref === 'a4')?.wait).toEqual([
      { element: { css: '#result' }, state: 'attached' },
      { element: { role: 'dialog', name: '新建商品' }, state: 'detached' },
      { text: '保存成功' }, { url: { contains: '/result' } }, { dom_quiet: { ms: 250 } },
    ]);
  });

  it.each(['element', 'element_gone', 'text', 'url', 'request', 'unsupported'])('finding 2：%s 缺等待证据拒绝提炼', async (kind) => {
    const events = happyPathTrace();
    events.find((event) => event.id === 'a4')!.settled_by = [{ kind, ms: 10 }];
    writeTrace(ctx, events);
    expect((await buildIr('s_test')).ok).toBe(false);
    expect(fs.existsSync(path.join(ctx.tmpHome, 'workspace', 'ir'))).toBe(false);
  });

  it('F2：dom_quiet 只有 ms 没有 quiet_ms 拒绝提炼', async () => {
    const events = happyPathTrace();
    events.find((event) => event.id === 'a4')!.settled_by = [{ kind: 'dom_quiet', ms: 50 }];
    writeTrace(ctx, events);
    expect((await buildIr('s_test')).ok).toBe(false);
  });

  it('finding 3：visible/absent/text.within 保留原定位和作用域', async () => {
    const events = happyPathTrace();
    events.splice(events.length - 1, 0,
      { t: 'assert', after: 'a4', kind: 'visible', expect: '[7]', target: { resolved_by: 'ax', role: 'button', name: '保存', matches: 1, candidates: [{ by: 'role', role: 'button', name: '保存', matches: 1 }] }, pass: true },
      { t: 'assert', after: 'a4', kind: 'absent', expect: 'css=#loading', pass: true },
      { t: 'assert', after: 'a4', kind: 'text', expect: { contains: '完成', within: '[8]' }, within: { resolved_by: 'ax', role: 'dialog', name: '结果', matches: 1, candidates: [{ by: 'role', role: 'dialog', name: '结果', matches: 1 }] }, pass: true });
    writeTrace(ctx, events);
    const result = await buildIr('s_test');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ir.steps.at(-1)?.checks?.slice(-3)).toEqual([
      { assert: { visible: { role: 'button', name: '保存' } } },
      { assert: { absent: { css: '#loading' } } },
      { assert: { text: { contains: '完成', within: { role: 'dialog', name: '结果' } } } },
    ]);
  });

  it.each(['visible', 'absent', 'text'])('finding 3：%s 索引定位无解析证据拒绝', async (kind) => {
    const events = happyPathTrace();
    events.splice(events.length - 1, 0, { t: 'assert', after: 'a4', kind, expect: kind === 'text' ? { within: '[7]', contains: '完成' } : '[7]', pass: true });
    writeTrace(ctx, events);
    expect((await buildIr('s_test')).ok).toBe(false);
  });

  it('finding 3：解析证据中的嵌套 within 不得丢失', async () => {
    const events = happyPathTrace();
    const within = { row: { contains: '${title}' } };
    events.splice(events.length - 1, 0, { t: 'assert', after: 'a4', kind: 'visible', expect: '[7]', target: { resolved_by: 'ax', role: 'button', name: '编辑', within, candidates: [{ by: 'role', role: 'button', name: '编辑', matches: 1 }] }, pass: true });
    writeTrace(ctx, events);
    const result = await buildIr('s_test');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ir.steps.at(-1)?.checks?.at(-1)).toEqual({ assert: { visible: { role: 'button', name: '编辑', within } } });
  });

  it('finding 4：field_value 无显式来源保持 literal，不固化 raw 反查来源', async () => {
    const events = happyPathTrace();
    events.splice(events.length - 1, 0, fieldAssert('a4', 'E2E商品_123'));
    writeTrace(ctx, events);
    const result = await buildIr('s_test');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ir.steps.at(-1)?.checks?.at(-1)).toEqual({ assert: { field_value: {
      label: '商品名称', value: { literal: 'E2E商品_123' },
      locator: { role: 'textbox', name: '商品名称' }, read_mode: 'value',
    } } });
  });

  it('Phase2：field_value 显式 value-ref 保留 {ref} 来源（raw 与当前绑定一致）', async () => {
    const events = happyPathTrace();
    events.splice(events.length - 1, 0, fieldAssert('a4', 'E2E商品_123', { value: { raw: 'E2E商品_123', origin: 'captured', ref: 'title' } }));
    writeTrace(ctx, events);
    const result = await buildIr('s_test');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ir.steps.at(-1)?.checks?.at(-1)).toEqual({ assert: { field_value: {
      label: '商品名称', value: { ref: 'title' },
      locator: { role: 'textbox', name: '商品名称' }, read_mode: 'value',
    } } });
  });

  it('Phase2：field_value 显式 from-action 映射来源动作 step.id（generated 动作，无 save_as 也可引用）', async () => {
    const events = happyPathTrace();
    const a4 = events.find((e) => e.id === 'a4') as TraceEvent;
    delete (a4 as Record<string, unknown>).save_as;
    events.splice(events.length - 1, 0, fieldAssert('a4', 'E2E商品_123', { value: { raw: 'E2E商品_123', origin: 'generated', template: 'E2E商品_${ts}', source_action: 'a4' } }));
    writeTrace(ctx, events);
    const result = await buildIr('s_test');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // a4 是第 2 个动作 → step s2；from_action 取 step.id 而非录制 action.id
    expect(result.ir.steps.at(-1)?.checks?.at(-1)).toEqual({ assert: { field_value: {
      label: '商品名称', value: { from_action: 's2' },
      locator: { role: 'textbox', name: '商品名称' }, read_mode: 'value',
    } } });
  });

  it('finding 6：upload 导出候选 fixture，保留二进制字节并写安全 basename', async () => {
    const bytes = Buffer.from([0, 255, 128, 10]);
    const hash = createHash('sha256').update(bytes).digest('hex');
    fs.mkdirSync(path.join(ctx.sessionDir, 'blobs'));
    fs.writeFileSync(path.join(ctx.sessionDir, 'blobs', hash), bytes);
    const events = happyPathTrace();
    events.splice(events.length - 1, 0, { t: 'action', id: 'upload', kind: 'upload', intent: '上传证明', nav: 'n1', args: { files: [{ name: 'proof.bin', blob_ref: `blobs/${hash}` }] } });
    writeTrace(ctx, events);
    const result = await buildIr('s_test', { name: 'upload-proof' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const filename = `${hash}-proof.bin`;
    expect(result.ir.steps.at(-1)?.args?.files).toEqual([filename]);
    expect(fs.readFileSync(path.join(path.dirname(result.ir_path), 'cases', 'fixtures', 'upload-proof', filename))).toEqual(bytes);
  });

  it('finding 6：upload blob 缺失拒绝，不输出悬空 fixture', async () => {
    const events = happyPathTrace();
    events.splice(events.length - 1, 0, { t: 'action', id: 'upload', kind: 'upload', intent: '上传证明', nav: 'n1', args: { files: [{ name: 'proof.bin', blob_ref: `blobs/${'a'.repeat(64)}` }] } });
    writeTrace(ctx, events);
    expect((await buildIr('s_test')).ok).toBe(false);
  });

  it.each(['../../escape', '/tmp/escape', 'bad/name', 'bad\\name', '.', '', '中文'])('finding 7：非法 name %j 写盘前返回用法错误', async (name) => {
    writeTrace(ctx, happyPathTrace());
    const result = await buildIr('s_test', { name });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('USAGE');
    expect(fs.existsSync(path.join(ctx.tmpHome, 'workspace', 'ir'))).toBe(false);
  });

  it('finding 11：fill_form 字段的生成值来源进入 IR', async () => {
    const events = happyPathTrace();
    events.splice(events.length - 1, 0, { t: 'action', id: 'form', kind: 'fill_form', intent: '填表单', nav: 'n1', args: { scope: 'targeted', fields: { 商品名称: { raw: 'E2E商品_123', origin: 'generated', template: 'E2E商品_${ts}' } } } });
    writeTrace(ctx, events);
    const result = await buildIr('s_test');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ir.steps.at(-1)?.args?.fields).toEqual({ 商品名称: { template: 'E2E商品_${ts}' } });
  });

  it.each(['accept', 'dismiss'])('finding 16：dialog %s 合并结果时保留 prompt_text', async (handled) => {
    const events = happyPathTrace();
    events.find((event) => event.id === 'a4')!.args = { dialog: { accept: handled !== 'accept', prompt_text: '输入内容' } };
    events.splice(events.length - 1, 0, { t: 'dialog', after: 'a4', kind: 'prompt', message: '输入', handled, registered: true });
    writeTrace(ctx, events);
    const result = await buildIr('s_test');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ir.steps.at(-1)?.args?.dialog).toEqual({ accept: handled === 'accept', prompt_text: '输入内容' });
  });

  it('真实形态 trace 提炼出合法 IR，废步骤（切走切回）被删除并列出', async () => {
    writeTrace(ctx, happyPathTrace());
    const r = await buildIr('s_test', { name: 'item-publish-normal' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // a1/a2 抵消对删除，a3/a4 保留
    expect(r.dropped_steps).not.toContain('a1');
    expect(r.dropped_steps).not.toContain('a2');
    expect(r.kept_steps).toEqual(['a3', 'a4']);
    // IR 写盘
    expect(fs.existsSync(r.ir_path)).toBe(true);
    // 过 schema 校验
    const parsed = parseIRv2(r.ir);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.ir.name).toBe('item-publish-normal');
    expect(parsed.ir.url).toBe('https://portal.example.invalid/@item/pages/publish/normal.html');
    expect(parsed.ir.steps).toHaveLength(2);
    // s1 = open，s2 = fill（带 creates + value.template + wait.api + checks）
    const s2 = parsed.ir.steps[1];
    expect(s2.action).toBe('fill');
    expect(s2.creates).toEqual({ entity: 'item', path: '/api/item/publish/commit.json' });
    expect(s2.value).toEqual({ template: 'E2E商品_${ts}' });
    expect(s2.save_as).toBe('title');
    expect(s2.locator).toEqual({ role: 'textbox', name: '商品名称' });
    expect(s2.wait).toEqual([{ api: { path: '/api/item/publish/commit.json', nav: 1, call_index: 1 } }]);
    // checks 顺序：assert api → assert toast → capture
    expect(s2.checks).toHaveLength(3);
    expect(s2.checks?.[0]).toEqual({ assert: { api: { path: '/api/item/publish/commit.json', nav: 1, call_index: 1 }, expect: [{ path: 'success', op: 'eq', value: true }] } });
    expect(s2.checks?.[1]).toEqual({ assert: { toast: '提交成功' } });
    expect(s2.checks?.[2]).toEqual({ capture: { from_api: { path: '/api/item/publish/commit.json', nav: 1, call_index: 1 }, path: 'data.itemId', as: 'itemId', lineage: 'created' } });
    // provenance.mocked = false
    expect(parsed.ir.provenance.mocked).toBe(false);
  });

  it('switch_tab 不再盲删连续对（无抵消对 warning）', async () => {
    writeTrace(ctx, happyPathTrace());
    const r = await buildIr('s_test', { name: 'case-x' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings.some((w) => w.includes('a1+a2'))).toBe(false);
  });

  it('旧假 history switch（无 resolved_tab/target_id 证据）被拒绝', async () => {
    const events = happyPathTrace();
    events.splice(2, 0, { t: 'action', id: 'a_fake', ts: 15, kind: 'switch_tab', intent: '假切', nav: 'n0', args: { index: 1 }, result: { ok: true }, settled_by: [], requests: [] });
    writeTrace(ctx, events);
    const r = await buildIr('s_test', { name: 'case-fake-switch' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('INSUFFICIENT_EVIDENCE');
    expect(r.error.message).toContain('switch_tab');
  });

  it('真实 switch_tab（带 resolved_tab 证据）保留且可过 schema', async () => {
    const events = happyPathTrace();
    events.splice(2, 0, { t: 'action', id: 'a_real', ts: 15, kind: 'switch_tab', intent: '切到列表', nav: 'n0', args: { target_id: 'tab-2', resolved_index: 1, resolved_url: 'https://x/list', from_target_id: 'tab-1', to_target_id: 'tab-2' }, resolved_tab: { target_id: 'tab-2', url: 'https://x/list', resolved_index: 1, from_target_id: 'tab-1' }, result: { ok: true }, settled_by: [{ kind: 'dom_quiet', quiet_ms: 300 }], requests: [] });
    writeTrace(ctx, events);
    const r = await buildIr('s_test', { name: 'case-real-switch' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.kept_steps).toContain('a_real');
    const parsed = parseIRv2(r.ir);
    expect(parsed.ok).toBe(true);
  });

  it('target.candidates 产 fallback，frame FrameDesc[] 透传', async () => {
    const events = happyPathTrace();
    // a4 的 target 加 candidates（role 主 + label fallback），frame 加结构化 FrameDesc[]
    const a4 = events.find((e) => e.id === 'a4') as TraceEvent;
    a4.target = { resolved_by: 'ax', role: 'textbox', name: '商品名称', matches: 1, backendNodeId: 101, candidates: [
      { by: 'role', role: 'textbox', name: '商品名称', matches: 1 },
      { by: 'label', name: '商品名称', matches: 1 },
    ] };
    a4.frame = [{ name: 'contentFrame', url_contains: '/release.html', selector: 'iframe#rel' }];
    writeTrace(ctx, events);
    const r = await buildIr('s_test', { name: 'case-fb' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const parsed = parseIRv2(r.ir);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const s2 = parsed.ir.steps[1];
    expect(s2.locator).toEqual({ role: 'textbox', name: '商品名称' });
    // fallback 取非主定位的 matches==1 候选，最多 2 条
    expect(s2.fallback).toEqual([{ label: '商品名称' }]);
    expect(s2.frame).toEqual([{ name: 'contentFrame', url_contains: '/release.html', selector: 'iframe#rel' }]);
  });

  it('css resolved_by 用 target.selector 还原 css locator', async () => {
    const events = happyPathTrace();
    const a4 = events.find((e) => e.id === 'a4') as TraceEvent;
    a4.target = { resolved_by: 'css', role: 'input', name: '.title-input', matches: 1, backendNodeId: 101, selector: '.title-input', candidates: [
      { by: 'css', selector: '.title-input', matches: 1 },
    ] };
    writeTrace(ctx, events);
    const r = await buildIr('s_test', { name: 'case-css' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const parsed = parseIRv2(r.ir);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const s2 = parsed.ir.steps[1];
    expect(s2.locator).toEqual({ css: '.title-input' });
    // 主定位就是 css，candidates 里也是同一条 css，不进 fallback
    expect(s2.fallback ?? []).toHaveLength(0);
  });

  it('Bug2：css resolved_by 但 candidates 有 role(matches=1) 时优先用 role 定位', async () => {
    const events = happyPathTrace();
    const a4 = events.find((e) => e.id === 'a4') as TraceEvent;
    a4.target = { resolved_by: 'css', role: 'input', name: '.title-input', matches: 1, backendNodeId: 101, selector: '.title-input', candidates: [
      { by: 'css', selector: '.title-input', matches: 1 },
      { by: 'role', role: 'textbox', name: '商品名称', matches: 1 },
    ] };
    writeTrace(ctx, events);
    const r = await buildIr('s_test', { name: 'case-css-role' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const parsed = parseIRv2(r.ir);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const s2 = parsed.ir.steps[1];
    // CSS class 名易漂移：candidates 里有 role(matches=1) 时主定位走 role
    expect(s2.locator).toEqual({ role: 'textbox', name: '商品名称' });
    // 原 css 进 fallback
    expect(s2.fallback).toContainEqual({ css: '.title-input' });
  });

  it('Bug2：assert.text 的 within 从自身事件候选映射 role 定位（不借 actionTarget）', async () => {
    const events = happyPathTrace();
    const a4 = events.find((e) => e.id === 'a4') as TraceEvent;
    a4.target = { resolved_by: 'css', role: 'input', name: '.title-input', matches: 1, backendNodeId: 101, selector: '.title-input', candidates: [
      { by: 'css', selector: '.title-input', matches: 1 },
      { by: 'role', role: 'textbox', name: '商品名称', matches: 1 },
    ] };
    // Phase2：within 只从断言自身事件的解析证据映射（候选含 matches=1 role）
    events.splice(events.length - 1, 0, { t: 'assert', after: 'a4', kind: 'text', expect: { contains: '完成', within: 'css=.title-input' }, pass: true,
      within: { resolved_by: 'css', role: 'textbox', name: '商品名称', matches: 1, backendNodeId: 102, selector: '.title-input', candidates: [{ by: 'role', role: 'textbox', name: '商品名称', matches: 1 }] } });
    writeTrace(ctx, events);
    const r = await buildIr('s_test', { name: 'case-text-within-role' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const parsed = parseIRv2(r.ir);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const check = parsed.ir.steps[1].checks?.at(-1);
    // 自身候选有 matches=1 role → 用 role 定位
    expect(check).toEqual({ assert: { text: { contains: '完成', within: { role: 'textbox', name: '商品名称' } } } });
  });

  it('Bug2：assert.text 的 within CSS 与 action 不同区时保留 CSS（不能丢断言）', async () => {
    const events = happyPathTrace();
    const a4 = events.find((e) => e.id === 'a4') as TraceEvent;
    a4.target = { resolved_by: 'css', role: 'input', name: '.title-input', matches: 1, backendNodeId: 101, selector: '.title-input', candidates: [
      { by: 'css', selector: '.title-input', matches: 1 },
      { by: 'role', role: 'textbox', name: '商品名称', matches: 1 },
    ] };
    // Phase2：within 自身事件只有 css 候选 → 保留 CSS
    events.splice(events.length - 1, 0, { t: 'assert', after: 'a4', kind: 'text', expect: { contains: '完成', within: 'css=.other-block' }, pass: true,
      within: { resolved_by: 'css', role: 'textbox', name: '其他区块', matches: 1, backendNodeId: 103, selector: '.other-block', candidates: [{ by: 'css', selector: '.other-block', matches: 1 }] } });
    writeTrace(ctx, events);
    const r = await buildIr('s_test', { name: 'case-text-within-css-keep' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const parsed = parseIRv2(r.ir);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const check = parsed.ir.steps[1].checks?.at(-1);
    expect(check).toEqual({ assert: { text: { contains: '完成', within: { css: '.other-block' } } } });
  });

  it('Phase2：assert.text 显式 from-action 保留 value 来源，悬空来源拒绝提炼', async () => {
    const events = happyPathTrace();
    events.splice(events.length - 1, 0, {
      t: 'assert', after: 'a4', kind: 'text',
      expect: { contains: 'E2E商品_123', within: null }, pass: true,
      value: { raw: 'E2E商品_123', origin: 'generated', template: 'E2E商品_${ts}', source_action: 'a4' },
    });
    writeTrace(ctx, events);
    const result = await buildIr('s_test', { name: 'text-from-action' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ir.steps.at(-1)?.checks?.at(-1)).toEqual({
      assert: { text: { contains: 'E2E商品_123', value: { from_action: 's2' } } },
    });

    (events.at(-2) as Record<string, unknown>).value = {
      raw: 'E2E商品_123', origin: 'generated', template: 'E2E商品_${ts}', source_action: 'missing',
    };
    writeTrace(ctx, events);
    expect((await buildIr('s_test', { name: 'text-missing-source' })).ok).toBe(false);
  });

  it('N3：同名 save_as 重新绑定后旧 raw 的断言拒绝提炼', async () => {
    const events = happyPathTrace();
    // a4 的 save_as='title', raw='E2E商品_123'
    // 插入第二个 fill action，save_as='title' 但 raw 不同
    const a4 = events.find((e) => e.id === 'a4') as TraceEvent;
    const a5: TraceEvent = { ...a4, id: 'a5', ts: 45, value: { raw: 'E2E商品_456', origin: 'generated', template: 'E2E商品_${ts}' }, save_as: 'title', creates: undefined, settled_by: [{ kind: 'dom_quiet', quiet_ms: 100 }], requests: [], resolved_value: 'E2E商品_456', saved_value: 'E2E商品_456' };
    events.splice(events.indexOf(a4) + 1, 0, a5);
    // a5 后面挂一个 field_value 断言引用旧 raw（title 现在绑定 E2E商品_456，但 raw 是 E2E商品_123）
    events.splice(events.length - 1, 0, { t: 'assert', after: 'a5', kind: 'field_value', expect: { label: '商品名称', value: 'E2E商品_123' }, pass: true, value: { raw: 'E2E商品_123', origin: 'captured', ref: 'title' } });
    writeTrace(ctx, events);
    const r = await buildIr('s_test', { name: 'n3-rebind' });
    // 旧 raw 被覆盖，断言引用旧 raw → 拒绝提炼
    expect(r.ok).toBe(false);
    if (!r.ok) return;
    expect(r.error.message).toContain('无法从 trace 还原');
  });

  it('N3：save_as 未冲突时 field_value 正常引用旧 raw', async () => {
    const events = happyPathTrace();
    const a4 = events.find((e) => e.id === 'a4') as TraceEvent;
    // Phase2：显式 value-ref 引用 a4 的 raw（无重绑定，raw 与当前绑定一致）
    events.splice(events.length - 1, 0, fieldAssert('a4', 'E2E商品_123', { value: { raw: 'E2E商品_123', origin: 'captured', ref: 'title' } }));
    writeTrace(ctx, events);
    const r = await buildIr('s_test', { name: 'n3-ok' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const checks = r.ir.steps.at(-1)?.checks ?? [];
    const fv = checks.find((c) => 'assert' in c && 'field_value' in (c as any).assert);
    expect(fv).toBeTruthy();
    expect((fv as any).assert.field_value.value).toEqual({ ref: 'title' });
  });

  it('N6：fill OLD save_as title → assert OLD → fill NEW save_as title → build 成功，断言为 {ref: title}', async () => {
    const events = happyPathTrace();
    // a4 save_as='title', raw='E2E商品_123'
    // Phase2：a4 后面挂 field_value 断言显式 value-ref（此时 title 绑定 E2E商品_123）
    events.splice(events.length - 1, 0, fieldAssert('a4', 'E2E商品_123', { value: { raw: 'E2E商品_123', origin: 'captured', ref: 'title' } }));
    // 插入第二个 fill，save_as='title' 但 raw 不同（覆盖绑定）
    const a4 = events.find((e) => e.id === 'a4') as TraceEvent;
    const a5: TraceEvent = { ...a4, id: 'a5', ts: 45, value: { raw: 'E2E商品_456', origin: 'generated', template: 'E2E商品_${ts}' }, save_as: 'title', creates: undefined, settled_by: [{ kind: 'dom_quiet', quiet_ms: 100 }], requests: [], resolved_value: 'E2E商品_456', saved_value: 'E2E商品_456' };
    events.splice(events.indexOf(a4) + 1, 0, a5);
    writeTrace(ctx, events);
    const r = await buildIr('s_test', { name: 'n6-ok' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // a4 的断言在 a4 时解析（title→E2E商品_123），产出 {ref: 'title'}
    const s2 = r.ir.steps.find((s) => s.trace_ref === 'a4');
    const fv = s2?.checks?.find((c) => 'assert' in c && 'field_value' in (c as Record<string, Record<string, unknown>>).assert);
    expect(fv).toBeTruthy();
    expect((fv as Record<string, Record<string, Record<string, unknown>>>)!.assert.field_value.value).toEqual({ ref: 'title' });
  });
  it('N3-空字符串：title OLD→"" 后断言带 ref:title raw:OLD → build 拒绝', async () => {
    const events = happyPathTrace();
    const a4 = events.find((e) => e.id === 'a4') as TraceEvent;
    // 第二个 fill 把 title 重绑为空字符串
    const a5: TraceEvent = { ...a4, id: 'a5', ts: 45, value: { raw: '', origin: 'generated', template: 'E2E商品_${ts}' }, save_as: 'title', creates: undefined, settled_by: [{ kind: 'dom_quiet', quiet_ms: 100 }], requests: [], resolved_value: '', saved_value: '' };
    events.splice(events.indexOf(a4) + 1, 0, a5);
    // a5 后挂断言带 ev.value ref:title raw:OLD（bindings 里 title='' 不等 OLD）
    events.splice(events.length - 1, 0, { t: 'assert', after: 'a5', kind: 'field_value', expect: { label: '商品名称', value: 'E2E商品_123' }, pass: true, value: { raw: 'E2E商品_123', origin: 'captured', ref: 'title' } });
    writeTrace(ctx, events);
    const r = await buildIr('s_test', { name: 'n3-empty' });
    expect(r.ok).toBe(false);
    if (!r.ok) return;
    expect(r.error.message).toContain('无法从 trace 还原');
  });
});

describe('ir build 前提拒绝', () => {
  let ctx: Ctx;
  beforeEach(() => { ctx = setupTrace(); });
  afterEach(() => { teardown(ctx); });

  it.each([1, 999, undefined])('finding 15：trace schema_version=%s 读取入口拒绝', async (version) => {
    const events = happyPathTrace();
    events[0].schema_version = version;
    writeTrace(ctx, events);
    const result = await buildIr('s_test');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('TRACE_VERSION_UNSUPPORTED');
    expect(fs.existsSync(path.join(ctx.tmpHome, 'workspace', 'ir'))).toBe(false);
  });

  it.each(['action', 'assert', 'timeout', 'zero'])('旧终态 pass 但 trace %s 失败/未验证：build 必拒', async defect => {
    let events = happyPathTrace();
    if (defect === 'action') events.find(event => event.id === 'a3')!.result = { ok: false };
    if (defect === 'assert') events.find(event => event.t === 'assert')!.pass = false;
    if (defect === 'timeout') events.find(event => event.id === 'a3')!.settled_by = [{ kind: 'timeout' }];
    if (defect === 'zero') events = events.filter(event => event.t !== 'assert');
    writeTrace(ctx, events);
    const result = await buildIr('s_test');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('SESSION_NOT_PASS');
    expect(fs.existsSync(path.join(ctx.tmpHome, 'workspace', 'ir'))).toBe(false);
  });

  it('session_end 缺失视为 aborted 拒', async () => {
    const events = happyPathTrace().filter((e) => e.t !== 'session_end');
    writeTrace(ctx, events);
    const r = await buildIr('s_test');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('SESSION_NOT_PASS');
    expect(r.error.message).toContain('aborted');
  });

  it('session_end.result=fail 拒', async () => {
    const events = happyPathTrace().map((e) => e.t === 'session_end' ? { ...e, result: 'fail' } : e);
    writeTrace(ctx, events);
    const r = await buildIr('s_test');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('SESSION_NOT_PASS');
  });

  it('mocked=true 拒', async () => {
    const events = happyPathTrace().map((e) => e.t === 'session_end' ? { ...e, mocked: true } : e);
    writeTrace(ctx, events);
    const r = await buildIr('s_test');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('SESSION_MOCKED');
  });

  it('trace 不存在拒', async () => {
    const r = await buildIr('nonexistent');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('TRACE_NOT_FOUND');
  });
});

describe('ir build 不可映射动作', () => {
  let ctx: Ctx;
  beforeEach(() => { ctx = setupTrace(); });
  afterEach(() => { teardown(ctx); });

  it('finding 5：不可映射动作导致整体失败并列出', async () => {
    const events = happyPathTrace();
    // 把 a4（fill）的 kind 改成不在 action 集合的 'screenshot'
    const a4Idx = events.findIndex((e) => e.id === 'a4');
    events[a4Idx] = { ...events[a4Idx] as TraceEvent, kind: 'screenshot' } as TraceEvent;
    writeTrace(ctx, events);
    const r = await buildIr('s_test', { name: 'case-y' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain('a4:screenshot');
    expect(fs.existsSync(path.join(ctx.tmpHome, 'workspace', 'ir'))).toBe(false);
  });

  it('finding 5：未被依赖的未知动作也必须在裁剪前拒绝', async () => {
    const events = happyPathTrace();
    events.splice(4, 0, { t: 'action', id: 'unknown', kind: 'evaluate', intent: '不可映射', nav: 'n1' });
    writeTrace(ctx, events);
    const result = await buildIr('s_test');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('unknown:evaluate');
  });
});

describe('ir build 被依赖筛选', () => {
  let ctx: Ctx;
  beforeEach(() => { ctx = setupTrace(); });
  afterEach(() => { teardown(ctx); });

  // P3 回放事实 2.2：依赖剪枝会删掉无 save_as/无断言引用的 fill，回放丢输入。剪枝已移除，dropped_steps 恒空。
  it('未引用动作不再被删除（剪枝已移除）', async () => {
    const events = happyPathTrace();
    // 在 a3 和 a4 之间插一个无依赖的 hover
    const hover: TraceEvent = { t: 'action', id: 'a3b', ts: 35, kind: 'hover', intent: '随便 hover', nav: 'n1', args: {}, target: { resolved_by: 'ax', role: 'button', name: 'x', matches: 1, backendNodeId: 99, candidates: [{ by: 'role', role: 'button', name: 'x', matches: 1 }] }, result: { ok: true }, settled_by: [], requests: [] };
    events.splice(2, 0, hover);
    writeTrace(ctx, events);
    const r = await buildIr('s_test', { name: 'case-z' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.kept_steps).toContain('a3b');
    expect(r.dropped_steps).toEqual([]);
  });

  it('open → literal fill("42") → click → click + 断言：fill 不丢，4 动作 4 step', async () => {
    const events: TraceEvent[] = [
      { t: 'session', id: 'session', ts: 1, session_id: 's_test', schema_version: 3, env: 'pre', tool_version: '0.6.0', auth_source: 'profile', browser_source: 'chrome-profile' },
      { t: 'action', id: 'a1', ts: 10, kind: 'open', intent: '打开页面', nav: 'n0', args: { url: 'https://x/publish' }, result: { ok: true }, settled_by: [{ kind: 'dom_quiet', quiet_ms: 300 }], requests: [] },
      { t: 'action', id: 'a2', ts: 20, kind: 'fill', intent: '填数量', nav: 'n0', args: {}, value: { raw: '42', origin: 'literal' }, target: { resolved_by: 'ax', role: 'textbox', name: '数量', matches: 1, backendNodeId: 101, candidates: [{ by: 'role', role: 'textbox', name: '数量', matches: 1 }] }, result: { ok: true }, settled_by: [], requests: [] },
      { t: 'action', id: 'a3', ts: 30, kind: 'click', intent: '点击提交', nav: 'n0', args: {}, target: { resolved_by: 'ax', role: 'button', name: '提交', matches: 1, backendNodeId: 102, candidates: [{ by: 'role', role: 'button', name: '提交', matches: 1 }] }, result: { ok: true }, settled_by: [{ kind: 'dom_quiet', quiet_ms: 300 }], requests: [] },
      { t: 'action', id: 'a4', ts: 40, kind: 'click', intent: '点击确认', nav: 'n0', args: {}, target: { resolved_by: 'ax', role: 'button', name: '确认', matches: 1, backendNodeId: 103, candidates: [{ by: 'role', role: 'button', name: '确认', matches: 1 }] }, result: { ok: true }, settled_by: [{ kind: 'dom_quiet', quiet_ms: 300 }], requests: [] },
      { t: 'assert', after: 'a4', kind: 'text', expect: { contains: '提交成功' }, actual: '提交成功', pass: true, evidence: [] },
      { t: 'session_end', id: 'session_end', ts: 100, result: 'pass', mocked: false, asserts: { total: 1, pass: 1 }, timeouts: 0, ended_at: '2026-11-01T00:00:00.000Z' },
    ];
    writeTrace(ctx, events);
    const r = await buildIr('s_test', { name: 'p3-fill-keep' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.kept_steps).toEqual(['a1', 'a2', 'a3', 'a4']);
    expect(r.dropped_steps).toEqual([]);
    // IR step 顺序与 trace.actions 一致，fill 的字面值保留
    expect(r.ir.steps.map((s) => s.trace_ref)).toEqual(['a1', 'a2', 'a3', 'a4']);
    const s2 = r.ir.steps.find((s) => s.trace_ref === 'a2');
    expect(s2?.action).toBe('fill');
    expect(s2?.value).toEqual({ literal: '42' });
  });
});

describe('ir build R1: 开 popup 的 click 保留', () => {
  let ctx: Ctx;
  beforeEach(() => { ctx = setupTrace(); });
  afterEach(() => { teardown(ctx); });

  it('真实 switch 前的开 popup click（无 assert/saveAs）被保留，不剪没', async () => {
    const events: TraceEvent[] = [
      { t: 'session', id: 'session', ts: 1, session_id: 's_test', schema_version: 3, env: 'pre', tool_version: '0.6.0', auth_source: 'profile', browser_source: 'chrome-profile' },
      { t: 'action', id: 'a1', ts: 10, kind: 'open', intent: '打开源页', nav: 'n0', args: { url: 'https://x/source' }, result: { ok: true }, settled_by: [{ kind: 'dom_quiet', quiet_ms: 300 }], requests: [] },
      // 开 popup 的 click：无 assert/saveAs，无 creates —— 旧逻辑会被 reachable 剪掉
      { t: 'action', id: 'a2', ts: 20, kind: 'click', intent: '点击开 popup', nav: 'n0', args: {}, target: { resolved_by: 'ax', role: 'button', name: '开 popup', matches: 1, backendNodeId: 50, candidates: [{ by: 'role', role: 'button', name: '开 popup', matches: 1 }] }, result: { ok: true }, settled_by: [{ kind: 'dom_quiet', quiet_ms: 300 }], requests: [] },
      // 真实 switch 到 popup
      { t: 'action', id: 'a3', ts: 30, kind: 'switch_tab', intent: '切到 popup', nav: 'n0', args: { target_id: 'pop', resolved_index: 1, resolved_url: 'https://x/popup', from_target_id: 'src', to_target_id: 'pop' }, resolved_tab: { target_id: 'pop', url: 'https://x/popup', resolved_index: 1, from_target_id: 'src' }, result: { ok: true }, settled_by: [{ kind: 'dom_quiet', quiet_ms: 300 }], requests: [] },
      // popup 上的断言（after a3）—— 让 a3 被引用
      { t: 'assert', after: 'a3', kind: 'text', expect: { contains: 'popup 标题' }, actual: 'popup 标题', pass: true, evidence: [] },
      { t: 'session_end', id: 'session_end', ts: 100, result: 'pass', mocked: false, asserts: { total: 1, pass: 1 }, timeouts: 0, ended_at: '2026-10-31T00:00:00.000Z' },
    ];
    writeTrace(ctx, events);
    const r = await buildIr('s_test', { name: 'r1-open-click' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // a2（开 popup click）在 switch 前一个动作 → 保守保留，不剪没
    expect(r.kept_steps).toContain('a2');
    expect(r.kept_steps).toContain('a3');
    expect(r.dropped_steps).not.toContain('a2');
  });
});

describe('ir build F7: switch 前缀保守保留（不猜 creator）', () => {
  let ctx: Ctx;
  beforeEach(() => { ctx = setupTrace(); });
  afterEach(() => { teardown(ctx); });

  function realSwitch(id: string, ts: number, intent: string, toId: string, fromId: string): TraceEvent {
    return { t: 'action', id, ts, kind: 'switch_tab', intent, nav: 'n0', args: { target_id: toId, resolved_index: 1, resolved_url: 'https://x/' + toId, from_target_id: fromId, to_target_id: toId }, resolved_tab: { target_id: toId, url: 'https://x/' + toId, resolved_index: 1, from_target_id: fromId }, result: { ok: true }, settled_by: [{ kind: 'dom_quiet', quiet_ms: 300 }], requests: [] };
  }
  function act(id: string, ts: number, kind: string, intent: string): TraceEvent {
    return { t: 'action', id, ts, kind, intent, nav: 'n0', args: {}, target: { resolved_by: 'ax', role: 'button', name: intent, matches: 1, backendNodeId: 10 + ts, candidates: [{ by: 'role', role: 'button', name: intent, matches: 1 }] }, result: { ok: true }, settled_by: [{ kind: 'dom_quiet', quiet_ms: 300 }], requests: [] };
  }

  it('open→click(开popup)→源页 query→switch→子页 assert：click 和 query 都保留', async () => {
    const events: TraceEvent[] = [
      { t: 'session', id: 'session', ts: 1, session_id: 's_test', schema_version: 3, env: 'pre', tool_version: '0.6.0', auth_source: 'profile', browser_source: 'chrome-profile' },
      { t: 'action', id: 'a1', ts: 10, kind: 'open', intent: '打开源页', nav: 'n0', args: { url: 'https://x/source' }, result: { ok: true }, settled_by: [{ kind: 'dom_quiet', quiet_ms: 300 }], requests: [] },
      act('a2', 20, 'click', '点击开 popup'),
      act('a3', 30, 'click', '源页 query 查询'),  // 中间源页操作（非紧挨 switch）
      realSwitch('a4', 40, '切到 popup', 'pop', 'src'),
      { t: 'assert', after: 'a4', kind: 'text', expect: { contains: 'popup' }, actual: 'popup', pass: true, evidence: [] },
      { t: 'session_end', id: 'session_end', ts: 100, result: 'pass', mocked: false, asserts: { total: 1, pass: 1 }, timeouts: 0, ended_at: '2026-10-31T00:00:00.000Z' },
    ];
    writeTrace(ctx, events);
    const r = await buildIr('s_test', { name: 'f7-mid' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // click(开popup) a2 和 源页 query a3 都在前缀里（到最后一个真实 switch a4 为止）→ 都保留
    expect(r.kept_steps).toContain('a2');
    expect(r.kept_steps).toContain('a3');
    expect(r.kept_steps).toContain('a4');
  });

  it('nested 连续真实 switch：到最后一个 switch 为止全部保留', async () => {
    const events: TraceEvent[] = [
      { t: 'session', id: 'session', ts: 1, session_id: 's_test', schema_version: 3, env: 'pre', tool_version: '0.6.0', auth_source: 'profile', browser_source: 'chrome-profile' },
      { t: 'action', id: 'a1', ts: 10, kind: 'open', intent: '打开源页', nav: 'n0', args: { url: 'https://x/source' }, result: { ok: true }, settled_by: [{ kind: 'dom_quiet', quiet_ms: 300 }], requests: [] },
      act('a2', 20, 'click', '开 popup1'),
      realSwitch('a3', 30, '切 popup1', 'pop1', 'src'),
      act('a4', 40, 'click', 'popup1 操作'),  // popup1 上的操作（在两个 switch 之间）
      realSwitch('a5', 50, '切 popup2', 'pop2', 'pop1'),
      { t: 'assert', after: 'a5', kind: 'text', expect: { contains: 'popup2' }, actual: 'popup2', pass: true, evidence: [] },
      { t: 'session_end', id: 'session_end', ts: 100, result: 'pass', mocked: false, asserts: { total: 1, pass: 1 }, timeouts: 0, ended_at: '2026-10-31T00:00:00.000Z' },
    ];
    writeTrace(ctx, events);
    const r = await buildIr('s_test', { name: 'f7-nested' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 最后一个真实 switch 是 a5；前缀 a1..a5 全部保留（含 a2 开 popup1 click、a4 popup1 操作）
    expect(r.kept_steps).toEqual(['a1', 'a2', 'a3', 'a4', 'a5']);
  });

  it('最后一个真实 switch 之后的未引用动作仍保留（剪枝已移除）', async () => {
    const events: TraceEvent[] = [
      { t: 'session', id: 'session', ts: 1, session_id: 's_test', schema_version: 3, env: 'pre', tool_version: '0.6.0', auth_source: 'profile', browser_source: 'chrome-profile' },
      { t: 'action', id: 'a1', ts: 10, kind: 'open', intent: '打开源页', nav: 'n0', args: { url: 'https://x/source' }, result: { ok: true }, settled_by: [{ kind: 'dom_quiet', quiet_ms: 300 }], requests: [] },
      act('a2', 20, 'click', '开 popup'),
      realSwitch('a3', 30, '切 popup', 'pop', 'src'),
      act('a4', 40, 'hover', 'popup 上随便 hover'),  // switch 之后、未被引用
      act('a5', 50, 'click', 'popup 确认'),  // 最后动作
      { t: 'assert', after: 'a5', kind: 'text', expect: { contains: 'ok' }, actual: 'ok', pass: true, evidence: [] },
      { t: 'session_end', id: 'session_end', ts: 100, result: 'pass', mocked: false, asserts: { total: 1, pass: 1 }, timeouts: 0, ended_at: '2026-10-31T00:00:00.000Z' },
    ];
    writeTrace(ctx, events);
    const r = await buildIr('s_test', { name: 'f7-after' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 剪枝已移除：switch 后未引用动作与前后动作全保留且顺序与 trace 一致
    expect(r.kept_steps).toEqual(['a1', 'a2', 'a3', 'a4', 'a5']);
    expect(r.dropped_steps).toEqual([]);
    expect(r.ir.steps.map((s) => s.trace_ref)).toEqual(['a1', 'a2', 'a3', 'a4', 'a5']);
  });
  it('wait_timeout_ms 从 action.args 复制到 step 级，args 不重复携带', async () => {
    const events = happyPathTrace();
    const fill = events.find((e) => e.t === 'action' && e.id === 'a4') as any;
    fill.args.wait_timeout_ms = 60000;
    writeTrace(ctx, events);
    const result = await buildIr('s_test');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const step = result.ir.steps.find((s) => s.trace_ref === 'a4')!;
    expect(step.wait_timeout_ms).toBe(60000);
    expect(step.args?.wait_timeout_ms).toBeUndefined();
    expect(parseIRv2(result.ir).ok).toBe(true);
  });

  it('非法 wait_timeout_ms → INSUFFICIENT_EVIDENCE', async () => {
    const events = happyPathTrace();
    const fill = events.find((e) => e.t === 'action' && e.id === 'a4') as any;
    fill.args.wait_timeout_ms = 0;
    writeTrace(ctx, events);
    const result = await buildIr('s_test');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INSUFFICIENT_EVIDENCE');
  });

});

describe('P4 provenance 真实来源校验', () => {
  let ctx: Ctx;
  beforeEach(() => { ctx = setupTrace(); });
  afterEach(() => { teardown(ctx); });

  it('session 缺 auth_source/browser_source → AUTH_PROVENANCE_MISSING（不补 unknown/default）', async () => {
    const events = happyPathTrace();
    const session = events[0] as Record<string, unknown>;
    delete session.auth_source;
    delete session.browser_source;
    writeTrace(ctx, events);
    const result = await buildIr('s_test');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('AUTH_PROVENANCE_MISSING');
    expect(result.error.hint).toContain('重新录制');
  });

  it.each([
    ['missing-auth', (s: Record<string, unknown>) => { delete s.auth_source; }],
    ['missing-browser', (s: Record<string, unknown>) => { delete s.browser_source; }],
  ])('只缺一个来源 → %s 同样 AUTH_PROVENANCE_MISSING', async (_name, mutate) => {
    const events = happyPathTrace();
    mutate(events[0] as Record<string, unknown>);
    writeTrace(ctx, events);
    const result = await buildIr('s_test');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('AUTH_PROVENANCE_MISSING');
  });

  it.each([
    ['bad-label', '-unknown', 'managed'],
    ['path-label', '../unknown', 'managed'],
    ['bad-combo-chrome-imported', 'imported', 'chrome-profile'],
    ['bad-combo-chrome-custom', 'team-imported-v2', 'chrome-profile'],
    ['bad-combo-managed-profile', 'profile', 'managed'],
    ['bad-combo-existing-profile', 'profile', 'existing'],
  ])('非法组合 %s → AUTH_PROVENANCE_INVALID', async (_name, auth, browser) => {
    const events = happyPathTrace();
    const session = events[0] as Record<string, unknown>;
    session.auth_source = auth;
    session.browser_source = browser;
    writeTrace(ctx, events);
    const result = await buildIr('s_test');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('AUTH_PROVENANCE_INVALID');
  });

  it('合法组合 → provenance 写真实来源（trace 与 IR 一致），不读本机状态猜来源', async () => {
    const events = happyPathTrace();
    const session = events[0] as Record<string, unknown>;
    session.auth_source = 'team.imported_v2-beta';
    session.browser_source = 'existing';
    writeTrace(ctx, events);
    const result = await buildIr('s_test');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ir.provenance.auth_source).toBe('team.imported_v2-beta');
    expect(result.ir.provenance.browser_source).toBe('existing');
    expect(parseIRv2(result.ir).ok).toBe(true);
  });

  it('历史 ci 标签继续作为普通录制事实读写', async () => {
    const events = happyPathTrace();
    const session = events[0] as Record<string, unknown>;
    session.auth_source = 'ci';
    session.browser_source = 'managed';
    writeTrace(ctx, events);
    const result = await buildIr('s_test');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ir.provenance.auth_source).toBe('ci');
    expect(parseIRv2(result.ir).ok).toBe(true);
  });
});
