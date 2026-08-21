const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const extensionRoot = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(extensionRoot, file), 'utf8');

test('popup and the comparison lab load the shared production renderer and CSS', () => {
  const popup = read('popup.html');
  const lab = read('popup-lab.html');
  assert.match(popup, /popup\.css/);
  assert.match(popup, /shared\/defaults\.js/);
  assert.match(lab, /popup\.css/);
  assert.match(popup, /popup-view\.js/);
  assert.match(lab, /popup-view\.js/);
  assert.doesNotMatch(popup, /<script[^>]*>[^<]/);
  assert.doesNotMatch(lab, /<script[^>]*>[^<]/);
});

test('popup controller keeps current-page voice editing inside the native popup', () => {
  const source = read('popup.js');
  for (const type of ['reader:active-context', 'reader:snapshot:get', 'reader:command', 'reader:page-voices:get', 'reader:page-voices:apply']) {
    assert.match(source, new RegExp(type));
  }
  assert.doesNotMatch(source, /reader:page-editor:open/);
  assert.match(read('popup-view.js'), /mountPopup/);
  assert.match(read('popup-view.js'), /mountPageVoices/);
  assert.match(read('popup-view.js'), /qr-page-root-compact/);
});

test('popup renderer accepts a compact snapshot without the full segment queue or fake controls', () => {
  const source = read('popup-view.js');
  assert.match(source, /snapshot\.segmentCount/);
  assert.match(source, /snapshot\.current/);
  assert.match(source, /播放会在关闭弹窗后继续/);
  assert.doesNotMatch(source, /data-speed/);
  assert.match(source, /open-options/);
  assert.doesNotMatch(source, /previous\.disabled = !segments\.length/);
});

test('floating player, click-to-read, and author strategy are quick settings in the popup', () => {
  const view = read('popup-view.js');
  const controller = read('popup.js');
  const settingsPage = read('voice-studio.html');
  assert.match(view, /dataset\.setting = 'clickToRead'/);
  assert.match(view, /dataset\.setting = 'showFloatingPlayer'/);
  assert.match(view, /dataset\.setting = 'preset'/);
  assert.match(view, /网页点读/);
  assert.match(view, /网页悬浮窗/);
  assert.match(view, /作者配音策略/);
  assert.match(controller, /api\.storage\.local\.set/);
  assert.match(controller, /qwenReaderSettings/);
  assert.doesNotMatch(settingsPage, /name="(?:clickToRead|preset)"/);
});

test('rerendering cannot accumulate delegated control listeners', () => {
  const source = read('popup-view.js');
  assert.match(source, /const boundRoots = new WeakSet\(\)/);
  assert.match(source, /if \(boundRoots\.has\(root\)\) return/);
  assert.match(source, /boundRoots\.add\(root\)/);
});

test('popup polling preserves focus and keeps live announcements scoped to status', () => {
  const html = read('popup.html');
  const view = read('popup-view.js');
  const controller = read('popup.js');
  assert.doesNotMatch(html, /id="popup-root"[^>]*aria-live/);
  assert.match(view, /function captureFocus/);
  assert.match(view, /function restoreFocus/);
  assert.match(view, /dataset\.focusKey/);
  assert.match(view, /headerRight\.setAttribute\('role', 'status'\)/);
  assert.match(view, /progress\.setAttribute\('role', 'progressbar'\)/);
  assert.match(controller, /lastRenderSignature/);
  assert.match(read('popup.css'), /@media \(forced-colors: active\)/);
});

test('toolbar badge uses an intuitive neutral pause treatment', () => {
  const background = read('background.js');
  assert.match(background, /status === 'paused' \? '❚❚'/u);
  assert.match(background, /status === 'paused' \? '#475569'/u);
  assert.doesNotMatch(background, /#d97706|status === 'paused' \? 'Ⅱ'/u);
});

test('page editor trusts contextId, keeps global voice choices implicit, and only closes after success', () => {
  const editor = read('page-voices.js');
  const view = read('popup-view.js');
  assert.match(editor, /query\.get\('contextId'\)/);
  assert.doesNotMatch(editor, /query\.get\('tabId'\)/);
  assert.match(editor, /reader:page-context:get'[\s\S]*\{ contextId \}/);
  assert.match(editor, /reader:page-context:apply'[\s\S]*contextId/);
  assert.match(editor, /filter\(\(select\) => Boolean\(select\.value\)\)/);
  assert.match(view, /跟随全局策略（当前：/);
  assert.match(view, /author\.effectiveVoice \|\| author\.voice \|\| '默认音色'/);
  const errorCheck = editor.indexOf("response && response.ok === false");
  const close = editor.indexOf('window.close();', editor.indexOf("reader:page-context:apply"));
  assert.ok(errorCheck >= 0 && close > errorCheck);
});

test('popup commands carry the current page identity', () => {
  const source = read('popup.js');
  assert.match(source, /pageKey: snapshot && snapshot\.pageKey \|\| context && context\.pageKey/);
  assert.match(source, /pageKey: pageContext && pageContext\.pageKey/);
});

test('the popup has no legacy sidebar or floating-orb surface and exposes page guide mode', () => {
  const source = [read('popup.html'), read('popup.css'), read('popup-view.js')].join('\n');
  assert.doesNotMatch(source, /qr-panel|qr-orb|侧栏/);
  assert.match(source, /页面导览/);
});

test('page guide uses the shared reader TTS protocol instead of an independent speech engine', () => {
  const guide = fs.readFileSync(path.join(__dirname, '..', 'page-guide.js'), 'utf8');
  assert.match(guide, /message\('reader\/tts'/u);
  assert.doesNotMatch(guide, /speechSynthesis|SpeechSynthesisUtterance/u);
});
