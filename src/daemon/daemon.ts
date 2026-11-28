/**
 * session daemon 进程入口（CLI 内部命令 `__daemon`）。
 *
 * runDaemon 只排流程：bootstrap → 会话事实 → owner 组装 → 页面/网络初始化 → target → socket → keepAlive。
 */
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { BrowserMode, CdpSession, TransportKind } from '../browser/daemon-client.js';
import type { CaptureMode } from '../browser/target-registry.js';
import type { AuthMode } from '../auth-resolve.js';
import { writeMeta, readMeta, traceDir, type SessionMeta } from './session-meta.js';
import { appendTraceEvent, cleanupExpiredTraces, redactText, writeSessionStart, writeSessionEnd } from './trace.js';
import { NetworkTrace } from './network-trace.js';
import { defaultBootstrap, type BootstrapResult } from './bootstrap.js';
import type { SessionResult } from './session-types.js';
import { SessionLifecycle, type CleanupPorts } from './lifecycle.js';
import { PageContext } from './page-context.js';
import { PageObservers } from './page-observers.js';
import { SessionValues } from './session-values.js';
import { ActionRunner } from './action-runner.js';
import { PageCommands } from './page-commands.js';
import { EvidenceCommands } from './evidence-commands.js';
import { TargetCoordinator } from './targets.js';
import { OBSERVER_SCRIPT } from './observer-script.js';
import { FlowRecorder } from './flow-recorder.js';
import { encodeLine, parseLine, type DaemonRequest, type DaemonResponse, type DaemonWaitStarted } from './protocol.js';
import { readPackageVersion } from '../package-version.js';
import { requestContext, releaseRequestInputs } from '../request-context.js';
import { AcceptanceInputError, readAcceptanceSnapshot } from '../report/acceptance.js';

export interface DaemonOptions {
  env: string;
  socketPath: string;
  authMode?: AuthMode;
  browserMode?: BrowserMode;
  browserBootstrap?: () => Promise<BootstrapResult>;
  exitOnStop?: boolean;
}

/** 组装后的 owner 引用（每个字段都是有限 owner，不是可写会话上下文）。 */
interface DaemonRuntime {
  readonly page: PageContext;
  readonly observers: PageObservers;
  readonly networkTrace: NetworkTrace;
  readonly values: SessionValues;
  readonly runner: ActionRunner;
  readonly evidence: EvidenceCommands;
  readonly targets: TargetCoordinator;
  readonly flow: FlowRecorder;
  readonly pageCommands: PageCommands;
}

export async function runDaemon(sessionId: string, opts: DaemonOptions): Promise<void> {
  try {
    const directory = process.env.E2ET_RUN_ACCEPTANCE_DIR;
    if (directory !== undefined && path.resolve(directory) !== path.resolve(traceDir(sessionId))) {
      throw new AcceptanceInputError('验收快照目录不属于本次 Source 会话');
    }
    const acceptance = directory === undefined ? undefined : readAcceptanceSnapshot(directory);
    if (directory !== undefined && !acceptance) throw new AcceptanceInputError('本次验收快照缺失');
    const cliSha256 = createHash('sha256').update(fs.readFileSync(process.argv[1])).digest('hex');
    writeMeta({ id: sessionId, pid: process.pid, socket: opts.socketPath, started_at: Date.now(), env: opts.env,
      cli_sha256: cliSha256,
      ...(acceptance ? { acceptance_sha256: acceptance.sha256, acceptance_frozen_at: acceptance.frozenAt } : {}),
    });
  } catch (error) {
    writeMeta({ id: sessionId, pid: process.pid, socket: opts.socketPath, started_at: Date.now(), env: opts.env,
      error: redactText(error instanceof Error ? error.message : String(error)),
      session_end: { result: 'aborted', ended_at: Date.now() },
    });
    throw error;
  }
  try { cleanupExpiredTraces(sessionId); } catch { /* TTL 清理失败不阻断当前会话 */ }

  let cleanupPorts: CleanupPorts | null = null;
  let bootstrapSession: CdpSession | null = null;
  const lifecycle: SessionLifecycle = new SessionLifecycle({
    sessionId,
    socketPath: opts.socketPath,
    exitOnStop: opts.exitOnStop,
    idleTimeoutMs: Number.isFinite(Number(process.env.E2ET_IDLE_TIMEOUT_MS)) && Number(process.env.E2ET_IDLE_TIMEOUT_MS) > 0
      ? Number(process.env.E2ET_IDLE_TIMEOUT_MS)
      : 30 * 60 * 1000,
    cleanup: (requested: SessionResult): Promise<SessionResult> => cleanupPorts
      ? lifecycle.finalize(requested, cleanupPorts)
      : lifecycle.recoverEarly(requested, bootstrapSession),
  });
  lifecycle.installSignals();
  const snap = () => lifecycle.snapshot();

  const bo = await bringUpBootstrap(sessionId, opts, lifecycle);
  if (!bo) return;
  bootstrapSession = bo.session;
  const transport: TransportKind = bo.browserSource === 'existing' ? 'native-cdp' : 'managed';
  if (!await publishSessionFacts(sessionId, opts, bo, transport, snap)) { await lifecycle.waitStopped(); return; }

  const runtime = assembleOwners(sessionId, bo.tabId, bo.session, {
    snapshot: snap,
    onAbort: () => { void lifecycle.stop('aborted', 10_000, false); },
  });
  let server: net.Server | null = null;
  cleanupPorts = buildCleanupPorts(opts, bo, runtime, () => server);
  const initState = await initializePageAndNetwork(sessionId, bo, runtime, snap, lifecycle);
  if (initState !== 'ok') {
    await lifecycle.waitStopped();
    if (initState === 'failed') throw new Error('网络监听初始化失败');
    return;
  }
  await armTargetsOrDegrade(sessionId, bo, runtime, lifecycle, snap);
  if (snap().stopped) { await lifecycle.waitStopped(); return; }

  server = net.createServer((socket) => {
    let buf = '';
    const inFlight = new Map<number, AbortController>();
    const cancel = (controller: AbortController): void => {
      controller.abort(Object.assign(new Error('请求已取消；执行结果未知，禁止自动重试'), { code: 'REQUEST_CANCELLED' }));
    };
    const cancelAll = (): void => { for (const controller of inFlight.values()) cancel(controller); };
    socket.on('error', cancelAll);
    socket.on('close', cancelAll);
    socket.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const msg = parseLine(line);
        if (!msg || typeof msg !== 'object' || !Number.isSafeInteger(msg.id)) continue;
        if ('cancel' in msg && msg.cancel === true) {
          const controller = inFlight.get(msg.id);
          if (controller) cancel(controller);
          continue;
        }
        if (!('method' in msg) || typeof msg.method !== 'string') continue;
        const req = msg as DaemonRequest;
        lifecycle.resetIdle();
        const controller = new AbortController();
        inFlight.set(req.id, controller);
        const onWaitStarted = (deadlineMs: number): void => {
          if (controller.signal.aborted || socket.destroyed) return;
          try { socket.write(encodeLine({ id: req.id, wait_deadline_ms: deadlineMs } satisfies DaemonWaitStarted)); } catch { /* socket 已断 */ }
        };
        const route = (r: DaemonRequest): Promise<DaemonResponse> => {
          if (r.method === 'stop') {
            if (runtime.networkTrace.isActionActive()) {
              return Promise.resolve({ id: r.id, ok: false, error: { code: 'BUSY', message: 'action 执行中，暂不能停止会话' } });
            }
            return lifecycle.stop('pass', 10_000, true).then((result) => ({ id: r.id, ok: true, data: { session_id: sessionId, result } }));
          }
          if (r.method.startsWith('page.')) return runtime.pageCommands.handle(r, onWaitStarted);
          if (r.method.startsWith('assert.') || r.method.startsWith('capture.') || r.method.startsWith('mock.')) {
            return runtime.evidence.handle(r);
          }
          return Promise.resolve({ id: r.id, ok: false, error: { code: 'UNKNOWN_METHOD', message: '未知方法: ' + r.method } });
        };
        // 分行解析不等待 route，取消控制行才能打断同一 buffer 中的长请求。
        void requestContext.run({ signal: controller.signal, onProgress: onWaitStarted, inputCleanups: new Map() }, async () => {
          let res: DaemonResponse;
          try {
            res = await route(req);
          } catch (e) {
            res = { id: req.id, ok: false, error: { code: 'DAEMON_ERROR', message: redactText((e as Error).message) } };
          } finally {
            if (!await releaseRequestInputs()) {
              appendTraceEvent(sessionId, { t: 'input_cleanup_error', error: 'INPUT_RELEASE_FAILED' });
            }
            inFlight.delete(req.id);
          }
          if (controller.signal.aborted) {
            res = { id: req.id, ok: false, error: { code: 'REQUEST_CANCELLED', message: controller.signal.reason.message, hint: '禁止自动重试，先检查会话状态和 trace' } };
          }
          if (socket.destroyed) return;
          try { socket.write(encodeLine(res), () => {}); } catch { /* socket 已 end：丢弃响应 */ }
          if (req.method === 'stop' && res.ok) {
            socket.end(() => {
              if (opts.exitOnStop !== false) process.exit(0);
              else lifecycle.exitAfterStopResponse();
            });
          }
        }).catch((e) => {
          console.error('❌ request cleanup:', e);
          inFlight.delete(req.id);
        });
      }
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(opts.socketPath, () => {
        server!.removeListener('error', reject);
        resolve();
      });
    });
  } catch (e) {
    writeMeta({ ...(readMeta(sessionId) ?? ({} as SessionMeta)), error: 'socket listen 失败: ' + redactText((e as Error).message) });
    await lifecycle.stop('aborted', 10_000, true);
    if (opts.exitOnStop !== false) process.exit(1);
    return;
  }

  if (snap().stopped) { await lifecycle.waitStopped(); return; }
  lifecycle.markRunning();
  await lifecycle.keepAlive();
}

/** bootstrap 启动与失败/迟到结果收口；返回 null 表示会话已被停止。 */
async function bringUpBootstrap(sessionId: string, opts: DaemonOptions, lifecycle: SessionLifecycle): Promise<BootstrapResult | null> {
  const bootstrap = opts.browserBootstrap ?? (() => defaultBootstrap(
    sessionId, opts.socketPath, opts.env, opts.authMode ?? 'auto', opts.browserMode ?? 'auto',
    (connection, contextId, endpoint) => lifecycle.onContext(connection, contextId, endpoint),
    {
      onSpawn: (pid, userDataDir) => {
        if (!lifecycle.onSpawn(pid, userDataDir)) throw new Error('bootstrap 已停止，中止启动');
        const previous = readMeta(sessionId) ?? ({} as SessionMeta);
        writeMeta({ ...previous, id: sessionId, pid: process.pid, socket: opts.socketPath, started_at: Date.now(), env: opts.env, browser_pid: pid, browser_user_data_dir: userDataDir, browser_endpoint: undefined });
      },
      isStopping: () => lifecycle.stopped,
    },
  ));
  let bo: BootstrapResult;
  try {
    bo = await bootstrap();
  } catch (error) {
    const prev: Partial<SessionMeta> = readMeta(sessionId) ?? {};
    // 停止后 bootstrap 才失败：保留已完成的 aborted 终态与原 started_at，不重建 running 事实。
    writeMeta({
      ...prev,
      id: sessionId, pid: process.pid, socket: opts.socketPath,
      started_at: prev.started_at ?? Date.now(), env: opts.env,
      error: redactText((error as Error).message),
      session_end: prev.session_end ?? { result: 'aborted', ended_at: Date.now() },
    });
    try {
      writeSessionStart({
        session_id: sessionId, env: opts.env, tool_version: readPackageVersion(),
        transport: prev.transport ?? 'managed',
        ...(prev.browser_source ? { browser_source: prev.browser_source } : {}),
        ...(prev.cli_sha256 ? { cli_sha256: prev.cli_sha256 } : {}),
        ...(prev.acceptance_sha256 ? { acceptance_sha256: prev.acceptance_sha256, acceptance_frozen_at: prev.acceptance_frozen_at } : {}),
      });
    } catch { /* ignore */ }
    if (!prev.session_end) writeSessionEnd(sessionId, 'aborted');
    lifecycle.dispose();
    process.exit(1);
  }
  if (lifecycle.adoptBootstrap(bo)) return bo;
  await lifecycle.reclaimLate(bo);
  if (opts.exitOnStop !== false) process.exit(0);
  lifecycle.exitAfterStopResponse();
  return null;
}

/** 写 meta/session trace（含 viewport）；停止后返回 false，不覆盖 aborted 事实。 */
async function publishSessionFacts(
  sessionId: string, opts: DaemonOptions, bo: BootstrapResult, transport: TransportKind,
  snap: () => { state: string; stopped: boolean },
): Promise<boolean> {
  const rawViewport = await bo.session.evaluate<unknown>(
    '({ width: window.innerWidth, height: window.innerHeight, deviceScaleFactor: window.devicePixelRatio })',
  ).catch(() => null);
  if (snap().stopped) return false;
  const viewport = rawViewport && typeof rawViewport === 'object'
    && Number.isFinite((rawViewport as { width?: number }).width) && Number.isFinite((rawViewport as { height?: number }).height)
    ? rawViewport as { width: number; height: number; deviceScaleFactor?: number }
    : undefined;
  const headless = bo.browserSource === 'managed' ? (process.env.E2ET_MANAGED_HEADLESS !== '0') : undefined;
  const startup = readMeta(sessionId);
  writeMeta({
    ...startup,
    id: sessionId, pid: process.pid, socket: opts.socketPath, tab_id: bo.tabId,
    browser_endpoint: bo.endpoint, browser_version: bo.browserVersion,
    ...(bo.browserPid ? { browser_pid: bo.browserPid } : {}),
    ...(bo.endpoint ? { browser_port: Number(new URL(bo.endpoint).port) } : {}),
    ...(bo.browserUserDataDir ? { browser_user_data_dir: bo.browserUserDataDir } : {}),
    ...(bo.browserContextId ? { browser_context_id: bo.browserContextId } : {}),
    transport, started_at: Date.now(), env: opts.env,
    ...(bo.authSource ? { auth_source: bo.authSource } : {}),
    ...(bo.browserSource ? { browser_source: bo.browserSource } : {}),
  });
  writeSessionStart({
    session_id: sessionId, env: opts.env, tool_version: readPackageVersion(), transport,
    browser_version: bo.browserVersion, headless,
    ...(startup?.cli_sha256 ? { cli_sha256: startup.cli_sha256 } : {}),
    ...(startup?.acceptance_sha256 ? { acceptance_sha256: startup.acceptance_sha256, acceptance_frozen_at: startup.acceptance_frozen_at } : {}),
    ...(viewport ? { viewport } : {}),
    ...(bo.authSource ? { auth_source: bo.authSource } : {}),
    ...(bo.browserSource ? { browser_source: bo.browserSource } : {}),
    ...(bo.browserContextId ? { browser_context_id: bo.browserContextId } : {}),
  });
  return true;
}

/** 纯 owner 组装：不安装监听、不启动异步操作。 */
function assembleOwners(
  sessionId: string, sourceTabId: string, sourceSession: CdpSession,
  lifecyclePorts: { snapshot: () => { state: 'starting' | 'running' | 'stopping'; stopped: boolean }; onAbort: () => void },
): DaemonRuntime {
  const holders: { trace: NetworkTrace | null; observers: PageObservers | null } = { trace: null, observers: null };
  const trace = new NetworkTrace(sessionId, sourceSession, sourceTabId);
  holders.trace = trace;
  let page!: PageContext;
  const flow = new FlowRecorder(sessionId, process.env, () => page.activeCdp(), () => lifecyclePorts.snapshot().stopped);
  const lazyTrace = () => holders.trace;
  const lazyObservers = () => holders.observers;
  page = new PageContext({
    sessionId, sourceTabId,
    networkTrace: lazyTrace,
    observers: lazyObservers,
    lifecycleSnapshot: lifecyclePorts.snapshot,
    onAbort: lifecyclePorts.onAbort,
    onActivePageChanged: () => flow.onActivePageChanged(),
    trace: (event) => { try { appendTraceEvent(sessionId, event); } catch { /* trace 已结束 */ } },
  });
  const observers = new PageObservers({
    sessionId, networkTrace: trace,
    currentPage: () => page.currentPage(),
    lifecycleSnapshot: lifecyclePorts.snapshot,
    activeTargetId: () => page.activeId() ?? sourceTabId,
  });
  holders.observers = observers;
  const values = new SessionValues();
  const runner = new ActionRunner({
    sessionId, page, observers: lazyObservers, networkTrace: lazyTrace, values,
    lifecycleSnapshot: lifecyclePorts.snapshot,
  });
  const evidence = new EvidenceCommands({
    sessionId, page, observers: lazyObservers, networkTrace: lazyTrace, values,
    lifecycleSnapshot: lifecyclePorts.snapshot,
    trace: (event) => { try { appendTraceEvent(sessionId, event); } catch { /* trace 已结束 */ } },
  });
  const targets = new TargetCoordinator({
    sessionId, page, observers: lazyObservers, networkTrace: lazyTrace,
    lifecycleSnapshot: lifecyclePorts.snapshot,
    installDialogHandler: (ws) => runner.installDialogHandler(ws),
    removeDialogHandler: (ws) => runner.removeDialogHandler(ws),
    trace: (event) => { try { appendTraceEvent(sessionId, event); } catch { /* trace 已结束 */ } },
  });
  const pageCommands = new PageCommands({
    sessionId, page, observers: lazyObservers, networkTrace: lazyTrace,
    lifecycleSnapshot: lifecyclePorts.snapshot, runner, flow,
    trace: (event) => { try { appendTraceEvent(sessionId, event); } catch { /* trace 已结束 */ } },
  });
  return { page, observers, networkTrace: trace, values, runner, evidence, targets, flow, pageCommands };
}

/** 有限清理端口（owner stop/dispose/summary + trace flush + server/socket）。 */
function buildCleanupPorts(
  opts: DaemonOptions, bo: BootstrapResult, runtime: DaemonRuntime, server: () => net.Server | null,
): CleanupPorts {
  return {
    stopOwners: async () => {
      let ok = true;
      await runtime.flow.stop();
      runtime.runner.clearDialogHandlers();
      try { await runtime.page.clearHover(); } catch { ok = false; }
      await runtime.evidence.dispose();
      await runtime.targets.stop();
      for (const popup of runtime.page.popups()) { try { popup.pageWs?.close(); } catch { /* 已关闭 */ } }
      return ok;
    },
    flushTrace: async () => { await runtime.networkTrace.flush(); },
    closePage: () => { try { (runtime.page.activeCdp() ?? bo.session).close(); } catch { /* 已关闭 */ } },
    summary: () => ({ ...runtime.evidence.summary(), mocked: runtime.evidence.hasMocked() }),
    closeServer: () => { try { server()?.close(); } catch { /* ignore */ } },
    removeSocket: async () => { try { await fs.promises.unlink(opts.socketPath); } catch { /* ignore */ } },
  };
}

/** 按原顺序装 trace/Page/Network/registry；失败统一 aborted 收尾。 */
async function initializePageAndNetwork(
  sessionId: string, bo: BootstrapResult, runtime: DaemonRuntime,
  snap: () => { state: string; stopped: boolean }, lifecycle: SessionLifecycle,
): Promise<'ok' | 'stopped' | 'failed'> {
  const { page, networkTrace, runner } = runtime;
  try {
    networkTrace.install();
    runner.installDialogHandler(bo.session);
    await bo.session.send('Page.enable');
    if (snap().stopped) return 'stopped';
    await networkTrace.initialize(bo.tabId).catch(() => {});
    if (snap().stopped) return 'stopped';
    await bo.session.send('Page.addScriptToEvaluateOnNewDocument', { source: OBSERVER_SCRIPT }).catch(() => {});
    if (snap().stopped) return 'stopped';
    page.initRegistry();
    const isOwned = bo.browserSource === 'managed' || bo.browserSource === 'chrome-profile';
    const captureMode: CaptureMode = isOwned ? 'owned_paused' : 'existing_late';
    page.registerSource(bo.session, { ...(bo.browserContextId ? { contextId: bo.browserContextId } : {}), captureMode });
    page.setActivePageWs(bo.tabId);
    await networkTrace.enable();
    if (snap().stopped) return 'stopped';
    await bo.session.evaluate(OBSERVER_SCRIPT).catch(() => {});
    if (snap().stopped) return 'stopped';
    bo.session.onClose(() => page.handleTargetClosed(bo.tabId, 'source_ws_close'));
    return 'ok';
  } catch (error) {
    try { writeMeta({ ...(readMeta(sessionId) ?? ({} as SessionMeta)), error: '网络监听初始化失败: ' + redactText((error as Error).message) }); } catch { /* cleanup 继续 */ }
    await lifecycle.stop('aborted', 10_000, true);
    if (lifecycle.exitOnStop !== false) process.exit(1);
    return 'failed';
  }
}

/** popup 接管失败不杀会话（降级单 tab），保持原降级行为。 */
async function armTargetsOrDegrade(
  sessionId: string, bo: BootstrapResult, runtime: DaemonRuntime, lifecycle: SessionLifecycle,
  snap: () => { state: string; stopped: boolean },
): Promise<void> {
  try {
    await runtime.targets.arm({
      sourceSession: bo.session, sourceTabId: bo.tabId, endpoint: bo.endpoint,
      browserSource: bo.browserSource, browserContextId: bo.browserContextId, lifecycle,
    });
  } catch (error) {
    try { appendTraceEvent(sessionId, { t: 'target_owner_init_failed', error: redactText((error as Error).message) }); } catch { /* ignore */ }
    try { writeMeta({ ...(readMeta(sessionId) ?? ({} as SessionMeta)), error: 'popup 接管降级（单 tab 可用）: ' + redactText((error as Error).message) }); } catch { /* ignore */ }
    await runtime.targets.stop();
  }
  if (snap().stopped) await lifecycle.waitStopped();
}
