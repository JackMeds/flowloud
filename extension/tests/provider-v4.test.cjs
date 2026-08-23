const test = require('node:test');
const assert = require('node:assert/strict');
const provider = require('../shared/provider-v4.js');

test('Provider V4 separates transport streaming from true incremental generation', () => {
  const item = provider.normalizeProvider({
    id: 'contract-test', version: 4,
    capabilities: {
      synthesize: true,
      transportStreaming: true,
      incrementalGeneration: false,
    },
    async synthesize() { return { audio: new Uint8Array([1]) }; },
  });
  assert.equal(item.capabilities.transportStreaming, true);
  assert.equal(item.capabilities.incrementalGeneration, false);
  assert.equal(item.capabilities.backendIncrementalGeneration, false);
});

test('Provider V4 errors expose stage code retryability and identity without raw causes', () => {
  const error = provider.structuredError(Object.assign(new Error('temporary'), {
    code: 'http_503', status: 503,
  }), { providerId: 'openai-compatible', requestId: 'req-1', stage: 'response' });
  assert.deepEqual(error.toJSON(), {
    stage: 'response', code: 'http_503', message: 'temporary', retryable: true,
    providerId: 'openai-compatible', requestId: 'req-1', status: 503,
  });
});

test('local service accepts only loopback addresses on arbitrary ports', () => {
  assert.equal(provider.validateLocalBaseUrl('http://localhost:9880/'), 'http://localhost:9880');
  assert.equal(provider.validateLocalBaseUrl('http://[::1]:5000'), 'http://[::1]:5000');
  assert.throws(() => provider.validateLocalBaseUrl('http://192.168.1.20:9880'), /只允许/u);
});

test('GPT-SoVITS adapter uses its fixed request mapping and truthful capability flags', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (String(url).endsWith('/health')) {
      return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
    }
    if (String(url).endsWith('/v1/audio/voices')) {
      return new Response(JSON.stringify({ voices: ['speaker-a'] }), { headers: { 'content-type': 'application/json' } });
    }
    return new Response(new Uint8Array([82, 73, 70, 70]), { headers: { 'content-type': 'audio/wav' } });
  };
  const item = provider.createLocalServiceProvider({
    adapterId: 'gpt-sovits', baseUrl: 'http://127.0.0.1:9880', fetchImpl,
  });
  assert.equal(item.id, 'local-service');
  assert.equal(item.capabilities.transportStreaming, true);
  assert.equal(item.capabilities.incrementalGeneration, true);
  const result = await item.synthesize({ input: '你好', voice: 'local-service:speaker-a', requestId: 'gpt-1' });
  assert.equal(result.providerId, 'local-service');
  const payload = JSON.parse(calls.at(-1).init.body);
  assert.equal(payload.text, '你好');
  assert.equal(payload.voice, 'speaker-a');
  assert.equal(payload.streaming_mode, false);
  assert.equal(calls.at(-1).url, 'http://127.0.0.1:9880/tts');
});

test('CosyVoice adapter uses the fixed inference_sft contract', async () => {
  const calls = [];
  const item = provider.createLocalServiceProvider({
    adapterId: 'cosyvoice', baseUrl: 'http://localhost:50000',
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(new Uint8Array([1, 2]), { headers: { 'content-type': 'audio/wav' } });
    },
  });
  const result = await item.synthesize({ input: '你好', voice: 'local-service:中文女声', model: 'CosyVoice2-0.5B', requestId: 'cosy-1' });
  const payload = JSON.parse(calls[0].init.body);
  assert.equal(calls[0].url, 'http://localhost:50000/inference_sft');
  assert.deepEqual(payload, {
    tts_text: '你好', spk_id: '中文女声', model: 'CosyVoice2-0.5B', response_format: 'wav', stream: false,
  });
  assert.equal(result.requestId, 'cosy-1');
  assert.equal(item.capabilities.incrementalGeneration, true);
  assert.equal(item.capabilities.voiceClone, false);
});

test('OpenAI-local adapter keeps OpenAI request fields but never claims true incremental generation', async () => {
  const calls = [];
  const item = provider.createLocalServiceProvider({
    adapterId: 'openai-local', baseUrl: 'http://127.0.0.1:9000', clientToken: 'local-token',
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(new Uint8Array([1, 2]), { headers: { 'content-type': 'audio/mpeg' } });
    },
  });
  await item.synthesize({ input: '试听', voice: 'local-service:alloy', model: 'tts-local', response_format: 'mp3', requestId: 'local-openai-1' });
  assert.equal(calls[0].url, 'http://127.0.0.1:9000/v1/audio/speech');
  assert.equal(calls[0].init.headers.authorization, 'Bearer local-token');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    input: '试听', voice: 'alloy', model: 'tts-local', response_format: 'mp3', stream: false,
  });
  assert.equal(item.capabilities.transportStreaming, true);
  assert.equal(item.capabilities.incrementalGeneration, false);
});

test('online health is side-effect free and synthesis sends only user-provided audition text', async () => {
  const calls = [];
  const item = provider.createOpenAICompatibleProvider({
    baseUrl: 'https://tts.example.test', model: 'tts-1', voice: 'alloy', apiKey: 'secret',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/mpeg' } });
    },
  });
  const health = await item.health({ apiKey: 'secret' });
  assert.equal(health.requiresAudition, true);
  assert.equal(calls.length, 0);
  await item.synthesize({ input: '用户试听短句', requestId: 'audition-1' }, { apiKey: 'secret' });
  assert.equal(JSON.parse(calls[0].init.body).input, '用户试听短句');
});
