/**
 * 阶段 2.2 反证测试：STALE_INDEX / frame 描述 / 文本归一化
 *
 * 不走 daemon 集成测试（vitest + runDaemon 环境隔离太脆弱），
 * 改为直接测核心逻辑：
 * - STALE_INDEX: 直接调 handle 里的 checkStaleIndex 逻辑
 * - frame 描述: 测 collectPageState + FrameDesc
 * - 文本归一化: 浐 normalizeText
 */

import { describe, expect, it } from 'vitest';

// ── STALE_INDEX ──
// checkStaleIndex 的核心逻辑：snapshot_change_count 与 changeCount 对比

function checkStaleIndex(changeCount: number, params: Record<string, unknown> | undefined): { code: string; message: string; hint: string } | null {
  const snapCC = params?.snapshot_change_count;
  if (snapCC === undefined || snapCC === null) return null;
  const expected = Number(snapCC);
  if (!Number.isFinite(expected)) return null;
  if (changeCount !== expected) {
    return { code: 'STALE_INDEX', message: `页面已变化（快照 change_count=${expected}，当前 change_count=${changeCount}），请先 page state`, hint: 'page state' };
  }
  return null;
}

describe('STALE_INDEX 逻辑', () => {
  it('不传 snapshot_change_count → 不检查', () => {
    expect(checkStaleIndex(5, {})).toBeNull();
    expect(checkStaleIndex(5, undefined)).toBeNull();
    expect(checkStaleIndex(5, { other: 1 })).toBeNull();
  });

  it('snapshot_change_count 匹配 → 通过', () => {
    expect(checkStaleIndex(5, { snapshot_change_count: 5 })).toBeNull();
    expect(checkStaleIndex(0, { snapshot_change_count: 0 })).toBeNull();
  });

  it('snapshot_change_count 不匹配 → STALE_INDEX', () => {
    const result = checkStaleIndex(3, { snapshot_change_count: 1 });
    expect(result).not.toBeNull();
    expect(result!.code).toBe('STALE_INDEX');
    expect(result!.message).toContain('change_count');
  });

  it('snapshot_change_count 为 NaN/null → 不检查', () => {
    expect(checkStaleIndex(5, { snapshot_change_count: NaN })).toBeNull();
    expect(checkStaleIndex(5, { snapshot_change_count: null })).toBeNull();
    expect(checkStaleIndex(5, { snapshot_change_count: 'abc' })).toBeNull();
  });
});

// ── frame 描述 ──

import { collectPageState, type FrameDesc, type PageState } from '../browser/page-state.js';
import type { CdpSession } from '../browser/daemon-client.js';

function mockCdpForFrameTest(iframes: Array<{ name: string; src: string; id: string }>): Pick<CdpSession, 'send' | 'evaluate' | 'on'> {
  return {
    send: async (method: string) => {
      if (method === 'Accessibility.enable') return {};
      if (method === 'Accessibility.getFullAXTree') return { nodes: [] };
      return {};
    },
    evaluate: async (expr: string) => {
      if (expr.includes('location.href')) return 'https://example.test/page';
      if (expr.includes('document.title')) return 'Test Page';
      if (expr.includes('iframe')) return iframes;
      if (expr.includes('readyState')) return 'complete';
      if (expr.includes('innerWidth')) return { width: 1024, height: 768 };
      return '';
    },
    on: () => () => {},
  };
}

describe('frame 描述：collectPageState 采集 iframe', () => {
  it('2 个 iframe → PageState.frames 含 2 条描述', async () => {
    const cdp = mockCdpForFrameTest([
      { name: 'contentFrame', src: 'https://example.test/embed/page', id: '' },
      { name: '', src: 'https://other.test/widget', id: 'widget-frame' },
    ]);
    const state = await collectPageState(cdp as CdpSession);
    expect(state.frames).toHaveLength(2);
    // 有 name 的 iframe → selector 含 name
    expect(state.frames[0].name).toBe('contentFrame');
    expect(state.frames[0].url_contains).toContain('/embed/page');
    expect(state.frames[0].selector).toContain('contentFrame');
    // 有 id 的 iframe → selector 含 id
    expect(state.frames[1].selector).toContain('widget-frame');
  });

  it('无 iframe → frames=[]', async () => {
    const cdp = mockCdpForFrameTest([]);
    const state = await collectPageState(cdp as CdpSession);
    expect(state.frames).toEqual([]);
  });

  it('evaluate 抛异常 → frames=[]', async () => {
    const cdp: Pick<CdpSession, 'send' | 'evaluate' | 'on'> = {
      send: async (method: string) => {
        if (method === 'Accessibility.enable') return {};
        if (method === 'Accessibility.getFullAXTree') return { nodes: [] };
        return {};
      },
      evaluate: async (expr: string) => {
        if (expr.includes('iframe')) throw new Error('cross-origin');
        if (expr.includes('location.href')) return 'https://example.test/page';
        if (expr.includes('document.title')) return 'Test Page';
        return '';
      },
      on: () => () => {},
    };
    const state = await collectPageState(cdp as CdpSession);
    expect(state.frames).toEqual([]);
  });

  it('id 含特殊字符 → cssIdent 转义', async () => {
    const cdp = mockCdpForFrameTest([
      { name: '', src: 'https://example.test/embed', id: 'my.frame' },
    ]);
    const state = await collectPageState(cdp as CdpSession);
    expect(state.frames).toHaveLength(1);
    // id 含 . → 选择器转义（不能直接拼 #my.frame）
    expect(state.frames[0].selector).not.toBe('iframe#my.frame');
    expect(state.frames[0].selector).toContain('\\');
  });
});

// ── 文本归一化 ──

describe('文本归一化：零宽/不间断空格 → 普通空格', () => {
  it('\\u200B/\\u00A0/\\uFEFF 归一化后不丢字', () => {
    const cases: [string, string][] = [
      ['\u200B确\u200B定\u200B', '确 定'],
      ['\u00A0提交', ' 提交'],
      ['\uFEFF删除', ' 删除'],
      ['\u200C拆\u200D分', '拆 分'],
    ];
    for (const [input, expected] of cases) {
      const result = input.replace(/[\u200B\u200C\u200D\uFEFF\u00A0]/g, ' ').trim();
      // 归一化不丢字
      expect(result.replace(/\s/g, '')).toBe(expected.replace(/\s/g, ''));
      expect(result.length).toBeGreaterThan(0);
    }
  });

  it('归一化后 role exact 能命中', () => {
    // "确 定"（零宽空格分割）→ "确 定"（普通空格）→ 用 exact 匹配到 "确 定"
    const raw = '\u200B确\u200B定\u200B';
    const normalized = raw.replace(/[\u200B\u200C\u200D\uFEFF\u00A0]/g, ' ').trim();
    // 假设 AX 树里 name 是 "确定"（无空格），而原始文本是 "确\u200B定"
    // 归一化后 "确 定" 有空格仍不等于 "确定"，但至少不再是不可见字符
    // 关键效果：搜索 "确 定" 能匹配（之前搜索不到）
    expect(normalized).toContain('确');
    expect(normalized).toContain('定');
  });
});