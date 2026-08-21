(function installPageGuide() {
  'use strict';
  const guide = globalThis.FlowloudSemanticGuide;
  let current = null;
  function snapshot(filter) { current = guide.buildSnapshot(document, { filter }); return { title: current.title, url: current.url, nodes: current.nodes }; }
  function focus(id) {
    if (!current) snapshot('all'); const element = current.elements.get(String(id));
    if (!element) return { ok: false, error: { code: 'guide_item_missing', message: '导览项目已失效，请刷新大纲。' } };
    element.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
    element.classList.add('flowloud-guide-current'); setTimeout(() => element.classList.remove('flowloud-guide-current'), 2400);
    return { ok: true };
  }
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'flowloud:guide:snapshot') { sendResponse({ ok: true, snapshot: snapshot(message.filter) }); return false; }
    if (message?.type === 'flowloud:guide:focus') { sendResponse(focus(message.id)); return false; }
    return undefined;
  });
}());
