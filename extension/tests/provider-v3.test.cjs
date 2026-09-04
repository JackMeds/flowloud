const test = require('node:test');
const assert = require('node:assert/strict');
const provider = require('../shared/provider-v3.js');

test('Provider V3 accepts capability-scoped implementations', () => {
  const item = provider.normalizeProvider({ id: 'minimal', version: 3, capabilities: { voices: true }, voices: async () => [] });
  assert.equal(item.capabilities.voices, true);
  assert.equal(item.capabilities.synthesize, false);
});

test('browser model voice batch skips invalid IDs, limits concurrency, and reports partial failures', async () => {
  const previousCaches = globalThis.caches;
  globalThis.caches = { keys: async () => [], delete: async () => false };
  let active = 0;
  let peak = 0;
  const progress = [];
  const pipelineFactory = async () => async () => ({ audio: new Float32Array([0.2]), sampling_rate: 16000 });
  pipelineFactory.downloadVoice = async (_repoId, options) => {
    active += 1; peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, options.voiceId === 'zf_002' ? 4 : 1));
    active -= 1;
    if (options.voiceId === 'zf_003') throw Object.assign(new Error('源文件暂时不可用'), { code: 'source_unavailable' });
    return { voiceId: options.voiceId, cached: true, downloaded: true };
  };
  try {
    const item = provider.createBrowserModelProvider({ modelId: 'kokoro-zh', downloadConcurrency: 2, pipelineFactory });
    const result = await item.modelManagement['voice-batch']({
      action: 'download', voiceIds: ['browser-model:zf_001', 'zf_002', 'zf_003', 'not-a-voice'],
      onProgress: (value) => progress.push(value),
    });
    assert.deepEqual(result.requested, ['zf_001', 'zf_002', 'zf_003']);
    assert.deepEqual(result.completed.sort(), ['zf_001', 'zf_002']);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].voiceId, 'zf_003');
    assert.ok(peak <= 2, `expected at most two concurrent downloads, saw ${peak}`);
    assert.ok(progress.some((value) => value.completed === 3 && value.phase === 'voice-batch'));
    assert.equal(result.totalBytes, 3 * 522240);
  } finally {
    globalThis.caches = previousCaches;
  }
});

test('browser model full install asks the runtime for every catalog voice', async () => {
  const previousCaches = globalThis.caches;
  let cacheId = '';
  globalThis.caches = { keys: async () => cacheId ? [cacheId] : [], delete: async () => false };
  const builds = [];
  const pipelineFactory = async (_task, _repoId, options) => {
    builds.push({ ensureAllVoices: options.ensureAllVoices, ensureVoiceIds: options.ensureVoiceIds });
    return Object.assign(async () => ({ audio: new Float32Array([0.2, -0.2]), sampling_rate: 16000 }), { dispose: async () => {} });
  };
  try {
    const item = provider.createBrowserModelProvider({ modelId: 'kokoro-zh', device: 'wasm', pipelineFactory });
    cacheId = (await item.modelManagement.info()).cacheId;
    const result = await item.modelManagement.download({ installMode: 'full' });
    assert.equal(result.installMode, 'full');
    assert.equal(result.downloadedVoiceIds.length, 103);
    assert.equal(builds[0].ensureAllVoices, true);
    assert.equal(builds[0].ensureVoiceIds.length, 103);
  } finally {
    globalThis.caches = previousCaches;
  }
});

test('browser model voice metadata keeps the raw catalog id beside the friendly label', async () => {
  const item = provider.createBrowserModelProvider({ modelId: 'kokoro-zh', pipelineFactory: async () => async () => ({ audio: new Float32Array([0.2]) }) });
  const voices = await item.modelManagement.voices();
  const voice = voices.find((entry) => entry.rawId === 'zf_001');
  assert.equal(voice.rawLabel, 'zf_001');
  assert.equal(voice.displayLabel, 'Kokoro 音色 001');
});

test('online provider rejects unsafe HTTP before fetching', () => {
  assert.throws(() => provider.createOpenAICompatibleProvider({ baseUrl: 'http://tts.example.test' }), /HTTPS/);
});

test('browser model rejects remote code and malformed repositories', () => {
  assert.throws(() => provider.createBrowserModelProvider({ modelId: 'custom', repoId: 'bad', trustRemoteCode: true }), /Repo ID|远程代码/);
  assert.throws(() => provider.createBrowserModelProvider({ modelId: 'custom', repoId: 'owner/model', customLoader: 'https://evil.test/a.js' }), /远程代码/);
});

test('browser model pins built-ins and requires an immutable custom revision', () => {
  assert.deepEqual(Object.keys(provider.BUILTIN_BROWSER_MODELS), ['kokoro-zh']);
  assert.match(provider.BUILTIN_BROWSER_MODELS['kokoro-zh'].revision, /^[a-f0-9]{40}$/);
  assert.equal(provider.BUILTIN_BROWSER_MODELS['kokoro-zh'].source, 'modelscope');
  assert.equal(provider.BUILTIN_BROWSER_MODELS['kokoro-zh'].hfRevision.length, 40);
  assert.throws(() => provider.createBrowserModelProvider({ modelId: 'kokoro-zh', source: 'example' }), /模型来源无效/);
  assert.throws(() => provider.createBrowserModelProvider({ modelId: 'custom', repoId: 'owner/model', revision: 'main' }), /40 位 commit/);
});

test('browser model falls back from WebGPU to WASM when allowed', async () => {
  const devices = [];
  const item = provider.createBrowserModelProvider({
    modelId: 'kokoro-zh', device: 'webgpu', allowWasmFallback: true,
    async pipelineFactory(_task, _repo, options) {
      devices.push(options.device);
      if (options.device === 'webgpu') throw new Error('no adapter');
      return async () => ({ audio: new Float32Array([0.1]), sampling_rate: 16000 });
    },
  });
  const result = await item.modelManagement.download({});
  assert.deepEqual(devices, ['webgpu', 'wasm']);
  assert.equal(result.device, 'wasm');
  assert.match(result.fallbackReason, /no adapter/);
});

test('browser model deletion disposes the live pipeline and removes only its exact cache key', async () => {
  const deleted = [];
  const adapterDeleted = [];
  let disposed = 0;
  const previousCaches = globalThis.caches;
  globalThis.caches = { delete: async (key) => { deleted.push(key); return true; } };
  try {
    const engine = Object.assign(async () => ({ audio: new Float32Array([0.1]), sampling_rate: 16000 }), { dispose: async () => { disposed += 1; } });
    const pipelineFactory = async () => engine;
    pipelineFactory.deleteCache = async (repoId, revision) => { adapterDeleted.push({ repoId, revision }); };
    const item = provider.createBrowserModelProvider({ modelId: 'kokoro-zh', pipelineFactory });
    const downloaded = await item.modelManagement.download({});
    const result = await item.modelManagement.delete();
    assert.equal(disposed, 1);
    assert.deepEqual(deleted, [downloaded.cacheId]);
    assert.deepEqual(adapterDeleted, [{ repoId: downloaded.repoId, revision: downloaded.revision }]);
    assert.equal(result.cacheId, downloaded.cacheId);
  } finally {
    globalThis.caches = previousCaches;
  }
});

test('browser model never trusts downloaded metadata when the real cache is missing', async () => {
  const previousCaches = globalThis.caches;
  let pipelineCalls = 0;
  globalThis.caches = { keys: async () => [], delete: async () => false };
  try {
    const item = provider.createBrowserModelProvider({
      modelId: 'kokoro-zh', downloaded: true,
      pipelineFactory: async () => { pipelineCalls += 1; return async () => ({ audio: new Float32Array([0.1]) }); },
    });
    const info = await item.modelManagement.info();
    const health = await item.health({});
    assert.equal(info.state, 'missing');
    assert.equal(info.ready, false);
    assert.equal(health.state, 'missing');
    assert.equal(pipelineCalls, 0);
  } finally {
    globalThis.caches = previousCaches;
  }
});

test('browser model recreates its pipeline offline before marking a cached download ready', async () => {
  const previousCaches = globalThis.caches;
  const builds = [];
  let cacheId = '';
  globalThis.caches = { keys: async () => cacheId ? [cacheId] : [] };
  try {
    const item = provider.createBrowserModelProvider({
      modelId: 'kokoro-zh', device: 'wasm',
      pipelineFactory: async (_task, _repo, options) => {
        builds.push({ offline: options.flowloudOffline, hasSignal: Boolean(options.signal) });
        return Object.assign(async () => ({ audio: new Float32Array([0.1]), sampling_rate: 16000 }), { dispose: async () => {} });
      },
    });
    cacheId = (await item.modelManagement.info()).cacheId;
    const result = await item.modelManagement.download({});
    assert.equal(result.ready, true);
    assert.deepEqual(builds, [
      { offline: false, hasSignal: true },
      { offline: true, hasSignal: true },
    ]);
  } finally {
    globalThis.caches = previousCaches;
  }
});

test('browser model cancellation aborts an in-flight pipeline build', async () => {
  const previousCaches = globalThis.caches;
  globalThis.caches = { keys: async () => [], delete: async () => false };
  try {
    const item = provider.createBrowserModelProvider({
      modelId: 'kokoro-zh', device: 'wasm',
      pipelineFactory: async (_task, _repo, options) => new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true });
      }),
    });
    const pending = item.modelManagement.download({});
    await new Promise((resolve) => setImmediate(resolve));
    const cancelled = await item.modelManagement.cancel();
    assert.equal(cancelled.cancelled, true);
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal((await item.modelManagement.info()).state, 'cancelled');
  } finally {
    globalThis.caches = previousCaches;
  }
});

test('browser model exposes the full voice catalog without requiring the model cache', async () => {
  const previousCaches = globalThis.caches;
  const cacheValues = new Map();
  globalThis.caches = { keys: async () => [], delete: async () => false, open: async () => ({ match: async (key) => cacheValues.get(key) }) };
  try {
    const item = provider.createBrowserModelProvider({ modelId: 'kokoro-zh', source: 'modelscope', pipelineFactory: async () => async () => ({ audio: new Float32Array([0.1]) }) });
    const response = await item.modelManagement['voice-list']();
    assert.equal(response.voices.length, 103);
    assert.equal(response.voices[0].providerId, 'browser-model');
    assert.equal(response.voices.find((voice) => voice.voiceId === 'zf_001').cached, null);
  } finally {
    globalThis.caches = previousCaches;
  }
});

test('browser model refuses playback until both the model and selected voice are explicitly cached', async () => {
  const previousCaches = globalThis.caches;
  let cacheKeys = [];
  let pipelineCalls = 0;
  const pipelineFactory = async () => {
    pipelineCalls += 1;
    return async () => ({ audio: new Float32Array([0.1]), sampling_rate: 16000 });
  };
  pipelineFactory.voiceInfo = async (_repoId, options) => ({ voiceId: options.voiceId, cached: false });
  globalThis.caches = { keys: async () => cacheKeys, delete: async () => false };
  try {
    const item = provider.createBrowserModelProvider({ modelId: 'kokoro-zh', device: 'wasm', pipelineFactory });
    const cacheId = (await item.modelManagement.info()).cacheId;
    await assert.rejects(
      item.synthesize({ input: '你好', voice: 'browser-model:zf_003' }),
      (error) => error.code === 'model_not_downloaded' && /语音来源/.test(error.message),
    );
    cacheKeys = [cacheId];
    await assert.rejects(
      item.synthesize({ input: '你好', voice: 'browser-model:zf_003' }),
      (error) => error.code === 'voice_not_downloaded' && error.voiceId === 'zf_003' && /声音库/.test(error.message),
    );
    assert.equal(pipelineCalls, 0);
  } finally {
    globalThis.caches = previousCaches;
  }
});

test('browser model synthesizes a cached voice with remote loading disabled', async () => {
  const previousCaches = globalThis.caches;
  let cacheId = '';
  const builds = [];
  const pipelineFactory = async (_task, _repoId, options) => {
    builds.push(options.flowloudOffline);
    return async () => ({ audio: new Float32Array([0.2, -0.2]), sampling_rate: 16000 });
  };
  pipelineFactory.voiceInfo = async (_repoId, options) => ({ voiceId: options.voiceId, cached: true });
  globalThis.caches = { keys: async () => cacheId ? [cacheId] : [], delete: async () => false };
  try {
    const item = provider.createBrowserModelProvider({ modelId: 'kokoro-zh', device: 'wasm', pipelineFactory });
    cacheId = (await item.modelManagement.info()).cacheId;
    const result = await item.synthesize({ input: '你好', voice: 'browser-model:zf_001' });
    assert.equal(result.mimeType, 'audio/wav');
    assert.ok(result.audio.byteLength > 44);
    assert.deepEqual(builds, [true]);
  } finally {
    globalThis.caches = previousCaches;
  }
});

test('browser model rejects silent PCM instead of reporting a playable WAV', async () => {
  const previousCaches = globalThis.caches;
  let cacheId = '';
  const pipelineFactory = async () => async () => ({ audio: new Float32Array(128), sampling_rate: 16000 });
  pipelineFactory.voiceInfo = async (_repoId, options) => ({ voiceId: options.voiceId, cached: true });
  globalThis.caches = { keys: async () => cacheId ? [cacheId] : [], delete: async () => false };
  try {
    const item = provider.createBrowserModelProvider({ modelId: 'kokoro-zh', device: 'wasm', pipelineFactory });
    cacheId = (await item.modelManagement.info()).cacheId;
    await assert.rejects(
      item.synthesize({ input: '你好', voice: 'browser-model:zf_001' }),
      (error) => error.code === 'model_silent' && /fp32/.test(error.message),
    );
  } finally {
    globalThis.caches = previousCaches;
  }
});

test('browser model retries a clipped WebGPU waveform on WASM', async () => {
  const previousCaches = globalThis.caches;
  let cacheId = '';
  const devices = [];
  const bad = new Float32Array(4096);
  for (let index = 0; index < 16; index += 1) bad[index] = index % 2 ? -1 : 1;
  const good = Float32Array.from({ length: 4096 }, (_, index) => 0.2 * Math.sin(index * 2 * Math.PI * 220 / 16000));
  const pipelineFactory = async (_task, _repoId, options) => {
    devices.push(options.device);
    return async () => ({ audio: options.device === 'webgpu' ? bad : good, sampling_rate: 16000 });
  };
  pipelineFactory.voiceInfo = async (_repoId, options) => ({ voiceId: options.voiceId, cached: true });
  globalThis.caches = { keys: async () => cacheId ? [cacheId] : [], delete: async () => false };
  try {
    const item = provider.createBrowserModelProvider({ modelId: 'kokoro-zh', device: 'webgpu', allowWasmFallback: true, pipelineFactory });
    cacheId = (await item.modelManagement.info()).cacheId;
    const result = await item.synthesize({ input: '你好', voice: 'browser-model:zf_001' });
    assert.equal(result.mimeType, 'audio/wav');
    assert.deepEqual(devices, ['webgpu', 'wasm']);
    const info = await item.modelManagement.info();
    assert.equal(info.device, 'wasm');
    assert.match(info.fallbackReason, /WebGPU 音频输出异常/);
  } finally {
    globalThis.caches = previousCaches;
  }
});

test('voice ids are namespaced and rates are bounded', () => {
  assert.equal(provider.voiceId('browser-system', 'Alice'), 'browser-system:Alice');
  assert.equal(provider.clampRate(9), 2);
  assert.equal(provider.clampRate(0.1), 0.75);
});

test('browser-model WAV conversion applies bounded make-up gain', () => {
  const view = new DataView(provider.pcmToWav(new Float32Array([0.2, -0.2]), 16000));
  assert.equal(view.getUint16(20, true), 1);
  assert.ok(view.getInt16(44, true) >= 16000);
  assert.ok(view.getInt16(46, true) <= -16000);
});
