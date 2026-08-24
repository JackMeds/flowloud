(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.QwenReaderPlayer = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const ORB_STATUS_PRIORITY = Object.freeze({
    error: 100,
    offline: 99,
    retrying: 90,
    unstable: 89,
    fallback: 88,
    pausing: 82,
    resuming: 82,
    playing: 80,
    paused: 79,
    "pause-queued": 73,
    "stream-starting": 72,
    "model-loading": 70,
    synthesizing: 69,
    scanning: 60,
    "text-not-ready": 59,
    connecting: 58,
    ready: 10,
  });

  const ORB_STATUS_META = Object.freeze({
    error: Object.freeze({ label: "朗读失败", action: "open-panel", busy: false }),
    offline: Object.freeze({ label: "服务离线", action: "open-panel", busy: false }),
    retrying: Object.freeze({ label: "正在重试", action: "open-panel", busy: true }),
    unstable: Object.freeze({ label: "服务不稳定", action: "open-panel", busy: false }),
    fallback: Object.freeze({ label: "已切换整段播放", action: "open-panel", busy: false }),
    pausing: Object.freeze({ label: "正在暂停", action: "open-panel", busy: true }),
    resuming: Object.freeze({ label: "正在继续", action: "open-panel", busy: true }),
    playing: Object.freeze({ label: "正在朗读", action: "pause", busy: false }),
    paused: Object.freeze({ label: "已暂停", action: "resume", busy: false }),
    "pause-queued": Object.freeze({ label: "暂停已排队", action: "resume", busy: true }),
    "stream-starting": Object.freeze({ label: "正在加载模型", action: "pause", busy: true }),
    "model-loading": Object.freeze({ label: "正在加载模型", action: "open-panel", busy: true }),
    synthesizing: Object.freeze({ label: "正在加载模型", action: "open-panel", busy: true }),
    scanning: Object.freeze({ label: "正在读取正文", action: "open-panel", busy: true }),
    "text-not-ready": Object.freeze({ label: "文本未就绪", action: "open-panel", busy: false }),
    connecting: Object.freeze({ label: "正在连接 Provider", action: "open-panel", busy: true }),
    ready: Object.freeze({ label: "已就绪", action: "play", busy: false }),
  });

  function normalizeOrbStatus(value) {
    const raw = String(value == null ? "" : value).trim().toLowerCase();
    const aliases = {
      stopped: "ready",
      "provider-connecting": "connecting",
      "provider_connecting": "connecting",
      "model_loading": "model-loading",
      "text_not_ready": "text-not-ready",
    };
    const key = aliases[raw] || raw;
    return Object.prototype.hasOwnProperty.call(ORB_STATUS_PRIORITY, key) ? key : "";
  }

  function deriveOrbStatus(input) {
    const source = input && typeof input === "object" ? input : {};
    const candidates = [];
    const add = (value, active) => {
      const key = normalizeOrbStatus(value);
      if (!key || !active) return;
      candidates.push(key);
    };
    const playbackInput = String(source.playbackStatus || source.stateStatus || source.status || "")
      .trim().toLowerCase();
    const playback = normalizeOrbStatus(playbackInput);
    const isExtracting = playbackInput === "extracting";
    const isLoading = playbackInput === "loading";
    const service = normalizeOrbStatus(source.serviceStatus || source.providerStatus);
    const errorCode = String(source.errorCode || "").toLowerCase();

    add("error", Boolean(source.error) || playback === "error" || service === "error");
    add("offline", service === "offline" || [
      "offline", "network_error", "offscreen_unavailable", "host_permission_missing",
      "provider_unavailable", "gateway_unavailable", "disconnected",
    ].includes(errorCode));
    add("retrying", service === "retrying");
    add("unstable", service === "unstable");
    add("fallback", service === "fallback" || Boolean(source.fallback));
    add("pausing", source.controlPending === "pause");
    add("resuming", source.controlPending === "resume");
    add("playing", playback === "playing");
    add("paused", playback === "paused");
    add("pause-queued", Boolean(source.pauseQueued));
    add("stream-starting", isLoading && Boolean(source.canControlLoading));
    add("model-loading", service === "model-loading");
    add("synthesizing", isLoading || service === "synthesizing");
    add("scanning", isExtracting || service === "scanning");
    add("text-not-ready", service === "text-not-ready" || (
      source.hasSegments === false && !isExtracting &&
      !["connecting", "model-loading", "synthesizing"].includes(service)
    ));
    add("connecting", service === "connecting");
    add("ready", service === "ready" || playback === "ready" || playback === "idle");

    const selected = candidates.sort((left, right) => (
      ORB_STATUS_PRIORITY[right] - ORB_STATUS_PRIORITY[left]
    ))[0] || "ready";
    const meta = ORB_STATUS_META[selected];
    return Object.freeze(Object.assign({
      key: selected,
      priority: ORB_STATUS_PRIORITY[selected],
    }, meta));
  }

  function createInitialState() {
    return {
      panelOpen: false,
      tab: "now",
      status: "idle",
      document: null,
      pageKey: "",
      scanId: 0,
      segments: [],
      index: 0,
      current: null,
      sessionId: null,
      prefetchedIndex: null,
      error: null,
    };
  }

  function segmentIdentity(segment) {
    const item = segment && typeof segment === "object" ? segment : {};
    return String(
      item.sourceIdentity ||
      item.id ||
      [item.sourceKey || "", item.sourceStart || 0, item.sourceEnd || 0, item.text || ""].join("|")
    );
  }

  function shouldWaitForProgressiveQueue(document) {
    const source = document && typeof document === "object" ? document : {};
    return source.kind === "forum" && source.complete === false;
  }

  function segmentOrderValue(segment, fallback) {
    const item = segment && typeof segment === "object" ? segment : {};
    const floor = Number(item.floor);
    const unit = Number(item.sourceLocator && item.sourceLocator.unitIndex);
    const start = Number(item.sourceStart);
    return {
      floor: Number.isFinite(floor) ? floor : Number.MAX_SAFE_INTEGER,
      unit: Number.isFinite(unit) ? unit : 0,
      start: Number.isFinite(start) ? start : 0,
      fallback,
    };
  }

  // Forum adapters can reveal the visible posts before the canonical API has
  // finished. Merge those immutable snapshots so a currently playing sentence
  // is not removed when an earlier page arrives a moment later.
  function mergeProgressiveSegments(previous, incoming) {
    const before = Array.isArray(previous) ? previous : [];
    const after = Array.isArray(incoming) ? incoming : [];
    const entries = [];
    const positions = new Map();
    [...after, ...before].forEach((segment) => {
      const key = segmentIdentity(segment);
      if (!key || positions.has(key)) return;
      positions.set(key, entries.length);
      entries.push(segment);
    });
    return entries
      .map((segment, fallback) => ({ segment, order: segmentOrderValue(segment, fallback) }))
      .sort((left, right) => (
        left.order.floor - right.order.floor ||
        left.order.unit - right.order.unit ||
        left.order.start - right.order.start ||
        left.order.fallback - right.order.fallback
      ))
      .map((entry) => entry.segment);
  }

  function findSegmentByIdentity(segments, identity) {
    const key = String(identity || "");
    if (!key) return -1;
    return (Array.isArray(segments) ? segments : [])
      .findIndex((segment) => segmentIdentity(segment) === key);
  }

  function withCurrent(state, index) {
    const segments = state.segments || [];
    const safeIndex = segments.length
      ? Math.max(0, Math.min(index, segments.length - 1))
      : 0;
    return Object.assign({}, state, {
      index: safeIndex,
      current: segments[safeIndex] || null,
    });
  }

  function reduce(state, action) {
    const currentState = state || createInitialState();
    const event = action || {};
    switch (event.type) {
      case "PANEL_TOGGLE":
        return Object.assign({}, currentState, {
          panelOpen: !currentState.panelOpen,
        });
      case "PANEL_OPEN":
        return Object.assign({}, currentState, { panelOpen: true });
      case "PANEL_CLOSE":
        return Object.assign({}, currentState, { panelOpen: false });
      case "TAB_SELECT":
        return Object.assign({}, currentState, { tab: event.tab || "now" });
      case "LOAD_START": {
        const preserveSegments = event.preserveSegments === true;
        return Object.assign({}, currentState, {
          // A forum can append posts while an utterance is playing. That
          // background refresh must not demote or detach the active session.
          status: preserveSegments ? currentState.status : "extracting",
          document: preserveSegments ? currentState.document : null,
          pageKey:
            event.pageKey == null ? currentState.pageKey : String(event.pageKey),
          scanId:
            event.scanId == null ? currentState.scanId : Number(event.scanId),
          segments: preserveSegments ? currentState.segments : [],
          index: preserveSegments ? currentState.index : 0,
          current: preserveSegments ? currentState.current : null,
          sessionId: preserveSegments ? currentState.sessionId : null,
          prefetchedIndex: preserveSegments ? currentState.prefetchedIndex : null,
          error: null,
        });
      }
      case "LOAD_SUCCESS": {
        if (
          event.scanId != null &&
          currentState.scanId != null &&
          Number(event.scanId) !== Number(currentState.scanId)
        ) {
          return currentState;
        }
        const next = Object.assign({}, currentState, {
          status: "ready",
          document: event.document || currentState.document,
          pageKey:
            (event.document && event.document.pageKey) ||
            event.pageKey ||
            currentState.pageKey,
          segments: Array.isArray(event.segments) ? event.segments.slice() : [],
          index: event.index == null ? 0 : Number(event.index),
          current: null,
          sessionId: null,
          prefetchedIndex: null,
          error: null,
        });
        return withCurrent(next, event.index == null ? 0 : Number(event.index));
      }
      case "QUEUE_UPDATE": {
        // Progressive forum extraction extends the queue while audio may
        // already be playing. Preserve the session/status/current sentence;
        // only replace the immutable queue snapshot and refresh its pointer.
        if (
          event.scanId != null &&
          currentState.scanId != null &&
          Number(event.scanId) !== Number(currentState.scanId)
        ) return currentState;
        const segments = Array.isArray(event.segments)
          ? event.segments.slice()
          : currentState.segments;
        const next = Object.assign({}, currentState, {
          document: event.document || currentState.document,
          pageKey: (event.document && event.document.pageKey) || currentState.pageKey,
          segments,
          error: null,
        });
        return withCurrent(next, event.index == null ? currentState.index : Number(event.index));
      }
      case "PAGE_INVALIDATE":
        return Object.assign({}, currentState, {
          status: "idle",
          document: null,
          pageKey:
            event.pageKey == null ? "" : String(event.pageKey),
          scanId:
            event.scanId == null
              ? Number(currentState.scanId || 0) + 1
              : Number(event.scanId),
          segments: [],
          index: 0,
          current: null,
          sessionId: null,
          prefetchedIndex: null,
          error: null,
        });
      case "AUDIO_LOADING":
        return Object.assign({}, currentState, {
          status: "loading",
          sessionId: event.sessionId || currentState.sessionId,
          error: null,
        });
      case "AUDIO_PLAYING":
        return Object.assign({}, currentState, {
          status: "playing",
          sessionId: event.sessionId || currentState.sessionId,
          prefetchedIndex:
            event.prefetchedIndex == null
              ? currentState.prefetchedIndex
              : event.prefetchedIndex,
          error: null,
        });
      case "PAUSE":
        return Object.assign({}, currentState, { status: "paused" });
      case "RESUME":
        return Object.assign({}, currentState, { status: "playing" });
      case "NEXT":
        return withCurrent(currentState, currentState.index + 1);
      case "PREVIOUS":
        return withCurrent(currentState, currentState.index - 1);
      case "SEEK":
        return withCurrent(currentState, Number(event.index) || 0);
      case "STOP":
        return Object.assign({}, currentState, {
          status: currentState.segments.length ? "ready" : "idle",
          sessionId: null,
          prefetchedIndex: null,
          error: null,
        });
      case "ERROR":
        if (
          event.scanId != null &&
          currentState.scanId != null &&
          Number(event.scanId) !== Number(currentState.scanId)
        ) {
          return currentState;
        }
        return Object.assign({}, currentState, {
          status: "error",
          sessionId: null,
          prefetchedIndex: null,
          error: event.message || "朗读发生错误",
        });
      case "CLEAR_ERROR":
        return Object.assign({}, currentState, {
          status: currentState.segments.length ? "ready" : "idle",
          error: null,
        });
      default:
        return currentState;
    }
  }

  function createRequestCache(cancelSession) {
    const entries = new Map();

    return {
      prefetch(index, sessionId, factory) {
        if (entries.has(index)) return entries.get(index).promise;
        const promise = Promise.resolve().then(factory);
        entries.set(index, { sessionId, promise });
        return promise;
      },
      take(index) {
        const entry = entries.get(index) || null;
        entries.delete(index);
        return entry;
      },
      async discard(entry) {
        if (
          entry &&
          entry.sessionId &&
          typeof cancelSession === "function"
        ) {
          await Promise.resolve(cancelSession(entry.sessionId)).catch(() => {});
        }
      },
      async cancelAll() {
        const pending = Array.from(entries.values());
        entries.clear();
        if (typeof cancelSession === "function") {
          await Promise.all(
            pending.map((entry) =>
              Promise.resolve(cancelSession(entry.sessionId)).catch(() => {}),
            ),
          );
        }
      },
      clearAll() {
        entries.clear();
      },
      clear(index) {
        entries.delete(index);
      },
    };
  }

  async function resolveAudioRequest(prefetched, foregroundFactory) {
    if (!prefetched) return foregroundFactory();
    try {
      return await prefetched.promise;
    } catch (error) {
      if (error && error.code === "cancelled") throw error;
      return foregroundFactory();
    }
  }

  function createInvocationGate() {
    let generation = 0;
    return {
      begin() {
        generation += 1;
        return generation;
      },
      invalidate() {
        generation += 1;
        return generation;
      },
      isCurrent(token) {
        return Number(token) === generation;
      },
    };
  }

  function createIdentityFactory(options) {
    const config = options || {};
    const cryptoImpl = Object.prototype.hasOwnProperty.call(config, "crypto")
      ? config.crypto
      : (typeof globalThis !== "undefined" ? globalThis.crypto : null);
    const now = typeof config.now === "function" ? config.now : Date.now;
    const random = typeof config.random === "function" ? config.random : Math.random;
    const prefix = String(config.prefix || "qwen-reader")
      .replace(/[^A-Za-z0-9._:-]/gu, "-")
      .slice(0, 48) || "qwen-reader";
    let sequence = 0;

    function randomHex() {
      if (cryptoImpl && typeof cryptoImpl.getRandomValues === "function") {
        const values = new Uint32Array(4);
        cryptoImpl.getRandomValues(values);
        return Array.from(values, (value) => value.toString(16).padStart(8, "0")).join("");
      }
      const first = Math.floor(Number(random()) * 0x100000000) >>> 0;
      const second = Math.floor(Number(random()) * 0x100000000) >>> 0;
      return `${first.toString(16).padStart(8, "0")}${second.toString(16).padStart(8, "0")}`;
    }

    const instanceEntropy = randomHex();
    return function nextIdentity(kind) {
      const label = String(kind || "request")
        .replace(/[^A-Za-z0-9._:-]/gu, "-")
        .slice(0, 32) || "request";
      sequence += 1;
      if (cryptoImpl && typeof cryptoImpl.randomUUID === "function") {
        return `${prefix}-${label}-${cryptoImpl.randomUUID()}`;
      }
      return `${prefix}-${label}-${Number(now()).toString(36)}-${instanceEntropy}-${sequence.toString(36)}-${randomHex()}`;
    };
  }

  return {
    createInitialState,
    segmentIdentity,
    mergeProgressiveSegments,
    shouldWaitForProgressiveQueue,
    findSegmentByIdentity,
    reduce,
    ORB_STATUS_PRIORITY,
    ORB_STATUS_META,
    deriveOrbStatus,
    createRequestCache,
    resolveAudioRequest,
    createInvocationGate,
    createIdentityFactory,
  };
});
