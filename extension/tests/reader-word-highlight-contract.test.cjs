const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'content', 'reader.js'),
  'utf8',
);
const css = fs.readFileSync(
  path.join(__dirname, '..', 'content', 'reader.css'),
  'utf8',
);
const pageCss = fs.readFileSync(
  path.join(__dirname, '..', 'content', 'page-highlight.css'),
  'utf8',
);

test('reader builds and updates a separate word highlight without moving follow or marker state', () => {
  assert.match(source, /QwenReaderWordTimeline/);
  assert.match(source, /speechSourceMap/);
  assert.match(source, /speechMap\.words/);
  assert.match(source, /SentenceRange\.findSubranges/);
  assert.match(source, /qwen-reader-current-word/);
  assert.match(source, /WordTimeline\.applyProgress/);
  assert.match(source, /event === "progress"/);
  assert.match(source, /event === "boundary"/);
  assert.match(source, /charIndex:\s*Math\.max\(0,\s*Number\(message\.charIndex\)/);

  const wordUpdater = source.match(/function\s+highlightWord\(index\)\s*\{([\s\S]*?)\n\s*\}/);
  assert.ok(wordUpdater);
  assert.doesNotMatch(wordUpdater[1], /centerSegment|renderReadingMarker/);
});

test('reader has an exact DOM fallback when Custom Highlight is unavailable', () => {
  assert.match(source, /function\s+customHighlightRegistry\s*\(/);
  assert.match(source, /function\s+textNodesForRange\s*\(/);
  assert.match(source, /document\.createTreeWalker\(walkerRoot,\s*4\)/);
  assert.match(source, /function\s+installWordFallback\s*\(range\)/);
  assert.match(source, /qwen-reader-speaking-word/);
  assert.match(source, /function\s+restoreWordFallback\s*\(/);
  assert.match(source, /invalidateWordRangeCaches\(\)/);
  assert.match(source, /if\s*\(installWordFallback\(range\)\)\s*\{[\s\S]*?highlightedWordIndex\s*=\s*index/);

  assert.match(source, /function\s+installWordFallback\(range\)[\s\S]*?splitText/);
  assert.match(source, /function\s+installWordFallback\(range\)[\s\S]*?data-qwen-reader-word-fallback/);
});

test('word fallback cleanup is shared by native cleanup and does not scroll', () => {
  assert.match(source, /function\s+clearNativeHighlight\(\)[\s\S]*?restoreWordFallback/);

  const wordUpdater = source.match(/function\s+highlightWord\(index\)\s*\{([\s\S]*?)\n\s*\}/);
  assert.ok(wordUpdater);
  assert.doesNotMatch(wordUpdater[1], /centerSegment|scrollIntoView|scrollBy|renderReadingMarker/);
});

test('reader feeds ordinary audio timing events into the same word timeline', () => {
  assert.match(source, /loadedmetadata/);
  assert.match(source, /timeupdate/);
  assert.match(source, /updateAudioWordProgress/);
  assert.match(source, /message\.done === true/);
  assert.match(source, /completedStreamSession/);
  assert.match(source, /segmentIndex/);
});

test('fixed glyph light sweeps are isolated from page layout and follow the highlight lifecycle', () => {
  assert.match(source, /data-role="word-motion-layer"/);
  assert.match(source, /function\s+showWordMotion\s*\(range,\s*wordIndex\)/);
  assert.match(source, /function\s+retireWordMotion\s*\(/);
  assert.match(source, /function\s+clearWordMotion\s*\(/);
  assert.match(source, /function\s+positionWordMotion\s*\(/);
  assert.match(source, /showWordMotion\(range,\s*index\)/);
  assert.match(css, /\.qr-word-motion-layer\s*\{[\s\S]*?position:\s*fixed/);
  assert.match(css, /\.qr-word-motion-layer\s*\{[\s\S]*?pointer-events:\s*none/);
  assert.match(source, /function\s+ensureWordMotionCursor\s*\(/);
  assert.match(source, /function\s+moveWordMotionCursor\s*\(/);
  assert.doesNotMatch(source, /overshoot|rebound|cursor\.animate/);
  assert.match(source, /cursor\.classList\.add\("is-running"\)/);
  assert.match(source, /function\s+styleWordMotionInk\s*\(/);
  assert.match(source, /ink\.textContent\s*=\s*range\.toString\(\)/);
  assert.match(css, /\.qr-word-motion-ink::after\s*\{[\s\S]*?radial-gradient[\s\S]*?background-clip:\s*text/);
  assert.match(css, /\.qr-word-motion-cursor\s*\{[\s\S]*?height:\s*2px[\s\S]*?radial-gradient/);
  assert.match(css, /\.qr-word-motion-cursor::after\s*\{[\s\S]*?left:\s*var\(--qr-beam-x\)/);
  assert.match(pageCss, /qwen-reader-word-style-edge-dissolve[\s\S]*?radial-gradient[\s\S]*?background-clip:\s*text/);
  assert.match(pageCss, /@keyframes\s+qwen-reader-edge-position/);
  assert.doesNotMatch(pageCss, /qwen-reader-ink-settle|translateX\(calc\(var\(--qwen-reader-inertia/);
  assert.doesNotMatch(source, /scrollIntoView[\s\S]{0,160}showWordMotion|showWordMotion[\s\S]{0,160}scrollIntoView/);
});

test('word focus motion has reduced-motion, pause, and cleanup protections', () => {
  assert.match(source, /qwen-reader-word-motion-paused/);
  assert.match(source, /state\.status\s*===\s*"paused"\s*&&\s*highlightedWordIndex\s*>=\s*0/);
  assert.match(source, /qwen-reader-word-ink-overlay/);
  assert.match(source, /layer\.replaceChildren\(\)/);
  assert.match(source, /state\.status\s*===\s*"paused"\s*&&\s*progress\.paused\s*!==\s*false/);
  assert.match(css, /prefers-reduced-motion:\s*reduce[\s\S]*?\.qr-word-motion-cursor/);
  assert.match(css, /\.qr-word-motion-layer\.is-paused[\s\S]*?animation-play-state:\s*paused/);
  assert.match(source, /paused\s*&&\s*animation\.playState\s*===\s*"running"[\s\S]*?animation\.pause\(\)/);
  assert.match(pageCss, /html\.qwen-reader-word-motion-paused[\s\S]*?animation-play-state:\s*paused/);
});

test('word switching reuses one light cursor while terminal paths clear every resource', () => {
  const switchFlow = source.match(/function\s+highlightWord\(index\)[\s\S]*?function\s+prefersReducedWordMotion/);
  assert.ok(switchFlow);
  assert.match(switchFlow[0], /retireWordMotion\(\)[\s\S]*?showWordMotion\(range,\s*index\)/);
  assert.doesNotMatch(switchFlow[0], /retireWordMotion\(\)[\s\S]*?clearWordMotion\(\)[\s\S]*?showWordMotion/);

  const clearMotion = source.match(/function\s+clearWordMotion\(\)[\s\S]*?\n\s*\}/);
  assert.ok(clearMotion);
  assert.match(clearMotion[0], /wordMotionRange\s*=\s*null/);
  assert.match(clearMotion[0], /wordMotionCursorRect\s*=\s*null/);
  assert.match(clearMotion[0], /clearTimeout/);
  assert.match(source, /classList\.remove\("qwen-reader-word-ink-overlay"\)/);
  assert.match(source, /layer\.replaceChildren\(\)/);
  assert.match(source, /layer\.classList\.remove\("is-paused"\)/);
  assert.match(source, /document\.documentElement\.classList\.remove\("qwen-reader-word-motion-paused"\)/);
  assert.match(source, /function\s+clearNativeHighlight\(\)[\s\S]*?clearWordMotion\(\)/);
  assert.match(source, /function\s+clearHighlight\(\)[\s\S]*?clearWordMotion\(\)/);
});

test('fixed ink hides the native glyph while its light copy is visible and keeps the exact wrapper fallback', () => {
  const wordUpdater = source.match(/function\s+highlightWord\(index\)[\s\S]*?function\s+prefersReducedWordMotion/);
  assert.ok(wordUpdater);
  assert.match(wordUpdater[0], /customHighlightRegistry\(\)[\s\S]*?installWordFallback\(range\)/);
  assert.match(source, /ink\.dataset\.word\s*=\s*range\.toString\(\)/);
  assert.doesNotMatch(source, /--qwen-reader-inertia-direction/);
  assert.match(source, /if\s*\(!wordFallbackMarks\.length\)[\s\S]*?qr-word-motion-ink/);
  assert.match(source, /classList\.add\("qwen-reader-word-ink-overlay"\)/);
  assert.match(source, /querySelectorAll\("\.qr-word-motion-ink"\)[\s\S]*?ink\.remove\(\)/);
  assert.match(pageCss, /html\.qwen-reader-word-ink-overlay\s+::highlight\(qwen-reader-current-word\)\s*\{[\s\S]*?color:\s*transparent/);
  assert.match(pageCss, /-webkit-text-fill-color:\s*transparent/);
  assert.match(css, /\.qr-word-motion-ink\s*\{[^}]*transform:\s*none/);
});

test('stop, stream errors, and audio errors share idempotent word-motion cleanup', () => {
  assert.match(source, /function\s+stopPlayback\(options\)[\s\S]*?clearHighlight\(\)/);
  assert.match(source, /event\s*===\s*"error"[\s\S]*?clearHighlight\(\)/);
  assert.match(source, /audio\.onerror\s*=\s*\(\)\s*=>[\s\S]*?clearHighlight\(\)/);
  assert.match(source, /function\s+clearWordMotion\(\)[\s\S]*?layer\.replaceChildren\(\)/);
});

test('page highlight styles are extension-declared instead of CSP-sensitive inline style', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));
  const readerContent = manifest.content_scripts.find((entry) => entry.js?.includes('content/reader.js'));
  assert.ok(readerContent);
  assert.deepEqual(readerContent.matches, ['http://*/*', 'https://*/*']);
  assert.ok(readerContent.css.includes('content/page-highlight.css'));
  const background = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
  assert.match(background, /insertCSS\(\{ target: \{ tabId \}, files: \['content\/page-highlight\.css'\]/);
  assert.match(pageCss, /::highlight\(qwen-reader-current-word\)/);
  assert.match(pageCss, /\.qwen-reader-speaking-word/);
  assert.doesNotMatch(source, /createElement\(["']style["']\)|qwen-reader-page-style/);
});

test('reader retries a lazy first-sentence DOM mapping instead of caching a broad fallback', () => {
  assert.match(source, /function\s+refreshSegmentLocation\s*\(index\)/);
  assert.match(source, /function\s+scheduleHighlightRetry\s*\(index\)/);
  assert.match(source, /failed[\s\S]*matches must remain retryable/);
  assert.match(source, /if\s*\(range\)\s*sentenceRanges\.set\(candidateIndex,\s*range\)/);
  assert.match(source, /ranges\.length\s*===\s*words\.length\s*&&\s*ranges\.every\(Boolean\)/);
  assert.match(source, /highlightCurrent\(\{\s*deferBroadFallback:\s*true\s*\}\)/);
  assert.match(source, /if\s*\(!range\)\s*scheduleHighlightRetry\(index\)/);
});

test('lazy repeated sentences prefer their stable source offsets and never reuse an occupied copy', () => {
  const rangeResolver = source.match(/function\s+getSegmentRange\(index\)\s*\{([\s\S]*?)\n\s*function\s+createDocumentRange/);
  assert.ok(rangeResolver);
  assert.match(rangeResolver[1], /const\s+stableSourceStart\s*=\s*Number\(candidate\s*&&\s*candidate\.sourceStart\)/);
  assert.match(rangeResolver[1], /SentenceRange\.findSegment\(textIndex,[\s\S]*?preferredCursor\)/);
  assert.match(rangeResolver[1], /currentMatchIsReused/);
  assert.match(source, /bestDistance\s*=\s*Number\.POSITIVE_INFINITY/);
  assert.match(rangeResolver[1], /if\s*\(!match\)\s*\{[\s\S]*?sentenceMatches\.delete\(candidateIndex\);[\s\S]*?return null/);
});

test('a shared multi-sentence element is never used as a whole-element highlight fallback', () => {
  assert.match(source, /const\s+sharesElement\s*=\s*\(sourceIndicesByElement\.get\(element\)\s*\|\|\s*\[\]\)\.length\s*>\s*1/);
  assert.match(source, /!installNativeHighlight\(range\)\s*&&\s*!deferBroadFallback\s*&&\s*!sharesElement/);
});

test('reader ignores a pause response that lost an ended-event race', () => {
  assert.match(source, /const\s+controlSession\s*=\s*activeSession/);
  assert.match(source, /activeSession\s*!==\s*controlSession\s*\|\|\s*desiredPlaybackPaused\s*!==\s*desiredPaused/);
  assert.match(source, /if\s*\(activeSession\)\s*void\s+reconcilePlaybackControl\(\)/);
});
