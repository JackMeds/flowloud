const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const extensionRoot = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(extensionRoot, 'voice-studio.html'), 'utf8');
const source = fs.readFileSync(path.join(extensionRoot, 'settings-center.js'), 'utf8');
const css = fs.readFileSync(path.join(extensionRoot, 'voice-studio.css'), 'utf8');
const reader = fs.readFileSync(path.join(extensionRoot, 'content', 'reader.js'), 'utf8');
const defaults = fs.readFileSync(path.join(extensionRoot, 'shared', 'defaults.js'), 'utf8');

test('options page unifies reading settings and the complete voice studio', () => {
  assert.match(html, /data-settings-section="reader"/u);
  assert.match(html, /data-settings-section="voices"/u);
  for (const name of [
    'readingFocus', 'readingFocusStyle',
    'wordHighlightStyle', 'wordHighlightColor', 'wordHighlightGlow',
    'wordHighlightSpeed', 'opVoice',
  ]) {
    assert.match(html, new RegExp(`name="${name}"`));
  }
  assert.doesNotMatch(html, /name="(?:clickToRead|preset)"/u);
  assert.match(html, /网页点读与配音策略可直接在 Popup 中快速调整/u);
  assert.match(html, /开始录音/u);
  assert.match(html, /type="file"[^>]+multiple/u);
  assert.match(html, /音色库/u);
  assert.match(html, /settings-center\.js/u);
});

test('settings center persists every runtime setting and loads the real voice catalog', () => {
  assert.match(source, /qwenReaderSettings/u);
  assert.match(source, /chrome\.storage\.local\.set/u);
  assert.match(source, /type:\s*'voice:list'/u);
  assert.match(source, /replyVoices/u);
  assert.match(source, /data-open-voice-studio/u);
  assert.match(css, /\.theme-options/u);
  assert.match(css, /\.reply-voice-options/u);
});

test('visual setting changes update live reading without interrupting playback', () => {
  assert.match(reader, /const\s+previousVoiceAssignment\s*=\s*voiceAssignmentSignature\(settings\)/u);
  assert.match(reader, /if\s*\(!voiceAssignmentChanged\)\s*\{[\s\S]*?refreshReadingFocus\(\)[\s\S]*?refreshActiveWordStyle\(\)[\s\S]*?render\(\)[\s\S]*?return/u);
  assert.match(reader, /if\s*\(!voiceAssignmentChanged\)[\s\S]*?return;[\s\S]*?await\s+stopPlayback\(\)/u);
});

test('page click-to-read is opt-in and never cancels the site click event', () => {
  assert.match(defaults, /clickToRead:\s*false/u);
  assert.match(defaults, /interactionVersion:\s*3/u);
  assert.match(reader, /Number\(value\.interactionVersion \|\| 0\) < 3[\s\S]*?\? false/u);
  const clickHandler = reader.slice(reader.indexOf('async function handlePageClick'), reader.indexOf('function handlePagePointerMove'));
  assert.doesNotMatch(clickHandler, /preventDefault|stopPropagation|stopImmediatePropagation/u);
  assert.match(clickHandler, /isInteractivePageTarget\(target\)/u);
});
