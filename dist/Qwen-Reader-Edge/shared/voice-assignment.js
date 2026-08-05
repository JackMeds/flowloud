(function attachVoiceAssignment(global) {
  'use strict';

  function assignVoices(segments, options) {
    const settings = options || {};
    const opVoice = String(settings.opVoice || '').trim();
    const replyVoices = Array.isArray(settings.replyVoices)
      ? settings.replyVoices.map((voice) => String(voice || '').trim()).filter((voice) => voice && voice !== opVoice)
      : [];
    if (!replyVoices.length) {
      throw new Error('回复音色池不能为空');
    }

    const mode = settings.mode || 'op-exclusive';
    if (!['op-exclusive', 'stable-author', 'round-robin'].includes(mode)) {
      throw new Error('未知的音色分配预设');
    }

    const stableVoices = new Map();
    let replyIndex = 0;
    let lastReplyAuthor = '';
    let lastReplyGroup = '';
    let activeReplyVoice = '';
    return (Array.isArray(segments) ? segments : []).map((segment, index) => {
      const clone = { ...segment };
      if (clone.isOp || clone.type === 'article' || clone.type === 'selection') {
        clone.voice = opVoice;
        return clone;
      }

      if (mode === 'stable-author') {
        const authorKey = String(clone.authorId || clone.authorName || clone.id || index);
        if (!stableVoices.has(authorKey)) {
          stableVoices.set(authorKey, replyVoices[stableVoices.size % replyVoices.length]);
        }
        clone.voice = stableVoices.get(authorKey);
      } else if (mode === 'op-exclusive') {
        const authorKey = String(
          clone.authorId || clone.authorName || clone.postId || clone.sourceKey || clone.id || index
        );
        if (authorKey !== lastReplyAuthor || !activeReplyVoice) {
          activeReplyVoice = replyVoices[replyIndex % replyVoices.length];
          replyIndex += 1;
          lastReplyAuthor = authorKey;
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
      return clone;
    });
  }

  global.QwenReaderVoiceAssignment = { assignVoices };
})(globalThis);
