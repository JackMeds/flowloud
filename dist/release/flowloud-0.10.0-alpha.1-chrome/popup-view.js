(function attachPopupView(global) {
  'use strict';
  const boundRoots = new WeakSet();
  const popupRefs = new WeakMap();

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
    const node = button(className, '', action);
    const icon = element('img', 'qr-control-icon');
    const relative = `assets/icons/${iconName}.svg`;
    icon.src = global.chrome?.runtime?.getURL ? global.chrome.runtime.getURL(relative) : relative;
    icon.alt = '';
    node.append(icon, element('span', 'qr-control-label', label));
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

  function captureScroll(root) {
    const nodes = Array.from(root.querySelectorAll('.qr-popup, [data-scroll-key]'))
      .filter((node, index, all) => all.indexOf(node) === index);
    return nodes.map((node, index) => ({
      key: node.dataset.scrollKey || (node.classList.contains('qr-popup') ? 'popup' : `scroll:${index}`),
      top: node.scrollTop,
      left: node.scrollLeft
    }));
  }

  function restoreScroll(root, previous) {
    (previous || []).forEach((entry) => {
      const escapedKey = String(entry.key).replace(/["\\]/g, '\\$&');
      const selector = entry.key === 'popup' ? '.qr-popup' : `[data-scroll-key="${escapedKey}"]`;
      const node = root.querySelector(selector);
      if (!node) return;
      node.scrollTop = entry.top;
      node.scrollLeft = entry.left;
    });
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
      const tab = event.target.closest('[data-popup-tab]');
      if (tab) {
        activatePopupTab(root, tab.dataset.popupTab);
        return;
      }
      const target = event.target.closest('[data-action]');
      if (!target) return;
      const action = target.dataset.action;
      if (action === 'open-page-editor' || action === 'open-options' || action === 'open-guide') return dispatch(root, action);
      if (action === 'previous' || action === 'toggle-playback' || action === 'next') return dispatch(root, 'reader:command', { command: action });
      if (action === 'save-page-voices' || action === 'cancel-page-voices') return dispatch(root, action);
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

  function popupTab(key, label) {
    const node = button('qr-popup-tab', label, '');
    delete node.dataset.action;
    node.dataset.popupTab = key;
    node.dataset.focusKey = `popup-tab:${key}`;
    node.id = `qr-popup-tab-${key}`;
    node.setAttribute('role', 'tab');
    node.setAttribute('aria-controls', `qr-popup-panel-${key}`);
    return node;
  }

  function popupPanel(key) {
    const node = element('section', 'qr-popup-panel');
    node.id = `qr-popup-panel-${key}`;
    node.dataset.popupPanel = key;
    node.setAttribute('role', 'tabpanel');
    node.setAttribute('aria-labelledby', `qr-popup-tab-${key}`);
    node.tabIndex = 0;
    return node;
  }

  function activatePopupTab(root, requested) {
    const key = ['reader', 'voices', 'settings'].includes(requested) ? requested : 'reader';
    root.dataset.activePopupTab = key;
    root.querySelectorAll('[data-popup-tab]').forEach((tab) => {
      const active = tab.dataset.popupTab === key;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
    });
    root.querySelectorAll('[data-popup-panel]').forEach((panel) => {
      panel.hidden = panel.dataset.popupPanel !== key;
    });
  }

  function settingCopy(title, description) {
    const copy = element('span', 'qr-quick-copy');
    copy.append(element('strong', '', title), element('small', '', description));
    return copy;
  }

  function switchRow(setting, title, description, checked) {
    const row = element('label', 'qr-quick-row');
    row.append(settingCopy(title, description));
    const switchWrap = element('span', 'qr-popup-switch');
    const input = element('input');
    input.type = 'checkbox';
    input.dataset.setting = setting;
    input.dataset.focusKey = `setting:${setting}`;
    input.checked = checked;
    input.setAttribute('aria-label', title);
    switchWrap.append(input, element('span'));
    row.append(switchWrap);
    return row;
  }

  function selectRow(setting, title, description, options, selected) {
    const row = element('label', 'qr-quick-row qr-quick-row-stack');
    row.append(settingCopy(title, description));
    const select = element('select', 'qr-quick-select');
    select.dataset.setting = setting;
    select.dataset.focusKey = `setting:${setting}`;
    select.setAttribute('aria-label', title);
    options.forEach(([value, label]) => {
      const option = element('option', '', label);
      option.value = value;
      option.selected = value === selected;
      select.append(option);
    });
    row.append(select);
    return row;
  }

  function quickSettingsSection(model) {
    const settings = model && model.settings || {};
    const section = element('section', 'qr-quick-settings');
    section.setAttribute('aria-labelledby', 'qr-quick-settings-title');
    const heading = element('div', 'qr-quick-settings-head');
    heading.append(element('h2', '', '全局设置'), button('qr-link-button', '打开完整设置', 'open-options'));
    heading.firstChild.id = 'qr-quick-settings-title';
    section.append(heading);

    section.append(selectRow(
      'activeProviderId',
      '语音来源',
      '系统语音安装后立即可用；其他来源需先配置。',
      [['browser-system', '浏览器系统语音'], ['browser-model', '浏览器下载模型'], ['local-service', '本地服务'], ['openai-compatible', 'OpenAI 兼容在线 TTS']],
      settings.activeProviderId || 'browser-system',
    ));
    const interactionHeading = element('div', 'qr-quick-subhead');
    interactionHeading.append(element('strong', '', '网页交互'), element('span', '', '全局生效'));
    section.append(interactionHeading);
    section.append(switchRow('showFloatingPlayer', '显示网页悬浮球', '在网页边缘保留小型播放球，可拖动吸附。', settings.showFloatingPlayer !== false));
    section.append(switchRow('clickToRead', '点击正文朗读', '点击正文句子后从该处开始朗读。', settings.clickToRead === true));
    section.append(selectRow(
      'preset',
      '作者配音策略',
      '决定楼主与回复作者如何分配音色。',
      [['op-exclusive', '楼主专属'], ['stable-author', '作者固定'], ['round-robin', '按楼层轮换']],
      settings.preset || 'op-exclusive',
    ));
    return section;
  }

  function readingSettingsSection(model) {
    const settings = model && model.settings || {};
    const section = element('section', 'qr-quick-settings qr-reading-settings');
    section.setAttribute('aria-labelledby', 'qr-reading-settings-title');
    const heading = element('div', 'qr-quick-settings-head');
    heading.append(element('h2', '', '朗读设置'), element('span', '', '即时生效'));
    heading.firstChild.id = 'qr-reading-settings-title';
    section.append(heading);
    section.append(selectRow(
      'playbackRate',
      '播放速度',
      '调整朗读节奏；新的段落会使用当前速度。',
      [0.75, 1, 1.25, 1.5, 1.75, 2].map((value) => [String(value), `${value}×`]),
      String(settings.playbackRate || 1),
    ));
    const modeHeading = element('div', 'qr-quick-subhead');
    modeHeading.append(element('strong', '', '阅读模式'), element('span', '', '选择内容入口'));
    section.append(modeHeading, modeSwitch(model));
    return section;
  }

  function updateQuickSettings(section, model) {
    const settings = model && model.settings || {};
    const values = {
      activeProviderId: settings.activeProviderId || 'browser-system',
      playbackRate: String(settings.playbackRate || 1),
      preset: settings.preset || 'op-exclusive'
    };
    Object.keys(values).forEach((setting) => {
      const control = section.querySelector(`[data-setting="${setting}"]`);
      if (control) control.value = values[setting];
    });
    const floating = section.querySelector('[data-setting="showFloatingPlayer"]');
    const clickToRead = section.querySelector('[data-setting="clickToRead"]');
    if (floating) floating.checked = settings.showFloatingPlayer !== false;
    if (clickToRead) clickToRead.checked = settings.clickToRead === true;
  }

  function modeSwitch(model) {
    const settings = model && model.settings || {};
    const mode = settings.readingMode || 'content';
    const group = element('div', 'qr-mode-switch');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', '阅读模式');
    [['content', '正文朗读', '朗读当前页面提取出的正文内容'], ['guide', '页面导览', '按标题、区域和控件浏览当前页面']].forEach(([value, label, hint]) => {
      const item = element('label', `qr-mode-option${mode === value ? ' is-active' : ''}`);
      const input = element('input');
      input.type = 'radio'; input.name = 'readingMode'; input.value = value;
      input.checked = mode === value; input.dataset.setting = 'readingMode'; input.dataset.focusKey = `setting:readingMode:${value}`;
      item.title = hint;
      item.append(input, element('span', '', label)); group.append(item);
    });
    return group;
  }

  function updateModeSwitch(group, model) {
    const mode = model && model.settings && model.settings.readingMode || 'content';
    group.querySelectorAll('input[data-setting="readingMode"]').forEach((input) => {
      const active = input.value === mode;
      input.checked = active;
      input.parentElement.classList.toggle('is-active', active);
    });
  }

  function createPopupShell(root, model) {
    const shell = element('section', 'qr-popup');
    shell.dataset.scrollKey = 'popup';
    const sticky = element('div', 'qr-popup-sticky');
    const header = element('header', 'qr-popup-header');
    const brandLockup = element('div', 'qr-popup-brand-lockup');
    const brandLogo = element('img', 'qr-popup-brand-logo');
    brandLogo.src = global.chrome?.runtime?.getURL ? global.chrome.runtime.getURL('assets/flowloud-32.png') : 'assets/flowloud-32.png';
    brandLogo.alt = '';
    brandLockup.append(brandLogo, element('h1', 'qr-brand', 'Flowloud / 流声'));
    const headerActions = element('div', 'qr-popup-actions');
    const status = element('span', 'qr-status', '准备就绪');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.setAttribute('aria-atomic', 'true');
    headerActions.append(status, button('qr-text-button', '全部设置', 'open-options'));
    header.append(brandLockup, headerActions);

    const guide = element('section', 'qr-guide-entry');
    const guideButton = button('qr-control qr-control-primary', '打开页面导览', 'open-guide');
    guide.append(element('strong', '', '按标题、区域和控件浏览当前页面'), element('p', '', '只定位与朗读，不会点击或修改网页。'), guideButton);
    const pageCard = element('section', 'qr-page-card');
    const emptyCard = element('section', 'qr-empty-card');
    const message = element('p', 'qr-popup-message');
    message.setAttribute('role', 'alert');
    const tabs = element('nav', 'qr-popup-tabs');
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', 'Flowloud 控制台');
    tabs.append(popupTab('reader', '朗读'), popupTab('voices', '本页音色'), popupTab('settings', '设置'));
    const panels = element('div', 'qr-popup-panels');
    const readerPanel = popupPanel('reader');
    const voicesPanel = popupPanel('voices');
    const settingsPanel = popupPanel('settings');
    const readingSettings = readingSettingsSection(model);
    const modes = readingSettings.querySelector('.qr-mode-switch');
    const quick = quickSettingsSection(model);
    const voiceSummary = element('section', 'qr-voice-summary');
    readerPanel.append(readingSettings);
    voicesPanel.append(voiceSummary);
    settingsPanel.append(quick);
    panels.append(readerPanel, voicesPanel, settingsPanel);
    sticky.append(header, guide, pageCard, emptyCard, message, tabs);
    shell.append(sticky, panels);
    root.replaceChildren(shell);
    root.dataset.popupView = 'reader';
    const refs = { shell, sticky, status, modes, guide, pageCard, emptyCard, message, tabs, panels, readerPanel, voicesPanel, settingsPanel, readingSettings, quick, voiceSummary };
    popupRefs.set(root, refs);
    setControlEvents(root);
    activatePopupTab(root, root.dataset.activePopupTab || 'reader');
    return refs;
  }

  function statusLabel(status) {
    return status === 'playing' ? '正在朗读' : status === 'paused' ? '已暂停' : status === 'loading' ? '准备中' : status === 'error' ? '连接异常' : '准备就绪';
  }

  function normalizeReadingWords(current) {
    const sourceText = String(current && (current.speechText || current.text) || '')
      .replace(/\s+/gu, ' ')
      .trim();
    const sourceWords = current && Array.isArray(current.words) ? current.words : [];
    const words = sourceWords.slice(0, 180).map((word) => ({
      text: String(word && word.text || ''),
      sourceStart: Number(word && word.sourceStart),
      sourceEnd: Number(word && word.sourceEnd),
    })).filter((word) => Number.isFinite(word.sourceStart)
      && Number.isFinite(word.sourceEnd)
      && word.sourceStart >= 0
      && word.sourceEnd > word.sourceStart
      && word.sourceEnd <= sourceText.length);
    const wordIndex = Number.isInteger(Number(current && current.wordIndex))
      ? Number(current.wordIndex)
      : -1;
    return { sourceText, words, wordIndex };
  }

  function positionReadingCaption(reading, current) {
    const viewport = reading && reading.querySelector('.qr-reading-viewport');
    const track = reading && reading.querySelector('.qr-reading-track');
    if (!viewport || !track || !reading.classList.contains('is-long')) return;
    const viewportWidth = viewport.clientWidth;
    const trackWidth = track.scrollWidth;
    if (!viewportWidth || !trackWidth) return;
    const minimumOffset = Math.min(0, viewportWidth - trackWidth);
    let nextOffset = Number(reading.dataset.captionOffset || 0);
    if (!Number.isFinite(nextOffset)) nextOffset = 0;
    nextOffset = Math.min(0, Math.max(minimumOffset, nextOffset));
    const index = Number(current && current.wordIndex);
    const activeWord = Number.isInteger(index) && index >= 0
      ? track.querySelector(`.qr-reading-word[data-word-index="${index}"]`)
      : null;
    if (activeWord && trackWidth > viewportWidth) {
      const wordCenter = activeWord.offsetLeft + activeWord.offsetWidth / 2;
      const visibleCenter = wordCenter + nextOffset;
      const safeStart = viewportWidth * .28;
      const safeEnd = viewportWidth * .68;
      if (visibleCenter < safeStart || visibleCenter > safeEnd) {
        nextOffset = Math.min(0, Math.max(minimumOffset, viewportWidth * .42 - wordCenter));
      }
    }
    reading.dataset.captionOffset = String(nextOffset);
    const reducedMotion = Boolean(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
    track.classList.toggle('is-instant', reducedMotion);
    track.style.transform = `translate3d(${Math.round(nextOffset)}px, 0, 0)`;
  }

  function readingCaption(current) {
    const reading = element('div', 'qr-reading');
    const label = element('span', 'qr-reading-label', current && current.authorName || '正在准备');
    const viewport = element('div', 'qr-reading-viewport');
    const track = element('span', 'qr-reading-track');
    const normalized = normalizeReadingWords(current);
    const sourceText = normalized.sourceText || '正在识别正文，请稍候。';
    let cursor = 0;
    let appendedWords = 0;
    const fragment = document.createDocumentFragment();
    normalized.words.forEach((word, index) => {
      if (word.sourceStart < cursor) return;
      if (word.sourceStart > cursor) fragment.append(document.createTextNode(sourceText.slice(cursor, word.sourceStart)));
      const span = element('span', 'qr-reading-word', sourceText.slice(word.sourceStart, word.sourceEnd) || word.text);
      span.dataset.wordIndex = String(index);
      span.classList.toggle('is-active', index === normalized.wordIndex);
      fragment.append(span);
      cursor = word.sourceEnd;
      appendedWords += 1;
    });
    if (!appendedWords) {
      track.className = 'qr-reading-track qr-reading-text';
      track.textContent = sourceText;
    } else {
      if (cursor < sourceText.length) fragment.append(document.createTextNode(sourceText.slice(cursor)));
      track.append(fragment);
      track.dataset.wordCount = String(appendedWords);
      reading.classList.toggle('is-long', sourceText.length > 32);
    }
    viewport.append(track);
    reading.append(label, viewport);
    return { reading, current: Object.assign({}, current || {}, { wordIndex: normalized.wordIndex }) };
  }

  function updatePageCard(pageCard, model) {
    const snapshot = model && model.snapshot || {};
    const status = snapshot.status || model && model.status || 'idle';
    const segmentCount = Math.max(0, Number(snapshot.segmentCount || model.segmentCount || model.total || (snapshot.segments || []).length) || 0);
    const current = currentSegment(snapshot);
    const pageKicker = element('p', 'qr-kicker', model.sourceLabel || '当前网页');
    const pageTitle = element('h2', 'qr-page-title', model.title || '未命名页面');
    const previousReading = pageCard.querySelector('.qr-reading');
    const caption = readingCaption(current);
    const reading = caption.reading;
    if (previousReading && previousReading.dataset.captionOffset) reading.dataset.captionOffset = previousReading.dataset.captionOffset;
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
    const progressLabel = element('div', 'qr-progress-label');
    progressLabel.append(element('span', '', `第 ${Math.min(index + 1, total)} 段`), element('span', '', `共 ${total} 段`));
    const controls = element('div', 'qr-controls');
    controls.setAttribute('role', 'group');
    controls.setAttribute('aria-label', '朗读控制');
    const previous = transportButton('qr-control', '上一句', 'previous', 'skip-back');
    previous.disabled = !segmentCount || status === 'loading';
    const primaryLabel = status === 'playing' ? '暂停朗读' : status === 'loading' ? '暂停准备' : status === 'paused' ? '继续朗读' : '开始朗读';
    const primary = transportButton('qr-control qr-control-primary', primaryLabel, 'toggle-playback', status === 'playing' ? 'pause' : 'play');
    primary.disabled = !segmentCount;
    const next = transportButton('qr-control', '下一句', 'next', 'skip-forward');
    next.disabled = !segmentCount || status === 'loading';
    controls.append(previous, primary, next);
    pageCard.replaceChildren(reading, progress, progressLabel, pageKicker, pageTitle, controls, element('p', 'qr-runtime-note', '播放会在关闭弹窗后继续；正文会保持当前句与逐词高亮。'));
    positionReadingCaption(reading, caption.current);
    if (typeof global.requestAnimationFrame === 'function') global.requestAnimationFrame(() => positionReadingCaption(reading, caption.current));
  }

  function updateVoiceSummary(summary, model) {
    const authors = model && model.authors || [];
    if (!authors.length) {
      summary.hidden = true;
      summary.replaceChildren();
      return;
    }
    const titleRow = element('div', 'qr-voice-summary-head');
    const copy = element('div');
    copy.append(element('h2', '', '本页配音'), element('p', '', `${authors.length} 位作者，已按本页规则分配音色。`));
    titleRow.append(copy, button('qr-link-button', '调整本页配音', 'open-page-editor'));
    const chips = element('div', 'qr-voice-chips');
    authors.slice(0, 3).forEach((author) => chips.append(element('span', 'qr-voice-chip', `${author.name} · ${author.voice || '默认'}`)));
    if (authors.length > 3) chips.append(element('span', 'qr-voice-chip', `另有 ${authors.length - 3} 人`));
    summary.replaceChildren(titleRow, chips);
    summary.hidden = false;
  }

  function updatePopup(root, refs, model) {
    const snapshot = model && model.snapshot || {};
    const status = snapshot.status || model && model.status || 'idle';
    const hasContent = Boolean(model && !model.empty && (model.snapshot || model.title));
    const guideMode = (model && model.settings && model.settings.readingMode) === 'guide';
    refs.status.textContent = statusLabel(status);
    refs.status.dataset.state = status === 'idle' ? 'ready' : status;
    updateModeSwitch(refs.modes, model);
    refs.guide.hidden = !hasContent || !guideMode;
    refs.pageCard.hidden = !hasContent || guideMode;
    refs.emptyCard.hidden = hasContent;
    refs.emptyCard.textContent = model && model.message || '打开一篇文章或讨论页后，即可从这里开始朗读。';
    refs.message.hidden = !model || !model.message || !hasContent;
    refs.message.textContent = hasContent ? model.message || '' : '';
    if (hasContent && !guideMode) {
      updatePageCard(refs.pageCard, model);
      updateVoiceSummary(refs.voiceSummary, model);
    } else if (!hasContent) {
      refs.voiceSummary.hidden = false;
      refs.voiceSummary.replaceChildren(element('section', 'qr-empty-card', '打开一篇文章或讨论页后，即可调整本页音色。'));
    }
    updateQuickSettings(refs.shell, model);
    refs.shell.dataset.status = status;
    root.dataset.popupView = 'reader';
    activatePopupTab(root, root.dataset.activePopupTab || 'reader');
  }

  function mountPopup(root, model) {
    const previousFocus = captureFocus(root);
    const previousScroll = captureScroll(root);
    let refs = popupRefs.get(root);
    if (!refs || root.dataset.popupView !== 'reader') refs = createPopupShell(root, model);
    updatePopup(root, refs, model || {});
    restoreScroll(root, previousScroll);
    restoreFocus(root, previousFocus);
  }

  function mountPageVoices(root, model) {
    const previousFocus = captureFocus(root);
    const previousScroll = captureScroll(root);
    const authors = model && model.authors || [];
    const voices = model && model.voices || [];
    const authorVoices = model && model.authorVoices || {};
    const compact = Boolean(model && model.compact);
    const shell = element('main', `qr-page-root${compact ? ' qr-page-root-compact' : ''}`);
    const header = element('header', 'qr-page-header');
    const title = element('div', 'qr-page-title-block');
    title.append(element('p', 'qr-kicker', compact ? '本页配音' : 'FLOWLOUD · 本页配音'));
    title.append(element('h1', '', compact ? '调整作者音色' : model && model.title || '本页配音'));
    title.append(element('p', 'qr-page-subtitle', compact
      ? '只影响当前网页；留空即跟随全局策略。'
      : '只影响当前网页。全局音色请在扩展设置中管理。'));
    header.append(title, element('span', 'qr-author-count', `${authors.length} 位作者`));
    shell.append(header);
    if (model && model.error) {
      const error = element('p', 'qr-page-error', model.error);
      error.setAttribute('role', 'alert');
      shell.append(error);
    }
    const list = element('section', 'qr-author-list');
    list.dataset.scrollKey = 'author-list';
    if (!authors.length) list.append(element('section', 'qr-empty-card', '还没有识别到可单独配音的作者。返回网页并等待正文识别完成后再试。'));
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
    root.replaceChildren(shell);
    root.dataset.popupView = 'page-voices';
    setControlEvents(root);
    restoreScroll(root, previousScroll);
    restoreFocus(root, previousFocus);
  }

  global.QwenPopupView = Object.freeze({ mountPopup, mountPageVoices });
})(globalThis);
