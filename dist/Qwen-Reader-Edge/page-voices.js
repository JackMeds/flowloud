(function pageVoicesController() {
  'use strict';
  const root = document.getElementById('page-voices-root');
  const api = globalThis.chrome;
  const query = new URLSearchParams(location.search);
  const contextId = String(query.get('contextId') || '');
  let context = null;

  function request(type, payload) {
    return api.runtime.sendMessage(Object.assign({ type }, payload || {}));
  }

  function render(model) {
    globalThis.QwenPopupView.mountPageVoices(root, model || { title: '本页配音', authors: [], voices: [] });
  }

  async function load() {
    try {
      if (!contextId) throw new Error('页面编辑上下文已失效，请从扩展弹窗重新打开。');
      context = await request('reader:page-context:get', { contextId });
      if (context && context.ok === false) throw new Error(context.error && context.error.message || '无法读取本页配音。');
      render(context);
    } catch (error) {
      render({ title: error && error.message || '无法读取本页配音', authors: [], voices: [] });
    }
  }

  root.addEventListener('qwen-popup-command', async (event) => {
    const detail = event.detail || {};
    if (detail.action === 'cancel-page-voices') return window.close();
    if (detail.action !== 'save-page-voices') return;
    const assignments = Array.from(root.querySelectorAll('[data-author-id]'))
      .filter((select) => Boolean(select.value))
      .map((select) => ({ authorId: select.dataset.authorId, voice: select.value }));
    try {
      const response = await request('reader:page-context:apply', {
        contextId,
        pageKey: context && context.pageKey,
        assignments
      });
      if (response && response.ok === false) throw new Error(response.error && response.error.message || '保存失败。');
      window.close();
    } catch (error) {
      render(Object.assign({}, context, { error: error && error.message || '保存失败，请重试。' }));
    }
  });
  void load();
})();
