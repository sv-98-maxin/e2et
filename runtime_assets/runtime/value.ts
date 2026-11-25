/**
/* Value 求值：literal / template / ref / from_action */
import type { Value } from './types.js';
import { renderTemplate } from './shared/template.js';

export interface ValueContext {
  resolve(v: Value): string;
  set(name: string, val: string): void;
  setActionValue(stepId: string, val: string): void;
  variables: Map<string, string>;
}

export function createValueContext(): ValueContext {
  const variables = new Map<string, string>();
  const actionValues = new Map<string, string>();

  function resolve(v: Value): string {
    if ('literal' in v) return String(v.literal);
    if ('template' in v) return renderTemplate(v.template);
    if ('ref' in v) {
      const val = variables.get(v.ref);
      if (val === undefined) throw new Error(`变量引用不存在: ${v.ref}`);
      return val;
    }
    if ('from_action' in v) {
      const val = actionValues.get(v.from_action);
      if (val === undefined) throw new Error(`历史动作值不存在: ${v.from_action}`);
      return val;
    }
    throw new Error(`unknown value type: ${JSON.stringify(v)}`);
  }

  function set(name: string, val: string): void {
    variables.set(name, val);
  }

  function setActionValue(stepId: string, val: string): void {
    actionValues.set(stepId, val);
  }

  return { resolve, set, setActionValue, variables };
}
