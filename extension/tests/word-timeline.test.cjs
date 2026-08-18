const assert = require('node:assert/strict');
const test = require('node:test');

const Timeline = require('../shared/word-timeline.js');

function sampleTimeline(overrides) {
  return Timeline.createTimeline(Object.assign({
    segmentIndex: 2,
    segmentId: 'segment-2',
    playbackId: 'playback-2',
    speechText: '你好，世界。Hello world',
    durationSeconds: 10,
    words: [
      { text: '你好', speechStart: 0, speechEnd: 2, sourceStart: 0, sourceEnd: 2 },
      { text: '世界', speechStart: 3, speechEnd: 5, sourceStart: 3, sourceEnd: 5 },
      { text: 'Hello', speechStart: 6, speechEnd: 11, sourceStart: 6, sourceEnd: 11 },
      { text: 'world', speechStart: 12, speechEnd: 17, sourceStart: 12, sourceEnd: 17 }
    ]
  }, overrides || {}));
}

test('wordIndexAtProgress uses duration-ratio text positions and assigns punctuation gaps to the previous word', () => {
  const timeline = sampleTimeline();

  assert.equal(Timeline.wordIndexAtProgress(timeline, { playedSeconds: 0 }), 0);
  assert.equal(Timeline.wordIndexAtProgress(timeline, { playedSeconds: 1.1 }), 0);
  assert.equal(Timeline.wordIndexAtProgress(timeline, { playedSeconds: 2 }), 1);
  assert.equal(Timeline.wordIndexAtProgress(timeline, { playedSeconds: 5 }), 2);
  assert.equal(Timeline.wordIndexAtProgress(timeline, { playedSeconds: 10 }), 3);
  assert.equal(Timeline.wordIndexAtProgress(timeline, { playedSeconds: 10, done: true }), 3);
});
test('applyProgress is monotonic and ignores duplicate or stale event sequences', () => {
  const timeline = sampleTimeline();

  const first = Timeline.applyProgress(timeline, {
    playedSeconds: 1,
    durationSeconds: 10,
    scheduledSeconds: 3,
    bufferedSeconds: 2,
    sequence: 4
  });
  assert.equal(first.index, 0);
  assert.equal(first.changed, true);
  assert.equal(timeline.lastEventSequence, 4);

  const stale = Timeline.applyProgress(timeline, {
    playedSeconds: 9,
    durationSeconds: 10,
    sequence: 3
  });
  assert.equal(stale.ignored, true);
  assert.equal(stale.index, 0);
  assert.equal(timeline.playedSeconds, 1);

  const next = Timeline.applyProgress(timeline, {
    playedSeconds: 6,
    durationSeconds: 10,
    scheduledSeconds: 7,
    sequence: 5
  });
  assert.equal(next.index, 2);
  assert.equal(next.changed, true);
  assert.equal(timeline.playedSeconds, 6);
});

test('finish is idempotent and clears buffered time while selecting the final word', () => {
  const timeline = sampleTimeline();
  Timeline.applyProgress(timeline, {
    playedSeconds: 4,
    durationSeconds: 10,
    scheduledSeconds: 8,
    bufferedSeconds: 4,
    sequence: 1
  });

  const finished = Timeline.finish(timeline, { durationSeconds: 10, sequence: 2 });
  assert.equal(finished, timeline);
  assert.equal(timeline.finished, true);
  assert.equal(timeline.activeWordIndex, 3);
  assert.equal(timeline.playedSeconds, 10);
  assert.equal(timeline.bufferedSeconds, 0);

  Timeline.finish(timeline, { durationSeconds: 10, sequence: 2 });
  assert.equal(timeline.activeWordIndex, 3);
  assert.equal(timeline.lastEventSequence, 2);
});

test('missing duration falls back to scheduled-ratio timing and reset returns an idle timeline', () => {
  const timeline = sampleTimeline({ durationSeconds: null });
  assert.equal(timeline.timingMode, 'unavailable');
  const progress = Timeline.applyProgress(timeline, {
    playedSeconds: 2,
    scheduledSeconds: 4,
    sequence: 1
  });

  assert.equal(progress.index, 2);
  assert.equal(timeline.timingMode, 'scheduled-ratio');
  Timeline.reset(timeline);
  assert.equal(timeline.activeWordIndex, -1);
  assert.equal(timeline.playedSeconds, 0);
  assert.equal(timeline.scheduledSeconds, 0);
  assert.equal(timeline.finished, false);
  assert.equal(timeline.lastEventSequence, -1);
});
