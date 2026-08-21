(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.QwenReaderRecording = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function createRecordingGate() {
    let phase = 'idle';
    let generation = 0;

    return Object.freeze({
      begin() {
        if (phase !== 'idle') return null;
        generation += 1;
        phase = 'starting';
        return generation;
      },
      activate(token) {
        if (phase !== 'starting' || Number(token) !== generation) return false;
        phase = 'recording';
        return true;
      },
      fail(token) {
        if (phase !== 'starting' || Number(token) !== generation) return false;
        phase = 'idle';
        return true;
      },
      cancel() {
        generation += 1;
        phase = 'idle';
      },
      stop() {
        generation += 1;
        phase = 'idle';
      },
      isStarting() {
        return phase === 'starting';
      },
      isRecording() {
        return phase === 'recording';
      },
      isIdle() {
        return phase === 'idle';
      }
    });
  }

  return Object.freeze({ createRecordingGate });
});
