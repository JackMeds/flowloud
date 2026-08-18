(function popupController() {
  'use strict';
  const root = document.getElementById('popup-root');
  const api = globalThis.chrome;
  let context = null;
  let snapshot = null;
  let view = 'reader';
  let pageContext = null;

  function request(type, payload) {
    return api.runtime.sendMessage(Object.assign({ type }, payload || {}));
  }

  function render(message) {
    if (view === 'page-voices') {
      globalThis.QwenPopupView.mountPageVoices(root, Object.assign({}, pageContext || {}, {
        compact: true,
        error: message || ''
      }));
      return;
    }
    if (!context || !context.tabId) {
      globalThis.QwenPopupView.mountPopup(root, { empty: true, message: message || '正在读取当前网页…' });
      return;
    }
    globalThis.QwenPopupView.mountPopup(root, Object.assign({}, context || {}, { snapshot, message }));
  }

  async function refresh() {
    try {
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
})();
