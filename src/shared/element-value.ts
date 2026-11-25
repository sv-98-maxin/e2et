export const AUTH_DATA_NOT_REPLAYABLE = 'AUTH_DATA_NOT_REPLAYABLE';

export interface ElementValue {
  read_mode: 'value' | 'text';
  value: string;
}

export interface ReadableElement {
  value?: unknown;
  innerText?: string;
  /** native input 的 tagName（密码 guard 限定真实 native input，不把 wrapper 的 type 属性当凭证通道） */
  tagName?: unknown;
  /** native input 的 type（password 检测用；非 input 元素缺省） */
  type?: unknown;
}

/**
 * field/capture 共用的固定控件读取合同：读自身 DOM.value（string 时取原值，
 * 空串与空白均保留），否则读自身 innerText（缺内容为空串）。
 * native password 在读 value 前固定拒绝（input[type=password].type === 'password'）。
 * 不找 parent/后代 input、不按 expected 猜控件、不用 AX 展示值——写入侧的
 * wrapper 后代寻 input 语义不带到读侧。
 *
 * 无闭包：函数体只引用入参与字面量，runtime 侧 locator.evaluate 直接传本函数；
 * CDP 侧 callOnNode 用 READ_ELEMENT_VALUE_FN 以 this 包装本函数源（派生，不复制逻辑）。
 */
export function readElementValue(element: ReadableElement): ElementValue {
  if (element.tagName === 'INPUT' && element.type === 'password') {
    // 字面量而非 AUTH_DATA_NOT_REPLAYABLE 引用：保持无闭包可序列化
    throw new Error('AUTH_DATA_NOT_REPLAYABLE');
  }
  if (typeof element.value === 'string') return { read_mode: 'value', value: element.value };
  const text = typeof element.innerText === 'string' ? element.innerText : '';
  return { read_mode: 'text', value: text };
}

/** CDP callOnNode 专用：以 this 包装 readElementValue 函数源（唯一逻辑源的序列化形态） */
export const READ_ELEMENT_VALUE_FN = `function () { return (${readElementValue.toString()})(this); }`;
