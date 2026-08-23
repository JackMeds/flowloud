(function attachNormalizedDocument(global) {
  'use strict';

  function clean(value) {
    const helper = global.QwenReaderText && global.QwenReaderText.cleanText;
    if (typeof helper === 'function') return helper(value);
    return String(value == null ? '' : value)
      .replace(/\u00a0/gu, ' ')
      .replace(/[\t\f\v ]+/gu, ' ')
      .replace(/ *\n */gu, '\n')
      .replace(/\n{3,}/gu, '\n\n')
      .trim();
  }

  function locationHref(location) {
    if (typeof location === 'string') return location;
    if (!location) return '';
    if (location.href) return String(location.href);
    const origin = String(location.origin || '');
    const pathname = String(location.pathname || '/');
    const search = String(location.search || '');
    const hash = String(location.hash || '');
    return `${origin}${pathname}${search}${hash}`;
  }

  function pageKey(location) {
    const href = locationHref(location);
    if (!href) return '';
    try {
      const url = new URL(href);
      if (!/^#!?\//u.test(url.hash)) url.hash = '';
      return url.toString();
    } catch (_) {
      return href.replace(/#.*$/u, '');
    }
  }

  function normalizeSourceLocator(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const keys = ['adapter', 'containerSelector', 'unitIndex', 'fingerprint'];
    if (!keys.every((key) => {
      const value = input[key];
      return (typeof value === 'string' || typeof value === 'number') &&
        (typeof value !== 'number' || Number.isFinite(value));
    })) return null;
    const unitIndex = Number(input.unitIndex);
    if (!Number.isFinite(unitIndex)) return null;
    return {
      adapter: String(input.adapter),
      containerSelector: String(input.containerSelector),
      unitIndex,
      fingerprint: String(input.fingerprint)
    };
  }

  function createBlock(input) {
    const source = input || {};
    const floorValue = Number(source.floor);
    return {
      id: String(source.id == null ? '' : source.id),
      type: String(source.type || 'paragraph'),
      text: clean(source.text),
      authorId: String(source.authorId == null ? '' : source.authorId),
      authorName: clean(source.authorName),
      floor: Number.isFinite(floorValue) ? floorValue : null,
      isOp: Boolean(source.isOp),
      postId: String(source.postId == null ? '' : source.postId),
      sourceKey: String(source.sourceKey == null ? '' : source.sourceKey),
      sourceSelector: String(source.sourceSelector == null ? '' : source.sourceSelector),
      sourceLocator: normalizeSourceLocator(source.sourceLocator)
    };
  }

  function createDocument(input) {
    const source = input || {};
    const url = locationHref(source.url || source.location);
    const blocks = (Array.isArray(source.blocks) ? source.blocks : [])
      .map(createBlock)
      .filter((block) => block.text.length > 0);
    const adapterId = String(source.adapterId || source.adapter || 'generic');
    return {
      url,
      pageKey: String(source.pageKey || pageKey(url)),
      title: clean(source.title),
      kind: String(source.kind || (
        ['flarum', 'discourse', 'nodebb', 'xenforo'].includes(adapterId)
          ? 'forum'
          : adapterId === 'selection' ? 'selection' : 'article'
      )),
      adapterId,
      adapter: adapterId,
      blocks,
      complete: source.complete !== false,
      warnings: Array.from(new Set(
        (Array.isArray(source.warnings) ? source.warnings : [])
          .map((warning) => String(warning || '').trim())
          .filter(Boolean)
      )),
      stats: Object.assign({ extractedPosts: blocks.length }, source.stats || {})
    };
  }

  function toPlaybackSegments(document, maxChars) {
    const source = document || {};
    const blocks = Array.isArray(source.blocks) ? source.blocks : [];
    const split = global.QwenReaderText && global.QwenReaderText.splitText;
    const canSpeak = global.QwenReaderText && global.QwenReaderText.hasSpeakableText;
    const prepare = global.QwenReaderText && global.QwenReaderText.prepareSpeech;
    const buildSpeechWords = global.QwenReaderText && global.QwenReaderText.buildSpeechWords;
    const hasSpeakableText = typeof canSpeak === 'function'
      ? canSpeak
      : (value) => /[\p{L}\p{N}]/u.test(String(value == null ? '' : value));
    const output = [];
    const documentKey = String(source.pageKey || pageKey(source.url || source.location));
    blocks.forEach((input, blockIndex) => {
      const normalized = createBlock(input);
      const chunks = typeof split === 'function'
        ? split(normalized.text, maxChars)
        : [normalized.text];
      let sourceCursor = 0;
      chunks.forEach((chunk, chunkIndex) => {
        const locatedStart = normalized.text.indexOf(chunk, sourceCursor);
        const sourceStart = locatedStart >= 0 ? locatedStart : sourceCursor;
        const sourceEnd = Math.min(normalized.text.length, sourceStart + chunk.length);
        sourceCursor = Math.max(sourceCursor, sourceEnd);
        const prepared = typeof prepare === 'function'
          ? prepare(chunk)
          : { sourceText: chunk, speechText: chunk, ranges: [] };
        if (!hasSpeakableText(prepared.speechText)) return;
        const segment = createBlock(Object.assign({}, normalized, {
          id: `${normalized.id || `block-${blockIndex}`}:${chunkIndex}`,
          text: chunk
        }));
        const locator = segment.sourceLocator;
        const locatorIdentity = locator
          // Live forum DOM and canonical forum APIs often describe the same
          // post with different selector strings (for example, the live DOM
          // adds a virtualized floor selector).  A selector-based identity
          // therefore leaves two copies of the clicked sentence in the
          // progressive queue.  Prefer the immutable post id when available;
          // unit index, fingerprint and text offsets still keep genuinely
          // repeated sentences distinct.
          ? [locator.adapter, segment.postId || locator.containerSelector, locator.unitIndex, locator.fingerprint].join(':')
          : String(segment.sourceKey || segment.sourceSelector || normalized.id || `block-${blockIndex}`);
        segment.sourceText = normalized.text;
        segment.sourceStart = sourceStart;
        segment.sourceEnd = sourceEnd;
        segment.sourceIdentity = [documentKey, locatorIdentity, sourceStart, sourceEnd].join('|');
        segment.speechText = prepared.speechText;
        segment.speechSourceMap = {
          sourceText: prepared.sourceText,
          speechText: prepared.speechText,
          ranges: (Array.isArray(prepared.ranges) ? prepared.ranges : [])
            .map((range) => Object.assign({}, range))
        };
        // Word ranges are only consumed once this segment starts playing.
        // Computing them for every sentence up front makes long threads wait
        // in the extracting state, so preserve the same API with a lazy array.
        let cachedWords = null;
        Object.defineProperty(segment.speechSourceMap, 'words', {
          configurable: true,
          enumerable: true,
          get() {
            if (!cachedWords) {
              cachedWords = (typeof buildSpeechWords === 'function'
                ? buildSpeechWords(prepared)
                : [])
                .map((word) => Object.assign({}, word));
            }
            return cachedWords;
          },
          set(value) {
            cachedWords = (Array.isArray(value) ? value : [])
              .map((word) => Object.assign({}, word));
          }
        });
        output.push(segment);
      });
    });
    return output;
  }

  const api = Object.freeze({
    createBlock,
    createDocument,
    pageKey,
    makePageKey: pageKey,
    toPlaybackSegments
  });
  global.QwenReaderNormalizedDocument = api;
  global.QwenReaderDocument = api;
})(globalThis);
