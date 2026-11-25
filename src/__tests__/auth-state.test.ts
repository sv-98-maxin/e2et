import { describe, expect, it } from 'vitest';
import { buildAuthSummary, type AuthSummary, type CookieLike } from '../shared/auth-state.js';

const NOW = 1_800_000_000;
const SECRET_VALUES = ['SECRET_SESSION_VALUE_123', 'SECRET_XSRF_VALUE_456', 'SECRET_BIG_COOKIE_VALUE'];

function cookie(name: string, domain = '.example.test', expires = NOW + 3600): CookieLike {
  return { name, value: `SECRET_${name}_VALUE`, domain, path: '/', expires };
}

const VALID_COOKIES = [cookie('SESSION_A'), cookie('SESSION_B'), cookie('OTHER')];

function expectNoSecret(text: string): void {
  for (const secret of SECRET_VALUES) expect(text).not.toContain(secret);
  expect(text).not.toMatch(/"value"\s*:\s*"[^"]*SECRET/i);
}

describe('shared buildAuthSummary', () => {
  it('摘要只含条数/domain 计数/sha8/每条 cookie 事实，不含任何 value', () => {
    const serialized = JSON.stringify({ cookies: VALID_COOKIES });
    const summary: AuthSummary = buildAuthSummary(VALID_COOKIES, serialized, NOW);
    expect(summary.cookies).toBe(3);
    expect(summary.sha8).toHaveLength(8);
    expect(summary.domains.some((domain) => domain.domain === '.example.test')).toBe(true);
    expect(summary.cookieFacts).toHaveLength(3);
    const fact = summary.cookieFacts.find((item) => item.name === 'SESSION_A');
    expect(fact).toMatchObject({ domain: '.example.test', path: '/', expired: false });
    expect(fact?.expires).toBe(NOW + 3600);
    expectNoSecret(JSON.stringify(summary));
  });

  it('到期 cookie 记录 expired=true，不生成 critical 清单', () => {
    const cookies = [cookie('A', '.example.test', NOW - 100), cookie('B')];
    const summary = buildAuthSummary(cookies, JSON.stringify({ cookies }), NOW);
    expect(summary.cookieFacts.find((item) => item.name === 'A')?.expired).toBe(true);
    expect(summary.cookieFacts.find((item) => item.name === 'B')?.expired).toBe(false);
    expect(JSON.stringify(summary)).not.toContain('critical');
  });

  it('sha8 对同值稳定，对异值不同', () => {
    const first = buildAuthSummary(VALID_COOKIES, 'same');
    const second = buildAuthSummary(VALID_COOKIES, 'same');
    const third = buildAuthSummary(VALID_COOKIES, 'different');
    expect(first.sha8).toBe(second.sha8);
    expect(first.sha8).not.toBe(third.sha8);
  });
});
