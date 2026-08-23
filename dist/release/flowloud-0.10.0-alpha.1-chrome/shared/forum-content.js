(function attachForumContent(global) {
  'use strict';

  const SEMANTIC_SELECTOR = 'p,h1,h2,h3,h4,h5,h6,li';
  const REMOVABLE_SELECTOR = [
    'script', 'style', 'noscript', 'template', 'svg', 'figure', 'nav', 'aside', 'footer',
    '.Post-actions', '.Post-controls', '.Post-signature', '.Post-meta',
    '.message-signature', '.message-attribution-opposite', '.message-footer',
    '.bbCodeBlock--quote', '.quote', '.signature', '.reactions', '.reactionsBar',
    '.item-like', '.item-reply', '.Button', '.dropdown', '.badge', '.toolbar',
    '.onebox', '.link-preview', '.attachment', '.image-metadata', '.file-info',
    '.lightbox-wrapper',
    '[hidden]', '[role="button"]', '[role="toolbar"]', '[aria-hidden="true"]',
    'button', 'input', 'select', 'textarea', 'option', 'form',
    '.advertisement', '.advert', '.ad', '.ads', '.ad-container'
  ].join(',');
  const SEMANTIC_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li']);
  const BLOCK_SEPARATOR_TAGS = new Set([
    'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DETAILS', 'DIALOG',
    'DIV', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM',
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HGROUP', 'HR', 'IFRAME',
    'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'SUMMARY', 'TABLE',
    'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL'
  ]);
  const REMOVABLE_CLASSES = new Set([
    'post-actions', 'post-controls', 'post-signature', 'post-meta',
    'message-signature', 'message-attribution-opposite', 'message-footer',
    'bbcodeblock--quote', 'quote', 'signature', 'reactions', 'reactionsbar',
    'item-like', 'item-reply', 'button', 'dropdown', 'badge', 'toolbar',
    'onebox', 'link-preview', 'attachment', 'image-metadata', 'file-info',
    'lightbox-wrapper', 'advertisement', 'advert', 'ad', 'ads', 'ad-container'
  ]);
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

  function fingerprint(value) {
    let hash = 2166136261;
    for (const character of String(value || '')) {
      hash ^= character.codePointAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function cleanText(value) {
    const helper = global.QwenReaderText && global.QwenReaderText.cleanText;
    return typeof helper === 'function' ? helper(value) : String(value == null ? '' : value).replace(/\s+/gu, ' ').trim();
  }

  function removableSelector(options) {
    return options && options.removeBlockquotes === false
      ? REMOVABLE_SELECTOR
      : `blockquote,${REMOVABLE_SELECTOR}`;
  }

  function toUnits(texts) {
    return texts.filter(Boolean).map((text, unitIndex) => ({
      text,
      unitIndex,
      fingerprint: fingerprint(text)
    }));
  }

  function safeAttribute(node, name) {
    if (!node || typeof node.getAttribute !== 'function') return '';
    try {
      return String(node.getAttribute(name) || '');
    } catch (_) {
      return '';
    }
  }

  function emojiAlt(className, altText) {
    const alt = String(altText || '');
    return EMOJI_IMAGE_CLASS_RE.test(String(className || ''))
      && alt.length <= 64
      && EMOJI_ALT_RE.test(alt)
      ? alt
      : '';
  }

  function inlineEmojiText(node) {
    const tag = String(node && (node.tagName || node.nodeName) || '').toUpperCase();
    if (tag !== 'IMG') return '';
    if (node.hidden === true || node.inert === true
      || safeAttribute(node, 'aria-hidden').toLowerCase() === 'true') return '';
    return emojiAlt(safeAttribute(node, 'class'), safeAttribute(node, 'alt'));
  }

  function replaceInlineEmojiImages(root) {
    if (!root || typeof root.querySelectorAll !== 'function') return;
    for (const image of root.querySelectorAll('img')) {
      const replacement = inlineEmojiText(image);
      if (!replacement) continue;
      try {
        if (image.parentNode && image.ownerDocument
          && typeof image.ownerDocument.createTextNode === 'function'
          && typeof image.parentNode.replaceChild === 'function') {
          image.parentNode.replaceChild(image.ownerDocument.createTextNode(replacement), image);
        } else if (typeof image.replaceWith === 'function') {
          image.replaceWith(replacement);
        }
      } catch (_) {}
    }
  }

  function removeReadableElement(node) {
    if (!node) return;
    const tag = String(node.tagName || node.nodeName || '').toUpperCase();
    try {
      if (BLOCK_SEPARATOR_TAGS.has(tag) && node.parentNode && node.ownerDocument
        && typeof node.ownerDocument.createTextNode === 'function'
        && typeof node.parentNode.replaceChild === 'function') {
        node.parentNode.replaceChild(node.ownerDocument.createTextNode(' '), node);
      } else if (BLOCK_SEPARATOR_TAGS.has(tag) && typeof node.replaceWith === 'function') {
        node.replaceWith(' ');
      } else if (typeof node.remove === 'function') {
        node.remove();
      }
    } catch (_) {}
  }

  function readableElementText(element, options) {
    if (!element || typeof element.cloneNode !== 'function') return '';
    const clone = element.cloneNode(true);
    if (clone && typeof clone.querySelectorAll === 'function') {
      replaceInlineEmojiImages(clone);
      for (const removable of clone.querySelectorAll(removableSelector(options))) removeReadableElement(removable);
      if (options && options.removeNestedSemanticElements) {
        for (const nested of clone.querySelectorAll(SEMANTIC_SELECTOR)) removeReadableElement(nested);
      }
    }
    return cleanText(clone && clone.textContent);
  }

  function semanticElements(root, options) {
    if (!root || typeof root.querySelectorAll !== 'function') return [];
    const selector = removableSelector(options);
    return Array.from(root.querySelectorAll(SEMANTIC_SELECTOR)).filter((element) => {
      if (typeof element.closest === 'function' && element.closest(selector)) return false;
      const descendants = typeof element.querySelectorAll === 'function'
        ? Array.from(element.querySelectorAll(SEMANTIC_SELECTOR))
        : [];
      if (!descendants.length) return Boolean(readableElementText(element, options));
      const elementText = readableElementText(element, options);
      const leafTexts = descendants
        .filter((child) => !child.querySelectorAll(SEMANTIC_SELECTOR).length)
        .map((child) => readableElementText(child, options))
        .filter(Boolean);
      return elementText !== cleanText(leafTexts.join(' '));
    });
  }

  function semanticUnitsFromElement(root, options) {
    const textOptions = Object.assign({}, options, { removeNestedSemanticElements: true });
    const texts = semanticElements(root, options)
      .map((element) => readableElementText(element, textOptions))
      .filter(Boolean);
    if (texts.length) return toUnits(texts);
    const lineTexts = root && typeof root.innerHTML === 'string' && /<br\b/iu.test(root.innerHTML)
      ? fallbackPlainLines(root.innerHTML, options)
      : [];
    if (lineTexts.length > 1) return toUnits(lineTexts);
    return toUnits([readableElementText(root, options)]);
  }

  function isRemovableTag(tag, attributes, options) {
    if (tag === 'blockquote') return !options || options.removeBlockquotes !== false;
    if (['script', 'style', 'noscript', 'template', 'svg', 'figure', 'nav', 'aside', 'footer', 'button', 'input', 'select', 'textarea', 'option', 'form'].includes(tag)) return true;
    if (/\b(?:hidden(?:\s|=|$)|role\s*=\s*["']?(?:button|toolbar)|aria-hidden\s*=\s*["']?true)\b/iu.test(attributes)) return true;
    const classMatch = attributes.match(/\bclass\s*=\s*(["'])(.*?)\1/iu);
    return Boolean(classMatch && classMatch[2].split(/\s+/u).some((name) => REMOVABLE_CLASSES.has(name.toLowerCase())));
  }

  function decodeEntities(value) {
    return String(value)
      .replace(/&#x([0-9a-f]+);?/giu, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
      .replace(/&#([0-9]+);?/gu, (_, decimal) => String.fromCodePoint(parseInt(decimal, 10)))
      .replace(/&(nbsp|amp|lt|gt|quot|apos);/giu, (_, name) => ({ nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[name.toLowerCase()]);
  }

  function htmlText(value) {
    return cleanText(decodeEntities(stripHtmlTags(value)));
  }

  function forEachHtmlToken(source, visitor) {
    const input = String(source || '');
    let textStart = 0;
    for (let index = 0; index < input.length; index += 1) {
      if (input[index] !== '<') continue;
      const comment = input.startsWith('<!--', index);
      const end = comment ? input.indexOf('-->', index + 4) : tagEnd(input, index + 1);
      if (end < 0) continue;
      visitor(input.slice(textStart, index), input.slice(index, comment ? end + 3 : end + 1), index);
      index = comment ? end + 2 : end;
      textStart = index + 1;
    }
    visitor(input.slice(textStart), '', input.length);
  }

  function tagEnd(input, start) {
    let quote = '';
    for (let index = start; index < input.length; index += 1) {
      const character = input[index];
      if (quote) {
        if (character === quote) quote = '';
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === '>') {
        return index;
      }
    }
    return -1;
  }

  function parseTag(raw) {
    const match = /^<\s*(\/)?\s*([a-z][\w:-]*)\b([\s\S]*?)>$/iu.exec(raw);
    if (!match) return null;
    return {
      closing: Boolean(match[1]),
      tag: match[2].toLowerCase(),
      attributes: match[3] || '',
      selfClosing: /\/\s*>$/u.test(raw)
    };
  }

  function attributeFromText(attributes, name) {
    const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const match = String(attributes || '').match(new RegExp(`\\b${escaped}\\s*=\\s*(["'])(.*?)\\1`, 'iu'));
    return match ? decodeEntities(match[2]) : '';
  }

  function inlineEmojiTextFromTag(parsed) {
    if (!parsed || parsed.closing || parsed.tag !== 'img') return '';
    return emojiAlt(
      attributeFromText(parsed.attributes, 'class'),
      attributeFromText(parsed.attributes, 'alt')
    );
  }

  function stripHtmlTags(value) {
    const pieces = [];
    forEachHtmlToken(value, (text) => pieces.push(text));
    return pieces.join(' ');
  }

  function fallbackTexts(html, options) {
    const source = String(html == null ? '' : html);
    const records = [];
    const semanticStack = [];
    const tagStack = [];
    let removableDepth = 0;
    forEachHtmlToken(source, (_, raw, rawIndex) => {
      const parsed = parseTag(raw);
      if (!parsed) return;
      const { tag, closing } = parsed;
      const selfClosing = parsed.selfClosing || ['img', 'br', 'hr', 'input', 'meta', 'link', 'source'].includes(tag);
      if (closing) {
        const opened = tagStack.pop();
        if (opened && opened.removable) removableDepth -= 1;
        if (SEMANTIC_TAGS.has(tag)) {
          const index = semanticStack.map((frame) => frame.tag).lastIndexOf(tag);
          if (index >= 0) {
            const frame = semanticStack.splice(index, 1)[0];
            frame.end = rawIndex;
            records.push(frame);
          }
        }
        return;
      }
      const removable = isRemovableTag(tag, parsed.attributes, options);
      const frame = SEMANTIC_TAGS.has(tag) && removableDepth === 0 ? {
        tag,
        start: rawIndex + raw.length,
        end: rawIndex + raw.length,
        childRanges: []
      } : null;
      if (frame) {
        const parent = semanticStack[semanticStack.length - 1];
        if (parent) parent.childRanges.push(frame);
        semanticStack.push(frame);
      }
      if (!selfClosing) {
        tagStack.push({ tag, removable });
        if (removable) removableDepth += 1;
      }
    });
    const texts = records.sort((left, right) => left.start - right.start).map((record) => {
      let inner = source.slice(record.start, record.end);
      for (const child of record.childRanges.sort((left, right) => right.start - left.start)) {
        inner = inner.slice(0, child.start - record.start) + inner.slice(child.end - record.start);
      }
      return fallbackPlainText(inner, options);
    }).filter(Boolean);
    if (texts.length) return texts;
    const lines = fallbackPlainLines(source, options);
    if (lines.length > 1) return lines;
    return [fallbackPlainText(source, options)].filter(Boolean);
  }

  function fallbackPlainLines(source, options) {
    const input = String(source || '');
    const tagStack = [];
    const pieces = [];
    let removableDepth = 0;
    forEachHtmlToken(input, (text, raw) => {
      if (removableDepth === 0) pieces.push(text);
      const parsed = parseTag(raw);
      if (!parsed) return;
      const { tag } = parsed;
      if (parsed.closing) {
        const opened = tagStack.pop();
        if (opened && opened.removable) removableDepth -= 1;
        return;
      }
      const removable = isRemovableTag(tag, parsed.attributes, options);
      const inlineEmoji = inlineEmojiTextFromTag(parsed);
      if (inlineEmoji && !removable && removableDepth === 0) pieces.push(inlineEmoji);
      if ((tag === 'br' || tag === 'wbr') && removableDepth === 0) pieces.push('\n');
      const selfClosing = parsed.selfClosing || ['img', 'br', 'hr', 'input', 'meta', 'link', 'source'].includes(tag);
      if (!selfClosing) {
        tagStack.push({ tag, removable });
        if (removable) removableDepth += 1;
      }
    });
    return decodeEntities(pieces.join(''))
      .replace(/\r\n?/gu, '\n')
      .split(/\n+/gu)
      .map(cleanText)
      .filter(Boolean);
  }

  function fallbackPlainText(source, options) {
    const input = String(source || '');
    const tagStack = [];
    const pieces = [];
    let removableDepth = 0;
    forEachHtmlToken(input, (text, raw) => {
      if (removableDepth === 0) pieces.push(text);
      const parsed = parseTag(raw);
      if (!parsed) return;
      const { tag } = parsed;
      if (parsed.closing) {
        const opened = tagStack.pop();
        if (opened && opened.removable) removableDepth -= 1;
        return;
      }
      const removable = isRemovableTag(tag, parsed.attributes, options);
      const inlineEmoji = inlineEmojiTextFromTag(parsed);
      if (inlineEmoji && !removable && removableDepth === 0) {
        pieces.push({ text: inlineEmoji, glueLeft: true, glueRight: true });
      } else if (tag === 'img' && removableDepth === 0) {
        // textContent omits ordinary and hidden images without inserting a
        // separator. Preserve that adjacency in the parser fallback too.
        pieces.push({ text: '', glueLeft: true, glueRight: true });
      }
      const selfClosing = parsed.selfClosing || ['img', 'br', 'hr', 'input', 'meta', 'link', 'source'].includes(tag);
      if (!selfClosing) {
        tagStack.push({ tag, removable });
        if (removable) removableDepth += 1;
      }
    });
    let joined = '';
    let glueRight = false;
    for (const piece of pieces) {
      const value = typeof piece === 'object' ? String(piece.text || '') : String(piece || '');
      const glueLeft = Boolean(piece && typeof piece === 'object' && piece.glueLeft);
      if (!value) {
        if (piece && typeof piece === 'object' && piece.glueRight) glueRight = true;
        continue;
      }
      if (joined && !glueRight && !glueLeft) joined += ' ';
      joined += value;
      glueRight = Boolean(piece && typeof piece === 'object' && piece.glueRight);
    }
    return cleanText(decodeEntities(joined));
  }

  function semanticUnitsFromHtml(html, options) {
    const DOMParserCtor = options && options.DOMParserCtor || global.DOMParser;
    if (typeof DOMParserCtor === 'function') {
      const document = new DOMParserCtor().parseFromString(String(html == null ? '' : html), 'text/html');
      if (document && document.body) return semanticUnitsFromElement(document.body, options);
    }
    return toUnits(fallbackTexts(html, options));
  }

  global.QwenReaderForumContent = Object.freeze({
    fingerprint,
    inlineEmojiText,
    semanticUnitsFromHtml,
    semanticUnitsFromElement,
    semanticElements,
    readableElementText
  });
})(globalThis);
