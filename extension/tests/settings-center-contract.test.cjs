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
const voiceSources = fs.readFileSync(path.join(reactRoot, 'VoiceSourceCards.tsx'), 'utf8');
const voiceStrategy = fs.readFileSync(path.join(reactRoot, 'VoiceStrategyPanel.tsx'), 'utf8');
const voiceCatalog = fs.readFileSync(path.join(reactRoot, 'VoiceCatalog.tsx'), 'utf8');
const providerSetup = fs.readFileSync(path.join(reactRoot, 'VoiceProviderSetup.tsx'), 'utf8');
const bridge = fs.readFileSync(path.join(reactRoot, 'runtime-bridge.ts'), 'utf8');

test('voice studio is an asset-only tool and links back to the unique Options voice section', () => {
  assert.doesNotMatch(html, /data-settings-section="(?:reader|engine|storage)"/u);
  assert.doesNotMatch(html, /settings-center\.js|provider-settings\.js/u);
  assert.match(html, /options-react\.html\?section=voice&amp;provider=local-service/u);
  assert.match(html, /开始录音/u);
  assert.match(html, /type="file"[^>]+multiple/u);
  assert.match(html, /音色库/u);
});

test('Options exposes one task-oriented voice category with unified catalog, assignment, and provider configuration', () => {
  assert.match(workspace, /<Tab id="voice">[\s\S]*声音/u);
  assert.doesNotMatch(workspace, /<Tab id="(?:engine|voices|roles)"/u);
  assert.match(voiceWorkbench, /声音中心/u);
  assert.match(voiceSources, /选择并配置声音来源/u);
  assert.match(voiceStrategy, /默认旁白是单选/u);
  assert.match(voiceCatalog, /全选当前结果/u);
  assert.match(voiceCatalog, /清空声音池/u);
  assert.match(providerSetup, /创建或导入本地音色/u);
  assert.match(providerSetup, /复制扩展配对令牌/u);
  assert.match(providerSetup, /发布包不包含网关和模型/u);
  assert.doesNotMatch(voiceWorkbench, /demoCatalog|demoStatuses|demoSettings|demoMode/u);
  assert.match(voiceWorkbench, /setCatalog\(\[\]\)/u);
  assert.doesNotMatch(workspace, /voiceDemoMode/u);
  assert.match(bridge, /type:\s*'settings:voice:assign'/u);
  assert.match(bridge, /type:\s*'provider:status:list'/u);
});

test('settings search exposes complete paths and the four task entry points', () => {
  for (const tab of ['朗读', '声音', '文档工具', '数据与帮助']) assert.match(workspace, new RegExp(`<Tab id="[^"]+">[\\s\\S]*${tab}`, 'u'));
  assert.match(workspace, /搜索设置/u);
  assert.ok(workspace.includes("path: '声音 / 声音来源'"));
  assert.ok(workspace.includes("path: '声音 / 配音方式与声音池'"));
  assert.ok(workspace.includes("path: '声音 / 浏览器模型与下载'"));
  assert.ok(workspace.includes("scrollIntoView({ behavior: 'smooth'"));
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
  assert.doesNotMatch(reader, /Math\.max\(0, Number\(segment\.floor\) - 1\)/u);
  assert.match(reader, /targetForumPostId\(target\)/u);
  assert.match(reader, /maxDistance:\s*options && options\.strictPoint \? 0 : 8/u);
});
