const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createGlobalPlaybackCoordinator } = require('../background.js');

function memorySession() {
  const values = new Map();
  return {
    async get(key) { return values.get(key); },
    async set(key, value) { values.set(key, JSON.parse(JSON.stringify(value))); },
    async remove(key) { values.delete(key); },
  };
}

test('a new audible page atomically takes over the previous global playback', async () => {
  const cancelled = [];
  const coordinator = createGlobalPlaybackCoordinator({
    session: memorySession(),
    async cancel(playback, reason) { cancelled.push({ playback, reason }); },
  });
  await coordinator.claim({ sourceTabId: 10, sourceDocumentId: 'doc-a', pageKey: 'a', playbackId: 'play-a', requestId: 'req-a' });
  const second = await coordinator.claim({ sourceTabId: 20, sourceDocumentId: 'doc-b', pageKey: 'b', playbackId: 'play-b', requestId: 'req-b' });
  assert.equal(cancelled.length, 1);
  assert.equal(cancelled[0].playback.playbackId, 'play-a');
  assert.equal(cancelled[0].reason, 'replaced-by-new-playback');
  assert.equal(second.playback.sourceTabId, 20);
  assert.equal(second.playback.intentSequence, 2);
});

test('global controls without an identity resolve to the active immutable session', async () => {
  const coordinator = createGlobalPlaybackCoordinator({ session: memorySession() });
  await coordinator.claim({
    sourceTabId: 7, sourceDocumentId: 'doc-7', pageKey: 'page-7', segmentId: 'seg-2',
    playbackId: 'play-7', requestId: 'req-7', clientId: 'client-7', providerId: 'browser-model',
  });
  const control = await coordinator.resolve({ type: 'tts:pause' });
  assert.deepEqual({
    sourceTabId: control.sourceTabId, sourceDocumentId: control.sourceDocumentId,
    pageKey: control.pageKey, segmentId: control.segmentId, playbackId: control.playbackId,
    requestId: control.requestId, clientId: control.clientId, providerId: control.providerId,
  }, {
    sourceTabId: 7, sourceDocumentId: 'doc-7', pageKey: 'page-7', segmentId: 'seg-2',
    playbackId: 'play-7', requestId: 'req-7', clientId: 'client-7', providerId: 'browser-model',
  });
});

test('controls with a matching playback identity inherit the active provider after a fallback', async () => {
  const coordinator = createGlobalPlaybackCoordinator({ session: memorySession() });
  await coordinator.claim({
    sourceTabId: 7, sourceDocumentId: 'doc-7', pageKey: 'page-7', segmentId: 'seg-2',
    playbackId: 'play-7', requestId: 'req-7', clientId: 'client-7', providerId: 'browser-system',
  });
  const control = await coordinator.resolve({
    type: 'tts:pause', sourceTabId: 7, playbackId: 'play-7', requestId: 'req-7', clientId: 'client-7',
  });
  assert.equal(control.providerId, 'browser-system');
  assert.equal(control.pageKey, 'page-7');
  assert.equal(control.sessionId, 'play-7');
});

test('late events from an older playback cannot clear or advance the active session', async () => {
  const coordinator = createGlobalPlaybackCoordinator({ session: memorySession(), async cancel() {} });
  await coordinator.claim({ sourceTabId: 1, playbackId: 'old', requestId: 'old-request' });
  await coordinator.claim({ sourceTabId: 2, playbackId: 'new', requestId: 'new-request' });
  await coordinator.acceptStreamEvent({ sourceTabId: 1, playbackId: 'old', requestId: 'old-request', event: 'ended' });
  const current = await coordinator.getSnapshot();
  assert.equal(current.active, true);
  assert.equal(current.playbackId, 'new');
  assert.equal(current.sourceTabId, 2);
});

test('a naturally ended sentence releases before its automatic successor is claimed', async () => {
  const cancelled = [];
  const coordinator = createGlobalPlaybackCoordinator({
    session: memorySession(),
    async cancel(playback, reason) { cancelled.push([playback.playbackId, reason]); },
  });
  await coordinator.claim({ sourceTabId: 1, pageKey: 'forum', playbackId: 'sentence-1', requestId: 'sentence-1' });
  await coordinator.acceptStreamEvent({ sourceTabId: 1, pageKey: 'forum', playbackId: 'sentence-1', requestId: 'sentence-1', event: 'ended' });
  await coordinator.claim({ sourceTabId: 1, pageKey: 'forum', playbackId: 'sentence-2', requestId: 'sentence-2' });

  assert.deepEqual(cancelled, []);
  assert.equal((await coordinator.getSnapshot()).playbackId, 'sentence-2');
});

test('source navigation stops and releases the matching session but ignores other tabs', async () => {
  const cancelled = [];
  const coordinator = createGlobalPlaybackCoordinator({ session: memorySession(), async cancel(playback, reason) { cancelled.push([playback.sourceTabId, reason]); } });
  await coordinator.claim({ sourceTabId: 3, playbackId: 'p3', requestId: 'r3' });
  await coordinator.stopForTab(4, 'source-document-navigation');
  assert.equal((await coordinator.getSnapshot()).active, true);
  await coordinator.stopForTab(3, 'source-document-navigation');
  assert.deepEqual(cancelled, [[3, 'source-document-navigation']]);
  assert.equal((await coordinator.getSnapshot()).active, false);
});

test('tab loading updates do not revoke playback because pagehide owns real navigation', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
  const listener = source.match(/chromeApi\.tabs\.onUpdated\.addListener\(\(tabId, changeInfo\) => \{([\s\S]*?)\n\s*\}\);/);
  assert.ok(listener, 'missing tabs.onUpdated listener');
  const loadingBranch = listener[1].match(/if \(changeInfo\.status === 'loading'\) \{([\s\S]*?)\n\s*\}/);
  assert.ok(loadingBranch, 'missing loading branch');
  assert.doesNotMatch(loadingBranch[1], /stopForTab|cancelPlaybackForTab/);
});
