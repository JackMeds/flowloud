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
