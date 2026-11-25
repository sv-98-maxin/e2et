/**
 * assertApi / assertRequest 路径未命中诊断回归：jsonPath 未命中时
 * path_status='missing'、actual 显式 null（JSON 不丢字段）、evidence 带最长前缀与可用 key，
 * 且 compare 语义不被展示层 null 带偏（missing 对所有 op 仍为 false）。
 */
import { describe, expect, it } from 'vitest';
import { assertApi, assertRequest, jsonPath, type AssertDeps } from '../assert.js';

/** 构造最小 AssertDeps：body 同时作为响应/请求 body 来源 */
function depsWith(body: unknown): AssertDeps {
  return {
    cdp: {} as AssertDeps['cdp'],
    resolveReq: () => ({ id: 'req-1', path: '/api/item', nav: 'tab-main', call_index: 0, status: 200 }),
    getBodyInfo: () => ({
      resp_body_ref: 'blobs/resp',
      req_body_ref: 'blobs/req',
      resp_body_redacted_paths: [],
      req_body_redacted_paths: [],
      status: 200,
    }),
    readBody: () => JSON.stringify(body),
    currentUrl: async () => 'https://example.test/page',
  };
}

/** 取 evidence 里的 missing 诊断对象 */
function missingDiag(result: { evidence: unknown[] }): Record<string, unknown> {
  const diag = result.evidence.find(
    (e) => typeof e === 'object' && e !== null && (e as Record<string, unknown>).path_status === 'missing',
  );
  expect(diag).toBeTruthy();
  return diag as Record<string, unknown>;
}

describe('assertApi 路径命中状态', () => {
  it('jsonPath 命中：path_status=ok，actual 保留原值，无诊断证据', async () => {
    const result = await assertApi(depsWith({ data: { itemId: 12345 } }), 'req-1', 'data.itemId == 12345');

    expect(result.path_status).toBe('ok');
    expect(result.actual).toBe(12345);
    expect(result.pass).toBe(true);
    expect(result.evidence).toHaveLength(1);
  });

  it('jsonPath 未命中：path_status=missing，actual 显式 null，JSON 序列化不丢字段', async () => {
    const result = await assertApi(depsWith({ data: { itemId: 12345 } }), 'req-1', 'data.missing == 1');

    expect(result.path_status).toBe('missing');
    expect(result.actual).toBeNull();
    expect(result.pass).toBe(false);
    const serialized = JSON.parse(JSON.stringify(result));
    expect(serialized).toHaveProperty('actual', null);
    expect(serialized).toHaveProperty('path_status', 'missing');
  });

  it('missing 不被展示层 null 换成假绿：!= 与 == null 仍 pass=false', async () => {
    const deps = depsWith({ data: { itemId: 12345 } });
    const ne = await assertApi(deps, 'req-1', 'data.missing != 1');
    const eqNull = await assertApi(deps, 'req-1', 'data.missing == null');
    const exists = await assertApi(deps, 'req-1', 'data.missing exists');

    expect(ne.pass).toBe(false);
    expect(eqNull.pass).toBe(false);
    expect(exists.pass).toBe(false);
  });

  it('missing 诊断含最长可解析前缀 + 可用 key', async () => {
    const result = await assertApi(
      depsWith({ data: { code: 1, msg: 'ok', itemId: 12345 } }),
      'req-1',
      'data.missing.field == 1',
    );

    expect(missingDiag(result)).toEqual({
      path_status: 'missing',
      resolved_prefix: 'data',
      available_keys: ['code', 'msg', 'itemId'],
    });
  });

  it('前缀是数组时输出 array_length：list[9] → resolved_prefix=list', async () => {
    const result = await assertApi(depsWith({ list: [1, 2, 3] }), 'req-1', 'list[9] == 1');

    expect(result.path_status).toBe('missing');
    expect(missingDiag(result)).toEqual({
      path_status: 'missing',
      resolved_prefix: 'list',
      array_length: 3,
    });
  });

  it('根层级未命中：resolved_prefix 为空串，available_keys 取根对象 key', async () => {
    const result = await assertApi(depsWith({ a: 1, b: 2 }), 'req-1', 'nope.x == 1');

    expect(missingDiag(result)).toEqual({
      path_status: 'missing',
      resolved_prefix: '',
      available_keys: ['a', 'b'],
    });
  });

  it('可用 key 最多取 5 个', async () => {
    const result = await assertApi(
      depsWith({ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7 }),
      'req-1',
      'nope == 1',
    );

    expect(missingDiag(result).available_keys).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('body 为 null：无结构可诊断，resolved_prefix 为空串', async () => {
    const result = await assertApi(depsWith(null), 'req-1', 'a == 1');

    expect(result.path_status).toBe('missing');
    expect(missingDiag(result)).toEqual({ path_status: 'missing', resolved_prefix: '' });
  });

  it('前缀值为 null：只回前缀，不伪造 available_keys', async () => {
    const result = await assertApi(depsWith({ data: null }), 'req-1', 'data.x == 1');

    expect(missingDiag(result)).toEqual({ path_status: 'missing', resolved_prefix: 'data' });
  });
});

describe('assertRequest 路径命中状态', () => {
  it('命中：path_status=ok，actual 有值', async () => {
    const result = await assertRequest(depsWith({ payload: { sku: 'S-1' } }), 'req-1', 'payload.sku == "S-1"');

    expect(result.kind).toBe('request');
    expect(result.path_status).toBe('ok');
    expect(result.actual).toBe('S-1');
    expect(result.pass).toBe(true);
  });

  it('未命中：path_status=missing，actual null，诊断同样进 evidence', async () => {
    const result = await assertRequest(depsWith({ payload: { sku: 'S-1' } }), 'req-1', 'payload.nope == 1');

    expect(result.path_status).toBe('missing');
    expect(result.actual).toBeNull();
    expect(missingDiag(result)).toEqual({
      path_status: 'missing',
      resolved_prefix: 'payload',
      available_keys: ['sku'],
    });
  });
});

describe('既有 jsonPath 行为不回归', () => {
  it('jsonPath 命中/未命中判定与之前一致', () => {
    const body = { data: { itemId: 12345, list: [1, 2] } };
    expect(jsonPath(body, 'data.itemId')).toBe(12345);
    expect(jsonPath(body, 'data.list[1]')).toBe(2);
    expect(jsonPath(body, 'data.missing')).toBeUndefined();
  });
});