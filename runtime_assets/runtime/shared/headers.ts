import { REDACTED, isSensitiveKey, redactText, redactUrl } from './url-safety.js';

const URL_HEADER_KEYS = new Set(['location', 'referer', 'referrer']);

function redactHeaderValue(key: string, value: string): string {
  if (isSensitiveKey(key)) return REDACTED;
  return URL_HEADER_KEYS.has(key.toLowerCase()) ? redactUrl(value) : redactText(value);
}

export function redactHeaders(headers: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (typeof value !== 'string') continue;
    out[key.toLowerCase()] = redactHeaderValue(key, value);
  }
  return out;
}

/** 实际被改写的响应头（小写名）；用于拒绝把脱敏值当可回放证据。 */
export function redactedHeaderKeys(
  original: Record<string, unknown> | undefined,
  redacted: Record<string, string>,
): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(original ?? {})) {
    if (typeof value !== 'string') continue;
    const lower = key.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(redacted, lower) && redacted[lower] !== value) out.push(lower);
  }
  return out;
}
