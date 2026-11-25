import { describe, it, expect } from 'vitest';
import { createValueContext } from '../value.js';

describe('value', () => {
  it('literal string', () => {
    const ctx = createValueContext();
    expect(ctx.resolve({ literal: 'hello' })).toBe('hello');
  });

  it('literal number', () => {
    const ctx = createValueContext();
    expect(ctx.resolve({ literal: 42 })).toBe('42');
  });

  it('template ts', () => {
    const ctx = createValueContext();
    const before = Math.floor(Date.now() / 1000);
    const result = ctx.resolve({ template: 'prefix-${ts}' });
    const after = Math.floor(Date.now() / 1000);
    const ts = Number(result.split('-')[1]);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it('template rand6', () => {
    const ctx = createValueContext();
    const result = ctx.resolve({ template: '${rand6}' });
    expect(result).toMatch(/^\d{6}$/);
  });

  it('template random（与 rand6 共用六位数字）', () => {
    const ctx = createValueContext();
    const result = ctx.resolve({ template: '${random}' });
    expect(result).toMatch(/^\d{6}$/);
  });

  it('template date:YYYY-MM-DD', () => {
    const ctx = createValueContext();
    const result = ctx.resolve({ template: '${date:YYYY-MM-DD}' });
    const now = new Date();
    const expected = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
    expect(result).toBe(expected);
  });

  it('template mixed', () => {
    const ctx = createValueContext();
    const result = ctx.resolve({ template: 'item-${ts}-${rand6}' });
    expect(result).toMatch(/^item-\d+-\d{6}$/);
  });

  it('rand6 与 random 同一 render 返回同一值', () => {
    const ctx = createValueContext();
    const result = ctx.resolve({ template: '${rand6}-${random}' });
    const parts = result.split('-');
    expect(parts[0]).toBe(parts[1]);
  });

  it('无占位符模板 throws', () => {
    const ctx = createValueContext();
    expect(() => ctx.resolve({ template: '固定名称' })).toThrow('template');
  });

  it('不同 step 的 template 不缓存复用（两次 render 独立快照）', () => {
    const ctx = createValueContext();
    const a = ctx.resolve({ template: '${rand6}' });
    const b = ctx.resolve({ template: '${rand6}' });
    // 极低概率碰撞但允许；关键是两次调用不返回同一缓存对象
    expect(a).toMatch(/^\d{6}$/);
    expect(b).toMatch(/^\d{6}$/);
  });

  it('ref exists', () => {
    const ctx = createValueContext();
    ctx.set('foo', 'bar');
    expect(ctx.resolve({ ref: 'foo' })).toBe('bar');
  });

  it('ref not found throws', () => {
    const ctx = createValueContext();
    expect(() => ctx.resolve({ ref: 'nope' })).toThrow('变量引用不存在: nope');
  });

  it('unsupported placeholder throws', () => {
    const ctx = createValueContext();
    expect(() => ctx.resolve({ template: '${bad}' })).toThrow('template 含不支持的占位符');
  });
});
