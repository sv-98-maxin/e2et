/**
 * P2 report 观察归组测试:observation 进已有证据归组(after/显式 group 单归属)、
 * 孤立观察放诊断附录(findings + diagnostic_observations)、0 断言仍 BLOCKED、
 * 不伪造 action 计数。不改 HTML 风格、不删除截图/网络证据。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { appendTraceEvent, ensurePrivateDir } from '../daemon/trace.js';
import { dispatch } from '../cli/router.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('report observation 归组(P2)', () => {
  let home: string;
  let previousHome: string | undefined;
  let seq = 0;

  beforeEach(() => {
    previousHome = process.env.E2ET_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-report-'));
    process.env.E2ET_HOME = home;
  });
  afterEach(() => {
    if (previousHome === undefined) delete process.env.E2ET_HOME;
    else process.env.E2ET_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  function sid(): string {
    seq++;
    const id = `pd-rep-${seq}`;
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

  async function report(id: string, args: string[] = []): Promise<{ html: string; json: any; stdout: any }> {
    appendTraceEvent(id, { t: 'session_end', result: 'pass' });
    const stdout: string[] = [];
    expect(await dispatch(['report', '-s', id, ...args], {
      env: process.env, stdout: (s: string) => stdout.push(s), stderr: () => {},
    })).toBe(0);
    const out = JSON.parse(stdout.join(''));
    return {
      html: fs.readFileSync(out.data.html, 'utf8'),
      json: JSON.parse(fs.readFileSync(out.data.json, 'utf8')),
      stdout: out,
    };
  }

  it('observation 归组进业务步骤(assert data 关联展示源/值/身份),孤立的进诊断附录', async () => {
    const id = sid();
    const sp = shot(id, 'g1');
    // 组 A:open + assert data + 对应 observation
    appendTraceEvent(id, { t: 'action', id: 'a1', ts: 1, ts_end: 2, kind: 'open', intent: '打开页面', group: 'A', result: { ok: true }, requests: [], screenshot_path: sp });
    appendTraceEvent(id, {
      t: 'observation', id: 'o1', ts: 3, source: { local_storage: 'cfg', path: 'record.mode' },
      after: 'a1', group: 'A', target_id: 'T1', document: { frame_id: 'F1', loader_id: 'LD1' },
      nav: 'n1', url: 'https://example.test/', origin: 'https://example.test',
      result: { ok: true, present: true, value: 'fast' },
    });
    appendTraceEvent(id, {
      t: 'assert', after: 'a1', kind: 'data', group: 'A',
      expect: { source: { local_storage: 'cfg', path: 'record.mode' }, equals: 'fast' },
      actual: { present: true, value: 'fast', context: { target_id: 'T1', frame_id: 'F1', loader_id: 'LD1', nav: 'n1', url: 'https://example.test/', origin: 'https://example.test' } },
      pass: true, evidence: [{ observation: 'o1' }], observation_ref: 'o1',
    });
    // 孤立观察:无 group、after 不指向任何 action
    appendTraceEvent(id, {
      t: 'observation', id: 'o2', ts: 4, source: { global: 'gFlag' },
      target_id: 'T1', document: { frame_id: 'F1', loader_id: 'LD1' },
      nav: 'n1', url: 'https://example.test/', origin: 'https://example.test',
      result: { ok: true, present: false },
    });
    const { html, json } = await report(id);
    // 组 A 的步骤含断言与观察
    const stepA = json.cases[0].steps.find((s: any) => s.group === 'A');
    expect(stepA).toBeDefined();
    expect(stepA.status).toBe('pass'); // 观察/断言归组不改变结论
    expect(stepA.observation).toContain('页面数据观察');
    expect(stepA.observation).toContain('present=true');
    expect(stepA.assertDetails.some((d: string) => d.includes('observation o1'))).toBe(true);
    // 孤立观察:不进业务步骤,进诊断附录
    expect(json.diagnostic_observations).toHaveLength(1);
    expect(json.diagnostic_observations[0].id).toBe('o2');
    expect(json.findings.some((f: string) => f.includes('孤立观察') && f.includes('gFlag'))).toBe(true);
    // 业务步骤不含孤立观察伪造成果
    expect(json.cases[0].steps.some((s: any) => s.group === 'B')).toBe(false);
    // action 计数不伪造:只有 1 个 action
    expect(json.actions.total).toBe(1);
    // HTML 展示观察与孤立观察
    expect(html).toContain('页面数据观察');
    expect(html).toContain('孤立观察');
  });

  it('失败 observation 归组进步骤事实行,不改写断言结论(0 断言组仍 BLOCKED)', async () => {
    const id = sid();
    const sp = shot(id, 'g2');
    appendTraceEvent(id, { t: 'action', id: 'a1', ts: 1, ts_end: 2, kind: 'open', intent: '打开', group: 'G', result: { ok: true }, requests: [], screenshot_path: sp });
    appendTraceEvent(id, {
      t: 'observation', id: 'o1', ts: 3, source: { global: 'gFlag' }, after: 'a1', group: 'G',
      target_id: 'T1', document: { frame_id: 'F1', loader_id: 'LD1' }, nav: 'n1',
      url: 'https://example.test/', origin: 'https://example.test',
      result: { ok: false, error: { code: 'READ_UNAVAILABLE', message: '读取失败' } },
    });
    const { json } = await report(id);
    const stepG = json.cases[0].steps.find((s: any) => s.group === 'G');
    expect(stepG).toBeDefined();
    // 0 断言 → blocked(不因观察存在变 pass)
    expect(stepG.status).toBe('blocked');
    expect(stepG.observation).toContain('读取失败');
    expect(stepG.observation).toContain('READ_UNAVAILABLE');
  });

  it('敏感观察值不进 HTML/JSON 报告', async () => {
    const id = sid();
    const sp = shot(id, 'g3');
    appendTraceEvent(id, { t: 'action', id: 'a1', ts: 1, ts_end: 2, kind: 'open', intent: '打开', group: 'G', result: { ok: true }, requests: [], screenshot_path: sp });
    appendTraceEvent(id, {
      t: 'observation', id: 'o1', ts: 3, source: { local_storage: 'auth_token' }, after: 'a1', group: 'G',
      target_id: 'T1', document: { frame_id: 'F1', loader_id: 'LD1' }, nav: 'n1',
      url: 'https://example.test/', origin: 'https://example.test',
      result: { ok: true, present: true, value: '[REDACTED]' },
    });
    const { html, json } = await report(id);
    expect(JSON.stringify(json)).not.toMatch(/T0PS3CRT/);
    expect(html).not.toContain('T0PS3CRET');
    const stepG = json.cases[0].steps.find((s: any) => s.group === 'G');
    expect(stepG.observation).toContain('[REDACTED]');
  });
});
