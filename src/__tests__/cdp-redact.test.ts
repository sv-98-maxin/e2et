import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { dispatch } from '../cli/router.js';
import type { RouterDeps } from '../cli/context.js';
import { writeMeta, sessionsDir, resolveSocketPath, type SessionMeta } from '../daemon/session-meta.js';

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-redact-'));
const ENV: NodeJS.ProcessEnv = { ...process.env, E2ET_HOME: TMP_HOME };
beforeAll(() => fs.mkdirSync(sessionsDir(ENV), { recursive: true }));
afterAll(() => fs.rmSync(TMP_HOME, { recursive: true, force: true }));

const SENTINEL_USER = 'sentinel_user:secret_pass';
const SENTINEL_QUERY = 'token=sentinel_query_token';
const SENTINEL_PATH = '/sentinel-path-token';

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

describe('CDP endpoint 凭据不回显', () => {
  const cdpUrlWithCreds = `http://${SENTINEL_USER}@cdp.example.com:9222${SENTINEL_PATH}?${SENTINEL_QUERY}`;

  it('setup 输出的 cdp_url 只有 origin/host/port，无 userinfo/query/path', async () => {
    const c = capture();
    const deps = { ...c.deps, env: { ...ENV, E2ET_CDP_URL: cdpUrlWithCreds } };
    const code = await dispatch(['setup'], deps);
    expect(code).not.toBe(2);
    const out = envelope(c.stdout);
    const cdp = out.data?.cdp_url;
    expect(cdp).toBe('http://cdp.example.com:9222');
    expect(cdp).not.toContain(SENTINEL_USER);
    expect(cdp).not.toContain(SENTINEL_QUERY);
    expect(cdp).not.toContain(SENTINEL_PATH);
  });

  it('session list 输出的 browser_endpoint 脱敏', async () => {
    const id = 's_test1';
    const meta: SessionMeta = {
      id, pid: 999999, socket: resolveSocketPath(id, ENV),
      started_at: Date.now(), env: 'pre',
      browser_endpoint: cdpUrlWithCreds,
    };
    writeMeta(meta, ENV);
    const c = capture();
    const code = await dispatch(['session', 'list'], c.deps);
    expect(code).toBe(0);
    const out = envelope(c.stdout);
    const sessions = out.data?.sessions as any[];
    const ep = sessions.find((s) => s.id === id)?.browser_endpoint;
    expect(ep).toBe('http://cdp.example.com:9222');
    expect(ep).not.toContain(SENTINEL_USER);
    expect(ep).not.toContain(SENTINEL_QUERY);
  });

  it('meta 文件权限 0600', () => {
    const id = 's_perm1';
    const meta: SessionMeta = {
      id, pid: 999999, socket: resolveSocketPath(id, ENV),
      started_at: Date.now(), env: 'pre',
      browser_endpoint: cdpUrlWithCreds,
    };
    writeMeta(meta, ENV);
    const stat = fs.statSync(path.join(sessionsDir(ENV), `${id}.json`));
    // 0600 = 0o100600, mask to lower 12 bits
    expect(stat.mode & 0o777).toBe(0o600);
  });
});
