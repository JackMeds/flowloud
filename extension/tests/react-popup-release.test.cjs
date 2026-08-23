const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const extensionRoot = path.resolve(__dirname, '..');

test('release manifest points at synchronized React production surfaces without Storybook error-symbol leakage', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'manifest.json'), 'utf8'));
  assert.equal(manifest.action.default_popup, 'popup-react.html');
  assert.equal(manifest.options_page, 'options-react.html');

  const registry = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'react-ui-build.json'), 'utf8'));
  assert.ok(registry.files.includes('popup-react.html'));
  assert.ok(registry.files.includes('options-react.html'));
  for (const relative of registry.files) {
    assert.ok(fs.existsSync(path.join(extensionRoot, relative)), `missing synchronized React asset: ${relative}`);
  }

  const popupHtml = fs.readFileSync(path.join(extensionRoot, 'popup-react.html'), 'utf8');
  const entryMatch = popupHtml.match(/<script\b[^>]+src=["']([^"']*popup-[^"']+\.js)["']/u);
  assert.ok(entryMatch, 'React Popup entry chunk is missing');
  const entry = fs.readFileSync(path.resolve(extensionRoot, entryMatch[1].replace(/^\//u, '')), 'utf8');
  assert.doesNotMatch(entry, /instanceof\s+[A-Za-z_$][\w$]*/u, 'Popup entry must not bind the native Error constructor to a Storybook export');
  assert.match(entry, /globalThis\.Error/u);

  const optionsHtml = fs.readFileSync(path.join(extensionRoot, 'options-react.html'), 'utf8');
  const optionsEntryMatch = optionsHtml.match(/<script\b[^>]+src=["']([^"']*options-[^"']+\.js)["']/u);
  assert.ok(optionsEntryMatch, 'React settings entry chunk is missing');
  const productionScripts = registry.files.filter((relative) => relative.endsWith('.js'))
    .map((relative) => fs.readFileSync(path.join(extensionRoot, relative), 'utf8')).join('\n');
  assert.match(productionScripts, /settings:secrets:status/u);
  assert.match(productionScripts, /provider:model:/u);
  assert.match(productionScripts, /provider:test/u);

  const story = fs.readFileSync(path.resolve(extensionRoot, '..', 'extension-wxt', 'components', 'PopupConsole.stories.tsx'), 'utf8');
  assert.doesNotMatch(story, /export\s+const\s+Error\b/u);
});

test('React settings requests exact origins and cancels the active browser-model request identity', () => {
  const sourceRoot = path.resolve(extensionRoot, '..', 'extension-wxt', 'components');
  const settings = fs.readFileSync(path.join(sourceRoot, 'SettingsWorkspace.tsx'), 'utf8');
  const bridge = fs.readFileSync(path.join(sourceRoot, 'runtime-bridge.ts'), 'utf8');
  assert.match(settings, /requestOnlineOrigin\(providerDrafts\['openai-compatible'\]\.baseUrl\)/u);
  assert.match(settings, /requestLocalOrigin\(providerDrafts\['local-service'\]\.baseUrl\)/u);
  assert.match(settings, /activeModelRequestId\.current\s*=\s*requestId[\s\S]*modelAction\('download', requestId\)/u);
  assert.match(settings, /modelAction\('cancel', requestId\)/u);
  assert.match(bridge, /\['localhost', '127\.0\.0\.1', '\[::1\]'\]\.includes\(parsed\.hostname\)/u);
  assert.match(bridge, /在线 TTS 必须使用 HTTPS/u);
  assert.match(bridge, /permissions\.request\(\{ origins: \[`\$\{parsed\.origin\}\/\*`\] \}\)/u);
});

test('React popup renders the live word boundary from the reader snapshot instead of a hard-coded phrase', () => {
  const sourceRoot = path.resolve(extensionRoot, '..', 'extension-wxt', 'components');
  const popup = fs.readFileSync(path.join(sourceRoot, 'PopupConsole.tsx'), 'utf8');
  const bridge = fs.readFileSync(path.join(sourceRoot, 'runtime-bridge.ts'), 'utf8');
  assert.doesNotMatch(popup, /const\s+activePhrase\s*=\s*['"]作者配音/u);
  assert.match(popup, /words\?\.\[Number\(wordIndex\)\]/u);
  assert.match(popup, /text\.slice\(active\.sourceStart, active\.sourceEnd\)/u);
  assert.match(bridge, /currentWords:\s*words/u);
  assert.match(bridge, /currentWordIndex:/u);
});

test('React popup does not repeat the toolbar logo and keeps the header state on one compact line', () => {
  const sourceRoot = path.resolve(extensionRoot, '..', 'extension-wxt');
  const popup = fs.readFileSync(path.join(sourceRoot, 'components', 'PopupConsole.tsx'), 'utf8');
  const css = fs.readFileSync(path.join(sourceRoot, 'styles', 'components.css'), 'utf8');
  assert.doesNotMatch(popup, /fl-brand-mark[^\n]*flowloud-mark/u);
  assert.match(popup, /className="fl-header-summary"/u);
  assert.match(popup, /className="fl-header-settings"/u);
  assert.match(css, /\.fl-header-settings[\s\S]*?white-space:\s*nowrap/u);
});

test('production popup fixes its real extension dimensions, expands daily settings, and edits voices inline', () => {
  const sourceRoot = path.resolve(extensionRoot, '..', 'extension-wxt');
  const popup = fs.readFileSync(path.join(sourceRoot, 'components', 'PopupConsole.tsx'), 'utf8');
  const runtime = fs.readFileSync(path.join(sourceRoot, 'components', 'RuntimePopup.tsx'), 'utf8');
  const bridge = fs.readFileSync(path.join(sourceRoot, 'components', 'runtime-bridge.ts'), 'utf8');
  const css = fs.readFileSync(path.join(sourceRoot, 'styles', 'components.css'), 'utf8');
  const tokens = fs.readFileSync(path.join(sourceRoot, 'styles', 'tokens.css'), 'utf8');
  const html = fs.readFileSync(path.join(sourceRoot, 'entrypoints', 'popup', 'index.html'), 'utf8');
  assert.match(html, /body class="fl-popup-document"/u);
  assert.match(tokens, /body\.fl-popup-document[\s\S]*?width:\s*420px[\s\S]*?height:\s*600px/u);
  assert.doesNotMatch(css, /@media\s*\(max-width:\s*440px\)[\s\S]*?\.fl-console\s*\{\s*width:\s*100vw/u);
  assert.match(css, /\.fl-popup-tab-panel[\s\S]*?flex:\s*1 1 228px/u);
  assert.match(css, /\.fl-popup-tab-panel[\s\S]*?scrollbar-gutter:\s*auto/u);
  assert.match(popup, /label="当前音色"/u);
  assert.match(popup, /检查连接/u);
  assert.match(popup, /model\.authors\.map/u);
  assert.match(popup, /onPageVoiceChange/u);
  assert.match(popup, /不会离开 Popup/u);
  assert.doesNotMatch(runtime, /type:\s*'page-editor:open'/u);
  assert.match(runtime, /changeVoice/u);
  assert.match(runtime, /changePageVoice/u);
  assert.match(bridge, /type:\s*'voice:list'/u);
  assert.match(bridge, /type:\s*'reader:page-voices:get'/u);
  assert.match(bridge, /type:\s*'reader:page-voices:apply'/u);
});

test('React popup explains role strategies and reports pause intent immediately', () => {
  const sourceRoot = path.resolve(extensionRoot, '..', 'extension-wxt', 'components');
  const popup = fs.readFileSync(path.join(sourceRoot, 'PopupConsole.tsx'), 'utf8');
  const runtime = fs.readFileSync(path.join(sourceRoot, 'RuntimePopup.tsx'), 'utf8');
  const model = fs.readFileSync(path.join(sourceRoot, 'model.ts'), 'utf8');
  assert.match(model, /preset:\s*'everyone-one'/u);
  assert.match(popup, /所有人使用同一配音[\s\S]*默认推荐，最稳定/u);
  assert.match(popup, /查看全部配音策略说明/u);
  assert.match(popup, /model\.controlNotice/u);
  assert.match(runtime, /正在立即停止声音并保存当前位置/u);
  assert.match(runtime, /继续时会从当前词重新开始/u);
});

test('React floating player previews the selected half-hidden quick-action design', () => {
  const sourceRoot = path.resolve(extensionRoot, '..', 'extension-wxt');
  const floating = fs.readFileSync(path.join(sourceRoot, 'components', 'FloatingPlayer.tsx'), 'utf8');
  const css = fs.readFileSync(path.join(sourceRoot, 'styles', 'components.css'), 'utf8');
  assert.match(floating, /fl-floating-edge-control/u);
  assert.match(floating, /fl-floating-quick-actions/u);
  assert.match(floating, /fl-floating-quick-actions is-above[\s\S]*?暂停朗读[\s\S]*?回到当前朗读位置/u);
  assert.doesNotMatch(floating, /fl-floating-quick-actions is-below|打开完整悬浮播放器/u);
  assert.match(floating, /AudioLines/u);
  assert.match(floating, /LoaderCircle/u);
  assert.match(floating, /CircleAlert/u);
  assert.match(floating, /Minimize2/u);
  assert.doesNotMatch(floating, /ChevronUp/u);
  assert.match(css, /\.fl-floating-edge-control[\s\S]*?translate\(22px, -50%\)/u);
  assert.match(css, /\.fl-orb[\s\S]*?width:\s*40px[\s\S]*?height:\s*40px/u);
  assert.match(css, /\.fl-floating-hit-area[\s\S]*?width:\s*44px[\s\S]*?height:\s*44px/u);
  assert.match(css, /\.fl-floating-quick-actions[\s\S]*?gap:\s*8px/u);
  assert.match(css, /\.fl-floating-quick-actions\.is-above[\s\S]*?bottom:\s*44px[\s\S]*?padding-bottom:\s*8px/u);
  assert.doesNotMatch(css, /\.fl-floating-quick-actions\.is-below/u);
  assert.match(css, /\.fl-floating-player[\s\S]*?border:\s*1px solid var\(--fl-line\)[\s\S]*?border-radius:\s*9px/u);
  assert.doesNotMatch(css, /\.fl-floating-player[^\n]*border-left/u);
  assert.match(css, /prefers-reduced-motion:\s*reduce[\s\S]*?fl-floating-signal-loader/u);
});
