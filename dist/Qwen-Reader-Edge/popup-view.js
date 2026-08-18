(function attachPopupView(global) {
  'use strict';
  const boundRoots = new WeakSet();

  function element(tagName, className, text) {
    const node = document.createElement(tagName);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(className, label, action) {
    const node = element('button', className, label);
    node.type = 'button';
    node.dataset.action = action;
    return node;
  }

  function dispatch(root, action, detail) {
    root.dispatchEvent(new CustomEvent('qwen-popup-command', { bubbles: true, detail: Object.assign({ action }, detail || {}) }));
  }

  function currentSegment(snapshot) {
    if (snapshot && snapshot.current) return snapshot.current;
    const segments = snapshot && snapshot.segments || [];
    return segments[snapshot && Number.isInteger(snapshot.index) ? snapshot.index : 0] || null;
  }

  function setControlEvents(root) {
    if (boundRoots.has(root)) return;
    boundRoots.add(root);
    root.addEventListener('click', (event) => {
      const target = event.target.closest('[data-action]');
      if (!target) return;
      const action = target.dataset.action;
      if (action === 'open-page-editor') return dispatch(root, action);
      if (action === 'open-options') return dispatch(root, action);
      if (action === 'previous' || action === 'toggle-playback' || action === 'next') return dispatch(root, 'reader:command', { command: action });
      if (action === 'save-page-voices') return dispatch(root, action);
      if (action === 'cancel-page-voices') return dispatch(root, action);
    });
    root.addEventListener('change', (event) => {
      const target = event.target;
      if (target.matches('[data-speed]')) dispatch(root, 'reader:command', { command: 'set-speed', value: target.value });
    });
  }

  function mountPopup(root, model) {
    const snapshot = model && model.snapshot || {};
    const status = snapshot.status || model && model.status || 'idle';
    const segmentCount = Math.max(0, Number(snapshot.segmentCount || model.segmentCount || model.total || (snapshot.segments || []).length) || 0);
    const current = currentSegment(snapshot);
    root.replaceChildren();
    const shell = element('section', 'qr-popup');
    const header = element('header', 'qr-popup-header');
    header.append(element('h1', 'qr-brand', 'Qwen 网页朗读'));
    const headerRight = element('div', 'qr-status', status === 'playing' ? '正在朗读' : status === 'paused' ? '已暂停' : status === 'error' ? '连接异常' : '准备就绪');
    headerRight.dataset.state = status === 'idle' ? 'ready' : status;
    header.append(headerRight);
    shell.append(header);
    if (!model || model.empty) {
      shell.append(element('section', 'qr-empty-card', model && model.message || '打开一篇文章或讨论页后，即可从这里开始朗读。'));
      root.append(shell);
      setControlEvents(root);
      return;
    }
    const pageCard = element('section', 'qr-page-card');
    pageCard.append(element('p', 'qr-kicker', model.sourceLabel || '当前网页'));
    pageCard.append(element('h2', 'qr-page-title', model.title || '未命名页面'));
    const reading = element('div', 'qr-reading');
    reading.append(element('span', 'qr-reading-label', current && current.authorName || '正在准备'));
    reading.append(document.createTextNode(current && current.text || '正在识别正文，请稍候。'));
    pageCard.append(reading);
    const total = Math.max(segmentCount, 1);
    const index = Math.max(0, Number.isInteger(snapshot.index) ? snapshot.index : Number(model.index) || 0);
    const progress = element('div', 'qr-progress');
    const progressInner = element('span');
    progressInner.style.width = `${Math.min(100, ((index + 1) / total) * 100)}%`;
    progress.append(progressInner);
    pageCard.append(progress);
    const progressLabel = element('div', 'qr-progress-label');
    progressLabel.append(element('span', '', `第 ${Math.min(index + 1, total)} 段`), element('span', '', `共 ${total} 段`));
    pageCard.append(progressLabel);
    const controls = element('div', 'qr-controls');
    const previous = button('qr-control', '上一句', 'previous');
    previous.disabled = !segmentCount || status === 'loading';
    const primary = button('qr-control qr-control-primary', status === 'playing' ? '暂停朗读' : '开始朗读', 'toggle-playback');
    primary.disabled = !segmentCount || status === 'loading';
    const next = button('qr-control', '下一句', 'next');
    next.disabled = !segmentCount || status === 'loading';
    controls.append(previous, primary, next);
    pageCard.append(controls);
    const speedRow = element('label', 'qr-speed-row');
    speedRow.append(element('span', '', '朗读速度'));
    const speed = element('select', 'qr-speed-select');
    speed.dataset.speed = 'true';
    const playbackSpeed = String(snapshot.speed || snapshot.rate || model.speed || '1.0');
    ['0.8×', '1.0×', '1.2×', '1.4×'].forEach((label) => {
      const option = element('option', '', label);
      option.value = label.replace('×', '');
      option.selected = option.value === playbackSpeed;
      speed.append(option);
    });
    speedRow.append(speed);
    pageCard.append(speedRow);
    shell.append(pageCard);
    const authors = model.authors || [];
    if (authors.length) {
      const summary = element('section', 'qr-voice-summary');
      const titleRow = element('div', 'qr-voice-summary-head');
      const copy = element('div');
      copy.append(element('h2', '', '本页配音'));
      copy.append(element('p', '', `${authors.length} 位作者，已按本页规则分配音色。`));
      titleRow.append(copy, button('qr-link-button', '编辑', 'open-page-editor'));
      summary.append(titleRow);
      const chips = element('div', 'qr-voice-chips');
      authors.slice(0, 3).forEach((author) => chips.append(element('span', 'qr-voice-chip', `${author.name} · ${author.voice || '默认'}`)));
      if (authors.length > 3) chips.append(element('span', 'qr-voice-chip', `另有 ${authors.length - 3} 人`));
      summary.append(chips);
      shell.append(summary);
    }
    shell.append(element('p', 'qr-footer-note', '朗读将在关闭弹窗后继续；网页正文会跟随高亮。'));
    root.append(shell);
    setControlEvents(root);
  }

  function mountPageVoices(root, model) {
    const authors = model && model.authors || [];
    const voices = model && model.voices || [];
    const authorVoices = model && model.authorVoices || {};
    root.replaceChildren();
    const shell = element('main', 'qr-page-root');
    const header = element('header', 'qr-page-header');
    const title = element('div', 'qr-page-title-block');
    title.append(element('p', 'qr-kicker', 'QWEN READER · 本页配音'));
    title.append(element('h1', '', model && model.title || '本页配音'));
    title.append(element('p', 'qr-page-subtitle', '只影响当前网页。全局音色请在扩展设置中管理。'));
    header.append(title, element('span', 'qr-author-count', `${authors.length} 位作者`));
    shell.append(header);
    if (model && model.error) {
      const error = element('p', 'qr-page-error', model.error);
      error.setAttribute('role', 'alert');
      shell.append(error);
    }
    const list = element('section', 'qr-author-list');
    authors.forEach((author) => {
      const card = element('article', 'qr-author-card');
      const row = element('div', 'qr-author-row');
      const copy = element('div');
      copy.append(element('div', 'qr-author-name', author.name || '未署名作者'));
      copy.append(element('p', 'qr-author-meta', `${author.count || 0} 段文字${author.isOp ? ' · 楼主' : ''}`));
      row.append(copy, element('span', 'qr-voice-chip', author.isOp ? '楼主' : '回复'));
      card.append(row);
      const select = element('select', 'qr-voice-select');
      select.name = `voice:${author.id || author.name}`;
      select.dataset.authorId = author.id || author.name || '';
      const followGlobal = element('option', '', `跟随全局策略（当前：${author.voice || '默认音色'}）`);
      followGlobal.value = '';
      select.append(followGlobal);
      const explicitVoice = String(authorVoices[author.id || author.name] || '');
      voices.forEach((voice) => {
        const voiceName = typeof voice === 'string' ? voice : voice.name;
        const option = element('option', '', voiceName);
        option.value = voiceName;
        option.selected = voiceName === explicitVoice;
        select.append(option);
      });
      card.append(select);
      list.append(card);
    });
    shell.append(list);
    const actions = element('footer', 'qr-page-actions');
    actions.append(button('qr-secondary-button', '取消', 'cancel-page-voices'), button('qr-primary-button', '应用到本页', 'save-page-voices'));
    shell.append(actions);
    root.append(shell);
    setControlEvents(root);
  }

  global.QwenPopupView = Object.freeze({ mountPopup, mountPageVoices });
})(globalThis);
