(function attachWordTimeline(global, factory) {
  'use strict';

  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  global.QwenReaderWordTimeline = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function makeWordTimeline() {
  'use strict';

  const EPSILON = 0.0001;

  function finiteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function cloneWords(words) {
    return (Array.isArray(words) ? words : [])
      .map((word, index) => {
        const source = word || {};
        const speechStart = finiteNumber(source.speechStart);
        const speechEnd = finiteNumber(source.speechEnd);
        if (speechStart === null || speechEnd === null || speechEnd <= speechStart) return null;
        return Object.assign({}, source, {
          index: Number.isInteger(source.index) ? source.index : index,
          text: String(source.text == null ? '' : source.text),
          speechStart: Math.max(0, Math.floor(speechStart)),
          speechEnd: Math.max(0, Math.floor(speechEnd))
        });
      })
      .filter(Boolean)
      .sort((left, right) => left.speechStart - right.speechStart || left.index - right.index)
      .map((word, index) => Object.assign({}, word, { index }));
  }

  function speechLengthOf(words, speechText) {
    const textLength = String(speechText == null ? '' : speechText).length;
    const wordLength = words.reduce((maximum, word) => Math.max(maximum, word.speechEnd), 0);
    return Math.max(textLength, wordLength);
  }

  function durationOf(value) {
    const duration = finiteNumber(value);
    return duration !== null && duration > EPSILON ? duration : null;
  }

  function createTimeline(input) {
    const source = input || {};
    const words = cloneWords(source.words);
    const durationSeconds = durationOf(source.durationSeconds);
    return {
      segmentIndex: Number.isInteger(source.segmentIndex) ? source.segmentIndex : -1,
      segmentId: String(source.segmentId == null ? '' : source.segmentId),
      playbackId: String(source.playbackId == null ? '' : source.playbackId),
      words,
      speechLength: speechLengthOf(words, source.speechText),
      durationSeconds,
      timingMode: durationSeconds === null ? 'unavailable' : 'duration-ratio',
      playedSeconds: 0,
      scheduledSeconds: 0,
      bufferedSeconds: 0,
      activeWordIndex: -1,
      lastEventSequence: -1,
      finished: false
    };
  }

  function normalizeProgress(timeline, progress) {
    const event = progress || {};
    const duration = durationOf(event.durationSeconds) || timeline.durationSeconds;
    const playedValue = finiteNumber(event.playedSeconds);
    const scheduledValue = finiteNumber(event.scheduledSeconds);
    const bufferedValue = finiteNumber(event.bufferedSeconds);
    const sequenceValue = finiteNumber(event.sequence ?? event.eventSequence);
    const speechOffsetValue = finiteNumber(event.speechOffset ?? event.charIndex);
    const playedSeconds = playedValue === null
      ? timeline.playedSeconds
      : Math.max(timeline.playedSeconds, playedValue);
    const scheduledSeconds = scheduledValue === null
      ? timeline.scheduledSeconds
      : Math.max(timeline.scheduledSeconds, scheduledValue);
    const boundedPlayed = duration === null
      ? Math.max(0, playedSeconds)
      : clamp(playedSeconds, 0, duration);
    const boundedScheduled = Math.max(scheduledSeconds, boundedPlayed);
    return {
      durationSeconds: duration,
      playedSeconds: boundedPlayed,
      scheduledSeconds: boundedScheduled,
      bufferedSeconds: bufferedValue === null
        ? Math.max(0, boundedScheduled - boundedPlayed)
        : Math.max(0, bufferedValue),
      sequence: sequenceValue,
      speechOffset: speechOffsetValue === null
        ? null
        : clamp(speechOffsetValue, 0, Math.max(0, timeline.speechLength)),
      done: event.done === true || event.event === 'ended'
    };
  }

  function wordIndexAtSpeechOffset(timeline, value) {
    const words = timeline && Array.isArray(timeline.words) ? timeline.words : [];
    if (!words.length) return -1;
    const offsetValue = finiteNumber(value);
    if (offsetValue === null) return -1;
    const offset = clamp(offsetValue, 0, Math.max(0, timeline.speechLength));
    for (const word of words) {
      if (offset <= word.speechStart || offset < word.speechEnd) return word.index;
    }
    return words.length - 1;
  }

  function wordIndexAtProgress(timeline, progress) {
    const words = timeline && Array.isArray(timeline.words) ? timeline.words : [];
    if (!words.length) return -1;
    const snapshot = normalizeProgress(timeline, progress);
    if (snapshot.speechOffset !== null) return wordIndexAtSpeechOffset(timeline, snapshot.speechOffset);
    let ratio = null;
    if (snapshot.durationSeconds !== null) {
      ratio = clamp(snapshot.playedSeconds / snapshot.durationSeconds, 0, 1);
    } else if (snapshot.scheduledSeconds > EPSILON) {
      ratio = clamp(snapshot.playedSeconds / snapshot.scheduledSeconds, 0, 1);
    }
    if (ratio === null) return -1;
    if (snapshot.done || ratio >= 1 - EPSILON) return words.length - 1;

    const speechLength = Math.max(1, timeline.speechLength || words[words.length - 1].speechEnd);
    const speechOffset = clamp(ratio * speechLength, 0, speechLength - EPSILON);
    let previous = words[0];
    for (const word of words) {
      if (speechOffset < word.speechStart) return previous.index;
      if (speechOffset < word.speechEnd) return word.index;
      previous = word;
    }
    return words.length - 1;
  }

  function applyProgress(timeline, progress) {
    const current = timeline && typeof timeline === 'object' ? timeline : createTimeline();
    const event = progress || {};
    const previousIndex = current.activeWordIndex;
    const sequence = finiteNumber(event.sequence ?? event.eventSequence);
    if (sequence !== null && sequence <= current.lastEventSequence) {
      return {
        timeline: current,
        index: current.activeWordIndex,
        changed: false,
        ignored: true,
        done: current.finished
      };
    }

    const snapshot = normalizeProgress(current, event);
    const nextIndex = wordIndexAtProgress(current, snapshot);
    const nextDone = current.finished || snapshot.done;
    current.durationSeconds = snapshot.durationSeconds;
    current.timingMode = snapshot.durationSeconds !== null
      ? 'duration-ratio'
      : (snapshot.speechOffset !== null ? 'character-boundary' : snapshot.scheduledSeconds > EPSILON ? 'scheduled-ratio' : 'unavailable');
    current.playedSeconds = snapshot.playedSeconds;
    current.scheduledSeconds = snapshot.scheduledSeconds;
    current.bufferedSeconds = snapshot.bufferedSeconds;
    current.activeWordIndex = nextDone && current.words.length
      ? current.words.length - 1
      : nextIndex;
    current.finished = nextDone;
    if (sequence !== null) current.lastEventSequence = sequence;
    return {
      timeline: current,
      index: current.activeWordIndex,
      changed: current.activeWordIndex !== previousIndex,
      ignored: false,
      done: current.finished
    };
  }

  function finish(timeline, progress) {
    const current = timeline && typeof timeline === 'object' ? timeline : createTimeline();
    const snapshot = normalizeProgress(current, Object.assign({}, progress || {}, { done: true }));
    current.durationSeconds = snapshot.durationSeconds;
    current.timingMode = snapshot.durationSeconds !== null ? 'duration-ratio' : current.timingMode;
    current.playedSeconds = snapshot.durationSeconds === null
      ? snapshot.playedSeconds
      : snapshot.durationSeconds;
    current.scheduledSeconds = Math.max(snapshot.scheduledSeconds, current.playedSeconds);
    current.bufferedSeconds = 0;
    current.activeWordIndex = current.words.length ? current.words.length - 1 : -1;
    current.finished = true;
    const sequence = finiteNumber(progress && (progress.sequence ?? progress.eventSequence));
    if (sequence !== null) current.lastEventSequence = Math.max(current.lastEventSequence, sequence);
    return current;
  }

  function reset(timeline) {
    const current = timeline && typeof timeline === 'object' ? timeline : createTimeline();
    current.playedSeconds = 0;
    current.scheduledSeconds = 0;
    current.bufferedSeconds = 0;
    current.activeWordIndex = -1;
    current.lastEventSequence = -1;
    current.finished = false;
    return current;
  }

  return Object.freeze({
    EPSILON,
    createTimeline,
    wordIndexAtSpeechOffset,
    wordIndexAtProgress,
    selectWordAtProgress: wordIndexAtProgress,
    applyProgress,
    finish,
    reset
  });
});
