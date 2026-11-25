/**
 * 3.1 IR v2 schema 单测：合法 IR 通过 / 缺字段 / 错类型 / 非法 action / 非法 name / value 三态缺失 / wait api 缺 call_index 拒。
 */
import { describe, expect, it } from 'vitest';
import { IRv2Schema, parseIRv2, type IRv2 } from '../schema.js';
import { MAX_WAIT_TIMEOUT_MS } from '../../wait-timeout.js';

/** 最小合法 IR：一个 open 步骤。后续用例在此基础上 mutation。 */
function baseIR(): IRv2 {
  return {
    schema_version: 3,
    name: 'item-publish-normal',
    description: '新建普通商品并在列表回查',
    url: 'https://portal.example.invalid/@item/pages/publish/normal.html',
    covered_pages: ['https://portal.example.invalid/@example-dashboard/pages/master/release.html'],
    env: 'pre',
    provenance: {
      session_id: 's_0423a',
      auth_source: 'profile',
      browser_source: 'chrome-profile',
      tool_version: '0.6.0',
      generated_at: '2026-10-27T00:00:00.000Z',
      mocked: false,
    },
    steps: [
      {
        id: 's1',
        intent: '打开新建商品页',
        action: 'open',
        value: { literal: 'https://portal.example.invalid/@item/pages/publish/normal.html' },
        wait: [{ url: { contains: 'publish/normal.html' } }],
        trace_ref: 'a1',
      },
    ],
  };
}

describe('IRv2 schema 合法', () => {
  it('最小合法 IR 通过', () => {
    const r = parseIRv2(baseIR());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ir.steps).toHaveLength(1);
  });

  it('全套字段：role locator + template value + api wait + assert/capture checks', () => {
    const ir = baseIR();
    ir.steps.push(
      {
        id: 's2',
        intent: '填写商品名称',
        action: 'fill',
        locator: { role: 'textbox', name: '商品名称' },
        value: { template: 'E2E商品_${ts}' },
        save_as: 'title',
        wait: [{ api: { path: '/api/item/publish/commit.json', nav: 1, call_index: 2 } }],
        trace_ref: 'a2',
        creates: { entity: 'item', path: '/api/item/publish/commit.json' },
        checks: [
          { assert: { toast: '提交成功' } },
          { capture: { from_api: { path: '/api/item/publish/commit.json', nav: 1, call_index: 2 }, path: 'data.items[0].id', as: 'itemId', lineage: 'created' } },
        ],
      },
      {
        id: 's3',
        intent: '列表回查',
        action: 'click',
        locator: { row: { contains: '${title}' }, role: 'link', name: '编辑' },
        checks: [{ assert: { table_row: { contains: '${title}', count: 1 } } }],
        trace_ref: 'a3',
      },
    );
    expect(parseIRv2(ir).ok).toBe(true);
  });

  it('css locator + literal value + element wait visible', () => {
    const ir = baseIR();
    ir.steps.push({
      id: 's2',
      intent: '点确定',
      action: 'click',
      locator: { css: '.next-dialog .next-btn-primary' },
      value: { literal: '100' },
      wait: [{ element: { role: 'dialog' }, state: 'visible' }],
      trace_ref: 'a2',
    });
    expect(parseIRv2(ir).ok).toBe(true);
  });

  it('ref value + dom_quiet wait', () => {
    const ir = baseIR();
    ir.steps.push({
      id: 's2',
      intent: '回填 itemId',
      action: 'fill',
      locator: { label: '商品编码' },
      value: { ref: 'itemId' },
      wait: [{ dom_quiet: { ms: 300 } }],
      trace_ref: 'a2',
    });
    expect(parseIRv2(ir).ok).toBe(true);
  });

  it('provenance auth_source 接受自定义安全标签与历史 ci 值', () => {
    const custom = baseIR();
    custom.provenance.auth_source = 'team.imported_v1-beta';
    custom.provenance.browser_source = 'managed';
    expect(parseIRv2(custom).ok).toBe(true);

    const legacyCi = baseIR();
    legacyCi.provenance.auth_source = 'ci';
    legacyCi.provenance.browser_source = 'managed';
    expect(parseIRv2(legacyCi).ok).toBe(true);
  });
});

describe('IRv2 schema 拒绝', () => {
  it('schema_version 非 2 拒', () => {
    const ir = baseIR() as unknown as Record<string, unknown>;
    ir.schema_version = 1;
    const r = parseIRv2(ir);
    expect(r.ok).toBe(false);
  });

  it('缺 steps 拒', () => {
    const ir = baseIR();
    delete (ir as Partial<IRv2>).steps;
    expect(parseIRv2(ir).ok).toBe(false);
  });

  it('非法 action 拒', () => {
    const ir = baseIR();
    (ir.steps[0] as { action: string }).action = 'sleep';
    const r = parseIRv2(ir);
    expect(r.ok).toBe(false);
  });

  it('name 不符正则（中文开头）拒', () => {
    const ir = baseIR();
    ir.name = '商品发布';
    expect(parseIRv2(ir).ok).toBe(false);
  });

  it('name 数字开头合法', () => {
    const ir = baseIR();
    ir.name = '1case';
    expect(parseIRv2(ir).ok).toBe(true);
  });

  it('value 三态缺失：template 缺 template 字段拒', () => {
    const ir = baseIR();
    // value 对象存在但不含 literal/template/ref 任一 key
    ir.steps.push({ id: 's2', intent: 'x', action: 'fill', locator: { label: 'a' }, value: { bogus: 1 } as unknown as { template: string }, trace_ref: 'a2' });
    expect(parseIRv2(ir).ok).toBe(false);
  });

  it('value 三态缺失：ref 缺 ref 字段拒', () => {
    const ir = baseIR();
    ir.steps.push({ id: 's2', intent: 'x', action: 'fill', locator: { label: 'a' }, value: { bogus: 1 } as unknown as { ref: string }, trace_ref: 'a2' });
    expect(parseIRv2(ir).ok).toBe(false);
  });

  it('wait api 缺 call_index 拒', () => {
    const ir = baseIR();
    ir.steps[0].wait = [{ api: { path: '/x', nav: 1 } } as unknown as { api: { path: string; nav: number; call_index: number } }];
    expect(parseIRv2(ir).ok).toBe(false);
  });

  it('wait api call_index 非正整数拒', () => {
    const ir = baseIR();
    ir.steps[0].wait = [{ api: { path: '/x', nav: 1, call_index: 0 } }];
    expect(parseIRv2(ir).ok).toBe(false);
  });

  it('locator unknown 字段拒', () => {
    const ir = baseIR();
    (ir.steps[0] as { locator?: unknown }).locator = { foo: 'bar' };
    expect(parseIRv2(ir).ok).toBe(false);
  });

  it('assert op 非法值拒', () => {
    const ir = baseIR();
    ir.steps.push({
      id: 's2', intent: 'x', action: 'click', locator: { role: 'button' }, trace_ref: 'a2',
      checks: [{ assert: { api: { path: '/x', nav: 1, call_index: 1 }, expect: [{ path: 'success', op: 'matches', value: true }] } }],
    });
    expect(parseIRv2(ir).ok).toBe(false);
  });

  it('capture lineage 非法值拒', () => {
    const ir = baseIR();
    ir.steps.push({
      id: 's2', intent: 'x', action: 'click', locator: { role: 'button' }, trace_ref: 'a2',
      checks: [{ capture: { from_api: { path: '/x', nav: 1, call_index: 1 }, path: 'data.id', as: 'x', lineage: 'fetched' } }],
    });
    expect(parseIRv2(ir).ok).toBe(false);
  });

  it('env 非法值拒', () => {
    const ir = baseIR() as unknown as Record<string, unknown>;
    ir.env = '-staging';
    expect(parseIRv2(ir).ok).toBe(false);
  });

  it.each([
    ['空标签', ''],
    ['前导连字符', '-imported'],
    ['空白', 'team imported'],
    ['控制字符', 'team\nimported'],
    ['路径字符', '../imported'],
    ['非 ASCII', '团队'],
  ])('provenance auth_source %s 拒', (_name, value) => {
    const ir = baseIR();
    ir.provenance.auth_source = value;
    ir.provenance.browser_source = 'managed';
    expect(parseIRv2(ir).ok).toBe(false);
  });

  it('provenance 缺 mocked 拒', () => {
    const ir = baseIR();
    delete (ir.provenance as { mocked?: boolean }).mocked;
    expect(parseIRv2(ir).ok).toBe(false);
  });

  it('chrome-profile 只允许配 profile，不允许自定义标签冒充 profile 浏览器', () => {
    const ir = baseIR();
    ir.provenance.auth_source = 'team-profile-v2';
    expect(parseIRv2(ir).ok).toBe(false);
  });
});

describe('IRv2 schema 直接调用', () => {
  it('IRv2Schema.safeParse 返回 issues', () => {
    const r = IRv2Schema.safeParse({ schema_version: 3 });
    expect(r.success).toBe(false);
  });
});

describe('Step.wait_timeout_ms', () => {
  const baseStep = { id: 's1', intent: 'i', action: 'open' as const, trace_ref: 'a1', value: { literal: 'https://x.com' } };
  function irWith(step: Record<string, unknown>): IRv2 {
    return { schema_version: 3, name: 'wt', url: 'https://x.com', covered_pages: [], env: 'pre',
      provenance: { session_id: 's', auth_source: 'imported', browser_source: 'managed', tool_version: '0', generated_at: '2026-01-01T00:00:00Z', mocked: false },
      steps: [step as any] };
  }
  it('正整数合法', () => {
    expect(parseIRv2(irWith({ ...baseStep, wait_timeout_ms: 60000 })).ok).toBe(true);
  });
  it('上限值合法', () => {
    expect(parseIRv2(irWith({ ...baseStep, wait_timeout_ms: MAX_WAIT_TIMEOUT_MS })).ok).toBe(true);
  });
  it('零拒', () => {
    expect(parseIRv2(irWith({ ...baseStep, wait_timeout_ms: 0 })).ok).toBe(false);
  });
  it('负数拒', () => {
    expect(parseIRv2(irWith({ ...baseStep, wait_timeout_ms: -1 })).ok).toBe(false);
  });
  it('小数拒', () => {
    expect(parseIRv2(irWith({ ...baseStep, wait_timeout_ms: 1.5 })).ok).toBe(false);
  });
  it('超上限拒', () => {
    expect(parseIRv2(irWith({ ...baseStep, wait_timeout_ms: MAX_WAIT_TIMEOUT_MS + 1 })).ok).toBe(false);
  });
  it('两个各自合法预算聚合 overflow → SCHEMA 拒（steps）', () => {
    const ir = { schema_version: 3, name: 'wt', url: 'https://x.com', covered_pages: [], env: 'pre',
      provenance: { session_id: 's', auth_source: 'imported', browser_source: 'managed', tool_version: '0', generated_at: '2026-01-01T00:00:00Z', mocked: false },
      steps: [
        { ...baseStep, wait_timeout_ms: MAX_WAIT_TIMEOUT_MS },
        { ...baseStep, id: 's2', trace_ref: 'a2', wait_timeout_ms: MAX_WAIT_TIMEOUT_MS },
      ] } as any;
    const r = parseIRv2(ir);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('SCHEMA');
    expect(r.error.issues.some((i) => i.path === 'steps')).toBe(true);
  });
  it('IRv2Schema.safeParse 聚合 overflow 同样拒绝', () => {
    const ir = { schema_version: 3, name: 'wt', url: 'https://x.com', covered_pages: [], env: 'pre',
      provenance: { session_id: 's', auth_source: 'imported', browser_source: 'managed', tool_version: '0', generated_at: '2026-01-01T00:00:00Z', mocked: false },
      steps: [
        { ...baseStep, wait_timeout_ms: MAX_WAIT_TIMEOUT_MS },
        { ...baseStep, id: 's2', trace_ref: 'a2', wait_timeout_ms: MAX_WAIT_TIMEOUT_MS },
      ] } as any;
    expect(IRv2Schema.safeParse(ir).success).toBe(false);
  });
  it('刚好不溢出的聚合合法', () => {
    // 单步 MAX_WAIT_TIMEOUT_MS 合法；两步会溢出。用两个较大但不溢出的值
    const half = Math.floor(MAX_WAIT_TIMEOUT_MS / 3);
    const ir = { schema_version: 3, name: 'wt', url: 'https://x.com', covered_pages: [], env: 'pre',
      provenance: { session_id: 's', auth_source: 'imported', browser_source: 'managed', tool_version: '0', generated_at: '2026-01-01T00:00:00Z', mocked: false },
      steps: [
        { ...baseStep, wait_timeout_ms: half },
        { ...baseStep, id: 's2', trace_ref: 'a2', wait_timeout_ms: half },
      ] } as any;
    expect(parseIRv2(ir).ok).toBe(true);
  });
});
describe('Phase2 wire3', () => {
  it('schema_version 非 3 拒', () => {
    const r = parseIRv2({ ...baseIR(), schema_version: 2 });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error.issues.some((i) => i.path === 'schema_version')).toBe(true);
  });
});
