/**
 * TargetNotFoundError 判据回归（P3）：真实缺席与协议/读取错误必须分开。
 * - 文本定位：TextTargetError.notFound 才是真缺席（TargetNotFoundError）；
 *   probe 读取抛错原样传播（不当消失）。
 * - CSS 定位：合法空数组才是真空集；协议缺/非法 nodeIds 字段是 CdpReadError（不当消失）。
 */
import { describe, it, expect } from 'vitest';
import { resolveTarget, resolveSelector, TargetNotFoundError } from '../interactions.js';
import { CdpReadError } from '../page-state.js';

const emptySnapshot = { elements: [] } as never;

describe('resolveTarget not-found 判据', () => {
  it('文本真缺席（TextTargetError.notFound）→ TargetNotFoundError', async () => {
    const session = {
      evaluate: async () => ({ kind: 'none', count: 0, candidates: [], clickable_texts: [] }),
    } as never;
    await expect(resolveTarget(session, '缺失文本', emptySnapshot)).rejects.toBeInstanceOf(TargetNotFoundError);
  });

  it('probe 协议错误原样传播（不被包装成 TargetNotFoundError）', async () => {
    const protocolError = new Error('controlled execution context destroyed');
    const session = {
      evaluate: async () => { throw protocolError; },
    } as never;
    await expect(resolveTarget(session, '任意文本', emptySnapshot)).rejects.toBe(protocolError);
  });

  it('歧义（notFound=false）原样传播 TextTargetError', async () => {
    const session = {
      evaluate: async () => ({ kind: 'exact', count: 2, candidates: [], clickable_texts: [] }),
    } as never;
    await expect(resolveTarget(session, '同名文本', emptySnapshot)).rejects.toThrow('不猜点哪个');
  });
});

describe('resolveSelector not-found 判据', () => {
  function cssSession(nodeIds: number[] | undefined): never {
    return {
      send: async (method: string) =>
        method === 'DOM.getDocument' ? { root: { nodeId: 1 } } : { nodeIds },
    } as never;
  }

  it('合法空数组 → TargetNotFoundError（真实缺席）', async () => {
    await expect(resolveSelector(cssSession([]), '#missing')).rejects.toBeInstanceOf(TargetNotFoundError);
  });

  it('协议缺 nodeIds 字段 → CdpReadError（读取失败，不当消失）', async () => {
    await expect(resolveSelector(cssSession(undefined), '#missing')).rejects.toBeInstanceOf(CdpReadError);
  });

  it('协议 nodeIds 非数组 → CdpReadError', async () => {
    await expect(resolveSelector(cssSession(null as unknown as number[]), '#missing')).rejects.toBeInstanceOf(CdpReadError);
  });
});
