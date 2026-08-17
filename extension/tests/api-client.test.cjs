const test = require('node:test');
const assert = require('node:assert/strict');

const { createApiClient } = require('../shared/api-client.js');

function createFetch(responses) {
  const calls = [];
  const queue = [...responses];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetchImpl, calls };
}

test('synthesize sends the fixed local WAV request and returns a WAV Blob', async () => {
  const wav = new Uint8Array([82, 73, 70, 70]).buffer;
  const fake = createFetch([new Response(wav, {
    status: 200,
    headers: { 'content-type': 'audio/wav' },
  })]);
  const client = createApiClient({ fetchImpl: fake.fetchImpl });

  const result = await client.synthesize({
    input: '你好，世界。',
    voice: '邵思萌',
    model: 'untrusted-model',
    response_format: 'mp3',
  });

  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].url, 'http://127.0.0.1:7811/v1/audio/speech');
  assert.equal(fake.calls[0].options.method, 'POST');
  assert.equal(fake.calls[0].options.headers['content-type'], 'application/json');
  const body = JSON.parse(fake.calls[0].options.body);
  assert.deepEqual(body, {
    input: '你好，世界。',
    voice: '邵思萌',
    model: 'untrusted-model',
    response_format: 'mp3',
  });
  assert.equal(result.mimeType, 'audio/wav');
  assert.equal(result.blob.type, 'audio/wav');
  assert.deepEqual([...new Uint8Array(await result.blob.arrayBuffer())], [82, 73, 70, 70]);
});

test('synthesizeStream negotiates a readable stream and keeps the trusted request contract', async () => {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([82, 73, 70, 70]));
      controller.close();
    },
  });
  const fake = createFetch([new Response(body, {
    status: 200,
    headers: { 'content-type': 'audio/wav' },
  })]);
  const client = createApiClient({ fetchImpl: fake.fetchImpl });

  const result = await client.synthesizeStream({ input: '流式你好。', voice: '旁白' });

  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].url, 'http://127.0.0.1:7811/v1/audio/speech/stream');
  assert.equal(fake.calls[0].options.headers['x-qwen-reader-client'], 'qwen-reader-extension-v1');
  assert.deepEqual(JSON.parse(fake.calls[0].options.body), {
    input: '流式你好。',
    voice: '旁白',
    model: 'qwen3-tts-1.7b-base',
    response_format: 'wav',
    stream: true,
  });
  assert.equal(typeof result.stream.getReader, 'function');
  assert.equal(client.streamCapability(), 'supported');
});

test('synthesizeStream remembers an unavailable endpoint and exposes a stable fallback code', async () => {
  const fake = createFetch([new Response(JSON.stringify({ error: { message: 'not found' } }), {
    status: 404,
    headers: { 'content-type': 'application/json' },
  })]);
  const client = createApiClient({ fetchImpl: fake.fetchImpl });

  await assert.rejects(
    client.synthesizeStream({ input: '旧网关' }),
    (error) => error.code === 'stream_unsupported',
  );
  await assert.rejects(
    client.synthesizeStream({ input: '旧网关再次请求' }),
    (error) => error.code === 'stream_unsupported',
  );
  assert.equal(fake.calls.length, 1);
  assert.equal(client.streamCapability(), 'unsupported');
});

test('speech identity is sanitized consistently across headers and stream request body', async () => {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([82, 73, 70, 70]));
      controller.close();
    },
  });
  const fake = createFetch([new Response(body, {
    status: 200,
    headers: { 'content-type': 'audio/wav' },
  })]);
  const client = createApiClient({ fetchImpl: fake.fetchImpl });

  await client.synthesizeStream({
    input: '带身份的流',
    voice: '旁白',
    requestId: ' req/stream\r\nunsafe ',
    playbackId: 'playback:42',
  });

  const call = fake.calls[0];
  assert.equal(call.options.headers['x-qwen-request-id'], 'req_stream__unsafe');
  assert.equal(call.options.headers['x-qwen-playback-id'], 'playback:42');
  assert.deepEqual(JSON.parse(call.options.body), {
    input: '带身份的流',
    voice: '旁白',
    model: 'qwen3-tts-1.7b-base',
    response_format: 'wav',
    stream: true,
    request_id: 'req_stream__unsafe',
    playback_id: 'playback:42',
  });
});

test('health capabilities are queried and suppress a stream probe when explicitly unsupported', async () => {
  const fake = createFetch([new Response(JSON.stringify({
    gateway: 'running',
    capabilities: { stream: false, transportStreaming: false },
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })]);
  const client = createApiClient({ fetchImpl: fake.fetchImpl });

  await client.status();
  assert.equal(client.streamCapability(), 'unsupported');
  await assert.rejects(
    client.synthesizeStream({ input: '不要探测' }),
    (error) => error.code === 'stream_unsupported',
  );
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].url, 'http://127.0.0.1:7811/health');
});

test('speech cancel and status APIs use the same safe request and playback identity', async () => {
  const json = (value, status = 200) => new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
  const fake = createFetch([
    json({ status: 'cancellation_requested', request_id: 'r-1', playback_id: 'p-1' }),
    json({ status: 'active', request_id: 'r-1', playback_id: 'p-1' }),
  ]);
  const client = createApiClient({ fetchImpl: fake.fetchImpl });

  const cancelled = await client.cancel({ requestId: 'r-1', playbackId: 'p-1' });
  const current = await client.speechStatus({ requestId: 'r-1', playbackId: 'p-1' });

  assert.equal(cancelled.status, 'cancellation_requested');
  assert.equal(current.status, 'active');
  assert.equal(fake.calls[0].url, 'http://127.0.0.1:7811/v1/audio/speech/cancel');
  assert.equal(fake.calls[0].options.headers['x-qwen-request-id'], 'r-1');
  assert.equal(fake.calls[0].options.headers['x-qwen-playback-id'], 'p-1');
  assert.deepEqual(JSON.parse(fake.calls[0].options.body), {
    request_id: 'r-1', playback_id: 'p-1',
  });
  assert.equal(fake.calls[1].url, 'http://127.0.0.1:7811/v1/audio/speech/status/r-1');
  assert.equal(fake.calls[1].options.headers['x-qwen-request-id'], 'r-1');
  assert.equal(fake.calls[1].options.headers['x-qwen-playback-id'], 'p-1');
});

test('ensureLocalVoices only registers locally saved profiles absent from the server', async () => {
  const fake = createFetch([
    new Response(JSON.stringify({ voices: [{ name: '邵思萌', kind: 'registered' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
    new Response(JSON.stringify({ gateway: 'running', backendPid: null }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
    new Response(JSON.stringify({ name: '旁白', status: 'registered' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  ]);
  const storage = {
    async get(key) {
      assert.equal(key, 'voiceProfiles');
      return [{ name: '邵思萌', wavB64: 'cHJlc2VydmU=' }, {
        name: '旁白', refText: '这是参考台词。', wavB64: 'bmV3LXZvaWNl',
      }];
    },
  };
  const client = createApiClient({ fetchImpl: fake.fetchImpl, storage });

  const result = await client.ensureLocalVoices();

  assert.deepEqual(result.registered, ['旁白']);
  assert.equal(fake.calls.length, 3);
  assert.equal(fake.calls[0].url, 'http://127.0.0.1:7811/v1/audio/voices');
  assert.equal(fake.calls[1].url, 'http://127.0.0.1:7811/health');
  assert.equal(fake.calls[2].url, 'http://127.0.0.1:7811/v1/audio/voices');
  const registration = JSON.parse(fake.calls[2].options.body);
  assert.deepEqual(registration, {
    name: '旁白', ref_text: '这是参考台词。', wav_b64: 'bmV3LXZvaWNl',
  });
});

test('refuses a non-loopback base URL before any network request', () => {
  assert.throws(
    () => createApiClient({
      baseUrl: 'http://192.168.1.10:7811',
      fetchImpl: async () => new Response(),
    }),
    /127\.0\.0\.1/,
  );
});

test('refuses a loopback TTS URL on a port other than 7811', () => {
  assert.throws(
    () => createApiClient({
      baseUrl: 'http://127.0.0.1:7812',
      fetchImpl: async () => new Response(),
    }),
    /7811/,
  );
});

test('ensureLocalVoices re-registers same-name profiles only when the backend PID changes', async () => {
  const voicesResponse = () => new Response(JSON.stringify({ voices: [{ name: '邵思萌' }] }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
  const healthResponse = (backendPid) => new Response(JSON.stringify({
    gateway: 'running', backend: 'loaded', backendPid,
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  const registeredResponse = () => new Response(JSON.stringify({ status: 'registered' }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
  const fake = createFetch([
    voicesResponse(), healthResponse(101), registeredResponse(),
    voicesResponse(), healthResponse(101),
    voicesResponse(), healthResponse(202), registeredResponse(),
  ]);
  const storage = {
    async get() { return [{ name: '邵思萌', wavB64: 'c2hhbw==' }]; },
  };
  const client = createApiClient({ fetchImpl: fake.fetchImpl, storage });

  const first = await client.ensureLocalVoices();
  const sameProcess = await client.ensureLocalVoices();
  const restarted = await client.ensureLocalVoices();

  assert.deepEqual(first.registered, ['邵思萌']);
  assert.deepEqual(sameProcess.registered, []);
  assert.deepEqual(restarted.registered, ['邵思萌']);
  assert.equal(fake.calls.filter((call) => call.options.method === 'POST').length, 2);
});

test('registerVoice reports a local server error with its message', async () => {
  const fake = createFetch([new Response(JSON.stringify({
    error: { message: '录音格式无效' },
  }), {
    status: 400,
    headers: { 'content-type': 'application/json' },
  })]);
  const client = createApiClient({ fetchImpl: fake.fetchImpl });

  await assert.rejects(
    client.registerVoice({ name: '失败音色', wavB64: 'bad' }),
    (error) => error.code === 'http_400' && error.message === '录音格式无效',
  );
});

test('every local API request carries the browser-extension client header', async () => {
  const json = (value) => new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  const fake = createFetch([
    json({ gateway: 'ok' }),
    json({ voices: [] }),
    new Response(new Uint8Array([82, 73, 70, 70]), {
      status: 200,
      headers: { 'content-type': 'audio/wav' },
    }),
    json({ status: 'registered' }),
    json({ status: 'deleted' }),
  ]);
  const client = createApiClient({ fetchImpl: fake.fetchImpl });

  await client.status();
  await client.voices();
  await client.synthesize({ input: '测试', voice: '邵思萌' });
  await client.registerVoice({ name: '测试音色', wavB64: 'UklGRg==' });
  await client.deleteVoice('测试音色');

  assert.equal(fake.calls.length, 5);
  for (const call of fake.calls) {
    assert.equal(call.options.headers['x-qwen-reader-client'], 'qwen-reader-extension-v1');
  }
});

test('background returns a Chinese error envelope for a rejected request', async () => {
  const { createMessageRouter } = require('../background.js');
  const router = createMessageRouter({
    api: { async status() { throw Object.assign(new Error('无法连接'), { code: 'network_error' }); } },
    storage: { async get() { return []; }, async set() {} },
  });

  const result = await router({ type: 'tts:status' });

  assert.deepEqual(result, { ok: false, error: { code: 'network_error', message: '无法连接' } });
});

test('background opens the voice studio through its message contract', async () => {
  const { createMessageRouter } = require('../background.js');
  let opened = 0;
  const router = createMessageRouter({
    api: {},
    storage: { async get() { return []; }, async set() {} },
    openVoiceStudio: async () => { opened += 1; },
  });

  const result = await router({ type: 'voice:studio:open' });

  assert.deepEqual(result, { ok: true });
  assert.equal(opened, 1);
});

test('install wires toolbar and keyboard actions to the active tab', async () => {
  const { install } = require('../background.js');
  const listeners = {};
  const sent = [];
  const chromeApi = {
    storage: {
      local: {
        async get() { return {}; },
        async set() {},
      },
    },
    runtime: {
      getURL(path) { return `chrome-extension://reader/${path}`; },
      onMessage: { addListener(listener) { listeners.message = listener; } },
    },
    action: { onClicked: { addListener(listener) { listeners.action = listener; } } },
    commands: { onCommand: { addListener(listener) { listeners.command = listener; } } },
    tabs: {
      async query() { return [{ id: 17 }]; },
      async sendMessage(tabId, message) { sent.push({ tabId, message }); },
      async create() {},
    },
  };

  install(chromeApi);
  await listeners.action({ id: 8 });
  await listeners.command('toggle-reader');

  assert.deepEqual(sent, [
    { tabId: 8, message: { type: 'ui:toggle' } },
    { tabId: 17, message: { type: 'ui:toggle' } },
  ]);
});

test('background sends browser-saved profiles to the offscreen voice library', async () => {
  const { createMessageRouter } = require('../background.js');
  let forwarded;
  const router = createMessageRouter({
    api: {},
    offscreen: {
      async request(message) {
        forwarded = message;
        return { ok: true, voices: [
          { name: '邵思萌', kind: 'registered' },
          { name: '旁白', kind: 'registered', local: true },
        ] };
      },
      async cancel() { return { ok: true, cancelled: false }; },
    },
    storage: {
      async get(key) {
        return key === 'voiceProfiles' ? [{ name: '旁白', wavB64: 'd2F2' }] : [];
      },
      async set() {},
    },
  });

  const result = await router({ type: 'voice:list' });

  assert.equal(forwarded.type, 'voice:list');
  assert.deepEqual(forwarded.profiles, [{ name: '旁白', wavB64: 'd2F2' }]);
  assert.deepEqual(result, {
    ok: true,
    voices: [
      {
        name: '邵思萌', kind: 'registered', local: false, editable: false,
        readOnly: true, source: 'backend',
      },
      {
        name: '旁白', kind: 'registered', local: true, editable: true,
        readOnly: false, source: 'browser', sourceFileName: '', durationSeconds: 0, refText: '',
      },
    ],
  });
});

test('deleting an active custom voice repairs saved OP and reply assignments', async () => {
  const { createMessageRouter } = require('../background.js');
  const values = {
    voiceProfiles: [
      { name: '自定义楼主', wavB64: 'b3A=' },
      { name: '自定义回复', wavB64: 'cmVwbHk=' },
    ],
    qwenReaderSettings: {
      preset: 'op-exclusive',
      opVoice: '自定义楼主',
      replyVoices: ['自定义回复'],
    },
  };
  const router = createMessageRouter({
    api: {},
    offscreen: {
      async request() { return { ok: true, voice: '自定义楼主' }; },
      async cancel() { return { ok: true }; },
    },
    storage: {
      async get(key) { return values[key]; },
      async set(key, value) { values[key] = value; },
    },
  });

  const result = await router({ type: 'voice:delete', name: '自定义楼主' });

  assert.equal(result.ok, true);
  assert.deepEqual(values.voiceProfiles.map((profile) => profile.name), ['自定义回复']);
  assert.notEqual(values.qwenReaderSettings.opVoice, '自定义楼主');
  assert.ok(values.qwenReaderSettings.replyVoices.length > 0);
  assert.ok(!values.qwenReaderSettings.replyVoices.includes('自定义楼主'));
  assert.ok(!values.qwenReaderSettings.replyVoices.includes(values.qwenReaderSettings.opVoice));
});
