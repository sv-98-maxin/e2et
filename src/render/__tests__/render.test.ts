/**
 * 5.1 render 单测：基础渲染 / IR 嵌入 / fixture 路径 / 头注释 / 最小 & 多步 IR。
 */
import { describe, expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';
import { irDigest, renderIR, testDigest } from '../render.js';
import { parseIRv2, type IRv2, type Step } from '../../ir/schema.js';

function step(partial: Partial<Step> & { id: string; action: Step['action']; trace_ref: string }): Step {
  return { intent: partial.id, ...partial } as Step;
}

function ir(steps: Step[], opts: { coveredPages?: string[]; env?: 'pre' | 'prod' } = {}): IRv2 {
  return {
    schema_version: 3,
    name: 'render-case',
    url: 'https://portal.example.invalid/@item/pages/publish/normal.html',
    covered_pages: opts.coveredPages ?? [],
    env: opts.env ?? 'pre',
    provenance: {
      session_id: 's_render',
      auth_source: 'profile',
      browser_source: 'chrome-profile',
      tool_version: '0.6.0',
      generated_at: '2026-10-27T00:00:00.000Z',
      mocked: false,
    },
    steps,
  };
}

function minimalStep(): Step {
  return step({ id: 's1', action: 'open', trace_ref: 'a1', intent: '打开页面', value: { literal: 'https://portal.example.invalid/@item/pages/publish/normal.html' } });
}

function multiSteps(): Step[] {
  return [
    step({ id: 's1', action: 'open', trace_ref: 'a1', intent: '打开页面', value: { literal: 'https://portal.example.invalid/@item/pages/publish/normal.html' } }),
    step({
      id: 's2', action: 'fill', trace_ref: 'a2', intent: '填写名称',
      locator: { role: 'textbox', name: '商品名称' },
      value: { literal: 'E2E商品' }, save_as: 'title',
      creates: { entity: 'item', path: '/api/item/publish/commit.json' },
      wait: [{ api: { path: '/api/item/publish/commit.json', nav: 1, call_index: 1 } }],
      checks: [
        { assert: { api: { path: '/api/item/publish/commit.json', nav: 1, call_index: 1 }, expect: [{ path: '$.success', op: 'eq', value: true }] } },
        { assert: { toast: '保存成功' } },
        { capture: { from_api: { path: '/api/item/publish/commit.json', nav: 1, call_index: 1 }, path: '$.data.itemId', as: 'itemId', lineage: 'created' } },
      ],
    }),
    // A-F06：own __proto__ 字段必须贯穿编译；用 JSON.parse 构造 own key（JS 对象字面量会丢键）
    step({
      id: 's3', action: 'fill_form', trace_ref: 'a3', intent: '填原型字段',
      args: {
        scope: 'targeted',
        fields: JSON.parse('{"__proto__":{"literal":"原型字段值"}}'),
        field_locators: JSON.parse('{"__proto__":{"role":"textbox","name":"原型字段"}}'),
        field_order: ['__proto__'],
      },
    }),
  ];
}

describe('renderIR', () => {
  it('基础渲染：包含 PAGE_URL / COVERED_PAGES / import / test.describe + test', () => {
    const out = renderIR(ir([minimalStep()], { coveredPages: ['https://portal.example.invalid/x.html'] }));
    expect(out).toMatch(/const PAGE_URL = "https:\/\/portal\.example\.invalid\/@item\/pages\/publish\/normal\.html";/);
    expect(out).toContain('const COVERED_PAGES: string[] = ["https://portal.example.invalid/x.html"];');
    expect(out).toContain("import { test, expect } from '@playwright/test';");
    expect(out).toContain("import { runTest, type RunnerOptions } from '../runtime/runner';");
    expect(out).toContain("import { withReplayContext } from '../runtime/replay-context';");
    // P4：生成代码不再猜本机身份（删 fs/os 导入与 existsSync 列表；path 仅用于 fixture 路径）
    expect(out).not.toContain("import * as fs from 'node:fs';");
    expect(out).not.toContain("import * as os from 'node:os';");
    expect(out).not.toContain('existsSync');
    expect(out).not.toContain('chromium.launch');
    // 回放环境来自子进程参数/环境；生成代码不回读 provenance
    expect(out).toContain('await withReplayContext(');
    expect(out).not.toContain('ir.provenance.auth_source');
    expect(out).not.toContain('ir.provenance.browser_source');
    expect(out).toContain("testInfo.attach('replay-environment'");
    // 编译环境不进产物：版本号写死会让每次发版都改字节，报告用 runtime-environment 记执行期事实
    expect(out).not.toContain('compile-environment');
    expect(out).toContain("testInfo.attach('runtime-environment'");
    expect(out).toContain('body: JSON.stringify(testInfo.project.metadata)');
    expect(out).toContain('await runTest(ir, {');
    expect(out).toContain('test.describe("render-case"');
    expect(out).toContain('test("render-case E2E"');
  });

  it('COVERED_PAGES 为空时输出空数组', () => {
    const out = renderIR(ir([minimalStep()]));
    expect(out).toContain('const COVERED_PAGES: string[] = [];');
  });

  it('IR 嵌入声明经 VM 真执行：own __proto__ 保留 + deepEqual 原 IR', () => {
    const original = ir(multiSteps(), { coveredPages: ['a', 'b'] });
    const out = renderIR(original);
    const start = out.indexOf('const ir: IRv2 = ');
    // 取数据声明到 test.describe 之前；只移除 TS 注解，真执行声明（不执行 test 套件/浏览器）
    const end = out.indexOf('\n\ntest.describe(', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const declaration = out.slice(start, end).replace(': IRv2', '');
    const materialized = runInNewContext(declaration + '\nir') as IRv2;
    // 两个 map 的 __proto__ 必须是 own property：对象字面量编译会把它解释成原型设置 → 丢键
    const fillArgs = materialized.steps.find((stepEntry) => stepEntry.action === 'fill_form')!.args as Record<string, Record<string, unknown>>;
    expect(Object.hasOwn(fillArgs.fields!, '__proto__')).toBe(true);
    expect(Object.hasOwn(fillArgs.field_locators!, '__proto__')).toBe(true);
    const reparsed = parseIRv2(materialized);
    expect(reparsed.ok).toBe(true);
    expect(reparsed.ok && reparsed.ir).toEqual(original);
  });

  it('最小 IR 可渲染；回放环境附件不含 provenance 路径', () => {
    const out = renderIR(ir([minimalStep()]));
    expect(out).toContain("path.dirname(test.info().file) + '/../cases/fixtures/render-case'");
    expect(out).not.toContain('auth_state:');
    expect(out).not.toContain('authState:');
  });

  it('fixture 路径指向 cases/fixtures/{name}/', () => {
    const out = renderIR(ir([minimalStep()]));
    expect(out).toContain("path.dirname(test.info().file) + '/../cases/fixtures/render-case'");
  });

  it('TEST 第一行绑定 LF 后原始字节，IR 摘要与编译来源独立', () => {
    const source = ir([minimalStep()], { env: 'prod' });
    const out = renderIR(source);
    const lf = out.indexOf('\n');
    expect(out.slice(0, lf)).toBe(`// TEST-SHA256: ${testDigest(Buffer.from(out.slice(lf + 1)))}`);
    expect(out).toContain(`// IR-SHA256: ${irDigest(source)}`);
    expect(out).toContain('// Compiler: e2et | Playwright: 1.64.1 | runtime: bundled');
    expect(out).toContain('// IR: render-case.ir.json | session: "s_render" | env: prod');
  });

  it('sid 的四种行分隔符不能注入可执行行', () => {
    const separators = ['\n', '\r', '\u2028', '\u2029'];
    for (const separator of separators) {
      const payload = 'globalThis.__renderPayload = true; //';
      const source = ir([minimalStep()]);
      source.provenance.session_id = `s_render${separator}${payload}`;
      const out = renderIR(source);
      const header = out.slice(0, out.indexOf('\nimport '));
      const sandbox: { __renderPayload?: boolean } = {};
      runInNewContext(header, sandbox);
      expect(sandbox.__renderPayload).toBeUndefined();
    }
  });

  it('upload 文件名原样交回 runtime，不在模板内剥离目录', () => {
    const upload = step({ id: 's1', action: 'upload', trace_ref: 'a1', locator: { role: 'button', name: '上传' }, args: { files: [`${'a'.repeat(64)}-proof.bin`] } });
    const out = renderIR(ir([upload]));
    expect(out).toContain('a'.repeat(64) + '-proof.bin');
    expect(out).not.toContain('file.split');
  });

  it('最小 IR（1 step open）能渲染', () => {
    const out = renderIR(ir([minimalStep()]));
    expect(out).toContain('test.describe("render-case"');
    // JSON.parse 嵌入后 token 以 JSON 字符串转义引号出现
    expect(out).toContain('\\"open\\"');
  });

  it('多步 IR 能渲染', () => {
    const out = renderIR(ir(multiSteps()));
    // JSON.parse 嵌入后 token 以 JSON 字符串转义引号出现
    expect(out).toContain('\\"fill\\"');
    expect(out).toContain('\\"保存成功\\"');
    expect(out).toContain('\\"itemId\\"');
  });
  it('有 wait_timeout_ms 的步骤 → 渲染 test.setTimeout(replayTimeoutMs)', () => {
    const s = step({ id: 's1', action: 'open', trace_ref: 'a1', intent: '开' }) as any;
    s.wait_timeout_ms = 60000;
    const out = renderIR(ir([s]));
    expect(out).toContain('test.setTimeout(');
    // 预算 > 单步完成等待（60000 + setup/action 允许）
    expect(out).toMatch(/test\.setTimeout\(\d{6,}\)/);
  });

  it('无 wait_timeout_ms 的 IR 渲染字节不含 test.setTimeout（旧快照不变）', () => {
    const out = renderIR(ir([minimalStep()]));
    expect(out).not.toContain('test.setTimeout');
  });
});
