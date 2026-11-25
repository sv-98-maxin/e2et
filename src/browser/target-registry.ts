/**
 * Target 生命周期 registry（TASK 阶段 3 第 1 块）。
 *
 * 窄职责数据结构：保存 targetId / contextId / openerId / pageWS / childSessionId /
 * ready / closed / 创建顺序 / 捕获起点（区分 owned 暂停前初始化 vs existing 晚 attach）。
 *
 * 关键边界：
 *  - source ID 在构造时固定（bootstrap 返回 bo.tabId 后才 new registry），无占位逻辑。
 *    source ID 固定 ≠ source 永远存活：source 被关闭同样标 closed。
 *  - 创建顺序在 first target 事件（reservePopup）固定，不按 connect 完成顺序。
 *    reservePopup 在任何 await connect 之前同步去重，避免并发重复连接。
 *  - active 关闭只能回到存活 ready 页；无活页 → activeId=null，操作明确不可操作，
 *    不 fallback 已 closed source。
 *
 * 不做 owner autoAttach 编排（在 target-owner.ts）。不 attach/暂停/读 body/清理 other context。
 */
import type { CdpSession } from './daemon-client.js';

/** 捕获起点模式：owned 暂停前初始化（首批可采）vs existing 晚 attach（首批可能已过）。 */
export type CaptureMode = 'owned_paused' | 'existing_late';

export interface TargetEntry {
  targetId: string;
  contextId?: string;
  openerId?: string;
  /** 生产 pageWS：reserve 时为 undefined，connect 完成后 attachPageWs 填入。 */
  pageWs?: CdpSession;
  childSessionId?: string;
  waiting?: boolean;
  ready: boolean;
  closed: boolean;
  createdAt: number;
  /** 捕获起点：pageWs Network.enable 完成时刻（owned）/ connect 时刻（existing 晚 attach） */
  captureStart?: number;
  captureMode?: CaptureMode;
  isSource: boolean;
}

export interface ReserveOpts {
  contextId?: string;
  openerId?: string;
  childSessionId?: string;
  waiting?: boolean;
  captureMode?: CaptureMode;
}

/** source 固定不可移除条目（但可 closed）；active tab 单独管理；ready tab 按创建顺序。 */
export class TargetRegistry {
  private entries = new Map<string, TargetEntry>();
  private order: string[] = [];
  private activeTargetId: string | null;
  private readonly sourceTargetId: string;
  private seq = 0;

  /** sourceTargetId = bo.tabId（bootstrap 后真实 targetId，无占位）。 */
  constructor(sourceTargetId: string) {
    this.sourceTargetId = sourceTargetId;
    this.activeTargetId = sourceTargetId;
  }

  /** 注册 source/root tab（bootstrap 后调一次，pageWs 已就绪）。 */
  registerSource(pageWs: CdpSession, opts: { contextId?: string; captureMode?: CaptureMode } = {}): TargetEntry {
    const entry: TargetEntry = {
      targetId: this.sourceTargetId, pageWs, isSource: true, ready: true, closed: false,
      createdAt: ++this.seq,
      ...(opts.contextId ? { contextId: opts.contextId } : {}),
      ...(opts.captureMode ? { captureMode: opts.captureMode } : {}),
    };
    this.entries.set(this.sourceTargetId, entry);
    this.order.push(this.sourceTargetId);
    this.activeTargetId = this.sourceTargetId;
    return entry;
  }

  /** 同步去重 + 固定创建顺序（在任何 await connect 之前调）。
   *  返回 entry=新占用；返回 null=已存在（并发重复事件，跳过）。 */
  reservePopup(targetId: string, opts: ReserveOpts): TargetEntry | null {
    if (this.entries.has(targetId)) return null;
    const entry: TargetEntry = {
      targetId, isSource: false, ready: false, closed: false, createdAt: ++this.seq,
      ...(opts.contextId ? { contextId: opts.contextId } : {}),
      ...(opts.openerId ? { openerId: opts.openerId } : {}),
      ...(opts.childSessionId ? { childSessionId: opts.childSessionId } : {}),
      ...(opts.waiting !== undefined ? { waiting: opts.waiting } : {}),
      ...(opts.captureMode ? { captureMode: opts.captureMode } : {}),
    };
    this.entries.set(targetId, entry);
    this.order.push(targetId);
    return entry;
  }

  /** connect 完成后填入 pageWs（reserve 之后）。 */
  attachPageWs(targetId: string, pageWs: CdpSession): TargetEntry | undefined {
    const e = this.entries.get(targetId);
    if (e) e.pageWs = pageWs;
    return e;
  }

  /** 更新 childSessionId/waiting（reattach / 暂停态变化）。 */
  updateMeta(targetId: string, meta: { childSessionId?: string; waiting?: boolean }): void {
    const e = this.entries.get(targetId);
    if (!e) return;
    if (meta.childSessionId !== undefined) e.childSessionId = meta.childSessionId;
    if (meta.waiting !== undefined) e.waiting = meta.waiting;
  }

  /** 标记 pageWs 已 Page.enable + Network.enable 完毕。captureStart 落 enable 完成时刻。 */
  markReady(targetId: string): void {
    const e = this.entries.get(targetId);
    if (e) { e.ready = true; if (!e.captureStart) e.captureStart = Date.now(); }
  }

  /** 显式设捕获起点（existing 晚 attach：connect 时刻，非 enable）。 */
  setCaptureStart(targetId: string, mode: CaptureMode): void {
    const e = this.entries.get(targetId);
    if (e) { e.captureMode = mode; if (!e.captureStart) e.captureStart = Date.now(); }
  }

  get(targetId: string): TargetEntry | undefined {
    return this.entries.get(targetId);
  }

  has(targetId: string): boolean {
    return this.entries.has(targetId);
  }

  source(): TargetEntry | undefined {
    return this.entries.get(this.sourceTargetId);
  }

  sourceId(): string {
    return this.sourceTargetId;
  }

  active(): TargetEntry | undefined {
    return this.activeTargetId ? this.entries.get(this.activeTargetId) : undefined;
  }

  activeId(): string | null {
    return this.activeTargetId;
  }

  /** 切 active tab（switch-tab）。只选存活 ready 且 pageWs 已就绪的。
   *  越界 / 非 ready / closed / 无 pageWs → 返回 null（拒绝假成功）。 */
  setActive(targetId: string): TargetEntry | null {
    const e = this.entries.get(targetId);
    if (!e || e.closed || !e.ready || !e.pageWs) return null;
    this.activeTargetId = targetId;
    return e;
  }

  /** 按创建顺序列出存活 ready tab（含 source）。switch-tab index 从 0 开始按此序。 */
  readyTabs(): TargetEntry[] {
    return this.order
      .map((id) => this.entries.get(id)!)
      .filter((e) => e && !e.closed && e.ready && e.pageWs);
  }

  /** 所有已注册 target（含 closed，cleanup 用）。 */
  all(): TargetEntry[] {
    return this.order.map((id) => this.entries.get(id)!).filter(Boolean);
  }

  /** 非源 target（popup，cleanup resume/detach 用）。 */
  popups(): TargetEntry[] {
    return this.all().filter((e) => !e.isSource && !e.closed);
  }

  /** 释放失败/取消的预占（connect 失败 / onPopup 失败 / stop 后晚完成）：
   *  只移除未 ready 的非 source 条目，不留永久 pending。已 ready 的不释放。 */
  releasePopup(targetId: string): void {
    const e = this.entries.get(targetId);
    if (!e || e.isSource || e.ready) return;
    this.entries.delete(targetId);
    this.order = this.order.filter((id) => id !== targetId);
    if (this.activeTargetId === targetId) this.activeTargetId = this.sourceTargetId;
  }

  /** 关闭 target：标 closed。active 关闭 → 回到首个存活 ready 页；无活页 → activeId=null。
   *  source 被关闭同样标 closed，不 fallback 已 closed source。 */
  close(targetId: string): TargetEntry | undefined {
    const e = this.entries.get(targetId);
    if (!e) return undefined;
    e.closed = true;
    e.ready = false;
    if (this.activeTargetId === targetId) {
      const live = this.readyTabs()[0];
      this.activeTargetId = live ? live.targetId : null;
    }
    return e;
  }
}
