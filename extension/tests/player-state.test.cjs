const test = require("node:test");
const assert = require("node:assert/strict");

const Player = require("../shared/player-state.js");

function sampleSegments() {
  return [
    { id: "p1", authorName: "楼主", voice: "邵思萌", text: "第一段" },
    { id: "p2", authorName: "回复者", voice: "音色B", text: "第二段" },
    { id: "p3", authorName: "楼主", voice: "邵思萌", text: "第三段" },
  ];
}

test("load success selects the first segment and exposes its author and voice", () => {
  const state = Player.reduce(Player.createInitialState(), {
    type: "LOAD_SUCCESS",
    segments: sampleSegments(),
  });

  assert.equal(state.status, "ready");
  assert.equal(state.index, 0);
  assert.equal(state.current.authorName, "楼主");
  assert.equal(state.current.voice, "邵思萌");
});

test("dynamic load can preserve a requested queue position", () => {
  let state = Player.reduce(Player.createInitialState(), {
    type: "LOAD_SUCCESS",
    segments: sampleSegments(),
  });
  state = Player.reduce(state, {
    type: "LOAD_START",
    scanId: 2,
    pageKey: "https://example.com/topic/1",
    preserveSegments: true,
  });
  assert.equal(state.current.id, "p1");

  state = Player.reduce(state, {
    type: "LOAD_SUCCESS",
    scanId: 2,
    segments: [...sampleSegments(), { id: "p4", text: "新增回复" }],
    index: 3,
  });

  assert.equal(state.index, 3);
  assert.equal(state.current.id, "p4");
});

test("dynamic rescan start preserves an active playback session", () => {
  let state = Player.reduce(Player.createInitialState(), {
    type: "LOAD_SUCCESS",
    segments: sampleSegments(),
    index: 1,
  });
  state = Player.reduce(state, {
    type: "AUDIO_PLAYING",
    sessionId: "play-forum-2",
  });
  state = Object.assign({}, state, { prefetchedIndex: 2 });

  const rescanning = Player.reduce(state, {
    type: "LOAD_START",
    scanId: 3,
    pageKey: "https://forum.example/topic/2",
    preserveSegments: true,
  });

  assert.equal(rescanning.status, "playing");
  assert.equal(rescanning.sessionId, "play-forum-2");
  assert.equal(rescanning.prefetchedIndex, 2);
  assert.equal(rescanning.index, 1);
  assert.equal(rescanning.current.id, "p2");
});

test("scan state stores the normalized document and rejects a stale scan result", () => {
  const firstDocument = {
    pageKey: "https://example.com/t/one",
    adapter: "discourse",
    blocks: [{ id: "old", text: "旧主题" }],
  };
  const secondDocument = {
    pageKey: "https://example.com/t/two",
    adapter: "discourse",
    blocks: [{ id: "new", text: "新主题" }],
  };

  let state = Player.reduce(Player.createInitialState(), {
    type: "LOAD_START",
    scanId: 1,
    pageKey: firstDocument.pageKey,
  });
  state = Player.reduce(state, {
    type: "LOAD_START",
    scanId: 2,
    pageKey: secondDocument.pageKey,
  });
  const stale = Player.reduce(state, {
    type: "LOAD_SUCCESS",
    scanId: 1,
    document: firstDocument,
    segments: [{ id: "old", text: "旧主题" }],
  });

  assert.equal(stale, state);

  const fresh = Player.reduce(state, {
    type: "LOAD_SUCCESS",
    scanId: 2,
    document: secondDocument,
    segments: [{ id: "new", text: "新主题" }],
  });
  assert.equal(fresh.status, "ready");
  assert.equal(fresh.pageKey, secondDocument.pageKey);
  assert.equal(fresh.document.adapter, "discourse");
  assert.equal(fresh.current.text, "新主题");
});

test("page invalidation clears page-bound playback but preserves panel and tab", () => {
  let state = Object.assign(Player.createInitialState(), {
    panelOpen: true,
    tab: "authors",
  });
  state = Player.reduce(state, {
    type: "LOAD_START",
    scanId: 4,
    pageKey: "https://example.com/t/old",
  });
  state = Player.reduce(state, {
    type: "LOAD_SUCCESS",
    scanId: 4,
    document: { pageKey: "https://example.com/t/old", blocks: [] },
    segments: sampleSegments(),
  });
  state = Player.reduce(state, {
    type: "AUDIO_PLAYING",
    sessionId: "old-session",
    prefetchedIndex: 1,
  });
  state = Player.reduce(state, {
    type: "PAGE_INVALIDATE",
    pageKey: "https://example.com/t/new",
  });

  assert.equal(state.panelOpen, true);
  assert.equal(state.tab, "authors");
  assert.equal(state.pageKey, "https://example.com/t/new");
  assert.equal(state.document, null);
  assert.deepEqual(state.segments, []);
  assert.equal(state.current, null);
  assert.equal(state.sessionId, null);
  assert.equal(state.prefetchedIndex, null);
  assert.equal(state.status, "idle");
});

test("pause and resume retain the current segment", () => {
  let state = Player.reduce(Player.createInitialState(), {
    type: "LOAD_SUCCESS",
    segments: sampleSegments(),
  });
  state = Player.reduce(state, { type: "AUDIO_PLAYING" });
  state = Player.reduce(state, { type: "PAUSE" });

  assert.equal(state.status, "paused");
  assert.equal(state.index, 0);

  state = Player.reduce(state, { type: "RESUME" });
  assert.equal(state.status, "playing");
  assert.equal(state.index, 0);
});

test("next and previous clamp at queue boundaries and update current metadata", () => {
  let state = Player.reduce(Player.createInitialState(), {
    type: "LOAD_SUCCESS",
    segments: sampleSegments(),
  });
  state = Player.reduce(state, { type: "PREVIOUS" });
  assert.equal(state.index, 0);

  state = Player.reduce(state, { type: "NEXT" });
  assert.equal(state.index, 1);
  assert.deepEqual(
    { authorName: state.current.authorName, voice: state.current.voice },
    { authorName: "回复者", voice: "音色B" },
  );

  state = Player.reduce(state, { type: "NEXT" });
  state = Player.reduce(state, { type: "NEXT" });
  assert.equal(state.index, 2);
});

test("stop clears transient playback and prefetched audio without losing the readable queue", () => {
  let state = Player.reduce(Player.createInitialState(), {
    type: "LOAD_SUCCESS",
    segments: sampleSegments(),
  });
  state = Player.reduce(state, {
    type: "AUDIO_PLAYING",
    sessionId: "session-1",
    prefetchedIndex: 1,
  });
  state = Player.reduce(state, { type: "STOP" });

  assert.equal(state.status, "ready");
  assert.equal(state.sessionId, null);
  assert.equal(state.prefetchedIndex, null);
  assert.equal(state.segments.length, 3);
});

test("error state contains a reader-facing message and can be cleared", () => {
  let state = Player.reduce(Player.createInitialState(), {
    type: "ERROR",
    message: "本地 Qwen 服务未启动",
  });
  assert.equal(state.status, "error");
  assert.equal(state.error, "本地 Qwen 服务未启动");

  state = Player.reduce(state, { type: "CLEAR_ERROR" });
  assert.equal(state.status, "idle");
  assert.equal(state.error, null);
});

test("request cache reuses the prefetched next segment and cancels abandoned sessions", async () => {
  const cancelled = [];
  const cache = Player.createRequestCache(async (sessionId) => {
    cancelled.push(sessionId);
  });
  let calls = 0;

  const prefetched = cache.prefetch(1, "prefetch-1", async () => {
    calls += 1;
    return "audio-one";
  });
  const taken = cache.take(1);

  assert.equal(taken.sessionId, "prefetch-1");
  assert.equal(await taken.promise, "audio-one");
  assert.equal(await prefetched, "audio-one");
  assert.equal(calls, 1);

  cache.prefetch(2, "prefetch-2", async () => "audio-two");
  await cache.cancelAll();
  assert.deepEqual(cancelled, ["prefetch-2"]);
});

test("progressive forum queues retain the visible sentence while earlier floors arrive", () => {
  const visible = [
    { id: "floor-500:a", sourceIdentity: "post-500|0", floor: 500, sourceStart: 0, text: "当前楼层第一句" },
    { id: "floor-500:b", sourceIdentity: "post-500|1", floor: 500, sourceStart: 8, text: "当前楼层第二句" },
  ];
  const earlier = [
    { id: "floor-1", sourceIdentity: "post-1|0", floor: 1, sourceStart: 0, text: "第一楼" },
  ];

  const merged = Player.mergeProgressiveSegments(visible, earlier);

  assert.deepEqual(merged.map((segment) => segment.floor), [1, 500, 500]);
  assert.equal(Player.findSegmentByIdentity(merged, "post-500|0"), 1);
  assert.equal(Player.findSegmentByIdentity(merged, "post-500|1"), 2);
});

test("progressive queue merging replaces duplicate live-DOM segments with canonical API data", () => {
  const live = [{ id: "live", sourceIdentity: "same", floor: 165, text: "正文", authorName: "DOM" }];
  const canonical = [{ id: "api", sourceIdentity: "same", floor: 165, text: "正文", authorName: "API" }];

  const merged = Player.mergeProgressiveSegments(live, canonical);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].authorName, "API");
});

test("progressive queue does not replay a clicked first sentence when its canonical copy arrives", () => {
  const live = [
    { id: "live:first", sourceIdentity: "topic|post-165|0|0|6", floor: 165, sourceStart: 0, text: "第一句话。", authorName: "DOM" },
    { id: "live:second", sourceIdentity: "topic|post-165|0|6|12", floor: 165, sourceStart: 6, text: "第二句话。", authorName: "DOM" },
  ];
  const canonical = [
    { id: "api:first", sourceIdentity: "topic|post-165|0|0|6", floor: 165, sourceStart: 0, text: "第一句话。", authorName: "API" },
    { id: "api:second", sourceIdentity: "topic|post-165|0|6|12", floor: 165, sourceStart: 6, text: "第二句话。", authorName: "API" },
  ];

  const merged = Player.mergeProgressiveSegments(live, canonical);
  const firstIndex = Player.findSegmentByIdentity(merged, live[0].sourceIdentity);

  assert.deepEqual(merged.map((segment) => segment.text), ["第一句话。", "第二句话。"]) ;
  assert.equal(merged[firstIndex].authorName, "API");
  assert.equal(merged[firstIndex + 1].text, "第二句话。");
});

test("only incomplete forum documents keep the auto-play intent at a temporary queue tail", () => {
  assert.equal(Player.shouldWaitForProgressiveQueue({ kind: "forum", complete: false }), true);
  assert.equal(Player.shouldWaitForProgressiveQueue({ kind: "forum", complete: true }), false);
  assert.equal(Player.shouldWaitForProgressiveQueue({ kind: "article", complete: false }), false);
  assert.equal(Player.shouldWaitForProgressiveQueue(null), false);
});

test("request cache can forget local prefetch state without recursively cancelling a revoked global session", async () => {
  const cancelled = [];
  const cache = Player.createRequestCache(async (sessionId) => cancelled.push(sessionId));
  cache.prefetch(3, "revoked-prefetch", async () => "late-audio");

  cache.clearAll();
  await cache.cancelAll();

  assert.deepEqual(cancelled, []);
  assert.equal(cache.take(3), null);
});

test("a prefetched entry taken by a superseded seek can still be cancelled", async () => {
  const cancelled = [];
  const cache = Player.createRequestCache(async (sessionId) => {
    cancelled.push(sessionId);
  });
  cache.prefetch(4, "orphan-prefetch", async () => "unused-audio");
  const taken = cache.take(4);

  await cache.discard(taken);

  assert.deepEqual(cancelled, ["orphan-prefetch"]);
});

test("failed prefetch becomes a cache miss and performs exactly one foreground retry", async () => {
  let foregroundCalls = 0;
  const prefetched = {
    promise: Promise.reject(new Error("warmup failed")),
  };

  const result = await Player.resolveAudioRequest(prefetched, async () => {
    foregroundCalls += 1;
    return { audioBase64: "UklGRg==" };
  });

  assert.equal(result.audioBase64, "UklGRg==");
  assert.equal(foregroundCalls, 1);
});

test("cancelled prefetch is not retried as a foreground request", async () => {
  let foregroundCalls = 0;
  const cancellation = Object.assign(new Error("cancelled"), {
    code: "cancelled",
  });

  await assert.rejects(
    Player.resolveAudioRequest(
      { promise: Promise.reject(cancellation) },
      async () => {
        foregroundCalls += 1;
        return {};
      },
    ),
    (error) => error === cancellation,
  );
  assert.equal(foregroundCalls, 0);
});

test("playback admission gate rejects an older invocation after a newer seek begins", () => {
  const gate = Player.createInvocationGate();
  const older = gate.begin();
  const newer = gate.begin();

  assert.equal(gate.isCurrent(older), false);
  assert.equal(gate.isCurrent(newer), true);

  gate.invalidate();
  assert.equal(gate.isCurrent(newer), false);
});

test("progressive queue update appends forum pages without resetting playback", () => {
  let state = Player.reduce(Player.createInitialState(), {
    type: "LOAD_START",
    scanId: 7,
    pageKey: "https://forum.example/topic/7",
  });
  state = Player.reduce(state, {
    type: "LOAD_SUCCESS",
    scanId: 7,
    segments: sampleSegments(),
    index: 1,
  });
  state = Player.reduce(state, { type: "AUDIO_PLAYING", sessionId: "play-7" });
  const updated = Player.reduce(state, {
    type: "QUEUE_UPDATE",
    scanId: 7,
    segments: [...sampleSegments(), { id: "p4", text: "后台补全" }],
    index: 1,
  });

  assert.equal(updated.status, "playing");
  assert.equal(updated.sessionId, "play-7");
  assert.equal(updated.index, 1);
  assert.equal(updated.current.id, "p2");
  assert.equal(updated.segments.length, 4);
});

test("orb status synthesis follows operation priority and exposes accessible actions", () => {
  assert.deepEqual(
    Player.deriveOrbStatus({
      stateStatus: "playing",
      serviceStatus: "ready",
      hasSegments: true,
    }),
    {
      key: "playing",
      priority: 80,
      label: "正在朗读",
      action: "pause",
      busy: false,
    },
  );
  assert.equal(
    Player.deriveOrbStatus({
      stateStatus: "playing",
      serviceStatus: "offline",
      hasSegments: true,
    }).key,
    "offline",
  );
  assert.equal(
    Player.deriveOrbStatus({ stateStatus: "extracting", hasSegments: false }).key,
    "scanning",
  );
  assert.equal(
    Player.deriveOrbStatus({ stateStatus: "idle", hasSegments: false, serviceStatus: "ready" }).key,
    "text-not-ready",
  );
  assert.equal(
    Player.deriveOrbStatus({ stateStatus: "idle", hasSegments: false, serviceStatus: "connecting" }).key,
    "connecting",
  );
  assert.equal(
    Player.deriveOrbStatus({ stateStatus: "ready", hasSegments: true, serviceStatus: "ready" }).action,
    "play",
  );
});

test("orb exposes loading pause, queued pause, and in-flight control truthfully", () => {
  assert.deepEqual(
    Player.deriveOrbStatus({
      stateStatus: "loading",
      serviceStatus: "model-loading",
      hasSegments: true,
      canControlLoading: true,
    }),
    { key: "stream-starting", priority: 72, label: "正在加载模型", action: "pause", busy: true },
  );
  assert.equal(Player.deriveOrbStatus({
    stateStatus: "loading", serviceStatus: "synthesizing", pauseQueued: true,
  }).action, "resume");
  assert.equal(Player.deriveOrbStatus({
    stateStatus: "playing", serviceStatus: "playing", controlPending: "pause",
  }).key, "pausing");
  assert.equal(Player.deriveOrbStatus({
    stateStatus: "paused", serviceStatus: "paused", controlPending: "resume",
  }).key, "resuming");
});

test("two reader instances created at the same time cannot collide on client, playback, or request identity", () => {
  const fixedNow = () => 1_700_000_000_000;
  const uuidsA = [
    "11111111-1111-4111-8111-111111111111",
    "11111111-1111-4111-8111-111111111112",
    "11111111-1111-4111-8111-111111111113",
  ];
  const uuidsB = [
    "22222222-2222-4222-8222-222222222221",
    "22222222-2222-4222-8222-222222222222",
    "22222222-2222-4222-8222-222222222223",
  ];
  const first = Player.createIdentityFactory({
    now: fixedNow,
    crypto: { randomUUID: () => uuidsA.shift() },
  });
  const second = Player.createIdentityFactory({
    now: fixedNow,
    crypto: { randomUUID: () => uuidsB.shift() },
  });

  const identitiesA = [first("client"), first("playback"), first("request")];
  const identitiesB = [second("client"), second("playback"), second("request")];

  assert.equal(new Set([...identitiesA, ...identitiesB]).size, 6);
  assert.match(identitiesA[0], /qwen-reader-client-11111111/u);
  assert.match(identitiesB[1], /qwen-reader-playback-22222222/u);
});

test("identity fallback keeps per-instance entropy when randomUUID is unavailable", () => {
  const first = Player.createIdentityFactory({
    now: () => 42,
    crypto: null,
    random: (() => {
      const values = [0.1, 0.2, 0.3, 0.4];
      return () => values.shift();
    })(),
  });
  const second = Player.createIdentityFactory({
    now: () => 42,
    crypto: null,
    random: (() => {
      const values = [0.5, 0.6, 0.7, 0.8];
      return () => values.shift();
    })(),
  });

  assert.notEqual(first("playback"), second("playback"));
});
