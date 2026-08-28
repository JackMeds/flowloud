(function providerV4Module(root, factory) {
  const exported = factory(
    root.FlowloudProviderCore || (typeof require === 'function' ? require('./provider-core.js') : null),
    root.FlowloudProviderV3 || (typeof require === 'function' ? require('./provider-v3.js') : null),
    root.QwenReaderProviderV2 || (typeof require === 'function' ? require('./provider-v2.js') : null),
    root.QwenReaderApiClient || (typeof require === 'function' ? require('./api-client.js') : null),
  );
  if (typeof module === 'object' && module.exports) module.exports = exported;
  root.FlowloudProviderV4 = exported;
}(typeof globalThis !== 'undefined' ? globalThis : this, function makeProviderV4(core, v3, legacy, apiModule) {
  'use strict';

  const PROVIDER_VERSION = 4;
  const METHODS = Object.freeze([
    'health', 'voices', 'synthesize', 'stream', 'play', 'pause', 'resume',
    'cancel', 'status', 'cloneVoice', 'modelManagement',
  ]);
  const LOCAL_ADAPTER_IDS = Object.freeze([
    'flowloud-qwen', 'gpt-sovits', 'cosyvoice', 'openai-local',
  ]);
  const RETRYABLE_CODES = new Set([
    'network_error', 'timeout', 'service_unavailable', 'offscreen_unavailable',
    'http_408', 'http_425', 'http_429', 'http_500', 'http_502', 'http_503', 'http_504',
  ]);

  const LOCAL_ADAPTERS = Object.freeze({
    'flowloud-qwen': Object.freeze({
      label: 'Flowloud Qwen', protocolVersion: 1, speechPath: '/v1/audio/speech',
      streamPath: '/v1/audio/speech/stream', voicesPath: '/v1/audio/voices',
      cancelPath: '/v1/audio/speech/cancel', statusPath: '/v1/audio/speech/status',
      cloneVoice: true, transportStreaming: true, incrementalGeneration: false,
    }),
    'gpt-sovits': Object.freeze({
      label: 'GPT-SoVITS', protocolVersion: 1, speechPath: '/tts', streamPath: '/tts',
      voicesPath: '/v1/audio/voices', cancelPath: '', statusPath: '/health',
      cloneVoice: false, transportStreaming: true, incrementalGeneration: true,
    }),
    cosyvoice: Object.freeze({
      label: 'CosyVoice', protocolVersion: 1, speechPath: '/inference_sft',
      streamPath: '/inference_sft', voicesPath: '/v1/audio/voices', cancelPath: '',
      statusPath: '/health', cloneVoice: false, transportStreaming: true,
      incrementalGeneration: true,
    }),
    'openai-local': Object.freeze({
      label: 'OpenAI 本地兼容', protocolVersion: 1, speechPath: '/v1/audio/speech',
      streamPath: '/v1/audio/speech/stream', voicesPath: '/v1/audio/voices',
      cancelPath: '/v1/audio/speech/cancel', statusPath: '/health',
      cloneVoice: false, transportStreaming: true, incrementalGeneration: false,
    }),
  });

  class LegacyProviderError extends Error {
    constructor(code, message, details) {
      super(message || code || 'Provider 请求失败。');
      this.name = 'ProviderError';
      this.code = String(code || 'provider_error');
      const context = details && typeof details === 'object' ? details : {};
      this.stage = String(context.stage || context.operation || 'provider');
      this.providerId = String(context.providerId || '');
      this.requestId = String(context.requestId || '');
      this.retryable = context.retryable == null
        ? RETRYABLE_CODES.has(this.code) : Boolean(context.retryable);
      if (context.status != null) this.status = Number(context.status) || 0;
      if (context.cause) this.cause = context.cause;
    }

    toJSON() {
      return {
        stage: this.stage,
        code: this.code,
        message: this.message,
        retryable: this.retryable,
        providerId: this.providerId,
        requestId: this.requestId,
        ...(this.status ? { status: this.status } : {}),
      };
    }
  }

  const ProviderError = core?.ProviderError || LegacyProviderError;

  function object(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
  function text(value) { return String(value == null ? '' : value).trim(); }
  function rawVoice(providerId, value) {
    const id = text(value);
    return id.startsWith(`${providerId}:`) ? id.slice(providerId.length + 1) : id;
  }
  function voiceId(providerId, value) {
    const id = rawVoice(providerId, value);
    return id ? `${providerId}:${id}` : '';
  }
  function requestIdOf(request, operation) {
    return text(object(request).requestId || object(request).request_id || object(operation).requestId);
  }
  function success(providerId, request, operation, data) {
    return Object.assign({ providerId, requestId: requestIdOf(request, operation) }, object(data));
  }
  function structuredError(error, context) {
    if (core?.structuredError) return core.structuredError(error, context);
    if (error instanceof ProviderError) return error;
    const source = object(error);
    const code = source.name === 'AbortError' ? 'cancelled' : text(source.code) || 'provider_error';
    return new ProviderError(code, text(source.message) || 'Provider 请求失败。', Object.assign({}, context, {
      retryable: source.name === 'AbortError' ? false : source.retryable,
      status: source.status,
      cause: error,
    }));
  }

  function normalizeCapabilities(provider) {
    const declared = object(provider.capabilities);
    const caps = {};
    for (const name of METHODS) {
      if (name === 'modelManagement') {
        caps[name] = declared[name] == null
          ? Object.values(object(provider[name])).some((item) => typeof item === 'function')
          : Boolean(declared[name]);
      } else {
        caps[name] = declared[name] == null ? typeof provider[name] === 'function' : Boolean(declared[name]);
      }
    }
    caps.transportStreaming = Boolean(declared.transportStreaming ?? declared.streaming);
    caps.incrementalGeneration = Boolean(declared.incrementalGeneration ?? declared.backendIncrementalGeneration);
    caps.backendIncrementalGeneration = caps.incrementalGeneration;
    caps.boundaryEvents = Boolean(declared.boundaryEvents ?? declared.boundary);
    caps.boundary = caps.boundaryEvents;
    caps.voiceClone = Boolean(declared.voiceClone ?? declared.cloneVoice);
    caps.safeRate = declared.safeRate !== false;
    return Object.freeze(caps);
  }

  function normalizeProvider(provider) {
    if (!object(provider)) throw new TypeError('Provider V4 必须是对象。');
    const id = text(provider.id);
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) throw new TypeError('Provider V4 id 无效。');
    if (Number(provider.version) < PROVIDER_VERSION) throw new TypeError('Provider V4 version 必须为 4 或更高版本。');
    const capabilities = normalizeCapabilities(provider);
    for (const name of METHODS) {
      const implemented = name === 'modelManagement'
        ? Object.values(object(provider[name])).some((item) => typeof item === 'function')
        : typeof provider[name] === 'function';
      if (capabilities[name] && !implemented) throw new TypeError(`Provider ${id} 声明了 ${name} 能力但未实现。`);
    }
    return Object.freeze(Object.assign({}, provider, { id, version: PROVIDER_VERSION, capabilities }));
  }

  function promote(provider, overrides) {
    const source = Object.assign({}, provider, object(overrides));
    source.version = PROVIDER_VERSION;
    source.capabilities = Object.assign({}, object(provider.capabilities), object(source.capabilities));
    return normalizeProvider(source);
  }

  function createProviderRegistry(options) {
    const providers = new Map();
    let activeId = text(object(options).activeProviderId) || 'browser-system';
    function register(provider, config) {
      const normalized = normalizeProvider(provider);
      if (providers.has(normalized.id) && !object(config).replace) {
        throw new ProviderError('provider_exists', `Provider 已注册：${normalized.id}`, { providerId: normalized.id, retryable: false });
      }
      providers.set(normalized.id, normalized);
      return normalized;
    }
    function select(input) {
      const query = typeof input === 'string' ? { providerId: input } : object(input);
      const id = text(query.providerId) || activeId;
      const provider = providers.get(id);
      if (!provider) throw new ProviderError('provider_unavailable', `未找到朗读引擎：${id}`, { providerId: id, stage: 'select', retryable: false });
      const required = Array.isArray(query.requiredCapabilities) ? query.requiredCapabilities : [];
      const missing = required.filter((name) => !provider.capabilities[name]);
      if (missing.length) throw new ProviderError('capability_mismatch', `当前朗读引擎不支持：${missing.join('、')}`, { providerId: id, stage: 'select', retryable: false });
      return provider;
    }
    for (const provider of (Array.isArray(object(options).providers) ? object(options).providers : [])) register(provider);
    return Object.freeze({
      register, select,
      setActive(id) { select(id); activeId = String(id); return activeId; },
      getActive: () => activeId,
      get: (id) => providers.get(String(id)) || null,
      list: () => Array.from(providers.values()),
      inspect: () => Array.from(providers.values()).map((item) => ({ id: item.id, version: item.version, capabilities: item.capabilities })),
    });
  }

  function createBrowserSystemProvider(options) {
    if (!v3?.createBrowserSystemProvider) throw new ProviderError('provider_unavailable', '系统语音 Provider 未加载。');
    return promote(v3.createBrowserSystemProvider(options), {
      capabilities: { boundaryEvents: true },
    });
  }

  function createOpenAICompatibleProvider(options) {
    if (!v3?.createOpenAICompatibleProvider) throw new ProviderError('provider_unavailable', '在线 TTS Provider 未加载。');
    return promote(v3.createOpenAICompatibleProvider(options), {
      capabilities: { transportStreaming: false, incrementalGeneration: false },
    });
  }

  function createBrowserModelProvider(options) {
    if (!v3?.createBrowserModelProvider) throw new ProviderError('provider_unavailable', '浏览器模型 Provider 未加载。');
    return promote(v3.createBrowserModelProvider(options), {
      capabilities: { transportStreaming: false, incrementalGeneration: false },
    });
  }

  function validateLocalBaseUrl(value) {
    let url;
    try { url = new URL(text(value) || 'http://127.0.0.1:7811'); } catch (_) {
      throw new ProviderError('invalid_base_url', '本地 TTS 地址无效。', { stage: 'configure', retryable: false });
    }
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (!loopback || !['http:', 'https:'].includes(url.protocol)) {
      throw new ProviderError('non_loopback_forbidden', '本地服务只允许 localhost、127.0.0.1 或 ::1。', { stage: 'configure', retryable: false });
    }
    if (url.username || url.password || url.search || url.hash) {
      throw new ProviderError('invalid_base_url', '本地 TTS 地址不能包含凭据、查询参数或片段。', { stage: 'configure', retryable: false });
    }
    return url.toString().replace(/\/$/, '');
  }

  function adapterPayload(adapterId, request, stream) {
    const body = object(request);
    const input = text(body.input || body.text);
    const voice = rawVoice('local-service', body.voice || body.voiceId);
    const model = text(body.model);
    const format = text(body.response_format || body.responseFormat) || 'wav';
    if (adapterId === 'gpt-sovits') {
      return {
        text: input, text_lang: text(body.textLang) || 'zh', ref_audio_path: text(body.referenceAudioPath),
        prompt_text: text(body.promptText), prompt_lang: text(body.promptLang) || 'zh',
        text_split_method: text(body.textSplitMethod) || 'cut5', batch_size: Math.max(1, Number(body.batchSize) || 1),
        media_type: format, streaming_mode: Boolean(stream), voice,
      };
    }
    if (adapterId === 'cosyvoice') {
      return { tts_text: input, spk_id: voice, model, response_format: format, stream: Boolean(stream) };
    }
    return { input, voice, model, response_format: format, stream: Boolean(stream) };
  }

  function createLocalServiceProvider(options) {
    const config = object(options);
    const adapterId = LOCAL_ADAPTER_IDS.includes(text(config.adapterId)) ? text(config.adapterId) : 'flowloud-qwen';
    const adapter = LOCAL_ADAPTERS[adapterId];
    const baseUrl = validateLocalBaseUrl(config.baseUrl);

    if (adapterId === 'flowloud-qwen' && v3?.adaptLocalQwen && (config.api || apiModule?.createApiClient)) {
      const api = config.api || apiModule.createApiClient({
        baseUrl, clientToken: config.clientToken, fetchImpl: config.fetchImpl, storage: config.storage,
      });
      const local = v3.adaptLocalQwen(Object.assign({}, config, { api, baseUrl }));
      const mapResult = (result) => Object.assign({}, object(result), { providerId: 'local-service', adapterId });
      const mapRequest = (request) => Object.assign({}, object(request), {
        voice: rawVoice('local-service', object(request).voice || object(request).voiceId),
      });
      const stream = typeof local.stream === 'function' ? function stream(request, operation) {
        const source = local.stream(mapRequest(request), operation);
        return (async function* mappedStream() {
          for await (const event of source) yield Object.assign({}, event, { providerId: 'local-service', adapterId });
        }());
      } : undefined;
      return normalizeProvider({
        id: 'local-service', version: PROVIDER_VERSION, adapterId,
        capabilities: Object.assign({}, local.capabilities, {
          status: true, cloneVoice: true, voiceClone: true,
          transportStreaming: true, incrementalGeneration: false,
        }),
        health: async (operation) => mapResult(await local.health(operation)),
        voices: async (operation) => (await local.voices(operation)).map((voice) => Object.assign({}, voice, {
          id: voiceId('local-service', voice.voiceId || voice.name), providerId: 'local-service', adapterId,
        })),
        synthesize: async (request, operation) => mapResult(await local.synthesize(mapRequest(request), operation)),
        stream,
        cancel: async (request, operation) => mapResult(await local.cancel(request, operation)),
        status: async (request, operation) => success('local-service', request, operation, await api.speechStatus(request, object(operation).signal)),
        cloneVoice: async (profile, operation) => success('local-service', profile, operation, await api.registerVoice(profile, object(operation).signal)),
      });
    }

    const fetchImpl = config.fetchImpl || globalThis.fetch;
    if (typeof fetchImpl !== 'function') throw new ProviderError('fetch_unavailable', '当前环境无法访问本地 TTS。', { providerId: 'local-service', stage: 'configure' });
    const operations = new Map();
    const token = text(config.clientToken);

    function headers(extra) {
      return Object.assign({ accept: 'application/json' }, token ? { authorization: `Bearer ${token}` } : {}, object(extra));
    }
    function start(request, operation) {
      const requestId = requestIdOf(request, operation) || `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      const controller = new AbortController();
      const external = object(operation).signal;
      if (external?.aborted) controller.abort();
      else external?.addEventListener?.('abort', () => controller.abort(), { once: true });
      const record = { requestId, playbackId: text(object(request).playbackId || object(operation).playbackId), controller };
      operations.set(requestId, record);
      return record;
    }
    async function request(path, init, context) {
      let response;
      try { response = await fetchImpl(`${baseUrl}${path}`, init); } catch (error) {
        throw structuredError(error, Object.assign({ providerId: 'local-service', stage: 'transport' }, context));
      }
      if (!response.ok) {
        throw new ProviderError(`http_${response.status}`, `本地 TTS 返回 HTTP ${response.status}。`, Object.assign({
          providerId: 'local-service', stage: 'response', status: response.status,
        }, context));
      }
      return response;
    }
    async function json(path, signal, context) {
      const response = await request(path, { method: 'GET', signal, headers: headers() }, context);
      try { return await response.json(); } catch (error) {
        throw new ProviderError('invalid_response', '本地 TTS 返回了无效 JSON。', Object.assign({ providerId: 'local-service', stage: 'decode', cause: error }, context));
      }
    }
    async function synthesize(requestBody, operation) {
      const record = start(requestBody, operation);
      try {
        const response = await request(adapter.speechPath, {
          method: 'POST', signal: record.controller.signal,
          headers: headers({ 'content-type': 'application/json', accept: 'audio/*, application/octet-stream' }),
          body: JSON.stringify(adapterPayload(adapterId, Object.assign({}, requestBody, { requestId: record.requestId }), false)),
        }, record);
        const blob = await response.blob();
        return success('local-service', Object.assign({}, requestBody, { requestId: record.requestId }), operation, {
          adapterId, blob, audio: blob, mimeType: blob.type || response.headers?.get?.('content-type') || 'audio/wav',
        });
      } finally { operations.delete(record.requestId); }
    }
    function stream(requestBody, operation) {
      const record = start(requestBody, operation);
      return (async function* localStream() {
        try {
          const response = await request(adapter.streamPath, {
            method: 'POST', signal: record.controller.signal,
            headers: headers({ 'content-type': 'application/json', accept: 'audio/*, application/octet-stream' }),
            body: JSON.stringify(adapterPayload(adapterId, Object.assign({}, requestBody, { requestId: record.requestId }), true)),
          }, record);
          if (response.body?.getReader) {
            const reader = response.body.getReader();
            while (true) {
              const item = await reader.read();
              if (item.done) break;
              if (item.value?.byteLength) yield item.value;
            }
          } else {
            const bytes = new Uint8Array(await response.arrayBuffer());
            if (bytes.byteLength) yield bytes;
          }
        } finally { operations.delete(record.requestId); }
      }());
    }
    async function cancel(identity, operation) {
      const query = object(identity);
      const id = text(query.requestId || identity);
      let count = 0;
      for (const record of operations.values()) {
        if ((id && record.requestId !== id) || (query.playbackId && record.playbackId !== String(query.playbackId))) continue;
        record.controller.abort(); count += 1;
      }
      let remoteCancelled = false;
      if (adapter.cancelPath && (id || query.playbackId)) {
        try {
          const response = await request(adapter.cancelPath, {
            method: 'POST', signal: object(operation).signal, headers: headers({ 'content-type': 'application/json' }),
            body: JSON.stringify({ request_id: id, playback_id: text(query.playbackId) }),
          }, { requestId: id });
          remoteCancelled = response.ok;
        } catch (_) {}
      }
      return success('local-service', query, operation, { adapterId, cancelled: count > 0 || remoteCancelled, remoteCancelled, count });
    }
    async function health(operation) {
      const payload = await json('/health', object(operation).signal, {});
      const dynamic = object(payload.capabilities || payload.features);
      return success('local-service', {}, operation, {
        adapterId, ok: payload.ok !== false, ready: payload.ready !== false,
        capabilities: Object.assign({}, dynamic, {
          transportStreaming: dynamic.transportStreaming == null ? adapter.transportStreaming : Boolean(dynamic.transportStreaming),
          incrementalGeneration: dynamic.incrementalGeneration == null
            ? adapter.incrementalGeneration : Boolean(dynamic.incrementalGeneration),
        }),
      });
    }
    async function voices(operation) {
      const payload = await json(adapter.voicesPath, object(operation).signal, {});
      const list = Array.isArray(payload) ? payload : (Array.isArray(payload.voices) ? payload.voices : []);
      return list.map((voice) => {
        const source = typeof voice === 'string' ? { name: voice } : object(voice);
        const id = text(source.id || source.voiceId || source.name);
        return Object.assign({}, source, { id: voiceId('local-service', id), voiceId: id, name: text(source.name || id), providerId: 'local-service', adapterId });
      });
    }

    return normalizeProvider({
      id: 'local-service', version: PROVIDER_VERSION, adapterId,
      capabilities: {
        health: true, voices: true, synthesize: true, stream: true, cancel: true, status: true,
        cloneVoice: false, voiceClone: adapter.cloneVoice,
        transportStreaming: adapter.transportStreaming,
        incrementalGeneration: adapter.incrementalGeneration,
        safeRate: false,
      },
      health, voices, synthesize, stream, cancel,
      status: async (identity, operation) => success('local-service', identity, operation,
        await json(adapter.statusPath || '/health', object(operation).signal, { requestId: requestIdOf(identity, operation) })),
    });
  }

  function createDoubaoTtsProvider(options) {
    const config = object(options);
    const fetchImpl = config.fetchImpl || globalThis.fetch;
    const apiKey = text(config.apiKey);
    const resourceId = text(config.resourceId) || 'seed-tts-2.0';
    const appId = text(config.appId);
    const configuredVoices = (Array.isArray(config.voiceIds) ? config.voiceIds : [config.voice]).map(text).filter(Boolean);
    const configuredVoice = configuredVoices[0] || '';
    let parsed;
    try { parsed = new URL(text(config.baseUrl) || 'https://openspeech.bytedance.com'); }
    catch (_) { throw new ProviderError('invalid_base_url', '豆包语音 Base URL 无效。', { providerId: 'doubao-tts', stage: 'configure', retryable: false }); }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
    if (parsed.protocol !== 'https:' && !(loopback && parsed.protocol === 'http:')) {
      throw new ProviderError('insecure_remote_url', '豆包语音远程地址必须使用 HTTPS。', { providerId: 'doubao-tts', stage: 'configure', retryable: false });
    }
    const baseUrl = parsed.toString().replace(/\/$/u, '');
    const path = text(config.path) || '/api/v3/tts/unidirectional';
    function headers() {
      const result = { 'content-type': 'application/json', accept: 'audio/*, application/json, text/event-stream' };
      if (apiKey) result['X-Api-Key'] = apiKey;
      if (resourceId) result['X-Api-Resource-Id'] = resourceId;
      if (appId) result['X-Api-App-Id'] = appId;
      return result;
    }
    function bytesFromBase64(value) {
      const binary = atob(String(value || '').replace(/^data:[^,]+,/u, ''));
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      return bytes;
    }
    async function audioBlob(response, format) {
      const contentType = text(response.headers?.get?.('content-type')).toLowerCase();
      if (contentType.startsWith('audio/') || contentType.includes('octet-stream')) return response.blob();
      const raw = await response.text();
      const chunks = [];
      if (contentType.includes('event-stream') || /^data:/mu.test(raw)) {
        for (const line of raw.split(/\r?\n/u)) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const item = JSON.parse(payload);
            const audio = item.data || item.audio || item.result?.audio || item.result?.data;
            if (audio) chunks.push(bytesFromBase64(audio));
          } catch (_) {}
        }
      } else {
        let payload;
        try { payload = JSON.parse(raw); } catch (_) { payload = {}; }
        const audio = payload.data || payload.audio || payload.result?.audio || payload.result?.data;
        if (audio) chunks.push(bytesFromBase64(audio));
        if (!chunks.length && payload.message) throw new ProviderError('invalid_response', String(payload.message), { providerId: 'doubao-tts', retryable: false });
      }
      if (!chunks.length) throw new ProviderError('invalid_response', '豆包语音没有返回可播放音频。', { providerId: 'doubao-tts', retryable: false });
      return new Blob(chunks, { type: format === 'wav' ? 'audio/wav' : format === 'opus' ? 'audio/ogg' : 'audio/mpeg' });
    }
    async function synthesize(request, operation) {
      const body = object(request);
      const requestId = requestIdOf(body, operation) || `doubao-${Date.now().toString(36)}`;
      const format = text(body.response_format || body.responseFormat || config.responseFormat) || 'mp3';
      const voice = rawVoice('doubao-tts', body.voice || configuredVoice);
      if (!apiKey) throw new ProviderError('authentication_required', '请先填写豆包语音 API Key。', { providerId: 'doubao-tts', requestId, retryable: false });
      if (!voice) throw new ProviderError('voice_required', '请填写豆包语音音色 ID。', { providerId: 'doubao-tts', requestId, retryable: false });
      let response;
      try {
        response = await fetchImpl(`${baseUrl}${path.startsWith('/') ? path : `/${path}`}`, {
          method: 'POST', signal: object(operation).signal, headers: headers(),
          body: JSON.stringify({
            user: { uid: text(config.userId) || 'flowloud-browser' },
            audio: { voice_type: voice, encoding: format, speed_ratio: Number(body.rate || config.rate) || 1 },
            request: { reqid: requestId, text: text(body.input || body.text), operation: 'query' },
          }),
        });
      } catch (error) { throw structuredError(error, { providerId: 'doubao-tts', requestId, stage: 'synthesize' }); }
      if (!response.ok) throw new ProviderError(`http_${response.status}`, `豆包语音返回 HTTP ${response.status}。`, { providerId: 'doubao-tts', requestId, status: response.status });
      const blob = await audioBlob(response, format);
      return success('doubao-tts', body, operation, { blob, audio: blob, mimeType: blob.type, voice: voiceId('doubao-tts', voice), resourceId });
    }
    return normalizeProvider({
      id: 'doubao-tts', version: PROVIDER_VERSION,
      capabilities: { health: true, voices: true, synthesize: true, stream: false, cancel: false, safeRate: true },
      health: async (operation) => success('doubao-tts', {}, operation, { ok: Boolean(apiKey && configuredVoice), ready: Boolean(apiKey && configuredVoice), resourceId }),
      voices: async () => configuredVoices.map((voice) => ({ id: voiceId('doubao-tts', voice), voiceId: voice, name: voice, label: voice, providerId: 'doubao-tts' })),
      synthesize,
    });
  }

  return Object.freeze({
    PROVIDER_VERSION, METHODS, LOCAL_ADAPTER_IDS, LOCAL_ADAPTERS, ProviderError,
    structuredError, success, voiceId, rawVoice, normalizeCapabilities, normalizeProvider,
    createProviderRegistry, createBrowserSystemProvider, createOpenAICompatibleProvider,
    createBrowserModelProvider, createLocalServiceProvider, createDoubaoTtsProvider, validateLocalBaseUrl,
    BUILTIN_BROWSER_MODELS: v3?.BUILTIN_BROWSER_MODELS || Object.freeze({}), providerCore: core || null,
  });
}));
