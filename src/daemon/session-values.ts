/**
 * 会话级变量与已完成动作值 owner。
 * 私有持有 sessionVars、completedActionValues 和 parseAssertValueSource。
 * 不暴露 Map，只通过方法读写。
 */
import type { ActionValue } from './network-trace.js';
import type { SessionVar, AssertValueSourceResult } from './session-types.js';

export class SessionValues {
  private readonly sessionVars = new Map<string, SessionVar>();
  private readonly completedActionValues = new Map<string, ActionValue & { source_action: string }>();

  /** 读取变量值（只读访问，不暴露 Map 引用） */
  getVar(name: string): string | undefined {
    return this.sessionVars.get(name)?.value;
  }

  /** 读取变量完整条目 */
  getVarEntry(name: string): SessionVar | undefined {
    return this.sessionVars.get(name);
  }

  /** 写入变量 */
  setVar(name: string, entry: SessionVar): void {
    this.sessionVars.set(name, entry);
  }

  /** 变量是否存在 */
  hasVar(name: string): boolean {
    return this.sessionVars.has(name);
  }

  /** 读取已完成动作值 */
  getCompletedActionValue(actionId: string): (ActionValue & { source_action: string }) | undefined {
    return this.completedActionValues.get(actionId);
  }

  /** 发布 capture 值（capture 成功时调用） */
  publishCapture(actionId: string, value: ActionValue): void {
    this.completedActionValues.set(actionId, { ...value, source_action: actionId });
  }

  /** 发布成功动作值（只有 wait 成功的动作才登记） */
  publishActionValue(actionId: string, value: ActionValue): void {
    this.completedActionValues.set(actionId, { ...value, source_action: actionId });
  }

  /** assert 期望来源解析：value / --value-ref / --value-from-action 互斥，恰好选一个 */
  parseAssertValueSource(
    params: Record<string, unknown> | undefined,
    requireValue = false,
  ): AssertValueSourceResult {
    const valueRef = params?.value_ref !== undefined ? String(params.value_ref) : undefined;
    const fromActionId = params?.value_from_action !== undefined ? String(params.value_from_action) : undefined;
    if (params?.value_ref !== undefined && !valueRef) {
      return { ok: false, error: { code: 'BAD_REQUEST', message: '--value-ref 变量名为空' } };
    }
    if (params?.value_from_action !== undefined && !fromActionId) {
      return { ok: false, error: { code: 'BAD_REQUEST', message: '--value-from-action 动作 id 为空' } };
    }
    const hasValue = params?.value !== undefined;
    const flags = (valueRef ? 1 : 0) + (fromActionId ? 1 : 0) + (hasValue ? 1 : 0);
    if (flags > 1) {
      return { ok: false, error: { code: 'BAD_REQUEST', message: 'value / --value-ref / --value-from-action 必须恰好提供一个' } };
    }
    if (flags === 0) {
      if (requireValue) {
        return { ok: false, error: { code: 'BAD_REQUEST', message: '缺期望值：value、--value-ref、--value-from-action 恰好选一个（value 可为空串）' } };
      }
      return { ok: true, value: undefined, meta: undefined };
    }
    if (valueRef) {
      const v = this.sessionVars.get(valueRef);
      if (v === undefined) {
        return { ok: false, error: { code: 'BAD_REQUEST', message: '未定义的变量引用: ' + valueRef, hint: '前序步骤需 --save-as' } };
      }
      return { ok: true, value: v.value, meta: { raw: v.value, origin: 'captured', ref: valueRef } };
    }
    if (fromActionId) {
      const av = this.completedActionValues.get(fromActionId);
      if (!av) {
        return { ok: false, error: { code: 'BAD_REQUEST', message: '引用的动作不存在/未成功完成/无可引用输入值: ' + fromActionId, hint: '只有 open/type/fill/select/date 的成功动作可引用' } };
      }
      return {
        ok: true,
        value: av.raw,
        meta: { raw: av.raw, origin: av.origin, ...(av.template !== undefined ? { template: av.template } : {}), ...(av.ref !== undefined ? { ref: av.ref } : {}), source_action: fromActionId },
      };
    }
    return { ok: true, value: String(params?.value), meta: undefined };
  }


  /** 迭代所有变量条目（只读快照，不暴露 Map 引用） */
  allVars(): IterableIterator<SessionVar> {
    return this.sessionVars.values();
  }
}
