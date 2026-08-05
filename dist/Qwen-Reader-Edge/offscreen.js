/* global chrome */
(function offscreenModule(root, factory) {
  const apiModule = root.QwenReaderApiClient || (typeof require === 'function'
    ? require('./shared/api-client.js') : null);
  const exported = factory(apiModule);
  if (typeof module === 'object' && module.exports) module.exports = exported;
  root.QwenReaderOffscreen = exported;

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    exported.install(chrome);
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function makeOffscreen(apiModule) {
  'use strict';

  const TARGET = 'qwen-reader-offscreen';
  const DEFAULT_TIMEOUT_MS = 60000;
  const MAX_AUDIO_BYTES = 32 * 1024 * 1024;

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('无法读取本地 TTS 音频。'));
      reader.onload = () => {
        const dataUrl = String(reader.result || '');
        const comma = dataUrl.indexOf(',');
        if (comma < 0) {
          reject(new Error('本地 TTS 音频格式无效。'));
          return;
        }
        resolve(dataUrl.slice(comma + 1));
      };
      reader.readAsDataURL(blob);
    });
  }

  function abortError() {
    return Object.assign(new Error('朗读已取消。'), { name: 'AbortError', code: 'cancelled' });
  }

  function isRetriable(code) {
    return code === 'timeout'
      || code === 'network_error'
      || code === 'offscreen_unavailable'
      || /^http_5\d\d$/.test(String(code || ''));
  }

  function errorEnvelope(error, requestId, timedOut) {
    let code = error && error.code ? String(error.code) : 'unexpected_error';
    let message = error && error.message ? String(error.message) : '本地朗读服务发生未知错误。';
    if (timedOut) {
      code = 'timeout';
      message = '模型启动或语音合成超过 60 秒，请检查本地 Qwen 服务。';
    } else if (error && error.name === 'AbortError') {
      code = 'cancelled';
      message = '朗读已取消。';
    }
    return {
      ok: false,
      requestId,
      error: { code, message, retriable: isRetriable(code) },
    };
  }

  function identityOf(message, sequence) {
    const body = message || {};
    const sessionId = String(body.sessionId || '');
    const clientId = String(body.clientId || sessionId || 'legacy-client');
    const playbackId = String(body.playbackId || sessionId || 'legacy-playback');
    const requestId = String(body.requestId || `${sessionId || playbackId}:${sequence}`);
    return { clientId, playbackId, requestId, sessionId };
  }

  function createBroker(options) {
    const config = options || {};
    if (!config.api) throw new TypeError('缺少 offscreen TTS 客户端。');
    const api = config.api;
    const convertBlob = config.blobToBase64 || blobToBase64;
    const timeoutMs = Number.isFinite(config.timeoutMs) ? config.timeoutMs : DEFAULT_TIMEOUT_MS;
    const jobs = new Map();
    let sequence = 0;

    function keyOf(identity) {
      return `${identity.clientId}\u0000${identity.requestId}`;
    }

    function matches(job, message) {
      const body = message || {};
      if (body.clientId && String(body.clientId) !== job.identity.clientId) return false;
      if (body.sessionId && String(body.sessionId) !== job.identity.sessionId) return false;
      if (body.playbackId && String(body.playbackId) !== job.identity.playbackId) return false;
      if (body.requestId && String(body.requestId) !== job.identity.requestId) return false;
      return Boolean(body.clientId || body.sessionId || body.playbackId || body.requestId);
    }

    async function runJob(message, operation) {
      const identity = identityOf(message, ++sequence);
      const key = keyOf(identity);
      if (jobs.has(key)) {
        return errorEnvelope(Object.assign(new Error('重复的朗读请求。'), {
          code: 'duplicate_request',
        }), identity.requestId, false);
      }
      const controller = new AbortController();
      const job = { identity, controller, timedOut: false };
      jobs.set(key, job);
      const timer = setTimeout(() => {
        job.timedOut = true;
        controller.abort();
      }, timeoutMs);
      try {
        const result = await operation(controller.signal, identity);
        return Object.assign({ ok: true, requestId: identity.requestId }, result || {});
      } catch (error) {
        return errorEnvelope(error, identity.requestId, job.timedOut);
      } finally {
        clearTimeout(timer);
        if (jobs.get(key) === job) jobs.delete(key);
      }
    }

    async function syncProfiles(message, signal) {
      if (typeof api.ensureLocalVoices !== 'function') return;
      await api.ensureLocalVoices({
        profiles: Array.isArray(message.profiles) ? message.profiles : [],
        signal,
      });
      if (signal.aborted) throw abortError();
    }

    async function handle(message) {
      const body = message || {};
      if (body.type === 'tts:cancel') {
        let count = 0;
        for (const job of jobs.values()) {
          if (!matches(job, body)) continue;
          count += 1;
          job.controller.abort();
        }
        return { ok: true, cancelled: count > 0, count };
      }

      if (body.type === 'tts:synthesize') {
        return runJob(body, async (signal) => {
          await syncProfiles(body, signal);
          const result = await api.synthesize(body.request || {}, signal);
          if (signal.aborted) throw abortError();
          const blob = result && result.blob instanceof Blob
            ? result.blob
            : new Blob([result && result.audio || new ArrayBuffer(0)], {
              type: result && result.mimeType || 'audio/wav',
            });
          if (!blob.size) {
            const error = new Error('本地 TTS 服务返回了空音频。');
            error.code = 'invalid_response';
            throw error;
          }
          if (blob.size > MAX_AUDIO_BYTES) {
            const error = new Error('朗读片段生成的音频过大，请缩短文本。');
            error.code = 'audio_too_large';
            throw error;
          }
          return {
            audioBase64: await convertBlob(blob),
            mimeType: result && result.mimeType || blob.type || 'audio/wav',
          };
        });
      }

      if (body.type === 'tts:voices' || body.type === 'voice:list') {
        return runJob(body, async (signal) => {
          await syncProfiles(body, signal);
          const voices = await api.voices(signal);
          if (body.type === 'tts:voices') return { voices };
          const savedNames = new Set((Array.isArray(body.profiles) ? body.profiles : [])
            .map((profile) => profile && profile.name));
          return {
            voices: voices.map((voice) => Object.assign({}, voice, {
              local: savedNames.has(voice.name),
            })),
          };
        });
      }

      if (body.type === 'voice:save') {
        return runJob(body, async (signal) => {
          const profile = body.profile || {};
          await api.registerVoice(profile, signal);
          return { voice: profile.name };
        });
      }

      if (body.type === 'voice:delete') {
        return runJob(body, async (signal) => {
          const name = String(body.name || '');
          try {
            await api.deleteVoice(name, signal);
          } catch (error) {
            if (!error || error.code !== 'http_404') throw error;
          }
          return { voice: name };
        });
      }

      return errorEnvelope(Object.assign(new Error('offscreen 不支持该请求。'), {
        code: 'unknown_message',
      }), String(body.requestId || ''), false);
    }

    return { handle, activeJobCount: () => jobs.size };
  }

  function install(chromeApi) {
    const api = apiModule.createApiClient();
    const broker = createBroker({ api });
    chromeApi.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!message || message.target !== TARGET) return undefined;
      broker.handle(message).then(sendResponse);
      return true;
    });
    return broker;
  }

  return {
    TARGET,
    DEFAULT_TIMEOUT_MS,
    MAX_AUDIO_BYTES,
    blobToBase64,
    createBroker,
    errorEnvelope,
    install,
  };
}));
