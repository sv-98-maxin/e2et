import { describe, expect, it } from 'vitest';
import { TargetRegistry } from '../target-registry.js';

class FakePageWs { closed = false; close() { this.closed = true; } }
function pw() { return new FakePageWs() as any; }

describe('TargetRegistry 纯逻辑', () => {
  it('source 固定；registerSource 后 active=source', () => {
    const r = new TargetRegistry('src');
    r.registerSource(pw(), {});
    expect(r.activeId()).toBe('src');
    expect(r.source()?.isSource).toBe(true);
    expect(r.readyTabs()).toHaveLength(1);
  });

  it('reservePopup 同步去重：第二次返回 null（并发重复事件）', () => {
    const r = new TargetRegistry('src');
    r.registerSource(pw(), {});
    const e1 = r.reservePopup('pop', { waiting: true, captureMode: 'owned_paused' });
    expect(e1).not.toBeNull();
    const e2 = r.reservePopup('pop', { waiting: true, captureMode: 'owned_paused' });
    expect(e2).toBeNull();
  });

  it('reservePopup 创建顺序在 first event 固定（不按 connect 完成顺序）', () => {
    const r = new TargetRegistry('src');
    r.registerSource(pw(), {});
    r.reservePopup('pop-a', {});
    r.reservePopup('pop-b', {});
    r.attachPageWs('pop-b', pw());
    r.attachPageWs('pop-a', pw());
    r.markReady('pop-a');
    r.markReady('pop-b');
    const ids = r.readyTabs().map((t) => t.targetId);
    // 创建顺序：src, pop-a, pop-b（不按 attach 完成顺序）
    expect(ids).toEqual(['src', 'pop-a', 'pop-b']);
  });

  it('setActive 只选存活 ready 且有 pageWs 的；越界/未 ready/closed 拒绝', () => {
    const r = new TargetRegistry('src');
    r.registerSource(pw(), {});
    r.reservePopup('pop', {});
    // 未 attach pageWs / 未 markReady → setActive 拒绝
    expect(r.setActive('pop')).toBeNull();
    r.attachPageWs('pop', pw());
    expect(r.setActive('pop')).toBeNull(); // 仍 not ready
    r.markReady('pop');
    expect(r.setActive('pop')?.targetId).toBe('pop');
    expect(r.activeId()).toBe('pop');
    // 切回 source
    expect(r.setActive('src')?.targetId).toBe('src');
  });

  it('关闭 active popup → 回到存活 ready source（不 fallback closed）', () => {
    const r = new TargetRegistry('src');
    const srcWs = pw();
    r.registerSource(srcWs, {});
    r.reservePopup('pop', {});
    r.attachPageWs('pop', pw());
    r.markReady('pop');
    r.setActive('pop');
    r.close('pop');
    expect(r.activeId()).toBe('src');
    expect(r.active()?.targetId).toBe('src');
  });

  it('关闭 active popup 无其他活页 → activeId=null（不 fallback closed source）', () => {
    const r = new TargetRegistry('src');
    r.registerSource(pw(), {});
    // source 也关闭 → 无活页
    r.close('src');
    expect(r.activeId()).toBeNull();
    expect(r.active()).toBeUndefined();
    expect(r.readyTabs()).toHaveLength(0);
  });

  it('source 被关闭标 closed，但 popup 仍可操作（active 不变）', () => {
    const r = new TargetRegistry('src');
    r.registerSource(pw(), {});
    r.reservePopup('pop', {});
    r.attachPageWs('pop', pw());
    r.markReady('pop');
    r.setActive('pop');
    r.close('src');
    // active 仍是 pop（关闭的是非 active source）
    expect(r.activeId()).toBe('pop');
    expect(r.source()?.closed).toBe(true);
  });

  it('releasePopup 只释放未 ready 的非 source 预占；已 ready 不释放', () => {
    const r = new TargetRegistry('src');
    r.registerSource(pw(), {});
    r.reservePopup('pop', {});
    r.releasePopup('pop');
    expect(r.has('pop')).toBe(false);
    // 已 ready 的不释放
    r.reservePopup('pop2', {});
    r.attachPageWs('pop2', pw());
    r.markReady('pop2');
    r.releasePopup('pop2');
    expect(r.has('pop2')).toBe(true);
    // source 不释放
    r.releasePopup('src');
    expect(r.has('src')).toBe(true);
  });
});
