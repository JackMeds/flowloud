(function attachGenericThreadDetector(global) {
  'use strict';

  const Text = global.QwenReaderText;
  const ForumContent = global.QwenReaderForumContent;
  const CLUSTER_SELECTORS = [
    '[data-post-id]',
    '[data-post-number]',
    '[data-message-id]',
    '.topic-post',
    '.forum-post',
    '.message--post',
    '.comment',
    '[role="article"]',
    'article'
  ];
  const BODY_SELECTORS = [
    '[data-post-body]',
    '.post-body',
    '.post-content',
    '.message-body',
    '.message-content',
    '.comment-body',
    '.comment-content',
    '.content'
  ];
  const AUTHOR_SELECTORS = [
    '[data-author]',
    '[rel="author"]',
    '.author',
    '.username',
    '.user-name',
    '.message-name'
  ];

  function clean(value) {
    return Text && typeof Text.cleanText === 'function'
      ? Text.cleanText(value)
      : String(value == null ? '' : value).replace(/\s+/gu, ' ').trim();
  }

  function queryAll(node, selector) {
    if (!node || typeof node.querySelectorAll !== 'function') return [];
    try {
      return Array.from(node.querySelectorAll(selector) || []);
    } catch (_) {
      return [];
    }
  }

  function queryFirst(node, selectors) {
    if (!node || typeof node.querySelector !== 'function') return null;
    for (const selector of selectors) {
      try {
        const match = node.querySelector(selector);
        if (match) return match;
      } catch (_) {
        // Try the next conservative selector.
      }
    }
    return null;
  }

  function attribute(node, names) {
    if (!node || typeof node.getAttribute !== 'function') return '';
    for (const name of names) {
      const value = node.getAttribute(name);
      if (value != null && String(value).trim()) return String(value).trim();
    }
    return '';
  }

  function fingerprint(value) {
    let hash = 2166136261;
    for (const character of String(value || '')) {
      hash ^= character.codePointAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function cssString(value) {
    return String(value || '').replace(/\\/gu, '\\\\').replace(/"/gu, '\\"');
  }

  function sourceSelector(node, postId, clusterSelector) {
    const dataPostId = attribute(node, ['data-post-id']);
    if (dataPostId) return `[data-post-id="${cssString(dataPostId)}"]`;
    const dataMessageId = attribute(node, ['data-message-id']);
    if (dataMessageId) return `[data-message-id="${cssString(dataMessageId)}"]`;
    const id = attribute(node, ['id']);
    if (id) return `#${cssString(id)}`;
    return `${clusterSelector}:nth-of-type(${Math.max(1, Number(postId) || 1)})`;
  }

  function authorOf(node, index) {
    const authorNode = queryFirst(node, AUTHOR_SELECTORS);
    const name = clean(
      attribute(node, ['data-author-name', 'data-author']) ||
      attribute(authorNode, ['data-author-name', 'data-author']) ||
      authorNode && authorNode.textContent
    ) || '匿名用户';
    const rawId = attribute(node, ['data-user-id', 'data-author-id']) ||
      attribute(authorNode, ['data-user-id', 'data-author-id', 'href']);
    return {
      id: rawId ? String(rawId) : (name === '匿名用户' ? `anonymous:${index + 1}` : `name:${name.toLocaleLowerCase()}`),
      name,
      stable: Boolean(rawId || name !== '匿名用户')
    };
  }

  function unitsOf(body) {
    if (ForumContent && typeof ForumContent.semanticUnitsFromElement === 'function') {
      const units = ForumContent.semanticUnitsFromElement(body, { removeBlockquotes: true });
      if (units.length) return units;
    }
    const value = clean(body && body.textContent);
    return value ? [{ unitIndex: 0, text: value, fingerprint: fingerprint(value) }] : [];
  }

  function postOf(node, index, clusterSelector) {
    const body = queryFirst(node, BODY_SELECTORS) || node;
    const units = unitsOf(body).filter((unit) => clean(unit.text).length > 0);
    if (!units.length) return null;
    const author = authorOf(node, index);
    const rawFloor = attribute(node, ['data-post-number', 'data-floor']);
    const floor = Number(rawFloor);
    const postId = attribute(node, ['data-post-id', 'data-message-id', 'id']) || String(index + 1);
    return {
      node,
      body,
      postId,
      floor: Number.isFinite(floor) && floor > 0 ? floor : index + 1,
      author,
      units,
      containerSelector: sourceSelector(node, index + 1, clusterSelector)
    };
  }

  function strongForumSignal(node, selector) {
    if (/data-post|data-message|topic-post|forum-post|message--post/u.test(selector)) return true;
    const classes = attribute(node, ['class']);
    return /(?:^|\s)(?:post|message|comment)(?:\s|$|--|-)/iu.test(classes);
  }

  function scoreCluster(posts, selector) {
    if (posts.length < 2) return -Infinity;
    const totalChars = posts.reduce((sum, post) => (
      sum + post.units.reduce((unitSum, unit) => unitSum + clean(unit.text).length, 0)
    ), 0);
    const averageChars = totalChars / posts.length;
    const stableAuthors = posts.filter((post) => post.author.stable).length;
    const authorCoverage = stableAuthors / posts.length;
    const strongSignal = posts.some((post) => strongForumSignal(post.node, selector));
    if (!strongSignal && posts.length < 3) return -Infinity;
    if (averageChars < 4) return -Infinity;
    return Math.min(40, posts.length * 6) +
      Math.min(24, averageChars / 8) +
      authorCoverage * 24 +
      (strongSignal ? 18 : 0);
  }

  function detect(document, options) {
    const settings = options || {};
    const maximumPosts = Number.isInteger(settings.maximumPosts) ? settings.maximumPosts : 500;
    const candidates = [];
    CLUSTER_SELECTORS.forEach((selector) => {
      const nodes = queryAll(document, selector).slice(0, maximumPosts);
      const posts = nodes.map((node, index) => postOf(node, index, selector)).filter(Boolean);
      const score = scoreCluster(posts, selector);
      if (Number.isFinite(score)) candidates.push({ selector, posts, score });
    });
    const selected = candidates.sort((left, right) => right.score - left.score)[0];
    if (!selected || selected.score < 58) return null;
    const firstAuthor = selected.posts[0] && selected.posts[0].author;
    return {
      adapterId: 'generic-thread',
      selector: selected.selector,
      score: Math.round(selected.score * 100) / 100,
      confidence: selected.score >= 82 ? 'high' : 'medium',
      posts: selected.posts.map((post, index) => Object.assign({}, post, {
        isOp: index === 0 || Boolean(
          firstAuthor && firstAuthor.stable && post.author.stable && post.author.id === firstAuthor.id
        )
      }))
    };
  }

  function toBlocks(result) {
    if (!result || !Array.isArray(result.posts)) return [];
    return result.posts.flatMap((post) => post.units.map((unit) => ({
      id: `generic-thread:${post.postId}:unit:${unit.unitIndex}`,
      type: 'forum-post',
      text: clean(unit.text),
      authorId: post.author.id,
      authorName: post.author.name,
      floor: post.floor,
      isOp: Boolean(post.isOp),
      postId: post.postId,
      sourceKey: `generic-thread:${post.postId}`,
      sourceSelector: post.containerSelector,
      sourceLocator: {
        adapter: 'generic-thread',
        containerSelector: post.containerSelector,
        unitIndex: unit.unitIndex,
        fingerprint: unit.fingerprint || fingerprint(unit.text)
      }
    })));
  }

  global.QwenReaderGenericThreadDetector = Object.freeze({ detect, toBlocks });
})(globalThis);
