import { describe, expect, it, vi } from 'vitest';
import { assertVisible, assertAbsent, assertText, resolveTargetForAssert, InvalidRefError } from '../assert.js';
import { captureElement } from '../capture.js';
import { BACKEND_PLACEHOLDER_CANDIDATES_FN } from '../locator-query.js';

/** backend probe 行为可配置：
 *  - 'gone'    : DOM.resolveNode 抛 No node with given id（节点已移除/回收）
 *  - 'cdp-err' : DOM.resolveNode 抛非消失型 CDP 错（如 WS 已关），必须传播，不当消失 PASS
 *  - {connected, visible, role?, name?} : resolveNode 成功 + callFunctionOn 返回连接/可见 + 局部 AX */
interface ProbeCfg { state: 'gone' | 'cdp-err' | 'present' | 'call-reject' | 'call-exception'; connected?: boolean; visible?: boolean; role?: string; name?: string }

function fakeCdp(axNodes: any[], probes: Record<number, ProbeCfg> = {}, cssMatches: number[] = []) {
  return {
    send: vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'Accessibility.enable') return {};
      if (method === 'Accessibility.getFullAXTree') return { nodes: axNodes };
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
        if (fn === BACKEND_PLACEHOLDER_CANDIDATES_FN) return { result: { value: [] } };
        // 快照可见性工厂：首个节点返回 function RemoteObject，后续节点调用该函数
        if (params.returnByValue === false && fn.includes('isElementVisible')) return { result: { type: 'function', objectId: 'visibility-fn' } };
        if (fn.includes('return this(element)')) {
          const argOid = String((params.arguments as Array<{ objectId?: string }>)[0]?.objectId ?? '');
          const b = Number(argOid.replace('obj-', ''));
          const cfg = probes[b];
          if (cfg?.state === 'call-reject') throw new Error('Runtime.callFunctionOn 传输失败');
          if (cfg?.state === 'call-exception') return { result: {}, exceptionDetails: { text: '页面脚本异常', exception: { description: 'TypeError: x is null' } } };
          if (cfg?.state === 'present') return { result: { value: { connected: cfg.connected ?? false, visible: cfg.visible ?? false } } };
          return { result: { value: null } };
        }
        const oid = params.objectId as string;
        const b = Number(oid.replace('obj-', ''));
        const cfg = probes[b];
        // probe 函数（含 isConnected）返回连接/可见事实；其余 callOnNode 返回取值串
        if (fn.includes('isConnected')) {
          if (cfg?.state === 'call-reject') throw new Error('Runtime.callFunctionOn 传输失败');
          if (cfg?.state === 'call-exception') return { result: {}, exceptionDetails: { text: '页面脚本异常', exception: { description: 'TypeError: x is null' } } };
          if (cfg?.state === 'present') return { result: { value: { connected: cfg.connected ?? false, visible: cfg.visible ?? false } } };
          return { result: { value: null } };
        }
        // assertText 的 innerText 读取返回字符串；readElementValue 返回 { read_mode, value }
        if (fn.includes('this.innerText')) return { result: { value: 'captured-val' } };
        return { result: { value: { read_mode: 'value', value: 'captured-val' } } };
      }
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
      if (method === 'DOM.querySelectorAll') return { nodeIds: cssMatches };
      if (method === 'DOM.describeNode') return { node: { backendNodeId: 555, nodeName: 'DIV' } };
      if (method === 'Runtime.evaluate' && params.returnByValue === false) return { result: { objectId: undefined } };
      return {};
    }),
    evaluate: vi.fn(async (expr: string) => {
      // text-locator 探针：真实“无可见文本命中”形状（count=0 → notFound → TargetNotFoundError → absent PASS）
      if (expr.includes('createTreeWalker')) {
        return { kind: 'none', count: 0, candidates: [], clickable_texts: [] };
      }
      if (expr === '({ url: location.href, title: document.title })') return { url: 'https://x/', title: 't' };
      if (expr === 'location.href') return 'https://x/';
      if (expr.includes('readyState')) return 'complete';
      if (expr.includes('__e2etChangeCount')) return 0;
      if (expr.includes('innerWidth')) return { width: 1280, height: 720 };
      // callOnNode/capture 取 value/textContent：返回固定串
      if (expr.includes('innerText') || expr.includes('textContent') || expr.includes('this.value')) return 'captured-val';
      return '';
    }),
    on: vi.fn(() => () => {}),
  } as any;
}

function axNode(backend: number, role: string, name: string) {
  return { nodeId: 'n' + backend, role: { type: 'role', value: role }, name: { type: 'string', value: name }, backendDOMNodeId: backend, ignored: false };
}

function depsFor(axNodes: any[], opts: { resolveRef?: (ref: number) => any; probes?: Record<number, ProbeCfg>; cssMatches?: number[] } = {}) {
  const cdp = fakeCdp(axNodes, opts.probes ?? {}, opts.cssMatches ?? []);
  return {
    deps: {
      cdp, resolveRef: opts.resolveRef,
      resolveReq: () => null, getBodyInfo: () => undefined, readBody: () => null,
      currentUrl: async () => 'https://x/',
      generatedValues: () => new Set<string>(),
    } as any,
    cdp,
  };
}

describe('assert ref 分类（R2）', () => {
  it('有效 ref 元素在快照：visible PASS / absent fail（带身份全树唯一命中可见）', async () => {
    const { deps } = depsFor([axNode(100, 'button', '确定')], {
      resolveRef: () => ({ targetId: 'src', backendNodeId: 100, identity: { candidate: { by: 'role', role: 'button', name: '确定' }, source: 'snapshot' } }),
      probes: { 100: { state: 'present', connected: true, visible: true } },
    });
    const v = await assertVisible(deps, '[0]');
    expect(v.pass).toBe(true);
    const a = await assertAbsent(deps, '[0]');
    expect(a.pass).toBe(false);
    expect(a.actual).toMatchObject({ resolved: false, matches: 1, visible: true });
  });

  it('有效 ref 但元素真实消失（DOM 已移除，带已验证身份）：visible=false / absent=PASS（正常观察，不拒）', async () => {
    const { deps } = depsFor([axNode(100, 'button', '其他')], {
      resolveRef: () => ({ targetId: 'src', backendNodeId: 999, identity: { candidate: { by: 'role', role: 'button', name: '确定' }, source: 'snapshot' } }),
      probes: { 999: { state: 'gone' } },
    });
    const v = await assertVisible(deps, '[0]');
    expect(v.pass).toBe(false);
    expect(v.actual).toMatchObject({ resolved: false });
    const a = await assertAbsent(deps, '[0]');
    expect(a.pass).toBe(true);
    expect(a.actual).toMatchObject({ resolved: false, matches: 0 });
    expect(a.identity).toMatchObject({ source: 'snapshot', candidate: { role: 'button', name: '确定' } });
  });

  it('无效 ref（不在 refMap）：visible/absent 都 throw InvalidRefError（输入错误，不 PASS）', async () => {
    const { deps } = depsFor([axNode(100, 'button', '确定')], { resolveRef: () => null });
    await expect(assertVisible(deps, '[0]')).rejects.toBeInstanceOf(InvalidRefError);
    await expect(assertAbsent(deps, '[0]')).rejects.toBeInstanceOf(InvalidRefError);
  });

  it('跨页 ref（resolveRef 返回 null）：absent 不 PASS，throw InvalidRefError', async () => {
    const { deps } = depsFor([axNode(100, 'button', '确定')], { resolveRef: () => null });
    await expect(assertAbsent(deps, '[0]')).rejects.toBeInstanceOf(InvalidRefError);
  });

  it('text 含 "已失效" 但无匹配：absent PASS（正常缺失，不因文本判输入错误）', async () => {
    const { deps } = depsFor([axNode(100, 'button', '确定')], { resolveRef: () => null });
    const a = await assertAbsent(deps, '已失效');
    expect(a.pass).toBe(true);
  });

  it('文本含 "ref [" 但无匹配：absent PASS（正常缺失，不因文本判输入错误）', async () => {
    const { deps } = depsFor([axNode(100, 'button', '确定')], { resolveRef: () => null });
    const a = await assertAbsent(deps, 'ref [something]');
    expect(a.pass).toBe(true);
  });
});

describe('assert ref 真实 backend 存在性（R3：过滤快照不能证明不存在）', () => {
  it('有效 ref 被 dialog/150 过滤出 ps.elements 但 DOM connected+visible：visible PASS / absent fail（身份全树命中）/ capture 成功', async () => {
    // 全树含 backend 777（身份重查命中）；ps 快照仅由同一批 AX 节点构成，777 同在其中不影响判别
    const { deps } = depsFor([axNode(100, 'button', '其他'), axNode(777, 'button', '确定')], {
      resolveRef: () => ({ targetId: 'src', backendNodeId: 777, identity: { candidate: { by: 'role', role: 'button', name: '确定' }, source: 'snapshot' } }),
      probes: { 777: { state: 'present', connected: true, visible: true } },
    });
    const v = await assertVisible(deps, '[0]');
    expect(v.pass).toBe(true);
    const a = await assertAbsent(deps, '[0]');
    expect(a.pass).toBe(false);
    const cap = await captureElement(deps, '[0]', 'v');
    expect(cap.value).toBe('captured-val');
  });

  it('有效 ref 被过滤且 DOM connected 但无布局盒子（display:none）：visible=false / absent=PASS（身份零命中——display:none 不在非 ignored AX 树）', async () => {
    const { deps } = depsFor([axNode(100, 'button', '其他')], {
      resolveRef: () => ({ targetId: 'src', backendNodeId: 777, identity: { candidate: { by: 'role', role: 'button', name: '确定' }, source: 'snapshot' } }),
      probes: { 777: { state: 'present', connected: true, visible: false } },
    });
    const v = await assertVisible(deps, '[0]');
    expect(v.pass).toBe(false);
    const a = await assertAbsent(deps, '[0]');
    expect(a.pass).toBe(true); // 不可见 → absent PASS（与 visible 对齐）
  });

  it('有效 ref 确已 disconnected（backend 已回收，带已验证身份）：visible=false / absent PASS', async () => {
    const { deps } = depsFor([axNode(100, 'button', '其他')], {
      resolveRef: () => ({ targetId: 'src', backendNodeId: 888, identity: { candidate: { by: 'role', role: 'button', name: '确定' }, source: 'collector' } }),
      probes: { 888: { state: 'gone' } },
    });
    const v = await assertVisible(deps, '[0]');
    expect(v.pass).toBe(false);
    const a = await assertAbsent(deps, '[0]');
    expect(a.pass).toBe(true);
    expect(a.actual).toMatchObject({ resolved: false, matches: 0 });
  });

  it('非节点消失的 CDP 读取失败（DOM.resolveNode）：visible/absent 都 reject（不准当消失 PASS）', async () => {
    const { deps } = depsFor([axNode(100, 'button', '其他')], {
      resolveRef: () => ({ targetId: 'src', backendNodeId: 888 }),
      probes: { 888: { state: 'cdp-err' } },
    });
    await expect(assertVisible(deps, '[0]')).rejects.toThrow();
    await expect(assertAbsent(deps, '[0]')).rejects.toThrow();
  });

  it('Runtime.callFunctionOn reject（传输失败）：visible/absent 都 reject，不当消失 PASS', async () => {
    const { deps } = depsFor([axNode(100, 'button', '其他')], {
      resolveRef: () => ({ targetId: 'src', backendNodeId: 888 }),
      probes: { 888: { state: 'call-reject' } },
    });
    await expect(assertVisible(deps, '[0]')).rejects.toThrow();
    await expect(assertAbsent(deps, '[0]')).rejects.toThrow();
  });

  it('Runtime.callFunctionOn exceptionDetails（函数抛错）：visible/absent 都 reject，不当消失 PASS', async () => {
    const { deps } = depsFor([axNode(100, 'button', '其他')], {
      resolveRef: () => ({ targetId: 'src', backendNodeId: 888 }),
      probes: { 888: { state: 'call-exception' } },
    });
    await expect(assertVisible(deps, '[0]')).rejects.toThrow();
    await expect(assertAbsent(deps, '[0]')).rejects.toThrow();
  });

  it('assertText within 元素真消失（disconnected）：pass:false（空范围），不 throw InvalidRefError', async () => {
    const { deps } = depsFor([axNode(100, 'button', '其他')], {
      resolveRef: () => ({ targetId: 'src', backendNodeId: 888 }),
      probes: { 888: { state: 'gone' } },
    });
    const r = await assertText(deps, 'foo', '[0]');
    expect(r.pass).toBe(false);
    expect((r.evidence as any[]).some((e) => e.within_absent)).toBe(true);
  });

  it('assertText within 元素被过滤但 DOM 仍存在：取该元素 innerText 作范围（不因 AX 缺席拒绝）', async () => {
    const { deps } = depsFor([axNode(100, 'button', '其他')], {
      resolveRef: () => ({ targetId: 'src', backendNodeId: 777 }),
      probes: { 777: { state: 'present', connected: true, visible: true, role: 'button', name: '确定' } },
    });
    // innerText evaluate 返回 'captured-val'，不含 'foo' → pass:false（正常失败，非 abort）
    const r = await assertText(deps, 'foo', '[0]');
    expect(r.pass).toBe(false);
    expect((r.evidence as any[]).some((e) => e.within_absent)).toBe(false);
  });

  it('真 CSS selector css=[data-state="已失效"] 无匹配：走 resolveSelector 抛错 → absent PASS', async () => {
    const { deps } = depsFor([axNode(100, 'button', '确定')], { resolveRef: () => null, cssMatches: [] });
    const a = await assertAbsent(deps, 'css=[data-state="已失效"]');
    expect(a.pass).toBe(true);
  });

  it('真 CSS selector 有匹配：absent fail / visible PASS', async () => {
    const { deps } = depsFor([axNode(100, 'button', '确定')], { resolveRef: () => null, cssMatches: [9], probes: { 555: { state: 'present', connected: true, visible: true } } });
    const a = await assertAbsent(deps, 'css=[data-state="x"]');
    expect(a.pass).toBe(false);
  });

  it('resolveTargetForAssert 有效 ref 被过滤但 present：返回 backendNodeId + 真实局部 AX role（不造假）', async () => {
    const { deps, cdp } = depsFor([axNode(100, 'button', '其他')], {
      resolveRef: () => ({ targetId: 'src', backendNodeId: 777 }),
      probes: { 777: { state: 'present', connected: true, visible: true, role: 'link', name: '详情' } },
    });
    const ps = await (await import('../page-state.js')).collectPageState(deps.cdp);
    const r = await resolveTargetForAssert(deps.cdp, '[0]', ps, deps.resolveRef);
    expect(r).not.toBeNull();
    expect(r!.backendNodeId).toBe(777);
    expect(r!.role).toBe('link'); // 来自真实局部 AX，非造假
    expect(r!.name).toBe('详情');
  });
});
