import { describe, expect, it } from 'vitest';
import { assertField } from '../browser/assert.js';
import type { AssertDeps } from '../browser/assert.js';

/** BUG 1 回归：assert field label 不截断 evidence + 去前导 * 模糊匹配。 */
class FieldCdp {
  private labels: Array<{ label: string; value: string }>;
  constructor(labels: Array<{ label: string; value: string }>) { this.labels = labels; }
  private currentBackend = 0;
  on(): () => void { return () => {}; }
  onClose(): void {}
  close(): void {}
  async send<T = unknown>(method: string, params?: { backendNodeId?: number }): Promise<T> {
    if (method === 'Accessibility.getFullAXTree') {
      // 按 fieldLabel 顺序造 textbox 节点，value 放 properties
      return { nodes: this.labels.map((f, i) => ({
        nodeId: 'f' + i,
        role: { type: 'role', value: 'textbox' },
        name: { type: 'string', value: f.label },
        backendDOMNodeId: 100 + i,
        ignored: false,
        value: { type: 'string', value: f.value },
      })) } as T;
    }
    if (method === 'Accessibility.enable') {
      return {} as T;
    }
    if (method === 'Accessibility.getPartialAXTree') {
      return { nodes: [] } as T;
    }
    if (method === 'DOM.resolveNode') {
      // Phase2：callOnNode 走 resolveNode + callFunctionOn（readElementValue）
      this.currentBackend = params?.backendNodeId ?? 0;
      return { object: { objectId: 'node' } } as T;
    }
    if (method === 'Runtime.callFunctionOn') {
      const fd = String((params as Record<string, unknown> | undefined)?.functionDeclaration);
      if (params?.returnByValue === false && fd.includes('isElementVisible')) {
        return { result: { type: 'function', objectId: 'snapshot-visibility-fn' } } as T;
      }
      if (fd.includes('return this(element)') || fd.includes('isConnected')) {
        return { result: { value: { connected: true, visible: true } } } as T;
      }
      const hit = this.labels.find((_, i) => 100 + i === this.currentBackend);
      return { result: { value: { read_mode: 'value', value: hit?.value ?? '' } } } as T;
    }
    return {} as T;
  }
  async evaluate<T = unknown>(): Promise<T> { return '' as T; }
}

function deps(cdp: FieldCdp): AssertDeps {
  return {
    cdp: cdp as never,
    resolveReq: () => null,
    getBodyInfo: () => undefined,
    readBody: () => null,
    currentUrl: async () => 'https://example.test/',
  };
}

describe('assertField label 查找（BUG 1 回归）', () => {
  // 30 个字段，目标 "*商品保质天数" 在第 25 位（前 20 个不含）
  const labels = Array.from({ length: 24 }, (_, i) => ({ label: `字段${i}`, value: `v${i}` }))
    .concat([{ label: '*商品保质天数', value: '5' }])
    .concat(Array.from({ length: 6 }, (_, i) => ({ label: `尾部字段${i}`, value: `t${i}` })));

  it('label 带前导 * 也能命中（用户传无星号）', async () => {
    const r = await assertField(deps(new FieldCdp(labels)), '商品保质天数', '5');
    expect(r.pass).toBe(true);
    expect(r.actual).toMatchObject({ found: true, value: '5' });
  });

  it('label 完全相等（带星号）也命中', async () => {
    const r = await assertField(deps(new FieldCdp(labels)), '*商品保质天数', '5');
    expect(r.pass).toBe(true);
  });

  it('未命中时 evidence 返回全部 label（不截断到前 20）', async () => {
    const r = await assertField(deps(new FieldCdp(labels)), '不存在的字段', 'x');
    expect(r.pass).toBe(false);
    expect(r.actual).toMatchObject({ found: false });
    const ev = (r.evidence as Array<{ labels: string[] }>)[0];
    expect(ev.labels).toHaveLength(31);
    expect(ev.labels).toContain('*商品保质天数');
  });

  it('值不匹配时 found=true 但 pass=false', async () => {
    const r = await assertField(deps(new FieldCdp(labels)), '商品保质天数', '999');
    expect(r.pass).toBe(false);
    expect(r.actual).toMatchObject({ found: true, value: '5' });
  });
});
