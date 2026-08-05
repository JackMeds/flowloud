const test = require('node:test');
const assert = require('node:assert/strict');

const { createBroker } = require('../offscreen.js');

async function blobToBase64(blob) {
  return Buffer.from(await blob.arrayBuffer()).toString('base64');
}

test('offscreen broker converts a synthesized WAV Blob to a message-safe base64 response', async () => {
  const calls = [];
  const broker = createBroker({
    blobToBase64,
    api: {
      async ensureLocalVoices(options) {
        calls.push({ type: 'sync', profiles: options.profiles, signal: options.signal });
      },
      async synthesize(request, signal) {
        calls.push({ type: 'synthesize', request, signal });
        return {
          blob: new Blob([new Uint8Array([82, 73, 70, 70])], { type: 'audio/wav' }),
          mimeType: 'audio/wav',
        };
      },
    },
  });

  const result = await broker.handle({
    type: 'tts:synthesize',
    clientId: 'tab-1',
    playbackId: 'play-3',
    requestId: 'request-9',
    profiles: [{ name: '邵思萌', wavB64: 'd2F2' }],
    request: { input: '你好。', voice: '邵思萌' },
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].profiles[0].name, '邵思萌');
  assert.equal(calls[1].request.input, '你好。');
  assert.equal(calls[1].signal, calls[0].signal);
  assert.deepEqual(result, {
    ok: true,
    audioBase64: 'UklGRg==',
    mimeType: 'audio/wav',
    requestId: 'request-9',
  });
});

test('offscreen cancellation aborts only the matching immutable playback identity', async () => {
  const started = [];
  const api = {
    async ensureLocalVoices() {},
    async synthesize(request, signal) {
      started.push(request.input);
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        }, { once: true });
        if (request.input === 'B') {
          resolve({ blob: new Blob(['B'], { type: 'audio/wav' }), mimeType: 'audio/wav' });
        }
      });
    },
  };
  const broker = createBroker({ api, blobToBase64 });
  const requestA = broker.handle({
    type: 'tts:synthesize', clientId: 'tab-A', playbackId: 'play-A', requestId: 'req-A',
    request: { input: 'A', voice: 'voice-a' }, profiles: [],
  });
  const requestB = broker.handle({
    type: 'tts:synthesize', clientId: 'tab-B', playbackId: 'play-B', requestId: 'req-B',
    request: { input: 'B', voice: 'voice-b' }, profiles: [],
  });

  const cancelled = await broker.handle({
    type: 'tts:cancel', clientId: 'tab-A', playbackId: 'play-A',
  });
  const [resultA, resultB] = await Promise.all([requestA, requestB]);

  assert.deepEqual(started, ['B']);
  assert.deepEqual(cancelled, { ok: true, cancelled: true, count: 1 });
  assert.equal(resultA.ok, false);
  assert.equal(resultA.error.code, 'cancelled');
  assert.equal(resultB.ok, true);
  assert.equal(resultB.audioBase64, 'Qg==');
});

test('offscreen broker returns a stable timeout error after its deadline', async () => {
  const broker = createBroker({
    timeoutMs: 5,
    blobToBase64,
    api: {
      async ensureLocalVoices() {},
      async synthesize(_request, signal) {
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          }, { once: true });
        });
      },
    },
  });

  const result = await broker.handle({
    type: 'tts:synthesize', clientId: 'tab', playbackId: 'play', requestId: 'slow',
    request: { input: '很慢', voice: '邵思萌' }, profiles: [],
  });

  assert.deepEqual(result, {
    ok: false,
    requestId: 'slow',
    error: {
      code: 'timeout',
      message: '模型启动或语音合成超过 60 秒，请检查本地 Qwen 服务。',
      retriable: true,
    },
  });
});

test('offscreen voice list marks browser profiles without exposing storage to the document', async () => {
  const broker = createBroker({
    blobToBase64,
    api: {
      async ensureLocalVoices(options) {
        assert.deepEqual(options.profiles, [{ name: '旁白', wavB64: 'd2F2' }]);
      },
      async voices() {
        return [{ name: '邵思萌' }, { name: '旁白' }];
      },
    },
  });

  const result = await broker.handle({
    type: 'voice:list', requestId: 'voices-1', profiles: [{ name: '旁白', wavB64: 'd2F2' }],
  });

  assert.deepEqual(result, {
    ok: true,
    requestId: 'voices-1',
    voices: [{ name: '邵思萌', local: false }, { name: '旁白', local: true }],
  });
});
