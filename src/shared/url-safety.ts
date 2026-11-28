/**
 * 共源 URL/文本来源安全规则：redactText / redactUrl / redactUrlWithEvidence。
 * 唯一维护源，src/shared 与 runtime_assets 由 sync 脚本镜像；trace.ts 仅转发/调用。
 * 不扩词表、不新造第二套 URL 算法；判定依据是实际替换事实，不是敏感词扫描。
 */

export const REDACTED = '[REDACTED]';

const SENSITIVE_KEY = /(?:cookie|token|authorization|password|passwd|pwd|secret|session|sessid|xsrf|csrf|api[-_ ]?key|access[-_ ]?key|credential)/i;

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key.replace(/[^a-z0-9_-]/gi, ''));
}

function redactPlainText(value: string): string {
  const key = '[a-z0-9_-]*(?:cookie|token|authorization|password|passwd|pwd|secret|session|sessid|xsrf|csrf|api[-_ ]?key|access[-_ ]?key|credential)[a-z0-9_-]*';
  return value
    .replace(/(bearer\s+)[^\s,;]+/gi, '$1' + REDACTED)
    .replace(new RegExp('([?&]' + key + '=)[^&#\\s]*', 'gi'), '$1' + REDACTED)
    .replace(new RegExp('(\\b' + key + '\\b\\s*[\\"\\\']?\\s*[:=]\\s*)(?:\\"[^\\"]*\\"|\\\'[^\\\']*\\\'|(?:\\[REDACTED\\]|[^\\r\\n&,;}\\]])+)', 'gi'), '$1' + REDACTED);
}

export function redactText(value: string): string {
  return redactPlainText(value.replace(/https?:\/\/[^\s"'<>]+/gi, (url) => redactUrl(url)));
}

/** URL 来源安全：返回实际替换事实 + 处理后的值。
 *  userinfo 实际存在 → 清除；query 值/hash 命中现有来源规则且真的改写 → 替换；
 *  没有任何实际替换时返回 raw 原串（不因规范化/编码差异改写业务 URL）。 */
export function redactUrlWithEvidence(raw: string): { value: string; redacted: boolean } {
  try {
    const url = new URL(raw);
    let redacted = false;
    if (url.username || url.password) { redacted = true; url.username = ''; url.password = ''; }
    for (const [key, value] of [...url.searchParams.entries()]) {
      const replaced = isSensitiveKey(key) ? REDACTED : redactPlainText(value);
      if (replaced !== value) { url.searchParams.set(key, replaced); redacted = true; }
    }
    if (url.hash) {
      const scrubbed = redactText(url.hash);
      if (scrubbed !== url.hash) { url.hash = scrubbed; redacted = true; }
    }
    return { value: redacted ? url.toString() : raw, redacted };
  } catch { return { value: raw, redacted: false }; }
}

/** redactUrl 与 redactUrlWithEvidence 同源：只返回其实际处理值，不保留旧版（不清 userinfo、总格式化）行为 */
export function redactUrl(raw: string): string {
  return redactUrlWithEvidence(raw).value;
}
