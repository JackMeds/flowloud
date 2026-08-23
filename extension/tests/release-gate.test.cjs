const test = require('node:test');
const assert = require('node:assert/strict');
const { runReleaseGate } = require('../../scripts/release-gate.cjs');

test('Chrome and Edge release gate closes manifest references and rejects remote code or secrets', () => {
  const result = runReleaseGate();
  assert.equal(result.ok, true);
  assert.equal(result.manifestVersion, 3);
  assert.ok(result.filesInspected > 20);
});
