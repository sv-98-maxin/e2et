/**
 * 会话生命周期 owner：状态机（starting/running/stopping）、浏览器资源追踪、
 * signal 处理、idle 计时、keepAlive 和收尾调度。
 *
 * 实际资源释放由构造时传入的 cleanup 回调完成；lifecycle 只持有自己的状态，
 * 不向外暴露可写资源。
 */
import * as fs from 'node:fs';
import type { CdpSession } from '../browser/daemon-client.js';
import { closeTabIn } from '../browser/daemon-client.js';
import { killProcessGroup, openCdpSession, type CdpLowSession } from '../browser/managed-browser.js';
import type { BootstrapResult } from './bootstrap.js';
import { readMeta, writeMeta } from './session-meta.js';
import { readTraceEvents, writeSessionEnd, type SessionEndExtras } from './trace.js';
import type { SessionResult, LifecycleSnapshot, BrowserResources } from './session-types.js';

const CLEANUP_TIMEOUT_MS = 10_000;

/** 有限清理端口：owner 的停止/摘要、trace flush 与 server/socket 关闭。 */
export interface CleanupPorts {
  /** true = 所有原本影响终态的 owner 清理成功（hover cleanup 失败为 false）。 */
  stopOwners(): Promise<boolean>;
  flushTrace(): Promise<void>;
  closePage(): void;
  summary(): { total: number; pass: number; mocked: boolean };
  closeServer(): void;
  removeSocket(): Promise<void>;
}

export interface LifecycleOptions {
  sessionId: string;
  socketPath: string;
  exitOnStop?: boolean;
  idleTimeoutMs: number;
  cleanup: (requested: SessionResult, browser: Readonly<BrowserResources>) => Promise<SessionResult>;
}

class IdleTimer {
  private timer: NodeJS.Timeout | null = null;
  constructor(private readonly ms: number, private readonly onTimeout: () => void) {
    this.arm();
  }
  arm(): void {
    this.clear();
    this.timer = setTimeout(this.onTimeout, this.ms);
    this.timer.unref?.();
  }
  reset(): void {
    this.arm();
  }
  clear(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

export class SessionLifecycle {
  private state: 'starting' | 'running' | 'stopping' = 'starting';
  private _stopped = false;
  private stopPromise: Promise<SessionResult> | null = null;

  private readonly browser: BrowserResources = {
    tabId: null,
    owner: null,
    ownedBrowserOwner: null,
  };

  private idleTimer: IdleTimer | null = null;
  private readonly keepAlivePromise: Promise<void>;
  private keepAliveResolve!: () => void;

  private readonly onSigTerm: () => void;
  private readonly onSigInt: () => void;

  constructor(private readonly opts: LifecycleOptions) {
    this.keepAlivePromise = new Promise<void>((resolve) => { this.keepAliveResolve = resolve; });
    this.onSigTerm = () => { void this.stop('aborted', CLEANUP_TIMEOUT_MS, false); };
    this.onSigInt = () => { void this.stop('aborted', CLEANUP_TIMEOUT_MS, false); };
  }

  /** 显式安装本实例 signal handlers（协调入口在 bootstrap 前调用一次）。 */
  installSignals(): void {
    process.on('SIGTERM', this.onSigTerm);
    process.on('SIGINT', this.onSigInt);
  }

  snapshot(): Readonly<LifecycleSnapshot> {
    return { state: this.state, stopped: this._stopped };
  }

  /** 浏览器资源只读快照（cleanup 回调与停止判定使用）。 */
  browserSnapshot(): Readonly<BrowserResources> {
    return this.browser;
  }

  /** bootstrap 第 6 参数的 onContext 回调：发布/撤销 owner 与 contextId+endpoint。 */
  onContext(owner: CdpLowSession | null, contextId: string, endpoint: string): void {
    if (owner) {
      if (this._stopped) { try { owner.close(); } catch { /* stop 已回收 */ } return; }
      this.browser.owner = owner;
      this.browser.browserContextId = contextId;
      this.browser.browserEndpoint = endpoint;
      return;
    }
    if (this.browser.browserContextId === contextId && this.browser.browserEndpoint === endpoint) {
      this.browser.owner = null;
      this.browser.browserContextId = undefined;
      this.browser.browserEndpoint = undefined;
    }
  }

  /** 第 11 节：浏览器进程已 spawn，先登记可回收的 pid/user-data-dir。
   *  已停止时拒绝（返回 false），由调用方（bootstrap 的 onSpawn hook）抛错让 launch 回收自己的 child。 */
  onSpawn(pid: number, userDataDir: string): boolean {
    if (this._stopped) return false;
    this.browser.browserPid = pid;
    this.browser.browserUserDataDir = userDataDir;
    return true;
  }

  /** bootstrap 成功后导入结果；停止后的迟到结果返回 false，由协调入口回收自身资源。 */
  adoptBootstrap(result: BootstrapResult): boolean {
    if (this._stopped) return false;
    this.browser.tabId = result.tabId;
    if (result.owner) this.browser.owner = result.owner;
    if (result.browserPid) this.browser.browserPid = result.browserPid;
    if (result.browserUserDataDir) this.browser.browserUserDataDir = result.browserUserDataDir;
    if (result.endpoint) this.browser.browserEndpoint = result.endpoint;
    if (result.browserContextId) this.browser.browserContextId = result.browserContextId;
    return true;
  }

  /** owned 模式 post-bootstrap 的 browser-level owner WS；stop 后迟到连接立即关闭。 */
  adoptOwnedOwner(owner: CdpLowSession): boolean {
    if (this._stopped) { try { owner.close(); } catch { /* 已停止 */ } return false; }
    this.browser.ownedBrowserOwner = owner;
    return true;
  }

  /** 只撤销同一连接身份。 */
  releaseOwnedOwner(owner: CdpLowSession): void {
    if (this.browser.ownedBrowserOwner === owner) this.browser.ownedBrowserOwner = null;
  }

  markRunning(): void {
    if (this._stopped || this.state === 'stopping') return;
    this.state = 'running';
    this.idleTimer = new IdleTimer(this.opts.idleTimeoutMs, () => {
      void this.stop('aborted', CLEANUP_TIMEOUT_MS, false);
    });
  }

  /** 置 stopping → 同一次 cleanup → 超时保护。deferExit 时由调用方决定退出时机。 */
  stop(result: SessionResult, timeoutMs: number, deferExit = false): Promise<SessionResult> {
    if (this.stopPromise) return this.stopPromise;
    this._stopped = true;
    this.state = 'stopping';
    this.idleTimer?.clear();
    this.stopPromise = this.runCleanup(result, timeoutMs, deferExit);
    return this.stopPromise;
  }

  private async runCleanup(result: SessionResult, timeoutMs: number, deferExit: boolean): Promise<SessionResult> {
    const outcome = await Promise.race([
      this.opts.cleanup(result, this.browser).then((cleaned) => ({ timedOut: false as const, result: cleaned })),
      new Promise<{ timedOut: true; result: 'aborted' }>((resolve) => {
        const t = setTimeout(() => resolve({ timedOut: true, result: 'aborted' }), timeoutMs);
        t.unref?.();
      }),
    ]);
    if (outcome.timedOut || !deferExit) {
      if (this.opts.exitOnStop !== false) process.exit(0);
      else if (!deferExit) this.keepAliveResolve();
    }
    return outcome.result;
  }

  dispose(): void {
    process.off('SIGTERM', this.onSigTerm);
    process.off('SIGINT', this.onSigInt);
  }

  resetIdle(): void {
    this.idleTimer?.reset();
  }

  /** 进程常驻 promise（构造时建立）；测试注入 exitOnStop=false 时由 stop/socket flush resolve。 */
  keepAlive(): Promise<void> {
    return this.keepAlivePromise;
  }

  exitAfterStopResponse(): void {
    this.keepAliveResolve();
  }

  get sessionId(): string { return this.opts.sessionId; }
  get socketPath(): string { return this.opts.socketPath; }
  get exitOnStop(): boolean | undefined { return this.opts.exitOnStop; }
  get tabId(): string | null { return this.browser.tabId; }
  get owner(): CdpLowSession | null { return this.browser.owner; }
  get stopped(): boolean { return this._stopped; }

  // ── 收尾编排（stop 的 cleanup 回调调用；协调入口只提供有限端口） ──

  /** 完整会话收尾：置停 → 资源释放 → 证据结算 → session_end/meta → server/socket。 */
  async finalize(requested: SessionResult, ports: CleanupPorts): Promise<SessionResult> {
    let result = requested;
    try {
      if (!await ports.stopOwners()) result = 'aborted';
      let traceComplete = true;
      try { await ports.flushTrace(); } catch { traceComplete = false; result = 'aborted'; }
      ports.closePage();
      await this.closeBrowserResources(this.browser);
      const settled = this.settle(result, traceComplete, ports.summary());
      result = settled.result;
      traceComplete = settled.traceComplete;
      if (traceComplete) {
        try {
          const extras: SessionEndExtras = { mocked: ports.summary().mocked, asserts: { total: ports.summary().total, pass: ports.summary().pass }, timeouts: settled.timeouts };
          writeSessionEnd(this.opts.sessionId, result, extras);
        } catch { traceComplete = false; result = 'aborted'; }
      }
      const prev = readMeta(this.opts.sessionId);
      if (prev) {
        writeMeta(traceComplete
          ? { ...prev, session_end: { result, ended_at: Date.now() } }
          : { ...prev, error: 'network trace finalize failed' });
      }
      ports.closeServer();
      await ports.removeSocket();
      return result;
    } finally {
      this.dispose();
    }
  }

  /** bootstrap 阶段被 stop：只有 browser 资源与 early meta，不碰尚未构造的 owner。 */
  async recoverEarly(requested: SessionResult, session: CdpSession | null): Promise<SessionResult> {
    try { session?.close(); } catch { /* 已关闭 */ }
    await this.closeBrowserResources(this.browser);
    try { writeSessionEnd(this.opts.sessionId, 'aborted'); } catch { /* ignore */ }
    const meta = readMeta(this.opts.sessionId);
    if (meta) { try { writeMeta({ ...meta, session_end: { result: 'aborted', ended_at: Date.now() } }); } catch { /* ignore */ } }
    this.dispose();
    return requested === 'pass' ? 'aborted' : requested;
  }

  /** 停止已发起时等本次 cleanup 真正结束（协调入口早停分支用）。 */
  waitStopped(): Promise<SessionResult | undefined> {
    return this.stopPromise ?? Promise.resolve(undefined);
  }

  /** stop 之后才返回的迟到 bootstrap 结果：回收它自己的进程/目录/context。 */
  async reclaimLate(result: BootstrapResult): Promise<void> {
    try { result.session.close(); } catch { /* 已关闭 */ }
    await this.closeBrowserResources({
      tabId: result.tabId,
      ...(result.endpoint ? { browserEndpoint: result.endpoint } : {}),
      ...(result.browserContextId ? { browserContextId: result.browserContextId } : {}),
      ...(result.browserPid ? { browserPid: result.browserPid } : {}),
      ...(result.browserUserDataDir ? { browserUserDataDir: result.browserUserDataDir } : {}),
      owner: result.owner ?? null,
      ownedBrowserOwner: null,
    });
    try { writeSessionEnd(this.opts.sessionId, 'aborted'); } catch { /* ignore */ }
    this.dispose();
  }

  private async closeBrowserResources(browser: Readonly<BrowserResources>): Promise<void> {
    const meta = readMeta(this.opts.sessionId);
    const pid = browser.browserPid ?? meta?.browser_pid;
    const dir = browser.browserUserDataDir ?? meta?.browser_user_data_dir;
    const endpoint = browser.browserEndpoint ?? meta?.browser_endpoint;
    const contextId = browser.browserContextId ?? meta?.browser_context_id;
    try { browser.ownedBrowserOwner?.close(); } catch { /* 已关闭 */ }
    if (contextId && endpoint) {
      const connection = browser.owner ?? await openCdpSession(endpoint).catch(() => null);
      await connection?.send('Target.disposeBrowserContext', { browserContextId: contextId }).catch(() => {});
      if (connection !== browser.owner) connection?.close();
    } else if (browser.tabId && endpoint) {
      await closeTabIn(endpoint, browser.tabId).catch(() => {});
    }
    try { browser.owner?.close(); } catch { /* 已关闭 */ }
    if (pid) await killProcessGroup(pid, 3000).catch(() => {});
    if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
  }

  /** 终态判定：失败证据不可被终态覆盖；零断言仅代表未验证。 */
  private settle(result: SessionResult, traceComplete: boolean, summary: { total: number; pass: number }): { result: SessionResult; traceComplete: boolean; timeouts: number } {
    let timeouts = 0;
    let failedAction = false;
    let observationFailed = false;
    let captureFailed = false;
    if (traceComplete) {
      try {
        const events = readTraceEvents(this.opts.sessionId);
        if (!events.some((event) => event.t === 'session')) throw new Error('trace 缺 session 证据');
        for (const ev of events) {
          if (ev.t === 'assert' && ev.pass !== true) failedAction = true;
          if (ev.t !== 'action') {
            if (ev.t === 'observation' && (ev.result as { ok?: boolean } | undefined)?.ok !== true) observationFailed = true;
            if (ev.t === 'capture' && (ev.result as { ok?: boolean } | undefined)?.ok !== true) captureFailed = true;
            continue;
          }
          if ((ev.result as { ok?: boolean } | undefined)?.ok === false) failedAction = true;
          const settled = ev.settled_by;
          if (Array.isArray(settled) && settled.some((sb: { kind?: string }) => sb && sb.kind === 'timeout')) timeouts++;
        }
      } catch { traceComplete = false; result = 'aborted'; }
    }
    if (result === 'pass' && (failedAction || captureFailed || summary.pass < summary.total || timeouts > 0)) result = 'fail';
    if (result === 'pass' && summary.total === 0) result = 'blocked';
    if (result === 'pass' && observationFailed) result = 'blocked';
    return { result, traceComplete, timeouts };
  }
}
