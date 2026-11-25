import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { checkAuthFreshness } from '../browser/auth-check.js';

const NOW = 1_800_000_000; // 固定 now（2027 年），测试用相对偏移构造过期/有效
const tmp = (name: string) => path.join(os.tmpdir(), `auth-check-${process.pid}-${name}`);
const written: string[] = [];

type CookieItem = Record<string, unknown>;

/** 可注入的最小 cookie：name/value 字符串 + domain/path 来源（Playwright 注入要求） */
function writeState(name: string, cookies: CookieItem[], extra: Record<string, unknown> = {}): string {
  const p = tmp(name);
  fs.writeFileSync(p, JSON.stringify({ cookies: cookies.map((c) => ({ domain: '.example.test', path: '/', value: 'x', ...c })), origins: [], ...extra }));
  written.push(p);
  return p;
}

/** 写原始 JSON 文本（不经 writeState 的默认补齐） */
function writeRaw(name: string, text: string): string {
  const p = tmp(name);
  fs.writeFileSync(p, text);
  written.push(p);
  return p;
}

afterEach(() => {
  while (written.length) fs.rmSync(written.pop()!, { force: true });
});

describe('checkAuthFreshness（标准数据事实，无业务判据）', () => {
  it('文件不存在 → present=false, valid=false', () => {
    const f = checkAuthFreshness('/nonexistent/state.json', NOW);
    expect(f.present).toBe(false);
    expect(f.valid).toBe(false);
    expect(f.expired).toEqual([]);
    expect(f.reason).toContain('不存在');
  });

  it('解析失败 → present=true（文件存在）, valid=false，reason 固定不含原文', () => {
    const p = writeRaw('bad.json', '{nope');
    const f = checkAuthFreshness(p, NOW);
    expect(f.present).toBe(true);
    expect(f.valid).toBe(false);
    expect(f.reason).toContain('非合法 JSON');
    expect(f.reason).not.toContain('nope');
  });

  it('没有业务 cookie 的标准 state → valid=true（不因缺固定 cookie 拒）', () => {
    const p = writeState('no-critical.json', [{ name: 'SESSION_TOKEN_OTHER', expires: NOW + 3600 }]);
    const f = checkAuthFreshness(p, NOW);
    expect(f).toMatchObject({ present: true, valid: true, expired: [] });
  });

  it('空但显式提供的标准 state → valid=true，不称已认证', () => {
    const p = writeState('empty.json', []);
    const f = checkAuthFreshness(p, NOW);
    expect(f).toMatchObject({ present: true, valid: true, expired: [] });
  });

  it('空 name 仍接受（Chrome 语义）', () => {
    const p = writeState('empty-name.json', [{ name: '' }]);
    const f = checkAuthFreshness(p, NOW);
    expect(f.valid).toBe(true);
  });

  it('输入 cookie 到期 → expired 报名字（到期事实，不判登录）', () => {
    const p = writeState('expired.json', [
      { name: 'A', expires: NOW - 100 },
      { name: 'B', expires: NOW + 3600 },
    ]);
    const f = checkAuthFreshness(p, NOW);
    expect(f.valid).toBe(true);
    expect(f.expired).toEqual(['A']);
  });

  it('expires = -1（session 级）不算到期', () => {
    const p = writeState('session.json', [{ name: 'A', expires: -1 }]);
    expect(checkAuthFreshness(p, NOW).expired).toEqual([]);
  });

  it('expires 缺失不算到期', () => {
    const p = writeState('no-exp.json', [{ name: 'A' }]);
    expect(checkAuthFreshness(p, NOW).expired).toEqual([]);
  });

  it('恰好等于 now 视为到期（边界）', () => {
    const p = writeState('edge.json', [{ name: 'A', expires: NOW }]);
    expect(checkAuthFreshness(p, NOW).expired).toEqual(['A']);
  });

  it('CHIPS 同名多条（一条过期一条活）→ expired 只报事实名字一次', () => {
    const p = writeState('chips.json', [
      { name: 'A', domain: '.x.test', path: '/', expires: NOW - 100 },
      { name: 'A', domain: '.x.test', path: '/', expires: NOW + 100 },
      { name: 'B', expires: NOW - 50 },
    ]);
    const f = checkAuthFreshness(p, NOW);
    expect(f.expired).toEqual(['A', 'B']);
    expect(f.valid).toBe(true);
  });
});

describe('checkAuthFreshness 结构校验（Playwright 可注入性）', () => {
  it('顶层 JSON null → valid=false（不抛）', () => {
    const p = writeRaw('null.json', 'null');
    const f = checkAuthFreshness(p, NOW);
    expect(f).toMatchObject({ present: true, valid: false });
    expect(f.reason).toContain('顶层');
  });

  it('顶层原始字符串/数字 → valid=false', () => {
    expect(checkAuthFreshness(writeRaw('str.json', '"x"'), NOW).valid).toBe(false);
    expect(checkAuthFreshness(writeRaw('num.json', '42'), NOW).valid).toBe(false);
  });

  it('缺 cookies 数组 → valid=false', () => {
    const p = writeRaw('no-cookies.json', JSON.stringify({ foo: 1 }));
    const f = checkAuthFreshness(p, NOW);
    expect(f.valid).toBe(false);
    expect(f.reason).toContain('cookies 数组');
  });

  it('cookies 数组含 null → valid=false', () => {
    const p = writeRaw('null-item.json', JSON.stringify({ cookies: [null] }));
    expect(checkAuthFreshness(p, NOW).valid).toBe(false);
  });

  it('cookies 数组中间 null / 原始标量项 → valid=false', () => {
    const p = writeRaw('mid.json', JSON.stringify({ cookies: [{ name: 'A', value: 'v', domain: '.x.test' }, null, 1] }));
    expect(checkAuthFreshness(p, NOW).valid).toBe(false);
  });

  it('cookie 项是原始标量（1 / "x"）→ valid=false', () => {
    expect(checkAuthFreshness(writeRaw('scalar.json', JSON.stringify({ cookies: [1] })), NOW).valid).toBe(false);
    expect(checkAuthFreshness(writeRaw('scalar2.json', JSON.stringify({ cookies: ['x'] })), NOW).valid).toBe(false);
  });

  it('缺 value → valid=false（name/value 都必须是字符串）', () => {
    const p = writeRaw('no-value.json', JSON.stringify({ cookies: [{ name: 'A', domain: '.x.test' }] }));
    expect(checkAuthFreshness(p, NOW).valid).toBe(false);
  });

  it('缺 url 与 domain 来源 → valid=false（不可注入）', () => {
    const p = writeRaw('no-source.json', JSON.stringify({ cookies: [{ name: 'A', value: 'v' }] }));
    expect(checkAuthFreshness(p, NOW).valid).toBe(false);
  });

  it('有 url 无 domain → valid（合法 http(s) url 是注入源）', () => {
    const p = writeRaw('url.json', JSON.stringify({ cookies: [{ name: 'A', value: 'v', url: 'https://example.test/' }] }));
    expect(checkAuthFreshness(p, NOW).valid).toBe(true);
  });

  it('domain 无 path → invalid（domain 源要求非空 domain + 非空以 / 开始的 path）', () => {
    const p = writeRaw('dom-no-path.json', JSON.stringify({ cookies: [{ name: 'A', value: 'v', domain: '.example.test' }] }));
    expect(checkAuthFreshness(p, NOW).valid).toBe(false);
  });

  it('domain 空串 → invalid', () => {
    const p = writeRaw('dom-empty.json', JSON.stringify({ cookies: [{ name: 'A', value: 'v', domain: '', path: '/' }] }));
    expect(checkAuthFreshness(p, NOW).valid).toBe(false);
  });

  it('path 不以 / 开始 → invalid', () => {
    const p = writeRaw('path-no-slash.json', JSON.stringify({ cookies: [{ name: 'A', value: 'v', domain: '.example.test', path: 'x' }] }));
    expect(checkAuthFreshness(p, NOW).valid).toBe(false);
  });

  it('url 非法（not-a-url）→ invalid', () => {
    const p = writeRaw('url-bad.json', JSON.stringify({ cookies: [{ name: 'A', value: 'v', url: 'not-a-url' }] }));
    expect(checkAuthFreshness(p, NOW).valid).toBe(false);
  });

  it('url=about:blank → invalid（非 http(s) 注入源）', () => {
    const p = writeRaw('url-blank.json', JSON.stringify({ cookies: [{ name: 'A', value: 'v', url: 'about:blank' }] }));
    expect(checkAuthFreshness(p, NOW).valid).toBe(false);
  });

  it('url 与 domain/path 混用 → invalid（互斥）', () => {
    const p = writeRaw('mixed.json', JSON.stringify({ cookies: [{ name: 'A', value: 'v', url: 'https://example.test/', domain: '.example.test', path: '/' }] }));
    expect(checkAuthFreshness(p, NOW).valid).toBe(false);
  });

  it('sameSite 是数组/非字符串 → invalid（不靠 String() 转换蒙混）', () => {
    expect(checkAuthFreshness(writeRaw('ss-arr.json', JSON.stringify({ cookies: [{ name: 'A', value: 'v', domain: '.x.test', path: '/', sameSite: ['Strict'] }] })), NOW).valid).toBe(false);
    expect(checkAuthFreshness(writeRaw('ss-num.json', JSON.stringify({ cookies: [{ name: 'A', value: 'v', domain: '.x.test', path: '/', sameSite: 1 }] })), NOW).valid).toBe(false);
  });

  it('expires 字符串 → valid=false', () => {
    const p = writeState('str-exp.json', [{ name: 'A', expires: '123' }]);
    expect(checkAuthFreshness(p, NOW).valid).toBe(false);
  });

  it('expires 非有限（Infinity）→ valid=false', () => {
    const p = writeRaw('inf.json', JSON.stringify({ cookies: [{ name: 'A', value: 'v', domain: '.x.test', expires: 1e999 }] }));
    expect(checkAuthFreshness(p, NOW).valid).toBe(false);
  });

  it('expires 负数（非 -1）→ valid=false', () => {
    const p = writeState('neg.json', [{ name: 'A', expires: -5 }]);
    expect(checkAuthFreshness(p, NOW).valid).toBe(false);
  });

  it('httpOnly/secure 非布尔 → valid=false', () => {
    expect(checkAuthFreshness(writeState('bool.json', [{ name: 'A', httpOnly: 'yes' }]), NOW).valid).toBe(false);
    expect(checkAuthFreshness(writeState('bool2.json', [{ name: 'A', secure: 1 }]), NOW).valid).toBe(false);
  });

  it('sameSite 枚举外（unspecified/foo）→ valid=false', () => {
    expect(checkAuthFreshness(writeState('ss.json', [{ name: 'A', sameSite: 'unspecified' }]), NOW).valid).toBe(false);
    expect(checkAuthFreshness(writeState('ss2.json', [{ name: 'A', sameSite: 'Foo' }]), NOW).valid).toBe(false);
  });

  it('sameSite 标准枚举（Strict/Lax/None）→ valid', () => {
    for (const ss of ['Strict', 'Lax', 'None']) {
      expect(checkAuthFreshness(writeState(`ss-${ss}.json`, [{ name: 'A', sameSite: ss }]), NOW).valid).toBe(true);
    }
  });

  it('path 非字符串 → valid=false', () => {
    const p = writeRaw('bad-path.json', JSON.stringify({ cookies: [{ name: 'A', value: 'v', domain: '.x.test', path: 1 }] }));
    expect(checkAuthFreshness(p, NOW).valid).toBe(false);
  });

  it('origins 提供但非数组 → valid=false', () => {
    const p = writeRaw('bad-origins.json', JSON.stringify({ cookies: [], origins: 'nope' }));
    expect(checkAuthFreshness(p, NOW).valid).toBe(false);
  });

  it('origins 缺省省略 → valid', () => {
    const p = writeRaw('no-origins.json', JSON.stringify({ cookies: [{ name: 'A', value: 'v', domain: '.x.test', path: '/' }] }));
    expect(checkAuthFreshness(p, NOW).valid).toBe(true);
  });

  it('坏数据的 reason 是固定文案，不拼原文/内容', () => {
    const p = writeRaw('leak.json', JSON.stringify({ cookies: [{ name: 'A', value: 'SECRET_VALUE_xyz', domain: '.x.test' }, { name: 'B', value: 5 }] }));
    const f = checkAuthFreshness(p, NOW);
    expect(f.valid).toBe(false);
    expect(f.reason).not.toContain('SECRET_VALUE_xyz');
    expect(f.reason).toContain('不可注入');
  });
});
