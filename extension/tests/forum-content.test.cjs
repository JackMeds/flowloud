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

test('line-break-only forum HTML preserves every visual paragraph as a unit', () => {
  const content = loadForumContent();
  const units = content.semanticUnitsFromHtml('<div>First line<br>Second line<br><br>短</div>');

  assert.deepEqual(units.map((unit) => unit.text), ['First line', 'Second line', '短']);
  assert.deepEqual(units.map((unit) => unit.unitIndex), [0, 1, 2]);
});

test('live DOM falls back to one block when it has no semantic child tags', () => {
  const content = loadForumContent();
  const root = {
    querySelectorAll: () => [],
    cloneNode() {
      return { textContent: '短回复', querySelectorAll: () => [] };
    }
  };

  assert.deepEqual(content.semanticUnitsFromElement(root).map((unit) => unit.text), ['短回复']);
});

test('live DOM excludes nested paragraphs inside known forum chrome', () => {
  const content = loadForumContent();
  const signatureParagraph = makeSemanticElement('签名内容');
  signatureParagraph.closest = (selector) => selector.includes('.Post-signature') ? {} : null;
  const root = { querySelectorAll: () => [signatureParagraph] };

  assert.deepEqual(content.semanticUnitsFromElement(root), []);
});

test('string fallback excludes legacy forum signatures quotes reactions and lightboxes', () => {
  const content = loadForumContent();
  const html = [
    '<div class="Post-signature"><p>签名内容</p></div>',
    '<div class="message-signature"><p>另一个签名</p></div>',
    '<div class="message-footer"><p>页脚操作</p></div>',
    '<div class="bbCodeBlock--quote"><p>引用内容</p></div>',
    '<div class="reactionsBar"><p>点赞信息</p></div>',
    '<div class="lightbox-wrapper"><p>350×318 24.5 KB</p></div>',
    '<p>保留正文</p>'
  ].join('');

  assert.deepEqual(content.semanticUnitsFromHtml(html).map((unit) => unit.text), ['保留正文']);
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

test('semanticElements removes a parent fully represented by multiple semantic children', () => {
  const content = loadForumContent();
  const first = makeSemanticElement('one');
  const second = makeSemanticElement('two');
  const parent = makeSemanticElement('one two', [first, second]);
  const root = { querySelectorAll: () => [parent, first, second] };

  assert.deepEqual(content.semanticElements(root), [first, second]);
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
