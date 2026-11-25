import { describe, expect, it, vi } from 'vitest';
import type { Page } from '@playwright/test';
import { executeChecks } from '../checks.js';
import { RequestTracker } from '../request-tracker.js';
import { createValueContext } from '../value.js';
import type { Check } from '../types.js';

describe('lead native completion budget proof', () => {
  it('field_value 在正剩余预算内执行 evaluate 读取', async () => {
    const calls: unknown[] = [];
    const loc = { evaluate: vi.fn(async (fn: unknown) => {
      calls.push(fn);
      return { read_mode: 'value', value: 'factory' };
    }) };
    const page = { getByLabel: () => loc } as unknown as Page;
    const check: Check = { assert: { field_value: { label: 'producer', value: { literal: 'factory' }, locator: { label: 'producer' }, read_mode: 'value' } } };
    await executeChecks(page, [check], createValueContext(), new RequestTracker(), 100);
    expect(calls).toHaveLength(1);
  });

  it('capture.from_element 在正剩余预算内执行 evaluate 读取', async () => {
    const calls: unknown[] = [];
    const loc = { evaluate: vi.fn(async (fn: unknown) => {
      calls.push(fn);
      return { read_mode: 'text', value: 'factory' };
    }) };
    const page = { getByLabel: () => loc } as unknown as Page;
    const vctx = createValueContext();
    const check: Check = { capture: { from_element: { label: 'producer' }, as: 'producer', lineage: 'queried', read_mode: 'text' } };
    await executeChecks(page, [check], vctx, new RequestTracker(), 100);
    expect(vctx.resolve({ ref: 'producer' })).toBe('factory');
    expect(calls).toHaveLength(1);
  });

  it('exhausted field_value budget fails before evaluate', async () => {
    const evaluate = vi.fn(async () => ({ read_mode: 'value', value: 'factory' }));
    const page = { getByLabel: () => ({ evaluate }) } as unknown as Page;
    const check: Check = { assert: { field_value: { label: 'producer', value: { literal: 'factory' }, locator: { label: 'producer' }, read_mode: 'value' } } };
    await expect(executeChecks(page, [check], createValueContext(), new RequestTracker(), 0)).rejects.toThrow();
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('exhausted capture.from_element budget fails before evaluate', async () => {
    const evaluate = vi.fn(async () => ({ read_mode: 'text', value: 'factory' }));
    const loc = { evaluate };
    const page = { getByLabel: () => loc } as unknown as Page;
    const check: Check = { capture: { from_element: { label: 'producer' }, as: 'producer', lineage: 'queried', read_mode: 'text' } };
    await expect(executeChecks(page, [check], createValueContext(), new RequestTracker(), 0)).rejects.toThrow();
    expect(evaluate).not.toHaveBeenCalled();
  });
});
