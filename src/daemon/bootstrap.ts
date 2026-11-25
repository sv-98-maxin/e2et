/**
 * daemon bootstrap：浏览器候选选择、启动与登录态探测。
 * 从 daemon.ts 迁移，保留原 6 参数 + 可选第 7 参数 hooks。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createTabIn, CdpSession, type BrowserMode, type TransportKind } from '../browser/daemon-client.js';
import { resolveChromiumExecutable, resolveSystemChrome, launchChromium, killProcessGroup, openCdpSession, loadAuthState, injectAndProbeInSession, confirmOwnerClosed, type CdpLowSession } from '../browser/managed-browser.js';
import { launchProfileAndProbe, profileMasterPath, cleanupProfileCopy } from '../browser/profile-browser.js';
import { resolveAndProbeAuth, resolveSessionCandidates, AuthResolveError, type AuthMode, type AuthSource, type BrowserSource, type ProfileProbeFn } from '../auth-resolve.js';
import { writeMeta, readMeta } from './session-meta.js';

export interface BootstrapResult {
  tabId: string;
  session: CdpSession;
  /** 浏览器端点（existing: discovery 地址；自起浏览器: launched.baseUrl） */
  endpoint: string;
  browserVersion?: string;
  /** managed 模式：本会话独占的浏览器进程信息（收尾用） */
  browserPid?: number;
  browserUserDataDir?: string;
  /** 登录态来源 */
  authSource?: AuthSource;
  /** 浏览器来源：managed / existing */
  browserSource: BrowserSource;
  browserContextId?: string;
  owner?: CdpLowSession;
}

/** owner 断链无法确认时抛出——禁止降级，auto 也必须终止（cookie 泄漏风险）。 */
export class OwnerDisconnectError extends Error {
  constructor(contextId: string, cause: Error) {
    super(`owner 断链无法确认，拒绝降级（context=${contextId}）`, { cause });
    this.name = 'OwnerDisconnectError';
  }
}

export interface BootstrapHooks {
  onSpawn: (pid: number, userDataDir: string) => void;
  isStopping: () => boolean;
}

export async function defaultBootstrap(
  sessionId: string,
  socketPath: string,
  env: string,
  authMode: AuthMode = 'auto',
  browserMode: BrowserMode = 'auto',
  onContext?: (owner: CdpLowSession | null, contextId: string, endpoint: string) => void,
  hooks?: BootstrapHooks,
): Promise<BootstrapResult> {
  const ensureNotStopping = (): void => {
    if (hooks?.isStopping()) throw new Error('bootstrap 已停止，中止启动');
  };
  const candidates = await resolveSessionCandidates(browserMode, authMode);
  let lastError: Error | undefined;
  for (const candidate of candidates) {
    ensureNotStopping();
    const choice = candidate.browser;
    const transport: TransportKind = choice.kind === 'existing' ? 'native-cdp' : 'managed';
    if (candidate.unavailable || candidate.valid.length === 0) {
      const candidateError = candidate.unavailable ? new Error(candidate.unavailable) : new AuthResolveError(candidate.failures);
      if (browserMode !== 'auto' || authMode !== 'auto') {
        writeMeta({ ...readMeta(sessionId), id: sessionId, pid: process.pid, socket: socketPath, started_at: Date.now(), env,
          transport, browser_source: choice.kind === 'chrome' ? 'chrome-profile' : choice.kind });
        throw candidateError;
      }
      lastError ??= candidateError;
      continue;
    }
    writeMeta({ ...readMeta(sessionId), id: sessionId, pid: process.pid, socket: socketPath, started_at: Date.now(), env,
      transport, browser_source: choice.kind === 'chrome' ? 'chrome-profile' : choice.kind,
      browser_endpoint: undefined, browser_context_id: undefined, tab_id: undefined });
    try {
      if (choice.kind === 'existing') {
        writeMeta({ ...readMeta(sessionId)!, browser_endpoint: choice.endpoint });
        let owner: CdpLowSession | null = null;
        let contextId: string | undefined;
        let targetId: string | undefined;
        try {
          owner = await openCdpSession(choice.endpoint);
          ensureNotStopping();
          ({ browserContextId: contextId } = await owner.send<{ browserContextId: string }>('Target.createBrowserContext', { disposeOnDetach: true }));
          ensureNotStopping();
          if (!contextId) throw new Error('CDP 未返回 browserContextId，拒绝创建默认 context 标签页');
          writeMeta({ ...readMeta(sessionId)!, browser_context_id: contextId });
          onContext?.(owner, contextId, choice.endpoint);
          ({ targetId } = await owner.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank', browserContextId: contextId }));
          ensureNotStopping();
          if (!targetId) throw new Error('CDP 未返回 targetId');
          writeMeta({ ...readMeta(sessionId)!, tab_id: targetId });
          const { sessionId: targetSessionId } = await owner.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
          ensureNotStopping();
          await owner.send('Security.setIgnoreCertificateErrors', { ignore: true }, targetSessionId);
          const resolved = await resolveAndProbeAuth({ baseUrl: choice.endpoint, authMode, cdpUrl: choice.endpoint, profileAllowed: false,
            profileProbe: async () => { throw new Error('existing 不支持 profile'); },
            probeAuth: (authPath) => injectAndProbeInSession(owner!, targetSessionId, loadAuthState(authPath)) });
          ensureNotStopping();
          const session = await CdpSession.connect(targetId, choice.endpoint);
          ensureNotStopping();
          return { tabId: targetId, session, owner, browserContextId: contextId, endpoint: choice.endpoint,
            browserVersion: choice.version, authSource: resolved.authSource, browserSource: 'existing' };
        } catch (error) {
          if (owner && contextId) {
            const disposed = await owner.send('Target.disposeBrowserContext', { browserContextId: contextId })
              .then(() => true).catch(() => false);
            if (!disposed) {
              const confirmed = await confirmOwnerClosed(owner, 2000);
              if (!confirmed) {
                const previous = readMeta(sessionId);
                if (previous) writeMeta({ ...previous, cleanup_blocked: true, cleanup_reason: 'owner_disconnect_unconfirmed' });
                onContext?.(null, contextId, choice.endpoint);
                throw new OwnerDisconnectError(contextId, error as Error);
              }
            } else {
              try { owner.close(); } catch { /* context 已销毁，断开 owner 连接 */ }
            }
          } else {
            if (contextId) await owner?.send('Target.disposeBrowserContext', { browserContextId: contextId }).catch(() => {});
            try { owner?.close(); } catch { /* disposeOnDetach 依赖连接断开 */ }
          }
          const previous = readMeta(sessionId);
          if (previous?.browser_source === 'existing' && previous.browser_endpoint === choice.endpoint
            && (previous.browser_context_id === contextId || (contextId !== undefined && previous.browser_context_id === undefined))
            && (previous.tab_id === targetId || (targetId !== undefined && previous.tab_id === undefined))) {
            writeMeta({ ...previous, browser_context_id: undefined, browser_endpoint: undefined, tab_id: undefined });
          }
          if (contextId) onContext?.(null, contextId, choice.endpoint);
          throw error;
        }
      }
      let profileResult: Awaited<ReturnType<ProfileProbeFn>>;
      const profileProbe: ProfileProbeFn = async () => profileResult;
      if (choice.kind === 'chrome') {
        const masterDir = profileMasterPath(process.env);
        const clearProfileMeta = (h: { pid: number; baseUrl: string; userDataDir: string }) => {
          const previous = readMeta(sessionId);
          if (previous?.browser_pid === h.pid && previous.browser_user_data_dir === h.userDataDir) {
            writeMeta({ ...previous, browser_pid: undefined, browser_user_data_dir: undefined, browser_endpoint: undefined });
          }
        };
        const r = await launchProfileAndProbe(resolveSystemChrome()!, masterDir, sessionId, process.env, (h) => {
          writeMeta({
            ...readMeta(sessionId),
            id: sessionId,
            pid: process.pid,
            socket: socketPath,
            browser_endpoint: h.baseUrl,
            browser_pid: h.pid,
            browser_user_data_dir: h.userDataDir,
            transport,
            started_at: Date.now(),
            env,
          });
        }, clearProfileMeta, hooks?.onSpawn);
        if (hooks?.isStopping()) {
          if (r.handle) {
            await killProcessGroup(r.handle.pid, 3000).catch(() => {});
            cleanupProfileCopy(r.handle.userDataDir);
            clearProfileMeta(r.handle);
          }
          throw new Error('bootstrap 已停止，中止启动');
        }
        if (r.handle) {
          try {
            ensureNotStopping();
            const tab = await createTabIn(r.handle.baseUrl, 'about:blank');
            ensureNotStopping();
            const session = await CdpSession.connect(tab.id, r.handle.baseUrl);
            ensureNotStopping();
            const browserVersion = await fetchBrowserVersion(r.handle.baseUrl);
            ensureNotStopping();
            return {
              tabId: tab.id,
              session,
              endpoint: r.handle.baseUrl,
              browserVersion,
              browserPid: r.handle.pid,
              browserUserDataDir: r.handle.userDataDir,
              authSource: 'profile',
              browserSource: 'chrome-profile',
            };
          } catch (e) {
            await killProcessGroup(r.handle.pid, 3000).catch(() => {});
            cleanupProfileCopy(r.handle.userDataDir);
            clearProfileMeta(r.handle);
            throw e;
          }
        }
        profileResult = r.result;
        await resolveAndProbeAuth({ baseUrl: '', authMode: 'profile', profileProbe, cdpUrl: null });
        throw new Error('profile 探测失败但 resolveAndProbeAuth 未抛错（不可达）');
      }

      const executable = resolveChromiumExecutable()!;
      const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `e2et-${sessionId}-`));
      let launched: import('../browser/managed-browser.js').LaunchedChromium | null = null;
      try {
        launched = hooks
          ? await launchChromium(executable, userDataDir, process.env, {
            onSpawn: (pid) => {
              hooks.onSpawn(pid, userDataDir);
              writeMeta({ ...readMeta(sessionId)!, browser_pid: pid, browser_user_data_dir: userDataDir, browser_endpoint: undefined });
            },
          })
          : await launchChromium(executable, userDataDir);
        ensureNotStopping();
        writeMeta({
          id: sessionId,
          pid: process.pid,
          socket: socketPath,
          browser_endpoint: launched.baseUrl,
          browser_pid: launched.pid,
          browser_user_data_dir: userDataDir,
          transport,
          browser_source: 'managed',
          started_at: Date.now(),
          env,
        });
        const resolved = await resolveAndProbeAuth({ baseUrl: launched.baseUrl, authMode, profileProbe, cdpUrl: null, profileAllowed: false });
        ensureNotStopping();
        const tab = await createTabIn(launched.baseUrl, 'about:blank');
        ensureNotStopping();
        const session = await CdpSession.connect(tab.id, launched.baseUrl);
        ensureNotStopping();
        const browserVersion = await fetchBrowserVersion(launched.baseUrl);
        ensureNotStopping();
        launched.child.unref?.();
        launched.child.stderr?.removeAllListeners();
        launched.child.stderr?.destroy();
        return {
          tabId: tab.id,
          session,
          endpoint: launched.baseUrl,
          browserVersion,
          browserPid: launched.pid,
          browserUserDataDir: userDataDir,
          authSource: resolved.authSource,
          browserSource: 'managed',
        };
      } catch (e) {
        if (launched) {
          await killProcessGroup(launched.pid, 3000).catch(() => {});
        }
        try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
        const previous = readMeta(sessionId);
        if (launched && previous?.browser_pid === launched.pid && previous.browser_user_data_dir === userDataDir) {
          writeMeta({ ...previous, browser_pid: undefined, browser_user_data_dir: undefined, browser_endpoint: undefined, tab_id: undefined });
        }
        throw e;
      }
    } catch (error) {
      lastError = error as Error;
      if (hooks?.isStopping()) throw error;
      if (error instanceof OwnerDisconnectError) throw error;
      if (browserMode !== 'auto' || authMode !== 'auto') throw error;
    }
  }
  throw lastError ?? new Error('没有可用的浏览器与登录态组合');
}

/** 拉 /json/version 取浏览器版本，超时/失败返回 undefined。 */
export async function fetchBrowserVersion(baseUrl: string): Promise<string | undefined> {
  try {
    const v = await fetch(`${baseUrl}/json/version`, { signal: AbortSignal.timeout(3000) }).then(r => r.json()) as { Browser?: string };
    return v.Browser;
  } catch { /* ignore */ }
  return undefined;
}
