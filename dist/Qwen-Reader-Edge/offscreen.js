/* global chrome */
(function offscreenModule(root, factory) {
  const apiModule = root.QwenReaderApiClient || (typeof require === 'function'
    ? require('./shared/api-client.js') : null);
  const providerModule = root.QwenReaderProviderV2 || (typeof require === 'function'
    ? require('./shared/provider-v2.js') : null);
  const exported = factory(apiModule, providerModule);
  if (typeof module === 'object' && module.exports) module.exports = exported;
  root.QwenReaderOffscreen = exported;

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    exported.install(chrome);
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function makeOffscreen(apiModule, providerModule) {
  'use strict';

  const TARGET = 'qwen-reader-offscreen';
  const STREAM_EVENT_TARGET = 'qwen-reader-stream-event';
  const DEFAULT_TIMEOUT_MS = 60000;
  const MAX_AUDIO_BYTES = 32 * 1024 * 1024;
  const STREAM_PREBUFFER_SECONDS = 0.35;
  const STREAM_MAX_BUFFER_SECONDS = 3;
  const STREAM_POLL_MS = 30;

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
    const sourceTabCandidate = body.sourceTabId;
    const sourceTabId = sourceTabCandidate == null || sourceTabCandidate === ''
      ? null
      : (Number.isInteger(Number(sourceTabCandidate)) ? Number(sourceTabCandidate) : null);
    return { clientId, playbackId, requestId, sessionId, sourceTabId };
  }

  function asBytes(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) {
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    return new Uint8Array(0);
  }

  function concatBytes(left, right) {
    const a = asBytes(left);
    const b = asBytes(right);
    const result = new Uint8Array(a.byteLength + b.byteLength);
    result.set(a, 0);
    result.set(b, a.byteLength);
    return result;
  }

  function waitMs(milliseconds, signal) {
    if (signal && signal.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve();
      }, milliseconds);
      const onAbort = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        reject(abortError());
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  function readAscii(bytes, offset, length) {
    let value = '';
    for (let index = 0; index < length && offset + index < bytes.length; index += 1) {
      value += String.fromCharCode(bytes[offset + index]);
    }
    return value;
  }

  function readUint32(bytes, offset) {
    return (bytes[offset] || 0)
      | ((bytes[offset + 1] || 0) << 8)
      | ((bytes[offset + 2] || 0) << 16)
      | ((bytes[offset + 3] || 0) << 24);
  }

  function readUint16(bytes, offset) {
    return (bytes[offset] || 0) | ((bytes[offset + 1] || 0) << 8);
  }

  // WAV streams are only progressively playable when they contain ordinary
  // little-endian PCM. Compressed or extensible WAV data is handed to the
  // regular whole-blob path after capability detection.
  function parseWavHeader(bytes) {
    const source = asBytes(bytes);
    if (source.length < 12) return { pending: true };
    if (readAscii(source, 0, 4) !== 'RIFF' || readAscii(source, 8, 4) !== 'WAVE') {
      const error = new Error('流式音频不是可渐进播放的 WAV。');
      error.code = 'stream_unplayable';
      throw error;
    }
    let offset = 12;
    let format = null;
    while (offset + 8 <= source.length) {
      const id = readAscii(source, offset, 4);
      const size = Math.max(0, readUint32(source, offset + 4));
      const bodyStart = offset + 8;
      if (id === 'fmt ') {
        if (size < 16 || bodyStart + 16 > source.length) return { pending: true };
        format = {
          tag: readUint16(source, bodyStart),
          channels: readUint16(source, bodyStart + 2),
          sampleRate: readUint32(source, bodyStart + 4),
          bitsPerSample: readUint16(source, bodyStart + 14),
        };
      }
      if (id === 'data') {
        if (!format) return { pending: true };
        if (format.tag !== 1 || !format.channels || !format.sampleRate
          || ![8, 16, 24, 32].includes(format.bitsPerSample)) {
          const error = new Error('流式音频编码不支持渐进播放。');
          error.code = 'stream_unplayable';
          throw error;
        }
        return Object.assign(format, {
          dataStart: bodyStart,
          dataSize: size,
        });
      }
      const next = bodyStart + size + (size % 2);
      if (next > source.length) return { pending: true };
      offset = next;
    }
    return { pending: true };
  }

  function createPcmScheduler(options) {
    const config = options || {};
    const AudioContextCtor = config.AudioContextCtor;
    if (typeof AudioContextCtor !== 'function') return null;
    const context = new AudioContextCtor();
    const prebuffer = Number.isFinite(config.prebufferSeconds)
      ? config.prebufferSeconds : STREAM_PREBUFFER_SECONDS;
    const maxBuffer = Number.isFinite(config.maxBufferSeconds)
      ? config.maxBufferSeconds : STREAM_MAX_BUFFER_SECONDS;
    const signal = config.signal;
    let nextTime = 0;
    let queuedFrames = 0;
    let pendingBytes = new Uint8Array(0);
    let format = null;
    let totalBytes = 0;
    let started = false;
    let closed = false;
    const sources = new Set();

    async function resume() {
      if (context && typeof context.resume === 'function') await context.resume();
    }

    function bufferedSeconds() {
      if (!nextTime || !context) return 0;
      return Math.max(0, nextTime - Number(context.currentTime || 0));
    }

    async function applyBackpressure() {
      while (bufferedSeconds() > maxBuffer) await waitMs(STREAM_POLL_MS, signal);
    }

    function decode(bytes) {
      const bytesPerSample = format.bitsPerSample / 8;
      const frameBytes = bytesPerSample * format.channels;
      const usable = bytes.length - (bytes.length % frameBytes);
      if (!usable) {
        pendingBytes = bytes;
        return 0;
      }
      pendingBytes = bytes.slice(usable);
      const frames = usable / frameBytes;
      const audioBuffer = context.createBuffer(format.channels, frames, format.sampleRate);
      const channels = Array.from({ length: format.channels }, (_, index) => audioBuffer.getChannelData(index));
      let cursor = 0;
      for (let frame = 0; frame < frames; frame += 1) {
        for (let channel = 0; channel < format.channels; channel += 1) {
          let sample;
          if (format.bitsPerSample === 8) {
            sample = (bytes[cursor] - 128) / 128;
            cursor += 1;
          } else if (format.bitsPerSample === 16) {
            let raw = bytes[cursor] | (bytes[cursor + 1] << 8);
            if (raw & 0x8000) raw -= 0x10000;
            sample = raw / 0x8000;
            cursor += 2;
          } else if (format.bitsPerSample === 24) {
            let raw = bytes[cursor] | (bytes[cursor + 1] << 8) | (bytes[cursor + 2] << 16);
            if (raw & 0x800000) raw -= 0x1000000;
            sample = raw / 0x800000;
            cursor += 3;
          } else {
            let raw = (bytes[cursor]
              | (bytes[cursor + 1] << 8)
              | (bytes[cursor + 2] << 16)
              | (bytes[cursor + 3] << 24));
            sample = raw / 0x80000000;
            cursor += 4;
          }
          channels[channel][frame] = Math.max(-1, Math.min(1, sample));
        }
      }
      const source = context.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(context.destination);
      sources.add(source);
      source.onended = () => {
        sources.delete(source);
        if (typeof source.disconnect === 'function') {
          try { source.disconnect(); } catch (_) { /* The context may already be closed. */ }
        }
      };
      if (!nextTime) nextTime = Number(context.currentTime || 0) + prebuffer;
      source.start(nextTime);
      nextTime += frames / format.sampleRate;
      queuedFrames += frames;
      totalBytes += usable;
      started = true;
      return frames;
    }

    async function queue(bytes) {
      const combined = concatBytes(pendingBytes, bytes);
      pendingBytes = new Uint8Array(0);
      await applyBackpressure();
      return decode(combined);
    }

    async function finish() {
      if (!started || !queuedFrames) {
        const error = new Error('流式音频没有可播放的 PCM 数据。');
        error.code = 'stream_unplayable';
        throw error;
      }
      if (pendingBytes.length) {
        const error = new Error('流式音频帧不完整。');
        error.code = 'stream_unplayable';
        throw error;
      }
      while (bufferedSeconds() > 0) await waitMs(STREAM_POLL_MS, signal);
    }

    async function close() {
      if (closed) return;
      closed = true;
      for (const source of sources) {
        if (typeof source.stop === 'function') {
          try { source.stop(); } catch (_) { /* A naturally-ended source may reject stop(). */ }
        }
        if (typeof source.disconnect === 'function') {
          try { source.disconnect(); } catch (_) { /* The context may already be closed. */ }
        }
      }
      sources.clear();
      if (context && typeof context.close === 'function') await context.close();
    }

    return {
      context,
      resume,
      queue,
      finish,
      close,
      bufferedSeconds,
      setFormat(value) { format = value; },
      get format() { return format; },
      get totalBytes() { return totalBytes; },
    };
  }

  function readWithAbort(reader, signal, cancelReader) {
    if (signal && signal.aborted) {
      cancelReader();
      return Promise.reject(abortError());
    }
    if (!signal) return Promise.resolve().then(() => reader.read());
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => signal.removeEventListener('abort', onAbort);
      const onAbort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        cancelReader();
        reject(abortError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      Promise.resolve()
        .then(() => {
          if (signal.aborted) throw abortError();
          return reader.read();
        })
        .then((value) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(value);
        }, (error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        });
      if (signal.aborted) onAbort();
    });
  }

  async function readStreamChunks(stream, onChunk, signal) {
    if (!stream) throw Object.assign(new Error('本地 TTS 服务没有返回音频流。'), { code: 'stream_unplayable' });
    if (typeof stream.getReader === 'function') {
      const reader = stream.getReader();
      let cancelRequested = false;
      const cancelReader = () => {
        if (cancelRequested || typeof reader.cancel !== 'function') return;
        cancelRequested = true;
        try {
          const result = reader.cancel(abortError());
          if (result && typeof result.catch === 'function') result.catch(() => {});
        } catch (_) {
          // The abort rejection below remains authoritative.
        }
      };
      try {
        while (true) {
          if (signal && signal.aborted) throw abortError();
          const next = await readWithAbort(reader, signal, cancelReader);
          if (!next || next.done) break;
          const chunk = asBytes(next.value);
          if (chunk.byteLength) await onChunk(chunk);
        }
      } finally {
        if (signal && signal.aborted) cancelReader();
        if (typeof reader.releaseLock === 'function') {
          try { reader.releaseLock(); } catch (_) { /* A pending native read may retain the lock briefly. */ }
        }
      }
      return;
    }
    if (typeof stream[Symbol.asyncIterator] === 'function') {
      const iterator = stream[Symbol.asyncIterator]();
      let returnRequested = false;
      const cancelIterator = () => {
        if (returnRequested || !iterator || typeof iterator.return !== 'function') return;
        returnRequested = true;
        try {
          const result = iterator.return();
          if (result && typeof result.catch === 'function') result.catch(() => {});
        } catch (_) {
          // The abort rejection below remains authoritative.
        }
      };
      try {
        while (true) {
          const next = await readWithAbort({ read: () => iterator.next() }, signal, cancelIterator);
          if (!next || next.done) break;
          const chunk = asBytes(next.value);
          if (chunk.byteLength) await onChunk(chunk);
        }
      } finally {
        if (signal && signal.aborted) cancelIterator();
      }
      return;
    }
    throw Object.assign(new Error('本地 TTS 服务返回了不可读取的音频流。'), {
      code: 'stream_unplayable',
    });
  }

  async function collectStream(stream, mimeType, signal) {
    const chunks = [];
    let total = 0;
    await readStreamChunks(stream, (chunk) => {
      total += chunk.byteLength;
      if (total > MAX_AUDIO_BYTES) {
        const error = new Error('朗读片段生成的音频过大，请缩短文本。');
        error.code = 'audio_too_large';
        throw error;
      }
      chunks.push(chunk.slice());
    }, signal);
    if (!total) {
      const error = new Error('本地 TTS 服务返回了空音频。');
      error.code = 'invalid_response';
      throw error;
    }
    return new Blob(chunks, { type: mimeType || 'audio/wav' });
  }

  // Begin consuming a stream and return as soon as a small amount of audio is
  // scheduled. The returned `done` promise remains alive until playback ends,
  // so cancellation can still find the immutable job identity in `jobs`.
  async function beginStreamPlayback(streamResult, options) {
    const config = options || {};
    const signal = config.signal;
    const AudioContextCtor = config.AudioContextCtor;
    if (typeof AudioContextCtor !== 'function') {
      const blob = await collectStream(streamResult.stream, streamResult.mimeType, signal);
      return {
        mode: 'buffered',
        blob,
        transportStreaming: true,
        progressivePlayback: false,
        done: Promise.resolve(),
      };
    }

    const scheduler = createPcmScheduler({
      AudioContextCtor,
      signal,
      prebufferSeconds: config.prebufferSeconds,
      maxBufferSeconds: config.maxBufferSeconds,
    });
    let mode = 'unknown';
    let header = new Uint8Array(0);
    let dataRemaining = 0;
    let totalBytes = 0;
    let readyResolve;
    let readyReject;
    let readySignaled = false;
    const readyPromise = new Promise((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });

    const resolveReady = () => {
      if (readySignaled) return;
      readySignaled = true;
      readyResolve();
    };
    const rejectReady = (error) => {
      if (readySignaled) return;
      readySignaled = true;
      readyReject(error);
    };

    const pump = (async () => {
      try {
        await scheduler.resume();
        await readStreamChunks(streamResult.stream, async (chunk) => {
          totalBytes += chunk.byteLength;
          if (totalBytes > MAX_AUDIO_BYTES) {
            const error = new Error('朗读片段生成的音频过大，请缩短文本。');
            error.code = 'audio_too_large';
            throw error;
          }
          if (mode === 'unknown') {
            header = concatBytes(header, chunk);
            const parsed = parseWavHeader(header);
            if (parsed.pending) return;
            mode = 'progressive';
            dataRemaining = parsed.dataSize;
            scheduler.setFormat(parsed);
            const pcm = header.slice(parsed.dataStart);
            header = new Uint8Array(0);
            if (pcm.length) {
              const usable = pcm.slice(0, dataRemaining);
              dataRemaining -= usable.length;
              await scheduler.queue(usable);
            }
          } else if (mode === 'progressive' && dataRemaining > 0) {
            const usable = chunk.slice(0, dataRemaining);
            dataRemaining -= usable.length;
            await scheduler.queue(usable);
          }
          if (mode === 'progressive' && typeof config.onProgress === 'function') {
            config.onProgress({
              bytes: totalBytes,
              bufferedSeconds: scheduler.bufferedSeconds(),
            });
          }
          if (mode === 'progressive' && scheduler.bufferedSeconds() >= (
            Number.isFinite(config.prebufferSeconds)
              ? config.prebufferSeconds : STREAM_PREBUFFER_SECONDS
          )) resolveReady();
        }, signal);
        if (mode !== 'progressive') {
          const error = new Error('流式音频没有可识别的 PCM WAV 头。');
          error.code = 'stream_unplayable';
          throw error;
        }
        if (dataRemaining > 0 || dataRemaining < 0 || scheduler.totalBytes <= 0) {
          const error = new Error('流式音频没有可播放的数据。');
          error.code = 'stream_unplayable';
          throw error;
        }
        resolveReady();
        await scheduler.finish();
        return {
          mode: 'progressive',
          transportStreaming: true,
          progressivePlayback: true,
          bytes: totalBytes,
        };
      } catch (error) {
        rejectReady(error);
        throw error;
      } finally {
        await scheduler.close().catch(() => {});
      }
    })();
    // If the parser rejects before the readiness promise settles, the caller
    // will perform the whole-audio fallback. Mark the background pump handled
    // here so a closed stream cannot create an unhandled rejection.
    pump.catch(() => {});

    await readyPromise;
    return {
      mode,
      transportStreaming: true,
      progressivePlayback: mode === 'progressive',
      done: pump,
    };
  }

  // Provider V2 streams are event iterables so their control envelope never
  // crosses an MV3 message boundary. The existing progressive player only
  // needs byte chunks, therefore this adapter deliberately drops the `end`
  // event and exposes an equivalent async byte stream.
  function providerStreamToStreamResult(providerStream, mimeType) {
    const source = providerStream && providerStream.stream
      ? providerStream.stream : providerStream;
    if (providerStream && providerStream.stream
      && source && typeof source.getReader === 'function') {
      return {
        stream: source,
        mimeType: providerStream.mimeType || mimeType || 'audio/wav',
      };
    }
    if (!source || typeof source[Symbol.asyncIterator] !== 'function') {
      throw Object.assign(new Error('Provider V2 返回了不可读取的音频流。'), {
        code: 'stream_unplayable',
      });
    }
    const stream = (async function* providerByteStream() {
      for await (const event of source) {
        if (!event) continue;
        if (event.type === 'end' || event.final === true) break;
        const value = event.type === 'data'
          ? (event.data === undefined ? event.chunk : event.data)
          : event;
        const bytes = asBytes(value);
        if (bytes.byteLength) yield bytes;
      }
    }());
    return {
      stream,
      mimeType: providerStream && providerStream.mimeType
        ? providerStream.mimeType : (mimeType || 'audio/wav'),
    };
  }

  function createBroker(options) {
    const config = options || {};
    if (!config.api) throw new TypeError('缺少 offscreen TTS 客户端。');
    const api = config.api;
    const providerApi = config.providerApi || providerModule;
    let providerRegistry = config.providerRegistry || null;
    if (!providerRegistry && providerApi && typeof providerApi.createProviderRegistry === 'function') {
      const localProvider = config.provider || (
        typeof providerApi.createLocalQwenProvider === 'function'
          ? providerApi.createLocalQwenProvider({
            api,
            settings: config.settings,
            baseUrl: config.baseUrl,
            model: config.model,
            responseFormat: config.responseFormat,
            fetchImpl: config.fetchImpl,
            storage: config.storage,
            enableRemoteCancel: config.enableRemoteCancel,
            forwardExternalSignal: true,
            // Offscreen owns the whole-audio fallback envelope so it can
            // report streamFallback and avoid pretending a completed WAV is
            // progressive transport.
            fallbackToSynthesize: false,
          })
          : null
      );
      if (localProvider) providerRegistry = providerApi.createProviderRegistry({ providers: [localProvider] });
    }
    const providerId = String(config.providerId || 'local-qwen');
    const convertBlob = config.blobToBase64 || blobToBase64;
    const timeoutMs = Number.isFinite(config.timeoutMs) ? config.timeoutMs : DEFAULT_TIMEOUT_MS;
    const AudioContextCtor = Object.prototype.hasOwnProperty.call(config, 'AudioContextCtor')
      ? config.AudioContextCtor
      : (typeof globalThis !== 'undefined' && (globalThis.AudioContext || globalThis.webkitAudioContext));
    const emit = typeof config.emit === 'function' ? config.emit : () => {};
    const jobs = new Map();
    let sequence = 0;

    function selectProvider(requiredCapabilities) {
      if (!providerRegistry || typeof providerRegistry.select !== 'function') {
        throw Object.assign(new Error('Provider V2 未初始化。'), { code: 'provider_unavailable' });
      }
      return providerRegistry.select({
        providerId,
        requiredCapabilities,
      });
    }

    function providerCapabilities(provider, health) {
      if (providerApi && typeof providerApi.effectiveCapabilities === 'function') {
        return providerApi.effectiveCapabilities(provider, health);
      }
      return (health && health.capabilities) || provider.capabilities || {};
    }

    async function ensureProviderStreamCapability(provider, signal) {
      if (!provider || typeof provider.health !== 'function') return;
      const health = await provider.health({ signal });
      const capabilities = providerCapabilities(provider, health);
      if (capabilities.stream === false || capabilities.transportStreaming === false) {
        throw Object.assign(new Error('本地 TTS 服务暂不支持流式合成。'), {
          code: 'stream_unsupported',
        });
      }
    }

    function legacyVoiceShape(voice) {
      if (!voice || typeof voice !== 'object') return voice;
      const result = Object.assign({}, voice);
      // The local adapter adds identity metadata for Provider V2 consumers.
      // Keep the pre-V2 offscreen message shape when those fields are purely
      // generated aliases; real provider metadata remains visible.
      if (result.providerId === 'local-qwen'
        && result.id === result.name
        && result.label === result.name
        && result.source === 'provider') {
        delete result.id;
        delete result.label;
        delete result.providerId;
        delete result.source;
      }
      return result;
    }

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

    function notifyRemoteCancel(job) {
      if (!job || job.remoteCancelNotified) return;
      const provider = job.provider && typeof job.provider.cancel === 'function'
        ? job.provider : null;
      // Provider V2's cancel implementation forwards to its API client when
      // available. Use the direct gateway only for legacy/custom providers
      // without a provider-level cancel operation, avoiding duplicate remote
      // cancellation requests while retaining best-effort server cleanup.
      const gateway = !provider && api && typeof api.cancel === 'function'
        ? api : null;
      if (!provider && !gateway) return;
      job.remoteCancelNotified = true;
      const identity = {
        requestId: job.identity.requestId,
        clientId: job.identity.clientId,
        playbackId: job.identity.playbackId,
        sessionId: job.identity.sessionId,
      };
      const notify = (remote) => {
        if (!remote) return;
        try {
          const result = remote.cancel(identity);
          if (result && typeof result.catch === 'function') result.catch(() => {});
        } catch (_) {
          // AbortController remains authoritative; provider cancellation is only
          // a best-effort optimization for providers with an explicit cancel API.
        }
      };
      notify(provider);
      notify(gateway);
    }

    function emitStreamEvent(job, event, extra) {
      const identity = job && job.identity ? job.identity : {};
      const payload = Object.assign({
        target: STREAM_EVENT_TARGET,
        type: 'tts:stream:event',
        event,
        clientId: identity.clientId,
        playbackId: identity.playbackId,
        requestId: identity.requestId,
        sessionId: identity.sessionId,
        sourceTabId: identity.sourceTabId,
      }, extra || {});
      try {
        const result = emit(payload);
        if (result && typeof result.catch === 'function') result.catch(() => {});
      } catch (_) {
        // Playback is independent from event delivery; a closed tab must not
        // interrupt a stream that is already audible in the offscreen page.
      }
    }

    async function materializeAudio(result) {
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
    }

    function requestWithIdentity(message, identity) {
      const request = message && message.request && typeof message.request === 'object'
        ? Object.assign({}, message.request)
        : {};
      return Object.assign(request, {
        requestId: identity.requestId,
        clientId: identity.clientId,
        playbackId: identity.playbackId,
        sessionId: identity.sessionId,
      });
    }

    function providerRequestOptions(identity, signal) {
      return {
        signal,
        requestId: identity.requestId,
        clientId: identity.clientId,
        playbackId: identity.playbackId,
        sessionId: identity.sessionId,
      };
    }

    function healthDisablesStreaming(health) {
      const capabilities = health && health.capabilities;
      if (!capabilities || typeof capabilities !== 'object') return false;
      return capabilities.stream === false || capabilities.transportStreaming === false;
    }

    async function providerStreamResult(provider, request, identity, signal) {
      if (!provider || typeof provider.stream !== 'function') return null;
      if (typeof provider.health === 'function') {
        try {
          const health = await provider.health(providerRequestOptions(identity, signal));
          if (healthDisablesStreaming(health)) {
            const error = new Error('本地 TTS 服务暂不支持流式合成。');
            error.code = 'stream_unsupported';
            throw error;
          }
        } catch (error) {
          if (error && error.name === 'AbortError') throw error;
          if (error && error.code === 'stream_unsupported') throw error;
          // A health endpoint is advisory. The provider stream itself remains
          // the source of truth when health is temporarily unavailable.
        }
      }
      const source = provider.stream(request, providerRequestOptions(identity, signal));
      return providerStreamToStreamResult(source, 'audio/wav');
    }

    function canFallbackToWholeAudio(error) {
      return Boolean(error && [
        'stream_unsupported',
        'stream_unplayable',
        'stream_no_audio',
      ].includes(String(error.code || '')));
    }

    function canRetrySynthesis(error) {
      const code = String(error && error.code || '');
      return code === 'network_error'
        || code === 'timeout'
        || /^http_5\d\d$/.test(code);
    }

    async function withSynthesisRetry(operation, signal, requestedRetries) {
      const retries = Number.isFinite(Number(requestedRetries))
        ? Math.max(0, Math.min(2, Math.floor(Number(requestedRetries)))) : 1;
      let attempt = 0;
      while (true) {
        try {
          return await operation();
        } catch (error) {
          if (attempt >= retries || !canRetrySynthesis(error) || (signal && signal.aborted)) throw error;
          attempt += 1;
          await waitMs(250 * attempt, signal);
        }
      }
    }

    async function runJob(message, operation, provider) {
      const identity = identityOf(message, ++sequence);
      const key = keyOf(identity);
      if (jobs.has(key)) {
        return errorEnvelope(Object.assign(new Error('重复的朗读请求。'), {
          code: 'duplicate_request',
        }), identity.requestId, false);
      }
      const controller = new AbortController();
      const job = { identity, controller, timedOut: false, provider: provider || null };
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

    function runStreamJob(message, provider) {
      const identity = identityOf(message, ++sequence);
      const key = keyOf(identity);
      if (jobs.has(key)) {
        return Promise.resolve(errorEnvelope(Object.assign(new Error('重复的朗读请求。'), {
          code: 'duplicate_request',
        }), identity.requestId, false));
      }
      const controller = new AbortController();
      const job = {
        identity,
        controller,
        timedOut: false,
        initialReady: false,
        provider: provider || null,
      };
      jobs.set(key, job);
      let resolveInitial;
      const initial = new Promise((resolve) => { resolveInitial = resolve; });
      const synthesisRequest = requestWithIdentity(message, identity);
      const timer = setTimeout(() => {
        job.timedOut = true;
        controller.abort();
      }, timeoutMs);

      void (async () => {
        try {
          await syncProfiles(message, controller.signal);
          await ensureProviderStreamCapability(provider, controller.signal);
          let providerStream = null;
          const playback = await withSynthesisRetry(
            async () => {
              const streamResult = await provider.stream(synthesisRequest, {
                signal: controller.signal,
                requestId: identity.requestId,
                clientId: identity.clientId,
                playbackId: identity.playbackId,
                sessionId: identity.sessionId,
              });
              providerStream = providerStreamToStreamResult(streamResult, 'audio/wav');
              return beginStreamPlayback(providerStream, {
                AudioContextCtor,
                signal: controller.signal,
                prebufferSeconds: STREAM_PREBUFFER_SECONDS,
                maxBufferSeconds: STREAM_MAX_BUFFER_SECONDS,
                onProgress: (progress) => {
                  if (job.streamStarted) emitStreamEvent(job, 'progress', progress);
                },
              });
            },
            controller.signal,
            message.retryCount,
          );

          if (playback.mode === 'buffered') {
            const result = await materializeAudio({
              blob: playback.blob,
              mimeType: providerStream.mimeType,
            });
            job.initialReady = true;
            resolveInitial(Object.assign({ ok: true, requestId: identity.requestId }, result, {
              streaming: true,
              transportStreaming: true,
              progressivePlayback: false,
            }));
            return;
          }

          job.streamStarted = true;
          emitStreamEvent(job, 'started', {
            mimeType: providerStream.mimeType || 'audio/wav',
            transportStreaming: true,
            progressivePlayback: true,
          });
          job.initialReady = true;
          resolveInitial({
            ok: true,
            requestId: identity.requestId,
            mimeType: providerStream.mimeType || 'audio/wav',
            streaming: true,
            transportStreaming: true,
            progressivePlayback: true,
          });
          await playback.done;
          emitStreamEvent(job, 'ended', {
            transportStreaming: true,
            progressivePlayback: true,
          });
        } catch (error) {
          if (!job.initialReady && canFallbackToWholeAudio(error) && !controller.signal.aborted) {
            try {
              const result = await withSynthesisRetry(
                () => provider.synthesize(synthesisRequest, {
                  signal: controller.signal,
                  requestId: identity.requestId,
                  clientId: identity.clientId,
                  playbackId: identity.playbackId,
                  sessionId: identity.sessionId,
                }),
                controller.signal,
                message.retryCount,
              );
              const materialized = await materializeAudio(result);
              job.initialReady = true;
              resolveInitial(Object.assign({ ok: true, requestId: identity.requestId }, materialized, {
                streaming: false,
                transportStreaming: false,
                progressivePlayback: false,
                streamFallback: true,
              }));
              return;
            } catch (fallbackError) {
              error = fallbackError;
            }
          }
          const envelope = errorEnvelope(error, identity.requestId, job.timedOut);
          if (!job.initialReady) {
            job.initialReady = true;
            resolveInitial(envelope);
          } else {
            emitStreamEvent(job, 'error', {
              error: envelope.error,
              transportStreaming: true,
              progressivePlayback: true,
            });
          }
        } finally {
          clearTimeout(timer);
          if (jobs.get(key) === job) jobs.delete(key);
        }
      })();
      return initial;
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
          notifyRemoteCancel(job);
        }
        return { ok: true, cancelled: count > 0, count };
      }

      if (body.type === 'tts:status') {
        const provider = selectProvider(['health']);
        return runJob(body, async (signal) => ({
          status: await provider.health({ signal }),
        }), provider);
      }

      if (body.type === 'tts:synthesize') {
        const provider = selectProvider(body.stream === true ? ['stream'] : ['synthesize']);
        if (body.stream === true) return runStreamJob(body, provider);
        return runJob(body, async (signal, identity) => {
          await syncProfiles(body, signal);
          const result = await withSynthesisRetry(
            () => provider.synthesize(requestWithIdentity(body, identity), {
              signal,
              requestId: identity.requestId,
              clientId: identity.clientId,
              playbackId: identity.playbackId,
              sessionId: identity.sessionId,
            }),
            signal,
            body.retryCount,
          );
          if (signal.aborted) throw abortError();
          return materializeAudio(result);
        }, provider);
      }

      if (body.type === 'tts:voices' || body.type === 'voice:list') {
        const provider = selectProvider(['voices']);
        return runJob(body, async (signal) => {
          await syncProfiles(body, signal);
          const voices = (await provider.voices({ signal })).map(legacyVoiceShape);
          if (body.type === 'tts:voices') return { voices };
          const savedNames = new Set((Array.isArray(body.profiles) ? body.profiles : [])
            .map((profile) => profile && profile.name));
          return {
            voices: voices.map((voice) => Object.assign({}, voice, {
              local: savedNames.has(voice.name),
            })),
          };
        }, provider);
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
    const broker = createBroker({
      api,
      enableRemoteCancel: true,
      AudioContextCtor: rootAudioContext(),
      emit(message) {
        const tabId = Number.isInteger(Number(message && message.sourceTabId))
          ? Number(message.sourceTabId) : null;
        if (tabId != null && chromeApi.tabs && typeof chromeApi.tabs.sendMessage === 'function') {
          return chromeApi.tabs.sendMessage(tabId, message);
        }
        if (chromeApi.runtime && typeof chromeApi.runtime.sendMessage === 'function') {
          return chromeApi.runtime.sendMessage(message);
        }
        return undefined;
      },
    });
    chromeApi.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!message || message.target !== TARGET) return undefined;
      broker.handle(message).then(sendResponse);
      return true;
    });
    return broker;
  }

  function rootAudioContext() {
    return typeof globalThis !== 'undefined'
      ? (globalThis.AudioContext || globalThis.webkitAudioContext)
      : null;
  }

  return {
    TARGET,
    STREAM_EVENT_TARGET,
    DEFAULT_TIMEOUT_MS,
    MAX_AUDIO_BYTES,
    blobToBase64,
    createBroker,
    beginStreamPlayback,
    collectStream,
    errorEnvelope,
    install,
  };
}));
