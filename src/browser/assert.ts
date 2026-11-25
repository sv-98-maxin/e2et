/**
 * 阶段 2.4 assert 命令的 browser 层实现。
 *
 * 断言失败返回 pass:false(不抛错),由 daemon 写 trace assert 事件 + 命令返回 ok:true。
 * 真正的失败(找不到请求、body 不可读、target 解析失败)才抛错 → 命令 ok:false。
 *
 * req 引用与 body 读取:统一走 NetworkTrace.resolveReqRef + getBodyRef + readTraceBody,
 * 不重新发 Network.getResponseBody(请求可能已过期,trace blob 是 SSOT)。
 *
 * jsonPath 手写,只支持 a.b.c / a[0] / a.b[2].c 三种(spec 示例够用);
 * 不引入 jsonpath 库,避免给 CLI 包加依赖。
 */
import type { CdpSession } from './daemon-client.js';
import { collectPageState, probeBackendNode, CdpReadError, type PageState, type AXNode, type BackendProbe } from './page-state.js';
import { resolveTarget, resolveSelector, callOnNode, TargetNotFoundError } from './interactions.js';
import { parseTargetSpec, collectCandidates, type ResolvedTargetInfo } from './actions.js';
import type { RefIdentity } from '../shared/types.js';
import { candidateToLocator } from '../shared/wait-locator.js';

/** 类型化 ref 错误：无效/跨页/旧 ref 是输入错误（拒绝，不在 absent 里变 PASS）。
 *  有效 active ref 对应元素真实消失是正常观察（visible=false / absent=true / capture 失败），不抛此错。 */
export class InvalidRefError extends Error {
  readonly code = 'INVALID_REF';
  constructor(message: string) { super(message); this.name = 'InvalidRefError'; }
}

import { jsonPath, replayJsonPath, compare, compareQuery, queryParamValues, parseAssertion, parseValue, diagnoseMissingPath, REPLAY_EVIDENCE_REDACTED, type AssertOp } from '../shared/assertion.js';
import { isSensitiveKey } from '../shared/url-safety.js';
import { READ_ELEMENT_VALUE_FN } from '../shared/element-value.js';
import { normalizeRoleName } from '../shared/accessible-name.js';
import { ELEMENT_PROPERTIES, readComputedStyle, readElementProperty, scanUi, type UiScanResult } from '../shared/dom-inspection.js';
import { mapLocatorElements, queryLocator } from './locator-query.js';
export { jsonPath, compare, parseAssertion, parseValue, type AssertOp };

export interface AssertResult {
  kind: string;
  expect: unknown;
  actual: unknown;
  pass: boolean;
  evidence: unknown[];
  target?: ResolvedTargetInfo;
  within?: ResolvedTargetInfo;
  /** Phase2：field/capture 自身读取通道（value/text），写入 assert 事件 */
  read_mode?: 'value' | 'text';
  /** §7：本 assert 自身使用的 ref 稳定身份（absent 重查依据；历史 candidate.matches
   *  不是当前 matches，actual 单独记录当前事实） */
  identity?: RefIdentity;
  /** 路径未命中状态载体：missing 时 actual 显式 null（避免 JSON.stringify 丢字段），
   *  诊断（最长可解析前缀 + 可用 key）在 evidence 里；compare 仍按 undefined 判 false。 */
  path_status?: 'ok' | 'missing';
}

export interface AssertDeps {
  cdp: CdpSession;
  /** 解析 req 引用 → RequestSummary;返回 null 表示找不到 */
  resolveReq: (ref: string) => { id: string; path: string; nav: string; call_index: number; status?: number; url?: string; url_redacted?: boolean } | null;
  /** 取请求的 body ref 信息(resp_body_ref / req_body_ref / omitted / creates / failed)
   *  Phase2 F3：body_ref 存在时必须携带实际改写路径事实（redacted_paths） */
  getBodyInfo: (id: string) => { resp_body_ref?: string; req_body_ref?: string; resp_body_omitted?: string; req_body_omitted?: string; creates?: string; failed?: string | null; status?: number; resp_body_redacted_paths?: string[][]; req_body_redacted_paths?: string[][] } | undefined;
  /** 响应头安全元数据（已有实际改写事实）；header 断言只认未改写证据。 */
  getHeadersInfo?: (id: string) => { headers?: Record<string, string>; redacted?: string[] } | undefined;
  /** 读 trace blob 内容(ref 形如 blobs/<sha>);不存在返回 null */
  readBody: (ref: string) => string | null;
  /** 当前 URL(page state 之外取,assert url 用) */
  currentUrl: () => Promise<string>;
  /** 解析对外 ref [N] → (targetId, backendNodeId)；与 daemon refMap 同源。
   *  assert/capture/within 的 [N] 必须走此映射，不得用 AX 局部 index 绕过。
   *  失效 ref（切换/关闭/新快照后）返回 null，是输入错误，不在此变 PASS。 */
  resolveRef?: (ref: number) => { targetId: string; backendNodeId: number; identity?: RefIdentity } | null;
}

/** 从请求 body 取值(assert api 取响应、assert request 取请求体)。
 *  body 不可读时抛 'BODY_UNAVAILABLE'(不静默 pass)。
 *  Phase2 F3：body_ref 存在但缺路径事实/非二维字符串数组 → INSUFFICIENT_EVIDENCE，不默认 []。
 *  取值走 replayJsonPath：具体节点/子树/filter 依赖被脱敏改写时抛 REPLAY_EVIDENCE_REDACTED，
 *  无改写路径时行为与 jsonPath 一致。 */
function readBodyEvidence(deps: AssertDeps, reqId: string, source: 'response' | 'request'): { body: unknown; redactedPaths: string[][] } {
  const info = deps.getBodyInfo(reqId);
  if (!info) throw new Error('BODY_UNAVAILABLE: 请求体信息缺失');
  const ref = source === 'response' ? info.resp_body_ref : info.req_body_ref;
  const omitted = source === 'response' ? info.resp_body_omitted : info.req_body_omitted;
  const pathsRaw = source === 'response' ? info.resp_body_redacted_paths : info.req_body_redacted_paths;
  if (!ref) {
    if (omitted) throw new Error('BODY_UNAVAILABLE: ' + omitted);
    throw new Error('BODY_UNAVAILABLE: 该请求无 ' + (source === 'response' ? '响应' : '请求') + ' body');
  }
  if (!Array.isArray(pathsRaw)) {
    throw new Error(`INSUFFICIENT_EVIDENCE: body_ref 存在但缺 ${source === 'response' ? 'resp' : 'req'}_body_redacted_paths 路径事实`);
  }
  for (const p of pathsRaw) {
    if (!Array.isArray(p) || p.some((seg) => typeof seg !== 'string')) {
      throw new Error(`INSUFFICIENT_EVIDENCE: ${source === 'response' ? 'resp' : 'req'}_body_redacted_paths 非二维字符串数组`);
    }
  }
  const raw = deps.readBody(ref);
  if (raw === null) throw new Error('BODY_UNAVAILABLE: blob 不可读');
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch (e) {
    throw new Error('BODY_UNAVAILABLE: body 不是合法 JSON (' + (e as Error).message + ')');
  }
  return { body, redactedPaths: pathsRaw };
}

/** 校验 redacted_paths 事实形状（daemon 映射层用；与 readBodyEvidence 同规则）。 */
export function assertValidRedactedPaths(paths: unknown): string[][] {
  if (!Array.isArray(paths)) throw new Error('INSUFFICIENT_EVIDENCE: redacted_paths 缺失');
  for (const p of paths) {
    if (!Array.isArray(p) || p.some((seg) => typeof seg !== 'string')) {
      throw new Error('INSUFFICIENT_EVIDENCE: redacted_paths 非二维字符串数组');
    }
  }
  return paths as string[][];
}

/** assert api:从响应 body 取值比较。
 *  Phase2：expectedOverride 存在时（显式 value-ref / value-from-action）直接用该字符串比较，
 *  不对 literal JSON 猎类型；取值走 replayJsonPath 拒绝依赖被脱敏改写的路径。 */
export async function assertApi(deps: AssertDeps, reqRef: string, assertion: string, expectedOverride?: string): Promise<AssertResult> {
  const parsed = parseAssertion(assertion);
  if (!parsed) throw new Error('BAD_REQUEST: 期望 "<path> <op> <value>",收到: ' + assertion);
  const summary = deps.resolveReq(reqRef);
  if (!summary) throw new Error('BAD_REQUEST: 找不到请求引用: ' + reqRef);
  const { body, redactedPaths } = readBodyEvidence(deps, summary.id, 'response');
  const actual = replayJsonPath(body, parsed.path, redactedPaths);
  const pathStatus = actual === undefined ? 'missing' : 'ok';
  const expected = expectedOverride !== undefined ? expectedOverride : parseValue(parsed.valueJson);
  // compare 入参仍用 undefined 原值：missing 对所有 op 为 false，不能被展示层 null 换成假绿
  const pass = compare(parsed.op, actual, expected);
  const evidence: unknown[] = [{ req_id: summary.id, path: summary.path, status: summary.status }];
  if (pathStatus === 'missing') evidence.push(diagnoseMissingPath(body, parsed.path));
  return {
    kind: 'api',
    expect: { path: parsed.path, op: parsed.op, value: expected, req: { path: summary.path, nav: summary.nav, call_index: summary.call_index } },
    actual: pathStatus === 'missing' ? null : actual,
    pass,
    path_status: pathStatus,
    evidence,
  };
}

/** assert request:从请求 body 或 query 取值比较。同 assertApi 的来源与守卫规则。
 *  query 以完整键名匹配，值保留有序 string[]；来源 URL 实际被脱敏改写或键名敏感 → REPLAY_EVIDENCE_REDACTED。 */
export async function assertRequest(
  deps: AssertDeps,
  reqRef: string,
  assertion: string,
  expectedOverride?: string,
  source: 'body' | 'query' = 'body',
): Promise<AssertResult> {
  const parsed = parseAssertion(assertion);
  if (!parsed) throw new Error('BAD_REQUEST: 期望 "<path> <op> <value>",收到: ' + assertion);
  const summary = deps.resolveReq(reqRef);
  if (!summary) throw new Error('BAD_REQUEST: 找不到请求引用: ' + reqRef);
  if (source === 'query') {
    if (!summary.url) throw new Error('INSUFFICIENT_EVIDENCE: 请求缺少安全 URL 事实');
    if (summary.url_redacted) throw new Error(`${REPLAY_EVIDENCE_REDACTED}: 来源 URL 已被实际脱敏改写`);
    if (isSensitiveKey(parsed.path)) throw new Error(`${REPLAY_EVIDENCE_REDACTED}: query 键名敏感`);
    const values = queryParamValues(summary.url, parsed.path);
    const expected = expectedOverride !== undefined ? expectedOverride : parseValue(parsed.valueJson);
    const pathStatus = values === undefined ? 'missing' : 'ok';
    const pass = compareQuery(parsed.op, values, expected);
    const evidence: unknown[] = [{ req_id: summary.id, path: summary.path, query: parsed.path }];
    if (pathStatus === 'missing') evidence.push({ path_status: 'missing', resolved_prefix: '' });
    return {
      kind: 'request',
      expect: {
        path: parsed.path,
        op: parsed.op,
        value: expected,
        req: { path: summary.path, nav: summary.nav, call_index: summary.call_index },
        source: 'query',
      },
      actual: pathStatus === 'missing' ? null : values,
      pass,
      path_status: pathStatus,
      evidence,
    };
  }
  const { body, redactedPaths } = readBodyEvidence(deps, summary.id, 'request');
  const actual = replayJsonPath(body, parsed.path, redactedPaths);
  const pathStatus = actual === undefined ? 'missing' : 'ok';
  const expected = expectedOverride !== undefined ? expectedOverride : parseValue(parsed.valueJson);
  // compare 入参仍用 undefined 原值：missing 对所有 op 为 false，不能被展示层 null 换成假绿
  const pass = compare(parsed.op, actual, expected);
  const evidence: unknown[] = [{ req_id: summary.id, path: summary.path }];
  if (pathStatus === 'missing') evidence.push(diagnoseMissingPath(body, parsed.path));
  return {
    kind: 'request',
    expect: { path: parsed.path, op: parsed.op, value: expected, req: { path: summary.path, nav: summary.nav, call_index: summary.call_index } },
    actual: pathStatus === 'missing' ? null : actual,
    pass,
    path_status: pathStatus,
    evidence,
  };
}

/** assert api --header：响应头名大小写不敏感；敏感键/实际被改写值拒绝作为回放证据。 */
export async function assertApiHeader(deps: AssertDeps, reqRef: string, assertion: string): Promise<AssertResult> {
  const parsed = parseAssertion(assertion);
  if (!parsed) throw new Error('BAD_REQUEST: 期望 "<header-name> <op> <value>",收到: ' + assertion);
  const summary = deps.resolveReq(reqRef);
  if (!summary) throw new Error('BAD_REQUEST: 找不到请求引用: ' + reqRef);
  const name = parsed.path.toLowerCase();
  if (isSensitiveKey(name)) throw new Error(`${REPLAY_EVIDENCE_REDACTED}: 响应头名敏感`);
  const info = deps.getHeadersInfo?.(summary.id);
  if (!info?.headers) throw new Error('INSUFFICIENT_EVIDENCE: 响应头安全元数据缺失');
  if (info.redacted?.includes(name)) throw new Error(`${REPLAY_EVIDENCE_REDACTED}: 响应头已被实际脱敏改写`);
  const actual = Object.prototype.hasOwnProperty.call(info.headers, name) ? info.headers[name] : undefined;
  if (actual !== undefined && actual.includes('[REDACTED]')) throw new Error(`${REPLAY_EVIDENCE_REDACTED}: 响应头值已被实际脱敏改写`);
  const expected = parseValue(parsed.valueJson);
  const pass = compare(parsed.op, actual, expected);
  return {
    kind: 'api',
    expect: {
      path: name, op: parsed.op, value: expected,
      req: { path: summary.path, nav: summary.nav, call_index: summary.call_index },
      source: 'header',
    },
    actual: actual ?? null,
    pass,
    path_status: actual === undefined ? 'missing' : 'ok',
    evidence: [{ req_id: summary.id, path: summary.path, header: name }],
  };
}

/** assert toast:page state 的 messages 是否包含 text(子串)。 */
export async function assertToast(deps: AssertDeps, text: string): Promise<AssertResult> {
  const ps = await collectPageState(deps.cdp);
  const hit = ps.messages.some((m) => m.includes(text));
  return {
    kind: 'toast',
    expect: text,
    actual: ps.messages,
    pass: hit,
    evidence: hit ? [] : [{ messages: ps.messages }],
  };
}

/** assert text:页面可见文本包含 contains;within 限定范围(target 写法)。
 *  within 省略时扫 document.body.innerText;给定时取该元素的 text。 */
export async function assertText(deps: AssertDeps, contains: string, within?: string): Promise<AssertResult> {
  let scope: string;
  let scopeDesc: string;
  let withinTarget: ResolvedTargetInfo | undefined;
  if (within) {
    const ps = await collectPageState(deps.cdp);
    const r = await resolveTargetForAssert(deps.cdp, within, ps, deps.resolveRef);
    if (!r) {
      // within 元素真正脱离 DOM（disconnected）→ 搜索范围为空 → text 未找到 → pass:false（正常断言失败，不 abort）。
      // 无效/跨页 ref 仍由 resolveTargetForAssert 抛 InvalidRefError 传播（不经过此分支）。
      return { kind: 'text', expect: { contains, within: within ?? null }, actual: '', pass: false, evidence: [{ within_absent: true }] };
    }
    withinTarget = { backendNodeId: r.backendNodeId, role: r.role ?? '', name: r.name ?? '', resolved_by: r.matchedBy ?? 'ax', ...(r.matches !== undefined ? { matches: r.matches } : {}), ...(r.selector ? { selector: r.selector } : {}), ...(r.visible !== undefined ? { visible: r.visible } : {}) };
    // 候选采集与 innerText 读取分离：collector 的 CDP 错误直接抛（不进 innerText 的 catch，不掩成空范围）
    const cands = await collectCandidates(ps, withinTarget, r.matchedBy ?? 'ax', deps.cdp);
    if (cands.length > 0) withinTarget.candidates = cands;
    // callOnNode 在节点上下文里跑函数，读 innerText 比 evaluate 拿 objectId 稳
    scope = await callOnNode<string>(deps.cdp, r.backendNodeId, 'function() { return (this && this.innerText) || ""; }').catch(() => '');
    scopeDesc = within;
  } else {
    scope = await deps.cdp.evaluate<string>('document.body && document.body.innerText || ""').catch(() => '');
    scopeDesc = 'document.body';
  }
  const pass = scope.includes(contains);
  // C2: actual 取命中位置前后各 100 字符作为 snippet，不再截前 200
  const idx = scope.indexOf(contains);
  const snippet = idx >= 0
    ? scope.slice(Math.max(0, idx - 100), Math.min(scope.length, idx + contains.length + 100))
    : scope.slice(0, 200);
  return {
    kind: 'text',
    expect: { contains, within: within ?? null },
    actual: snippet,
    pass,
    evidence: pass ? [] : [{ within: scopeDesc, text_preview: snippet }],
    ...(withinTarget ? { within: withinTarget } : {}),
  };
}

/** assert visible/absent + capture element 的 target 解析:[N]/role=/label=/text=/css=,复用 parseTargetSpec。
 *  [N] 走 resolveRef（与 daemon refMap 同源）：
 *   - ref 不在 refMap / 跨 target → 抛 InvalidRefError（输入错误，拒绝，不在 absent 里变 PASS）
 *   - ref 有效但在当前过滤快照里缺席 → 用真实 backend 查 DOM 连接/布局事实：
 *     仍连接 → 返回该 backend（visible 由布局盒子决定；role/name 取真实局部 AX，缺则 undefined，不造假）
 *     已断开/被回收 → 返回 null（正常消失：visible=false/absent=PASS/capture 失败）
 *   - 其他 CDP 读取失败 → throw（不当消失 PASS）
 *  CSS/text 未命中 → 护常抛错，调用方按正常缺失处理。不用 msg.includes 文本或假 role 哨兵判错误类型。 */
export async function resolveTargetForAssert(cdp: CdpSession, target: string, ps: PageState, resolveRef?: (ref: number) => { targetId: string; backendNodeId: number } | null): Promise<{ backendNodeId: number; role?: string; name?: string; matches?: number; matchedBy?: string; selector?: string; visible?: boolean } | null> {
  const spec = parseTargetSpec(target);
  if (!spec) throw new Error('无法解析 target: ' + target);
  if (spec.kind === 'index') {
    if (resolveRef) {
      const mapped = resolveRef(spec.index);
      if (!mapped) throw new InvalidRefError('ref [' + spec.index + '] 不存在/已失效/跨页（切换/关闭/新快照后旧 ref 失效）');
      const el = ps.elements.find((e) => e.backendNodeId === mapped.backendNodeId);
      if (el) {
        const probe = await probeBackendNode(cdp, el.backendNodeId);
        return probe.state === 'gone' ? null : { backendNodeId: el.backendNodeId, role: el.role, name: el.name, matchedBy: 'index', visible: probe.visible };
      }
      // 有效 ref 但被 dialog/MAX_ELEMENTS 过滤出 ps.elements：用真实 backend 查 DOM 存在/可见性，不当 absent PASS
      const probe = await probeBackendNode(cdp, mapped.backendNodeId);
      if (probe.state === 'gone') return null; // 真正脱离 DOM → 正常消失
      return { backendNodeId: probe.backendNodeId, role: probe.role, name: probe.name, matchedBy: 'index-probe', ...(probe.visible ? {} : { visible: false }) };
    }
    const el = ps.elements[spec.index];
    if (!el) return null; // 索引越界 → 正常缺失
    const probe = await probeBackendNode(cdp, el.backendNodeId);
    return probe.state === 'gone' ? null : { backendNodeId: el.backendNodeId, role: el.role, name: el.name, matchedBy: 'index', visible: probe.visible };
  }
  if (spec.kind === 'css') {
    const r = await resolveSelector(cdp, spec.selector);
    // CSS 命中只证 DOM 存在不证可见：复用 probeBackendNode 读布局盒子，display:none 命中不再当 visible PASS。
    const probe = await probeBackendNode(cdp, r.backendNodeId);
    if (probe.state === 'gone') return null;
    return { ...r, matchedBy: 'css', selector: spec.selector, visible: probe.visible };
  }
  // text 写法:走 resolveTarget 当 name 找
  const r = await resolveTarget(cdp, spec.value, ps);
  const probe = await probeBackendNode(cdp, r.backendNodeId);
  return probe.state === 'gone' ? null : { ...r, matchedBy: r.matchedBy ?? 'ax', visible: probe.visible };
}

export async function assertVisible(deps: AssertDeps, target: string): Promise<AssertResult> {
  const ps = await collectPageState(deps.cdp);
  let r: Awaited<ReturnType<typeof resolveTargetForAssert>>;
  try {
    r = await resolveTargetForAssert(deps.cdp, target, ps, deps.resolveRef);
  } catch (e) {
    // InvalidRefError（无效/跨页/旧 ref）+ CdpReadError（真实 backend 读取失败）必须传播，不掩成 pass:false
    if (e instanceof InvalidRefError || e instanceof CdpReadError) throw e;
    return { kind: 'visible', expect: target, actual: { resolved: false }, pass: false, evidence: [{ error: (e as Error).message.slice(0, 200) }] };
  }
  if (!r) {
    // 真正脱离 DOM / CSS-text 未命中 → 正常缺失，visible=false
    return { kind: 'visible', expect: target, actual: { resolved: false }, pass: false, evidence: [{ not_present: true }] };
  }
  // 候选采集放在 resolve 的 catch 之外：collector 的 CDP 读取错误传播到 daemon 结构化处理，不准变 visible=false
  const targetInfo: ResolvedTargetInfo = { backendNodeId: r.backendNodeId, role: r.role ?? '', name: r.name ?? '', resolved_by: r.matchedBy ?? 'ax', ...(r.matches !== undefined ? { matches: r.matches } : {}), ...(r.selector ? { selector: r.selector } : {}) };
  const cands = await collectCandidates(ps, targetInfo, r.matchedBy ?? 'ax', deps.cdp);
  if (cands.length > 0) targetInfo.candidates = cands;
  // visible 来自真实布局事实（probe 的 present-but-no-box → false）；AX/快照命中默认可见
  const visible = r.visible !== false;
  return {
    kind: 'visible',
    expect: target,
    actual: { resolved: true, role: r.role, name: r.name, matches: r.matches ?? 1 },
    pass: visible,
    evidence: [{ resolved_by: r.matchedBy ?? 'ax', matches: r.matches ?? 1, ...(r.visible === false ? { visible: false } : {}) }],
    target: targetInfo,
  };
}

export async function assertAbsent(deps: AssertDeps, target: string): Promise<AssertResult> {
  const spec = parseTargetSpec(target);
  // R1/LC1：index 目标统一走 ref 身份合同：先 resolveRef（缺/跨页/失效 InvalidRefError）；
  // 有效但无 identity → INSUFFICIENT_EVIDENCE（无论旧 backend 是否仍连接）；
  // 有 identity 直接进身份重查，不先用旧 backend 或 dialog/MAX_ELEMENTS 过滤后的
  // ps.elements 决定结论（旧 backend 仍连接不代表该身份缺席，隐藏旧节点/多匹配同理）
  if (spec?.kind === 'index' && deps.resolveRef) {
    const mapped = deps.resolveRef(spec.index);
    if (!mapped) throw new InvalidRefError('ref [' + spec.index + '] 不存在/已失效/跨页（切换/关闭/新快照后旧 ref 失效）');
    if (!mapped.identity) {
      throw new Error('INSUFFICIENT_EVIDENCE: ref [' + spec.index + '] 无已验证身份（快照无唯一 roleLocator、也无 collector 候选），无法判定缺席，不假判缺席');
    }
    return await absentByRefIdentity(deps, target, mapped);
  }
  const ps = await collectPageState(deps.cdp);
  let r: Awaited<ReturnType<typeof resolveTargetForAssert>>;
  try {
    r = await resolveTargetForAssert(deps.cdp, target, ps, deps.resolveRef);
  } catch (e) {
    // R1/LC2：只把真实 TargetNotFoundError 当缺席；InvalidRefError（输入错误）、
    // CdpReadError（读取失败）与其它真实协议异常（如非法 CSS）原样传播到 daemon 分类，
    // 不无差别变 PASS 假缺席
    if (e instanceof TargetNotFoundError) {
      return { kind: 'absent', expect: target, actual: { resolved: false }, pass: true, evidence: [{ absent: true }] };
    }
    throw e;
  }
  // 返回的 matches>1 在取 first/判可见性之前拒绝：歧义不当缺席
  if (r && (r.matches ?? 1) > 1) {
    throw new Error('BAD_REQUEST: absent 目标命中 ' + r.matches + ' 个节点，歧义不当缺席');
  }
  if (!r) {
    // 真正脱离 DOM / CSS-text 未命中 → 不可见 → absent=true（PASS）
    return { kind: 'absent', expect: target, actual: { resolved: false }, pass: true, evidence: [{ absent: true }] };
  }
  // 仍连接 DOM：仅本次实际解析到 backend 时产 target 证据（带候选）；真实消失没有 target，不拿旧 ref/名字猜定位。
  // 候选采集在 resolve 的 catch 之外：collector 的 CDP 读取错误传播，不准变 absent PASS。
  const targetInfo: ResolvedTargetInfo = { backendNodeId: r.backendNodeId, role: r.role ?? '', name: r.name ?? '', resolved_by: r.matchedBy ?? 'ax', ...(r.matches !== undefined ? { matches: r.matches } : {}), ...(r.selector ? { selector: r.selector } : {}) };
  const cands = await collectCandidates(ps, targetInfo, r.matchedBy ?? 'ax', deps.cdp);
  if (cands.length > 0) targetInfo.candidates = cands;
  // probe present-but-no-box（visible=false，如 display:none）→ 不可见 → absent PASS；
  // present-visible / AX 命中（visible undefined）→ 可见 → absent fail。仅消费本次新增 r.visible，不重构其他 locator。
  const visible = r.visible !== false;
  return { kind: 'absent', expect: target, actual: { resolved: true, visible }, pass: !visible, evidence: visible ? [{ found: true }] : [{ present_not_visible: true }], target: targetInfo };
}

/** ref 目标按已验证身份在当前同一文档重查缺席（R1/LC1/LC3）：
 *  role 候选用 Accessibility.getFullAXTree 原始 nodes 全树匹配（忽略 ignored/无 backend 节点，
 *  不做 dialog 范围/展示截断/名称子串 fallback）；candidate.name 与当前 raw AX name 双侧
 *  normalizeRoleName（与 PW exact 同义），role 精确、name 大小写保持，按真实 backend 去重。
 *  css 候选走 resolveSelector 真实 count + probe，只 TargetNotFoundError 证明零命中。
 *  当前 0 命中 PASS；多命中 BAD_REQUEST；唯一节点 probeBackendNode 读真实可见性：
 *  可见 FAIL、不可见 PASS。query 命中但 probe 节点失效/读取失败 → INSUFFICIENT_EVIDENCE
 *  （不轮询、不用旧 backend gone 假 PASS）。历史 candidate.matches=1 与本次 actual.matches
 *  分开记录，不制造旧 backend 或假当前 target。helper 不接 PageState。 */
async function absentByRefIdentity(
  deps: AssertDeps,
  target: string,
  refEntry: { backendNodeId: number; identity?: RefIdentity },
): Promise<AssertResult> {
  const identity = refEntry.identity;
  if (!identity) {
    throw new Error('INSUFFICIENT_EVIDENCE: ref 目标无已验证身份（快照无唯一 roleLocator、也无 collector 候选），无法重查缺席，不假判缺席');
  }
  const cand = identity.candidate;
  const finish = (actual: Record<string, unknown>, pass: boolean): AssertResult => ({
    kind: 'absent',
    expect: target,
    actual,
    pass,
    evidence: pass ? [{ absent: true }] : [{ found: true }],
    identity,
  });
  if (cand.by === 'role' && cand.role !== undefined && cand.name !== undefined) {
    await deps.cdp.send('Accessibility.enable');
    const { nodes } = await deps.cdp.send<{ nodes: AXNode[] }>('Accessibility.getFullAXTree');
    const wanted = normalizeRoleName(cand.name);
    const hits = new Set<number>();
    for (const n of nodes) {
      if (n.ignored || n.backendDOMNodeId === undefined) continue;
      const role = n.role?.value === undefined || n.role?.value === null ? '' : String(n.role.value);
      if (role !== cand.role) continue;
      const rawName = n.name?.value === undefined || n.name?.value === null ? '' : String(n.name.value);
      if (normalizeRoleName(rawName) !== wanted) continue;
      hits.add(n.backendDOMNodeId);
    }
    if (hits.size === 0) return finish({ resolved: false, matches: 0 }, true);
    if (hits.size > 1) throw new Error('BAD_REQUEST: ref 身份在当前文档命中 ' + hits.size + ' 个同 role/name 元素，歧义不当缺席');
    let probe: BackendProbe;
    try {
      probe = await probeBackendNode(deps.cdp, [...hits][0]);
    } catch (e) {
      if (e instanceof CdpReadError) {
        throw new Error('INSUFFICIENT_EVIDENCE: ref 身份全树唯一命中但 backend 读取失败，无法判定缺席，请重试');
      }
      throw e;
    }
    if (probe.state === 'gone') {
      // 全树刚命中但 backend 已失效：无法证明当前身份零命中，不假 PASS
      throw new Error('INSUFFICIENT_EVIDENCE: ref 身份全树唯一命中但 backend 已失效，无法判定缺席，请重试');
    }
    return finish({ resolved: false, matches: 1, visible: probe.visible }, !probe.visible);
  }
  if (cand.by === 'css' && cand.selector) {
    let resolved: { backendNodeId: number; matches?: number };
    try {
      resolved = await resolveSelector(deps.cdp, cand.selector);
    } catch (e) {
      if (e instanceof TargetNotFoundError) return finish({ resolved: false, matches: 0 }, true);
      throw e;
    }
    if ((resolved.matches ?? 1) > 1) throw new Error('BAD_REQUEST: ref 身份 css 在当前文档命中 ' + resolved.matches + ' 个节点，歧义不当缺席');
    let probe: BackendProbe;
    try {
      probe = await probeBackendNode(deps.cdp, resolved.backendNodeId);
    } catch (e) {
      if (e instanceof CdpReadError) {
        throw new Error('INSUFFICIENT_EVIDENCE: ref 身份 css 唯一命中但 backend 读取失败，无法判定缺席，请重试');
      }
      throw e;
    }
    if (probe.state === 'gone') {
      // query 已命中但节点失效不能直接证明当前 locator 零命中，不拿旧 backend gone 假 PASS
      throw new Error('INSUFFICIENT_EVIDENCE: ref 身份 css 唯一命中但节点失效，不能证明当前 locator 零命中，请重试');
    }
    return finish({ resolved: false, matches: 1, visible: probe.visible }, !probe.visible);
  }
  throw new Error('INSUFFICIENT_EVIDENCE: ref 身份候选非 role/css（' + cand.by + '），无法在当前文档重查缺席');
}

/** assert table-row:页面表格中包含 contains 文本的行;count 校验行数。
 *  不进 page-state SSOT(不加 tables 字段),用 Runtime.evaluate 跑一段 JS 找行。 */
export async function assertTableRow(deps: AssertDeps, contains: string, count?: number): Promise<AssertResult> {
  const js = `(function() {
    const rows = document.querySelectorAll('table tr, [role="row"]');
    let matched = 0;
    const samples = [];
    for (const row of rows) {
      const text = row.innerText || '';
      if (text.includes(${JSON.stringify(contains)})) {
        matched++;
        if (samples.length < 3) samples.push(text.slice(0, 100));
      }
    }
    return JSON.stringify({ matched, samples, total: rows.length });
  })()`;
  const raw = await deps.cdp.evaluate<string>(js).catch(() => '{}');
  let info: { matched: number; samples: string[]; total: number };
  try { info = JSON.parse(String(raw)); } catch { info = { matched: 0, samples: [], total: 0 }; }
  const hasRow = info.matched > 0;
  const countOk = count === undefined ? hasRow : info.matched === count;
  return {
    kind: 'table_row',
    expect: { contains, count: count ?? null },
    actual: { matched_rows: info.matched, total_rows: info.total },
    pass: hasRow && countOk,
    evidence: [{ samples: info.samples, total_rows: info.total }],
  };
}

/** assert field:按 label 找字段，检查当前值。
 *  Phase2：候选按 label/name 归一化寻找、按 backend 去重后必须唯一；零个 → pass:false；
 *  多个 → BAD_REQUEST（带候选名/role，不 find 首个、不按 expected 选目标）。
 *  命中后用 collectCandidates 取自身身份，用共源 readElementValue 严格 eq；
 *  密码通道抛 AUTH_DATA_NOT_REPLAYABLE；target/read_mode 写入 AssertResult 与 assert 事件。 */
export async function assertField(deps: AssertDeps, label: string, value: string): Promise<AssertResult> {
  const ps = await collectPageState(deps.cdp);
  // 去前导 *（必填星号）后比对：用户传 "商品保质天数" 也要命中实际 "*商品保质天数"
  const norm = (s: string | undefined): string => (s ?? '').replace(/^\s*\*\s*/, '').replace(/[\ue000-\uf8ff]/g, '').trim();
  const hitsByBackend = new Map<number, typeof ps.elements[number]>();
  for (const e of ps.elements) {
    if (norm(e.fieldLabel) === norm(label) || norm(e.name) === norm(label)) hitsByBackend.set(e.backendNodeId, e);
  }
  const hits = [...hitsByBackend.values()];
  if (hits.length === 0) {
    return {
      kind: 'field_value',
      expect: { label, value },
      actual: { found: false },
      pass: false,
      // 不截断：页面 30+ 字段时前 20 可能不含目标 label，返回全部才能定位
      evidence: [{ labels: ps.elements.map((e) => e.fieldLabel ?? e.name) }],
    };
  }
  if (hits.length > 1) {
    // 字段组名歧义时给候选名/role 提示，不猜目标
    throw new Error('BAD_REQUEST: 字段 label 非唯一（' + hits.length + ' 个候选）: ' + hits.map((h) => `${h.role}=${h.fieldLabel ?? h.name}`).join(' | '));
  }
  const hit = hits[0];
  // 自身身份候选（roleLocator 唯一身份 / css 显式单命中；无已验证身份 → 空，fail closed）
  const cands = await collectCandidates(ps, { backendNodeId: hit.backendNodeId, role: hit.role, name: hit.name, matches: 1 }, 'ax', deps.cdp);
  const ev = await callOnNode<{ read_mode: 'value' | 'text'; value: string }>(deps.cdp, hit.backendNodeId, READ_ELEMENT_VALUE_FN);
  // ARIA combobox 等 AX 复合控件：DOM 侧可能读不到选中值（option 不在子树或 innerText 为空），
  // 用 page-state 已采集的 AX value 作 fallback——这是浏览器 ARIA 计算的权威选中值
  let effectiveValue = ev.value;
  let effectiveReadMode = ev.read_mode;
  if (ev.value === '' && hit.role === 'combobox' && hit.value) {
    effectiveValue = hit.value;
    effectiveReadMode = 'text';
  }
  const pass = effectiveValue === value;
  return {
    kind: 'field_value',
    expect: { label, value },
    actual: { found: true, value: effectiveValue, role: hit.role, read_mode: effectiveReadMode },
    pass,
    evidence: [{ index: hit.index, role: hit.role, value: effectiveValue, read_mode: effectiveReadMode }],
    target: { backendNodeId: hit.backendNodeId, resolved_by: 'ax', role: hit.role, name: hit.name, matches: 1, ...(cands.length > 0 ? { candidates: cands } : {}) },
    read_mode: effectiveReadMode,
  };
}

/** assert url:当前 URL 包含 contains。 */
export async function assertUrl(deps: AssertDeps, contains: string): Promise<AssertResult> {
  const url = await deps.currentUrl();
  const pass = url.includes(contains);
  return {
    kind: 'url',
    expect: { contains },
    actual: url,
    pass,
    evidence: pass ? [] : [{ url }],
  };
}

/** style/element 断言的 target → 可回放 canonical locator；[N] 必须带已验证身份。 */
async function resolveAssertLocator(
  deps: AssertDeps,
  target: string,
): Promise<{ locator: import('../shared/types.js').Locator; matches: number; target?: ResolvedTargetInfo }> {
  const spec = parseTargetSpec(target);
  if (!spec) throw new Error('BAD_REQUEST: 无法解析 target: ' + target);
  if (spec.kind === 'index') {
    const mapped = deps.resolveRef?.(spec.index);
    if (!mapped) throw new InvalidRefError('ref [' + spec.index + '] 不存在/已失效/跨页');
    const locator = mapped.identity ? candidateToLocator(mapped.identity.candidate) : undefined;
    if (!locator) throw new Error('INSUFFICIENT_EVIDENCE: ref [' + spec.index + '] 无已验证身份，不能生成可回放 locator');
    return { locator, matches: 1 };
  }
  if (spec.kind === 'css') {
    const locator = target.startsWith('testid=') ? { testid: target.slice(7) } as const : { css: spec.selector } as const;
    return { locator, matches: (await queryLocator(deps.cdp, locator, true)).matches };
  }
  if (target.startsWith('role=')) {
    const rest = target.slice(5);
    const colon = rest.indexOf(':');
    const locator = { role: colon >= 0 ? rest.slice(0, colon) : rest, ...(colon >= 0 ? { name: rest.slice(colon + 1) } : {}) };
    return { locator, matches: (await queryLocator(deps.cdp, locator, true)).matches };
  }
  if (target.startsWith('label=')) {
    const locator = { label: target.slice(6) };
    return { locator, matches: (await queryLocator(deps.cdp, locator, true)).matches };
  }
  if (target.startsWith('text=')) {
    const locator = { text: target.slice(5), normalize: true };
    return { locator, matches: (await queryLocator(deps.cdp, locator, true)).matches };
  }
  const ps = await collectPageState(deps.cdp);
  const r = await resolveTargetForAssert(deps.cdp, target, ps, deps.resolveRef);
  if (!r) throw new TargetNotFoundError(`目标未命中: ${target}`);
  const targetInfo: ResolvedTargetInfo = {
    backendNodeId: r.backendNodeId, role: r.role ?? '', name: r.name ?? '',
    resolved_by: r.matchedBy ?? 'ax', ...(r.matches !== undefined ? { matches: r.matches } : {}),
  };
  const cands = await collectCandidates(ps, targetInfo, r.matchedBy ?? 'ax', deps.cdp);
  if (cands.length > 0) targetInfo.candidates = cands;
  const locator = cands.find((c) => c.matches === 1) ? candidateToLocator(cands.find((c) => c.matches === 1)!) : undefined;
  if (!locator) throw new Error('INSUFFICIENT_EVIDENCE: 目标没有唯一 canonical locator，不能生成可回放断言');
  return { locator, matches: r.matches ?? 1, target: targetInfo };
}

/** assert style：读取计算样式（可选伪元素）；默认唯一目标，--all 才逐个核对。 */
export async function assertStyle(
  deps: AssertDeps,
  target: string,
  input: { property: string; equals: string; pseudo?: 'before' | 'after'; all?: boolean },
): Promise<AssertResult> {
  const { locator, matches, target: targetInfo } = await resolveAssertLocator(deps, target);
  const mapper = `(elements) => elements.map((el) => (${readComputedStyle.toString()})(el, { property: ${JSON.stringify(input.property)},${input.pseudo ? ` pseudo: ${JSON.stringify(input.pseudo)},` : ''} }))`;
  const values = await mapLocatorElements<string[]>(deps.cdp, locator, mapper);
  const applicable = input.all === true ? values : matches === 1 ? values.slice(0, 1) : [];
  const pass = matches > 0 && values.length === matches
    && (input.all === true ? applicable.every((v) => v === input.equals) : matches === 1 && values[0] === input.equals);
  return {
    kind: 'style',
    expect: {
      locator, property: input.property, equals: input.equals,
      ...(input.pseudo ? { pseudo: input.pseudo } : {}),
      ...(input.all === true ? { all: true } : {}),
    },
    actual: { matches: values.length, values },
    pass,
    evidence: [{ matches: values.length, ...(pass ? {} : { values }) }],
    ...(targetInfo ? { target: targetInfo } : {}),
  };
}

/** assert element：标准 DOM 属性或 count；count 统计全部匹配且可为 0。 */
export async function assertElement(
  deps: AssertDeps,
  target: string,
  input: { property: string; op: AssertOp; value: unknown; all?: boolean },
): Promise<AssertResult> {
  if (input.property !== 'count' && !(ELEMENT_PROPERTIES as readonly string[]).includes(input.property)) {
    throw new Error('BAD_REQUEST: 不支持的标准属性: ' + input.property);
  }
  const { locator, matches, target: targetInfo } = await resolveAssertLocator(deps, target);
  if (input.property === 'count') {
    const pass = compare(input.op, matches, input.value);
    return {
      kind: 'element',
      expect: { locator, property: 'count', op: input.op, value: input.value },
      actual: { matches },
      pass,
      evidence: pass ? [] : [{ matches }],
      ...(targetInfo ? { target: targetInfo } : {}),
    };
  }
  const mapper = `(elements) => elements.map((el) => (${readElementProperty.toString()})(el, ${JSON.stringify(input.property)}))`;
  const values = await mapLocatorElements<Array<string | number | boolean>>(deps.cdp, locator, mapper);
  const applicable = input.all === true ? values : matches === 1 ? values.slice(0, 1) : [];
  const pass = matches > 0 && values.length === matches
    && (input.all === true ? applicable.every((v) => compare(input.op, v, input.value)) : matches === 1 && compare(input.op, values[0], input.value));
  return {
    kind: 'element',
    expect: { locator, property: input.property, op: input.op, value: input.value, ...(input.all === true ? { all: true } : {}) },
    actual: { matches: values.length, values },
    pass,
    evidence: [{ matches: values.length, ...(pass ? {} : { values }) }],
    ...(targetInfo ? { target: targetInfo } : {}),
  };
}

/** page inspect：只产诊断候选；within 必须唯一命中，否则拒绝而不是扫错范围。 */
export async function inspectUi(
  deps: AssertDeps,
  check: 'text-artifacts' | 'i18n' | 'overflow' | 'broken-images' | 'error-exposure',
  within?: string,
): Promise<UiScanResult> {
  if (within) {
    const { locator, matches } = await resolveAssertLocator(deps, within);
    if (matches !== 1) throw new Error(`BAD_REQUEST: --within 命中 ${matches} 个节点，诊断范围必须唯一`);
    const result = await mapLocatorElements<UiScanResult | null>(
      deps.cdp,
      locator,
      `(elements) => elements.length === 1 ? (${scanUi.toString()})(elements[0], ${JSON.stringify(check)}) : null`,
    );
    if (!result) throw new Error('READ_UNAVAILABLE: --within 诊断根元素读取失败');
    return result;
  }
  return await deps.cdp.evaluate<UiScanResult>(`(${scanUi.toString()})(document.documentElement, ${JSON.stringify(check)})`);
}
