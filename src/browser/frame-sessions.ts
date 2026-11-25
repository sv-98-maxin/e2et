import type { CdpSession } from './daemon-client.js';
import { FrameUnavailableError } from './frame-view.js';
import { requestContext } from '../request-context.js';

export interface FrameChannel {
  frameId: string;
  targetId: string;
  session: CdpSession;
  oopif: boolean;
}

export interface FrameSessionRegistryOptions {
  page: CdpSession;
  pageTargetId: string;
  onAttach: (channel: FrameChannel) => Promise<void>;
  onDetach: (channel: FrameChannel) => void;
  deadlineMs?: number;
  log?: (tag: string, data?: unknown) => void;
}

interface FrameTreeLike {
  frame?: { id?: string };
}

const DEFAULT_DEADLINE_MS = 30_000;
const ATTACH_POLL_MS = 25;

export class FrameSessionRegistry {
  private readonly page: CdpSession;
  private readonly deadlineMs: number;
  private readonly offs: Array<() => void> = [];
  private readonly attachTasks = new Set<Promise<void>>();
  private readonly childSessions = new Map<string, FrameChannel>();
  private readonly sessionsByFrame = new Map<string, Set<string>>();
  private readonly waitingSessions = new Set<string>();
  private readonly rootFrameIds = new Set<string>();
  private readonly contextFrames = new Map<number, string>();
  private readonly knownFrames = new Set<string>();
  private stopped = false;
  private rootFrame = '';

  constructor(private readonly opts: FrameSessionRegistryOptions) {
    this.page = opts.page;
    this.deadlineMs = opts.deadlineMs ?? DEFAULT_DEADLINE_MS;
  }

  async start(): Promise<void> {
    if (this.stopped) throw new FrameUnavailableError('registry 已停止');
    const deadline = this.deadline();
    this.offs.push(this.page.on('Target.attachedToTarget', (params) => this.onAttached(params)));
    this.offs.push(this.page.on('Target.detachedFromTarget', (params) => this.onDetached(params)));
    this.offs.push(this.page.on('Runtime.executionContextCreated', (params) => this.onContextCreated(params)));
    this.offs.push(this.page.on('Runtime.executionContextDestroyed', (params) => this.onContextDestroyed(params)));
    this.offs.push(this.page.on('Runtime.executionContextsCleared', () => this.onContextsCleared()));
    this.offs.push(this.page.on('Page.frameDetached', (params) => this.onFrameDetached(params)));
    try {
      await this.page.send('Page.enable', {}, deadline);
      await this.page.send('Runtime.enable', {}, deadline);
      await this.page.send('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
        filter: [
          { type: 'iframe', exclude: false },
          { exclude: true },
        ],
      }, deadline);
    } catch (e) {
      for (const off of this.offs.splice(0)) { try { off(); } catch {} }
      throw e;
    }
    await this.drainAttachTasks();
    if (this.stopped) return;
    const tree = await this.page.send<{ frameTree?: FrameTreeLike }>('Page.getFrameTree', {}, deadline);
    const root = tree?.frameTree?.frame?.id;
    if (typeof root !== 'string' || root === '') {
      throw new FrameUnavailableError('Page.getFrameTree 未返回实际主 frame id');
    }
    this.rootFrame = root;
    this.knownFrames.add(root);
    this.rootFrameIds.add(root);
  }

  rootFrameId(): string {
    if (!this.rootFrame) throw new FrameUnavailableError('registry 尚未 start');
    return this.rootFrame;
  }

  async resolve(frameId: string, deadlineMs?: number): Promise<FrameChannel> {
    const signal = requestContext.getStore()?.signal;
    signal?.throwIfAborted();
    if (!frameId) throw new FrameUnavailableError('空 frameId');
    const until = deadlineMs ?? Date.now() + this.deadlineMs;
    for (;;) {
      signal?.throwIfAborted();
      const sessionIds = this.sessionsByFrame.get(frameId);
      if (sessionIds && sessionIds.size > 1) {
        throw new FrameUnavailableError(`frame ${frameId} 存在多个实际会话，拒绝选择`);
      }
      if (sessionIds && sessionIds.size === 1) {
        const channel = this.childSessions.get([...sessionIds][0]);
        if (channel) return channel;
      } else if (this.rootFrameIds.has(frameId)) {
        return { frameId, targetId: this.opts.pageTargetId, session: this.page, oopif: false };
      }
      if (Date.now() >= until) {
        throw new FrameUnavailableError(`frame ${frameId} 缺失或已 detach，拒绝回退主文档`);
      }
      await new Promise((r) => setTimeout(r, ATTACH_POLL_MS));
    }
  }

  isDetached(frameId: string): boolean {
    return this.knownFrames.has(frameId)
      && !this.rootFrameIds.has(frameId)
      && !this.sessionsByFrame.has(frameId);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const off of this.offs.splice(0)) { try { off(); } catch {} }
    for (const channel of [...this.childSessions.values()]) {
      try { this.opts.onDetach(channel); } catch (e) { this.opts.log?.('frame-detach-cb-err', { msg: String(e) }); }
    }
    for (const sessionId of [...this.waitingSessions]) {
      try { await this.page.child(sessionId).send('Runtime.runIfWaitingForDebugger', {}, this.deadline()); }
      catch {}
    }
    this.waitingSessions.clear();
    this.childSessions.clear();
    this.sessionsByFrame.clear();
    this.rootFrameIds.clear();
    this.contextFrames.clear();
    try {
      await this.page.send('Target.setAutoAttach', {
        autoAttach: false, waitForDebuggerOnStart: false, flatten: true,
      }, this.deadline());
    } catch {}
    await this.drainAttachTasks();
  }

  private onContextCreated(params: any): void {
    const context = params?.context ?? {};
    const contextId = context.id;
    const auxData = context.auxData ?? {};
    const frameId = String(auxData.frameId ?? '');
    if (auxData.isDefault !== true || typeof contextId !== 'number' || !frameId) return;
    this.contextFrames.set(contextId, frameId);
    this.rootFrameIds.add(frameId);
    this.knownFrames.add(frameId);
  }

  private onContextDestroyed(params: any): void {
    const contextId = params?.executionContextId;
    if (typeof contextId !== 'number') return;
    const frameId = this.contextFrames.get(contextId);
    this.contextFrames.delete(contextId);
    if (!frameId) return;
    for (const value of this.contextFrames.values()) {
      if (value === frameId) return;
    }
    this.rootFrameIds.delete(frameId);
  }

  private onContextsCleared(): void {
    this.contextFrames.clear();
    this.rootFrameIds.clear();
  }

  private onFrameDetached(params: any): void {
    const frameId = String(params?.frameId ?? '');
    if (!frameId) return;
    this.rootFrameIds.delete(frameId);
    for (const [contextId, value] of this.contextFrames) {
      if (value === frameId) this.contextFrames.delete(contextId);
    }
  }

  private onAttached(params: any): void {
    const sessionId = String(params?.sessionId ?? '');
    const targetInfo = params?.targetInfo ?? {};
    const targetId = String(targetInfo.targetId ?? '');
    const type = String(targetInfo.type ?? '');
    const waiting = params?.waitingForDebugger === true;
    if (!sessionId) return;
    if (this.stopped) {
      if (waiting) void this.page.child(sessionId).send('Runtime.runIfWaitingForDebugger', {}, this.deadline()).catch(() => {});
      return;
    }
    if (type !== 'iframe') {
      if (waiting) void this.page.child(sessionId).send('Runtime.runIfWaitingForDebugger', {}, this.deadline()).catch(() => {});
      return;
    }
    if (waiting) this.waitingSessions.add(sessionId);
    const task = this.prepareChild(sessionId, targetId, waiting)
      .catch((e) => this.opts.log?.('frame-attach-err', { sessionId, targetId, msg: String(e) }))
      .finally(() => this.attachTasks.delete(task));
    this.attachTasks.add(task);
  }

  private async prepareChild(sessionId: string, targetId: string, waiting: boolean): Promise<void> {
    const deadline = this.deadline();
    const child = this.page.child(sessionId);
    let frameId = '';
    let attached = false;
    let channel: FrameChannel | undefined;
    try {
      await child.send('Page.enable', {}, deadline);
      const tree = await child.send<{ frameTree?: FrameTreeLike }>('Page.getFrameTree', {}, deadline);
      frameId = String(tree?.frameTree?.frame?.id ?? '');
      if (!frameId) throw new FrameUnavailableError(`OOPIF ${targetId} 未返回实际 frameId`);
      this.knownFrames.add(frameId);
      const set = this.sessionsByFrame.get(frameId) ?? new Set<string>();
      set.add(sessionId);
      this.sessionsByFrame.set(frameId, set);
      this.rootFrameIds.delete(frameId);
      channel = { frameId, targetId, session: child, oopif: true };
      attached = true;
      await this.opts.onAttach(channel);
      if (this.stopped) throw new FrameUnavailableError('registry 在 attach 期间停止');
      if (!this.sessionsByFrame.get(frameId)?.has(sessionId)) {
        throw new FrameUnavailableError(`OOPIF ${targetId} 在准备期间 detach`);
      }
      this.childSessions.set(sessionId, channel);
      if (waiting) {
        await child.send('Runtime.runIfWaitingForDebugger', {}, deadline);
        this.waitingSessions.delete(sessionId);
      }
    } catch (e) {
      if (frameId) {
        const set = this.sessionsByFrame.get(frameId);
        set?.delete(sessionId);
        if (set && set.size === 0) this.sessionsByFrame.delete(frameId);
      }
      this.childSessions.delete(sessionId);
      if (attached && channel) {
        try { this.opts.onDetach(channel); } catch (err) { this.opts.log?.('frame-detach-cb-err', { msg: String(err) }); }
      }
      if (waiting) {
        try { await child.send('Runtime.runIfWaitingForDebugger', {}, this.deadline()); }
        catch {}
        this.waitingSessions.delete(sessionId);
      }
      await child.detach().catch(() => {});
      throw e;
    }
  }

  private onDetached(params: any): void {
    const sessionId = String(params?.sessionId ?? '');
    if (!sessionId) return;
    this.waitingSessions.delete(sessionId);
    const channel = this.childSessions.get(sessionId);
    this.childSessions.delete(sessionId);
    for (const [frameId, set] of this.sessionsByFrame) {
      set.delete(sessionId);
      if (set.size === 0) this.sessionsByFrame.delete(frameId);
    }
    if (channel) {
      this.rootFrameIds.delete(channel.frameId);
      try { this.opts.onDetach(channel); } catch (e) { this.opts.log?.('frame-detach-cb-err', { msg: String(e) }); }
    }
  }

  private deadline(): number {
    return Date.now() + this.deadlineMs;
  }

  private async drainAttachTasks(): Promise<void> {
    while (this.attachTasks.size > 0) await Promise.allSettled([...this.attachTasks]);
  }
}
