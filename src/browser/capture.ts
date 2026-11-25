/**
 * 阶段 2.4 capture 命令的 browser 层实现。
 *
 * capture api:从请求响应 body 用 JSON path 取值 → 存变量。血缘由 daemon 判定:
 *   - 取自带 creates 的请求 → created
 *   - 值等于本会话某个模板生成值 → generated
 *   - 否则 → queried
 * capture element:从页面元素取值 → 存变量。血缘:
 *   - 值等于某个生成值 → generated
 *   - 否则 → queried
 *
 * 不重发 Network.getResponseBody;走 trace blob(请求已结束,SSOT)。
 */
import type { CdpSession } from './daemon-client.js';
import { collectPageState } from './page-state.js';
import { resolveTarget, callOnNode } from './interactions.js';
import { resolveTargetForAssert } from './assert.js';
import { replayJsonPath } from '../shared/assertion.js';
import { collectCandidates } from './actions.js';
import { READ_ELEMENT_VALUE_FN } from '../shared/element-value.js';

export type CaptureLineage = 'created' | 'generated' | 'queried';

export interface CaptureResult {
  as: string;
  value: string;
  lineage: CaptureLineage;
  from: unknown;
  /** Phase2：自身读取通道与自身 target 身份（写入 capture 事件 result） */
  read_mode?: 'value' | 'text';
  target?: { backendNodeId: number; resolved_by: string; role: string; name: string; matches?: number; selector?: string; candidates?: Array<{ by: string; role?: string; name?: string; value?: string; selector?: string; matches: number }> };
}

export interface CaptureDeps {
  cdp: CdpSession;
  resolveReq: (ref: string) => { id: string; path: string; nav: string; call_index: number; status?: number } | null;
  getBodyInfo: (id: string) => { resp_body_ref?: string; req_body_ref?: string; resp_body_omitted?: string; req_body_omitted?: string; creates?: string; failed?: string | null; status?: number; resp_body_redacted_paths?: string[][]; req_body_redacted_paths?: string[][] } | undefined;
  readBody: (ref: string) => string | null;
  /** 本会话已生成的模板值集合(--value-template 渲染结果),供血缘判定 */
  generatedValues: () => Set<string>;
  /** 解析对外 ref [N] → (targetId, backendNodeId)，与 daemon refMap 同源（assert/capture [N] 不走 AX 局部 index）。 */
  resolveRef?: (ref: number) => { targetId: string; backendNodeId: number } | null;
}

/** capture api:从响应 body 取值。
 *  reqRef + jsonPath → 值。Body 不可读抛错(不静默 lineage=queried)。
 *  Phase2 F3：body_ref 存在时必须有路径事实；取值走 replayJsonPath，依赖被脱敏改写路径抛 REPLAY_EVIDENCE_REDACTED。
 *  血缘:creates 标注 → created;值 ∈ generatedValues → generated;否则 queried。 */
export async function captureApi(deps: CaptureDeps, reqRef: string, jsonPathExpr: string, as: string): Promise<CaptureResult> {
  const summary = deps.resolveReq(reqRef);
  if (!summary) throw new Error('BAD_REQUEST: 找不到请求引用: ' + reqRef);
  const info = deps.getBodyInfo(summary.id);
  if (!info || !info.resp_body_ref) {
    const omitted = info?.resp_body_omitted;
    throw new Error('BODY_UNAVAILABLE: ' + (omitted ?? '该请求无响应 body'));
  }
  const pathsRaw = info.resp_body_redacted_paths;
  if (!Array.isArray(pathsRaw)) {
    throw new Error('INSUFFICIENT_EVIDENCE: body_ref 存在但缺 resp_body_redacted_paths 路径事实');
  }
  for (const p of pathsRaw) {
    if (!Array.isArray(p) || p.some((seg) => typeof seg !== 'string')) {
      throw new Error('INSUFFICIENT_EVIDENCE: resp_body_redacted_paths 非二维字符串数组');
    }
  }
  const raw = deps.readBody(info.resp_body_ref);
  if (raw === null) throw new Error('BODY_UNAVAILABLE: blob 不可读');
  let body: unknown;
  try { body = JSON.parse(raw); } catch (e) {
    throw new Error('BODY_UNAVAILABLE: 响应 body 不是合法 JSON (' + (e as Error).message + ')');
  }
  const value = replayJsonPath(body, jsonPathExpr, pathsRaw);
  if (value === undefined || value === null) {
    throw new Error('BAD_REQUEST: JSON path 未命中: ' + jsonPathExpr);
  }
  const valueStr = typeof value === 'object' ? JSON.stringify(value) : String(value);
  const lineage: CaptureLineage = info.creates
    ? 'created'
    : deps.generatedValues().has(valueStr) ? 'generated' : 'queried';
  return {
    as,
    value: valueStr,
    lineage,
    from: { path: summary.path, nav: summary.nav, call_index: summary.call_index, req_id: summary.id },
  };
}

/** capture element:从页面元素取值。
 *  Phase2：读自身唯一候选的 DOM.value 或自身 innerText（共源 readElementValue），
 *  记录自身 locator/read_mode；CDP/传输读失败直接结构化错误，不再 catch 后补空串；
 *  密码通道抛 AUTH_DATA_NOT_REPLAYABLE。血缘:值 ∈ generatedValues → generated;否则 queried。 */
export async function captureElement(deps: CaptureDeps, target: string, as: string): Promise<CaptureResult> {
  const ps = await collectPageState(deps.cdp);
  const r = await resolveTargetForAssert(deps.cdp, target, ps, deps.resolveRef);
  if (!r) throw new Error('目标元素不存在（有效 ref 但元素已消失），capture 失败');
  const ev = await callOnNode<{ read_mode: 'value' | 'text'; value: string }>(deps.cdp, r.backendNodeId, READ_ELEMENT_VALUE_FN);
  // ARIA combobox: DOM 侧可能读不到选中值，用 page-state 已采集的 AX value fallback
  let valueStr = ev.value;
  let captureReadMode = ev.read_mode;
  if (ev.value === '' && r.role === 'combobox') {
    const axHit = ps.elements.find((e) => e.backendNodeId === r.backendNodeId);
    if (axHit && axHit.value) {
      valueStr = axHit.value;
      captureReadMode = 'text';
    }
  }
  const lineage: CaptureLineage = deps.generatedValues().has(valueStr) ? 'generated' : 'queried';
  const targetInfo: NonNullable<CaptureResult['target']> = { backendNodeId: r.backendNodeId, resolved_by: r.matchedBy ?? 'ax', role: r.role ?? '', name: r.name ?? '', ...(r.matches !== undefined ? { matches: r.matches } : {}), ...(r.selector ? { selector: r.selector } : {}) };
  const cands = await collectCandidates(ps, targetInfo, r.matchedBy ?? 'ax', deps.cdp);
  if (cands.length > 0) targetInfo.candidates = cands;
  return {
    as,
    value: valueStr,
    lineage,
    from: { target, role: r.role, name: r.name, backendNodeId: r.backendNodeId },
    read_mode: captureReadMode,
    target: targetInfo,
  };
}
