/** 应用操作结构化返回；CLI 负责把 kind 映射为原退出码并剥除该字段。 */
export type OperationResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; hint?: string; kind: 'usage' | 'validation' | 'environment' } };
