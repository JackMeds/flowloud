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

test('comparison lab connects Popup page-voice entry to an interactive C editor', () => {
  const lab = read('popup-lab.html');
  const script = read('popup-lab.js');
  const css = read('popup-lab.css');
  assert.match(lab, /page-voices-lab-status/);
  assert.match(lab, /调整本页配音/);
  for (const action of ['qwen-popup-command', 'open-page-editor', 'cancel-page-voices', 'save-page-voices']) {
    assert.match(script, new RegExp(action));
  }
  assert.match(script, /scrollIntoView/);
  assert.match(script, /已应用到本页预览/);
  assert.match(css, /qr-lab-editor-card\s*\{[^}]*width: min\(390px, 100%\)/);
  assert.match(read('popup.css'), /\.qr-page-root-compact\s*\{[^}]*padding: 0 16px 16px/);
  assert.match(read('popup.css'), /\.qr-page-root-compact \{ width: 100%; padding: 0 14px 14px/);
});

test('popup delegates complex current-page voice editing to a dedicated editor page', () => {
  const source = read('popup.js');
  for (const type of ['reader:active-context', 'reader:snapshot:get', 'reader:command', 'page-editor:open']) {
    assert.match(source, new RegExp(type));
  }
  assert.doesNotMatch(source, /reader:page-voices:(?:get|apply)/);
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
  const voiceStudio = read('voice-studio.html');
  assert.match(view, /switchRow\('clickToRead'/);
  assert.match(view, /switchRow\('showFloatingPlayer'/);
  assert.match(view, /selectRow\(\s*'preset'/);
  assert.match(view, /点击正文朗读/);
  assert.match(view, /显示网页悬浮球/);
  assert.match(view, /作者配音策略/);
  assert.match(view, /网页交互/);
  assert.match(controller, /api\.storage\.local\.set/);
  assert.match(controller, /qwenReaderSettings/);
  assert.match(voiceStudio, /返回语音与音色设置/);
  assert.doesNotMatch(voiceStudio, /name="(?:showFloatingPlayer|clickToRead|preset)"/);
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
  assert.match(view, /function captureScroll/);
  assert.match(view, /function restoreScroll/);
  assert.match(view, /data-scroll-key/);
  assert.match(view, /dataset\.focusKey/);
  assert.match(view, /status\.setAttribute\('role', 'status'\)/);
  assert.match(view, /progress\.setAttribute\('role', 'progressbar'\)/);
  assert.match(controller, /lastRenderSignature/);
  assert.match(read('popup.css'), /@media \(forced-colors: active\)/);
  assert.match(read('popup.css'), /\.qr-control-primary:hover/);
});

test('snapshot updates keep the popup shell stable and preserve its scroll container', () => {
  const view = read('popup-view.js');
  const mountStart = view.indexOf('function mountPopup');
  const pageEditorStart = view.indexOf('function mountPageVoices');
  assert.ok(mountStart >= 0 && pageEditorStart > mountStart);
  const mountSource = view.slice(mountStart, pageEditorStart);
  assert.doesNotMatch(mountSource, /root\.replaceChildren\(\)/);
  assert.match(view, /popupRefs\.set\(root, refs\)/);
  assert.match(read('popup.css'), /overscroll-behavior: contain/);
});

test('global interaction settings stay in Popup quick controls and are absent from the asset studio', () => {
  const view = read('popup-view.js');
  const voiceStudio = read('voice-studio.html');
  assert.match(view, /全局设置/);
  assert.match(view, /网页交互/);
  assert.doesNotMatch(voiceStudio, /name="showFloatingPlayer"/);
  assert.doesNotMatch(voiceStudio, /name="clickToRead"/);
  assert.doesNotMatch(voiceStudio, /name="preset"/);
  assert.doesNotMatch(voiceStudio, /settings-center\.js|provider-settings\.js/);
  assert.doesNotMatch(read('popup.html'), /popup-paper\.css/);
  assert.doesNotMatch(voiceStudio, /settings-paper\.css/);
});

test('toolbar keeps one logo and uses state-color icons without overlay badge glyphs', () => {
  const background = read('background.js');
  assert.match(background, /setBadgeText\(\{ tabId: target\.tabId, text: '' \}\)/u);
  assert.match(background, /flowloud-toolbar-\$\{normalized\}-16\.png/u);
  assert.match(background, /flowloud-toolbar-\$\{normalized\}-32\.png/u);
  assert.doesNotMatch(background, /'▶'|'❚❚'|'Ⅱ'/u);
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
