(function providerV3Module(root, factory) {
  const exported = factory(
    root.QwenReaderProviderV2 || (typeof require === 'function' ? require('./provider-v2.js') : null),
    root.FlowloudBrowserModelManifest || (typeof require === 'function' ? require('./browser-model-manifest.js') : null),
  );
  if (typeof module === 'object' && module.exports) module.exports = exported;
  root.FlowloudProviderV3 = exported;
}(typeof globalThis !== 'undefined' ? globalThis : this, function makeProviderV3(legacy, browserModelManifest) {
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
        body: JSON.stringify({ model: text(body.model || config.model), voice: rawVoiceId('openai-compatible', body.voice || config.voiceIds?.[0] || 'alloy'), input: text(body.text || body.input), response_format: body.responseFormat || body.response_format || format }) });
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
      voices: async () => (config.voiceIds || config.voices || ['alloy']).map((name) => ({ id: voiceId('openai-compatible', name), voiceId: name, name, label: name, providerId: 'openai-compatible' })),
      synthesize, cancel: async () => ({ cancelled: true }) });
  }

  const manifestModel = browserModelManifest?.BUILTIN_BROWSER_MODEL || {};
  const BUILTIN_BROWSER_MODELS = Object.freeze({
    'kokoro-zh': Object.freeze(Object.assign({
      repoId: 'onnx-community/Kokoro-82M-v1.1-zh-ONNX',
      revision: browserModelManifest?.MODELSCOPE_REVISION || '71bfd8ce077d1f8c70a183704da7c55c1c4cded6',
      hfRevision: browserModelManifest?.HUGGINGFACE_REVISION || '6cc0f0d2ebe369a68b0df87c2b65c1af8c0ac3e3',
      source: 'modelscope', lang: 'zh-CN', license: 'Apache-2.0', voice: 'zf_001',
      estimatedBytes: 342 * 1024 * 1024,
    }, manifestModel, { source: 'modelscope' })),
  });
  function validateRepoId(value) {
    const id = text(value);
    if (!/^[A-Za-z0-9][\w.-]{0,95}\/[A-Za-z0-9][\w.-]{0,95}$/.test(id)) throw new ProviderError('invalid_model_repo', '模型 Repo ID 格式无效。');
    return id;
  }
  function pcmToWav(samples, sampleRate) {
    const input = samples instanceof Float32Array ? samples : Float32Array.from(samples || []);
    let peak = 0;
    for (let i = 0; i < input.length; i += 1) {
      const value = Number(input[i]);
      if (Number.isFinite(value)) peak = Math.max(peak, Math.abs(value));
    }
    // Kokoro's fp32 output is often around -26 dBFS. Apply a bounded make-up
    // gain so browser playback is intelligible without allowing a malformed
    // backend waveform to be hidden by arbitrary amplification.
    const gain = peak > 0 && peak < 0.9 ? Math.min(2.5, 0.9 / peak) : 1;
    const buffer = new ArrayBuffer(44 + input.length * 2); const view = new DataView(buffer);
    const write = (offset, value) => { for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index)); };
    write(0, 'RIFF'); view.setUint32(4, 36 + input.length * 2, true); write(8, 'WAVE'); write(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); write(36, 'data'); view.setUint32(40, input.length * 2, true);
    for (let i = 0; i < input.length; i += 1) {
      const value = Number.isFinite(Number(input[i])) ? Number(input[i]) * gain : 0;
      view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, value)) * 0x7fff, true);
    }
    return buffer;
  }
  function audioSignal(samples) {
    let maxAbs = 0;
    let nonZero = 0;
    let finite = 0;
    let clipped = 0;
    let sum = 0;
    let sumSquares = 0;
    let alternatingHigh = 0;
    let previous = 0;
    const length = Number(samples?.length) || 0;
    for (let index = 0; index < length; index += 1) {
      const value = Number(samples[index]);
      if (!Number.isFinite(value)) continue;
      finite += 1;
      const abs = Math.abs(value);
      if (abs > 1e-6) nonZero += 1;
      if (abs > maxAbs) maxAbs = abs;
      if (abs >= 0.999) clipped += 1;
      sum += value;
      sumSquares += value * value;
      if (index > 0 && abs >= 0.5 && Math.abs(previous) >= 0.5 && Math.sign(previous) !== Math.sign(value)) alternatingHigh += 1;
      previous = value;
    }
    const rms = finite > 0 ? Math.sqrt(sumSquares / finite) : 0;
    const crestFactor = rms > 0 ? maxAbs / rms : Infinity;
    // A healthy Kokoro fp32 waveform has a substantial active body and a
    // crest factor in the single digits.  WebGPU failures observed in the
    // field contain full-scale alternating spikes or a sparse waveform with
    // a crest factor above 20; both are perceived as electrical noise.
    const likelyCorrupt = length >= 1024 && (
      finite !== length || clipped > 0 || alternatingHigh >= 4 || (maxAbs >= 0.5 && crestFactor >= 20)
    );
    return {
      maxAbs, nonZero, finite, mean: finite > 0 ? sum / finite : 0, rms, crestFactor,
      clipped, alternatingHigh, likelyCorrupt, audible: maxAbs >= 1e-4 && nonZero > 0,
    };
  }
  function createBrowserModelProvider(options) {
    const config = object(options); const preset = BUILTIN_BROWSER_MODELS[config.modelId];
    if (!preset && config.modelId !== 'custom') throw new ProviderError('unsupported_model', '浏览器模型不在已验证白名单中。');
    if (!preset && (config.trustRemoteCode === true || config.remoteCode === true || config.loaderCode || config.customLoader || config.customHost)) {
      throw new ProviderError('remote_code_forbidden', '自定义模型不允许远程代码、自定义加载器或任意模型主机。');
    }
    const repoId = validateRepoId(preset?.repoId || config.repoId);
    const requestedSource = text(config.source || config.sourceId || config.modelSource || preset?.source || 'modelscope').toLowerCase();
    if (!['modelscope', 'huggingface'].includes(requestedSource)) throw new ProviderError('invalid_model_source', '模型来源无效，请选择魔搭社区或手动 Hugging Face。');
    const sourceInfo = browserModelManifest?.source
      ? browserModelManifest.source(requestedSource)
      : { id: requestedSource === 'huggingface' ? 'huggingface' : 'modelscope', label: requestedSource === 'huggingface' ? 'Hugging Face（手动备用）' : '魔搭社区', revision: requestedSource === 'huggingface' ? preset?.hfRevision : preset?.revision, host: requestedSource === 'huggingface' ? 'https://huggingface.co/' : 'https://www.modelscope.cn/models/', remotePathTemplate: '{model}/resolve/{revision}/' };
    const revision = text(config.revision || sourceInfo.revision || 'main');
    if (!/^[A-Za-z0-9._/-]{1,160}$/.test(revision) || revision.includes('..')) throw new ProviderError('invalid_model_revision', '模型 revision 无效。');
    if (!preset && !/^[a-f0-9]{40}$/i.test(revision)) throw new ProviderError('unpinned_model_revision', '实验性自定义模型必须填写完整的 40 位 commit revision。');
    const pipelineFactory = config.pipelineFactory;
    let pipelinePromise = null;
    let resolvedDevice = config.device === 'wasm' ? 'wasm' : 'webgpu';
    let fallbackReason = '';
    const selectedVariant = () => browserModelManifest?.variant
      ? browserModelManifest.variant(config.variant || config.dtype || 'auto', resolvedDevice)
      : { id: text(config.variant || 'auto') || 'auto', dtype: text(config.dtype || 'fp32') || 'fp32', estimatedBytes: Number(preset?.estimatedBytes || 0) };
    let variantInfo = selectedVariant();
    let cacheKey = browserModelManifest?.modelKey
      ? browserModelManifest.modelKey({ repoId, revision, source: sourceInfo.id, variant: config.variant || 'auto', device: config.device })
      : `flowloud-model-${repoId}@${revision}`;
    const voiceCatalog = browserModelManifest?.VOICE_CATALOG || ['zf_001', 'zf_002', 'zm_009', 'zm_010'].map((id) => ({ id, name: id, label: id, lang: preset?.lang || 'zh-CN', language: 'zh-CN', gender: id.startsWith('zf_') ? 'female' : 'male', path: `voices/${id}.bin` }));
    const voiceById = browserModelManifest?.VOICE_BY_ID || Object.fromEntries(voiceCatalog.map((voice) => [voice.id, voice]));
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
        const activeVariant = selectedVariant();
        variantInfo = activeVariant;
        cacheKey = browserModelManifest?.modelKey
          ? browserModelManifest.modelKey({ repoId, revision, source: sourceInfo.id, variant: activeVariant.id, device: resolvedDevice })
          : cacheKey;
        const baseOptions = {
          revision,
          dtype: text(activeVariant.dtype || (resolvedDevice === 'wasm' ? 'q8' : 'fp16')),
          variant: activeVariant.id,
          source: sourceInfo.id,
          sourceInfo,
          cacheKey,
          concurrency: Math.max(1, Math.min(4, Number(config.downloadConcurrency) || 4)),
          progress_callback: onProgress,
          flowloudOffline: controls.offline === true,
          signal: controls.signal,
          starterVoiceIds: Array.isArray(config.starterVoiceIds) ? config.starterVoiceIds.slice() : [],
          ensureStarterVoices: controls.ensureStarterVoices === true,
        };
        try {
          return await pipelineFactory('text-to-speech', repoId, Object.assign({}, baseOptions, { device: resolvedDevice }));
        } catch (error) {
          if (resolvedDevice !== 'webgpu' || config.allowWasmFallback === false) throw error;
          fallbackReason = String(error?.message || error?.code || 'WebGPU 初始化失败');
          resolvedDevice = 'wasm';
          variantInfo = selectedVariant();
          cacheKey = browserModelManifest?.modelKey
            ? browserModelManifest.modelKey({ repoId, revision, source: sourceInfo.id, variant: variantInfo.id, device: resolvedDevice })
            : cacheKey;
          return pipelineFactory('text-to-speech', repoId, Object.assign({}, baseOptions, {
            device: 'wasm', dtype: variantInfo.dtype, variant: variantInfo.id, cacheKey,
          }));
        }
      })();
      return pipelinePromise;
    }
    let wasmFallbackPromise = null;
    async function fallbackToWasm(reason) {
      if (resolvedDevice !== 'webgpu' || config.allowWasmFallback === false) return false;
      if (!wasmFallbackPromise) {
        wasmFallbackPromise = (async () => {
          fallbackReason = text(reason) || 'WebGPU 合成输出异常';
          // The pipeline has already finished the current inference by the
          // time this is called. Drop the cached promise before rebuilding;
          // disposing a failed WebGPU graph can itself tear down the MV3
          // offscreen document on affected Edge/ORT combinations.
          pipelinePromise = null;
          resolvedDevice = 'wasm';
          variantInfo = selectedVariant();
          cacheKey = browserModelManifest?.modelKey
            ? browserModelManifest.modelKey({ repoId, revision, source: sourceInfo.id, variant: variantInfo.id, device: resolvedDevice })
            : cacheKey;
          return true;
        })();
      }
      const pending = wasmFallbackPromise;
      try { return await pending; }
      finally { if (wasmFallbackPromise === pending) wasmFallbackPromise = null; }
    }
    async function generateAudio(textValue, voice, operation) {
      const controls = object(operation);
      let engine = await getPipeline(controls.onProgress, {
        signal: controls.signal,
        offline: controls.offline === true,
      });
      let output = await engine(textValue, { speaker_embeddings: voice });
      let samples = output && (output.audio || output.waveform);
      let signal = audioSignal(samples);
      // Some WebGPU/ORT combinations complete successfully but return a
      // clipped, sparse waveform (which is heard as static). Treat that as a
      // backend failure and retry once on the known-stable WASM path.
      if (resolvedDevice === 'webgpu' && (!signal.audible || signal.likelyCorrupt) && config.allowWasmFallback !== false) {
        await fallbackToWasm(`WebGPU 音频输出异常（峰值 ${signal.maxAbs.toFixed(3)}、RMS ${signal.rms.toFixed(3)}、削波 ${signal.clipped}）`);
        engine = await getPipeline(controls.onProgress, {
          signal: controls.signal,
          offline: controls.offline === true,
        });
        output = await engine(textValue, { speaker_embeddings: voice });
        samples = output && (output.audio || output.waveform);
        signal = audioSignal(samples);
      }
      if (!samples || !signal.audible) {
        throw new ProviderError('model_silent', '浏览器模型合成结果为静音；请在“语音来源”中选择 fp32 并重新下载。', signal);
      }
      if (signal.likelyCorrupt) {
        throw new ProviderError('model_audio_invalid', '浏览器模型输出异常，疑似音频失真；请切换到 WASM 后重试。', signal);
      }
      return { output, samples, signal };
    }
    async function probe(engine, signal) {
      if (signal?.aborted) throw Object.assign(new Error('模型校验已取消。'), { name: 'AbortError', code: 'cancelled' });
      const sample = preset?.lang === 'en' ? 'Ready.' : '准备就绪。';
      const generated = await generateAudio(sample, preset?.voice || config.voice, { signal, offline: true, engine });
      const samples = generated.samples;
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
      const body = object(request);
      const cached = await cacheExists();
      if (cached === false) {
        throw new ProviderError('model_not_downloaded', '浏览器模型尚未下载并通过离线校验，请先在“语音来源”中下载模型。');
      }
      const selectedVoice = normalizeVoice(body.speaker || body.voice || preset?.voice || config.voice || 'zf_001');
      const selectedVoiceInfo = await voiceInfo(selectedVoice);
      if (selectedVoiceInfo.cached === false) {
        throw new ProviderError('voice_not_downloaded', `音色 ${selectedVoice} 尚未下载，请先在“声音库”中下载或试听该音色。`, { voiceId: selectedVoice });
      }
      const generated = await generateAudio(text(body.text || body.input), selectedVoice, { offline: cached === true, onProgress: object(operation).onProgress, signal: object(operation).signal });
      const output = generated.output; const samples = generated.samples; const samplingRate = Number(output.sampling_rate || output.samplingRate || 24000);
      return { audio: pcmToWav(samples, samplingRate), samplingRate, mimeType: 'audio/wav', providerId: 'browser-model' };
    }
    function normalizeVoice(value) {
      const raw = rawVoiceId('browser-model', value || preset?.voice || 'zf_001');
      if (!voiceById[raw]) throw new ProviderError('voice_unavailable', `浏览器模型没有音色：${raw}。`);
      return raw;
    }
    async function voiceInfo(value) {
      const id = normalizeVoice(value);
      if (typeof pipelineFactory?.voiceInfo === 'function') {
        return Object.assign({}, voiceById[id], await pipelineFactory.voiceInfo(repoId, {
          source: sourceInfo.id, revision, voiceId: id,
        }));
      }
      return Object.assign({}, voiceById[id], { cached: null });
    }
    async function voiceAction(action, operation) {
      const controls = object(operation);
      const id = normalizeVoice(controls.voiceId || controls.voice || controls.request?.voiceId || controls.request?.voice);
      const method = action === 'download' ? 'downloadVoice' : action === 'delete' ? 'deleteVoice' : 'repairVoice';
      if (typeof pipelineFactory?.[method] !== 'function') {
        if (action === 'delete') return { voiceId: id, cached: false, deleted: false };
        throw new ProviderError('voice_cache_unavailable', '当前构建不支持单独管理浏览器模型音色。');
      }
      return Object.assign({ voiceId: id }, await pipelineFactory[method](repoId, {
        source: sourceInfo.id, revision, variant: variantInfo.id, dtype: variantInfo.dtype,
        device: resolvedDevice, concurrency: config.downloadConcurrency,
        voiceId: id, signal: controls.signal,
        onProgress: controls.onProgress,
      }));
    }
    const modelManagement = Object.freeze({
      info: async () => {
        const cached = await cacheExists();
        const transientState = ['downloading', 'verifying', 'cancelled'].includes(modelState);
        const state = transientState
          ? modelState
          : cached === false ? 'missing' : modelState === 'missing' && cached === true ? 'available-unverified' : modelState;
        return { cacheId: cacheKey, cacheKey, modelId: text(config.modelId), repoId, revision, source: sourceInfo.id, sourceLabel: sourceInfo.label, manualOnlySource: sourceInfo.manualOnly === true, variant: variantInfo.id, variantLabel: variantInfo.label, license: preset?.license || '由模型仓库声明', estimatedBytes: Number(variantInfo.estimatedBytes || preset?.estimatedBytes || 0), cached: cached == null ? modelState === 'ready' : cached, state, ready: state === 'ready', verifiedAt, runtimeVersion: text(config.runtimeVersion || 'transformers-js-bundled'), device: resolvedDevice, fallbackReason, concurrency: Math.max(1, Math.min(4, Number(config.downloadConcurrency) || 4)), voiceCount: voiceCatalog.length, starterVoiceIds: browserModelManifest?.STARTER_VOICE_IDS || ['zf_001', 'zf_002', 'zm_009', 'zm_010'] };
      },
      download: async (operation) => {
        const controls = object(operation);
        const controller = new AbortController();
        activeDownload = controller;
        if (controls.signal?.aborted) controller.abort();
        else controls.signal?.addEventListener?.('abort', () => controller.abort(), { once: true });
        modelState = 'downloading';
        try {
          await getPipeline(controls.onProgress, {
            signal: controller.signal, forceNew: true, offline: false, ensureStarterVoices: true,
          });
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
          return { downloaded: true, ready: true, state: 'ready', cacheId: cacheKey, cacheKey, modelId: text(config.modelId), repoId, revision, source: sourceInfo.id, sourceLabel: sourceInfo.label, variant: variantInfo.id, variantLabel: variantInfo.label, license: preset?.license || '由模型仓库声明', estimatedBytes: Number(variantInfo.estimatedBytes || preset?.estimatedBytes || 0), device: resolvedDevice, fallbackReason, verifiedAt, downloadedAt: new Date().toISOString(), runtimeVersion: text(config.runtimeVersion || 'transformers-js-bundled'), concurrency: Math.max(1, Math.min(4, Number(config.downloadConcurrency) || 4)) };
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
          await pipelineFactory.deleteCache(repoId, revision, { source: sourceInfo.id, variant: variantInfo.id, cacheKey });
        }
        modelState = 'missing'; verifiedAt = '';
        return { deleted, cacheId: cacheKey, state: modelState };
      },
      voiceCatalog: async () => voiceCatalog.map((voice) => Object.assign({}, voice)),
      voices: async (operation) => Promise.all(voiceCatalog.map((voice) => voiceInfo(voice.id).then((info) => Object.assign({ id: voiceId('browser-model', voice.id), voiceId: voice.id, name: voice.name || voice.id, label: voice.label || voice.name || voice.id, lang: voice.lang || voice.language || preset?.lang || '', providerId: 'browser-model' }, info)))),
      voiceInfo: async (operation) => voiceInfo(object(operation).voiceId || object(operation).voice),
      voiceDownload: async (operation) => voiceAction('download', operation),
      voiceDelete: async (operation) => voiceAction('delete', operation),
      voiceRepair: async (operation) => voiceAction('repair', operation),
      'voice-list': async () => ({ voices: await Promise.all(voiceCatalog.map((voice) => voiceInfo(voice.id).then((info) => Object.assign({ id: voiceId('browser-model', voice.id), voiceId: voice.id, name: voice.name || voice.id, label: voice.label || voice.name || voice.id, lang: voice.lang || voice.language || preset?.lang || '', providerId: 'browser-model' }, info)))) }),
      'voice-info': async (operation) => voiceInfo(object(operation).voiceId || object(operation).voice),
      'voice-download': async (operation) => voiceAction('download', operation),
      'voice-delete': async (operation) => voiceAction('delete', operation),
      'voice-repair': async (operation) => voiceAction('repair', operation),
      'voice:list': async (operation) => voiceCatalog.map((voice) => Object.assign({}, voice)),
      'voice:download': async (operation) => voiceAction('download', operation),
      'voice:delete': async (operation) => voiceAction('delete', operation),
      'voice:repair': async (operation) => voiceAction('repair', operation),
    });
    return normalizeProvider({ id: 'browser-model', version: 3,
      capabilities: { health: true, voices: true, synthesize: true, cancel: true, modelManagement: true, safeRate: false },
      health: async (operation) => Object.assign({ ok: true, providerId: 'browser-model' }, await verify(operation)),
      voices: async (operation) => modelManagement.voices(operation),
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
