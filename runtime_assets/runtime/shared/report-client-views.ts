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
  function linkedAction(caseIndex, event) {
    if (event.type === 'action') return event;
    if (!event.actionId) return undefined;
    const exact = allEvents[caseIndex].find(action => action.type === 'action' && action.id === event.actionId);
    const matches = allEvents[caseIndex].filter(action => action.type === 'action' && action.actionId === event.actionId);
    return exact || (matches.length === 1 ? matches[0] : undefined);
  }
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
    return candidates.sort((left, right) => {
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
    humanFact(list, label, event.actual, (event.actualStatus === undefined || event.actualStatus === 'present') && has(event, 'actual'), missing[event.actualStatus] || '未采集', undefined, true);
  }
  function renderChecks(scope) {
    const root = get('checks'); root.replaceChildren(); const used = new Set();
    function checkCard(event, plan, bindings) {
      const state = event ? status(event) : 'unverified', card = node('article', 'check');
      const apis = event ? apisForEvent(scope.caseIndex, event) : [];
      const api = apis[0];
      const apiAssertion = Boolean(event && (event.kind === 'api' || event.kind === 'request'));
      if (event) { card.dataset.eventId = event.id; card.dataset.actionId = event.actionId || ''; }
      if (plan) card.dataset.planId = plan.id;
      const heading = node('div', 'row between');
      heading.append(button(plan ? plan.expectation : apiAssertion ? '接口断言 · ' + (api ? apiLabel(api) : '未关联') : assertionTitle(event), () => {
        if (event) { selectedCheck = event.id; selectEvent(event.id); get('action').scrollIntoView({ block: 'start', behavior: 'smooth' }); }
      }, 'check-name'), badge(state)); card.append(heading);
      if (plan) {
        const bindingInfo = node('p', 'small muted', bindings.length ? '已绑定 ' + bindings.length + ' 条执行记录' : '未绑定执行记录，不按标题核销');
        bindingInfo.append(node('span', '', ' · '), badge(planState(bindings), '计划项 ' + states[planState(bindings)])); card.append(bindingInfo);
      }
      const list = node('dl', 'facts');
      if (!event) {
        humanFact(list, '期望', plan.expectation, true, undefined, undefined, true);
        humanFact(list, '本次结果', '未执行或未绑定', true);
      } else {
        used.add(event.id);
        const expected = assertionValue(event);
        if (apiAssertion) {
          if (api) humanFact(list, '接口状态', api.status, has(api, 'status'), '未记录');
          else humanFact(list, '接口', '未关联接口证据', true);
          const path = record(event.expect).path;
          if (path) humanFact(list, '断言字段', path, true);
        } else humanFact(list, '对象', targetSummary(event), true);
        humanFact(list, '条件', assertionCondition(event), true);
        humanFact(list, '期望', expected, expected !== undefined, '未记录', undefined, true);
        actualFact(list, '实测', event);
        if (whitespaceNote(expected)) humanFact(list, '空白检查', whitespaceNote(expected), true);
        card.append(button('查看对应步骤与截图', () => { selectedCheck = event.id; selectEvent(event.id); get('action').scrollIntoView({ block: 'start', behavior: 'smooth' }); }, 'raw-link'));
        if (event.error) card.append(node('p', 'error-message', (event.error.code || '') + ' ' + event.error.message));
        if (event.redacted || event.truncated) card.append(node('p', 'alert', [event.redacted && '已脱敏', event.truncated && '生产记录已截断'].filter(Boolean).join(' · ') + '，完整核验受此边界限制'));
      }
      card.append(list);
      if (event) {
        const flagged = ['fail', 'error'].includes(status(event))
          || apis.some(api => Number(api.status) >= 400) || scopeState(scope) !== 'pass';
        const trace = apis.find(api => api.traceId);
        if (flagged && trace) card.append(node('p', 'trace-id', 'traceId · ' + trace.traceId));
        if (apis.length) {
          const details = node('details', 'tech-evidence');
          details.append(node('summary', '', '接口证据 · ' + apis.map(apiLabel).join(' / ')));
          apis.forEach(api => details.append(apiEvidence(api)));
          card.append(details);
        }
      }
      root.append(card);
    }
    if (scope.scenario) {
      root.append(node('p', 'section-label', '冻结验收计划 · 缺失项也保留'));
      scope.scenario.checks.forEach(plan => {
        const bindings = boundEvents(scope.caseIndex, scope.scenario, plan);
        if (!bindings.length) checkCard(undefined, plan, []);
        else bindings.forEach(event => checkCard(event, plan, bindings));
      });
      if (!scope.scenario.checks.length) root.append(node('p', 'alert', '验收说明没有计划检查，需求覆盖未验证'));
    }
    const asserts = scope.events.filter(event => event.type === 'assert' && !used.has(event.id));
    if (asserts.length) root.append(node('p', 'section-label', scope.scenario ? '实际检查 · 尚未核销上述计划项' : '本次实际检查'));
    asserts.forEach(event => checkCard(event));
    if (!scope.scenario && !asserts.length) root.append(node('p', 'empty', '本范围没有正式断言。截图与辅助观察不计为断言。'));
    get('check-count').textContent = root.querySelectorAll('.check').length + ' 项';
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
  function renderTimeline(scope) {
    const root = get('timeline'); root.replaceChildren(node('p', 'timeline-title', '执行步骤 · 动作与检查'));
    scope.events.forEach((event, index) => {
      const entry = button('', () => { selectedCheck = undefined; selectEvent(event.id); }, 'event'); entry.dataset.eventId = event.id;
      const detail = node('div');
      if (event.type === 'action') {
        detail.append(node('div', 'event-title', actionTitle(event)), node('div', 'event-meta', [actionMeta(event), duration(event)].filter(Boolean).join(' · ')));
      } else if (event.type === 'assert') {
        const apis = apisForEvent(scope.caseIndex, event);
        const object = apis.length ? apiLabel(apis[0]) : ['api', 'request'].includes(event.kind) ? '未关联接口证据' : targetSummary(event);
        detail.append(node('div', 'event-title', '检查：' + assertionTitle(event)), node('div', 'event-meta', [assertionCondition(event), object].join(' · ')));
      } else if (event.type === 'error') {
        detail.append(node('div', 'event-title', '执行错误'), node('div', 'event-meta', event.error && event.error.message || event.kind));
      } else {
        detail.append(node('div', 'event-title', '辅助观察 · ' + event.kind), node('div', 'event-meta', ['observation', event.intent, states[status(event)]].filter(Boolean).join(' · ')));
      }
      entry.append(node('span', 'step-index', String(index + 1).padStart(2, '0')), detail, badge(status(event))); root.append(entry);
    });
  }
`;
