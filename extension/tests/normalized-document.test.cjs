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
    sourceSelector: ''
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
      sourceSelector: '[data-post-id="9"]'
    }]
  });

  const chunks = model.toPlaybackSegments(document, 5);

  assert.equal(chunks.length, 2);
  assert.deepEqual(chunks.map((chunk) => chunk.id), [
    'discourse:post:9:0',
    'discourse:post:9:1'
  ]);
  assert.deepEqual(chunks.map((chunk) => chunk.text), ['第一句。', '第二句。']);
  assert.equal(chunks[1].authorId, 'op');
  assert.equal(chunks[1].isOp, true);
  assert.equal(chunks[1].sourceSelector, '[data-post-id="9"]');
});
