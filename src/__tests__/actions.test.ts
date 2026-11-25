import { describe, it, expect } from 'vitest';
import { parseTargetSpec } from '../browser/actions.js';

describe('parseTargetSpec', () => {
  it('[N] 索引', () => {
    expect(parseTargetSpec('[12]')).toEqual({ kind: 'index', index: 12, raw: '[12]' });
    expect(parseTargetSpec('[0]')).toEqual({ kind: 'index', index: 0, raw: '[0]' });
  });

  it('数字直接传', () => {
    expect(parseTargetSpec(5)).toEqual({ kind: 'index', index: 5, raw: '5' });
  });

  it('css= / testid=', () => {
    expect(parseTargetSpec('css=.next-btn-primary')).toEqual({ kind: 'css', selector: '.next-btn-primary', raw: 'css=.next-btn-primary' });
    expect(parseTargetSpec('testid=submit-btn')).toEqual({ kind: 'css', selector: '[data-testid="submit-btn"]', raw: 'testid=submit-btn' });
  });

  it('role= / label= / text= 都转文本匹配', () => {
    expect(parseTargetSpec('role=button:确定')).toEqual({ kind: 'text', value: '确定', raw: 'role=button:确定' });
    expect(parseTargetSpec('role=button')).toEqual({ kind: 'text', value: 'button', raw: 'role=button' });
    expect(parseTargetSpec('label=商品名称')).toEqual({ kind: 'text', value: '商品名称', raw: 'label=商品名称' });
    expect(parseTargetSpec('text=提交成功')).toEqual({ kind: 'text', value: '提交成功', raw: 'text=提交成功' });
  });

  it('裸字符串按 accessible name', () => {
    expect(parseTargetSpec('确定')).toEqual({ kind: 'text', value: '确定', raw: '确定' });
  });

  it('非法输入返回 undefined', () => {
    expect(parseTargetSpec(undefined)).toBeUndefined();
    expect(parseTargetSpec(null)).toBeUndefined();
    expect(parseTargetSpec('')).toBeUndefined();
    expect(parseTargetSpec('   ')).toBeUndefined();
    expect(parseTargetSpec(-1)).toBeUndefined();
    expect(parseTargetSpec(NaN)).toBeUndefined();
  });
});
