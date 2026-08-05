const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadAudioImport() {
  const wavSource = fs.readFileSync(path.join(__dirname, '..', 'shared', 'wav.js'), 'utf8');
  const importSource = fs.readFileSync(path.join(__dirname, '..', 'shared', 'audio-import.js'), 'utf8');
  const context = {};
  vm.createContext(context);
  vm.runInContext(wavSource, context, { filename: 'wav.js' });
  vm.runInContext(importSource, context, { filename: 'audio-import.js' });
  return context.QwenReaderAudioImport;
}

function silence(length) {
  return new Float32Array(length);
}

function tone(length, amplitude) {
  const samples = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    samples[index] = amplitude * Math.sin(index * Math.PI / 8);
  }
  return samples;
}

function concat(...parts) {
  const result = new Float32Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

test('trims silence and keeps a stable ten-second speech window', () => {
  const rate = 1000;
  const samples = concat(silence(2000), tone(12000, 0.25), silence(3000));
  const result = loadAudioImport().selectReferenceSegment(samples, rate, {
    minSeconds: 5, preferredSeconds: 10, maxSeconds: 15,
  });

  assert.ok(result.startSeconds >= 1.8 && result.startSeconds <= 2.2);
  assert.ok(result.durationSeconds >= 9.9 && result.durationSeconds <= 10.1);
  assert.ok(result.activeRatio > 0.99);
  assert.equal(result.samples.length, 10000);
});

test('rejects less than five seconds of active speech', () => {
  const samples = concat(silence(1000), tone(3500, 0.2), silence(1000));

  assert.throws(
    () => loadAudioImport().selectReferenceSegment(samples, 1000, { minSeconds: 5, maxSeconds: 15 }),
    (error) => error.code === 'voice_too_short',
  );
});

test('limits normalized import windows to five through fifteen seconds', () => {
  const samples = concat(silence(6000), tone(22000, 0.2));
  const audioImport = loadAudioImport();

  for (const options of [
    { minSeconds: 1, maxSeconds: 30, preferredSeconds: 30 },
    { minSeconds: 20, maxSeconds: 30 },
  ]) {
    const result = audioImport.selectReferenceSegment(samples, 1000, options);
    assert.ok(result.durationSeconds >= 5 && result.durationSeconds <= 15);
  }
});

test('scores reference duration against a fixed ten-second target', () => {
  const samples = concat(silence(6000), tone(15000, 0.2));
  const result = loadAudioImport().selectReferenceSegment(samples, 1000, {
    minSeconds: 5, maxSeconds: 15, preferredSeconds: 14,
  });

  assert.equal(result.durationSeconds, 10);
});

test('downmixes channels without clipping', () => {
  assert.deepEqual(
    [...loadAudioImport().downmix([new Float32Array([1, -1]), new Float32Array([0, 1])])],
    [0.5, 0],
  );
});

test('marks 20 ms frames active above the ten-decibel noise threshold', () => {
  const frames = loadAudioImport().analyzeFrames(
    concat(new Float32Array(20).fill(0.002), new Float32Array(20).fill(0.05)),
    1000,
    20,
  );

  assert.equal(frames.length, 2);
  assert.deepEqual({ start: frames[1].start, end: frames[1].end, active: frames[1].active }, {
    start: 20, end: 40, active: true,
  });
  assert.equal(frames[0].active, false);
});

test('excludes clipped candidates when an unclipped valid window exists', () => {
  const rate = 1000;
  const samples = concat(silence(3000), tone(6000, 0.25), tone(6000, 1));
  const result = loadAudioImport().selectReferenceSegment(samples, rate, {
    minSeconds: 5, preferredSeconds: 5, maxSeconds: 10,
  });

  assert.ok(result.endSeconds <= 9.15);
  assert.ok(result.peak < 0.995);
});

test('processAudioBuffer downmixes the selected samples and produces 24 kHz WAV', () => {
  const left = concat(silence(2000), tone(6000, 0.2));
  const right = concat(silence(2000), tone(6000, 0.2));
  const audioBuffer = {
    numberOfChannels: 2,
    sampleRate: 1000,
    getChannelData(index) { return index === 0 ? left : right; },
  };
  const processed = loadAudioImport().processAudioBuffer(audioBuffer);

  assert.equal(processed.wav.byteLength, 288044);
  assert.equal(new DataView(processed.wav).getUint32(24, true), 24000);
  assert.equal(processed.segment.durationSeconds, 6);
});

test('decodeFile translates invalid input and decode errors into coded errors', async () => {
  const audioImport = loadAudioImport();
  await assert.rejects(
    () => audioImport.decodeFile(null, {}),
    (error) => error.code === 'invalid_audio',
  );
  await assert.rejects(
    () => audioImport.decodeFile({ arrayBuffer: async () => new ArrayBuffer(0) }, {
      decodeAudioData: async () => { throw new Error('bad audio'); },
    }),
    (error) => error.code === 'audio_decode_failed',
  );
});
