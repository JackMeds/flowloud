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
  const IGNORED_BLOCK_TAGS = new Set([
    'FORM', 'FIELDSET', 'IFRAME', 'OBJECT', 'EMBED', 'CANVAS'
  ]);

  const ZERO_WIDTH_RE = /[\u200B-\u200D\u2060\uFEFF]/;
  const WHITESPACE_RE = /[\s\u00A0]/;
  const URL_RE = /(?:https?:\/\/|www\.)[^\s<>()\[\]{}]+/giu;
  const EMOJI_IMAGE_CLASS_RE = /(?:^|\s)(?:emoji|emojione|twemoji)(?:\s|$)/iu;
  const EMOJI_ALT_RE = (() => {
    try {
      return new RegExp(
        '^(?:(?:\\p{Extended_Pictographic}|\\p{Regional_Indicator}|[#*0-9]\\uFE0F?\\u20E3)(?:\\p{Emoji_Modifier}|[\\u200D\\uFE0E\\uFE0F\\u20E3]|[\\u{E0020}-\\u{E007F}])*)+$',
        'u'
      );
    } catch (_) {
      return /^(?:[\u00a9\u00ae\u203c-\u3299]|[\ud83c-\udbff][\udc00-\udfff]|[\u200d\ufe0e\ufe0f\u20e3])+$/u;
    }
  })();

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

  function inlineEmojiText(node) {
    const shared = global.QwenReaderForumContent;
    if (shared && typeof shared.inlineEmojiText === 'function') {
      try {
        return shared.inlineEmojiText(node);
      } catch (_) {}
    }
    if (tagNameOf(node) !== 'IMG') return '';
    const className = String(safeAttribute(node, 'class') || '');
    const alt = String(safeAttribute(node, 'alt') || '');
    if (!EMOJI_IMAGE_CLASS_RE.test(className) || !alt || alt.length > 64 || !EMOJI_ALT_RE.test(alt)) return '';
    return alt;
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

    function pushInlineReplacement(node, parent, childIndex, value) {
      if (!parent || !Number.isInteger(childIndex) || childIndex < 0 || !value) return false;
      const start = boundary(parent, childIndex);
      const end = boundary(parent, childIndex + 1);
      for (let offset = 0; offset < value.length; offset += 1) {
        tokens.push({ char: value[offset], start, end, synthetic: false });
      }
      lastBoundary = end;
      return true;
    }

    function visit(node, parent, childIndex) {
      if (!node) return;
      const type = Number(node.nodeType);
      if (type === TEXT_NODE || (!Number.isFinite(type) && typeof node.nodeValue === 'string')) {
        pushText(node);
        return;
      }
      if (type !== ELEMENT_NODE && type !== DOCUMENT_NODE && type !== DOCUMENT_FRAGMENT_NODE
        && Number.isFinite(type)) return;

      if (type === ELEMENT_NODE && isIgnoredElement(node, options)) {
        // Extraction removes hidden/ignored inline decorations without adding
        // text. Mirror that behavior so an aria-hidden emoji image cannot turn
        // `前后` into `前 后`. Ignored block containers still carry a semantic
        // boundary and must not glue independent readable blocks together.
        const ignoredTag = tagNameOf(node);
        if (BLOCK_TAGS.has(ignoredTag) || IGNORED_BLOCK_TAGS.has(ignoredTag)) pushBreak();
        return;
      }

      if (type === ELEMENT_NODE
        && pushInlineReplacement(node, parent, childIndex, inlineEmojiText(node))) return;

      const tag = tagNameOf(node);
      if (tag === 'BR' || tag === 'WBR') {
        pushBreak();
        return;
      }

      const isBlock = BLOCK_TAGS.has(tag);
      if (isBlock) pushBreak();
      childNodesOf(node).forEach((child, index) => visit(child, node, index));
      if (isBlock) pushBreak();
    }

    for (const root of rootsOf(source)) visit(root, null, -1);
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

  function graphemeSpans(value) {
    const text = String(value || '');
    if (!text) return [];
    if (typeof Intl === 'object' && typeof Intl.Segmenter === 'function') {
      try {
        const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
        return Array.from(segmenter.segment(text), (entry) => ({
          text: entry.segment,
          start: entry.index
        }));
      } catch (_) {}
    }
    const output = [];
    let start = 0;
    for (const character of Array.from(text)) {
      output.push({ text: character, start });
      start += character.length;
    }
    return output;
  }

  function emojiFreeProjection(value, sourceMap) {
    const text = String(value || '');
    const raw = [];
    graphemeSpans(text).forEach((span) => {
      if (EMOJI_ALT_RE.test(span.text)) return;
      for (let offset = 0; offset < span.text.length; offset += 1) {
        const originalOffset = span.start + offset;
        raw.push({
          char: span.text[offset],
          map: sourceMap && sourceMap[originalOffset],
          originalOffset
        });
      }
    });

    const output = [];
    const charMap = [];
    const originalOffsets = [];
    for (let index = 0; index < raw.length;) {
      if (isWhitespace(raw[index].char)) {
        const first = raw[index];
        while (index < raw.length && isWhitespace(raw[index].char)) index += 1;
        if (!output.length || index >= raw.length) continue;
        output.push(' ');
        charMap.push(first.map);
        originalOffsets.push(first.originalOffset);
        continue;
      }
      output.push(raw[index].char);
      charMap.push(raw[index].map);
      originalOffsets.push(raw[index].originalOffset);
      index += 1;
    }
    return { text: output.join(''), charMap, originalOffsets };
  }

  function projectedSearchOffset(originalOffsets, requestedOffset) {
    let lower = 0;
    let upper = originalOffsets.length;
    while (lower < upper) {
      const middle = Math.floor((lower + upper) / 2);
      if (originalOffsets[middle] < requestedOffset) lower = middle + 1;
      else upper = middle;
    }
    return lower;
  }

  function makeMatch(first, last, normalizedStart, normalizedEnd, text, extra) {
    if (!first || !last || !first.start || !last.end) return null;
    return Object.assign({
      start: { node: first.start.node, offset: first.start.offset },
      end: { node: last.end.node, offset: last.end.offset },
      startContainer: first.start.node,
      startOffset: first.start.offset,
      endContainer: last.end.node,
      endOffset: last.end.offset,
      normalizedStart,
      normalizedEnd,
      nextOffset: normalizedEnd,
      text
    }, extra || {});
  }

  function findSegment(source, segmentText, precedingNormalizedOffset, options) {
    const index = ensureTextIndex(source, options);
    const needle = normalizeText(segmentText);
    if (!needle || !index.normalizedText || !index.charMap.length) return null;

    const searchFrom = Math.min(index.normalizedText.length, numericOffset(precedingNormalizedOffset));
    const normalizedStart = index.normalizedText.indexOf(needle, searchFrom);
    if (normalizedStart >= 0) {
      const normalizedEnd = normalizedStart + needle.length;
      return makeMatch(
        index.charMap[normalizedStart],
        index.charMap[normalizedEnd - 1],
        normalizedStart,
        normalizedEnd,
        needle
      );
    }

    // Some forums render a Unicode emoji as an inline image. Extraction and
    // the live DOM can briefly disagree about whether that emoji is present.
    // Retry using an emoji-only projection while retaining exact mappings for
    // every non-emoji character. No ordinary image or arbitrary symbol is
    // ignored by this fallback.
    const projectedIndex = emojiFreeProjection(index.normalizedText, index.charMap);
    const projectedNeedle = emojiFreeProjection(needle);
    if (!projectedNeedle.text
      || (projectedNeedle.text === needle && projectedIndex.text === index.normalizedText)) return null;
    const projectedFrom = projectedSearchOffset(projectedIndex.originalOffsets, searchFrom);
    const projectedStart = projectedIndex.text.indexOf(projectedNeedle.text, projectedFrom);
    if (projectedStart < 0) return null;
    const projectedEnd = projectedStart + projectedNeedle.text.length;
    const originalStart = projectedIndex.originalOffsets[projectedStart];
    const originalEnd = projectedIndex.originalOffsets[projectedEnd - 1] + 1;
    return makeMatch(
      projectedIndex.charMap[projectedStart],
      projectedIndex.charMap[projectedEnd - 1],
      originalStart,
      originalEnd,
      projectedNeedle.text,
      { emojiProjected: true }
    );
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

  function normalizedBounds(segmentMatch, index, options) {
    const settings = options || {};
    const match = segmentMatch || {};
    const lowerValue = finiteNumber(settings.normalizedStart ?? match.normalizedStart);
    const upperValue = finiteNumber(settings.normalizedEnd ?? match.normalizedEnd);
    const lower = lowerValue === null ? 0 : Math.max(0, Math.floor(lowerValue));
    const upper = upperValue === null
      ? index.normalizedText.length
      : Math.min(index.normalizedText.length, Math.max(lower, Math.floor(upperValue)));
    return { lower, upper };
  }

  function isWithinNormalizedBounds(match, bounds) {
    return Boolean(match)
      && match.normalizedStart >= bounds.lower
      && match.normalizedEnd <= bounds.upper;
  }

  // Find a child phrase inside an already matched sentence. The returned
  // object has the same DOM-boundary shape as findSegment(), plus nextOffset
  // for the caller's sequential cursor. Keeping this API separate preserves
  // the existing whole-sentence lookup behavior.
  function findSubrange(source, segmentMatch, subsegmentText, precedingNormalizedOffset, options) {
    const index = ensureTextIndex(source, options);
    const bounds = normalizedBounds(segmentMatch, index, options);
    const requestedCursor = finiteNumber(precedingNormalizedOffset);
    const cursor = Math.max(
      bounds.lower,
      Math.min(bounds.upper, requestedCursor === null ? bounds.lower : Math.floor(requestedCursor))
    );
    const match = findSegment(index, subsegmentText, cursor);
    return isWithinNormalizedBounds(match, bounds) ? match : null;
  }

  function sourceSubsegmentText(sourceText, sourceStart, sourceEnd) {
    const value = String(sourceText == null ? '' : sourceText);
    const startNumber = finiteNumber(sourceStart);
    const endNumber = finiteNumber(sourceEnd);
    if (startNumber === null || endNumber === null) return '';
    const start = Math.max(0, Math.min(value.length, Math.floor(startNumber)));
    const end = Math.max(start, Math.min(value.length, Math.floor(endNumber)));
    return value.slice(start, end);
  }

  // Resolve one SpeechSourceMap word back to DOM boundaries. The source
  // offsets are UTF-16 offsets in speechSourceMap.sourceText; they must never
  // be used as TextNode offsets directly.
  function findSourceSubrange(source, segmentMatch, sourceText, sourceStart, sourceEnd,
    precedingNormalizedOffset, options) {
    const text = sourceSubsegmentText(sourceText, sourceStart, sourceEnd);
    if (!text) return null;
    const match = findSubrange(
      source,
      segmentMatch,
      text,
      precedingNormalizedOffset,
      options
    );
    if (!match) return null;
    return Object.assign({}, match, {
      sourceStart: Number.isFinite(Number(sourceStart)) ? Number(sourceStart) : null,
      sourceEnd: Number.isFinite(Number(sourceEnd)) ? Number(sourceEnd) : null
    });
  }

  // Resolve an ordered list of SpeechSourceMap words inside one sentence.
  // Each item may be a plain string, or an object with text, or an object with
  // sourceText/sourceStart/sourceEnd. The cursor advances only after a match,
  // so repeated words remain deterministic.
  function findSubranges(source, segmentMatch, subsegments, options) {
    const index = ensureTextIndex(source, options);
    const settings = options || {};
    const bounds = normalizedBounds(segmentMatch, index, settings);
    let cursor = Math.max(
      bounds.lower,
      Math.min(bounds.upper, numericOffset(settings.cursor ?? bounds.lower))
    );
    return Array.from(subsegments || [], (item) => {
      const value = item && typeof item === 'object' ? item : { text: item };
      const hasSourceOffsets = value.sourceText != null
        && Number.isFinite(Number(value.sourceStart))
        && Number.isFinite(Number(value.sourceEnd));
      const text = hasSourceOffsets
        ? sourceSubsegmentText(value.sourceText, value.sourceStart, value.sourceEnd)
        : String(value.text == null ? '' : value.text);
      if (!text) return null;
      const match = findSubrange(index, segmentMatch, text, cursor, settings);
      if (!match) return null;
      cursor = match.nextOffset;
      return hasSourceOffsets
        ? Object.assign({}, match, {
          sourceStart: Number(value.sourceStart),
          sourceEnd: Number(value.sourceEnd)
        })
        : match;
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
    findSubrange,
    findSourceSubrange,
    findSubranges,
    pickSegmentIndexAtPoint,
    segmentIndexAtPoint: pickSegmentIndexAtPoint
  });
})(globalThis);
