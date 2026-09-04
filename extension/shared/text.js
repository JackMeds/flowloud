(function attachTextHelpers(global) {
  'use strict';

  const URL_PATTERN = /(?:https?:\/\/|www\.)[^\s<>()\[\]{}]+/giu;
  const BREAK_CHARACTERS = new Set(['。', '！', '？', '；']);
  const CLOSING_CHARACTERS = new Set(['”', '’', '」', '』', '】', '》', '）', ')', ']', '}']);
  const SPEAKABLE_PATTERN = /[\p{L}\p{N}]/u;
  const EMOJI_CLUSTER_PATTERN = createUnicodePattern(
    '(?:\\p{Extended_Pictographic}|\\p{Regional_Indicator}|[#*0-9]\\uFE0F?\\u20E3)',
    'u',
    /(?:[\u00a9\u00ae\u203c-\u3299]|[\ud83c-\udbff][\udc00-\udfff])/u
  );
  const EMOJI_COMPONENT_PATTERN = createUnicodePattern(
    '(?:\\p{Emoji_Modifier}|[\\u200D\\uFE0E\\uFE0F\\u20E3]|[\\u{E0020}-\\u{E007F}])',
    'u',
    /[\u200d\ufe0e\ufe0f\u20e3]/u
  );

  function createUnicodePattern(source, flags, fallback) {
    try {
      return new RegExp(source, flags);
    } catch (_) {
      return fallback;
    }
  }

  function cleanText(value) {
    return String(value == null ? '' : value)
      .replace(URL_PATTERN, ' ')
      .replace(/[\t\r\n\f\v\u00a0\u3000]+/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim();
  }

  function hasSpeakableText(value) {
    return SPEAKABLE_PATTERN.test(String(value == null ? '' : value));
  }

  function graphemeUnits(value) {
    const text = String(value == null ? '' : value);
    if (!text) return [];
    if (typeof Intl === 'object' && typeof Intl.Segmenter === 'function') {
      try {
        const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
        return Array.from(segmenter.segment(text), (entry) => ({
          text: entry.segment,
          sourceStart: entry.index,
          sourceEnd: entry.index + entry.segment.length
        }));
      } catch (_) {
        // Fall through to the code-point-safe fallback.
      }
    }
    const units = [];
    let offset = 0;
    for (const character of Array.from(text)) {
      units.push({
        text: character,
        sourceStart: offset,
        sourceEnd: offset + character.length
      });
      offset += character.length;
    }
    return units;
  }

  function isEmojiUnit(value) {
    const text = String(value == null ? '' : value);
    return EMOJI_CLUSTER_PATTERN.test(text) || EMOJI_COMPONENT_PATTERN.test(text);
  }

  function collapseWhitespace(units) {
    const output = [];
    for (let index = 0; index < units.length; index += 1) {
      const unit = units[index];
      if (!/^\s+$/u.test(unit.text)) {
        output.push(unit);
        continue;
      }
      let end = unit.sourceEnd;
      while (index + 1 < units.length && /^\s+$/u.test(units[index + 1].text)) {
        index += 1;
        end = units[index].sourceEnd;
      }
      output.push({ text: ' ', sourceStart: unit.sourceStart, sourceEnd: end });
    }
    while (output.length && output[0].text === ' ') output.shift();
    while (output.length && output[output.length - 1].text === ' ') output.pop();
    return output;
  }

  function replaceMapped(units, pattern, replacement) {
    const text = units.map((unit) => unit.text).join('');
    pattern.lastIndex = 0;
    const matches = Array.from(text.matchAll(pattern));
    pattern.lastIndex = 0;
    if (!matches.length) return units;

    const starts = [];
    let textOffset = 0;
    units.forEach((unit) => {
      starts.push(textOffset);
      textOffset += unit.text.length;
    });

    const output = [];
    let unitCursor = 0;
    for (const match of matches) {
      const matchStart = match.index;
      const matchEnd = matchStart + match[0].length;
      while (
        unitCursor < units.length &&
        starts[unitCursor] + units[unitCursor].text.length <= matchStart
      ) {
        output.push(units[unitCursor]);
        unitCursor += 1;
      }
      const firstMatched = unitCursor;
      while (unitCursor < units.length && starts[unitCursor] < matchEnd) {
        unitCursor += 1;
      }
      if (firstMatched === unitCursor) continue;
      const replacementText = typeof replacement === 'function'
        ? replacement(match)
        : replacement;
      if (replacementText) {
        output.push({
          text: replacementText,
          sourceStart: units[firstMatched].sourceStart,
          sourceEnd: units[unitCursor - 1].sourceEnd
        });
      }
    }
    while (unitCursor < units.length) {
      output.push(units[unitCursor]);
      unitCursor += 1;
    }
    return output;
  }

  function buildSpeechRanges(units) {
    const ranges = [];
    let speechOffset = 0;
    units.forEach((unit) => {
      const speechEnd = speechOffset + unit.text.length;
      ranges.push({
        speechStart: speechOffset,
        speechEnd,
        sourceStart: unit.sourceStart,
        sourceEnd: unit.sourceEnd
      });
      speechOffset = speechEnd;
    });
    return ranges;
  }

  function prepareSpeech(value) {
    const sourceText = cleanText(value);
    let units = graphemeUnits(sourceText).filter((unit) => !isEmojiUnit(unit.text));
    units = collapseWhitespace(units);
    units = replaceMapped(units, /(?:[。．]\s*){2,}/gu, '。');
    units = replaceMapped(units, /(?:\.\s*){3,}/gu, '…');
    units = replaceMapped(units, /…{2,}/gu, '…');
    units = replaceMapped(units, /([！？!?；;])(?:\s*\1)+/gu, (match) => match[1]);
    units = replaceMapped(units, /(?:[！？!?]\s*){4,}/gu, '！？');
    units = collapseWhitespace(units);
    const speechText = units.map((unit) => unit.text).join('').trim();
    if (!hasSpeakableText(speechText)) {
      return { sourceText, speechText: '', ranges: [] };
    }
    return {
      sourceText,
      speechText,
      ranges: buildSpeechRanges(units)
    };
  }

  function prepareSpeechText(value) {
    return prepareSpeech(value).speechText;
  }

  function mapSpeechRange(prepared, speechStart, speechEnd) {
    const ranges = prepared && Array.isArray(prepared.ranges) ? prepared.ranges : [];
    if (!ranges.length) return null;
    const textLength = String(prepared.speechText || '').length;
    const start = Math.max(0, Math.min(Number(speechStart) || 0, textLength));
    const requestedEnd = Number.isFinite(Number(speechEnd)) ? Number(speechEnd) : start;
    const end = Math.max(start, Math.min(requestedEnd, textLength));
    let matches = ranges.filter((range) => range.speechEnd > start && range.speechStart < end);
    if (!matches.length) {
      const nearest = ranges.find((range) => range.speechStart <= start && range.speechEnd >= start) ||
        ranges.find((range) => range.speechStart >= start) || ranges[ranges.length - 1];
      matches = nearest ? [nearest] : [];
    }
    if (!matches.length) return null;
    return {
      sourceStart: matches[0].sourceStart,
      sourceEnd: matches[matches.length - 1].sourceEnd
    };
  }

  function findNextSpeakableIndex(items, startIndex) {
    const source = Array.isArray(items) ? items : [];
    const requested = Number.isInteger(startIndex) ? startIndex : 0;
    for (let index = Math.max(0, requested); index < source.length; index += 1) {
      const item = source[index];
      const text = item && typeof item === 'object' ? item.text : item;
      if (hasSpeakableText(text)) return index;
    }
    return -1;
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

  function normalizeForSegmentation(value) {
    return String(value == null ? '' : value)
      .replace(URL_PATTERN, ' ')
      .replace(/\r\n?/gu, '\n')
      .replace(/[\t\f\v\u00a0\u3000]+/gu, ' ')
      .replace(/[ ]+/gu, ' ')
      .replace(/ *\n */gu, '\n')
      .trim();
  }

  function splitConfiguredBoundaries(text) {
    const chunks = [];
    let current = '';
    let boundaryPending = false;
    const characters = Array.from(text);

    function pushCurrent() {
      const chunk = current.trim();
      if (chunk) chunks.push(chunk);
      current = '';
    }

    for (let index = 0; index < characters.length; index += 1) {
      const character = characters[index];
      current += character;
      if (BREAK_CHARACTERS.has(character)) boundaryPending = true;
      if (!boundaryPending) continue;
      const nextCharacter = characters[index + 1] || '';
      if (BREAK_CHARACTERS.has(nextCharacter) || CLOSING_CHARACTERS.has(nextCharacter)) {
        continue;
      }
      pushCurrent();
      boundaryPending = false;
    }
    pushCurrent();
    return chunks;
  }

  function segmentSentences(value) {
    const text = normalizeForSegmentation(value);
    if (!text) return [];
    const output = [];
    const paragraphs = text.split('\n');
    let segmenter = null;
    if (typeof Intl === 'object' && typeof Intl.Segmenter === 'function') {
      try {
        segmenter = new Intl.Segmenter(undefined, { granularity: 'sentence' });
      } catch (_) {
        segmenter = null;
      }
    }
    paragraphs.forEach((paragraph) => {
      const standardSegments = segmenter
        ? Array.from(segmenter.segment(paragraph), (entry) => entry.segment.trim()).filter(Boolean)
        : [paragraph];
      standardSegments.forEach((segment) => {
        splitConfiguredBoundaries(segment).forEach((chunk) => output.push(chunk));
      });
    });
    return output;
  }

  function splitAtLimit(text, limit) {
    const output = [];
    let current = '';
    graphemeUnits(text).forEach((unit) => {
      if (current && current.length + unit.text.length > limit) {
        if (hasSpeakableText(current)) output.push(current.trim());
        current = '';
      }
      current += unit.text;
    });
    if (current.trim() && hasSpeakableText(current)) output.push(current.trim());
    return output;
  }

  function splitText(value, maxChars) {
    const text = normalizeForSegmentation(value);
    const limit = Number.isInteger(maxChars) && maxChars > 0 ? maxChars : 260;
    if (!text) return [];
    const chunks = [];
    segmentSentences(text).forEach((sentence) => {
      splitAtLimit(sentence, limit).forEach((chunk) => chunks.push(chunk));
    });
    return chunks;
  }

  global.QwenReaderText = {
    cleanText,
    hasSpeakableText,
    prepareSpeech,
    prepareSpeechText,
    mapSpeechRange,
    findNextSpeakableIndex,
    segmentSentences,
    splitText,
    makeSegment
  };
})(globalThis);
