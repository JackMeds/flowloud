const test = require('node:test');
const assert = require('node:assert/strict');

const { createMessageRouter, createOffscreenManager } = require('../background.js');

test('background routes synthesis and local profiles to offscreen without fetching TTS itself', async () => {
  const forwarded = [];
  const router = createMessageRouter({
    api: {
      async synthesize() { throw new Error('service worker must not synthesize'); },
    },
    offscreen: {
      async request(message) {
        forwarded.push(message);
        return { ok: true, audioBase64: 'UklGRg==', mimeType: 'audio/wav' };
      },
      async cancel() { return { ok: true, cancelled: false }; },
    },
    storage: {
      async get(key) {
        assert.equal(key, 'voiceProfiles');
        return [{ name: '邵思萌', wavB64: 'd2F2' }];
      },
      async set() {},
    },
  });

  const result = await router({
    type: 'tts:synthesize', sessionId: 'legacy-session',
    request: { input: '正文', voice: '邵思萌' },
  });

  assert.equal(result.ok, true);
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].type, 'tts:synthesize');
  assert.equal(forwarded[0].sessionId, 'legacy-session');
  assert.equal(forwarded[0].profiles[0].name, '邵思萌');
  assert.match(forwarded[0].requestId, /^legacy-session:/);
});

test('offscreen manager creates one BLOBS document for concurrent requests', async () => {
  let contexts = [];
  let createCount = 0;
  const sent = [];
  const chromeApi = {
    runtime: {
      getURL(path) { return `chrome-extension://reader/${path}`; },
      async getContexts() { return contexts; },
      async sendMessage(message) {
        sent.push(message);
        return { ok: true, requestId: message.requestId };
      },
    },
    offscreen: {
      async createDocument(options) {
        createCount += 1;
        await Promise.resolve();
        contexts = [{ contextType: 'OFFSCREEN_DOCUMENT', documentUrl: 'chrome-extension://reader/offscreen.html' }];
        assert.deepEqual(options.reasons, ['BLOBS']);
      },
    },
  };
  const manager = createOffscreenManager(chromeApi);

  const [first, second] = await Promise.all([
    manager.request({ type: 'tts:synthesize', requestId: 'one' }),
    manager.request({ type: 'tts:synthesize', requestId: 'two' }),
  ]);

  assert.equal(createCount, 1);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].target, 'qwen-reader-offscreen');
  assert.deepEqual([first.requestId, second.requestId], ['one', 'two']);
});

test('background cancellation is a fast no-op when no offscreen document exists', async () => {
  let created = 0;
  const chromeApi = {
    runtime: {
      getURL(path) { return `chrome-extension://reader/${path}`; },
      async getContexts() { return []; },
      async sendMessage() { throw new Error('must not send without a document'); },
    },
    offscreen: { async createDocument() { created += 1; } },
  };
  const manager = createOffscreenManager(chromeApi);

  const result = await manager.cancel({ type: 'tts:cancel', sessionId: 'missing' });

  assert.deepEqual(result, { ok: true, cancelled: false, count: 0 });
  assert.equal(created, 0);
});
