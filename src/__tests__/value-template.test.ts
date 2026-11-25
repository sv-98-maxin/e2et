import { describe, expect, it } from 'vitest';
import { renderTemplate } from '../value-template.js';

describe('finding 14：模板渲染与校验使用相同语法', () => {
  it('所有支持的占位符都实际渲染，不留原文', () => {
    expect(renderTemplate('${ts}_${rand6}_${random}_${date:YYYY-MM-DD}')).toMatch(/^\d+_\d{6}_\d{6}_\d{4}-\d{2}-\d{2}$/);
  });
  it('非法或混合非法占位符抛错', () => {
    expect(() => renderTemplate('${ts}_${bogus}')).toThrow();
  });
});
