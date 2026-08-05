const test = require('node:test');
const assert = require('node:assert/strict');

const Transcription = require('../shared/transcription.js');

function resultEvent(entries, resultIndex = 0) {
  const results = new Array(resultIndex + entries.length);
  entries.forEach((entry, offset) => {
    results[resultIndex + offset] = {
      0: { transcript: entry.text },
      isFinal: entry.final,
      length: 1,
    };
  });
  return { type: 'result', resultIndex, results };
}

function endEvent() {
  return { type: 'end' };
}

function errorEvent(error) {
  return { type: 'error', error };
}

function createCountingSignal() {
  const signal = {
    aborted: false,
    addCalls: 0,
    removeCalls: 0,
    listener: null,
    addEventListener(type, listener) {
      assert.equal(type, 'abort');
      this.addCalls += 1;
      this.listener = listener;
    },
    removeEventListener(type, listener) {
      assert.equal(type, 'abort');
      assert.equal(listener, this.listener);
      this.removeCalls += 1;
      this.listener = null;
    },
    abort() {
      if (this.aborted) return;
      this.aborted = true;
      const listener = this.listener;
      if (listener) listener();
    },
  };
  return signal;
}

function createRecognitionHarness(events, options = {}) {
  const state = {
    audioContexts: 0,
    sourceConnects: 0,
    sourceDisconnects: 0,
    sourceStarts: 0,
    destinationDisconnects: 0,
    trackStops: 0,
    recognitionStarts: 0,
    recognitionStops: 0,
    recognitionAborts: 0,
    clearTimeouts: 0,
    recognition: null,
    operations: [],
  };
  const signal = createCountingSignal();
  state.signal = signal;
  const track = { stop() { state.trackStops += 1; } };

  class SpeechRecognitionCtor {
    constructor() {
      state.recognition = this;
    }

    start(receivedTrack) {
      assert.equal(receivedTrack, track);
      state.recognitionStarts += 1;
      state.operations.push('recognition.start');
      if (options.startThrows) throw new TypeError('audio track overload is unavailable');
    }

    stop() {
      state.recognitionStops += 1;
    }

    abort() {
      state.recognitionAborts += 1;
    }
  }

  class AudioContextCtor {
    constructor() {
      state.audioContexts += 1;
    }

    createBuffer(channels, length, sampleRate) {
      assert.equal(channels, 1);
      assert.equal(length, 3);
      assert.equal(sampleRate, 24000);
      return {
        copyToChannel(samples, channel) {
          assert.equal(channel, 0);
          assert.deepEqual([...samples], [...new Float32Array([0.1, 0.2, 0.3])]);
        },
      };
    }

    createBufferSource() {
      return {
        connect(destination) {
          assert.equal(destination, state.destination);
          state.sourceConnects += 1;
        },
        disconnect() { state.sourceDisconnects += 1; },
        start() {
          state.sourceStarts += 1;
          state.operations.push('source.start');
          queueMicrotask(() => {
            if (typeof this.onended === 'function') this.onended();
            for (const event of events) {
              if (event.type === 'result' && typeof state.recognition.onresult === 'function') {
                state.recognition.onresult(event);
              }
              if (event.type === 'error' && typeof state.recognition.onerror === 'function') {
                state.recognition.onerror(event);
              }
              if (event.type === 'end' && typeof state.recognition.onend === 'function') {
                state.recognition.onend(event);
              }
            }
          });
        },
      };
    }

    createMediaStreamDestination() {
      const destination = {
        stream: { getAudioTracks() { return [track]; } },
        disconnect() { state.destinationDisconnects += 1; },
      };
      state.destination = destination;
      return destination;
    }

    close() {
      state.audioContextCloses = (state.audioContextCloses || 0) + 1;
      return options.closePromise || Promise.resolve();
    }
  }

  return {
    state,
    dependencies: {
      SpeechRecognitionCtor,
      AudioContextCtor,
      setTimeout(callback, delay) {
        state.timerCallback = callback;
        state.timeoutMs = delay;
        return 41;
      },
      clearTimeout(timer) {
        assert.equal(timer, 41);
        state.clearTimeouts += 1;
      },
    },
    request: {
      samples: new Float32Array([0.1, 0.2, 0.3]),
      sampleRate: 24000,
      signal,
    },
    signal,
    fireTimeout() {
      if (state.timerCallback) state.timerCallback();
    },
  };
}

function assertCleanedOnce(state) {
  assert.equal(state.sourceDisconnects, 1);
  assert.equal(state.destinationDisconnects, 1);
  assert.equal(state.trackStops, 1);
  assert.equal(state.clearTimeouts, 1);
  assert.equal(state.audioContextCloses, 1);
  assert.equal(state.signal.addCalls, 1);
  assert.equal(state.signal.removeCalls, 1);
}

test('aggregates final results once and ignores interim duplicates', async () => {
  const fake = createRecognitionHarness([
    resultEvent([{ text: '今天', final: false }, { text: '今天', final: true }]),
    resultEvent([{ text: '天气很好', final: true }]),
    endEvent(),
  ]);
  const provider = Transcription.createEdgeSpeechProvider(fake.dependencies);

  const result = await provider.transcribe(fake.request);

  assert.equal(result.text, '今天天气很好');
  assert.equal(fake.state.recognition.lang, 'zh-CN');
  assert.equal(fake.state.recognition.continuous, true);
  assert.equal(fake.state.recognition.interimResults, true);
  assert.equal(fake.state.recognition.maxAlternatives, 1);
  assert.equal(fake.state.recognitionStarts, 1);
  assert.equal(fake.state.sourceConnects, 1);
  assert.equal(fake.state.sourceStarts, 1);
  assert.deepEqual(fake.state.operations, ['recognition.start', 'source.start']);
  assert.equal(fake.state.recognitionStops, 1);
  assert.equal(fake.state.recognitionAborts, 0);
  assert.equal(Object.prototype.hasOwnProperty.call(fake.state.recognition, 'processLocally'), false);
  assertCleanedOnce(fake.state);
  fake.fireTimeout();
  assertCleanedOnce(fake.state);
});

test('reports an unsupported browser before creating audio nodes', async () => {
  let audioContexts = 0;
  const provider = Transcription.createEdgeSpeechProvider({
    SpeechRecognitionCtor: null,
    AudioContextCtor: class {
      constructor() { audioContexts += 1; }
    },
  });

  await assert.rejects(
    provider.transcribe({ samples: new Float32Array([0.1]), sampleRate: 24000 }),
    (error) => error.code === 'speech_recognition_unsupported' && error.retryable === false,
  );
  assert.equal(audioContexts, 0);
});

function failure(code) {
  return Object.assign(new Error(code), { code });
}

function sequenceProvider(responses) {
  return {
    calls: 0,
    async transcribe() {
      this.calls += 1;
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return response;
    },
  };
}

test('retries network twice and then returns the third result', async () => {
  const provider = sequenceProvider([failure('network'), failure('network'), { text: '成功' }]);
  const waits = [];

  const result = await Transcription.transcribeWithRetry(provider, {
    samples: new Float32Array([0.1]), sampleRate: 24000,
  }, {
    retries: 2,
    delaysMs: [0, 0],
    wait: async (delay) => { waits.push(delay); },
  });

  assert.equal(result.text, '成功');
  assert.equal(provider.calls, 3);
  assert.deepEqual(waits, [0, 0]);
});

test('uses one and three second default retry delays', async () => {
  const provider = sequenceProvider([failure('network'), failure('network'), { text: '成功' }]);
  const waits = [];

  await Transcription.transcribeWithRetry(provider, {
    samples: new Float32Array([0.1]), sampleRate: 24000,
  }, { wait: async (delay) => { waits.push(delay); } });

  assert.equal(provider.calls, 3);
  assert.deepEqual(waits, [1000, 3000]);
});

test('does not retry a policy denial', async () => {
  const provider = sequenceProvider([failure('service-not-allowed')]);

  await assert.rejects(
    Transcription.transcribeWithRetry(provider, {
      samples: new Float32Array([0.1]), sampleRate: 24000,
    }, { retries: 2, wait: async () => {} }),
    (error) => error.code === 'service-not-allowed'
      && error.retryable === false
      && provider.calls === 1,
  );
});

test('retries no-speech only once even when more retries are available', async () => {
  const provider = sequenceProvider([
    failure('no-speech'),
    failure('no-speech'),
    { text: 'must not be reached' },
  ]);

  await assert.rejects(
    Transcription.transcribeWithRetry(provider, {
      samples: new Float32Array([0.1]), sampleRate: 24000,
    }, { retries: 2, delaysMs: [0, 0], wait: async () => {} }),
    (error) => error.code === 'no-speech' && provider.calls === 2,
  );
});

test('classifies a recognition network error as transient and cleans resources once', async () => {
  const fake = createRecognitionHarness([errorEvent('network'), endEvent()]);
  const provider = Transcription.createEdgeSpeechProvider(fake.dependencies);

  await assert.rejects(
    provider.transcribe(fake.request),
    (error) => error.code === 'network' && error.retryable === true,
  );

  assert.equal(fake.state.recognitionStops, 1);
  assert.equal(fake.state.recognitionAborts, 0);
  assertCleanedOnce(fake.state);
  fake.fireTimeout();
  assertCleanedOnce(fake.state);
});

test('times out at audio duration plus fifteen seconds and cleans resources once', async () => {
  const fake = createRecognitionHarness([]);
  const provider = Transcription.createEdgeSpeechProvider(fake.dependencies);
  const pending = provider.transcribe({ ...fake.request, durationSeconds: 2.5 });

  assert.equal(fake.state.timeoutMs, 17500);
  fake.fireTimeout();

  const outcome = await Promise.race([
    pending.then(
      () => ({ resolved: true }),
      (error) => ({ error }),
    ),
    new Promise((resolve) => setImmediate(() => resolve({ pending: true }))),
  ]);
  assert.equal(outcome.error && outcome.error.code, 'recognition_timeout');
  assert.equal(outcome.error && outcome.error.retryable, true);
  assert.equal(fake.state.recognitionStops, 0);
  assert.equal(fake.state.recognitionAborts, 1);
  assertCleanedOnce(fake.state);
  fake.fireTimeout();
  assertCleanedOnce(fake.state);
});

test('abort signal stops recognition without retrying and cleans resources once', async () => {
  const fake = createRecognitionHarness([]);
  const provider = Transcription.createEdgeSpeechProvider(fake.dependencies);
  const retrying = Transcription.transcribeWithRetry(provider, fake.request, {
    retries: 2,
    delaysMs: [0, 0],
    wait: async () => {},
  });

  fake.signal.abort();

  await assert.rejects(retrying, (error) => error.name === 'AbortError' && error.retryable === false);
  assert.equal(fake.state.recognitionStarts, 1);
  assert.equal(fake.state.recognitionStops, 0);
  assert.equal(fake.state.recognitionAborts, 1);
  assertCleanedOnce(fake.state);
  fake.signal.abort();
  fake.fireTimeout();
  assertCleanedOnce(fake.state);
});

test('retries a non-user recognition abort', async () => {
  const provider = sequenceProvider([failure('aborted'), { text: '恢复' }]);

  const result = await Transcription.transcribeWithRetry(provider, {
    samples: new Float32Array([0.1]), sampleRate: 24000,
  }, { retries: 2, delaysMs: [0], wait: async () => {} });

  assert.equal(result.text, '恢复');
  assert.equal(provider.calls, 2);
});

test('reports an empty final result as transient and cleans resources once', async () => {
  const fake = createRecognitionHarness([endEvent()]);
  const provider = Transcription.createEdgeSpeechProvider(fake.dependencies);

  await assert.rejects(
    provider.transcribe(fake.request),
    (error) => error.code === 'empty_result' && error.retryable === true,
  );

  assert.equal(fake.state.recognitionStops, 1);
  assert.equal(fake.state.recognitionAborts, 0);
  assertCleanedOnce(fake.state);
});

test('maps an unsupported audio-track overload to a permanent error and cleans resources once', async () => {
  const fake = createRecognitionHarness([], { startThrows: true });
  const provider = Transcription.createEdgeSpeechProvider(fake.dependencies);

  await assert.rejects(
    provider.transcribe(fake.request),
    (error) => error.code === 'audio_track_unsupported' && error.retryable === false,
  );

  assert.equal(fake.state.recognitionStarts, 1);
  assert.equal(fake.state.sourceStarts, 0);
  assert.equal(fake.state.recognitionStops, 0);
  assert.equal(fake.state.recognitionAborts, 1);
  assertCleanedOnce(fake.state);
});

test('classifies permanent Web Speech policy and language failures', () => {
  for (const code of ['not-allowed', 'service-not-allowed', 'language-not-supported']) {
    const error = Transcription.classifyError(failure(code));
    assert.equal(error.code, code);
    assert.equal(error.retryable, false);
  }
});

test('waits for asynchronous audio-context cleanup before settling', async () => {
  let releaseClose;
  const closePromise = new Promise((resolve) => { releaseClose = resolve; });
  const fake = createRecognitionHarness([
    resultEvent([{ text: '已清理', final: true }]),
    endEvent(),
  ], { closePromise });
  const provider = Transcription.createEdgeSpeechProvider(fake.dependencies);
  let settled = false;
  const pending = provider.transcribe(fake.request).finally(() => { settled = true; });

  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(settled, false);
  assertCleanedOnce(fake.state);
  fake.fireTimeout();
  assertCleanedOnce(fake.state);
  releaseClose();
  assert.equal((await pending).text, '已清理');
  assert.equal(settled, true);
  assertCleanedOnce(fake.state);
});

test('abort during retry backoff rejects immediately without another provider call', async () => {
  const signal = createCountingSignal();
  const provider = sequenceProvider([failure('network'), { text: 'must not be reached' }]);
  const pending = Transcription.transcribeWithRetry(provider, {
    samples: new Float32Array([0.1]), sampleRate: 24000, signal,
  }, {
    retries: 2,
    delaysMs: [1000, 3000],
    wait: () => new Promise(() => {}),
  });
  await new Promise((resolve) => setImmediate(resolve));

  signal.abort();
  const outcome = await Promise.race([
    pending.then(
      () => ({ resolved: true }),
      (error) => ({ error }),
    ),
    new Promise((resolve) => setImmediate(() => resolve({ pending: true }))),
  ]);

  assert.equal(outcome.error && outcome.error.name, 'AbortError');
  assert.equal(provider.calls, 1);
  assert.equal(signal.addCalls, 1);
  assert.equal(signal.removeCalls, 1);
});
