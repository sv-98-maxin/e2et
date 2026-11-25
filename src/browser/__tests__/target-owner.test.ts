import { describe, expect, it, vi } from 'vitest';
import { TargetOwner } from '../target-owner.js';

/** 最小 fake owner（CdpLowSession 子集）：记录 send 调用 + 可派事件。 */
function fakeOwner() {
  const listeners = new Map<string, Array<(p: any) => void>>();
  const calls: Array<{ method: string; params: Record<string, unknown>; sessionId?: string }> = [];
  const send = vi.fn(async (method: string, params: Record<string, unknown> = {}, sessionId?: string) => {
    calls.push({ method, params, sessionId });
    if (method === 'Target.getTargets') return { targetInfos: [{ targetId: 'src', type: 'page' }] };
    if (method === 'Target.attachToTarget') return { sessionId: 'child-' + Math.random().toString(36).slice(2, 6) };
    return {};
  });
  const addEventListener = vi.fn((m: string, h: (p: any) => void) => {
    const l = listeners.get(m) ?? [];
    l.push(h); listeners.set(m, l);
    return () => { listeners.set(m, (listeners.get(m) ?? []).filter((x) => x !== h)); };
  });
  const close = vi.fn();
  return { send, addEventListener, close, calls, emit: (m: string, p: any) => { for (const h of listeners.get(m) ?? []) h(p); } };
}

function fakePageWs() {
  return { close: vi.fn(), onClose: vi.fn(), send: vi.fn(async () => ({})), on: vi.fn(() => () => {}), evaluate: vi.fn(async () => '') };
}

describe('TargetOwner owned/shared 边界', () => {
  it('shared: foreign ctx target 不 connect（不 attach）', async () => {
    const owner = fakeOwner();
    const connect = vi.fn(async () => fakePageWs() as any);
    const onPopup = vi.fn(async () => {});
    const reserve = vi.fn(() => true);
    const o = new TargetOwner({
      owner: owner as any, baseUrl: 'http://x', kind: 'shared',
      sourceTargetId: 'src', sourceContextId: 'my-ctx',
      connect, reserve, onPopup,
    });
    await o.arm();
    // foreign ctx 的 targetCreated → 不 connect
    owner.emit('Target.targetCreated', { targetInfo: { targetId: 'foreign', type: 'page', browserContextId: 'other-ctx', openerId: 'src' } });
    expect(connect).not.toHaveBeenCalled();
    expect(onPopup).not.toHaveBeenCalled();
  });

  it('shared: 缺 ctx 等 infoChanged，opener==source 不能绕过过滤', async () => {
    const owner = fakeOwner();
    const connect = vi.fn(async () => fakePageWs() as any);
    const onPopup = vi.fn(async () => {});
    const o = new TargetOwner({
      owner: owner as any, baseUrl: 'http://x', kind: 'shared',
      sourceTargetId: 'src', sourceContextId: 'my-ctx',
      connect, reserve: () => true, onPopup,
    });
    await o.arm();
    // 缺 ctx、opener=src → 不接管（等真实 infoChanged 补 ctx）
    owner.emit('Target.targetCreated', { targetInfo: { targetId: 'amb', type: 'page', openerId: 'src' } });
    expect(connect).not.toHaveBeenCalled();
    // 同 ctx 的 targetCreated → 接管
    owner.emit('Target.targetCreated', { targetInfo: { targetId: 'own', type: 'page', browserContextId: 'my-ctx' } });
    expect(connect).toHaveBeenCalledWith('own', 'http://x');
  });

  it('shared: 不发 global autoAttach（无 setAutoAttach 调用）', async () => {
    const owner = fakeOwner();
    const o = new TargetOwner({
      owner: owner as any, baseUrl: 'http://x', kind: 'shared',
      sourceTargetId: 'src', sourceContextId: 'my-ctx',
      connect: vi.fn(async () => fakePageWs() as any), reserve: () => true, onPopup: vi.fn(async () => {}),
    });
    await o.arm();
    expect(owner.calls.some((c) => c.method === 'Target.setAutoAttach')).toBe(false);
  });

  it('owned: arm 发 global autoAttach(waiting=true)；source 页被 auto-attach 暂停时立即 resume', async () => {
    const owner = fakeOwner();
    const resumed: string[] = [];
    const o = new TargetOwner({
      owner: owner as any, baseUrl: 'http://x', kind: 'owned', sourceTargetId: 'src',
      connect: vi.fn(async () => fakePageWs() as any), reserve: () => true, onPopup: vi.fn(async () => {}),
      log: (_t, data) => { if ((data as any)?.targetId === 'src') resumed.push('src'); },
    });
    await o.arm();
    expect(owner.calls.some((c) => c.method === 'Target.setAutoAttach' && (c.params as any).autoAttach === true && (c.params as any).waitForDebuggerOnStart === true)).toBe(true);
    // source 页被 auto-attach（preArmPages 含 src）→ waiting → 立即 resume
    owner.emit('Target.attachedToTarget', { targetInfo: { targetId: 'src', type: 'page' }, sessionId: 'src-child', waitingForDebugger: true });
    expect(owner.send).toHaveBeenCalledWith('Runtime.runIfWaitingForDebugger', {}, 'src-child');
  });

  it('owned: arm 前既存 page（遗留 about:blank）只 resume，不 takeover/不进 onPopup', async () => {
    const owner = fakeOwner();
    const send = owner.send;
    // getTargets 返回遗留空白页 + source
    send.mockImplementation(async (method: string, params: Record<string, unknown> = {}, sessionId?: string) => {
      if (method === 'Target.getTargets') return { targetInfos: [{ targetId: 'leftover', type: 'page' }, { targetId: 'src', type: 'page' }] };
      if (method === 'Target.attachToTarget') return { sessionId: 'child-x' };
      return {};
    });
    const onPopup = vi.fn(async () => {});
    const connect = vi.fn(async () => fakePageWs() as any);
    const o = new TargetOwner({ owner: owner as any, baseUrl: 'http://x', kind: 'owned', sourceTargetId: 'src', connect, reserve: () => true, onPopup });
    await o.arm();
    // 遗留空白页被 auto-attach 暂停 → resume，不 onPopup
    owner.emit('Target.attachedToTarget', { targetInfo: { targetId: 'leftover', type: 'page' }, sessionId: 'left-child', waitingForDebugger: true });
    expect(owner.send).toHaveBeenCalledWith('Runtime.runIfWaitingForDebugger', {}, 'left-child');
    expect(onPopup).not.toHaveBeenCalled();
  });

  it('重复事件去重：reserve 第二次返回 false → 不重复 connect', async () => {
    const owner = fakeOwner();
    const connect = vi.fn(async () => fakePageWs() as any);
    const reserve = vi.fn(() => true);
    const o = new TargetOwner({ owner: owner as any, baseUrl: 'http://x', kind: 'owned', sourceTargetId: 'src', connect, reserve, onPopup: vi.fn(async () => {}) });
    await o.arm();
    // popup attached（post-arm，新 target）
    owner.emit('Target.attachedToTarget', { targetInfo: { targetId: 'pop', type: 'page' }, sessionId: 'pop-c', waitingForDebugger: true });
    // 第二次 attachedToTarget 同 targetId（并发重复）→ reserve 返回 false → 不再 connect
    reserve.mockReturnValueOnce(false);
    owner.emit('Target.attachedToTarget', { targetInfo: { targetId: 'pop', type: 'page' }, sessionId: 'pop-c2', waitingForDebugger: true });
    await new Promise((r) => setTimeout(r, 10));
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('stop 发生在 await connect 期间：晚完成 pageWs 直接 close，不 onPopup', async () => {
    const owner = fakeOwner();
    let resolveConnect: ((v: any) => void) | undefined;
    const lateWs = fakePageWs();
    const connect = vi.fn(() => new Promise((resolve) => { resolveConnect = (v) => resolve(v); }));
    const onPopup = vi.fn(async () => {});
    const release = vi.fn();
    const o = new TargetOwner({ owner: owner as any, baseUrl: 'http://x', kind: 'owned', sourceTargetId: 'src', connect: connect as any, reserve: () => true, onPopup, release });
    await o.arm();
    owner.emit('Target.attachedToTarget', { targetInfo: { targetId: 'pop', type: 'page' }, sessionId: 'pop-c', waitingForDebugger: true });
    // connect 还在 pending → stop
    await o.stop();
    expect(resolveConnect).toBeDefined();
    resolveConnect!(lateWs);
    await new Promise((r) => setTimeout(r, 10));
    expect(lateWs.close).toHaveBeenCalled();
    expect(onPopup).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith('pop');
  });

  it('onPopup 初始化失败：close pageWs + release 预占 + resume waiting', async () => {
    const owner = fakeOwner();
    const ws = fakePageWs();
    const connect = vi.fn(async () => ws as any);
    const onPopup = vi.fn(async () => { throw new Error('enable 失败'); });
    const release = vi.fn();
    const o = new TargetOwner({ owner: owner as any, baseUrl: 'http://x', kind: 'owned', sourceTargetId: 'src', connect, reserve: () => true, onPopup, release });
    await o.arm();
    owner.emit('Target.attachedToTarget', { targetInfo: { targetId: 'pop', type: 'page' }, sessionId: 'pop-c', waitingForDebugger: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(ws.close).toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith('pop');
    // waiting popup 被 resume（兜底）
    expect(owner.send).toHaveBeenCalledWith('Runtime.runIfWaitingForDebugger', {}, 'pop-c');
  });

  it('resumePopup ACK 成功才解除 waiting；失败返回 false（不 ready）', async () => {
    const owner = fakeOwner();
    const o = new TargetOwner({ owner: owner as any, baseUrl: 'http://x', kind: 'owned', sourceTargetId: 'src', connect: vi.fn(async () => fakePageWs() as any), reserve: () => true, onPopup: vi.fn(async () => {}), release: vi.fn() });
    await o.arm();
    const ok = await o.resumePopup('pop-c');
    expect(ok).toBe(true);
    // 失败路径
    owner.send.mockRejectedValueOnce(new Error('gone'));
    const ok2 = await o.resumePopup('pop-c2');
    expect(ok2).toBe(false);
  });

  it('owned stop: 显式关 global autoAttach（autoAttach=false）再回收', async () => {
    const owner = fakeOwner();
    const o = new TargetOwner({ owner: owner as any, baseUrl: 'http://x', kind: 'owned', sourceTargetId: 'src', connect: vi.fn(async () => fakePageWs() as any), reserve: () => true, onPopup: vi.fn(async () => {}), release: vi.fn() });
    await o.arm();
    await o.stop();
    expect(owner.calls.some((c) => c.method === 'Target.setAutoAttach' && (c.params as any).autoAttach === false)).toBe(true);
  });
});
