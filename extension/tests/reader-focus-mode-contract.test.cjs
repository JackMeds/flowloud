const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const extensionRoot = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(extensionRoot, 'content', 'reader.js'), 'utf8');
const css = fs.readFileSync(path.join(extensionRoot, 'content', 'reader.css'), 'utf8');
const defaults = fs.readFileSync(path.join(extensionRoot, 'shared', 'defaults.js'), 'utf8');

test('reading focus offers persistent off, line, and sentence modes with sentence as the default', () => {
  assert.match(defaults, /readingFocus:\s*['"]sentence['"]/);
  assert.match(source, /data-setting="readingFocus"/);
  assert.match(source, /value="off"/);
  assert.match(source, /value="line"/);
  assert.match(source, /value="sentence"/);
  assert.match(source, /settings\.readingFocus\s*=\s*normalizeReadingFocus\(control\.value\)/);
  assert.match(source, /await\s+saveSettings\(\)[\s\S]{0,120}refreshReadingFocus\(\)/);
});

test('line focus uses viewport client rect geometry from the active word without a vertical offset', () => {
  assert.match(source, /function\s+readingFocusAnchorRect/);
  assert.match(source, /highlightedWordIndex\s*>=\s*0\s*\?\s*wordMotionRects\(\)/);
  assert.match(source, /band\.style\.top\s*=\s*`\$\{rect\.top\}px`/);
  assert.match(source, /band\.style\.height\s*=\s*`\$\{rect\.height\}px`/);
  assert.doesNotMatch(css, /\.qr-line-focus-band\s*\{[^}]*transition:[^;]*(?:top|height)/);
});

test('sentence and line focus can be removed without clearing the exact word highlight', () => {
  const refresh = source.match(/function\s+refreshReadingFocus\(\)\s*\{([\s\S]*?)\n\s*\}/);
  assert.ok(refresh, 'missing focus refresh function');
  assert.match(refresh[1], /clearSentenceNativeHighlight\(\)/);
  assert.doesNotMatch(refresh[1], /clearNativeHighlight|clearWordHighlight|clearWordMotion/);
  assert.match(source, /settings\.readingFocus\s*===\s*"sentence"/);
  assert.match(source, /settings\.readingFocus\s*===\s*"line"/);
  assert.match(css, /\.qr-line-focus-layer[\s\S]*?position:\s*fixed/);
  assert.match(css, /\.qr-line-focus-layer[\s\S]*?pointer-events:\s*none/);
});
