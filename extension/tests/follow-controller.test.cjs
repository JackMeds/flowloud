const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadFollow() {
  delete globalThis.QwenReaderFollow;
  const source = fs.readFileSync(path.join(__dirname, '..', 'shared', 'follow-controller.js'), 'utf8');
  vm.runInThisContext(source, { filename: 'follow-controller.js' });
  return globalThis.QwenReaderFollow;
}

const plainTarget = { tagName: 'DIV' };
const context = { viewportWidth: 1000 };

test('manual mode never resumes without an explicit action', () => {
  const follow = loadFollow().createController();
  follow.markManual();

  assert.equal(follow.mode, 'manual');
  assert.equal(follow.canFollow(), false);
  assert.equal(follow.mode, 'manual');

  follow.reset();
  assert.equal(follow.mode, 'following');
  assert.equal(follow.canFollow(), true);
});

test('resume explicitly returns a manual controller to following mode', () => {
  const follow = loadFollow().createController();
  follow.markManual();
  follow.resume();

  assert.equal(follow.mode, 'following');
});

test('wheel touch paging keys and scrollbar pointer are manual scroll intent', () => {
  const api = loadFollow();

  assert.equal(api.isScrollIntent({ type: 'wheel', composedPath: () => [] }, context), true);
  assert.equal(api.isScrollIntent({ type: 'touchmove', composedPath: () => [] }, context), true);
  assert.equal(api.isScrollIntent({ type: 'keydown', key: 'PageDown', target: plainTarget }, context), true);
  assert.equal(api.isScrollIntent(
    { type: 'pointerdown', clientX: 995, composedPath: () => [] },
    { viewportWidth: 1000 },
  ), true);
});

test('editable controls and extension-panel paths do not disable following', () => {
  const api = loadFollow();
  const host = {};
  const hostContext = { host, viewportWidth: 1000 };

  assert.equal(api.isScrollIntent({ type: 'wheel', composedPath: () => [host] }, hostContext), false);
  assert.equal(api.isScrollIntent({ type: 'keydown', key: ' ', target: { tagName: 'INPUT' } }, context), false);
  assert.equal(api.isScrollIntent({ type: 'keydown', key: 'ArrowDown', target: { isContentEditable: true } }, context), false);
});

test('safe viewport includes targets intersecting the 15% through 85% boundaries', () => {
  const api = loadFollow();

  assert.equal(api.isWithinSafeViewport({ top: 140, bottom: 150 }, 1000), true);
  assert.equal(api.isWithinSafeViewport({ top: 850, bottom: 860 }, 1000), true);
  assert.equal(api.isWithinSafeViewport({ top: 0, bottom: 149 }, 1000), false);
  assert.equal(api.isWithinSafeViewport({ top: 851, bottom: 900 }, 1000), false);
});
