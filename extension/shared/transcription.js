(function transcriptionModule(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.QwenReaderTranscription = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function makeTranscription(root) {
  'use strict';

  const TRANSIENT_CODES = new Set([
    'network',
    'aborted',
    'no-speech',
    'recognition_timeout',
    'empty_result',
  ]);
  const PERMANENT_CODES = new Set([
    'not-allowed',
    'service-not-allowed',
    'language-not-supported',
    'speech_recognition_unsupported',
    'audio_track_unsupported',
  ]);

  class RecognitionFailure extends Error {
    constructor(code, message, retryable) {
      super(message || code);
      this.name = 'RecognitionFailure';
      this.code = code;
      this.retryable = retryable;
    }
  }

  function classifyError(error) {
    if (error && error.name === 'AbortError') {
      error.retryable = false;
      return error;
    }
    if (error instanceof RecognitionFailure) return error;
    const rawCode = error && (error.error || error.code);
    const code = typeof rawCode === 'string' && rawCode ? rawCode : 'recognition_failed';
    const retryable = TRANSIENT_CODES.has(code) && !PERMANENT_CODES.has(code);
    return new RecognitionFailure(code, error && error.message, retryable);
  }

  function abortError() {
    const error = new Error('The transcription was aborted.');
    error.name = 'AbortError';
    error.retryable = false;
    return error;
  }

  function createEdgeSpeechProvider(dependencies) {
    const config = dependencies || {};
    const SpeechRecognitionCtor = Object.prototype.hasOwnProperty.call(config, 'SpeechRecognitionCtor')
      ? config.SpeechRecognitionCtor
      : (root.SpeechRecognition || root.webkitSpeechRecognition);
    const AudioContextCtor = config.AudioContextCtor || root.AudioContext || root.webkitAudioContext;
    const setTimer = config.setTimeout || root.setTimeout;
    const clearTimer = config.clearTimeout || root.clearTimeout;

    return {
      transcribe(request) {
        if (!SpeechRecognitionCtor) {
          return Promise.reject(classifyError({ code: 'speech_recognition_unsupported' }));
        }
        if (request && request.signal && request.signal.aborted) {
          return Promise.reject(abortError());
        }
        return new Promise((resolve, reject) => {
          let recognition;
          let audioContext;
          let source;
          let destination;
          let track;
          let timer;
          let settled = false;
          let recognitionHalted = false;
          let cleanupPromise;
          let abortListenerAttached = false;
          const finalResults = new Map();
          let observedResultSpan = 0;
          const signal = request && request.signal;

          function cleanup(abortRecognition) {
            if (cleanupPromise) return cleanupPromise;
            if (timer !== undefined && typeof clearTimer === 'function') clearTimer(timer);
            timer = undefined;
            if (abortListenerAttached && signal && typeof signal.removeEventListener === 'function') {
              signal.removeEventListener('abort', onAbort);
              abortListenerAttached = false;
            }
            if (recognition) {
              recognition.onresult = null;
              recognition.onerror = null;
              recognition.onend = null;
            }
            if (source) source.onended = null;
            if (abortRecognition && recognition && !recognitionHalted) {
              recognitionHalted = true;
              try { recognition.abort(); } catch (_) { /* already stopped */ }
            }
            try { if (source) source.disconnect(); } catch (_) { /* already disconnected */ }
            try { if (destination) destination.disconnect(); } catch (_) { /* already disconnected */ }
            try { if (track) track.stop(); } catch (_) { /* already stopped */ }
            let closing;
            try {
              closing = audioContext && typeof audioContext.close === 'function'
                ? audioContext.close()
                : undefined;
            } catch (_) {
              closing = undefined;
            }
            cleanupPromise = Promise.resolve(closing).catch(() => {});
            return cleanupPromise;
          }

          function finish(error, result, abortRecognition) {
            if (settled) return;
            settled = true;
            cleanup(abortRecognition).then(() => {
              if (error) reject(classifyError(error));
              else resolve(result);
            });
          }

          function onAbort() {
            finish(abortError(), null, true);
          }

          try {
            recognition = new SpeechRecognitionCtor();
            recognition.lang = request.lang || 'zh-CN';
            recognition.continuous = true;
            recognition.interimResults = true;
            recognition.maxAlternatives = 1;

            audioContext = new AudioContextCtor({ sampleRate: request.sampleRate });
            const buffer = audioContext.createBuffer(1, request.samples.length, request.sampleRate);
            buffer.copyToChannel(request.samples, 0);
            source = audioContext.createBufferSource();
            source.buffer = buffer;
            destination = audioContext.createMediaStreamDestination();
            source.connect(destination);
            const tracks = destination.stream && destination.stream.getAudioTracks
              ? destination.stream.getAudioTracks()
              : [];
            track = tracks[0];
            if (!track) throw { code: 'audio_track_unsupported' };

            recognition.onresult = (event) => {
              const first = Number.isInteger(event.resultIndex) ? event.resultIndex : 0;
              const incrementalOffset = first === 0 && event.results.length < observedResultSpan
                ? observedResultSpan
                : 0;
              for (let index = first; index < event.results.length; index += 1) {
                const result = event.results[index];
                if (!result || !result.isFinal || !result[0]) continue;
                finalResults.set(incrementalOffset + index, String(result[0].transcript || ''));
              }
              observedResultSpan = Math.max(
                observedResultSpan,
                incrementalOffset + event.results.length,
              );
            };
            recognition.onerror = (event) => {
              finish({ code: event && event.error }, null, true);
            };
            recognition.onend = () => {
              const text = [...finalResults.entries()]
                .sort((left, right) => left[0] - right[0])
                .map((entry) => entry[1])
                .join('')
                .trim();
              if (!text) finish({ code: 'empty_result' }, null, false);
              else finish(null, { text: text }, false);
            };
            source.onended = () => {
              if (recognitionHalted) return;
              recognitionHalted = true;
              try {
                recognition.stop();
              } catch (error) {
                finish(error, null, true);
              }
            };
            if (signal && typeof signal.addEventListener === 'function') {
              signal.addEventListener('abort', onAbort, { once: true });
              abortListenerAttached = true;
              if (signal.aborted) {
                onAbort();
                return;
              }
            }
            const durationSeconds = Number.isFinite(request.durationSeconds)
              ? request.durationSeconds
              : request.samples.length / request.sampleRate;
            timer = setTimer(() => {
              finish({ code: 'recognition_timeout' }, null, true);
            }, durationSeconds * 1000 + 15000);

            try {
              recognition.start(track);
            } catch (_) {
              finish({ code: 'audio_track_unsupported' }, null, true);
              return;
            }
            source.start();
          } catch (error) {
            finish(error, null, true);
          }
        });
      },
    };
  }

  function waitWithAbort(waitPromise, signal) {
    if (!signal || typeof signal.addEventListener !== 'function') return waitPromise;
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      let settled = false;

      function finish(callback, value) {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        callback(value);
      }

      function onAbort() {
        finish(reject, abortError());
      }

      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }
      Promise.resolve(waitPromise).then(
        (value) => finish(resolve, value),
        (error) => finish(reject, error),
      );
    });
  }

  function defaultWait(delay, signal) {
    if (!signal || typeof signal.addEventListener !== 'function') {
      return new Promise((resolve) => root.setTimeout(resolve, delay));
    }
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      let timer;
      let settled = false;

      function cleanup() {
        signal.removeEventListener('abort', onAbort);
      }

      function onAbort() {
        if (settled) return;
        settled = true;
        if (timer !== undefined) root.clearTimeout(timer);
        cleanup();
        reject(abortError());
      }

      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }
      timer = root.setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      }, delay);
    });
  }

  async function transcribeWithRetry(provider, request, options) {
    const config = options || {};
    const retries = Number.isInteger(config.retries) && config.retries >= 0 ? config.retries : 2;
    const delays = Array.isArray(config.delaysMs) && config.delaysMs.length
      ? config.delaysMs
      : [1000, 3000];
    const customWait = typeof config.wait === 'function' ? config.wait : null;
    let retryIndex = 0;
    let noSpeechRetried = false;

    while (true) {
      if (request && request.signal && request.signal.aborted) throw abortError();
      try {
        return await provider.transcribe(request);
      } catch (rawError) {
        const error = classifyError(rawError);
        if (error.name === 'AbortError' || (request && request.signal && request.signal.aborted)) {
          throw error.name === 'AbortError' ? error : abortError();
        }
        let canRetry = error.retryable && retryIndex < retries;
        if (error.code === 'no-speech') {
          if (noSpeechRetried) canRetry = false;
          else noSpeechRetried = true;
        }
        if (!canRetry) throw error;
        const delay = delays[retryIndex] === undefined
          ? delays[delays.length - 1]
          : delays[retryIndex];
        retryIndex += 1;
        const signal = request && request.signal;
        if (customWait) {
          await waitWithAbort(Promise.resolve().then(() => customWait(delay, signal)), signal);
        } else {
          await defaultWait(delay, signal);
        }
        if (request && request.signal && request.signal.aborted) throw abortError();
      }
    }
  }

  return Object.freeze({ createEdgeSpeechProvider, classifyError, transcribeWithRetry });
}));
