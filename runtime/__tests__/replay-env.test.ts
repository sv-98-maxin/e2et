import { describe, expect, it } from 'vitest';
import { resolveReplaySelection, ReplaySelectionError } from '../shared/replay-env.js';

const noCapabilities = { profileAvailable: false, existingAvailable: false };
const allCapabilities = { profileAvailable: true, existingAvailable: true };
const profileOnlyCapabilities = { profileAvailable: true, existingAvailable: false };

describe('resolveReplaySelection', () => {
  it('默认 auto 无 profile/existing 时选 imported+managed', () => {
    expect(resolveReplaySelection({}, {}, noCapabilities)).toEqual({
      auth: 'imported',
      browser: 'managed',
    });
  });

  it('auto 优先 profile+chrome', () => {
    expect(resolveReplaySelection({}, {}, allCapabilities)).toEqual({
      auth: 'profile',
      browser: 'chrome',
    });
  });

  it('有效 state 配 auto 强制 imported，即使 profile 可用也不先试 profile', () => {
    expect(resolveReplaySelection(
      { authState: '/tmp/state.json' },
      { E2ET_REPLAY_AUTH: 'auto' },
      profileOnlyCapabilities,
    )).toEqual({
      auth: 'imported',
      browser: 'managed',
      authState: '/tmp/state.json',
    });
  });

  it.each([
    ['profile', { E2ET_REPLAY_AUTH: 'profile' }],
    ['供应商旧值', { E2ET_REPLAY_AUTH: 'vendor' }],
  ])('同次显式 state 覆盖继承 auth=%s', (_name, env) => {
    expect(resolveReplaySelection(
      { authState: '/tmp/state.json' },
      env,
      profileOnlyCapabilities,
    )).toEqual({
      auth: 'imported',
      browser: 'managed',
      authState: '/tmp/state.json',
    });
  });

  it('显式 profile 清除继承 state 配置', () => {
    expect(resolveReplaySelection(
      { auth: 'profile' },
      { E2ET_AUTH_STATE: '/tmp/inherited.json' },
      allCapabilities,
    )).toEqual({
      auth: 'profile',
      browser: 'chrome',
    });
  });

  it('显式 chrome 清除继承 state 配置', () => {
    expect(resolveReplaySelection(
      { browser: 'chrome' },
      { E2ET_AUTH_STATE: '/tmp/inherited.json' },
      allCapabilities,
    )).toEqual({
      auth: 'profile',
      browser: 'chrome',
    });
  });

  it('CLI 参数覆盖继承的非法值，覆盖值不参与校验', () => {
    expect(resolveReplaySelection(
      { auth: 'imported', browser: 'managed' },
      { E2ET_REPLAY_AUTH: 'inherited-bad', E2ET_REPLAY_BROWSER: '' },
      noCapabilities,
    )).toEqual({
      auth: 'imported',
      browser: 'managed',
    });
  });

  it.each([
    ['auth 空字符串', {}, { E2ET_REPLAY_AUTH: '' }, /auth 枚举不合法/],
    ['browser 空字符串', {}, { E2ET_REPLAY_BROWSER: '' }, /browser 枚举不合法/],
    ['auth 非法枚举', { auth: 'vendor' }, {}, /auth 枚举不合法/],
    ['browser 非法枚举', { browser: 'vendor' }, {}, /browser 枚举不合法/],
    ['profile+managed', { auth: 'profile', browser: 'managed' }, {}, /不能配 auth profile/],
    ['profile+existing', { auth: 'profile', browser: 'existing' }, {}, /不能配 auth profile/],
    ['chrome+imported', { auth: 'imported', browser: 'chrome' }, {}, /只能配 auth profile\|auto/],
    ['显式 state+profile', { auth: 'profile', authState: '/tmp/state.json' }, {}, /不能与 profile\/chrome 模式混用/],
    ['显式 state+chrome', { browser: 'chrome', authState: '/tmp/state.json' }, {}, /不能与 profile\/chrome 模式混用/],
    ['state 空字符串', {}, { E2ET_AUTH_STATE: '   ' }, /E2ET_AUTH_STATE 是空字符串/],
  ])('%s 在浏览器启动前拒绝', (_name, input, env, pattern) => {
    expect(() => resolveReplaySelection(input, env, allCapabilities)).toThrow(ReplaySelectionError);
    expect(() => resolveReplaySelection(input, env, allCapabilities)).toThrow(pattern);
  });
});
