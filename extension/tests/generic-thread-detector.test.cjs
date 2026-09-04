const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadDetector() {
  delete globalThis.QwenReaderText;
  delete globalThis.QwenReaderForumContent;
  delete globalThis.QwenReaderGenericThreadDetector;
  for (const relativePath of [
    'shared/text.js',
    'shared/forum-content.js',
    'shared/generic-thread-detector.js'
  ]) {
    const source = fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
    vm.runInThisContext(source, { filename: relativePath });
  }
  return globalThis.QwenReaderGenericThreadDetector;
}

function paragraph(textContent) {
  return {
    tagName: 'P',
    textContent,
    closest: () => null,
    querySelectorAll: () => [],
    cloneNode: () => ({ textContent, querySelectorAll: () => [] })
  };
}

function post(id, floor, authorId, authorName, textContent) {
  const content = paragraph(textContent);
  const body = {
    textContent,
    querySelectorAll(selector) {
      return selector === 'p,h1,h2,h3,h4,h5,h6,li' ? [content] : [];
    },
    cloneNode: () => ({ textContent, querySelectorAll: () => [] })
  };
  const author = {
    textContent: authorName,
    getAttribute(name) {
      if (name === 'data-user-id') return authorId;
      return null;
    }
  };
  return {
    textContent: `${authorName} ${textContent}`,
    getAttribute(name) {
      if (name === 'data-post-id') return id;
      if (name === 'data-post-number') return String(floor);
      if (name === 'class') return 'forum-post';
      return null;
    },
    querySelector(selector) {
      if (selector === '.post-body') return body;
      if (selector === '[rel="author"]') return author;
      return null;
    }
  };
}

test('detects an unknown repeated thread and preserves OP identity across later posts', () => {
  const detector = loadDetector();
  const posts = [
    post('101', 1, 'u1', '楼主', '这是首帖的完整正文。'),
    post('102', 2, 'u2', '回复者', '这是另一位作者的回复。'),
    post('103', 3, 'u1', '楼主', '楼主继续补充更多信息。')
  ];
  const document = {
    querySelectorAll(selector) {
      return selector === '[data-post-id]' ? posts : [];
    }
  };

  const result = detector.detect(document);
  const blocks = detector.toBlocks(result);

  assert.equal(result.adapterId, 'generic-thread');
  assert.ok(['medium', 'high'].includes(result.confidence));
  assert.deepEqual(blocks.map((block) => block.text), [
    '这是首帖的完整正文。',
    '这是另一位作者的回复。',
    '楼主继续补充更多信息。'
  ]);
  assert.deepEqual(blocks.map((block) => block.isOp), [true, false, true]);
  assert.deepEqual(blocks.map((block) => block.floor), [1, 2, 3]);
  assert.ok(blocks.every((block) => block.sourceLocator.adapter === 'generic-thread'));
});

test('does not classify two ordinary article elements as a forum thread', () => {
  const detector = loadDetector();
  const articles = [
    post('a1', 1, '', '', '普通文章的第一部分。'),
    post('a2', 2, '', '', '普通文章的第二部分。')
  ].map((entry) => Object.assign({}, entry, {
    getAttribute(name) {
      if (name === 'class') return 'article-section';
      return null;
    }
  }));
  const document = {
    querySelectorAll(selector) {
      return selector === 'article' ? articles : [];
    }
  };

  assert.equal(detector.detect(document), null);
});
