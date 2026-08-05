const test = require('node:test');
const assert = require('node:assert/strict');

const Library = require('../shared/voice-library.js');

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

test('creates imported profiles with fixed WAV metadata and transcription state', () => {
  const result = Library.createImportedProfile({
    name: '导入音色',
    wavB64: 'UklGRg==',
    refText: '请保持安静。',
    sourceFileName: '导入音色.m4a',
    durationSeconds: 8.5,
    createdAt: '2026-08-05T00:00:00.000Z',
    updatedAt: '2026-08-05T00:00:01.000Z',
    transcriptionStatus: 'pending',
    attempts: 2,
  });

  assert.deepEqual(result, {
    name: '导入音色', wavB64: 'UklGRg==', mimeType: 'audio/wav', sampleRate: 24000,
    refText: '请保持安静。', sourceFileName: '导入音色.m4a', durationSeconds: 8.5,
    createdAt: '2026-08-05T00:00:00.000Z', updatedAt: '2026-08-05T00:00:01.000Z',
    transcription: { provider: 'edge-web-speech', status: 'pending', attempts: 2 },
  });
});

test('makes a queued batch item with a unique name derived from the file', () => {
  const file = { name: '旁白.样本.wav', type: 'audio/wav', size: 16, lastModified: 7 };
  const item = Library.createBatchItem(file, ['旁白.样本']);

  assert.equal(item.name, '旁白.样本 (2)');
  assert.equal(item.file, file);
  assert.equal(item.sourceFileName, '旁白.样本.wav');
  assert.equal(item.transcriptionStatus, 'pending');
  assert.equal(item.attempts, 0);
});

test('rejects incomplete, duplicate, and built-in rename sources', () => {
  assert.throws(() => Library.planRename([], {}, 'missing', 'new'));
  assert.throws(() => Library.planRename([{ name: '邵思萌', wavB64: 'UklGRg==' }], {}, '邵思萌', 'new'));
  assert.throws(() => Library.planRename([
    { name: 'same', wavB64: 'UklGRg==' }, { name: 'same', wavB64: 'UklGRg==' },
  ], {}, 'same', 'new'));
  assert.throws(() => Library.planRename([{ name: 'empty' }], {}, 'empty', 'new'));
});
