const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const extensionRoot = path.join(__dirname, '..');
const readerSource = fs.readFileSync(path.join(extensionRoot, 'content', 'reader.js'), 'utf8');
const readerCss = fs.readFileSync(path.join(extensionRoot, 'content', 'reader.css'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'manifest.json'), 'utf8'));

function cssRule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = readerCss.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`));
  assert.ok(match, `Missing CSS rule: ${selector}`);
  return match[1];
}

test('reader host stays hidden until its shadow stylesheet is ready', () => {
  assert.match(readerSource, /host\.style\.setProperty\(["']display["'],\s*["']none["'],\s*["']important["']\)/);
  assert.match(readerSource, /stylesheet\.addEventListener\(["']load["'][\s\S]*host\.style\.removeProperty\(["']display["']\)/);
  assert.match(readerSource, /stylesheet\.addEventListener\(["']error["'][\s\S]*host\.remove\(\)/);
});

test('floating entry presents the generated logo without a second circle, border, or button chrome', () => {
  assert.match(readerSource, /<img class="qr-orb-logo"/);
  const orb = cssRule('.qr-orb');
  const logo = cssRule('.qr-orb-logo');
  assert.match(orb, /background:\s*transparent\s*;/);
  assert.match(orb, /border:\s*(?:0|none)\s*;/);
  assert.match(orb, /box-shadow:\s*none\s*;/);
  assert.doesNotMatch(orb, /border-radius\s*:/);
  assert.match(logo, /filter:\s*drop-shadow\([^)]*\)(?:\s*drop-shadow\([^)]*\))*\s*;/);
  assert.doesNotMatch(logo, /background\s*:|border\s*:|border-radius\s*:/);
  assert.equal(manifest.icons['128'], 'assets/qwen-reader-128.png');
  assert.equal(manifest.action.default_icon['32'], 'assets/qwen-reader-32.png');
});

test('floating entry can be dragged, snaps to a viewport edge, and persists its normalized position', () => {
  assert.match(readerSource, /data-role="floating-orb"/);
  assert.match(readerSource, /function\s+applyOrbPosition/);
  assert.match(readerSource, /function\s+(?:finishOrbDrag|snapOrbToEdge)/);
  assert.match(readerSource, /settings\.orbEdge/);
  assert.match(readerSource, /settings\.orbY/);
  assert.match(readerSource, /setPointerCapture/);
  assert.match(readerSource, /saveSettings\(\)/);
  const orb = cssRule('.qr-orb');
  assert.match(orb, /touch-action:\s*none/);
  assert.match(readerCss, /\.qr-orb\.is-dragging/);
});

test('active sentence is a restrained text-edge glow, never a rectangular highlight overlay', () => {
  assert.match(readerSource, /::highlight\(qwen-reader-current\)/);
  assert.match(readerSource, /SentenceRange\.findSegment/);
  assert.match(readerSource, /new globalThis\.Highlight\(range\)/);
  assert.doesNotMatch(readerSource, /data-role="highlight-layer"|qr-highlight-band|renderHighlightOverlay/);
  assert.doesNotMatch(readerCss, /\.qr-highlight-(?:layer|group|band)\b/);

  const pageHighlight = readerSource.match(/::highlight\(qwen-reader-current\)\s*\{([\s\S]*?)\}/);
  assert.ok(pageHighlight, 'Missing page highlight rule');
  assert.match(pageHighlight[1], /text-shadow:\s*(?:[^;]*rgba?\([^;]+;)/);
  assert.doesNotMatch(pageHighlight[1], /background(?:-color)?\s*:\s*(?!transparent\b)|box-shadow\s*:|border\s*:|outline\s*:/);
  assert.match(readerSource + readerCss, /@keyframes\s+(?:qr|qwen-reader)-(?:text-)?(?:glow|bloom)[\w-]*/);
  assert.doesNotMatch(readerSource + readerCss, /@keyframes\s+qr-highlight-sweep|linear-gradient\([^)]*rgba\(116,\s*88,\s*232/);
});

test('the page affordance is a minimal voice marker above the active sentence, not a floating control card', () => {
  assert.match(readerSource, /data-role="reading-marker"/);
  assert.match(readerSource, /function handlePagePointerMove/);
  assert.match(readerSource, /function renderReadingMarker/);
  assert.match(readerSource, /data-action="marker-play"/);
  assert.match(readerSource, /qr-marker-voice/);
  assert.match(readerSource, /qr-marker-(?:position|progress)/);
  assert.doesNotMatch(readerSource, /qr-inline-author|qr-inline-speaker-copy/);

  const marker = cssRule('.qr-reading-marker');
  assert.match(marker, /position:\s*fixed/);
  assert.match(marker, /background:\s*transparent\s*;/);
  assert.match(marker, /border:\s*(?:0|none)\s*;/);
  assert.match(marker, /box-shadow:\s*none\s*;/);
  assert.doesNotMatch(marker, /min-width\s*:|backdrop-filter\s*:|border-radius:\s*999px/);
  assert.match(readerSource, /MarkerPlacement\.chooseMarkerPlacement/);
  assert.match(readerSource, /collectOccupiedTextRects/);
  assert.match(readerCss, /\.qr-reading-marker\.is-safe-hidden/);
});

test('panel width is drag-adjustable and persisted without a duplicate range setting', () => {
  assert.doesNotMatch(readerSource, /data-setting="panelWidth"|type="range"[^>]*panelWidth|qr-width-row|panel-width-value/);
  assert.match(readerSource, /data-role="panel-resize"/);
  assert.match(readerSource, /clampPanelWidth/);
  assert.match(readerSource, /settings\.panelWidth\s*=/);
  assert.match(readerSource, /saveSettings\(\)/);
  assert.match(readerCss, /--qr-panel-width/);
});

test('sidebar navigation and content are editorial and flat rather than pill-and-card UI', () => {
  const tabs = cssRule('.qr-tabs');
  const tab = cssRule('.qr-tab');
  const selectedTab = cssRule('.qr-tab[aria-selected="true"]');
  const readingBox = cssRule('.qr-reading-box');
  const queueItem = cssRule('.qr-queue-item');

  assert.match(tabs, /border-bottom:\s*1px\s+solid/);
  assert.match(tabs, /background:\s*transparent\s*;/);
  assert.doesNotMatch(tabs, /border-radius\s*:|padding:\s*4px/);
  assert.match(tab, /border-radius:\s*0\s*;/);
  assert.match(selectedTab, /border-bottom:\s*(?:1|2)px\s+solid/);
  assert.doesNotMatch(selectedTab, /background:\s*#fff|box-shadow\s*:/);

  for (const rule of [readingBox, queueItem]) {
    assert.doesNotMatch(rule, /border-left\s*:|border-radius:\s*(?:9|10|11|12|13|14|999)px|box-shadow\s*:|linear-gradient\s*\(/);
  }
  assert.doesNotMatch(readingBox, /background:\s*#fff/);
});

test('page click-to-read defaults on, targets sentences, and ignores interactive content or selections', () => {
  assert.match(readerSource, /data-setting="clickToRead"/);
  assert.match(readerSource, /clickToRead:\s*DEFAULT_SETTINGS\.clickToRead !== false/);
  assert.match(readerSource, /function handlePageClick/);
  assert.match(readerSource, /function isInteractivePageTarget/);
  assert.match(readerSource, /"pre",[\s\S]*"code",[\s\S]*"img"/);
  assert.match(readerSource, /window\.getSelection/);
  assert.match(readerSource, /SentenceRange\.pickSegmentIndexAtPoint/);
  assert.match(readerSource, /await seek\(matchingIndex\)/);
});

test('point-reading hover is strictly gated by the point-reading switch', () => {
  const hoverBody = readerSource.match(/function\s+handlePagePointerMove\([^)]*\)\s*\{([\s\S]*?)\n\s*\}/);
  assert.ok(hoverBody, 'missing point-reading hover handler');
  assert.match(hoverBody[1], /settings\.clickToRead/);
  assert.match(readerSource, /active\s*\?\s*state\.index\s*:\s*settings\.clickToRead/);
  assert.match(readerSource, /hoveredSegmentIndex\s*=\s*-1/);
});

test('point-reading survives stale DOM mappings and ignores unrelated old selections', () => {
  assert.match(readerSource, /\.isConnected/);
  assert.match(readerSource, /function\s+(?:selectionContainsPoint|selectionCoversPoint)/);
  assert.match(readerSource, /findSegmentIndexAtTarget[\s\S]*invalidateSourceIndex\(\)/);
  assert.match(readerSource, /SentenceRange\.pickSegmentIndexAtPoint[\s\S]*maxDistance:\s*(?:5[0-9]|6[0-9]|7[0-9]|8[0-9])/);
});

test('point-reading uses an accessible switch instead of a raw checkbox', () => {
  assert.match(readerSource, /type="checkbox"[^>]*role="switch"[^>]*data-setting="clickToRead"/);
  assert.match(readerSource, /qr-switch-track/);
  const input = cssRule('.qr-toggle-row input');
  assert.match(input, /position:\s*absolute/);
  assert.match(input, /opacity:\s*0/);
  assert.match(readerCss, /\.qr-switch-track/);
  assert.match(readerCss, /input:checked\s*\+\s*\.qr-switch-track/);
});

test('manual scrolling disables follow until the user explicitly returns', () => {
  assert.match(readerSource, /Follow\.isScrollIntent/);
  assert.match(readerSource, /followController\.markManual\(\)/);
  assert.match(readerSource, /data-action="resume-follow"/);
  assert.match(readerSource, /qr-follow-chip/);
  assert.match(readerSource, /followController\.canFollow\(\)/);
});

test('motion is restrained and respects reduced-motion preferences', () => {
  assert.match(readerSource + readerCss, /160ms|180ms|190ms|220ms|240ms/);
  assert.match(readerSource + readerCss, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(readerSource + readerCss, /(?:qr|qwen-reader)-(?:text-)?(?:glow|bloom)[\w-]*[\s\S]*animation:\s*none/);
  assert.doesNotMatch(readerSource + readerCss, /animation-duration:\s*(?:[4-9]\d\d|\d{4,})ms/);
});
