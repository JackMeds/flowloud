const test = require('node:test');
const assert = require('node:assert/strict');
const documentApi = require('../shared/document-provider-v1.js');
const ttsApi = require('../shared/provider-v4.js');

function profile(protocol, overrides = {}) {
  return {
    id: `test-${protocol}`, label: protocol, protocol,
    baseUrl: protocol.includes('ollama') || protocol.includes('flowloud') ? 'http://127.0.0.1:7812' : 'https://api.example.test',
    model: protocol === 'flowloud-document-v1' ? '' : 'test-model',
    authHeader: protocol === 'ollama-chat' ? '' : 'Authorization', authScheme: 'Bearer', timeoutMs: 5000,
    capabilities: { visionOcr: true, textTranslation: true, structuredOutput: true, pdfInput: false, streaming: false },
    ...overrides,
  };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

test('OpenAI Chat OCR sends image input and returns stable document blocks', async () => {
  const calls = [];
  const provider = documentApi.createDocumentProvider(profile('openai-chat', { customHeaders: { 'X-Title': 'Flowloud', Authorization: 'unsafe-override' } }), {
    secret: 'session-secret',
    fetchImpl: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      return jsonResponse({ choices: [{ message: { content: '```json\n{"document":{"blocks":[{"id":"p1","text":"识别结果","page":1}]}}\n```' } }] });
    },
  });
  const result = await provider.extract({ requestId: 'ocr-chat', page: 1, dataUrl: 'data:image/png;base64,AA==' });
  assert.equal(calls[0].url, 'https://api.example.test/v1/chat/completions');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer session-secret');
  assert.equal(calls[0].init.headers['X-Title'], 'Flowloud');
  assert.equal(calls[0].body.messages[0].content[1].type, 'image_url');
  assert.deepEqual(result.document.blocks[0], { id: 'p1', kind: 'paragraph', text: '识别结果', page: 1 });
});

test('OpenAI Responses translation preserves source block IDs', async () => {
  const provider = documentApi.createDocumentProvider(profile('openai-responses'), {
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      assert.equal(body.input[0].content[0].type, 'input_text');
      return jsonResponse({ output_text: JSON.stringify({ translation: { sourceLanguage: 'en', targetLanguage: 'zh-CN', blocks: [{ id: 'intro', translatedText: '你好' }] } }) });
    },
  });
  const result = await provider.translate({ requestId: 'translate-responses', sourceLanguage: 'en', targetLanguage: 'zh-CN', blocks: [{ id: 'intro', text: 'Hello' }] });
  assert.deepEqual(result.translation.blocks[0], { id: 'intro', sourceText: 'Hello', translatedText: '你好', status: 'translated', warnings: [] });
});

test('OpenAI-compatible vendor versioned base URLs do not receive a duplicate v1 segment', async () => {
  const calls = [];
  const chat = documentApi.createDocumentProvider(profile('openai-chat', { baseUrl: 'https://open.bigmodel.cn/api/paas/v4' }), {
    fetchImpl: async (url) => {
      calls.push(url);
      return jsonResponse({ choices: [{ message: { content: JSON.stringify({ translation: { blocks: [{ id: 'a', translatedText: '甲' }] } }) } }] });
    },
  });
  const responses = documentApi.createDocumentProvider(profile('openai-responses', { baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' }), {
    fetchImpl: async (url) => {
      calls.push(url);
      return jsonResponse({ output_text: JSON.stringify({ translation: { blocks: [{ id: 'b', translatedText: '乙' }] } }) });
    },
  });
  await chat.translate({ blocks: [{ id: 'a', text: 'A' }], targetLanguage: 'zh-CN' });
  await responses.translate({ blocks: [{ id: 'b', text: 'B' }], targetLanguage: 'zh-CN' });
  assert.deepEqual(calls, [
    'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    'https://ark.cn-beijing.volces.com/api/v3/responses',
  ]);
});

test('Ollama chat sends raw base64 images to /api/chat', async () => {
  const provider = documentApi.createDocumentProvider(profile('ollama-chat', { baseUrl: 'http://127.0.0.1:11434' }), {
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      assert.equal(url, 'http://127.0.0.1:11434/api/chat');
      assert.deepEqual(body.messages[0].images, ['AQI=']);
      return jsonResponse({ message: { content: JSON.stringify({ document: { blocks: [{ id: 'scan-1', text: '本地视觉结果' }] } }) } });
    },
  });
  const result = await provider.extract({ requestId: 'ocr-ollama', dataUrl: 'data:image/png;base64,AQI=' });
  assert.equal(result.document.blocks[0].text, '本地视觉结果');
});

test('Flowloud local document protocol probes capabilities and uses dedicated endpoints', async () => {
  const paths = [];
  const provider = documentApi.createDocumentProvider(profile('flowloud-document-v1'), {
    fetchImpl: async (url) => {
      const path = new URL(url).pathname;
      paths.push(path);
      if (path === '/health') return jsonResponse({ ready: true });
      if (path === '/v1/capabilities') return jsonResponse({ capabilities: { visionOcr: true, textTranslation: true } });
      if (path === '/v1/documents/extract') return jsonResponse({ document: { blocks: [{ id: 'local-1', text: '本地 OCR' }] } });
      return jsonResponse({ translation: { blocks: [{ id: 'local-1', translatedText: 'Local OCR' }] } });
    },
  });
  assert.equal((await provider.probe({ requestId: 'probe-local' })).ready, true);
  await provider.extract({ requestId: 'extract-local', dataUrl: 'data:image/png;base64,AA==' });
  await provider.translate({ requestId: 'translate-local', blocks: [{ id: 'local-1', text: '本地 OCR' }], targetLanguage: 'en' });
  assert.deepEqual(paths, ['/health', '/v1/capabilities', '/v1/documents/extract', '/v1/translations']);
});

test('document cancellation aborts only the matching request with a normalized error', async () => {
  const provider = documentApi.createDocumentProvider(profile('openai-chat'), {
    fetchImpl: async (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })),
  });
  const pending = provider.extract({ requestId: 'cancel-this', dataUrl: 'data:image/png;base64,AA==' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await provider.cancel({ requestId: 'cancel-this' }), { providerId: 'test-openai-chat', requestId: 'cancel-this', cancelled: true, count: 1 });
  await assert.rejects(pending, (error) => error.code === 'cancelled' && error.requestId === 'cancel-this');
});

test('Doubao TTS uses its native endpoint, request envelope, and headers', async () => {
  const calls = [];
  const provider = ttsApi.createDoubaoTtsProvider({
    baseUrl: 'https://openspeech.bytedance.com', appId: 'app-id', resourceId: 'seed-tts-2.0', voice: 'zh_female_test', apiKey: 'doubao-secret',
    fetchImpl: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      return new Response(new Uint8Array([73, 68, 51]), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
    },
  });
  const result = await provider.synthesize({ requestId: 'doubao-1', input: '你好', rate: 1.1 }, {});
  assert.equal(calls[0].url, 'https://openspeech.bytedance.com/api/v3/tts/unidirectional');
  assert.equal(calls[0].init.headers['X-Api-Key'], 'doubao-secret');
  assert.equal(calls[0].body.request.text, '你好');
  assert.equal(calls[0].body.audio.voice_type, 'zh_female_test');
  assert.equal(result.mimeType, 'audio/mpeg');
});
