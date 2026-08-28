/* global chrome */
(function offscreenModule(root, factory) {
  const apiModule = root.QwenReaderApiClient || (typeof require === 'function'
    ? require('./shared/api-client.js') : null);
  const providerModule = root.QwenReaderProviderV2 || (typeof require === 'function'
    ? require('./shared/provider-v2.js') : null);
  const providerV3Module = root.FlowloudProviderV3 || (typeof require === 'function'
    ? require('./shared/provider-v3.js') : null);
  const providerV4Module = root.FlowloudProviderV4 || (typeof require === 'function'
    ? require('./shared/provider-v4.js') : null);
  const browserModelManifest = root.FlowloudBrowserModelManifest || (typeof require === 'function'
    ? require('./shared/browser-model-manifest.js') : null);
  const documentProviderModule = root.FlowloudDocumentProviderV1 || (typeof require === 'function'
    ? require('./shared/document-provider-v1.js') : null);
  const exported = factory(apiModule, providerModule, providerV3Module, providerV4Module, documentProviderModule, browserModelManifest);
  if (typeof module === 'object' && module.exports) module.exports = exported;
  root.QwenReaderOffscreen = exported;

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    exported.install(chrome);
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function makeOffscreen(apiModule, providerModule, providerV3Module, providerV4Module, documentProviderModule, browserModelManifest) {
  'use strict';

  const TARGET = 'qwen-reader-offscreen';
  const STREAM_EVENT_TARGET = 'qwen-reader-stream-event';
  const DEFAULT_TIMEOUT_MS = 60000;
  const MODEL_DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;
  const MODEL_VERIFY_TIMEOUT_MS = 5 * 60 * 1000;
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
      error: {
        stage: String(error && (error.stage || error.operation) || (timedOut ? 'synthesis' : 'provider')),
        code,
        message,
        retryable: isRetriable(code),
        retriable: isRetriable(code),
        providerId: String(error && error.providerId || ''),
        requestId: String(requestId || error && error.requestId || ''),
      },
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
    const hasSegmentIndex = body.segmentIndex != null && body.segmentIndex !== '';
    const segmentIndex = hasSegmentIndex && Number.isInteger(Number(body.segmentIndex))
      ? Number(body.segmentIndex) : null;
    const segmentId = body.segmentId == null ? '' : String(body.segmentId);
    const sourceDocumentId = String(body.sourceDocumentId || '');
    const pageKey = String(body.pageKey || '');
    const intentSequence = Number.isInteger(Number(body.intentSequence)) ? Number(body.intentSequence) : 0;
    return { clientId, playbackId, requestId, sessionId, sourceTabId, sourceDocumentId, pageKey, intentSequence, segmentIndex, segmentId };
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
          frameBytes: format.channels * (format.bitsPerSample / 8),
          durationSeconds: size / (
            format.channels * (format.bitsPerSample / 8) * format.sampleRate
          ),
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
    let paused = false;
    let pausedPlayedSeconds = 0;
    let pauseRawTime = null;
    let pausedRawSeconds = 0;
    let firstStartTime = null;
    let progressSequence = 0;
    let progressTimer = null;
    let lastProgress = null;
    let desiredPaused = false;
    let controlEpoch = 0;
    let controlTail = Promise.resolve();
    const sources = new Set();

    function rawTime() {
      const value = Number(context && context.currentTime);
      return Number.isFinite(value) && value >= 0 ? value : 0;
    }

    function isClosedContextError(error) {
      if (closed || String(context && context.state || '').toLowerCase() === 'closed') return true;
      if (!error) return false;
      if (String(error.name || '') === 'InvalidStateError') return true;
      return /closed\s+(?:audio\s+)?context|context\s+is\s+closed/i.test(String(error.message || ''));
    }

    async function resumeContext() {
      if (closed || String(context && context.state || '').toLowerCase() === 'closed') return false;
      if (!context || typeof context.resume !== 'function') return false;
      try {
        await context.resume();
        return String(context && context.state || '').toLowerCase() !== 'closed';
      } catch (error) {
        if (!isClosedContextError(error)) throw error;
        return false;
      }
    }

    async function suspendContext() {
      if (closed || String(context && context.state || '').toLowerCase() === 'closed') return false;
      if (!context || typeof context.suspend !== 'function') return false;
      try {
        await context.suspend();
        return String(context && context.state || '').toLowerCase() !== 'closed';
      } catch (error) {
        if (!isClosedContextError(error)) throw error;
        return false;
      }
    }

    function durationSeconds() {
      return format && Number.isFinite(format.durationSeconds)
        ? Math.max(0, format.durationSeconds)
        : 0;
    }

    function playedSeconds() {
      if (firstStartTime == null) return 0;
      if (paused) return pausedPlayedSeconds;
      const value = rawTime() - firstStartTime - pausedRawSeconds;
      return Math.max(0, Math.min(durationSeconds() || value, value));
    }

    function scheduledSeconds() {
      if (!format || !Number.isFinite(format.sampleRate) || format.sampleRate <= 0) return 0;
      return queuedFrames / format.sampleRate;
    }

    function snapshot(increment) {
      if (!format) return lastProgress;
      const played = playedSeconds();
      const scheduled = scheduledSeconds();
      const value = {
        sequence: increment === false ? progressSequence : ++progressSequence,
        playedSeconds: played,
        durationSeconds: durationSeconds(),
        scheduledSeconds: scheduled,
        bufferedSeconds: Math.max(0, scheduled - played),
        sampleRate: format.sampleRate,
        channels: format.channels,
        bitsPerSample: format.bitsPerSample,
        audioBytesScheduled: totalBytes,
        totalAudioBytes: Number.isFinite(format.dataSize) ? format.dataSize : 0,
      };
      lastProgress = value;
      return value;
    }

    function emitProgress() {
      if (closed || typeof config.onProgress !== 'function' || !format) return lastProgress;
      const value = snapshot(true);
      try { config.onProgress(value); } catch (_) { /* Progress delivery is best effort. */ }
      return value;
    }

    function startProgressTicker() {
      if (progressTimer || typeof config.onProgress !== 'function') return;
      const interval = Number.isFinite(config.progressIntervalMs)
        ? Math.max(20, config.progressIntervalMs) : 50;
      progressTimer = setInterval(() => {
        // A pause freezes both the Web Audio clock and externally observable
        // progress. Only the explicit paused snapshot is emitted until resume.
        if (!closed && started && !paused) emitProgress();
      }, interval);
    }

    async function applyPausedState(targetPaused) {
      if (closed || String(context && context.state || '').toLowerCase() === 'closed') return false;
      if (targetPaused) {
        if (paused) return true;
        const nextPlayedSeconds = playedSeconds();
        const nextPauseRawTime = rawTime();
        const suspended = await suspendContext();
        if (!suspended) return false;
        pausedPlayedSeconds = nextPlayedSeconds;
        pauseRawTime = nextPauseRawTime;
        paused = true;
        emitProgress();
        return true;
      }
      if (!paused) return resumeContext();
      const now = rawTime();
      if (pauseRawTime != null) pausedRawSeconds += Math.max(0, now - pauseRawTime);
      const resumed = await resumeContext();
      if (!resumed) return false;
      pauseRawTime = null;
      paused = false;
      emitProgress();
      return true;
    }

    function requestPaused(targetPaused) {
      desiredPaused = Boolean(targetPaused);
      const requestedEpoch = ++controlEpoch;
      const reconcile = async () => {
        while (!closed) {
          const target = desiredPaused;
          const observedEpoch = controlEpoch;
          const applied = await applyPausedState(target);
          if (!applied) return false;
          if (observedEpoch === controlEpoch && paused === desiredPaused) return true;
        }
        return false;
      };
      const result = controlTail.catch(() => {}).then(reconcile);
      controlTail = result.catch(() => {});
      return result.then((applied) => (
        applied && requestedEpoch === controlEpoch && paused === Boolean(targetPaused)
      ));
    }

    function resume() { return requestPaused(false); }

    function pause() { return requestPaused(true); }

    function bufferedSeconds() {
      const scheduled = scheduledSeconds();
      return Math.max(0, scheduled - playedSeconds());
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
      if (!nextTime) {
        nextTime = rawTime() + prebuffer;
        firstStartTime = nextTime;
      }
      source.start(nextTime);
      nextTime += frames / format.sampleRate;
      queuedFrames += frames;
      totalBytes += usable;
      started = true;
      startProgressTicker();
      emitProgress();
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
      emitProgress();
    }

    async function close() {
      if (closed) return;
      closed = true;
      if (progressTimer) {
        clearInterval(progressTimer);
        progressTimer = null;
      }
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
      pause,
      queue,
      finish,
      close,
      bufferedSeconds,
      progress() { return snapshot(true); },
      emitProgress,
      get paused() { return paused; },
      get desiredPaused() { return desiredPaused; },
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
        async pause() {},
        async resume() {},
        done: Promise.resolve(),
      };
    }

    const scheduler = createPcmScheduler({
      AudioContextCtor,
      signal,
      prebufferSeconds: config.prebufferSeconds,
      maxBufferSeconds: config.maxBufferSeconds,
      progressIntervalMs: config.progressIntervalMs,
      onProgress: config.onProgress,
    });
    if (typeof config.onControlReady === 'function') {
      config.onControlReady(scheduler);
    }
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
        if (typeof config.shouldStartPaused === 'function' && config.shouldStartPaused()) {
          await scheduler.pause();
        } else {
          await scheduler.resume();
        }
        await readStreamChunks(streamResult.stream, async (chunk) => {
          if (typeof config.onStreamActivity === 'function') config.onStreamActivity('chunk');
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
              const scheduled = await scheduler.queue(usable);
              if (scheduled > 0 && typeof config.onFirstAudio === 'function') config.onFirstAudio();
            }
          } else if (mode === 'progressive' && dataRemaining > 0) {
            const usable = chunk.slice(0, dataRemaining);
            dataRemaining -= usable.length;
            const scheduled = await scheduler.queue(usable);
            if (scheduled > 0 && typeof config.onFirstAudio === 'function') config.onFirstAudio();
          }
          if (mode === 'progressive' && typeof config.onProgress === 'function') {
            config.onProgress(Object.assign({}, scheduler.progress() || {}, {
              bytes: totalBytes,
            }));
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
            progress: scheduler.progress(),
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
      pause: scheduler.pause,
      resume: scheduler.resume,
      progress: scheduler.progress,
      get paused() { return scheduler.paused; },
      get desiredPaused() { return scheduler.desiredPaused; },
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
    const documentApi = config.documentProviderApi || documentProviderModule;
    const jobs = new Map();
    let sequence = 0;

    function selectProvider(requiredCapabilities, requestedId, message) {
      if (!providerRegistry || typeof providerRegistry.select !== 'function') {
        throw Object.assign(new Error('Provider V2 未初始化。'), { code: 'provider_unavailable' });
      }
      const id = String(requestedId || providerId);
      if (typeof config.resolveProvider === 'function') {
        const resolved = config.resolveProvider(id, message || {});
        if (resolved && typeof providerRegistry.register === 'function') providerRegistry.register(resolved, { replace: true });
      }
      return providerRegistry.select({
        providerId: id,
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
      try {
        const health = await provider.health({ signal });
        const capabilities = providerCapabilities(provider, health);
        if (capabilities.stream === false || capabilities.transportStreaming === false) {
          throw Object.assign(new Error('本地 TTS 服务暂不支持流式合成。'), {
            code: 'stream_unsupported',
          });
        }
      } catch (error) {
        // Health is a capability hint, not the stream operation itself. Keep
        // cancellation and an explicit unsupported capability authoritative,
        // but let the real stream request exercise its retry/fallback path
        // after transient health failures (timeouts, network errors, etc.).
        if ((signal && signal.aborted) || (error && error.name === 'AbortError')) {
          throw signal && signal.aborted && (!error || error.name !== 'AbortError')
            ? abortError()
            : error;
        }
        if (error && error.code === 'stream_unsupported') throw error;
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
      const hasSourceTabId = body.sourceTabId != null && body.sourceTabId !== '';
      if (hasSourceTabId && Number(body.sourceTabId) !== job.identity.sourceTabId) return false;
      if (body.sourceDocumentId && String(body.sourceDocumentId) !== job.identity.sourceDocumentId) return false;
      if (body.intentSequence != null && Number(body.intentSequence) !== job.identity.intentSequence) return false;
      return Boolean(body.clientId || body.sessionId || body.playbackId || body.requestId || hasSourceTabId || body.sourceDocumentId || body.intentSequence != null);
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
        sourceDocumentId: identity.sourceDocumentId,
        pageKey: identity.pageKey,
        intentSequence: identity.intentSequence,
        segmentIndex: identity.segmentIndex,
        segmentId: identity.segmentId,
      }, extra || {});
      try {
        const result = emit(payload);
        if (result && typeof result.catch === 'function') result.catch(() => {});
      } catch (_) {
        // Event delivery can race with tab closure. The background's tab
        // removal handler separately cancels every job owned by that tab.
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
        sourceDocumentId: identity.sourceDocumentId,
        pageKey: identity.pageKey,
        intentSequence: identity.intentSequence,
        segmentIndex: identity.segmentIndex,
        segmentId: identity.segmentId,
      });
    }

    function providerRequestOptions(identity, signal) {
      return {
        signal,
        requestId: identity.requestId,
        clientId: identity.clientId,
        playbackId: identity.playbackId,
        sessionId: identity.sessionId,
        sourceDocumentId: identity.sourceDocumentId,
        pageKey: identity.pageKey,
        intentSequence: identity.intentSequence,
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

    async function withSynthesisRetry(operation, signal, requestedRetries, onRetry) {
      const retries = Number.isFinite(Number(requestedRetries))
        ? Math.max(0, Math.min(2, Math.floor(Number(requestedRetries)))) : 1;
      let attempt = 0;
      while (true) {
        try {
          return await operation();
        } catch (error) {
          if (attempt >= retries || !canRetrySynthesis(error) || (signal && signal.aborted)) throw error;
          attempt += 1;
          if (typeof onRetry === 'function') {
            try {
              onRetry({ attempt, retries, error });
            } catch (_) {
              // Retry telemetry is best effort and must not affect synthesis.
            }
          }
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
      const operationTimeoutMs = message.type === 'provider:model:download' || /^provider:model:voice-(?:download|repair)$/u.test(String(message.type || ''))
        ? Number(config.modelDownloadTimeoutMs || MODEL_DOWNLOAD_TIMEOUT_MS)
        : message.type === 'provider:model:verify'
          ? Number(config.modelVerifyTimeoutMs || MODEL_VERIFY_TIMEOUT_MS)
          : String(message.type || '').startsWith('document:')
            ? Math.min(10 * 60 * 1000, Math.max(timeoutMs, Number(message.profile?.timeoutMs) || 120000))
            : timeoutMs;
      const timer = setTimeout(() => {
        job.timedOut = true;
        controller.abort();
      }, operationTimeoutMs);
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

    function runDirectPlayJob(message, provider) {
      const identity = identityOf(message, ++sequence);
      const key = keyOf(identity);
      if (jobs.has(key)) return Promise.resolve(errorEnvelope(Object.assign(new Error('重复的朗读请求。'), { code: 'duplicate_request' }), identity.requestId, false));
      const controller = new AbortController();
      let initialResolved = false; let resolveInitial;
      const initial = new Promise((resolve) => { resolveInitial = resolve; });
      const job = { identity, controller, provider, timedOut: false, streamStarted: true, endedEmitted: false, pauseRequested: message.startPaused === true };
      job.playbackControl = {
        pause: () => provider.pause ? provider.pause({ requestId: identity.requestId }) : false,
        resume: () => provider.resume ? provider.resume({ requestId: identity.requestId }) : false,
        progress: () => ({}),
      };
      jobs.set(key, job);
      const timer = setTimeout(() => { job.timedOut = true; controller.abort(); provider.cancel?.({ requestId: identity.requestId }); }, timeoutMs);
      const request = requestWithIdentity(message, identity);
      const onEvent = (event) => {
        const type = event?.type === 'end' ? 'ended' : event?.type;
        if (type === 'started' && !initialResolved) {
          initialResolved = true;
          resolveInitial({ ok: true, requestId: identity.requestId, streaming: true, transportStreaming: false, progressivePlayback: true, directPlayback: true });
        }
        if (type) emitStreamEvent(job, type, Object.assign({ directPlayback: true, progressivePlayback: true }, event));
      };
      void provider.play(request, { signal: controller.signal, onEvent }).then(() => {
        if (!job.endedEmitted) { job.endedEmitted = true; emitStreamEvent(job, 'ended', { directPlayback: true, done: true }); }
      }).catch((error) => {
        const envelope = errorEnvelope(error, identity.requestId, job.timedOut);
        if (!initialResolved) { initialResolved = true; resolveInitial(envelope); }
        else emitStreamEvent(job, 'error', { error: envelope.error, directPlayback: true });
      }).finally(() => { clearTimeout(timer); if (jobs.get(key) === job) jobs.delete(key); });
      if (message.startPaused === true) void provider.pause?.({ requestId: identity.requestId });
      queueMicrotask(() => {
        if (!initialResolved) { initialResolved = true; resolveInitial({ ok: true, requestId: identity.requestId, streaming: true, transportStreaming: false, progressivePlayback: true, directPlayback: true, paused: message.startPaused === true }); }
      });
      return initial;
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
        playback: null,
        playbackControl: null,
        streamStarted: false,
        endedEmitted: false,
        initialAudioReady: false,
        pauseRequested: message.startPaused === true,
        paused: false,
        provider: provider || null,
      };
      jobs.set(key, job);
      let resolveInitial;
      const initial = new Promise((resolve) => { resolveInitial = resolve; });
      const synthesisRequest = requestWithIdentity(message, identity);
      let initialTimer = null;
      let stallTimer = null;
      let lastProgressSignature = '';
      const abortForTimeout = () => {
        if (controller.signal.aborted) return;
        job.timedOut = true;
        controller.abort();
      };
      const clearInitialTimer = () => {
        if (!initialTimer) return;
        clearTimeout(initialTimer);
        initialTimer = null;
      };
      const clearStallTimer = () => {
        if (!stallTimer) return;
        clearTimeout(stallTimer);
        stallTimer = null;
      };
      const isPausedOrPausing = () => Boolean(
        job.pauseRequested || job.paused || (job.playbackControl && (
          job.playbackControl.paused || job.playbackControl.desiredPaused
        ))
      );
      const armStallWatchdog = () => {
        clearStallTimer();
        if (!job.initialAudioReady || isPausedOrPausing() || controller.signal.aborted) return;
        const control = job.playback || job.playbackControl;
        const bufferedSeconds = control && typeof control.bufferedSeconds === 'function'
          ? Math.max(0, Number(control.bufferedSeconds()) || 0) : 0;
        // Scheduled audio is healthy activity even before the prebuffer start
        // time. Give it enough wall time to drain once before declaring a
        // genuine transport/playback stall.
        const stallDelayMs = timeoutMs
          + Math.ceil((STREAM_PREBUFFER_SECONDS + bufferedSeconds) * 1000);
        stallTimer = setTimeout(() => {
          stallTimer = null;
          if (isPausedOrPausing()) return;
          abortForTimeout();
        }, stallDelayMs);
      };
      const noteFirstAudio = () => {
        if (!job.initialAudioReady) {
          job.initialAudioReady = true;
          clearInitialTimer();
        }
        armStallWatchdog();
      };
      const noteStreamActivity = (kind, progress) => {
        if (kind === 'progress') {
          const value = progress || {};
          const signature = [
            Number(value.playedSeconds) || 0,
            Number(value.scheduledSeconds) || 0,
            Number(value.audioBytesScheduled) || 0,
          ].join(':');
          if (signature === lastProgressSignature) return;
          lastProgressSignature = signature;
          if ((Number(value.audioBytesScheduled) || 0) > 0) noteFirstAudio();
          else if (job.initialAudioReady) armStallWatchdog();
          return;
        }
        if (job.initialAudioReady) armStallWatchdog();
      };
      job.refreshWatchdog = armStallWatchdog;
      initialTimer = setTimeout(abortForTimeout, timeoutMs);

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
                  noteStreamActivity('progress', progress);
                  if (job.streamStarted) emitStreamEvent(job, 'progress', progress);
                },
                onFirstAudio: noteFirstAudio,
                onStreamActivity: noteStreamActivity,
                shouldStartPaused: () => job.pauseRequested,
                onControlReady: (control) => {
                  job.playbackControl = control;
                },
              });
            },
            controller.signal,
            message.retryCount,
            ({ attempt, retries, error }) => emitStreamEvent(job, 'retrying', {
              attempt,
              maxRetries: retries,
              error: {
                code: error && error.code,
                message: error && error.message,
              },
            }),
          );

          job.playback = playback;
          if (job.pauseRequested && typeof playback.pause === 'function') {
            job.paused = (await playback.pause()) !== false;
          }

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
          noteFirstAudio();
          emitStreamEvent(job, 'started', Object.assign({}, playback.progress ? playback.progress() : {}, {
            mimeType: providerStream.mimeType || 'audio/wav',
            transportStreaming: true,
            progressivePlayback: true,
            paused: Boolean(job.paused),
          }));
          job.initialReady = true;
          resolveInitial({
            ok: true,
            requestId: identity.requestId,
            mimeType: providerStream.mimeType || 'audio/wav',
            streaming: true,
            transportStreaming: true,
            progressivePlayback: true,
            paused: Boolean(job.paused),
          });
          await playback.done;
          if (!job.endedEmitted) {
            job.endedEmitted = true;
            emitStreamEvent(job, 'ended', Object.assign({}, playback.progress ? playback.progress() : {}, {
              transportStreaming: true,
              progressivePlayback: true,
              done: true,
            }));
          }
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
                ({ attempt, retries, error }) => emitStreamEvent(job, 'retrying', {
                  attempt,
                  maxRetries: retries,
                  error: {
                    code: error && error.code,
                    message: error && error.message,
                  },
                }),
              );
              const materialized = await materializeAudio(result);
              emitStreamEvent(job, 'fallback', {
                reason: error && error.code ? String(error.code) : 'stream_unplayable',
              });
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
          job.playback = null;
          job.playbackControl = null;
          clearInitialTimer();
          clearStallTimer();
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
      if (body.type === 'document:cancel') {
        let count = 0;
        for (const job of jobs.values()) {
          if (!matches(job, body)) continue;
          count += 1;
          job.controller.abort();
          notifyRemoteCancel(job);
        }
        return { ok: true, cancelled: count > 0, count };
      }
      if (body.type === 'provider:model:cancel') {
        let count = 0;
        for (const job of jobs.values()) {
          if (!matches(job, body)) continue;
          count += 1;
          job.controller.abort();
        }
        return { ok: true, cancelled: count > 0, count };
      }
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

      if (body.type === 'tts:pause' || body.type === 'tts:resume') {
        const pausing = body.type === 'tts:pause';
        let count = 0;
        let applied = 0;
        let queued = 0;
        let cancelledQueued = 0;
        for (const job of jobs.values()) {
          if (!matches(job, body)) continue;
          count += 1;
          const previouslyRequested = job.pauseRequested;
          job.pauseRequested = pausing;
          if (pausing && typeof job.refreshWatchdog === 'function') job.refreshWatchdog();
          const control = job.playback || job.playbackControl;
          if (!control) {
            if (pausing) {
              queued += 1;
            } else {
              if (previouslyRequested) cancelledQueued += 1;
              job.paused = false;
            }
            if (!pausing && typeof job.refreshWatchdog === 'function') job.refreshWatchdog();
            continue;
          }
          let changed = true;
          const operation = pausing ? control.pause : control.resume;
          if (typeof operation === 'function') {
            changed = (await operation.call(control)) !== false;
          } else {
            changed = false;
          }
          if (!changed) continue;
          job.paused = pausing;
          applied += 1;
          if (typeof job.refreshWatchdog === 'function') job.refreshWatchdog();
          if (job.streamStarted) {
            emitStreamEvent(job, pausing ? 'paused' : 'resumed', Object.assign({},
              control && typeof control.progress === 'function'
                ? control.progress() : {}, {
              progressivePlayback: true,
              paused: pausing,
            }));
          }
        }
        return {
          ok: true,
          paused: pausing ? applied > 0 : false,
          resumed: !pausing ? applied > 0 : false,
          queued: pausing ? queued > 0 : false,
          cancelledQueued: !pausing ? cancelledQueued > 0 : false,
          count,
        };
      }

      if (body.type === 'tts:status') {
        const provider = selectProvider(['health'], body.providerId, body);
        return runJob(body, async (signal) => ({
          status: await provider.health({ signal }),
        }), provider);
      }

      if (body.type === 'document:probe' || body.type === 'document:extract' || body.type === 'document:translate') {
        if (!documentApi || typeof documentApi.createDocumentProvider !== 'function') {
          return errorEnvelope(Object.assign(new Error('文档 Provider 运行时不可用。'), { code: 'document_provider_unavailable' }), String(body.requestId || ''), false);
        }
        let provider;
        try {
          provider = documentApi.createDocumentProvider(body.profile, { secret: body.secret, fetchImpl: globalThis.fetch });
        } catch (error) {
          return errorEnvelope(error, String(body.requestId || ''), false);
        }
        const operation = body.type.slice('document:'.length);
        return runJob(body, async (signal, identity) => {
          if (operation === 'probe') return { result: await provider.probe({ signal, requestId: identity.requestId }) };
          const request = Object.assign({}, body.request || {}, { requestId: identity.requestId });
          const result = await provider[operation](request, { signal, requestId: identity.requestId });
          return { result };
        }, provider);
      }

      if (/^provider:model:/.test(String(body.type || ''))) {
        const provider = selectProvider(['modelManagement'], 'browser-model', body);
        const operation = body.type.slice('provider:model:'.length);
        const manager = provider.modelManagement;
        if (!manager || typeof manager[operation] !== 'function') throw Object.assign(new Error('不支持此模型管理操作。'), { code: 'model_operation_unsupported' });
        return runJob(body, async (signal) => ({ result: await manager[operation](Object.assign({}, body, {
          signal,
          onProgress(progress) {
            if (signal.aborted) throw abortError();
            config.emit?.({ target: 'flowloud:model', type: 'provider:model:progress', requestId: body.requestId, progress });
          },
        })) }), provider);
      }

      if (body.type === 'tts:synthesize') {
        let provider;
        try { provider = selectProvider(body.stream === true ? ['stream'] : ['synthesize'], body.providerId, body); }
        catch (error) {
          try {
            const candidate = selectProvider(['play'], body.providerId, body);
            if (candidate && typeof candidate.play === 'function') return runDirectPlayJob(body, candidate);
          } catch (_) {
            provider = selectProvider(['synthesize'], body.providerId, body);
          }
        }
        if (typeof provider.play === 'function' && typeof provider.synthesize !== 'function') return runDirectPlayJob(body, provider);
        if (body.stream === true && typeof provider.stream === 'function') return runStreamJob(body, provider);
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
        const provider = selectProvider(['voices'], body.providerId, body);
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
    const providerApi = providerV4Module || providerV3Module || providerModule;
    const providers = [];
    if (providerV4Module) {
      providers.push(providerV4Module.createBrowserSystemProvider());
      providers.push(providerV4Module.createLocalServiceProvider({
        adapterId: 'flowloud-qwen', api, enableRemoteCancel: true,
        forwardExternalSignal: true, fallbackToSynthesize: false,
      }));
    } else if (providerV3Module) {
      providers.push(providerV3Module.createBrowserSystemProvider());
      providers.push(providerV3Module.adaptLocalQwen({ api, enableRemoteCancel: true, forwardExternalSignal: true, fallbackToSynthesize: false }));
    }
    const providerRegistry = providerApi.createProviderRegistry({ providers, activeProviderId: 'browser-system' });
    let kokoroRuntimePromise = null;
    const resolvedProviderCache = new Map();
    function cachedProvider(providerId, signatureSource, create) {
      const signature = JSON.stringify(signatureSource);
      const existing = resolvedProviderCache.get(providerId);
      if (existing && existing.signature === signature) return existing.provider;
      const provider = create();
      resolvedProviderCache.set(providerId, { signature, provider });
      return provider;
    }
    const voiceFetcherCache = new Map();
    function modelSource(options) {
      const manifest = browserModelManifest;
      const sourceInfo = manifest?.source
        ? manifest.source(options?.source || options?.sourceId || options?.modelSource)
        : { id: 'modelscope', label: '魔搭社区', host: 'https://www.modelscope.cn/models/', revision: options?.revision, remotePathTemplate: '{model}/resolve/{revision}/' };
      const revision = String(options?.revision || sourceInfo.revision || 'main');
      const variant = manifest?.variant ? manifest.variant(options?.variant || options?.dtype || 'auto', options?.device) : { id: String(options?.variant || 'auto') };
      return { sourceInfo, revision, variant, sourceId: sourceInfo.id, voiceCacheName: `kokoro-voices-${sourceInfo.id}-${revision}`, partialCacheName: `flowloud-model-parts-${sourceInfo.id}-${revision}-${variant.id}` };
    }
    async function createModelFetcher(options, meta) {
      const info = modelSource(options);
      const key = `${info.partialCacheName}:${Number(options?.concurrency) || 4}`;
      let fetcher = voiceFetcherCache.get(key);
      if (!fetcher) {
        const partialCache = await caches.open(info.partialCacheName);
        fetcher = browserModelManifest?.createResumableFetcher
          ? browserModelManifest.createResumableFetcher({
            fetchImpl: globalThis.fetch.bind(globalThis), partialCache,
            concurrency: Number(options?.concurrency) || 4,
            signal: options?.signal,
          })
          : globalThis.fetch.bind(globalThis);
        voiceFetcherCache.set(key, fetcher);
      }
      return { fetcher, info };
    }
    async function ensureVoice(repoId, options, voiceId, controls = {}) {
      const id = String(voiceId || 'zf_001').replace(/^browser-model:/u, '');
      const { fetcher, info } = await createModelFetcher(options, { file: `voices/${id}.bin` });
      const voiceCache = await caches.open(info.voiceCacheName);
      const remoteVoiceUrl = browserModelManifest?.voiceUrl
        ? browserModelManifest.voiceUrl({ repoId, source: info.sourceId, revision: info.revision }, id)
        : `${String(info.sourceInfo.host).replace(/\/$/u, '')}/${repoId}/resolve/${encodeURIComponent(info.revision)}/voices/${id}.bin`;
      if (await voiceCache.match(remoteVoiceUrl)) return { voiceId: id, cached: true, url: remoteVoiceUrl, source: info.sourceId };
      if (options.flowloudOffline === true || controls.offline === true) throw Object.assign(new Error(`Kokoro 音色缓存缺失：${id}。`), { code: 'offline_cache_miss', voiceId: id });
      const response = await fetcher(remoteVoiceUrl, {}, {
        source: info.sourceId, file: `voices/${id}.bin`, signal: controls.signal || options.signal,
        onProgress: controls.onProgress,
      });
      if (!response?.ok) throw Object.assign(new Error(`Kokoro 音色下载失败（HTTP ${response?.status || 0}）。`), { code: `http_${response?.status || 0}`, voiceId: id });
      await voiceCache.put(remoteVoiceUrl, response.clone ? response.clone() : response);
      return { voiceId: id, cached: true, downloaded: true, url: remoteVoiceUrl, source: info.sourceId };
    }
    async function browserPipeline(task, repoId, options) {
      if (repoId === 'onnx-community/Kokoro-82M-v1.1-zh-ONNX') {
        const info = modelSource(options);
        const configuredStarters = Array.isArray(options.starterVoiceIds)
          ? options.starterVoiceIds.map((voice) => String(voice || '').replace(/^browser-model:/u, '')).filter((voice) => browserModelManifest?.VOICE_BY_ID?.[voice])
          : [];
        const starterVoiceIds = options.ensureStarterVoices === true
          ? (configuredStarters.length ? configuredStarters : (browserModelManifest?.STARTER_VOICE_IDS || ['zf_001', 'zf_002', 'zm_009', 'zm_010']))
          : ['zf_001'];
        await Promise.all([...new Set(starterVoiceIds)].map((voiceId) => ensureVoice(repoId, options, voiceId, {
          offline: options.flowloudOffline === true, onProgress: options.progress_callback,
        })));
        if (!kokoroRuntimePromise) kokoroRuntimePromise = import(chromeApi.runtime.getURL('vendor/kokoro/kokoro.web.min.js'));
        const kokoroRuntime = await kokoroRuntimePromise;
        const modelFetch = options.flowloudOffline === true
          ? async () => { throw Object.assign(new Error('Kokoro 离线校验期间禁止访问远程模型。'), { code: 'offline_cache_miss' }); }
          : (resource, init) => {
            const resourceUrl = typeof resource === 'string'
              ? resource
              : resource && typeof resource === 'object' && 'url' in resource
                ? String(resource.url)
                : String(resource);
            const resourceInit = resource && typeof resource === 'object' && 'url' in resource
              ? Object.assign({}, resource, init || {}) : (init || {});
            return createModelFetcher(options, { file: resourceUrl }).then(({ fetcher, info: sourceInfo }) => fetcher(resourceUrl, resourceInit, {
              source: sourceInfo.sourceId, file: resourceUrl, signal: init?.signal || options.signal, onProgress: options.progress_callback,
            }));
          };
        return kokoroRuntime.flowloudCreateKokoro(repoId, Object.assign({}, options, {
          cacheKey: options.cacheKey || (browserModelManifest?.modelKey ? browserModelManifest.modelKey({ repoId, revision: info.revision, source: info.sourceId, variant: info.variant.id, device: options.device }) : `flowloud-model-${repoId}@${info.revision}`),
          wasmPaths: chromeApi.runtime.getURL('vendor/transformers/'),
          remoteHost: info.sourceInfo.host,
          remotePathTemplate: info.sourceInfo.remotePathTemplate,
          fetch: modelFetch,
          voiceCacheName: info.voiceCacheName,
          voicePath: `${String(info.sourceInfo.host).replace(/\/$/u, '')}/${repoId}/resolve/${encodeURIComponent(info.revision)}/voices`,
        }));
      }
      throw Object.assign(new Error('当前扩展只支持 Kokoro 中英浏览器模型。'), { code: 'unsupported_model' });
    }
    browserPipeline.voiceInfo = async (repoId, options) => {
      const info = modelSource(options);
      const id = String(options?.voiceId || 'zf_001').replace(/^browser-model:/u, '');
      const voiceCache = await caches.open(info.voiceCacheName);
      const remoteVoiceUrl = browserModelManifest?.voiceUrl
        ? browserModelManifest.voiceUrl({ repoId, source: info.sourceId, revision: info.revision }, id)
        : `${String(info.sourceInfo.host).replace(/\/$/u, '')}/${repoId}/resolve/${encodeURIComponent(info.revision)}/voices/${id}.bin`;
      return { cached: Boolean(await voiceCache.match(remoteVoiceUrl)), source: info.sourceId };
    };
    browserPipeline.downloadVoice = async (repoId, options) => ensureVoice(repoId, options, options.voiceId, options);
    browserPipeline.deleteVoice = async (repoId, options) => {
      const info = modelSource(options);
      const id = String(options?.voiceId || '').replace(/^browser-model:/u, '');
      const voiceCache = await caches.open(info.voiceCacheName);
      const remoteVoiceUrl = browserModelManifest?.voiceUrl
        ? browserModelManifest.voiceUrl({ repoId, source: info.sourceId, revision: info.revision }, id)
        : `${String(info.sourceInfo.host).replace(/\/$/u, '')}/${repoId}/resolve/${encodeURIComponent(info.revision)}/voices/${id}.bin`;
      return { voiceId: id, deleted: await voiceCache.delete(remoteVoiceUrl), cached: false, source: info.sourceId };
    };
    browserPipeline.repairVoice = async (repoId, options) => {
      await browserPipeline.deleteVoice(repoId, options);
      return browserPipeline.downloadVoice(repoId, options);
    };
    browserPipeline.deleteCache = async (repoId, revision, extra) => {
      if (repoId !== 'onnx-community/Kokoro-82M-v1.1-zh-ONNX') return false;
      const info = modelSource(Object.assign({}, extra || {}, { revision, source: extra?.source || 'modelscope' }));
      // The cache key includes the user-selected concurrency.  Remove every
      // fetcher for this source/revision/variant so changing concurrency after
      // a delete cannot keep a stale partial-cache handle alive.
      for (const key of voiceFetcherCache.keys()) {
        if (key.startsWith(`${info.partialCacheName}:`)) voiceFetcherCache.delete(key);
      }
      await caches.delete(info.partialCacheName);
      return true;
    };
    const broker = createBroker({
      api,
      providerApi,
      providerRegistry,
      providerId: 'browser-system',
      documentProviderApi: documentProviderModule,
      resolveProvider(providerId, message) {
        const options = Object.assign({}, message.providerSettings || {}, {
          apiKey: message.apiKey, clientToken: message.clientToken,
        });
        const modern = providerV4Module || providerV3Module;
        if (providerId === 'openai-compatible') return cachedProvider(providerId, {
          baseUrl: options.baseUrl, model: options.model, voice: options.voice,
          responseFormat: options.responseFormat, apiKey: options.apiKey,
        }, () => modern.createOpenAICompatibleProvider(options));
        if (providerId === 'doubao-tts' && typeof modern.createDoubaoTtsProvider === 'function') return cachedProvider(providerId, {
          baseUrl: options.baseUrl, path: options.path, resourceId: options.resourceId,
          appId: options.appId, voice: options.voice, responseFormat: options.responseFormat, apiKey: options.apiKey,
        }, () => modern.createDoubaoTtsProvider(Object.assign({}, options, { fetchImpl: globalThis.fetch })));
        if (providerId === 'browser-model') return cachedProvider(providerId, {
          modelId: options.modelId, repoId: options.repoId, revision: options.revision,
          source: options.source || options.sourceId || options.modelSource, variant: options.variant,
          dtype: options.dtype, device: options.device, downloadConcurrency: options.downloadConcurrency,
          starterVoiceIds: options.starterVoiceIds,
          allowWasmFallback: options.allowWasmFallback,
        }, () => modern.createBrowserModelProvider(Object.assign({}, options, { pipelineFactory: browserPipeline })));
        if (providerId === 'local-service' && providerV4Module) {
          return cachedProvider(providerId, {
            adapterId: options.adapterId, baseUrl: options.baseUrl, model: options.model,
            responseFormat: options.responseFormat, clientToken: options.clientToken,
          }, () => providerV4Module.createLocalServiceProvider(Object.assign({}, options, {
            fetchImpl: globalThis.fetch,
            enableRemoteCancel: true,
            forwardExternalSignal: true,
            fallbackToSynthesize: false,
          })));
        }
        if (providerId === 'local-qwen' && typeof api.setClientToken === 'function') {
          api.setClientToken(message.clientToken);
        }
        return null;
      },
      enableRemoteCancel: true,
      AudioContextCtor: rootAudioContext(),
      emit(message) {
        // Stream lifecycle notifications must go through the service worker.
        // The worker authenticates the offscreen sender and forwards only to
        // the originating tab, keeping tab delivery in one place.
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
    MODEL_DOWNLOAD_TIMEOUT_MS,
    MODEL_VERIFY_TIMEOUT_MS,
    MAX_AUDIO_BYTES,
    blobToBase64,
    createBroker,
    beginStreamPlayback,
    collectStream,
    errorEnvelope,
    install,
  };
}));
