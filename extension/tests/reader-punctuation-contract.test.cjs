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

test('reader opts foreground synthesis into streaming but keeps prefetch silent and non-streaming', () => {
  assert.match(readerSource, /synthesizeSegment\(segment,\s*sessionId,\s*\{\s*stream:\s*true\s*\}\)/u);
  assert.match(readerSource, /synthesizeSegment\(nextSegment,\s*nextSession,\s*\{\s*stream:\s*false\s*\}\)/u);
  assert.match(readerSource, /type:\s*"tts:stream:event"|message\.type\s*===\s*"tts:stream:event"/u);
});
