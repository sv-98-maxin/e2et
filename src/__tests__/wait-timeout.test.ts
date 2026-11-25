import { describe, it, expect } from 'vitest';
import {
  parseWaitTimeoutMs,
  replayTimeoutMs,
  nativeCallCount,
  DEFAULT_WAIT_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  MAX_WAIT_TIMEOUT_MS,
  MAX_TIMER_MS,
} from '../wait-timeout.js';

describe('parseWaitTimeoutMs', () => {
  it('undefined 视为缺省', () => {
    expect(parseWaitTimeoutMs(undefined)).toBeUndefined();
  });
  it('纯数字字符串接受', () => {
    expect(parseWaitTimeoutMs('12000')).toBe(12000);
  });
  it('正整数 number 接受', () => {
    expect(parseWaitTimeoutMs(12000)).toBe(12000);
  });
  it('上限值接受', () => {
    expect(parseWaitTimeoutMs(MAX_WAIT_TIMEOUT_MS)).toBe(MAX_WAIT_TIMEOUT_MS);
  });
  it('present null 拒（不回退缺省）', () => {
    expect(() => parseWaitTimeoutMs(null)).toThrow('非法');
  });
  it('present 空串拒（不回退缺省）', () => {
    expect(() => parseWaitTimeoutMs('')).toThrow('非法');
  });
  it('带空白的数字拒', () => {
    expect(() => parseWaitTimeoutMs(' 12 ')).toThrow('非法');
    expect(() => parseWaitTimeoutMs(' 12')).toThrow('非法');
    expect(() => parseWaitTimeoutMs('12 ')).toThrow('非法');
  });
  it('小数拒', () => {
    expect(() => parseWaitTimeoutMs('12.5')).toThrow('非法');
    expect(() => parseWaitTimeoutMs(12.5)).toThrow('非法');
  });
  it('0 拒', () => {
    expect(() => parseWaitTimeoutMs('0')).toThrow('非法');
    expect(() => parseWaitTimeoutMs(0)).toThrow('非法');
  });
  it('负数拒', () => {
    expect(() => parseWaitTimeoutMs(-1)).toThrow('非法');
  });
  it('非数字串拒', () => {
    expect(() => parseWaitTimeoutMs('abc')).toThrow('非法');
    expect(() => parseWaitTimeoutMs('12abc')).toThrow('非法');
  });
  it('溢出上限拒', () => {
    expect(() => parseWaitTimeoutMs(MAX_WAIT_TIMEOUT_MS + 1)).toThrow('上限');
  });
  it('非 finite 拒', () => {
    expect(() => parseWaitTimeoutMs(Number.POSITIVE_INFINITY)).toThrow('非法');
  });
});

describe('nativeCallCount', () => {
  it('category = args.labels 数量', () => {
    expect(nativeCallCount({ action: 'category', args: { labels: ['a', 'b', 'c'] } })).toBe(3);
  });
  it('category 无 labels → 1（下限）', () => {
    expect(nativeCallCount({ action: 'category', args: {} })).toBe(1);
  });
  it('fill_form = args.fields 键数', () => {
    expect(nativeCallCount({ action: 'fill_form', args: { fields: { x: 1, y: 2 } } })).toBe(2);
  });
  it('其余 action = 1', () => {
    expect(nativeCallCount({ action: 'click' })).toBe(1);
    expect(nativeCallCount({})).toBe(1);
  });
});

describe('replayTimeoutMs', () => {
  it('无 wait_timeout_ms 的步骤用 DEFAULT_WAIT_TIMEOUT_MS', () => {
    const total = replayTimeoutMs([{ action: 'click' }]);
    // 2*REQUEST + 1*REQUEST(native) + DEFAULT_WAIT
    expect(total).toBe(2 * DEFAULT_REQUEST_TIMEOUT_MS + DEFAULT_REQUEST_TIMEOUT_MS + DEFAULT_WAIT_TIMEOUT_MS);
  });
  it('声明 wait_timeout_ms 的步骤用声明值', () => {
    const total = replayTimeoutMs([{ action: 'click', wait_timeout_ms: 60000 }]);
    expect(total).toBe(2 * DEFAULT_REQUEST_TIMEOUT_MS + DEFAULT_REQUEST_TIMEOUT_MS + 60000);
  });
  it('category 聚合按 labels 数计入 native', () => {
    const total = replayTimeoutMs([{ action: 'category', args: { labels: ['a', 'b'] }, wait_timeout_ms: 60000 }]);
    expect(total).toBe(2 * DEFAULT_REQUEST_TIMEOUT_MS + 2 * DEFAULT_REQUEST_TIMEOUT_MS + 60000);
  });
  it('fill_form 聚合按 fields 键数计入 native', () => {
    const total = replayTimeoutMs([{ action: 'fill_form', args: { fields: { x: 1, y: 2, z: 3 } } }]);
    expect(total).toBe(2 * DEFAULT_REQUEST_TIMEOUT_MS + 3 * DEFAULT_REQUEST_TIMEOUT_MS + DEFAULT_WAIT_TIMEOUT_MS);
  });
  it('超 MAX_TIMER_MS 抛错', () => {
    expect(() => replayTimeoutMs([{ action: 'click', wait_timeout_ms: MAX_WAIT_TIMEOUT_MS }, { action: 'click', wait_timeout_ms: MAX_WAIT_TIMEOUT_MS }])).toThrow();
  });
});
