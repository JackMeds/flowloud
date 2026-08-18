(function popupController() {
  'use strict';
  const root = document.getElementById('popup-root');
  const api = globalThis.chrome;
  let context = null;
  let snapshot = null;

  function request(type, payload) {
    return api.runtime.sendMessage(Object.assign({ type }, payload || {}));
  }

  function render(message) {
    if (!context && !snapshot) {
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
        await request('reader:page-editor:open', { tabId: context && context.tabId, pageKey: context && context.pageKey });
        return;
      }
      if (detail.action === 'open-options') {
        await api.runtime.openOptionsPage();
        return;
      }
      if (detail.action === 'reader:command') {
        snapshot = await request('reader:command', {
          tabId: context && context.tabId,
          pageKey: snapshot && snapshot.pageKey || context && context.pageKey,
          command: detail.command,
          value: detail.value
        });
        render();
      }
    } catch (error) {
      render(error && error.message || '操作未完成，请重试。');
    }
  });
  render();
  void refresh();
})();
