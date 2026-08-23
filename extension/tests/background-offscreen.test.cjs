const test = require('node:test');
const assert = require('node:assert/strict');

const {
  actionIconPaths,
  cancelPlaybackForTab,
  chromeStorage,
  createMessageRouter,
  createOffscreenManager,
  createPopupBroker,
  install,
} = require('../background.js');

test('toolbar playback state recolors the full logo for each state without overlay badges', () => {
  assert.deepEqual(actionIconPaths('playing'), {
    16: 'assets/flowloud-toolbar-playing-16.png',
    32: 'assets/flowloud-toolbar-playing-32.png',
  });
  assert.deepEqual(actionIconPaths('paused'), {
    16: 'assets/flowloud-toolbar-paused-16.png',
    32: 'assets/flowloud-toolbar-paused-32.png',
  });
  assert.deepEqual(actionIconPaths('unknown'), {
    16: 'assets/flowloud-toolbar-idle-16.png',
    32: 'assets/flowloud-toolbar-idle-32.png',
  });
  const backgroundSource = require('node:fs').readFileSync(require('node:path').resolve(__dirname, '..', 'background.js'), 'utf8');
  assert.match(backgroundSource, /setBadgeText\(\{ tabId: target\.tabId, text: '' \}\)/u);
  assert.doesNotMatch(backgroundSource, /status === 'playing' \? '▶'/u);
});

test('router injects only the active Provider model and format instead of legacy Qwen defaults', async () => {
  const previousSchema = globalThis.FlowloudSettings;
  globalThis.FlowloudSettings = require('../shared/settings-schema.js');
  const forwarded = [];
  const settings = globalThis.FlowloudSettings.migrate({
    activeProviderId: 'local-service',
    providerSettings: {
      'local-service': { adapterId: 'cosyvoice', baseUrl: 'http://127.0.0.1:50000', model: 'CosyVoice2-0.5B', responseFormat: 'wav' },
    },
  });
  try {
    const router = createMessageRouter({
      api: {},
      offscreen: { async request(message) { forwarded.push(message); return { ok: true }; } },
      storage: { async get(key) { return key === 'qwenReaderSettings' ? settings : undefined; }, async set() {} },
      session: { async get() { return {}; } },
    });
    const result = await router({
      type: 'tts:synthesize', providerId: 'local-service', prefetch: true,
      request: { input: '你好' },
    });
    assert.equal(result.ok, true);
    assert.equal(forwarded[0].providerId, 'local-service');
    assert.equal(forwarded[0].request.model, 'CosyVoice2-0.5B');
    assert.equal(forwarded[0].request.response_format, 'wav');
    assert.doesNotMatch(JSON.stringify(forwarded[0].request), /qwen3-tts/u);
  } finally {
    globalThis.FlowloudSettings = previousSchema;
  }
});

test('settings secret messages keep credentials out of public settings and distinguish session from remembered storage', async () => {
  const previousSchema = globalThis.FlowloudSettings;
  globalThis.FlowloudSettings = require('../shared/settings-schema.js');
  const localValues = {};
  const sessionValues = {};
  try {
    const router = createMessageRouter({
      api: {},
      storage: {
        async get(key) { return localValues[key]; },
        async set(key, value) { localValues[key] = value; },
      },
      session: {
        async get(key) { return sessionValues[key]; },
        async set(key, value) { sessionValues[key] = value; },
      },
    });
    const saved = await router({ type: 'settings:secret:set', providerId: 'openai-compatible', secret: 'sk-private-value', remember: false });
    assert.deepEqual(saved, { ok: true, providerId: 'openai-compatible', present: true, remembered: false });
    assert.equal(sessionValues.flowloudProviderSecrets['openai-compatible'], 'sk-private-value');
    assert.equal(localValues.flowloudRememberedProviderSecrets?.['openai-compatible'], undefined);
    const status = await router({ type: 'settings:secrets:status' });
    assert.deepEqual(status.secrets['openai-compatible'], { present: true, remembered: false });
    assert.doesNotMatch(JSON.stringify(status), /sk-private-value/u);
  } finally {
    globalThis.FlowloudSettings = previousSchema;
  }
});

test('settings reset preserves model cache registry but restores safe Provider defaults', async () => {
  const previousSchema = globalThis.FlowloudSettings;
  globalThis.FlowloudSettings = require('../shared/settings-schema.js');
  let stored = globalThis.FlowloudSettings.migrate({
    activeProviderId: 'openai-compatible', playbackRate: 2,
    modelCacheRegistry: { 'flowloud-model-pinned': { revision: 'a'.repeat(40) } },
  });
  try {
    const router = createMessageRouter({
      api: {},
      storage: {
        async get(key) { return key === 'qwenReaderSettings' ? stored : undefined; },
        async set(key, value) { if (key === 'qwenReaderSettings') stored = value; },
      },
    });
    const response = await router({ type: 'settings:reset' });
    assert.equal(response.ok, true);
    assert.equal(response.settings.activeProviderId, 'browser-system');
    assert.equal(response.settings.playbackRate, 1);
    assert.deepEqual(response.settings.modelCacheRegistry, { 'flowloud-model-pinned': { revision: 'a'.repeat(40) } });
  } finally {
    globalThis.FlowloudSettings = previousSchema;
  }
});

test('successful browser-model download persists verified cache metadata instead of trusting a loose downloaded flag', async () => {
  const previousSchema = globalThis.FlowloudSettings;
  globalThis.FlowloudSettings = require('../shared/settings-schema.js');
  let stored = globalThis.FlowloudSettings.migrate({});
  const cacheId = 'flowloud-model-BricksDisplay/vits-cmn@3265ca20151fb9c79fa00c8f3874cacb2c15b2ce';
  try {
    const router = createMessageRouter({
      api: {},
      offscreen: { async request() { return { ok: true, result: {
        ready: true, state: 'ready', cacheId, repoId: 'BricksDisplay/vits-cmn',
        revision: '3265ca20151fb9c79fa00c8f3874cacb2c15b2ce', verifiedAt: '2026-08-23T00:00:00.000Z',
        runtimeVersion: 'transformers-js-bundled', device: 'wasm', license: 'Apache-2.0', estimatedBytes: 356515840,
      } }; } },
      storage: {
        async get(key) { return key === 'qwenReaderSettings' ? stored : undefined; },
        async set(key, value) { if (key === 'qwenReaderSettings') stored = value; },
      },
    });
    const response = await router({ type: 'provider:model:download', requestId: 'model-download-1' });
    assert.equal(response.ok, true);
    assert.equal(stored.providerSettings['browser-model'].downloaded, true);
    assert.equal(stored.providerSettings['browser-model'].cacheMetadata.cacheId, cacheId);
    assert.equal(stored.modelCacheRegistry[cacheId].verifiedAt, '2026-08-23T00:00:00.000Z');
    assert.equal(stored.modelCacheRegistry[cacheId].estimatedBytes, 356515840);
  } finally {
    globalThis.FlowloudSettings = previousSchema;
  }
});

test('closing a source tab requests cancellation for every offscreen job owned by that tab', async () => {
  const calls = [];
  const result = await cancelPlaybackForTab({
    async cancel(message) {
      calls.push(message);
      return { ok: true, cancelled: true, count: 2 };
    },
  }, 42);

  assert.deepEqual(calls, [{ type: 'tts:cancel', sourceTabId: 42, reason: 'source-tab-closed' }]);
  assert.deepEqual(result, { ok: true, cancelled: true, count: 2 });
});

test('installed background wires tab removal to offscreen source-tab cancellation', async () => {
  let onRemoved = null;
  const sent = [];
  const chromeApi = {
    storage: {
      local: { async get() { return {}; }, async set() {} },
      session: { async get() { return {}; }, async set() {}, async remove() {} },
    },
    runtime: {
      getURL(path) { return `chrome-extension://reader/${path}`; },
      async getContexts() { return [{ contextType: 'OFFSCREEN_DOCUMENT', documentUrl: 'chrome-extension://reader/offscreen.html' }]; },
      async sendMessage(message) { sent.push(message); return { ok: true, cancelled: true, count: 1 }; },
      onMessage: { addListener() {} },
    },
    action: {},
    commands: { onCommand: { addListener() {} } },
    tabs: {
      onRemoved: { addListener(listener) { onRemoved = listener; } },
      async query() { return []; },
      async sendMessage() { return null; },
    },
  };

  install(chromeApi);
  assert.equal(typeof onRemoved, 'function');
  onRemoved(55);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sent, [{
    target: 'qwen-reader-offscreen',
    type: 'tts:cancel',
    sourceTabId: 55,
    reason: 'source-tab-closed',
  }]);
});

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

test('background forwards pause and resume controls with normalized playback identity', async () => {
  const forwarded = [];
  const router = createMessageRouter({
    api: {},
    offscreen: {
      async control(message) {
        forwarded.push(message);
        return message.type === 'tts:pause'
          ? { ok: true, paused: true, resumed: false, count: 1 }
          : { ok: true, paused: false, resumed: true, count: 1 };
      },
    },
    storage: {
      async get() { return []; },
      async set() {},
    },
  });

  const paused = await router({ type: 'tts:pause', clientId: 'tab', playbackId: 'play', requestId: 'req' });
  const resumed = await router({ type: 'tts:resume', clientId: 'tab', playbackId: 'play', requestId: 'req' });

  assert.equal(paused.paused, true);
  assert.equal(resumed.resumed, true);
  assert.deepEqual(forwarded.map((message) => ({
    type: message.type,
    clientId: message.clientId,
    playbackId: message.playbackId,
    requestId: message.requestId,
  })), [
    { type: 'tts:pause', clientId: 'tab', playbackId: 'play', requestId: 'req' },
    { type: 'tts:resume', clientId: 'tab', playbackId: 'play', requestId: 'req' },
  ]);
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

test('offscreen control bypasses a stale context snapshot and trusts the live recipient', async () => {
  const sent = [];
  const manager = createOffscreenManager({
    runtime: {
      getURL(path) { return `chrome-extension://reader/${path}`; },
      async getContexts() { return []; },
      async sendMessage(message) {
        sent.push(message);
        return { ok: true, paused: true, resumed: false, count: 1 };
      },
    },
  });

  const result = await manager.control({
    type: 'tts:pause', clientId: 'tab', playbackId: 'play', requestId: 'req',
  });

  assert.equal(result.paused, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].target, 'qwen-reader-offscreen');
});

test('an enabled reader tab is reinjected after a same-tab refresh and forgotten when closed', async () => {
  const sessionValues = {};
  const injected = [];
  const chromeApi = {
    storage: {
      session: {
        async get(key) { return { [key]: sessionValues[key] }; },
        async set(values) { Object.assign(sessionValues, values); },
        async remove(key) { delete sessionValues[key]; },
      },
    },
    tabs: {
      async get(tabId) { return { id: tabId, url: 'https://example.com/topic/1', title: 'Topic' }; },
    },
    scripting: {
      async insertCSS(payload) { injected.push(['css', payload.target.tabId]); },
      async executeScript(payload) { injected.push(['js', payload.target.tabId, payload.files.at(-1)]); },
    },
  };
  const broker = createPopupBroker(chromeApi, {});
  await broker.acceptSnapshot({
    type: 'reader:snapshot',
    snapshot: { pageKey: 'https://example.com/topic/1', status: 'ready', total: 2 },
  }, { tab: { id: 17, url: 'https://example.com/topic/1', title: 'Topic' } });

  await broker.forgetTab(17, false);
  assert.equal(await broker.ensureInjected(17), true);
  assert.deepEqual(injected, [
    ['css', 17],
    ['js', 17, 'content/reader.js'],
  ]);

  await broker.forgetTab(17, true);
  assert.equal(await broker.ensureInjected(17), false);
  assert.equal(injected.length, 2);
});

test('offscreen control reports a typed retryable failure instead of a false success', async () => {
  const manager = createOffscreenManager({
    runtime: {
      getURL(path) { return `chrome-extension://reader/${path}`; },
      async sendMessage() {
        const error = new Error('Receiving end does not exist.');
        error.code = 'offscreen_unavailable';
        throw error;
      },
    },
  });

  const result = await manager.control({
    type: 'tts:pause', clientId: 'tab', playbackId: 'play', requestId: 'req',
  });

  assert.equal(result.ok, false);
  assert.equal(result.count, 0);
  assert.equal(result.error.code, 'offscreen_unavailable');
  assert.equal(result.error.retryable, true);
  assert.match(result.error.message, /Receiving end/u);
  assert.equal(Object.hasOwn(result, 'paused'), false);
});

test('background reports an unavailable playback control channel as a typed failure', async () => {
  const router = createMessageRouter({
    api: {},
    storage: {
      async get() { return { activeProviderId: 'local-qwen' }; },
      async set() {},
    },
  });

  const result = await router({
    type: 'tts:pause', clientId: 'tab', playbackId: 'play', requestId: 'req',
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.error, {
    code: 'offscreen_unavailable',
    message: '后台音频运行环境不可用。',
    retryable: true,
  });
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

test('background relays offscreen stream lifecycle events to their source tab', async () => {
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
      async getContexts() { return []; },
    },
    offscreen: { async createDocument() {} },
    tabs: {
      async sendMessage(tabId, message) {
        sent.push({ tabId, message });
      },
      async create() {},
    },
  };

  install(chromeApi);
  const sender = { url: 'chrome-extension://reader/offscreen.html' };
  for (const event of ['started', 'progress', 'ended']) {
    listeners.message({
      target: 'qwen-reader-stream-event',
      event,
      sourceTabId: 77,
      requestId: `stream-${event}`,
    }, sender);
  }
  await Promise.resolve();

  assert.deepEqual(sent.map((entry) => [entry.tabId, entry.message.event]), [
    [77, 'started'],
    [77, 'progress'],
    [77, 'ended'],
  ]);
});

test('background drops stream events without a valid tab or from a non-offscreen sender', async () => {
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
      async getContexts() { return []; },
    },
    offscreen: { async createDocument() {} },
    tabs: {
      async sendMessage(tabId, message) {
        sent.push({ tabId, message });
      },
      async create() {},
    },
  };

  install(chromeApi);
  const offscreenSender = { documentUrl: 'chrome-extension://reader/offscreen.html' };
  const events = [
    { sourceTabId: undefined, sender: offscreenSender },
    { sourceTabId: -1, sender: offscreenSender },
    { sourceTabId: 4.5, sender: offscreenSender },
    { sourceTabId: 12, sender: { url: 'https://example.com/article' } },
  ];
  for (const item of events) {
    listeners.message({
      target: 'qwen-reader-stream-event',
      event: 'ended',
      sourceTabId: item.sourceTabId,
    }, item.sender);
  }
  await Promise.resolve();

  assert.deepEqual(sent, []);
});

test('background ignores a closed source tab while relaying stream events', async () => {
  const listeners = {};
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
      async getContexts() { return []; },
    },
    offscreen: { async createDocument() {} },
    tabs: {
      async sendMessage() {
        throw new Error('Could not establish connection. Receiving end does not exist.');
      },
      async create() {},
    },
  };

  install(chromeApi);
  assert.doesNotThrow(() => listeners.message({
    target: 'qwen-reader-stream-event',
    event: 'ended',
    sourceTabId: 77,
  }, { url: 'chrome-extension://reader/offscreen.html' }));
  await Promise.resolve();
});
