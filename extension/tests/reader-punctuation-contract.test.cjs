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
  assert.match(readerSource, /synthesizeSegment\(segment,\s*sessionId,\s*\{\s*stream:\s*true,\s*startPaused:\s*desiredPlaybackPaused\s*\}\)/u);
  assert.match(readerSource, /synthesizeSegment\(nextSegment,\s*nextSession,\s*\{\s*stream:\s*false\s*\}\)/u);
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

test('reader exposes loading playback as a truthful pauseable state', () => {
  assert.match(readerSource, /state\.status\s*===\s*"loading"[\s\S]*?desiredPlaybackPaused\s*=\s*!desiredPlaybackPaused/u);
  assert.match(readerSource, /pauseQueued:\s*state\.status\s*===\s*"loading"/u);
  assert.match(readerSource, /canControlLoading:\s*state\.status\s*===\s*"loading"/u);
  assert.match(readerSource, /暂停已排队/u);
  assert.match(readerSource, /isScanning\s*\|\|\s*playbackControlPending\s*\|\|\s*!total/u);
});

test('reader advances to the next speakable segment when a stream ends', () => {
  assert.match(
    readerSource,
    /if\s*\(event\s*===\s*"ended"\)\s*\{\s*finishStreamPlayback\(\);\s*return;/u,
  );
  assert.match(
    readerSource,
    /function\s+finishStreamPlayback\(\)[\s\S]*?if\s*\(nextIndex\s*>=\s*0\)\s*\{\s*void\s+playIndex\(nextIndex\);/u,
  );
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

test('reader refuses to finish a stream after stop or seek cleared the active session', () => {
  assert.match(
    readerSource,
    /function\s+finishStreamPlayback\(\)\s*\{\s*if\s*\(!activeSession\)\s*return;/u,
  );
});
