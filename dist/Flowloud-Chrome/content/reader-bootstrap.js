(function restoreAuthorizedReader() {
  'use strict';
  if (globalThis.__flowloudReaderRestoreRequested) return;
  globalThis.__flowloudReaderRestoreRequested = true;
  try {
    const result = chrome.runtime.sendMessage({ type: 'reader:auto-restore' });
    if (result && typeof result.catch === 'function') result.catch(() => {});
  } catch (_) {
    // The full reader remains available through the toolbar injection fallback.
  }
}());
