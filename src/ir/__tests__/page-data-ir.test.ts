/**
 * P2 ir 层红前测试:trace-reader observations 桶、schema data 断言、build 拒绝失败观察、
 * check 动态核对(observation_ref)、judge 拒绝失败观察。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildIr } from '../build.js';
import { parseIRv2 } from '../schema.js';
import { checkIr } from '../check.js';
import { judgeIr } from '../judge.js';
import { parseTrace, readTrace, type TraceEvent } from '../trace-reader.js';

interface Ctx {
  tmpHome: string;
  sessionDir: string;
  origHome: string | undefined;
}

function setupTrace(): Ctx {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-ir-'));
  const sessionDir = path.join(tmpHome, 'workspace', 'traces', 's_test');
  fs.mkdirSync(sessionDir, { recursive: true });
  const origHome = process.env.E2ET_HOME;
  process.env.E2ET_HOME = tmpHome;
  return { tmpHome, sessionDir, origHome };
}

function writeTrace(ctx: Ctx, events: TraceEvent[]): void {
  const lines = events.map((e) => JSON.stringify(e)).join('\n');
  fs.writeFileSync(path.join(ctx.sessionDir, 'trace.jsonl'), lines + '\n', 'utf8');
}

function teardown(ctx: Ctx): void {
  if (ctx.origHome === undefined) delete process.env.E2ET_HOME;
  else process.env.E2ET_HOME = ctx.origHome;
  fs.rmSync(ctx.tmpHome, { recursive: true, force: true });
}

/** open → assert data(local-storage path)+ 对应 observation 的完整 trace。
 *  值走稳定 value 字段(公开/trace 同构);overrides 注入证据缺口负例。 */
function dataTrace(overrides: {
  observationResult?: Record<string, unknown>;
  assertExpect?: Record<string, unknown>;
  observationSource?: Record<string, unknown>;
  observationAfter?: string;
  observationRef?: string;
  actual?: Record<string, unknown>;
  observationMeta?: Record<string, unknown>;
} = {}): TraceEvent[] {
  const obsResult = overrides.observationResult ?? { ok: true, present: true, value: 'fast' };
  const actual = overrides.actual ?? { present: true, value: 'fast', context: { target_id: 'T1', frame_id: 'F1', loader_id: 'LD1', nav: 'n1', url: 'https://page.test/app', origin: 'https://page.test' } };
  return [
    { t: 'session', id: 'session', ts: 1, session_id: 's_test', schema_version: 3, env: 'pre', tool_version: '0.6.0', auth_source: 'profile', browser_source: 'chrome-profile' },
    { t: 'action', id: 'a1', ts: 30, kind: 'open', intent: '打开页面', nav: 'n0', args: { url: 'https://page.test/app' }, result: { ok: true }, settled_by: [{ kind: 'dom_quiet', quiet_ms: 300 }], requests: [], replayable: true },
    { t: 'navigation', id: 'n1', ts: 31, from: 'about:blank', to: 'https://page.test/app', kind: 'same_page', triggered_by: 'a1' },
    {
      t: 'observation', id: 'o1', ts: 32,
      source: overrides.observationSource ?? { local_storage: 'cfg', path: 'record.mode' },
      after: overrides.observationAfter ?? 'a1', group: '校验',
      target_id: 'T1', document: { frame_id: 'F1', loader_id: 'LD1' }, nav: 'n1', url: 'https://page.test/app', origin: 'https://page.test',
      ...(overrides.observationMeta ?? {}),
      result: obsResult,
      replayable: true,
    },
    {
      t: 'assert', after: 'a1', kind: 'data', group: '校验证',
      expect: overrides.assertExpect ?? { source: { local_storage: 'cfg', path: 'record.mode' }, equals: 'fast' },
      actual,
      pass: true, replayable: true, evidence: [{ observation: 'o1' }],
      ...(overrides.observationRef !== undefined ? { observation_ref: overrides.observationRef } : { observation_ref: 'o1' }),
    },
    { t: 'session_end', id: 'session_end', ts: 100, result: 'pass', mocked: false, asserts: { total: 1, pass: 1 }, timeouts: 0, ended_at: '2026-11-02T00:00:00.000Z' },
  ];
}

describe('trace-reader observations 桶', () => {
  it('observation 事件解析进 ParsedTrace.observations;assert 带 observation_ref', () => {
    const trace = parseTrace(dataTrace());
    expect(trace.observations).toHaveLength(1);
    expect(trace.observations[0].id).toBe('o1');
    expect(trace.observations[0].source).toEqual({ local_storage: 'cfg', path: 'record.mode' });
    expect(trace.asserts[0].observation_ref).toBe('o1');
  });

  it('旧 trace(无 observation 事件)→ observations 为空数组', () => {
    const events: TraceEvent[] = [
      { t: 'session', id: 'session', ts: 1, session_id: 's_test', schema_version: 3, env: 'pre', tool_version: '0.6.0', auth_source: 'profile', browser_source: 'chrome-profile' },
      { t: 'session_end', id: 'session_end', ts: 100, result: 'pass', mocked: false, asserts: { total: 0, pass: 0 }, timeouts: 0 },
    ];
    expect(parseTrace(events).observations).toEqual([]);
  });
});

describe('schema data 断言', () => {
  const baseIr = {
    schema_version: 3,
    name: 'data-case',
    url: 'https://page.test/app',
    covered_pages: [],
    env: 'pre',
    provenance: { session_id: 's_test', auth_source: 'profile', browser_source: 'chrome-profile', tool_version: '0.6.0', generated_at: '2026-11-02T00:00:00Z', mocked: false },
    steps: [{
      id: 's1', intent: '打开页面', action: 'open', value: { literal: 'https://page.test/app' }, trace_ref: 'a1',
      args: { url: 'https://page.test/app' },
      checks: [{ assert: { data: { source: { local_storage: 'cfg', path: 'record.mode' }, equals: 'fast' } } }],
    }],
  };

  it('合法 data 断言通过 schema(local-storage + path + scalar)', () => {
    expect(parseIRv2(baseIr).ok).toBe(true);
  });

  it('global 源合法', () => {
    const ir = structuredClone(baseIr);
    ir.steps[0].checks = [{ assert: { data: { source: { global: 'gStr' }, equals: 42 } } }];
    expect(parseIRv2(ir).ok).toBe(true);
  });

  it('同时 local_storage 与 global → schema 拒绝', () => {
    const ir = structuredClone(baseIr);
    ir.steps[0].checks = [{ assert: { data: { source: { local_storage: 'cfg', global: 'g' } as never, equals: 'v' } } }];
    expect(parseIRv2(ir).ok).toBe(false);
  });

  it('path 非 dot path(bracket/空段)→ schema 拒绝', () => {
    for (const badPath of ['a[0]', 'a..b', '', 'a b']) {
      const ir = structuredClone(baseIr);
      ir.steps[0].checks = [{ assert: { data: { source: { local_storage: 'cfg', path: badPath }, equals: 'v' } } }];
      expect(parseIRv2(ir).ok).toBe(false);
    }
  });

  it('equals 非标量(object/array)→ schema 拒绝', () => {
    const ir = structuredClone(baseIr);
    ir.steps[0].checks = [{ assert: { data: { source: { local_storage: 'cfg' }, equals: { a: 1 } as never } } }];
    expect(parseIRv2(ir).ok).toBe(false);
    const ir2 = structuredClone(baseIr);
    ir2.steps[0].checks = [{ assert: { data: { source: { local_storage: 'cfg' }, equals: [1] as never } } }];
    expect(parseIRv2(ir2).ok).toBe(false);
  });

  it('equals null/number/boolean 标量合法', () => {
    for (const equals of [null, 0, false, true, 12.5, '']) {
      const ir = structuredClone(baseIr);
      ir.steps[0].checks = [{ assert: { data: { source: { local_storage: 'cfg' }, equals } } }];
      expect(parseIRv2(ir).ok).toBe(true);
    }
  });
});

describe('build:data 断言提炼与失败观察拒绝', () => {
  let ctx: Ctx;
  beforeEach(() => { ctx = setupTrace(); });
  afterEach(() => { teardown(ctx); });

  it('成功 data assert → IR checks[].assert.data(source + equals 期望值,不复制观察实际值)', async () => {
    writeTrace(ctx, dataTrace());
    const result = await buildIr('s_test', { name: 'data-case' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const checks = result.ir.steps[0].checks!;
    expect(checks).toHaveLength(1);
    expect(checks[0]).toEqual({
      assert: { data: { source: { local_storage: 'cfg', path: 'record.mode' }, equals: 'fast' } },
      report_ref: { group: '校验证' },
    });
  });

  it('trace 含失败 observation → 拒绝(裁剪 reachable 前)', async () => {
    writeTrace(ctx, dataTrace({ observationResult: { ok: false, error: { code: 'READ_UNAVAILABLE', message: '读取失败' } } }));
    const result = await buildIr('s_test');
    expect(result.ok).toBe(false);
    if (!result.ok) return;
    expect(result.error.code).toBe('OBSERVATION_FAILED');
  });

  it('assert data 的 after=open → 断言挂在 open 步骤 checks(先于后续写动作回放)', async () => {
    writeTrace(ctx, dataTrace());
    const result = await buildIr('s_test', { name: 'after-open' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ir.steps[0].checks?.length).toBe(1);
  });
});

describe('check:data 断言动态核对(有 trace)', () => {
  let ctx: Ctx;
  beforeEach(() => { ctx = setupTrace(); });
  afterEach(() => { teardown(ctx); });

  function irOf(): unknown {
    return {
      schema_version: 3,
      name: 'data-case',
      url: 'https://page.test/app',
      covered_pages: [],
      env: 'pre',
      provenance: { session_id: 's_test', auth_source: 'profile', browser_source: 'chrome-profile', tool_version: '0.6.0', generated_at: '2026-11-02T00:00:00Z', mocked: false },
      steps: [{
        id: 's1', intent: '打开页面', action: 'open', value: { literal: 'https://page.test/app' }, trace_ref: 'a1',
        args: { url: 'https://page.test/app' },
        wait: [{ dom_quiet: { ms: 300 } }],
        checks: [{ assert: { data: { source: { local_storage: 'cfg', path: 'record.mode' }, equals: 'fast' } } }],
      }],
    };
  }

  it('一致 trace + 成功 observation → 通过', () => {
    writeTrace(ctx, dataTrace());
    const events = readTrace('s_test')!;
    const res = checkIr(irOf(), { trace: parseTrace(events) });
    expect(res.failures).toEqual([]);
  });

  it('IR equals 与 trace assert 不一致 → failure', () => {
    writeTrace(ctx, dataTrace());
    const events = readTrace('s_test')!;
    const ir = irOf() as { steps: Array<{ checks: Array<{ assert: { data: { equals: unknown } } }> }> };
    ir.steps[0].checks[0].assert.data.equals = 'slow';
    const res = checkIr(ir, { trace: parseTrace(events) });
    expect(res.failures.some((f) => f.rule === 'data-assert')).toBe(true);
  });

  it('observation_ref 指向不存在的 observation → failure', () => {
    writeTrace(ctx, dataTrace({ observationRef: 'o404' }));
    const events = readTrace('s_test')!;
    const res = checkIr(irOf(), { trace: parseTrace(events) });
    expect(res.failures.some((f) => f.rule === 'observation-ref')).toBe(true);
  });

  it('observation 读取失败(result.ok=false)→ failure', () => {
    writeTrace(ctx, dataTrace({ observationResult: { ok: false, error: { code: 'READ_UNAVAILABLE', message: 'x' } } }));
    const events = readTrace('s_test')!;
    const res = checkIr(irOf(), { trace: parseTrace(events) });
    expect(res.failures.some((f) => f.rule === 'observation-ref')).toBe(true);
  });

  it('observation source 与断言 source 不一致(同名观察不等于证据一致)→ failure', () => {
    writeTrace(ctx, dataTrace({ observationSource: { local_storage: 'other', path: 'record.mode' } }));
    const events = readTrace('s_test')!;
    const res = checkIr(irOf(), { trace: parseTrace(events) });
    expect(res.failures.some((f) => f.rule === 'observation-evidence')).toBe(true);
  });

  it('observation after 与断言 after 不一致 → failure', () => {
    writeTrace(ctx, dataTrace({ observationAfter: 'a9' }));
    const events = readTrace('s_test')!;
    const res = checkIr(irOf(), { trace: parseTrace(events) });
    expect(res.failures.some((f) => f.rule === 'observation-evidence')).toBe(true);
  });

  it('trace 中找不到匹配的 data assert 事件 → failure', () => {
    // trace 只有 observation，没有 assert data 事件
    const events = dataTrace().filter((e) => !(e.t === 'assert'));
    writeTrace(ctx, events);
    const res = checkIr(irOf(), { trace: parseTrace(readTrace('s_test')!) });
    expect(res.failures.some((f) => f.rule === 'data-assert')).toBe(true);
  });

  it('actual 值与 equals 不一致（actual 值冲突）→ failure', () => {
    writeTrace(ctx, dataTrace({ actual: { present: true, value: 'slow', context: { target_id: 'T1', frame_id: 'F1', loader_id: 'LD1', nav: 'n1', url: 'https://page.test/app', origin: 'https://page.test' } } }));
    const res = checkIr(irOf(), { trace: parseTrace(readTrace('s_test')!) });
    expect(res.failures.some((f) => f.rule === 'observation-evidence' && f.message.includes('actual value'))).toBe(true);
  });

  it('observation 值与 equals 不一致（observation 值冲突）→ failure', () => {
    writeTrace(ctx, dataTrace({ observationResult: { ok: true, present: true, value: 'slow' } }));
    const res = checkIr(irOf(), { trace: parseTrace(readTrace('s_test')!) });
    expect(res.failures.some((f) => f.rule === 'observation-evidence' && f.message.includes('观察 o1 value'))).toBe(true);
  });

  it('观察缺 document / actual 缺 context（身份证据缺口）→ failure', () => {
    writeTrace(ctx, dataTrace({ observationMeta: { document: undefined } as never }));
    let res = checkIr(irOf(), { trace: parseTrace(readTrace('s_test')!) });
    expect(res.failures.some((f) => f.rule === 'observation-evidence' && f.message.includes('身份'))).toBe(true);
    writeTrace(ctx, dataTrace({ actual: { present: true, value: 'fast' } }));
    res = checkIr(irOf(), { trace: parseTrace(readTrace('s_test')!) });
    expect(res.failures.some((f) => f.rule === 'observation-evidence' && f.message.includes('身份字段'))).toBe(true);
  });

  it('观察/actual 缺自身 scalar value → failure', () => {
    writeTrace(ctx, dataTrace({ observationResult: { ok: true, present: true } }));
    let res = checkIr(irOf(), { trace: parseTrace(readTrace('s_test')!) });
    expect(res.failures.some((f) => f.rule === 'observation-evidence' && f.message.includes('缺自身 scalar value'))).toBe(true);
    writeTrace(ctx, dataTrace({ actual: { present: true, context: { target_id: 'T1', frame_id: 'F1', loader_id: 'LD1', nav: 'n1', url: 'https://page.test/app', origin: 'https://page.test' } } }));
    res = checkIr(irOf(), { trace: parseTrace(readTrace('s_test')!) });
    expect(res.failures.some((f) => f.rule === 'observation-evidence' && f.message.includes('缺自身 scalar value'))).toBe(true);
  });

  it('present=false 但断言 pass=true（证据冲突）→ failure', () => {
    writeTrace(ctx, dataTrace({ observationResult: { ok: true, present: false } }));
    const res = checkIr(irOf(), { trace: parseTrace(readTrace('s_test')!) });
    expect(res.failures.some((f) => f.rule === 'observation-evidence' && f.message.includes('present'))).toBe(true);
  });

  it('nav 冲突（obs.nav ≠ actual.context.nav）→ failure', () => {
    writeTrace(ctx, dataTrace({ observationMeta: { nav: 'n9' } }));
    const res = checkIr(irOf(), { trace: parseTrace(readTrace('s_test')!) });
    expect(res.failures.some((f) => f.rule === 'observation-evidence' && f.message.includes('nav'))).toBe(true);
  });

  it('origin 冲突（obs.origin ≠ actual.context.origin）→ failure', () => {
    writeTrace(ctx, dataTrace({ observationMeta: { origin: 'https://other.test' } }));
    const res = checkIr(irOf(), { trace: parseTrace(readTrace('s_test')!) });
    expect(res.failures.some((f) => f.rule === 'observation-evidence' && f.message.includes('origin'))).toBe(true);
  });

  it('loader_id 空串允许（初始 about:blank），不能当缺字段拒绝', () => {
    writeTrace(ctx, dataTrace({
      observationMeta: { document: { frame_id: 'F1', loader_id: '' } },
      actual: { present: true, value: 'fast', context: { target_id: 'T1', frame_id: 'F1', loader_id: '', nav: 'n1', url: 'https://page.test/app', origin: 'https://page.test' } },
    }));
    const res = checkIr(irOf(), { trace: parseTrace(readTrace('s_test')!) });
    expect(res.failures).toEqual([]);
  });

  it.each([['null', null], ['false', false], ['0', 0], ['空串', '']] as Array<[string, unknown]>)('完整证据链：%s 值三处一致 → 通过', (_label, equals) => {
    writeTrace(ctx, dataTrace({
      observationResult: { ok: true, present: true, value: equals },
      assertExpect: { source: { local_storage: 'cfg', path: 'record.mode' }, equals },
      actual: { present: true, value: equals, context: { target_id: 'T1', frame_id: 'F1', loader_id: 'LD1', nav: 'n1', url: 'https://page.test/app', origin: 'https://page.test' } },
    }));
    const ir = irOf() as { steps: Array<{ checks: Array<{ assert: { data: { equals: unknown } } }> }> };
    ir.steps[0].checks[0].assert.data.equals = equals;
    const res = checkIr(ir, { trace: parseTrace(readTrace('s_test')!) });
    expect(res.failures).toEqual([]);
  });
});

describe('judge:失败观察拒绝', () => {
  let ctx: Ctx;
  beforeEach(() => { ctx = setupTrace(); });
  afterEach(() => { teardown(ctx); });

  it('trace 含失败 observation → 不通过原因', () => {
    writeTrace(ctx, dataTrace({ observationResult: { ok: false, error: { code: 'READ_UNAVAILABLE', message: 'x' } } }));
    const events = readTrace('s_test')!;
    const res = judgeIr({
      schema_version: 3,
      name: 'data-case',
      url: 'https://page.test/app',
      covered_pages: [],
      env: 'pre',
      provenance: { session_id: 's_test', auth_source: 'profile', browser_source: 'chrome-profile', tool_version: '0.6.0', generated_at: '2026-11-02T00:00:00Z', mocked: false },
      steps: [{
        id: 's1', intent: '打开页面', action: 'open', value: { literal: 'https://page.test/app' }, trace_ref: 'a1',
        args: { url: 'https://page.test/app' },
        checks: [{ assert: { data: { source: { local_storage: 'cfg', path: 'record.mode' }, equals: 'fast' } } }],
      }],
    }, { trace: parseTrace(events) });
    expect(res.regressible).toBe(false);
    expect(res.reasons.some((r) => r.includes('失败观察'))).toBe(true);
  });
});
