(function attachSentenceRange(global) {
  'use strict';

  const ELEMENT_NODE = 1;
  const TEXT_NODE = 3;
  const DOCUMENT_NODE = 9;
  const DOCUMENT_FRAGMENT_NODE = 11;

  const IGNORED_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE',
    'BUTTON', 'FORM', 'INPUT', 'TEXTAREA', 'SELECT', 'OPTION',
    'OPTGROUP', 'DATALIST', 'FIELDSET', 'LEGEND', 'LABEL',
    'IFRAME', 'OBJECT', 'EMBED', 'CANVAS', 'SVG'
  ]);

  const BLOCK_TAGS = new Set([
    'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DETAILS',
    'DIALOG', 'DIV', 'DL', 'DT', 'FIGCAPTION', 'FIGURE', 'FOOTER',
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HGROUP', 'HR',
    'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'SUMMARY',
    'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL'
  ]);

  const ZERO_WIDTH_RE = /[\u200B-\u200D\u2060\uFEFF]/;
  const WHITESPACE_RE = /[\s\u00A0]/;
  const URL_RE = /(?:https?:\/\/|www\.)[^\s<>()\[\]{}]+/giu;

  function tagNameOf(node) {
    return String(node && (node.tagName || node.nodeName) || '').toUpperCase();
  }

  function safeAttribute(node, name) {
    if (!node || typeof node.getAttribute !== 'function') return null;
    try {
      return node.getAttribute(name);
    } catch (_) {
      return null;
    }
  }

  function isIgnoredElement(node, options) {
    if (!node || Number(node.nodeType) !== ELEMENT_NODE) return false;
    if (options && typeof options.ignoreNode === 'function') {
      try {
        if (options.ignoreNode(node)) return true;
      } catch (_) {}
    }

    if (IGNORED_TAGS.has(tagNameOf(node))) return true;
    if (node.hidden === true || node.inert === true) return true;
    return String(safeAttribute(node, 'aria-hidden') || '').toLowerCase() === 'true';
  }

  function boundary(node, offset) {
    return { node, offset };
  }

  function nodeText(node) {
    if (!node) return '';
    if (typeof node.nodeValue === 'string') return node.nodeValue;
    if (typeof node.data === 'string') return node.data;
    return typeof node.textContent === 'string' ? node.textContent : '';
  }

  function childNodesOf(node) {
    const children = node && node.childNodes;
    if (!children) return [];
    try {
      return Array.from(children);
    } catch (_) {
      return [];
    }
  }

  function isNodeLike(value) {
    return Boolean(value) && (
      Number.isFinite(Number(value.nodeType))
      || typeof value.nodeValue === 'string'
      || Boolean(value.childNodes)
    );
  }

  function rootsOf(source) {
    if (!source) return [];
    if (isNodeLike(source)) return [source];
    if (typeof source === 'string') return [];
    if (typeof source[Symbol.iterator] === 'function') {
      try {
        return Array.from(source).filter(Boolean);
      } catch (_) {
        return [];
      }
    }
    if (Number.isFinite(Number(source.length))) {
      try {
        return Array.from(source).filter(Boolean);
      } catch (_) {
        return [];
      }
    }
    return [];
  }

  function collectTokens(source, options) {
    const tokens = [];
    let lastBoundary = null;

    function pushBreak() {
      tokens.push({ char: ' ', start: lastBoundary, end: null, synthetic: true });
    }

    function pushText(node) {
      const text = nodeText(node);
      for (let offset = 0; offset < text.length; offset += 1) {
        const start = boundary(node, offset);
        const end = boundary(node, offset + 1);
        tokens.push({ char: text[offset], start, end, synthetic: false });
        lastBoundary = end;
      }
    }

    function visit(node) {
      if (!node) return;
      const type = Number(node.nodeType);
      if (type === TEXT_NODE || (!Number.isFinite(type) && typeof node.nodeValue === 'string')) {
        pushText(node);
        return;
      }
      if (type !== ELEMENT_NODE && type !== DOCUMENT_NODE && type !== DOCUMENT_FRAGMENT_NODE
        && Number.isFinite(type)) return;

      if (type === ELEMENT_NODE && isIgnoredElement(node, options)) {
        // A separator prevents readable words on either side of a removed control
        // from being joined into a different word.
        pushBreak();
        return;
      }

      const tag = tagNameOf(node);
      if (tag === 'BR' || tag === 'WBR') {
        pushBreak();
        return;
      }

      const isBlock = BLOCK_TAGS.has(tag);
      if (isBlock) pushBreak();
      for (const child of childNodesOf(node)) visit(child);
      if (isBlock) pushBreak();
    }

    for (const root of rootsOf(source)) visit(root);
    return tokens;
  }

  function isZeroWidth(char) {
    return ZERO_WIDTH_RE.test(char);
  }

  function isWhitespace(char) {
    return WHITESPACE_RE.test(char);
  }

  function firstMappedBoundary(tokens, start, end, key) {
    for (let index = start; index < end; index += 1) {
      if (tokens[index][key] && tokens[index][key].node) return tokens[index][key];
    }
    return null;
  }

  function lastMappedBoundary(tokens, start, end, key) {
    for (let index = end - 1; index >= start; index -= 1) {
      if (tokens[index][key] && tokens[index][key].node) return tokens[index][key];
    }
    return null;
  }

  function normalizeTokens(tokens) {
    const output = [];
    const charMap = [];

    for (let index = 0; index < tokens.length;) {
      const token = tokens[index];
      if (isZeroWidth(token.char)) {
        index += 1;
        continue;
      }

      if (isWhitespace(token.char)) {
        const runStart = index;
        while (index < tokens.length
          && (isWhitespace(tokens[index].char) || isZeroWidth(tokens[index].char))) index += 1;

        let next = index;
        while (next < tokens.length && isZeroWidth(tokens[next].char)) next += 1;
        if (!output.length || next >= tokens.length) continue;

        const previousEnd = charMap[charMap.length - 1] && charMap[charMap.length - 1].end;
        const nextStart = tokens[next] && tokens[next].start;
        const mappedStart = firstMappedBoundary(tokens, runStart, index, 'start')
          || previousEnd
          || nextStart;
        const mappedEnd = lastMappedBoundary(tokens, runStart, index, 'end')
          || nextStart
          || mappedStart;

        output.push(' ');
        charMap.push({ start: mappedStart, end: mappedEnd });
        continue;
      }

      output.push(token.char);
      charMap.push({ start: token.start, end: token.end });
      index += 1;
    }

    return stripUrls(output.join(''), charMap);
  }

  function stripUrls(text, charMap) {
    URL_RE.lastIndex = 0;
    const mask = new Uint8Array(text.length);
    let match;
    while ((match = URL_RE.exec(text))) {
      for (let index = match.index; index < match.index + match[0].length; index += 1) mask[index] = 1;
    }
    if (!mask.some(Boolean)) return { text, charMap };

    const output = [];
    const outputMap = [];
    for (let index = 0; index < text.length;) {
      if (mask[index] || isWhitespace(text[index])) {
        const runStart = index;
        while (index < text.length && (mask[index] || isWhitespace(text[index]))) index += 1;
        if (!output.length || index >= text.length) continue;
        const first = charMap[runStart] || outputMap[outputMap.length - 1];
        const last = charMap[index - 1] || first;
        output.push(' ');
        outputMap.push({ start: first.start, end: last.end });
        continue;
      }
      output.push(text[index]);
      outputMap.push(charMap[index]);
      index += 1;
    }
    return { text: output.join(''), charMap: outputMap };
  }

  function normalizeText(value) {
    return String(value == null ? '' : value)
      .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
      .replace(/[\s\u00A0]+/g, ' ')
      .trim();
  }

  function buildTextIndex(source, options) {
    const normalized = normalizeTokens(collectTokens(source, options));
    return {
      text: normalized.text,
      normalizedText: normalized.text,
      charMap: normalized.charMap,
      length: normalized.text.length
    };
  }

  function isTextIndex(value) {
    return Boolean(value)
      && typeof value.normalizedText === 'string'
      && Array.isArray(value.charMap);
  }

  function ensureTextIndex(source, options) {
    return isTextIndex(source) ? source : buildTextIndex(source, options);
  }

  function numericOffset(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0;
  }

  function findSegment(source, segmentText, precedingNormalizedOffset, options) {
    const index = ensureTextIndex(source, options);
    const needle = normalizeText(segmentText);
    if (!needle || !index.normalizedText || !index.charMap.length) return null;

    const searchFrom = Math.min(index.normalizedText.length, numericOffset(precedingNormalizedOffset));
    const normalizedStart = index.normalizedText.indexOf(needle, searchFrom);
    if (normalizedStart < 0) return null;

    const normalizedEnd = normalizedStart + needle.length;
    const first = index.charMap[normalizedStart];
    const last = index.charMap[normalizedEnd - 1];
    if (!first || !last || !first.start || !last.end) return null;

    return {
      start: { node: first.start.node, offset: first.start.offset },
      end: { node: last.end.node, offset: last.end.offset },
      startContainer: first.start.node,
      startOffset: first.start.offset,
      endContainer: last.end.node,
      endOffset: last.end.offset,
      normalizedStart,
      normalizedEnd,
      nextOffset: normalizedEnd,
      text: needle
    };
  }

  function findSegments(source, segmentTexts, precedingNormalizedOffset, options) {
    const index = ensureTextIndex(source, options);
    let cursor = numericOffset(precedingNormalizedOffset);
    return Array.from(segmentTexts || [], (segmentText) => {
      const match = findSegment(index, segmentText, cursor);
      if (match) cursor = match.nextOffset;
      return match;
    });
  }

  function finiteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function normalizedRect(rect) {
    if (!rect) return null;
    let left = finiteNumber(rect.left);
    let top = finiteNumber(rect.top);
    let right = finiteNumber(rect.right);
    let bottom = finiteNumber(rect.bottom);
    const width = finiteNumber(rect.width);
    const height = finiteNumber(rect.height);
    if (left === null || top === null) return null;
    if (right === null && width !== null) right = left + width;
    if (bottom === null && height !== null) bottom = top + height;
    if (right === null || bottom === null) return null;
    if (right < left) [left, right] = [right, left];
    if (bottom < top) [top, bottom] = [bottom, top];
    return { left, top, right, bottom };
  }

  function isRectLike(value) {
    return Boolean(value)
      && finiteNumber(value.left) !== null
      && finiteNumber(value.top) !== null
      && (finiteNumber(value.right) !== null || finiteNumber(value.width) !== null)
      && (finiteNumber(value.bottom) !== null || finiteNumber(value.height) !== null);
  }

  function rectListOf(entry) {
    if (!entry) return [];
    if (isRectLike(entry)) return [entry];
    const value = entry.rects || entry.clientRects || entry.rect || entry;
    if (isRectLike(value)) return [value];
    if (typeof value === 'string') return [];
    try {
      return Array.from(value || []).filter(isRectLike);
    } catch (_) {
      return [];
    }
  }

  function pointDistance(rect, x, y) {
    const dx = x < rect.left ? rect.left - x : x > rect.right ? x - rect.right : 0;
    const dy = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
    return Math.hypot(dx, dy);
  }

  function pickSegmentIndexAtPoint(segmentRects, xValue, yValue, options) {
    const x = finiteNumber(xValue);
    const y = finiteNumber(yValue);
    if (x === null || y === null) return -1;

    const settings = typeof options === 'number' ? { maxDistance: options } : (options || {});
    const configuredDistance = finiteNumber(settings.maxDistance);
    const maxDistance = configuredDistance === null ? 8 : Math.max(0, configuredDistance);
    let best = null;

    let groups;
    try {
      groups = Array.from(segmentRects || []);
    } catch (_) {
      return -1;
    }

    groups.forEach((entry, groupIndex) => {
      const explicitIndex = finiteNumber(entry && (entry.segmentIndex != null ? entry.segmentIndex : entry.index));
      const segmentIndex = explicitIndex === null ? groupIndex : Math.floor(explicitIndex);
      for (const rawRect of rectListOf(entry)) {
        const rect = normalizedRect(rawRect);
        if (!rect) continue;
        const distance = pointDistance(rect, x, y);
        if (distance > maxDistance) continue;
        const centerX = (rect.left + rect.right) / 2;
        const centerY = (rect.top + rect.bottom) / 2;
        const centerDistance = Math.hypot(x - centerX, y - centerY);
        const area = Math.max(0, rect.right - rect.left) * Math.max(0, rect.bottom - rect.top);
        const candidate = { segmentIndex, distance, centerDistance, area, order: groupIndex };
        if (!best
          || candidate.distance < best.distance
          || (candidate.distance === best.distance && candidate.centerDistance < best.centerDistance)
          || (candidate.distance === best.distance && candidate.centerDistance === best.centerDistance
            && candidate.area < best.area)
          || (candidate.distance === best.distance && candidate.centerDistance === best.centerDistance
            && candidate.area === best.area && candidate.order < best.order)) best = candidate;
      }
    });

    return best ? best.segmentIndex : -1;
  }

  global.QwenReaderSentenceRange = Object.freeze({
    normalizeText,
    isIgnoredElement,
    buildTextIndex,
    findSegment,
    findSegments,
    pickSegmentIndexAtPoint,
    segmentIndexAtPoint: pickSegmentIndexAtPoint
  });
})(globalThis);
