const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadModules() {
  delete globalThis.QwenReaderText;
  delete globalThis.QwenReaderForumContent;
  delete globalThis.QwenReaderSentenceRange;
  for (const relativePath of ['shared/text.js', 'shared/forum-content.js', 'shared/sentence-range.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
    vm.runInThisContext(source, { filename: relativePath });
  }
  return {
    forum: globalThis.QwenReaderForumContent,
    range: globalThis.QwenReaderSentenceRange
  };
}

function text(value) {
  return { nodeType: 3, nodeName: '#text', nodeValue: value, childNodes: [] };
}

function element(tagName, children = [], attributes = {}) {
  return {
    nodeType: 1,
    nodeName: tagName.toUpperCase(),
    tagName: tagName.toUpperCase(),
    childNodes: children,
    hidden: Boolean(attributes.hidden),
    inert: Boolean(attributes.inert),
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attributes, name) ? attributes[name] : null;
    }
  };
}

test('ordinary and hidden inline images keep extraction and range text adjacent', () => {
  const { forum, range } = loadModules();
  let visibleEmoji = '';
  let hiddenInline = '隐藏文字';
  const visibleEmojiClone = {
    tagName: 'IMG',
    getAttribute(name) { return name === 'class' ? 'emoji' : name === 'alt' ? '🙂' : null; },
    replaceWith(value) { visibleEmoji = value; }
  };
  const ordinaryImageClone = {
    tagName: 'IMG',
    getAttribute(name) { return name === 'class' ? 'attachment' : name === 'alt' ? 'image350×318' : null; },
    remove() {}
  };
  const hiddenEmojiClone = {
    tagName: 'IMG',
    getAttribute(name) {
      if (name === 'class') return 'emoji';
      if (name === 'alt') return '😭';
      if (name === 'aria-hidden') return 'true';
      return null;
    },
    remove() {}
  };
  const hiddenOrdinaryClone = {
    tagName: 'IMG',
    hidden: true,
    getAttribute(name) { return name === 'alt' ? 'decorative' : null; },
    remove() {}
  };
  const hiddenSpanClone = {
    tagName: 'SPAN',
    getAttribute(name) { return name === 'aria-hidden' ? 'true' : null; },
    remove() { hiddenInline = ''; }
  };
  const extractElement = {
    cloneNode() {
      return {
        get textContent() { return `前${visibleEmoji}${hiddenInline}后。`; },
        querySelectorAll(selector) {
          if (selector === 'img') {
            return [visibleEmojiClone, ordinaryImageClone, hiddenEmojiClone, hiddenOrdinaryClone];
          }
          if (selector.includes('[aria-hidden="true"]') || selector.includes('[hidden]')) {
            return [hiddenEmojiClone, hiddenOrdinaryClone, hiddenSpanClone];
          }
          return [];
        }
      };
    }
  };

  const extracted = forum.readableElementText(extractElement);
  const opening = text('前');
  const ending = text('后。');
  const rangeRoot = element('p', [
    opening,
    element('img', [], { class: 'emoji', alt: '🙂' }),
    element('img', [], { class: 'attachment', alt: 'image350×318' }),
    element('img', [], { class: 'emoji', alt: '😭', 'aria-hidden': 'true' }),
    element('img', [], { alt: 'decorative', hidden: true }),
    element('span', [text('隐藏文字')], { 'aria-hidden': 'true' }),
    ending
  ]);
  const index = range.buildTextIndex(rangeRoot);
  const match = range.findSegment(index, extracted, 0);

  assert.equal(extracted, '前🙂后。');
  assert.equal(index.normalizedText, extracted);
  assert.ok(match);
  assert.equal(match.startContainer, opening);
  assert.equal(match.endContainer, ending);
  assert.deepEqual(range.findSubranges(index, match, ['前', '后']).map((word) => word && word.text), ['前', '后']);
});

test('aria-hidden inline content is skipped while an aria-hidden block preserves one boundary', () => {
  const { forum, range } = loadModules();
  let hiddenInline = '内联隐藏';
  let hiddenBlock = '块隐藏';
  let blockBoundary = '';
  const inlineClone = {
    tagName: 'SPAN',
    getAttribute(name) { return name === 'aria-hidden' ? 'true' : null; },
    remove() { hiddenInline = ''; }
  };
  const blockClone = {
    tagName: 'DIV',
    getAttribute(name) { return name === 'aria-hidden' ? 'true' : null; },
    replaceWith(value) {
      hiddenBlock = '';
      blockBoundary = value;
    }
  };
  const extractElement = {
    cloneNode() {
      return {
        get textContent() { return `甲${hiddenInline}${blockBoundary}${hiddenBlock}乙。`; },
        querySelectorAll(selector) {
          if (selector === 'img') return [];
          if (selector.includes('[aria-hidden="true"]')) return [inlineClone, blockClone];
          return [];
        }
      };
    }
  };

  const extracted = forum.readableElementText(extractElement);
  const opening = text('甲');
  const ending = text('乙。');
  const rangeRoot = element('div', [
    opening,
    element('span', [text('内联隐藏')], { 'aria-hidden': 'true' }),
    element('div', [text('块隐藏')], { 'aria-hidden': 'true' }),
    ending
  ]);
  const index = range.buildTextIndex(rangeRoot);
  const match = range.findSegment(index, extracted, 0);

  assert.equal(extracted, '甲 乙。');
  assert.equal(index.normalizedText, extracted);
  assert.ok(match);
  assert.equal(range.findSegment(index, '甲乙。', 0), null);
  assert.deepEqual(range.findSubranges(index, match, ['甲', '乙']).map((word) => word && word.text), ['甲', '乙']);
});
