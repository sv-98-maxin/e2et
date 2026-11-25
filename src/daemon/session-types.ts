/**
 * 跨 daemon owner 使用的共享类型与常量。
 * 不放可写状态或业务算法。
 */
import type { ActionValue } from './network-trace.js';
import type { RequestContext } from '../request-context.js';

import type { CdpLowSession } from '../browser/managed-browser.js';

// ── 会话终态 ──
export type SessionResult = 'pass' | 'fail' | 'blocked' | 'aborted';

// ── 变量条目 ──
export interface SessionVar {
  value: string;
  origin: 'literal' | 'generated' | 'captured';
}

// ── Dialog 策略 ──
export interface DialogPolicy {
  actionId: string;
  accept: boolean;
  promptText?: string;
  pending: Promise<void>[];
  handlingFailed: boolean;
  requestContext?: RequestContext;
}

// ── assert 期望来源解析结果 ──
export type AssertValueSourceResult =
  | { ok: true; value: string | undefined; meta: (ActionValue & { source_action?: string }) | undefined }
  | { ok: false; error: { code: string; message: string; hint?: string } };

// ── assert 方法 → 失败事件 kind ──
export const ASSERT_KIND_BY_METHOD: Record<string, string> = {
  'assert.api': 'api',
  'assert.request': 'request',
  'assert.toast': 'toast',
  'assert.text': 'text',
  'assert.visible': 'visible',
  'assert.absent': 'absent',
  'assert.table_row': 'table_row',
  'assert.field': 'field_value',
  'assert.url': 'url',
};

// ── 生命周期快照 ──
export interface LifecycleSnapshot {
  state: 'starting' | 'running' | 'stopping';
  stopped: boolean;
}

// ── 浏览器资源 ──
export interface BrowserResources {
  tabId: string | null;
  browserPid?: number;
  browserEndpoint?: string;
  browserUserDataDir?: string;
  browserContextId?: string;
  owner: CdpLowSession | null;
  ownedBrowserOwner: CdpLowSession | null;
}

// ── OOPIF frame 提示 ──
export interface OopifFrameHint {
  frameId: string;
  name: string;
  url: string;
}
