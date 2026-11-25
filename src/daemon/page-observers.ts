/**
 * 页面观察器 owner：per-page console/frame registry、数据观察与 frame 上下文解析。
 * 从 daemon.ts 迁移，按 P2 方案暴露有限接口。
 * 构造不安装监听，不 import coordinator 的实现。
 */
import { CdpSession } from '../browser/daemon-client.js';
import { collectPageState, type FrameDesc } from '../browser/page-state.js';
import { createFrameView, FrameUnavailableError } from '../browser/frame-view.js';
import { FrameSessionRegistry, type FrameChannel } from '../browser/frame-sessions.js';
import { resolveSelector, TargetNotFoundError } from '../browser/interactions.js';
import { ConsoleObserver } from '../shared/console-observer.js';
import type { ConsoleEntry, ConsoleSnapshot } from '../shared/console.js';
import { NetworkTrace } from './network-trace.js';
import { appendTraceEvent, redactUrl, scrubValue } from './trace.js';
import { readPageData, readPageIdentity, staleContextError, PageDataError, type PageDataSource, type PageDataValue, type PageIdentity } from '../browser/page-data.js';
import type { OopifFrameHint, LifecycleSnapshot } from './session-types.js';

// ── 构造输入接口 ──
export interface PageObserversDeps {
  sessionId: string;
  networkTrace: NetworkTrace;
  currentPage: () => { cdp: CdpSession | null; targetId: string };
  lifecycleSnapshot: () => Readonly<LifecycleSnapshot>;
  /** 获取 active target id 的只读函数（fallback 无 registry 时用 source tabId） */
  activeTargetId: () => string;
}

// ── frame 解析结果 ──
export interface FrameContext {
  frameId: string;
  desc: FrameDesc;
  channel: FrameChannel;
  view: CdpSession;
}

export interface PageDataFrame {
  targetId: string;
  session: CdpSession;
  frameId: string;
  defaultContextId?: number;
  desc: FrameDesc;
}

export type PageDataReadOutcome =
  | { ok: true; source: PageDataSource; value: PageDataValue; result: Record<string, unknown>; context: Record<string, unknown>; observationId: string; replayable: boolean }
  | { ok: false; code: string; message: string; hint: string; observationId: string };

// ── 内部状态 ──
interface PageConsoleState {
  targetId: string;
  page: CdpSession;
  observer: ConsoleObserver;
  registry: FrameSessionRegistry;
  children: Map<string, {
    frameId: string;
    observer: ConsoleObserver;
    channel: FrameChannel;
    name?: string;
    url?: string;
  }>;
  pending: Set<string>;
  offs: Array<() => void>;
  retired: ConsoleSnapshot[];
  errors: string[];
}

export class PageObservers {
  private readonly sessionId: string;
  private readonly networkTrace: NetworkTrace;
  private readonly currentPage: () => { cdp: CdpSession | null; targetId: string };
  private readonly lifecycleSnapshot: () => Readonly<LifecycleSnapshot>;
  private readonly activeTargetId: () => string;
  private readonly consoleStates = new Map<string, PageConsoleState>();

  constructor(deps: PageObserversDeps) {
    this.sessionId = deps.sessionId;
    this.networkTrace = deps.networkTrace;
    this.currentPage = deps.currentPage;
    this.lifecycleSnapshot = deps.lifecycleSnapshot;
    this.activeTargetId = deps.activeTargetId;
  }

  // ── attribution helper ──
  private consoleAttribution(): { nav?: string; action_id?: string; after_id?: string } {
    return {
      ...(this.networkTrace ? { nav: this.networkTrace.currentNav() } : {}),
      ...(this.networkTrace.getActiveActionId() ? { action_id: this.networkTrace.getActiveActionId()! } : {}),
      ...(this.networkTrace && !this.networkTrace.getActiveActionId() && this.networkTrace.getLastFinishedActionId()
        ? { after_id: this.networkTrace.getLastFinishedActionId()! } : {}),
    };
  }

  // ── attach/detach/dispose ──
  async attach(targetId: string, pageWs: CdpSession): Promise<void> {
    await this.startPageConsole(targetId, pageWs);
  }

  async detach(targetId: string): Promise<void> {
    await this.stopPageConsole(targetId);
  }

  async dispose(): Promise<void> {
    for (const targetId of [...this.consoleStates.keys()]) {
      await this.stopPageConsole(targetId);
    }
  }

  hasActiveConsole(): boolean {
    const activeId = this.activeTargetId();
    return this.consoleStates.has(activeId);
  }

  async consoleSnapshot(frameId?: string): Promise<{ snapshot: ConsoleSnapshot; complete: boolean } | undefined> {
    const state = this.getActiveConsoleState();
    if (!state) return undefined;
    return this.doConsoleSnapshot(state, frameId);
  }

  async selectFrameChannel(targetId: string, frameId: string, deadlineMs: number): Promise<FrameChannel> {
    const state = this.consoleStates.get(targetId);
    const { cdp } = this.currentPage();
    if (!state) {
      if (!cdp) throw new FrameUnavailableError('当前 page 会话未就绪');
      return { frameId, targetId, session: cdp, oopif: false };
    }
    const channel = await state.registry.resolve(frameId, deadlineMs);
    if (!this.consoleHasFrame(state, frameId)) {
      throw new FrameUnavailableError(`frame ${frameId} 缺少唯一 default world`);
    }
    return channel;
  }

  async resolveActiveFrameContext(frame: string, deadlineMs = Date.now() + 30_000): Promise<FrameContext> {
    const activeId = this.activeTargetId();
    const state = this.consoleStates.get(activeId);
    const { cdp } = this.currentPage();
    if (!cdp) throw new FrameUnavailableError('当前 page 会话未就绪');
    const resolved = await resolveFrameId(
      cdp,
      frame,
      this.oopifFrameHints(state),
      state ? (fId: string) => state.observer.getDefaultContext(fId) !== undefined : undefined,
    );
    if (!resolved) throw new FrameUnavailableError(`找不到匹配的 iframe: ${frame}`);
    const channel = await this.selectFrameChannel(activeId, resolved.frameId, deadlineMs);
    const view = await createFrameView(channel.session, resolved.frameId, deadlineMs);
    return { frameId: resolved.frameId, desc: resolved.desc, channel, view };
  }

  async resolvePageDataFrame(frame: string): Promise<PageDataFrame> {
    const ctx = await this.resolveActiveFrameContext(frame);
    const activeId = this.activeTargetId();
    const pageConsole = this.consoleStates.get(activeId);
    const observer = ctx.channel.oopif
      ? pageConsole?.children.get(ctx.channel.targetId)?.observer
      : pageConsole?.observer;
    const defaultContextId = observer?.getDefaultContext(ctx.frameId);
    return {
      targetId: ctx.channel.targetId,
      session: ctx.channel.session,
      frameId: ctx.frameId,
      ...(defaultContextId !== undefined ? { defaultContextId } : {}),
      desc: ctx.desc,
    };
  }

  async readPageDataObserved(
    source: PageDataSource,
    opts: { after?: string; group?: string },
    frame?: PageDataFrame,
  ): Promise<PageDataReadOutcome> {
    const { cdp: observedBaseCdp } = this.currentPage();
    const observedCdp = frame?.session ?? observedBaseCdp!;
    const observedTargetId = frame?.targetId ?? this.activeTargetId();
    const observedPageTargetId = this.activeTargetId();
    const observedNav = this.networkTrace.currentNav();
    const readStartLastFinished = this.networkTrace.getLastFinishedActionId();
    const newObservationId = (): string => 'o' + crypto.randomUUID();
    const writeObservation = (result: Record<string, unknown>, identity: PageIdentity | undefined, replayable: boolean): string => {
      const obsId = newObservationId();
      appendTraceEvent(this.sessionId, {
        t: 'observation',
        id: obsId,
        ts: Date.now(),
        source,
        ...(opts.after ? { after: opts.after } : {}),
        ...(opts.group ? { group: opts.group } : {}),
        target_id: observedTargetId,
        ...(identity ? { document: { frame_id: identity.frame_id, loader_id: identity.loader_id }, url: identity.url, origin: identity.origin } : {}),
        nav: observedNav,
        result,
        replayable,
      });
      return obsId;
    };
    const failWith = (err: PageDataError, identity?: PageIdentity): PageDataReadOutcome => {
      const obsId = writeObservation({ ok: false, error: { code: err.code, message: err.message } }, identity, false);
      return { ok: false, code: err.code, message: err.message, hint: err.hint, observationId: obsId };
    };
    let before: PageIdentity;
    try {
      before = frame ? await readPageIdentity(observedCdp, frame.frameId) : await readPageIdentity(observedCdp);
    } catch (e) {
      return failWith(e instanceof PageDataError ? e : staleContextError());
    }
    let value: PageDataValue;
    try {
      value = frame
        ? await readPageData(observedCdp, frame.frameId, source, { ...(frame.defaultContextId !== undefined ? { defaultContextId: frame.defaultContextId } : {}) })
        : await readPageData(observedCdp, before.frame_id, source);
    } catch (e) {
      return failWith(e instanceof PageDataError ? e : staleContextError(), before);
    }
    let afterIdent: PageIdentity;
    try {
      afterIdent = frame ? await readPageIdentity(observedCdp, frame.frameId) : await readPageIdentity(observedCdp);
    } catch {
      return failWith(staleContextError(), before);
    }
    if (this.networkTrace.isActionActive()) {
      const obsId = writeObservation({ ok: false, error: { code: 'BUSY', message: 'action 执行中，页面数据观察拒绝中间值' } }, before, false);
      return { ok: false, code: 'BUSY', message: 'action 执行中，暂不能读取页面数据（观察拒绝中间值）', hint: '等当前 action 完成后重试', observationId: obsId };
    }
    if (this.networkTrace.getLastFinishedActionId() !== readStartLastFinished) {
      const obsId = writeObservation({ ok: false, error: { code: 'STALE_CONTEXT', message: '读取期间有新 action 完成，拒绝关联旧 after' } }, before, false);
      return { ok: false, code: 'STALE_CONTEXT', message: '页面上下文已变化（读取期间有新 action 完成），拒绝返回旧或混拼数据', hint: '重新读取', observationId: obsId };
    }
    const { cdp: currentCdp } = this.currentPage();
    const { state, stopped } = this.lifecycleSnapshot();
    const drifted = currentCdp !== observedBaseCdp
      || this.activeTargetId() !== observedPageTargetId
      || this.networkTrace.currentNav() !== observedNav
      || state !== 'running' || stopped
      || afterIdent.frame_id !== before.frame_id || afterIdent.loader_id !== before.loader_id
      || afterIdent.url !== before.url || afterIdent.origin !== before.origin;
    if (drifted) return failWith(staleContextError(), before);
    const scrubKey = pageDataScrubKey(source);
    const rawValue = value.present && value.value !== undefined ? value.value : undefined;
    const scrubbed = rawValue !== undefined ? scrubValue(rawValue, scrubKey) : undefined;
    const result: Record<string, unknown> = { ok: true, present: value.present, ...(scrubbed !== undefined ? { value: scrubbed } : {}) };
    const observationReplayable = rawValue === undefined ? true : rawValue === scrubbed;
    const observationId = writeObservation(result, before, observationReplayable);
    return {
      ok: true, source, value, result, replayable: observationReplayable,
      context: { target_id: observedTargetId, frame_id: before.frame_id, loader_id: before.loader_id, nav: observedNav, url: redactUrl(before.url), origin: before.origin },
      observationId,
    };
  }

  oopifFrameHints(state: PageConsoleState | undefined): OopifFrameHint[] {
    if (!state) return [];
    return [...state.children.values()].map((child) => ({
      frameId: child.frameId,
      name: child.name ?? '',
      url: child.url ?? '',
    }));
  }

  // ── private ──

  private getActiveConsoleState(): PageConsoleState | undefined {
    const activeId = this.activeTargetId();
    return this.consoleStates.get(activeId);
  }

  private async startPageConsole(targetId: string, pageWs: CdpSession): Promise<PageConsoleState> {
    const existing = this.consoleStates.get(targetId);
    if (existing) return existing;
    const consoleDeadlineMs = 1_500;
    const consoleChannel = {
      send: <T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> =>
        pageWs.send<T>(method, params, Date.now() + consoleDeadlineMs),
      on: (method: string, handler: (params: unknown) => void): (() => void) =>
        pageWs.on(method, handler as (params: any) => void),
    };
    const observer = new ConsoleObserver(consoleChannel, targetId, () => this.consoleAttribution());
    const children = new Map<string, { frameId: string; observer: ConsoleObserver; channel: FrameChannel; name?: string; url?: string }>();
    const pending = new Set<string>();
    const sessionTargets = new Map<string, string>();
    const targetSessions = new Map<string, string>();
    const offs: Array<() => void> = [];
    const retired: ConsoleSnapshot[] = [];
    const errors: string[] = [];
    offs.push(pageWs.on('Target.attachedToTarget', (params: any) => {
      if (String(params?.targetInfo?.type ?? '') !== 'iframe') return;
      const sid = String(params?.sessionId ?? '');
      const childTargetId = String(params?.targetInfo?.targetId ?? '');
      if (sid) sessionTargets.set(sid, childTargetId);
      if (sid && childTargetId) targetSessions.set(childTargetId, sid);
      if (childTargetId) pending.add(childTargetId);
    }));
    offs.push(pageWs.on('Target.detachedFromTarget', (params: any) => {
      const sid = String(params?.sessionId ?? '');
      const childTargetId = sessionTargets.get(sid);
      if (childTargetId) pending.delete(childTargetId);
      if (childTargetId) targetSessions.delete(childTargetId);
      sessionTargets.delete(sid);
    }));
    const registry = new FrameSessionRegistry({
      page: pageWs,
      pageTargetId: targetId,
      deadlineMs: consoleDeadlineMs,
      onAttach: async (channel) => {
        this.networkTrace.addFrameChannel(targetId, channel.targetId, channel.session, channel.frameId);
        await channel.session.send('Network.enable', {}, Date.now() + consoleDeadlineMs);
        const childChannel = {
          send: <T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> =>
            channel.session.send<T>(method, params, Date.now() + consoleDeadlineMs),
          on: (method: string, handler: (params: unknown) => void): (() => void) =>
            channel.session.on(method, handler as (params: any) => void),
        };
        const child = new ConsoleObserver(childChannel, channel.targetId, () => this.consoleAttribution());
        await child.start();
        let name = '';
        let url = '';
        try {
          const tree = await channel.session.send<{ frameTree?: { frame?: { name?: string; url?: string; urlFragment?: string } } }>('Page.getFrameTree');
          const frame = tree?.frameTree?.frame;
          name = String(frame?.name ?? '');
          url = String(frame?.url ?? '') + String(frame?.urlFragment ?? '');
        } catch {
          // 元数据只服务 frame 描述解析；读不到时该描述 fail closed
        }
        pending.delete(channel.targetId);
        const attachedSid = targetSessions.get(channel.targetId);
        if (attachedSid) sessionTargets.delete(attachedSid);
        targetSessions.delete(channel.targetId);
        children.set(channel.targetId, {
          frameId: channel.frameId,
          observer: child,
          channel,
          name,
          url,
        });
      },
      onDetach: (channel) => {
        this.networkTrace.removeFrameChannel(channel.targetId);
        pending.delete(channel.targetId);
        const entry = children.get(channel.targetId);
        if (!entry) return;
        retired.push(entry.observer.snapshot());
        entry.observer.dispose();
        children.delete(channel.targetId);
      },
      log: (tag, data) => {
        if (tag === 'frame-attach-err' || tag === 'frame-detach-cb-err') errors.push(tag + ':' + JSON.stringify(data ?? {}));
      },
    });
    const pageState: PageConsoleState = { targetId, page: pageWs, observer, registry, children, pending, offs, retired, errors };
    this.consoleStates.set(targetId, pageState);
    const starting = (async () => {
      await observer.start();
      await registry.start();
    })();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        starting,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('CONSOLE_INIT_TIMEOUT')), 2_000);
          timer.unref?.();
        }),
      ]);
    } catch (error) {
      if (timer) clearTimeout(timer);
      this.consoleStates.delete(targetId);
      observer.dispose();
      void registry.stop().catch(() => { /* 安装失败优先返回原始错误 */ });
      void starting.catch(() => { /* 超时后迟到失败不覆盖原始错误 */ });
      throw error;
    }
    if (timer) clearTimeout(timer);
    return pageState;
  }

  private async stopPageConsole(targetId: string): Promise<void> {
    const state = this.consoleStates.get(targetId);
    if (!state) return;
    this.consoleStates.delete(targetId);
    for (const off of state.offs.splice(0)) { try { off(); } catch {} }
    try { await state.registry.stop(); } catch { /* page 可能已关闭 */ }
    state.observer.dispose();
    for (const child of state.children.values()) child.observer.dispose();
  }

  private async doConsoleSnapshot(state: PageConsoleState, frameId?: string): Promise<{ snapshot: ConsoleSnapshot; complete: boolean }> {
    const root = state.observer.snapshot();
    const children = [...state.children.values()].map((c) => c.observer.snapshot());
    const retired = state.retired;
    const entries: ConsoleEntry[] = [];
    for (const snap of [root, ...children, ...retired]) entries.push(...snap.entries);
    entries.sort((a, b) => a.ts - b.ts || a.seq - b.seq);
    let frameComplete = state.pending.size === 0;
    if (frameComplete) {
      let tree: { frameTree?: { frame?: { id?: string }; childFrames?: unknown[] } } = {};
      try { tree = await state.page.send<{ frameTree?: { frame?: { id?: string }; childFrames?: unknown[] } }>('Page.getFrameTree'); }
      catch { frameComplete = false; }
      const ids: string[] = [];
      const walk = (node: any): void => {
        const id = node?.frame?.id;
        if (typeof id === 'string' && id) ids.push(id);
        for (const child of node?.childFrames ?? []) walk(child);
      };
      walk(tree.frameTree);
      for (const child of state.children.values()) if (!ids.includes(child.frameId)) ids.push(child.frameId);
      if (frameId === undefined) {
        for (const id of ids) if (!this.consoleHasFrame(state, id)) frameComplete = false;
      } else if (!ids.includes(frameId) || !this.consoleHasFrame(state, frameId)) {
        frameComplete = false;
      }
    }
    const active = root.active && children.every((snap) => snap.active) && retired.every((snap) => snap.active === true);
    return {
      snapshot: { active: active && frameComplete && state.errors.length === 0, truncated: [root, ...children, ...retired].some((s) => s.truncated), entries },
      complete: frameComplete && state.errors.length === 0,
    };
  }

  private consoleHasFrame(state: PageConsoleState, frameId: string): boolean {
    let matches = state.observer.getDefaultContext(frameId) !== undefined ? 1 : 0;
    for (const child of state.children.values()) {
      if (child.observer.getDefaultContext(frameId) !== undefined) matches++;
    }
    return matches === 1;
  }

  /** Check if a frame has a unique default world context */
  hasDefaultContext(frameId: string): boolean {
    const activeId = this.activeTargetId();
    const state = this.consoleStates.get(activeId);
    if (!state) return false;
    return this.consoleHasFrame(state, frameId);
  }
}

// ── frame 解析辅助函数（模块级，无闭包状态） ──

/** DOM.getFrameOwner 的实际 backendNodeId；非正整数 → undefined（拒绝，不猜）。协议错误向上传播。 */
async function frameOwnerBackend(cdp: CdpSession, frameId: string): Promise<number | undefined> {
  const { backendNodeId } = await cdp.send<{ backendNodeId?: number }>('DOM.getFrameOwner', { frameId });
  return typeof backendNodeId === 'number' && Number.isInteger(backendNodeId) && backendNodeId > 0 ? backendNodeId : undefined;
}

/** desc 的每个非空声明确实命中同一个 hint 才算匹配（name/url 必须同时一致）。 */
function descMatchesHint(desc: FrameDesc, hint: OopifFrameHint): boolean {
  if (desc.name !== '' && desc.name !== hint.name) return false;
  if (desc.url_contains !== '' && !hint.url.includes(desc.url_contains)) return false;
  return desc.name !== '' || desc.url_contains !== '';
}

/** root DOM owner backend → 实际子 frameId。无 frameId 说明 owner 已失效/非 frame，拒绝。 */
async function ownerFrameId(cdp: CdpSession, backendNodeId: number): Promise<string | undefined> {
  const { node } = await cdp.send<{ node?: { frameId?: string } }>('DOM.describeNode', { backendNodeId });
  return typeof node?.frameId === 'string' && node.frameId !== '' ? node.frameId : undefined;
}

/** selector 必须唯一命中且返回合法 backend；未命中/歧义/owner 失效 → undefined。 */
async function uniqueOwnerBackend(cdp: CdpSession, selector: string): Promise<number | undefined> {
  let owner: Awaited<ReturnType<typeof resolveSelector>>;
  try {
    owner = await resolveSelector(cdp, selector);
  } catch (e) {
    if (e instanceof TargetNotFoundError) return undefined;
    throw e;
  }
  if ((owner.matches ?? 1) > 1) return undefined;
  return Number.isInteger(owner.backendNodeId) && owner.backendNodeId > 0 ? owner.backendNodeId : undefined;
}

export async function resolveFrameId(
  cdp: CdpSession,
  frame: string,
  oopifFrames: OopifFrameHint[] = [],
  hasDefaultWorld?: (frameId: string) => boolean,
): Promise<{ frameId: string; desc: FrameDesc } | undefined> {
  if (!frame.trim()) return undefined;
  const tree = await cdp.send<{ frameTree?: { frame?: { id?: string; url?: string; name?: string }; childFrames?: any[] } }>('Page.getFrameTree');
  const collect = (node: any, acc: Array<{ id: string; name: string; url: string; parentId?: string }>): void => {
    if (!node?.frame) return;
    acc.push({ id: String(node.frame.id ?? ''), name: String(node.frame.name ?? ''), url: String(node.frame.url ?? '') + String(node.frame.urlFragment ?? ''), parentId: node.frame.parentId });
    for (const c of node.childFrames ?? []) collect(c, acc);
  };
  const all: Array<{ id: string; name: string; url: string; parentId?: string }> = [];
  collect(tree.frameTree, all);
  const sub = all.filter((f) => f.parentId !== undefined);
  const ps = await collectPageState(cdp);

  let domCandidates = ps.frames.filter((d) => d.name !== '' && d.name === frame);
  if (domCandidates.length === 0) domCandidates = ps.frames.filter((d) => d.url_contains !== '' && d.url_contains.includes(frame));
  if (domCandidates.length === 0) domCandidates = ps.frames.filter((d) => d.selector !== '' && d.selector === frame);
  if (domCandidates.length > 1) return undefined;
  const domHit = domCandidates[0];

  if (domHit) {
    const ownerBackend = await uniqueOwnerBackend(cdp, domHit.selector);
    if (ownerBackend === undefined) return undefined;
    const rFrameId = await ownerFrameId(cdp, ownerBackend);
    if (!rFrameId) return undefined;
    const sameOrigin = hasDefaultWorld
      ? (hasDefaultWorld(rFrameId) ? 1 : 0)
      : sub.filter((f) => f.id === rFrameId).length;
    const oopif = oopifFrames.filter((f) => f.frameId === rFrameId).length;
    if (sameOrigin + oopif !== 1) return undefined;
    return { frameId: rFrameId, desc: domHit };
  }

  const sameOriginFrames = hasDefaultWorld ? sub.filter((f) => hasDefaultWorld(f.id)) : sub;
  const byName = sameOriginFrames.filter((f) => f.name !== '' && f.name === frame);
  const oopifByName = oopifFrames.filter((f) => f.name !== '' && f.name === frame);
  const candidates: Array<{ id: string; name: string; url: string; oopif?: OopifFrameHint }> =
    byName.length > 0 || oopifByName.length > 0
      ? [...byName, ...oopifByName.map((f) => ({ id: f.frameId, name: f.name, url: f.url, oopif: f }))]
      : [
        ...sameOriginFrames.filter((f) => f.url !== '' && f.url.includes(frame)),
        ...oopifFrames.filter((f) => f.url !== '' && f.url.includes(frame)).map((f) => ({ id: f.frameId, name: f.name, url: f.url, oopif: f })),
      ];
  if (candidates.length !== 1) return undefined;
  const oopifCandidate = candidates[0]!.oopif;
  if (oopifCandidate) {
    const descs = ps.frames.filter((d) => descMatchesHint(d, oopifCandidate));
    if (descs.length !== 1) return undefined;
    const ownerBackend = await uniqueOwnerBackend(cdp, descs[0]!.selector);
    if (ownerBackend === undefined) return undefined;
    if (await ownerFrameId(cdp, ownerBackend) !== oopifCandidate.frameId) return undefined;
    return { frameId: oopifCandidate.frameId, desc: descs[0]! };
  }
  const ownerBackend = await frameOwnerBackend(cdp, candidates[0].id);
  if (ownerBackend === undefined) return undefined;
  const aligned: FrameDesc[] = [];
  for (const d of ps.frames) {
    if (d.selector === '') continue;
    let resolved: Awaited<ReturnType<typeof resolveSelector>>;
    try {
      resolved = await resolveSelector(cdp, d.selector);
    } catch (e) {
      if (e instanceof TargetNotFoundError) continue;
      throw e;
    }
    if ((resolved.matches ?? 1) > 1) continue;
    if (resolved.backendNodeId === ownerBackend) aligned.push(d);
  }
  if (aligned.length !== 1) return undefined;
  return { frameId: candidates[0].id, desc: aligned[0] };
}

// ── 也有 pageDataScrubKey（从 daemon.ts 迁出，供 evidence-commands 复用） ──
export function pageDataScrubKey(source: PageDataSource): string {
  const base = 'local_storage' in source
    ? (source.path !== undefined ? source.path.split('.').filter(Boolean).at(-1) : source.local_storage)
    : source.global;
  return 'v_' + String(base ?? '').replace(/[^A-Za-z0-9_-]/g, '_');
}
