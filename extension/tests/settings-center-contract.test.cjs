const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const extensionRoot = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(extensionRoot, 'voice-studio.html'), 'utf8');
const reader = fs.readFileSync(path.join(extensionRoot, 'content', 'reader.js'), 'utf8');
const defaults = fs.readFileSync(path.join(extensionRoot, 'shared', 'defaults.js'), 'utf8');
const reactRoot = path.resolve(extensionRoot, '..', 'extension-wxt', 'components');
const workspace = fs.readFileSync(path.join(reactRoot, 'SettingsWorkspace.tsx'), 'utf8');
const voiceWorkbench = fs.readFileSync(path.join(reactRoot, 'VoiceWorkbench.tsx'), 'utf8');
const bridge = fs.readFileSync(path.join(reactRoot, 'runtime-bridge.ts'), 'utf8');

test('voice studio is an asset-only tool and links back to the unique Options voice section', () => {
  assert.doesNotMatch(html, /data-settings-section="(?:reader|engine|storage)"/u);
  assert.doesNotMatch(html, /settings-center\.js|provider-settings\.js/u);
  assert.match(html, /options-react\.html\?section=voice&amp;provider=local-service/u);
  assert.match(html, /开始录音/u);
  assert.match(html, /type="file"[^>]+multiple/u);
  assert.match(html, /音色库/u);
});

test('Options exposes one voice category with unified catalog, assignment, and provider configuration', () => {
  assert.match(workspace, /<Tab id="voice">[\s\S]*语音与音色/u);
  assert.doesNotMatch(workspace, /<Tab id="(?:engine|voices|roles)"/u);
  assert.match(voiceWorkbench, /统一音色库/u);
  assert.match(voiceWorkbench, /默认旁白/u);
  assert.match(voiceWorkbench, /人物对白/u);
  assert.match(voiceWorkbench, /网页临时音色[\s\S]*在 Popup 调整/u);
  assert.match(voiceWorkbench, /配置并验证/u);
  assert.doesNotMatch(voiceWorkbench, /demoCatalog|demoStatuses|demoSettings|demoMode/u);
  assert.match(voiceWorkbench, /setCatalog\(\[\]\)/u);
  assert.doesNotMatch(workspace, /voiceDemoMode/u);
  assert.match(bridge, /type:\s*'settings:voice:assign'/u);
  assert.match(bridge, /type:\s*'provider:status:list'/u);
});

test('visual setting changes update live reading without interrupting playback', () => {
  assert.match(reader, /const\s+previousVoiceAssignment\s*=\s*voiceAssignmentSignature\(settings\)/u);
  assert.match(reader, /if\s*\(!voiceAssignmentChanged\)\s*\{[\s\S]*?refreshReadingFocus\(\)[\s\S]*?refreshActiveWordStyle\(\)[\s\S]*?render\(\)[\s\S]*?return/u);
  assert.match(reader, /if\s*\(!voiceAssignmentChanged\)[\s\S]*?return;[\s\S]*?await\s+stopPlayback\(\)/u);
});

test('page click-to-read is opt-in and never cancels the site click event', () => {
  assert.match(defaults, /clickToRead:\s*false/u);
  assert.match(defaults, /showFloatingPlayer:\s*true/u);
  assert.match(defaults, /interactionVersion:\s*3/u);
  assert.match(reader, /Number\(value\.interactionVersion \|\| 0\) < 3[\s\S]*?\? false/u);
  const clickHandler = reader.slice(reader.indexOf('async function handlePageClick'), reader.indexOf('function handlePagePointerMove'));
  assert.doesNotMatch(clickHandler, /preventDefault|stopPropagation|stopImmediatePropagation/u);
  assert.match(clickHandler, /isInteractivePageTarget\(target\)/u);
  assert.match(clickHandler, /strictPoint:\s*true/u);
  assert.match(reader, /Math\.max\(0, Number\(segment\.floor\) - 1\)/u);
  assert.match(reader, /maxDistance:\s*options && options\.strictPoint \? 0 : 8/u);
});
