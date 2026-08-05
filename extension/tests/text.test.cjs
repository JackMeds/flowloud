const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadTextModule() {
  delete globalThis.QwenReaderText;
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'shared', 'text.js'),
    'utf8'
  );
  vm.runInThisContext(source, { filename: 'text.js' });
  return globalThis.QwenReaderText;
}

test('cleanText normalizes Chinese whitespace and removes pasted URLs', () => {
  const { cleanText } = loadTextModule();

  assert.equal(
    cleanText('  第一段\n\n　第二段   https://example.com/read?id=7  '),
    '第一段 第二段'
  );
});

test('makeSegment keeps a two-character short reply with its source identity', () => {
  const { makeSegment } = loadTextModule();

  assert.deepEqual(
    makeSegment({
      id: 'post-12',
      floor: 12,
      authorId: 'user-8',
      authorName: '小林',
      isOp: false,
      text: '同意',
      sourceKey: 'flarum:23351:12'
    }),
    {
      id: 'post-12',
      floor: 12,
      authorId: 'user-8',
      authorName: '小林',
      isOp: false,
      text: '同意',
      sourceKey: 'flarum:23351:12'
    }
  );
});

test('splitText keeps punctuation boundaries and never exceeds 260 characters', () => {
  const { splitText } = loadTextModule();
  const firstSentence = `${'甲'.repeat(250)}。`;
  const secondSentence = `${'乙'.repeat(20)}！`;

  const chunks = splitText(`${firstSentence}${secondSentence}`, 260);

  assert.deepEqual(chunks, [firstSentence, secondSentence]);
  assert.ok(chunks.every((chunk) => chunk.length <= 260));
});

test('splitText breaks an overlong sentence exactly at the requested limit', () => {
  const { splitText } = loadTextModule();
  const text = '字'.repeat(261);

  assert.deepEqual(splitText(text, 260), ['字'.repeat(260), '字']);
});

test('splitText treats a paragraph newline as a preferred boundary', () => {
  const { splitText } = loadTextModule();

  assert.deepEqual(splitText('第一段\n第二段', 260), ['第一段', '第二段']);
});
