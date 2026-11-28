import type { ReportData } from './report-model.js';
import { displayData } from './report-display.js';
import { reportStyles } from './report-styles.js';
import { reportClientScript } from './report-client.js';

export type {
  ReportData, ReportCase, ReportStep, ReportStepApi, ReportEvent, ReportImage, ReportRun,
  ReportCoverage, ReportUiChecks, ReportFix, ReportBackendInfo, ReportFlow, ReportFlowFrame,
  AcceptanceDocument, AcceptanceSnapshot, AcceptanceCoverage, AcceptanceScenarioCoverage, AcceptanceCheckCoverage,
} from './report-model.js';

const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]!));

export function renderReportHtml(data: ReportData): string {
  if (!data.cases.length) throw new Error('report data must have at least one case');
  const projected = displayData(data);
  const json = JSON.stringify(projected).replace(/[<>&\u2028\u2029]/g, character =>
    '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'));
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>${escapeHtml(projected.title)}</title><style>${reportStyles}</style></head><body>
<a class="skip" href="#center">跳到报告正文</a>
<header class="top">
  <div class="top-row">
    <div class="title-block"><span class="brand">e2et · 验收记录</span><h1 class="top-title">${escapeHtml(projected.title)}</h1></div>
    <div class="top-actions"><button id="nav-toggle" class="nav-toggle" type="button" aria-expanded="false" aria-controls="directory">场景目录</button><button id="theme" type="button">主题</button></div>
  </div>
  <div class="top-meta"><span id="execution" class="row"></span><span id="coverage" class="row"></span><span id="counts"></span><span class="muted">环境 ${escapeHtml(projected.env || '未记录')} · ${projected.mocked ? 'Mock 开启' : 'Mock 未开启'}</span><span id="boundary" class="boundary"></span></div>
</header>
<div id="directory" class="directory"><div class="directory-head"><span>场景目录</span><label class="sr-only" for="search">搜索场景</label><input id="search" type="search" placeholder="搜索场景 / 状态"></div><nav id="scenarios" class="scenarios" aria-label="场景目录"></nav></div>
<main id="center" class="report" tabindex="-1">
  <section id="cases-section" class="cases-section" aria-label="用例结果"><div class="section-head"><div><h2>用例结果</h2><p>点击用例查看执行步骤与证据。</p></div><span id="case-count" class="small muted"></span></div><div id="cases" class="cases"></div></section>
  <section class="overview" aria-label="验证范围"><div class="overview-main">
    <div id="case-actions" class="case-actions" aria-label="当前用例操作">
      <div class="row"><span id="case-status" class="badge"></span><span id="case-name" class="case-current-name"></span></div>
      <div class="row"><button id="flow-replay" type="button" class="run-link" hidden>全流程回放</button><button id="run-info" type="button" class="run-link">运行信息</button><button id="raw-trace" type="button" class="run-link">原始 trace</button></div>
    </div>
    <div id="context" class="context"></div>
  </div><span id="scope-status"></span></section>
  <section class="process" aria-label="执行步骤">
    <div class="section-head"><div><h2>执行步骤</h2><p>点击步骤查看截图与结果；上一步 / 下一步可逐条核对。</p></div>
      <div class="controls row"><button id="previous" type="button" aria-label="上一步">上一步</button><button id="next" type="button" aria-label="下一步">下一步</button><span id="position" class="small mono"></span></div></div>
    <div class="process-body">
      <nav id="timeline" class="timeline" aria-label="执行步骤"></nav>
      <div class="step-detail">
        <section id="action" class="action" aria-label="当前步骤事实"></section>
        <section class="preview" aria-label="步骤截图">
          <div class="preview-head"><div id="image-label" class="image-label"></div></div>
          <div id="images" class="row small" aria-label="关联截图"></div>
          <div id="image-stage" class="image-stage" aria-label="截图预览，点击图片全屏查看"></div>
        </section>
      </div>
      <section class="checks-section" aria-label="检查结果"><div class="section-head"><div><h2>检查结果</h2><p>每条断言：对象 · 条件 · 期望 · 实测</p></div><span id="check-count" class="small muted"></span></div><div id="checks" class="checks"></div></section>
    </div>
  </section>
</main>
<dialog id="dialog" aria-labelledby="dialog-title"><div class="row between"><h2 id="dialog-title"></h2><button id="dialog-close" type="button">关闭 · Esc</button></div><div id="dialog-body" class="dialog-body"></div></dialog>
<noscript><p class="alert">此离线报告需要启用 JavaScript 才能核对事件、图片和验收检查。</p></noscript>
<script id="report-data" type="application/json">${json}</script><script>${reportClientScript}</script></body></html>`;
}
