const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const extensionRoot = path.join(__dirname, '..');
const studioHtml = fs.readFileSync(path.join(extensionRoot, 'voice-studio.html'), 'utf8');
const studioSource = fs.readFileSync(path.join(extensionRoot, 'voice-studio.js'), 'utf8');
const studioCss = fs.readFileSync(path.join(extensionRoot, 'voice-studio.css'), 'utf8');
const studioHarness = fs.readFileSync(path.join(__dirname, 'browser', 'voice-studio-harness.html'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'manifest.json'), 'utf8'));

function openingTags(name) {
  return [...studioHtml.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'giu'))].map((match) => match[0]);
}

function hasSemanticHook(tag, pattern) {
  return new RegExp(`(?:id|class|data-(?:role|action))=["'][^"']*${pattern.source}[^"']*["']`, 'iu').test(tag);
}

function functionBody(name) {
  const signature = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`, 'u').exec(studioSource);
  assert.ok(signature, `missing function ${name}`);
  const open = studioSource.indexOf('{', signature.index);
  let depth = 0;
  for (let index = open; index < studioSource.length; index += 1) {
    if (studioSource[index] === '{') depth += 1;
    if (studioSource[index] === '}') depth -= 1;
    if (depth === 0) return studioSource.slice(open + 1, index);
  }
  assert.fail(`unterminated function ${name}`);
}

test('voice studio loads the shared import, naming, library, and transcription modules before its controller', () => {
  const requiredScripts = [
    'shared/audio-import.js',
    'shared/voice-naming.js',
    'shared/voice-library.js',
    'shared/transcription.js',
  ];
  const controllerIndex = studioHtml.indexOf('voice-studio.js');
  assert.ok(controllerIndex >= 0, 'voice studio controller script is missing');
  for (const script of requiredScripts) {
    const dependencyIndex = studioHtml.indexOf(script);
    assert.ok(dependencyIndex >= 0, `missing voice studio dependency: ${script}`);
    assert.ok(dependencyIndex < controllerIndex, `${script} must load before voice-studio.js`);
  }
});

test('batch voice samples are not constrained by the default storage.local quota', () => {
  assert.ok(manifest.permissions.includes('unlimitedStorage'));
});

test('the studio clearly distinguishes local voice registration from online transcript recognition', () => {
  assert.match(studioHtml, /本机 Qwen/u);
  assert.match(studioHtml, /Edge 在线语音服务|Microsoft/u);
  assert.doesNotMatch(studioHtml, /不上传到互联网/u);
});

test('voice studio exposes an accessible multi-file import and batch review flow', () => {
  const fileInput = openingTags('input').find((tag) => /type=["']file["']/iu.test(tag));
  assert.ok(fileInput, 'missing local audio file input');
  assert.match(fileInput, /\bmultiple(?:\s*=\s*["'](?:multiple|true)?["'])?/iu);
  assert.match(fileInput, /accept=["'][^"']*audio\//iu);

  const dropZone = openingTags('section').concat(openingTags('div'), openingTags('label'))
    .find((tag) => hasSemanticHook(tag, /drop(?:zone|area)?|drop-zone/iu));
  assert.ok(dropZone, 'missing a semantic drag-and-drop target');

  const batchQueue = openingTags('ul').concat(openingTags('ol'), openingTags('div'))
    .find((tag) => hasSemanticHook(tag, /(?:batch|import)[-_ ]?(?:queue|list)|(?:queue|list)[-_ ]?(?:batch|import)/iu));
  assert.ok(batchQueue, 'missing a visible batch import queue');

  const saveAll = openingTags('button').find((tag) => (
    hasSemanticHook(tag, /(?:save|import)[-_ ]?(?:all|batch)|(?:all|batch)[-_ ]?(?:save|import)/iu)
  ));
  assert.ok(saveAll, 'missing a save-all/import-all action');

  assert.match(studioSource, /addEventListener\(\s*["']dragover["']/);
  assert.match(studioSource, /addEventListener\(\s*["']drop["']/);
});

test('voice studio records either microphone input or explicitly shared computer audio', () => {
  const sourceButtons = openingTags('button').filter((tag) => /data-record-source=/iu.test(tag));
  assert.equal(sourceButtons.length, 2);
  assert.ok(sourceButtons.some((tag) => /data-record-source=["']microphone["']/iu.test(tag)));
  assert.ok(sourceButtons.some((tag) => /data-record-source=["']system-audio["']/iu.test(tag)));
  assert.match(studioSource, /mediaDevices\.getDisplayMedia\(/u);
  assert.match(studioSource, /systemAudio:\s*["']include["']/u);
  assert.match(studioSource, /stream\.getAudioTracks\(\)\.length/u);
  assert.match(studioSource, /system_audio_missing/u);
  assert.match(studioSource, /audioTrack\.addEventListener\(["']ended["']/u);
  assert.match(studioSource, /state\.stream\.getTracks\(\)\.forEach\(\(track\)\s*=>\s*track\.stop\(\)\)/u);
  assert.doesNotMatch(manifest.permissions.join(','), /desktopCapture|tabCapture/u);
});

test('every imported file is decoded, prepared, transcribed, profiled, and saved independently', () => {
  assert.match(studioSource, /(?:Array\.from\([^)]*\.files|\.files\b|dataTransfer\.files)/);
  assert.match(studioSource, /(?:for\s*\([^)]*\bfile\b[^)]*\)|\.map\(\s*(?:async\s*)?\(?\s*file\b)/);
  assert.match(studioSource, /QwenReaderAudioImport\.decodeFile\(\s*file\b/);
  assert.match(studioSource, /QwenReaderAudioImport\.processAudioBuffer\(/);
  assert.match(studioSource, /QwenReaderTranscription\.(?:transcribeWithRetry|createEdgeSpeechProvider)\(/);
  assert.match(studioSource, /QwenReaderVoiceLibrary\.createImportedProfile\(/);
  assert.match(studioSource, /type:\s*["']voice:save["']/);
});

test('only complete browser-local voices offer rename controls while backend voices are clearly read-only', () => {
  assert.match(studioSource, /type:\s*["']voice:rename["']/);
  assert.match(studioSource, /oldName\s*:/);
  assert.match(studioSource, /newName\s*:/);

  const renderer = functionBody('renderVoiceRow');
  assert.match(renderer, /if\s*\([^)]*(?:!\s*readOnly|readOnly\s*===\s*false)[^)]*voice\.local[^)]*\)/u);
  assert.match(renderer, /rename-start|rename|edit|重命名/iu);
  assert.match(renderer, /readonly-label|read[-_ ]?only|readonly|只读/iu);
});

test('voice studio shares the reader visual language without returning to glass card styling', () => {
  for (const token of ['--qr-purple', '--qr-ink', '--qr-muted', '--qr-line']) {
    assert.match(studioCss, new RegExp(`${token}\\s*:`), `missing shared reader token ${token}`);
    assert.match(studioCss, new RegExp(`var\\(\\s*${token}\\s*\\)`), `${token} is declared but unused`);
  }

  assert.match(studioCss, /:focus-visible\b/);
  assert.match(studioCss, /@media\s*\([^)]*max-width\s*:/);
  assert.doesNotMatch(studioCss, /radial-gradient\s*\(|backdrop-filter\s*:|box-shadow\s*:\s*0\s+1[0-9]px\s+3[0-9]px/iu);

  const repeatedCardRule = studioCss.match(/\.record-card\s*,\s*\.save-card\s*,\s*\.library-card\s*\{([\s\S]*?)\}/u);
  if (repeatedCardRule) {
    assert.doesNotMatch(repeatedCardRule[1], /border-radius\s*:\s*(?:1[2-9]|[2-9]\d)px|box-shadow\s*:|rgba\([^)]*,\s*\.8[0-9]\)/iu);
  }
});

test('batch processing uses one awaited worker and never decodes files concurrently', () => {
  const queue = functionBody('queueFiles');
  const directWorker = /for\s*\(\s*const\s+\w+\s+of\s+added\s*\)\s*(?:\{\s*)?await\s+processImportItem\(/u.test(queue);
  const coordinatedWorker = /await\s+ensureImportWorker\s*\(/u.test(queue);
  assert.ok(directWorker || coordinatedWorker, 'queue does not await one import worker');
  if (coordinatedWorker) {
    const worker = functionBody('ensureImportWorker');
    assert.match(worker, /state\.importWorkerPromise/u);
    assert.match(worker, /await\s+processImportItem\(/u);
  }
  assert.doesNotMatch(studioSource, /Promise\.all\s*\([^)]*processImportItem|\.map\s*\([^)]*processImportItem/u);
});

test('Save All stays disabled until the entire batch is idle and ready', () => {
  const actions = functionBody('updateImportActions');
  const processing = functionBody('importsAreProcessing');
  assert.match(processing, /queued[\s\S]*processing[\s\S]*transcribing/u);
  assert.match(actions, /saveAllButton\.disabled\s*=\s*[^;]*(?:processing|busy|active|pending|canSaveAll|allReady)/iu);
  assert.match(actions, /saveAllButton\.disabled\s*=\s*[^;]*state\.savingImports/iu);
  const save = functionBody('saveAllImports');
  assert.match(save, /if\s*\(\s*importsAreProcessing\(\)\s*\)\s*\{[\s\S]{0,300}return/u);
});

test('remove and clear mark work cancelled and every async continuation observes cancellation', () => {
  const remove = functionBody('removeImport');
  const clear = functionBody('clearImports');
  for (const [name, body] of [['removeImport', remove], ['clearImports', clear]]) {
    assert.match(body, /item\.cancelled\s*=\s*true/u, `${name} does not mark cancellation`);
    assert.match(body, /releaseImportPayload\(\s*item\s*\)/u, `${name} does not release and abort work`);
  }
  assert.match(remove, /state\.imports\s*=\s*state\.imports\.filter/u);
  assert.match(clear, /state\.imports\s*=\s*\[\s*\]/u);

  for (const name of ['processImportItem', 'transcribeImportItem']) {
    const body = functionBody(name);
    assert.match(body, /item\.cancelled/u, `${name} does not observe item.cancelled`);
    assert.match(body, /if\s*\([^)]*item\.cancelled[^)]*\)\s*return/u, `${name} lacks a cancellation exit`);
  }
  assert.match(functionBody('releaseImportPayload'), /\.abort\s*\(/u);
});

test('failed saves remain retryable without re-decoding or re-transcribing audio', () => {
  const save = functionBody('saveAllImports');
  const recovery = save.match(/catch\s*\(\s*error\s*\)\s*\{\s*item\.status\s*=\s*["']ready["'][\s\S]{0,180}?item\.saveError\s*=\s*error\.message/u);
  assert.ok(recovery, 'missing per-item save failure recovery');
  assert.doesNotMatch(recovery[0], /decodeFile|processAudioBuffer|transcribeImportItem/u);
  assert.match(save, /filter\s*\([\s\S]{0,120}item\.status\s*===\s*["']ready["'][\s\S]{0,80}item\.wavB64/u);
});

test('late transcription cannot overwrite reference text edited by the user', () => {
  assert.match(studioSource, /item\.(?:refTextEdited|refTextRevision|refTextVersion)/u);
  const inputListener = studioSource.match(/importList\.addEventListener\(\s*["']input["'][\s\S]*?\n\s*\}\);/u);
  assert.ok(inputListener, 'missing import text input listener');
  assert.match(inputListener[0], /import-ref-text[\s\S]*item\.(?:refTextEdited|refTextRevision|refTextVersion)/u);
  const transcribe = functionBody('transcribeImportItem');
  assert.match(transcribe, /(?:refTextEdited|refTextRevision|refTextVersion)/u);
  assert.match(
    transcribe,
    /if[\s\S]{0,100}item\.(?:refTextEdited|refTextRevision|refTextVersion)[\s\S]{0,100}item\.refText\s*=/u,
  );
});

test('successful saves release the File, PCM, WAV, Base64, and Object URL payloads', () => {
  const release = studioSource.match(/function\s+(releaseImport\w*)\s*\(\s*item\s*\)\s*\{([\s\S]*?)\n\s*\}/u);
  assert.ok(release, 'missing a dedicated import payload release helper');
  for (const field of ['file', 'samples', 'wav', 'wavB64']) {
    assert.match(release[2], new RegExp(`item\\.${field}\\s*=\\s*(?:null|["']{2})`), `${field} is retained after save`);
  }
  assert.match(release[2], /revokeImportPreview\(\s*item\s*\)|URL\.revokeObjectURL/u);
  const save = functionBody('saveAllImports');
  assert.match(save, new RegExp(`item\\.status\\s*=\\s*["']saved["'][\\s\\S]{0,300}${release[1]}\\(\\s*item\\s*\\)`));
});

test('browser harness exercises the import lifecycle with delayed decode, transcription, and save failure', () => {
  assert.match(studioHarness, /displayCaptureMode[\s\S]*getDisplayMedia[\s\S]*no-audio[\s\S]*reject/u);
  assert.match(studioHarness, /feedRecordingSamples[\s\S]*电脑声音样本[\s\S]*lastDisplayStream\.audio\.end/u);
  assert.match(studioHarness, /holdDecode[\s\S]*maxDecodeActive/u);
  assert.match(studioHarness, /save-all-button[\s\S]*disabled[\s\S]*部分保存/u);
  assert.match(studioHarness, /planTranscription[\s\S]*用户手动填写的台词[\s\S]*迟到/u);
  assert.match(studioHarness, /remove-import[\s\S]*仍继续识别/u);
  assert.match(studioHarness, /clear-imports[\s\S]*清空后仍继续识别/u);
  assert.match(studioHarness, /failSaveNames[\s\S]*voice:save[\s\S]*firstSaveCount\s*\+\s*2/u);
  assert.match(studioHarness, /objectUrls[\s\S]*revokedUrls[\s\S]*没有释放音频 ObjectURL/u);
});
