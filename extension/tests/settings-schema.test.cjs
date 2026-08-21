const test = require('node:test');
const assert = require('node:assert/strict');
const schema = require('../shared/settings-schema.js');

test('new installs default to browser system voices and Provider V3', () => {
  const settings = schema.migrate({});
  assert.equal(settings.activeProviderId, 'browser-system');
  assert.equal(settings.providerVersion, 3);
  assert.equal(settings.playbackRate, 1);
});

test('legacy local Qwen settings and voice assignments migrate without loss', () => {
  const settings = schema.migrate({ providerId: 'local-qwen', apiBaseUrl: 'http://127.0.0.1:7811', model: 'legacy-model', opVoice: '旧音色', replyVoices: ['回复音色'], orbY: 0.42 });
  assert.equal(settings.activeProviderId, 'local-qwen');
  assert.equal(settings.providerSettings['local-qwen'].model, 'legacy-model');
  assert.equal(settings.providerVoices['local-qwen'], 'local-qwen:旧音色');
  assert.deepEqual(settings.replyVoices, ['回复音色']);
  assert.equal(settings.orbY, 0.42);
});

test('online addresses require HTTPS except on loopback and exports remove secrets', () => {
  assert.equal(schema.sanitizeOnlineBaseUrl('https://tts.example.test/'), 'https://tts.example.test');
  assert.equal(schema.sanitizeOnlineBaseUrl('http://127.0.0.1:9000'), 'http://127.0.0.1:9000');
  assert.throws(() => schema.sanitizeOnlineBaseUrl('http://tts.example.test'), /HTTPS/);
  const cleaned = schema.publicSettings({ apiKey: 'secret', providerSettings: { 'openai-compatible': { apiKey: 'secret' } } });
  assert.equal(JSON.stringify(cleaned).includes('secret'), false);
});

test('V3 legacy Qwen assignments are isolated from browser system voices in V4', () => {
  const settings = schema.migrate({ schemaVersion: 3, activeProviderId: 'browser-system', opVoice: '邵思萌', replyVoices: ['qwen-clone'] });
  assert.equal(settings.schemaVersion, 4);
  assert.equal(settings.voiceAssignmentsByProvider['browser-system'].narratorVoiceId, '');
  assert.deepEqual(settings.voiceAssignmentsByProvider['browser-system'].replyVoiceIds, []);
  assert.equal(settings.voiceAssignmentsByProvider['local-qwen'].narratorVoiceId, 'local-qwen:邵思萌');
  assert.deepEqual(settings.voiceAssignmentsByProvider['local-qwen'].replyVoiceIds, ['local-qwen:qwen-clone']);
  assert.equal(settings.opVoice, '');
});

test('V4 migration is idempotent and keeps provider assignments namespaced', () => {
  const first = schema.migrate({ schemaVersion: 4, activeProviderId: 'openai-compatible', voiceAssignmentsByProvider: {
    'openai-compatible': { narratorVoiceId: 'alloy', replyVoiceIds: ['verse'], authorVoices: { a: 'nova' } },
  } });
  const second = schema.migrate(first);
  assert.deepEqual(second.voiceAssignmentsByProvider, first.voiceAssignmentsByProvider);
  assert.equal(second.voiceAssignmentsByProvider['openai-compatible'].narratorVoiceId, 'openai-compatible:alloy');
  assert.equal(second.voiceAssignmentsByProvider['openai-compatible'].authorVoices.a, 'openai-compatible:nova');
});
