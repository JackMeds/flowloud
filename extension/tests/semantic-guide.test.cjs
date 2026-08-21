const test = require('node:test');
const assert = require('node:assert/strict');
const guide = require('../shared/semantic-guide.js');

function element(values = {}) {
  const attributes = values.attributes || {};
  return {
    tagName: values.tagName || 'BUTTON',
    type: values.type || '',
    textContent: values.textContent || '',
    value: values.value || '',
    labels: values.labels,
    ownerDocument: values.ownerDocument,
    getAttribute(name) { return attributes[name] || ''; },
  };
}

test('semantic guide resolves aria-labelledby accessible names', () => {
  const document = { getElementById(id) { return id === 'label-a' ? { textContent: '播放文章' } : null; } };
  assert.equal(guide.accessibleName(element({ ownerDocument: document, attributes: { 'aria-labelledby': 'label-a' } })), '播放文章');
});

test('semantic guide keeps unnamed controls with safe fallback labels', () => {
  assert.equal(guide.describe(element(), 'button'), '未命名按钮');
  assert.equal(guide.describe(element({ tagName: 'INPUT', type: 'checkbox' }), 'form'), '未命名复选框');
});
