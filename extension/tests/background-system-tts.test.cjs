const test = require('node:test');
const assert = require('node:assert/strict');
const { createChromeTtsManager } = require('../background.js');

test('chrome.tts provider reports voices and normalizes playback options', async () => {
  let spoken;
  const events = [];
  const manager = createChromeTtsManager({
    tts: {
      getVoices(callback) { callback([{ voiceName: 'System Voice', lang: 'zh-CN', eventTypes: ['word'] }]); },
      speak(input, options) { spoken = { input, options }; options.onEvent({ type: 'start' }); options.onEvent({ type: 'word', charIndex: 2, charLength: 1 }); },
      stop() {}, pause() {}, resume() {},
    },
    tabs: { sendMessage(_tabId, payload) { events.push(payload); return Promise.resolve(); } },
  });
  const voices = await manager.voices();
  assert.equal(voices[0].id, 'browser-system:System Voice');
  const result = await manager.request({ type: 'tts:synthesize', sourceTabId: 7, requestId: 'req', playbackId: 'play', playbackRate: 3, request: { input: '你好', voice: 'browser-system:System Voice', pitch: 1.2, volume: .8 } });
  assert.equal(result.ok, true);
  assert.equal(spoken.input, '你好');
  assert.equal(spoken.options.rate, 2);
  assert.equal(spoken.options.voiceName, 'System Voice');
  assert.equal(events[1].event, 'boundary');
  assert.equal(events[1].preciseBoundary, true);
});

test('chrome.tts completion may arrive synchronously without losing request result', async () => {
  const manager = createChromeTtsManager({ tts: {
    speak(_input, options) { options.onEvent({ type: 'end' }); },
    stop() {}, pause() {}, resume() {}, getVoices(callback) { callback([]); },
  } });
  const result = await manager.request({ type: 'tts:synthesize', requestId: 'sync-end', request: { input: 'done' } });
  assert.equal(result.requestId, 'sync-end');
  assert.equal(manager.active(), null);
});

test('system speech pause is immediate and a late end cannot advance a paused session', async () => {
  let options;
  const events = [];
  const manager = createChromeTtsManager({
    tts: {
      getVoices(callback) { callback([{ voiceName: 'Sparse Events', eventTypes: [] }]); },
      speak(_input, nextOptions) { options = nextOptions; nextOptions.onEvent({ type: 'start' }); },
      stop() {}, pause() {}, resume() {},
    },
    tabs: { sendMessage(_tabId, payload) { events.push(payload); return Promise.resolve(); } },
  });
  await manager.request({ type: 'tts:synthesize', sourceTabId: 4, requestId: 'late-end', request: { input: '第一句。第二句。', voice: 'browser-system:Sparse Events' } });
  const paused = await manager.control({ type: 'tts:pause', requestId: 'late-end' });
  assert.equal(paused.paused, true);
  assert.equal(manager.active().state, 'paused');
  options.onEvent({ type: 'end' });
  assert.equal(manager.active().state, 'paused');
  assert.equal(events.at(-1).event, 'paused');
  assert.equal(events.at(-1).capabilityMode, 'sentence-restart');
});

test('system speech resume watchdog restarts at the last safe boundary when a voice stalls', async () => {
  const spoken = [];
  const events = [];
  const manager = createChromeTtsManager({
    tts: {
      getVoices(callback) { callback([{ voiceName: 'Word Voice', eventTypes: ['word'] }]); },
      speak(input, options) {
        spoken.push({ input, options });
        options.onEvent({ type: 'start' });
        if (spoken.length === 1) options.onEvent({ type: 'word', charIndex: 3, charLength: 1 });
      },
      stop() {}, pause() {}, resume() {},
    },
    tabs: { sendMessage(_tabId, payload) { events.push(payload); return Promise.resolve(); } },
  });
  await manager.request({ type: 'tts:synthesize', sourceTabId: 5, requestId: 'watchdog', request: { input: '甲乙丙丁戊', voice: 'browser-system:Word Voice' } });
  await manager.control({ type: 'tts:pause', requestId: 'watchdog' });
  await manager.control({ type: 'tts:resume', requestId: 'watchdog' });
  await new Promise((resolve) => setTimeout(resolve, 760));
  assert.equal(spoken.length, 2);
  assert.equal(spoken[1].input, '丁戊');
  assert.ok(events.some((event) => event.event === 'resumed' && event.restartedFromBoundary === true && event.charIndex === 3));
});
