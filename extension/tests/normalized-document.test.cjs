const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadNormalizedDocument() {
  delete globalThis.QwenReaderText;
  delete globalThis.QwenReaderNormalizedDocument;
  delete globalThis.QwenReaderDocument;
  const textPath = path.join(__dirname, '..', 'shared', 'text.js');
  vm.runInThisContext(fs.readFileSync(textPath, 'utf8'), {
    filename: 'shared/text.js'
  });
  const modulePath = path.join(__dirname, '..', 'shared', 'normalized-document.js');
  if (fs.existsSync(modulePath)) {
    vm.runInThisContext(fs.readFileSync(modulePath, 'utf8'), {
      filename: 'shared/normalized-document.js'
    });
  }
  return globalThis.QwenReaderNormalizedDocument;
}

test('pageKey removes a floor hash without changing the topic URL', () => {
  const model = loadNormalizedDocument();

  assert.equal(
    model.pageKey({ href: 'https://forum.example/community/t/topic/42#post_7' }),
    'https://forum.example/community/t/topic/42'
  );
});

test('pageKey preserves hash-router navigation and exports the reader-facing alias', () => {
  const model = loadNormalizedDocument();

  assert.equal(globalThis.QwenReaderDocument, model);
  assert.equal(
    model.makePageKey('https://reader.example/app#/chapter/8'),
    'https://reader.example/app#/chapter/8'
  );
});

test('createBlock preserves a non-empty one-character forum reply', () => {
  const model = loadNormalizedDocument();

  assert.deepEqual(model.createBlock({
    id: 'discourse:post:2',
    type: 'forum-post',
    text: ' 顶 ',
    authorId: 7,
    floor: '2',
    isOp: false
  }), {
    id: 'discourse:post:2',
    type: 'forum-post',
    text: '顶',
    authorId: '7',
    authorName: '',
    floor: 2,
    isOp: false,
    postId: '',
    sourceKey: '',
    sourceSelector: '',
    sourceLocator: null
  });
});

test('createDocument filters only empty blocks and records extraction metadata', () => {
  const model = loadNormalizedDocument();
  const document = model.createDocument({
    url: 'https://forum.example/t/42#post_3',
    title: ' 主题 ',
    adapterId: 'discourse',
    complete: false,
    warnings: ['missing-posts:3'],
    blocks: [
      { id: '1', text: '正文' },
      { id: '2', text: '   ' }
    ]
  });

  assert.equal(document.pageKey, 'https://forum.example/t/42');
  assert.equal(document.title, '主题');
  assert.equal(document.complete, false);
  assert.deepEqual(document.warnings, ['missing-posts:3']);
  assert.deepEqual(document.blocks.map((block) => block.text), ['正文']);
});

test('toPlaybackSegments is the single chunking point and preserves speaker metadata', () => {
  const model = loadNormalizedDocument();
  const locator = {
    adapter: 'discourse',
    containerSelector: 'article[data-post-id="9"] .cooked, article#post_9 .cooked',
    unitIndex: 3,
    fingerprint: 'abc123'
  };
  const document = model.createDocument({
    url: 'https://forum.example/t/42',
    adapterId: 'discourse',
    blocks: [{
      id: 'discourse:post:9',
      text: '第一句。第二句。',
      authorId: 'op',
      authorName: '楼主',
      isOp: true,
      floor: 9,
      sourceSelector: '[data-post-id="9"]',
      sourceLocator: locator
    }]
  });

  const chunks = model.toPlaybackSegments(document, 5);

  assert.equal(chunks.length, 2);
  assert.deepEqual(chunks.map((chunk) => chunk.id), [
    'discourse:post:9:0',
    'discourse:post:9:1'
  ]);
  assert.deepEqual(chunks.map((chunk) => chunk.text), ['第一句。', '第二句。']);
  assert.deepEqual(chunks.map((chunk) => chunk.speechText), ['第一句。', '第二句。']);
  assert.equal(chunks[0].speechSourceMap.sourceText, '第一句。');
  assert.ok(chunks[0].speechSourceMap.ranges.length > 0);
  assert.equal(chunks[1].authorId, 'op');
  assert.equal(chunks[1].isOp, true);
  assert.equal(chunks[1].sourceSelector, '[data-post-id="9"]');
  assert.deepEqual(chunks[0].sourceLocator, locator);
  assert.deepEqual(chunks[1].sourceLocator, locator);
  assert.notEqual(chunks[0].sourceLocator, locator);
  assert.notEqual(chunks[0].sourceLocator, chunks[1].sourceLocator);
});

test('toPlaybackSegments preserves source text while attaching emoji-safe speech mapping', () => {
  const model = loadNormalizedDocument();
  const document = model.createDocument({
    url: 'https://reader.example/article',
    blocks: [{ id: 'paragraph-1', text: '你好👋🏽世界！！' }]
  });

  const [segment] = model.toPlaybackSegments(document, 260);

  assert.equal(segment.text, '你好👋🏽世界！！');
  assert.equal(segment.speechText, '你好世界！');
  assert.equal(segment.speechSourceMap.sourceText, segment.text);
  assert.equal(segment.speechSourceMap.speechText, segment.speechText);
});

test('toPlaybackSegments defensively filters punctuation-only chunks and preserves valid metadata', () => {
  const model = loadNormalizedDocument();
  const locator = {
    adapter: 'flarum',
    containerSelector: 'article[data-id="77"] .Post-body',
    unitIndex: 2,
    fingerprint: 'valid-77'
  };
  globalThis.QwenReaderText = Object.assign({}, globalThis.QwenReaderText, {
    splitText() {
      return ['\u3002\u3002\u3002', '\u6709\u6548\u6b63\u6587\u3002'];
    }
  });
  const document = model.createDocument({
    url: 'https://forum.example/d/77',
    adapterId: 'flarum',
    blocks: [{
      id: 'flarum:post:77',
      type: 'forum-post',
      text: '\u539f\u59cb\u6b63\u6587',
      authorId: 'author-77',
      authorName: '\u4f5c\u8005',
      floor: 7,
      isOp: true,
      postId: '77',
      sourceKey: 'flarum:77:7',
      sourceSelector: '[data-id="77"]',
      sourceLocator: locator
    }]
  });

  const segments = model.toPlaybackSegments(document, 260);

  assert.equal(segments.length, 1);
  assert.equal(segments[0].text, '\u6709\u6548\u6b63\u6587\u3002');
  assert.equal(segments[0].authorId, 'author-77');
  assert.equal(segments[0].authorName, '\u4f5c\u8005');
  assert.equal(segments[0].floor, 7);
  assert.equal(segments[0].isOp, true);
  assert.equal(segments[0].postId, '77');
  assert.equal(segments[0].sourceKey, 'flarum:77:7');
  assert.equal(segments[0].sourceSelector, '[data-id="77"]');
  assert.deepEqual(segments[0].sourceLocator, locator);
  assert.notEqual(segments[0].sourceLocator, locator);
});

test('createBlock rejects malformed source locators without retaining caller objects', () => {
  const model = loadNormalizedDocument();
  const locator = { adapter: 'flarum', containerSelector: '.Post-body', unitIndex: 0, fingerprint: 'abc123' };

  const valid = model.createBlock({ id: 'valid', text: 'Text', sourceLocator: locator });
  const invalid = model.createBlock({ id: 'invalid', text: 'Text', sourceLocator: { ...locator, unitIndex: false } });

  assert.deepEqual(valid.sourceLocator, locator);
  assert.notEqual(valid.sourceLocator, locator);
  assert.equal(invalid.sourceLocator, null);
});
