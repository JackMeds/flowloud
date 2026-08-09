const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const extensionRoot = path.join(__dirname, '..');
const readerSource = fs.readFileSync(path.join(extensionRoot, 'content', 'reader.js'), 'utf8');
const readerCss = fs.readFileSync(path.join(extensionRoot, 'content', 'reader.css'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'manifest.json'), 'utf8'));

test('reader host stays hidden until its shadow stylesheet is ready', () => {
  assert.match(readerSource, /host\.style\.setProperty\(["']display["'],\s*["']none["'],\s*["']important["']\)/);
  assert.match(readerSource, /stylesheet\.addEventListener\(["']load["'][\s\S]*host\.style\.removeProperty\(["']display["']\)/);
  assert.match(readerSource, /stylesheet\.addEventListener\(["']error["'][\s\S]*host\.remove\(\)/);
});

test('floating entry is a compact circle backed by a generated image asset', () => {
  assert.match(readerSource, /<img class="qr-orb-logo"/);
  assert.match(readerCss, /\.qr-orb\s*\{[\s\S]*?width:\s*40px;[\s\S]*?height:\s*40px;[\s\S]*?border-radius:\s*50%;/);
  assert.match(readerCss, /\.qr-orb-logo\s*\{/);
  assert.equal(manifest.icons['128'], 'assets/qwen-reader-128.png');
  assert.equal(manifest.action.default_icon['32'], 'assets/qwen-reader-32.png');
});

test('active reading treatment uses aurora underline and text glow without an outline box', () => {
  assert.doesNotMatch(readerSource, /\.qwen-reader-speaking\s*\{[\s\S]*?outline:/);
  assert.match(readerSource, /\.qwen-reader-speaking\s*\{[\s\S]*?linear-gradient/);
  assert.match(readerSource, /\.qwen-reader-speaking\s*\{[\s\S]*?text-shadow:/);
});

test('panel width is adjustable, clamped, and persisted', () => {
  assert.match(readerSource, /data-setting="panelWidth"/);
  assert.match(readerSource, /data-role="panel-resize"/);
  assert.match(readerSource, /clampPanelWidth/);
  assert.match(readerSource, /settings\.panelWidth\s*=/);
  assert.match(readerSource, /saveSettings\(\)/);
  assert.match(readerCss, /--qr-panel-width/);
});

test('page click-to-read is opt-in and ignores interactive elements', () => {
  assert.match(readerSource, /data-setting="clickToRead"/);
  assert.match(readerSource, /function handlePageClick/);
  assert.match(readerSource, /a, button, input, select, textarea/);
  assert.match(readerSource, /SourceLocator\.resolve\(document, segment\)/);
  assert.match(readerSource, /await seek\(matchingIndex\)/);
});
