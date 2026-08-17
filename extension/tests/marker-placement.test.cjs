const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadMarkerPlacement() {
  delete globalThis.QwenReaderMarkerPlacement;
  const source = fs.readFileSync(path.join(__dirname, '..', 'shared', 'marker-placement.js'), 'utf8');
  vm.runInThisContext(source, { filename: 'marker-placement.js' });
  return globalThis.QwenReaderMarkerPlacement;
}

function rect(left, top, right, bottom) {
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

test('prefers a collision-free position above the first sentence line', () => {
  const api = loadMarkerPlacement();
  const result = api.chooseMarkerPlacement({
    sentenceRects: [rect(120, 100, 300, 124)],
    markerWidth: 96,
    markerHeight: 22,
    viewport: { width: 800, height: 600 },
    occupiedRects: []
  });

  assert.deepEqual(result, { left: 120, top: 72, right: 216, bottom: 94, placement: 'above' });
});

test('dense list text above the sentence forces the marker into a free side gutter', () => {
  const api = loadMarkerPlacement();
  const result = api.chooseMarkerPlacement({
    sentenceRects: [rect(220, 100, 500, 124)],
    markerWidth: 96,
    markerHeight: 22,
    viewport: { width: 900, height: 600 },
    occupiedRects: [
      rect(100, 68, 560, 96),
      rect(100, 126, 560, 150)
    ]
  });

  assert.equal(result.placement, 'left');
  assert.equal(result.right <= 214, true);
});

test('tries the right gutter when the preferred left gutter is occupied', () => {
  const api = loadMarkerPlacement();
  const result = api.chooseMarkerPlacement({
    sentenceRects: [rect(220, 100, 500, 124)],
    markerWidth: 96,
    markerHeight: 22,
    viewport: { width: 900, height: 600 },
    occupiedRects: [
      rect(100, 68, 560, 96),
      rect(100, 98, 218, 126)
    ]
  });

  assert.equal(result.placement, 'right');
  assert.equal(result.left >= 506, true);
});

test('uses the area below the last line when neither side gutter fits', () => {
  const api = loadMarkerPlacement();
  const result = api.chooseMarkerPlacement({
    sentenceRects: [
      rect(18, 100, 782, 124),
      rect(18, 126, 400, 150)
    ],
    markerWidth: 120,
    markerHeight: 22,
    viewport: { width: 800, height: 600 },
    occupiedRects: [rect(0, 68, 800, 96)]
  });

  assert.deepEqual(result, { left: 18, top: 156, right: 138, bottom: 178, placement: 'below' });
});

test('returns null when every in-bounds candidate intersects occupied text', () => {
  const api = loadMarkerPlacement();
  const result = api.chooseMarkerPlacement({
    sentenceRects: [rect(220, 100, 500, 124)],
    markerWidth: 96,
    markerHeight: 22,
    viewport: { width: 900, height: 600 },
    occupiedRects: [
      rect(0, 60, 900, 99),
      rect(0, 99, 219, 130),
      rect(501, 99, 900, 130),
      rect(0, 125, 900, 170)
    ]
  });

  assert.equal(result, null);
});

test('rejects malformed and zero-area geometry instead of guessing', () => {
  const api = loadMarkerPlacement();

  assert.equal(api.chooseMarkerPlacement({
    sentenceRects: [],
    markerWidth: 96,
    markerHeight: 22,
    viewport: { width: 800, height: 600 },
    occupiedRects: []
  }), null);

  assert.equal(api.chooseMarkerPlacement({
    sentenceRects: [rect(100, 100, 200, 120)],
    markerWidth: 0,
    markerHeight: 22,
    viewport: { width: 800, height: 600 },
    occupiedRects: []
  }), null);
});
