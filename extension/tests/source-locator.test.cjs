const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadLocator() {
  delete globalThis.QwenReaderText;
  delete globalThis.QwenReaderForumContent;
  delete globalThis.QwenReaderSourceLocator;
  for (const relativePath of ['shared/text.js', 'shared/forum-content.js', 'shared/source-locator.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
    vm.runInThisContext(source, { filename: relativePath });
  }
  return globalThis.QwenReaderSourceLocator;
}

function node(text) {
  return {
    textContent: text,
    closest: () => null,
    querySelectorAll: () => [],
    cloneNode() {
      return { textContent: text, querySelectorAll: () => [] };
    }
  };
}

function nestedNode(ownText, childText) {
  const child = node(childText);
  return {
    textContent: `${ownText} ${childText}`,
    closest: () => null,
    querySelectorAll: (selector) => selector === 'p,h1,h2,h3,h4,h5,h6,li' ? [child] : [],
    cloneNode() {
      let currentText = `${ownText} ${childText}`;
      const nestedClone = { remove() { currentText = ownText; } };
      return {
        get textContent() { return currentText; },
        querySelectorAll(selector) {
          return selector === 'p,h1,h2,h3,h4,h5,h6,li' ? [nestedClone] : [];
        }
      };
    }
  };
}

function fakeDocument(nodes, containers = {}) {
  const post = { id: 'post-fallback' };
  const container = {
    querySelectorAll(selector) {
      return selector === 'p,h1,h2,h3,h4,h5,h6,li' ? nodes : [];
    }
  };
  return {
    post,
    querySelector(selector) {
      if (selector === '.post .Post-body') return containers.body === false ? null : container;
      if (selector === '.post') return post;
      if (selector === ':invalid') throw new Error('invalid selector');
      return null;
    }
  };
}

test('resolver prefers a fingerprint match after DOM order changes', () => {
  const forumContent = loadLocator() && globalThis.QwenReaderForumContent;
  const target = node('target paragraph');
  const document = fakeDocument([node('inserted paragraph'), node('first paragraph'), target]);

  const resolved = globalThis.QwenReaderSourceLocator.resolve(document, {
    sourceSelector: '.post',
    sourceLocator: {
      adapter: 'flarum', containerSelector: '.post .Post-body', unitIndex: 1,
      fingerprint: forumContent.fingerprint('target paragraph')
    }
  });

  assert.equal(resolved, target);
});

test('resolver chooses the duplicate fingerprint closest to the original unit index', () => {
  const locator = loadLocator();
  const forumContent = globalThis.QwenReaderForumContent;
  const first = node('repeated paragraph');
  const second = node('repeated paragraph');
  const document = fakeDocument([first, node('other paragraph'), second]);

  const resolved = locator.resolve(document, {
    sourceLocator: {
      containerSelector: '.post .Post-body', unitIndex: 2,
      fingerprint: forumContent.fingerprint('repeated paragraph')
    }
  });

  assert.equal(resolved, second);
});

test('resolver fingerprints nested list parents with the same text rule as extraction', () => {
  const locator = loadLocator();
  const forumContent = globalThis.QwenReaderForumContent;
  const inserted = node('inserted paragraph');
  const parent = nestedNode('parent item', 'child item');
  const child = node('child item');
  const document = fakeDocument([inserted, parent, child]);

  const resolved = locator.resolve(document, {
    sourceLocator: {
      containerSelector: '.post .Post-body', unitIndex: 0,
      fingerprint: forumContent.fingerprint('parent item')
    }
  });

  assert.equal(resolved, parent);
});

test('resolver falls back to the original unit index when no fingerprint matches', () => {
  const locator = loadLocator();
  const target = node('second live paragraph');
  const document = fakeDocument([node('first live paragraph'), target]);

  const resolved = locator.resolve(document, {
    sourceLocator: {
      containerSelector: '.post .Post-body', unitIndex: 1, fingerprint: 'stale-fingerprint'
    }
  });

  assert.equal(resolved, target);
});

test('resolver falls back to the post selector when the paragraph cannot be found', () => {
  const locator = loadLocator();
  const document = fakeDocument([], { body: false });

  assert.equal(locator.resolve(document, {
    sourceSelector: '.post',
    sourceLocator: { containerSelector: '.post .Post-body', unitIndex: 0, fingerprint: 'missing' }
  }), document.post);
});

test('resolver keeps a matched br-only container as the shared range root', () => {
  const locator = loadLocator();
  const document = fakeDocument([]);
  const container = document.querySelector('.post .Post-body');

  assert.equal(locator.resolve(document, {
    sourceLocator: {
      containerSelector: '.post .Post-body', unitIndex: 1, fingerprint: 'virtual-line'
    }
  }), container);
});

test('resolver returns null when the locator container and post selector are unavailable', () => {
  const locator = loadLocator();

  assert.equal(locator.resolve(fakeDocument([], { body: false }), {
    sourceLocator: { containerSelector: '.post .Post-body', unitIndex: 0, fingerprint: 'missing' }
  }), null);
});

test('resolver returns null for invalid selectors instead of throwing into playback', () => {
  const locator = loadLocator();

  assert.equal(locator.resolve(fakeDocument([]), { sourceSelector: ':invalid' }), null);
});
