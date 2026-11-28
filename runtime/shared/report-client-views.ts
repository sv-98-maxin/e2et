/** 报告页浏览器脚本片段 2/3：目录、上下文、检查对照、时间线渲染；与 core 同一 IIFE 作用域。 */
export const reportClientViews = String.raw`
  async function copy(text, control, original) {
    try { await navigator.clipboard.writeText(text); control.textContent = '已复制'; }
    catch (_) { const selection = window.getSelection(), range = document.createRange(); range.selectNodeContents(original); selection.removeAllRanges(); selection.addRange(range); control.textContent = '已选中，请复制'; }
  }
  function valueNode(value, present, empty, raw) {
    if (!present) return node('span', 'value muted', empty || '未记录');
    const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    const pretty = JSON.stringify(value, null, 2), full = typeof value === 'string' ? value : pretty;
    const compact = typeof value === 'string' && raw ? value : JSON.stringify(value), container = node('div', 'value');
    const typeLabel = node('span', 'value-type', type);
    if (compact.length <= 110) { container.append(typeLabel, node('code', '', compact)); return container; }
    const details = node('details'), summary = node('summary');
    const size = Array.isArray(value) ? ' · ' + value.length + ' 项' : record(value) ? ' · ' + Object.keys(value).length + ' 字段' : '';
    summary.append(typeLabel, node('span', 'muted', size + ' · 展开完整值'));
    const original = node('pre', '', full), tools = node('div', 'value-tools');
    tools.append(button('复制完整安全值', event => copy(full, event.currentTarget, original)));
    details.append(summary, tools, original); container.append(details); return container;
  }
  function fact(list, label, value, present, empty, raw) { list.append(node('dt', '', label)); const cell = node('dd'); cell.append(valueNode(value, present, empty, raw)); list.append(cell); }
  function apisForEvent(caseIndex, event) {
    const testCase = data.cases[caseIndex], steps = testCase.steps.concat(testCase.appendix || []);
    const step = steps.find(item => (item.eventIds || []).includes(event.id))
      || (event.actionId ? steps.find(item => (item.actionIds || []).includes(event.actionId) || (item.eventIds || []).includes(event.actionId)) : undefined);
    const apis = step ? step.apis || (step.api ? [step.api] : []) : [];
    if (event.type !== 'assert' && event.type !== 'capture') return apis;
    const references = (Array.isArray(event.evidence) ? event.evidence : [event.evidence]).concat(record(event.valueSource).from);
    return apis.filter(api => references.some(reference => {
      const evidence = record(reference);
      if (typeof evidence.req_id === 'string') return evidence.req_id === api.reqId;
      const req = record(evidence.req);
      return typeof req.path === 'string' && typeof req.nav === 'string' && Number.isInteger(req.call_index)
        && req.path === api.path && req.nav === api.nav && req.call_index === api.callIndex;
    }));
  }
  function apiEvidence(api) {
    const list = node('dl', 'facts');
    fact(list, '接口', (api.method || '') + ' ' + (api.url || api.path || '未记录'), true);
    fact(list, '状态', api.status, has(api, 'status'));
    fact(list, 'traceId', api.traceId, has(api, 'traceId'), '未采集 traceId');
    fact(list, '请求参数', api.reqBody, has(api, 'reqBody'), '未记录请求体', true);
    fact(list, '响应头', api.respHeaders, has(api, 'respHeaders'), '未记录响应头', true);
    fact(list, '响应原文', api.respBody, has(api, 'respBody'), '响应体未采集或已脱敏', true);
    return list;
  }
  function apiLabel(api) {
    return [api.method, api.path || api.url].filter(Boolean).join(' ') || '接口';
  }
  function imageCandidates(caseIndex, event) {
    if (status(event) === 'not_run') return [];
    const testCase = data.cases[caseIndex], images = testCase.images || [];
    const step = testCase.steps.concat(testCase.appendix || []).find(item => (item.eventIds || []).includes(event.id))
      || (event.actionId ? testCase.steps.concat(testCase.appendix || []).find(item => (item.actionIds || []).includes(event.actionId)) : undefined);
    const preferred = event.type !== 'action' && step && (step.eventIds || []).slice().reverse().find(id => images.some(image => image.eventId === id));
    const actionId = event.type === 'action' ? event.actionId || event.id : event.actionId;
    const direct = images.filter(image => image.eventId === event.id);
    const associated = actionId ? images.filter(image => image.actionId === actionId) : [];
    const candidates = event.type === 'action' ? Array.from(new Set(direct.concat(associated))) : direct.length ? direct : associated;
    const explicit = candidates.filter(image => image.phase !== 'after_action');
    return (explicit.length ? explicit : candidates).sort((left, right) => {
      if (preferred) {
        if (left.eventId === preferred) return -1;
        if (right.eventId === preferred) return 1;
      }
      return (event.type === 'action' ? Number(right.phase === 'after_action') - Number(left.phase === 'after_action') : 0) || left.sequence - right.sequence;
    });
  }
  function renderCases() {
    const root = get('cases'); if (!root) return;
    root.replaceChildren();
    let passed = 0, failed = 0, blocked = 0;
    data.cases.forEach((testCase, caseIndex) => {
      const state = testCase.result === 'PASS' ? 'pass' : testCase.result === 'FAIL' ? 'fail' : 'blocked';
      if (state === 'pass') passed++; else if (state === 'fail') failed++; else blocked++;
      const stats = caseStats(caseIndex);
      const row = button('', () => selectCase(caseIndex), 'case-row');
      row.dataset.case = String(caseIndex);
      row.setAttribute('aria-current', String(caseIndex === currentCase));
      const main = node('div', 'case-main');
      main.append(node('div', 'case-name', caseName(testCase)), node('div', 'case-meta', stats.meta));
      row.append(badge(state, testCase.result), main, node('span', 'case-duration', stats.duration));
      root.append(row);
    });
    const count = get('case-count');
    if (count) count.textContent = data.cases.length + ' 个用例 · ' + passed + ' 通过' + (failed ? ' · ' + failed + ' 失败' : '') + (blocked ? ' · ' + blocked + ' 阻断' : '');
    const section = get('cases-section');
    if (section) section.hidden = data.cases.length <= 1;
    const center = get('center');
    if (center) center.classList.toggle('multi', data.cases.length > 1);
  }
  function renderDirectory() {
    const root = get('scenarios'); root.replaceChildren();
    scopes.forEach((scope, index) => {
      if (scope.caseIndex !== currentCase) return;
      const entry = button('', () => selectScope(index), 'scenario'); entry.dataset.index = String(index); entry.setAttribute('aria-current', String(index === currentScope));
      const content = node('div'), state = scopeState(scope);
      const business = scope.allEvents.filter(isBusiness).length;
      const count = business ? business + ' 个步骤' : scope.allEvents.length + ' 条辅助记录';
      content.append(node('span', 'scenario-name', scope.name), node('br'), badge(state, count + ' · ' + states[state]));
      if (!scope.allEvents.length) content.append(node('div', 'small muted', '无执行记录'));
      if (scope.scenario) { const unbound = scope.scenario.checks.filter(check => !boundEvents(scope.caseIndex, scope.scenario, check).length).length; if (unbound) content.append(node('div', 'small muted', unbound + ' 项未绑定')); }
      entry.append(node('span', 'mono small muted', String(index + 1).padStart(2, '0')), content); root.append(entry);
    });
  }
  function renderContext(scope) {
    const root = get('context'); root.replaceChildren(); root.append(node('h2', '', scope.name));
    const testCase = data.cases[scope.caseIndex];
    if (scope.scenario) {
      const source = scope.scenario.source;
      root.append(node('p', '', '预期来源：' + sourceLabels[source.kind] + (source.text ? ' · ' + source.text : '') + (source.ref ? ' · ' + source.ref : '')));
      const details = node('details'), list = node('dl', 'facts'); details.append(node('summary', 'small muted', '前提与操作约束'));
      fact(list, '前提', scope.scenario.preconditions, true); fact(list, '操作约束', scope.scenario.actions, has(scope.scenario, 'actions')); details.append(list); root.append(details);
    } else if (data.cases[scope.caseIndex].acceptance) root.append(node('p', '', '该范围未绑定验收场景'));
    const coverage = testCase.coverage || data.coverage;
    if (coverage && (coverage.plan || coverage.missing.length || coverage.unplanned.length)) {
      const details = node('details', 'coverage-boundary');
      details.append(node('summary', '', '验证范围与边界' + (coverage.missing.length ? ' · 覆盖计划缺失 ' + coverage.missing.length + ' 项' : '')));
      const list = node('dl', 'facts');
      fact(list, '计划范围', coverage.plan, coverage.plan !== null, '未提供覆盖计划');
      fact(list, '已执行', coverage.executed, true);
      fact(list, '缺失', coverage.missing, true);
      fact(list, '计划外', coverage.unplanned, true);
      details.append(list); root.append(details);
    }
    if (testCase.backendInfo) {
      const info = testCase.backendInfo, details = node('details', 'tech-evidence backend-diagnostics');
      details.append(node('summary', '', '后端失败诊断'));
      const list = node('dl', 'facts');
      fact(list, '接口', info.api, true); fact(list, 'traceId', info.traceId, has(info, 'traceId'), '未采集 traceId');
      fact(list, '时间', info.time, has(info, 'time'), '时间未记录'); fact(list, '失败', info.failure, has(info, 'failure'));
      fact(list, '响应', info.response, has(info, 'response')); fact(list, '参数', info.params, has(info, 'params'));
      details.append(list); root.append(details);
    }
    if (scopeState(scope) === 'blocked') {
      const steps = scope.group === undefined && !scope.scenario ? testCase.steps : testCase.steps.filter(step => step.group === scope.group);
      const notices = steps.filter(step => step.status === 'blocked' || step.sourceStatus === 'blocked').map(step => step.screenshotNotice || step.observation).filter(Boolean);
      root.append(node('p', 'alert', '场景阻断 · ' + (notices.join('；') || testCase.summary || '本次执行报告标记 BLOCKED')));
    }
  }
  function humanValue(value, present, empty, note, exact) {
    if (!present) return node('span', 'value muted', empty || '未记录');
    const container = node('div', 'value'), text = typeof value === 'string' ? (exact ? JSON.stringify(value) : value) : JSON.stringify(value);
    if (text.length > 200) {
      const details = node('details', 'value-long');
      details.append(node('summary', '', '长值 · ' + text.length + ' 字符 · 展开'), node('pre', '', text));
      container.append(details);
    } else container.append(node('code', 'mono human-value', text));
    if (note) container.append(node('span', 'small muted', ' · ' + note));
    return container;
  }
  function humanFact(list, label, value, present, empty, note, exact) {
    list.append(node('dt', '', label));
    const cell = node('dd'); cell.append(humanValue(value, present, empty, note, exact)); list.append(cell);
  }
  function actualFact(list, label, event) {
    const missing = { missing: '缺失', unavailable: '不可用', not_collected: '未采集' };
    const present = (event.actualStatus === undefined || event.actualStatus === 'present') && has(event, 'actual');
    const summary = present ? actualSummary(event) : undefined;
    if (summary !== undefined) { humanFact(list, label, summary, true); return; }
    humanFact(list, label, event.actual, (event.actualStatus === undefined || event.actualStatus === 'present') && has(event, 'actual'), missing[event.actualStatus] || '未采集', undefined, true);
  }
  function stepEvents(scope) { return scope.events.filter(event => event.type !== 'assert'); }
  function stepChecks(scope, actionId) { return scope.events.filter(event => event.type === 'assert' && event.actionId === actionId); }
  let checkRows = [];
  function stepIndexOf(scope, event) {
    const actionId = event.type === 'action' ? event.id : event.actionId;
    if (!actionId) return undefined;
    const index = stepEvents(scope).findIndex(item => item.type === 'action' && (item.id === actionId || item.actionId === actionId));
    return index < 0 ? undefined : index + 1;
  }
  function checkRow(scope, plan, event, events) {
    const state = plan ? planState(events) : status(event);
    const row = node('article', 'check'); row.dataset.state = state;
    if (plan) row.dataset.planId = plan.id;
    if (events && events.length) row.dataset.eventIds = events.map(item => item.id).join(',');
    const anchor = events.find(item => ['fail', 'error'].includes(status(item))) || event || events[0];
    if (anchor) { row.dataset.eventId = anchor.id; if (anchor.actionId) row.dataset.actionId = anchor.actionId; }
    const apis = anchor ? apisForEvent(scope.caseIndex, anchor) : [], api = apis[0];
    const apiAssertion = Boolean(anchor && (anchor.kind === 'api' || anchor.kind === 'request'));
    const label = plan ? plan.expectation : apiAssertion ? '接口断言 · ' + (api ? apiLabel(api) : '未关联') : assertionTitle(anchor);
    const title = button(label, () => {
      if (!anchor) return;
      selectedCheck = anchor.id; selectCheck(anchor.id); focusStep(anchor.id);
    }, 'check-name');
    const head = node('div', 'check-head'); head.append(badge(state), title);
    const bits = [];
    if (anchor) {
      const summary = actualSummary(anchor);
      if (summary !== undefined) bits.push('实测 ' + summary);
      const step = stepIndexOf(scope, anchor);
      if (step !== undefined) bits.push('第 ' + step + ' 步');
    } else bits.push('本次未核销');
    if (events.length > 1) bits.push(events.length + ' 条记录');
    head.append(node('span', 'check-meta', bits.join(' · ')));
    row.append(head);
    const details = node('details', 'check-detail');
    details.append(node('summary', 'small muted', '详情'));
    const facts = node('dl', 'facts');
    if (!anchor) {
      humanFact(facts, '期望', plan.expectation, true, undefined, undefined, true);
      humanFact(facts, '本次结果', '未执行或未绑定', true);
    } else {
      const expected = assertionValue(anchor);
      if (apiAssertion) {
        if (api) humanFact(facts, '接口状态', api.status, has(api, 'status'), '未记录');
        else humanFact(facts, '接口', '未关联接口证据', true);
        const path = record(anchor.expect).path;
        if (path) humanFact(facts, '断言字段', path, true);
      } else humanFact(facts, '对象', targetSummary(anchor), true);
      humanFact(facts, '条件', assertionCondition(anchor), true);
      humanFact(facts, '期望', expected, expected !== undefined, '未记录', undefined, true);
      actualFact(facts, '实测', anchor);
      if (whitespaceNote(expected)) humanFact(facts, '空白检查', whitespaceNote(expected), true);
    }
    details.append(facts);
    if (anchor) {
      if (anchor.error) details.append(node('p', 'error-message', (anchor.error.code || '') + ' ' + anchor.error.message));
      if (anchor.redacted || anchor.truncated) details.append(node('p', 'alert', [anchor.redacted && '已脱敏', anchor.truncated && '生产记录已截断'].filter(Boolean).join(' · ') + '，完整核验受此边界限制'));
      const flagged = ['fail', 'error'].includes(status(anchor)) || apis.some(api => Number(api.status) >= 400) || scopeState(scope) !== 'pass';
      const trace = apis.find(api => api.traceId);
      if (flagged && trace) details.append(node('p', 'trace-id', 'traceId · ' + trace.traceId));
      if (apis.length) {
        const tech = node('details', 'tech-evidence');
        tech.append(node('summary', '', '接口证据 · ' + apis.map(apiLabel).join(' / ')));
        apis.forEach(api => tech.append(apiEvidence(api)));
        details.append(tech);
      }
    }
    row.append(details);
    return row;
  }
  function renderChecks(scope) {
    const root = get('checks'), section = get('checks-section');
    root.replaceChildren(); checkRows = [];
    if (scope.scenario) {
      const handled = new Set();
      scope.scenario.checks.forEach(plan => {
        const events = boundEvents(scope.caseIndex, scope.scenario, plan);
        events.forEach(event => handled.add(event.id));
        const primary = events.find(event => ['fail', 'error'].includes(status(event))) || events[events.length - 1];
        root.append(checkRow(scope, plan, primary, events));
      });
      const extras = scope.events.filter(event => event.type === 'assert' && !handled.has(event.id));
      if (extras.length) {
        const details = node('details', 'check-extras');
        details.append(node('summary', '', '计划外断言 · ' + extras.length + ' 条'));
        extras.forEach(event => details.append(checkRow(scope, undefined, event, [event])));
        root.append(details);
      }
      if (!scope.scenario.checks.length) root.append(node('p', 'alert', '验收说明没有计划检查，需求覆盖未验证'));
    } else {
      scope.events.filter(event => event.type === 'assert').forEach(event => root.append(checkRow(scope, undefined, event, [event])));
    }
    checkRows = Array.from(root.querySelectorAll('.check'));
    const count = root.querySelectorAll('.check').length;
    get('check-count').textContent = count ? count + ' 项' : '';
    if (section) section.hidden = !root.children.length;
  }
  function actionMeta(event) {
    if (event.kind === 'open' || event.kind === 'refresh') return event.args && event.args.url || event.input || '';
    if (event.kind === 'execute') return '脚本操作';
    const target = targetOf(event), selector = target.selector || target.css || target.label || target.text || target.name;
    if (selector) return selector;
    if (event.input !== undefined && event.input !== null) return '输入 ' + JSON.stringify(event.input);
    return '';
  }
  function actionOutcome(event) {
    const actual = record(event.actual);
    if (event.status !== 'pass') return '未通过';
    if (event.kind === 'open') return '页面已打开';
    if (event.kind === 'refresh') return '页面已刷新';
    if (typeof actual.text === 'string') return JSON.stringify(actual.text);
    if (typeof actual.outputValue === 'string') return actual.outputValue;
    if (typeof actual.resolvedValue === 'string') return actual.resolvedValue;
    return '完成';
  }
  function stepTitle(event) {
    if (event.type === 'action') return actionTitle(event);
    if (event.type === 'assert') return '检查：' + assertionTitle(event);
    if (event.type === 'error') return '执行错误';
    return '辅助观察 · ' + event.kind;
  }
  function stepMeta(scope, event) {
    if (event.type === 'action') {
      const checks = stepChecks(scope, event.id), meta = [];
      if (checks.length) meta.push('断言 ' + checks.filter(item => status(item) === 'pass').length + '/' + checks.length);
      meta.push(duration(event));
      return meta.filter(Boolean).join(' · ');
    }
    if (event.type === 'assert') return duration(event);
    if (event.type === 'error') return event.error && event.error.message || event.kind;
    return ['observation', event.intent, states[status(event)], duration(event)].filter(Boolean).join(' · ');
  }
  function stepFacts(scope, event) {
    const facts = node('dl', 'facts');
    if (event.type === 'action') {
      humanFact(facts, '目标', actionMeta(event), Boolean(actionMeta(event)), '未记录');
      humanFact(facts, '结果', actionOutcome(event), true);
    } else if (event.type === 'assert') {
      const expected = assertionValue(event), apis = apisForEvent(scope.caseIndex, event), api = apis[0];
      const apiAssertion = event.kind === 'api' || event.kind === 'request';
      if (apiAssertion) {
        if (api) humanFact(facts, '接口状态', api.status, has(api, 'status'), '未记录');
        else humanFact(facts, '接口', '未关联接口证据', true);
        const path = record(event.expect).path;
        if (path) humanFact(facts, '断言字段', path, true);
      } else humanFact(facts, '对象', targetSummary(event), true);
      humanFact(facts, '条件', assertionCondition(event), true);
      humanFact(facts, '期望', expected, expected !== undefined, '未记录', undefined, true);
      actualFact(facts, '实测', event);
      if (whitespaceNote(expected)) humanFact(facts, '空白检查', whitespaceNote(expected), true);
    } else if (event.type === 'error') {
      humanFact(facts, '错误', event.error && event.error.message || event.kind, true);
      if (event.error && event.error.code) humanFact(facts, '错误码', event.error.code, true);
    } else {
      actualFact(facts, '结果', event);
      const apis = apisForEvent(scope.caseIndex, event);
      if (apis.length) humanFact(facts, '接口', apis.map(apiLabel).join(' / '), true);
      humanFact(facts, '时间', time(event.startedAt), true);
    }
    return facts;
  }
  function stepBlock(scope, event, index) {
    const actionId = event.type === 'action' ? event.id : event.actionId;
    const card = node('article', 'step');
    card.dataset.eventId = event.id; card.dataset.state = status(event);
    if (actionId) card.dataset.actionId = actionId;
    const head = node('div', 'step-head');
    head.append(node('span', 'step-index', String(index + 1).padStart(2, '0')), node('span', 'step-title', stepTitle(event)),
      badge(status(event)), node('span', 'step-meta', stepMeta(scope, event)));
    card.append(head, stepFacts(scope, event));
    if (event.type === 'action' && /execute|script/i.test(event.kind)) card.append(node('p', 'alert', '脚本操作 · 只展示已记录脚本与返回，不推断为键盘或鼠标路径'));
    if (event.error) card.append(node('p', 'error-message', (event.error.code || '') + ' ' + event.error.message));
    const preview = stepPreview(scope, event);
    if (preview) card.append(preview);
    return card;
  }
  function stepPreview(scope, event) {
    if (!imageCandidates(scope.caseIndex, event).length && !apisForEvent(scope.caseIndex, event).length) return undefined;
    const preview = node('section', 'preview'), label = node('div', 'image-label'), picker = node('div', 'row small step-images');
    const head = node('div', 'preview-head'), stage = node('div', 'image-stage');
    head.append(label); preview.append(head, picker, stage);
    renderImages(scope, event, label, picker, stage);
    return preview;
  }
  function renderSteps(scope) {
    const root = get('steps'); root.replaceChildren();
    const steps = stepEvents(scope), events = steps.length ? steps : scope.events;
    if (!events.length) { root.append(node('p', 'empty', '本范围没有可展示的业务步骤。')); return; }
    events.forEach((event, index) => root.append(stepBlock(scope, event, index)));
  }
`;
