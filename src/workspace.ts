/**
 * Workspace 准备（CLI-only）：只准备托管目录、探测 Chrome/CDP。
 * 不查旧 AUTH_STATE / USER_NAME / PASSWORD，不报 missing_credentials。
 * 认证检查由 doctor 独立做，不混入 setup。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { e2etRoot } from './daemon/session-meta.js';
import { resolveChromiumExecutable } from './browser/managed-browser.js';

export type Blocker = 'missing_browser';

export interface WorkspaceSetupResult {
  workspace: string;
  browser: 'system-chrome' | 'bundled-chromium' | 'native-cdp' | 'none';
  cdp_url: string | null;
  blockers: Blocker[];
}

export function ensureWorkspace(env: NodeJS.ProcessEnv = process.env): WorkspaceSetupResult {
  const workspace = path.join(e2etRoot(env), 'workspace');
  fs.mkdirSync(workspace, { recursive: true });

  const cdpUrl = env.E2ET_CDP_URL ?? null;
  const browser: WorkspaceSetupResult['browser'] = cdpUrl
    ? 'native-cdp'
    : (resolveChromiumExecutable(env) ? 'system-chrome' : 'none');

  const blockers: Blocker[] = browser === 'none' ? ['missing_browser'] : [];

  return { workspace, browser, cdp_url: cdpUrl, blockers };
}

export function blockerHints(blockers: Blocker[]): string[] {
  const hints: Record<Blocker, string> = {
    missing_browser:
      'No system Chrome found. Set CHROME_EXECUTABLE_PATH or E2ET_CDP_URL, or install Chrome.',
  };
  return blockers.map((b) => hints[b]);
}
