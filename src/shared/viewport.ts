/** 截图与回放固定台式视口：真实 Chrome 窗口会被侧栏/屏幕裁窄，页面按窄视口排版会把右侧表单裁掉。
 *  E2ET_VIEWPORT=<宽>x<高> 覆盖，默认 1440x900。 */
export const DEFAULT_VIEWPORT = { width: 1440, height: 900 } as const;

export function resolveViewport(env: NodeJS.ProcessEnv = process.env): { width: number; height: number } {
  const raw = env.E2ET_VIEWPORT?.trim();
  if (!raw) return { ...DEFAULT_VIEWPORT };
  const matched = /^([1-9]\d{1,4})x([1-9]\d{1,4})$/i.exec(raw);
  if (matched) return { width: Number(matched[1]), height: Number(matched[2]) };
  throw new Error(`E2ET_VIEWPORT 格式错误: "${raw}"，应为 <宽>x<高>，如 1600x1000`);
}
