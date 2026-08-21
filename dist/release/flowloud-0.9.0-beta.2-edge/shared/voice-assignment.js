(function attachVoiceAssignment(global) {
  'use strict';

  function cleanKeyPart(value, lowercase) {
    const text = String(value == null ? '' : value)
      .trim()
      .replace(/\s+/gu, ' ');
    return lowercase ? text.toLocaleLowerCase() : text;
  }

  function makeAuthorKey(prefix, value, lowercase) {
    const key = cleanKeyPart(value, lowercase);
    return key ? `${prefix}:${key}` : '';
  }

  function authorKey(segment, index) {
    const source = segment || {};
    const byId = makeAuthorKey('id', source.authorId, false);
    if (byId) return byId;
    const byName = makeAuthorKey('name', source.authorName, true);
    if (byName) return byName;
    if (source.isOp) return 'role:op';
    if (source.type === 'article' || source.type === 'selection') {
      return `document:${source.type}`;
    }
    const byPost = makeAuthorKey('source', source.postId || source.sourceKey, false);
    if (byPost) return byPost;
    const bySegment = makeAuthorKey('segment', source.id, false);
    if (bySegment) return bySegment;
    return `segment:${Number.isInteger(index) ? index : 0}`;
  }

  function normalizeAuthorKey(value) {
    const raw = cleanKeyPart(value, false);
    if (!raw) return '';
    const match = /^(id|name|role|document|source|segment):(.*)$/u.exec(raw);
    if (!match) return makeAuthorKey('id', raw, false);
    const prefix = match[1];
    const part = cleanKeyPart(match[2], prefix === 'name');
    return part ? `${prefix}:${part}` : '';
  }

  function normalizeAuthorVoices(value) {
    const entries = value instanceof Map
      ? Array.from(value.entries())
      : Array.isArray(value)
        ? value.map((item) => Array.isArray(item)
          ? item
          : [item && (item.authorKey || item.key), item && item.voice])
        : value && typeof value === 'object'
          ? Object.entries(value)
          : [];
    const normalized = {};
    entries.forEach(([key, voice]) => {
      const author = normalizeAuthorKey(key);
      const selectedVoice = String(voice == null ? '' : voice).trim();
      if (author && selectedVoice) normalized[author] = selectedVoice;
    });
    return normalized;
  }

  function assignVoices(segments, options) {
    const settings = options || {};
    const opVoice = String(settings.opVoice || '').trim();
    const replyVoices = Array.isArray(settings.replyVoices)
      ? settings.replyVoices.map((voice) => String(voice || '').trim()).filter((voice) => voice && voice !== opVoice)
      : [];
    if (!replyVoices.length && settings.allowSingleVoice && opVoice) replyVoices.push(opVoice);
    if (!replyVoices.length) {
      throw new Error('回复音色池不能为空');
    }

    const mode = settings.mode || 'op-exclusive';
    if (!['op-exclusive', 'stable-author', 'round-robin'].includes(mode)) {
      throw new Error('未知的音色分配预设');
    }
    const authorVoices = normalizeAuthorVoices(settings.authorVoices);

    const stableVoices = new Map();
    let replyIndex = 0;
    let lastReplyAuthor = '';
    let lastReplyGroup = '';
    let activeReplyVoice = '';
    return (Array.isArray(segments) ? segments : []).map((segment, index) => {
      const clone = { ...segment };
      const key = authorKey(clone, index);
      const overrideVoice = authorVoices[key];
      if (clone.isOp || clone.type === 'article' || clone.type === 'selection') {
        clone.voice = overrideVoice || opVoice;
        return clone;
      }

      if (mode === 'stable-author') {
        if (!stableVoices.has(key)) {
          stableVoices.set(key, replyVoices[stableVoices.size % replyVoices.length]);
        }
        clone.voice = stableVoices.get(key);
      } else if (mode === 'op-exclusive') {
        if (key !== lastReplyAuthor || !activeReplyVoice) {
          activeReplyVoice = replyVoices[replyIndex % replyVoices.length];
          replyIndex += 1;
          lastReplyAuthor = key;
        }
        clone.voice = activeReplyVoice;
      } else {
        const groupKey = String(
          clone.postId || clone.sourceKey || String(clone.id || index).replace(/:\d+$/u, '')
        );
        if (groupKey !== lastReplyGroup || !activeReplyVoice) {
          activeReplyVoice = replyVoices[replyIndex % replyVoices.length];
          replyIndex += 1;
          lastReplyGroup = groupKey;
        }
        clone.voice = activeReplyVoice;
      }
      // A per-page author decision changes only this final selection. We still
      // advance the normal allocator so the remaining authors keep their
      // deterministic B/C ordering when an override is later removed.
      if (overrideVoice) clone.voice = overrideVoice;
      return clone;
    });
  }

  global.QwenReaderVoiceAssignment = {
    assignVoices,
    authorKey,
    normalizeAuthorKey,
    normalizeAuthorVoices
  };
})(globalThis);
