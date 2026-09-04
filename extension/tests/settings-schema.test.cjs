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

test('appearance settings are normalized and a zero glow remains a valid explicit value', () => {
  const settings = schema.migrate({
    readingFocus: 'line',
    readingFocusStyle: 'underline-guide',
    wordHighlightStyle: 'custom',
    wordHighlightColor: '#AABBCC',
    wordHighlightGlow: 0,
    wordHighlightSpeed: 1.8,
  });
  assert.equal(settings.readingFocus, 'line');
  assert.equal(settings.readingFocusStyle, 'underline-guide');
  assert.equal(settings.wordHighlightStyle, 'custom');
  assert.equal(settings.wordHighlightColor, '#aabbcc');
  assert.equal(settings.wordHighlightGlow, 0);
  assert.equal(settings.wordHighlightSpeed, 1.8);
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

test('V3 legacy Qwen assignments are isolated from browser system voices in Schema V9', () => {
  const settings = schema.migrate({ schemaVersion: 3, activeProviderId: 'browser-system', opVoice: '邵思萌', replyVoices: ['qwen-clone'] });
  assert.equal(settings.schemaVersion, 9);
  assert.equal(settings.voiceAssignmentsByProvider['browser-system'].narratorVoiceId, '');
  assert.deepEqual(settings.voiceAssignmentsByProvider['browser-system'].replyVoiceIds, []);
  assert.equal(settings.voiceAssignmentsByProvider['local-service'].narratorVoiceId, 'local-service:邵思萌');
  assert.deepEqual(settings.voiceAssignmentsByProvider['local-service'].replyVoiceIds, ['local-service:qwen-clone']);
  assert.equal(settings.opVoice, '');
});

test('Schema V9 migration is idempotent and keeps provider assignments namespaced', () => {
  const first = schema.migrate({ schemaVersion: 4, activeProviderId: 'openai-compatible', voiceAssignmentsByProvider: {
    'openai-compatible': { narratorVoiceId: 'alloy', replyVoiceIds: ['verse'], authorVoices: { a: 'nova' } },
  } });
  const second = schema.migrate(first);
  assert.deepEqual(second.voiceAssignmentsByProvider, first.voiceAssignmentsByProvider);
  assert.equal(second.voiceAssignmentsByProvider['openai-compatible'].narratorVoiceId, 'openai-compatible:alloy');
  assert.equal(second.voiceAssignmentsByProvider['openai-compatible'].authorVoices.a, 'openai-compatible:nova');
});

test('V7 to V8 chooses narrator by assignment, provider projection, legacy config, then default', () => {
  const assignmentWins = schema.migrate({ schemaVersion: 7, providerSettings: { 'openai-compatible': { voice: 'nova' } }, providerVoices: { 'openai-compatible': 'openai-compatible:alloy' }, voiceAssignmentsByProvider: { 'openai-compatible': { narratorVoiceId: 'openai-compatible:echo' } } });
  assert.equal(assignmentWins.voiceAssignmentsByProvider['openai-compatible'].narratorVoiceId, 'openai-compatible:echo');
  const projectionWins = schema.migrate({ schemaVersion: 7, providerSettings: { 'openai-compatible': { voice: 'nova' } }, providerVoices: { 'openai-compatible': 'openai-compatible:alloy' } });
  assert.equal(projectionWins.voiceAssignmentsByProvider['openai-compatible'].narratorVoiceId, 'openai-compatible:alloy');
  const configWins = schema.migrate({ schemaVersion: 7, providerSettings: { 'openai-compatible': { voice: 'nova' } } });
  assert.equal(configWins.voiceAssignmentsByProvider['openai-compatible'].narratorVoiceId, 'openai-compatible:nova');
  assert.equal(schema.migrate({ schemaVersion: 7 }).voiceAssignmentsByProvider['openai-compatible'].narratorVoiceId, 'openai-compatible:alloy');
});

test('V8 generates legacy fields as compatibility projections and migrates online voices to arrays', () => {
  const settings = schema.migrate({ schemaVersion: 7, activeProviderId: 'openai-compatible', providerSettings: { 'openai-compatible': { voice: 'nova' }, 'doubao-tts': { voice: 'zh_female_1' } }, voiceAssignmentsByProvider: { 'openai-compatible': { narratorVoiceId: 'echo', replyVoiceIds: ['verse'] } } });
  assert.deepEqual(settings.providerSettings['openai-compatible'].voiceIds, ['nova']);
  assert.deepEqual(settings.providerSettings['doubao-tts'].voiceIds, ['zh_female_1']);
  assert.equal('voice' in settings.providerSettings['openai-compatible'], false);
  assert.equal(settings.providerVoices['openai-compatible'], settings.voiceAssignmentsByProvider['openai-compatible'].narratorVoiceId);
  assert.equal(settings.opVoice, 'echo');
  assert.deepEqual(settings.replyVoices, ['verse']);
  assert.deepEqual(schema.migrate(settings), settings);
});

test('Schema V9 replaces obsolete browser models with pinned Kokoro and keeps AI profile routing', () => {
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

test('browser model settings default to ModelScope, bounded parallel chunks, and starter voices', () => {
  const settings = schema.migrate({});
  const browserModel = settings.providerSettings['browser-model'];
  assert.equal(browserModel.modelId, 'kokoro-zh');
  assert.equal(browserModel.source, 'modelscope');
  assert.equal(browserModel.fallbackSource, 'huggingface');
  assert.equal(browserModel.downloadConcurrency, 4);
  assert.equal(browserModel.variant, 'auto');
  assert.equal(browserModel.dtype, 'fp32');
  assert.equal(browserModel.device, 'wasm');
  assert.deepEqual(browserModel.starterVoiceIds, ['zf_001', 'zf_002', 'zm_009', 'zm_010']);
  assert.deepEqual(browserModel.voiceCacheRegistry, {});
});

test('schema 6 browser-model installs migrate away from the unverified WebGPU default into Schema V9', () => {
  const migrated = schema.migrate({ schemaVersion: 6, providerSettings: { 'browser-model': { device: 'webgpu' } } });
  assert.equal(migrated.schemaVersion, 9);
  assert.equal(migrated.providerSettings['browser-model'].device, 'wasm');
});

test('explicit manual Hugging Face choice survives migration while invalid source is reset', () => {
  const hf = schema.migrate({ providerSettings: { 'browser-model': {
    source: 'huggingface', revision: '6cc0f0d2ebe369a68b0df87c2b65c1af8c0ac3e3', downloadConcurrency: 99,
    starterVoiceIds: ['browser-model:zf_001', 'zf_001', 'zm_010'], voiceCacheRegistry: { zf_001: { cached: true } },
  } } });
  assert.equal(hf.providerSettings['browser-model'].source, 'huggingface');
  assert.equal(hf.providerSettings['browser-model'].downloadConcurrency, 4);
  assert.deepEqual(hf.providerSettings['browser-model'].starterVoiceIds, ['zf_001', 'zm_010']);
  assert.equal(hf.providerSettings['browser-model'].voiceCacheRegistry.zf_001.cached, true);
  const hfWithoutRevision = schema.migrate({ providerSettings: { 'browser-model': { source: 'huggingface' } } });
  assert.equal(hfWithoutRevision.providerSettings['browser-model'].revision, hfWithoutRevision.providerSettings['browser-model'].hfRevision);
  const invalid = schema.migrate({ providerSettings: { 'browser-model': { source: 'somewhere-else' } } });
  assert.equal(invalid.providerSettings['browser-model'].source, 'modelscope');
});

test('legacy silent browser-model variants migrate to the verified fp32 path', () => {
  for (const variant of ['fp16', 'quantized', 'q8', '']) {
    const settings = schema.migrate({ providerSettings: { 'browser-model': { variant, dtype: variant } } });
    assert.equal(settings.providerSettings['browser-model'].variant, 'auto');
    assert.equal(settings.providerSettings['browser-model'].dtype, 'fp32');
  }
  const explicit = schema.migrate({ providerSettings: { 'browser-model': { variant: 'fp32', dtype: 'fp32' } } });
  assert.equal(explicit.providerSettings['browser-model'].variant, 'fp32');
  assert.equal(explicit.providerSettings['browser-model'].dtype, 'fp32');
});

test('Schema V9 defaults to full browser-model voice installation and preserves voice notes', () => {
  const fresh = schema.migrate({});
  assert.equal(fresh.providerSettings['browser-model'].installMode, 'full');
  assert.deepEqual(fresh.providerSettings['browser-model'].selectedVoiceIds, []);
  assert.deepEqual(fresh.voiceCatalogPreferences, { languageMode: 'auto', locale: '' });
  const migrated = schema.migrate({
    schemaVersion: 8,
    voiceCatalogPreferences: { languageMode: 'fixed', locale: 'zh-CN' },
    voiceOverridesByProvider: {
      'browser-model': {
        zf_001: { alias: '  旁白  ', note: '  适合长文  ', updatedAt: 123 },
        zf_002: { alias: 'x'.repeat(100), note: 'y'.repeat(600) },
      },
    },
    providerSettings: { 'browser-model': { installMode: 'custom', selectedVoiceIds: ['browser-model:zf_001', 'zf_001'] } },
  });
  assert.deepEqual(migrated.voiceCatalogPreferences, { languageMode: 'fixed', locale: 'zh-CN' });
  assert.deepEqual(migrated.voiceOverridesByProvider['browser-model'].zf_001, { alias: '旁白', note: '适合长文', updatedAt: 123 });
  assert.equal(migrated.voiceOverridesByProvider['browser-model'].zf_002.alias.length, 64);
  assert.equal(migrated.voiceOverridesByProvider['browser-model'].zf_002.note.length, 500);
  assert.equal(migrated.providerSettings['browser-model'].installMode, 'custom');
  assert.deepEqual(migrated.providerSettings['browser-model'].selectedVoiceIds, ['zf_001']);
});

test('AI profile custom headers reject secret-like names', () => {
  const settings = schema.publicSettings({ aiProfiles: [{
    id: 'custom', protocol: 'openai-chat', baseUrl: 'https://api.example.test', model: 'vision',
    customHeaders: { 'X-Title': 'Flowloud', Authorization: 'Bearer leaked', 'X-Api-Key': 'leaked' },
    capabilities: { visionOcr: true, textTranslation: true },
  }] });
  assert.deepEqual(settings.aiProfiles[0].customHeaders, { 'X-Title': 'Flowloud' });
});
