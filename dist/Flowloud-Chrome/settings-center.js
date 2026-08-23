(function settingsCenter() {
  'use strict';

  const SETTINGS_KEY = 'qwenReaderSettings';
  const defaults = globalThis.QwenReaderDefaults || {};
  const form = document.getElementById('reader-settings-form');
  const saveStatus = document.getElementById('settings-save-status');
  const customControls = document.getElementById('word-custom-settings');
  const replyOptions = document.getElementById('reply-voice-options');
  const opVoiceSelect = form && form.querySelector('[data-role="op-voice-select"]');
  let settings = {};
  let voiceNames = [];
  let saveTimer = null;
  let saveRevision = 0;

  const settingKeys = [
    'readingFocus', 'readingFocusStyle',
    'wordHighlightStyle', 'wordHighlightColor', 'wordHighlightGlow',
    'wordHighlightSpeed', 'opVoice', 'replyVoices', 'clickToRead', 'showFloatingPlayer', 'preset', 'interactionVersion',
  ];

  function unique(values) {
    return Array.from(new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean)));
  }

  function clamp(value, minimum, maximum, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback;
  }

  function oneOf(value, values, fallback) {
    return values.includes(value) ? value : fallback;
  }

  function normalize(value) {
    const next = Object.assign({}, defaults, value || {});
    next.activeProviderId = String(next.activeProviderId || next.providerId || 'browser-system');
    next.voiceAssignmentsByProvider = Object.assign({}, next.voiceAssignmentsByProvider || {});
    const assignment = next.voiceAssignmentsByProvider[next.activeProviderId] || {};
    next.clickToRead = Number(value && value.interactionVersion || 0) < 3
      ? false
      : next.clickToRead === true;
    next.showFloatingPlayer = next.showFloatingPlayer !== false;
    next.preset = oneOf(next.preset || next.voiceMode, ['op-exclusive', 'stable-author', 'round-robin'], 'op-exclusive');
    next.readingFocus = oneOf(next.readingFocus, ['off', 'line', 'sentence'], 'sentence');
    next.readingFocusStyle = oneOf(next.readingFocusStyle, ['soft-glow', 'edge-glow', 'paper-wash', 'underline-guide'], 'paper-wash');
    next.wordHighlightStyle = oneOf(next.wordHighlightStyle, ['edge-dissolve', 'classic-glow', 'aurora-tide', 'custom'], 'edge-dissolve');
    next.wordHighlightColor = /^#[0-9a-f]{6}$/i.test(String(next.wordHighlightColor || ''))
      ? String(next.wordHighlightColor).toLowerCase() : '#2563eb';
    next.wordHighlightGlow = clamp(next.wordHighlightGlow, 0, 100, 48);
    next.wordHighlightSpeed = clamp(next.wordHighlightSpeed, .6, 1.8, 1);
    const voicePrefix = `${next.activeProviderId}:`;
    next.opVoice = String(assignment.narratorVoiceId || '').trim();
    if (next.opVoice && !next.opVoice.startsWith(voicePrefix)) next.opVoice = '';
    next.replyVoices = unique(Array.isArray(assignment.replyVoiceIds) ? assignment.replyVoiceIds : []).filter((voice) => voice.startsWith(voicePrefix));
    next.replyVoices = next.replyVoices.filter((voice) => voice !== next.opVoice);
    next.interactionVersion = 3;
    return next;
  }

  function setControlValue(name, value) {
    const controls = Array.from(form.querySelectorAll(`[name="${name}"]`));
    controls.forEach((control) => {
      if (control.type === 'radio') control.checked = control.value === String(value);
      else if (control.type === 'checkbox') control.checked = Boolean(value);
      else control.value = String(value);
    });
  }

  function updateOutputs() {
    const glow = form.elements.wordHighlightGlow;
    const speed = form.elements.wordHighlightSpeed;
    const glowOutput = form.querySelector('[data-output="wordHighlightGlow"]');
    const speedOutput = form.querySelector('[data-output="wordHighlightSpeed"]');
    if (glowOutput && glow) glowOutput.textContent = `${Math.round(Number(glow.value) || 0)}%`;
    if (speedOutput && speed) speedOutput.textContent = `${(Number(speed.value) || 1).toFixed(1)}×`;
    const custom = form.querySelector('[name="wordHighlightStyle"]:checked');
    if (customControls) customControls.hidden = !custom || custom.value !== 'custom';
  }

  function renderVoiceOptions() {
    if (!opVoiceSelect || !replyOptions) return;
    const voicePrefix = `${settings.activeProviderId}:`;
    voiceNames = unique([settings.opVoice, ...(settings.replyVoices || []), ...voiceNames]).filter((voice) => voice.startsWith(voicePrefix));
    opVoiceSelect.replaceChildren();
    if (!voiceNames.length) {
      const automatic = document.createElement('option');
      automatic.value = '';
      automatic.textContent = settings.activeProviderId === 'browser-system' ? '浏览器默认系统音色' : '使用 Provider 默认音色';
      opVoiceSelect.append(automatic);
    }
    voiceNames.forEach((voice) => {
      const option = document.createElement('option');
      option.value = voice;
      option.textContent = voice;
      option.selected = voice === settings.opVoice;
      opVoiceSelect.append(option);
    });
    replyOptions.replaceChildren();
    voiceNames.filter((voice) => voice !== settings.opVoice).forEach((voice) => {
      const label = document.createElement('label');
      label.className = 'reply-voice-option';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.name = 'replyVoice';
      input.value = voice;
      input.checked = settings.replyVoices.includes(voice);
      const copy = document.createElement('span');
      copy.textContent = voice;
      label.append(input, copy);
      replyOptions.append(label);
    });
    if (!replyOptions.children.length) {
      const empty = document.createElement('p');
      empty.className = 'settings-empty-note';
      empty.textContent = settings.activeProviderId === 'local-service'
        ? '请先在“音色与克隆”中添加另一个音色。'
        : '未选择回复音色时，所有内容使用当前音色。';
      replyOptions.append(empty);
    }
  }

  function render() {
    if (!form) return;
    setControlValue('readingFocus', settings.readingFocus);
    setControlValue('readingFocusStyle', settings.readingFocusStyle);
    setControlValue('wordHighlightStyle', settings.wordHighlightStyle);
    setControlValue('wordHighlightColor', settings.wordHighlightColor);
    setControlValue('wordHighlightGlow', settings.wordHighlightGlow);
    setControlValue('wordHighlightSpeed', settings.wordHighlightSpeed);
    setControlValue('clickToRead', settings.clickToRead);
    setControlValue('showFloatingPlayer', settings.showFloatingPlayer);
    setControlValue('preset', settings.preset);
    renderVoiceOptions();
    const replyHelp = document.getElementById('reply-voice-help');
    if (replyHelp) replyHelp.textContent = settings.activeProviderId === 'local-service'
      ? '可为回复作者选择多个本地音色；楼主音色不会重复分配。'
      : '未选择时使用旁白音色；不同 Provider 的分配互不混用。';
    document.querySelectorAll('[data-open-voice-studio]').forEach((control) => {
      const enabled = settings.activeProviderId === 'local-service'
        && settings.providerSettings?.['local-service']?.adapterId === 'flowloud-qwen';
      control.disabled = !enabled;
      control.title = enabled ? '' : '音色克隆仅在 Flowloud Qwen 适配器下启用';
    });
    updateOutputs();
  }

  function readForm() {
    const next = Object.assign({}, settings);
    next.readingFocus = form.elements.readingFocus.value;
    next.readingFocusStyle = form.querySelector('[name="readingFocusStyle"]:checked')?.value;
    next.wordHighlightStyle = form.querySelector('[name="wordHighlightStyle"]:checked')?.value;
    next.wordHighlightColor = form.elements.wordHighlightColor.value;
    next.wordHighlightGlow = Number(form.elements.wordHighlightGlow.value);
    next.wordHighlightSpeed = Number(form.elements.wordHighlightSpeed.value);
    next.clickToRead = Boolean(form.elements.clickToRead.checked);
    next.showFloatingPlayer = Boolean(form.elements.showFloatingPlayer.checked);
    next.preset = form.elements.preset.value;
    next.opVoice = opVoiceSelect.value;
    next.replyVoices = Array.from(form.querySelectorAll('[name="replyVoice"]:checked'))
      .map((control) => control.value)
      .filter((voice) => voice !== next.opVoice);
    if (!next.replyVoices.length) {
      const fallback = voiceNames.find((voice) => voice !== next.opVoice);
      if (fallback) next.replyVoices = [fallback];
    }
    next.voiceAssignmentsByProvider = Object.assign({}, next.voiceAssignmentsByProvider || {}, {
      [next.activeProviderId]: {
        narratorVoiceId: next.opVoice,
        replyVoiceIds: next.replyVoices.slice(),
        authorVoices: Object.assign({}, next.voiceAssignmentsByProvider?.[next.activeProviderId]?.authorVoices || {}),
      },
    });
    return normalize(next);
  }

  async function save() {
    const revision = ++saveRevision;
    settings = readForm();
    settings.voiceAssignmentsByProvider = Object.assign({}, settings.voiceAssignmentsByProvider || {}, {
      [settings.activeProviderId]: {
        narratorVoiceId: settings.opVoice,
        replyVoiceIds: settings.replyVoices.slice(),
        authorVoices: Object.assign({}, settings.voiceAssignmentsByProvider?.[settings.activeProviderId]?.authorVoices || {}),
      },
    });
    settings.providerVoices = Object.assign({}, settings.providerVoices || {}, { [settings.activeProviderId]: settings.opVoice });
    render();
    if (saveStatus) saveStatus.textContent = '正在保存…';
    try {
      if (!chrome.runtime?.sendMessage) await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
      const response = await chrome.runtime.sendMessage({ type: 'settings:set', settings });
      if (!response?.ok) throw new Error(response?.error?.message || '保存失败');
      settings = normalize(response.settings);
      if (revision === saveRevision && saveStatus) saveStatus.textContent = '已自动保存';
    } catch (error) {
      if (revision === saveRevision && saveStatus) saveStatus.textContent = '保存失败，请重试';
    }
  }

  function scheduleSave(immediate) {
    clearTimeout(saveTimer);
    if (saveStatus) saveStatus.textContent = '有更改待保存';
    saveTimer = setTimeout(() => { void save(); }, immediate ? 0 : 180);
  }

  function setSection(section, updateHash) {
    const target = ['voices', 'engine', 'storage'].includes(section) ? section : 'reader';
    document.querySelectorAll('[data-settings-pane]').forEach((pane) => {
      pane.hidden = pane.dataset.settingsPane !== target;
    });
    document.querySelectorAll('[data-settings-section]').forEach((button) => {
      const active = button.dataset.settingsSection === target;
      button.classList.toggle('is-active', active);
      if (active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    const sectionSelect = document.getElementById('settings-section-select');
    if (sectionSelect) sectionSelect.value = target;
    if (updateHash && location.hash !== `#${target}`) history.replaceState(null, '', `#${target}`);
    document.title = target === 'voices' ? 'Flowloud · 音色与克隆' : target === 'engine' ? 'Flowloud · 朗读引擎' : target === 'storage' ? 'Flowloud · 存储与数据' : 'Flowloud / 流声设置';
  }

  async function loadVoices() {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'voice:list', providerId: settings.activeProviderId });
      if (response && response.ok) {
        voiceNames = unique((response.voices || []).map((voice) => typeof voice === 'string' ? voice : (voice.id || voice.voiceId || voice.name)));
        if (!settings.opVoice && voiceNames.length) settings.opVoice = voiceNames[0];
      }
    } catch (_) {
      voiceNames = [];
    }
    renderVoiceOptions();
  }

  async function initialize() {
    if (!form) return;
    try {
      const saved = await chrome.runtime.sendMessage({ type: 'settings:get' });
      settings = normalize(saved && saved.settings);
    } catch (_) {
      settings = normalize({});
    }
    render();
    await loadVoices();
    if (saveStatus) saveStatus.textContent = '已同步';
    setSection(location.hash.slice(1), false);
  }

  document.querySelectorAll('[data-settings-section]').forEach((button) => {
    button.addEventListener('click', () => setSection(button.dataset.settingsSection, true));
  });
  document.getElementById('settings-section-select')?.addEventListener('change', (event) => setSection(event.target.value, true));
  document.querySelectorAll('[data-open-voice-studio]').forEach((button) => {
    button.addEventListener('click', () => setSection('voices', true));
  });
  document.getElementById('reset-reader-settings')?.addEventListener('click', () => {
    const preserved = Object.fromEntries(Object.entries(settings).filter(([key]) => !settingKeys.includes(key)));
    settings = normalize(Object.assign(preserved, Object.fromEntries(settingKeys.map((key) => [key, defaults[key]]))));
    render();
    scheduleSave(true);
  });
  form?.addEventListener('input', (event) => {
    updateOutputs();
    scheduleSave(event.target.type !== 'range');
  });
  form?.addEventListener('change', (event) => {
    if (event.target === opVoiceSelect) {
      settings.opVoice = opVoiceSelect.value;
      settings.replyVoices = settings.replyVoices.filter((voice) => voice !== settings.opVoice);
      renderVoiceOptions();
    }
    updateOutputs();
    scheduleSave(true);
  });
  window.addEventListener('hashchange', () => setSection(location.hash.slice(1), false));
  chrome.storage.onChanged?.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (changes.voiceProfiles) void loadVoices();
    if (changes[SETTINGS_KEY] && changes[SETTINGS_KEY].newValue) {
      const previousProvider = settings.activeProviderId;
      settings = normalize(changes[SETTINGS_KEY].newValue);
      render();
      if (previousProvider !== settings.activeProviderId) void loadVoices();
    }
  });

  void initialize();
})();
