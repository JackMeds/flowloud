(function popupController() {
  'use strict';
  const root = document.getElementById('popup-root');
  const api = globalThis.chrome;
  const SETTINGS_KEY = 'qwenReaderSettings';
  const defaults = globalThis.QwenReaderDefaults || {};
  const settingsSchema = globalThis.FlowloudSettings;
  let context = null;
  let snapshot = null;
  let view = 'reader';
  let pageContext = null;
  let quickSettings = normalizeQuickSettings(null);
  let lastRenderSignature = '';

  function normalizeQuickSettings(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const preset = ['op-exclusive', 'stable-author', 'round-robin'].includes(source.preset || source.voiceMode)
      ? source.preset || source.voiceMode
      : defaults.voiceMode || 'op-exclusive';
    return {
      clickToRead: Number(source.interactionVersion || 0) >= 3 && source.clickToRead === true,
      showFloatingPlayer: source.showFloatingPlayer !== false,
      preset,
      interactionVersion: 3,
      activeProviderId: source.activeProviderId || source.providerId || 'browser-system',
      playbackRate: settingsSchema ? settingsSchema.rate(source.playbackRate) : Number(source.playbackRate) || 1,
      readingMode: source.readingMode === 'guide' ? 'guide' : 'content'
    };
  }

  async function loadQuickSettings() {
    const saved = await api.storage.local.get(SETTINGS_KEY);
    quickSettings = normalizeQuickSettings(saved && saved[SETTINGS_KEY]);
  }

  async function saveQuickSetting(setting, value) {
    if (!['clickToRead', 'showFloatingPlayer', 'preset', 'activeProviderId', 'playbackRate', 'readingMode'].includes(setting)) return;
    const saved = await api.storage.local.get(SETTINGS_KEY);
    const current = settingsSchema
      ? settingsSchema.migrate(saved && saved[SETTINGS_KEY])
      : Object.assign({}, defaults, saved && saved[SETTINGS_KEY] || {});
    if (setting === 'clickToRead') current.clickToRead = value === true;
    if (setting === 'showFloatingPlayer') current.showFloatingPlayer = value !== false;
    if (setting === 'preset') {
      if (!['op-exclusive', 'stable-author', 'round-robin'].includes(value)) return;
      current.preset = value;
    }
    if (setting === 'activeProviderId' && ['browser-system', 'browser-model', 'local-qwen', 'openai-compatible'].includes(value)) {
      if (value === 'local-qwen') {
        const granted = await api.permissions.request({ origins: ['http://127.0.0.1:7811/*'] });
        if (!granted) throw new Error('未授予本地 Qwen 连接权限。');
      }
      current.activeProviderId = value;
      current.providerId = value;
      current.providerVersion = 3;
    }
    if (setting === 'playbackRate') current.playbackRate = settingsSchema ? settingsSchema.rate(value) : Number(value) || 1;
    if (setting === 'readingMode') current.readingMode = value === 'guide' ? 'guide' : 'content';
    current.schemaVersion = 4;
    current.interactionVersion = 3;
    const persisted = settingsSchema ? settingsSchema.publicSettings(current) : current;
    await api.storage.local.set({ [SETTINGS_KEY]: persisted });
    quickSettings = normalizeQuickSettings(persisted);
  }

  function request(type, payload) {
    return api.runtime.sendMessage(Object.assign({ type }, payload || {}));
  }

  function render(message) {
    const signature = JSON.stringify({
      view,
      message: message || '',
      tabId: context && context.tabId || null,
      title: context && context.title || '',
      settings: quickSettings,
      snapshot: snapshot ? {
        pageKey: snapshot.pageKey,
        status: snapshot.status,
        index: snapshot.index,
        total: snapshot.segmentCount || snapshot.total,
        error: snapshot.error,
        current: snapshot.current
      } : null,
      pageContext: view === 'page-voices' ? pageContext : null
    });
    if (signature === lastRenderSignature) return;
    lastRenderSignature = signature;
    if (view === 'page-voices') {
      globalThis.QwenPopupView.mountPageVoices(root, Object.assign({}, pageContext || {}, {
        compact: true,
        error: message || ''
      }));
      return;
    }
    if (!context || !context.tabId) {
      globalThis.QwenPopupView.mountPopup(root, { empty: true, settings: quickSettings, message: message || '正在读取当前网页…' });
      return;
    }
    globalThis.QwenPopupView.mountPopup(root, Object.assign({}, context || {}, { snapshot, settings: quickSettings, message }));
  }

  async function refresh() {
    try {
      await loadQuickSettings();
      context = await request('reader:active-context');
      if (!context || !context.tabId) return render('当前标签页不支持朗读。');
      snapshot = await request('reader:snapshot:get', { tabId: context.tabId });
      render();
    } catch (error) {
      render(error && error.message || '无法连接到当前网页。');
    }
  }

  root.addEventListener('qwen-popup-command', async (event) => {
    const detail = event.detail || {};
    try {
      if (detail.action === 'setting-change') {
        await saveQuickSetting(detail.setting, detail.value);
        render();
        return;
      }
      if (detail.action === 'open-page-editor') {
        const response = await request('reader:page-voices:get', {
          tabId: context && context.tabId,
          pageKey: snapshot && snapshot.pageKey || context && context.pageKey
        });
        if (response && response.ok === false) throw new Error(response.error && response.error.message || '无法读取本页配音。');
        pageContext = response && response.pageContext || response;
        view = 'page-voices';
        render();
        return;
      }
      if (detail.action === 'cancel-page-voices') {
        view = 'reader';
        pageContext = null;
        render();
        return;
      }
      if (detail.action === 'save-page-voices') {
        const assignments = Array.from(root.querySelectorAll('[data-author-id]'))
          .filter((select) => Boolean(select.value))
          .map((select) => ({ authorId: select.dataset.authorId, voice: select.value }));
        const response = await request('reader:page-voices:apply', {
          tabId: context && context.tabId,
          pageKey: pageContext && pageContext.pageKey || snapshot && snapshot.pageKey || context && context.pageKey,
          assignments
        });
        if (response && response.ok === false) {
          pageContext = response.pageContext || pageContext;
          render(response.error && response.error.message || '本页配音没有保存，请重试。');
          return;
        }
        pageContext = null;
        view = 'reader';
        snapshot = await request('reader:snapshot:get', { tabId: context && context.tabId });
        render('本页配音已更新。');
        return;
      }
      if (detail.action === 'open-options') {
        await api.runtime.openOptionsPage();
        return;
      }
      if (detail.action === 'open-guide') {
        const response = await request('guide:open', { tabId: context && context.tabId });
        if (!response || response.ok === false) throw new Error(response?.error?.message || '无法打开页面导览。');
        window.close();
        return;
      }
      if (detail.action === 'reader:command') {
        const response = await request('reader:command', {
          tabId: context && context.tabId,
          pageKey: snapshot && snapshot.pageKey || context && context.pageKey,
          command: detail.command,
          value: detail.value
        });
        if (response && response.ok === false) {
          snapshot = response.snapshot || snapshot;
          render(response.error && response.error.message || '操作未完成，请重试。');
          return;
        }
        snapshot = response && response.snapshot || response || snapshot;
        render();
      }
    } catch (error) {
      render(error && error.message || '操作未完成，请重试。');
    }
  });
  render();
  void refresh();
  const poller = window.setInterval(async () => {
    if (!context || !context.tabId) return;
    try {
      snapshot = await request('reader:snapshot:get', { tabId: context.tabId });
      if (view === 'reader') render();
    } catch (_) {
      // A transient background restart should not replace a usable Popup with
      // an error while the user is interacting with it.
    }
  }, 900);
  window.addEventListener('unload', () => window.clearInterval(poller), { once: true });
  api.storage.onChanged?.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes[SETTINGS_KEY]) return;
    quickSettings = normalizeQuickSettings(changes[SETTINGS_KEY].newValue);
    if (view === 'reader') render();
  });
})();
