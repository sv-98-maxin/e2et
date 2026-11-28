/** 报告 HTML 的内联样式；由 report-render.ts 嵌入，不单独加载。 */
export const reportStyles = String.raw`
:root{color-scheme:light;--bg:#f6f7fb;--surface:#fff;--soft:#eef1f6;--line:#dfe4ec;--text:#1f2a3d;--muted:#667085;--accent:#2f5fd0;--selected:#edf2ff;--pass:#0f6b4f;--pass-bg:#e9f6f0;--fail:#b42332;--fail-bg:#fdeff0;--warn:#8a5a09;--warn-bg:#fff6e6;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;--radius:10px;--shadow:0 1px 2px rgba(16,24,40,.04)}
:root[data-theme=dark]{color-scheme:dark;--bg:#151a23;--surface:#1f2735;--soft:#273142;--line:#374255;--text:#e6ecf6;--muted:#a7b4c8;--accent:#9ab8ff;--selected:#2a3a5c;--pass:#82d7b2;--pass-bg:#203c33;--fail:#ff9aa5;--fail-bg:#452a33;--warn:#edc57b;--warn-bg:#3f3627;--shadow:none}
*{box-sizing:border-box}
[hidden]{display:none!important}
html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
button,select,input{font:inherit;color:inherit}
button,select{cursor:pointer}
button{border:1px solid var(--line);background:var(--surface);border-radius:6px;padding:6px 10px;line-height:1.2}
button:hover{background:var(--soft)}
button:disabled{cursor:default;opacity:.45}
button[aria-pressed=true]{background:var(--selected);border-color:var(--accent);color:var(--accent)}
:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
h1,h2,h3,p{margin:0}
h1{font-size:22px;line-height:1.3;font-weight:650}
h2{font-size:17px;line-height:1.35;font-weight:650}
h3{font-size:14px;line-height:1.4;font-weight:650}
code,pre,.mono{font-family:var(--mono)}
code{overflow-wrap:anywhere}
.muted{color:var(--muted)}
.small{font-size:12px}
.badge{display:inline-flex;align-items:center;border-radius:999px;padding:3px 9px;font-size:11px;font-weight:600;white-space:nowrap}
.badge.pass{color:var(--pass);background:var(--pass-bg)}
.badge.fail,.badge.error{color:var(--fail);background:var(--fail-bg)}
.badge.unverified,.badge.not_run,.badge.blocked{color:var(--warn);background:var(--warn-bg)}
.row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.between{justify-content:space-between}

.top{position:sticky;top:0;z-index:20;background:var(--surface);border-bottom:1px solid var(--line);padding:20px 28px 14px}
.top-row{display:flex;align-items:flex-start;justify-content:space-between;gap:24px}
.title-block{min-width:0}
.brand{display:block;color:var(--muted);font-size:11px;letter-spacing:.08em;text-transform:uppercase}
.top-title{margin-top:6px;overflow-wrap:anywhere}
.top-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}
.top-actions .run-link{font-size:12px;color:var(--accent);border-color:transparent;background:transparent}
.top-actions .run-link:hover{background:var(--soft)}
.top-meta{display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin-top:12px;font-size:12px;color:var(--muted)}
.boundary{margin-left:auto;color:var(--warn);font-size:12px;overflow-wrap:anywhere}
.nav-toggle{display:none}

.directory{display:flex;align-items:center;gap:16px;padding:10px 28px;background:var(--surface);border-bottom:1px solid var(--line)}
.directory-head{display:flex;align-items:center;gap:10px;flex:none;color:var(--muted);font-size:12px}
.directory-head input{width:180px;padding:6px 9px;border:1px solid var(--line);border-radius:6px;background:var(--bg)}
.scenarios{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.case-label{display:none}
.scenario{display:flex;align-items:center;gap:8px;border:1px solid var(--line);background:var(--bg);border-radius:999px;padding:6px 12px;color:var(--muted);text-align:left}
.scenario br{display:none}
.scenario .scenario-name{color:var(--text);font-weight:600}
.scenario[aria-current=true]{border-color:var(--accent);background:var(--selected);color:var(--accent)}
.scenario[aria-current=true] .scenario-name{color:var(--accent)}
.scenario .badge{margin-left:2px}

.report{max-width:1180px;margin:0 auto;padding:24px 28px 48px;display:flex;flex-direction:column;gap:28px}
.report.multi{max-width:1400px;display:grid;grid-template-columns:300px minmax(0,1fr);align-content:start;align-items:start;column-gap:24px;row-gap:24px}
.report.multi>*:not(.cases-section){grid-column:2}
.report.multi>.cases-section{grid-column:1;grid-row:1/-1;align-self:start;position:sticky;top:calc(var(--top-h,0px) + 16px);max-height:calc(100vh - var(--top-h,0px) - 32px);overflow:auto}
.overview{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;padding:18px 20px;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow);scroll-margin-top:calc(var(--top-h,0px) + 16px)}
.overview-main{flex:1;min-width:0}
.case-actions{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:12px;padding-bottom:12px;border-bottom:1px solid var(--line)}
.case-actions .run-link{font-size:12px;color:var(--accent);border-color:transparent;background:transparent}
.case-actions .run-link:hover{background:var(--soft)}
.case-current-name{font-weight:600;font-size:13px;overflow-wrap:anywhere;min-width:0}
.cases-section .section-head{margin-bottom:10px}
.cases{display:grid;gap:8px}
.case-row{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:12px;text-align:left;padding:12px 14px;border:1px solid var(--line);border-radius:8px;background:var(--surface);box-shadow:var(--shadow)}
.case-row:hover{background:var(--soft)}
.case-row[aria-current=true]{border-color:var(--accent);background:var(--selected);box-shadow:inset 3px 0 var(--accent)}
.case-main{min-width:0}
.case-name{font-weight:650;font-size:14px;overflow-wrap:anywhere}
.case-meta{margin-top:3px;color:var(--muted);font-size:11.5px}
.case-duration{font:11px/1.6 var(--mono);color:var(--muted);white-space:nowrap}
.context{min-width:0}
.context h2{font-size:21px}
.context p{margin-top:4px;color:var(--muted);font-size:12px}
.context details{margin-top:10px}
.section-head{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:12px}
.section-head p{margin-top:3px;color:var(--muted);font-size:12px}

.steps{display:grid;gap:12px}
.step{display:grid;gap:10px;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow);padding:14px 16px;scroll-margin:16px}
.step[aria-current=true]{border-color:var(--accent);border-left:3px solid var(--accent)}
.step-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.step-index{font:11px/1.7 var(--mono);color:var(--muted)}
.step-title{flex:1;min-width:0;font-weight:650;font-size:14px;overflow-wrap:anywhere}
.step-meta{color:var(--muted);font-size:11.5px;overflow-wrap:anywhere}
.step>.facts{margin:0}
.facts{display:grid;grid-template-columns:78px minmax(0,1fr);gap:6px 12px;margin:12px 0 0;font-size:12.5px}
.facts dt{color:var(--muted)}
.facts dd{margin:0;min-width:0;overflow-wrap:anywhere}
.preview{display:flex;flex-direction:column;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);overflow:hidden;box-shadow:var(--shadow);min-width:0}
.preview-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px;border-bottom:1px solid var(--line);font-size:12px}
.preview-head .row{gap:5px}
.preview-head button{font-size:11px;padding:4px 7px}
.image-label{color:var(--muted);overflow-wrap:anywhere}
.image-stage{display:flex;align-items:center;justify-content:center;min-height:380px;padding:12px;background:var(--soft)}
.image-stage.empty{min-height:56px;max-height:none;padding:4px}
.image-stage.empty .empty{padding:10px 12px}
.image-stage img{display:block;max-width:100%;height:auto;background:#fff}
.image-stage[data-kind=api]{align-items:flex-start;justify-content:flex-start;min-height:0;max-height:none}
.api-preview{display:grid;gap:12px;width:100%;align-content:start;padding:4px}
.api-card{border:1px solid var(--line);border-radius:8px;background:var(--surface);padding:14px}
.api-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px}
.api-method{font:600 11px/1 var(--mono);color:var(--accent);background:var(--selected);padding:4px 6px;border-radius:4px}
.api-path{font:12px/1.4 var(--mono);overflow-wrap:anywhere;flex:1;min-width:0}
.api-card .facts{grid-template-columns:78px minmax(0,1fr);margin-top:0}
.step-images{padding:0;gap:6px}
.step-images:empty{display:none}
.step-images button{font-size:11px;padding:4px 8px;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.empty{padding:32px 16px;text-align:center;color:var(--muted);overflow-wrap:anywhere}

.plan-section{display:grid;gap:10px}
.plan-section .section-head{margin-bottom:0}
.plan-section .section-head h2{font-size:15px}
.plan-section .section-head p{font-size:11px}
.checks{display:grid;gap:6px}
.check{display:grid;gap:4px;background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:9px 12px;scroll-margin:16px}
.check-head{display:flex;align-items:baseline;gap:10px}
.check.selected,.check.related{border-left:3px solid var(--accent)}
.check.selected{border-color:var(--accent);background:var(--selected)}
.check .check-name{flex:1;text-align:left;border:0;background:transparent;padding:0;font-weight:600;font-size:13px;line-height:1.5;overflow-wrap:anywhere}
.check .check-name:hover{color:var(--accent)}
.check .check-meta{color:var(--muted);font-size:11.5px;white-space:nowrap}
.check-detail summary{cursor:pointer;font-size:11px;color:var(--muted);padding:2px 0}
.check-detail .facts{margin-top:4px}
.check-extras{display:grid;gap:6px}
.check-extras summary{cursor:pointer;color:var(--muted);font-size:12px;padding:4px 0}
.value{max-width:100%;font-size:12px;overflow-wrap:anywhere}
.value summary{cursor:pointer;overflow-wrap:anywhere}
.value-type{color:var(--muted);font-size:10px;margin-right:5px}
.human-value{white-space:pre-wrap}
.value pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:320px;overflow:auto;background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:10px;margin:8px 0}
.value-tools{display:flex;gap:6px;margin:5px 0}
.value button{font-size:10px;padding:3px 6px}
.raw-link{font-size:12px;color:var(--accent);margin-top:10px}
.alert{color:var(--warn);background:var(--warn-bg);padding:8px 10px;font-size:12px;border-radius:6px;margin:8px 0}
.error-message{color:var(--fail);white-space:pre-wrap;overflow-wrap:anywhere;margin-top:8px;font-size:12px}
.trace-id{font-family:var(--mono);font-size:11px;color:var(--fail);margin-top:6px;overflow-wrap:anywhere}
.tech-evidence>summary,.tech-fields>summary,.coverage-boundary>summary{cursor:pointer;color:var(--muted);font-size:11.5px;margin-top:10px}
.tech-evidence .facts,.tech-fields .facts,.coverage-boundary .facts{margin-top:6px}
.run-link{font-size:12px;color:var(--accent)}
.skip{position:fixed;top:-80px;left:12px;z-index:20;background:var(--surface);padding:10px;border-radius:6px}
.skip:focus{top:12px}
dialog{border:1px solid var(--line);border-radius:12px;background:var(--surface);color:var(--text);width:min(1000px,94vw);max-height:92vh;padding:16px}
dialog::backdrop{background:rgba(8,16,29,.72)}
.dialog-body{max-height:77vh;overflow:auto;margin-top:12px}
.dialog-body img{display:block;max-width:100%;max-height:72vh;margin:auto}
.dialog-body pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;margin:0}
.image-stage img{cursor:zoom-in}
dialog.image-viewer{width:100vw;height:100vh;max-width:none;max-height:none;border-radius:0;padding:14px 18px;display:flex;flex-direction:column}
dialog.image-viewer .dialog-body{flex:1;max-height:none;display:flex;align-items:center;justify-content:center;overflow:auto;padding:8px}
dialog.image-viewer .dialog-body img{max-width:100%;max-height:calc(100vh - 96px);cursor:zoom-in}
dialog.image-viewer .dialog-body[data-image-zoom=actual]{display:block}
dialog.image-viewer .dialog-body[data-image-zoom=actual] img{max-width:none;max-height:none;width:auto;height:auto;cursor:zoom-out}
.replay{display:flex;flex-direction:column;gap:10px}
.replay-stage{display:flex;align-items:center;justify-content:center;min-height:360px;max-height:68vh;padding:8px;background:var(--soft);border:1px solid var(--line);border-radius:8px;overflow:auto}
.replay-controls{justify-content:flex-start;flex-wrap:nowrap}
.replay-progress{--replay-progress:0%;flex:1;min-width:160px;height:18px;padding:0;border:0;border-radius:999px;background:linear-gradient(to right,var(--accent) 0 var(--replay-progress),var(--line) var(--replay-progress) 100%) center/100% 6px no-repeat;appearance:none;-webkit-appearance:none;cursor:pointer}
.replay-progress::-webkit-slider-runnable-track{height:18px;background:transparent}
.replay-progress::-webkit-slider-thumb{-webkit-appearance:none;width:14px;height:14px;margin-top:2px;border:2px solid var(--accent);border-radius:50%;background:var(--surface);box-shadow:0 1px 3px rgba(15,23,42,.28)}
.replay-progress::-moz-range-track{height:18px;background:transparent}
.replay-progress::-moz-range-thumb{width:12px;height:12px;border:2px solid var(--accent);border-radius:50%;background:var(--surface);box-shadow:0 1px 3px rgba(15,23,42,.28)}
.replay-time{color:var(--muted);white-space:nowrap;min-width:92px;text-align:right}
.replay-speed{display:inline-flex;align-items:center;gap:2px;padding:2px;border:1px solid var(--line);border-radius:8px;background:var(--soft)}
.replay-speed-option{padding:4px 7px;border:0;background:transparent;color:var(--muted);font-size:11px;line-height:1.2;border-radius:6px}
.replay-speed-option:hover{background:var(--surface);color:var(--text)}
.replay-speed-option[aria-pressed=true]{background:var(--surface);color:var(--accent);box-shadow:0 1px 2px rgba(15,23,42,.16)}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}

@media(max-width:960px){
  .top{padding:16px 18px 12px}
  .top-row{flex-direction:column}
  .top-actions{justify-content:flex-start}
  .directory{padding:10px 18px;flex-wrap:wrap}
  .report{padding:18px 18px 36px;gap:22px}
  .report.multi{display:flex;flex-direction:column}
  .report.multi>.cases-section{position:static;max-height:none;overflow:visible}
  .image-stage{min-height:300px}
  .boundary{margin-left:0}
  .checks{grid-template-columns:1fr}
}
@media(max-width:680px){
  .top-title{font-size:19px}
  .nav-toggle{display:inline-block}
  .directory{display:none}
  body[data-nav=open] .directory{display:flex}
  .directory-head input{width:100%}
  .directory-head{width:100%}
  .scenarios{width:100%}
  .report{padding:14px 12px 32px}
  .overview{padding:14px}
  .section-head{align-items:flex-start}
  .controls{width:100%}
  .image-stage{min-height:240px}
  .facts{grid-template-columns:70px minmax(0,1fr)}
  .case-row{grid-template-columns:auto minmax(0,1fr)}
  .case-duration{grid-column:2}
  .check-head{flex-wrap:wrap}
  .check .check-meta{width:100%;white-space:normal}
}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
`;
