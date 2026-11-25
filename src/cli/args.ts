import type { ArgDef } from './commands.js';
import { isValidDotPath, type PageDataSource } from '../browser/page-data.js';
import { parseValue } from '../browser/assert.js';

export interface ParsedArgs {
  values: Record<string, string>;
  positional: string[];
  errors: string[];
}

export function parseArgs(argv: string[], defs: ArgDef[]): ParsedArgs {
  const values: Record<string, string> = {};
  const positional: string[] = [];
  const errors: string[] = [];
  const byName = new Map(defs.map((d) => [d.name, d]));
  const positionalDefs = defs.filter((d) => !d.name.startsWith('-'));
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { i++; continue; }
    if (a.startsWith('--')) {
      const keyPart = a.split('=')[0];
      const def = byName.get(keyPart);
      if (!def) { errors.push(`未知参数: ${a}`); i++; continue; }
      const eq = a.indexOf('=');
      if (eq !== -1) {
        const v = a.slice(eq + 1);
        if (def.enum && !def.enum.includes(v)) { errors.push(`${keyPart} 只接受 ${def.enum.join('|')}`); i++; continue; }
        values[def.name] = v;
        i++; continue;
      }
      if (def.kind === 'flag') { values[def.name] = 'true'; i++; continue; }
      const v = argv[++i];
      if (v === undefined) { errors.push(`${a} 需要值`); i++; continue; }
      if (def.enum && !def.enum.includes(v)) { errors.push(`${a} 只接受 ${def.enum.join('|')}`); i++; continue; }
      values[def.name] = v;
      i++; continue;
    }
    if (a.startsWith('-') && a.length === 2) {
      const def = byName.get(a);
      if (!def) { errors.push(`未知参数: ${a}`); i++; continue; }
      const v = argv[++i];
      if (v === undefined) { errors.push(`${a} 需要值`); i++; continue; }
      if (def.enum && !def.enum.includes(v)) { errors.push(`${a} 只接受 ${def.enum.join('|')}`); i++; continue; }
      values[def.name] = v;
      i++; continue;
    }
    const fixedPositional = positionalDefs.filter((def) => !def.variadic);
    const variadicDef = positionalDefs.find((def) => def.variadic);
    if (positional.length >= fixedPositional.length && !variadicDef) {
      errors.push(`多余的位置参数: ${a}`);
      i++; continue;
    }
    if (positional.length < fixedPositional.length) {
      values[fixedPositional[positional.length].name] = a;
    } else {
      values[variadicDef!.name] = a;
    }
    positional.push(a);
    i++;
  }
  for (const def of defs) {
    if (def.required && values[def.name] === undefined) errors.push(`缺少必填参数: ${def.name}`);
  }
  return { values, positional, errors };
}

export function parsePageDataSourceFlags(values: Record<string, string>): { ok: true; source: PageDataSource } | { ok: false; message: string } {
  const ls = values['--local-storage'];
  const gl = values['--global'];
  const flagPath = values['--path'];
  const hasLs = ls !== undefined;
  const hasG = gl !== undefined;
  if (hasLs === hasG) return { ok: false, message: '必须且只能指定一种数据源:--local-storage <key> 或 --global <name>' };
  if (hasLs) {
    if (ls === '') return { ok: false, message: '--local-storage key 不能为空' };
    if (flagPath !== undefined) {
      if (flagPath === '') return { ok: false, message: '--path 不能为空' };
      if (!isValidDotPath(flagPath)) return { ok: false, message: '--path 只支持 dot path（如 record.mode / items.0.id），不支持 [] / 过滤 / 空段' };
      return { ok: true, source: { local_storage: ls, path: flagPath } };
    }
    return { ok: true, source: { local_storage: ls } };
  }
  if (flagPath !== undefined) return { ok: false, message: '--path 只能与 --local-storage 一起使用' };
  if (gl === '') return { ok: false, message: '--global name 不能为空' };
  return { ok: true, source: { global: gl } };
}

export function parseEqualsScalar(raw: string): { ok: true; value: string | number | boolean | null } | { ok: false; message: string } {
  const v = parseValue(raw);
  if (v !== null && typeof v === 'object') return { ok: false, message: '--equals 只接受 JSON 标量（字符串/数字/boolean/null），不接受对象或数组' };
  if (typeof v === 'number' && !Number.isFinite(v)) return { ok: false, message: '--equals 数字必须是有限值（NaN/Infinity 拒绝）' };
  return { ok: true, value: v as string | number | boolean | null };
}

export function collectCommon(values: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (values['--wait-api']) out.wait_api = values['--wait-api'];
  if (values['--wait-element']) out.wait_element = values['--wait-element'];
  if (values['--wait-gone']) out.wait_gone = values['--wait-gone'];
  if (values['--wait-text']) out.wait_text = values['--wait-text'];
  if (values['--wait-url']) out.wait_url = values['--wait-url'];
  if (values['--wait-timeout-ms'] !== undefined) out.wait_timeout_ms = values['--wait-timeout-ms'];
  if (values['--creates']) {
    const raw = values['--creates'];
    const eq = raw.indexOf('=');
    if (eq > 0) out.creates = { entity: raw.slice(0, eq), path: raw.slice(eq + 1) };
  }
  if (values['--dialog']) {
    out.dialog = { accept: values['--dialog'] === 'accept', ...(values['--prompt-text'] !== undefined ? { prompt_text: values['--prompt-text'] } : {}) };
  }
  if (values['--frame']) out.frame = values['--frame'];
  if (values['--save-as']) out.save_as = values['--save-as'];
  if (values['--value-template'] !== undefined) out.value_template = values['--value-template'];
  if (values['--value-ref'] !== undefined) out.value_ref = values['--value-ref'];
  if (values['--group']) out.group = values['--group'];
  return out;
}
