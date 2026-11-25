import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { dispatch } from '../cli/router.js';
import type { RouterDeps } from '../cli/context.js';
import { authStatePath, defaultAuthStatePath } from '../browser/managed-browser.js';

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'review-fix-'));
const ENV: NodeJS.ProcessEnv = { ...process.env, E2ET_HOME: TMP_HOME };
afterAll(() => fs.rmSync(TMP_HOME, { recursive: true, force: true }));

function capture(overrides: Partial<RouterDeps> = {}): { stdout: string[]; stderr: string[]; deps: RouterDeps } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout, stderr,
    deps: {
      env: ENV,
      homeDir: TMP_HOME,
      stdout: (s: string) => stdout.push(s),
      stderr: (s: string) => stderr.push(s),
      ...overrides,
    },
  };
}
function envelope(stdout: string[]): any { return JSON.parse(stdout.join('')); }

describe('doctor managed mode: no CDP_URL → auth fail exit3', () => {
  it('无 CPД_URL 且 auth stale → exit3, not warn', async () => {
    const c = capture();
    const deps = { ...c.deps, env: { ...ENV, E2ET_AUTH_STATE: '/nonexistent/state.json' } };
    const code = await dispatch(['doctor'], deps);
    expect(code).toBe(3);
    const out = envelope(c.stdout);
    expect(out.ok).toBe(false);
    expect(out.error?.code).toBe('ENV_UNAVAILABLE');
    const authCheck = out.checks?.find((c: any) => c.name === 'auth');
    expect(authCheck?.status).toBe('fail');
  });

  it('有 CDP_URL 但不可达且 auth stale → 不存在可用组合，auth fail', async () => {
    const c = capture();
    const deps = { ...c.deps, env: { ...ENV, E2ET_CDP_URL: 'http://fake:9999', E2ET_AUTH_STATE: '/nonexistent/state.json' } };
    const code = await dispatch(['doctor'], deps);
    // 端点不可达会降级；仍无可用登录态则失败。
    const out = envelope(c.stdout);
    const authCheck = out.checks?.find((c: any) => c.name === 'auth');
    expect(code).toBe(3);
    expect(authCheck?.status).toBe('fail');
  });
});

describe('authStatePath respects E2ET_HOME', () => {
  it('默认路径在 E2ET_HOME 下，不写真 HOME', () => {
    const p = defaultAuthStatePath(ENV);
    expect(p).toContain(TMP_HOME);
    expect(p).not.toContain(os.homedir() + '/.e2et');
    expect(p).toBe(path.join(TMP_HOME, 'auth', 'imported.json'));
  });

  it('E2ET_AUTH_STATE 覆盖优先', () => {
    const p = authStatePath({ ...ENV, E2ET_AUTH_STATE: '/custom/path.json' });
    expect(p).toBe('/custom/path.json');
  });
});
