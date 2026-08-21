(function attachFollowController(global) {
  'use strict';

  const PAGING_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);
  const EDITABLE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'OPTION']);

  function createController() {
    let mode = 'following';
    return {
      get mode() { return mode; },
      markManual() { mode = 'manual'; },
      resume() { mode = 'following'; },
      reset() { mode = 'following'; },
      canFollow() { return mode === 'following'; }
    };
  }

  function eventPath(event) {
    return event && typeof event.composedPath === 'function' ? event.composedPath() : [];
  }

  function isEditable(target) {
    if (!target) return false;
    if (target.isContentEditable || target.contentEditable === 'true') return true;
    if (EDITABLE_TAGS.has(String(target.tagName || '').toUpperCase())) return true;
    return typeof target.closest === 'function'
      && Boolean(target.closest('input,textarea,select,option,[contenteditable=""],[contenteditable="true"]'));
  }

  function isScrollIntent(event, context) {
    const path = eventPath(event);
    if (context && context.host && path.includes(context.host)) return false;
    if (isEditable(event && event.target)) return false;

    if (event && (event.type === 'wheel' || event.type === 'touchmove')) return true;
    if (event && event.type === 'keydown') return PAGING_KEYS.has(event.key);
    if (event && event.type === 'pointerdown') {
      const threshold = Number.isFinite(context && context.scrollbarThreshold)
        ? context.scrollbarThreshold
        : 24;
      return Number.isFinite(event.clientX)
        && Number.isFinite(context && context.viewportWidth)
        && event.clientX >= context.viewportWidth - threshold;
    }
    return false;
  }

  function isWithinSafeViewport(rect, viewportHeight) {
    if (!rect || !Number.isFinite(viewportHeight)) return false;
    return rect.bottom >= viewportHeight * 0.15 && rect.top <= viewportHeight * 0.85;
  }

  global.QwenReaderFollow = Object.freeze({
    createController,
    isScrollIntent,
    isWithinSafeViewport
  });
})(globalThis);
