const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const extensionRoot = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(extensionRoot, 'content', 'reader.js'), 'utf8');
const css = fs.readFileSync(path.join(extensionRoot, 'content', 'reader.css'), 'utf8');
const pageCss = fs.readFileSync(path.join(extensionRoot, 'content', 'page-highlight.css'), 'utf8');
const defaults = fs.readFileSync(path.join(extensionRoot, 'shared', 'defaults.js'), 'utf8');

test('edge dissolve is the default and all requested styles are selectable', () => {
  assert.match(defaults, /wordHighlightStyle:\s*['"]edge-dissolve['"]/);
  for (const value of ['edge-dissolve', 'classic-glow', 'aurora-tide', 'custom']) {
    assert.match(source, new RegExp(`value="${value}"`));
    assert.match(source, new RegExp(`qwen-reader-word-style-${value}`));
  }
  assert.match(source, /data-setting="wordHighlightStyle"/);
  assert.match(source, /normalizeWordHighlightStyle/);
  assert.match(source, /await\s+saveSettings\(\)[\s\S]{0,120}refreshActiveWordStyle\(\)/);
});

test('custom style persists safe color, glow, and speed controls', () => {
  assert.match(defaults, /wordHighlightColor/);
  assert.match(defaults, /wordHighlightGlow/);
  assert.match(defaults, /wordHighlightSpeed/);
  assert.match(source, /data-setting="wordHighlightColor"/);
  assert.match(source, /data-setting="wordHighlightGlow"/);
  assert.match(source, /data-setting="wordHighlightSpeed"/);
  assert.match(source, /\^#\[0-9a-f\]\{6\}\$/i);
  assert.match(source, /--qwen-reader-word-motion-duration/);
  assert.match(source, /--qwen-reader-word-glow-radius/);
});

test('preset CSS keeps glyph position fixed and changes only light, color, and underline', () => {
  assert.match(css, /data-style="edge-dissolve"/);
  assert.match(css, /data-style="classic-glow"/);
  assert.match(css, /data-style="aurora-tide"/);
  assert.match(css, /@keyframes\s+qr-word-edge-dissolve/);
  assert.match(css, /@keyframes\s+qr-word-aurora-position/);
  assert.match(pageCss, /qwen-reader-word-style-classic-glow/);
  assert.match(pageCss, /qwen-reader-word-style-aurora-tide/);
  assert.doesNotMatch(css, /overshoot|rebound|qr-word-ink-settle/);
  assert.doesNotMatch(pageCss, /qwen-reader-ink-settle|qwen-reader-inertia-direction/);
});
