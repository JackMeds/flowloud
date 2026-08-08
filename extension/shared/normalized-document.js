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
    const output = [];
    blocks.forEach((input, blockIndex) => {
      const normalized = createBlock(input);
      const chunks = typeof split === 'function'
        ? split(normalized.text, maxChars)
        : [normalized.text];
      chunks.forEach((chunk, chunkIndex) => {
        output.push(createBlock(Object.assign({}, normalized, {
          id: `${normalized.id || `block-${blockIndex}`}:${chunkIndex}`,
          text: chunk
        })));
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
