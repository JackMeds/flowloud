const test = require('node:test');
const assert = require('node:assert/strict');
const schema = require('../shared/settings-schema.js');

test('new installs default to browser system voices and Provider V4', () => {
  const settings = schema.migrate({});
  assert.equal(settings.activeProviderId, 'browser-system');
  assert.equal(settings.providerVersion, 4);
  assert.equal(settings.playbackRate, 1);
  assert.equal(settings.preset, 'everyone-one');
  assert.equal(settings.voiceStrategyVersion, 2);
});

test('the old implicit OP-exclusive default migrates once to the single-voice strategy', () => {
  const settings = schema.migrate({ schemaVersion: 5, preset: 'op-exclusive' });
  assert.equal(settings.preset, 'everyone-one');
  assert.equal(settings.voiceStrategyVersion, 2);
  assert.equal(schema.migrate({ ...settings, preset: 'op-stable-random' }).preset, 'op-stable-random');
});

test('legacy local Qwen settings and voice assignments migrate without loss', () => {
  const settings = schema.migrate({ providerId: 'local-qwen', apiBaseUrl: 'http://127.0.0.1:7811', model: 'legacy-model', opVoice: '旧音色', replyVoices: ['回复音色'], orbY: 0.42 });
  assert.equal(settings.activeProviderId, 'local-service');
  assert.equal(settings.providerSettings['local-service'].adapterId, 'flowloud-qwen');
  assert.equal(settings.providerSettings['local-service'].model, 'legacy-model');
  assert.equal(settings.providerVoices['local-service'], 'local-service:旧音色');
  assert.deepEqual(settings.replyVoices, ['回复音色']);
  assert.equal(settings.orbY, 0.42);
});

test('online addresses require HTTPS except on loopback and exports remove secrets', () => {
  assert.equal(schema.sanitizeOnlineBaseUrl('https://tts.example.test/'), 'https://tts.example.test');
  assert.equal(schema.sanitizeOnlineBaseUrl('http://127.0.0.1:9000'), 'http://127.0.0.1:9000');
  assert.throws(() => schema.sanitizeOnlineBaseUrl('http://tts.example.test'), /HTTPS/);
  const cleaned = schema.publicSettings({
    apiKey: 'root-api-secret', clientToken: 'root-local-secret',
    providerSettings: {
      'openai-compatible': { apiKey: 'online-secret', authorization: 'Bearer online-secret' },
      'local-service': { clientToken: 'local-secret', token: 'legacy-local-secret', headers: { authorization: 'Bearer nested-secret' } },
    },
  });
  const serialized = JSON.stringify(cleaned);
  for (const secret of ['root-api-secret', 'root-local-secret', 'online-secret', 'local-secret', 'legacy-local-secret', 'nested-secret']) {
    assert.equal(serialized.includes(secret), false);
  }
});

test('V3 legacy Qwen assignments are isolated from browser system voices in Schema v6', () => {
  const settings = schema.migrate({ schemaVersion: 3, activeProviderId: 'browser-system', opVoice: '邵思萌', replyVoices: ['qwen-clone'] });
  assert.equal(settings.schemaVersion, 6);
  assert.equal(settings.voiceAssignmentsByProvider['browser-system'].narratorVoiceId, '');
  assert.deepEqual(settings.voiceAssignmentsByProvider['browser-system'].replyVoiceIds, []);
  assert.equal(settings.voiceAssignmentsByProvider['local-service'].narratorVoiceId, 'local-service:邵思萌');
  assert.deepEqual(settings.voiceAssignmentsByProvider['local-service'].replyVoiceIds, ['local-service:qwen-clone']);
  assert.equal(settings.opVoice, '');
});

test('Schema v6 migration is idempotent and keeps provider assignments namespaced', () => {
  const first = schema.migrate({ schemaVersion: 4, activeProviderId: 'openai-compatible', voiceAssignmentsByProvider: {
    'openai-compatible': { narratorVoiceId: 'alloy', replyVoiceIds: ['verse'], authorVoices: { a: 'nova' } },
  } });
  const second = schema.migrate(first);
  assert.deepEqual(second.voiceAssignmentsByProvider, first.voiceAssignmentsByProvider);
  assert.equal(second.voiceAssignmentsByProvider['openai-compatible'].narratorVoiceId, 'openai-compatible:alloy');
  assert.equal(second.voiceAssignmentsByProvider['openai-compatible'].authorVoices.a, 'openai-compatible:nova');
});

test('Schema v6 replaces obsolete browser models with pinned Kokoro and keeps AI profile routing', () => {
  const settings = schema.migrate({
    schemaVersion: 5,
    providerSettings: { 'browser-model': { modelId: 'cmn-vits', repoId: 'old/model', revision: 'main' } },
    aiProfiles: [{ id: 'ollama', label: 'Ollama', protocol: 'ollama-chat', baseUrl: 'http://127.0.0.1:11434', model: 'qwen2.5vl:3b', capabilities: { visionOcr: true, textTranslation: true } }],
    aiProfileSelections: { ocr: 'ollama', translation: 'ollama' },
  });
  assert.equal(settings.providerSettings['browser-model'].modelId, 'kokoro-zh');
  assert.match(settings.providerSettings['browser-model'].revision, /^[a-f0-9]{40}$/);
  assert.equal(settings.providerVoices['browser-model'], 'browser-model:zf_001');
  assert.equal(settings.aiProfileSelections.ocr, 'ollama');
  assert.equal(settings.aiProfileSelections.translation, 'ollama');
});

test('AI profile custom headers reject secret-like names', () => {
  const settings = schema.publicSettings({ aiProfiles: [{
    id: 'custom', protocol: 'openai-chat', baseUrl: 'https://api.example.test', model: 'vision',
    customHeaders: { 'X-Title': 'Flowloud', Authorization: 'Bearer leaked', 'X-Api-Key': 'leaked' },
    capabilities: { visionOcr: true, textTranslation: true },
  }] });
  assert.deepEqual(settings.aiProfiles[0].customHeaders, { 'X-Title': 'Flowloud' });
});
