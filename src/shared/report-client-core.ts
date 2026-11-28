/**
 * 报告页浏览器脚本片段 1/3：数据、状态、覆盖判定。
 * core → views → actions 按序拼成同一个 IIFE，共享词法作用域，不能单独执行。
 */
export const reportClientCore = String.raw`
(function () {
  'use strict';
  const data = JSON.parse(document.getElementById('report-data').textContent);
  const get = id => document.getElementById(id);
  const has = (record, key) => record != null && Object.prototype.hasOwnProperty.call(record, key);
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const node = (tag, className, text) => { const element = document.createElement(tag); if (className) element.className = className; if (text !== undefined) element.textContent = String(text); return element; };
  const button = (text, handler, className) => { const element = node('button', className, text); element.type = 'button'; element.addEventListener('click', handler); return element; };
  const states = { pass: '通过', fail: '比较失败', error: '执行错误', not_run: '未执行', unverified: '未验证', blocked: '阻断' };
  const sourceLabels = { user: '用户原文', contract: '独立契约', case: '既有用例', host: 'Host整理' };
  const status = event => event.executed === false || event.status === 'not_run' ? 'not_run' : event.status;
  const badge = (state, text) => node('span', 'badge ' + state, text || states[state] || state);
  const caseName = testCase => String(testCase.name || '本次执行').replace(/^\[s_[a-f0-9]{8}\]\s+/, '');
  const span = (start, end) => Number.isFinite(start) && Number.isFinite(end)
    ? (end - start < 1000 ? (end - start) + ' ms' : ((end - start) / 1000).toFixed(1) + ' s')
    : '耗时未记录';
  const duration = event => span(event.startedAt, event.endedAt);
  const time = value => Number.isFinite(value) ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '时间未记录';
  const imageSafe = image => /^data:image\/(png|jpe?g|gif|webp|avif|bmp);base64,[a-z0-9+/=\s]+$/i.test(image.src || '');
  const allEvents = data.cases.map(testCase => (testCase.events || []).slice().sort((left, right) => left.sequence - right.sequence));
  const businessTypes = new Set(['action', 'assert', 'error']);
  const isBusiness = event => businessTypes.has(event.type) || ['fail', 'error'].includes(event.status);
  const timelineOf = events => { const business = events.filter(isBusiness); return business.length ? business : events; };
  const actionNames = { open: '打开页面', refresh: '刷新页面', click: '点击', fill: '填写', type: '输入', press: '按键', execute: '执行脚本', hover: '悬停', scroll: '滚动', select: '选择', upload: '上传', wait: '等待', screenshot: '截图' };
  const actionTitle = event => event.intent || actionNames[event.kind] || event.kind;
  const operatorLabels = { contains: '包含', equals: '等于', eq: '等于', ne: '不等于', gt: '大于', lt: '小于', '==': '等于', '!=': '不等于', '>': '大于', '<': '小于', '>=': '不小于', '<=': '不大于', exists: '存在', absent: '不存在' };
  function assertionCondition(event) {
    const expect = record(event.expect);
    const nested = record(expect[event.kind]);
    const condition = Object.keys(nested).length ? nested : expect;
    for (const key of ['contains', 'equals', 'op', 'state', 'count', 'check', 'matches']) {
      if (has(condition, key)) return key === 'contains' || key === 'equals'
        ? operatorLabels[key] : operatorLabels[condition[key]] || operatorLabels[key] || key;
    }
    return ({ text: '文本', api: '接口返回', data: '页面数据', nav: '页面地址', state: '元素状态', count: '元素数量', absent: '元素不存在', exists: '元素存在' })[event.kind] || '检查';
  }
  function assertionValue(event) {
    const expect = record(event.expect);
    if (has(expect, 'contains')) return expect.contains;
    if (has(expect, 'equals')) return expect.equals;
    if (has(expect, 'value')) return expect.value;
    return has(event, 'resolvedExpected') ? event.resolvedExpected : undefined;
  }
  function assertionTitle(event) {
    const value = assertionValue(event);
    if (event.kind === 'text') return '文本' + assertionCondition(event) + (value === undefined ? '' : '「' + value + '」');
    if (event.kind === 'api') {
      const path = record(event.expect).path;
      return '接口字段' + (path ? '「' + path + '」' : '') + assertionCondition(event) + (value === undefined ? '' : '「' + value + '」');
    }
    if (event.kind === 'data') {
      const path = record(event.expect).path;
      return '页面数据' + (path ? '「' + path + '」' : '') + assertionCondition(event) + (value === undefined ? '' : '「' + value + '」');
    }
    if (event.kind === 'nav') return '页面地址' + assertionCondition(event) + (value === undefined ? '' : '「' + value + '」');
    if (event.kind === 'state') return '元素状态' + assertionCondition(event) + (value === undefined ? '' : '「' + value + '」');
    return assertionCondition(event) + (value === undefined ? '' : '「' + value + '」');
  }
  function targetOf(event) {
    const target = record(event.target);
    return record(target.within ?? target.target ?? event.target);
  }
  function targetSummary(event) {
    const target = targetOf(event);
    const selector = target.selector || target.css || target.label || target.text || target.name || String(record(event.expect).within || '').replace(/^css=/, '') || undefined;
    const matches = Array.isArray(target.candidates) && target.candidates.length ? target.candidates[0].matches : undefined;
    const bits = [];
    if (selector) bits.push(selector);
    if (matches !== undefined) bits.push(matches + ' 个匹配');
    if (target.visible !== undefined) bits.push(target.visible ? '可见' : '不可见');
    return bits.join(' · ') || '目标未记录';
  }
  function whitespaceNote(value) {
    if (typeof value !== 'string') return '';
    const leading = (value.match(/^\s*/) || [''])[0].length, trailing = (value.match(/\s*$/) || [''])[0].length;
    return leading || trailing ? '首尾空白：前 ' + leading + ' / 后 ' + trailing + ' 个字符' : '';
  }
  function caseStats(caseIndex) {
    const events = allEvents[caseIndex], testCase = data.cases[caseIndex];
    const actions = events.filter(event => event.type === 'action');
    const assertions = events.filter(event => event.type === 'assert');
    const screenshots = events.filter(event => event.type === 'screenshot');
    const meta = [];
    if (actions.length) meta.push(actions.length + ' 个步骤');
    if (assertions.length) meta.push(assertions.filter(event => status(event) === 'pass').length + '/' + assertions.length + ' 断言');
    if (screenshots.length) meta.push(screenshots.length + ' 张截图');
    return {
      meta: meta.join(' · ') || '无执行记录',
      duration: span(testCase.run && testCase.run.startedAt, testCase.run && testCase.run.endedAt),
    };
  }
  const scopes = [];
  let currentScope = 0, currentCase = 0, selectedId, selectedCheck, selectedImage, lastFocus;

  function boundEvents(caseIndex, scenario, check) {
    const coverage = data.cases[caseIndex].acceptanceCoverage;
    const entry = coverage && coverage.scenarios.find(item => item.id === scenario.id);
    const binding = entry && entry.checks.find(item => item.id === check.id);
    return allEvents[caseIndex].filter(event => event.type === 'assert' && event.group === scenario.id && (
      binding ? binding.eventIds.includes(event.id) : event.checkId === check.id));
  }
  function planState(events) {
    if (!events.length) return 'unverified';
    if (events.some(event => status(event) === 'fail' || status(event) === 'error')) return 'fail';
    if (events.some(event => status(event) === 'not_run' || event.executed !== true)) return 'unverified';
    return events.every(event => status(event) === 'pass') ? 'pass' : 'unverified';
  }
  data.cases.forEach((testCase, caseIndex) => {
    const scenarios = testCase.acceptance ? testCase.acceptance.document.scenarios : [];
    const groups = new Set([...testCase.steps.map(step => step.group).filter(Boolean),
      ...allEvents[caseIndex].map(event => event.group).filter(Boolean)]);
    scenarios.forEach(scenario => {
      const bindings = scenario.checks.flatMap(check => boundEvents(caseIndex, scenario, check));
      const ids = new Set(bindings.map(event => event.id));
      bindings.forEach(event => { if (event.actionId) allEvents[caseIndex].filter(action => action.type === 'action' && (action.id === event.actionId || action.actionId === event.actionId)).forEach(action => ids.add(action.id)); });
      const events = allEvents[caseIndex].filter(event => event.group === scenario.id || ids.has(event.id));
      scopes.push({ caseIndex, group: scenario.id, name: scenario.goal, scenario, allEvents: events, events: timelineOf(events) });
      groups.delete(scenario.id);
    });
    groups.forEach(group => {
      const explicitIds = new Set(testCase.steps.filter(step => step.group === group).flatMap(step => step.eventIds || []));
      const title = testCase.steps.find(step => step.group === group && step.action && step.action !== group);
      const events = allEvents[caseIndex].filter(event => event.group === group || explicitIds.has(event.id));
      scopes.push({ caseIndex, group, name: title ? title.action : group, allEvents: events, events: timelineOf(events) });
    });
    const covered = new Set(scopes.filter(scope => scope.caseIndex === caseIndex).flatMap(scope => scope.allEvents.map(event => event.id)));
    const rest = allEvents[caseIndex].filter(event => !covered.has(event.id) && isBusiness(event));
    if (rest.length) scopes.push({ caseIndex, group: undefined, name: '其他步骤', allEvents: rest, events: rest });
    if (!scopes.some(scope => scope.caseIndex === caseIndex)) scopes.push({ caseIndex, group: undefined, name: caseName(testCase), allEvents: allEvents[caseIndex], events: timelineOf(allEvents[caseIndex]) });
  });
  function scopeState(scope) {
    const testCase = data.cases[scope.caseIndex];
    const wholeCase = scope.group === undefined && !scope.scenario;
    const steps = wholeCase ? testCase.steps.concat(testCase.appendix || []) : testCase.steps.filter(step => scope.group !== undefined && step.group === scope.group);
    const coverage = scope.scenario && testCase.acceptanceCoverage && testCase.acceptanceCoverage.scenarios.find(scenario => scenario.id === scope.scenario.id);
    const checks = scope.scenario ? scope.scenario.checks.map(check => planState(boundEvents(scope.caseIndex, scope.scenario, check))) : [];
    if (wholeCase && testCase.result === 'FAIL' || steps.some(step => step.status === 'fail' || step.sourceStatus === 'fail')
      || scope.allEvents.some(event => ['fail', 'error'].includes(status(event))) || coverage && coverage.result === 'FAIL' || checks.includes('fail')) return 'fail';
    if (wholeCase && testCase.result === 'BLOCKED' || steps.some(step => step.status === 'blocked' || step.sourceStatus === 'blocked')) return 'blocked';
    if (!scope.events.length || scope.allEvents.some(event => status(event) === 'not_run')
      || scope.scenario && (!checks.length || checks.includes('unverified') || coverage && coverage.result === 'UNVERIFIED')) return 'unverified';
    return 'pass';
  }
  function coverageSummary() {
    const passedCases = data.cases.filter(testCase => testCase.result === 'PASS').length;
    const failedCases = data.cases.filter(testCase => testCase.result === 'FAIL').length;
    const blockedCases = data.cases.filter(testCase => testCase.result === 'BLOCKED').length;
    get('execution').replaceChildren(badge(data.result.toLowerCase(), '用例 ' + passedCases + '/' + data.cases.length + ' 通过'),
      node('span', 'small muted', failedCases ? failedCases + ' 个失败' : blockedCases ? blockedCases + ' 个阻断' : '全部通过'));
    const checks = data.cases.flatMap((testCase, caseIndex) => testCase.acceptance ? testCase.acceptance.document.scenarios.flatMap(scenario =>
      scenario.checks.map(check => planState(boundEvents(caseIndex, scenario, check)))) : []);
    const provided = data.cases.filter(testCase => testCase.acceptance).length;
    const incomplete = provided !== data.cases.length || data.cases.some(testCase => testCase.acceptanceCoverage && testCase.acceptanceCoverage.result === 'UNVERIFIED')
      || scopes.some(scope => scope.scenario && ['unverified', 'blocked'].includes(scopeState(scope)));
    const state = checks.includes('fail') || data.cases.some(testCase => testCase.acceptanceCoverage && testCase.acceptanceCoverage.result === 'FAIL')
      ? 'fail' : incomplete || !checks.length || checks.includes('unverified') ? 'unverified' : 'pass';
    if (provided) {
      get('coverage').replaceChildren(badge(state, '需求覆盖 ' + (state === 'pass' ? '计划项已核对' : states[state])),
        node('span', 'small muted', checks.filter(item => item === 'pass').length + '/' + checks.length + ' 计划检查通过'));
    } else if (data.coverage) {
      const total = data.coverage.plan ? data.coverage.plan.length : data.coverage.executed.length;
      get('coverage').replaceChildren(
        badge(data.coverage.missing.length ? 'unverified' : 'pass', data.coverage.plan ? '覆盖计划 ' + data.coverage.executed.length + '/' + total + ' 已执行' : '已执行 ' + total + ' 个场景'),
        node('span', 'small muted', '缺失 ' + data.coverage.missing.length + ' · 计划外 ' + data.coverage.unplanned.length));
    } else {
      get('coverage').replaceChildren(node('span', 'small muted', '未提供覆盖计划'));
    }
    const events = allEvents.flat(), assertions = events.filter(event => event.type === 'assert');
    get('counts').textContent = '业务动作 ' + events.filter(event => event.type === 'action').length + ' · 断言 ' + assertions.filter(event => status(event) === 'pass').length + '/' + assertions.length + ' 通过 · 截图 ' + events.filter(event => event.type === 'screenshot').length;
    get('boundary').textContent = data.mocked ? 'Mock 已开启 · 不能作为真实后端落库依据' : data.result === 'FAIL' ? '报告未通过，失败步骤与断言保留在目录和检查结果中' : data.result === 'BLOCKED' ? '报告阻断 · 未执行或未绑定项保留在目录和检查结果中' : provided ? '绑定与执行结果可核对，描述是否充分由验收人判断' : '未提供独立验收说明，不能证明完整需求覆盖';
  }
`;
