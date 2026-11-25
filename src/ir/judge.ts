/**
 * judge：技术证据可执行性判据（不是业务完整性/可重复运行保证）。
 *
 * 保留的技术门禁：
 *  - 关联 trace 存在、schema 版本一致、session_id 与 provenance 一致
 *  - 会话真实 pass、未用 mock（trace 与 provenance 一致）
 *  - 无失败动作/断言/timeout，有声明断言
 *  - checkIr（schema/locator/请求引用/value/wait/refine）的 failures 与
 *    skipped（证据缺失项）全部转成不通过原因 —— 不通过删业务规则漏掉技术证据
 *  - 已声明 creates 是调用方数据：仅核对对应 trace action 元数据与已引用请求三元组的
 *    触发归因；不规定每个测试必须创建业务实体，不猜唯一性字段，不限定结果断言种类
 *
 * arbitrary execute 的 UNMAPPED_ACTIONS 仍由 ir build 拒绝，judge 不放行。
 */
import * as fs from 'node:fs';
import { parseIRv2, type IRv2 } from './schema.js';
import { checkIr } from './check.js';
import { readTrace, parseTrace, type ParsedTrace } from './trace-reader.js';
import { TRACE_SCHEMA_VERSION } from '../shared/versions.js';

export interface JudgeResult {
  regressible: boolean;
  reasons: string[];
}

export interface JudgeOptions {
  trace?: ParsedTrace;
}

/** 已声明 creates 的核对：trace action 元数据 + 已引用 wait.api 三元组的触发归因（调用方数据一致性） */
function createsConsistencyReasons(ir: IRv2, trace: ParsedTrace | undefined): string[] {
  const bad: string[] = [];
  for (const s of ir.steps) {
    if (!s.creates) continue;
    if (!trace) {
      bad.push(`creates 步骤 ${s.id} 缺关联 trace，无法核对请求触发归因`);
      continue;
    }
    const action = trace.actions.find((a) => a.id === s.trace_ref);
    if (action?.creates?.entity !== s.creates.entity || action.creates?.path !== s.creates.path) {
      bad.push(`creates 步骤 ${s.id} 与 trace action 标注不一致`);
      continue;
    }
    for (const w of s.wait ?? []) {
      if (!('api' in w)) continue;
      const ref = w.api;
      const request = trace.requests.find((r) => r.path === ref.path && r.nav === `n${ref.nav}` && r.call_index === ref.call_index);
      if (request?.triggered_by !== s.trace_ref || request.creates !== s.creates.entity) {
        bad.push(`creates 步骤 ${s.id} 的 wait.api 三元组 ${JSON.stringify(ref)} 缺匹配的触发归因/creates 证据`);
      }
    }
  }
  return bad;
}

export function judgeIr(input: unknown, opts: JudgeOptions = {}): JudgeResult {
  const parsed = parseIRv2(input);
  if (!parsed.ok) {
    return { regressible: false, reasons: ['IR schema 校验失败: ' + parsed.error.issues.map((i) => i.message).join('; ')] };
  }
  const ir = parsed.ir;
  const reasons: string[] = [];
  let trace = opts.trace;
  if (!trace) {
    try {
      const events = readTrace(ir.provenance.session_id);
      if (events) trace = parseTrace(events);
    } catch (error) {
      return { regressible: false, reasons: ['trace 校验失败: ' + (error as Error).message] };
    }
  }
  if (!trace) reasons.push('缺关联 trace');
  if (trace && trace.session?.session_id !== ir.provenance.session_id) reasons.push('trace session_id 与 IR provenance 不一致');
  if (trace && trace.session?.schema_version !== TRACE_SCHEMA_VERSION) reasons.push(`trace schema_version 必须是 ${TRACE_SCHEMA_VERSION}`);
  if (trace && (trace.sessionEnd?.result !== 'pass' || trace.sessionEnd.mocked || trace.mocks.some((event) => event.op === 'add') || trace.requests.some((request) => request.mocked === true))) reasons.push('关联 trace 会话未 pass 或使用过 mock');
  if (trace && (trace.actions.some((action) => action.result?.ok === false || action.settled_by?.some((wait) => wait.kind === 'timeout')) || trace.asserts.some((assert) => !assert.pass) || (trace.sessionEnd?.timeouts ?? 0) > 0 || (trace.sessionEnd?.asserts && trace.sessionEnd.asserts.pass < trace.sessionEnd.asserts.total))) reasons.push('关联 trace 含失败动作、断言或 timeout，不接受旧误 pass 终态');
  // P2：失败观察拒绝（observation 不是 action，但不能因它不是 action 而忽略）
  if (trace && trace.observations.some((o) => o.result?.ok !== true)) reasons.push('关联 trace 含失败观察（页面数据读取错误）');
  if (trace && trace.asserts.length === 0) reasons.push('关联 trace 无断言，未验证');

  // 判据：会话未用 mock（provenance 与 trace 双向一致）
  if (ir.provenance.mocked) {
    reasons.push('会话使用过 mock（provenance.mocked=true），不可落库');
  }

  // 技术校验（checkIr）：failures / skipped（证据缺失项）全部成为不通过原因
  const checked = checkIr(ir, { trace });
  for (const failure of checked.failures) {
    reasons.push(`ir check: ${failure.rule}${failure.step ? ` ${failure.step}` : ''}: ${failure.message}`);
  }
  for (const skipped of checked.skipped) {
    reasons.push(`ir check 证据缺失: ${skipped}`);
  }

  // 已声明 creates 的核对（调用方数据一致性，不要求不存在 creates 的测试补造）
  reasons.push(...createsConsistencyReasons(ir, trace));

  return { regressible: reasons.length === 0, reasons };
}

/** CLI 入口：读 IR 文件。 */
export function judgeIrFile(irFile: string): JudgeResult {
  return judgeIr(JSON.parse(fs.readFileSync(irFile, 'utf-8')));
}
