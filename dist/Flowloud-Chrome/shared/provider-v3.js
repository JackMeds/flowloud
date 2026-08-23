(function providerV3Module(root, factory) {
  const exported = factory(root.QwenReaderProviderV2 || (typeof require === 'function' ? require('./provider-v2.js') : null));
  if (typeof module === 'object' && module.exports) module.exports = exported;
  root.FlowloudProviderV3 = exported;
}(typeof globalThis !== 'undefined' ? globalThis : this, function makeProviderV3(legacy) {
  'use strict';

  const PROVIDER_VERSION = 3;
  const METHODS = Object.freeze(['health', 'voices', 'synthesize', 'stream', 'play', 'pause', 'resume', 'cancel', 'modelManagement']);
  const FORMATS = Object.freeze(['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm']);
  const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

  class ProviderError extends Error {
    constructor(code, message, details) {
      super(message || code);
      this.name = 'ProviderError';
      this.code = code || 'provider_error';
      Object.assign(this, details || {});
    }
  }

  function object(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
  function text(value) { return String(value == null ? '' : value).trim(); }
  function clampRate(value) { const n = Number(value); return Number.isFinite(n) ? Math.min(2, Math.max(0.75, n)) : 1; }
  function voiceId(providerId, value) {
    const raw = text(value);
    if (!raw) return '';
    return raw.startsWith(`${providerId}:`) ? raw : `${providerId}:${raw}`;
  }
  function rawVoiceId(providerId, value) {
    const raw = text(value);
    return raw.startsWith(`${providerId}:`) ? raw.slice(providerId.length + 1) : raw;
  }

  function capabilities(provider) {
    const declared = object(provider.capabilities);
    const result = {};
    for (const name of METHODS) result[name] = declared[name] == null ? typeof provider[name] === 'function' : Boolean(declared[name]);
    result.cloneVoice = Boolean(declared.cloneVoice);
    result.streaming = Boolean(declared.streaming);
    result.boundary = Boolean(declared.boundary);
    result.safeRate = declared.safeRate !== false;
    return Object.freeze(result);
  }

  function normalizeProvider(provider) {
    if (!object(provider)) throw new TypeError('Provider V3 必须是对象。');
    const id = text(provider.id);
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) throw new TypeError('Provider V3 id 无效。');
    if (Number(provider.version) < PROVIDER_VERSION) throw new TypeError('Provider V3 version 必须为 3 或更高版本。');
    const caps = capabilities(provider);
    for (const name of METHODS) {
      const manager = object(provider[name]);
      const implemented = name === 'modelManagement'
        ? Object.keys(manager).some((key) => typeof manager[key] === 'function')
        : typeof provider[name] === 'function';
      if (caps[name] && !implemented) throw new TypeError(`Provider ${id} 声明了 ${name} 能力但未实现。`);
    }
    return Object.freeze(Object.assign({}, provider, { id, version: Number(provider.version), capabilities: caps }));
  }

  function createProviderRegistry(options) {
    const providers = new Map();
    let activeId = text(object(options).activeProviderId) || 'browser-system';
    function register(provider, config) {
      const value = normalizeProvider(provider);
      if (providers.has(value.id) && !object(config).replace) throw new ProviderError('provider_exists', `Provider 已注册：${value.id}`);
      providers.set(value.id, value);
      return value;
    }
    function select(request) {
      const query = typeof request === 'string' ? { providerId: request } : object(request);
      const id = text(query.providerId) || activeId;
      const provider = providers.get(id);
      if (!provider) throw new ProviderError('provider_unavailable', `未找到朗读引擎：${id}`, { providerId: id });
      const required = Array.isArray(query.requiredCapabilities) ? query.requiredCapabilities : [];
      const missing = required.filter((name) => !provider.capabilities[name]);
      if (missing.length) throw new ProviderError('capability_mismatch', `当前朗读引擎不支持：${missing.join('、')}`, { providerId: id, missing });
      return provider;
    }
    function setActive(id) { select(String(id)); activeId = String(id); return activeId; }
    for (const provider of (Array.isArray(object(options).providers) ? object(options).providers : [])) register(provider);
    return Object.freeze({ register, select, setActive, getActive: () => activeId, get: (id) => providers.get(String(id)) || null,
      list: () => Array.from(providers.values()), inspect: () => Array.from(providers.values()).map((p) => ({ id: p.id, version: p.version, capabilities: p.capabilities })) });
  }

  function createBrowserSystemProvider(options) {
    const config = object(options);
    const synth = config.speechSynthesis || globalThis.speechSynthesis;
    const Utterance = config.SpeechSynthesisUtterance || globalThis.SpeechSynthesisUtterance;
    let current = null;
    function ensure() {
      if (!synth || !Utterance) throw new ProviderError('system_voice_unavailable', '当前浏览器没有可用的系统语音。');
    }
    function voiceList() {
      ensure();
      return Array.from(synth.getVoices()).map((voice) => ({
        id: voiceId('browser-system', voice.voiceURI || voice.name),
        voiceId: voice.voiceURI || voice.name, name: voice.name, label: voice.name,
        lang: voice.lang || '', local: voice.localService !== false, default: Boolean(voice.default), providerId: 'browser-system',
      }));
    }
    async function play(request, playOptions) {
      ensure();
      const body = object(request); const opts = object(playOptions);
      if (!text(body.text || body.input)) throw new ProviderError('invalid_input', '朗读内容不能为空。');
      if (current) synth.cancel();
      return new Promise((resolve, reject) => {
        const utterance = new Utterance(text(body.text || body.input));
        const requestedVoice = rawVoiceId('browser-system', body.voice || body.voiceId);
        utterance.voice = voiceList().map((item, index) => ({ item, native: synth.getVoices()[index] }))
          .find(({ item }) => item.voiceId === requestedVoice || item.name === requestedVoice)?.native || null;
        utterance.rate = clampRate(body.rate); utterance.pitch = Math.min(2, Math.max(0, Number(body.pitch) || 1));
        utterance.volume = Math.min(1, Math.max(0, Number(body.volume == null ? 1 : body.volume)));
        if (body.lang) utterance.lang = body.lang;
        utterance.onboundary = (event) => { if (typeof opts.onEvent === 'function') opts.onEvent({ type: 'boundary', charIndex: event.charIndex, charLength: event.charLength || 0, name: event.name }); };
        utterance.onpause = () => opts.onEvent?.({ type: 'paused' });
        utterance.onresume = () => opts.onEvent?.({ type: 'resumed' });
        utterance.onerror = (event) => { current = null; reject(new ProviderError(event.error === 'canceled' ? 'cancelled' : 'system_voice_error', `系统语音播放失败：${event.error || 'unknown'}`)); };
        utterance.onend = () => { current = null; opts.onEvent?.({ type: 'end' }); resolve({ providerId: 'browser-system', completed: true }); };
        current = utterance; synth.speak(utterance); opts.onEvent?.({ type: 'started' });
      });
    }
    return normalizeProvider({ id: 'browser-system', version: 3,
      capabilities: { health: true, voices: true, play: true, pause: true, resume: true, cancel: true, boundary: true, safeRate: true },
      health: async () => ({ ok: true, ready: Boolean(synth && Utterance), providerId: 'browser-system' }), voices: async () => voiceList(), play,
      pause: async () => { ensure(); synth.pause(); return { paused: true }; }, resume: async () => { ensure(); synth.resume(); return { resumed: true }; },
      cancel: async () => { ensure(); synth.cancel(); current = null; return { cancelled: true }; } });
  }

  function validateOnlineBaseUrl(value) {
    let url; try { url = new URL(text(value)); } catch (_) { throw new ProviderError('invalid_base_url', '在线 TTS 地址无效。'); }
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new ProviderError('insecure_base_url', '在线服务必须使用 HTTPS；仅回环地址允许 HTTP。');
    if (url.username || url.password) throw new ProviderError('invalid_base_url', '在线 TTS 地址不能包含凭据。');
    return url.toString().replace(/\/$/, '');
  }

  function createOpenAICompatibleProvider(options) {
    const config = object(options); const fetchImpl = config.fetchImpl || globalThis.fetch;
    const baseUrl = validateOnlineBaseUrl(config.baseUrl); const format = FORMATS.includes(config.responseFormat) ? config.responseFormat : 'mp3';
    async function synthesize(request, operation) {
      const body = object(request); const key = text(object(operation).apiKey || config.apiKey);
      if (!key) throw new ProviderError('missing_api_key', '请先填写 API Key。');
      const response = await fetchImpl(`${baseUrl}/v1/audio/speech`, { method: 'POST', signal: object(operation).signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: text(body.model || config.model), voice: rawVoiceId('openai-compatible', body.voice || config.voice || 'alloy'), input: text(body.text || body.input), response_format: body.responseFormat || body.response_format || format }) });
      if (!response.ok) throw new ProviderError(`http_${response.status}`, `在线 TTS 请求失败（HTTP ${response.status}）。`, { status: response.status });
      const declared = Number(response.headers?.get?.('content-length') || 0);
      if (declared > MAX_RESPONSE_BYTES) throw new ProviderError('response_too_large', '在线 TTS 返回的音频超过 64 MB。');
      const contentType = text(response.headers?.get?.('content-type')).toLowerCase();
      if (contentType && !contentType.startsWith('audio/') && contentType !== 'application/octet-stream') throw new ProviderError('invalid_response', '在线 TTS 返回的不是音频。');
      const blob = await response.blob();
      if (blob.size > MAX_RESPONSE_BYTES) throw new ProviderError('response_too_large', '在线 TTS 返回的音频超过 64 MB。');
      return { blob, mimeType: blob.type || `audio/${format}`, providerId: 'openai-compatible' };
    }
    return normalizeProvider({ id: 'openai-compatible', version: 3,
      capabilities: { health: true, voices: true, synthesize: true, cancel: true, safeRate: false },
      // `health` is deliberately side-effect free. Some OpenAI-compatible
      // services bill every speech request, so a real connection test must be
      // an explicit, user-authored audition handled by the settings UI.
      health: async (operation) => ({
        ok: true,
        ready: Boolean(text(object(operation).apiKey || config.apiKey) && text(config.model)),
        providerId: 'openai-compatible',
        requiresAudition: true,
      }),
      voices: async () => (config.voices || ['alloy']).map((name) => ({ id: voiceId('openai-compatible', name), voiceId: name, name, label: name, providerId: 'openai-compatible' })),
      synthesize, cancel: async () => ({ cancelled: true }) });
  }

  const BUILTIN_BROWSER_MODELS = Object.freeze({
    'kokoro-zh': Object.freeze({ repoId: 'onnx-community/Kokoro-82M-v1.1-zh-ONNX', revision: '6cc0f0d2ebe369a68b0df87c2b65c1af8c0ac3e3', lang: 'zh-CN', license: 'Apache-2.0', voice: 'zf_001', estimatedBytes: 110 * 1024 * 1024 }),
  });
  function validateRepoId(value) {
    const id = text(value);
    if (!/^[A-Za-z0-9][\w.-]{0,95}\/[A-Za-z0-9][\w.-]{0,95}$/.test(id)) throw new ProviderError('invalid_model_repo', 'Hugging Face Repo ID 格式无效。');
    return id;
  }
  function pcmToWav(samples, sampleRate) {
    const input = samples instanceof Float32Array ? samples : Float32Array.from(samples || []);
    const buffer = new ArrayBuffer(44 + input.length * 2); const view = new DataView(buffer);
    const write = (offset, value) => { for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index)); };
    write(0, 'RIFF'); view.setUint32(4, 36 + input.length * 2, true); write(8, 'WAVE'); write(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); write(36, 'data'); view.setUint32(40, input.length * 2, true);
    for (let i = 0; i < input.length; i += 1) view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, input[i])) * 0x7fff, true);
    return buffer;
  }
  function createBrowserModelProvider(options) {
    const config = object(options); const preset = BUILTIN_BROWSER_MODELS[config.modelId];
    if (!preset && config.modelId !== 'custom') throw new ProviderError('unsupported_model', '浏览器模型不在已验证白名单中。');
    if (!preset && (config.trustRemoteCode === true || config.remoteCode === true || config.loaderCode || config.customLoader || config.customHost)) {
      throw new ProviderError('remote_code_forbidden', '自定义模型不允许远程代码、自定义加载器或任意模型主机。');
    }
    const repoId = validateRepoId(preset?.repoId || config.repoId);
    const revision = text(preset?.revision || config.revision || 'main');
    if (!/^[A-Za-z0-9._/-]{1,160}$/.test(revision) || revision.includes('..')) throw new ProviderError('invalid_model_revision', '模型 revision 无效。');
    if (!preset && !/^[a-f0-9]{40}$/i.test(revision)) throw new ProviderError('unpinned_model_revision', '实验性自定义模型必须填写完整的 40 位 commit revision。');
    const pipelineFactory = config.pipelineFactory;
    let pipelinePromise = null;
    let resolvedDevice = config.device === 'wasm' ? 'wasm' : 'webgpu';
    let fallbackReason = '';
    const cacheKey = `flowloud-model-${repoId}@${revision}`;
    let modelState = 'missing';
    let verifiedAt = '';
    let activeDownload = null;
    async function cacheExists() {
      if (typeof caches === 'undefined' || typeof caches.keys !== 'function') return null;
      return (await caches.keys()).includes(cacheKey);
    }
    async function disposePipeline() {
      const pending = pipelinePromise;
      pipelinePromise = null;
      if (!pending) return;
      try { await (await pending)?.dispose?.(); } catch (_) {}
    }
    async function getPipeline(progress, buildOptions) {
      const controls = object(buildOptions);
      if (typeof pipelineFactory !== 'function') throw new ProviderError('model_runtime_unavailable', '当前构建未包含浏览器模型运行库。');
      if (controls.forceNew) await disposePipeline();
      if (!pipelinePromise) pipelinePromise = (async () => {
        const onProgress = (value) => {
          if (controls.signal?.aborted) throw Object.assign(new Error('模型下载已取消。'), { name: 'AbortError', code: 'cancelled' });
          if (typeof progress === 'function') progress(value);
        };
        const baseOptions = {
          revision,
          dtype: text(config.dtype || 'fp32'),
          progress_callback: onProgress,
          flowloudOffline: controls.offline === true,
          signal: controls.signal,
        };
        try {
          return await pipelineFactory('text-to-speech', repoId, Object.assign({}, baseOptions, { device: resolvedDevice }));
        } catch (error) {
          if (resolvedDevice !== 'webgpu' || config.allowWasmFallback === false) throw error;
          fallbackReason = String(error?.message || error?.code || 'WebGPU 初始化失败');
          resolvedDevice = 'wasm';
          return pipelineFactory('text-to-speech', repoId, Object.assign({}, baseOptions, { device: 'wasm' }));
        }
      })();
      return pipelinePromise;
    }
    async function probe(engine, signal) {
      if (signal?.aborted) throw Object.assign(new Error('模型校验已取消。'), { name: 'AbortError', code: 'cancelled' });
      const sample = preset?.lang === 'en' ? 'Ready.' : '准备就绪。';
      const output = await engine(sample, { speaker_embeddings: preset?.voice || config.voice });
      const samples = output && (output.audio || output.waveform);
      if (!samples || !Number(samples.length)) throw new ProviderError('model_probe_failed', '模型已缓存，但离线短句合成失败。');
      verifiedAt = new Date().toISOString();
      modelState = 'ready';
      return { ready: true, verifiedAt };
    }
    async function verify(operation) {
      const controls = object(operation);
      const cached = await cacheExists();
      if (cached === false) {
        modelState = 'missing'; verifiedAt = '';
        return { ready: false, cached: false, state: 'missing', cacheId: cacheKey };
      }
      modelState = 'verifying';
      try {
        const engine = await getPipeline(controls.onProgress, {
          signal: controls.signal,
          offline: cached === true,
          forceNew: controls.forceNew === true,
        });
        await probe(engine, controls.signal);
        return { ready: true, cached: cached !== false, state: modelState, cacheId: cacheKey, verifiedAt, device: resolvedDevice };
      } catch (error) {
        if (error?.name === 'AbortError') { modelState = 'cancelled'; throw error; }
        modelState = cached === true ? 'corrupt' : 'missing';
        return { ready: false, cached: cached === true, state: modelState, cacheId: cacheKey, error: { code: error?.code || 'model_probe_failed', message: error?.message || '模型校验失败。' } };
      }
    }
    async function synthesize(request, operation) {
      const body = object(request); const engine = await getPipeline(object(operation).onProgress);
      const selectedVoice = rawVoiceId('browser-model', body.speaker || body.voice || preset?.voice || config.voice || 'zf_001');
      const output = await engine(text(body.text || body.input), { speaker_embeddings: selectedVoice });
      const samples = output.audio || output.waveform; const samplingRate = Number(output.sampling_rate || output.samplingRate || 24000);
      if (!samples) throw new ProviderError('invalid_response', '浏览器模型没有返回音频。');
      return { audio: pcmToWav(samples, samplingRate), samplingRate, mimeType: 'audio/wav', providerId: 'browser-model' };
    }
    const modelManagement = Object.freeze({
      info: async () => {
        const cached = await cacheExists();
        const transientState = ['downloading', 'verifying', 'cancelled'].includes(modelState);
        const state = transientState
          ? modelState
          : cached === false ? 'missing' : modelState === 'missing' && cached === true ? 'available-unverified' : modelState;
        return { cacheId: cacheKey, cacheKey, modelId: text(config.modelId), repoId, revision, license: preset?.license || '由模型仓库声明', estimatedBytes: Number(preset?.estimatedBytes || 0), cached: cached == null ? modelState === 'ready' : cached, state, ready: state === 'ready', verifiedAt, runtimeVersion: text(config.runtimeVersion || 'transformers-js-bundled'), device: resolvedDevice, fallbackReason };
      },
      download: async (operation) => {
        const controls = object(operation);
        const controller = new AbortController();
        activeDownload = controller;
        if (controls.signal?.aborted) controller.abort();
        else controls.signal?.addEventListener?.('abort', () => controller.abort(), { once: true });
        modelState = 'downloading';
        try {
          await getPipeline(controls.onProgress, { signal: controller.signal, forceNew: true, offline: false });
          if (controller.signal.aborted) throw Object.assign(new Error('模型下载已取消。'), { name: 'AbortError', code: 'cancelled' });
          const cached = await cacheExists();
          if (cached === false) throw new ProviderError('model_cache_missing', '模型运行库完成加载，但没有找到对应缓存。');
          // In a real extension Cache Storage is available. Recreate the
          // pipeline with remote loading disabled before declaring success.
          const validation = await verify({
            signal: controller.signal,
            onProgress: controls.onProgress,
            forceNew: cached === true,
          });
          if (!validation.ready) throw new ProviderError(validation.error?.code || 'model_probe_failed', validation.error?.message || '模型离线校验失败。');
          return { downloaded: true, ready: true, state: 'ready', cacheId: cacheKey, cacheKey, modelId: text(config.modelId), repoId, revision, license: preset?.license || '由模型仓库声明', estimatedBytes: Number(preset?.estimatedBytes || 0), device: resolvedDevice, fallbackReason, verifiedAt, downloadedAt: new Date().toISOString(), runtimeVersion: text(config.runtimeVersion || 'transformers-js-bundled') };
        } catch (error) {
          modelState = error?.name === 'AbortError' ? 'cancelled' : 'corrupt';
          throw error;
        } finally {
          if (activeDownload === controller) activeDownload = null;
        }
      },
      verify,
      cancel: async () => {
        const pending = activeDownload;
        if (pending) pending.abort();
        if (pending) modelState = 'cancelled';
        return { cancelled: Boolean(pending), state: modelState };
      },
      delete: async () => {
        if (activeDownload) activeDownload.abort();
        await disposePipeline();
        const deleted = typeof caches !== 'undefined' ? await caches.delete(cacheKey) : false;
        if (typeof pipelineFactory?.deleteCache === 'function') {
          await pipelineFactory.deleteCache(repoId, revision);
        }
        modelState = 'missing'; verifiedAt = '';
        return { deleted, cacheId: cacheKey, state: modelState };
      },
    });
    return normalizeProvider({ id: 'browser-model', version: 3,
      capabilities: { health: true, voices: true, synthesize: true, cancel: true, modelManagement: true, safeRate: false },
      health: async (operation) => Object.assign({ ok: true, providerId: 'browser-model' }, await verify(operation)),
      voices: async () => ['zf_001', 'zm_010', 'af_maple', 'af_sol', 'bf_vale'].map((voice) => ({ id: voiceId('browser-model', voice), voiceId: voice, name: voice, lang: preset?.lang || '', providerId: 'browser-model' })),
      synthesize, cancel: async () => ({ cancelled: true }), modelManagement });
  }

  function adaptLocalQwen(options) {
    if (!legacy?.createLocalQwenProvider) throw new ProviderError('provider_unavailable', '本地 Qwen 兼容层未加载。');
    const provider = legacy.createLocalQwenProvider(options);
    const unwrapRequestVoice = (request) => Object.assign({}, object(request), {
      voice: rawVoiceId('local-qwen', object(request).voice || object(request).voiceId),
    });
    const compatible = Object.assign({}, provider, {
      synthesize: typeof provider.synthesize === 'function' ? (request, operation) => provider.synthesize(unwrapRequestVoice(request), operation) : undefined,
      stream: typeof provider.stream === 'function' ? (request, operation) => provider.stream(unwrapRequestVoice(request), operation) : undefined,
    });
    return normalizeProvider(Object.assign({}, compatible, { version: 3, capabilities: Object.assign({}, provider.capabilities, {
      health: true, voices: true, synthesize: true, cancel: true, modelManagement: false, cloneVoice: true, safeRate: false,
    }) }));
  }

  return Object.freeze({ PROVIDER_VERSION, METHODS, FORMATS, MAX_RESPONSE_BYTES, ProviderError, clampRate, voiceId, rawVoiceId,
    capabilities, normalizeProvider, createProviderRegistry, createBrowserSystemProvider, validateOnlineBaseUrl,
    createOpenAICompatibleProvider, BUILTIN_BROWSER_MODELS, validateRepoId, pcmToWav, createBrowserModelProvider, adaptLocalQwen });
}));
