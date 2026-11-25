/**
 * 共源模板逻辑：校验与渲染。
 * 唯一维护源，src/shared 和 runtime_assets 由 sync 脚本镜像。
 *
 * 单次 render 所有 random/rand6 共同一个六位数字、ts/date 同一时间快照。
 * 不同 step 不缓存复用（调用方每次调用 renderTemplate 即是独立快照）。
 */
export function isValidTemplate(template: string): boolean {
  const placeholders = [...template.matchAll(/\$\{([^}]*)\}/g)];
  return placeholders.length > 0 && placeholders.every((match) => /^(ts|rand6|random|date:YYYY-MM-DD)$/.test(match[1]))
    && !template.replace(/\$\{[^}]*\}/g, '').includes('${');
}

export function renderTemplate(template: string): string {
  if (!isValidTemplate(template)) throw new Error('template 含不支持的占位符或缺生成占位符');
  const now = new Date();
  // 每次 render 同一个六位随机数
  const random = String(Math.floor(Math.random() * 1e6)).padStart(6, '0');
  const date = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
  const ts = String(Math.floor(now.getTime() / 1000));
  return template.replace(/\$\{([^}]*)\}/g, (match, placeholder: string) =>
    placeholder === 'ts' ? ts
      : placeholder === 'date:YYYY-MM-DD' ? date
      : random  // rand6 和 random 共同一个六位数字
  );
}
