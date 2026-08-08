const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadForumContent() {
  delete globalThis.QwenReaderText;
  delete globalThis.QwenReaderForumContent;
  for (const relativePath of ['shared/text.js', 'shared/forum-content.js']) {
    const absolutePath = path.join(__dirname, '..', relativePath);
    const source = fs.readFileSync(absolutePath, 'utf8');
    vm.runInThisContext(source, { filename: relativePath });
  }
  return globalThis.QwenReaderForumContent;
}

test('forum HTML becomes separate semantic units without images or quotes', () => {
  const content = loadForumContent();
  const units = content.semanticUnitsFromHtml([
    '<blockquote><p>鏃у紩鐢?</p></blockquote>',
    '<p>绗竴娈?</p>',
    '<p><img src="x.jpg" alt="image350脳318 24.5 KB"></p>',
    '<h2>灏忔爣棰?</h2>',
    '<p>鍚屾剰</p>',
    '<div class="Post-actions"><button>鐐硅禐</button></div>'
  ].join(''), { removeBlockquotes: true });

  assert.deepEqual(units.map((unit) => unit.text), ['绗竴娈?', '灏忔爣棰?', '鍚屾剰']);
  assert.deepEqual(units.map((unit) => unit.unitIndex), [0, 1, 2]);
  assert.equal(new Set(units.map((unit) => unit.fingerprint)).size, 3);
});

test('forum HTML falls back to one block when it has no semantic child tags', () => {
  const content = loadForumContent();
  assert.deepEqual(
    content.semanticUnitsFromHtml('<div>闈炴爣鍑嗚鍧涙鏂?</div>').map((unit) => unit.text),
    ['闈炴爣鍑嗚鍧涙鏂?']
  );
});

test('nested list markup keeps each list level without parent-child duplicate speech', () => {
  const content = loadForumContent();
  assert.deepEqual(
    content.semanticUnitsFromHtml('<ul><li>澶栧眰<ul><li>鍐呭眰</li></ul></li></ul>').map((unit) => unit.text),
    ['澶栧眰', '鍐呭眰']
  );
});

test('a one-character paragraph remains a semantic unit', () => {
  const content = loadForumContent();
  assert.deepEqual(content.semanticUnitsFromHtml('<p>濂?</p>').map((unit) => unit.text), ['濂?']);
});

test('plain HTML fallback excludes controls and image metadata without reading alt text', () => {
  const content = loadForumContent();
  assert.deepEqual(
    content.semanticUnitsFromHtml('<div>姝ｆ枃<div class="Post-actions">鐐硅禐</div><img alt="image350脳318 24.5 KB"></div>').map((unit) => unit.text),
    ['姝ｆ枃']
  );
});

test('string fallback never emits image attribute fragments containing greater-than characters', () => {
  const content = loadForumContent();
  assert.deepEqual(
    content.semanticUnitsFromHtml('<p><img alt="image350 > 24.5 KB"></p><div>reply<img src="https://example.test/a>b.png"></div>').map((unit) => unit.text),
    ['reply']
  );
});

test('string fallback excludes ordinary controls and advertisement containers', () => {
  const content = loadForumContent();
  assert.deepEqual(
    content.semanticUnitsFromHtml('<p><button>Like</button></p><aside class="advertisement"><p>Buy now</p></aside><p>Keep me</p>').map((unit) => unit.text),
    ['Keep me']
  );
});

test('semanticElements removes redundant three-level semantic parents while retaining live leaf nodes', () => {
  const content = loadForumContent();
  const leaf = makeSemanticElement('leaf');
  const middle = makeSemanticElement('leaf', [leaf]);
  const outer = makeSemanticElement('leaf', [middle, leaf]);
  const root = { querySelectorAll: () => [outer, middle, leaf] };

  assert.deepEqual(content.semanticElements(root), [leaf]);
});

function makeSemanticElement(text, descendants = []) {
  return {
    textContent: text,
    closest: () => null,
    cloneNode() {
      return {
        textContent: text,
        querySelectorAll: () => []
      };
    },
    querySelectorAll(selector) {
      return selector === 'p,h1,h2,h3,h4,h5,h6,li' ? descendants : [];
    }
  };
}
