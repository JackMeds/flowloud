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

test('splitText keeps consecutive sentence punctuation in one boundary and emits no punctuation-only chunks', () => {
  const { splitText } = loadTextModule();
  const chunks = splitText(
    '\u6b63\u6587\u3002\u3002\u3002\u3002\u3002\u3002\u4e0b\u4e00\u53e5\u3002',
    260
  );

  assert.deepEqual(chunks, [
    '\u6b63\u6587\u3002\u3002\u3002\u3002\u3002\u3002',
    '\u4e0b\u4e00\u53e5\u3002'
  ]);
  assert.ok(chunks.every((chunk) => /[\p{L}\p{N}]/u.test(chunk)));
});

test('splitText groups mixed terminal punctuation instead of creating a standalone punctuation segment', () => {
  const { splitText } = loadTextModule();

  assert.deepEqual(
    splitText('\u771f\u7684\uff1f\uff01\u4e0b\u4e00\u53e5\u3002', 260),
    ['\u771f\u7684\uff1f\uff01', '\u4e0b\u4e00\u53e5\u3002']
  );
});

test('splitText keeps closing quotes with the sentence punctuation cluster', () => {
  const { splitText } = loadTextModule();

  assert.deepEqual(splitText('“真的？！”她问。', 260), ['“真的？！”', '她问。']);
});

test('splitText never emits trailing punctuation after an exact length boundary', () => {
  const { splitText } = loadTextModule();
  const prose = '字'.repeat(260);

  assert.deepEqual(splitText(`${prose}。。。。`, 260), [prose]);
});

test('splitText drops input made only of punctuation', () => {
  const { splitText } = loadTextModule();

  assert.deepEqual(
    splitText('\u3002\u3002\u3002\u3002\u3002\u3002\n\u2026\u2026\n......', 260),
    []
  );
});

test('splitText still preserves short legitimate replies', () => {
  const { splitText } = loadTextModule();

  assert.deepEqual(
    splitText('\u55ef\u3002\n1\u3002', 260),
    ['\u55ef\u3002', '1\u3002']
  );
});

test('prepareSpeechText softens excessive punctuation without changing normal prose', () => {
  const { prepareSpeechText } = loadTextModule();

  assert.equal(prepareSpeechText('正文。。。。。。下一句.....'), '正文。下一句…');
  assert.equal(prepareSpeechText('真的！！！！'), '真的！');
  assert.equal(prepareSpeechText('正常的一句话。'), '正常的一句话。');
  assert.equal(prepareSpeechText('。。。。……'), '');
});

test('prepareSpeech removes complete emoji grapheme clusters without changing source text', () => {
  const { prepareSpeech } = loadTextModule();
  const sourceText = '开始👨‍👩‍👧‍👦继续！！';
  const prepared = prepareSpeech(sourceText);

  assert.equal(prepared.sourceText, sourceText);
  assert.equal(prepared.speechText, '开始继续！');
  assert.ok(prepared.ranges.length > 0);
  assert.ok(prepared.ranges.every((range) => range.sourceEnd <= sourceText.length));
});

test('prepareSpeech removes flags, keycaps and emoji modifiers as complete graphemes', () => {
  const { prepareSpeech } = loadTextModule();

  assert.equal(prepareSpeech('你好 🇨🇳 世界').speechText, '你好 世界');
  assert.equal(prepareSpeech('版本 2️⃣ 已发布 👍🏽').speechText, '版本 已发布');
  assert.equal(prepareSpeech('👨‍👩‍👧‍👦……').speechText, '');
});

test('prepareSpeech keeps non-emoji combining graphemes intact', () => {
  const { prepareSpeech } = loadTextModule();
  const text = 'Cafe\u0301 已完成';

  assert.equal(prepareSpeech(text).speechText, text);
});

test('mapSpeechRange maps a spoken phrase back across removed emoji', () => {
  const { prepareSpeech, mapSpeechRange } = loadTextModule();
  const prepared = prepareSpeech('开始👨‍👩‍👧‍👦继续！！');

  assert.deepEqual(mapSpeechRange(prepared, 2, 4), {
    sourceStart: 13,
    sourceEnd: 15
  });
  assert.deepEqual(mapSpeechRange(prepared, 4, 5), {
    sourceStart: 15,
    sourceEnd: 17
  });
});

test('segmentSentences uses Unicode sentence boundaries for Latin prose', () => {
  const { segmentSentences } = loadTextModule();

  assert.deepEqual(
    segmentSentences('First sentence. Second sentence!'),
    ['First sentence.', 'Second sentence!']
  );
});

test('findNextSpeakableIndex skips stale punctuation-only queue entries', () => {
  const { findNextSpeakableIndex } = loadTextModule();
  const queue = [{ text: '。。。' }, { text: '……' }, { text: '嗯。' }];

  assert.equal(findNextSpeakableIndex(queue, 0), 2);
  assert.equal(findNextSpeakableIndex(queue, 3), -1);
});

test('splitText treats a paragraph newline as a preferred boundary', () => {
  const { splitText } = loadTextModule();

  assert.deepEqual(splitText('第一段\n第二段', 260), ['第一段', '第二段']);
});
