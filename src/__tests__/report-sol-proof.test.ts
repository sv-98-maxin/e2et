import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { appendTraceEvent, ensurePrivateDir, storeTraceBody } from '../daemon/trace.js';
import { dispatch } from '../cli/router.js';
import { renderReportHtml, type ReportData } from '../shared/report-render.js';
import { buildReport, type StepOutcome } from '../../runtime_assets/runtime/report.js';
import type { IRv2, Step } from '../../runtime_assets/runtime/types.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

/**
 * 反例取自 review-r2-sol-proof-wf2Yr7：真实生产结构（NetworkTrace.beginAction/finishAction
 * 写的 action、captureApi 真实 from 结构、显式 group、断言失败、多接口）。
 * 这些测试证明修复后不再假绿。
 */
describe('report 真实判定回归（review-r2 反例）', () => {
  let home: string;
  let previousHome: string | undefined;
  let seq = 0;
  beforeEach(() => {
    previousHome = process.env.E2ET_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'sol-proof-'));
    process.env.E2ET_HOME = home;
  });
  afterEach(() => {
    if (previousHome === undefined) delete process.env.E2ET_HOME;
    else process.env.E2ET_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  function sid(): string {
    seq++;
    const id = `sol-${seq}`;
    appendTraceEvent(id, { t: 'session', env: 'pre', tool_version: 'test' });
    appendTraceEvent(id, { t: 'navigation', nav: 'n1', to: 'https://example.test/' });
    return id;
  }
  function shot(id: string, name: string): string {
    const dir = path.join(home, 'workspace', 'screenshots');
    ensurePrivateDir(dir, true);
    const file = path.join(dir, `${id}_${name}.png`);
    fs.writeFileSync(file, Buffer.from(PNG, 'base64'), { mode: 0o600 });
    return file;
  }
  function blob(id: string, json: string): string {
    return storeTraceBody(id, json, 'application/json').ref;
  }
  async function report(id: string, args: string[] = []): Promise<{ html: string; json: any }> {
    appendTraceEvent(id, { t: 'session_end', result: 'pass' });
    appendTraceEvent(id, { t: 'session_end', result: 'pass' });
    const stdout: string[] = [];
    expect(await dispatch(['report', '-s', id, ...args], {
      env: process.env, stdout: s => stdout.push(s), stderr: () => {},
    })).toBe(0);
    const out = JSON.parse(stdout.join(''));
    return {
      html: fs.readFileSync(out.data.html, 'utf8'),
      json: JSON.parse(fs.readFileSync(out.data.json, 'utf8')),
    };
  }
  function renderData(overrides: Partial<ReportData> = {}): ReportData {
    return {
      title: '净含量验证',
      url: 'https://example.test/page',
      env: 'pre',
      result: 'PASS',
      summary: '1/1 业务步骤通过；已覆盖 1 条断言，1 条通过；未提供覆盖计划，仅代表已执行断言，不能证明完整需求覆盖',
      sessionId: 'render-test',
      toolVersion: 'test',
      mocked: false,
      coverage: { plan: null, executed: ['验证净含量'], missing: [], unplanned: [] },
      cases: [{
        id: 'TC-01',
        name: '净含量验证',
        result: 'PASS',
        steps: [{
          index: 1,
          status: 'pass',
          action: '验证净含量',
          observation: '接口字段通过',
          duration: '10ms',
          assertions: [{ kind: 'text', expect: { contains: '净含量' }, actual: '净含量', pass: true }],
        }],
      }],
      ...overrides,
    };
  }

  // finding 1: A(断言通过) → B(断言通过) → A(执行失败)，plan ["A","B"] 不能变 PASS
  it('plan 不投影删除后续执行失败（FAIL 保持 FAIL）', async () => {
    const id = sid();
    const sp = shot(id, 'a1');
    appendTraceEvent(id, { t: 'action', id: 'a1', ts: 1, ts_end: 2, kind: 'click', intent: '动作-A', group: 'A', result: { ok: true }, requests: [], screenshot_path: sp });
    appendTraceEvent(id, { t: 'assert', after: 'a1', kind: 'text', expect: { contains: '实测文案' }, actual: '实测文案', pass: true, evidence: [] });
    appendTraceEvent(id, { t: 'action', id: 'a2', ts: 3, ts_end: 4, kind: 'click', intent: '动作-B', group: 'B', result: { ok: true }, requests: [] });
    appendTraceEvent(id, { t: 'assert', after: 'a2', kind: 'text', expect: { contains: '实测文案' }, actual: '实测文案', pass: true, evidence: [] });
    const sp3 = shot(id, 'a3');
    appendTraceEvent(id, { t: 'action', id: 'a3', ts: 5, ts_end: 6, kind: 'click', intent: '动作-A', group: 'A', result: { ok: false }, requests: [], screenshot_path: sp3 });
    const plan = path.join(home, 'plan.json');
    fs.writeFileSync(plan, JSON.stringify(['A', 'B']));
    const { json } = await report(id, ['--plan', plan]);
    expect(json.conclusion).toBe('FAIL');
    // A 的失败事实必须可见，不被裁成 pass
    expect(JSON.stringify(json.cases[0].steps)).toContain('"fail"');
  });

  // finding 1: 计划外已执行失败不被裁掉
  it('计划外已执行失败保留并标记（不被 plan 删除）', async () => {
    const id = sid();
    const sp = shot(id, 'a1');
    appendTraceEvent(id, { t: 'action', id: 'a1', ts: 1, ts_end: 2, kind: 'click', intent: '动作-A', group: 'A', result: { ok: true }, requests: [], screenshot_path: sp });
    appendTraceEvent(id, { t: 'assert', after: 'a1', kind: 'text', expect: { contains: '实测文案' }, actual: '实测文案', pass: true, evidence: [] });
    appendTraceEvent(id, { t: 'action', id: 'a2', ts: 3, ts_end: 4, kind: 'click', intent: '动作-extra', group: 'extra-business', result: { ok: false }, requests: [] });
    const plan = path.join(home, 'plan.json');
    fs.writeFileSync(plan, JSON.stringify(['A']));
    const { json, html } = await report(id, ['--plan', plan]);
    expect(json.conclusion).toBe('FAIL');
    // extra-business 仍在，标「计划外已执行」
    expect(html).toContain('计划外已执行');
  });

  // finding 2: group A 执行失败无 assert，plan ["A"] 不能变 BLOCKED 洗掉失败
  it('无断言执行失败不被 plan 改成 BLOCKED 隐藏失败', async () => {
    const id = sid();
    const sp = shot(id, 'a1');
    appendTraceEvent(id, { t: 'action', id: 'a1', ts: 1, ts_end: 2, kind: 'click', intent: '动作-A', group: 'A', result: { ok: false }, requests: [], screenshot_path: sp });
    const plan = path.join(home, 'plan.json');
    fs.writeFileSync(plan, JSON.stringify(['A']));
    const { json, html } = await report(id, ['--plan', plan]);
    expect(json.conclusion).toBe('FAIL');
    expect(html).toContain('动作执行失败');
  });

  // finding 4: action group=A，assert 显式 group=B，B 不被吞进 A
  it('assert 显式 group B（action group A）B 独立成组不丢', async () => {
    const id = sid();
    const sp = shot(id, 'a1');
    appendTraceEvent(id, { t: 'action', id: 'a1', ts: 1, ts_end: 2, kind: 'click', intent: '动作-A', group: 'A', result: { ok: true }, requests: [], screenshot_path: sp });
    appendTraceEvent(id, { t: 'assert', after: 'a1', kind: 'text', expect: { contains: '实测文案' }, actual: '实测文案', pass: true, evidence: [] });
    appendTraceEvent(id, { t: 'assert', after: 'a1', kind: 'text', expect: { contains: '实测文案' }, actual: '实测文案', pass: true, evidence: [], group: 'B' });
    const spA = shot(id, 'a');
    const spB = shot(id, 'b');
    appendTraceEvent(id, { t: 'screenshot', after: 'a1', group: 'A', path: spA });
    appendTraceEvent(id, { t: 'screenshot', after: 'a1', group: 'B', path: spB });
    const plan = path.join(home, 'plan.json');
    fs.writeFileSync(plan, JSON.stringify(['A', 'B']));
    const { json, html } = await report(id, ['--plan', plan]);
    // B 有 assert 通过且完成态截图 → 不该报「未执行」
    expect(json.conclusion).toBe('PASS');
    // B 不被报「未执行」
    expect(html).not.toContain('未执行');
  });

  // finding 4: 一个无 group execute 后 A、B 两个独立断言组
  it('单 action 后两个独立显式断言组各自保留', async () => {
    const id = sid();
    appendTraceEvent(id, { t: 'action', id: 'a1', ts: 1, ts_end: 2, kind: 'execute', intent: '探查', result: { ok: true }, requests: [] });
    appendTraceEvent(id, { t: 'assert', after: 'a1', kind: 'text', expect: { contains: '实测文案' }, actual: '实测文案', pass: true, evidence: [], group: 'A' });
    appendTraceEvent(id, { t: 'assert', after: 'a1', kind: 'text', expect: { contains: '实测文案' }, actual: '实测文案', pass: true, evidence: [], group: 'B' });
    const plan = path.join(home, 'plan.json');
    fs.writeFileSync(plan, JSON.stringify(['A', 'B']));
    const { json, html } = await report(id, ['--plan', plan]);
    // B 有 assert 通过且 A 也通过，但缺断言后完成态截图 → BLOCKED（finding 8），不被报「未执行」
    expect(json.conclusion).toBe('BLOCKED');
    expect(html).not.toContain('未执行');
  });

  // finding 5: capture.api 真实 from {path,nav,call_index,req_id}，report 消费 req_id
  it('capture.api from.req_id 消费，展示对应 API 与 traceId', async () => {
    const id = sid();
    const ref1 = blob(id, '{"data":{"tip":"r2"}}');
    appendTraceEvent(id, { t: 'request', id: 'r2', path: '/tip.json', nav: 'n2', call_index: 2, method: 'GET', url: 'https://example.test/tip.json', status: 200, resource_type: 'XHR', resp_headers: { 'Content-Type': 'application/json', 'Eagleeye-Traceid': 'trace-r2' }, resp_body_ref: ref1 });
    const sp = shot(id, 'a1');
    appendTraceEvent(id, { t: 'action', id: 'a1', ts: 1, ts_end: 2, kind: 'click', intent: '动作-A', group: 'A', result: { ok: true }, requests: [], screenshot_path: sp });
    appendTraceEvent(id, { t: 'assert', after: 'a1', kind: 'text', expect: { contains: 'r2' }, actual: 'r2', pass: true, evidence: [] });
    appendTraceEvent(id, { t: 'capture', after: 'a1', as: 'tipText', value: 'r2', lineage: 'queried', from: { path: '/tip.json', nav: 'n2', call_index: 2, req_id: 'r2' }, group: 'A' });
    const { html } = await report(id);
    expect(html).toContain('https://example.test/tip.json');
    expect(html).toContain('trace-r2');
  });

  // P1 报告默认策略去业务化：CDN/供应商 host 不再一刀切过滤，敏感词走 pathname 通用安全保护
  it('CDN 样式 host 上的 JSON XHR 出现在报告（不再按供应商 host 过滤）', async () => {
    const id = sid();
    const ref = blob(id, '{"data":{"tip":"cdn-json"}}');
    appendTraceEvent(id, { t: 'request', id: 'r1', path: '/api/list.json', nav: 'n1', call_index: 1, method: 'GET', url: 'https://cdn.example-assets.test/api/list.json', status: 200, resource_type: 'XHR', resp_headers: { 'Content-Type': 'application/json', 'Eagleeye-Traceid': 'trace-cdn' }, resp_body_ref: ref });
    const sp = shot(id, 'a1');
    appendTraceEvent(id, { t: 'action', id: 'a1', ts: 1, ts_end: 2, kind: 'click', intent: '动作-A', group: 'A', result: { ok: true }, requests: [], screenshot_path: sp });
    appendTraceEvent(id, { t: 'assert', after: 'a1', kind: 'api', expect: { path: 'data.tip', op: '==', value: 'cdn-json' }, actual: 'cdn-json', pass: true, evidence: [{ req_id: 'r1' }] });
    const { html } = await report(id);
    expect(html).toContain('https://cdn.example-assets.test/api/list.json');
    expect(html).toContain('cdn-json');
  });

  it('敏感路径（token/cookie/secret 等通用安全词）不展开 body 进报告', async () => {
    const id = sid();
    // sentinel 只存在于请求/响应 blob；assert 只核对非敏感的一般状态（ok=true）
    const reqRef = blob(id, '{"grant":"ticket","note":"SENSITIVE_REQ_BODY_777"}');
    const respRef = blob(id, '{"ok":true,"secret":"SENSITIVE_TOKEN_VALUE_999"}');
    appendTraceEvent(id, { t: 'request', id: 'r1', path: '/api/session/token.json', nav: 'n1', call_index: 1, method: 'POST', url: 'https://any-host.example.test/api/session/token.json', status: 200, resource_type: 'XHR', resp_headers: { 'Content-Type': 'application/json' }, req_body_ref: reqRef, resp_body_ref: respRef });
    const sp = shot(id, 'a1');
    appendTraceEvent(id, { t: 'action', id: 'a1', ts: 1, ts_end: 2, kind: 'click', intent: '动作-A', group: 'A', result: { ok: true }, requests: [], screenshot_path: sp });
    appendTraceEvent(id, { t: 'assert', after: 'a1', kind: 'api', expect: { path: 'ok', op: '==', value: true }, actual: true, pass: true, evidence: [{ req_id: 'r1' }] });
    const { html } = await report(id);
    // 敏感路径在 buildApis 读 body 前被拒：请求/响应 body 与 URL 都不进报告（全 HTML 不含 sentinel）
    expect(html).not.toContain('SENSITIVE_TOKEN_VALUE_999');
    expect(html).not.toContain('SENSITIVE_REQ_BODY_777');
    expect(html).not.toContain('/api/session/token.json');
  });

  it('query 参数中的普通文案不当敏感端点（pathname 才匹配）', async () => {
    const id = sid();
    const ref = blob(id, '{"data":{"tip":"ok-token-in-query"}}');
    // pathname /api/list.json 无敏感词；query 里带 token= 文案
    appendTraceEvent(id, { t: 'request', id: 'r1', path: '/api/list.json', nav: 'n1', call_index: 1, method: 'GET', url: 'https://example.test/api/list.json?token=ordinary', status: 200, resource_type: 'XHR', resp_headers: { 'Content-Type': 'application/json' }, resp_body_ref: ref });
    const sp = shot(id, 'a1');
    appendTraceEvent(id, { t: 'action', id: 'a1', ts: 1, ts_end: 2, kind: 'click', intent: '动作-A', group: 'A', result: { ok: true }, requests: [], screenshot_path: sp });
    appendTraceEvent(id, { t: 'assert', after: 'a1', kind: 'api', expect: { path: 'data.tip', op: '==', value: 'ok-token-in-query' }, actual: 'ok-token-in-query', pass: true, evidence: [{ req_id: 'r1' }] });
    const { html } = await report(id);
    expect(html).toContain('https://example.test/api/list.json');
    expect(html).toContain('ok-token-in-query');
  });

  // finding 6: 自动等待 settled_by.request 不当显式 API；sessionSecret 不冒充业务接口
  it('自动等待 request 不作 API 引用，sessionSecret 不进报告', async () => {
    const id = sid();
    const ref = blob(id, '{"token":"secret"}');
    appendTraceEvent(id, { t: 'request', id: 'r1', path: '/sessionSecret.json', nav: 'n1', call_index: 1, method: 'GET', url: 'https://example.test/sessionSecret.json', status: 200, resource_type: 'XHR', resp_headers: { 'Content-Type': 'application/json' }, resp_body_ref: ref });
    const sp = shot(id, 'a1');
    appendTraceEvent(id, { t: 'action', id: 'a1', ts: 1, ts_end: 2, kind: 'click', intent: '动作-A', group: 'A', result: { ok: true }, requests: [], settled_by: [{ kind: 'request', ref: 'r1', ms: 1 }], screenshot_path: sp });
    appendTraceEvent(id, { t: 'assert', after: 'a1', kind: 'text', expect: { contains: '实测文案' }, actual: '实测文案', pass: true, evidence: [] });
    const { html } = await report(id);
    expect(html).not.toContain('sessionSecret');
  });

  // BUG 2: observation api 大串截断（actual 是大数组不 dump 3000 字）
  it('api actual 超 200 字截断 observation', async () => {
    const id = sid();
    const bigArray = Array.from({ length: 300 }, (_, i) => ({ id: i, name: `catProperty${i}` }));
    const sp = shot(id, 'a1');
    appendTraceEvent(id, { t: 'action', id: 'a1', ts: 1, ts_end: 2, kind: 'click', intent: '动作-A', group: 'A', result: { ok: true }, requests: [], screenshot_path: sp });
    appendTraceEvent(id, { t: 'assert', after: 'a1', kind: 'api', pass: true, expect: { path: 'data.list', op: 'exists', value: null }, actual: bigArray, evidence: [] });
    const spDone = shot(id, 'done');
    appendTraceEvent(id, { t: 'screenshot', after: 'a1', group: 'A', path: spDone });
    const { html } = await report(id);
    // 断言表的实际值单元格截断，不把 300 个 catProperty 全 dump 到主体
    const actualMatch = html.match(/<td class="assert-actual">([^<]*)<\/td>/);
    expect(actualMatch).toBeTruthy();
    expect(actualMatch![1]).toContain('…');
    expect(actualMatch![1]).not.toContain('catProperty250');
  });

  // finding 7: 同组两个显式接口都渲染
  it('同组两个显式 assert api 都渲染，不丢第二个', async () => {
    const id = sid();
    const ref1 = blob(id, '{"data":{"tip":"r1"}}');
    const ref2 = blob(id, '{"data":{"tip":"r2"}}');
    appendTraceEvent(id, { t: 'request', id: 'r1', path: '/one.json', nav: 'n1', call_index: 1, method: 'GET', url: 'https://example.test/one.json', status: 200, resource_type: 'XHR', resp_headers: { 'Content-Type': 'application/json', 'Eagleeye-Traceid': 'trace-r1' }, resp_body_ref: ref1 });
    appendTraceEvent(id, { t: 'request', id: 'r2', path: '/two.json', nav: 'n1', call_index: 1, method: 'GET', url: 'https://example.test/two.json', status: 200, resource_type: 'XHR', resp_headers: { 'Content-Type': 'application/json', 'Eagleeye-Traceid': 'trace-r2' }, resp_body_ref: ref2 });
    const sp = shot(id, 'a1');
    appendTraceEvent(id, { t: 'action', id: 'a1', ts: 1, ts_end: 2, kind: 'click', intent: '动作-A', group: 'A', result: { ok: true }, requests: [], screenshot_path: sp });
    appendTraceEvent(id, { t: 'assert', after: 'a1', kind: 'api', pass: true, expect: { path: 'data.tip', op: '==', value: 'r1' }, actual: 'r1', evidence: [{ req_id: 'r1' }] });
    appendTraceEvent(id, { t: 'assert', after: 'a1', kind: 'api', pass: true, expect: { path: 'data.tip', op: '==', value: 'r2' }, actual: 'r2', evidence: [{ req_id: 'r2' }] });
    const { html } = await report(id);
    expect(html).toContain('https://example.test/one.json');
    expect(html).toContain('https://example.test/two.json');
  });

  // finding 8: assert 通过但截图失败，不 PASS（BLOCKED），截图报错可见
  it('assert 通过但截图失败 → BLOCKED，截图报错可见', async () => {
    const id = sid();
    appendTraceEvent(id, { t: 'action', id: 'a1', ts: 1, ts_end: 2, kind: 'click', intent: '动作-A', group: 'A', result: { ok: true }, requests: [], screenshot_error: '截图服务失败' });
    appendTraceEvent(id, { t: 'assert', after: 'a1', kind: 'text', expect: { contains: '实测文案' }, actual: '实测文案', pass: true, evidence: [] });
    const { json, html } = await report(id);
    expect(json.conclusion).toBe('BLOCKED');
    expect(html).toContain('截图服务失败');
  });

  // finding 8: page screenshot --group 完成态截图优先
  it('page screenshot --group 完成态截图优先于自动截图', async () => {
    const id = sid();
    const auto = shot(id, 'auto');
    appendTraceEvent(id, { t: 'action', id: 'a1', ts: 1, ts_end: 2, kind: 'fill', intent: '输入', group: 'A', result: { ok: true }, requests: [], screenshot_path: auto });
    appendTraceEvent(id, { t: 'assert', after: 'a1', kind: 'absent', expect: 'css=.tip', actual: { resolved: false }, pass: true, evidence: [] });
    const completion = shot(id, 'done');
    appendTraceEvent(id, { t: 'screenshot', after: 'a1', group: 'A', path: completion });
    const { json } = await report(id);
    expect(json.conclusion).toBe('PASS');
  });

  // finding 11: 无 group 时 capture-only 也 BLOCKED（不保留旧假绿）
  it('无 group 时 capture-only 不 PASS', async () => {
    const id = sid();
    appendTraceEvent(id, { t: 'action', id: 'a1', ts: 1, ts_end: 2, kind: 'hover', intent: '抓提示', result: { ok: true }, requests: [] });
    appendTraceEvent(id, { t: 'capture', after: 'a1', as: 'tipText', value: '实际值', lineage: 'queried', from: { target: 'css=.tip' } });
    appendTraceEvent(id, { t: 'action', id: 'a2', ts: 3, ts_end: 4, kind: 'fill', intent: '填字段', result: { ok: true }, requests: [] });
    appendTraceEvent(id, { t: 'assert', after: 'a2', kind: 'text', pass: true, actual: '实际值', expect: { contains: '实际值' } });
    const { json } = await report(id);
    expect(json.conclusion).toBe('BLOCKED');
  });

  // finding 12: 附录诊断失败不改写业务结论
  it('诊断 assert 失败进附录，不改写业务结论', async () => {
    const id = sid();
    const sp = shot(id, 'a1');
    appendTraceEvent(id, { t: 'action', id: 'a1', ts: 1, ts_end: 2, kind: 'click', intent: '动作-A', group: 'A', result: { ok: true }, requests: [], screenshot_path: sp });
    appendTraceEvent(id, { t: 'assert', after: 'a1', kind: 'text', expect: { contains: '实测文案' }, actual: '实测文案', pass: true, evidence: [] });
    const spA = shot(id, 'done');
    appendTraceEvent(id, { t: 'screenshot', after: 'a1', group: 'A', path: spA });
    appendTraceEvent(id, { t: 'action', id: 'a2', ts: 3, ts_end: 4, kind: 'click', intent: '诊断', result: { ok: true }, requests: [] });
    appendTraceEvent(id, { t: 'assert', after: 'a2', kind: 'text', expect: { contains: '不存在' }, actual: '', pass: false, evidence: [] });
    const plan = path.join(home, 'plan.json');
    fs.writeFileSync(plan, JSON.stringify(['A']));
    const { json, html } = await report(id, ['--plan', plan]);
    // 业务 A 完整通过 → PASS，诊断失败进附录不升级为 FAIL（finding 12）
    expect(json.conclusion).toBe('PASS');
  });

  // finding 14: backendInfo 从失败 api assert 自动组装
  it('API 字段断言失败生成 backendInfo', async () => {
    const id = sid();
    const ref = blob(id, '{"data":{"tip":"actual"}}');
    appendTraceEvent(id, { t: 'request', id: 'r1', path: '/fail.json', nav: 'n1', call_index: 1, method: 'GET', url: 'https://example.test/fail.json', status: 200, resource_type: 'XHR', resp_headers: { 'Content-Type': 'application/json', 'Eagleeye-Traceid': 'trace-r1' }, resp_body_ref: ref });
    appendTraceEvent(id, { t: 'action', id: 'a1', ts: 1, ts_end: 2, kind: 'click', intent: '动作-A', group: 'A', result: { ok: true }, requests: [] });
    appendTraceEvent(id, { t: 'assert', after: 'a1', kind: 'api', pass: false, expect: { path: 'data.tip', op: '==', value: 'expected' }, actual: 'actual', evidence: [{ req_id: 'r1' }] });
    const { json, html } = await report(id);
    expect(json.conclusion).toBe('FAIL');
    expect(html).not.toContain('给后端的排查信息');
    expect(html).toContain('后端失败诊断');
    expect(html).toContain('trace-r1');
    expect(html).toContain('https://example.test/fail.json');
    const diagnostics = html.match(/<details class="tech-evidence backend-diagnostics">[\s\S]*?<\/details>/);
    expect(diagnostics).toBeTruthy();
    expect(diagnostics![0]).not.toMatch(new RegExp(`^<details[^>]*\\sopen`));
    const stepHtml = html.slice(html.indexOf('<div class="step fail">'), html.indexOf('backend-diagnostics'));
    expect(stepHtml).toContain('data.tip');
    expect(stepHtml).toContain('class="code-tag code-ok">200</span>');
    expect(stepHtml).toContain('actual');
    expect(stepHtml).toContain('trace-r1');
    expect(stepHtml).toContain('https://example.test/fail.json');
    expect(stepHtml).not.toMatch(/<details class="full-response"[^>]*\sopen/);
    expect(stepHtml).not.toMatch(/<details class="headers"[^>]*\sopen/);
  });

  // finding 16: 统计不混单位
  it('summary 展示业务步骤，原子动作仅保留 JSON 统计', async () => {
    const id = sid();
    const sp = shot(id, 'a1');
    appendTraceEvent(id, { t: 'action', id: 'a1', ts: 1, ts_end: 2, kind: 'hover', intent: '抓提示', group: 'A', result: { ok: true }, requests: [], screenshot_path: sp });
    appendTraceEvent(id, { t: 'assert', after: 'a1', kind: 'text', pass: true, actual: '实际值', expect: { contains: '实际值' } });
    const sp2 = shot(id, 'a2');
    appendTraceEvent(id, { t: 'action', id: 'a2', ts: 3, ts_end: 4, kind: 'fill', intent: '填字段', group: 'A', result: { ok: true }, requests: [], screenshot_path: sp2 });
    const { json } = await report(id);
    expect(json.summary).toContain('1/1 业务步骤通过');
    expect(json.summary).not.toContain('派生结论');
    expect(json.summary).toContain('不能证明完整需求覆盖');
    expect(json.summary).not.toContain('原子动作');
    expect(json.actions).toEqual({ total: 2, success: 2 });
    expect(json.summary).not.toMatch(/2\/1/);
    expect(json.coverage).toEqual({ plan: null, executed: ['A'], missing: [], unplanned: [] });
  });

  it('覆盖计划、执行、缺失和计划外使用业务标题，不暴露内部 group', async () => {
    const id = sid();
    for (const [actionId, group, name, expectedText] of [
      ['a1', 'sprint-42548-618', 'a', '500g'],
      ['a2', 'sprint-42548-621', 'b', '750g'],
      ['a3', 'sprint-extra-624', 'extra', '计划外'],
    ] as const) {
      const sp = shot(id, actionId);
      appendTraceEvent(id, { t: 'action', id: actionId, ts: Number(actionId.slice(1)) * 3, ts_end: Number(actionId.slice(1)) * 3 + 1, kind: 'click', intent: group, group, result: { ok: true }, requests: [], screenshot_path: sp });
      appendTraceEvent(id, { t: 'assert', after: actionId, kind: 'text', expect: { contains: expectedText }, actual: expectedText, pass: true, evidence: [] });
      appendTraceEvent(id, { t: 'screenshot', after: actionId, group, path: shot(id, `${name}-done`) });
    }
    const plan = path.join(home, 'plan-titles.json');
    const titles = path.join(home, 'titles.json');
    fs.writeFileSync(plan, JSON.stringify(['sprint-42548-618', 'sprint-42548-621', 'sprint-missing-999']));
    fs.writeFileSync(titles, JSON.stringify({
      'sprint-42548-618': '验证净含量文本输入（500g）',
      'sprint-42548-621': '验证净含量文本输入（750g）',
      'sprint-missing-999': '验证审批详情',
      'sprint-extra-624': '验证计划外补充场景',
    }));
    const { json, html } = await report(id, ['--plan', plan, '--step-titles', titles]);
    expect(json.coverage).toEqual({
      plan: ['验证净含量文本输入（500g）', '验证净含量文本输入（750g）', '验证审批详情'],
      executed: ['验证净含量文本输入（500g）', '验证净含量文本输入（750g）', '验证计划外补充场景'],
      missing: ['验证审批详情'],
      unplanned: ['验证计划外补充场景'],
    });
    expect(html).toContain('验证范围与边界');
    expect(html).toContain('计划范围');
    expect(html).toContain('验证审批详情');
    expect(html).toContain('验证计划外补充场景');
    expect(html).toContain('覆盖计划缺失 1 项');
    expect(html).not.toContain('sprint-42548-618');
    expect(html).not.toContain('sprint-missing-999');
  });

  it('首屏只对 Mock、blocked、coverage missing 显示独立风险；无 plan 由覆盖区表达', () => {
    const html = renderReportHtml(renderData({
      result: 'BLOCKED',
      mocked: true,
      coverage: { plan: ['验证审批详情'], executed: ['验证净含量'], missing: ['验证审批详情'], unplanned: ['验证净含量'] },
      cases: [{
        id: 'TC-01',
        name: '净含量验证',
        result: 'BLOCKED',
        steps: [{
          index: 1,
          status: 'blocked',
          action: '验证净含量',
          observation: '截图缺失',
          duration: '10ms',
          assertions: [{ kind: 'text', expect: { contains: '净含量' }, actual: '净含量', pass: true }],
        }],
      }],
    }));
    expect(html).toContain('Mock 结果不可作为真实后端落库依据');
    expect(html).toContain('存在 1 个阻塞业务步骤：验证净含量');
    expect(html).toContain('覆盖计划缺失 1 项：验证审批详情');
    expect(html).toContain('<ul class="risk-list"');
    expect(html).not.toContain('未提供覆盖计划，不能证明完整需求覆盖');

    const noPlan = renderReportHtml(renderData());
    expect(noPlan).toContain('未提供覆盖计划，仅代表已执行断言，不能证明完整需求覆盖');
    expect(noPlan).toContain('未提供覆盖计划</b><span>仅代表已执行断言，不能证明完整需求覆盖。');
    expect(noPlan).not.toContain('<ul class="risk-list"');
  });

  it('PASS 只直显断言和截图，接口与原始证据进入默认关闭的技术证据', () => {
    const html = renderReportHtml(renderData({
      cases: [{
        id: 'TC-01',
        name: '净含量验证',
        result: 'PASS',
        steps: [{
          index: 1,
          status: 'pass',
          action: '验证净含量',
          observation: '接口字段 pass',
          duration: '10ms',
          assertions: [{ kind: 'api', expect: { path: 'data.tip', op: '==', value: '净含量' }, actual: '净含量', pass: true, evidence: [{ req_id: 'r1' }] }],
          apis: [{
            reqId: 'r1',
            method: 'POST',
            path: '/api/item.json',
            url: 'https://example.test/api/item.json?token=raw',
            status: '200',
            reqBody: '{"name":"净含量"}',
            respBody: '{"data":{"tip":"净含量","extra":1},"success":true}',
            respHeaders: 'Eagleeye-Traceid: trace-pass',
            traceId: 'trace-pass',
          }],
          screenshot: `data:image/png;base64,${PNG}`,
          assertDetails: ['api；期望：净含量；实际：净含量'],
          evidence: 'NETWORK_RAW_SENTINEL',
          executeResult: { json: 'EXECUTE_RESULT_SENTINEL' },
        }],
        backendInfo: {
          api: 'https://example.test/backend-info',
          traceId: 'backend-trace',
          time: '2026-11-08T00:00:00.000Z',
          failure: 'BACKEND_FAILURE_SENTINEL',
          response: '{"backend":"response"}',
          params: '{"backend":"params"}',
        },
      }],
      coverage: { plan: ['验证净含量'], executed: ['验证净含量'], missing: [], unplanned: [] },
    }));
    const stepStart = html.indexOf('<div class="step pass">');
    const techStart = html.indexOf('<details class="tech-evidence">', stepStart);
    expect(stepStart).toBeGreaterThan(-1);
    expect(techStart).toBeGreaterThan(stepStart);
    const firstScreen = html.slice(stepStart, techStart);
    expect(firstScreen).toContain('class="assert-table"');
    expect(firstScreen).toContain('class="shot"');
    expect(firstScreen).not.toContain('class="method"');
    expect(firstScreen).not.toContain('/api/item.json');
    expect(firstScreen).not.toContain('HTTP 200');
    expect(html).not.toContain('class="risk-list"');
    const tech = html.slice(techStart);
    expect(tech).not.toMatch(new RegExp(`^<details[^>]*\\sopen`));
    expect(tech).toContain('技术证据 · 1 个接口');
    expect(tech).toContain('POST');
    expect(tech).toContain('/api/item.json');
    expect(tech).toContain('class="json-response-tree"');
    expect(tech).toContain('{…} · 2项');
    expect(tech).toContain('<details class="response-source"><summary>响应原文</summary>');
    expect(tech).toContain('<details class="headers"><summary>响应头');
    expect(tech).toContain('<details class="full-response"><summary>完整 URL</summary>');
    expect(tech).toContain('观察证据（原始）');
    expect(tech).toContain('NETWORK_RAW_SENTINEL');
    expect(tech).not.toContain('完整验证事实');
    expect(html).not.toContain('EXECUTE_RESULT_SENTINEL');
    expect(html).not.toContain('后端失败诊断');
    expect(html).not.toContain('BACKEND_FAILURE_SENTINEL');
    expect(html).toContain('.step.pass .shot { width: 100%; height: 480px; max-height: 480px; object-fit: cover; object-position: top; }');
    expect(html).not.toContain('.step.fail .shot {');
    expect(html).not.toContain('.step.blocked .shot {');
  });

  it('非 JSON 响应保留原文，旧报告无 assertions 时 observation 仍可见', () => {
    const html = renderReportHtml(renderData({
      cases: [{
        id: 'TC-01',
        name: '旧报告',
        result: 'BLOCKED',
        steps: [{
          index: 1,
          status: 'blocked',
          action: '旧步骤',
          observation: '旧报告观察事实',
          duration: '10ms',
          apis: [{
            method: 'GET',
            path: '/legacy.txt',
            url: 'https://example.test/legacy.txt',
            status: '200',
            respBody: 'plain text response',
          }],
        }],
      }],
      result: 'BLOCKED',
      coverage: { plan: null, executed: ['旧步骤'], missing: [], unplanned: [] },
    }));
    expect(html).toContain('<div class="step-obs">旧报告观察事实</div>');
    expect(html).not.toContain('class="assert-table"');
    expect(html).toContain('plain text response');
    expect(html).not.toContain('class="json-response-tree"');
  });

  it('runtime replay 不伪造覆盖计划，executed 使用 IR step 业务标题', () => {
    const step: Step = {
      id: 'step-1',
      intent: '验证净含量输入',
      action: 'click',
      trace_ref: 'trace:1',
    };
    const ir: IRv2 = {
      schema_version: 3,
      name: '净含量回放',
      url: 'https://example.test/page',
      covered_pages: ['/page'],
      env: 'pre',
      provenance: {
        session_id: 'runtime-test',
        auth_source: 'profile',
        browser_source: 'managed',
        tool_version: 'test',
        generated_at: '2026-11-08T00:00:00.000Z',
        mocked: false,
      },
      steps: [step],
    };
    const outcome: StepOutcome = {
      step,
      status: 'pass',
      durationMs: 1,
      apis: [],
      assertions: [],
      captures: [],
    };
    const data = buildReport(ir, [outcome]);
    expect(data.coverage).toEqual({
      plan: null,
      executed: ['验证净含量输入'],
      missing: [],
      unplanned: [],
    });
    expect(data.summary).not.toContain('派生结论');
    expect(data.summary).toContain('未提供覆盖计划');
  });

  // finding 17: plan 非字符串元素拒绝
  it.each([123, {}, true, ' '])('plan 非字符串/空白元素 %s 拒绝', async (el) => {
    const id = sid();
    const plan = path.join(home, 'plan.json');
    fs.writeFileSync(plan, JSON.stringify([el]));
    const stdout: string[] = [];
    const code = await dispatch(['report', '-s', id, '--plan', plan], {
      env: process.env, stdout: s => stdout.push(s), stderr: () => {},
    });
    expect(code).toBe(2);
    expect(stdout.join('')).toContain('字符串');
  });

  it('plan 重复/空/非数组拒绝', async () => {
    const id = sid();
    const plan = path.join(home, 'plan.json');
    fs.writeFileSync(plan, JSON.stringify(['A', 'A']));
    const stdout: string[] = [];
    expect(await dispatch(['report', '-s', id, '--plan', plan], { env: process.env, stdout: s => stdout.push(s), stderr: () => {} })).toBe(2);
    expect(stdout.join('')).toContain('重复');
    stdout.length = 0;
    fs.writeFileSync(plan, JSON.stringify([]));
    expect(await dispatch(['report', '-s', id, '--plan', plan], { env: process.env, stdout: s => stdout.push(s), stderr: () => {} })).toBe(2);
    expect(stdout.join('')).toContain('空');
    stdout.length = 0;
    fs.writeFileSync(plan, JSON.stringify({ not: 'array' }));
    expect(await dispatch(['report', '-s', id, '--plan', plan], { env: process.env, stdout: s => stdout.push(s), stderr: () => {} })).toBe(2);
    expect(stdout.join('')).toContain('数组');
  });

  // ── traceId 条件渲染 ──

  it('PASS 步骤 + 200 接口有 traceId → 不展示 trace-box', async () => {
    const id = sid();
    const ref = blob(id, '{"data":{"tip":"ok"}}');
    appendTraceEvent(id, { t: 'request', id: 'r1', path: '/ok.json', nav: 'n1', call_index: 1, method: 'GET', url: 'https://example.test/ok.json', status: 200, resource_type: 'XHR', resp_headers: { 'Content-Type': 'application/json', 'Eagleeye-Traceid': 'trace-pass-200' }, resp_body_ref: ref });
    const sp = shot(id, 'a1');
    appendTraceEvent(id, { t: 'action', id: 'a1', ts: 1, ts_end: 2, kind: 'click', intent: '动作-A', group: 'A', result: { ok: true }, requests: [], screenshot_path: sp });
    appendTraceEvent(id, { t: 'assert', after: 'a1', kind: 'api', pass: true, expect: { path: 'data.tip', op: '==', value: 'ok' }, actual: 'ok', evidence: [{ req_id: 'r1' }] });
    const { html } = await report(id);
    expect(html).not.toContain('class="trace-box"');
    // traceId 仍在可折叠的 headers 里
    expect(html).toContain('trace-pass-200');
  });

  it('FAIL 步骤 + 200 接口有 traceId → 展示 trace-box', async () => {
    const id = sid();
    const ref = blob(id, '{"data":{"tip":"actual"}}');
    appendTraceEvent(id, { t: 'request', id: 'r1', path: '/fail.json', nav: 'n1', call_index: 1, method: 'GET', url: 'https://example.test/fail.json', status: 200, resource_type: 'XHR', resp_headers: { 'Content-Type': 'application/json', 'Eagleeye-Traceid': 'trace-fail-200' }, resp_body_ref: ref });
    const sp = shot(id, 'a1');
    appendTraceEvent(id, { t: 'action', id: 'a1', ts: 1, ts_end: 2, kind: 'click', intent: '动作-A', group: 'A', result: { ok: true }, requests: [], screenshot_path: sp });
    appendTraceEvent(id, { t: 'assert', after: 'a1', kind: 'api', pass: false, expect: { path: 'data.tip', op: '==', value: 'expected' }, actual: 'actual', evidence: [{ req_id: 'r1' }] });
    const { html } = await report(id);
    expect(html).toContain('class="trace-box"');
    expect(html).toContain('trace-fail-200');
  });

  it('PASS 步骤 + 500 接口有 traceId → 展示 trace-box', async () => {
    const id = sid();
    const ref = blob(id, '{"error":"internal"}');
    appendTraceEvent(id, { t: 'request', id: 'r1', path: '/err.json', nav: 'n1', call_index: 1, method: 'GET', url: 'https://example.test/err.json', status: 500, resource_type: 'XHR', resp_headers: { 'Content-Type': 'application/json', 'Eagleeye-Traceid': 'trace-err-500' }, resp_body_ref: ref });
    const sp = shot(id, 'a1');
    appendTraceEvent(id, { t: 'action', id: 'a1', ts: 1, ts_end: 2, kind: 'click', intent: '动作-A', group: 'A', result: { ok: true }, requests: [], screenshot_path: sp });
    // api assert 引用 r1，使 request 关联到步骤；步骤本身 pass（assert 通过），但 HTTP 500 仍应展示 trace-box
    appendTraceEvent(id, { t: 'assert', after: 'a1', kind: 'api', pass: true, expect: { path: 'error', op: '==', value: 'internal' }, actual: 'internal', evidence: [{ req_id: 'r1' }] });
    const { html } = await report(id);
    expect(html).toContain('class="trace-box"');
    expect(html).toContain('trace-err-500');
  });

  it('BLOCKED 步骤 + 200 接口有 traceId → 展示 trace-box', async () => {
    const id = sid();
    const ref = blob(id, '{"data":{"tip":"ok"}}');
    appendTraceEvent(id, { t: 'request', id: 'r1', path: '/ok.json', nav: 'n1', call_index: 1, method: 'GET', url: 'https://example.test/ok.json', status: 200, resource_type: 'XHR', resp_headers: { 'Content-Type': 'application/json', 'Eagleeye-Traceid': 'trace-blocked-200' }, resp_body_ref: ref });
    // 无断言后完成态截图 → BLOCKED
    appendTraceEvent(id, { t: 'action', id: 'a1', ts: 1, ts_end: 2, kind: 'click', intent: '动作-A', group: 'A', result: { ok: true }, requests: [] });
    appendTraceEvent(id, { t: 'assert', after: 'a1', kind: 'api', pass: true, expect: { path: 'data.tip', op: '==', value: 'ok' }, actual: 'ok', evidence: [{ req_id: 'r1' }] });
    const { html } = await report(id);
    expect(html).toContain('class="trace-box"');
    expect(html).toContain('trace-blocked-200');
  });

  // ── focused display ──

  it('api assertion 有 path → focused display + full-response 折叠', async () => {
    const id = sid();
    const ref = blob(id, '{"data":{"tip":"hello","extra":"noise"}}');
    appendTraceEvent(id, { t: 'request', id: 'r1', path: '/tip.json', nav: 'n1', call_index: 1, method: 'GET', url: 'https://example.test/tip.json', status: 200, resource_type: 'XHR', resp_headers: { 'Content-Type': 'application/json' }, resp_body_ref: ref });
    const sp = shot(id, 'a1');
    appendTraceEvent(id, { t: 'action', id: 'a1', ts: 1, ts_end: 2, kind: 'click', intent: '动作-A', group: 'A', result: { ok: true }, requests: [], screenshot_path: sp });
    appendTraceEvent(id, { t: 'assert', after: 'a1', kind: 'api', pass: true, expect: { path: 'data.tip', op: '==', value: 'hello' }, actual: 'hello', evidence: [{ req_id: 'r1' }] });
    const { html } = await report(id);
    expect(html).toContain('class="api-focused"');
    expect(html).toContain('data.tip');
    expect(html).toContain('hello');
    expect(html).toContain('class="full-response"');
    // 噪音字段不在 focused 里
    const focusedMatch = html.match(/class="api-focused"[\s\S]*?<\/div>\s*<details/);
    expect(focusedMatch).toBeTruthy();
    expect(focusedMatch![0]).not.toContain('noise');
  });

  it('无 assertions 或 path 为空 → 降级全量展示，不含 api-focused', async () => {
    const id = sid();
    const ref = blob(id, '{"data":{"tip":"hello"}}');
    appendTraceEvent(id, { t: 'request', id: 'r1', path: '/tip.json', nav: 'n1', call_index: 1, method: 'GET', url: 'https://example.test/tip.json', status: 200, resource_type: 'XHR', resp_headers: { 'Content-Type': 'application/json' }, resp_body_ref: ref });
    const sp = shot(id, 'a1');
    appendTraceEvent(id, { t: 'action', id: 'a1', ts: 1, ts_end: 2, kind: 'click', intent: '动作-A', group: 'A', result: { ok: true }, requests: [], screenshot_path: sp });
    // text 类型断言，非 api
    appendTraceEvent(id, { t: 'assert', after: 'a1', kind: 'text', expect: { contains: 'hello' }, actual: 'hello', pass: true, evidence: [] });
    const { html } = await report(id);
    expect(html).not.toContain('class="api-focused"');
    expect(html).not.toContain('class="full-response"');
  });

  it('focused display 基础类型内联：string/number/boolean/null', async () => {
    const id = sid();
    const ref = blob(id, '{"s":"hello","n":42,"b":true,"x":null}');
    appendTraceEvent(id, { t: 'request', id: 'r1', path: '/tip.json', nav: 'n1', call_index: 1, method: 'GET', url: 'https://example.test/tip.json', status: 200, resource_type: 'XHR', resp_headers: { 'Content-Type': 'application/json' }, resp_body_ref: ref });
    const sp = shot(id, 'a1');
    appendTraceEvent(id, { t: 'action', id: 'a1', ts: 1, ts_end: 2, kind: 'click', intent: '动作-A', group: 'A', result: { ok: true }, requests: [], screenshot_path: sp });
    appendTraceEvent(id, { t: 'assert', after: 'a1', kind: 'api', pass: true, expect: { path: 's', op: '==', value: 'hello' }, actual: 'hello', evidence: [{ req_id: 'r1' }] });
    appendTraceEvent(id, { t: 'assert', after: 'a1', kind: 'api', pass: true, expect: { path: 'n', op: '==', value: 42 }, actual: 42, evidence: [{ req_id: 'r1' }] });
    appendTraceEvent(id, { t: 'assert', after: 'a1', kind: 'api', pass: true, expect: { path: 'b', op: '==', value: true }, actual: true, evidence: [{ req_id: 'r1' }] });
    appendTraceEvent(id, { t: 'assert', after: 'a1', kind: 'api', pass: true, expect: { path: 'x', op: '==', value: null }, actual: null, evidence: [{ req_id: 'r1' }] });
    const { html } = await report(id);
    // string 带引号（HTML 转义）
    expect(html).toContain('class="api-tree-str"');
    expect(html).toContain('&quot;hello&quot;');
    // number 直接展示
    expect(html).toContain('class="api-tree-number"');
    expect(html).toContain('>42<');
    // boolean 直接展示
    expect(html).toContain('class="api-tree-boolean"');
    expect(html).toContain('>true<');
    // null 灰色斜体
    expect(html).toContain('class="api-tree-null"');
    expect(html).toContain('>null<');
    // 不含 details（基础类型不折叠）
    const focusedMatch = html.match(/class="api-focused"[\s\S]*?<\/div>\s*<details class="full-response"/);
    expect(focusedMatch).toBeTruthy();
    expect(focusedMatch![0]).not.toContain('<details><summary');
  });

  it('focused display 对象/数组嵌套折叠：details + summary', async () => {
    const id = sid();
    const ref = blob(id, '{"data":{"list":[1,2],"meta":{"count":2}}}');
    appendTraceEvent(id, { t: 'request', id: 'r1', path: '/tip.json', nav: 'n1', call_index: 1, method: 'GET', url: 'https://example.test/tip.json', status: 200, resource_type: 'XHR', resp_headers: { 'Content-Type': 'application/json' }, resp_body_ref: ref });
    const sp = shot(id, 'a1');
    appendTraceEvent(id, { t: 'action', id: 'a1', ts: 1, ts_end: 2, kind: 'click', intent: '动作-A', group: 'A', result: { ok: true }, requests: [], screenshot_path: sp });
    appendTraceEvent(id, { t: 'assert', after: 'a1', kind: 'api', pass: true, expect: { path: 'data', op: 'exists' }, actual: null, evidence: [{ req_id: 'r1' }] });
    const { html } = await report(id);
    // 对象折叠：{list, meta}
    expect(html).toContain('class="api-tree-summary"');
    expect(html).toContain('{list, meta}');
    // 数组折叠：[2 项]
    expect(html).toContain('[2 项]');
    // 嵌套缩进
    expect(html).toContain('class="api-tree-indent"');
    // 逗号
    expect(html).toContain('class="api-tree-comma"');
  });
});
