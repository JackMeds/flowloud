const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const extensionRoot = path.join(__dirname, '..');
const readerSource = fs.readFileSync(path.join(extensionRoot, 'content', 'reader.js'), 'utf8');
const readerCss = fs.readFileSync(path.join(extensionRoot, 'content', 'reader.css'), 'utf8');
const pageHighlightCss = fs.readFileSync(path.join(extensionRoot, 'content', 'page-highlight.css'), 'utf8');
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

test('popup-first reader has no rendered sidebar or permanent floating launcher', () => {
  assert.equal(manifest.action.default_popup, 'popup.html');
  assert.match(readerSource, /class="qr-mini-player"/);
  assert.match(readerSource, /data-role="mini-player"/);
  assert.doesNotMatch(readerSource, /<aside class="qr-panel"/);
  assert.doesNotMatch(readerSource, /data-role="floating-orb"/);
  assert.doesNotMatch(readerSource, /ui:toggle/);
  assert.match(readerSource, /\["loading", "playing", "paused"\]\.includes\(state\.status\)/);
});

test('active mini player has touch-safe controls and a restrained shadow', () => {
  const player = cssRule('.qr-mini-player');
  const control = cssRule('.qr-mini-button');
  const primary = cssRule('.qr-mini-button.is-primary');
  assert.match(player, /position:\s*fixed/);
  assert.match(player, /visibility:\s*hidden/);
  assert.match(player, /box-shadow:\s*0 8px 22px rgba\(36, 29, 57, \.14\)/);
  assert.match(readerCss, /\.qr-mini-player\.is-visible[\s\S]*?pointer-events:\s*auto/);
  assert.match(control, /width:\s*42px/);
  assert.match(control, /height:\s*42px/);
  assert.match(primary, /width:\s*44px/);
  assert.match(primary, /height:\s*44px/);
  assert.match(readerCss, /@media \(max-width: 520px\)[\s\S]*?\.qr-mini-button \{ width: 40px; height: 40px; \}/);
  for (const action of ['previous', 'play-toggle', 'next', 'stop']) {
    assert.match(readerSource, new RegExp(`data-action="${action}"`));
  }
});

test('content keeps its marker, author cue, follow chip, and word motion', () => {
  assert.match(readerSource, /data-role="reading-marker"/);
  assert.match(readerSource, /function renderReadingMarker/);
  assert.match(readerSource, /data-action="marker-play"/);
  assert.match(readerSource, /qr-marker-voice/);
  assert.match(readerSource, /qr-marker-context/);
  assert.match(readerSource, /data-action="resume-follow"/);
  assert.match(readerSource, /QwenReaderWordTimeline/);
  assert.match(readerSource, /data-role="word-motion-layer"/);
  assert.match(readerSource, /followController\.markManual\(\)/);
  assert.match(readerCss, /\.qr-reading-marker\s*\{[\s\S]*?position:\s*fixed/);
  assert.match(readerCss, /\.qr-follow-chip\.is-visible/);
  assert.match(readerCss, /\.qr-word-motion-layer\s*\{[\s\S]*?position:\s*fixed/);
});

test('manual rescans await playback cancellation and only rebuild document state', () => {
  const refresh = readerSource.match(/async function refreshCurrentPage\(\)\s*\{([\s\S]*?)\n\s*\}/);
  assert.ok(refresh, 'missing manual rescan handler');
  assert.match(refresh[1], /await\s+stopPlayback\(\)/);
  assert.match(refresh[1], /await\s+scanCurrentPage\(["']manual["']\)/);
  assert.doesNotMatch(refresh[1], /playIndex\(|togglePlayback\(|seek\(/);
});

test('long-thread source locations remain indexed on demand', () => {
  assert.match(readerSource, /function\s+ensureSourceIndex\(requestedIndex\)/);
  assert.match(readerSource, /sourceElements\s*=\s*new\s+Array\(state\.segments\.length\)/);
  assert.match(readerSource, /ensureSourceIndex\(index\)/);
});

test('reader exposes a compact popup and page-voice command contract', () => {
  for (const type of ['reader:snapshot:get', 'reader:command', 'reader:page-context:get', 'reader:page-context:apply', 'reader:snapshot']) {
    assert.match(readerSource, new RegExp(type));
  }
  assert.match(readerSource, /function getReaderSnapshot/);
  assert.match(readerSource, /function getPageContext/);
  assert.match(readerSource, /function applyPageContext/);
  assert.match(readerSource, /authorVoices:\s*pageAuthorVoices/);
  assert.match(readerSource, /publishReaderSnapshot\(\)/);
});

test('active sentence remains a restrained translucent native highlight', () => {
  assert.match(pageHighlightCss, /::highlight\(qwen-reader-current\)/);
  assert.match(readerSource, /SentenceRange\.findSegment/);
  assert.match(readerSource, /new globalThis\.Highlight\(range\)/);
  const rule = pageHighlightCss.match(/::highlight\(qwen-reader-current\)\s*\{([\s\S]*?)\}/);
  assert.ok(rule, 'Missing page highlight rule');
  assert.match(rule[1], /background-color:\s*rgba\(116,\s*88,\s*232,\s*\.075\)/);
  assert.doesNotMatch(rule[1], /animation\s*:/);
  assert.deepEqual(manifest.content_scripts[0].css, ['content/page-highlight.css']);
});

test('click-to-read and manual follow behavior remain independent of the popup', () => {
  assert.match(readerSource, /settings\.clickToRead/);
  assert.match(readerSource, /function handlePageClick/);
  assert.match(readerSource, /SentenceRange\.pickSegmentIndexAtPoint/);
  assert.match(readerSource, /await seek\(matchingIndex\)/);
  assert.match(readerSource, /Follow\.isScrollIntent/);
  assert.match(readerSource, /followController\.resume\(\)/);
});

test('motion remains restrained and respects reduced-motion preferences', () => {
  const motionCss = pageHighlightCss + readerCss;
  assert.match(motionCss, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(motionCss, /prefers-reduced-motion:\s*reduce[\s\S]*?\.qr-word-motion-cursor[\s\S]*?animation:\s*none/);
  assert.doesNotMatch(motionCss, /animation-duration:\s*(?:[4-9]\d\d|\d{4,})ms/);
});
