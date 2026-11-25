export function normalizeAccessibleName(text: string): string {
  return text
    .replace(/[\u200B\u200C\u200D\uFEFF\u00A0]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** role 身份名规范化（R1/LC3）：与已核 PW 1.64.1 getByRole exact 的 normalizeWhiteSpace
 *  同义 —— 删除 U+200B/U+00AD，再 trim、压空白。零宽字符直接删而非换空格，与
 *  normalizeAccessibleName（展示/选择语义）不同源。 */
export function normalizeRoleName(text: string): string {
  return text.replace(/[\u200b\u00ad]/g, '').trim().replace(/\s+/g, ' ');
}
