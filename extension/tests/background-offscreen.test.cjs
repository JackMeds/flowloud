const test = require('node:test');
const assert = require('node:assert/strict');

const { chromeStorage, createMessageRouter, createOffscreenManager } = require('../background.js');

test('renaming a local voice registers the new name before one atomic storage update and old-name deletion', async () => {
  const forwarded = [];
  const setManyCalls = [];
  const timeline = [];
  const values = {
    voiceProfiles: [{
      name: '旧音色',
      wavB64: 'UklGRg==',
      mimeType: 'audio/wav',
      sampleRate: 24000,
      refText: '参考台词',
      sourceFileName: 'voice.wav',
      durationSeconds: 1,
      createdAt: '2026-08-04T00:00:00.000Z',
      updatedAt: '2026-08-04T00:00:00.000Z',
      transcription: { provider: 'edge-web-speech', status: 'success', attempts: 1 },
    }],
    qwenReaderSettings: {
      preset: 'op-exclusive',
      opVoice: '旧音色',
      replyVoices: ['邵思萌'],
    },
  };
  const router = createMessageRouter({
    api: {},
    offscreen: {
      async request(message) {
        forwarded.push(message);
        timeline.push(message.type);
        return { ok: true };
      },
    },
    storage: {
      async get(key) { return values[key]; },
      async set() { throw new Error('rename must persist with setMany'); },
      async setMany(nextValues) {
        setManyCalls.push(nextValues);
        timeline.push('storage:setMany');
        Object.assign(values, nextValues);
      },
    },
  });

  const result = await router({ type: 'voice:rename', oldName: '旧音色', newName: '新音色' });

  assert.equal(result.ok, true);
  assert.deepEqual(timeline, ['voice:save', 'storage:setMany', 'voice:delete']);
  assert.deepEqual(forwarded.map((item) => item.type), ['voice:save', 'voice:delete']);
  assert.equal(forwarded[0].profile.name, '新音色');
  assert.equal(forwarded[1].name, '旧音色');
  assert.equal(setManyCalls.length, 1);
  assert.equal(setManyCalls[0].voiceProfiles[0].name, '新音色');
  assert.equal(setManyCalls[0].qwenReaderSettings.opVoice, '新音色');
});

test('chrome storage setMany persists all keys in one local storage call', async () => {
  const calls = [];
  const storage = chromeStorage({
    storage: {
      local: {
        async set(values) { calls.push(values); },
      },
    },
  });
  const values = {
    voiceProfiles: [{ name: '新音色', wavB64: 'UklGRg==' }],
    qwenReaderSettings: { opVoice: '新音色', replyVoices: ['邵思萌'] },
  };

  await storage.setMany(values);

  assert.deepEqual(calls, [values]);
});

test('a storage failure while saving a new voice removes the newly registered backend voice', async () => {
  const forwarded = [];
  const values = { voiceProfiles: [] };
  const profile = { name: '新音色', wavB64: 'bmV3' };
  const router = createMessageRouter({
    api: {},
    offscreen: {
      async request(message) {
        forwarded.push(message);
        return { ok: true };
      },
    },
    storage: {
      async get(key) { return values[key]; },
      async set() { throw new Error('quota exceeded'); },
      async setMany() { throw new Error('unexpected setMany'); },
    },
  });

  const result = await router({ type: 'voice:save', profile });

  assert.equal(result.ok, false);
  assert.equal(result.error.message, 'quota exceeded');
  assert.deepEqual(forwarded.map((message) => [message.type, message.name, message.profile]), [
    ['voice:save', undefined, profile],
    ['voice:delete', '新音色', undefined],
  ]);
  assert.deepEqual(values.voiceProfiles, []);
});

test('a storage failure while overwriting a voice restores the previous backend profile', async () => {
  const forwarded = [];
  const oldProfile = { name: '已有音色', wavB64: 'b2xk', refText: '旧台词' };
  const newProfile = { name: '已有音色', wavB64: 'bmV3', refText: '新台词' };
  const values = { voiceProfiles: [oldProfile] };
  const router = createMessageRouter({
    api: {},
    offscreen: {
      async request(message) {
        forwarded.push(message);
        return { ok: true };
      },
    },
    storage: {
      async get(key) { return values[key]; },
      async set() { throw new Error('disk full'); },
      async setMany() { throw new Error('unexpected setMany'); },
    },
  });

  const result = await router({ type: 'voice:save', profile: newProfile });

  assert.equal(result.ok, false);
  assert.equal(result.error.message, 'disk full');
  assert.deepEqual(forwarded.map((message) => [message.type, message.profile]), [
    ['voice:save', newProfile],
    ['voice:save', oldProfile],
  ]);
  assert.deepEqual(values.voiceProfiles, [oldProfile]);
});

test('a failed new-name registration leaves storage and the old backend name untouched', async () => {
  const forwarded = [];
  let storageWrites = 0;
  const values = {
    voiceProfiles: [{ name: '旧音色', wavB64: 'UklGRg==' }],
    qwenReaderSettings: { opVoice: '旧音色', replyVoices: ['邵思萌'] },
  };
  const router = createMessageRouter({
    api: {},
    offscreen: {
      async request(message) {
        forwarded.push(message);
        return { ok: false, error: { code: 'http_500', message: 'register failed' } };
      },
    },
    storage: {
      async get(key) { return values[key]; },
      async set() { storageWrites += 1; },
      async setMany() { storageWrites += 1; },
    },
  });

  const result = await router({ type: 'voice:rename', oldName: '旧音色', newName: '新音色' });

  assert.equal(result.ok, false);
  assert.deepEqual(forwarded.map((item) => [item.type, item.name]), [['voice:save', undefined]]);
  assert.equal(storageWrites, 0);
  assert.equal(values.voiceProfiles[0].name, '旧音色');
});

test('an atomic storage failure rolls back the newly registered backend name', async () => {
  const forwarded = [];
  const values = {
    voiceProfiles: [{ name: '旧音色', wavB64: 'UklGRg==' }],
    qwenReaderSettings: { opVoice: '旧音色', replyVoices: ['邵思萌'] },
  };
  const router = createMessageRouter({
    api: {},
    offscreen: {
      async request(message) {
        forwarded.push(message);
        return { ok: true };
      },
    },
    storage: {
      async get(key) { return values[key]; },
      async set() {},
      async setMany() { throw new Error('disk full'); },
    },
  });

  const result = await router({ type: 'voice:rename', oldName: '旧音色', newName: '新音色' });

  assert.equal(result.ok, false);
  assert.equal(result.error.message, 'disk full');
  assert.deepEqual(forwarded.map((item) => [item.type, item.name]), [
    ['voice:save', undefined],
    ['voice:delete', '新音色'],
  ]);
  assert.equal(values.voiceProfiles[0].name, '旧音色');
  assert.equal(values.qwenReaderSettings.opVoice, '旧音色');
});

test('a failed old-name deletion succeeds with a warning and a deduplicated cleanup queue', async () => {
  const forwarded = [];
  const values = {
    voiceProfiles: [{ name: '旧音色', wavB64: 'UklGRg==' }],
    qwenReaderSettings: { opVoice: '旧音色', replyVoices: ['邵思萌'] },
    voiceCleanupQueue: ['旧音色', '新音色', '旧音色'],
  };
  const router = createMessageRouter({
    api: {},
    offscreen: {
      async request(message) {
        forwarded.push(message);
        if (message.type === 'voice:delete') {
          return { ok: false, error: { code: 'network_error', message: 'offline' } };
        }
        return { ok: true };
      },
    },
    storage: {
      async get(key) { return values[key]; },
      async set(key, value) { values[key] = value; },
      async setMany(nextValues) { Object.assign(values, nextValues); },
    },
  });

  const result = await router({ type: 'voice:rename', oldName: '旧音色', newName: '新音色' });

  assert.equal(result.ok, true);
  assert.equal(result.warning.code, 'old_voice_cleanup_pending');
  assert.deepEqual(values.voiceCleanupQueue, ['旧音色']);
  assert.equal(values.voiceProfiles[0].name, '新音色');
  assert.deepEqual(forwarded.map((item) => [item.type, item.name]), [
    ['voice:save', undefined],
    ['voice:delete', '旧音色'],
  ]);
});

test('voice:list retries queued deletions once each and retains only failures without blocking the list', async () => {
  const forwarded = [];
  const values = {
    voiceProfiles: [{ name: '当前音色', wavB64: 'UklGRg==' }],
    voiceCleanupQueue: ['已清理', '仍失败', '仍失败'],
  };
  const router = createMessageRouter({
    api: {},
    offscreen: {
      async request(message) {
        forwarded.push(message);
        if (message.type === 'voice:delete' && message.name === '已清理') return { ok: true };
        if (message.type === 'voice:delete') {
          return { ok: false, error: { code: 'network_error', message: 'still offline' } };
        }
        return { ok: true, voices: [{ name: '当前音色', kind: 'registered' }] };
      },
    },
    storage: {
      async get(key) { return values[key]; },
      async set(key, value) { values[key] = value; },
      async setMany(nextValues) { Object.assign(values, nextValues); },
    },
  });

  const result = await router({ type: 'voice:list' });

  assert.deepEqual(result, {
    ok: true,
    voices: [{
      name: '当前音色',
      kind: 'registered',
      local: true,
      editable: true,
      readOnly: false,
      source: 'browser',
      sourceFileName: '',
      durationSeconds: 0,
      refText: '',
    }],
  });
  assert.deepEqual(forwarded.map((item) => [item.type, item.name]), [
    ['voice:delete', '已清理'],
    ['voice:delete', '仍失败'],
    ['voice:list', undefined],
  ]);
  assert.deepEqual(values.voiceCleanupQueue, ['仍失败']);
});

test('voice:list exposes editable browser profiles without leaking stored audio', async () => {
  const values = {
    voiceProfiles: [{
      name: '浏览器音色',
      wavB64: 'UklGRg==',
      sourceFileName: 'sample.m4a',
      durationSeconds: 8.4,
      refText: '参考台词',
    }],
    voiceCleanupQueue: [],
  };
  const router = createMessageRouter({
    api: {},
    offscreen: {
      async request() {
        return {
          ok: true,
          voices: [
            { name: '浏览器音色', local: true },
            { name: '后端手工音色', local: false },
          ],
        };
      },
    },
    storage: {
      async get(key) { return values[key]; },
      async set(key, value) { values[key] = value; },
      async setMany(nextValues) { Object.assign(values, nextValues); },
    },
  });

  const result = await router({ type: 'voice:list' });

  assert.deepEqual(result.voices[0], {
    name: '浏览器音色',
    local: true,
    editable: true,
    readOnly: false,
    source: 'browser',
    sourceFileName: 'sample.m4a',
    durationSeconds: 8.4,
    refText: '参考台词',
  });
  assert.deepEqual(result.voices[1], {
    name: '后端手工音色',
    local: false,
    editable: false,
    readOnly: true,
    source: 'backend',
  });
  assert.equal('wavB64' in result.voices[0], false);
});

test('built-in and incomplete remote-only voices are rejected as read-only', async () => {
  const cases = [
    { oldName: '邵思萌', profiles: [] },
    { oldName: '云端音色', profiles: [{ name: '云端音色', kind: 'remote', remote: true }] },
  ];

  for (const input of cases) {
    let forwarded = 0;
    let storageWrites = 0;
    const router = createMessageRouter({
      api: {},
      offscreen: {
        async request() {
          forwarded += 1;
          return { ok: true };
        },
      },
      storage: {
        async get(key) {
          if (key === 'voiceProfiles') return input.profiles;
          if (key === 'qwenReaderSettings') return {};
          return [];
        },
        async set() { storageWrites += 1; },
        async setMany() { storageWrites += 1; },
      },
    });

    const result = await router({ type: 'voice:rename', oldName: input.oldName, newName: '新名字' });

    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'voice_read_only');
    assert.equal(forwarded, 0);
    assert.equal(storageWrites, 0);
  }
});

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

test('offscreen manager creates one BLOBS and AUDIO_PLAYBACK document for concurrent requests', async () => {
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
        assert.deepEqual(options.reasons, ['BLOBS', 'AUDIO_PLAYBACK']);
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
