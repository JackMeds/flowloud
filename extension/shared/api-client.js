(function apiClientModule(root, factory) {
  const exported = factory();
  if (typeof module === 'object' && module.exports) module.exports = exported;
  root.QwenReaderApiClient = exported;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createModule() {
  'use strict';

  const DEFAULT_BASE_URL = 'http://127.0.0.1:7811';
  const MODEL = 'qwen3-tts-1.7b-base';
  const CLIENT_HEADER_VALUE = 'qwen-reader-extension-v1';

  class LocalApiError extends Error {
    constructor(code, message, status) {
      super(message);
      this.name = 'LocalApiError';
      this.code = code;
      this.status = status || 0;
    }
  }

  function normalizeBaseUrl(value) {
    const parsed = new URL(value || DEFAULT_BASE_URL);
    if (parsed.origin !== DEFAULT_BASE_URL) {
      throw new TypeError('本地 TTS 地址必须是 http://127.0.0.1:7811。');
    }
    return parsed.origin;
  }

  function backendGeneration(status) {
    if (!status || typeof status !== 'object') return '';
    const value = status.backendPid
      ?? status.backend_pid
      ?? status.backendGeneration
      ?? status.backend_generation
      ?? status.generation;
    return value == null || value === '' ? '' : String(value);
  }

  async function readError(response) {
    let payload;
    try {
      payload = await response.json();
    } catch (_) {
      payload = null;
    }
    const message = payload && payload.error && payload.error.message
      ? payload.error.message
      : `本地 TTS 服务返回 HTTP ${response.status}。`;
    throw new LocalApiError(`http_${response.status}`, message, response.status);
  }

  function profilePayload(profile) {
    if (!profile || !String(profile.name || '').trim()) {
      throw new LocalApiError('invalid_voice', '音色名称不能为空。');
    }
    const body = {
      name: String(profile.name).trim(),
      ref_text: String(profile.refText || profile.ref_text || ''),
    };
    if (profile.wavB64 || profile.wav_b64) body.wav_b64 = profile.wavB64 || profile.wav_b64;
    if (profile.spkB64 || profile.spk_b64) body.spk_b64 = profile.spkB64 || profile.spk_b64;
    if (profile.rvqB64 || profile.rvq_b64) body.rvq_b64 = profile.rvqB64 || profile.rvq_b64;
    if (!body.wav_b64 && !(body.spk_b64 && body.rvq_b64)) {
      throw new LocalApiError('invalid_voice', '音色需要参考 WAV 或已提取的音色数据。');
    }
    return body;
  }

  function createApiClient(options) {
    const config = options || {};
    const baseUrl = normalizeBaseUrl(config.baseUrl);
    const fetchImpl = config.fetchImpl || globalThis.fetch;
    if (typeof fetchImpl !== 'function') throw new TypeError('fetch 不可用。');
    const storage = config.storage;
    let lastVoiceGeneration = '';

    function withClientHeader(init) {
      const request = Object.assign({}, init || {});
      request.headers = Object.assign({}, request.headers || {}, {
        'x-qwen-reader-client': CLIENT_HEADER_VALUE,
      });
      return request;
    }

    async function requestJson(path, init) {
      let response;
      try {
        response = await fetchImpl(`${baseUrl}${path}`, withClientHeader(init));
      } catch (error) {
        if (error && error.name === 'AbortError') throw error;
        throw new LocalApiError('network_error', '无法连接本地 Qwen TTS 服务。');
      }
      if (!response.ok) return readError(response);
      try {
        return await response.json();
      } catch (_) {
        throw new LocalApiError('invalid_response', '本地 TTS 服务返回了无效数据。', response.status);
      }
    }

    function jsonPost(path, body, signal) {
      return requestJson(path, {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
      });
    }

    return {
      async status(signal) {
        return requestJson('/health', {
          method: 'GET', signal, headers: { accept: 'application/json' },
        });
      },

      async voices(signal) {
        const payload = await requestJson('/v1/audio/voices', {
          method: 'GET', signal, headers: { accept: 'application/json' },
        });
        return Array.isArray(payload.voices) ? payload.voices : [];
      },

      async ensureLocalVoices(options) {
        const syncOptions = options || {};
        let profiles = syncOptions.profiles;
        if (!Array.isArray(profiles)) {
          if (!storage || typeof storage.get !== 'function') return { registered: [] };
          profiles = await storage.get('voiceProfiles');
        }
        const saved = Array.isArray(profiles) ? profiles : [];
        if (!saved.length) return { registered: [] };
        const remoteVoices = Array.isArray(syncOptions.remoteVoices)
          ? syncOptions.remoteVoices
          : await this.voices(syncOptions.signal);
        const status = syncOptions.status || await this.status(syncOptions.signal);
        const generation = syncOptions.generation == null
          ? backendGeneration(status)
          : String(syncOptions.generation || '');
        const generationChanged = Boolean(generation) && generation !== lastVoiceGeneration;
        const remoteNames = new Set(remoteVoices.map((voice) => voice && voice.name));
        const registered = [];
        for (const profile of saved) {
          if (!profile || (!generationChanged && remoteNames.has(profile.name))) continue;
          await this.registerVoice(profile, syncOptions.signal);
          registered.push(profile.name);
        }
        if (generation) lastVoiceGeneration = generation;
        return { registered };
      },

      async synthesize(request, signal) {
        const input = String(request && request.input || '').trim();
        if (!input) throw new LocalApiError('invalid_input', '朗读内容不能为空。');
        let response;
        try {
          response = await fetchImpl(`${baseUrl}/v1/audio/speech`, withClientHeader({
            method: 'POST',
            signal,
            headers: { 'content-type': 'application/json', accept: 'audio/wav' },
            body: JSON.stringify({
              input,
              voice: request && request.voice ? String(request.voice) : '',
              model: MODEL,
              response_format: 'wav',
            }),
          }));
        } catch (error) {
          if (error && error.name === 'AbortError') throw error;
          throw new LocalApiError('network_error', '无法连接本地 Qwen TTS 服务。');
        }
        if (!response.ok) return readError(response);
        const blob = await response.blob();
        return { blob, mimeType: blob.type || response.headers.get('content-type') || 'audio/wav' };
      },

      async registerVoice(profile, signal) {
        return jsonPost('/v1/audio/voices', profilePayload(profile), signal);
      },

      async deleteVoice(name, signal) {
        const safeName = encodeURIComponent(String(name || '').trim());
        if (!safeName) throw new LocalApiError('invalid_voice', '音色名称不能为空。');
        return requestJson(`/v1/audio/voices/${safeName}`, { method: 'DELETE', signal });
      },
    };
  }

  return {
    createApiClient,
    LocalApiError,
    DEFAULT_BASE_URL,
    MODEL,
    CLIENT_HEADER_VALUE,
    backendGeneration,
  };
}));
