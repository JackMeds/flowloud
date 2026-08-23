(function providerCoreModule(root, factory) {
  const exported = factory();
  if (typeof module === 'object' && module.exports) module.exports = exported;
  root.FlowloudProviderCore = exported;
}(typeof globalThis !== 'undefined' ? globalThis : this, function makeProviderCore() {
  'use strict';

  const RETRYABLE_CODES = new Set([
    'network_error', 'timeout', 'service_unavailable', 'offscreen_unavailable',
    'http_408', 'http_425', 'http_429', 'http_500', 'http_502', 'http_503', 'http_504',
  ]);

  function object(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
  function text(value) { return String(value == null ? '' : value).trim(); }
  function requestIdOf(request, operation) {
    return text(object(request).requestId || object(request).request_id || object(operation).requestId);
  }

  class ProviderError extends Error {
    constructor(code, message, details) {
      super(message || code || 'Provider 请求失败。');
      this.name = 'ProviderError';
      this.code = text(code) || 'provider_error';
      const context = object(details);
      this.stage = text(context.stage || context.operation) || 'provider';
      this.providerId = text(context.providerId);
      this.requestId = text(context.requestId);
      this.retryable = context.retryable == null ? RETRYABLE_CODES.has(this.code) : Boolean(context.retryable);
      if (context.status != null) this.status = Number(context.status) || 0;
      if (context.cause) this.cause = context.cause;
    }

    toJSON() {
      return {
        stage: this.stage, code: this.code, message: this.message, retryable: this.retryable,
        providerId: this.providerId, requestId: this.requestId,
        ...(this.status ? { status: this.status } : {}),
      };
    }
  }

  function structuredError(error, context) {
    if (error instanceof ProviderError) return error;
    const source = object(error);
    const code = source.name === 'AbortError' ? 'cancelled' : text(source.code) || 'provider_error';
    return new ProviderError(code, text(source.message) || 'Provider 请求失败。', Object.assign({}, object(context), {
      retryable: source.name === 'AbortError' ? false : source.retryable,
      status: source.status, cause: error,
    }));
  }

  function createLinkedController(signal) {
    const controller = new AbortController();
    if (signal?.aborted) controller.abort(signal.reason);
    else signal?.addEventListener?.('abort', () => controller.abort(signal.reason), { once: true });
    return controller;
  }

  function createRegistry(options) {
    const config = object(options);
    const methods = Array.isArray(config.methods) ? config.methods.map(String) : [];
    const providers = new Map();
    function normalize(provider) {
      const source = object(provider);
      const id = text(source.id);
      if (!/^[a-z0-9][a-z0-9._-]*$/iu.test(id)) throw new TypeError('Provider id 无效。');
      const capabilities = Object.assign({}, object(source.capabilities));
      for (const method of methods) {
        if (capabilities[method] == null) capabilities[method] = typeof source[method] === 'function';
        if (capabilities[method] && typeof source[method] !== 'function') {
          throw new TypeError(`Provider ${id} 声明了 ${method} 能力但未实现。`);
        }
      }
      return Object.freeze(Object.assign({}, source, { id, capabilities: Object.freeze(capabilities) }));
    }
    function register(provider, registration) {
      const normalized = normalize(provider);
      if (providers.has(normalized.id) && !object(registration).replace) {
        throw new ProviderError('provider_exists', `Provider 已注册：${normalized.id}`, { providerId: normalized.id, retryable: false });
      }
      providers.set(normalized.id, normalized);
      return normalized;
    }
    function select(query) {
      const request = typeof query === 'string' ? { providerId: query } : object(query);
      const id = text(request.providerId);
      const provider = providers.get(id);
      if (!provider) throw new ProviderError('provider_unavailable', `未找到 Provider：${id}`, { providerId: id, stage: 'select', retryable: false });
      const missing = (Array.isArray(request.requiredCapabilities) ? request.requiredCapabilities : [])
        .filter((capability) => !provider.capabilities[String(capability)]);
      if (missing.length) throw new ProviderError('capability_mismatch', `当前 Provider 不支持：${missing.join('、')}`, { providerId: id, stage: 'select', retryable: false });
      return provider;
    }
    for (const provider of (Array.isArray(config.providers) ? config.providers : [])) register(provider);
    return Object.freeze({ register, select, get: (id) => providers.get(String(id)) || null, list: () => Array.from(providers.values()) });
  }

  async function parseJson(response, context) {
    const raw = await response.text();
    if (!raw) return {};
    try { return JSON.parse(raw); } catch (_) {
      throw new ProviderError('invalid_response', '服务返回了无法解析的 JSON。', Object.assign({}, context, { retryable: false }));
    }
  }

  async function checkedFetch(fetchImpl, url, init, context) {
    let response;
    try { response = await fetchImpl(url, init); }
    catch (error) {
      if (error?.name === 'AbortError') throw error;
      throw new ProviderError('network_error', '无法连接所选服务。', Object.assign({}, context, { cause: error }));
    }
    if (response.ok) return response;
    let detail = '';
    try {
      const payload = await response.clone().json();
      detail = text(payload?.error?.message || payload?.message || payload?.error);
    } catch (_) {}
    const status = Number(response.status) || 0;
    const messages = { 401: '认证失败，请检查凭据。', 403: '服务拒绝访问。', 404: '服务端点或模型不存在。', 413: '输入超过服务限制。', 429: '请求过多或额度不足。' };
    throw new ProviderError(`http_${status}`, detail || messages[status] || `服务返回 HTTP ${status}。`, Object.assign({}, context, { status }));
  }

  return Object.freeze({
    RETRYABLE_CODES, ProviderError, object, text, requestIdOf, structuredError,
    createLinkedController, createRegistry, parseJson, checkedFetch,
  });
}));
