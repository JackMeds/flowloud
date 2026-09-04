(function attachSourceLocator(global) {
  'use strict';

  function safeQuery(document, selector) {
    if (!document || !selector || typeof document.querySelector !== 'function') return null;
    try {
      return document.querySelector(selector);
    } catch (_) {
      return null;
    }
  }

  function resolve(document, block) {
    const source = block || {};
    const locator = source.sourceLocator;
    const forumContent = global.QwenReaderForumContent;
    if (locator && locator.containerSelector && forumContent) {
      const container = safeQuery(document, locator.containerSelector);
      if (container) {
        try {
          const nodes = forumContent.semanticElements(container, { removeBlockquotes: true });
          const matches = nodes
            .map((node, index) => ({ node, index }))
            .filter(({ node }) => forumContent.fingerprint(
              forumContent.readableElementText(node, {
                removeBlockquotes: true,
                removeNestedSemanticElements: true
              })
            ) === locator.fingerprint);
          if (matches.length) {
            matches.sort((left, right) => Math.abs(left.index - locator.unitIndex) - Math.abs(right.index - locator.unitIndex));
            return matches[0].node;
          }
          if (nodes[locator.unitIndex]) return nodes[locator.unitIndex];
          if (!nodes.length) return container;
        } catch (_) {}
      }
    }
    return safeQuery(document, source.sourceSelector);
  }

  global.QwenReaderSourceLocator = Object.freeze({ resolve });
})(globalThis);
