import { createHash } from 'node:crypto';

export interface CookieLike {
  name?: string;
  value?: string;
  domain?: string;
  path?: string;
  url?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None' | string;
  partitionKey?: string;
  _crHasCrossSiteAncestor?: boolean;
}

export interface StorageOriginEntry {
  name: string;
  value: string;
}

export interface StorageOrigin {
  origin: string;
  localStorage: StorageOriginEntry[];
}

export interface AuthSummary {
  cookies: number;
  domains: { domain: string; count: number }[];
  sha8: string;
  cookieFacts: Array<{
    name: string;
    domain?: string;
    path?: string;
    expires?: number;
    expired: boolean;
  }>;
}

const SAMESITE_VALUES = new Set(['Strict', 'Lax', 'None']);

function isCanonicalHttpOrigin(origin: unknown): origin is string {
  if (typeof origin !== 'string' || origin.length === 0) return false;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.origin === origin;
  } catch {
    return false;
  }
}

function isNonEmptyUnsupported(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function isValidStorageOriginEntry(entry: unknown): boolean {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const origin = entry as Record<string, unknown>;
  for (const key of Object.keys(origin)) {
    if (key !== 'origin' && key !== 'localStorage' && isNonEmptyUnsupported(origin[key])) return false;
  }
  if (!isCanonicalHttpOrigin(origin.origin) || !Array.isArray(origin.localStorage)) return false;
  return origin.localStorage.every((item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return false;
    const entry = item as { name?: unknown; value?: unknown };
    return typeof entry.name === 'string' && typeof entry.value === 'string';
  });
}

function isLegalUrlSource(url: unknown): boolean {
  if (typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname.length > 0;
  } catch {
    return false;
  }
}

function isInjectableCookie(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const cookie = value as CookieLike;
  if (typeof cookie.name !== 'string' || typeof cookie.value !== 'string') return false;
  const hasUrl = cookie.url !== undefined;
  const hasDomain = cookie.domain !== undefined;
  const hasPath = cookie.path !== undefined;
  if (hasUrl) {
    if (!isLegalUrlSource(cookie.url) || hasDomain || hasPath) return false;
  } else if (hasDomain) {
    if (typeof cookie.domain !== 'string' || cookie.domain.length === 0) return false;
    if (typeof cookie.path !== 'string' || !cookie.path.startsWith('/')) return false;
  } else {
    return false;
  }
  if (cookie.expires !== undefined) {
    if (typeof cookie.expires !== 'number' || !Number.isFinite(cookie.expires)
      || (cookie.expires !== -1 && cookie.expires < 0)) return false;
  }
  if (cookie.httpOnly !== undefined && typeof cookie.httpOnly !== 'boolean') return false;
  if (cookie.secure !== undefined && typeof cookie.secure !== 'boolean') return false;
  if (cookie.sameSite !== undefined
    && (typeof cookie.sameSite !== 'string' || !SAMESITE_VALUES.has(cookie.sameSite))) return false;
  if (cookie.partitionKey !== undefined && !isCanonicalHttpOrigin(cookie.partitionKey)) return false;
  if (cookie._crHasCrossSiteAncestor !== undefined && typeof cookie._crHasCrossSiteAncestor !== 'boolean') return false;
  return true;
}

export function validateStorageState(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return '不是标准 storageState（顶层不是对象）';
  }
  const state = value as Record<string, unknown>;
  if (!Array.isArray(state.cookies)) {
    return '不是标准 storageState（缺 cookies 数组）';
  }
  for (const key of Object.keys(state)) {
    if (key !== 'cookies' && key !== 'origins' && isNonEmptyUnsupported(state[key])) {
      return '不是标准 storageState（含未支持的非空状态字段；当前仅支持标准 cookies/origins）';
    }
  }
  if (state.origins !== undefined && !Array.isArray(state.origins)) {
    return '不是标准 storageState（origins 不是数组）';
  }
  if (state.origins !== undefined && !(state.origins as unknown[]).every(isValidStorageOriginEntry)) {
    return '不是标准 storageState（origins 含非法项：需规范化 http(s) origin + localStorage 数组且 name/value 为字符串）';
  }
  if (!state.cookies.every(isInjectableCookie)) {
    return '不是标准 storageState（cookies 含不可注入项：需 name/value 字符串 + 合法 url 或非空 domain+path，可选字段类型正确）';
  }
  return undefined;
}

export function buildAuthSummary(
  cookies: CookieLike[],
  serialized: string,
  nowSec = Math.floor(Date.now() / 1000),
): AuthSummary {
  const byDomain = new Map<string, number>();
  for (const cookie of cookies) {
    const domain = cookie.domain || '(no-domain)';
    byDomain.set(domain, (byDomain.get(domain) ?? 0) + 1);
  }
  return {
    cookies: cookies.length,
    domains: [...byDomain].map(([domain, count]) => ({ domain, count })),
    sha8: createHash('sha256').update(serialized).digest('hex').slice(0, 8),
    cookieFacts: cookies.map((cookie) => ({
      name: String(cookie.name ?? ''),
      ...(cookie.domain !== undefined ? { domain: cookie.domain } : {}),
      ...(cookie.path !== undefined ? { path: cookie.path } : {}),
      ...(cookie.expires !== undefined ? { expires: cookie.expires } : {}),
      expired: typeof cookie.expires === 'number' && cookie.expires > 0 && cookie.expires <= nowSec,
    })),
  };
}
