const test = require('node:test');
const assert = require('node:assert/strict');

const Recording = require('../shared/recording-state.js');

test('recording gate admits only one pending microphone request', () => {
  const gate = Recording.createRecordingGate();
  const first = gate.begin();

  assert.equal(typeof first, 'number');
  assert.equal(gate.begin(), null);
  assert.equal(gate.isStarting(), true);
  assert.equal(gate.activate(first), true);
  assert.equal(gate.isRecording(), true);
});

test('a cancelled microphone request cannot become the active recording', () => {
  const gate = Recording.createRecordingGate();
  const token = gate.begin();
  gate.cancel();

  assert.equal(gate.activate(token), false);
  assert.equal(gate.isIdle(), true);
});

test('failed and stopped sessions return the gate to idle', () => {
  const gate = Recording.createRecordingGate();
  const failed = gate.begin();
  assert.equal(gate.fail(failed), true);
  assert.equal(gate.isIdle(), true);

  const active = gate.begin();
  assert.equal(gate.activate(active), true);
  gate.stop();
  assert.equal(gate.isIdle(), true);
});
