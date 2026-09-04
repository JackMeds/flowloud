(function installFlowloudFlarumViewportBridge() {
  'use strict';

  if (window.__flowloudFlarumViewportBridge) return;
  window.__flowloudFlarumViewportBridge = true;
  window.addEventListener('message', (event) => {
    const data = event && event.data;
    if (event.source !== window || !data || data.__flowloudFlarum !== true || data.type !== 'ensure-visible') return;
    const requestId = String(data.requestId || '');
    const floor = Number(data.floor);
    if (!requestId || !Number.isFinite(floor) || floor <= 0) return;
    const stream = globalThis.app?.current?.get?.('stream');
    if (!stream || typeof stream.goToNumber !== 'function') {
      window.postMessage({ __flowloudFlarum: true, requestId, ok: false, reason: 'stream-unavailable' }, '*');
      return;
    }
    try {
      const result = stream.goToNumber(floor);
      Promise.resolve(result).then(() => {
        window.postMessage({ __flowloudFlarum: true, requestId, ok: true, floor }, '*');
      }, () => {
        window.postMessage({ __flowloudFlarum: true, requestId, ok: false, floor }, '*');
      });
    } catch (_) {
      window.postMessage({ __flowloudFlarum: true, requestId, ok: false, floor }, '*');
    }
  });
}());
