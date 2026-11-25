/**
 * judge 单测：技术证据可执行性判据。
 * 新语义：不判业务完整性（不强制 creates 闭环/唯一性字段/固定数据），保留技术门禁；
 * checkIr 的 failures/skipped 成为 judge 不通过原因。
 */
import { describe, expect, it } from 'vitest';
import { judgeIr as judge } from '../judge.js';
import { parseTrace, type ParsedTrace } from '../trace-reader.js';
import { type IRv2, type Step } from '../schema.js';

function judgeTrace(): ParsedTrace {
  return parseTrace([
    { t: 'session', schema_version: 3, session_id: 's_j', env: 'pre', tool_version: '0.6.0', auth_source: 'profile', browser_source: 'chrome-profile' },
    { t: 'action', id: 'a1', kind: 'open', intent: '打开', nav: 'n1', settled_by: [{ kind: 'url', url: 'x' }] },
    { t: 'action', id: 'a2', kind: 'fill', intent: '填写名称', nav: 'n1', target: { matches: 1, candidates: [{ by: 'role', role: 'textbox', name: '商品名称', matches: 1 }] }, creates: { entity: 'item', path: '/api/item/publish/commit.json' }, settled_by: [{ kind: 'request', ref: 'r1', ms: 840 }] },
    { t: 'request', id: 'r1', path: '/api/item/publish/commit.json', nav: 'n1', call_index: 1, triggered_by: 'a2', creates: 'item' },
    { t: 'assert', after: 'a2', kind: 'api', expect: { path: 'success', op: '==', value: true, req: { path: '/api/item/publish/commit.json', nav: 'n1', call_index: 1 } }, pass: true, replayable: true },
    { t: 'assert', after: 'a2', kind: 'toast', expect: '提交成功', pass: true },
    { t: 'capture', after: 'a2', as: 'itemId', replayable: true, result: { ok: true, value: '1', from: { path: '/api/item/publish/commit.json', nav: 'n1', call_index: 1, req_id: 'r1' }, lineage: 'created', path: 'data.id' } },
    { t: 'session_end', result: 'pass', mocked: false },
  ]);
}

/** 只读用例的极简 trace（单个 toast 断言，与 readonlyIR 的 checks 一一对应） */
function readonlyTrace(): ParsedTrace {
  return parseTrace([
    { t: 'session', schema_version: 3, session_id: 's_j', env: 'pre', tool_version: '0.6.0', auth_source: 'profile', browser_source: 'chrome-profile' },
    { t: 'action', id: 'a1', kind: 'open', intent: '打开', nav: 'n1', settled_by: [{ kind: 'url', url: 'x' }] },
    { t: 'action', id: 'a2', kind: 'fill', intent: '填写名称', nav: 'n1', target: { matches: 1, candidates: [{ by: 'role', role: 'textbox', name: '商品名称', matches: 1 }] }, settled_by: [] },
    { t: 'action', id: 'a3', kind: 'click', intent: '编辑', nav: 'n1', target: { matches: 1, candidates: [{ by: 'role', role: 'button', name: '编辑', matches: 1 }] }, settled_by: [] },
    { t: 'assert', after: 'a2', kind: 'toast', expect: '提交成功', pass: true },
    { t: 'session_end', result: 'pass', mocked: false, asserts: { total: 1, pass: 1 } },
  ]);
}

function judgeIr(input: unknown) {
  return judge(input, { trace: judgeTrace() });
}

function step(partial: Partial<Step> & { id: string; action: Step['action']; trace_ref: string }): Step {
  return { intent: partial.id, ...partial } as Step;
}

function ir(steps: Step[], opts: { mocked?: boolean } = {}): IRv2 {
  return {
    schema_version: 3,
    name: 'judge-case',
    url: 'https://example.test/x.html',
    covered_pages: [],
    env: 'pre',
    provenance: { session_id: 's_j', auth_source: 'profile', browser_source: 'chrome-profile', tool_version: '0.6.0', generated_at: '2026-10-27T00:00:00.000Z', mocked: opts.mocked ?? false },
    steps,
  };
}

/** 正常新建闭环：open → fill(creates, template) → assert api → assert toast → capture created */
function happyPathIR(): IRv2 {
  return ir([
    step({ id: 's1', action: 'open', value: { literal: 'https://example.test/x.html' }, wait: [{ url: { contains: 'x' } }], trace_ref: 'a1' }),
    step({
      id: 's2', action: 'fill',
      locator: { role: 'textbox', name: '商品名称' },
      value: { template: 'E2E商品_${ts}' },
      save_as: 'title',
      creates: { entity: 'item', path: '/api/item/publish/commit.json' },
      wait: [{ api: { path: '/api/item/publish/commit.json', nav: 1, call_index: 1 } }],
      checks: [
        { assert: { api: { path: '/api/item/publish/commit.json', nav: 1, call_index: 1 }, expect: [{ path: 'success', op: 'eq', value: true }] } },
        { assert: { toast: '提交成功' } },
        { capture: { from_api: { path: '/api/item/publish/commit.json', nav: 1, call_index: 1 }, path: 'data.id', as: 'itemId', lineage: 'created' } },
      ],
      trace_ref: 'a2',
    }),
  ]);
}

/** 只读用例：无 creates，只有查询 + 断言（不规定必须创建业务实体） */
function readonlyIR(): IRv2 {
  return ir([
    step({ id: 's1', action: 'open', value: { literal: 'https://example.test/x.html' }, wait: [{ url: { contains: 'x' } }], trace_ref: 'a1' }),
    step({ id: 's2', action: 'click', locator: { role: 'textbox', name: '商品名称' }, trace_ref: 'a2', checks: [{ assert: { toast: '提交成功' } }] }),
  ]);
}

describe('judge 正常判绿', () => {
  it('模板名称 + creates + assert api + toast + capture created → regressible', () => {
    const r = judgeIr(happyPathIR());
    expect(r.regressible).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  it('只读用例（无 creates、有断言、技术证据完整）→ regressible', () => {
    const r = judge(readonlyIR(), { trace: readonlyTrace() });
    expect(r.regressible).toBe(true);
    expect(r.reasons).toEqual([]);
  });
});

describe('judge 已声明 creates 的核对（调用方数据一致性）', () => {
  it.each(['triggered_by', 'creates'])('请求缺正确 %s 证据拒绝', (field) => {
    const trace = judgeTrace();
    delete trace.requests[0][field as 'triggered_by' | 'creates'];
    expect(judge(happyPathIR(), { trace }).regressible).toBe(false);
  });

  it('creates 与 trace action 标注不一致 → 拒', () => {
    const test = happyPathIR();
    test.steps[1].creates = { entity: 'other', path: '/api/item/publish/commit.json' };
    const r = judgeIr(test);
    expect(r.regressible).toBe(false);
    expect(r.reasons.some((x) => x.includes('标注不一致'))).toBe(true);
  });

  it('creates 但 wait.api 三元组缺匹配归因 → 拒', () => {
    const trace = judgeTrace();
    trace.requests[0].path = '/api/other.json';
    const r = judge(happyPathIR(), { trace });
    expect(r.regressible).toBe(false);
    expect(r.reasons.some((x) => x.includes('触发归因'))).toBe(true);
  });
});

describe('judge 技术门禁（保留）', () => {
  it('关联 trace 缺失不能判绿', () => {
    expect(judge(happyPathIR()).regressible).toBe(false);
  });

  it('trace session_id 与 provenance 不一致 → 拒', () => {
    const trace = judgeTrace();
    trace.session = { ...trace.session!, session_id: 's_other' };
    const r = judge(happyPathIR(), { trace });
    expect(r.regressible).toBe(false);
    expect(r.reasons.some((x) => x.includes('不一致'))).toBe(true);
  });

  it('mocked=true → 拒', () => {
    const test = happyPathIR();
    test.provenance.mocked = true;
    const r = judgeIr(test);
    expect(r.regressible).toBe(false);
    expect(r.reasons.some((x) => x.includes('mock'))).toBe(true);
  });

  it('会话未 pass → 拒', () => {
    const trace = judgeTrace();
    trace.sessionEnd!.result = 'fail';
    expect(judge(happyPathIR(), { trace }).regressible).toBe(false);
  });

  it('含失败断言 → 拒', () => {
    const trace = judgeTrace();
    trace.asserts[0].pass = false;
    expect(judge(happyPathIR(), { trace }).regressible).toBe(false);
  });

  it('含 timeout 动作 → 拒', () => {
    const trace = judgeTrace();
    trace.actions[1].settled_by = [{ kind: 'timeout' }];
    expect(judge(happyPathIR(), { trace }).regressible).toBe(false);
  });

  it('无断言 → 拒', () => {
    const trace = judgeTrace();
    trace.asserts = [];
    expect(judge(happyPathIR(), { trace }).regressible).toBe(false);
  });

  it('IR schema 不合法 → 拒', () => {
    const r = judgeIr({ schema_version: 3 });
    expect(r.regressible).toBe(false);
    expect(r.reasons.some((x) => x.includes('schema'))).toBe(true);
  });

  it('checkIr 失败（trace_ref 不存在）→ judge 拒并带 ir check 原因', () => {
    const test = readonlyIR();
    test.steps[1].trace_ref = 'a-nonexistent';
    const r = judge(test, { trace: readonlyTrace() });
    expect(r.regressible).toBe(false);
    expect(r.reasons.some((x) => x.includes('ir check') && x.includes('trace_ref'))).toBe(true);
  });

  it('checkIr 失败（value.ref 引用未定义变量）→ judge 拒', () => {
    const test = readonlyIR();
    test.steps[1].value = { ref: 'undefined_var' };
    const r = judge(test, { trace: readonlyTrace() });
    expect(r.regressible).toBe(false);
    expect(r.reasons.some((x) => x.includes('value-consistency'))).toBe(true);
  });
});

describe('judge 业务推断已迁出（不再拒绝）', () => {
  it('creates 的 value 是 literal → 不再以唯一性字段规定拒绝', () => {
    const test = happyPathIR();
    test.steps[1].value = { literal: 'E2E商品_固定' };
    const r = judgeIr(test);
    expect(r.regressible).toBe(true);
  });

  it('写死实体 ID 的 URL / queried 变量引用 / literal 定位锚 → 不再以固定数据规则拒绝', () => {
    const test = readonlyIR();
    test.url = 'https://example.test/edit.html?itemId=12345';
    test.steps.push(step({ id: 'edit', action: 'open', value: { literal: 'https://example.test/items/12345' }, args: { url: 'https://example.test/items/12345' }, wait: [{ url: { contains: 'x' } }], trace_ref: 'a1' }));
    test.steps.push(step({ id: 'use', action: 'click', locator: { role: 'button', name: '编辑', within: { row: { contains: '固定商品' } } }, trace_ref: 'a2' }));
    // locator 无 matches=1 候选证据会被 checkIr 拒 —— 去掉 locator 改用 text ref 引用 queried 变量
    test.steps.pop();
    test.steps.push(step({ id: 'use', action: 'click', locator: { role: 'button', name: '编辑' }, trace_ref: 'a3' }));
    const r = judge(test, { trace: readonlyTrace() });
    // 无 '固定数据'/'queried'/'literal' 类业务拒绝原因
    expect(r.reasons.some((x) => /固定数据|queried|literal|唯一性/.test(x))).toBe(false);
    expect(r.regressible).toBe(true);
  });

  it('备注等非唯一性字段 + creates → 不再报缺唯一性字段', () => {
    const test = happyPathIR();
    test.steps[1].locator = { role: 'textbox', name: '备注' };
    const trace = judgeTrace();
    // candidates 同步改，保证 locator 可达性绿，聚焦唯一性规则已删
    const action = trace.actions.find((a) => a.id === 'a2')!;
    (action as { target?: unknown }).target = { matches: 1, candidates: [{ by: 'role', role: 'textbox', name: '备注', matches: 1 }] };
    const r = judge(test, { trace });
    expect(r.reasons.some((x) => x.includes('唯一性'))).toBe(false);
    expect(r.regressible).toBe(true);
  });
});
