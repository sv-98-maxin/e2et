/**
 * 页面上下文 owner：active CDP target、ref/identity 映射、变化计数、导航 epoch、
 * hover 生命周期与 TargetRegistry。
 *
 * 所有可变字段私有；对外只给只读快照、精确方法和只读 ref 记录。
 * 构造不启动监听或连接；不 import 命令 handler、action runner 或 daemon 协调入口。
 */
import type { CdpSession } from '../browser/daemon-client.js';
import type { PageState } from '../browser/page-state.js';
import type { TargetSpec, ResolvedTargetInfo, TargetCandidate } from '../browser/actions.js';
import type { RefIdentity } from '../shared/types.js';
import type { DaemonResponse } from './protocol.js';
import { TargetRegistry, type CaptureMode } from '../browser/target-registry.js';
import type { TargetEntry } from '../browser/target-registry.js';
import { collectPageState, probeBackendNode } from '../browser/page-state.js';
import { resolveTarget, resolveSelector, TargetNotFoundError } from '../browser/interactions.js';
import { collectCandidates } from '../browser/actions.js';
import { InvalidRefError } from '../browser/assert.js';
import { appendTraceEvent, redactText } from './trace.js';
import type { NetworkTrace } from './network-trace.js';
import type { PageObservers } from './page-observers.js';
import type { LifecycleSnapshot } from './session-types.js';

export interface PageContextDeps {
  sessionId: string;
  /** bootstrap 后的真实 target id（无占位）。 */
  sourceTabId: string;
  networkTrace: () => NetworkTrace | null;
  observers: () => PageObservers | null;
  lifecycleSnapshot: () => Readonly<LifecycleSnapshot>;
  onAbort: () => void;
  onActivePageChanged?: () => void;
  trace: (event: Record<string, unknown>) => void;
}

export type RefRecord = Readonly<{ targetId: string; backendNodeId: number; identity?: RefIdentity }>;

export class PageContext {
  private changeCountValue = 0;
  private snapshotSeqValue = 0;
  private lastDomChangeCountValue = 0;
  private documentEpochValue = 0;

  private activeCdpValue: CdpSession | null = null;
  private activeFrameNavOff: (() => void) | null = null;

  private readonly refMap = new Map<number, RefRecord>();
  private readonly refReverse = new Map<string, number>();
  private nextRef = 0;

  private hoverCleanup: (() => Promise<void>) | null = null;
  private hoverBackendNodeId: number | null = null;

  private registry: TargetRegistry | null = null;

  constructor(private readonly deps: PageContextDeps) {}

  // ── 只读快照 ──
  activeCdp(): CdpSession | null { return this.activeCdpValue; }
  changeCount(): number { return this.changeCountValue; }
  documentEpoch(): number { return this.documentEpochValue; }
  sourceId(): string { return this.deps.sourceTabId; }
  activeId(): string | null { return this.registry?.activeId() ?? null; }
  currentPage(): { cdp: CdpSession | null; targetId: string } {
    return { cdp: this.activeCdpValue, targetId: this.activeId() ?? this.deps.sourceTabId };
  }
  hasRegistry(): boolean { return this.registry !== null; }
  resolveRef(ref: number): RefRecord | null { return this.refMap.get(ref) ?? null; }

  // ── registry（构造后私有持有；对外只给只读 entry 视图与精确注册方法） ──
  initRegistry(): void {
    this.registry = new TargetRegistry(this.deps.sourceTabId);
  }
  registerSource(pageWs: CdpSession, opts: { contextId?: string; captureMode?: CaptureMode }): TargetEntry {
    if (!this.registry) throw new Error('target registry 未初始化');
    return this.registry.registerSource(pageWs, opts);
  }
  getTarget(targetId: string): Readonly<TargetEntry> | undefined { return this.registry?.get(targetId); }
  hasTarget(targetId: string): boolean { return this.registry?.has(targetId) ?? false; }
  readyTabs(): ReadonlyArray<Readonly<TargetEntry>> { return this.registry?.readyTabs() ?? []; }
  popups(): ReadonlyArray<Readonly<TargetEntry>> { return this.registry?.popups() ?? []; }
  reservePopup(targetId: string, meta: { contextId?: string; openerId?: string; childSessionId?: string; waiting?: boolean; captureMode?: CaptureMode }): TargetEntry | null {
    return this.registry?.reservePopup(targetId, meta) ?? null;
  }
  releasePopup(targetId: string): void { this.registry?.releasePopup(targetId); }
  attachPopupWs(targetId: string, pageWs: CdpSession): void { this.registry?.attachPageWs(targetId, pageWs); }
  setCaptureStart(targetId: string, mode: CaptureMode): void { this.registry?.setCaptureStart(targetId, mode); }
  markReady(targetId: string): void { this.registry?.markReady(targetId); }
  closeTarget(targetId: string): void { this.registry?.close(targetId); }

  targetUrl(targetId: string): string {
    return this.deps.networkTrace()?.getTargetUrl(targetId) ?? '';
  }

  tabsDigest(): Array<{ index: number; target_id: string; url: string; active: boolean; source: boolean; capture_mode?: string }> {
    const activeId = this.activeId();
    return this.readyTabs().map((t, i) => ({
      index: i, target_id: t.targetId, url: this.targetUrl(t.targetId),
      active: t.targetId === activeId, source: t.isSource, ...(t.captureMode ? { capture_mode: t.captureMode } : {}),
    }));
  }

  // ── ref 分配与身份 ──
  private clearRefs(): void {
    this.refMap.clear();
    this.refReverse.clear();
  }

  assignRefs(ps: PageState): PageState {
    const activeId = this.activeId() ?? this.deps.sourceTabId;
    for (const el of ps.elements) {
      const key = activeId + ':' + el.backendNodeId;
      let ref = this.refReverse.get(key);
      if (ref === undefined) {
        ref = this.nextRef++;
        this.refReverse.set(key, ref);
        this.refMap.set(ref, { targetId: activeId, backendNodeId: el.backendNodeId, ...this.snapshotIdentity(el) });
      } else {
        const entry = this.refMap.get(ref);
        if (entry && !entry.identity) {
          const identity = this.snapshotIdentity(el);
          if (identity.identity) this.refMap.set(ref, { ...entry, identity: identity.identity });
        }
      }
      el.index = ref;
    }
    return ps;
  }

  private snapshotIdentity(el: PageState['elements'][number]): { identity?: RefIdentity } {
    if (!el.roleLocator) return {};
    return { identity: { candidate: { by: 'role', role: el.roleLocator.role, name: el.roleLocator.name, matches: 1 }, source: 'snapshot' } };
  }

  updateRefIdentity(info: { backendNodeId: number; candidates?: Array<{ by: string; role?: string; name?: string; value?: string; selector?: string; matches: number }> }): void {
    const primary = info.candidates?.find((c): c is TargetCandidate => c.matches === 1 && (c.by === 'role' || c.by === 'label' || c.by === 'text' || c.by === 'css'));
    if (!primary) return;
    const activeId = this.activeId() ?? this.deps.sourceTabId;
    const ref = this.refReverse.get(activeId + ':' + info.backendNodeId);
    if (ref === undefined) return;
    const entry = this.refMap.get(ref);
    if (entry) this.refMap.set(ref, { ...entry, identity: { candidate: primary, source: 'collector' } });
  }

  // ── 导航 / 变化计数 ──
  bindChangeCount(cdpSession: CdpSession): void {
    if (this.activeFrameNavOff) { try { this.activeFrameNavOff(); } catch { /* 旧监听已释放 */ } this.activeFrameNavOff = null; }
    this.activeFrameNavOff = cdpSession.on('Page.frameNavigated', (params: any) => {
      if (params?.frame?.parentId === undefined) {
        this.documentEpochValue++;
        this.clearRefs();
        this.changeCountValue++;
        this.lastDomChangeCountValue = 0;
      }
    });
  }

  /** page.state：快照号推进 + DOM 变化计数刷新（验证成功后调用一次）。 */
  advanceSnapshot(currentDom: number): { snapshotId: number; changeCount: number } {
    this.snapshotSeqValue++;
    if (currentDom > this.lastDomChangeCountValue) {
      this.changeCountValue++;
      this.lastDomChangeCountValue = currentDom;
    }
    return { snapshotId: this.snapshotSeqValue, changeCount: this.changeCountValue };
  }

  /** 动作后只刷新 DOM 变化计数。 */
  advanceChangeCount(currentDom: number): boolean {
    if (currentDom > this.lastDomChangeCountValue) {
      this.changeCountValue++;
      this.lastDomChangeCountValue = currentDom;
      return true;
    }
    return false;
  }

  setActivePageWs(targetId: string): { targetId: string; url: string } | null {
    const nt = this.deps.networkTrace();
    if (!this.registry || !nt) return null;
    const entry = this.registry.setActive(targetId);
    if (!entry || !entry.pageWs) return null;
    this.activeCdpValue = entry.pageWs;
    nt.setActiveTarget(targetId);
    this.bindChangeCount(entry.pageWs);
    this.lastDomChangeCountValue = 0;
    this.clearRefs();
    this.deps.onActivePageChanged?.();
    return { targetId: entry.targetId, url: this.targetUrl(targetId) };
  }

  checkStaleIndex(params: Record<string, unknown> | undefined, requestId: number): DaemonResponse | null {
    const snapCC = params?.snapshot_change_count;
    if (snapCC === undefined || snapCC === null) return null;
    const expected = Number(snapCC);
    if (!Number.isFinite(expected)) return null;
    if (this.changeCountValue !== expected) {
      return { id: requestId, ok: false, error: { code: 'STALE_INDEX', message: `页面已变化（快照 change_count=${expected}，当前 change_count=${this.changeCountValue}），请先 page state`, hint: 'e2et page state -s ' + this.deps.sessionId } };
    }
    return null;
  }

  // ── target 解析 ──
  async resolveTargetInfo(spec: TargetSpec | undefined, cdpCtx?: CdpSession): Promise<ResolvedTargetInfo> {
    if (!spec) throw new Error('缺 target');
    const c = cdpCtx ?? this.activeCdpValue;
    if (!c) throw new Error('浏览器会话未就绪');
    const ps = await collectPageState(c);
    if (spec.kind === 'index') {
      const mapped = this.refMap.get(spec.index);
      if (!mapped) throw new InvalidRefError('ref [' + spec.index + '] 不存在或已失效（切换/关闭/新快照后旧 ref 失效）');
      const activeId = this.activeId() ?? this.deps.sourceTabId;
      if (mapped.targetId !== activeId) throw new InvalidRefError('ref [' + spec.index + '] 属于另一 tab（' + mapped.targetId + '），当前 active=' + activeId + '，不能跨页复用');
      const el = ps.elements.find((e) => e.backendNodeId === mapped.backendNodeId);
      if (!el) {
        const probe = await probeBackendNode(c, mapped.backendNodeId);
        if (probe.state === 'gone') throw new TargetNotFoundError('ref [' + spec.index + '] 对应元素已不存在（节点已移除），先调用 page state 刷新');
        const probeInfo = { backendNodeId: probe.backendNodeId, role: probe.role ?? '', name: probe.name ?? '', matches: 1 };
        const info: ResolvedTargetInfo = { backendNodeId: probe.backendNodeId, resolved_by: 'index', role: probe.role ?? '', name: probe.name ?? '', matches: 1 };
        const cands = await collectCandidates(ps, probeInfo, 'index', c);
        if (cands.length > 0) info.candidates = cands;
        this.updateRefIdentity(info);
        return info;
      }
      const info: ResolvedTargetInfo = { backendNodeId: el.backendNodeId, resolved_by: 'index', role: el.role, name: el.name, matches: 1 };
      const cands = await collectCandidates(ps, info, 'index', c);
      if (cands.length > 0) info.candidates = cands;
      this.updateRefIdentity(info);
      return info;
    }
    if (spec.kind === 'css') {
      const r = await resolveSelector(c, spec.selector);
      const info: ResolvedTargetInfo = { ...r, resolved_by: 'css', selector: spec.selector };
      const cands = await collectCandidates(ps, info, 'css', c);
      if (cands.length > 0) info.candidates = cands;
      this.updateRefIdentity(info);
      return info;
    }
    const r = await resolveTarget(c, spec.value, ps);
    const resolvedBy = r.matchedBy ?? 'ax';
    const info: ResolvedTargetInfo = { ...r, resolved_by: resolvedBy };
    const cands = await collectCandidates(ps, info, resolvedBy, c);
    if (cands.length > 0) info.candidates = cands;
    this.updateRefIdentity(info);
    return info;
  }

  // ── hover ──
  hasHover(): boolean { return this.hoverCleanup !== null; }
  setHover(cleanup: () => Promise<void>, backendNodeId: number): void {
    this.hoverCleanup = cleanup;
    this.hoverBackendNodeId = backendNodeId;
  }
  resetHover(): void {
    this.hoverCleanup = null;
    this.hoverBackendNodeId = null;
  }

  async clearHover(after?: string, group?: string): Promise<void> {
    if (!this.hoverCleanup) return;
    try {
      await this.hoverCleanup();
      this.resetHover();
    } catch (e) {
      appendTraceEvent(this.deps.sessionId, { t: 'hover_cleanup_error', after, group, error: redactText((e as Error).message) });
      throw new Error('hover cleanup 失败: ' + redactText((e as Error).message));
    }
  }

  async withinHover(targetId: number): Promise<boolean> {
    const cdp = this.activeCdpValue;
    if (!cdp || !this.hoverBackendNodeId) return false;
    const parent = await cdp.send<{ object: { objectId: string } }>('DOM.resolveNode', { backendNodeId: this.hoverBackendNodeId });
    const child = await cdp.send<{ object: { objectId: string } }>('DOM.resolveNode', { backendNodeId: targetId });
    try {
      const result = await cdp.send<{ result: { value?: boolean }; exceptionDetails?: unknown }>('Runtime.callFunctionOn', {
        objectId: parent.object.objectId,
        functionDeclaration: `function(target) {
          if (this.contains(target)) return true;
          for (let node = this; node && node !== document.body; node = node.parentElement) {
            for (const attr of ['aria-controls', 'aria-owns', 'aria-describedby']) {
              for (const id of (node.getAttribute(attr) || '').split(/\\s+/)) {
                const root = document.getElementById(id);
                if (root && root.contains(target)) return true;
              }
            }
          }
          return false;
        }`,
        arguments: [{ objectId: child.object.objectId }], returnByValue: true,
      });
      if (result.exceptionDetails) throw new Error('hover 关联判断失败');
      return result.result.value === true;
    } finally {
      await cdp.send('Runtime.releaseObject', { objectId: parent.object.objectId });
      await cdp.send('Runtime.releaseObject', { objectId: child.object.objectId });
    }
  }

  // ── target 关闭 ──
  handleTargetClosed(targetId: string, reason: string): void {
    const ls = this.deps.lifecycleSnapshot();
    if (ls.stopped || ls.state === 'stopping' || !this.registry) return;
    void this.deps.observers()?.detach(targetId);
    const entry = this.registry.get(targetId);
    if (!entry || entry.closed) return;
    appendTraceEvent(this.deps.sessionId, { t: 'target_closed', target_id: targetId, reason, source: entry.isSource });
    const wasActive = this.registry.activeId() === targetId;
    this.registry.close(targetId);
    const nt = this.deps.networkTrace();
    if (!entry.isSource && nt) nt.removeTarget(targetId);
    this.clearRefs();
    if (!wasActive) return;
    this.resetHover();
    const newActiveId = this.registry.activeId();
    if (newActiveId) {
      this.setActivePageWs(newActiveId);
      appendTraceEvent(this.deps.sessionId, { t: 'active_switched_after_close', from: targetId, to: newActiveId });
    } else {
      appendTraceEvent(this.deps.sessionId, { t: 'session_abort', reason: 'no_live_target' });
      this.deps.onAbort();
    }
  }
}
