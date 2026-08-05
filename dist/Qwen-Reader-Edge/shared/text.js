(function attachTextHelpers(global) {
  'use strict';

  const URL_PATTERN = /(?:https?:\/\/|www\.)[^\s<>()\[\]{}]+/giu;
  const BREAK_CHARACTERS = new Set(['。', '！', '？', '；']);

  function cleanText(value) {
    return String(value == null ? '' : value)
      .replace(URL_PATTERN, ' ')
      .replace(/[\t\r\n\f\v\u00a0\u3000]+/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim();
  }

  function makeSegment(input) {
    const source = input || {};
    return {
      id: source.id == null ? '' : String(source.id),
      floor: Number.isFinite(source.floor) ? source.floor : 0,
      authorId: source.authorId == null ? '' : String(source.authorId),
      authorName: source.authorName == null ? '' : String(source.authorName),
      isOp: Boolean(source.isOp),
      text: cleanText(source.text),
      sourceKey: source.sourceKey == null ? '' : String(source.sourceKey)
    };
  }

  function splitText(value, maxChars) {
    const text = String(value == null ? '' : value)
      .replace(URL_PATTERN, ' ')
      .replace(/\r\n?/gu, '\n')
      .replace(/[\t\f\v\u00a0\u3000]+/gu, ' ')
      .replace(/[ ]+/gu, ' ')
      .replace(/ *\n */gu, '\n')
      .trim();
    const limit = Number.isInteger(maxChars) && maxChars > 0 ? maxChars : 260;
    if (!text) return [];

    const chunks = [];
    let current = '';

    function pushCurrent() {
      const chunk = current.trim();
      if (chunk) chunks.push(chunk);
      current = '';
    }

    for (const character of text) {
      if (character === '\n') {
        pushCurrent();
        continue;
      }
      if (current.length === limit) pushCurrent();
      current += character;
      if (BREAK_CHARACTERS.has(character) && current.length <= limit) {
        pushCurrent();
      }
    }
    pushCurrent();
    return chunks;
  }

  global.QwenReaderText = { cleanText, splitText, makeSegment };
})(globalThis);
