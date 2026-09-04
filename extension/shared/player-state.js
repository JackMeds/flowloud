(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.QwenReaderPlayer = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

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
      case "LOAD_START":
        return Object.assign({}, currentState, {
          status: "extracting",
          document: event.preserveSegments ? currentState.document : null,
          pageKey:
            event.pageKey == null ? currentState.pageKey : String(event.pageKey),
          scanId:
            event.scanId == null ? currentState.scanId : Number(event.scanId),
          segments: event.preserveSegments ? currentState.segments : [],
          index: event.preserveSegments ? currentState.index : 0,
          current: event.preserveSegments ? currentState.current : null,
          sessionId: null,
          prefetchedIndex: null,
          error: null,
        });
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
    reduce,
    createRequestCache,
    resolveAudioRequest,
    createInvocationGate,
    createIdentityFactory,
  };
});
