const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ProviderError,
  LOCAL_CAPABILITIES,
  normalizeCapabilities,
  negotiateCapabilities,
  effectiveCapabilities,
  normalizeProviderError,
  normalizeHealth,
  createProviderRegistry,
  migrateProviderConfig,
  createLocalQwenProvider,
} = require('../shared/provider-v2.js');

function makeProvider(overrides = {}) {
  return Object.assign({
    id: 'fake',
    version: 2,
    capabilities: { health: true, voices: true, synthesize: true, stream: true, cancel: true },
    async health() { return { ok: true }; },
    async voices() { return []; },
    async synthesize() { return { audio: new Uint8Array([1]) }; },
    stream() { return (async function* empty() {})(); },
    async cancel() { return { cancelled: false }; },
  }, overrides);
}

test('Provider V2 normalizes capability aliases and negotiates optional streaming levels', () => {
  const capabilities = normalizeCapabilities({
    health: true,
    voices: true,
    synthesize: true,
    supportsStream: true,
    streaming: true,
    progressive: false,
    incremental: false,
  });
  assert.equal(capabilities.stream, true);
  assert.equal(capabilities.transportStreaming, true);
  assert.equal(capabilities.progressivePlayback, false);
  assert.equal(capabilities.backendIncrementalGeneration, false);

  const report = negotiateCapabilities({ id: 'fake', version: 2, capabilities }, [
    'synthesize', 'stream', 'transportStreaming',
  ]);
  assert.equal(report.ok, true);
  assert.deepEqual(report.missing, []);
  assert.deepEqual(report.requested, ['synthesize', 'stream', 'transportStreaming']);

  const progressive = negotiateCapabilities({ id: 'fake', version: 2, capabilities }, ['progressivePlayback']);
  assert.equal(progressive.ok, false);
  assert.deepEqual(progressive.missing, ['progressivePlayback']);
});

test('registry validates the V2 contract, selects by capability, and reports duplicates', () => {
  const registry = createProviderRegistry({ providers: [makeProvider()] });
  assert.equal(registry.get('fake').version, 2);
  assert.deepEqual(registry.inspect(), [{
    id: 'fake',
    version: 2,
    capabilities: ['health', 'voices', 'synthesize', 'stream', 'cancel'],
  }]);
  assert.equal(registry.select({ providerId: 'fake', required: ['stream'] }).id, 'fake');
  assert.throws(
    () => registry.register(makeProvider()),
    (error) => error instanceof ProviderError && error.code === 'provider_exists',
  );
  assert.throws(
    () => registry.select({ required: ['progressivePlayback'] }),
    (error) => error instanceof ProviderError && error.code === 'capability_mismatch',
  );
  assert.equal(registry.unregister('fake'), true);
  assert.equal(registry.get('fake'), null);
});

test('health can dynamically downgrade static capabilities without changing the provider declaration', () => {
  const provider = makeProvider({ capabilities: LOCAL_CAPABILITIES });
  const dynamic = effectiveCapabilities(provider, {
    capabilities: { progressivePlayback: true, backendIncrementalGeneration: true },
  });
  assert.equal(dynamic.progressivePlayback, true);
  assert.equal(dynamic.backendIncrementalGeneration, true);
  assert.equal(provider.capabilities.progressivePlayback, false);
});

test('health only marks a backend ready from a ready state or a positive PID', () => {
  assert.equal(normalizeHealth({ gateway: 'ok', backend: 'unloaded', backendPid: 0 }).ready, false);
  assert.equal(normalizeHealth({ gateway: 'ok', backendPid: 0, ready: true }).ready, true);
  assert.equal(normalizeHealth({ gateway: 'ok', backend: 'loaded', backendPid: 42, ready: false }).ready, false);
  assert.equal(normalizeHealth({ gateway: 'ok', backend: 'loaded', backendPid: 0 }).ready, true);
  assert.equal(normalizeHealth({ gateway: 'ok', backend: 'unloaded', backendPid: 42 }).ready, true);
  assert.equal(normalizeHealth({ gateway: 'ok', ready: true }).ready, true);
});

test('error normalization preserves stable codes and never exposes a raw error in JSON', () => {
  const normalized = normalizeProviderError(Object.assign(new Error('连接被拒绝'), {
    code: 'network_error',
  }), {
    providerId: 'local-qwen',
    operation: 'stream',
    requestId: 'req-1',
  });
  assert.equal(normalized.code, 'network_error');
  assert.equal(normalized.retriable, true);
  assert.equal(normalized.providerId, 'local-qwen');
  assert.equal(normalized.requestId, 'req-1');
  assert.equal(normalized.toJSON().cause, undefined);

  const aborted = normalizeProviderError(Object.assign(new Error('aborted'), { name: 'AbortError' }), {
    providerId: 'local-qwen',
  });
  assert.equal(aborted.code, 'cancelled');
  assert.equal(aborted.retriable, false);

  const fetchFailure = normalizeProviderError(new TypeError('Failed to fetch'), {
    providerId: 'local-qwen',
  });
  assert.equal(fetchFailure.code, 'network_error');
  assert.equal(fetchFailure.retriable, true);
});

test('configuration migration is idempotent, preserves unknown settings, and keeps legacy keys', () => {
  const old = {
    apiBaseUrl: 'http://127.0.0.1:7811',
    model: 'custom-model',
    response_format: 'wav',
    voiceMode: 'stable-author',
    unknownUserSetting: { keep: true },
  };
  const migrated = migrateProviderConfig(old);
  const again = migrateProviderConfig(migrated);
  assert.equal(migrated.providerId, 'local-qwen');
  assert.equal(migrated.providerVersion, 2);
  assert.equal(migrated.providerOptions.baseUrl, 'http://127.0.0.1:7811');
  assert.equal(migrated.providerOptions.model, 'custom-model');
  assert.equal(migrated.providerOptions.responseFormat, 'wav');
  assert.deepEqual(migrated.unknownUserSetting, { keep: true });
  assert.equal(migrated.apiBaseUrl, 'http://127.0.0.1:7811');
  assert.deepEqual(again, migrated);

  const unsafe = migrateProviderConfig({ apiBaseUrl: 'http://192.168.1.3:7811', keep: 1 });
  assert.equal(unsafe.providerOptions.baseUrl, 'http://127.0.0.1:7811');
  assert.equal(unsafe.apiBaseUrl, 'http://127.0.0.1:7811');
  assert.deepEqual(unsafe.providerMigrationWarnings, ['unsafe_base_url_replaced']);
  assert.equal(unsafe.keep, 1);
});

test('local-qwen adapter exposes normalized health, voices, and synthesize results', async () => {
  const calls = [];
  const api = {
    async status(signal) {
      assert.equal(signal === undefined || signal.aborted === false, true);
      return {
        gateway: 'running',
        backend: 'loaded',
        backendPid: 42,
        capabilities: { transportStreaming: true, progressivePlayback: false },
      };
    },
    async voices() {
      return [{ name: '邵思萌', kind: 'builtin' }, 'qwen-clone'];
    },
    async synthesize(request, signal) {
      calls.push({ request, signal });
      return { blob: new Blob([new Uint8Array([82, 73, 70, 70])], { type: 'audio/wav' }) };
    },
  };
  const provider = createLocalQwenProvider({ api, baseUrl: 'http://127.0.0.1:7811', model: 'model-v2' });
  const health = await provider.health();
  assert.equal(health.ok, true);
  assert.equal(health.ready, true);
  assert.equal(health.backendPid, 42);
  assert.equal(health.capabilities.progressivePlayback, false);
  const voices = await provider.voices();
  assert.deepEqual(voices.map((voice) => voice.name), ['邵思萌', 'qwen-clone']);
  assert.equal(voices[0].providerId, 'local-qwen');
  const result = await provider.synthesize({ input: '你好', voice: '邵思萌', requestId: 's-1' });
  assert.equal(result.providerId, 'local-qwen');
  assert.equal(result.requestId, 's-1');
  assert.equal(result.mimeType, 'audio/wav');
  assert.equal(calls[0].request.model, 'model-v2');
  assert.equal(calls[0].request.response_format, 'wav');
});

test('local-qwen stream yields transport chunks progressively and sends the localhost header', async () => {
  const calls = [];
  const chunks = [new Uint8Array([1, 2]), new Uint8Array([3, 4])];
  const api = {
    async status() { return { gateway: 'running' }; },
    async voices() { return []; },
  };
  const fakeResponse = {
    ok: true,
    status: 200,
    headers: { get(name) { return name === 'content-type' ? 'audio/wav' : ''; } },
    body: {
      getReader() {
        let index = 0;
        return {
          async read() {
            if (index >= chunks.length) return { done: true, value: undefined };
            return { done: false, value: chunks[index++] };
          },
        };
      },
    },
  };
  const provider = createLocalQwenProvider({
    api,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return fakeResponse;
    },
  });
  const events = [];
  for await (const event of provider.stream({
    input: '流式测试',
    voice: '邵思萌',
    requestId: 'stream-1',
  }, { clientId: 'tab-1', playbackId: 'play-1', sessionId: 'session-1' })) events.push(event);
  assert.deepEqual(events.map((event) => event.type), ['data', 'data', 'end']);
  assert.deepEqual([...events[0].data], [1, 2]);
  assert.deepEqual([...events[1].data], [3, 4]);
  assert.equal(events[2].final, true);
  assert.equal(calls[0].url, 'http://127.0.0.1:7811/v1/audio/speech/stream');
  assert.equal(calls[0].options.headers['x-qwen-reader-client'], 'qwen-reader-extension-v1');
  const requestBody = JSON.parse(calls[0].options.body);
  assert.equal(requestBody.response_format, 'wav');
  assert.equal(requestBody.stream, true);
  assert.equal(requestBody.request_id, 'stream-1');
  assert.equal(requestBody.client_id, 'tab-1');
  assert.equal(requestBody.playback_id, 'play-1');
  assert.equal(requestBody.session_id, 'session-1');
});

test('local-qwen adapter prefers the API client streaming contract and falls back once when unsupported', async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([9, 8]));
      controller.close();
    },
  });
  const calls = [];
  const api = {
    async status() { return { gateway: 'running' }; },
    streamCapability() { return 'supported'; },
    async synthesizeStream(request) {
      calls.push(['stream', request]);
      return { stream, mimeType: 'audio/wav' };
    },
  };
  const provider = createLocalQwenProvider({ api, fetchImpl: undefined });
  const events = [];
  for await (const event of provider.stream({ input: '优先使用 API 流', requestId: 'api-stream' })) events.push(event);
  assert.deepEqual(events.map((event) => event.type), ['data', 'end']);
  assert.deepEqual([...events[0].data], [9, 8]);
  assert.equal(calls[0][0], 'stream');

  let synthesizeCalls = 0;
  const fallbackApi = {
    async status() { return { gateway: 'running' }; },
    streamCapability() { return 'unsupported'; },
    async synthesizeStream() { throw Object.assign(new Error('not supported'), { code: 'stream_unsupported' }); },
    async synthesize() {
      synthesizeCalls += 1;
      return { blob: new Blob([new Uint8Array([7, 6])], { type: 'audio/wav' }) };
    },
  };
  const fallback = createLocalQwenProvider({
    api: fallbackApi,
    fetchImpl: async () => { throw new Error('不应绕过 API 客户端回退'); },
  });
  const fallbackEvents = [];
  for await (const event of fallback.stream({ input: '回退合成', requestId: 'api-fallback' })) fallbackEvents.push(event);
  assert.deepEqual(fallbackEvents.map((event) => event.type), ['data', 'end']);
  assert.deepEqual([...fallbackEvents[0].data], [7, 6]);
  assert.equal(synthesizeCalls, 1);
});

test('local-qwen adapter rejects non-loopback URLs and supports explicit cancellation', async () => {
  assert.throws(
    () => createLocalQwenProvider({
      baseUrl: 'http://192.168.1.2:7811',
      api: { async status() {}, async voices() {}, async synthesize() {} },
    }),
    /127\.0\.0\.1/,
  );

  const provider = createLocalQwenProvider({
    api: { async status() {}, async voices() {} },
    streamTransport({ signal }) {
      return (async function* waitForAbort() {
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
        throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
      }());
    },
  });
  const iterator = provider.stream({ input: '待取消', requestId: 'cancel-1' });
  const pending = iterator.next();
  const cancelled = await provider.cancel('cancel-1');
  assert.equal(cancelled.cancelled, true);
  await assert.rejects(pending, (error) => error.code === 'cancelled');
  assert.equal((await provider.cancel('cancel-1')).cancelled, false);
});

test('local-qwen rejects duplicate request IDs and cancellation requires the matching identity', async () => {
  const provider = createLocalQwenProvider({
    api: { async status() {}, async voices() {} },
    streamTransport({ signal }) {
      return (async function* waitForAbort() {
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
        throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
      }());
    },
  });
  const first = provider.stream({ input: '第一个请求', requestId: 'shared-request' }, {
    clientId: 'client-a', playbackId: 'play-a', sessionId: 'session-a',
  });
  const pending = first.next();

  assert.throws(
    () => provider.stream({ input: '第二个请求', requestId: 'shared-request' }, {
      clientId: 'client-b', playbackId: 'play-b', sessionId: 'session-b',
    }),
    (error) => error instanceof ProviderError && error.code === 'duplicate_request',
  );

  const wrongIdentity = await provider.cancel({
    requestId: 'shared-request', clientId: 'client-b', playbackId: 'play-b', sessionId: 'session-b',
  });
  assert.equal(wrongIdentity.cancelled, false);

  const correctIdentity = await provider.cancel({
    requestId: 'shared-request', clientId: 'client-a', playbackId: 'play-a', sessionId: 'session-a',
  });
  assert.equal(correctIdentity.cancelled, true);
  await assert.rejects(pending, (error) => error.code === 'cancelled');
});
