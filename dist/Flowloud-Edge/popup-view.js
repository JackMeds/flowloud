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
    node.dataset.focusKey = `action:${action}`;
    return node;
  }

  function transportButton(className, label, action, iconName) {
    const node = button(className, label, action);
    const icon = element('img', 'qr-control-icon');
    const relative = `assets/icons/${iconName}.svg`;
    icon.src = global.chrome?.runtime?.getURL ? global.chrome.runtime.getURL(relative) : relative;
    icon.alt = '';
    node.prepend(icon);
    return node;
  }

  function captureFocus(root) {
    const active = document.activeElement;
    if (!active || !root.contains(active)) return null;
    return {
      key: active.dataset && active.dataset.focusKey || '',
      name: active.getAttribute && active.getAttribute('name') || ''
    };
  }

  function restoreFocus(root, previous) {
    if (!previous) return;
    const controls = Array.from(root.querySelectorAll('button, input, select, textarea, [tabindex]'));
    const target = controls.find((control) =>
      previous.key && control.dataset && control.dataset.focusKey === previous.key
    ) || controls.find((control) =>
      previous.name && control.getAttribute('name') === previous.name
    );
    if (target && typeof target.focus === 'function') target.focus({ preventScroll: true });
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
      if (action === 'open-guide') return dispatch(root, action);
      if (action === 'previous' || action === 'toggle-playback' || action === 'next') return dispatch(root, 'reader:command', { command: action });
      if (action === 'save-page-voices') return dispatch(root, action);
      if (action === 'cancel-page-voices') return dispatch(root, action);
    });
    root.addEventListener('change', (event) => {
      const control = event.target.closest('[data-setting]');
      if (!control) return;
      dispatch(root, 'setting-change', {
        setting: control.dataset.setting,
        value: control.type === 'checkbox' ? control.checked : control.value
      });
    });
  }

  function quickSettingsSection(model) {
    const settings = model && model.settings || {};
    const section = element('section', 'qr-quick-settings');
    const heading = element('div', 'qr-quick-settings-head');
    heading.append(element('h2', '', '声音'), element('span', '', '全局生效'));
    section.append(heading);

    const providerRow = element('label', 'qr-quick-row qr-quick-row-stack');
    const providerCopy = element('span', 'qr-quick-copy');
    providerCopy.append(element('strong', '', '语音来源'), element('small', '', '系统语音安装后立即可用；其他来源需配置或下载'));
    const provider = element('select', 'qr-quick-select');
    provider.dataset.setting = 'activeProviderId'; provider.dataset.focusKey = 'setting:activeProviderId'; provider.setAttribute('aria-label', '语音来源');
    [['browser-system', '浏览器系统语音'], ['browser-model', '浏览器下载模型'], ['local-qwen', '本地 Qwen'], ['openai-compatible', 'OpenAI 兼容在线 TTS']]
      .forEach(([value, label]) => { const option = element('option', '', label); option.value = value; option.selected = value === (settings.activeProviderId || 'browser-system'); provider.append(option); });
    providerRow.append(providerCopy, provider); section.append(providerRow);

    const speedRow = element('label', 'qr-quick-row qr-quick-row-stack');
    const speedCopy = element('span', 'qr-quick-copy');
    speedCopy.append(element('strong', '', '朗读速度'), element('small', '', '渐进音频无法安全变速时会切换为完整音频播放'));
    const speed = element('select', 'qr-quick-select'); speed.dataset.setting = 'playbackRate'; speed.dataset.focusKey = 'setting:playbackRate'; speed.setAttribute('aria-label', '朗读速度');
    [0.75, 1, 1.25, 1.5, 1.75, 2].forEach((value) => { const option = element('option', '', `${value}×`); option.value = String(value); option.selected = Number(settings.playbackRate || 1) === value; speed.append(option); });
    speedRow.append(speedCopy, speed); section.append(speedRow);

    const pageOptions = element('details', 'qr-page-options');
    const pageSummary = element('summary', 'qr-page-options-summary', '本页选项');
    pageOptions.append(pageSummary);
    const floatingRow = element('label', 'qr-quick-row');
    const floatingCopy = element('span', 'qr-quick-copy');
    floatingCopy.append(element('strong', '', '网页悬浮窗'), element('small', '', '在网页上显示播放、定位与缩放控制'));
    const floatingSwitch = element('span', 'qr-popup-switch');
    const floatingInput = element('input');
    floatingInput.type = 'checkbox';
    floatingInput.dataset.setting = 'showFloatingPlayer';
    floatingInput.dataset.focusKey = 'setting:showFloatingPlayer';
    floatingInput.checked = settings.showFloatingPlayer !== false;
    floatingInput.setAttribute('aria-label', '显示网页悬浮窗');
    floatingSwitch.append(floatingInput, element('span'));
    floatingRow.append(floatingCopy, floatingSwitch);
    pageOptions.append(floatingRow);

    const clickRow = element('label', 'qr-quick-row');
    const clickCopy = element('span', 'qr-quick-copy');
    clickCopy.append(element('strong', '', '网页点读'), element('small', '', '点击正文句子后从该处朗读'));
    const clickSwitch = element('span', 'qr-popup-switch');
    const clickInput = element('input');
    clickInput.type = 'checkbox';
    clickInput.dataset.setting = 'clickToRead';
    clickInput.dataset.focusKey = 'setting:clickToRead';
    clickInput.checked = settings.clickToRead === true;
    clickInput.setAttribute('aria-label', '网页点读');
    clickSwitch.append(clickInput, element('span'));
    clickRow.append(clickCopy, clickSwitch);
    pageOptions.append(clickRow);

    const strategyRow = element('label', 'qr-quick-row qr-quick-row-stack');
    const strategyCopy = element('span', 'qr-quick-copy');
    strategyCopy.append(element('strong', '', '作者配音策略'), element('small', '', '决定楼主与回复作者如何分配音色'));
    const strategy = element('select', 'qr-quick-select');
    strategy.dataset.setting = 'preset';
    strategy.dataset.focusKey = 'setting:preset';
    strategy.setAttribute('aria-label', '作者配音策略');
    [
      ['op-exclusive', '楼主专属'],
      ['stable-author', '作者固定'],
      ['round-robin', '按楼层轮换']
    ].forEach(([value, label]) => {
      const option = element('option', '', label);
      option.value = value;
      option.selected = value === (settings.preset || 'op-exclusive');
      strategy.append(option);
    });
    strategyRow.append(strategyCopy, strategy);
    pageOptions.append(strategyRow);
    section.append(pageOptions);
    return section;
  }

  function modeSwitch(model) {
    const settings = model && model.settings || {};
    const mode = settings.readingMode || 'content';
    const group = element('div', 'qr-mode-switch');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', '阅读模式');
    [['content', '内容朗读'], ['guide', '页面导览']].forEach(([value, label]) => {
      const item = element('label', `qr-mode-option${mode === value ? ' is-active' : ''}`);
      const input = element('input');
      input.type = 'radio'; input.name = 'readingMode'; input.value = value;
      input.checked = mode === value; input.dataset.setting = 'readingMode'; input.dataset.focusKey = `setting:readingMode:${value}`;
      item.append(input, element('span', '', label)); group.append(item);
    });
    return group;
  }

  function mountPopup(root, model) {
    const previousFocus = captureFocus(root);
    const snapshot = model && model.snapshot || {};
    const status = snapshot.status || model && model.status || 'idle';
    const segmentCount = Math.max(0, Number(snapshot.segmentCount || model.segmentCount || model.total || (snapshot.segments || []).length) || 0);
    const current = currentSegment(snapshot);
    root.replaceChildren();
    const shell = element('section', 'qr-popup');
    const header = element('header', 'qr-popup-header');
    const brandLockup = element('div', 'qr-popup-brand-lockup');
    const brandLogo = element('img', 'qr-popup-brand-logo');
    brandLogo.src = global.chrome?.runtime?.getURL ? global.chrome.runtime.getURL('assets/flowloud-32.png') : 'assets/flowloud-32.png';
    brandLogo.alt = '';
    brandLockup.append(brandLogo, element('h1', 'qr-brand', 'Flowloud / 流声'));
    header.append(brandLockup);
    const headerActions = element('div', 'qr-popup-actions');
    const headerRight = element('span', 'qr-status', status === 'playing' ? '正在朗读' : status === 'paused' ? '已暂停' : status === 'error' ? '连接异常' : '准备就绪');
    headerRight.dataset.state = status === 'idle' ? 'ready' : status;
    headerRight.setAttribute('role', 'status');
    headerRight.setAttribute('aria-live', 'polite');
    headerRight.setAttribute('aria-atomic', 'true');
    headerActions.append(headerRight, button('qr-text-button', '设置', 'open-options'));
    header.append(headerActions);
    shell.append(header);
    shell.append(modeSwitch(model));
    if ((model?.settings?.readingMode || 'content') === 'guide') {
      const guideIntro = element('section', 'qr-guide-entry');
      guideIntro.append(element('strong', '', '按标题、区域和控件浏览当前页面'), element('p', '', '只定位与朗读，不会点击或修改网页。'));
      guideIntro.append(button('qr-control qr-control-primary', '打开页面导览', 'open-guide'));
      shell.append(guideIntro);
    }
    if (!model || model.empty) {
      shell.append(element('section', 'qr-empty-card', model && model.message || '打开一篇文章或讨论页后，即可从这里开始朗读。'));
      shell.append(quickSettingsSection(model));
      root.append(shell);
      setControlEvents(root);
      restoreFocus(root, previousFocus);
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
    progress.setAttribute('role', 'progressbar');
    progress.setAttribute('aria-label', '朗读进度');
    progress.setAttribute('aria-valuemin', '1');
    progress.setAttribute('aria-valuemax', String(total));
    progress.setAttribute('aria-valuenow', String(Math.min(index + 1, total)));
    const progressInner = element('span');
    progressInner.style.width = `${Math.min(100, ((index + 1) / total) * 100)}%`;
    progress.append(progressInner);
    pageCard.append(progress);
    const progressLabel = element('div', 'qr-progress-label');
    progressLabel.append(element('span', '', `第 ${Math.min(index + 1, total)} 段`), element('span', '', `共 ${total} 段`));
    pageCard.append(progressLabel);
    const controls = element('div', 'qr-controls');
    controls.setAttribute('role', 'group');
    controls.setAttribute('aria-label', '朗读控制');
    const previous = transportButton('qr-control', '上一句', 'previous', 'skip-back');
    previous.disabled = !segmentCount || status === 'loading';
    const primary = transportButton('qr-control qr-control-primary', status === 'playing' ? '暂停朗读' : '开始朗读', 'toggle-playback', status === 'playing' ? 'pause' : 'play');
    primary.textContent = status === 'playing' ? '暂停朗读' : status === 'loading' ? '暂停准备' : status === 'paused' ? '继续朗读' : '开始朗读';
    primary.disabled = !segmentCount;
    const next = transportButton('qr-control', '下一句', 'next', 'skip-forward');
    next.disabled = !segmentCount || status === 'loading';
    controls.append(previous, primary, next);
    pageCard.append(controls);
    pageCard.append(element('p', 'qr-runtime-note', '播放会在关闭弹窗后继续；正文将保持当前句与逐词高亮。'));
    shell.append(pageCard);
    shell.append(quickSettingsSection(model));
    const authors = model.authors || [];
    if (authors.length) {
      const summary = element('section', 'qr-voice-summary');
      const titleRow = element('div', 'qr-voice-summary-head');
      const copy = element('div');
      copy.append(element('h2', '', '本页配音'));
      copy.append(element('p', '', `${authors.length} 位作者，已按本页规则分配音色。`));
      titleRow.append(copy, button('qr-link-button', '在弹窗内调整', 'open-page-editor'));
      summary.append(titleRow);
      const chips = element('div', 'qr-voice-chips');
      authors.slice(0, 3).forEach((author) => chips.append(element('span', 'qr-voice-chip', `${author.name} · ${author.voice || '默认'}`)));
      if (authors.length > 3) chips.append(element('span', 'qr-voice-chip', `另有 ${authors.length - 3} 人`));
      summary.append(chips);
      shell.append(summary);
    }
    root.append(shell);
    setControlEvents(root);
    restoreFocus(root, previousFocus);
  }

  function mountPageVoices(root, model) {
    const previousFocus = captureFocus(root);
    const authors = model && model.authors || [];
    const voices = model && model.voices || [];
    const authorVoices = model && model.authorVoices || {};
    const compact = Boolean(model && model.compact);
    root.replaceChildren();
    const shell = element('main', `qr-page-root${compact ? ' qr-page-root-compact' : ''}`);
    const header = element('header', 'qr-page-header');
    const title = element('div', 'qr-page-title-block');
    title.append(element('p', 'qr-kicker', compact ? '本页配音' : 'FLOWLOUD · 本页配音'));
    title.append(element('h1', '', compact ? '调整作者音色' : model && model.title || '本页配音'));
    title.append(element('p', 'qr-page-subtitle', compact
      ? '直接在这里修改，只影响当前网页；留空即跟随全局策略。'
      : '只影响当前网页。全局音色请在扩展设置中管理。'));
    header.append(title, element('span', 'qr-author-count', `${authors.length} 位作者`));
    shell.append(header);
    if (model && model.error) {
      const error = element('p', 'qr-page-error', model.error);
      error.setAttribute('role', 'alert');
      shell.append(error);
    }
    const list = element('section', 'qr-author-list');
    if (!authors.length) {
      list.append(element('section', 'qr-empty-card', '还没有识别到可单独配音的作者。返回网页并等待正文识别完成后再试。'));
    }
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
      select.dataset.focusKey = `voice:${author.id || author.name || ''}`;
      select.setAttribute('aria-label', `${author.name || '未署名作者'}的音色`);
      const effectiveVoice = author.effectiveVoice || author.voice || '默认音色';
      const followGlobal = element('option', '', `跟随全局策略（当前：${effectiveVoice}）`);
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
    restoreFocus(root, previousFocus);
  }

  global.QwenPopupView = Object.freeze({ mountPopup, mountPageVoices });
})(globalThis);
