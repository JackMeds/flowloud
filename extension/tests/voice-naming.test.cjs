const test = require('node:test');
const assert = require('node:assert/strict');

const Naming = require('../shared/voice-naming.js');

test('uses the final extension boundary and allocates stable duplicate suffixes', () => {
  assert.equal(Naming.fileStem('邵思萌.样本.m4a'), '邵思萌.样本');
  assert.equal(Naming.allocateUniqueName('邵思萌', ['邵思萌', '邵思萌 (2)']), '邵思萌 (3)');
});

test('sanitizes control characters and falls back for an empty name', () => {
  assert.equal(Naming.sanitizeName('  新\u0000音色  '), '新音色');
  assert.equal(Naming.sanitizeName(' . '), '未命名音色');
});

test('treats a leading dot as part of a file name instead of an extension', () => {
  assert.equal(Naming.fileStem('.voice'), '.voice');
  assert.equal(Naming.fileStem('voice.'), 'voice');
});
