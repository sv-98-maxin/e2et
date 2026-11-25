/**
 * Target owner 编排（TASK 阶段 3 第 1 块）。
 *
 * 两种 ownership 路径：
 *  - owned（managed / chrome-profile，本 daemon 实际启动的专用 Chrome）：
 *    arm browser-level Target.setAutoAttach(autoAttach=true, waitForDebuggerOnStart=true, flatten=true)。
 *    新 popup 暂停 → 建 pageWS → enable → 再 runIfWaitingForDebugger（不 await 源 click）。
 *    已存在 target（含 source 页自身）被 auto-attach 暂停 → 立即 resume。
 *    捕获起点 = enable 完成时刻（owned_paused，暂停前初始化，首批可采）。
 *  - shared（existing 共享 Chrome）：
 *    只 Target.setDiscoverTargets（只读）+ 监听 targetCreated/targetInfoChanged。
 *    过滤 own context（browserContextId === sourceContextId）或 openerId 链到 source。
 *    绝不 global autoAttach / 暂停 / attach / 读 body / 清理其他 context。
 *    own popup 建 pageWS（无暂停）；捕获起点 = reserve 时刻（existing_late，首批可能已过）。
 *
 * 产品约束：pageWS 是 NetworkTrace 唯一承载；owner 不帮采（不发 Network.enable）。
 * owner child session 只作 pause/resume 句柄（owned）；shared 无 child session。
 *
 * 去重：reserve 在任何 await connect 之前同步调用，避免 targetCreated/infoChanged/attached
 * 并发重复连接。创建顺序在 reserve（first event）固定，不按 connect 完成顺序。
 */
import type { CdpSession } from './daemon-client.js';
import type { CdpLowSession } from './managed-browser.js';
import type { CaptureMode } from './target-registry.js';

export interface PopupMeta {
  contextId?: string;
  openerId?: string;
  childSessionId?: string;
  waiting: boolean;
  url?: string;
  captureMode: CaptureMode;
}

export interface PopupInfo extends PopupMeta {
  targetId: string;
  pageWs: CdpSession;
}

export interface TargetOwnerOptions {
  owner: CdpLowSession;
  baseUrl: string;
  kind: 'owned' | 'shared';
  sourceTargetId: string;
  sourceContextId?: string;
  connect: (targetId: string, baseUrl: string) => Promise<CdpSession>;
  /** 同步去重 + 固定创建顺序（在任何 await connect 之前）。返回 true=新占用，false=已存在跳过。 */
  reserve: (targetId: string, meta: PopupMeta) => boolean;
  /** 释放失败/取消的预占（connect 失败 / onPopup 失败 / stop 后晚完成）：daemon 从 registry 移除未 ready 条目。 */
  release?: (targetId: string) => void;
  /** popup 接管回调（connect 完成后）：daemon 在此 attachPageWs + addTarget + Page.enable + Network.enable + (owned) resume。 */
  onPopup: (info: PopupInfo) => Promise<void>;
  /** target 被销毁回调（Target.targetDestroyed / pageWs onClose）：daemon 同步 registry+cdp+NetworkTrace，无活页才 abort。 */
  onDestroyed?: (targetId: string, reason: string) => void;
  log?: (tag: string, data?: unknown) => void;
}

interface WaitingChild {
  sessionId: string;
  targetId: string;
}

export class TargetOwner {
  private waitingChildren = new Map<string, WaitingChild>();
  private offListeners: Array<() => void> = [];
  private armed = false;
  private stopped = false;
  /** owned: arm 前既存 page targetId 集（launchChromium 遗留 about:blank + createTabIn 的 source）。
   *  这些只是应 resume/detach 的非 case 页，绝不进 readyTabs/NetworkTrace。
   *  否则 source0/popup1 会变成空白页1，IR runtime.context.pages 只含 case 页，index 回放必串。 */
  private preArmPages = new Set<string>();

  constructor(private readonly opts: TargetOwnerOptions) {}

  private captureModeFor(waiting: boolean): CaptureMode {
    return this.opts.kind === 'owned' && waiting ? 'owned_paused' : 'existing_late';
  }

  /** 注册监听并 arm。owned: autoAttach；shared: discover。
   *  监听器先注册再 arm：autoAttach 返回前 root target 的 attachedToTarget 已可能到达。 */
  async arm(): Promise<void> {
    if (this.armed || this.stopped) return;
    const { owner, kind } = this.opts;
    if (kind === 'owned') {
      this.offListeners.push(owner.addEventListener('Target.attachedToTarget', (params) => this.onAttached(params)));
      this.offListeners.push(owner.addEventListener('Target.targetDestroyed', (params) => this.onDestroyed(params, 'target_destroyed')));
      await owner.send('Target.setDiscoverTargets', { discover: true });
      // 快照 arm 前既存 page（含 launchChromium 遗留 about:blank + createTabIn 的 source）
      const { targetInfos } = await owner.send<{ targetInfos: Array<{ targetId: string; type: string }> }>('Target.getTargets');
      for (const ti of targetInfos ?? []) {
        if (ti.type === 'page') this.preArmPages.add(String(ti.targetId));
      }
      await owner.send('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
        filter: [{ type: 'page', exclude: false }, { exclude: true }],
      });
    } else {
      this.offListeners.push(owner.addEventListener('Target.targetCreated', (params) => this.onTargetCreated(params)));
      this.offListeners.push(owner.addEventListener('Target.targetInfoChanged', (params) => this.onTargetInfoChanged(params)));
      this.offListeners.push(owner.addEventListener('Target.targetDestroyed', (params) => this.onDestroyed(params, 'target_destroyed')));
      await owner.send('Target.setDiscoverTargets', { discover: true });
    }
    this.armed = true;
  }

  /** owned: 处理 attachedToTarget。
   *  - 非 page target（service_worker/other）：resume 后跳过。
   *  - arm 前既存 page（含 source、launchChromium 遗留 about:blank）：resume/detach，绝不 takeover。
   *  - arm 后新 page（真实 popup，含 noopener）：takeover 登记为 case target。
   *  opener 只作父子关系记录，不拿 URL 猜归属（owned 专用 Chrome 全是自己的）。 */
  private onAttached(params: any): void {
    if (this.stopped) return;
    const ti = params?.targetInfo ?? {};
    const sessionId: string | undefined = params?.sessionId;
    const waiting: boolean | undefined = params?.waitingForDebugger;
    const targetId = String(ti.targetId ?? '');
    const type = String(ti.type ?? '');
    this.opts.log?.('attachedToTarget', { targetId, type, url: ti.url, openerId: ti.openerId, waiting });
    if (!sessionId) return;
    if (type !== 'page') {
      if (type === 'iframe') {
        this.opts.log?.('iframe-deferred', { targetId, sessionId, waiting });
        return;
      }
      if (waiting) this.resumeChild(sessionId, targetId);
      return;
    }
    // arm 前既存 page（source / 遗留空白）：只 resume，不进 readyTabs/NetworkTrace
    if (this.preArmPages.has(targetId)) {
      if (waiting) this.resumeChild(sessionId, targetId);
      return;
    }
    void this.takeoverPopup(targetId, {
      ...(sessionId ? { childSessionId: sessionId } : {}),
      waiting: !!waiting,
      ...(ti.browserContextId ? { contextId: String(ti.browserContextId) } : {}),
      ...(ti.openerId ? { openerId: String(ti.openerId) } : {}),
      ...(ti.url ? { url: String(ti.url) } : {}),
      captureMode: this.captureModeFor(!!waiting),
    }).catch((e) => {
      // takeoverPopup 内部 connect/onPopup catch 已负责 close/release/resume（单一路径），外层只记录，不重复 resumeChild
      this.opts.log?.('popup-takeover-err', { targetId, msg: String(e) });
    });
  }

  /** shared: targetCreated 只发现不暂停。过滤 own context / opener 链。 */
  private onTargetCreated(params: any): void {
    this.handleSharedTarget(params?.targetInfo);
  }

  private onTargetInfoChanged(params: any): void {
    this.handleSharedTarget(params?.targetInfo);
  }

  private handleSharedTarget(ti: any): void {
    if (this.stopped) return;
    if (!ti || String(ti.type ?? '') !== 'page') return;
    const targetId = String(ti.targetId ?? '');
    if (targetId === this.opts.sourceTargetId) return;
    if (!this.isOwnTarget(ti)) return;
    void this.takeoverPopup(targetId, {
      waiting: false,
      ...(ti.browserContextId ? { contextId: String(ti.browserContextId) } : {}),
      ...(ti.openerId ? { openerId: String(ti.openerId) } : {}),
      ...(ti.url ? { url: String(ti.url) } : {}),
      captureMode: this.captureModeFor(false),
    }).catch((e) => this.opts.log?.('shared-popup-takeover-err', { targetId, msg: String(e) }));
  }

  /** target 销毁：回调 daemon 同步 registry/cdp/NetworkTrace。 */
  private onDestroyed(params: any, reason: string): void {
    if (this.stopped) return;
    const targetId = String(params?.targetId ?? '');
    if (!targetId || targetId === this.opts.sourceTargetId) {
      // source 销毁也回调（daemon 决定是否 abort）
      if (targetId) this.opts.onDestroyed?.(targetId, reason);
      return;
    }
    this.opts.onDestroyed?.(targetId, reason);
  }

  /** shared 过滤：必须确认独占 context 一致（browserContextId === sourceContextId）。
   *  缺 ctx 等 infoChanged 补全；opener 不能绕过过滤（不能由 opener==source 就接管）。 */
  private isOwnTarget(ti: any): boolean {
    const ctx = this.opts.sourceContextId;
    if (!ctx) return false; // shared 无 context 信息不猜归属，等真实 infoChanged
    return ti.browserContextId === ctx;
  }

  /** 接管 popup：reserve（同步去重，固定创建顺序）→ connect → onPopup（enable + resume）。
   *  reserve 在任何 await 之前，避免并发重复连接。owned 先 enable 再 resume。
   *  connect 后重查 stopped/已销毁：晚完成的 pageWS 直接 close，不 onPopup 写 trace。
   *  onPopup 初始化失败：close pageWs + release 预占 + resume waiting，不留永久 pending。 */
  private async takeoverPopup(targetId: string, meta: PopupMeta): Promise<void> {
    if (this.stopped) return;
    // ① 同步去重 + 固定创建顺序（first event）
    const reserved = this.opts.reserve(targetId, meta);
    if (!reserved) return; // 并发重复事件，已占用
    // ② owned 暂停态：登记 waiting child（失败兜底 resume）
    if (meta.waiting && meta.childSessionId) {
      this.waitingChildren.set(meta.childSessionId, { sessionId: meta.childSessionId, targetId });
    }
    // ③ 建独立 pageWS（不 await 源 click；owned 暂停期间建）
    let pageWs: CdpSession;
    try {
      pageWs = await this.opts.connect(targetId, this.opts.baseUrl);
    } catch (e) {
      this.opts.log?.('popup-pageWS-err', { targetId, msg: String(e) });
      this.opts.release?.(targetId);
      if (meta.waiting && meta.childSessionId) this.resumeChild(meta.childSessionId, targetId);
      throw e;
    }
    // connect 后重查：stop 已触发或 target 已销毁 → 直接 close pageWs，不 onPopup
    if (this.stopped) {
      try { pageWs.close(); } catch {}
      this.opts.release?.(targetId);
      return;
    }
    // ④ 回调 daemon：attachPageWs + addTarget + Page.enable + Network.enable + (owned) resume
    try {
      await this.opts.onPopup({ targetId, pageWs, ...meta });
    } catch (e) {
      // onPopup 初始化失败：close pageWs + release 预占 + resume waiting，不留 pending
      try { pageWs.close(); } catch {}
      this.opts.release?.(targetId);
      if (meta.waiting && meta.childSessionId) this.resumeChild(meta.childSessionId, targetId);
      this.opts.log?.('popup-init-failed', { targetId, msg: String(e) });
      throw e;
    }
  }

  /** owned: popup pageWS enable 完成后调 runIfWaitingForDebugger（放行首批）。
   *  ACK 成功才解除 waiting；失败不 ready，waiting 保留由 stop 兑底 resume。返回是否成功。 */
  async resumePopup(childSessionId: string): Promise<boolean> {
    try {
      await this.opts.owner.send('Runtime.runIfWaitingForDebugger', {}, childSessionId);
      this.waitingChildren.delete(childSessionId); // ACK 成功才解除
      return true;
    } catch (e) {
      this.opts.log?.('resume-popup-err', { childSessionId, msg: String(e) });
      // 失败：不解除 waiting（stop 时兑底 resume），调用方据此不 markReady
      return false;
    }
  }

  private resumeChild(sessionId: string, targetId: string): void {
    this.waitingChildren.delete(sessionId);
    this.opts.owner.send('Runtime.runIfWaitingForDebugger', {}, sessionId)
      .then(() => this.opts.log?.('resume-child', { sessionId, targetId }))
      .catch((e) => this.opts.log?.('resume-child-err', { sessionId, msg: String(e) }));
  }

  /** stop：阻止新接管 + owned 显式关 global autoAttach（不再暂停新 target）+
   *  resume 所有自己暂停的 child + 卸载监听。 */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const off of this.offListeners) { try { off(); } catch {} }
    this.offListeners = [];
    // owned: 显式关 global autoAttach，不卸监听后仍在暂停新 target
    if (this.opts.kind === 'owned') {
      try { await this.opts.owner.send('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: true }); }
      catch { /* owner 可能已断 */ }
    }
    for (const [, info] of this.waitingChildren) {
      try { await this.opts.owner.send('Runtime.runIfWaitingForDebugger', {}, info.sessionId); }
      catch { /* target 可能已关闭 */ }
    }
    this.waitingChildren.clear();
  }

  isStopped(): boolean { return this.stopped; }
}
