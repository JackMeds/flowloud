const test = require('node:test');
const assert = require('node:assert/strict');

const { createBroker } = require('../offscreen.js');
const { createProviderRegistry } = require('../shared/provider-v2.js');

async function blobToBase64(blob) {
  return Buffer.from(await blob.arrayBuffer()).toString('base64');
}

test('offscreen routes health, voices, synthesis, and streaming through the selected Provider V2', async () => {
  const calls = [];
  const provider = {
    id: 'test-provider',
    version: 2,
    capabilities: {
      health: true,
      voices: true,
      synthesize: true,
      stream: true,
      cancel: true,
      transportStreaming: true,
    },
    async health() {
      calls.push('health');
      return { providerId: 'test-provider', ok: true, capabilities: this.capabilities };
    },
    async voices() {
      calls.push('voices');
      return [{ name: 'Provider 音色' }];
    },
    async synthesize(request) {
      calls.push({ type: 'synthesize', request });
      return { blob: new Blob(['provider-audio'], { type: 'audio/wav' }), mimeType: 'audio/wav' };
    },
    stream(request) {
      calls.push({ type: 'stream', request });
      return (async function* events() {
        yield { type: 'data', data: new Uint8Array([80, 86]) };
        yield { type: 'end', final: true };
      }());
    },
    async cancel(identity) {
      calls.push({ type: 'cancel', identity });
      return { cancelled: true };
    },
  };
  const broker = createBroker({
    AudioContextCtor: null,
    blobToBase64,
    api: { async ensureLocalVoices() {} },
    providerId: 'test-provider',
    providerRegistry: createProviderRegistry({ providers: [provider] }),
  });

  const status = await broker.handle({ type: 'tts:status', requestId: 'health-1' });
  const voices = await broker.handle({ type: 'tts:voices', requestId: 'voices-1' });
  const audio = await broker.handle({
    type: 'tts:synthesize', requestId: 'synth-1', clientId: 'tab-1', playbackId: 'play-1',
    request: { input: 'Provider 合成', voice: 'Provider 音色' },
  });
  const streamed = await broker.handle({
    type: 'tts:synthesize', stream: true, requestId: 'stream-1', clientId: 'tab-1', playbackId: 'play-2',
    request: { input: 'Provider 流式', voice: 'Provider 音色' },
  });

  assert.equal(status.ok, true);
  assert.equal(status.status.providerId, 'test-provider');
  assert.deepEqual(voices.voices, [{ name: 'Provider 音色' }]);
  assert.equal(audio.audioBase64, Buffer.from('provider-audio').toString('base64'));
  assert.equal(streamed.audioBase64, 'UFY=');
  assert.deepEqual(calls.map((entry) => typeof entry === 'string' ? entry : entry.type), [
    'health', 'voices', 'synthesize', 'health', 'stream',
  ]);
  assert.equal(calls[2].request.requestId, 'synth-1');
  assert.equal(calls[4].request.playbackId, 'play-2');
});

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
  assert.equal(calls[1].request.requestId, 'request-9');
  assert.equal(calls[1].request.playbackId, 'play-3');
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

test('offscreen cancellation optionally notifies the provider once with matching IDs', async () => {
  const cancelCalls = [];
  const broker = createBroker({
    blobToBase64,
    api: {
      async ensureLocalVoices() {},
      async cancel(identity) {
        cancelCalls.push(identity);
      },
      async synthesize(_request, signal) {
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          }, { once: true });
        });
      },
    },
  });
  const pending = broker.handle({
    type: 'tts:synthesize', clientId: 'cancel-tab', playbackId: 'cancel-play', requestId: 'cancel-req',
    request: { input: '取消', voice: '旁白' }, profiles: [],
  });

  const first = await broker.handle({
    type: 'tts:cancel', clientId: 'cancel-tab', playbackId: 'cancel-play', requestId: 'cancel-req',
  });
  const second = await broker.handle({
    type: 'tts:cancel', clientId: 'cancel-tab', playbackId: 'cancel-play', requestId: 'cancel-req',
  });
  const result = await pending;

  assert.equal(first.count, 1);
  assert.equal(second.count, 1);
  assert.deepEqual(cancelCalls, [{
    requestId: 'cancel-req', clientId: 'cancel-tab', playbackId: 'cancel-play', sessionId: '',
  }]);
  assert.equal(result.error.code, 'cancelled');
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

test('offscreen stream transport falls back to a message-safe whole audio blob without AudioContext', async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([82, 73]));
      controller.enqueue(new Uint8Array([70, 70]));
      controller.close();
    },
  });
  const broker = createBroker({
    AudioContextCtor: null,
    blobToBase64,
    api: {
      async ensureLocalVoices() {},
      async synthesizeStream() {
        return { stream, mimeType: 'audio/wav' };
      },
    },
  });

  const result = await broker.handle({
    type: 'tts:synthesize', stream: true,
    clientId: 'tab-stream', playbackId: 'play-stream', requestId: 'stream-1',
    request: { input: '流式片段', voice: '旁白' }, profiles: [],
  });

  assert.deepEqual(result, {
    ok: true,
    requestId: 'stream-1',
    audioBase64: 'UklGRg==',
    mimeType: 'audio/wav',
    streaming: true,
    transportStreaming: true,
    progressivePlayback: false,
  });
});

test('offscreen uses health stream capability before probing and keeps identity on whole-audio fallback', async () => {
  let streamCalls = 0;
  let fallbackRequest;
  let capability = 'unknown';
  const broker = createBroker({
    AudioContextCtor: null,
    blobToBase64,
    api: {
      async ensureLocalVoices() {},
      async status() {
        capability = 'unsupported';
        return { capabilities: { stream: false, transportStreaming: false } };
      },
      streamCapability() { return capability; },
      async synthesizeStream() { streamCalls += 1; throw new Error('must not probe'); },
      async synthesize(request) {
        fallbackRequest = request;
        return { blob: new Blob(['fallback'], { type: 'audio/wav' }), mimeType: 'audio/wav' };
      },
    },
  });

  const result = await broker.handle({
    type: 'tts:synthesize', stream: true,
    clientId: 'health-tab', playbackId: 'health-play', requestId: 'health-req',
    request: { input: '健康检查后回退', voice: '旁白' }, profiles: [],
  });

  assert.equal(streamCalls, 0);
  assert.equal(fallbackRequest.requestId, 'health-req');
  assert.equal(fallbackRequest.playbackId, 'health-play');
  assert.equal(result.streamFallback, true);
  assert.equal(result.audioBase64, 'ZmFsbGJhY2s=');
});

test('offscreen retries transient synthesis failures once while preserving the request identity', async () => {
  let streamCalls = 0;
  const broker = createBroker({
    AudioContextCtor: null,
    blobToBase64,
    api: {
      async ensureLocalVoices() {},
      async synthesizeStream() {
        streamCalls += 1;
        if (streamCalls === 1) throw Object.assign(new Error('temporary network'), { code: 'network_error' });
        return {
          stream: new ReadableStream({
            start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); controller.close(); },
          }),
          mimeType: 'audio/wav',
        };
      },
    },
  });

  const result = await broker.handle({
    type: 'tts:synthesize', stream: true, retryCount: 1,
    clientId: 'retry-tab', playbackId: 'retry-play', requestId: 'retry-1',
    request: { input: '重试测试', voice: '旁白' }, profiles: [],
  });

  assert.equal(streamCalls, 2);
  assert.equal(result.ok, true);
  assert.equal(result.requestId, 'retry-1');
  assert.equal(result.audioBase64, 'AQID');
});

test('offscreen progressively schedules PCM WAV chunks and reports only the live stream identity', async () => {
  const sampleRate = 24000;
  const frames = 12000;
  const pcm = new Uint8Array(frames * 2);
  for (let index = 0; index < frames; index += 1) {
    const value = Math.round(Math.sin(index / 12) * 1200);
    pcm[index * 2] = value & 0xff;
    pcm[index * 2 + 1] = (value >> 8) & 0xff;
  }
  const wav = new Uint8Array(44 + pcm.length);
  const view = new DataView(wav.buffer);
  const writeAscii = (offset, text) => [...text].forEach((char, index) => wav[offset + index] = char.charCodeAt(0));
  writeAscii(0, 'RIFF');
  view.setUint32(4, wav.length - 8, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, pcm.length, true);
  wav.set(pcm, 44);

  class FakeAudioContext {
    constructor() { this.startedAt = Date.now(); this.destination = {}; }
    get currentTime() { return (Date.now() - this.startedAt) / 1000; }
    async resume() {}
    createBuffer(channels, length) {
      const data = Array.from({ length: channels }, () => new Float32Array(length));
      return { getChannelData(index) { return data[index]; } };
    }
    createBufferSource() {
      return { connect() {}, start() {} };
    }
    async close() {}
  }
  const events = [];
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(wav.slice(0, 47));
      controller.enqueue(wav.slice(47, 9000));
      controller.enqueue(wav.slice(9000));
      controller.close();
    },
  });
  const broker = createBroker({
    AudioContextCtor: FakeAudioContext,
    emit(message) { events.push(message); },
    api: {
      async ensureLocalVoices() {},
      async synthesizeStream() { return { stream, mimeType: 'audio/wav' }; },
    },
  });

  const result = await broker.handle({
    type: 'tts:synthesize', stream: true,
    clientId: 'tab-stream', playbackId: 'play-stream', requestId: 'stream-2',
    sourceTabId: 77, request: { input: '真实流式', voice: '旁白' }, profiles: [],
  });

  assert.equal(result.ok, true);
  assert.equal(result.streaming, true);
  assert.equal(result.progressivePlayback, true);
  assert.equal(result.audioBase64, undefined);
  assert.deepEqual(events.map((event) => event.event), ['started']);
  assert.equal(events[0].requestId, 'stream-2');
  assert.equal(events[0].sourceTabId, 77);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal(events[events.length - 1].event, 'ended');
  assert.ok(events.some((event) => event.event === 'progress'));
  assert.equal(broker.activeJobCount(), 0);
});

test('offscreen abort cancels a permanently pending stream read and promptly cleans audio resources', async () => {
  const sampleRate = 24000;
  const frames = 12000;
  const pcm = new Uint8Array(frames * 2);
  const wav = new Uint8Array(44 + pcm.length);
  const view = new DataView(wav.buffer);
  const writeAscii = (offset, text) => [...text].forEach((char, index) => {
    wav[offset + index] = char.charCodeAt(0);
  });
  writeAscii(0, 'RIFF');
  view.setUint32(4, wav.length - 8, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, pcm.length, true);
  wav.set(pcm, 44);

  const cleanup = { cancel: 0, release: 0, close: 0, stop: 0, disconnect: 0 };
  let reads = 0;
  const stream = {
    getReader() {
      return {
        read() {
          reads += 1;
          if (reads === 1) return Promise.resolve({ done: false, value: wav });
          return new Promise(() => {});
        },
        cancel() {
          cleanup.cancel += 1;
          return Promise.resolve();
        },
        releaseLock() { cleanup.release += 1; },
      };
    },
  };
  class FakeAudioContext {
    constructor() { this.destination = {}; this.currentTime = 0; }
    async resume() {}
    createBuffer(channels, length) {
      const data = Array.from({ length: channels }, () => new Float32Array(length));
      return { getChannelData(index) { return data[index]; } };
    }
    createBufferSource() {
      return {
        connect() {},
        start() {},
        stop() { cleanup.stop += 1; },
        disconnect() { cleanup.disconnect += 1; },
      };
    }
    async close() { cleanup.close += 1; }
  }
  const capabilities = {
    health: true, synthesize: true, stream: true, cancel: true, transportStreaming: true,
  };
  const provider = {
    id: 'pending-reader-provider',
    version: 2,
    capabilities,
    async health() { return { ok: true, capabilities }; },
    async synthesize() { throw new Error('whole-audio fallback must not run'); },
    async stream() { return { stream, mimeType: 'audio/wav' }; },
    async cancel() { return { cancelled: true }; },
  };
  const broker = createBroker({
    AudioContextCtor: FakeAudioContext,
    api: { async ensureLocalVoices() {} },
    providerApi: {
      effectiveCapabilities(_provider, health) { return health.capabilities; },
    },
    providerRegistry: { select() { return provider; } },
  });

  const started = await broker.handle({
    type: 'tts:synthesize', stream: true,
    clientId: 'pending-tab', playbackId: 'pending-play', requestId: 'pending-read',
    request: { input: '取消挂起流', voice: '旁白' }, profiles: [],
  });
  assert.equal(started.ok, true);
  assert.equal(started.progressivePlayback, true);
  assert.equal(reads, 2);

  const cancelStartedAt = Date.now();
  const cancelled = await broker.handle({
    type: 'tts:cancel', clientId: 'pending-tab', playbackId: 'pending-play', requestId: 'pending-read',
  });
  while (broker.activeJobCount() && Date.now() - cancelStartedAt < 500) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.equal(cancelled.count, 1);
  assert.equal(broker.activeJobCount(), 0);
  assert.ok(Date.now() - cancelStartedAt < 500);
  assert.deepEqual(cleanup, { cancel: 1, release: 1, close: 1, stop: 1, disconnect: 1 });
});
