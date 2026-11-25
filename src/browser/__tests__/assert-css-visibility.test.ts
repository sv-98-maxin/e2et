import { describe, expect, it, vi } from 'vitest';
import { assertVisible, assertAbsent, resolveTargetForAssert } from '../assert.js';
import { captureElement } from '../capture.js';
import { collectPageState } from '../page-state.js';

/**
 * CSS 断言可见性缺陷：resolveTargetForAssert 的 CSS 分支曾只取 resolveSelector 的 DOM 命中，
 * 不读布局盒子，导致 display:none 的命中节点被当 visible PASS（select-clear 清除图标即此场景）。
 *
 * 本文件复用真实生产函数（assertVisible/assertAbsent/captureElement/resolveTargetForAssert），
 * 只伪造 CDP 会话控制 probeBackendNode 的连接/布局事实，不复制被测判断逻辑。
 */

/** CSS 命中首个节点的 backendNodeId（DOM.describeNode 返回值），默认 555 与既有桩一致 */
interface CssCfg { matches: number[]; firstBackend?: number }
/** probe 行为配置，与 assert-ref 桩同语义 */
interface ProbeCfg { state: 'gone' | 'cdp-err' | 'present' | 'call-reject' | 'call-exception'; connected?: boolean; visible?: boolean; role?: string; name?: string }

function fakeCdp(probes: Record<number, ProbeCfg> = {}, css: CssCfg = { matches: [] }) {
  const firstBackend = css.firstBackend ?? 555;
  return {
    send: vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'Accessibility.enable') return {};
      if (method === 'Accessibility.getFullAXTree') return { nodes: [] };
      if (method === 'Accessibility.getPartialAXTree') {
        const b = params.backendNodeId as number;
        const cfg = probes[b];
        if (cfg?.state === 'present' && cfg.role) {
          return { nodes: [{ nodeId: 'p' + b, role: { type: 'role', value: cfg.role }, name: { type: 'string', value: cfg.name ?? '' }, backendDOMNodeId: b, ignored: false }] };
        }
        return { nodes: [] };
      }
      if (method === 'DOM.resolveNode') {
        const b = params.backendNodeId as number;
        const cfg = probes[b];
        if (cfg?.state === 'gone') throw new Error('No node with given id found');
        if (cfg?.state === 'cdp-err') throw new Error('CDP 会话已关闭');
        return { object: { objectId: 'obj-' + b } };
      }
      if (method === 'Runtime.callFunctionOn') {
        const fn = String(params.functionDeclaration ?? '');
        const oid = params.objectId as string;
        const b = Number(oid.replace('obj-', ''));
        const cfg = probes[b];
        if (fn.includes('isConnected')) {
          if (cfg?.state === 'call-reject') throw new Error('Runtime.callFunctionOn 传输失败');
          if (cfg?.state === 'call-exception') return { result: {}, exceptionDetails: { text: '页面脚本异常', exception: { description: 'TypeError: x is null' } } };
          if (cfg?.state === 'present') return { result: { value: { connected: cfg.connected ?? false, visible: cfg.visible ?? false } } };
          return { result: { value: null } };
        }
        // callOnNode readElementValue：返回 { read_mode, value }
        return { result: { value: { read_mode: 'value', value: 'captured-val' } } };
      }
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
      if (method === 'DOM.querySelectorAll') return { nodeIds: css.matches };
      if (method === 'DOM.describeNode') return { node: { backendNodeId: firstBackend, nodeName: 'DIV' } };
      return {};
    }),
    evaluate: vi.fn(async (expr: string) => {
      if (expr.includes('document.title') || expr.includes('location.href')) return { url: 'https://x/', title: 't' };
      if (expr.includes('innerText') || expr.includes('textContent') || expr.includes('this.value')) return 'captured-val';
      return '';
    }),
    on: vi.fn(() => () => {}),
  } as any;
}

function depsFor(probes: Record<number, ProbeCfg> = {}, css: CssCfg = { matches: [] }) {
  const cdp = fakeCdp(probes, css);
  return {
    deps: {
      cdp, resolveRef: () => null,
      resolveReq: () => null, getBodyInfo: () => undefined, readBody: () => null,
      currentUrl: async () => 'https://x/',
      generatedValues: () => new Set<string>(),
    } as any,
    cdp,
  };
}

describe('CSS 断言可见性（display:none 命中不能当 visible）', () => {
  it('CSS 命中 display:none 节点：visible=false / absent PASS（旧码此处 false-green）', async () => {
    const { deps } = depsFor(
      { 555: { state: 'present', connected: true, visible: false } },
      { matches: [9] },
    );
    const v = await assertVisible(deps, 'css=.clear-icon');
    expect(v.pass).toBe(false);
    expect((v.evidence as any[]).some((e) => e.visible === false)).toBe(true);
    const a = await assertAbsent(deps, 'css=.clear-icon');
    expect(a.pass).toBe(true);
  });

  it('CSS 命中可见节点：visible PASS / absent fail', async () => {
    const { deps } = depsFor(
      { 555: { state: 'present', connected: true, visible: true, role: 'button', name: '清除' } },
      { matches: [9] },
    );
    const v = await assertVisible(deps, 'css=.clear-icon');
    expect(v.pass).toBe(true);
    const a = await assertAbsent(deps, 'css=.clear-icon');
    expect(a.pass).toBe(false);
  });

  it('CSS 命中后节点真实消失（gone）：visible=false / absent PASS', async () => {
    const { deps } = depsFor(
      { 555: { state: 'gone' } },
      { matches: [9] },
    );
    const v = await assertVisible(deps, 'css=.clear-icon');
    expect(v.pass).toBe(false);
    expect(v.actual).toMatchObject({ resolved: false });
    const a = await assertAbsent(deps, 'css=.clear-icon');
    expect(a.pass).toBe(true);
  });

  it('CSS 命中但 backend 读取非消失型失败（DOM.resolveNode）：visible/absent 都 reject，不当消失 PASS', async () => {
    const { deps } = depsFor(
      { 555: { state: 'cdp-err' } },
      { matches: [9] },
    );
    await expect(assertVisible(deps, 'css=.clear-icon')).rejects.toThrow();
    await expect(assertAbsent(deps, 'css=.clear-icon')).rejects.toThrow();
  });

  it('CSS 命中但 callFunctionOn reject：visible/absent 都 reject，不当消失 PASS', async () => {
    const { deps } = depsFor(
      { 555: { state: 'call-reject' } },
      { matches: [9] },
    );
    await expect(assertVisible(deps, 'css=.clear-icon')).rejects.toThrow();
    await expect(assertAbsent(deps, 'css=.clear-icon')).rejects.toThrow();
  });

  it('CSS 命中但 callFunctionOn exceptionDetails：visible/absent 都 reject，不当消失 PASS', async () => {
    const { deps } = depsFor(
      { 555: { state: 'call-exception' } },
      { matches: [9] },
    );
    await expect(assertVisible(deps, 'css=.clear-icon')).rejects.toThrow();
    await expect(assertAbsent(deps, 'css=.clear-icon')).rejects.toThrow();
  });

  it('CSS 多命中保留 matches 总数（不擅自改判可见性语义）', async () => {
    const { deps } = depsFor(
      { 555: { state: 'present', connected: true, visible: true } },
      { matches: [10, 11, 12] },
    );
    const v = await assertVisible(deps, 'css=.row');
    expect(v.pass).toBe(true);
    expect(v.actual).toMatchObject({ matches: 3 });
    expect(v.target?.matches).toBe(3);
    const ps = await collectPageState(deps.cdp);
    const r = await resolveTargetForAssert(deps.cdp, 'css=.row', ps, deps.resolveRef);
    expect(r?.matches).toBe(3);
    expect(r?.backendNodeId).toBe(555);
  });

  it('CSS 命中 display:none 节点仍可 capture（连接着的隐藏节点不拒绝读取）', async () => {
    const { deps } = depsFor(
      { 555: { state: 'present', connected: true, visible: false } },
      { matches: [9] },
    );
    const cap = await captureElement(deps, 'css=.hidden-input', 'v');
    expect(cap.value).toBe('captured-val');
    expect(cap.from.backendNodeId).toBe(555);
  });

  it('CSS 未命中：resolveSelector 抛错 → absent PASS / visible fail', async () => {
    const { deps } = depsFor({}, { matches: [] });
    const a = await assertAbsent(deps, 'css=.none');
    expect(a.pass).toBe(true);
    const v = await assertVisible(deps, 'css=.none');
    expect(v.pass).toBe(false);
  });
});
