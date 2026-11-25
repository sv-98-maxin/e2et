/**
 * 共源导航状态与分号规则（R2/R3 唯一方案）。
 * 唯一维护源：runtime/shared/network-navigation.ts；
 * src/shared 与 runtime_assets 镜像由 scripts/sync-runtime-to-agents.sh 生成。
 * Source network-trace 与 runtime request-tracker 都导入本模块，各自不允许再维护分号规则。
 *
 * 分号/消费时点（F1）：
 * - 已确定 main Document 且非 redirectContinuation：同步 next() 分 n、写 pendingNavigation、
 *   同步写 currentNavId；调用方此后才能按 currentNavId 建请求记录。
 * - redirectContinuation 只由 redirectResponse 在场且前 hop.mainDocument 决定；只更新 pending.to，不新分 n。
 * - onFrameNavigated 只在无 parentId 的主帧事件更新 mainFrameId/currentUrl/pending.to，不消费 pending。
 * - onSameDocument 仅匹配主 frameId，独立 next()，不消费仍 provisional 的 pending。
 * - finishPending 是唯一 pending 消费点（commit 后或本 hop.mainDocument 的 loadingFinished/loadingFailed 调用）。
 */

export interface NetworkNavigation {
  id: string;
  from: string;
  to: string;
  triggeredBy: string | null;
}

export interface NetworkNavigationState {
  /** 真实主帧 CDP frameId；null 表示尚未初始化，不从首个 Document 猜主帧（F2） */
  mainFrameId: string | null;
  currentUrl: string;
  currentNavId: string;
  /** provisional 主文档导航：main Document 分号后、commit 前持有 */
  pendingNavigation?: NetworkNavigation;
}

export interface NavigationRequestInput {
  resourceType: string;
  frameId?: string;
  url: string;
  /** 由调用方按 redirectResponse 在场且前 hop.mainDocument 计算 */
  redirectContinuation?: boolean;
  triggeredBy?: string | null;
}

export interface NavigationFrameInput {
  id: string;
  parentId?: string;
  url?: string;
  /** CDP Frame.url 不含 fragment，urlFragment 单独字段（含 '#'），拼接完整 URL */
  urlFragment?: string;
}

/** 分配器：每 Source session / 每 runTest 一实例（n 全会话唯一），非全局 singleton。
 *  初始页/源 target 自持 n0，不经分配器；新 target 用 next() 预留（沿用 Source 旧规则）。 */
export class NetworkNavigationTracker {
  private seq = 0;

  /** 单调分配下一 nav 标识（n1, n2, ...） */
  next(): string {
    return 'n' + ++this.seq;
  }

  /** 主 Document request 起始分号。要求 state.mainFrameId 非 null 且等于事件 frameId，
   *  不从首个 Document 猜主帧；返回是否 main Document（含 redirect 链）。 */
  onRequest(state: NetworkNavigationState, input: NavigationRequestInput): boolean {
    const mainDocument = input.resourceType.toLowerCase() === 'document'
      && state.mainFrameId !== null
      && input.frameId !== undefined
      && input.frameId === state.mainFrameId;
    if (!mainDocument) return false;
    if (input.redirectContinuation) {
      if (state.pendingNavigation) state.pendingNavigation.to = input.url;
      return true;
    }
    const id = this.next();
    state.pendingNavigation = {
      id,
      from: state.currentUrl,
      to: input.url,
      triggeredBy: input.triggeredBy ?? null,
    };
    state.currentNavId = id;
    return true;
  }

  /** 主帧同文档导航：独立分 n、更新 currentNavId/currentUrl；返回独立 navigation；
   *  非 main frameId 返回 null；不消费仍 provisional 的 pending。 */
  onSameDocument(
    state: NetworkNavigationState,
    input: { frameId?: string; url: string; triggeredBy?: string | null },
  ): NetworkNavigation | null {
    if (state.mainFrameId === null || input.frameId === undefined || input.frameId !== state.mainFrameId) {
      return null;
    }
    const navigation: NetworkNavigation = {
      id: this.next(),
      from: state.currentUrl,
      to: input.url,
      triggeredBy: input.triggeredBy ?? null,
    };
    state.currentNavId = navigation.id;
    state.currentUrl = navigation.to;
    return navigation;
  }

  /** 主帧 commit：仅无 parentId 的真实主帧事件更新 mainFrameId/currentUrl 及 pending.to；
   *  不消费 pending。返回是否主帧（iframe 返回 false 由调用方忽略）。 */
  onFrameNavigated(state: NetworkNavigationState, frame: NavigationFrameInput): boolean {
    if (frame.parentId !== undefined) return false;
    state.mainFrameId = frame.id;
    if (frame.url === undefined) return true;
    const frameUrl = frame.url + (frame.urlFragment ?? '');
    if (state.pendingNavigation) state.pendingNavigation.to = frameUrl;
    else state.currentUrl = frameUrl;
    return true;
  }

  /** 唯一 pending 消费点：恢复 pending 的 id/to 到 state、清 pending、返回真实待发导航。 */
  finishPending(state: NetworkNavigationState): NetworkNavigation | null {
    const pending = state.pendingNavigation;
    if (!pending) return null;
    state.currentNavId = pending.id;
    state.currentUrl = pending.to;
    delete state.pendingNavigation;
    return pending;
  }
}
