/**
 * 3.3 ir check 单测：校验道各有正反；手改 call_index 为 trace 不存在的值被拒。
 */
import { describe, expect, it } from 'vitest';
import { checkIr } from '../check.js';
import { type IRv2 } from '../schema.js';
import { parseTrace, type ParsedTrace, type TraceEvent } from '../trace-reader.js';

function baseIR(): IRv2 {
  return {
    schema_version: 3,
    name: 'case-check',
    url: 'https://portal.example.invalid/@item/pages/publish/normal.html',
    covered_pages: [],
    env: 'pre',
    provenance: { session_id: 's_check', auth_source: 'profile', browser_source: 'chrome-profile', tool_version: '0.6.0', generated_at: '2026-10-27T00:00:00.000Z', mocked: false },
    steps: [
      {
        id: 's1',
        intent: '打开页面',
        action: 'open',
        value: { literal: 'https://portal.example.invalid/@item/pages/publish/normal.html' },
        args: { url: 'https://portal.example.invalid/@item/pages/publish/normal.html' },
        wait: [{ url: { contains: 'publish/normal.html' } }],
        trace_ref: 'a1',
      },
      {
        id: 's2',
        intent: '填写名称',
        action: 'fill',
        locator: { role: 'textbox', name: '商品名称' },
        value: { template: 'E2E商品_${ts}' },
        save_as: 'title',
        creates: { entity: 'item', path: '/api/item/publish/commit.json' },
        wait: [{ api: { path: '/api/item/publish/commit.json', nav: 1, call_index: 1 } }],
        checks: [
          { assert: { api: { path: '/api/item/publish/commit.json', nav: 1, call_index: 1 }, expect: [{ path: 'success', op: 'eq', value: true }] } },
          { capture: { from_api: { path: '/api/item/publish/commit.json', nav: 1, call_index: 1 }, path: 'data.id', as: 'itemId', lineage: 'created' } },
        ],
        trace_ref: 'a2',
      },
    ],
  };
}

function baseTrace(): TraceEvent[] {
  return [
    { t: 'session', id: 'session', ts: 1, session_id: 's_check', schema_version: 3, env: 'pre', tool_version: '0.6.0', auth_source: 'profile', browser_source: 'chrome-profile' },
    { t: 'action', id: 'a1', ts: 10, kind: 'open', intent: '打开页面', nav: 'n0', args: { url: 'https://portal.example.invalid/@item/pages/publish/normal.html' }, value: { raw: 'https://portal.example.invalid/@item/pages/publish/normal.html', origin: 'literal' }, result: { ok: true }, settled_by: [{ kind: 'url', url: 'publish/normal.html' }], requests: [] },
    { t: 'action', id: 'a2', ts: 20, kind: 'fill', intent: '填写名称', nav: 'n1', args: {}, value: { raw: 'E2E商品_123', origin: 'generated', template: 'E2E商品_${ts}' }, save_as: 'title', creates: { entity: 'item', path: '/api/item/publish/commit.json' }, target: { resolved_by: 'ax', role: 'textbox', name: '商品名称', matches: 1, backendNodeId: 101, candidates: [{ by: 'role', role: 'textbox', name: '商品名称', matches: 1 }] }, result: { ok: true }, settled_by: [{ kind: 'request', ref: 'r1', ms: 840 }], requests: ['r1'], resolved_value: 'E2E商品_123', saved_value: 'E2E商品_123' },
    { t: 'request', id: 'r1', ts: 21, path: '/api/item/publish/commit.json', nav: 'n1', call_index: 1, method: 'POST', url: 'https://portal.example.invalid/api/item/publish/commit.json', status: 200, failed: null, mocked: false, triggered_by: 'a2', creates: 'item' },
    { t: 'assert', after: 'a2', kind: 'api', expect: { path: 'success', op: '==', value: true, req: { path: '/api/item/publish/commit.json', nav: 'n1', call_index: 1 } }, pass: true, replayable: true },
    { t: 'capture', after: 'a2', as: 'itemId', replayable: true, result: { ok: true, value: '1', from: { path: '/api/item/publish/commit.json', nav: 'n1', call_index: 1, req_id: 'r1' }, lineage: 'created', path: 'data.id' } },
    { t: 'session_end', id: 'session_end', ts: 100, result: 'pass', mocked: false, asserts: { total: 1, pass: 1 }, timeouts: 0, ended_at: '2026-10-27T00:00:00.000Z' },
  ];
}

function parsedTrace(events: TraceEvent[]): ParsedTrace {
  return parseTrace(events);
}

describe('ir check 全绿', () => {
  it('合法 IR + 匹配 trace → 全部校验通过', () => {
    const r = checkIr(baseIR(), { trace: parsedTrace(baseTrace()) });
    expect(r.passed).toBe(true);
    expect(r.failures).toEqual([]);
  });

  it('无 trace 时跳过动态校验道，静态道全过', () => {
    const r = checkIr(baseIR(), {});
    expect(r.passed).toBe(true);
    expect(r.skipped.some((s) => s.includes('请求引用'))).toBe(true);
  });
});

describe('道 1 schema', () => {
  it.each([{ text: '' }, { url: { contains: '' } }, { element: { role: '' }, state: 'visible' }])('finding 2：空占位等待拒绝 %j', (wait) => {
    const ir = baseIR();
    ir.steps[0].wait = [wait as any];
    expect(checkIr(ir).passed).toBe(false);
  });
  it('缺 steps 拒', () => {
    const ir = baseIR() as unknown as Record<string, unknown>;
    delete ir.steps;
    const r = checkIr(ir, {});
    expect(r.passed).toBe(false);
    expect(r.failures.some((f) => f.rule === 'schema')).toBe(true);
  });
});

describe('道 2 locator 可达性', () => {
  it('finding 8：locator 改成不存在的按钮，即使操作 matches=1 也拒绝', () => {
    const ir = baseIR();
    ir.steps[1].locator = { role: 'button', name: '不存在的按钮' };
    const result = checkIr(ir, { trace: parsedTrace(baseTrace()) });
    expect(result.passed).toBe(false);
    expect(result.failures.some((failure) => failure.rule === 'locator-reachable')).toBe(true);
  });

  it.each(['target', 'trace_ref'])('finding 8：缺 %s 定位证据拒绝，不跳过', (missing) => {
    const events = baseTrace();
    if (missing === 'target') delete events.find((event) => event.id === 'a2')!.target;
    else events.find((event) => event.id === 'a2')!.id = 'other';
    expect(checkIr(baseIR(), { trace: parsedTrace(events) }).passed).toBe(false);
  });

  it('finding 8：无候选定位证据拒绝', () => {
    const events = baseTrace();
    const target = events.find((event) => event.id === 'a2')!.target as Record<string, unknown>;
    delete target.candidates;
    expect(checkIr(baseIR(), { trace: parsedTrace(events) }).passed).toBe(false);
  });
  it('matches!=1 拒', () => {
    const events = baseTrace();
    (events[2] as { target: { matches: number } }).target.matches = 3;
    const r = checkIr(baseIR(), { trace: parsedTrace(events) });
    expect(r.passed).toBe(false);
    expect(r.failures.some((f) => f.rule === 'locator-reachable' && f.step === 's2')).toBe(true);
  });
});

describe('道 3 请求引用完整性', () => {
  it('手改 call_index 为 trace 不存在的值拒', () => {
    const ir = baseIR();
    // s2 的 wait.api call_index 改成 99（trace 里只有 call_index=1）
    ir.steps[1].wait = [{ api: { path: '/api/item/publish/commit.json', nav: 1, call_index: 99 } }];
    const r = checkIr(ir, { trace: parsedTrace(baseTrace()) });
    expect(r.passed).toBe(false);
    expect(r.failures.some((f) => f.rule === 'request-ref')).toBe(true);
  });

  it('assert.api 引用不存在拒', () => {
    const ir = baseIR();
    ir.steps[1].checks = [{ assert: { api: { path: '/api/x', nav: 1, call_index: 1 }, expect: [{ path: 'ok', op: 'eq', value: true }] } }];
    const r = checkIr(ir, { trace: parsedTrace(baseTrace()) });
    expect(r.passed).toBe(false);
    expect(r.failures.some((f) => f.rule === 'request-ref')).toBe(true);
  });
});

describe('道 6 checks 来源核对', () => {
  it('Phase2：text.value 与 trace 显式来源一致；IR 漏掉 value 拒', () => {
    const events = baseTrace().filter((event) => event.t !== 'assert' && event.t !== 'capture');
    events.splice(events.length - 1, 0, {
      t: 'assert', after: 'a2', kind: 'text',
      expect: { contains: 'E2E商品_123', within: null },
      pass: true,
      value: { raw: 'E2E商品_123', origin: 'generated', template: 'E2E商品_${ts}', source_action: 'a2' },
    });
    const ir = baseIR();
    ir.steps[1].checks = [{
      assert: {
        text: { contains: 'E2E商品_123', value: { from_action: 's2' } },
      },
    }];
    expect(checkIr(ir, { trace: parsedTrace(events) }).passed).toBe(true);

    delete ir.steps[1].checks![0].assert.text!.value;
    const result = checkIr(ir, { trace: parsedTrace(events) });
    expect(result.failures.some((failure) => failure.rule === 'checks-mapping')).toBe(true);
  });
});

describe('道 4 value 一致性', () => {
  it.each(['${bogus}', '${ts}_${bogus}', '${date:BOGUS}', '${ts'])('finding 14：非法模板 %s 拒绝', (template) => {
    const ir = baseIR();
    ir.steps[1].value = { template };
    expect(checkIr(ir).failures.some((failure) => failure.rule === 'value-consistency')).toBe(true);
  });

  it.each(['${ts}', '${rand6}', '${random}', '${date:YYYY-MM-DD}'])('finding 14：支持的生成模板 %s 通过', (template) => {
    const ir = baseIR();
    ir.steps[1].value = { template };
    expect(checkIr(ir).passed).toBe(true);
  });

  it('finding 14：嵌套 fields 的非法模板同样拒绝', () => {
    const ir = baseIR();
    ir.steps[1].action = 'fill_form';
    ir.steps[1].args = { fields: { 商品名称: { template: '${bogus}' } } };
    expect(checkIr(ir).passed).toBe(false);
  });

  it.each(['value', 'fields', 'assert'])('finding 9：%s 引用后续才定义的变量拒绝', (where) => {
    const ir = baseIR();
    if (where === 'value') ir.steps[0].value = { ref: 'title' };
    if (where === 'fields') { ir.steps[0].action = 'fill_form'; ir.steps[0].args = { fields: { 商品名称: { ref: 'title' } }, field_locators: { 商品名称: { role: 'textbox', name: '商品名称' } }, field_order: ['商品名称'], scope: 'targeted' }; }
    if (where === 'assert') ir.steps[0].checks = [{ assert: { field_value: { label: '名称', value: { ref: 'title' }, locator: { role: 'textbox', name: '商品名称' }, read_mode: 'value' } } }];
    const result = checkIr(ir);
    expect(result.passed).toBe(false);
    expect(result.failures.some((failure) => failure.rule === 'value-consistency')).toBe(true);
  });

  it('finding 9：同一步先 assert 后 capture 不允许向后引用；交换顺序后通过', () => {
    const ir = baseIR();
    const assertion: any = { assert: { field_value: { label: '编码', value: { ref: 'late' }, locator: { role: 'textbox', name: '商品编码' }, read_mode: 'value' } } };
    const capture: any = { capture: { from_api: { path: '/api/item/publish/commit.json', nav: 1, call_index: 1 }, path: 'data.id', as: 'late', lineage: 'created' } };
    ir.steps[1].checks = [assertion, capture];
    expect(checkIr(ir).passed).toBe(false);
    ir.steps[1].checks = [capture, assertion];
    expect(checkIr(ir).passed).toBe(true);
  });
  it('template 不含合法占位符拒', () => {
    const ir = baseIR();
    ir.steps[1].value = { template: '固定名称' };
    const r = checkIr(ir, {});
    expect(r.passed).toBe(false);
    expect(r.failures.some((f) => f.rule === 'value-consistency' && f.step === 's2')).toBe(true);
  });

  it('ref 指向不存在的变量拒', () => {
    const ir = baseIR();
    ir.steps[1].value = { ref: 'nonexistent' };
    const r = checkIr(ir, {});
    expect(r.passed).toBe(false);
    expect(r.failures.some((f) => f.rule === 'value-consistency')).toBe(true);
  });

  it('ref 指向前序 save_as 通过', () => {
    const ir = baseIR();
    ir.steps.push({ id: 's3', intent: '回填', action: 'fill', locator: { label: 'x' }, value: { ref: 'title' }, trace_ref: 'a3' });
    const r = checkIr(ir, {});
    expect(r.passed).toBe(true);
  });

  it('N1：assert.api expect[].value 里的 {ref:xxx} 不被当 Value 扫（不触发 value-consistency）', () => {
    const ir = baseIR();
    // assert.api expect 的 value 是 { ref: 'nonexistent' }——如果 walkValues 误当 Value 会报 value-consistency
    ir.steps[1].checks = [{ assert: { api: { path: '/api/item/publish/commit.json', nav: 1, call_index: 1 }, expect: [{ path: 'data', op: 'eq', value: { ref: 'nonexistent' } }] } }];
    const r = checkIr(ir, {});
    // 不应报 value-consistency（assert.api 的 expect value 是普通 JSON）
    expect(r.failures.some((f) => f.rule === 'value-consistency')).toBe(false);
  });

  it('P1-1：field_value.value.template 的 ${ts} 不被 walkStrings 当变量引用', () => {
    const ir = baseIR();
    // generated fill 不带 save_as，字段断言用 template
    delete ir.steps[1].save_as;
    ir.steps[1].checks = [{ assert: { field_value: { label: '商品名称', value: { template: 'E2E商品_${ts}' }, locator: { role: 'textbox', name: '商品名称' }, read_mode: 'value' } } }];
    const r = checkIr(ir, {});
    // 不应报 value-consistency（template ${ts} 是占位符不是变量引用）
    expect(r.passed).toBe(true);
    expect(r.failures.some((f) => f.rule === 'value-consistency')).toBe(false);
  });
});

describe('道 5 wait 一致性', () => {
  it('wait.api 引用 trace 不存在拒', () => {
    const ir = baseIR();
    ir.steps[1].wait = [{ api: { path: '/api/missing', nav: 5, call_index: 1 } }];
    const r = checkIr(ir, { trace: parsedTrace(baseTrace()) });
    expect(r.passed).toBe(false);
    expect(r.failures.some((f) => f.rule === 'wait-consistency')).toBe(true);
  });
});

describe('内容边界（不做内容 DLP）', () => {
  it.each(['url', 'covered_pages', 'description', 'fallback', 'wait'])('%s 含 session/authorization 单词的正常语义不再被拒', (where) => {
    const ir = baseIR();
    if (where === 'url') ir.url = 'https://example.test/?sessionId=1';
    if (where === 'covered_pages') ir.covered_pages = ['https://example.test/?sessionId=1'];
    if (where === 'description') ir.description = '校验 session 字段的正常描述';
    if (where === 'fallback') ir.steps[1].fallback = [{ css: '[data-session="plain"]' }];
    if (where === 'wait') ir.steps[0].wait = [{ url: { contains: '?sessionId=1' } }];
    const result = checkIr(ir);
    expect(result.passed).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it('已生成的 /backedItem/sessionSecret.json 接口路径不再因单词被拒', () => {
    const ir = baseIR();
    ir.steps[0].wait = [{ api: { path: '/backedItem/sessionSecret.json', nav: 1, call_index: 1 } }];
    const r = checkIr(ir, {});
    expect(r.passed).toBe(true);
  });

  it('字段名/定位器/intent 含 authorization/token 的正常语义通过', () => {
    const ir = baseIR();
    ir.steps[0].intent = '打开 authorization token 管理页';
    ir.steps[1].locator = { role: 'textbox', name: 'authorization token 输入框' };
    const r = checkIr(ir, {});
    expect(r.passed).toBe(true);
  });

  it('四种 ApiRef（wait.api/assert.api/assert.request/capture.from_api）含 sessionSecret 路径均通过', () => {
    const ir = baseIR();
    ir.steps[1].wait = [
      { api: { path: '/api/item/publish/commit.json', nav: 1, call_index: 1 } },
      { api: { path: '/backedItem/sessionSecret.json', nav: 1, call_index: 1 } },
    ];
    ir.steps[1].checks = [
      { assert: { api: { path: '/backedItem/sessionSecret.json', nav: 1, call_index: 1 }, expect: [{ path: 'data', op: 'eq', value: true }] } },
      { assert: { request: { path: '/backedItem/sessionSecret.json', nav: 1, call_index: 1 }, body: [{ path: 'token', op: 'exists', value: '' }] } },
      { capture: { from_api: { path: '/backedItem/sessionSecret.json', nav: 1, call_index: 1 }, path: 'data', as: 'sessionData', lineage: 'queried' } },
    ];
    const r = checkIr(ir, {});
    expect(r.passed).toBe(true);
  });
});

describe('道 6 refine', () => {
  it.each(['', 'abc-proof.bin', `${'a'.repeat(64)}-`, `${'a'.repeat(64)}-a/b.bin`, `${'a'.repeat(64)}-a\\b.bin`, `${'a'.repeat(64)}-a\u0000.bin`])('upload 非法 fixture basename %j 由共享 schema 拒绝', (file) => {
    const ir = baseIR();
    ir.steps[1].action = 'upload';
    ir.steps[1].args = { files: [file] };
    const result = checkIr(ir);
    expect(result.passed).toBe(false);
    expect(result.failures.some((failure) => failure.rule === 'schema')).toBe(true);
  });
  it('upload 安全 hash-原名通过共享 schema', () => {
    const ir = baseIR();
    ir.steps[1].action = 'upload';
    ir.steps[1].args = { files: [`${'a'.repeat(64)}-proof.bin`] };
    expect(checkIr(ir).passed).toBe(true);
  });
  it('finding 6：upload args.files 残留 blob 对象拒绝', () => {
    const ir = baseIR();
    ir.steps[1].action = 'upload';
    ir.steps[1].args = { files: [{ blob_ref: 'blobs/abc' }] };
    const result = checkIr(ir);
    expect(result.passed).toBe(false);
    expect(result.failures.some((failure) => failure.rule === 'schema')).toBe(true);
  });
  it('fill_form 无 scope/fields 拒（schema 同源守卫拒绝，不再 refine 重复维护）', () => {
    const ir = baseIR();
    ir.steps[1].action = 'fill_form';
    ir.steps[1].args = {};
    const r = checkIr(ir, {});
    expect(r.passed).toBe(false);
    expect(r.failures.some((f) => f.rule === 'schema' && f.message.includes('fill_form'))).toBe(true);
  });

  it('open 后无 wait 且无后续步骤 拒', () => {
    const ir = baseIR();
    ir.steps = [ir.steps[0]];
    delete ir.steps[0].wait;
    const r = checkIr(ir, {});
    expect(r.passed).toBe(false);
    expect(r.failures.some((f) => f.rule === 'refine' && f.message.includes('open'))).toBe(true);
  });

  it('creates 没有对应 wait.api 拒', () => {
    const ir = baseIR();
    ir.steps[1].wait = []; // 清掉对应 wait
    const r = checkIr(ir, {});
    expect(r.passed).toBe(false);
    expect(r.failures.some((f) => f.rule === 'refine' && f.message.includes('creates'))).toBe(true);
  });

  it('press 无 key 拒（schema 同源守卫拒绝）', () => {
    const ir = baseIR();
    ir.steps.push({ id: 's3', intent: '按键', action: 'press', locator: { role: 'textbox' }, args: {}, trace_ref: 'a3' });
    const r = checkIr(ir, {});
    expect(r.passed).toBe(false);
    expect(r.failures.some((f) => f.rule === 'schema' && f.message.includes('press'))).toBe(true);
  });

  it('switch_tab 无真实 target 证据拒（旧假 history switch）', () => {
    const ir = baseIR();
    ir.steps.push({ id: 's4', intent: '假切', action: 'switch_tab', args: { index: 1 }, trace_ref: 'a4' });
    const r = checkIr(ir, {});
    expect(r.passed).toBe(false);
    expect(r.failures.some((f) => f.rule === 'refine' && f.message.includes('switch_tab'))).toBe(true);
  });

  it('switch_tab 带真实 target_id 过 refine', () => {
    const ir = baseIR();
    ir.steps.push({ id: 's5', intent: '切列表', action: 'switch_tab', args: { target_id: 'tab-2', resolved_index: 1, resolved_url: 'https://x/list' }, trace_ref: 'a5' });
    const r = checkIr(ir, {});
    // switch_tab 带 target_id 不触发 refine 失败（其他 baseIR 步骤可能仍失败，但不应是 switch_tab refine）
    expect(r.failures.some((f) => f.rule === 'refine' && f.message.includes('switch_tab'))).toBe(false);
  });
});

describe('P4 provenance 来源核对', () => {
  it('trace session 缺来源 → provenance 规则失败', () => {
    const ir = baseIR();
    const events = baseTrace().map((ev, i) => i === 0
      ? (() => { const { auth_source: _a, browser_source: _b, ...rest } = ev as Record<string, unknown>; return rest; })()
      : ev);
    const checked = checkIr(ir, { trace: parsedTrace(events) });
    expect(checked.passed).toBe(false);
    expect(checked.failures.some((f) => f.rule === 'provenance' && f.message.includes('缺失'))).toBe(true);
  });

  it('IR 与 trace 来源不一致 → provenance 规则失败（不悄悄接受）', () => {
    const ir = baseIR();
    const events = baseTrace().map((ev, i) => i === 0
      ? { ...(ev as Record<string, unknown>), auth_source: 'ci' }
      : ev);
    const checked = checkIr(ir, { trace: parsedTrace(events) });
    expect(checked.passed).toBe(false);
    expect(checked.failures.some((f) => f.rule === 'provenance' && f.message.includes('不一致'))).toBe(true);
  });

  it('IR 与 trace 来源一致 → 通过（无 provenance 失败）', () => {
    const checked = checkIr(baseIR(), { trace: parsedTrace(baseTrace()) });
    expect(checked.failures.filter((f) => f.rule === 'provenance')).toEqual([]);
  });
});
