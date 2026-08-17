const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadSentenceRange() {
  delete globalThis.QwenReaderSentenceRange;
  const source = fs.readFileSync(path.join(__dirname, '..', 'shared', 'sentence-range.js'), 'utf8');
  vm.runInThisContext(source, { filename: 'sentence-range.js' });
  return globalThis.QwenReaderSentenceRange;
}

function text(value) {
  return {
    nodeType: 3,
    nodeName: '#text',
    nodeValue: value,
    textContent: value,
    childNodes: []
  };
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

test('buildTextIndex normalizes whitespace while retaining exact text-node offsets', () => {
  const api = loadSentenceRange();
  const first = text('  Hello\u00a0 ');
  const second = text('world');
  const punctuation = text('!  ');
  const root = element('div', [first, element('span', [second]), punctuation]);

  const index = api.buildTextIndex(root);

  assert.equal(index.normalizedText, 'Hello world!');
  assert.equal(index.length, 12);
  assert.deepEqual(index.charMap[0].start, { node: first, offset: 2 });
  assert.deepEqual(index.charMap[4].end, { node: first, offset: 7 });
  assert.deepEqual(index.charMap[6].start, { node: second, offset: 0 });
  assert.deepEqual(index.charMap[11].end, { node: punctuation, offset: 1 });
});

test('block boundaries form one normalized separator across an element stream', () => {
  const api = loadSentenceRange();
  const first = text('First paragraph.');
  const second = text('Second paragraph.');

  const index = api.buildTextIndex([
    element('p', [first]),
    element('p', [second])
  ]);

  assert.equal(index.normalizedText, 'First paragraph. Second paragraph.');
  const match = api.findSegment(index, 'paragraph.\n Second');
  assert.equal(match.startContainer, first);
  assert.equal(match.startOffset, 6);
  assert.equal(match.endContainer, second);
  assert.equal(match.endOffset, 6);
});

test('findSegment returns DOM Range-like boundaries spanning inline text nodes', () => {
  const api = loadSentenceRange();
  const opening = text('Alpha ');
  const emphasis = text('beta');
  const closing = text(' gamma');
  const root = element('p', [opening, element('em', [emphasis]), closing]);

  const match = api.findSegment(root, 'beta   gamma');

  assert.deepEqual(match.start, { node: emphasis, offset: 0 });
  assert.deepEqual(match.end, { node: closing, offset: 6 });
  assert.equal(match.startContainer, emphasis);
  assert.equal(match.startOffset, 0);
  assert.equal(match.endContainer, closing);
  assert.equal(match.endOffset, 6);
  assert.equal(match.text, 'beta gamma');
});

test('preceding normalized offset selects repeated sentence chunks sequentially', () => {
  const api = loadSentenceRange();
  const content = text('Repeat this. A bridge. Repeat this.');
  const index = api.buildTextIndex(element('p', [content]));

  const first = api.findSegment(index, 'Repeat this.', 0);
  const second = api.findSegment(index, 'Repeat this.', first.nextOffset);

  assert.equal(first.normalizedStart, 0);
  assert.equal(first.normalizedEnd, 12);
  assert.equal(second.normalizedStart, 23);
  assert.equal(second.startContainer, content);
  assert.equal(second.startOffset, 23);
  assert.equal(api.findSegment(index, 'Repeat this.', second.nextOffset), null);
});

test('findSegments advances its cursor for every successful repeated match', () => {
  const api = loadSentenceRange();
  const content = text('Same. Same. Same.');
  const matches = api.findSegments(element('p', [content]), ['Same.', 'Same.', 'Same.']);

  assert.deepEqual(matches.map((match) => match.normalizedStart), [0, 6, 12]);
  assert.deepEqual(matches.map((match) => match.startOffset), [0, 6, 12]);
});

test('findSubranges resolves ordered words inside a matched sentence across inline nodes', () => {
  const api = loadSentenceRange();
  const opening = text('Alpha ');
  const emphasis = text('beta');
  const closing = text(' gamma!');
  const root = element('p', [opening, element('em', [emphasis]), closing]);
  const sentence = api.findSegment(root, 'Alpha beta gamma!', 0);
  const sourceText = 'Alpha beta gamma!';

  const matches = api.findSubranges(root, sentence, [
    { sourceText, sourceStart: 0, sourceEnd: 5 },
    { sourceText, sourceStart: 6, sourceEnd: 10 },
    { sourceText, sourceStart: 11, sourceEnd: 16 }
  ]);

  assert.deepEqual(matches.map((match) => match && match.text), ['Alpha', 'beta', 'gamma']);
  assert.equal(matches[0].startContainer, opening);
  assert.equal(matches[1].startContainer, emphasis);
  assert.equal(matches[2].startContainer, closing);
  assert.deepEqual(matches.map((match) => [match.sourceStart, match.sourceEnd]), [
    [0, 5], [6, 10], [11, 16]
  ]);
});

test('findSubranges uses a sequential cursor for repeated words and stays inside the sentence bounds', () => {
  const api = loadSentenceRange();
  const content = text('Same. Same Same.');
  const root = element('p', [content]);
  const sentence = api.findSegment(root, 'Same Same.', 6);
  const matches = api.findSubranges(root, sentence, ['Same', 'Same']);

  assert.deepEqual(matches.map((match) => match && match.normalizedStart), [6, 11]);
  assert.equal(api.findSubrange(root, sentence, 'Same. Same Same.', sentence.normalizedStart), null);
});

test('findSubranges maps source offsets around removed emoji without treating UTF-16 offsets as DOM offsets', () => {
  const api = loadSentenceRange();
  const content = text('开始👋世界。');
  const root = element('p', [content]);
  const sentence = api.findSegment(root, '开始👋世界。', 0);
  const sourceText = '开始👋世界。';
  const matches = api.findSubranges(root, sentence, [
    { sourceText, sourceStart: 0, sourceEnd: 2 },
    { sourceText, sourceStart: 4, sourceEnd: 6 }
  ]);

  assert.deepEqual(matches.map((match) => match && match.text), ['开始', '世界']);
  assert.equal(matches[1].startOffset, 4);
  assert.equal(matches[1].endOffset, 6);
});

test('Flarum emoji images preserve the first sentence range and word mapping in a long shared paragraph', () => {
  const api = loadSentenceRange();
  const opening = text('这几天摸乳头怎么没有感觉了');
  const continuation = text('，感受不到快感了，我这几天开发的也不频繁啊。今天下午午睡起来碰乳头不管是轻点，上下拨还是揉，捏，提拉都没什么快感，好难过。');
  const afterBreak = text('突然很好奇大家看片的时候会不会代入自己。');
  const firstEmoji = element('img', [], { class: 'emoji', alt: '😭' });
  const secondEmoji = element('img', [], { class: 'emoji', alt: '😭' });
  const paragraph = element('p', [
    opening,
    firstEmoji,
    secondEmoji,
    continuation,
    element('br'),
    afterBreak
  ]);
  const postBody = element('div', [paragraph]);
  const firstSentence = '这几天摸乳头怎么没有感觉了😭😭，感受不到快感了，我这几天开发的也不频繁啊。';

  const index = api.buildTextIndex(postBody);
  const match = api.findSegment(index, firstSentence, 0);

  assert.ok(match);
  assert.equal(index.normalizedText.startsWith(firstSentence), true);
  assert.equal(match.startContainer, opening);
  assert.equal(match.startOffset, 0);
  assert.equal(match.endContainer, continuation);
  assert.equal(match.endOffset, continuation.nodeValue.indexOf('。') + 1);
  const wordTexts = ['这几天', '感受不到', '不频繁'];
  const wordSpecs = wordTexts.map((word) => {
    const sourceStart = firstSentence.indexOf(word);
    return { sourceText: firstSentence, sourceStart, sourceEnd: sourceStart + word.length };
  });
  assert.deepEqual(api.findSubranges(index, match, wordSpecs).map((word) => word && word.text), [
    '这几天', '感受不到', '不频繁'
  ]);

  const secondSentence = api.findSegment(index, '今天下午午睡起来碰乳头不管是轻点，上下拨还是揉，捏，提拉都没什么快感，好难过。', match.nextOffset);
  assert.ok(secondSentence);
  assert.equal(secondSentence.startContainer, continuation);
  assert.equal(api.findSegment(index, '突然很好奇大家看片的时候会不会代入自己。', secondSentence.nextOffset).startContainer, afterBreak);
});

test('only trusted emoji images contribute alt text to range matching', () => {
  const api = loadSentenceRange();
  const root = element('p', [
    text('前'),
    element('img', [], { class: 'emoji', alt: '😭' }),
    element('img', [], { class: 'attachment', alt: 'image350×318 24.5 KB' }),
    element('img', [], { class: 'emoji', alt: 'not-an-emoji' }),
    text('后。')
  ]);

  const index = api.buildTextIndex(root);

  assert.equal(index.normalizedText, '前😭后。');
  assert.ok(api.findSegment(index, '前😭后。'));
  assert.equal(api.findSegment(index, '前image350×318 24.5 KB后。'), null);
});

test('emoji-only projection reconciles a textContent segment that omitted live emoji images', () => {
  const api = loadSentenceRange();
  const opening = text('正文');
  const ending = text('续文。');
  const root = element('p', [
    opening,
    element('img', [], { class: 'emoji', alt: '😭' }),
    ending
  ]);
  const index = api.buildTextIndex(root);

  const match = api.findSegment(index, '正文续文。', 0);

  assert.ok(match);
  assert.equal(match.emojiProjected, true);
  assert.equal(match.startContainer, opening);
  assert.equal(match.endContainer, ending);
  assert.deepEqual(api.findSubranges(index, match, ['正文', '续文']).map((word) => word && word.text), ['正文', '续文']);
});

test('repeated emoji sentences advance sequentially without losing punctuation boundaries', () => {
  const api = loadSentenceRange();
  const firstText = text('同一句');
  const middle = text('！同一句');
  const ending = text('！');
  const root = element('p', [
    firstText,
    element('img', [], { class: 'twemoji extra', alt: '🙂' }),
    middle,
    element('img', [], { class: 'emojione', alt: '🙂' }),
    ending
  ]);
  const index = api.buildTextIndex(root);

  const first = api.findSegment(index, '同一句🙂！', 0);
  const second = api.findSegment(index, '同一句🙂！', first.nextOffset);

  assert.ok(first);
  assert.ok(second);
  assert.equal(first.normalizedStart, 0);
  assert.equal(second.normalizedStart, first.normalizedEnd);
  assert.equal(second.endContainer, ending);
  assert.equal(second.endOffset, 1);
});

test('emoji-projected repeated sentences still honor the preceding cursor', () => {
  const api = loadSentenceRange();
  const firstOpening = text('同一句');
  const firstEnding = text('。');
  const secondOpening = text('同一句');
  const secondEnding = text('。');
  const root = element('div', [
    element('p', [firstOpening, element('img', [], { class: 'emoji', alt: '🙂' }), firstEnding]),
    element('p', [secondOpening, element('img', [], { class: 'emoji', alt: '🙂' }), secondEnding])
  ]);
  const index = api.buildTextIndex(root);

  const first = api.findSegment(index, '同一句。', 0);
  const second = api.findSegment(index, '同一句。', first.nextOffset);

  assert.equal(first.emojiProjected, true);
  assert.equal(second.emojiProjected, true);
  assert.equal(first.startContainer, firstOpening);
  assert.equal(second.startContainer, secondOpening);
  assert.ok(second.normalizedStart > first.normalizedStart);
});

test('scripts styles buttons forms controls and hidden content never enter the index', () => {
  const api = loadSentenceRange();
  const root = element('article', [
    text('Readable'),
    element('script', [text('window.bad = true')]),
    element('style', [text('.bad {}')]),
    element('button', [text('Like')]),
    element('form', [element('label', [text('Search')]), element('input')]),
    element('span', [text('secret')], { 'aria-hidden': 'true' }),
    text(' ending')
  ]);

  const index = api.buildTextIndex(root);

  assert.equal(index.normalizedText, 'Readable ending');
  assert.equal(index.normalizedText.includes('Like'), false);
  assert.equal(index.normalizedText.includes('window.bad'), false);
  assert.equal(index.normalizedText.includes('Search'), false);
  assert.equal(index.normalizedText.includes('secret'), false);
});

test('bare URLs are removed without losing sentence boundaries or DOM offsets', () => {
  const api = loadSentenceRange();
  const opening = text('开头 ');
  const url = text('https://example.com/image.png');
  const ending = text(' 结尾。');
  const root = element('p', [opening, element('a', [url]), ending]);

  const index = api.buildTextIndex(root);
  const match = api.findSegment(index, '开头 结尾。');

  assert.equal(index.normalizedText, '开头 结尾。');
  assert.equal(match.startContainer, opening);
  assert.equal(match.startOffset, 0);
  assert.equal(match.endContainer, ending);
  assert.equal(match.endOffset, ending.nodeValue.length);
});

test('custom ignore predicate is contained and supports site-specific chrome removal', () => {
  const api = loadSentenceRange();
  const body = text('Body');
  const chrome = element('aside', [text('Recommendations')], { role: 'complementary' });
  const root = element('main', [body, chrome, text(' continues')]);

  const index = api.buildTextIndex(root, {
    ignoreNode(node) {
      return node === chrome;
    }
  });

  assert.equal(index.normalizedText, 'Body continues');
});

test('point matching selects the correct segment across multi-line sentence rectangles', () => {
  const api = loadSentenceRange();
  const rectangles = [
    { segmentIndex: 4, rects: [
      { left: 100, top: 100, right: 220, bottom: 120 },
      { left: 100, top: 125, right: 160, bottom: 145 }
    ] },
    { segmentIndex: 5, rects: [
      { left: 165, top: 125, right: 280, bottom: 145 }
    ] }
  ];

  assert.equal(api.pickSegmentIndexAtPoint(rectangles, 130, 132), 4);
  assert.equal(api.segmentIndexAtPoint(rectangles, 210, 132), 5);
});

test('point matching snaps only within its small configured tolerance', () => {
  const api = loadSentenceRange();
  const rectangles = [
    { index: 0, rects: [{ left: 10, top: 10, right: 50, bottom: 30 }] },
    { index: 1, rects: [{ left: 60, top: 10, right: 100, bottom: 30 }] }
  ];

  assert.equal(api.pickSegmentIndexAtPoint(rectangles, 56, 20), 1);
  assert.equal(api.pickSegmentIndexAtPoint(rectangles, 55, 20, { maxDistance: 0 }), -1);
  assert.equal(api.pickSegmentIndexAtPoint(rectangles, 300, 300), -1);
});

test('overlapping rectangle matches choose the closest sentence center deterministically', () => {
  const api = loadSentenceRange();
  const rectangles = [
    { segmentIndex: 7, rects: [{ left: 0, top: 0, right: 100, bottom: 30 }] },
    { segmentIndex: 8, rects: [{ left: 70, top: 0, right: 120, bottom: 30 }] }
  ];

  assert.equal(api.pickSegmentIndexAtPoint(rectangles, 90, 15), 8);
});

test('invalid roots segments points and rectangles fail closed', () => {
  const api = loadSentenceRange();

  assert.equal(api.buildTextIndex(null).normalizedText, '');
  assert.equal(api.findSegment(null, 'missing'), null);
  assert.equal(api.findSegment(element('p', [text('text')]), '   '), null);
  assert.equal(api.pickSegmentIndexAtPoint([{ rects: [{}] }], 10, 10), -1);
  assert.equal(api.pickSegmentIndexAtPoint([], Number.NaN, 10), -1);
});
