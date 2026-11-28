/**
 * 入口：读 IR JSON → 创建 browser context → 执行 steps → 断言 → 关闭。
 * 每个 step: resolve locator → action → wait → input commit → checks。
 * dialog 的 context listener 在 newPage 前注册，policy 只覆盖当前 action 与 wait。
 * auth 由外部 fixture 处理（runner 不关心 auth 来源）。
 * 完成预算：每 step 一个 deadline（wait_timeout_ms ?? opts.timeout ?? 30s），
 * waits/checks 共享剩余预算；Page 原生操作/导航默认超时 30s（不用 global/context config）。
 */
import type { Page, BrowserContext, Dialog } from '@playwright/test';
import { selectors } from '@playwright/test';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import type { IRv2, Step } from './types.js';
import { createValueContext, type ValueContext } from './value.js';
import { executeAction, clearHover, type HoverState } from './actions.js';
import { executeWaits } from './waits.js';
import { executeChecks, notRunChecks, type AssertionResult } from './checks.js';
import { RequestTracker } from './request-tracker.js';
import type { RequestRecord } from './request-tracker.js';
import { buildReport, createReplayRun, collectApiRefs, toReportApi, type StepOutcome } from './report.js';
import type { AcceptanceSnapshot, ReportData, ReportEvent, ReportImage, ReportRun } from './shared/report-model.js';
import type { InputCommit } from './shared/types.js';
import { PLAYWRIGHT_VERSION } from './shared/versions.js';
import { e2etSelectionPoolEngine, E2ET_SELECTION_POOL_ENGINE_NAME } from './shared/selection.js';

/** 原生操作/导航默认预算（ms）。standalone runner 局部表达，不跨包抽象。 */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** 宿主版本 gate：newPage 前读取实际解析的 @playwright/test 版本，非精确 1.64.1 拒绝 */
const nodeRequire = typeof require === 'function' ? require : createRequire(process.cwd() + '/');
function assertPlaywrightVersion(): void {
  let actual: string;
  try {
    actual = String(nodeRequire('@playwright/test/package.json').version ?? '');
  } catch (e) {
    throw new Error(`PLAYWRIGHT_VERSION_UNSUPPORTED: 无法解析宿主 @playwright/test（${(e as Error).message}），回放需要精确 ${PLAYWRIGHT_VERSION}`);
  }
  if (actual !== PLAYWRIGHT_VERSION) {
    throw new Error(`PLAYWRIGHT_VERSION_UNSUPPORTED: 宿主 @playwright/test ${actual}，回放需要精确 ${PLAYWRIGHT_VERSION}`);
  }
}

export interface RunnerOptions {
  fixtureDir: string;
  timeout?: number;
  /** 外部注入的 context（auth/cookies 由调用方处理） */
  context: BrowserContext;
  /** withReplayContext 公开的同一浏览器 browser-level WebSocket endpoint */
  cdpEndpoint: string;
  /** 回放报告（成功/失败都会回调一次），供 CI reporter 渲染 HTML */
  onReport?: (report: ReportData) => void | Promise<void>;
  run?: ReportRun;
  acceptance?: AcceptanceSnapshot;
}

type EventRecorder = (event: Omit<ReportEvent, 'sequence'>) => ReportEvent;

function errorFact(error: unknown): { message: string } {
  return { message: error instanceof Error ? error.message : String(error) };
}

/** 固定选择池 engine 注册（F05/F06 fallback 绑定）：必须在目标 page 创建前注册；
 *  模块内缓存注册 promise，多次 runTest 只注册一次。engine 唯一 body 是 unique，
 *  无 ID/JSON/索引查询 DSL，不加用户配置。 */
let selectionEngineRegistered: Promise<void> | undefined;
function ensureSelectionEngineRegistered(): Promise<void> {
  selectionEngineRegistered ??= selectors.register(E2ET_SELECTION_POOL_ENGINE_NAME, e2etSelectionPoolEngine()).then(() => undefined);
  return selectionEngineRegistered;
}

export async function runTest(ir: IRv2, opts: RunnerOptions): Promise<void> {
  const run = { ...(opts.run ?? createReplayRun()), errors: [] as NonNullable<ReportRun['errors']> };
  const irSha256 = createHash('sha256').update(JSON.stringify(ir, null, 2)).digest('hex');
  const events: ReportEvent[] = [];
  const images: ReportImage[] = [];
  let sequence = 0;
  const record: EventRecorder = event => {
    const recorded = { ...event, sequence: sequence++ };
    events.push(recorded);
    return recorded;
  };
  const vctx = createValueContext();
  const reqTracker = new RequestTracker();
  const context = opts.context;

  const hoverState: HoverState = {};
  const dialogs: DialogState = { pending: new Set() };
  const onDialog = (dialog: Dialog): void => {
    const policy = dialogs.current;
    const pending = Promise.resolve().then(() => policy?.accept
      ? dialog.accept(dialog.type() === 'prompt' ? policy.prompt_text : undefined)
      : dialog.dismiss()).catch((error: unknown) => {
        if (policy) { policy.error ??= error; policy.failed = true; }
        else { dialogs.error ??= error; dialogs.failed = true; }
      });
    const owner = policy?.pending ?? dialogs.pending;
    owner.add(pending);
    void pending.then(() => owner.delete(pending));
  };
  context.on('dialog', onDialog);
  const failures: Array<{ stepId: string; intent: string; error: string }> = [];
  const outcomes: StepOutcome[] = [];
  let runFailed = false;
  try {
    assertPlaywrightVersion();
    await ensureSelectionEngineRegistered();
    await reqTracker.start(context, opts.cdpEndpoint);
    let page = await context.newPage();
    applyNativeTimeouts(page);
    await reqTracker.attach(page);

    const PAGE_GONE = /has been closed|browser has been closed/;
    for (const [index, step] of ir.steps.entries()) {
      const startedAt = Date.now();
      let status: StepOutcome['status'] = 'pass';
      let errorMessage: string | undefined;
      const assertionResults: AssertionResult[] = [];
      const eventStart = events.length;
      try {
        if (dialogs.failed) throw dialogs.error;
        const result = await executeStep(page, context, step, vctx, reqTracker, opts.fixtureDir, opts.timeout, hoverState, dialogs, (nextPage) => { page = nextPage; }, assertionResults, `${run.id}:${step.id}`, irSha256, record);
        // action（如 switch_tab）返回新 page 时更新
        if (result.page && result.page !== page) {
          page = result.page;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        status = 'fail';
        errorMessage = message;
        console.log(`🔴 步骤 ${step.id} - ${step.intent} 失败: ${message}`);
        failures.push({ stepId: step.id, intent: step.intent, error: message });
      }

      const records = collectApiRefs(step)
        .map((ref) => reqTracker.query(ref.path, ref.nav, ref.call_index))
        .filter((record): record is RequestRecord => record !== undefined);
      let screenshot: string | undefined;
      let screenshotNotice: string | undefined;
      const screenshotStartedAt = Date.now();
      if (page.isClosed()) {
        screenshotNotice = '截图缺失：页面已关闭';
      } else {
        try {
          screenshot = 'data:image/png;base64,' + (await page.screenshot({ type: 'png' })).toString('base64');
        } catch (error) {
          screenshotNotice = `截图失败：${error instanceof Error ? error.message : String(error)}`;
        }
      }
      const screenshotEndedAt = Date.now();
      if (screenshot) {
        const imageId = `${run.id}:${step.id}:image`;
        const event = record({
          id: `${run.id}:${step.id}:screenshot`, type: 'screenshot', kind: 'screenshot', status: 'pass',
          actionId: `${run.id}:${step.id}`, group: step.report_ref?.group, imageId,
          executed: true, startedAt: screenshotStartedAt, endedAt: screenshotEndedAt,
        });
        images.push({
          id: imageId, eventId: event.id, actionId: event.actionId, sequence: event.sequence, src: screenshot,
          phase: assertionResults.some(result => result.executed) ? 'after_checks' : 'after_action', startedAt: screenshotStartedAt, endedAt: screenshotEndedAt,
        });
      } else if (screenshotNotice) {
        record({
          id: `${run.id}:${step.id}:screenshot`, type: 'screenshot', kind: 'screenshot', status: 'error',
          actionId: `${run.id}:${step.id}`, group: step.report_ref?.group,
          executed: !page.isClosed(), error: { message: screenshotNotice },
          ...(page.isClosed() ? {} : { startedAt: screenshotStartedAt, endedAt: screenshotEndedAt }),
        });
      }
      outcomes.push({
        step,
        status,
        durationMs: Date.now() - startedAt,
        error: errorMessage,
        apis: records.map(toReportApi),
        assertions: assertionResults.filter(result => result.type !== 'capture') as unknown as Record<string, unknown>[],
        captures: assertionResults.filter(result => result.type === 'capture') as unknown as Record<string, unknown>[],
        events: events.slice(eventStart),
        ...(screenshot ? { screenshot } : {}),
        ...(screenshotNotice ? { screenshotNotice } : {}),
      });

      // page/context 已关闭，继续跑没意义：剩余步骤标 blocked 后终止
      if (status === 'fail' && PAGE_GONE.test(errorMessage ?? '')) {
        console.log('⛔ 页面/浏览器已关闭，终止后续步骤');
        for (const rest of ir.steps.slice(index + 1)) {
          outcomes.push({ step: rest, status: 'blocked', durationMs: 0, apis: [], assertions: [], captures: [], screenshotNotice: '未执行（前置步骤终止）' });
        }
        break;
      }
    }

    if (failures.length > 0) {
      const summary = failures
        .map((f) => `- [${f.stepId}] ${f.intent}: ${f.error}`)
        .join('\n');
      throw new Error(`IR 测试有 ${failures.length} 个步骤失败:\n${summary}`);
    }

    console.log('✅ IR 测试全部通过');
  } catch (error) {
    runFailed = true;
    run.errors.push(errorFact(error));
    record({ id: `${run.id}:runtime-error`, type: 'error', kind: 'runtime', status: 'error', error: errorFact(error) });
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    try { await clearHover(hoverState); } catch (error) { cleanupErrors.push(error); }
    try { await reqTracker.dispose(); } catch (error) { cleanupErrors.push(error); }
    while (dialogs.pending.size) await Promise.all(dialogs.pending);
    context.off('dialog', onDialog);
    if (dialogs.failed) cleanupErrors.push(dialogs.error);
    for (const error of cleanupErrors) {
      run.errors.push(errorFact(error));
      record({ id: `${run.id}:cleanup:${sequence}`, type: 'error', kind: 'cleanup', status: 'error', error: errorFact(error) });
    }
    for (const step of ir.steps.slice(outcomes.length)) {
      outcomes.push({ step, status: 'blocked', durationMs: 0, apis: [], assertions: [], captures: [] });
    }
    for (const outcome of outcomes.filter(outcome => outcome.status === 'blocked' && !outcome.events?.length)) {
      const step = outcome.step;
      const actionId = `${run.id}:${step.id}`;
      const eventStart = events.length;
      record({
        id: actionId, type: 'action', kind: step.action, status: 'not_run', executed: false,
        group: step.report_ref?.group, actionId, intent: step.intent, args: step.args,
        valueSource: step.value, actualStatus: 'not_collected',
      });
      const checks = notRunChecks(step.checks ?? []);
      for (const result of checks) record({
        id: `${actionId}:check:${result.checkIndex}:${result.entryIndex}`,
        type: result.type ?? 'assert', kind: result.kind, status: 'not_run', executed: false,
        actionId, checkId: result.checkId, group: result.group ?? step.report_ref?.group, expect: result.expect,
        actualStatus: 'not_collected', evidence: { irRef: { irSha256, stepId: step.id, checkIndex: result.checkIndex, entryIndex: result.entryIndex } },
      });
      outcome.assertions = checks.filter(result => result.type !== 'capture') as unknown as Record<string, unknown>[];
      outcome.captures = checks.filter(result => result.type === 'capture') as unknown as Record<string, unknown>[];
      outcome.events = events.slice(eventStart);
    }
    run.endedAt = Date.now();
    try {
      await opts.onReport?.(buildReport(ir, outcomes, { run, acceptance: opts.acceptance, events, images }));
    } catch (error) {
      console.error('❌ 回放报告生成失败:', error);
    }
    if (cleanupErrors.length) {
      if (!runFailed) throw cleanupErrors[0];
      console.error('❌ runtime cleanup:', ...cleanupErrors);
    }
  }
}

/** 设置 Page 级原生操作/导航超时（不用 global/context config）。 */
function applyNativeTimeouts(page: Page): void {
  page.setDefaultNavigationTimeout(DEFAULT_REQUEST_TIMEOUT_MS);
  page.setDefaultTimeout(DEFAULT_REQUEST_TIMEOUT_MS);
}

async function executeStep(
  page: Page,
  context: BrowserContext,
  step: Step,
  vctx: ValueContext,
  reqTracker: RequestTracker,
  fixtureDir: string,
  fallbackTimeout: number | undefined,
  hoverState: HoverState,
  dialogs: DialogState,
  setPage: (page: Page) => void,
  assertionResults: AssertionResult[],
  actionId: string,
  irSha256: string,
  record: EventRecorder,
): Promise<{ page?: Page }> {
  console.log(`\n⏳ 步骤: ${step.id} - ${step.intent} (${step.action})`);

  // 执行 action
  const declaration = step.args?.dialog as { accept?: boolean; prompt_text?: string } | undefined;
  const policy: DialogPolicy = { accept: declaration ? declaration.accept ?? true : false, prompt_text: declaration?.prompt_text, pending: new Set() };
  dialogs.current = policy;
  let result: Awaited<ReturnType<typeof executeAction>>;
  let currentPage: Page;
  let deadline: number;
  let actionFailed = false;
  const inputCommits: InputCommit[] = [];
  const recordInput = (commit: InputCommit): void => { inputCommits.push(commit); };
  let observationIndex = 0;
  let stepFailed = false;
  let waitRecorded = false;
  let commitsStarted = 0;
  const action = record({
    id: actionId, type: 'action', kind: step.action, status: 'error', executed: true,
    group: step.report_ref?.group, actionId, intent: step.intent, args: step.args, frame: step.frame,
    valueSource: step.value, actualStatus: 'not_collected', startedAt: Date.now(),
  });
  try {
    try {
      reqTracker.beginConsoleAction(step.id);
      try {
        result = await executeAction(page, context, step, vctx, reqTracker, fixtureDir, hoverState, recordInput, fact => {
          Object.assign(action, fact);
          record({
            id: `${actionId}:observation:${Date.now()}:${observationIndex++}`, type: 'observation',
            kind: fact.input !== undefined ? 'action_input' : 'target', status: 'pass', executed: true,
            group: step.report_ref?.group, actionId, ...fact,
          });
        });
        action.status = 'pass';
        if (result.resolvedValue !== undefined || result.outputValue !== undefined) {
          action.actual = { resolvedValue: result.resolvedValue, outputValue: result.outputValue };
          action.actualStatus = 'present';
        }
      } catch (error) {
        action.error = errorFact(error);
        throw error;
      } finally { action.endedAt = Date.now(); }
      currentPage = result.page ?? page;
      setPage(currentPage);
      if (result.page && result.page !== page) {
        applyNativeTimeouts(currentPage);
        await reqTracker.attach(currentPage);
      }

      const budget = step.wait_timeout_ms ?? fallbackTimeout ?? DEFAULT_REQUEST_TIMEOUT_MS;
      deadline = Date.now() + budget;

      if (step.wait?.length) {
        waitRecorded = true;
        const wait = record({
          id: `${actionId}:wait`, type: 'observation', kind: 'wait', status: 'error', executed: true,
          group: step.report_ref?.group, actionId, args: step.wait, frame: step.frame, startedAt: Date.now(),
        });
        try {
          await executeWaits(currentPage, step.wait, reqTracker, Math.max(0, deadline - Date.now()), step.frame);
          wait.status = 'pass';
        } catch (error) { wait.error = errorFact(error); throw error; }
        finally { wait.endedAt = Date.now(); }
      }
    } catch (error) {
      actionFailed = true;
      throw error;
    } finally {
      if (dialogs.current === policy) dialogs.current = undefined;
      while (policy.pending.size) await Promise.all(policy.pending);
      if (policy.failed) {
        record({ id: `${actionId}:dialog`, type: 'error', kind: 'dialog', status: 'error', actionId, group: step.report_ref?.group, error: errorFact(policy.error) });
        if (!actionFailed) throw policy.error;
        console.error('❌ dialog handling:', policy.error);
      }
    }

    for (const [index, commit] of inputCommits.entries()) {
      commitsStarted++;
      const event = record({
        id: `${actionId}:input_commit:${index}`, type: 'observation', kind: 'input_commit', status: 'error',
        actionId, group: step.report_ref?.group, executed: true, startedAt: Date.now(), actualStatus: 'unavailable',
      });
      try {
        const evidence = await commit.verify();
        event.status = 'pass';
        event.target = evidence.target;
        event.resolvedExpected = evidence.expected;
        event.actual = evidence.actual;
        event.actualStatus = 'present';
        event.evidence = { ...evidence, phase: 'after-wait' };
      } catch (error) {
        event.error = errorFact(error);
        const encoded = event.error.message.match(/^FILL_NOT_COMMITTED: (\{.*\})$/s)?.[1];
        if (encoded) {
          try {
            const evidence = JSON.parse(encoded) as { expected?: unknown; actual?: unknown; target?: unknown };
            event.evidence = evidence;
            event.target = evidence.target;
            event.resolvedExpected = evidence.expected;
            if (Object.hasOwn(evidence, 'actual')) { event.actual = evidence.actual; event.actualStatus = 'present'; }
          } catch {}
        }
        throw error;
      } finally { event.endedAt = Date.now(); }
    }
    reqTracker.finishConsoleAction(step.id);

    // wait 与输入校验成功后：登记历史动作值 → save_as → checks
    // wait 或输入校验失败不登记新 step、不覆旧变量
    if (result.resolvedValue !== undefined) {
      vctx.setActionValue(step.id, result.resolvedValue);
    }
    // §8 输出合同：outputValue（choose/category picked JSON）?? resolvedValue，不依赖 step.value
    if (step.save_as) {
      const bound = result.outputValue ?? result.resolvedValue;
      if (bound === undefined) {
        throw new Error(`❌ save_as "${step.save_as}" 需要绑定值但动作未产出 outputValue/resolvedValue (step: ${step.id})`);
      }
      vctx.set(step.save_as, bound);
      console.log(`📝 save_as: ${step.save_as} = ${bound}`);
    }

    // checks
    if (step.checks?.length) {
      await executeChecks(currentPage, step.checks, vctx, reqTracker, Math.max(0, deadline - Date.now()), assertionResults);
    }

    return { page: result.page };
  } catch (error) {
    stepFailed = true;
    throw error;
  } finally {
    if (step.wait?.length && !waitRecorded) record({
      id: `${actionId}:wait`, type: 'observation', kind: 'wait', status: 'not_run', executed: false,
      actionId, group: step.report_ref?.group, args: step.wait, frame: step.frame, actualStatus: 'not_collected',
    });
    for (let index = commitsStarted; index < inputCommits.length; index++) record({
      id: `${actionId}:input_commit:${index}`, type: 'observation', kind: 'input_commit', status: 'not_run',
      actionId, group: step.report_ref?.group, executed: false, actualStatus: 'not_collected',
    });
    if (!assertionResults.length) assertionResults.push(...notRunChecks(step.checks ?? []));
    for (const result of assertionResults) {
      record({
        id: `${actionId}:check:${result.checkIndex}:${result.entryIndex}`,
        type: result.type ?? 'assert', kind: result.kind, status: result.status ?? 'not_run',
        actionId, checkId: result.checkId, group: result.group ?? step.report_ref?.group,
        startedAt: result.startedAt, endedAt: result.endedAt, executed: result.executed,
        expect: result.expect, resolvedExpected: result.resolvedExpected, actual: result.actual,
        actualStatus: result.actualStatus, target: result.target, frame: result.frame, error: result.error,
        evidence: { ...(result.evidence as object ?? {}), irRef: { irSha256, stepId: step.id, checkIndex: result.checkIndex, entryIndex: result.entryIndex } },
      });
    }
    const cleanupErrors: unknown[] = [];
    for (const [index, commit] of inputCommits.entries()) {
      try { await commit.dispose(); } catch (error) {
        cleanupErrors.push(error);
        record({ id: `${actionId}:input_cleanup:${index}`, type: 'error', kind: 'input_cleanup', status: 'error', actionId, group: step.report_ref?.group, error: errorFact(error) });
      }
    }
    if (cleanupErrors.length) {
      if (!stepFailed) throw cleanupErrors[0];
      console.error('❌ input cleanup:', ...cleanupErrors);
    }
  }
}

interface DialogPolicy {
  accept: boolean;
  prompt_text?: string;
  pending: Set<Promise<void>>;
  failed?: boolean;
  error?: unknown;
}

interface DialogState {
  current?: DialogPolicy;
  pending: Set<Promise<void>>;
  failed?: boolean;
  error?: unknown;
}
