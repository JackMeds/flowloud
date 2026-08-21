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
  assert.match(provider.BUILTIN_BROWSER_MODELS['cmn-vits'].revision, /^[a-f0-9]{40}$/);
  assert.match(provider.BUILTIN_BROWSER_MODELS['kokoro-en'].revision, /^[a-f0-9]{40}$/);
  assert.throws(() => provider.createBrowserModelProvider({ modelId: 'custom', repoId: 'owner/model', revision: 'main' }), /40 位 commit/);
});

test('browser model falls back from WebGPU to WASM when allowed', async () => {
  const devices = [];
  const item = provider.createBrowserModelProvider({
    modelId: 'cmn-vits', device: 'webgpu', allowWasmFallback: true,
    async pipelineFactory(_task, _repo, options) {
      devices.push(options.device);
      if (options.device === 'webgpu') throw new Error('no adapter');
      return async () => ({ audio: new Float32Array([0]), sampling_rate: 16000 });
    },
  });
  const result = await item.modelManagement.download({});
  assert.deepEqual(devices, ['webgpu', 'wasm']);
  assert.equal(result.device, 'wasm');
});

test('browser model deletion disposes the live pipeline and removes only its exact cache key', async () => {
  const deleted = [];
  let disposed = 0;
  const previousCaches = globalThis.caches;
  globalThis.caches = { delete: async (key) => { deleted.push(key); return true; } };
  try {
    const engine = Object.assign(async () => ({ audio: new Float32Array([0]), sampling_rate: 16000 }), { dispose: async () => { disposed += 1; } });
    const item = provider.createBrowserModelProvider({ modelId: 'cmn-vits', pipelineFactory: async () => engine });
    const downloaded = await item.modelManagement.download({});
    const result = await item.modelManagement.delete();
    assert.equal(disposed, 1);
    assert.deepEqual(deleted, [downloaded.cacheId]);
    assert.equal(result.cacheId, downloaded.cacheId);
  } finally {
    globalThis.caches = previousCaches;
  }
});

test('voice ids are namespaced and rates are bounded', () => {
  assert.equal(provider.voiceId('browser-system', 'Alice'), 'browser-system:Alice');
  assert.equal(provider.clampRate(9), 2);
  assert.equal(provider.clampRate(0.1), 0.75);
});
