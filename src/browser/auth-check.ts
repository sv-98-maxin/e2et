/**
 * storageState 标准状态事实读取。
 *
 * 只报告标准数据事实：路径是否存在、能否按 Playwright 可注入的 storageState
 * 结构解析、输入 cookie 的到期事实。不判断业务登录是否有效 —— 登录有效性
 * 属于调用方基于真实导航结果的断言，CLI 不依据特定 cookie 名/数量推断。
 * session 级 expires=-1 不算到期。
 *
 * 结构校验对齐 Playwright 注入合同（playwright-core rewriteCookies/SetNetworkCookie）：
 * name/value 必须字符串；cookie 要么提供合法 http(s) url（且不得与 domain/path 混用），
 * 要么提供非空 domain + 非空以 / 开始的 path；expires/httpOnly/secure/sameSite 可选
 * 但类型必须对（expires 有限且 -1 或非负；sameSite ∈ Strict|Lax|None）；origins 若提供
 * 必须是数组且逐条为标准 StorageOrigin（规范化 http(s) origin + localStorage 键值）。
 * 空 name 仍接受（Chrome 语义）；空 cookies 数组是显式提供的合法 state。
 * 坏数据返回固定 reason，不拼解析原文/内容。
 */
import * as fs from 'node:fs';
import { validateStorageState } from '../shared/auth-state.js';

export { validateStorageState } from '../shared/auth-state.js';

export interface AuthFreshness {
  /** 路径存在 */
  present: boolean;
  /** 可按 Playwright 可注入的 storageState 结构解析 */
  valid: boolean;
  /** 已到期的输入 cookie 名（expires>0 且 <= now；同名多条只报一次） */
  expired: string[];
  /** 文件不存在/结构不合法的固定原因（不含原文/内容） */
  reason?: string;
}

interface StorageStateCookie {
  name?: unknown;
  value?: unknown;
  domain?: unknown;
  path?: unknown;
  url?: unknown;
  expires?: unknown;
  httpOnly?: unknown;
  secure?: unknown;
  sameSite?: unknown;
  partitionKey?: unknown;
  _crHasCrossSiteAncestor?: unknown;
}

/**
 * 读取 storageState 文件的标准状态事实。nowSec 可注入便于测试。
 * Playwright storageState 的 expires 单位是秒（Unix epoch），-1 = session 级。
 */
export function checkAuthFreshness(authStatePath: string, nowSec = Math.floor(Date.now() / 1000)): AuthFreshness {
  if (!fs.existsSync(authStatePath)) {
    return { present: false, valid: false, expired: [], reason: `文件不存在: ${authStatePath}` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(authStatePath, 'utf-8'));
  } catch {
    return { present: true, valid: false, expired: [], reason: '解析失败: 非合法 JSON' };
  }
  const reason = validateStorageState(raw);
  if (reason) {
    return { present: true, valid: false, expired: [], reason };
  }
  const cookies = (raw as { cookies: StorageStateCookie[] }).cookies;
  const expired: string[] = [];
  for (const c of cookies) {
    const name = c.name as string;
    const e = c.expires;
    if (typeof e === 'number' && e > 0 && e <= nowSec && !expired.includes(name)) expired.push(name);
  }
  return { present: true, valid: true, expired };
}
