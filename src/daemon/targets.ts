/**
 * popup/target 接管接线 owner：持有 TargetOwner，按原顺序完成 reserve → enable →
 * observer → network → resume，处理关闭与迟到续体。
 * 复用既有 TargetOwner/TargetRegistry 算法，不复制 registry 实现。
 */
import type { CdpSession } from '../browser/daemon-client.js';
import { CdpSession as CdpConnection } from '../browser/daemon-client.js';
import type { CdpLowSession } from '../browser/managed-browser.js';
import { openCdpSession } from '../browser/managed-browser.js';
import { TargetOwner, type PopupInfo } from '../browser/target-owner.js';
import type { BrowserSource } from '../auth-resolve.js';
import { appendTraceEvent, redactText, redactUrl } from './trace.js';
import { OBSERVER_SCRIPT } from './observer-script.js';
import type { LifecycleSnapshot } from './session-types.js';
import type { PageContext } from './page-context.js';
import type { PageObservers } from './page-observers.js';
import type { NetworkTrace } from './network-trace.js';
import type { SessionLifecycle } from './lifecycle.js';

export interface TargetsDeps {
  sessionId: string;
  page: PageContext;
  observers: () => PageObservers | null;
  networkTrace: () => NetworkTrace | null;
  lifecycleSnapshot: () => Readonly<LifecycleSnapshot>;
  installDialogHandler: (pageWs: CdpSession) => void;
  removeDialogHandler: (pageWs: CdpSession) => void;
  trace: (ev: Record<string, unknown>) => void;
}

export interface ArmInput {
  sourceSession: CdpSession;
  sourceTabId: string;
  endpoint: string;
  browserSource: BrowserSource;
  browserContextId?: string;
  lifecycle: SessionLifecycle;
}

export class TargetCoordinator {
  private targetOwner: TargetOwner | null = null;

  constructor(private readonly deps: TargetsDeps) {}

  async arm(input: ArmInput): Promise<void> {
    const { page } = this.deps;
    const isOwned = input.browserSource === 'managed' || input.browserSource === 'chrome-profile';
    const kind = isOwned ? 'owned' : 'shared';
    let armOwner: CdpLowSession | null = input.lifecycle.owner;
    if (isOwned) {
      armOwner = armOwner ?? await openCdpSession(input.endpoint);
      if (!input.lifecycle.adoptOwnedOwner(armOwner)) {
        input.lifecycle.releaseOwnedOwner(armOwner);
        return;
      }
    }
    if (!armOwner) return;
    const owner = armOwner;
    // 基线语义：owned/shared 的 owner WS 断链都视为会话中止（page 仍活也不能假装 ready）
    owner.onClose(() => {
      const ls = this.deps.lifecycleSnapshot();
      if (!ls.stopped) void input.lifecycle.stop('aborted', 10_000, false);
    });
    const targetOwner = new TargetOwner({
      owner, baseUrl: input.endpoint, kind,
      sourceTargetId: input.sourceTabId, ...(input.browserContextId ? { sourceContextId: input.browserContextId } : {}),
      connect: (targetId, baseUrl) => CdpConnection.connect(targetId, baseUrl),
      reserve: (targetId, meta) => page.reservePopup(targetId, meta) !== null,
      release: (targetId) => page.releasePopup(targetId),
      onDestroyed: (targetId, reason) => { if (page.hasTarget(targetId)) page.handleTargetClosed(targetId, reason); },
      onPopup: (info) => this.onPopup(info),
      log: (tag, data) => {
        if (this.deps.lifecycleSnapshot().stopped) return;
        this.deps.trace({ t: 'target_owner', tag, ...(data !== undefined ? { data } : {}) });
      },
    });
    this.targetOwner = targetOwner;
    await targetOwner.arm();
  }

  private cancelled(entry: ReturnType<PageContext['getTarget']>): boolean {
    const { page } = this.deps;
    return this.deps.lifecycleSnapshot().stopped
      || !entry
      || !page.hasTarget(entry.targetId)
      || page.getTarget(entry.targetId) !== entry
      || !!entry.closed;
  }

  private silentRecycle(entry: ReturnType<PageContext['getTarget']>, info: PopupInfo): void {
    const { page } = this.deps;
    const trace = this.deps.networkTrace();
    this.deps.removeDialogHandler(info.pageWs);
    if (entry && page.getTarget(info.targetId) === entry) {
      trace?.removeTarget(info.targetId);
      page.releasePopup(info.targetId);
    }
    try { info.pageWs.close(); } catch { /* 已关闭 */ }
  }

  private async onPopup(info: PopupInfo): Promise<void> {
    const { page } = this.deps;
    const trace = this.deps.networkTrace();
    const observers = this.deps.observers();
    if (!trace || !observers) return;
    const entry = page.getTarget(info.targetId);
    if (this.deps.lifecycleSnapshot().stopped || !entry || entry.closed) {
      if (entry && page.getTarget(info.targetId) === entry) page.releasePopup(info.targetId);
      try { info.pageWs.close(); } catch { /* 已关闭 */ }
      return;
    }
    if (info.captureMode === 'existing_late') page.setCaptureStart(info.targetId, 'existing_late');
    page.attachPopupWs(info.targetId, info.pageWs);
    this.deps.installDialogHandler(info.pageWs);
    info.pageWs.onClose(() => { if (page.getTarget(info.targetId) === entry) page.handleTargetClosed(info.targetId, 'popup_ws_close'); });
    trace.addTarget(info.targetId, info.pageWs, undefined, undefined);
    try {
      await info.pageWs.send('Page.enable');
      if (this.cancelled(entry)) { this.silentRecycle(entry, info); return; }
      try { await observers.attach(info.targetId, info.pageWs); }
      catch (e) {
        const ls = this.deps.lifecycleSnapshot();
        if (!ls.stopped && ls.state === 'running' && !this.cancelled(entry)) {
          this.deps.trace({ t: 'console_init_error', target_id: info.targetId, error: redactMessage(e) });
        }
      }
      if (this.cancelled(entry)) { this.silentRecycle(entry, info); return; }
      await info.pageWs.send('Network.enable');
      if (this.cancelled(entry)) { this.silentRecycle(entry, info); return; }
      await trace.initialize(info.targetId);
      if (this.cancelled(entry)) { this.silentRecycle(entry, info); return; }
      await info.pageWs.send('Page.addScriptToEvaluateOnNewDocument', { source: OBSERVER_SCRIPT });
      if (this.cancelled(entry)) { this.silentRecycle(entry, info); return; }
    } catch (e) {
      if (this.cancelled(entry)) { this.silentRecycle(entry, info); return; }
      this.deps.trace({ t: 'popup_init_error', target_id: info.targetId, error: redactMessage(e) });
      this.deps.removeDialogHandler(info.pageWs);
      if (page.getTarget(info.targetId) === entry) trace.removeTarget(info.targetId);
      throw e;
    }
    const domContentUnsub = info.pageWs.on('Page.domContentEventFired', () => {
      if (this.cancelled(entry)) { domContentUnsub(); return; }
      info.pageWs.evaluate(OBSERVER_SCRIPT).catch((e) => {
        if (!this.cancelled(entry)) this.deps.trace({ t: 'dom_observer_rebind_error', target_id: info.targetId, error: redactMessage(e) });
      }).finally(() => { if (this.cancelled(entry)) domContentUnsub(); });
    });
    info.pageWs.onClose(() => { domContentUnsub(); });
    let resumed = true;
    if (info.waiting && info.childSessionId) {
      if (this.cancelled(entry)) { domContentUnsub(); this.silentRecycle(entry, info); return; }
      resumed = await this.targetOwner!.resumePopup(info.childSessionId);
    }
    if (this.cancelled(entry)) { domContentUnsub(); this.silentRecycle(entry, info); return; }
    try {
      await info.pageWs.evaluate(OBSERVER_SCRIPT);
      if (this.cancelled(entry)) { domContentUnsub(); this.silentRecycle(entry, info); return; }
    } catch (e) {
      if (this.cancelled(entry)) { domContentUnsub(); this.silentRecycle(entry, info); return; }
      this.deps.trace({ t: 'popup_init_error', target_id: info.targetId, error: redactMessage(e) });
      if (page.getTarget(info.targetId) === entry) trace.removeTarget(info.targetId);
      domContentUnsub();
      throw e;
    }
    if (resumed) page.markReady(info.targetId);
    appendTraceEvent(this.deps.sessionId, {
      t: 'popup_attached', target_id: info.targetId, ...(info.openerId ? { opener_id: info.openerId } : {}),
      url: redactUrl(page.targetUrl(info.targetId)), capture_mode: info.captureMode, waiting: info.waiting, ready: resumed,
    });
  }

  async stop(): Promise<void> {
    try { await this.targetOwner?.stop(); } catch { /* owner 已断开 */ }
    this.targetOwner = null;
  }
}

function redactMessage(e: unknown): string {
  return redactText((e as Error).message);
}
