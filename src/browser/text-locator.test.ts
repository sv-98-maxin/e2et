import { describe, it, expect } from 'vitest';
import type { CdpSession } from './daemon-client.js';
import { resolveTextTarget, TextTargetError } from './text-locator.js';
import { resolveTarget } from './interactions.js';

interface ProbeResult {
  kind: string;
  count: number;
  candidates: Array<{ text: string; path: string; role: string }>;
  clickable_texts: string[];
}

/** 记录调用的假会话：probe 走 Runtime.evaluate(returnByValue=true)，
 *  拿句柄走 Runtime.evaluate(returnByValue=false) + DOM.describeNode(objectId)。 */
function fakeSession(opts: {
  probe?: ProbeResult;
  axElements?: Array<{ role: string; name: string; backendDOMNodeId: number }>;
  objectId?: string | undefined;
  backendNodeId?: number;
  state?: { url: string; title: string };
}) {
  const calls: string[] = [];
  const session = {
    send(method: string, params: Record<string, unknown> = {}) {
      calls.push(method);
      if (method === 'Accessibility.enable') return Promise.resolve({});
      if (method === 'Accessibility.getFullAXTree') {
        return Promise.resolve({
          nodes: (opts.axElements || []).map((e, i) => ({
            nodeId: String(i + 1),
            ignored: false,
            role: { type: 'role', value: e.role },
            name: { type: 'computedString', value: e.name },
            backendDOMNodeId: e.backendDOMNodeId,
          })),
        });
      }
      if (method === 'Runtime.evaluate') {
        const expression = String(params.expression);
        if (params.returnByValue === false) return Promise.resolve({ result: { objectId: opts.objectId } });
        if (expression === '({ url: location.href, title: document.title })') {
          return Promise.resolve({ result: { value: opts.state ?? { url: 'https://portal.example.invalid/x', title: 'x' } } });
        }
        return Promise.resolve({ result: { value: opts.probe } });
      }
      if (method === 'DOM.describeNode') {
        return Promise.resolve({ node: { backendNodeId: opts.backendNodeId } });
      }
      if (method === 'DOM.resolveNode') {
        return Promise.resolve({ object: { objectId: 'node-' + String(params.backendNodeId) } });
      }
      if (method === 'Runtime.callFunctionOn') {
        const fd = String(params.functionDeclaration);
        if (params.returnByValue === false && fd.includes('isElementVisible')) {
          return Promise.resolve({ result: { type: 'function', objectId: 'visibility-fn' } });
        }
        return Promise.resolve({ result: { value: { connected: true, visible: true } } });
      }
      return Promise.resolve({});
    },
    evaluate(expression: string) {
      return session.send('Runtime.evaluate', { expression, returnByValue: true }).then((r: any) => r.result.value);
    },
  };
  return { session: session as unknown as CdpSession, calls };
}

describe('resolveTextTarget', () => {
  it('唯一命中时返回可点容器的 backendNodeId', async () => {
    const { session } = fakeSession({
      probe: {
        kind: 'exact',
        count: 1,
        candidates: [{ text: '查看商品', path: 'div.op-list > div.op-item', role: 'div' }],
        clickable_texts: [],
      },
      objectId: 'obj-1',
      backendNodeId: 42,
    });
    await expect(resolveTextTarget(session, '查看商品')).resolves.toEqual({
      backendNodeId: 42,
      role: 'div',
      name: '查看商品',
    });
  });

  it('没命中时报 notFound 并给出页面可点文本候选', async () => {
    const { session } = fakeSession({
      probe: { kind: 'none', count: 0, candidates: [], clickable_texts: ['修改素材', '离 开'] },
    });
    const err = await resolveTextTarget(session, '查看素材').catch((e) => e as TextTargetError);
    expect(err).toBeInstanceOf(TextTargetError);
    expect((err as TextTargetError).notFound).toBe(true);
    expect((err as Error).message).toContain('修改素材');
    expect((err as Error).message).toContain('离 开');
  });

  it('多处命中不猜，列出各自可点容器路径', async () => {
    const { session } = fakeSession({
      probe: {
        kind: 'substring',
        count: 3,
        candidates: [
          { text: '查看商品详情', path: 'td > a', role: 'a' },
          { text: '查看商品', path: 'div.ops > div', role: 'div' },
        ],
        clickable_texts: [],
      },
    });
    const err = await resolveTextTarget(session, '查看商品').catch((e) => e as TextTargetError);
    expect((err as TextTargetError).notFound).toBe(false);
    expect((err as Error).message).toContain('3 处');
    expect((err as Error).message).toContain('td > a');
    expect((err as Error).message).toContain('div.ops > div');
  });

  it('句柄取不到（节点在两次查找之间消失）时明确报失效', async () => {
    const { session } = fakeSession({
      probe: { kind: 'exact', count: 1, candidates: [{ text: '确定', path: 'button', role: 'button' }], clickable_texts: [] },
      objectId: undefined,
    });
    await expect(resolveTextTarget(session, '确定')).rejects.toThrow('消失');
  });
});

describe('resolveTarget 的 DOM 文本回退', () => {
  it('AX 树能命中就不走 DOM 文本通道', async () => {
    const { session, calls } = fakeSession({
      axElements: [{ role: 'button', name: '离 开', backendDOMNodeId: 7 }],
      probe: { kind: 'none', count: 0, candidates: [], clickable_texts: [] },
    });
    const hit = await resolveTarget(session, '离 开', { url: 'x', title: 'x', busy: false, container: 'page', elements: [{ index: 0, role: 'button', name: '离 开', value: '', required: false, disabled: false, backendNodeId: 7 }], messages: [], frames: [] });
    expect(hit).toEqual({ backendNodeId: 7, role: 'button', name: '离 开', matchedBy: 'ax' });
    expect(calls.filter((c) => c === 'DOM.describeNode')).toHaveLength(0);
  });

  it('AX 树没有时回退到 DOM 文本并标记弱通道', async () => {
    const { session } = fakeSession({
      axElements: [{ role: 'button', name: '离 开', backendDOMNodeId: 7 }],
      probe: {
        kind: 'exact',
        count: 1,
        candidates: [{ text: '查看商品', path: 'div.ops > div', role: 'div' }],
        clickable_texts: [],
      },
      objectId: 'obj-1',
      backendNodeId: 99,
    });
    await expect(resolveTarget(session, '查看商品')).resolves.toEqual({
      backendNodeId: 99,
      role: 'div',
      name: '查看商品',
      matchedBy: 'dom-text',
    });
  });

  it('两条通道都没命中时，报错同时给 DOM 文本候选和 AX 清单', async () => {
    const { session } = fakeSession({
      axElements: [{ role: 'button', name: '离 开', backendDOMNodeId: 7 }],
      probe: { kind: 'none', count: 0, candidates: [], clickable_texts: ['修改素材'] },
    });
    const err = await resolveTarget(session, '查看素材').catch((e) => e as Error);
    expect(err.message).toContain('修改素材');
  });
});
