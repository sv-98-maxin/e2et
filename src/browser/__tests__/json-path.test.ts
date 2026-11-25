/**
 * jsonPath 可选根前缀 $（42304 Phase A1）。
 * 直接调用生产函数 assert.ts#jsonPath，不经 daemon；assert api / assert request / capture api 共享此函数。
 * 语义：裸 $ 返回 root；仅 $. / $[ 开头剥首个 $；$abc 仍是普通字段名；既有无前缀路径与过滤器行为不变。
 */
import { describe, expect, it } from 'vitest';
import { jsonPath } from '../assert.js';

describe('jsonPath 可选根前缀 $', () => {
  const root = {
    errorDesc: '',
    data: { itemId: '12345', ok: true },
    list: [
      { id: 1, name: 'a' },
      { id: 2, name: 'b' },
    ],
    $abc: 'dollar-field',
  };

  it('裸 $ 返回 root 本身', () => {
    expect(jsonPath(root, '$')).toBe(root);
  });

  it('$. 前缀：嵌套取值', () => {
    expect(jsonPath(root, '$.data.itemId')).toBe('12345');
    expect(jsonPath(root, '$.data.ok')).toBe(true);
  });

  it('$. 前缀：空字符串值字段（完整 JSON body 的 $.errorDesc 返回空字符串）', () => {
    expect(jsonPath(root, '$.errorDesc')).toBe('');
  });

  it('$[ 前缀：数组根的下标与过滤', () => {
    expect(jsonPath([{ v: 0 }, { v: 7 }], '$[1].v')).toBe(7);
    expect(jsonPath(root.list, '$[id=2].name')).toBe('b');
  });

  it('$. 前缀：嵌套数组下标与字段过滤保持原语义', () => {
    expect(jsonPath(root, '$.list[0].id')).toBe(1);
    expect(jsonPath(root, '$.list[1].name')).toBe('b');
    expect(jsonPath(root, '$.list[name=a].id')).toBe(1);
  });

  it('无前缀路径行为不变', () => {
    expect(jsonPath(root, 'data.itemId')).toBe('12345');
    expect(jsonPath(root, 'list[1].name')).toBe('b');
    expect(jsonPath(root, 'list[name=b].id')).toBe(2);
  });

  it('$abc 仍是普通字段名，不剥起始 $', () => {
    expect(jsonPath(root, '$abc')).toBe('dollar-field');
  });

  it('缺失路径返回 undefined', () => {
    expect(jsonPath(root, '$.nope')).toBeUndefined();
    expect(jsonPath(root, '$.data.nope')).toBeUndefined();
    expect(jsonPath(root, 'nope')).toBeUndefined();
  });

  it('空字符串与 root null 语义不变', () => {
    expect(jsonPath(root, '')).toBe(root);
    expect(jsonPath(null, '$')).toBeNull();
    expect(jsonPath(undefined, 'a')).toBeUndefined();
  });
});
