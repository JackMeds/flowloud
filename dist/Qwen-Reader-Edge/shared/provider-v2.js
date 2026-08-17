(function providerV2Module(root, factory) {
  const apiModule = root.QwenReaderApiClient || (typeof require === 'function'
    ? require('./api-client.js') : null);
  const exported = factory(apiModule, root.QwenReaderDefaults || {});
  if (typeof module === 'object' && module.exports) module.exports = exported;
  root.QwenReaderProviderV2 = exported;
}(typeof globalThis !== 'undefined' ? globalThis : this, function makeProviderV2(apiModule, defaults) {
  'use strict';

  const PROVIDER_VERSION = 2;
  const DEFAULT_PROVIDER_ID = 'local-qwen';
  const DEFAULT_BASE_URL = 'http://127.0.0.1:7811';
  const DEFAULT_MODEL = 'qwen3-tts-1.7b-base';
  const DEFAULT_RESPONSE_FORMAT = 'wav';
  const CLIENT_HEADER = 'qwen-reader-extension-v1';
  const CAPABILITY_NAMES = Object.freeze([
    'health',
    'voices',
    'synthesize',
    'stream',
    'cancel',
    'transportStreaming',
    'progressivePlayback',
    'backendIncrementalGeneration',
  ]);

  const LOCAL_CAPABILITIES = Object.freeze({
    health: true,
    voices: true,
    synthesize: true,
    cancel: true,
    // qwentts.cpp currently returns one synthesized WAV through a streaming
    // HTTP response. This is useful for transport backpressure, but it is not
    // backend token streaming and should not be presented as progressive PCM.
    stream: true,
    transportStreaming: true,
    progressivePlayback: false,
    backendIncrementalGeneration: false,
  });

  let requestSequence = 0;

  function isObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function text(value) {
    return String(value == null ? '' : value).trim();
  }

  function number(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function signalFrom(value) {
    if (value && typeof value.aborted === 'boolean') return value;
    if (value && value.signal && typeof value.signal.aborted === 'boolean') return value.signal;
    return undefined;
  }

  function optionsFrom(value) {
    if (value && typeof value.aborted === 'boolean') return { signal: value };
    return isObject(value) ? value : {};
  }

  function requestIdFrom(request, options) {
    const body = isObject(request) ? request : {};
    const config = optionsFrom(options);
    const candidate = text(body.requestId || body.request_id || config.requestId);
    if (candidate) return candidate;
    requestSequence += 1;
    return `provider-v2-${Date.now().toString(36)}-${requestSequence.toString(36)}`;
  }

  function normalizeLocalBaseUrl(value) {
    const candidate = text(value) || DEFAULT_BASE_URL;
    let parsed;
    try {
      parsed = new URL(candidate);
    } catch (_) {
      throw new TypeError('本地 TTS 地址必须是 http://127.0.0.1:7811。');
    }
    if (parsed.origin !== DEFAULT_BASE_URL || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new TypeError('本地 TTS 地址必须是 http://127.0.0.1:7811。');
    }
    return parsed.origin;
  }

  function capabilityKeys(value) {
    if (Array.isArray(value)) return value.map(text).filter(Boolean);
    if (!isObject(value)) return [];
    return Object.keys(value).filter((key) => value[key]);
  }

  function normalizeCapabilities(value) {
    const result = {};
    for (const name of CAPABILITY_NAMES) result[name] = false;
    if (Array.isArray(value)) {
      for (const key of capabilityKeys(value)) {
        if (Object.prototype.hasOwnProperty.call(result, key)) result[key] = true;
      }
      return Object.freeze(result);
    }
    if (!isObject(value)) return Object.freeze(result);
    for (const name of CAPABILITY_NAMES) {
      if (Object.prototype.hasOwnProperty.call(value, name)) result[name] = Boolean(value[name]);
    }
    // These aliases make capability negotiation tolerant of providers that
    // use the names from the browser streaming APIs.
    if (Object.prototype.hasOwnProperty.call(value, 'supportsStream')) result.stream = Boolean(value.supportsStream);
    if (Object.prototype.hasOwnProperty.call(value, 'streaming')) result.transportStreaming = Boolean(value.streaming);
    if (Object.prototype.hasOwnProperty.call(value, 'progressive')) result.progressivePlayback = Boolean(value.progressive);
    if (Object.prototype.hasOwnProperty.call(value, 'incremental')) result.backendIncrementalGeneration = Boolean(value.incremental);
    return Object.freeze(result);
  }

  function capabilityList(value) {
    const normalized = normalizeCapabilities(value);
    return CAPABILITY_NAMES.filter((name) => normalized[name]);
  }

  function mergeCapabilities(base, override) {
    const result = Object.assign({}, normalizeCapabilities(base));
    if (Array.isArray(override)) {
      for (const name of CAPABILITY_NAMES) result[name] = override.includes(name);
      return Object.freeze(result);
    }
    if (isObject(override)) {
      const normalized = normalizeCapabilities(override);
      for (const name of CAPABILITY_NAMES) {
        if (Object.prototype.hasOwnProperty.call(override, name)) result[name] = normalized[name];
      }
      if (Object.prototype.hasOwnProperty.call(override, 'supportsStream')) result.stream = normalized.stream;
      if (Object.prototype.hasOwnProperty.call(override, 'streaming')) result.transportStreaming = normalized.transportStreaming;
      if (Object.prototype.hasOwnProperty.call(override, 'progressive')) result.progressivePlayback = normalized.progressivePlayback;
      if (Object.prototype.hasOwnProperty.call(override, 'incremental')) result.backendIncrementalGeneration = normalized.backendIncrementalGeneration;
    }
    return Object.freeze(result);
  }

  function requiredCapabilityNames(value) {
    if (Array.isArray(value)) {
      return [...new Set(value.map(text).filter(Boolean))];
    }
    if (isObject(value)) {
      return Object.keys(value).filter((name) => Boolean(value[name]));
    }
    if (typeof value === 'string') return [value.trim()].filter(Boolean);
    return [];
  }

  function negotiateCapabilities(provider, required) {
    const source = provider && typeof provider === 'object' ? provider : {};
    const capabilities = normalizeCapabilities(source.capabilities);
    const requested = required && isObject(required) && required.requiredCapabilities
      ? required.requiredCapabilities
      : required;
    const names = requiredCapabilityNames(requested);
    const missing = names.filter((name) => !capabilities[name]);
    return Object.freeze({
      ok: missing.length === 0,
      providerId: text(source.id),
      providerVersion: source.version == null ? null : source.version,
      requested: Object.freeze(names.slice()),
      supported: Object.freeze(capabilityList(capabilities)),
      missing: Object.freeze(missing),
      capabilities,
    });
  }

  function effectiveCapabilities(provider, health) {
    const source = provider && typeof provider === 'object' ? provider : {};
    const payload = health && isObject(health) ? health : {};
    return mergeCapabilities(source.capabilities, payload.capabilities);
  }

  const DEFAULT_MESSAGES = Object.freeze({
    cancelled: '朗读已取消。',
    timeout: '本地 TTS 服务响应超时。',
    network_error: '无法连接本地 Qwen TTS 服务。',
    invalid_input: '朗读内容不能为空。',
    invalid_response: '本地 TTS 服务返回了无效数据。',
    duplicate_request: '重复的朗读请求。',
    capability_mismatch: '当前 TTS 提供方不支持所需能力。',
    provider_unavailable: '当前 TTS 提供方不可用。',
    unknown_error: '本地朗读服务发生未知错误。',
  });

  class ProviderError extends Error {
    constructor(code, message, details) {
      const info = isObject(details) ? details : {};
      super(text(message) || DEFAULT_MESSAGES[code] || code || DEFAULT_MESSAGES.unknown_error);
      this.name = 'ProviderError';
      this.code = text(code) || 'provider_error';
      this.providerId = text(info.providerId);
      this.operation = text(info.operation);
      this.requestId = text(info.requestId);
      this.status = number(info.status, 0);
      this.retriable = info.retriable == null ? defaultRetriable(this.code, this.status) : Boolean(info.retriable);
      if (info.details !== undefined) this.details = info.details;
      if (info.cause !== undefined) this.cause = info.cause;
    }

    toJSON() {
      const payload = {
        code: this.code,
        message: this.message,
        providerId: this.providerId || undefined,
        operation: this.operation || undefined,
        requestId: this.requestId || undefined,
        status: this.status || undefined,
        retriable: this.retriable,
      };
      if (this.details !== undefined) payload.details = this.details;
      return payload;
    }
  }

  function defaultRetriable(code, status) {
    if (code === 'cancelled' || code === 'invalid_input' || code === 'invalid_voice') return false;
    if (code === 'network_error' || code === 'timeout' || code === 'offscreen_unavailable') return true;
    if (status === 408 || status === 425 || status === 429 || status >= 500) return true;
    return /^http_5\d\d$/.test(code);
  }

  function rawErrorCode(error) {
    return text(error && (error.code || error.error || error.name));
  }

  function normalizeProviderError(error, context) {
    const info = isObject(context) ? context : {};
    if (error instanceof ProviderError) {
      return new ProviderError(error.code, error.message, Object.assign({}, info, {
        providerId: info.providerId || error.providerId,
        operation: info.operation || error.operation,
        requestId: info.requestId || error.requestId,
        status: info.status || error.status,
        retriable: info.retriable == null ? error.retriable : info.retriable,
        details: info.details === undefined ? error.details : info.details,
        cause: info.cause === undefined ? error.cause : info.cause,
      }));
    }
    const status = number(error && error.status, number(info.status, 0));
    const rawCode = rawErrorCode(error).toLowerCase();
    let code = rawCode;
    if (!code || code === 'error') code = 'unknown_error';
    else if (code === 'typeerror' && status === 0) code = 'network_error';
    if (error && error.name === 'AbortError' || code === 'aborterror' || code === 'aborted') code = 'cancelled';
    else if (code === 'network' || code === 'fetch_error' || code === 'failed_to_fetch') code = 'network_error';
    else if (code === 'timeout_error') code = 'timeout';
    else if (status >= 400 && status <= 599 && !/^http_\d+$/.test(code)) code = `http_${status}`;
    const message = text(error && error.message) || DEFAULT_MESSAGES[code] || DEFAULT_MESSAGES.unknown_error;
    return new ProviderError(code, message, Object.assign({}, info, {
      status,
      cause: error,
      retriable: info.retriable == null ? defaultRetriable(code, status) : info.retriable,
    }));
  }

  function voiceName(value) {
    if (typeof value === 'string') return text(value);
    if (!isObject(value)) return '';
    return text(value.name || value.id || value.voice || value.label);
  }

  function normalizeVoice(value, providerId) {
    const name = voiceName(value);
    if (!name) return null;
    const source = typeof value === 'string' ? {} : value;
    return Object.assign({}, source, {
      id: text(source.id) || name,
      name,
      label: text(source.label) || name,
      providerId: text(source.providerId) || providerId || '',
      source: text(source.source) || 'provider',
    });
  }

  function normalizeHealth(value, context) {
    const source = isObject(value) ? value : {};
    const info = isObject(context) ? context : {};
    const gateway = text(source.gateway || source.status || source.state);
    const backend = text(source.backend || source.backendStatus || source.backend_state);
    const providerStatus = text(
      source.providerStatus || source.provider_status || source.healthStatus || source.health_status,
    );
    const ok = source.ok == null
      ? !['stopped', 'error', 'failed', 'unavailable'].includes(gateway.toLowerCase())
      : Boolean(source.ok);
    const rawBackendPid = source.backendPid ?? source.backend_pid ?? null;
    const backendPid = Number(rawBackendPid);
    const backendReady = ['loaded', 'ready', 'running'].includes(backend.toLowerCase());
    const hasPositiveBackendPid = Number.isFinite(backendPid) && backendPid > 0;
    // PID 0 is the gateway sentinel for an unloaded backend, not a running
    // process. Preserve an explicit provider result; only inferred readiness
    // depends on backend state or a real positive process ID.
    const ready = source.ready == null
      ? backendReady || hasPositiveBackendPid
      : Boolean(source.ready);
    const dynamicCapabilities = source.capabilities || source.features || source.providerCapabilities;
    const capabilities = mergeCapabilities(info.capabilities, dynamicCapabilities);
    return Object.freeze({
      providerId: text(info.providerId || source.providerId),
      ok,
      ready,
      gateway,
      backend,
      providerStatus,
      healthStatus: providerStatus,
      backendPid: rawBackendPid,
      capabilities,
      checkedAt: new Date().toISOString(),
    });
  }

  function normalizeProvider(provider) {
    if (!isObject(provider)) throw new TypeError('Provider V2 必须是对象。');
    const id = text(provider.id);
    if (!id || !/^[a-z0-9][a-z0-9._-]*$/i.test(id)) throw new TypeError('Provider V2 id 无效。');
    const version = Number(provider.version);
    if (!Number.isFinite(version) || version < PROVIDER_VERSION) throw new TypeError('Provider V2 version 必须为 2 或更高版本。');
    for (const method of ['health', 'voices', 'synthesize', 'stream', 'cancel']) {
      if (typeof provider[method] !== 'function') throw new TypeError(`Provider V2 缺少 ${method}()。`);
    }
    const capabilities = normalizeCapabilities(provider.capabilities);
    return Object.assign({}, provider, { id, version, capabilities });
  }

  function createProviderRegistry(options) {
    const config = isObject(options) ? options : {};
    const providers = new Map();

    function register(provider, registerOptions) {
      const normalized = normalizeProvider(provider);
      const settings = isObject(registerOptions) ? registerOptions : {};
      if (providers.has(normalized.id) && !settings.replace) {
        throw new ProviderError('provider_exists', `Provider 已注册：${normalized.id}`, {
          providerId: normalized.id,
        });
      }
      providers.set(normalized.id, normalized);
      return normalized;
    }

    function unregister(id) {
      return providers.delete(text(id));
    }

    function get(id) {
      return providers.get(text(id)) || null;
    }

    function list() {
      return Array.from(providers.values());
    }

    function inspect() {
      return list().map((provider) => ({
        id: provider.id,
        version: provider.version,
        capabilities: capabilityList(provider.capabilities),
      }));
    }

    function select(selection) {
      const request = typeof selection === 'string' ? { providerId: selection } : (selection || {});
      const requestedId = text(request.providerId || request.id);
      const required = request.requiredCapabilities || request.required || [];
      const candidates = requestedId ? [get(requestedId)].filter(Boolean) : list();
      for (const provider of candidates) {
        const report = negotiateCapabilities(provider, required);
        if (report.ok) return provider;
      }
      if (requestedId && !get(requestedId)) {
        throw new ProviderError('provider_unavailable', `未找到 TTS 提供方：${requestedId}`, {
          providerId: requestedId,
        });
      }
      const reports = candidates.map((provider) => negotiateCapabilities(provider, required));
      const missing = reports.length ? reports[0].missing : requiredCapabilityNames(required);
      throw new ProviderError('capability_mismatch', DEFAULT_MESSAGES.capability_mismatch, {
        providerId: requestedId,
        details: { required: requiredCapabilityNames(required), missing },
      });
    }

    for (const provider of Array.isArray(config.providers) ? config.providers : []) register(provider);
    return Object.freeze({ register, unregister, get, list, inspect, select, negotiate: negotiateCapabilities });
  }

  function migrateProviderConfig(input, options) {
    const source = isObject(input) ? input : {};
    const config = isObject(options) ? options : {};
    const legacyProvider = typeof source.provider === 'string'
      ? source.provider
      : (isObject(source.provider) ? source.provider : {});
    const existingOptions = isObject(source.providerOptions)
      ? source.providerOptions
      : (isObject(source.provider_options) ? source.provider_options : {});
    const providerOptions = isObject(legacyProvider)
      ? Object.assign({}, legacyProvider.options || {}, legacyProvider)
      : {};
    delete providerOptions.id;
    delete providerOptions.version;
    delete providerOptions.options;
    const providerId = text(
      source.providerId || source.provider_id || source.ttsProvider ||
      (typeof source.provider === 'string' ? source.provider : '') ||
      (isObject(source.provider) ? source.provider.id : ''),
    ) || text(config.defaultProviderId) || DEFAULT_PROVIDER_ID;
    const mergedOptions = Object.assign({}, providerOptions, existingOptions);
    const oldBaseUrl = mergedOptions.baseUrl || mergedOptions.apiBaseUrl || source.apiBaseUrl || source.api_base_url;
    let baseUrl = DEFAULT_BASE_URL;
    let warning = '';
    try {
      baseUrl = normalizeLocalBaseUrl(oldBaseUrl || defaults.apiBaseUrl || DEFAULT_BASE_URL);
    } catch (_) {
      warning = 'unsafe_base_url_replaced';
    }
    const model = text(mergedOptions.model || source.model || defaults.model) || DEFAULT_MODEL;
    const responseFormat = text(
      mergedOptions.responseFormat || mergedOptions.response_format || source.responseFormat || source.response_format || defaults.responseFormat,
    ) || DEFAULT_RESPONSE_FORMAT;
    const providerVersion = number(source.providerVersion || source.provider_version, 0);
    const result = Object.assign({}, source);
    result.providerId = providerId;
    result.providerVersion = PROVIDER_VERSION;
    result.providerOptions = Object.assign({}, mergedOptions, {
      baseUrl,
      model,
      responseFormat,
    });
    // Keep legacy keys so v1 readers and settings UIs continue to work while
    // the integration migrates the stored object in place. The known endpoint
    // is intentionally rewritten even when an old value was unsafe: preserving
    // an untrusted apiBaseUrl here would let a legacy caller bypass localhost.
    result.apiBaseUrl = baseUrl;
    result.model = model;
    result.responseFormat = responseFormat;
    result.providerMigration = source.providerMigration || {
      fromVersion: providerVersion || 1,
      toVersion: PROVIDER_VERSION,
    };
    if (warning) {
      const prior = Array.isArray(source.providerMigrationWarnings) ? source.providerMigrationWarnings : [];
      result.providerMigrationWarnings = [...new Set([...prior, warning])];
    }
    return result;
  }

  function toBytes(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return null;
  }

  async function blobBytes(value) {
    const bytes = toBytes(value);
    if (bytes) return bytes;
    if (value && typeof value.arrayBuffer === 'function') return new Uint8Array(await value.arrayBuffer());
    return null;
  }

  async function* readChunkSource(source) {
    if (!source) return;
    if (typeof source.getReader === 'function') {
      const reader = source.getReader();
      try {
        while (true) {
          const item = await reader.read();
          if (item.done) break;
          yield item.value;
        }
      } finally {
        if (typeof reader.releaseLock === 'function') reader.releaseLock();
      }
      return;
    }
    if (typeof source[Symbol.asyncIterator] === 'function') {
      for await (const value of source) yield value;
      return;
    }
    if (Array.isArray(source)) {
      for (const value of source) yield value;
    }
  }

  function streamEvent(value, context, sequence, final) {
    const bytes = toBytes(value) || new Uint8Array(0);
    return Object.freeze({
      type: final ? 'end' : 'data',
      data: bytes,
      chunk: bytes,
      sequence,
      final: Boolean(final),
      requestId: context.requestId,
      providerId: context.providerId,
      mimeType: context.mimeType || 'audio/wav',
    });
  }

  function createLocalQwenProvider(options) {
    const config = isObject(options) ? options : {};
    const settings = migrateProviderConfig(config.settings || config);
    const providerOptions = settings.providerOptions || {};
    const baseUrl = normalizeLocalBaseUrl(config.baseUrl || providerOptions.baseUrl || DEFAULT_BASE_URL);
    const model = text(config.model || providerOptions.model) || DEFAULT_MODEL;
    const responseFormat = text(config.responseFormat || providerOptions.responseFormat) || DEFAULT_RESPONSE_FORMAT;
    const fetchImpl = config.fetchImpl || globalThis.fetch;
    const enableRemoteCancel = config.enableRemoteCancel === true;
    const forwardExternalSignal = config.forwardExternalSignal === true;
    const client = config.api || (apiModule && typeof apiModule.createApiClient === 'function'
      ? apiModule.createApiClient({ baseUrl, fetchImpl, storage: config.storage })
      : null);
    if (!client) throw new TypeError('缺少本地 Qwen API 客户端。');
    const operations = new Map();

    function begin(request, options, operation) {
      const requestId = requestIdFrom(request, options);
      if (operations.has(requestId)) {
        throw new ProviderError('duplicate_request', DEFAULT_MESSAGES.duplicate_request, {
          providerId: DEFAULT_PROVIDER_ID,
          operation,
          requestId,
        });
      }
      const metadata = {
        clientId: text(options && options.clientId) || text(request && (request.clientId || request.client_id)),
        playbackId: text(options && options.playbackId) || text(request && (request.playbackId || request.playback_id)),
        sessionId: text(options && options.sessionId) || text(request && (request.sessionId || request.session_id)),
      };
      const controller = new AbortController();
      const external = signalFrom(options);
      const onAbort = () => controller.abort();
      if (external) {
        if (external.aborted) controller.abort();
        else if (typeof external.addEventListener === 'function') external.addEventListener('abort', onAbort, { once: true });
      }
      const record = {
        requestId,
        controller,
        signal: forwardExternalSignal && external ? external : controller.signal,
        external,
        onAbort,
        operation,
        metadata,
      };
      operations.set(requestId, record);
      return record;
    }

    function finish(record) {
      if (!record) return;
      if (record.external && typeof record.external.removeEventListener === 'function') {
        record.external.removeEventListener('abort', record.onAbort);
      }
      if (operations.get(record.requestId) === record) operations.delete(record.requestId);
    }

    function providerContext(record) {
      return { providerId: DEFAULT_PROVIDER_ID, requestId: record && record.requestId };
    }

    async function health(optionsOrSignal) {
      const options = optionsFrom(optionsOrSignal);
      try {
        if (typeof client.status !== 'function') {
          return normalizeHealth({ gateway: 'unknown' }, {
            providerId: DEFAULT_PROVIDER_ID,
            capabilities: LOCAL_CAPABILITIES,
          });
        }
        const payload = await client.status(signalFrom(options));
        const streamState = typeof client.streamCapability === 'function'
          ? client.streamCapability()
          : '';
        const dynamic = isObject(payload && payload.capabilities)
          ? Object.assign({}, payload.capabilities)
          : {};
        if (streamState === 'supported') {
          dynamic.stream = true;
          dynamic.transportStreaming = true;
        } else if (streamState === 'unsupported') {
          dynamic.stream = false;
          dynamic.transportStreaming = false;
        }
        return normalizeHealth(payload, {
          providerId: DEFAULT_PROVIDER_ID,
          capabilities: mergeCapabilities(LOCAL_CAPABILITIES, dynamic),
        });
      } catch (error) {
        throw normalizeProviderError(error, { providerId: DEFAULT_PROVIDER_ID, operation: 'health' });
      }
    }

    async function voices(optionsOrSignal) {
      const options = optionsFrom(optionsOrSignal);
      try {
        const payload = await client.voices(signalFrom(options));
        const values = Array.isArray(payload) ? payload : (payload && Array.isArray(payload.voices) ? payload.voices : []);
        return values.map((voice) => normalizeVoice(voice, DEFAULT_PROVIDER_ID)).filter(Boolean);
      } catch (error) {
        throw normalizeProviderError(error, { providerId: DEFAULT_PROVIDER_ID, operation: 'voices' });
      }
    }

    async function synthesize(request, optionsOrSignal) {
      const requestBody = isObject(request) ? request : {};
      const options = optionsFrom(optionsOrSignal);
      const input = text(requestBody.input || requestBody.text);
      if (!input) throw new ProviderError('invalid_input', DEFAULT_MESSAGES.invalid_input, {
        providerId: DEFAULT_PROVIDER_ID,
        operation: 'synthesize',
      });
      const record = begin(requestBody, options, 'synthesize');
      try {
        const result = await client.synthesize(Object.assign({}, requestBody, {
          input,
          model: text(requestBody.model) || model,
          response_format: text(requestBody.response_format || requestBody.responseFormat) || responseFormat,
        }), record.signal);
        if (record.controller.signal.aborted) throw Object.assign(new Error(DEFAULT_MESSAGES.cancelled), { name: 'AbortError' });
        const blob = result && typeof Blob !== 'undefined' && result.blob instanceof Blob
          ? result.blob
          : (result && typeof Blob !== 'undefined' && result.audio instanceof Blob ? result.audio : null);
        const audio = blob || (result && result.audio);
        if (!audio) throw new ProviderError('invalid_response', DEFAULT_MESSAGES.invalid_response, providerContext(record));
        return Object.assign({}, result, {
          providerId: DEFAULT_PROVIDER_ID,
          requestId: record.requestId,
          blob: blob || undefined,
          audio,
          mimeType: text(result && result.mimeType) || (blob && blob.type) || `audio/${responseFormat}`,
          format: responseFormat,
        });
      } catch (error) {
        throw normalizeProviderError(error, Object.assign(providerContext(record), { operation: 'synthesize' }));
      } finally {
        finish(record);
      }
    }

    async function directStream(requestBody, record) {
      if (typeof fetchImpl !== 'function') return null;
      const response = await fetchImpl(`${baseUrl}/v1/audio/speech/stream`, {
        method: 'POST',
        signal: record.signal,
        headers: {
          'content-type': 'application/json',
          accept: `audio/wav, application/octet-stream`,
          'x-qwen-reader-client': CLIENT_HEADER,
        },
        body: JSON.stringify({
          input: text(requestBody.input || requestBody.text),
          voice: text(requestBody.voice),
          model: text(requestBody.model) || model,
          response_format: text(requestBody.response_format || requestBody.responseFormat) || responseFormat,
          stream: true,
          request_id: record.requestId,
          ...(record.metadata.clientId ? { client_id: record.metadata.clientId } : {}),
          ...(record.metadata.playbackId ? { playback_id: record.metadata.playbackId } : {}),
          ...(record.metadata.sessionId ? { session_id: record.metadata.sessionId } : {}),
        }),
      });
      if (!response.ok) {
        let message = `本地 TTS 服务返回 HTTP ${response.status}。`;
        try {
          const payload = await response.json();
          if (payload && payload.error && payload.error.message) message = text(payload.error.message);
        } catch (_) {
          // Keep the status-based message when the error body is not JSON.
        }
        const unsupported = [404, 405, 415, 501].includes(response.status);
        throw new ProviderError(unsupported ? 'stream_unsupported' : `http_${response.status}`, message, {
          providerId: DEFAULT_PROVIDER_ID,
          operation: 'stream',
          requestId: record.requestId,
          status: response.status,
        });
      }
      const mimeType = text(response.headers && response.headers.get && response.headers.get('content-type')) || `audio/${responseFormat}`;
      if (!response.body || typeof response.body.getReader !== 'function') {
        const bytes = new Uint8Array(await response.arrayBuffer());
        return { chunks: [bytes], mimeType };
      }
      return { reader: response.body.getReader(), mimeType };
    }

    function stream(request, optionsOrSignal) {
      const requestBody = isObject(request) ? request : {};
      const options = optionsFrom(optionsOrSignal);
      const input = text(requestBody.input || requestBody.text);
      const record = begin(requestBody, options, 'stream');
      const provider = this;
      return (async function* streamGenerator() {
        let sequence = 0;
        let mimeType = `audio/${responseFormat}`;
        try {
          if (!input) throw new ProviderError('invalid_input', DEFAULT_MESSAGES.invalid_input, providerContext(record));
          if (record.controller.signal.aborted) {
            throw Object.assign(new Error(DEFAULT_MESSAGES.cancelled), { name: 'AbortError' });
          }
          let source;
          let streamUnsupported = false;
          if (typeof config.streamTransport === 'function') {
            source = await config.streamTransport({
              request: Object.assign({}, requestBody, { input, model, response_format: responseFormat }),
              signal: record.signal,
              requestId: record.requestId,
            });
          } else if (client && typeof client.synthesizeStream === 'function') {
            try {
              source = await client.synthesizeStream(Object.assign({}, requestBody, { input, model, response_format: responseFormat }), record.signal);
            } catch (error) {
              const normalized = normalizeProviderError(error, Object.assign(providerContext(record), { operation: 'stream' }));
              if (normalized.code !== 'stream_unsupported' || config.fallbackToSynthesize === false) throw normalized;
              streamUnsupported = true;
              source = null;
            }
          } else if (client && typeof client.synthesizeStreaming === 'function') {
            try {
              source = await client.synthesizeStreaming(Object.assign({}, requestBody, { input, model, response_format: responseFormat }), record.signal);
            } catch (error) {
              const normalized = normalizeProviderError(error, Object.assign(providerContext(record), { operation: 'stream' }));
              if (normalized.code !== 'stream_unsupported' || config.fallbackToSynthesize === false) throw normalized;
              streamUnsupported = true;
              source = null;
            }
          }
          if (record.controller.signal.aborted) {
            throw Object.assign(new Error(DEFAULT_MESSAGES.cancelled), { name: 'AbortError' });
          }
          if (source) {
            const streamSource = source && source.stream ? source.stream : source;
            if (source && source.mimeType) mimeType = text(source.mimeType) || mimeType;
            for await (const chunk of readChunkSource(streamSource)) {
              if (record.controller.signal.aborted) throw Object.assign(new Error(DEFAULT_MESSAGES.cancelled), { name: 'AbortError' });
              const value = chunk && chunk.data !== undefined ? chunk.data : chunk;
              if (chunk && chunk.mimeType) mimeType = text(chunk.mimeType) || mimeType;
              const bytes = await blobBytes(value);
              if (!bytes || !bytes.byteLength) continue;
              yield streamEvent(bytes, { providerId: DEFAULT_PROVIDER_ID, requestId: record.requestId, mimeType }, sequence++, false);
            }
          } else if (!streamUnsupported && typeof fetchImpl === 'function' && config.disableTransportStreaming !== true) {
            const result = await directStream(Object.assign({}, requestBody, { input }), record);
            mimeType = result.mimeType || mimeType;
            if (result.reader) {
              while (true) {
                const item = await result.reader.read();
                if (item.done) break;
                const bytes = toBytes(item.value);
                if (bytes && bytes.byteLength) {
                  yield streamEvent(bytes, { providerId: DEFAULT_PROVIDER_ID, requestId: record.requestId, mimeType }, sequence++, false);
                }
              }
            } else {
              for (const bytes of result.chunks || []) {
                if (bytes && bytes.byteLength) yield streamEvent(bytes, { providerId: DEFAULT_PROVIDER_ID, requestId: record.requestId, mimeType }, sequence++, false);
              }
            }
          } else {
            const result = await client.synthesize(Object.assign({}, requestBody, {
              input,
              model,
              response_format: responseFormat,
            }), record.signal);
            const bytes = await blobBytes(result && (result.blob || result.audio));
            mimeType = text(result && result.mimeType) || mimeType;
            if (!bytes || !bytes.byteLength) throw new ProviderError('invalid_response', DEFAULT_MESSAGES.invalid_response, providerContext(record));
            yield streamEvent(bytes, { providerId: DEFAULT_PROVIDER_ID, requestId: record.requestId, mimeType }, sequence++, false);
          }
          yield streamEvent(new Uint8Array(0), { providerId: DEFAULT_PROVIDER_ID, requestId: record.requestId, mimeType }, sequence, true);
        } catch (error) {
          throw normalizeProviderError(error, Object.assign(providerContext(record), { operation: 'stream' }));
        } finally {
          finish(record);
        }
      }());
    }

    async function cancel(requestId, optionsOrSignal) {
      const input = isObject(requestId) ? requestId : {};
      const id = text(input.requestId || input.request_id) || text(requestId);
      const cancelOptions = optionsFrom(optionsOrSignal);
      const clientId = text(input.clientId || input.client_id || cancelOptions.clientId);
      const playbackId = text(input.playbackId || input.playback_id);
      const sessionId = text(input.sessionId || input.session_id);
      let record = id ? operations.get(id) : null;
      let identityConflict = false;
      if (record) {
        identityConflict = Boolean(
          (clientId && record.metadata.clientId !== clientId)
          || (playbackId && record.metadata.playbackId !== playbackId)
          || (sessionId && record.metadata.sessionId !== sessionId)
        );
        if (identityConflict) record = null;
      }
      if (!record && !id && (clientId || playbackId || sessionId)) {
        const candidates = Array.from(operations.values()).filter((item) => (
          (!clientId || item.metadata.clientId === clientId)
          && (!playbackId || item.metadata.playbackId === playbackId)
          && (!sessionId || item.metadata.sessionId === sessionId)
        ));
        if (candidates.length === 1) record = candidates[0];
        else if (candidates.length > 1) identityConflict = true;
      }
      if (record) record.controller.abort();

      let remoteCancelled = false;
      const remoteCancel = client && (client.cancelSpeech || client.cancelRequest || client.cancel);
      const remoteRequestId = id || (record && record.requestId) || '';
      const remotePlaybackId = playbackId || (record && record.metadata.playbackId) || '';
      const remoteSessionId = sessionId || (record && record.metadata.sessionId) || '';
      if (!identityConflict && typeof remoteCancel === 'function') {
        try {
          await remoteCancel.call(client, {
            requestId: remoteRequestId,
            clientId: clientId || (record && record.metadata.clientId) || '',
            playbackId: remotePlaybackId,
            sessionId: remoteSessionId,
          }, signalFrom(optionsOrSignal));
          remoteCancelled = true;
        } catch (_) {
          // Remote cancellation is best effort; the local AbortController is authoritative.
        }
      } else if (!identityConflict && enableRemoteCancel && typeof fetchImpl === 'function' && (remoteRequestId || remotePlaybackId)) {
        try {
          const response = await fetchImpl(`${baseUrl}/v1/audio/speech/cancel`, {
            method: 'POST',
            signal: signalFrom(optionsOrSignal),
            headers: {
              'content-type': 'application/json',
              accept: 'application/json',
              'x-qwen-reader-client': CLIENT_HEADER,
            },
            body: JSON.stringify({
              ...(remoteRequestId ? { request_id: remoteRequestId } : {}),
              ...(remotePlaybackId ? { playback_id: remotePlaybackId } : {}),
              ...(remoteSessionId ? { session_id: remoteSessionId } : {}),
            }),
          });
          remoteCancelled = response.ok || response.status === 404;
        } catch (_) {
          // The browser-side abort still stops playback when the gateway is gone.
        }
      }
      return {
        providerId: DEFAULT_PROVIDER_ID,
        requestId: remoteRequestId,
        playbackId: remotePlaybackId,
        cancelled: Boolean(record || remoteCancelled),
        remoteCancelled,
      };
    }

    return {
      id: DEFAULT_PROVIDER_ID,
      version: PROVIDER_VERSION,
      capabilities: LOCAL_CAPABILITIES,
      health,
      voices,
      synthesize,
      stream,
      cancel,
    };
  }

  return Object.freeze({
    PROVIDER_VERSION,
    DEFAULT_PROVIDER_ID,
    DEFAULT_BASE_URL,
    DEFAULT_MODEL,
    DEFAULT_RESPONSE_FORMAT,
    CAPABILITY_NAMES,
    LOCAL_CAPABILITIES,
    ProviderError,
    normalizeCapabilities,
    capabilityList,
    mergeCapabilities,
    negotiateCapabilities,
    effectiveCapabilities,
    normalizeProviderError,
    normalizeVoice,
    normalizeHealth,
    normalizeProvider,
    createProviderRegistry,
    migrateProviderConfig,
    createLocalQwenProvider,
  });
}));
