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

test('popup-first reader exposes a compact edge-snapping floating orb', () => {
  assert.equal(manifest.action.default_popup, 'popup-react.html');
  assert.match(readerSource, /class="qr-mini-player qr-mini-orb"/);
  assert.match(readerSource, /data-role="mini-player"/);
  assert.doesNotMatch(readerSource, /<aside class="qr-panel"/);
  assert.match(readerSource, /class="qr-mini-player qr-mini-orb"/);
  assert.match(readerSource, /data-mini-ui-version="visible-orb-v6"/);
  assert.match(readerSource, /class="qr-mini-launcher"[^>]*data-action="expand-mini-player"/);
  assert.equal((readerSource.match(/class="qr-mini-quick-button/g) || []).length, 2);
  assert.match(readerSource, /data-role="mini-avatar"[^>]*src=/);
  assert.doesNotMatch(readerSource, /ui:toggle/);
  assert.match(readerSource, /const readablePage = state\.status === "extracting" \|\| state\.segments\.length > 0/);
  assert.match(readerSource, /settings\.showFloatingPlayer !== false && readablePage/);
});

test('active floating orb has a small circular hit target and no panel chrome', () => {
  const player = cssRule('.qr-mini-player');
  const control = cssRule('.qr-mini-button');
  const primary = cssRule('.qr-mini-button.is-primary');
  assert.match(player, /position:\s*fixed/);
  assert.match(player, /visibility:\s*hidden/);
  assert.match(readerCss, /Visible-orb v6[\s\S]*?\.qr-mini-player\.qr-mini-orb\.is-minimized\s*\{[\s\S]*?width:\s*44px[\s\S]*?height:\s*44px/);
  assert.match(readerCss, /\.qr-mini-player\.qr-mini-orb\.is-minimized \.qr-mini-launcher\s*\{[\s\S]*?width:\s*40px[\s\S]*?height:\s*40px/);
  assert.match(readerCss, /is-minimized\.is-edge-snapped\[data-edge="right"\][\s\S]*?translateX\(12px\)/);
  assert.match(readerCss, /is-minimized\.is-edge-snapped\[data-edge="left"\][\s\S]*?translateX\(-12px\)/);
  assert.match(readerCss, /\.qr-mini-player\.is-visible[\s\S]*?pointer-events:\s*auto/);
  assert.match(control, /width:\s*36px/);
  assert.match(control, /height:\s*36px/);
  assert.match(primary, /width:\s*38px/);
  assert.match(primary, /height:\s*38px/);
  assert.match(readerCss, /@media \(max-width: 520px\)[\s\S]*?\.qr-mini-button \{ width: 40px; height: 40px; \}/);
  for (const action of ['previous', 'play-toggle', 'next', 'toggle-mini-size', 'resume-follow']) {
    assert.match(readerSource, new RegExp(`data-action="${action}"`));
  }
  assert.doesNotMatch(readerSource, /qr-mini-window-button is-close|data-role="mini-reopen"/);
});

test('floating quick play keeps its white transport glyph on a contrasting primary surface', () => {
  const playIcon = fs.readFileSync(path.join(extensionRoot, 'assets', 'icons', 'play.svg'), 'utf8');
  const pauseIcon = fs.readFileSync(path.join(extensionRoot, 'assets', 'icons', 'pause.svg'), 'utf8');
  assert.match(playIcon, /stroke="#ffffff"/i);
  assert.match(pauseIcon, /stroke="#ffffff"/i);
  assert.match(
    readerCss,
    /\.qr-mini-quick-button\.is-primary\s*\{[\s\S]*?border-color:\s*#2563eb[\s\S]*?color:\s*#fff[\s\S]*?background:\s*#2563eb/,
  );
  assert.doesNotMatch(
    readerCss,
    /\.qr-mini-quick-button\.is-primary\s*\{[\s\S]*?background:\s*#fff[\s\S]*?\}/,
  );
});

test('floating player exposes lifecycle status, minimization, and basic accessibility', () => {
  assert.match(readerSource, /role="region"[^>]*aria-labelledby="qr-mini-title"/);
  assert.match(readerSource, /data-role="mini-status"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(readerSource, /正在加载和识别网页文本/);
  assert.match(readerSource, /正在加载朗读模型/);
  assert.match(readerSource, /正在合成当前句/);
  assert.match(readerSource, /朗读失败/);
  assert.match(readerSource, /miniPlayerMinimized = !miniPlayerMinimized/);
  assert.match(readerSource, /settings\.showFloatingPlayer !== false/);
  assert.match(readerSource, /data-mini-ui-version="visible-orb-v6"/);
  assert.doesNotMatch(readerSource, /data-role="mini-size-icon"/);
  assert.equal((readerSource.match(/<button[^>]*data-action="toggle-mini-size"/g) || []).length, 1);
  assert.match(readerSource, /class="qr-mini-button is-collapse"[^>]*aria-label="收起网页悬浮播放器"/);
  assert.match(readerSource, /player\.classList\.contains\("is-minimized"\)/);
  assert.match(readerCss, /\.qr-mini-player\.qr-mini-orb:not\(\.is-minimized\)/);
  assert.doesNotMatch(readerSource, /qr-mini-follow-glyph|>↗</);
  assert.match(readerSource, /player\.inert = !active/);
  assert.match(readerSource, /visualViewport\.addEventListener\("resize", positionFloatingPlayer/);
  assert.match(readerCss, /Visible-orb v6[\s\S]*?\.qr-mini-player\.qr-mini-orb\.is-minimized \.qr-mini-launcher[\s\S]*?cursor:\s*grab/);
  assert.match(readerCss, /\.qr-mini-player\.qr-mini-orb:not\(\.is-minimized\)[\s\S]*?min-height:\s*126px/);
  assert.match(readerCss, /\[data-state="playing"\] \.qr-mini-signal-wave path[\s\S]*?qr-mini-signal-wave/);
  assert.match(readerCss, /\[data-state="paused"\] \.qr-mini-launcher[\s\S]*?#d97706/);
  assert.match(readerSource, /qr-mini-quick-actions is-above[\s\S]*?play-toggle[\s\S]*?resume-follow/);
  assert.doesNotMatch(readerSource, /qr-mini-quick-actions is-below/);
  assert.match(readerSource, /maximize:\s*chrome\.runtime\.getURL\("assets\/icons\/maximize-2\.svg"\)/);
  assert.match(readerSource, /minimize:\s*chrome\.runtime\.getURL\("assets\/icons\/minimize-2\.svg"\)/);
  assert.doesNotMatch(readerSource, /miniCollapseIconPath|M5 15l7-7 7 7/);
  assert.ok(manifest.web_accessible_resources[0].resources.includes('assets/icons/maximize-2.svg'));
  assert.ok(manifest.web_accessible_resources[0].resources.includes('assets/icons/minimize-2.svg'));
  assert.match(readerCss, /\.qr-mini-quick-actions\.is-above[\s\S]*?bottom:\s*44px[\s\S]*?padding-bottom:\s*8px/);
  assert.doesNotMatch(readerCss, /\.qr-mini-player\.qr-mini-orb\.is-minimized \.qr-mini-quick-actions\.is-below/);
  assert.match(readerCss, /\.qr-mini-player\.qr-mini-orb\.is-minimized:hover \.qr-mini-quick-actions[\s\S]*?visibility:\s*visible[\s\S]*?pointer-events:\s*auto/);
  assert.match(readerCss, /\.qr-mini-player\.qr-mini-orb:not\(\.is-minimized\)[\s\S]*?border:\s*1px solid #dbe4f0[\s\S]*?border-radius:\s*9px/);
  assert.doesNotMatch(readerCss, /border-radius:\s*9px 3px 3px 9px/);
  assert.doesNotMatch(readerCss, /border-left:\s*3px solid #2563eb/);
  assert.match(readerSource, /player\.classList\.contains\("is-minimized"\)[\s\S]*?miniPlayerMinimized = false;[\s\S]*?renderNow\(\);[\s\S]*?return;/);
  assert.doesNotMatch(readerCss, /\.qr-mini-reopen|\.qr-mini-window-button\.is-close/);
  assert.match(readerCss, /\.qr-mini-button\[hidden\][\s\S]*?display:\s*none/);
  assert.match(readerCss, /\.qr-mini-player\.qr-mini-orb\.is-edge-snapped\[data-edge="left"\]/);
  assert.match(readerCss, /\.qr-mini-player\.qr-mini-orb\.is-edge-snapped\[data-edge="right"\]/);
  assert.match(readerSource, /button\.hidden = false/);
  assert.match(readerSource, /data-role="mini-progress-bar"/);
  assert.match(readerSource, /data-action="retry-system-once"[^>]*>一次性改用系统语音</);
  assert.match(readerSource, /playIndex\(state\.index, \{ providerId: "browser-system" \}\)/);
  assert.match(readerCss, /\.qr-mini-provider-fallback/);
  assert.match(readerCss, /@media \(forced-colors: active\)/);
});

test('content keeps its marker, author cue, in-player follow control, and word motion', () => {
  assert.match(readerSource, /data-role="reading-marker"/);
  assert.match(readerSource, /function renderReadingMarker/);
  assert.match(readerSource, /data-action="marker-play"/);
  assert.match(readerSource, /qr-marker-voice/);
  assert.match(readerSource, /function markerVoiceLabel/);
  assert.match(readerSource, /function collectInteractiveRects/);
  assert.match(readerSource, /knownVoiceLabels\.get\(voiceId\)/);
  assert.doesNotMatch(readerSource, /"local-service":\s*"本地声音"/);
  assert.doesNotMatch(readerSource, /voice\.textContent\s*=\s*segment\.voice/);
  assert.match(readerSource, /qr-marker-context/);
  assert.match(readerSource, /qr-mini-button is-follow[^>]*data-action="resume-follow"/);
  assert.match(readerSource, /QwenReaderWordTimeline/);
  assert.match(readerSource, /data-role="word-motion-layer"/);
  assert.match(readerSource, /followController\.markManual\(\)/);
  assert.match(readerCss, /\.qr-reading-marker\s*\{[\s\S]*?position:\s*fixed/);
  assert.doesNotMatch(readerSource, /class="qr-follow-chip"/);
  assert.match(readerCss, /\.qr-mini-button\.is-follow\.is-needed/);
  assert.match(readerCss, /\.qr-word-motion-layer\s*\{[\s\S]*?position:\s*fixed/);
});

test('mini player supports bounded persistent dragging without stealing clicks', () => {
  assert.match(readerSource, /MINI_PLAYER_POSITION_KEY/);
  assert.match(readerSource, /function beginMiniPlayerDrag/);
  assert.match(readerSource, /Math\.hypot\(deltaX, deltaY\) < 5/);
  assert.match(readerSource, /normalizedMiniPlayerPosition/);
  assert.match(readerSource, /saveMiniPlayerPosition/);
  assert.match(readerSource, /miniPlayerSuppressClickUntil/);
  const dragStart = readerSource.match(/function beginMiniPlayerDrag\(event\)\s*\{([\s\S]*?)\n\s*\}/);
  assert.ok(dragStart, 'missing mini player drag start handler');
  assert.doesNotMatch(dragStart[1], /setPointerCapture/, 'pointer capture must not steal ordinary button clicks');
  assert.doesNotMatch(readerSource, /setPointerCapture|releasePointerCapture/);
  assert.match(readerSource, /window\.addEventListener\("pointermove", moveMiniPlayerDrag/);
  assert.match(readerSource, /window\.addEventListener\("pointerup", endMiniPlayerDrag/);
  assert.match(readerSource, /window\.addEventListener\("pointercancel", cancelMiniPlayerDrag/);
  assert.match(readerSource, /window\.addEventListener\("blur", abortMiniPlayerDrag/);
  assert.match(readerCss, /\.qr-mini-player[\s\S]*?touch-action:\s*none/);
  assert.match(readerCss, /\.qr-mini-player\.is-dragging/);
  assert.match(readerCss, /\.qr-mini-player\.is-snapping/);
  assert.match(readerSource, /player\.dataset\.edge = edge/);
  assert.match(readerSource, /player\.classList\.toggle\("is-edge-snapped", edge !== "none"\)/);
});

test('mini caption pans from the shared active-word timeline', () => {
  assert.match(readerSource, /data-role="mini-caption-track"/);
  assert.match(readerSource, /function renderMiniCaption/);
  assert.match(readerSource, /function updateMiniCaptionWord/);
  assert.match(readerSource, /result\.changed\) updateMiniCaptionWord/);
  assert.match(readerSource, /safeStart = viewportWidth \* \.28/);
  assert.match(readerSource, /safeEnd = viewportWidth \* \.68/);
  assert.match(readerCss, /\.qr-mini-caption-track[\s\S]*?transition:\s*transform 220ms/);
  assert.match(readerCss, /\.qr-mini-caption-word\.is-active/);
  assert.match(readerCss, /prefers-reduced-motion:\s*reduce[\s\S]*?\.qr-mini-caption-track/);
});

test('manual rescans await playback cancellation and only rebuild document state', () => {
  const refresh = readerSource.match(/async function refreshCurrentPage\(\)\s*\{([\s\S]*?)\n\s*\}/);
  assert.ok(refresh, 'missing manual rescan handler');
  assert.match(refresh[1], /await\s+stopPlayback\(\)/);
  assert.match(refresh[1], /await\s+scanCurrentPage\(["']manual["']\)/);
  assert.doesNotMatch(refresh[1], /playIndex\(|togglePlayback\(|seek\(/);
});

test('dynamic rescans extend the queue without resetting active playback', () => {
  assert.match(
    readerSource,
    /Player\.reduce\(state,\s*\(progressiveReady \|\| preserveDynamicQueue\) \? \{[\s\S]*?type:\s*"QUEUE_UPDATE"/,
  );
  assert.match(
    readerSource,
    /type:\s*\(progressiveReady \|\| preserveDynamicQueue\) \? "QUEUE_UPDATE" : "LOAD_SUCCESS"/,
  );
});

test('late voice discovery preserves a playback session that already started', () => {
  const loadVoices = readerSource.match(/async function loadVoices\(\)\s*\{([\s\S]*?)\n\s*async function reconcilePlaybackControl/);
  assert.ok(loadVoices, 'missing voice discovery handler');
  assert.match(loadVoices[1], /type:\s*"QUEUE_UPDATE"/);
  assert.doesNotMatch(loadVoices[1], /type:\s*"LOAD_SUCCESS"/);
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
  assert.match(rule[1], /background-color:\s*rgba\(37,\s*99,\s*235,\s*\.075\)/);
  assert.doesNotMatch(rule[1], /animation\s*:/);
  const readerContent = manifest.content_scripts.find((entry) => entry.js?.includes('content/reader.js'));
  assert.ok(readerContent);
  assert.equal(readerContent.run_at, 'document_idle');
  assert.ok(readerContent.css.includes('content/page-highlight.css'));
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8'), /insertCSS\(\{ target: \{ tabId \}, files: \['content\/page-highlight\.css'\]/);
});

test('click-to-read and manual follow behavior remain independent of the popup', () => {
  assert.match(readerSource, /settings\.clickToRead/);
  assert.match(readerSource, /function handlePageClick/);
  assert.match(readerSource, /SentenceRange\.pickSegmentIndexAtPoint/);
  assert.match(readerSource, /function findUnusedSegmentMatch/);
  assert.match(readerSource, /await seek\(matchingIndex\)/);
  assert.match(readerSource, /Follow\.isScrollIntent/);
  assert.match(readerSource, /followController\.resume\(\)/);
  assert.match(readerSource, /data-action="toggle-click-to-read"/);
  assert.match(readerSource, /clickToReadButton\.setAttribute\("aria-pressed"/);
  assert.match(readerCss, /\.qr-mini-button\.is-click-to-read\.is-selected/);
  assert.match(readerCss, /width:\s*min\(304px,\s*calc\(100vw - 24px\)\)/);
  assert.match(readerCss, /grid-template-columns:\s*repeat\(6,\s*40px\)/);
});

test('scroll tracking keeps expensive collision discovery outside the animation-frame hot path', () => {
  assert.match(readerSource, /scheduleOverlayUpdate\(true\)/);
  assert.match(readerSource, /scheduleOverlayUpdate\(false, true\)/);
  assert.match(readerSource, /function lightweightMarkerPlacement/);
  const schedulerStart = readerSource.indexOf('function scheduleOverlayUpdate');
  const schedulerEnd = readerSource.indexOf('function sourceLocatorKey', schedulerStart);
  assert.ok(schedulerStart >= 0 && schedulerEnd > schedulerStart, 'missing overlay scheduler');
  const scheduler = readerSource.slice(schedulerStart, schedulerEnd);
  const frameBody = scheduler.match(/requestAnimationFrame\(\(\) => \{([\s\S]*?)\n\s*\}\);/u);
  assert.ok(frameBody, 'missing overlay animation frame');
  assert.doesNotMatch(frameBody[1], /collectOccupiedTextRects|collectInteractiveRects/);
});

test('motion remains restrained and respects reduced-motion preferences', () => {
  const motionCss = pageHighlightCss + readerCss;
  assert.match(motionCss, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(motionCss, /prefers-reduced-motion:\s*reduce[\s\S]*?\.qr-word-motion-cursor[\s\S]*?animation:\s*none/);
  assert.doesNotMatch(motionCss, /animation-duration:\s*(?:[4-9]\d\d|\d{4,})ms/);
});
