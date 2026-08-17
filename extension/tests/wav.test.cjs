const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadWavEncoder() {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'shared', 'wav.js'),
    'utf8'
  );
  const context = {};
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'wav.js' });
  return context.QwenReaderWav;
}

test('encodeMono16 writes a 24 kHz mono PCM WAV header and data length', () => {
  const wav = loadWavEncoder().encodeMono16(
    new Float32Array([0, 0.5, -0.5, 1, 0, -1]),
    48000,
    24000
  );
  const view = new DataView(wav);

  assert.equal(Buffer.from(wav, 0, 4).toString('ascii'), 'RIFF');
  assert.equal(Buffer.from(wav, 8, 4).toString('ascii'), 'WAVE');
  assert.equal(Buffer.from(wav, 12, 4).toString('ascii'), 'fmt ');
  assert.equal(view.getUint16(20, true), 1);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 24000);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(Buffer.from(wav, 36, 4).toString('ascii'), 'data');
  assert.equal(view.getUint32(40, true), 6);
  assert.equal(wav.byteLength, 50);
});

test('encodeMono16 preserves positive and negative 16-bit PCM sample polarity', () => {
  const wav = loadWavEncoder().encodeMono16(
    new Float32Array([0, 0.5, -0.5, 1, 0, -1]),
    48000,
    24000
  );
  const view = new DataView(wav);

  assert.equal(view.getInt16(44, true), 0);
  assert.equal(view.getInt16(46, true), -16384);
  assert.equal(view.getInt16(48, true), 0);
});

test('encodeMono16 retains samples at the target sample rate', () => {
  const wav = loadWavEncoder().encodeMono16(
    new Float32Array([1, -1]),
    24000,
    24000
  );
  const view = new DataView(wav);

  assert.equal(view.getUint32(40, true), 4);
  assert.equal(view.getInt16(44, true), 32767);
  assert.equal(view.getInt16(46, true), -32768);
});

test('resample is exposed for imported audio processing', () => {
  const output = loadWavEncoder().resample(new Float32Array([0, 1, 0, -1]), 4, 8);

  assert.deepEqual([...output], [0, 0.5, 1, 0.5, 0, -0.5, -1, -1]);
});

test('exports the WAV API to CommonJS consumers', () => {
  const modulePath = path.join(__dirname, '..', 'shared', 'wav.js');
  delete require.cache[require.resolve(modulePath)];
  const wav = require(modulePath);

  assert.equal(typeof wav.encodeMono16, 'function');
  assert.equal(typeof wav.resample, 'function');
});
