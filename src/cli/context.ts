import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { packageRoot } from '../package-version.js';
import { readMeta } from '../daemon/session-meta.js';
import { DaemonClient } from '../daemon/client.js';
import type { AuthMode } from '../auth-resolve.js';
import type { BrowserMode } from '../browser/daemon-client.js';
import { exportCookiesFromProfile, loginProfileAndInstall } from '../browser/profile-browser.js';
import { discoverChromeProfiles, importChromeProfile } from '../browser/chrome-auth.js';
import { runPlaywright } from '../cases/replay.js';

export const EXIT_OK = 0;
export const EXIT_VALIDATION = 1;
export const EXIT_USAGE = 2;
export const EXIT_ENV = 3;

export interface RouterDeps {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  spawner?: (sessionId: string, env: string, socketPath: string, cliPath: string, authMode: AuthMode, browserMode: BrowserMode, childEnv?: NodeJS.ProcessEnv) => ChildProcess | void;
  readyWaiter?: (socketPath: string, id: string, timeoutMs: number) => Promise<{ ready: boolean; error?: string }>;
  cliPath?: string;
  readStdin?: () => Promise<string>;
  exportCookiesFromProfile?: typeof exportCookiesFromProfile;
  discoverChromeProfiles?: typeof discoverChromeProfiles;
  importChromeProfile?: typeof importChromeProfile;
  loginProfileAndInstall?: typeof loginProfileAndInstall;
  platform?: NodeJS.Platform;
  playwrightRunner?: (deps: RouterDeps, cliPackageRoot: string, testFile: string, testTimeoutMs?: number) => Promise<number>;
  cwd?: string;
}

export type Deps = Required<RouterDeps>;

async function defaultPlaywrightRunner(deps: RouterDeps, cliPackageRoot: string, testFile: string, testTimeoutMs = 30_000): Promise<number> {
  return runPlaywright(deps.env ?? process.env, cliPackageRoot, testFile, testTimeoutMs, (text) => (deps.stderr ?? console.error)(text));
}

export function emitOk(d: Deps, data: unknown): number {
  d.stdout(JSON.stringify({ ok: true, data }));
  return EXIT_OK;
}

export function emitError(d: Deps, code: string, message: string, hint?: string, exit = EXIT_VALIDATION, evidence?: Record<string, string>): number {
  d.stdout(JSON.stringify({ ok: false, error: { code, message, ...(hint ? { hint } : {}), ...(evidence ? { evidence } : {}) } }));
  return exit;
}

export function diag(d: Deps, msg: string): void {
  d.stderr(msg);
}

export function resolveDefaults(deps?: RouterDeps): Deps {
  return {
    env: deps?.env ?? process.env,
    homeDir: deps?.homeDir ?? os.homedir(),
    stdout: deps?.stdout ?? ((s: string) => console.log(s)),
    stderr: deps?.stderr ?? ((s: string) => console.error(s)),
    spawner: deps?.spawner ?? defaultSpawner,
    readyWaiter: deps?.readyWaiter ?? defaultReadyWaiter,
    cliPath: deps?.cliPath ?? '',
    readStdin: deps?.readStdin ?? defaultReadStdin,
    exportCookiesFromProfile: deps?.exportCookiesFromProfile ?? exportCookiesFromProfile,
    discoverChromeProfiles: deps?.discoverChromeProfiles ?? discoverChromeProfiles,
    importChromeProfile: deps?.importChromeProfile ?? importChromeProfile,
    loginProfileAndInstall: deps?.loginProfileAndInstall ?? loginProfileAndInstall,
    platform: deps?.platform ?? process.platform,
    playwrightRunner: deps?.playwrightRunner ?? defaultPlaywrightRunner,
    cwd: deps?.cwd ?? process.cwd(),
  };
}

export function cliDistPath(): string {
  const root = packageRoot();
  return path.join(root ?? process.cwd(), 'dist', 'cli.js');
}

function defaultSpawner(
  sessionId: string,
  env: string,
  socketPath: string,
  cliPath: string,
  authMode: AuthMode,
  browserMode: BrowserMode,
  childEnv: NodeJS.ProcessEnv = process.env,
): ChildProcess {
  const child = spawn(process.execPath, [cliPath, '__daemon', sessionId, '--env', env, '--socket', socketPath, '--auth', authMode, '--browser', browserMode], {
    detached: true,
    stdio: ['ignore', 'ignore', fs.openSync(path.join(path.dirname(socketPath), 'daemon.log'), 'a')],
    env: { ...childEnv, E2ET_DAEMON: '1' },
  });
  child.unref();
  return child;
}

async function defaultReadyWaiter(socketPath: string, id: string, timeoutMs: number): Promise<{ ready: boolean; error?: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const meta = readMeta(id);
    if (meta?.error) return { ready: false, error: meta.error };
    const ok = await DaemonClient.ping(socketPath, 1000);
    if (ok) return { ready: true };
    await new Promise((r) => setTimeout(r, 250));
  }
  return { ready: false, error: 'daemon 启动超时（30s 内 socket 未就绪）' };
}

export function defaultReadStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
    if (process.stdin.isTTY) {
      process.stderr.write('从 stdin 读取（Ctrl+D 结束）:\n');
    }
  });
}
