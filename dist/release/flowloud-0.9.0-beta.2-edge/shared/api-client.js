(function apiClientModule(root, factory) {
  const exported = factory();
  if (typeof module === 'object' && module.exports) module.exports = exported;
  root.QwenReaderApiClient = exported;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createModule() {
  'use strict';

  const DEFAULT_BASE_URL = 'http://127.0.0.1:7811';
  const MODEL = 'qwen3-tts-1.7b-base';
  const CLIENT_HEADER_VALUE = 'qwen-reader-extension-v1';
  const STREAM_PATH = '/v1/audio/speech/stream';
  const SPEECH_CANCEL_PATH = '/v1/audio/speech/cancel';

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

  function streamUnsupportedError(message) {
    return new LocalApiError(
      'stream_unsupported',
      message || '本地 TTS 服务暂不支持流式合成。',
    );
  }

  function isStreamUnsupportedStatus(status) {
    return status === 404 || status === 405 || status === 415 || status === 501;
  }

  function sanitizeRequestIdentity(value) {
    return String(value == null ? '' : value)
      .trim()
      .replace(/[^\x21-\x7e]/gu, '_')
      .replace(/[^A-Za-z0-9._:-]/gu, '_')
      .slice(0, 128);
  }

  function speechModel(request) {
    const value = String(request && request.model || '').trim();
    return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value) ? value : MODEL;
  }

  function speechFormat(request) {
    const value = String(request && (request.response_format || request.responseFormat) || '').trim().toLowerCase();
    return /^[a-z][a-z0-9._-]{0,15}$/u.test(value) ? value : 'wav';
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
    let clientToken = String(config.clientToken || '');
    const streamPath = String(config.streamPath || STREAM_PATH);
    let streamCapability = 'unknown';
    let lastVoiceGeneration = '';

    function withClientHeader(init) {
      const request = Object.assign({}, init || {});
      request.headers = Object.assign({}, request.headers || {}, {
        'x-qwen-reader-client': CLIENT_HEADER_VALUE,
      });
      if (clientToken) request.headers.authorization = `Bearer ${clientToken}`;
      return request;
    }

    function withSpeechIdentity(init, request) {
      const prepared = withClientHeader(init);
      const requestId = sanitizeRequestIdentity(request && (request.requestId || request.request_id));
      const playbackId = sanitizeRequestIdentity(request && (request.playbackId || request.playback_id));
      if (requestId) prepared.headers['x-qwen-request-id'] = requestId;
      if (playbackId) prepared.headers['x-qwen-playback-id'] = playbackId;
      return prepared;
    }

    async function requestJson(path, init, identity) {
      let response;
      try {
        response = await fetchImpl(`${baseUrl}${path}`, identity
          ? withSpeechIdentity(init, identity)
          : withClientHeader(init));
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

    function speechPayload(request, stream) {
      const payload = {
        input: String(request && request.input || '').trim(),
        voice: request && request.voice ? String(request.voice) : '',
        model: speechModel(request),
        response_format: speechFormat(request),
        ...(stream ? { stream: true } : {}),
      };
      const requestId = sanitizeRequestIdentity(request && (request.requestId || request.request_id));
      const playbackId = sanitizeRequestIdentity(request && (request.playbackId || request.playback_id));
      if (requestId) payload.request_id = requestId;
      if (playbackId) payload.playback_id = playbackId;
      return payload;
    }

    function updateStreamCapability(status) {
      if (!status || typeof status !== 'object') return;
      const capabilities = status.capabilities || status.features || status.providerCapabilities;
      if (!capabilities || typeof capabilities !== 'object') return;
      const hasStream = Object.prototype.hasOwnProperty.call(capabilities, 'stream')
        || Object.prototype.hasOwnProperty.call(capabilities, 'supportsStream');
      const hasTransport = Object.prototype.hasOwnProperty.call(capabilities, 'transportStreaming')
        || Object.prototype.hasOwnProperty.call(capabilities, 'streaming');
      if ((hasStream && !Boolean(capabilities.stream ?? capabilities.supportsStream))
        || (hasTransport && !Boolean(capabilities.transportStreaming ?? capabilities.streaming))) {
        streamCapability = 'unsupported';
      } else if ((hasStream && Boolean(capabilities.stream ?? capabilities.supportsStream))
        || (hasTransport && Boolean(capabilities.transportStreaming ?? capabilities.streaming))) {
        streamCapability = 'supported';
      }
    }

    async function fetchSpeechStream(request, signal) {
      const input = String(request && request.input || '').trim();
      if (!input) throw new LocalApiError('invalid_input', '朗读内容不能为空。');
      if (streamCapability === 'unsupported') throw streamUnsupportedError();

      let response;
      try {
        response = await fetchImpl(`${baseUrl}${streamPath}`, withSpeechIdentity({
          method: 'POST',
          signal,
          headers: {
            'content-type': 'application/json',
            accept: `audio/${speechFormat(request)}, audio/wav, application/octet-stream`,
          },
          body: JSON.stringify(speechPayload(request, true)),
        }, request));
      } catch (error) {
        if (error && error.name === 'AbortError') throw error;
        throw new LocalApiError('network_error', '无法连接本地 Qwen TTS 服务。');
      }

      if (!response.ok) {
        if (isStreamUnsupportedStatus(response.status)) {
          streamCapability = 'unsupported';
          throw streamUnsupportedError();
        }
        return readError(response);
      }
      if (!response.body || typeof response.body.getReader !== 'function') {
        streamCapability = 'unsupported';
        throw streamUnsupportedError('本地 TTS 服务没有返回可读取的音频流。');
      }
      streamCapability = 'supported';
      return {
        stream: response.body,
        mimeType: response.headers && response.headers.get('content-type') || 'audio/wav',
        contentLength: response.headers && response.headers.get('content-length') || '',
      };
    }

    async function requestSpeechStatus(request, signal) {
      const source = typeof request === 'string' ? { requestId: request } : (request || {});
      const requestId = sanitizeRequestIdentity(source.requestId || source.request_id);
      const playbackId = sanitizeRequestIdentity(source.playbackId || source.playback_id);
      if (!requestId) throw new LocalApiError('invalid_request_id', '语音请求 ID 不能为空。');
      return requestJson(`/v1/audio/speech/status/${encodeURIComponent(requestId)}`, {
        method: 'GET',
        signal,
        headers: { accept: 'application/json' },
      }, { requestId, playbackId });
    }

    return {
      setClientToken(value) { clientToken = String(value || '').trim(); },
      async status(signal) {
        const payload = await requestJson('/health', {
          method: 'GET', signal, headers: { accept: 'application/json' },
        });
        updateStreamCapability(payload);
        return payload;
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
          response = await fetchImpl(`${baseUrl}/v1/audio/speech`, withSpeechIdentity({
            method: 'POST',
            signal,
            headers: { 'content-type': 'application/json', accept: `audio/${speechFormat(request)}` },
            body: JSON.stringify(speechPayload(request, false)),
          }, request));
        } catch (error) {
          if (error && error.name === 'AbortError') throw error;
          throw new LocalApiError('network_error', '无法连接本地 Qwen TTS 服务。');
        }
        if (!response.ok) return readError(response);
        const blob = await response.blob();
        return { blob, mimeType: blob.type || response.headers.get('content-type') || `audio/${speechFormat(request)}` };
      },

      async cancel(request, signal) {
        const source = typeof request === 'string' ? { requestId: request } : (request || {});
        const requestId = sanitizeRequestIdentity(source.requestId || source.request_id);
        const playbackId = sanitizeRequestIdentity(source.playbackId || source.playback_id);
        if (!requestId && !playbackId) return { cancelled: false, requestId: '', playbackId: '' };
        const payload = {};
        if (requestId) payload.request_id = requestId;
        if (playbackId) payload.playback_id = playbackId;
        return requestJson(SPEECH_CANCEL_PATH, {
          method: 'POST',
          signal,
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(payload),
        }, { requestId, playbackId });
      },

      async speechStatus(request, signal) {
        return requestSpeechStatus(request, signal);
      },

      // Alias used by Provider V2 adapters that call the operation status API.
      async statusSpeech(request, signal) {
        return requestSpeechStatus(request, signal);
      },

      // This is deliberately a separate opt-in method. The offscreen document
      // owns the ReadableStream; MV3 messages only carry its small readiness
      // envelope, never the stream object itself.
      async synthesizeStream(request, signal) {
        return fetchSpeechStream(request, signal);
      },

      // Provider V2 integrations may use the longer name while the extension
      // keeps the short method as its stable compatibility contract.
      async synthesizeStreaming(request, signal) {
        return fetchSpeechStream(request, signal);
      },

      streamCapability() {
        return streamCapability;
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
    STREAM_PATH,
    SPEECH_CANCEL_PATH,
    backendGeneration,
    isStreamUnsupportedStatus,
    sanitizeRequestIdentity,
  };
}));
