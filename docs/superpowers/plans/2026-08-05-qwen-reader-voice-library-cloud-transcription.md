# Qwen Reader Voice Library and Edge Cloud Transcription Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add batch audio import, automatic reference-segment selection, Edge cloud transcription, editable reference text, and safe local-voice renaming to the existing Qwen Reader Edge extension.

**Architecture:** Keep the Qwen Vulkan TTS gateway and ports unchanged. Add four focused UMD modules for naming, audio processing, Edge Web Speech transcription, and voice-library data, then make `voice-studio.js` a UI coordinator; perform rename transactions in `background.js` so backend registration, browser storage, active voice assignments, and cleanup stay consistent.

**Tech Stack:** Manifest V3, plain JavaScript UMD modules, Microsoft Edge `SpeechRecognition`, Web Audio API, `chrome.storage.local`, Node.js built-in test runner, PowerShell packaging.

## Global Constraints

- Keep TTS at `http://127.0.0.1:7811`; do not change the Vulkan backend, tray gateway, or ten-minute idle unload.
- Do not install Whisper, add an ASR process, add a tray icon, or add a startup entry.
- Accept WAV, MP3, M4A, AAC, and OGG only when `AudioContext.decodeAudioData()` can decode them.
- Register only 24 kHz mono PCM 16-bit WAV reference audio between 5 and 15 seconds.
- Use Edge cloud `SpeechRecognition` with `lang = "zh-CN"`; do not set `processLocally = true`.
- Run batch transcription and voice registration serially, one item at a time.
- Retry transient recognition failures at most twice; never retry permanent policy, permission, language, or unsupported-API failures.
- Recognition failure must never block manual reference text or voice registration.
- Built-in voices and aliases are read-only; only complete profiles in `voiceProfiles` may be renamed.
- Keep the trusted Qwen Reader client header and current loopback-only host permission unchanged.
- Do not log audio Base64, complete reference transcripts, or webpage text.

---

## File Structure

### Create

- `extension/shared/voice-naming.js`: sanitize file-derived voice names and allocate deterministic duplicate suffixes.
- `extension/shared/audio-import.js`: downmix PCM, calculate frame energy, select a 5–15 second reference segment, and produce a Qwen-ready WAV.
- `extension/shared/transcription.js`: Edge Web Speech provider, result aggregation, cancellation, timeout, error classification, and retry.
- `extension/shared/voice-library.js`: normalize profiles, construct imported profiles, plan safe renames, and model batch item states.
- `extension/tests/voice-naming.test.cjs`: naming and duplicate tests.
- `extension/tests/audio-import.test.cjs`: silence trimming and segment-selection tests.
- `extension/tests/transcription.test.cjs`: SpeechRecognition aggregation, retry, timeout, and cancellation tests.
- `extension/tests/voice-library.test.cjs`: backward compatibility, metadata, and rename-planning tests.
- `extension/tests/browser/voice-studio-harness.html`: UI integration harness with mocked audio, recognition, and extension messaging.

### Modify

- `extension/shared/wav.js`: export pure resampling support needed by audio import without changing existing encoding behavior.
- `extension/background.js`: add atomic multi-key storage, `voice:rename`, and deferred stale-name cleanup.
- `extension/tests/api-client.test.cjs`: retain `ref_text` and client-header regression coverage.
- `extension/tests/background-offscreen.test.cjs`: cover rename success, rollback, settings repair, and cleanup queue.
- `extension/voice-studio.html`: add recording transcript, batch drop zone/table, privacy copy, and rename UI.
- `extension/voice-studio.css`: responsive batch table, states, buttons, dialogs, and accessible focus/error styles.
- `extension/voice-studio.js`: coordinate recording, imports, transcription, queue state, saving, renaming, cancellation, and cleanup.
- `extension/manifest.json`: load no remote scripts; bump extension version to `0.4.0`.
- `extension/package.json`: bump source package version to `0.4.0`.
- `extension/README.md`: document cloud transcription, privacy, supported formats, retry, and manual fallback.
- `README.md`: update the extension feature and privacy summary.
- `package-extension.ps1`: require the four new production shared modules while continuing to exclude test harnesses from `dist`.

---

### Task 1: Deterministic Voice Naming and Profile Model

**Files:**
- Create: `extension/shared/voice-naming.js`
- Create: `extension/shared/voice-library.js`
- Test: `extension/tests/voice-naming.test.cjs`
- Test: `extension/tests/voice-library.test.cjs`

**Interfaces:**
- Produces: `QwenReaderVoiceNaming.sanitizeName(value): string`
- Produces: `QwenReaderVoiceNaming.fileStem(fileName): string`
- Produces: `QwenReaderVoiceNaming.allocateUniqueName(preferred, occupiedNames): string`
- Produces: `QwenReaderVoiceLibrary.normalizeProfile(profile): VoiceProfile`
- Produces: `QwenReaderVoiceLibrary.createImportedProfile(input): VoiceProfile`
- Produces: `QwenReaderVoiceLibrary.planRename(profiles, settings, oldName, newName): RenamePlan`
- Produces: `QwenReaderVoiceLibrary.createBatchItem(file, occupiedNames): BatchItem`

- [ ] **Step 1: Write failing naming tests**

```js
test('uses the final extension boundary and allocates stable duplicate suffixes', () => {
  assert.equal(Naming.fileStem('邵思萌.样本.m4a'), '邵思萌.样本');
  assert.equal(Naming.allocateUniqueName('邵思萌', ['邵思萌', '邵思萌 (2)']), '邵思萌 (3)');
});

test('sanitizes control characters and falls back for an empty name', () => {
  assert.equal(Naming.sanitizeName('  新\u0000音色  '), '新音色');
  assert.equal(Naming.sanitizeName(' . '), '未命名音色');
});
```

- [ ] **Step 2: Run naming tests and verify RED**

Run: `node --test extension/tests/voice-naming.test.cjs`

Expected: FAIL because `../shared/voice-naming.js` does not exist.

- [ ] **Step 3: Implement the naming module**

Use a browser/Node UMD wrapper and implement these exact rules:

```js
function sanitizeName(value) {
  const cleaned = String(value || '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/gu, '')
    .replace(/[\\/:*?"<>|]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .replace(/^[.\s]+|[.\s]+$/gu, '');
  return cleaned || '未命名音色';
}

function allocateUniqueName(preferred, occupiedNames) {
  const base = sanitizeName(preferred);
  const occupied = new Set(Array.from(occupiedNames || [], sanitizeName));
  if (!occupied.has(base)) return base;
  for (let index = 2; ; index += 1) {
    const candidate = `${base} (${index})`;
    if (!occupied.has(candidate)) return candidate;
  }
}
```

- [ ] **Step 4: Run naming tests and verify GREEN**

Run: `node --test extension/tests/voice-naming.test.cjs`

Expected: all naming tests PASS.

- [ ] **Step 5: Write failing profile and rename-plan tests**

```js
test('normalizes an old saved profile without destroying its WAV', () => {
  const result = Library.normalizeProfile({ name: '旧音色', wavB64: 'UklGRg==' });
  assert.equal(result.name, '旧音色');
  assert.equal(result.wavB64, 'UklGRg==');
  assert.equal(result.refText, '');
});

test('rename plan updates OP and reply references without mutating inputs', () => {
  const profiles = [{ name: '旧音色', wavB64: 'UklGRg==', refText: '原台词' }];
  const settings = { opVoice: '旧音色', replyVoices: ['另一音色', '旧音色'] };
  const plan = Library.planRename(profiles, settings, '旧音色', '新音色');
  assert.equal(plan.newProfile.name, '新音色');
  assert.equal(plan.settings.opVoice, '新音色');
  assert.deepEqual(plan.settings.replyVoices, ['另一音色', '新音色']);
  assert.equal(profiles[0].name, '旧音色');
});
```

- [ ] **Step 6: Run profile tests and verify RED**

Run: `node --test extension/tests/voice-library.test.cjs`

Expected: FAIL because `../shared/voice-library.js` does not exist.

- [ ] **Step 7: Implement the profile and batch-state module**

`createImportedProfile()` must preserve `wavB64`, set `mimeType: "audio/wav"`, `sampleRate: 24000`, `refText`, source metadata, timestamps, and:

```js
transcription: {
  provider: 'edge-web-speech',
  status: input.transcriptionStatus,
  attempts: input.attempts || 0,
}
```

`planRename()` must reject missing, built-in, duplicate, or incomplete profiles and return `{oldProfile, newProfile, profiles, settings}` with every exact old-name assignment replaced.

- [ ] **Step 8: Run both suites and commit**

Run: `node --test extension/tests/voice-naming.test.cjs extension/tests/voice-library.test.cjs`

Expected: all tests PASS.

```powershell
git add extension/shared/voice-naming.js extension/shared/voice-library.js extension/tests/voice-naming.test.cjs extension/tests/voice-library.test.cjs
git commit -m "feat: add voice naming and library model"
```

---

### Task 2: Pure Audio Import and Reference Segment Selection

**Files:**
- Create: `extension/shared/audio-import.js`
- Modify: `extension/shared/wav.js`
- Create: `extension/tests/audio-import.test.cjs`
- Modify: `extension/tests/wav.test.cjs`

**Interfaces:**
- Consumes: `QwenReaderWav.encodeMono16(samples, sourceRate, 24000): ArrayBuffer`
- Produces: `QwenReaderAudioImport.downmix(channelArrays): Float32Array`
- Produces: `QwenReaderAudioImport.analyzeFrames(samples, sampleRate, frameMs): FrameAnalysis[]`
- Produces: `QwenReaderAudioImport.selectReferenceSegment(samples, sampleRate, options): SegmentResult`
- Produces: `QwenReaderAudioImport.processAudioBuffer(audioBuffer, wavModule): ProcessedAudio`
- Produces: `QwenReaderAudioImport.decodeFile(file, audioContext): Promise<AudioBuffer>`

- [ ] **Step 1: Write failing PCM and segment tests**

Create synthetic PCM helpers and require the following behavior:

```js
test('trims silence and keeps a stable ten-second speech window', () => {
  const rate = 1000;
  const samples = concat(silence(2000), tone(12000, 0.25), silence(3000));
  const result = AudioImport.selectReferenceSegment(samples, rate, {
    minSeconds: 5, preferredSeconds: 10, maxSeconds: 15,
  });
  assert.ok(result.startSeconds >= 1.8 && result.startSeconds <= 2.2);
  assert.ok(result.durationSeconds >= 9.9 && result.durationSeconds <= 10.1);
});

test('rejects less than five seconds of active speech', () => {
  const samples = concat(silence(1000), tone(3500, 0.2), silence(1000));
  assert.throws(
    () => AudioImport.selectReferenceSegment(samples, 1000, { minSeconds: 5, maxSeconds: 15 }),
    (error) => error.code === 'voice_too_short',
  );
});

test('downmixes channels without clipping', () => {
  assert.deepEqual(
    [...AudioImport.downmix([new Float32Array([1, -1]), new Float32Array([0, 1])])],
    [0.5, 0],
  );
});
```

- [ ] **Step 2: Run audio tests and verify RED**

Run: `node --test extension/tests/audio-import.test.cjs extension/tests/wav.test.cjs`

Expected: FAIL because `audio-import.js` and new WAV exports are missing.

- [ ] **Step 3: Export WAV resampling and implement frame analysis**

Expose `resample` from `QwenReaderWav` without changing `encodeMono16`. In `audio-import.js`, use 20 ms frames and compute `{start, end, rms, peak, active}`. Define the noise floor as the 20th-percentile frame RMS and the active threshold as `Math.max(0.01, noiseFloor * 3.1623)` (10 dB above noise, with a -40 dBFS floor). Mark a frame clipped when `peak >= 0.995`; clipped frames may be included only when no unclipped valid window exists.

- [ ] **Step 4: Implement deterministic segment scoring**

Build candidates on 100 ms boundaries from the first through last active frame. For each candidate, compute `activeRatio`, RMS coefficient of variation, clipped-frame ratio, and the longest inactive run. Score with `activeRatio * 100 - rmsVariation * 20 - clippedRatio * 80 - internalSilenceSeconds * 4 - Math.abs(durationSeconds - 10) * 0.5`. Candidate windows must:

- contain at least 5 seconds of active speech;
- prefer 10 seconds and extend only when continuity improves, never beyond 15 seconds;
- score higher for active-frame ratio and stable RMS;
- score lower for clipping, long internal silence, or energy variance;
- include at most 150 ms of padding around detected speech boundaries.

Return exact samples plus `startSeconds`, `endSeconds`, `durationSeconds`, `peak`, and `activeRatio`.

- [ ] **Step 5: Implement browser decoding and final WAV production**

```js
async function decodeFile(file, audioContext) {
  if (!file || typeof file.arrayBuffer !== 'function') throw coded('invalid_audio');
  try {
    return await audioContext.decodeAudioData(await file.arrayBuffer());
  } catch (_) {
    throw coded('audio_decode_failed');
  }
}
```

`processAudioBuffer()` must copy all channels, downmix, select the segment, and call `encodeMono16(segment.samples, audioBuffer.sampleRate, 24000)`.

- [ ] **Step 6: Run audio tests and commit**

Run: `node --test extension/tests/audio-import.test.cjs extension/tests/wav.test.cjs`

Expected: all tests PASS with no change to existing WAV byte assertions.

```powershell
git add extension/shared/audio-import.js extension/shared/wav.js extension/tests/audio-import.test.cjs extension/tests/wav.test.cjs
git commit -m "feat: process imported voice samples"
```

---

### Task 3: Edge Web Speech Provider and Retry Policy

**Files:**
- Create: `extension/shared/transcription.js`
- Create: `extension/tests/transcription.test.cjs`

**Interfaces:**
- Produces: `QwenReaderTranscription.createEdgeSpeechProvider(dependencies): TranscriptionProvider`
- Produces: `TranscriptionProvider.transcribe(request): Promise<TranscriptionResult>`
- Produces: `QwenReaderTranscription.classifyError(error): RecognitionFailure`
- Produces: `QwenReaderTranscription.transcribeWithRetry(provider, request, options): Promise<TranscriptionResult>`

- [ ] **Step 1: Write failing result aggregation and unsupported tests**

```js
test('aggregates final results once and ignores interim duplicates', async () => {
  const fake = createRecognitionHarness([
    resultEvent([{ text: '今天', final: false }, { text: '今天', final: true }]),
    resultEvent([{ text: '天气很好', final: true }]),
    endEvent(),
  ]);
  const provider = Transcription.createEdgeSpeechProvider(fake.dependencies);
  const result = await provider.transcribe(fake.request);
  assert.equal(result.text, '今天天气很好');
});

test('reports an unsupported browser before creating audio nodes', async () => {
  const provider = Transcription.createEdgeSpeechProvider({ SpeechRecognitionCtor: null });
  await assert.rejects(
    provider.transcribe({ samples: new Float32Array([0.1]), sampleRate: 24000 }),
    (error) => error.code === 'speech_recognition_unsupported',
  );
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test extension/tests/transcription.test.cjs`

Expected: FAIL because `transcription.js` does not exist.

- [ ] **Step 3: Implement the Edge provider lifecycle**

The provider must:

```js
recognition.lang = request.lang || 'zh-CN';
recognition.continuous = true;
recognition.interimResults = true;
recognition.maxAlternatives = 1;
recognition.start(destination.stream.getAudioTracks()[0]);
source.start();
```

Create an `AudioBufferSourceNode`, copy the selected PCM into an `AudioBuffer`, connect it only to `MediaStreamDestination`, call `recognition.stop()` when the source ends, and always stop the track and disconnect nodes in one idempotent cleanup function. Never set `processLocally`.

- [ ] **Step 4: Write failing retry, timeout, and cancellation tests**

```js
test('retries network twice and then returns the third result', async () => {
  const provider = sequenceProvider([failure('network'), failure('network'), { text: '成功' }]);
  const result = await Transcription.transcribeWithRetry(provider, request, {
    retries: 2, delaysMs: [0, 0], wait: async () => {},
  });
  assert.equal(result.text, '成功');
  assert.equal(provider.calls, 3);
});

test('does not retry a policy denial', async () => {
  const provider = sequenceProvider([failure('service-not-allowed')]);
  await assert.rejects(
    Transcription.transcribeWithRetry(provider, request, { retries: 2, wait: async () => {} }),
    (error) => error.retryable === false && provider.calls === 1,
  );
});

test('abort signal stops recognition without retrying', async () => {
  const controller = new AbortController();
  const pending = provider.transcribe({ ...request, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (error) => error.name === 'AbortError');
});
```

- [ ] **Step 5: Implement error classification, timeout, and retries**

Transient codes: `network`, non-user `aborted`, first `no-speech`, `recognition_timeout`, and `empty_result`. Permanent codes: `not-allowed`, `service-not-allowed`, `language-not-supported`, `speech_recognition_unsupported`, and `audio_track_unsupported`. Default delays must be `[1000, 3000]`; timeout must be `durationSeconds * 1000 + 15000`.

- [ ] **Step 6: Run transcription tests and commit**

Run: `node --test extension/tests/transcription.test.cjs`

Expected: all tests PASS and every test verifies recognition/audio cleanup.

```powershell
git add extension/shared/transcription.js extension/tests/transcription.test.cjs
git commit -m "feat: add Edge cloud transcription provider"
```

---

### Task 4: Transactional Rename and Deferred Backend Cleanup

**Files:**
- Modify: `extension/background.js`
- Modify: `extension/tests/background-offscreen.test.cjs`
- Modify: `extension/tests/api-client.test.cjs`

**Interfaces:**
- Consumes: `QwenReaderVoiceLibrary.planRename(...)`
- Produces background message: `{type: "voice:rename", oldName, newName}`
- Produces storage helper: `setMany(values: Record<string, unknown>): Promise<void>`
- Produces storage key: `voiceCleanupQueue: string[]`

- [ ] **Step 1: Write failing rename success test**

Create a router with one local profile and settings that use the old name. Assert the forwarded order is register-new then delete-old, and the single `setMany` call updates both `voiceProfiles` and `qwenReaderSettings`:

```js
const result = await router({ type: 'voice:rename', oldName: '旧音色', newName: '新音色' });
assert.equal(result.ok, true);
assert.deepEqual(forwarded.map((item) => item.type), ['voice:save', 'voice:delete']);
assert.equal(values.voiceProfiles[0].name, '新音色');
assert.equal(values.qwenReaderSettings.opVoice, '新音色');
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test extension/tests/background-offscreen.test.cjs`

Expected: FAIL because `voice:rename` is unknown.

- [ ] **Step 3: Add multi-key storage and the rename transaction**

Load `shared/voice-library.js` beside `shared/api-client.js` in the service worker and pass `QwenReaderVoiceLibrary` into the background factory. Node tests must use `require('./shared/voice-library.js')` through the same factory boundary.

Extend `chromeStorage` with:

```js
async setMany(values) {
  await chromeApi.storage.local.set(values);
}
```

Rename sequence:

1. Read profiles and settings.
2. Create and validate the plan.
3. Forward `voice:save` with the renamed complete profile.
4. Persist profiles and repaired settings together with `setMany`.
5. Forward `voice:delete` for the old name.

If step 4 fails, best-effort delete the newly registered name and return an error without changing the old storage record.

- [ ] **Step 4: Write failing rollback and stale-cleanup tests**

Cover these exact cases:

- new registration fails: no storage write and no deletion;
- storage write fails: delete the new backend name, preserve the old profile;
- old deletion fails: return success with `warning.code === "old_voice_cleanup_pending"` and store old name in `voiceCleanupQueue`;
- next `voice:list` tries each queued deletion, retaining only names that still fail;
- built-in or incomplete remote-only voice rename returns `voice_read_only`.

- [ ] **Step 5: Implement the cleanup queue and pass the router tests**

Cleanup runs before forwarding `voice:list`, is best-effort, and never prevents listing voices. Deduplicate stored cleanup names and never add the currently active new name.

Run: `node --test extension/tests/background-offscreen.test.cjs extension/tests/api-client.test.cjs`

Expected: all tests PASS, including trusted-client-header and `ref_text` regressions.

- [ ] **Step 6: Commit**

```powershell
git add extension/background.js extension/tests/background-offscreen.test.cjs extension/tests/api-client.test.cjs
git commit -m "feat: rename local voices safely"
```

---

### Task 5: Voice Studio Recording, Batch Import, and Library UI

**Files:**
- Modify: `extension/voice-studio.html`
- Modify: `extension/voice-studio.css`
- Modify: `extension/voice-studio.js`
- Create: `extension/tests/browser/voice-studio-harness.html`

**Interfaces:**
- Consumes all four new `QwenReader*` shared modules.
- Sends: `voice:save`, `voice:list`, `voice:delete`, and `voice:rename` runtime messages.
- Produces batch states: `waiting`, `processing`, `recognizing`, `ready`, `saving`, `saved`, `failed`, `cancelled`.

- [ ] **Step 1: Build a failing browser harness contract**

The harness must load `voice-studio.html` dependencies with mocked `AudioContext`, `SpeechRecognition`, and `chrome.runtime.sendMessage`, then assert:

```js
assert(document.querySelector('#audio-files[multiple]'));
assert(document.querySelector('#import-drop-zone'));
assert(document.querySelector('#batch-list'));
assert(document.querySelector('#cloud-privacy-note').textContent.includes('Microsoft'));
assert(document.querySelector('#record-transcript'));
```

It must simulate two same-stem files, verify names `样本` and `样本 (2)`, make the first recognition fail, verify the second still reaches `ready`, edit its transcript, click save, and verify the `voice:save` message contains `refText`.

- [ ] **Step 2: Open the harness in the Codex in-app browser and verify RED**

Serve the workspace through a loopback static server and open `extension/tests/browser/voice-studio-harness.html` in the in-app browser.

Expected: harness reports FAIL because import and transcript controls do not exist.

- [ ] **Step 3: Restructure the HTML without changing extension security**

Add scripts in dependency order:

```html
<script src="shared/wav.js"></script>
<script src="shared/recording-state.js"></script>
<script src="shared/voice-naming.js"></script>
<script src="shared/audio-import.js"></script>
<script src="shared/transcription.js"></script>
<script src="shared/voice-library.js"></script>
<script src="voice-studio.js"></script>
```

Add a transcript textarea to recording; an accessible file input with `multiple` and `.wav,.mp3,.m4a,.aac,.ogg`; drag/drop zone; visible Microsoft cloud privacy note; batch summary, table/list, progress, cancel, and save-all controls; and rename controls only for `voice.local === true` with a complete local profile.

- [ ] **Step 4: Implement the controller state and serial processing loop**

Maintain one controller state:

```js
const state = {
  context: null,
  recording: createRecordingState(),
  batch: [],
  batchAbort: null,
  isBatchRunning: false,
  voices: [],
};
```

For each accepted file: allocate its unique name, decode, process, build preview URL, transcribe with retry, and move to `ready`. Catch per-item failures and continue the loop. Revoke each URL and release decoded buffers when the item is removed, saved, cancelled, or the page unloads.

- [ ] **Step 5: Add recording transcription and manual fallback**

After existing microphone recording produces its 24 kHz WAV, retain the selected `Float32Array` and its sample rate in `state.recording`, then run the same provider against that PCM. Populate `#record-transcript`; on failure show an inline warning and leave the textarea editable. Saving sends:

```js
{
  type: 'voice:save',
  profile: {
    name,
    wavB64,
    mimeType: 'audio/wav',
    sampleRate: 24000,
    refText: transcript,
    transcription: { provider: 'edge-web-speech', status, attempts },
  },
}
```

- [ ] **Step 6: Implement save-all, item retry, cancellation, and rename UI**

- Save ready items serially and keep failed items available for retry.
- “取消处理” aborts current recognition, marks unstarted items cancelled, and preserves saved items.
- “重试识别” resets only that item to `recognizing`.
- “重新保存” retries Qwen registration without repeating audio decoding or recognition.
- Rename opens an inline editor, calls `voice:rename`, updates the row only after success, and displays cleanup warnings without treating the rename as lost.
- `beforeunload` warns only when an unsaved ready/processing item exists.

- [ ] **Step 7: Style responsive and accessible states**

Keep the existing purple visual language. On narrow screens turn the batch table into stacked cards; never require horizontal scrolling to edit a name or transcript. Add visible `:focus-visible`, status colors with text labels, disabled/busy states, drag-active state, and `prefers-reduced-motion` behavior.

- [ ] **Step 8: Run the browser harness and commit**

Expected harness result: PASS for controls, duplicate names, serial continuation, edited transcript, save payload, retry, rename, cancellation, and URL cleanup.

```powershell
git add extension/voice-studio.html extension/voice-studio.css extension/voice-studio.js extension/tests/browser/voice-studio-harness.html
git commit -m "feat: add batch voice import studio"
```

---

### Task 6: Packaging, Documentation, and Full Regression Verification

**Files:**
- Modify: `extension/manifest.json`
- Modify: `extension/package.json`
- Modify: `extension/README.md`
- Modify: `README.md`
- Modify: `package-extension.ps1`
- Regenerate: `dist/Qwen-Reader-Edge/**`

**Interfaces:**
- Consumes the complete extension source tree.
- Produces reloadable package: `dist/Qwen-Reader-Edge` version `0.4.0`.

- [ ] **Step 1: Bump version and update truthful privacy documentation**

Set both manifest and extension package versions to `0.4.0`. Replace claims that recordings never leave the machine with precise text:

- webpage text and Qwen TTS remain localhost-only;
- reference clips are sent to Microsoft only when Edge cloud transcription runs;
- cloud recognition needs no user API key but has no extension-guaranteed SLA;
- users may leave reference text blank or edit it manually;
- supported import formats depend on Edge decoding support.

- [ ] **Step 2: Harden packaging closure for new modules**

Add the four new shared module paths to `$required`. Ensure source-to-dist hash checks include them automatically and that no remote script or `eval()` is introduced.

- [ ] **Step 3: Run every automated test**

Run:

```powershell
Push-Location extension
npm test
Pop-Location
```

Expected: all Node tests PASS with zero failures.

- [ ] **Step 4: Run syntax checks**

Run each production JavaScript file, excluding `vendor` and `tests`, through `node --check`.

Expected: every file exits zero.

- [ ] **Step 5: Run all three browser harnesses in the Codex in-app browser**

Verify:

- `extractor-harness.html`: PASS.
- `ui-harness.html`: PASS.
- `voice-studio-harness.html`: PASS.

Do not claim that the live Edge extension was reloaded if the in-app browser cannot access `edge://extensions`.

- [ ] **Step 6: Package and inspect output**

Run: `powershell -ExecutionPolicy Bypass -File .\package-extension.ps1`

Expected output includes `PACK PASS version=0.4.0`, all new modules exist in `dist/Qwen-Reader-Edge/shared`, and the packaged manifest retains only loopback TTS host permission.

- [ ] **Step 7: Perform live Edge acceptance with user action where required**

After the user clicks “重新加载” for the unpacked extension, verify with one 5–15 second Chinese recording and a two-file import:

- cloud transcription fills editable reference text;
- duplicate names receive `(2)`;
- disconnecting the network triggers bounded retries and manual fallback;
- saving registers voices at the existing Qwen endpoint;
- renaming the active OP voice updates reader settings;
- no additional process, tray icon, or startup item appears.

- [ ] **Step 8: Commit the release-ready extension**

```powershell
git add extension/manifest.json extension/package.json extension/README.md README.md package-extension.ps1 dist/Qwen-Reader-Edge
git commit -m "release: package Qwen Reader 0.4.0"
```

---

## Completion Criteria

- All new and existing Node tests pass.
- Every production JavaScript file passes `node --check`.
- Extractor, reader UI, and voice studio browser harnesses report PASS.
- Packaging reports version `0.4.0` and source/dist hashes match.
- Batch import accepts every Edge-decodable allowed format and isolates per-file failures.
- Edge cloud transcription is sequential, cancellable, editable, and bounded to two retries.
- Cloud unavailability never blocks manual reference text or Qwen voice registration.
- Local rename preserves the old voice on early failure and repairs active voice assignments on success.
- The feature adds no ASR installation, process, tray icon, startup entry, broad host permission, or remote script.
