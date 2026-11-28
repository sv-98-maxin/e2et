/** 报告页浏览器脚本片段 3/3：事件选择、截图、播放、主题与初始化；与 core 同一 IIFE 作用域。 */
export const reportClientActions = String.raw`
  function renderApiPreview(scope, event) {
    const apis = apisForEvent(scope.caseIndex, event);
    if (!apis.length) return false;
    const wrapper = node('div', 'api-preview');
    apis.forEach(api => {
      const card = node('div', 'api-card'), head = node('div', 'api-head');
      head.append(node('span', 'api-method', api.method || 'API'), node('span', 'api-path', api.path || api.url || '未记录'),
        badge(Number(api.status) >= 400 ? 'fail' : 'pass', api.status ? 'HTTP ' + api.status : '状态未记录'));
      const facts = node('dl', 'facts');
      fact(facts, '完整地址', api.url || api.path, true);
      fact(facts, 'traceId', api.traceId, has(api, 'traceId'), '未采集');
      fact(facts, '请求参数', api.reqBody, has(api, 'reqBody'), '未记录', true);
      fact(facts, '响应头', api.respHeaders, has(api, 'respHeaders'), '未记录', true);
      fact(facts, '响应原文', api.respBody, has(api, 'respBody'), '未采集', true);
      card.append(head, facts); wrapper.append(card);
    });
    get('image-label').textContent = '接口证据 · ' + apis.map(apiLabel).join(' / ');
    get('image-stage').dataset.kind = 'api';
    get('image-stage').append(wrapper);
    return true;
  }
  function showImage(scope, event, image) {
    selectedImage = image; const stage = get('image-stage'), label = get('image-label'); stage.replaceChildren(); stage.dataset.kind = ''; stage.classList.remove('empty');
    get('images').querySelectorAll('button').forEach(option => option.setAttribute('aria-pressed', String(Boolean(image) && option.dataset.imageId === image.id)));
    if (!image || !imageSafe(image)) {
      stage.classList.add('empty');
      if (renderApiPreview(scope, event)) { stage.classList.remove('empty'); return; }
      label.textContent = status(event) === 'not_run' ? '本步骤未执行 · 未采集截图' : '本步骤未采集截图';
      stage.append(node('p', 'empty', image ? '截图数据无法解码；技术信息保留在原始 trace 中。' : status(event) === 'not_run' ? '此步骤未执行，没有截图。' : '没有与当前步骤关联的截图。无图不代表步骤通过。')); return;
    }
    const attribution = event.type === 'action' ? image.phase === 'after_action' ? '动作后自动截图' : '独立截图' : image.eventId === event.id ? '本检查截图' : '关联动作截图，非本检查独立取证';
    label.textContent = attribution + ' · ' + (image.label || actionTitle(event)) + ' · ' + time(image.startedAt);
    const picture = node('img'); picture.alt = image.label || ('步骤截图：' + actionTitle(event)); picture.src = image.src; picture.title = '点击全屏查看';
    picture.addEventListener('click', () => openImageViewer(image, event));
    picture.addEventListener('error', () => { if (picture.isConnected) { stage.classList.add('empty'); stage.replaceChildren(node('p', 'empty', '截图解码失败；技术信息保留在原始 trace 中。')); } }); stage.append(picture);
  }
  function openImageViewer(image, event) {
    const picture = node('img'); picture.src = image.src; picture.alt = image.label || ('步骤截图：' + actionTitle(event)); picture.title = '点击查看原始尺寸';
    const content = node('div', 'image-viewer-body'); content.append(picture);
    openDialog('查看截图 · ' + (image.label || actionTitle(event)), content);
    get('dialog').classList.add('image-viewer'); get('dialog-body').dataset.imageZoom = 'fit';
    picture.addEventListener('click', () => {
      const actual = get('dialog-body').dataset.imageZoom !== 'actual';
      get('dialog-body').dataset.imageZoom = actual ? 'actual' : 'fit';
      picture.title = actual ? '点击适应屏幕' : '点击查看原始尺寸';
    });
  }
  function selectEvent(id, chosenImage) {
    const scope = scopes[currentScope], event = scope.events.find(item => item.id === id); if (!event) return;
    selectedId = id; const action = linkedAction(scope.caseIndex, event), root = get('action'); root.replaceChildren();
    const facts = node('dl', 'facts');
    let title;
    if (event.type === 'assert') {
      const expected = assertionValue(event);
      const apis = apisForEvent(scope.caseIndex, event), api = apis[0];
      const apiAssertion = event.kind === 'api' || event.kind === 'request';
      title = apiAssertion ? '接口断言 · ' + (api ? apiLabel(api) : '未关联') : '检查：' + assertionTitle(event);
      if (apiAssertion) {
        if (api) humanFact(facts, '接口状态', api.status, has(api, 'status'), '未记录');
        else humanFact(facts, '接口', '未关联接口证据', true);
        const path = record(event.expect).path;
        if (path) humanFact(facts, '断言字段', path, true);
      } else {
        humanFact(facts, '对象', targetSummary(event), true);
      }
      humanFact(facts, '条件', assertionCondition(event), true);
      humanFact(facts, '期望', expected, expected !== undefined, '未记录', undefined, true);
      actualFact(facts, '实测', event);
      if (whitespaceNote(expected)) humanFact(facts, '空白检查', whitespaceNote(expected), true);
      if (action) humanFact(facts, '对应动作', actionTitle(action), true);
    } else if (event.type === 'action') {
      title = actionTitle(event);
      humanFact(facts, '目标', actionMeta(event), Boolean(actionMeta(event)), '未记录');
      humanFact(facts, '结果', actionOutcome(event), true);
      humanFact(facts, '耗时', duration(event), true);
    } else if (event.type === 'error') {
      title = '执行错误';
      humanFact(facts, '错误', event.error && event.error.message || event.kind, true);
      if (event.error && event.error.code) humanFact(facts, '错误码', event.error.code, true);
    } else {
      title = '辅助观察 · ' + event.kind;
      actualFact(facts, '结果', event);
      if (event.type === 'capture' && (record(record(event.valueSource).from).req_id || record(event.evidence).req || record(event.args).req)) {
        humanFact(facts, '接口', apisForEvent(scope.caseIndex, event).map(apiLabel).join(' / ') || '未关联接口证据', true);
      }
      humanFact(facts, '时间', time(event.startedAt), true);
    }
    const heading = node('div', 'row between'); heading.append(node('span', 'kind', title), badge(status(event)), node('span', 'small muted', duration(event))); root.append(heading);
    root.append(facts);
    if (event.type === 'action' && /execute|script/i.test(event.kind)) root.append(node('p', 'alert', '脚本操作 · 只展示已记录脚本与返回，不推断为键盘或鼠标路径'));
    if (event.error) root.append(node('p', 'error-message', (event.error.code || '') + ' ' + event.error.message));
    const candidates = imageCandidates(scope.caseIndex, event), picker = get('images'); picker.replaceChildren();
    const picked = chosenImage || candidates[0];
    if (candidates.length > 1) candidates.forEach(image => {
      const option = button((image.phase === 'after_action' ? '自动截图 · ' : '独立截图 · ') + (image.label || image.id), () => showImage(scope, event, image));
      option.dataset.imageId = image.id;
      option.setAttribute('aria-pressed', String(image === picked));
      picker.append(option);
    });
    showImage(scope, event, picked);
    const position = scope.events.indexOf(event); get('position').textContent = (position + 1) + '/' + scope.events.length;
    get('previous').disabled = position === 0; get('next').disabled = position === scope.events.length - 1;
    get('timeline').querySelectorAll('.event').forEach(entry => {
      entry.setAttribute('aria-current', String(entry.dataset.eventId === event.id)); entry.classList.toggle('related', Boolean(action && action.id !== event.id && entry.dataset.eventId === action.id));
    });
    get('checks').querySelectorAll('.check').forEach(card => {
      card.classList.toggle('selected', card.dataset.eventId === (selectedCheck || event.id));
      card.classList.toggle('related', Boolean(event.type === 'action' && card.dataset.actionId && card.dataset.actionId === (event.actionId || event.id)));
    });
    const active = get('timeline').querySelector('[aria-current=true]'); if (active) active.scrollIntoView({ block: 'nearest' });
  }
  function selectScope(index) {
    stopReplay(); currentScope = index; const scope = scopes[index]; currentCase = scope.caseIndex;
    selectedId = undefined; selectedCheck = undefined; selectedImage = undefined;
    get('scenarios').querySelectorAll('.scenario').forEach(entry => entry.setAttribute('aria-current', String(Number(entry.dataset.index) === index)));
    get('cases').querySelectorAll('.case-row').forEach(row => row.setAttribute('aria-current', String(Number(row.dataset.case) === currentCase)));
    renderContext(scope); renderChecks(scope); renderTimeline(scope); get('checks').scrollTop = 0;
    const failure = scope.events.find(event => ['fail', 'error'].includes(status(event)));
    const notRun = scope.events.find(event => status(event) === 'not_run');
    if (scope.events.length) selectEvent((failure || data.result === 'BLOCKED' && notRun || scope.events[0]).id);
    else {
      get('action').replaceChildren(node('p', 'muted', '本范围没有可展示的业务步骤'));
      get('image-label').textContent = '无可展示步骤'; get('image-stage').replaceChildren(node('p', 'empty', '此场景未执行，或报告没有执行记录。'));
      get('position').textContent = '0/0'; get('previous').disabled = true; get('next').disabled = true; get('images').replaceChildren();
    }
    updateReplayButton(); get('scope-status').replaceChildren(badge(scopeState(scope)));
  }
  function updateDirectoryVisibility() {
    const count = scopes.filter(scope => scope.caseIndex === currentCase).length;
    get('directory').hidden = count <= 1;
    get('nav-toggle').hidden = count <= 1;
  }
  function selectCase(caseIndex) {
    currentCase = caseIndex;
    const entries = scopes.map((scope, index) => ({ scope, index })).filter(entry => entry.scope.caseIndex === caseIndex);
    if (!entries.length) return;
    const failure = entries.find(entry => entry.scope.allEvents.some(event => ['fail', 'error'].includes(status(event))) || scopeState(entry.scope) === 'fail');
    renderDirectory();
    selectScope((failure || entries[0]).index);
    renderCases();
    updateDirectoryVisibility();
  }
  function move(offset) { const events = scopes[currentScope].events, position = events.findIndex(event => event.id === selectedId), next = events[position + offset]; if (next) selectEvent(next.id); }
  const replayRaf = callback => typeof requestAnimationFrame === 'function' ? requestAnimationFrame(callback) : setTimeout(callback, 16);
  const replayCancelRaf = id => typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(id) : clearTimeout(id);
  let replayTimer, replayPlaying = false, replayFrames = [], replayTimes = [], replayIndex = 0, replayPosition = 0, replaySpeed = 1;
  let replayAnchorWall = 0, replayAnchorTime = 0, replayButton, replayImage, replayRange, replayTime;
  function caseImages(caseIndex) {
    const testCase = data.cases[caseIndex];
    const flow = testCase.flow && Array.isArray(testCase.flow.frames) ? testCase.flow.frames : [];
    if (flow.length >= 2) return flow.filter(imageSafe);
    const seen = new Set();
    return (testCase.images || []).filter(image => {
      if (!imageSafe(image) || seen.has(image.id)) return false;
      seen.add(image.id);
      return true;
    }).sort((left, right) => left.sequence - right.sequence);
  }
  function updateReplayButton() {
    const control = get('flow-replay');
    control.hidden = caseImages(currentCase).length < 2;
    control.textContent = data.cases.length > 1 ? '回放当前用例' : '全流程回放';
    control.title = data.cases.length > 1 ? '只回放当前选中的用例' : '回放当前用例的完整过程';
    const result = data.cases[currentCase].result;
    const badge = get('case-status');
    badge.className = 'badge ' + result.toLowerCase();
    badge.textContent = '用例 ' + result;
    get('case-name').textContent = caseName(data.cases[currentCase]);
  }
  function replayDelay(index) {
    const current = replayFrames[index], next = replayFrames[index + 1];
    return Number.isFinite(current && current.startedAt) && Number.isFinite(next && next.startedAt)
      ? Math.max(16, Math.min(1000, next.startedAt - current.startedAt)) : 900;
  }
  function buildReplayTimes() {
    replayTimes = [0];
    for (let index = 1; index < replayFrames.length; index++) replayTimes.push(replayTimes[index - 1] + replayDelay(index - 1));
  }
  function clock(value) {
    const total = Math.max(0, Math.round(value / 1000));
    return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
  }
  function replayDuration() { return replayTimes[replayTimes.length - 1] || 0; }
  function replayNow() { return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now(); }
  function replayFrameAt(value) {
    let index = 0;
    while (index < replayTimes.length - 1 && replayTimes[index + 1] <= value) index++;
    return index;
  }
  function currentReplayTime() {
    if (!replayPlaying) return replayPosition;
    return Math.min(replayDuration(), replayAnchorTime + (replayNow() - replayAnchorWall) * replaySpeed);
  }
  function stopReplay(atEnd) {
    if (replayPlaying) replayPosition = atEnd ? replayDuration() : currentReplayTime();
    replayCancelRaf(replayTimer); replayTimer = undefined; replayPlaying = false;
    if (replayButton) replayButton.textContent = atEnd ? '重播' : '播放';
  }
  function renderReplayFrame(value) {
    if (!replayFrames.length) return;
    const duration = replayDuration();
    const position = Math.max(0, Math.min(duration, Number.isFinite(value) ? value : 0));
    const index = replayFrameAt(position);
    if (index !== replayIndex || !replayImage.src) {
      replayIndex = index;
      const image = replayFrames[index];
      replayImage.src = image.src;
      replayImage.alt = '全流程回放画面';
    }
    const percent = duration ? position / duration * 100 : 0;
    replayRange.value = String(Math.round(percent * 10));
    if (replayRange.style) replayRange.style.setProperty('--replay-progress', percent + '%');
    replayTime.textContent = clock(position) + ' / ' + clock(duration);
  }
  function tickReplay() {
    if (!replayPlaying) return;
    const position = replayAnchorTime + (replayNow() - replayAnchorWall) * replaySpeed;
    if (position >= replayDuration()) { renderReplayFrame(replayDuration()); stopReplay(true); return; }
    replayPosition = position;
    renderReplayFrame(position);
    replayTimer = replayRaf(tickReplay);
  }
  function startReplay() {
    if (replayFrames.length < 2) return;
    replayCancelRaf(replayTimer); replayTimer = undefined;
    if (replayPosition >= replayDuration() - 1) replayPosition = 0;
    replayAnchorTime = replayPosition; replayAnchorWall = replayNow();
    replayPlaying = true; replayButton.textContent = '暂停'; renderReplayFrame(replayPosition); tickReplay();
  }
  function seekReplay(value) {
    if (!replayFrames.length) return;
    const duration = replayDuration();
    replayPosition = Math.max(0, Math.min(duration, duration * Number(value) / 1000));
    if (replayPlaying) { replayAnchorTime = replayPosition; replayAnchorWall = replayNow(); }
    renderReplayFrame(replayPosition);
    if (!replayPlaying) replayButton.textContent = replayPosition >= duration ? '重播' : '播放';
  }
  function openReplay() {
    const images = caseImages(currentCase);
    if (images.length < 2 || get('dialog').open) return;
    stopReplay(); replayFrames = images; replayIndex = 0; replayPosition = 0; buildReplayTimes();
    replayImage = node('img');
    replayButton = button('暂停', () => { if (replayPlaying) stopReplay(); else startReplay(); });
    replayRange = node('input', 'replay-progress');
    replayRange.type = 'range'; replayRange.min = '0'; replayRange.max = '1000'; replayRange.step = '1'; replayRange.value = '0';
    replayRange.setAttribute('aria-label', '全流程回放进度');
    replayRange.addEventListener('input', event => seekReplay(event.target.value));
    replayTime = node('span', 'small mono replay-time');
    replaySpeed = 1;
    const speed = node('div', 'replay-speed');
    speed.setAttribute('role', 'group'); speed.setAttribute('aria-label', '回放倍速');
    const setSpeed = next => {
      if (replayPlaying) { replayPosition = currentReplayTime(); replayAnchorTime = replayPosition; replayAnchorWall = replayNow(); }
      replaySpeed = Number(next) || 1;
      speed.querySelectorAll('button').forEach(option => option.setAttribute('aria-pressed', String(Number(option.dataset.speed) === replaySpeed)));
    };
    ['0.5', '1', '1.5', '2'].forEach(value => {
      const option = button(value + 'x', () => setSpeed(value), 'replay-speed-option');
      option.dataset.speed = value; option.setAttribute('aria-pressed', String(value === '1')); speed.append(option);
    });
    const stage = node('div', 'replay-stage'); stage.append(replayImage);
    const controls = node('div', 'replay-controls row'); controls.append(replayButton, replayRange, replayTime, speed);
    const body = node('div', 'replay'); body.append(stage, controls);
    openDialog('全流程回放 · ' + caseName(data.cases[currentCase]), body);
    startReplay();
  }
  function openDialog(title, content) {
    stopReplay(); lastFocus = document.activeElement; get('dialog').classList.remove('image-viewer');
    get('dialog-body').dataset.imageZoom = ''; get('dialog-title').textContent = title;
    get('dialog-body').replaceChildren(content); get('dialog').showModal(); get('dialog-close').focus();
  }
  get('previous').addEventListener('click', () => move(-1)); get('next').addEventListener('click', () => move(1));
  get('flow-replay').addEventListener('click', openReplay);
  get('dialog-close').addEventListener('click', () => get('dialog').close()); get('dialog').addEventListener('close', () => { stopReplay(); get('dialog').classList.remove('image-viewer'); get('dialog-body').dataset.imageZoom = ''; if (lastFocus && lastFocus.isConnected) lastFocus.focus(); });
  get('run-info').addEventListener('click', () => {
    const testCase = data.cases[scopes[currentScope].caseIndex], content = node('div');
    content.append(node('pre', '', JSON.stringify({ run: testCase.run || '未记录', recording: testCase.recording || '未提供', source: testCase.source, acceptance: testCase.acceptance && { sha256: testCase.acceptance.sha256, frozenAt: testCase.acceptance.frozenAt } }, null, 2)));
    const links = node('div', 'row');
    (data.links || []).forEach(link => {
      try { if (!['http:', 'https:'].includes(new URL(link.url, 'https://report.invalid/').protocol)) return; }
      catch (_) { return; }
      const anchor = node('a', 'run-link', link.label); anchor.setAttribute('href', link.url); links.append(anchor);
    });
    if (links.children.length) content.append(links);
    openDialog('本次运行与录制来源', content);
  });
  get('raw-trace').addEventListener('click', () => { const caseIndex = scopes[currentScope].caseIndex; openDialog('原始 trace · 仅技术审计', node('pre', '', JSON.stringify({ case: caseName(data.cases[caseIndex]), events: allEvents[caseIndex] }, null, 2))); });
  get('nav-toggle').addEventListener('click', () => { const opened = document.body.dataset.nav !== 'open'; document.body.dataset.nav = opened ? 'open' : ''; get('nav-toggle').setAttribute('aria-expanded', String(opened)); });
  get('search').addEventListener('input', event => { const query = event.target.value.toLowerCase(); get('scenarios').querySelectorAll('.scenario').forEach(entry => { entry.hidden = !entry.textContent.toLowerCase().includes(query); }); });
  const themeMedia = window.matchMedia('(prefers-color-scheme: dark)'); let themeOverride;
  function applyTheme() { const dark = themeOverride === undefined ? themeMedia.matches : themeOverride; document.documentElement.dataset.theme = dark ? 'dark' : 'light'; get('theme').textContent = dark ? '浅色' : '深色'; }
  get('theme').addEventListener('click', () => { themeOverride = document.documentElement.dataset.theme !== 'dark'; applyTheme(); }); themeMedia.addEventListener('change', applyTheme);
  document.addEventListener('keydown', event => {
    if (get('dialog').open) return;
    if (event.key === 'Escape') { document.body.dataset.nav = ''; get('nav-toggle').setAttribute('aria-expanded', 'false'); return; }
    if (event.target.closest('input,textarea,select,details,[contenteditable=true]')) return;
    if (event.target.closest('.scenarios') && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
      event.preventDefault(); const choices = Array.from(get('scenarios').querySelectorAll('.scenario')).filter(entry => !entry.hidden), position = choices.indexOf(event.target.closest('.scenario')), next = choices[position + (event.key === 'ArrowDown' ? 1 : -1)]; if (next) { next.click(); get('scenarios').querySelector('[data-index="' + next.dataset.index + '"]').focus(); } return;
    }
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); move(event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1); if (event.target.closest('.timeline')) { const active = get('timeline').querySelector('[aria-current=true]'); if (active) active.focus(); } }
  });
  let initialCase = 0;
  if (data.result === 'FAIL') { const index = data.cases.findIndex(testCase => testCase.result === 'FAIL'); if (index >= 0) initialCase = index; }
  else if (data.result === 'BLOCKED') { const index = data.cases.findIndex(testCase => testCase.result === 'BLOCKED'); if (index >= 0) initialCase = index; }
  currentCase = initialCase;
  const entries = scopes.map((scope, index) => ({ scope, index })).filter(entry => entry.scope.caseIndex === initialCase);
  let initial = entries.length ? entries[0].index : 0;
  const failure = entries.find(entry => entry.scope.allEvents.some(event => ['fail', 'error'].includes(status(event))) || scopeState(entry.scope) === 'fail');
  if (failure) initial = failure.index;
  coverageSummary(); applyTheme(); renderCases(); renderDirectory(); selectScope(initial); updateDirectoryVisibility();
})();
`;
