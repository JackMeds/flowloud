const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PAGE_EDITOR_CONTEXTS_KEY,
  createPageEditorBroker,
  createPopupBroker,
} = require('../background.js');

function memorySession() {
  const values = new Map();
  return {
    async get(key) { return values.get(key); },
    async set(key, value) { values.set(key, value); },
    async remove(key) { values.delete(key); },
  };
}

test('popup broker fixes the active tab for a popup session', async () => {
  let activeTab = { id: 7, windowId: 1, title: '文章' };
  const sent = [];
  const chromeApi = {
    tabs: {
      async query() { return [activeTab]; },
      async sendMessage(tabId, message) {
        sent.push({ tabId, message });
        if (message.type === 'reader:snapshot:get') {
          return { ok: true, snapshot: { status: 'paused', title: '文章', total: 4, index: 1 } };
        }
        return { ok: true, snapshot: { status: 'playing', title: '文章', total: 4, index: 1 } };
      },
    },
  };
  const broker = createPopupBroker(chromeApi, { session: memorySession() });

  const initialized = await broker.handle({ type: 'popup:init' });
  assert.equal(initialized.target.tabId, 7);
  assert.equal(initialized.snapshot.status, 'paused');

  activeTab = { id: 8, windowId: 1, title: '另一篇文章' };
  const command = await broker.handle({ type: 'popup:command', command: 'play-toggle', value: '1.2' });
  assert.equal(command.target.tabId, 7);
  assert.equal(command.command, 'play-toggle');
  assert.equal(sent.at(-1).tabId, 7);
  assert.equal(sent.at(-1).message.type, 'reader:command');
  assert.equal(sent.at(-1).message.value, '1.2');
});

test('each newly opened native popup starts from the currently active tab', async () => {
  let activeTab = { id: 7, windowId: 1, title: '第一篇文章' };
  const chromeApi = {
    tabs: {
      async query() { return [activeTab]; },
      async sendMessage(tabId, message) {
        assert.equal(message.type, 'reader:snapshot:get');
        return { ok: true, snapshot: { pageKey: `page:${tabId}`, title: activeTab.title, total: 1 } };
      },
    },
  };
  const broker = createPopupBroker(chromeApi, { session: memorySession() });

  const first = await broker.handle({ type: 'reader:active-context' });
  assert.equal(first.tabId, 7);
  assert.equal(first.pageKey, 'page:7');

  activeTab = { id: 8, windowId: 1, title: '第二篇文章' };
  const second = await broker.handle({ type: 'reader:active-context' });
  assert.equal(second.tabId, 8);
  assert.equal(second.pageKey, 'page:8');
});

test('page editor broker maps context to source tab and cleans it when editor closes', async () => {
  const session = memorySession();
  const sent = [];
  const chromeApi = {
    runtime: { getURL(path) { return `chrome-extension://reader/${path}`; } },
    tabs: {
      async create(details) {
        const url = new URL(details.url);
        assert.equal(url.protocol, 'chrome-extension:');
        assert.equal(url.hostname, 'reader');
        assert.equal(url.pathname, '/page-voices.html');
        assert.deepEqual(Array.from(url.searchParams.keys()), ['contextId']);
        assert.equal(url.searchParams.get('contextId'), 'ctx-1');
        return { id: 99, windowId: 2 };
      },
      async sendMessage(tabId, message) {
        sent.push({ tabId, message });
        return { ok: true };
      },
    },
  };
  const broker = createPageEditorBroker(chromeApi, { session });

  const opened = await broker.open(
    { contextId: 'ctx-1', pageKey: 'https://example.test/topic', sourceTabId: 12 },
    {},
    { tabId: 12, pageKey: 'https://example.test/topic' },
  );
  assert.equal(opened.ok, true);
  assert.equal(opened.context.tabId, 12);
  assert.equal(opened.context.editorTabId, 99);

  const command = await broker.command({ contextId: 'ctx-1', command: 'next' }, { tab: { id: 99 } });
  assert.equal(command.ok, true);
  assert.equal(sent[0].tabId, 12);
  assert.equal(sent[0].message.type, 'ui:command');
  assert.equal(sent[0].message.contextId, 'ctx-1');

  await broker.forgetTab(99);
  const context = await broker.getContext({ contextId: 'ctx-1' });
  assert.equal(context.context, null);
  const saved = await session.get(PAGE_EDITOR_CONTEXTS_KEY);
  assert.deepEqual(saved, {});
});

test('installed background bridges the popup reader contract and page assignments', async () => {
  const { install } = require('../background.js');
  const listeners = {};
  const sent = [];
  const chromeApi = {
    storage: {
      local: {
        async get() { return {}; },
        async set() {},
      },
      session: memorySession(),
    },
    runtime: {
      getURL(path) { return `chrome-extension://reader/${path}`; },
      onMessage: { addListener(listener) { listeners.message = listener; } },
    },
    action: {},
    commands: { onCommand: { addListener() {} } },
    tabs: {
      async query() { return [{ id: 7, title: '正文' }]; },
      async get(id) { return { id, title: '正文' }; },
      async create(details) { return { id: 99, url: details.url }; },
      async sendMessage(tabId, message) {
        sent.push({ tabId, message });
        if (message.type === 'reader:snapshot:get') {
          return {
            ok: true,
            snapshot: {
              pageKey: 'https://example.test/topic',
              status: 'ready',
              index: 0,
              segmentCount: 2,
              current: { authorName: '楼主', text: '第一段' },
              authorSummary: [{ key: 'op', name: '楼主', voice: '旁白' }],
            },
          };
        }
        if (
          message.type === 'reader:page-context:apply' &&
          message.context &&
          message.context.authorVoices.bad
        ) {
          return {
            ok: false,
            error: { code: 'invalid_voice', message: '音色不可用' },
            pageContext: { pageKey: 'https://example.test/topic' },
          };
        }
        if (message.type === 'reader:page-context:get' || message.type === 'reader:page-context:apply') {
          return { ok: true, pageContext: { pageKey: 'https://example.test/topic', authorSummary: [] } };
        }
        if (message.command === 'fail') {
          return {
            ok: false,
            error: { code: 'reader_blocked', message: '无法播放' },
            snapshot: { status: 'error', segmentCount: 2, index: 0 },
          };
        }
        return { ok: true, snapshot: { status: 'playing', segmentCount: 2, index: 0 } };
      },
      onRemoved: { addListener() {} },
    },
  };
  install(chromeApi);

  const call = (message, sender = {}) => new Promise((resolve) => {
    const keepChannel = listeners.message(message, sender, resolve);
    assert.equal(keepChannel, true);
  });
  const context = await call({ type: 'reader:active-context' });
  assert.equal(context.tabId, 7);
  assert.equal(context.snapshot.total, 2);
  const command = await call({
    type: 'reader:command',
    tabId: 7,
    pageKey: 'https://example.test/topic',
    command: 'set-speed',
    value: '1.2',
  });
  assert.equal(command.ok, true);
  assert.equal(command.snapshot.status, 'playing');
  assert.equal(sent.at(-1).message.pageKey, 'https://example.test/topic');
  assert.equal(sent.at(-1).message.value, '1.2');

  const commandError = await call({ type: 'reader:command', tabId: 7, command: 'fail' });
  assert.equal(commandError.ok, false);
  assert.equal(commandError.error.code, 'reader_blocked');
  assert.equal(commandError.snapshot.status, 'error');

  const popupPageContext = await call({
    type: 'reader:page-voices:get',
    tabId: 7,
    pageKey: 'https://example.test/topic',
  });
  assert.equal(popupPageContext.ok, true);
  assert.equal(sent.at(-1).message.type, 'reader:page-context:get');
  assert.equal(sent.at(-1).message.pageKey, 'https://example.test/topic');

  const popupApply = await call({
    type: 'reader:page-voices:apply',
    tabId: 7,
    pageKey: 'https://example.test/topic',
    assignments: [
      { authorId: 'op', voice: '旁白' },
      { authorId: 'follow', voice: '' },
    ],
  });
  assert.equal(popupApply.ok, true);
  assert.equal(sent.at(-1).message.type, 'reader:page-context:apply');
  assert.deepEqual(sent.at(-1).message.context.authorVoices, { op: '旁白' });

  const editor = await call({ type: 'reader:page-editor:open' });
  const contextId = editor.context.contextId;
  const beforeRejected = sent.length;
  const rejected = await call({ type: 'reader:page-context:get', tabId: 7 });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, 'context_id_missing');
  assert.equal(sent.length, beforeRejected);

  const loadedContext = await call({ type: 'reader:page-context:get', contextId });
  assert.equal(loadedContext.ok, true);
  assert.equal(loadedContext.pageContext.pageKey, 'https://example.test/topic');

  const pageContext = await call({
    type: 'reader:page-context:apply',
    contextId,
    assignments: [
      { authorId: 'op', voice: '旁白' },
      { authorId: 'follow', voice: '' },
    ],
  });
  assert.equal(pageContext.ok, true);
  assert.deepEqual(sent.at(-1).message.context.authorVoices, { op: '旁白' });
  assert.equal(sent.at(-1).message.pageKey, 'https://example.test/topic');
  assert.equal(Object.hasOwn(sent.at(-1).message, 'tabId'), false);

  const contextError = await call({
    type: 'reader:page-context:apply',
    contextId,
    assignments: [{ authorId: 'bad', voice: '不可用' }],
  });
  assert.deepEqual(contextError, {
    ok: false,
    error: { code: 'invalid_voice', message: '音色不可用' },
    pageContext: { pageKey: 'https://example.test/topic' },
  });
});
