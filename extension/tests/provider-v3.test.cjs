const test = require('node:test');
const assert = require('node:assert/strict');
const provider = require('../shared/provider-v3.js');

test('Provider V3 accepts capability-scoped implementations', () => {
  const item = provider.normalizeProvider({ id: 'minimal', version: 3, capabilities: { voices: true }, voices: async () => [] });
  assert.equal(item.capabilities.voices, true);
  assert.equal(item.capabilities.synthesize, false);
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
  assert.throws(() => provider.createBrowserModelProvider({ modelId: 'custom', repoId: 'owner/model', revision: 'main' }), /40 位 commit/);
});

test('browser model falls back from WebGPU to WASM when allowed', async () => {
  const devices = [];
  const item = provider.createBrowserModelProvider({
    modelId: 'kokoro-zh', device: 'webgpu', allowWasmFallback: true,
    async pipelineFactory(_task, _repo, options) {
      devices.push(options.device);
      if (options.device === 'webgpu') throw new Error('no adapter');
      return async () => ({ audio: new Float32Array([0]), sampling_rate: 16000 });
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
    const engine = Object.assign(async () => ({ audio: new Float32Array([0]), sampling_rate: 16000 }), { dispose: async () => { disposed += 1; } });
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
      pipelineFactory: async () => { pipelineCalls += 1; return async () => ({ audio: new Float32Array([0]) }); },
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

test('voice ids are namespaced and rates are bounded', () => {
  assert.equal(provider.voiceId('browser-system', 'Alice'), 'browser-system:Alice');
  assert.equal(provider.clampRate(9), 2);
  assert.equal(provider.clampRate(0.1), 0.75);
});
