import { describe, expect, it } from 'vitest';
import type { Page } from '@playwright/test';
import { executeChecks } from '../checks.js';
import { RequestTracker } from '../request-tracker.js';
import { createValueContext } from '../value.js';

describe('lead native poll completion budget proof', () => {
  // toast 走标准 ARIA alert/status（组件库无关）：mock getByRole('alert').or(getByRole('status'))
  it('toast forwards remaining timeout to its native innerText', async () => {
    const calls: Array<{ timeout?: number } | undefined> = [];
    const loc: any = {
      count: async () => 1,
      nth: () => loc,
      or: () => loc,
      innerText: async (options?: { timeout?: number }) => {
        calls.push(options);
        return 'saved';
      },
    };
    const page = { getByRole: () => loc } as unknown as Page;
    await executeChecks(page, [{ assert: { toast: 'saved' } }], createValueContext(), new RequestTracker(), 100);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.timeout).toEqual(expect.any(Number));
    expect(calls[0]?.timeout).toBeGreaterThan(0);
    expect(calls[0]?.timeout).toBeLessThanOrEqual(100);
  });

  it('text forwards remaining timeout to its native innerText', async () => {
    const calls: Array<{ timeout?: number } | undefined> = [];
    const loc = { innerText: async (options?: { timeout?: number }) => {
      calls.push(options);
      return 'saved';
    } };
    const page = { locator: () => loc } as unknown as Page;
    await executeChecks(page, [{ assert: { text: { contains: 'saved' } } }], createValueContext(), new RequestTracker(), 100);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.timeout).toEqual(expect.any(Number));
    expect(calls[0]?.timeout).toBeGreaterThan(0);
    expect(calls[0]?.timeout).toBeLessThanOrEqual(100);
  });

  it('predicate 永不完成 → deadline 到报 poll timeout（不挂起）', async () => {
    const loc = { innerText: () => new Promise<string>(() => {}) };
    const page = { locator: () => loc } as unknown as Page;
    await expect(
      executeChecks(page, [{ assert: { text: { contains: 'never' } } }], createValueContext(), new RequestTracker(), 50),
    ).rejects.toThrow('poll timeout');
  }, 5000);
});
