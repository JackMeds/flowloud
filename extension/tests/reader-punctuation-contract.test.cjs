const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const readerSource = fs.readFileSync(
  path.join(__dirname, '..', 'content', 'reader.js'),
  'utf8'
);

test('reader skips punctuation-only queue entries for foreground and prefetched playback', () => {
  assert.match(
    readerSource,
    /findNextSpeakableIndex\(state\.segments,\s*index\)/u
  );
  assert.match(
    readerSource,
    /findNextSpeakableIndex\(state\.segments,\s*state\.index \+ 1\)/u
  );
});

test('reader sends a speech-safe copy while retaining original segment text for highlighting', () => {
  assert.match(readerSource, /prepareSpeechText\(segment\.text\)/u);
  assert.match(readerSource, /input:\s*speechText/u);
});

test('reader opts foreground synthesis into streaming with the queued pause intent but keeps prefetch silent and non-streaming', () => {
  assert.match(
    readerSource,
    /synthesizeSegment\(segment,\s*sessionId,\s*\{\s*stream:\s*true,\s*startPaused:\s*desiredPlaybackPaused,\s*providerId:\s*providerOverride,?\s*\}\)/u,
  );
  assert.match(readerSource, /synthesizeSegment\(nextSegment,\s*nextSession,\s*\{\s*stream:\s*false,\s*prefetch:\s*true\s*\}\)/u);
  assert.match(readerSource, /type:\s*"playback:claim"/u);
  assert.match(readerSource, /type:\s*"tts:stream:event"|message\.type\s*===\s*"tts:stream:event"/u);
});

test('reader controls progressive playback through the offscreen pause and resume protocol', () => {
  assert.match(readerSource, /const\s+type\s*=\s*desiredPaused\s*\?\s*"tts:pause"\s*:\s*"tts:resume"/u);
  assert.match(readerSource, /sendPlaybackControl\(type,\s*controlSession\)/u);
  assert.match(readerSource, /event === "paused"/u);
  assert.match(readerSource, /event === "resumed"/u);
  assert.match(readerSource, /message\.paused/u);
  assert.match(readerSource, /startPaused:\s*synthOptions\.startPaused\s*===\s*true/u);
  assert.match(readerSource, /response\.queued/u);
  assert.match(readerSource, /response\.cancelledQueued/u);
});

test('reader bounds playback-control retries and surfaces a terminal typed failure', () => {
  assert.match(readerSource, /PLAYBACK_CONTROL_TIMEOUT_MS\s*=\s*3000/u);
  assert.match(readerSource, /playbackControlDeadline\s*=\s*Date\.now\(\)\s*\+\s*PLAYBACK_CONTROL_TIMEOUT_MS/u);
  assert.match(readerSource, /function\s+failPlaybackControl\(desiredPaused,\s*response\)/u);
  assert.match(readerSource, /response\.error\.retryable\s*===\s*false/u);
  assert.match(readerSource, /playback_control_unavailable/u);
  assert.doesNotMatch(readerSource, /playbackControlRetryAttempt\s*>=\s*40/u);
});

test('reader keeps loading playback pauseable in the replacement mini player', () => {
  assert.match(readerSource, /state\.status\s*===\s*"loading"[\s\S]*?desiredPlaybackPaused\s*=\s*!desiredPlaybackPaused/u);
  assert.match(readerSource, /\["extracting",\s*"loading",\s*"playing",\s*"paused",\s*"ready",\s*"error"\]\.includes\(state\.status\)/u);
  assert.match(readerSource, /playButtons\.forEach[\s\S]*?playButton\.disabled\s*=/u);
  assert.match(readerSource, /暂停已排队/u);
  assert.match(readerSource, /startPaused:\s*desiredPlaybackPaused/u);
});

test('reader advances to the next speakable segment when a stream ends', () => {
  assert.match(
    readerSource,
    /if\s*\(event\s*===\s*"ended"\)\s*\{\s*finishStreamPlayback\(\);\s*return;/u,
  );
  assert.match(
    readerSource,
    /function\s+finishStreamPlayback\(reusableAudio\)[\s\S]*?if\s*\(nextIndex\s*>=\s*0\)[\s\S]*?playIndex\(nextIndex,\s*reusableAudio\s*\?\s*\{\s*reusableAudio\s*\}/u,
  );
});

test('reader reuses the user-unlocked media element when buffered browser-model audio advances', () => {
  assert.match(readerSource, /finishStreamPlayback\(audio\)/u);
  assert.match(readerSource, /playOptions\.reusableAudio\s*&&\s*playOptions\.reusableAudio\s*===\s*currentAudio/u);
  assert.match(readerSource, /const\s+audio\s*=\s*reusableAudio\s*\|\|\s*new\s+Audio\(\)/u);
});

test('reader ignores duplicate stream-ended notifications for the same playback identity', () => {
  assert.match(readerSource, /completedStreamSession/u);
  assert.match(
    readerSource,
    /if\s*\(\s*finishedSession\s*&&\s*completedStreamSession\s*===\s*finishedSession\s*\)\s*return;/u,
  );
});

test('reader rejects stream events without a verifiable current playback identity', () => {
  assert.match(
    readerSource,
    /if\s*\(!hasPlaybackId\s*&&\s*!hasSessionId\s*&&\s*!hasRequestId\)\s*return\s+false;/u,
  );
  assert.match(readerSource, /message\.playbackId\)\s*!==\s*String\(activeSession\)/u);
  assert.match(readerSource, /message\.sessionId\)\s*!==\s*String\(activeSession\)/u);
  assert.match(readerSource, /activeStreamRequest\s*\|\|\s*activeSession/u);
});

test('reader waits at an incomplete forum queue tail and resumes when a later scan adds a sentence', () => {
  assert.match(readerSource, /activeScanController\s*\|\|\s*dynamicScanPending\s*\|\|\s*progressiveQueueMayGrow\(\)/u);
  assert.match(readerSource, /deadline:\s*Date\.now\(\)\s*\+\s*PROGRESSIVE_CONTINUATION_GRACE_MS/u);
  assert.match(readerSource, /pending\.rescans\s*<\s*PROGRESSIVE_CONTINUATION_MAX_RESCANS/u);
  assert.match(readerSource, /pendingProgressiveContinuation[\s\S]{0,500}scheduleProgressiveContinuationCheck/u);
  assert.match(readerSource, /if\s*\(nextIndex\s*<\s*0\)\s*return false;[\s\S]{0,180}clearProgressiveContinuation\(\);[\s\S]{0,100}playIndex\(nextIndex\)/u);
});

test('reader reflects a current global takeover without letting a stale revocation stop the successor sentence', () => {
  assert.match(readerSource, /case\s+"reader:playback:revoked"/u);
  assert.match(readerSource, /revokedPlaybackId\s*&&\s*revokedPlaybackId\s*!==\s*String\(activeSession\s*\|\|\s*""\)/u);
  assert.match(readerSource, /reason:\s*"stale_playback"/u);
  assert.match(readerSource, /stopPlayback\(\{\s*localOnly:\s*true\s*\}\)/u);
  assert.match(readerSource, /stopOptions\.localOnly\s*!==\s*true/u);
  assert.match(readerSource, /stopOptions\.localOnly\s*===\s*true[\s\S]*requestCache\.clearAll\(\)/u);
});

test('reader never prefetches a direct-playback system utterance that would interrupt the current sentence', () => {
  assert.match(readerSource, /nextIndex\s*>=\s*0\s*&&\s*!providerOverride\s*&&\s*audioResult\.directPlayback\s*!==\s*true/u);
});

test('reader refuses to finish a stream after stop or seek cleared the active session', () => {
  assert.match(
    readerSource,
    /function\s+finishStreamPlayback\(reusableAudio\)\s*\{\s*if\s*\(!activeSession\)\s*return;/u,
  );
});
