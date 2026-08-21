(function voiceNamingModule(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.QwenReaderVoiceNaming = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function makeVoiceNaming() {
  'use strict';

  function sanitizeName(value) {
    const cleaned = String(value || '')
      .normalize('NFC')
      .replace(/[\u0000-\u001f\u007f]/gu, '')
      .replace(/[\\/:*?"<>|]/gu, ' ')
      .replace(/\s+/gu, ' ')
      .replace(/^[.\s]+|[.\s]+$/gu, '');
    return cleaned || '未命名音色';
  }

  function fileStem(fileName) {
    const value = String(fileName || '');
    const boundary = value.lastIndexOf('.');
    return boundary > 0 ? value.slice(0, boundary) : value;
  }

  function allocateUniqueName(preferred, occupiedNames) {
    const base = sanitizeName(preferred);
    const occupied = new Set(Array.from(occupiedNames || [], sanitizeName));
    if (!occupied.has(base)) return base;
    for (let index = 2; ; index += 1) {
      const candidate = `${base} (${index})`;
      if (!occupied.has(candidate)) return candidate;
    }
  }

  return Object.freeze({ sanitizeName, fileStem, allocateUniqueName });
}));
