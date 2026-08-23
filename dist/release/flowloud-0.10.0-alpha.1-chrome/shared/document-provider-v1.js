(function documentProviderModule(root, factory) {
  const exported = factory(root.FlowloudProviderCore || (typeof require === 'function' ? require('./provider-core.js') : null));
  if (typeof module === 'object' && module.exports) module.exports = exported;
  root.FlowloudDocumentProviderV1 = exported;
}(typeof globalThis !== 'undefined' ? globalThis : this, function makeDocumentProviderV1(core) {
  'use strict';
  if (!core) throw new Error('Document Provider 需要 FlowloudProviderCore。');

  const DOCUMENT_PROVIDER_VERSION = 1;
  const METHODS = Object.freeze(['probe', 'extract', 'translate', 'cancel']);
  const PROTOCOLS = Object.freeze(['openai-chat', 'openai-responses', 'ollama-chat', 'flowloud-document-v1']);
  const CAPABILITIES = Object.freeze(['textTranslation', 'visionOcr', 'pdfInput', 'structuredOutput', 'streaming']);
  const PROVIDER_PRESETS = Object.freeze({
    openai: Object.freeze({ label: 'OpenAI', protocol: 'openai-responses', baseUrl: 'https://api.openai.com', authHeader: 'Authorization', authScheme: 'Bearer', capabilities: { textTranslation: true, visionOcr: true, structuredOutput: true } }),
    ark: Object.freeze({ label: '火山方舟 / 豆包', protocol: 'openai-responses', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', authHeader: 'Authorization', authScheme: 'Bearer', capabilities: { textTranslation: true, visionOcr: true, structuredOutput: true } }),
    dashscope: Object.freeze({ label: '阿里百炼 / 通义', protocol: 'openai-chat', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode', authHeader: 'Authorization', authScheme: 'Bearer', capabilities: { textTranslation: true, visionOcr: true, structuredOutput: true } }),
    zhipu: Object.freeze({ label: '智谱 BigModel', protocol: 'openai-chat', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', authHeader: 'Authorization', authScheme: 'Bearer', capabilities: { textTranslation: true, visionOcr: true, structuredOutput: true } }),
    deepseek: Object.freeze({ label: 'DeepSeek', protocol: 'openai-chat', baseUrl: 'https://api.deepseek.com', authHeader: 'Authorization', authScheme: 'Bearer', capabilities: { textTranslation: true, visionOcr: false, structuredOutput: true } }),
    openrouter: Object.freeze({ label: 'OpenRouter', protocol: 'openai-chat', baseUrl: 'https://openrouter.ai/api', authHeader: 'Authorization', authScheme: 'Bearer', capabilities: { textTranslation: true, visionOcr: true, structuredOutput: true } }),
    ollama: Object.freeze({ label: 'Ollama', protocol: 'ollama-chat', baseUrl: 'http://127.0.0.1:11434', authHeader: '', authScheme: '', capabilities: { textTranslation: true, visionOcr: true, structuredOutput: true } }),
    flowloud: Object.freeze({ label: 'Flowloud 本地文档服务', protocol: 'flowloud-document-v1', baseUrl: 'http://127.0.0.1:7812', authHeader: 'Authorization', authScheme: 'Bearer', capabilities: { textTranslation: true, visionOcr: true, pdfInput: false, structuredOutput: true } }),
  });
  const operations = new Map();

  function normalizeBaseUrl(value) {
    let url;
    try { url = new URL(core.text(value)); } catch (_) {
      throw new core.ProviderError('invalid_base_url', 'AI 服务 Base URL 无效。', { stage: 'configure', retryable: false });
    }
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) {
      throw new core.ProviderError('insecure_remote_url', '远程 AI 服务必须使用 HTTPS；仅本机回环地址允许 HTTP。', { stage: 'configure', retryable: false });
    }
    if (url.username || url.password || url.hash) throw new core.ProviderError('invalid_base_url', 'AI 服务地址不能包含凭据或片段。', { stage: 'configure', retryable: false });
    return url.toString().replace(/\/$/u, '');
  }

  function normalizeProfile(input) {
    const source = core.object(input);
    const id = core.text(source.id);
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/iu.test(id)) throw new core.ProviderError('invalid_profile_id', 'AI Profile ID 无效。', { stage: 'configure', retryable: false });
    const protocol = PROTOCOLS.includes(core.text(source.protocol)) ? core.text(source.protocol) : 'openai-chat';
    const capabilities = {};
    for (const name of CAPABILITIES) capabilities[name] = Boolean(core.object(source.capabilities)[name]);
    const customHeaders = {};
    for (const [name, rawValue] of Object.entries(core.object(source.customHeaders)).slice(0, 12)) {
      const headerName = core.text(name);
      if (!/^[A-Za-z0-9-]{1,80}$/u.test(headerName) || /authorization|cookie|api[-_]?key|token|secret/iu.test(headerName)) continue;
      customHeaders[headerName] = core.text(rawValue).slice(0, 256);
    }
    return Object.freeze({
      id, label: core.text(source.label) || id, protocol, baseUrl: normalizeBaseUrl(source.baseUrl),
      model: core.text(source.model), authHeader: core.text(source.authHeader) || (protocol === 'ollama-chat' ? '' : 'Authorization'),
      authScheme: source.authScheme == null ? (protocol === 'ollama-chat' ? '' : 'Bearer') : core.text(source.authScheme),
      timeoutMs: Math.min(10 * 60 * 1000, Math.max(5000, Number(source.timeoutMs) || 120000)),
      customHeaders: Object.freeze(customHeaders),
      capabilities: Object.freeze(capabilities),
    });
  }

  function makeBlock(value, index, defaults) {
    const source = typeof value === 'string' ? { text: value } : core.object(value);
    return {
      id: core.text(source.id) || `block-${index + 1}`,
      kind: core.text(source.kind) || core.text(defaults?.kind) || 'paragraph',
      text: core.text(source.text || source.sourceText || source.content),
      ...(Number.isFinite(Number(source.page ?? defaults?.page)) ? { page: Number(source.page ?? defaults?.page) } : {}),
      ...(source.bbox ? { bbox: source.bbox } : {}),
      ...(Number.isFinite(Number(source.confidence)) ? { confidence: Number(source.confidence) } : {}),
    };
  }

  function documentArtifact(value, request) {
    const source = core.object(value?.document || value?.artifact || value);
    const rawBlocks = Array.isArray(source.blocks) ? source.blocks : (source.text ? [source.text] : []);
    const blocks = rawBlocks.map((block, index) => makeBlock(block, index, { page: request?.page })).filter((block) => block.text);
    return { version: 1, id: core.text(source.id) || core.text(request?.documentId) || `document-${Date.now().toString(36)}`, title: core.text(source.title || request?.title), sourceType: core.text(source.sourceType || request?.kind) || 'text', blocks, warnings: Array.isArray(source.warnings) ? source.warnings.map(String) : [] };
  }

  function translationArtifact(value, request) {
    const source = core.object(value?.translation || value?.artifact || value);
    const raw = Array.isArray(source.blocks) ? source.blocks : [];
    const translations = new Map(raw.map((item, index) => {
      const block = core.object(item);
      return [core.text(block.id) || `block-${index + 1}`, core.text(block.translatedText || block.translation || block.text || block.content)];
    }));
    const blocks = (Array.isArray(request?.blocks) ? request.blocks : []).map((item, index) => {
      const block = makeBlock(item, index);
      return { id: block.id, sourceText: block.text, translatedText: translations.get(block.id) || '', status: translations.has(block.id) ? 'translated' : 'failed', warnings: [] };
    });
    return { version: 1, id: core.text(source.id) || `translation-${Date.now().toString(36)}`, sourceLanguage: core.text(source.sourceLanguage || request?.sourceLanguage) || 'auto', targetLanguage: core.text(source.targetLanguage || request?.targetLanguage) || 'zh-CN', blocks, warnings: Array.isArray(source.warnings) ? source.warnings.map(String) : [] };
  }

  function extractJsonCandidate(value) {
    const raw = core.text(value);
    if (!raw) return {};
    try { return JSON.parse(raw); } catch (_) {}
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/iu);
    if (fenced) { try { return JSON.parse(fenced[1]); } catch (_) {} }
    const start = raw.indexOf('{'); const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) { try { return JSON.parse(raw.slice(start, end + 1)); } catch (_) {} }
    return { text: raw };
  }

  function authHeaders(profile, secret, extra) {
    const headers = Object.assign({ 'content-type': 'application/json' }, profile.customHeaders || {}, extra || {});
    if (secret && profile.authHeader) headers[profile.authHeader] = `${profile.authScheme ? `${profile.authScheme} ` : ''}${secret}`;
    return headers;
  }

  function endpoint(profile, path) {
    const base = profile.baseUrl.replace(/\/$/u, '');
    const openAiCompatible = profile.protocol === 'openai-chat' || profile.protocol === 'openai-responses';
    // Several compatible vendors include their API version in the configured base URL
    // (for example /v4 or /api/v3). Do not append a second /v1 segment.
    if (openAiCompatible && /\/(?:v\d+|api\/v\d+)$/u.test(base) && path.startsWith('/v1/')) return `${base}${path.slice(3)}`;
    return `${base}${path}`;
  }

  function ocrPrompt(request) {
    return `请忠实识别图像中的全部可读文字。保留标题和段落顺序，不要总结。只返回 JSON：{"document":{"title":"","sourceType":"image","blocks":[{"id":"page-${Number(request.page) || 1}-block-1","kind":"paragraph","text":"...","page":${Number(request.page) || 1}}],"warnings":[]}}`;
  }
  function translationPrompt(request) {
    const blocks = (Array.isArray(request.blocks) ? request.blocks : []).map((item, index) => makeBlock(item, index));
    return `把以下文本从 ${core.text(request.sourceLanguage) || '自动识别的语言'} 忠实翻译为 ${core.text(request.targetLanguage) || 'zh-CN'}。保持块 ID 和语义，不要总结或添加说明。只返回 JSON：{"translation":{"sourceLanguage":"auto","targetLanguage":"${core.text(request.targetLanguage) || 'zh-CN'}","blocks":[{"id":"原块ID","translatedText":"译文"}],"warnings":[]}}\n\n输入：${JSON.stringify(blocks.map(({ id, text }) => ({ id, text })))}`;
  }

  async function openAiChat(fetchImpl, profile, secret, prompt, imageDataUrl, signal, requestId) {
    const content = imageDataUrl ? [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: imageDataUrl } }] : prompt;
    const body = { model: profile.model, messages: [{ role: 'user', content }], temperature: 0 };
    if (profile.capabilities.structuredOutput) body.response_format = { type: 'json_object' };
    const response = await core.checkedFetch(fetchImpl, endpoint(profile, '/v1/chat/completions'), { method: 'POST', signal, headers: authHeaders(profile, secret), body: JSON.stringify(body) }, { providerId: profile.id, requestId, stage: 'request' });
    const json = await core.parseJson(response, { providerId: profile.id, requestId });
    return extractJsonCandidate(json?.choices?.[0]?.message?.content);
  }

  async function openAiResponses(fetchImpl, profile, secret, prompt, imageDataUrl, signal, requestId) {
    const content = [{ type: 'input_text', text: prompt }];
    if (imageDataUrl) content.push({ type: 'input_image', image_url: imageDataUrl });
    const body = { model: profile.model, input: [{ role: 'user', content }] };
    const response = await core.checkedFetch(fetchImpl, endpoint(profile, '/v1/responses'), { method: 'POST', signal, headers: authHeaders(profile, secret), body: JSON.stringify(body) }, { providerId: profile.id, requestId, stage: 'request' });
    const json = await core.parseJson(response, { providerId: profile.id, requestId });
    const outputText = core.text(json?.output_text) || (Array.isArray(json?.output) ? json.output.flatMap((item) => Array.isArray(item?.content) ? item.content : []).map((item) => item?.text).filter(Boolean).join('\n') : '');
    return extractJsonCandidate(outputText);
  }

  async function ollamaChat(fetchImpl, profile, secret, prompt, imageDataUrl, signal, requestId) {
    const images = imageDataUrl ? [String(imageDataUrl).replace(/^data:[^,]+,/u, '')] : undefined;
    const body = { model: profile.model, stream: false, format: 'json', messages: [{ role: 'user', content: prompt, ...(images ? { images } : {}) }] };
    const response = await core.checkedFetch(fetchImpl, endpoint(profile, '/api/chat'), { method: 'POST', signal, headers: authHeaders(profile, secret), body: JSON.stringify(body) }, { providerId: profile.id, requestId, stage: 'request' });
    const json = await core.parseJson(response, { providerId: profile.id, requestId });
    return extractJsonCandidate(json?.message?.content || json?.response);
  }

  function createDocumentProvider(inputProfile, options) {
    const profile = normalizeProfile(inputProfile);
    const config = core.object(options);
    const fetchImpl = config.fetchImpl || globalThis.fetch;
    const secret = core.text(config.secret);
    function start(request, operation) {
      const requestId = core.requestIdOf(request, operation) || `doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      const controller = core.createLinkedController(operation?.signal);
      operations.set(requestId, controller);
      const timer = setTimeout(() => controller.abort(new Error('timeout')), profile.timeoutMs);
      return { requestId, controller, done() { clearTimeout(timer); operations.delete(requestId); } };
    }
    async function invoke(prompt, imageDataUrl, record) {
      if (!profile.model && profile.protocol !== 'flowloud-document-v1') throw new core.ProviderError('model_required', '所选 AI Profile 尚未填写模型。', { providerId: profile.id, requestId: record.requestId, retryable: false });
      if (profile.protocol === 'openai-chat') return openAiChat(fetchImpl, profile, secret, prompt, imageDataUrl, record.controller.signal, record.requestId);
      if (profile.protocol === 'openai-responses') return openAiResponses(fetchImpl, profile, secret, prompt, imageDataUrl, record.controller.signal, record.requestId);
      if (profile.protocol === 'ollama-chat') return ollamaChat(fetchImpl, profile, secret, prompt, imageDataUrl, record.controller.signal, record.requestId);
      return {};
    }
    async function flowloudJson(path, body, record) {
      const response = await core.checkedFetch(fetchImpl, endpoint(profile, path), { method: 'POST', signal: record.controller.signal, headers: authHeaders(profile, secret), body: JSON.stringify(body) }, { providerId: profile.id, requestId: record.requestId, stage: 'request' });
      return core.parseJson(response, { providerId: profile.id, requestId: record.requestId });
    }
    async function probe(operation) {
      const record = start({}, operation);
      try {
        if (profile.protocol === 'flowloud-document-v1') {
          const health = await core.checkedFetch(fetchImpl, endpoint(profile, '/health'), { signal: record.controller.signal, headers: authHeaders(profile, secret, { accept: 'application/json' }) }, { providerId: profile.id, requestId: record.requestId, stage: 'health' });
          const healthPayload = await core.parseJson(health, { providerId: profile.id, requestId: record.requestId });
          let capabilities = profile.capabilities;
          try {
            const response = await core.checkedFetch(fetchImpl, endpoint(profile, '/v1/capabilities'), { signal: record.controller.signal, headers: authHeaders(profile, secret, { accept: 'application/json' }) }, { providerId: profile.id, requestId: record.requestId, stage: 'capabilities' });
            const payload = await core.parseJson(response, { providerId: profile.id, requestId: record.requestId });
            capabilities = Object.assign({}, capabilities, core.object(payload.capabilities || payload));
          } catch (error) { if (error?.status !== 404) throw error; }
          return { providerId: profile.id, requestId: record.requestId, ready: healthPayload.ready !== false, capabilities };
        }
        return { providerId: profile.id, requestId: record.requestId, ready: true, capabilities: profile.capabilities, note: '开放协议配置已通过本地校验；真实能力在首次请求时确认。' };
      } finally { record.done(); }
    }
    async function extract(request, operation) {
      if (!profile.capabilities.visionOcr) throw new core.ProviderError('capability_mismatch', '所选 Profile 未声明视觉 OCR 能力。', { providerId: profile.id, retryable: false });
      const record = start(request, operation);
      try {
        const payload = profile.protocol === 'flowloud-document-v1'
          ? await flowloudJson('/v1/documents/extract', request, record)
          : await invoke(ocrPrompt(request), core.text(request?.dataUrl), record);
        return { providerId: profile.id, requestId: record.requestId, document: documentArtifact(payload, request) };
      } catch (error) { throw core.structuredError(error, { providerId: profile.id, requestId: record.requestId, stage: 'extract' }); }
      finally { record.done(); }
    }
    async function translate(request, operation) {
      if (!profile.capabilities.textTranslation) throw new core.ProviderError('capability_mismatch', '所选 Profile 未声明文本翻译能力。', { providerId: profile.id, retryable: false });
      const record = start(request, operation);
      try {
        const payload = profile.protocol === 'flowloud-document-v1'
          ? await flowloudJson('/v1/translations', request, record)
          : await invoke(translationPrompt(request), '', record);
        return { providerId: profile.id, requestId: record.requestId, translation: translationArtifact(payload, request) };
      } catch (error) { throw core.structuredError(error, { providerId: profile.id, requestId: record.requestId, stage: 'translate' }); }
      finally { record.done(); }
    }
    async function cancel(identity) {
      const id = core.text(core.object(identity).requestId || identity);
      const controller = operations.get(id);
      if (controller) controller.abort();
      return { providerId: profile.id, requestId: id, cancelled: Boolean(controller), count: controller ? 1 : 0 };
    }
    return Object.freeze({
      id: profile.id, version: DOCUMENT_PROVIDER_VERSION,
      manifest: Object.freeze({ id: profile.id, version: DOCUMENT_PROVIDER_VERSION, domain: 'document-language', protocol: profile.protocol, capabilities: profile.capabilities, auth: { header: profile.authHeader, scheme: profile.authScheme }, inputTypes: ['text', 'image'], outputTypes: ['document-artifact', 'translation-artifact'], streaming: profile.capabilities.streaming }),
      capabilities: profile.capabilities, probe, extract, translate, cancel,
    });
  }

  function createDocumentRegistry(options) {
    return core.createRegistry(Object.assign({ methods: METHODS }, core.object(options)));
  }

  return Object.freeze({
    DOCUMENT_PROVIDER_VERSION, METHODS, PROTOCOLS, CAPABILITIES, PROVIDER_PRESETS,
    normalizeProfile, documentArtifact, translationArtifact, createDocumentProvider, createDocumentRegistry,
  });
}));
