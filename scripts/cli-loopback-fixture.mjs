// 工具自身 loopback 自测；复用现有通用 smoke 界面。
import * as fs from 'node:fs';
import * as http from 'node:http';

const smokeHtml = fs.readFileSync(new URL('../test/fixtures/runtime-smoke/test.html', import.meta.url), 'utf8').split('<script>')[0].replace('>商品名称</label>', '>工具名称输入</label>');

let negative = false;
// category 中间层 click noop（POST /fixture-mode 的 category_noop 字段）：仅使「蔬菜」click 不展开
// 叶菜；与 negative 独立，负模式只置 categoryNoop、negative 保持 false，同 IR/同 URL 回放必红
let categoryNoop = false;
const records = [];

function buildWaitPage(frame = false) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>wait contract</title></head><body>
<button id="wait-target" aria-label="等待\u200b目标">等待目标</button>
<button id="wait-remove">移除等待目标</button><button id="wait-hide">隐藏等待目标</button>
<button id="wait-replace">替换等待目标</button><button id="wait-replace-hidden">隐藏替换目标</button>
<button id="wait-duplicate">复制等待目标</button><button id="wait-future">创建未来目标</button>
<button id="wait-start">开始顺序等待</button><button id="wait-budget">开始共同预算</button>
<button id="wait-frame-nav">等待frame导航</button><button id="wait-read-fail">破坏文本读取</button>
<button id="wait-spa">同文档导航</button><button id="wait-document">跨文档导航</button>
<label for="wait-output">等待输出</label><input id="wait-output" aria-label="等待输出" value="旧输出">
<p id="wait-status"></p><p id="wait-save-status">尚未使用输出</p><p id="wait-count">副作用0</p>
<button id="wait-use-output">使用等待输出</button><div id="wait-future-host"></div>
<div id="wait-shadow"></div>
${frame ? '' : '<iframe id="wait-frame" name="wait-frame" src="/contract-wait/frame"></iframe>'}
<script>
const negative = ${negative};
let count = 0;
const status = document.getElementById('wait-status');
const bump = () => document.getElementById('wait-count').textContent = '副作用' + (++count);
const target = () => document.getElementById('wait-target');
document.getElementById('wait-remove').onclick = () => { bump(); target()?.remove(); };
document.getElementById('wait-hide').onclick = () => { bump(); target().style.display = 'none'; };
const replace = hidden => {
  bump(); const fresh = target().cloneNode(true); fresh.setAttribute('aria-label', '等待\u00a0目标');
  fresh.style.display = hidden ? 'none' : ''; target().replaceWith(fresh);
};
document.getElementById('wait-replace').onclick = () => replace(false);
document.getElementById('wait-replace-hidden').onclick = () => replace(true);
document.getElementById('wait-duplicate').onclick = () => { bump(); const fresh = target().cloneNode(true); fresh.id = 'wait-duplicate-target'; document.body.append(fresh); };
document.getElementById('wait-future').onclick = () => {
  bump(); setTimeout(() => {
    const host = document.getElementById('wait-future-host');
    host.innerHTML = '<button aria-label="未来裸名">未来裸名</button><button aria-label="未来声明">未来声明</button><label for="wait-future-input">未来关联标签</label><input id="wait-future-input" aria-label="未来ARIA标签"><div id="wait-future-css" role="button" aria-label="未来CSS角色">未来CSS</div><p>未来 <span>嵌套文本</span></p>';
    const testid = document.createElement('button'); testid.textContent = '未来测试属性'; testid.setAttribute('data-testid', 'future"\\\\]'); host.append(testid);
  }, 180);
};
document.getElementById('wait-start').onclick = async () => {
  bump(); status.textContent = '';
  const request = fetch('/api/wait-order');
  if (negative) { setTimeout(() => status.textContent = '顺序完成', 80); setTimeout(() => status.textContent = '', 200); }
  await request; if (!negative) status.textContent = '顺序完成';
};
document.getElementById('wait-budget').onclick = async () => {
  bump(); status.textContent = ''; await fetch('/api/wait-budget');
  setTimeout(() => status.textContent = '预算完成', 450);
};
document.getElementById('wait-output').oninput = () => { bump(); status.textContent = negative ? '' : '输出就绪'; };
document.getElementById('wait-use-output').onclick = () => {
  const value = document.getElementById('wait-output').value;
  document.getElementById('wait-save-status').textContent = '使用输出:' + value;
  fetch('/fixture-wait-output', { method: 'POST', body: value });
};
document.getElementById('wait-read-fail').onclick = () => { bump(); Object.defineProperty(document.body, 'innerText', { get() { throw new Error('fixture text read failure'); } }); };
document.getElementById('wait-spa').onclick = () => { bump(); history.pushState({}, '', '#same-document'); };
document.getElementById('wait-document').onclick = () => location.href = '/contract-wait?new-document=1';
document.getElementById('wait-frame-nav').onclick = () => {
  ${frame ? "location.href = '/contract-wait/frame?fresh=1';" : "document.getElementById('wait-frame').src = '/contract-wait/frame?fresh=1';"}
};
document.getElementById('wait-shadow').attachShadow({ mode: 'open' }).innerHTML = '<button aria-label="Shadow等待" style="display:none">Shadow等待</button>';
if (location.search.includes('fresh=1')) status.textContent = 'frame新文档';
</script></body></html>`;
}

function buildBetaActionsPage(frame = false) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>beta actions contract</title>
<style>#beta-contents{display:contents}#beta-portal{position:fixed;left:220px;top:100px;padding:25px;background:#eee}button{margin:8px}</style></head><body>
<button id="beta-click">可信点击</button><button id="beta-disabled" disabled>禁用点击</button>
<button id="beta-invisible" style="visibility:hidden">不可见点击</button><button id="beta-display-none" style="display:none">隐藏点击</button>
<button id="beta-contents"><span>Contents点击</span></button>
<button id="beta-confirm-accept">确认接受</button><button id="beta-confirm-dismiss">确认拒绝</button>
<button id="beta-prompt-accept">输入接受</button><button id="beta-prompt-dismiss">输入拒绝</button>
<button id="beta-wait-dialog">等待中对话框</button><button id="beta-popup">创建早popup</button>
<button id="beta-hover" aria-controls="beta-portal">悬停触发</button><button id="beta-unrelated">无关离开</button>
<div id="beta-portal" hidden><button id="beta-portal-action">关联Portal</button></div>
<p id="beta-click-status">点击0;trusted:false</p><p id="beta-dialog-status">尚无对话框</p>
<p id="beta-hover-status">悬停关闭</p><p id="beta-parent-echo">父竞争0</p>
<button id="beta-frame-echo">Frame回声</button><p id="beta-frame-status">frame回声0</p>
${frame ? '' : '<iframe id="beta-frame" name="beta-frame" src="/contract-beta-actions/frame"></iframe>'}
<script>
const negative = ${negative}; let count = 0; let echoes = 0;
const clickStatus = document.getElementById('beta-click-status');
for (const id of ['beta-click','beta-disabled','beta-invisible','beta-display-none','beta-contents']) {
  document.getElementById(id).addEventListener('click', event => {
    count++; clickStatus.textContent = '点击' + count + ';trusted:' + event.isTrusted;
    fetch('/fixture-beta-event', { method: 'POST', body: JSON.stringify({ id, count, trusted: event.isTrusted, frame: ${frame} }) });
  });
}
const dialogStatus = document.getElementById('beta-dialog-status');
document.getElementById('beta-confirm-accept').onclick = () => dialogStatus.textContent = 'confirm:' + confirm('虚构确认接受');
document.getElementById('beta-confirm-dismiss').onclick = () => dialogStatus.textContent = 'confirm:' + confirm('虚构确认拒绝');
document.getElementById('beta-prompt-accept').onclick = () => dialogStatus.textContent = 'prompt:' + JSON.stringify(prompt('虚构输入接受', '默认虚构'));
document.getElementById('beta-prompt-dismiss').onclick = () => dialogStatus.textContent = 'prompt:' + JSON.stringify(prompt('虚构输入拒绝', '默认虚构'));
document.getElementById('beta-wait-dialog').onclick = () => {
  dialogStatus.textContent = ''; setTimeout(() => { const answer = confirm('虚构等待中确认'); dialogStatus.textContent = '等待confirm:' + answer; }, 220);
};
document.getElementById('beta-popup').onclick = () => window.open('/contract-beta-actions?early-popup=1', 'beta-early-popup');
const portal = document.getElementById('beta-portal'); const hoverStatus = document.getElementById('beta-hover-status');
const close = () => { portal.hidden = true; hoverStatus.textContent = '悬停关闭'; };
document.getElementById('beta-hover').onmouseenter = () => { portal.hidden = false; hoverStatus.textContent = '悬停打开'; };
document.getElementById('beta-hover').onmouseleave = () => { setTimeout(() => { if (!portal.matches(':hover') && !document.getElementById('beta-hover').matches(':hover')) close(); }, 100); };
portal.onmouseenter = () => hoverStatus.textContent = 'Portal悬停'; portal.onmouseleave = close;
document.getElementById('beta-portal-action').onclick = () => hoverStatus.textContent = 'Portal点击完成';
document.getElementById('beta-unrelated').onmouseenter = close;
document.getElementById('beta-frame-echo').onclick = event => {
  echoes++; document.getElementById('beta-frame-status').textContent = 'frame回声' + echoes + ';trusted:' + event.isTrusted;
  ${frame ? "parent.postMessage({ betaEcho: echoes, trusted: event.isTrusted }, '*');" : "document.getElementById('beta-parent-echo').textContent = '父竞争' + echoes;"}
};
window.addEventListener('message', event => { if (event.data?.betaEcho) document.getElementById('beta-parent-echo').textContent = 'iframe回声' + event.data.betaEcho + ';trusted:' + event.data.trusted; });
if (location.search.includes('early-popup=1')) fetch('/api/beta-popup-early').then(() => dialogStatus.textContent = '早popup就绪');
</script></body></html>`;
}

function buildPage() {
  return smokeHtml + `
<h2>多文本</h2>
<button id="dup-btn-a" type="button">确认提交</button>
<button id="dup-btn-b" type="button">确认提交</button>
<p id="unique-text">仅此一处</p>

<h2>表格</h2>
<table id="item-table"><thead><tr><th>名称</th><th>编码</th></tr></thead><tbody id="contract-table-body"></tbody></table>
<button id="fetch-api-btn" type="button">加载API</button>
<p id="api-status"></p>
<h2>Phase2 字段与来源</h2>
<label for="desc-input">工具描述</label><textarea id="desc-input" aria-label="工具描述"></textarea>
<label for="cat-select">工具类目</label><select id="cat-select" aria-label="工具类目"><option value="fruit" selected>水果</option><option value="veg">蔬菜</option></select>
<label for="pwd-input">凭证通道</label><input type="password" id="pwd-input" aria-label="凭证通道" value="fixture_pwd_value" />
<label for="zw-input">工具\u200b原值</label><input type="text" id="zw-input" aria-label="工具\u200b原值" value="zero\u200bwidth" />
<label>重复字段</label><input id="duplicate-one" aria-label="重复字段" value="val1" /><input id="duplicate-two" aria-label="重复字段" value="val2" />
<div id="value-wrapper" aria-label="文本原值">文本原值</div>
<button id="load-protected-api" type="button" aria-label="加载保护API">加载保护API</button>
<button id="load-invalid-api" type="button">加载无效API</button>
<p id="input-ready" aria-label="输入就绪"></p>
<p id="binding-status" aria-label="绑定状态"></p>
<p id="protected-api-status"></p>
<h2>Phase2 凭证回放探针</h2>
<label for="replay-pwd-input">回放密码通道</label><input type="text" id="replay-pwd-input" aria-label="回放密码通道" />
<p id="replay-pwd-status" aria-label="回放密码状态"></p>
<label for="focus-pwd-input">焦点密码通道</label><input type="text" id="focus-pwd-input" aria-label="焦点密码通道" />
<p id="focus-pwd-status" aria-label="焦点密码状态"></p>
<div id="biz-type-wrapper" role="textbox" aria-label="业务类型包装">业务文本保持</div>
<button id="load-replay-url" type="button" aria-label="加载回放URL">加载回放URL</button>

<script>
window.contractProbe = { markerLiteral: "[REDACTED]", rewritten: "token=fixture_only_not_auth" };
var NEGATIVE = ${negative};
var inputReadyEl = document.getElementById('input-ready');
document.getElementById('name-input').addEventListener('input', () => {
  if (!NEGATIVE && inputReadyEl) inputReadyEl.textContent = '输入就绪';
});
document.getElementById('desc-input').addEventListener('input', function () {
  var expected = NEGATIVE ? document.getElementById('code-input').value : document.getElementById('name-input').value;
  var bindingEl = document.getElementById('binding-status');
  if (bindingEl) bindingEl.textContent = this.value === expected ? '绑定正确' : '绑定漂移';
});
// R-PWD：正模式 text（初始"尚未写入"，input 后"通道守住"）；负模式 password（初始"通道守住"，任何 input 即"通道失守"）。
// 负模式 focus 事件把 password 改回 text，打预点击绕过——writer 必须在预 click 前的初始 guard 拒绝
var replayPwdInput = document.getElementById('replay-pwd-input');
var replayPwdStatus = document.getElementById('replay-pwd-status');
if (NEGATIVE) {
  replayPwdInput.type = 'password';
  replayPwdInput.addEventListener('focus', function () { this.type = 'text'; });
}
replayPwdStatus.textContent = NEGATIVE ? '通道守住' : '尚未写入';
replayPwdInput.addEventListener('input', function () {
  replayPwdStatus.textContent = NEGATIVE ? '通道失守' : '通道守住';
});
// F-PWD：负模式初始“通道守住”；正模式初始“尚未写入”，实际 input 后才“通道守住”。
// 负模式 focus 事件把自己 type 改 password 保持；任何 input 即“通道失守”，不依赖当前 type
var focusPwdInput = document.getElementById('focus-pwd-input');
var focusPwdStatus = document.getElementById('focus-pwd-status');
focusPwdStatus.textContent = NEGATIVE ? '通道守住' : '尚未写入';
if (NEGATIVE) {
  focusPwdInput.addEventListener('focus', function () { this.type = 'password'; });
}
focusPwdInput.addEventListener('input', function () {
  focusPwdStatus.textContent = NEGATIVE ? '通道失守' : '通道守住';
});
// B-TYPE：wrapper 加普通业务 type='password' 属性——不是 native password，capture 仍按自身 text 读取
document.getElementById('biz-type-wrapper').setAttribute('type', 'password');
document.getElementById('load-replay-url').addEventListener('click', async () => {
  const response = await fetch('/api/replay-url');
  const data = await response.json();
  window.__replayUrl = data.url;
});
document.getElementById('submit-btn').addEventListener('click', async () => {
  const name = document.getElementById('name-input').value;
  const response = await fetch('/create', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name})});
  const result = await response.json();
  document.getElementById('result').textContent = result.success ? '已提交: ' + name : '创建失败';
  document.getElementById('toast').textContent = '提交成功';
  document.getElementById('toast').style.display = 'block';
  renderTable();
});
document.getElementById('fetch-api-btn').addEventListener('click', async () => {
  await fetch('/api/test');
  document.getElementById('api-status').textContent = '已加载';
});
document.getElementById('load-protected-api').addEventListener('click', async () => {
  await Promise.all([fetch('/api/cred'), fetch('/api/token-business')]);
  document.getElementById('protected-api-status').textContent = '已加载保护API';
});
document.getElementById('load-invalid-api').addEventListener('click', async () => {
  await Promise.all([fetch('/api/no-body'), fetch('/api/empty')]);
  document.getElementById('protected-api-status').textContent = '已加载无效API';
});
function renderTable() {
  var tbody = document.getElementById('contract-table-body');
  tbody.innerHTML = '';
  var rows = NEGATIVE
    ? [{name:'苹果',code:'A001'},{name:'苹果',code:'A002'},{name:'苹果',code:'A003'}]
    : [{name:'苹果',code:'A001'},{name:'苹果',code:'A002'}];
  rows.forEach(function(r) {
    var tr = document.createElement('tr');
    tr.innerHTML = '<td>' + r.name + '</td><td>' + r.code + '</td>';
    tbody.appendChild(tr);
  });
}
renderTable();
</script></body></html>`;
}

const CRED_PAYLOAD = { token: "fixture_only_credential", amount: 100, items: [{ id: "a", token: "fixture_only_a", amount: 10 }, { id: "b", token: "fixture_only_b", amount: 20 }], payload: { ref: "business", template: "literal", from_action: "ordinary" }, markerLiteral: "[REDACTED]" };

/** /contract-form：fill_form 合同页（Phase3a 剩余 A）。真实 input/change 只修改对应输入；
 *  input 事件同时 postMessage 给父页（/contract-form-frame 子文档复用同一页，独立打开时无害）。
 *  R1 补件：p#form-hover-status + #form-name 真实 mouseenter —— 供无输出 hover 写前拒绝
 *  （状态保持“未悬浮”）与普通 hover 正控（变“已悬浮”），不影响填写/上传既有事件。 */
function buildFormPage() {
  return `<!DOCTYPE html>
<html lang="zh">
<head><meta charset="utf-8"><title>contract form</title></head>
<body>
<h2>Form 合同页</h2>
<label for="form-name">表单名称</label><input id="form-name" aria-label="表单名称" value="旧名称" required />
<label for="form-note">表单备注</label><textarea id="form-note" aria-label="表单备注" required>旧备注</textarea>
<label for="form-unspecified">未提供必填</label><input id="form-unspecified" aria-label="未提供必填" value="必须保留" required />
<label for="form-disabled">禁用字段</label><input id="form-disabled" aria-label="禁用字段" value="禁止写" disabled />
<label for="form-skip">跳过字段</label><input id="form-skip" aria-label="跳过字段" value="跳过旧值" />
<label for="form-json-echo">表单输出消费</label><input id="form-json-echo" aria-label="表单输出消费" />
<label for="form-file">测试附件</label><input type="file" id="form-file" aria-label="测试附件" />
<p id="form-file-status" aria-label="附件状态">未上传</p>
<p id="form-hover-status" aria-label="悬浮状态">未悬浮</p>
<script>
(function () {
  function post(field, value) {
    try { parent.postMessage({ type: 'form-echo', field: field, value: value }, '*'); } catch (e) { /* 独立打开时无父页监听 */ }
  }
  document.getElementById('form-name').addEventListener('input', function () { post('name', this.value); });
  document.getElementById('form-name').addEventListener('mouseenter', function () {
    document.getElementById('form-hover-status').textContent = '已悬浮';
  });
  document.getElementById('form-note').addEventListener('input', function () { post('note', this.value); });
  document.getElementById('form-file').addEventListener('change', function () {
    var names = Array.prototype.map.call(this.files, function (f) { return f.name; });
    document.getElementById('form-file-status').textContent = names.length > 0 ? 'files=' + names.join(',') : '未上传';
  });
})();
</script>
</body></html>`;
}

/** /contract-form-frame：父页同名字段竞争 + iframe#form-frame 加载 /contract-form；
 *  子页 input 事件 postMessage 回声到父页两个只读输入。 */
function buildFormFramePage() {
  return `<!DOCTYPE html>
<html lang="zh">
<head><meta charset="utf-8"><title>contract form frame</title></head>
<body>
<h2>Form Frame 合同页</h2>
<label for="parent-name">表单名称</label><input id="parent-name" aria-label="表单名称" value="父名称" />
<label for="parent-note">表单备注</label><input id="parent-note" aria-label="表单备注" value="父备注" />
<iframe id="form-frame" src="/contract-form" title="表单子页"></iframe>
<label for="child-name-echo">子名称结果</label><input id="child-name-echo" aria-label="子名称结果" value="旧名称" readonly />
<label for="child-note-echo">子备注结果</label><input id="child-note-echo" aria-label="子备注结果" value="旧备注" readonly />
<script>
window.addEventListener('message', function (e) {
  if (!e.data || e.data.type !== 'form-echo') return;
  if (e.data.field === 'name') document.getElementById('child-name-echo').value = e.data.value;
  if (e.data.field === 'note') document.getElementById('child-note-echo').value = e.data.value;
});
</script>
</body></html>`;
}

/** /contract-form-duplicate：两个同 name“重复字段” + 正常“表单名称”；重复写必须在其它正常字段写前拒绝。 */
function buildFormDuplicatePage() {
  return `<!DOCTYPE html>
<html lang="zh">
<head><meta charset="utf-8"><title>contract form duplicate</title></head>
<body>
<h2>Form Duplicate 合同页</h2>
<label for="dup-a">重复字段</label><input id="dup-a" aria-label="重复字段" value="重复一" />
<label for="dup-b">重复字段</label><input id="dup-b" aria-label="重复字段" value="重复二" />
<label for="dup-name">表单名称</label><input id="dup-name" aria-label="表单名称" value="旧名称" />
</body></html>`;
}

/** /contract-form-write-failure：正常“表单名称”在前；div#form-unwritable（role=combobox、
 *  自身文本、无内部 input/textarea）使共源 writer 的真实拒绝分支可达；“后续字段”在最后。 */
function buildFormWriteFailurePage() {
  return `<!DOCTYPE html>
<html lang="zh">
<head><meta charset="utf-8"><title>contract form write failure</title></head>
<body>
<h2>Form Write Failure 合同页</h2>
<label for="wf-name">表单名称</label><input id="wf-name" aria-label="表单名称" />
<div id="form-unwritable" role="combobox" aria-label="不可直接填字段">原选项</div>
<label for="wf-next">后续字段</label><input id="wf-next" aria-label="后续字段" value="不得写" />
<label for="form-json-echo">表单输出消费</label><input id="form-json-echo" aria-label="表单输出消费" />
</body></html>`;
}

/** /contract-form-order：DOM 先“2”后“1”；字段 2 真实 input 把字段 1 值改为“被二影响”并把
 *  其 label/aria-label 改为“一已改名”；字段 1 只写自身。另有 name=__proto__ 的真实输入
 *  （字段名字符串 key 序列化契约：Record 动态 key 不丢不改原型）。 */
function buildFormOrderPage() {
  return `<!DOCTYPE html>
<html lang="zh">
<head><meta charset="utf-8"><title>contract form order</title></head>
<body>
<h2>Form Order 合同页</h2>
<label for="order-2">2</label><input id="order-2" aria-label="2" value="旧二" />
<label for="order-1" id="label-1">1</label><input id="order-1" aria-label="1" value="旧一" />
<label for="order-proto">__proto__</label><input id="order-proto" aria-label="__proto__" value="原型旧值" />
<script>
document.getElementById('order-2').addEventListener('input', function () {
  var one = document.getElementById('order-1');
  one.value = '被二影响';
  document.getElementById('label-1').textContent = '一已改名';
  one.setAttribute('aria-label', '一已改名');
});
</script>
</body></html>`;
}

/** /contract-identity：唯一 #identity-target（首屏 page state 有唯一 roleLocator）；
 *  hide 隐藏不 detach；remove 在 positive 真正 remove、在 negative 用同 role/name/id 新按钮
 *  replace 并保持可见；duplicate 新增同 role/name 可见目标；两个同 role/name“无身份目标”
 *  按钮供 page state 产生没有唯一 roleLocator 的真实 ref。状态段落用真实操作更新。
 *  R1 补件：#no-identity-remove 真实移除无身份按钮；#identity-dialog-open + aria-modal
 *  弹层（打开后层内唯一按钮，稳定身份目标仍在外部真实可见，供“过滤展示树查身份”的错误
 *  实现被识别）；#identity-unicode-target 的 aria-label 真实含 U+200B/U+00AD/U+00A0，
 *  negative replace 为去零宽同义名 —— raw AX 名称与 PW exact 规范化同义的判别件。 */
function buildIdentityPage() {
  return `<!DOCTYPE html>
<html lang="zh">
<head><meta charset="utf-8"><title>contract identity</title></head>
<body>
<h2>Identity 合同页</h2>
<p id="identity-status" aria-label="身份状态">初始</p>
<button id="identity-target" type="button" aria-label="稳定身份目标">稳定身份目标</button>
<button id="identity-hide" type="button" aria-label="隐藏稳定身份">隐藏稳定身份</button>
<button id="identity-remove" type="button" aria-label="移除稳定身份">移除稳定身份</button>
<button id="identity-duplicate" type="button" aria-label="复制稳定身份">复制稳定身份</button>
<button id="no-identity-a" type="button" aria-label="无身份目标">无身份目标</button>
<button id="no-identity-b" type="button" aria-label="无身份目标">无身份目标</button>
<button id="no-identity-remove" type="button" aria-label="移除无身份目标">移除无身份目标</button>
<button id="identity-dialog-open" type="button" aria-label="打开身份弹层">打开身份弹层</button>
<button id="identity-unicode-remove" type="button" aria-label="移除Unicode身份目标">移除Unicode身份目标</button>
<button id="identity-unicode-target" type="button" aria-label="Unicode&#8203;身&#173;份&#160;目标">Unicode&#8203;身&#173;份&#160;目标</button>
<p id="identity-unicode-status" aria-label="Unicode状态">Unicode初始</p>
<div id="identity-dialog" role="dialog" aria-modal="true" aria-label="身份弹层" style="display:none">
  <button id="identity-dialog-btn" type="button" aria-label="弹层唯一按钮">弹层唯一按钮</button>
</div>
<script>
(function () {
  var NEG = ${negative};
  var status = document.getElementById('identity-status');
  var uStatus = document.getElementById('identity-unicode-status');
  function makeTarget(id) {
    var b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('aria-label', '稳定身份目标');
    b.textContent = '稳定身份目标';
    if (id) b.id = id;
    return b;
  }
  document.getElementById('identity-hide').addEventListener('click', function () {
    document.getElementById('identity-target').style.display = 'none';
    status.textContent = '已隐藏';
  });
  document.getElementById('identity-remove').addEventListener('click', function () {
    var t = document.getElementById('identity-target');
    if (NEG) {
      t.replaceWith(makeTarget('identity-target'));
      status.textContent = '已替换';
    } else {
      t.remove();
      status.textContent = '已移除';
    }
  });
  document.getElementById('identity-duplicate').addEventListener('click', function () {
    document.getElementById('identity-target').after(makeTarget(null));
    status.textContent = '已复制';
  });
  document.getElementById('no-identity-remove').addEventListener('click', function () {
    var a = document.getElementById('no-identity-a');
    if (a) a.remove();
    status.textContent = '已移除无身份';
  });
  document.getElementById('identity-dialog-open').addEventListener('click', function () {
    document.getElementById('identity-dialog').style.display = 'block';
    status.textContent = '已开弹层';
  });
  document.getElementById('identity-unicode-remove').addEventListener('click', function () {
    var t = document.getElementById('identity-unicode-target');
    if (NEG) {
      var b = document.createElement('button');
      b.type = 'button';
      b.id = 'identity-unicode-target';
      b.setAttribute('aria-label', 'Unicode身份 目标');
      b.textContent = 'Unicode身份 目标';
      t.replaceWith(b);
      uStatus.textContent = 'Unicode已替换';
    } else {
      t.remove();
      uStatus.textContent = 'Unicode已移除';
    }
  });
})();
</script>
</body></html>`;
}

/** /contract-scroll：Scroll 合同页（Phase3a Scroll 子集专用）。
 *  正模式：整页 x/y 可滚（tall spacer）、嵌套容器 x/y 可滚、center-target 视口居中、边界状态；
 *  负模式（同 URL，内容无 overflow）：整页与容器都不可滚，录制正 IR 必须真实失败。
 *  UI 自身把坐标写入状态文本，tester 不用 execute 注入脚本。 */
function buildScrollPage() {
  const tall = negative ? 'height:120px;width:120px' : 'height:2400px;width:2400px';
  const box = negative ? 'height:120px;width:160px;overflow:visible' : 'height:200px;width:300px;overflow:auto';
  const inner = negative ? 'height:80px;width:120px' : 'height:900px;width:1500px';
  const boxTargetMargin = negative ? 'margin-left:8px;margin-top:8px' : 'margin-left:1300px;margin-top:850px';
  return `<!DOCTYPE html>
<html lang="zh">
<head><meta charset="utf-8"><title>scroll contract</title></head>
<body>
<h2>Scroll 合同页</h2>
<p id="scroll-status" aria-label="整页滚动状态">整页 x=0 y=0</p>
<p id="boundary-status" aria-label="整页边界状态">未达边界</p>
<div id="scroll-box" style="${box}">
  <div id="scroll-box-inner" style="${inner}">
    <span id="box-target" style="display:inline-block;${boxTargetMargin}">容器内目标</span>
  </div>
</div>
<p id="container-status" aria-label="容器滚动状态">容器 x=0 y=0</p>
<div id="no-scroll-box"><span id="no-scroll-target">无滚动祖先目标</span></div>
<p id="center-status" aria-label="居中状态">未居中</p>
<div id="tall-spacer" style="${tall}"><span id="center-target">居中目标</span></div>
<script>
(function () {
  var win = document.getElementById('scroll-status');
  var boundary = document.getElementById('boundary-status');
  var cont = document.getElementById('container-status');
  var center = document.getElementById('center-status');
  var box = document.getElementById('scroll-box');
  var target = document.getElementById('center-target');
  function report() {
    win.textContent = '整页 x=' + window.scrollX + ' y=' + window.scrollY;
    var doc = document.documentElement;
    boundary.textContent = window.innerHeight + window.scrollY >= doc.scrollHeight - 1 ? '已达底部' : '未达边界';
    cont.textContent = '容器 x=' + box.scrollLeft + ' y=' + box.scrollTop;
    var r = target.getBoundingClientRect();
    center.textContent = Math.abs(r.top + r.height / 2 - window.innerHeight / 2) < 40 ? '已居中' : '未居中';
  }
  window.addEventListener('scroll', report, true);
  box.addEventListener('scroll', report);
  window.addEventListener('resize', report);
  report();
})();
</script>
</body>
</html>`;
}

/** /contract-scroll-frame：Scroll frame 合同页（无 target scroll --frame 专用）。
 *  父页主文档不可滚动，只显示自身 x/y 并监听 scroll；iframe（id=scroll-frame，640x480）
 *  复用 /contract-scroll 子页及其既有状态文本——整页滚动必须发生在 iframe window，父页 x=y=0。 */
function buildScrollFramePage() {
  return `<!DOCTYPE html>
<html lang="zh">
<head><meta charset="utf-8"><title>scroll frame contract</title><style>html,body{overflow:hidden;margin:0}</style></head>
<body>
<h2>Scroll Frame 合同页</h2>
<p id="main-scroll-status" aria-label="主页面滚动状态">主页面 x=0 y=0</p>
<iframe id="scroll-frame" src="/contract-scroll" style="width:640px;height:480px;border:1px solid #999"></iframe>
<script>
(function () {
  var el = document.getElementById('main-scroll-status');
  function report() {
    el.textContent = '主页面 x=' + window.scrollX + ' y=' + window.scrollY;
  }
  window.addEventListener('scroll', report, true);
  report();
})();
</script>
</body>
</html>`;
}

/** /contract-navigation：导航合同页（Beta Navigation 专用，本地假数据）。
 *  按钮/状态全部由 fixture 自身事件写入，tester 不注入 execute。
 *  覆盖：导航API、同路径双请求、SPA同URL、iframe（不增全局 n）、redirect 链（只分一 n）、
 *  延迟导航（Document request 先到 + 旧文档 provisional 期间同 URL pushState）。 */
function buildNavigationPage() {
  return `<!DOCTYPE html>
<html lang="zh">
<head><meta charset="utf-8"><title>navigation contract</title></head>
<body>
<h2>Navigation 合同页</h2>
<button id="nav-api-btn" type="button">加载导航API</button>
<button id="nav-order-btn" type="button">加载同路径双请求</button>
<button id="nav-spa-btn" type="button">SPA同URL</button>
<button id="nav-frame-btn" type="button">加载iframe</button>
<button id="nav-slow-btn" type="button">延迟导航</button>
<button id="nav-body-btn" type="button">加载请求响应体</button>
<p id="nav-status" aria-label="导航状态">等待操作</p>
<div id="nav-frame-host"></div>
<script>
(function () {
  var status = document.getElementById('nav-status');
  document.getElementById('nav-api-btn').addEventListener('click', async function () {
    await fetch('/api/navigation');
    status.textContent = '导航API完成';
  });
  document.getElementById('nav-order-btn').addEventListener('click', async function () {
    var first = fetch('/api/navigation-order?slot=1');
    var second = fetch('/api/navigation-order?slot=2');
    var results = await Promise.all([first, second]);
    var bodies = await Promise.all([results[0].json(), results[1].json()]);
    status.textContent = '双请求完成 ' + bodies[0].slot + '/' + bodies[1].slot;
  });
  document.getElementById('nav-spa-btn').addEventListener('click', async function () {
    history.pushState({}, '', location.href);
    await fetch('/api/navigation');
    status.textContent = 'SPA接口完成';
  });
  document.getElementById('nav-frame-btn').addEventListener('click', function () {
    // 主页面 API 与 iframe Document 并存：iframe 不增全局 n，主页面请求仍归原 n
    fetch('/api/navigation');
    var host = document.getElementById('nav-frame-host');
    var frame = document.createElement('iframe');
    frame.id = 'nav-frame';
    frame.src = '/contract-navigation/frame';
    host.appendChild(frame);
  });
  window.addEventListener('message', function (event) {
    if (event.data === 'nav-frame-loaded') status.textContent = 'iframe已加载';
  });
  document.getElementById('nav-slow-btn').addEventListener('click', function () {
    var oldUrl = location.href;
    location.href = '/contract-navigation/slow';
    // 旧文档 provisional 期间对旧 URL 做 pushState（同 URL）：same-document 独立分 n，commit 恢复 pending n
    setTimeout(function () { history.pushState({}, '', oldUrl); }, 100);
  });
  document.getElementById('nav-body-btn').addEventListener('click', async function () {
    // 普通业务 key（不当 Value 元数据解读）；两侧核请求体与响应体，不以 headers 完成为通过
    var payload = { ref: 'nav-ref', template: 'nav-template', from_action: 'nav-from-action' };
    var response = await fetch('/api/navigation-body', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    var data = await response.json();
    status.textContent = data.echo && data.echo.ref === 'nav-ref' ? '请求响应体完成' : '请求响应体失败';
  });
})();
</script>
</body>
</html>`;
}

/** /contract-navigation/frame：iframe 子页，加载完成后向父页发消息（父页显示“iframe已加载”）。 */
function buildNavigationFramePage() {
  return `<!DOCTYPE html>
<html lang="zh">
<head><meta charset="utf-8"><title>navigation frame</title></head>
<body>
<p id="nav-frame-status">iframe 子页已加载</p>
<script>
if (window.parent !== window) window.parent.postMessage('nav-frame-loaded', location.origin);
</script>
</body>
</html>`;
}

/** /contract-native-selection：原生 select 选择合同页（Phase3a 原生选择子集专用）。
 *  正例：label≠value（蔬菜/veg）、唯一子串（“蔬”）、精确优先、不同 label 同 value、合法空 label，
 *  七类拒绝控件在 positive 下均改合法可录；负例随全局 negative（POST /fixture-mode）切换：
 *  sel-main 首项改“根茎”（零匹配）、sel-dup-label 次项改“苹果”（精确多匹配）、
 *  sel-ambiguous 次项改“蔬菜罐头”（子串歧义）、sel-disabled/sel-optgroup/sel-fieldset 追加 disabled、
 *  sel-aria 祖先 aria-disabled 置 true。
 *  状态文本由真实 selectedOptions 派生，change 后刷新；tester 不注入 execute。 */
function buildNativeSelectionPage() {
  const ids = ['sel-main', 'sel-same-value', 'sel-exact-first', 'sel-dup-label', 'sel-ambiguous', 'sel-disabled', 'sel-optgroup', 'sel-fieldset', 'sel-aria', 'sel-empty'];
  const selects = [
    '<label for="sel-main">主类目</label><select id="sel-main" aria-label="主类目"><option value="veg">' + (negative ? '根茎' : '蔬菜') + '</option><option value="fruit" selected>水果</option><option value="meat">肉类</option></select>',
    '<label for="sel-same-value">同值类目</label><select id="sel-same-value" aria-label="同值类目"><option value="veg">蔬菜</option><option value="veg">蔬菜罐头</option></select>',
    '<label for="sel-exact-first">精确优先类目</label><select id="sel-exact-first" aria-label="精确优先类目"><option value="veg">蔬菜</option><option value="canned">蔬菜罐头</option></select>',
    '<label for="sel-dup-label">重复选项类目</label><select id="sel-dup-label" aria-label="重复选项类目"><option value="a">苹果</option><option value="b">' + (negative ? '苹果' : '梨') + '</option></select>',
    '<label for="sel-ambiguous">歧义子串类目</label><select id="sel-ambiguous" aria-label="歧义子串类目"><option value="veg">蔬菜</option><option value="canned">' + (negative ? '蔬菜罐头' : '水果') + '</option></select>',
    '<label for="sel-disabled">禁用选项类目</label><select id="sel-disabled" aria-label="禁用选项类目"><option value="ok" selected>可选类目</option><option value="frozen"' + (negative ? ' disabled' : '') + '>冻结类目</option></select>',
    '<label for="sel-optgroup">分组类目</label><select id="sel-optgroup" aria-label="分组类目"><option value="plain">普通类目</option><optgroup label="禁用分组"' + (negative ? ' disabled' : '') + '><option value="grouped">分组内类目</option></optgroup></select>',
    '<fieldset id="fs-disabled"' + (negative ? ' disabled' : '') + '><label for="sel-fieldset">禁用域类目</label><select id="sel-fieldset" aria-label="禁用域类目"><option value="x">域内类目</option></select></fieldset>',
    '<div aria-disabled="' + (negative ? 'true' : 'false') + '"><label for="sel-aria">禁用态类目</label><select id="sel-aria" aria-label="禁用态类目"><option value="y">禁用态选项</option></select></div>',
    '<label for="sel-empty">空选项类目</label><select id="sel-empty" aria-label="空选项类目"><option value="blank"></option><option value="filled" selected>非空类目</option></select>',
  ].join('\n');
  return `<!DOCTYPE html>
<html lang="zh">
<head><meta charset="utf-8"><title>native selection contract</title></head>
<body>
<h2>Native Selection 合同页</h2>
${selects}
<p id="selection-status" aria-label="选择状态">待选择</p>
<script>
(function () {
  var ids = ${JSON.stringify(ids)};
  var status = document.getElementById('selection-status');
  function labelOf(option) {
    return (option.label || option.textContent || '').trim();
  }
  function report() {
    var parts = [];
    ids.forEach(function (id) {
      var sel = document.getElementById(id);
      var picked = sel.selectedOptions[0];
      parts.push(id + '=' + (picked ? labelOf(picked) + '/' + picked.value : 'none'));
    });
    status.textContent = parts.join(' ');
  }
  ids.forEach(function (id) {
    document.getElementById(id).addEventListener('change', report);
  });
  report();
})();
</script>
</body>
</html>`;
}

/** /contract-selection：选择合同页（Phase3a 选择子集专用，本地虚构值）。
 *  覆盖：custom 单选（aria-controls 声明池）、accessible name≠innerText 正例、keep-open 多选
 *  （aria-owns + menuitemcheckbox）、filter combobox（输入替换过滤）、三级级联 tree、
 *  page-scope 唯一可见池、同名其他池隔离、native multiple、动态 aria-label（seed input 事件
 *  真实改 option 的 aria-label，回放按当前池重匹配，不冻结录制 picked name）。
 *  负模式随全局 negative 切换：零匹配/精确歧义/子串歧义/禁用/声明池失效。
 *  状态文本全部由真实事件派生（aria-label 通道），tester 不注入 execute。 */
function buildSelectionPage() {
  const csThird = negative ? '根茎' : '蔬菜';
  const negDupSecond = negative ? '苹果' : '梨';
  const negAmbigSecond = negative ? '蔬菜罐头' : '水果';
  const negDisabled = negative ? ' aria-disabled="true"' : '';
  const negMissingTarget = negative ? 'sel-neg-missing-pool-gone' : 'sel-neg-missing-pool';
  // 长池：152 个真实 option，8 组无 role 包装（AX ignored 中间节点，两侧遍历必须穿透）
  const longPoolGroups = [];
  for (let g = 0; g < 8; g++) {
    const items = [];
    for (let i = 1; i <= 19; i++) {
      const n = g * 19 + i;
      items.push('<div role="option" aria-selected="false" data-n="' + n + '">长选项' + String(n).padStart(3, '0') + '</div>');
    }
    longPoolGroups.push('<div class="long-group">' + items.join('') + '</div>');
  }
  return `<!DOCTYPE html>
<html lang="zh">
<head><meta charset="utf-8"><title>selection contract</title></head>
<body>
<h2>Selection 合同页</h2>

<h3>custom 单选</h3>
<button id="sel-cs-root" type="button" aria-haspopup="listbox" aria-expanded="false" aria-controls="sel-cs-pool">单选类目</button>
<div id="sel-cs-pool" role="listbox" aria-label="单选类目池" hidden>
  <div role="option" aria-selected="false">苹果</div>
  <div role="option" aria-selected="false" aria-label="可见名称雪梨">内部文本pear</div>
  <div role="option" aria-selected="false">${csThird}</div>
</div>
<p id="sel-cs-status" aria-label="单选选择状态">未选择</p>

<h3>keep-open 多选</h3>
<button id="sel-ko-root" type="button" aria-expanded="false" aria-owns="sel-ko-pool">多选餐段</button>
<div id="sel-ko-pool" role="listbox" aria-label="多选餐段池" hidden>
  <div role="menuitemcheckbox" aria-checked="false">早餐</div>
  <div role="menuitemcheckbox" aria-checked="false">午餐</div>
  <div role="menuitemcheckbox" aria-checked="false">晚餐</div>
</div>
<p id="sel-ko-status" aria-label="多选选择状态">未选择</p>

<h3>filter 搜索选择</h3>
<input id="sel-filter-root" type="text" role="combobox" aria-expanded="false" aria-controls="sel-filter-pool" aria-label="搜索类目" />
<div id="sel-filter-pool" role="listbox" aria-label="搜索类目池" hidden>
  <div role="option" aria-selected="false">香蕉</div>
  <div role="option" aria-selected="false">香梨</div>
  <div role="option" aria-selected="false">芒果</div>
</div>
<p id="sel-filter-status" aria-label="过滤选择状态">未选择</p>

<h3>三级级联</h3>
<button id="sel-cat-root" type="button" aria-expanded="false" aria-controls="sel-cat-pool">类目级联</button>
<div id="sel-cat-pool" role="tree" aria-label="类目级联池" hidden>
  <div role="treeitem" aria-label="生鲜" aria-expanded="false" aria-selected="false">生鲜面板
    <div role="treeitem" aria-label="蔬菜" aria-expanded="false" aria-selected="false" hidden>蔬菜面板
      ${negative ? '' : '<div role="treeitem" aria-label="叶菜" aria-selected="false" hidden>叶菜末级</div>'}
    </div>
  </div>
  <div role="treeitem" aria-label="食品" aria-expanded="false" aria-selected="false">食品面板
    ${negative ? '<div role="treeitem" aria-label="叶菜" aria-selected="false" hidden>叶菜末级</div>' : ''}
    <div role="treeitem" aria-label="粮油" aria-selected="false" hidden>粮油末级</div>
  </div>
</div>
<p id="sel-cat-status" aria-label="级联选择状态">未选择</p>

<h3>页面池选择（无声明）</h3>
<button id="sel-ps-root" type="button" aria-expanded="false">页面池选择</button>
<div id="sel-ps-pool" role="listbox" aria-label="页面池" hidden>
  <div role="option" aria-selected="false">页面池选项甲</div>
  <div role="option" aria-selected="false">页面池选项乙</div>
</div>
<p id="sel-ps-status" aria-label="页面池选择状态">未选择</p>

<h3>同名其他组件池</h3>
<button id="sel-other-root" type="button" aria-expanded="false" aria-controls="sel-other-pool">其他组件</button>
<div id="sel-other-pool" role="listbox" aria-label="其他组件池" hidden>
  <div role="option" aria-selected="false">蔬菜</div>
</div>
<p id="sel-other-status" aria-label="其他组件状态">未选择</p>

<h3>native multiple</h3>
<label for="sel-nm">多选下拉</label>
<select id="sel-nm" aria-label="多选下拉" multiple size="4">
  <option value="a" selected>甲项</option>
  <option value="b">乙项</option>
  <option value="c">丙项</option>
</select>
<p id="sel-nm-status" aria-label="多选下拉状态">甲项</p>

<h3>长列表池（152 选项，ignored 中间嵌套）</h3>
<button id="sel-long-root" type="button" aria-haspopup="listbox" aria-expanded="false" aria-controls="sel-long-pool">长列表类目</button>
<div id="sel-long-pool" role="listbox" aria-label="长列表池" hidden style="max-height:200px;overflow:auto">
  ${longPoolGroups.join('')}
</div>
<p id="sel-long-status" aria-label="长列表选择状态">未选择</p>

<h3>动态 aria-label</h3>
<label for="dyn-seed">动态种子</label>
<input id="dyn-seed" type="text" aria-label="动态种子" />
<button id="dyn-root" type="button" aria-haspopup="listbox" aria-expanded="false" aria-controls="dyn-pool">动态类目</button>
<div id="dyn-pool" role="listbox" aria-label="动态类目池" hidden>
  <div role="option" id="dyn-opt" aria-label="label-000000" aria-selected="false">初始动态选项</div>
</div>
<p id="dyn-status" aria-label="动态选择状态">未选择</p>

<h3>原子单项身份（事件替换）</h3>
<select id="sel-atomic-single" aria-label="原子单项">
  <option value="decoy" selected>占位诱饵</option>
  <option id="sel-atomic-single-option" value="old">原子目标</option>
</select>
<input id="sel-atomic-single-status" type="text" readonly aria-label="原子单项状态" value="未选择" />

<h3>原子多项身份（事件替换）</h3>
<select id="sel-atomic-multi" aria-label="原子多项" multiple size="4">
  <option id="sel-atomic-a" value="old-a">原子甲</option>
  <option id="sel-atomic-b" value="old-b">原子乙</option>
</select>
<input id="sel-atomic-multi-status" type="text" readonly aria-label="原子多项状态" value="未选择" />

<h3>无 id 池 + 两个 group 归一</h3>
<button id="sel-noid-root" type="button" aria-expanded="false">无锚点类目</button>
<div data-case="sel-noid-pool" role="listbox" aria-label="无锚点类目池" hidden>
  <div role="group" aria-label="无锚点组一">
    <div role="option" aria-selected="false">无锚点甲</div>
  </div>
  <div role="group" aria-label="无锚点组二">
    <div role="option" aria-selected="false">无锚点乙</div>
  </div>
</div>
<input id="sel-noid-status" type="text" readonly aria-label="无锚点状态" value="未选择" />

<h3>嵌套声明去重</h3>
<button id="sel-nest-root" type="button" aria-expanded="false" aria-controls="sel-nest-outer sel-nest-inner">嵌套声明</button>
<div id="sel-nest-outer" role="listbox" aria-label="外层池" hidden>
  <div role="option" aria-selected="false">外层甲</div>
  <div id="sel-nest-inner" role="group" aria-label="内层组">
    <div role="option" aria-selected="false">内层甲</div>
  </div>
</div>
<input id="sel-nest-status" type="text" readonly aria-label="嵌套状态" value="未选择" />

<h3>CSS 控制字符 ID 声明池</h3>
<button id="sel-escape-root" type="button" aria-expanded="false">转义类目</button>
<div data-escape-pool role="listbox" aria-label="转义池" hidden>
  <div role="option" aria-selected="false">转义甲</div>
</div>
<input id="sel-escape-status" type="text" readonly aria-label="转义状态" value="未选择" />

<h3>延迟替换非空旧池</h3>
<input id="sel-async-root" type="text" role="combobox" aria-expanded="false" aria-controls="sel-async-pool" aria-label="异步类目" />
<div id="sel-async-pool" role="listbox" aria-label="异步池" hidden>
  <div role="option" aria-selected="false">旧选项</div>
</div>
<input id="sel-async-status" type="text" readonly aria-label="异步状态" value="未选择" />

<h3>声明子池级联</h3>
<button id="sel-child-cat-root" type="button" aria-expanded="false" aria-controls="sel-child-cat-pool">子池级联</button>
<div id="sel-child-cat-pool" role="tree" aria-label="子池级联顶层" hidden>
  <div role="treeitem" id="sel-child-cat-parent" aria-controls="sel-child-cat-next" aria-expanded="false" aria-selected="false">父类</div>
</div>
<div id="sel-child-cat-next" role="tree" aria-label="子池级联子层" hidden>
  <div role="treeitem" aria-selected="false">子类</div>
</div>
<input id="sel-child-cat-status" type="text" readonly aria-label="子池级联状态" value="未选择" />

<h3>选择输出消费</h3>
<input id="sel-output-consumer" type="text" aria-label="选择输出消费" />
<input id="sel-output-after" type="text" aria-label="失败后输出" />

<h3>拒绝负例组</h3>
<button id="sel-neg-zero-root" type="button" aria-expanded="false" aria-controls="sel-neg-zero-pool">零匹配类目</button>
<div id="sel-neg-zero-pool" role="listbox" hidden>
  <div role="option" aria-selected="false">${negative ? '根茎' : '蔬菜'}</div>
</div>
<p id="sel-neg-zero-status" aria-label="零匹配状态">未选择</p>
<button id="sel-neg-dup-root" type="button" aria-expanded="false" aria-controls="sel-neg-dup-pool">重复类目</button>
<div id="sel-neg-dup-pool" role="listbox" hidden>
  <div role="option" aria-selected="false">苹果</div>
  <div role="option" aria-selected="false">${negDupSecond}</div>
</div>
<p id="sel-neg-dup-status" aria-label="重复类目状态">未选择</p>
<button id="sel-neg-ambig-root" type="button" aria-expanded="false" aria-controls="sel-neg-ambig-pool">歧义类目</button>
<div id="sel-neg-ambig-pool" role="listbox" hidden>
  <div role="option" aria-selected="false">蔬菜</div>
  <div role="option" aria-selected="false">${negAmbigSecond}</div>
</div>
<p id="sel-neg-ambig-status" aria-label="歧义类目状态">未选择</p>
<button id="sel-neg-disabled-root" type="button" aria-expanded="false" aria-controls="sel-neg-disabled-pool">禁用类目</button>
<div id="sel-neg-disabled-pool" role="listbox" hidden>
  <div role="option" aria-selected="false"${negDisabled}>蔬菜</div>
</div>
<p id="sel-neg-disabled-status" aria-label="禁用类目状态">未选择</p>
<button id="sel-neg-missing-root" type="button" aria-expanded="false" aria-controls="${negMissingTarget}">失效类目</button>
<div id="sel-neg-missing-pool" role="listbox" hidden>
  <div role="option" aria-selected="false">蔬菜</div>
</div>
<p id="sel-neg-missing-status" aria-label="失效类目状态">未选择</p>

<script>
(function () {
  var NEGATIVE = ${negative};
  var CATEGORY_NOOP = ${categoryNoop};
  function nameOf(el) {
    return (el.getAttribute('aria-label') || el.textContent || '').trim();
  }
  function optionDisabled(el) {
    return el.getAttribute('aria-disabled') === 'true' || el.closest('[aria-disabled="true"]') !== null;
  }
  function bindSingleToggle(rootId, poolId, statusId, keepOpen) {
    var root = document.getElementById(rootId);
    var pool = document.getElementById(poolId);
    var status = document.getElementById(statusId);
    root.addEventListener('click', function () {
      pool.hidden = !pool.hidden;
      root.setAttribute('aria-expanded', pool.hidden ? 'false' : 'true');
    });
    pool.addEventListener('click', function (ev) {
      var opt = ev.target.closest('[role="option"], [role="menuitemcheckbox"]');
      if (!opt || !pool.contains(opt)) return;
      if (optionDisabled(opt)) return;
      if (opt.getAttribute('role') === 'menuitemcheckbox') {
        var checked = opt.getAttribute('aria-checked') === 'true';
        opt.setAttribute('aria-checked', checked ? 'false' : 'true');
        status.textContent = Array.prototype.map.call(pool.querySelectorAll('[aria-checked="true"]'), nameOf).join(',');
        return;
      }
      Array.prototype.forEach.call(pool.querySelectorAll('[aria-selected]'), function (o) { o.setAttribute('aria-selected', 'false'); });
      opt.setAttribute('aria-selected', 'true');
      status.textContent = nameOf(opt);
      if (!keepOpen) { pool.hidden = true; root.setAttribute('aria-expanded', 'false'); }
    });
  }
  bindSingleToggle('sel-cs-root', 'sel-cs-pool', 'sel-cs-status', false);
  bindSingleToggle('sel-ko-root', 'sel-ko-pool', 'sel-ko-status', true);
  bindSingleToggle('sel-ps-root', 'sel-ps-pool', 'sel-ps-status', false);
  bindSingleToggle('sel-other-root', 'sel-other-pool', 'sel-other-status', false);
  bindSingleToggle('sel-long-root', 'sel-long-pool', 'sel-long-status', false);
  ['sel-neg-zero', 'sel-neg-dup', 'sel-neg-ambig', 'sel-neg-disabled', 'sel-neg-missing'].forEach(function (prefix) {
    bindSingleToggle(prefix + '-root', prefix + '-pool', prefix + '-status', false);
  });

  // filter combobox：input 事件替换过滤（不追加），选项按包含匹配显示
  var filterRoot = document.getElementById('sel-filter-root');
  var filterPool = document.getElementById('sel-filter-pool');
  var filterStatus = document.getElementById('sel-filter-status');
  filterRoot.addEventListener('input', function () {
    var want = filterRoot.value.trim();
    filterPool.hidden = false;
    filterRoot.setAttribute('aria-expanded', 'true');
    Array.prototype.forEach.call(filterPool.querySelectorAll('[role="option"]'), function (opt) {
      opt.style.display = want === '' || nameOf(opt).includes(want) ? '' : 'none';
    });
  });
  filterPool.addEventListener('click', function (ev) {
    var opt = ev.target.closest('[role="option"]');
    if (!opt || !filterPool.contains(opt) || optionDisabled(opt)) return;
    Array.prototype.forEach.call(filterPool.querySelectorAll('[aria-selected]'), function (o) { o.setAttribute('aria-selected', 'false'); });
    opt.setAttribute('aria-selected', 'true');
    filterStatus.textContent = nameOf(opt);
    filterPool.hidden = true;
    filterRoot.setAttribute('aria-expanded', 'false');
  });

  // 级联：父级点击只展开直接子级（:scope，unhide 仅直接子级，展开判定用直接子级），
  // 叶子点击选中并收起整池；nameOf 只读 aria-label，状态按实际祖先 aria-label 链生成
  var catRoot = document.getElementById('sel-cat-root');
  var catPool = document.getElementById('sel-cat-pool');
  var catStatus = document.getElementById('sel-cat-status');
  catRoot.addEventListener('click', function () {
    catPool.hidden = !catPool.hidden;
    catRoot.setAttribute('aria-expanded', catPool.hidden ? 'false' : 'true');
  });
  catPool.addEventListener('click', function (ev) {
    var item = ev.target.closest('[role="treeitem"]');
    if (!item || !catPool.contains(item) || optionDisabled(item)) return;
    var children = item.querySelectorAll(':scope > [role="treeitem"]');
    if (children.length > 0) {
      item.setAttribute('aria-expanded', 'true');
      if (CATEGORY_NOOP && item.getAttribute('aria-label') === '蔬菜') return; // noop：不展开直接子级，叶菜保持 hidden
      Array.prototype.forEach.call(children, function (child) { child.hidden = false; });
      return;
    }
    Array.prototype.forEach.call(catPool.querySelectorAll('[aria-selected]'), function (o) { o.setAttribute('aria-selected', 'false'); });
    item.setAttribute('aria-selected', 'true');
    var chain = [];
    var node = item;
    while (node && node !== catPool) {
      if (node.getAttribute('role') === 'treeitem') chain.unshift(node.getAttribute('aria-label') || '');
      node = node.parentElement;
    }
    catStatus.textContent = chain.join('/');
    catPool.hidden = true;
    catRoot.setAttribute('aria-expanded', 'false');
  });

  // native multiple：状态 = 当前 selectedOptions 的真实 label
  var selNm = document.getElementById('sel-nm');
  var nmStatus = document.getElementById('sel-nm-status');
  selNm.addEventListener('change', function () {
    nmStatus.textContent = Array.prototype.map.call(selNm.selectedOptions, function (o) { return (o.label || o.textContent || '').trim(); }).join(',');
  });

  // 动态：seed 的 input 事件只真实改写 option 的 aria-label（accessible name ≠ innerText）；
  // 状态初始"未选择"，仅真实 option click 后写为该次 aria-label（capture 后 value-ref 严格 eq 断言）
  var dynSeed = document.getElementById('dyn-seed');
  var dynOpt = document.getElementById('dyn-opt');
  var dynStatus = document.getElementById('dyn-status');
  var dynRoot = document.getElementById('dyn-root');
  var dynPool = document.getElementById('dyn-pool');
  dynSeed.addEventListener('input', function () {
    dynOpt.setAttribute('aria-label', dynSeed.value);
  });
  dynRoot.addEventListener('click', function () {
    dynPool.hidden = !dynPool.hidden;
    dynRoot.setAttribute('aria-expanded', dynPool.hidden ? 'false' : 'true');
  });
  dynPool.addEventListener('click', function (ev) {
    var opt = ev.target.closest('[role="option"]');
    if (!opt || opt !== dynOpt || optionDisabled(opt)) return;
    opt.setAttribute('aria-selected', 'true');
    dynStatus.textContent = nameOf(opt);
    dynPool.hidden = true;
    dynRoot.setAttribute('aria-expanded', 'false');
  });

  // ── 原子单项身份：change 先按真实选中项写状态 old，再以同 label、value=new、
  // id=sel-atomic-single-replacement 的节点替换原 option（诱饵初始 selected）。
  // 判别：写前 capture 原 option backend；写后为替换节点 backend，pick 必须等于原 backend。
  var selAtomicSingle = document.getElementById('sel-atomic-single');
  var atomicSingleStatus = document.getElementById('sel-atomic-single-status');
  selAtomicSingle.addEventListener('change', function () {
    var opt = selAtomicSingle.selectedOptions[0];
    if (!opt) return;
    atomicSingleStatus.value = opt.value;
    if (opt.id === 'sel-atomic-single-option') {
      var replacement = document.createElement('option');
      replacement.id = 'sel-atomic-single-replacement';
      replacement.value = 'new';
      replacement.textContent = (opt.label || opt.textContent || '').trim();
      replacement.selected = true;
      opt.parentNode.replaceChild(replacement, opt);
    }
  });

  // ── 原子多项身份：change 先按真实选中项 values 写状态（old-a,old-b），再逐个以同 label
  // 新 value 替换（id 加 -new 后缀）。保存输出仍是实际 label 数组 JSON。
  var selAtomicMulti = document.getElementById('sel-atomic-multi');
  var atomicMultiStatus = document.getElementById('sel-atomic-multi-status');
  selAtomicMulti.addEventListener('change', function () {
    var selected = Array.prototype.slice.call(selAtomicMulti.selectedOptions);
    if (selected.length === 0) return;
    atomicMultiStatus.value = selected.map(function (o) { return o.value; }).join(',');
    selected.forEach(function (opt) {
      if (opt.id !== 'sel-atomic-a' && opt.id !== 'sel-atomic-b') return;
      var replacement = document.createElement('option');
      replacement.id = opt.id + '-new';
      replacement.value = opt.value.replace('old-', 'new-');
      replacement.textContent = (opt.label || opt.textContent || '').trim();
      replacement.selected = true;
      opt.parentNode.replaceChild(replacement, opt);
    });
  });

  // ── 无 id 池：同一 listbox 下两个 role=group 归一为一个真实池（源码不注入 id）
  var noidRoot = document.getElementById('sel-noid-root');
  var noidPool = document.querySelector('[data-case="sel-noid-pool"]');
  var noidStatus = document.getElementById('sel-noid-status');
  noidRoot.addEventListener('click', function () {
    noidPool.hidden = !noidPool.hidden;
    noidRoot.setAttribute('aria-expanded', noidPool.hidden ? 'false' : 'true');
  });
  noidPool.addEventListener('click', function (ev) {
    var opt = ev.target.closest('[role="option"]');
    if (!opt || !noidPool.contains(opt) || optionDisabled(opt)) return;
    Array.prototype.forEach.call(noidPool.querySelectorAll('[aria-selected]'), function (o) { o.setAttribute('aria-selected', 'false'); });
    opt.setAttribute('aria-selected', 'true');
    noidStatus.value = nameOf(opt);
  });

  // ── 嵌套声明：aria-controls 同时声明 outer/inner，outer 包 inner（containment 去重判别）
  var nestRoot = document.getElementById('sel-nest-root');
  var nestPool = document.getElementById('sel-nest-outer');
  var nestStatus = document.getElementById('sel-nest-status');
  nestRoot.addEventListener('click', function () {
    nestPool.hidden = !nestPool.hidden;
    nestRoot.setAttribute('aria-expanded', nestPool.hidden ? 'false' : 'true');
  });
  nestPool.addEventListener('click', function (ev) {
    var opt = ev.target.closest('[role="option"]');
    if (!opt || !nestPool.contains(opt) || optionDisabled(opt)) return;
    Array.prototype.forEach.call(nestPool.querySelectorAll('[aria-selected]'), function (o) { o.setAttribute('aria-selected', 'false'); });
    opt.setAttribute('aria-selected', 'true');
    nestStatus.value = nameOf(opt);
  });

  // ── CSS 控制字符 ID：脚本持真实池引用设置 id（含 U+0001）并更新 aria-controls
  var escapeRoot = document.getElementById('sel-escape-root');
  var escapePool = document.querySelector('[data-escape-pool]');
  var escapeStatus = document.getElementById('sel-escape-status');
  escapePool.id = 'sel-escape-' + String.fromCharCode(1);
  escapeRoot.setAttribute('aria-controls', escapePool.id);
  escapeRoot.addEventListener('click', function () {
    escapePool.hidden = !escapePool.hidden;
    escapeRoot.setAttribute('aria-expanded', escapePool.hidden ? 'false' : 'true');
  });
  escapePool.addEventListener('click', function (ev) {
    var opt = ev.target.closest('[role="option"]');
    if (!opt || !escapePool.contains(opt) || optionDisabled(opt)) return;
    opt.setAttribute('aria-selected', 'true');
    escapeStatus.value = nameOf(opt);
    escapePool.hidden = true;
    escapeRoot.setAttribute('aria-expanded', 'false');
  });

  // ── 延迟替换：click 打开旧池（旧选项）；filter 输入"新"后 300ms 以同 id 新池替换（含新选项）。
  // 不以旧非空池结束等待：wanted 缺席时等待层必须继续等新池。
  var asyncRoot = document.getElementById('sel-async-root');
  var asyncPool = document.getElementById('sel-async-pool');
  var asyncStatus = document.getElementById('sel-async-status');
  asyncRoot.addEventListener('click', function () {
    asyncPool.hidden = false;
    asyncRoot.setAttribute('aria-expanded', 'true');
  });
  asyncRoot.addEventListener('input', function () {
    if (asyncRoot.value.trim() !== '新') return;
    setTimeout(function () {
      var fresh = document.createElement('div');
      fresh.id = 'sel-async-pool';
      fresh.setAttribute('role', 'listbox');
      fresh.setAttribute('aria-label', '异步池');
      var opt = document.createElement('div');
      opt.setAttribute('role', 'option');
      opt.setAttribute('aria-selected', 'false');
      opt.textContent = '新选项';
      fresh.appendChild(opt);
      asyncPool.parentNode.replaceChild(fresh, asyncPool);
      asyncPool = fresh;
    }, 300);
  });
  document.addEventListener('click', function (ev) {
    if (!ev.target || !ev.target.closest) return;
    var opt = ev.target.closest('#sel-async-pool > [role="option"]');
    if (!opt || optionDisabled(opt)) return;
    opt.setAttribute('aria-selected', 'true');
    asyncStatus.value = nameOf(opt);
  });

  // ── 声明子池级联：顶层父类 aria-controls=sel-child-cat-next（子池在 parent 子树外的
  // sibling）；父类 click 只开子池，子类 click 后状态为 父类/子类（两级真实 click）
  var childCatRoot = document.getElementById('sel-child-cat-root');
  var childCatPool = document.getElementById('sel-child-cat-pool');
  var childCatParent = document.getElementById('sel-child-cat-parent');
  var childCatNext = document.getElementById('sel-child-cat-next');
  var childCatStatus = document.getElementById('sel-child-cat-status');
  childCatRoot.addEventListener('click', function () {
    childCatPool.hidden = !childCatPool.hidden;
    childCatRoot.setAttribute('aria-expanded', childCatPool.hidden ? 'false' : 'true');
  });
  childCatParent.addEventListener('click', function () {
    childCatNext.hidden = false;
    childCatParent.setAttribute('aria-expanded', 'true');
  });
  childCatNext.addEventListener('click', function (ev) {
    var item = ev.target.closest('[role="treeitem"]');
    if (!item || !childCatNext.contains(item) || optionDisabled(item)) return;
    item.setAttribute('aria-selected', 'true');
    childCatStatus.value = childCatParent.textContent.trim() + '/' + nameOf(item);
  });
})();
</script>
</body>
</html>`;
}

/** /contract-selection-frame：选择合同 frame 父页。
 *  iframe 复用 /contract-selection（父子同 CSS/root 名，控件全在子文档）；
 *  父页自带可被误点击真实改变的哨兵控件（非恒真文本），子页操作后父页未变检查可区分 frame 作用域。 */
function buildSelectionFramePage() {
  const csThirdFrame = negative ? '根茎' : '蔬菜';
  return `<!DOCTYPE html>
<html lang="zh">
<head><meta charset="utf-8"><title>selection frame contract</title></head>
<body>
<h2>Selection Frame 合同页</h2>
<p id="sentinel-status" aria-label="父页哨兵状态">哨兵未动</p>
<button id="sentinel-btn" type="button" aria-label="父页哨兵按钮">父页哨兵按钮</button>
<h3>父页同名选择（与子页同 CSS/name/选项的竞争目标）</h3>
<button id="sel-cs-root" type="button" aria-haspopup="listbox" aria-expanded="false" aria-controls="sel-cs-pool">单选类目</button>
<div id="sel-cs-pool" role="listbox" aria-label="单选类目池" hidden>
  <div role="option" aria-selected="false">苹果</div>
  <div role="option" aria-selected="false" aria-label="可见名称雪梨">内部文本pear</div>
  <div role="option" aria-selected="false">${csThirdFrame}</div>
</div>
<input id="sel-parent-status" type="text" readonly aria-label="父页选择状态" value="未选择" />
<iframe id="sel-frame" src="/contract-selection" title="选择合同子页" style="width:900px;height:640px;border:1px solid #999"></iframe>
<script>
(function () {
  var status = document.getElementById('sentinel-status');
  document.getElementById('sentinel-btn').addEventListener('click', function () {
    status.textContent = '哨兵已动';
  });
  // 父页 root/option 是真可交互控件：状态只随父页实际 root/option 事件更新；
  // 子页选择（--frame iframe#sel-frame）后父页状态必须保持「未选择」
  function nameOf(el) {
    return (el.getAttribute('aria-label') || el.textContent || '').trim();
  }
  var root = document.getElementById('sel-cs-root');
  var pool = document.getElementById('sel-cs-pool');
  var selStatus = document.getElementById('sel-parent-status');
  root.addEventListener('click', function () {
    pool.hidden = !pool.hidden;
    root.setAttribute('aria-expanded', pool.hidden ? 'false' : 'true');
  });
  pool.addEventListener('click', function (ev) {
    var opt = ev.target.closest('[role="option"]');
    if (!opt || !pool.contains(opt)) return;
    Array.prototype.forEach.call(pool.querySelectorAll('[aria-selected]'), function (o) { o.setAttribute('aria-selected', 'false'); });
    opt.setAttribute('aria-selected', 'true');
    selStatus.value = nameOf(opt);
    pool.hidden = true;
    root.setAttribute('aria-expanded', 'false');
  });
})();
</script>
</body>
</html>`;
}

/** /contract-navigation/slow：延迟 1500ms 后发 headers + 完整 HTML。
 *  延迟 headers 避免过早 commit，也给后台 tab 的 1s timer clamp 留窗口。 */
function handleNavigationSlow(res) {
  const html = buildNavigationPage();
  setTimeout(() => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  }, 1500);
}

function getApiData() {
  return negative ? {
    deep: { a: { b: { c: 'wrong' } } },
    arr: [4, 5],
    numStr: '99',
    nullVal: 'not-null',
    items: [{id:'a',score:1},{id:'b',score:9}],
  } : {
    deep: { a: { b: { c: 'deep-val' } } },
    arr: [1, 2, 3],
    numStr: '42',
    nullVal: null,
    optional: 'present',
    items: [{id:'a',score:1},{id:'b',score:2}],
  };
}

const server = http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0];

  if (urlPath === '/create' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const record = { id: records.length + 1, ...JSON.parse(body) };
      records.push(record);
      console.log(JSON.stringify({ method: 'POST', path: '/create', id: record.id }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: record }));
    });
  } else if (urlPath === '/fixture-mode' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const mode = JSON.parse(body);
      negative = !!mode.negative;
      categoryNoop = mode.category_noop === true;
      console.log(JSON.stringify({ method: 'POST', path: '/fixture-mode', negative }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ negative, category_noop: categoryNoop }));
    });
  } else if (urlPath === '/fixture-beta-observations') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(records.filter(record => record.path === '/fixture-beta-event' || record.path === '/fixture-wait-output')));
  } else if (urlPath === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(buildPage());
  } else if (urlPath === '/contract-wait' || urlPath === '/contract-wait/frame') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(buildWaitPage(urlPath.endsWith('/frame')));
  } else if (urlPath === '/contract-beta-actions' || urlPath === '/contract-beta-actions/frame') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(buildBetaActionsPage(urlPath.endsWith('/frame')));
  } else if (urlPath === '/fixture-beta-event' || urlPath === '/fixture-wait-output') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => { records.push({ path: urlPath, body }); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); });
  } else if (urlPath === '/api/wait-order' || urlPath === '/api/wait-budget' || urlPath === '/api/beta-popup-early') {
    const delay = urlPath === '/api/wait-budget' ? 450 : urlPath === '/api/wait-order' ? 450 : 0;
    setTimeout(() => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ fixture: 'ready' })); }, delay);
  } else if (urlPath === '/contract-scroll') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(buildScrollPage());
  } else if (urlPath === '/contract-scroll-frame') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(buildScrollFramePage());
  } else if (urlPath === '/contract-navigation') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(buildNavigationPage());
  } else if (urlPath === '/contract-navigation/frame') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(buildNavigationFramePage());
  } else if (urlPath === '/contract-native-selection') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(buildNativeSelectionPage());
  } else if (urlPath === '/contract-selection') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(buildSelectionPage());
  } else if (urlPath === '/contract-selection-frame') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(buildSelectionFramePage());
  } else if (urlPath === '/contract-form') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(buildFormPage());
  } else if (urlPath === '/contract-form-frame') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(buildFormFramePage());
  } else if (urlPath === '/contract-form-duplicate') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(buildFormDuplicatePage());
  } else if (urlPath === '/contract-form-write-failure') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(buildFormWriteFailurePage());
  } else if (urlPath === '/contract-form-order') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(buildFormOrderPage());
  } else if (urlPath === '/contract-identity') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(buildIdentityPage());
  } else if (urlPath === '/contract-navigation/slow') {
    handleNavigationSlow(res);
  } else if (urlPath === '/contract-navigation/redirect') {
    // redirect 链：302 → /contract-navigation/redirect-hop → 302 → /contract-navigation（同 origin）
    res.writeHead(302, { Location: '/contract-navigation/redirect-hop' });
    res.end();
  } else if (urlPath === '/contract-navigation/redirect-hop') {
    res.writeHead(302, { Location: '/contract-navigation' });
    res.end();
  } else if (urlPath === '/api/navigation' && req.method === 'GET') {
    // 正模式 marker=nav-ok；负模式 marker=nav-wrong（仅影响该响应，不新增开关端点）
    const data = { marker: negative ? 'nav-wrong' : 'nav-ok', payload: { ref: 'literal', template: 'literal', from_action: 'literal' } };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  } else if (urlPath === '/api/navigation-order' && req.method === 'GET') {
    const slot = new URL(req.url, 'http://127.0.0.1').searchParams.get('slot') ?? '';
    const respond = () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ slot }));
    };
    // 第一个响应延迟 600ms，第二个立即返回各自 slot：同 path 双请求 call_index=1/2 必须分别归因真实 body
    if (slot === '1') setTimeout(respond, 600); else respond();
  } else if (urlPath === '/api/navigation-body' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      // echo JSON 请求体：响应先发 headers + 部分 JSON，600ms 后发尾部（body 完成不得以 headers 完成为准）
      const payload = JSON.stringify({ echo: body ? JSON.parse(body) : null });
      const head = payload.slice(0, Math.max(1, Math.floor(payload.length / 2)));
      const tail = payload.slice(head.length);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write(head);
      setTimeout(() => res.end(tail), 600);
    });
  } else if (urlPath === '/api/test' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, data: getApiData() }));
  } else if (urlPath === '/api/empty' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({}));
  } else if (urlPath === '/api/cred' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(CRED_PAYLOAD));
  } else if (urlPath === '/api/token-business' && req.method === 'GET') {
    const data = negative ? { ...CRED_PAYLOAD, amount: 999, items: CRED_PAYLOAD.items.map(i => ({ ...i, amount: i.amount * 10 })) } : CRED_PAYLOAD;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  } else if (urlPath === '/api/replay-url' && req.method === 'GET') {
    // R-URL：正返回当前 loopback 普通 URL；负返回 userinfo 凭证 URL（fixture_only 虚构值）。
    // 端口用 server.address() 实际值生成，不信外部 Host。
    const port = server.address().port;
    const data = { url: negative ? `http://fixture_only_user:fixture_only_pwd@127.0.0.1:${port}/` : `http://127.0.0.1:${port}/?replayed=1` };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  } else if (urlPath === '/api/no-body' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('not-json');
  } else { res.writeHead(404); res.end(); }
});
server.listen(Number(process.env.E2ET_FIXTURE_PORT ?? 0), '127.0.0.1', () => console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}/` })));
process.on('SIGTERM', () => server.close());
