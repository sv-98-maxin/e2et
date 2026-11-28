/**
 * 阶段 5.1 编译器：IRv2 → .test.ts 字符串。
 * 包裹式渲染：IR JSON 原样嵌入，由 runtime/runner 解析执行。
 * IR provenance 只保留录制事实；本次回放环境由 CLI 参数/环境输入交给 runtime。
 */
import type { IRv2 } from '../ir/schema.js';
import { replayTimeoutMs } from '../wait-timeout.js';
import { createHash } from 'node:crypto';
import { PLAYWRIGHT_VERSION } from '../shared/versions.js';

export function irDigest(ir: IRv2): string {
  return createHash('sha256').update(JSON.stringify(ir, null, 2)).digest('hex');
}

export function testDigest(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * 渲染 IRv2 为完整 .test.ts 文件内容。
 * 不展开步骤，只做字符串拼接：头注释 + import + PAGE_URL/COVERED_PAGES const + IR 字面量 + test 套件。
 */
export function renderIR(ir: IRv2): string {
  const body = renderBody(ir);
  return `// TEST-SHA256: ${testDigest(Buffer.from(body, 'utf8'))}\n${body}`;
}

function renderBody(ir: IRv2): string {
  const header = renderHeader(ir);
  const coveredPages = ir.covered_pages.length > 0
    ? ir.covered_pages.map((p) => JSON.stringify(p)).join(', ')
    : '';
  const irJson = JSON.stringify(ir, null, 2);
  const name = JSON.stringify(ir.name);
  const fixtureRel = `/../cases/fixtures/${ir.name}`;
  // 有显式预算的 IR 才声明整用例回放预算（旧 IR 字节不变）
  const hasBudget = ir.steps.some((s) => s.wait_timeout_ms !== undefined);

  return `${header}

import { test, expect } from '@playwright/test';
import * as path from 'node:path';
import { runTest, type RunnerOptions } from '../runtime/runner';
import { withReplayContext } from '../runtime/replay-context';
import type { IRv2 } from '../runtime/types';
import { createReplayRun, runtimeDigest } from '../runtime/report';
import type { AcceptanceSnapshot, ReportRun } from '../runtime/shared/report-model';

const PAGE_URL = ${JSON.stringify(ir.url)};
const COVERED_PAGES: string[] = [${coveredPages}];

const ir: IRv2 = JSON.parse(${JSON.stringify(irJson)});

test.describe(${name}, () => {
  test(${JSON.stringify(ir.name + ' E2E')}, async ({}, testInfo) => {
${hasBudget ? `    test.setTimeout(${replayTimeoutMs(ir.steps)});
` : ''}    // 回放环境来自本次参数/环境输入；IR provenance 不参与选择。
    await withReplayContext(
      async (context, cdpEndpoint, replayEnvironment) => {
        const metadata = testInfo.project.metadata;
        const run = createReplayRun({
          ...(metadata.e2et_run as Partial<ReportRun> | undefined),
          id: process.env.E2ET_RUN_ID ?? testInfo.testId + ':retry:' + testInfo.retry,
          toolVersion: typeof metadata.e2et_version === 'string' ? metadata.e2et_version : '',
          env: process.env.E2ET_RUN_ENV ?? process.env.TEST_ENV ?? 'default',
          runtimeSha256: runtimeDigest(path.resolve(path.dirname(testInfo.file), '../runtime')),
          authSource: replayEnvironment.auth_source,
          browserSource: replayEnvironment.browser_source,
          browserVersion: context.browser()?.version(),
        });
        await testInfo.attach('replay-environment', {
          body: JSON.stringify(replayEnvironment),
          contentType: 'application/json',
        });
        await testInfo.attach('runtime-environment', {
          body: JSON.stringify(run),
          contentType: 'application/json',
        });
        await runTest(ir, {
          fixtureDir: path.dirname(test.info().file) + '${fixtureRel}',
          context,
          cdpEndpoint,
          run,
          acceptance: metadata.e2et_run?.id === run.id && process.env.E2ET_RUN_ACCEPTANCE_DIR
            ? metadata.e2et_acceptance as AcceptanceSnapshot | undefined : undefined,
          onReport: (report) => testInfo.attach('ir-report', {
            body: JSON.stringify(report),
            contentType: 'application/json',
          }),
        });
      },
    );
  });
});
`;
}

function renderHeader(ir: IRv2): string {
  const sid = JSON.stringify(ir.provenance.session_id).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return [
    '// 🤖 由 e2et 编译生成 — 不要手改',
    `// IR: ${ir.name}.ir.json | session: ${sid} | env: ${ir.env}`,
    `// IR-SHA256: ${irDigest(ir)}`,
    `// Compiler: e2et | Playwright: ${PLAYWRIGHT_VERSION} | runtime: bundled`,
  ].join('\n');
}
