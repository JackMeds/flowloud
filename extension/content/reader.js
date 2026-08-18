/* global chrome, QwenReaderDefaults, QwenReaderText, QwenReaderDocument, QwenReaderExtractors, QwenReaderSourceLocator, QwenReaderSentenceRange, QwenReaderMarkerPlacement, QwenReaderFollow, QwenReaderVoiceAssignment, QwenReaderPlayer, QwenReaderWordTimeline, Readability */
(function installQwenReader() {
  "use strict";

  if (document.getElementById("qwen-reader-host")) return;
  if (location.hostname === "accounts.google.com" && location.pathname.startsWith("/gsi/")) return;

  const Defaults = globalThis.QwenReaderDefaults || {};
  const Text = globalThis.QwenReaderText;
  const DocumentModel = globalThis.QwenReaderDocument;
  const Extractors = globalThis.QwenReaderExtractors;
  const SourceLocator = globalThis.QwenReaderSourceLocator;
  const SentenceRange = globalThis.QwenReaderSentenceRange;
  const MarkerPlacement = globalThis.QwenReaderMarkerPlacement;
  const Follow = globalThis.QwenReaderFollow;
  const VoiceAssignment =
    globalThis.QwenReaderVoiceAssignment || globalThis.QwenReaderVoices;
  const Player = globalThis.QwenReaderPlayer;
  const WordTimeline = globalThis.QwenReaderWordTimeline;
  if (!Text || !Extractors || !SourceLocator || !SentenceRange || !MarkerPlacement || !Follow || !VoiceAssignment || !Player || !WordTimeline) {
    console.error("Qwen Reader: shared modules are missing.");
    return;
  }

  const SETTINGS_KEY = Defaults.SETTINGS_KEY || "qwenReaderSettings";
  const DEFAULT_SETTINGS = Defaults.DEFAULT_SETTINGS || {
    preset: Defaults.voiceMode || "op-exclusive",
    opVoice: Defaults.opVoice || "邵思萌",
    replyVoices:
      Defaults.replyVoices && Defaults.replyVoices.length
        ? Defaults.replyVoices.slice()
        : ["qwen-clone"],
    clickToRead: true,
    readingFocus: "sentence",
    readingFocusStyle: Defaults.readingFocusStyle || "soft-glow",
    wordHighlightStyle: Defaults.wordHighlightStyle || "edge-dissolve",
    wordHighlightColor: Defaults.wordHighlightColor || "#6f58bd",
    wordHighlightGlow: Defaults.wordHighlightGlow ?? 48,
    wordHighlightSpeed: Defaults.wordHighlightSpeed ?? 1,
    interactionVersion: 2,
  };

  const host = document.createElement("div");
  host.id = "qwen-reader-host";
  host.style.setProperty("display", "none", "important");
  document.documentElement.appendChild(host);
  const TEST_MODE = globalThis.__QWEN_READER_TEST__ === true;
  const shadow = host.attachShadow({ mode: "closed" });
  if (TEST_MODE) globalThis.__QWEN_READER_TEST_ROOT__ = shadow;
  const stylesheet = document.createElement("link");
  stylesheet.rel = "stylesheet";
  stylesheet.href = chrome.runtime.getURL("content/reader.css");
  stylesheet.addEventListener("load", () => {
    host.style.removeProperty("display");
  }, { once: true });
  stylesheet.addEventListener("error", async () => {
    stylesheet.remove();
    try {
      const response = await fetch(chrome.runtime.getURL("content/reader.css"));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const fallbackStyle = new CSSStyleSheet();
      fallbackStyle.replaceSync(await response.text());
      shadow.adoptedStyleSheets = [...shadow.adoptedStyleSheets, fallbackStyle];
      host.style.removeProperty("display");
    } catch (_) {
      console.warn("Qwen Reader: reader stylesheet is unavailable in this document.");
      host.remove();
    }
  }, { once: true });
  shadow.append(stylesheet);

  const iconUrls = Object.freeze({
    play: chrome.runtime.getURL("assets/icons/play.svg"),
    pause: chrome.runtime.getURL("assets/icons/pause.svg"),
    previous: chrome.runtime.getURL("assets/icons/skip-back.svg"),
    next: chrome.runtime.getURL("assets/icons/skip-forward.svg"),
    close: chrome.runtime.getURL("assets/icons/x.svg"),
    stop: chrome.runtime.getURL("assets/icons/stop.svg"),
  });
  const shell = document.createElement("div");
  shell.innerHTML = `
    <section class="qr-mini-player" data-role="mini-player" aria-label="Qwen 网页朗读控制" aria-hidden="true">
      <div class="qr-mini-context">
        <span class="qr-mini-avatar" data-role="mini-avatar" aria-hidden="true">Q</span>
        <span class="qr-mini-copy">
          <span class="qr-mini-speaker" data-role="mini-speaker">正在准备朗读</span>
          <span class="qr-mini-meta" data-role="mini-meta">当前网页</span>
          <span class="qr-mini-text" data-role="mini-text"></span>
        </span>
      </div>
      <div class="qr-mini-controls" aria-label="朗读控制">
        <button class="qr-mini-button" type="button" data-action="previous" aria-label="上一句"><img class="qr-mini-icon" src="${iconUrls.previous}" alt=""></button>
        <button class="qr-mini-button is-primary" type="button" data-action="play-toggle" aria-label="暂停朗读"><img class="qr-mini-icon" data-role="mini-play-icon" src="${iconUrls.pause}" alt=""></button>
        <button class="qr-mini-button" type="button" data-action="next" aria-label="下一句"><img class="qr-mini-icon" src="${iconUrls.next}" alt=""></button>
        <button class="qr-mini-button is-stop" type="button" data-action="stop" aria-label="停止朗读并关闭控制条"><img class="qr-mini-icon" src="${iconUrls.close}" alt=""></button>
      </div>
    </section>
    <div class="qr-line-focus-layer" data-role="line-focus-layer" aria-hidden="true">
      <span class="qr-line-focus-band" data-role="line-focus-band"></span>
    </div>
    <div class="qr-word-motion-layer" data-role="word-motion-layer" aria-hidden="true"></div>
    <div class="qr-reading-marker" data-role="reading-marker" role="group" aria-label="当前句音色与朗读控制"></div>
    <button class="qr-follow-chip" type="button" data-action="resume-follow" aria-label="回到当前朗读位置">
      <span class="qr-follow-chip-dot" aria-hidden="true"></span>
      回到朗读位置
    </button>
    <div class="qr-toast" role="status" aria-live="polite"></div>
  `;
  shadow.append(shell);

  let state = Player.createInitialState();
  let settings = Object.assign({}, DEFAULT_SETTINGS, {
    replyVoices: (DEFAULT_SETTINGS.replyVoices || []).slice(),
    clickToRead: DEFAULT_SETTINGS.clickToRead !== false,
    readingFocus: normalizeReadingFocus(DEFAULT_SETTINGS.readingFocus),
    readingFocusStyle: normalizeReadingFocusStyle(DEFAULT_SETTINGS.readingFocusStyle),
    wordHighlightStyle: normalizeWordHighlightStyle(DEFAULT_SETTINGS.wordHighlightStyle),
    wordHighlightColor: normalizeHighlightColor(DEFAULT_SETTINGS.wordHighlightColor),
    wordHighlightGlow: clampNumber(DEFAULT_SETTINGS.wordHighlightGlow, 0, 100, 48),
    wordHighlightSpeed: clampNumber(DEFAULT_SETTINGS.wordHighlightSpeed, .6, 1.8, 1),
    interactionVersion: 2,
  });
  let knownVoices = unique([
    settings.opVoice,
    ...(settings.replyVoices || []),
  ]).filter(Boolean);
  let currentAudio = null;
  let activeSession = "";
  let activeStreamRequest = "";
  let completedStreamSession = "";
  let desiredPlaybackPaused = false;
  let playbackControlPending = "";
  let playbackControlRetryTimer = null;
  let playbackControlRetryAttempt = 0;
  let playbackStartPending = false;
  let serviceStatus = { kind: "connecting", label: "正在连接 Provider" };
  let serviceStatusTimer = null;
  let serviceStatusRevision = 0;
  let serviceCheckRevision = 0;
  const playbackGate = Player.createInvocationGate();
  const followController = Follow.createController();
  const nextIdentity = typeof Player.createIdentityFactory === "function"
    ? Player.createIdentityFactory({ prefix: "qwen-reader" })
    : createIdentityFactoryFallback();
  const clientId = nextIdentity("client");
  let scanCounter = 0;
  let activeScanController = null;
  let lastObservedPageKey = getCurrentPageKey();
  let routeTimer = null;
  let mutationTimer = null;
  let dynamicScanPending = false;
  let dynamicResumeIndex = null;
  const requestCache = Player.createRequestCache(cancelSessionById);
  let highlightedElement = null;
  let highlightedRange = null;
  let highlightedIndex = -1;
  let hoveredSegmentIndex = -1;
  let lastMarkerIndex = -1;
  let hoverHideTimer = null;
  let pointerFrame = null;
  let overlayFrame = null;
  let sourceElements = [];
  let sourceIndicesByKey = new Map();
  let sourceIndicesByElement = new WeakMap();
  let textIndexesByElement = new WeakMap();
  let sentenceRanges = new Map();
  let sentenceRangeOffsets = new Map();
  let sentenceMatches = new Map();
  let wordRangesBySegment = new Map();
  let wordTimeline = null;
  let highlightedWordIndex = -1;
  let wordFallbackMarks = [];
  let wordMotionRange = null;
  let wordMotionCursorRect = null;
  let wordMotionRetireTimer = null;
  let highlightRetryTimer = null;
  let highlightRetryKey = "";
  let highlightRetryAttempt = 0;
  let audioProgressSequence = 0;
  let indexedSegments = null;
  let lastScrolledLocatorKey = "";
  let toastTimer = null;
  let pageAuthorVoices = {};
  let stateRevision = 0;
  let playbackRate = 1;

  applyReadingFocusSettings();
  applyWordHighlightSettings();
  bindEvents();
  render();
  void initialize();

  async function initialize() {
    await restoreSettings();
    startLocationWatcher();
    await scanCurrentPage("initial");
    void loadVoices();
    void checkService();
  }

  function getAuthorKey(segment, index) {
    if (VoiceAssignment && typeof VoiceAssignment.authorKey === "function") {
      return VoiceAssignment.authorKey(segment, index);
    }
    return String(segment && (segment.authorId || segment.authorName || segment.id) || `segment:${index}`);
  }

  function getDisplayAuthor(segment) {
    if (!segment) return "正在准备";
    return String(segment.authorName || (segment.isOp ? "楼主" : "正文"));
  }

  function getRoleLabel(segment) {
    if (!segment) return "正文";
    return segment.isOp ? "楼主" : (segment.type === "article" ? "正文" : "回复");
  }

  function getAuthorSummary() {
    const byKey = new Map();
    state.segments.forEach((segment, index) => {
      const key = getAuthorKey(segment, index);
      const existing = byKey.get(key);
      if (existing) {
        existing.count += 1;
        return;
      }
      byKey.set(key, {
        key,
        id: key,
        name: getDisplayAuthor(segment),
        authorName: getDisplayAuthor(segment),
        role: getRoleLabel(segment),
        isOp: Boolean(segment && segment.isOp),
        count: 1,
        voice: String(segment && segment.voice || ""),
        effectiveVoice: String(segment && segment.voice || ""),
      });
    });
    return Array.from(byKey.values());
  }

  function getReaderSnapshot() {
    const current = state.current;
    const authors = getAuthorSummary();
    return {
      pageKey: state.pageKey || getCurrentPageKey(),
      revision: stateRevision,
      title: cleanTitle(document.title),
      status: state.status,
      index: state.index,
      total: state.segments.length,
      segmentCount: state.segments.length,
      speed: playbackRate,
      rate: playbackRate,
      hasMultipleAuthors: authors.length > 1,
      authorSummary: authors,
      current: current ? {
        authorKey: getAuthorKey(current, state.index),
        authorName: getDisplayAuthor(current),
        role: getRoleLabel(current),
        voice: String(current.voice || ""),
        text: truncateText(current.text, 120),
      } : null,
      error: state.error || null,
    };
  }

  function getPageContext() {
    const snapshot = getReaderSnapshot();
    return {
      ok: true,
      title: snapshot.title,
      pageKey: snapshot.pageKey,
      revision: snapshot.revision,
      authorVoices: Object.assign({}, pageAuthorVoices),
      hasMultipleAuthors: snapshot.hasMultipleAuthors,
      authorSummary: snapshot.authorSummary,
      authors: snapshot.authorSummary,
      voices: unique([
        ...knownVoices,
        settings.opVoice,
        ...(settings.replyVoices || []),
        ...Object.values(pageAuthorVoices),
      ]).filter(Boolean),
    };
  }

  async function applyPageContext(message) {
    const context = message && message.context && typeof message.context === "object"
      ? message.context
      : message || {};
    const requestedPageKey = String(context.pageKey || message && message.pageKey || "");
    const pageKey = String(state.pageKey || getCurrentPageKey());
    if (requestedPageKey && requestedPageKey !== pageKey) {
      return { ok: false, error: { code: "page_context_mismatch", message: "该配音设置不属于当前网页。" }, pageContext: getPageContext() };
    }
    pageAuthorVoices = VoiceAssignment && typeof VoiceAssignment.normalizeAuthorVoices === "function"
      ? VoiceAssignment.normalizeAuthorVoices(context.authorVoices)
      : {};
    if (state.segments.length) {
      await stopPlayback();
      const assigned = assignSegments(state.segments.map(stripPlaybackFields));
      state = Player.reduce(state, {
        type: "LOAD_SUCCESS",
        scanId: state.scanId,
        document: state.document,
        segments: assigned,
        index: Math.min(state.index, Math.max(0, assigned.length - 1)),
      });
    }
    render();
    return { ok: true, pageContext: getPageContext() };
  }

  async function runReaderCommand(message) {
    const requestedPageKey = String(message && message.pageKey || "");
    const currentPageKey = String(state.pageKey || getCurrentPageKey());
    if (requestedPageKey && requestedPageKey !== currentPageKey) {
      return { ok: false, error: { code: "page_context_mismatch", message: "网页已发生变化，请重新打开扩展弹窗后再操作。" }, snapshot: getReaderSnapshot() };
    }
    const payload = message && message.payload && typeof message.payload === "object" ? message.payload : {};
    const command = String(message && (message.command || message.action) || payload.command || "").trim().toLowerCase();
    switch (command) {
      case "toggle":
      case "play-toggle": await togglePlayback(); break;
      case "play":
      case "resume": if (state.status !== "playing") await togglePlayback(); break;
      case "pause": if (state.status === "playing") await togglePlayback(); break;
      case "previous":
      case "prev": await move(-1); break;
      case "next": await move(1); break;
      case "seek": {
        const index = Number(message && message.index != null ? message.index : payload.index);
        if (!Number.isInteger(index)) return { ok: false, error: { code: "invalid_reader_index", message: "朗读位置无效。" }, snapshot: getReaderSnapshot() };
        await seek(index);
        break;
      }
      case "scan":
      case "scan-page":
      case "refresh": await refreshCurrentPage(); break;
      case "stop":
      case "close": await stopPlayback(); break;
      case "set-speed":
        // v0.5.2 streams playback through the offscreen Web Audio scheduler,
        // which intentionally has no per-session rate control yet.
        return { ok: false, error: { code: "playback_rate_unavailable", message: "当前流式朗读暂不支持调速。" }, snapshot: getReaderSnapshot() };
      default:
        return { ok: false, error: { code: "unknown_reader_command", message: "不支持的朗读操作。" }, snapshot: getReaderSnapshot() };
    }
    return { ok: true, snapshot: getReaderSnapshot() };
  }

  async function handleReaderMessage(message) {
    switch (message && message.type) {
      case "reader:snapshot:get": return { ok: true, snapshot: getReaderSnapshot() };
      case "reader:command": return runReaderCommand(message);
      case "reader:page-context:get": return getPageContext();
      case "reader:page-context:apply": return applyPageContext(message);
      default: return { ok: false, error: { code: "unknown_reader_message", message: "不支持的网页朗读请求。" } };
    }
  }

  function publishReaderSnapshot() {
    stateRevision += 1;
    try {
      const result = chrome.runtime.sendMessage({ type: "reader:snapshot", snapshot: getReaderSnapshot() });
      if (result && typeof result.catch === "function") result.catch(() => {});
    } catch (_) {
      // A restricted or torn-down extension context must not interrupt reading.
    }
  }

  function bindEvents() {
    shadow.addEventListener("click", async (event) => {
      if (!event.isTrusted && !TEST_MODE) return;
      const button = event.target.closest("button");
      if (!button) return;
      const action = button.dataset.action;
      if (action === "play-toggle") {
        await togglePlayback();
      } else if (action === "marker-play") {
        const inlineIndex = Number(button.dataset.index);
        if (!Number.isInteger(inlineIndex) || !state.segments[inlineIndex]) return;
        if (inlineIndex === state.index && ["playing", "paused"].includes(state.status)) {
          await togglePlayback();
        } else {
          followController.resume();
          lastScrolledLocatorKey = "";
          await playIndex(inlineIndex);
        }
      } else if (action === "scan-page") {
        await refreshCurrentPage();
      } else if (action === "next") {
        await move(1);
      } else if (action === "previous") {
        await move(-1);
      } else if (action === "stop") {
        await stopPlayback();
      } else if (action === "resume-follow") {
        followController.resume();
        lastScrolledLocatorKey = "";
        highlightCurrent({ forceFollow: true });
        renderNow();
      } else if (button.dataset.index != null) {
        await seek(Number(button.dataset.index));
      }
    });

    shadow.addEventListener("change", async (event) => {
      if (!event.isTrusted && !TEST_MODE) return;
      const control = event.target;
      if (control.dataset.setting === "clickToRead") {
        settings.clickToRead = Boolean(control.checked);
        if (!settings.clickToRead) {
          clearTimeout(hoverHideTimer);
          hoveredSegmentIndex = -1;
          renderReadingMarker();
        }
        await saveSettings();
        renderNow();
        showToast(settings.clickToRead ? "网页点读已开启：点击正文即可从该句朗读。" : "网页点读已关闭。");
        return;
      } else if (control.dataset.setting === "readingFocus") {
        settings.readingFocus = normalizeReadingFocus(control.value);
        await saveSettings();
        refreshReadingFocus();
        showToast({
          off: "阅读聚焦已关闭；逐词效果保持开启。",
          line: "已聚焦当前朗读行。",
          sentence: "已聚焦当前朗读句。",
        }[settings.readingFocus]);
        return;
      } else if (control.dataset.setting === "readingFocusStyle") {
        settings.readingFocusStyle = normalizeReadingFocusStyle(control.value);
        await saveSettings();
        applyReadingFocusSettings();
        refreshReadingFocus();
        renderNow();
        showToast({
          "soft-glow": "阅读聚焦已切换为浅色光晕。",
          "edge-glow": "阅读聚焦已切换为字体柔光。",
          "paper-wash": "阅读聚焦已切换为淡色衬底。",
          "underline-guide": "阅读聚焦已切换为细线导读。",
        }[settings.readingFocusStyle]);
        return;
      } else if (control.dataset.setting === "wordHighlightStyle") {
        settings.wordHighlightStyle = normalizeWordHighlightStyle(control.value);
        await saveSettings();
        refreshActiveWordStyle();
        renderNow();
        showToast({
          "edge-dissolve": "逐词样式已切换为边缘消隐。",
          "classic-glow": "逐词样式已切换为经典光晕。",
          "aurora-tide": "逐词样式已切换为极光底线。",
          custom: "已启用自定义逐词样式。",
        }[settings.wordHighlightStyle]);
        return;
      } else if (control.dataset.setting === "wordHighlightColor") {
        settings.wordHighlightColor = normalizeHighlightColor(control.value);
        await saveSettings();
        refreshActiveWordStyle();
        return;
      } else if (control.dataset.setting === "wordHighlightGlow") {
        settings.wordHighlightGlow = clampNumber(control.value, 0, 100, 48);
        await saveSettings();
        refreshActiveWordStyle();
        renderNow();
        return;
      } else if (control.dataset.setting === "wordHighlightSpeed") {
        settings.wordHighlightSpeed = clampNumber(control.value, .6, 1.8, 1);
        await saveSettings();
        refreshActiveWordStyle();
        renderNow();
        return;
      } else if (control.dataset.setting === "preset") {
        settings.preset = control.value;
      } else if (control.dataset.setting === "opVoice") {
        const nextOpVoice = control.value;
        const nextReplyVoices = settings.replyVoices.filter(
          (voice) => voice !== nextOpVoice,
        );
        if (!nextReplyVoices.length) {
          const replacement = knownVoices.find((voice) => voice !== nextOpVoice);
          if (!replacement) {
            control.value = settings.opVoice;
            showToast("请先录制另一个音色，再把当前回复音色设为楼主音色。");
            return;
          }
          nextReplyVoices.push(replacement);
        }
        settings.opVoice = nextOpVoice;
        settings.replyVoices = nextReplyVoices;
      } else if (control.dataset.setting === "replyVoice") {
        const nextReplyVoices = Array.from(
          shadow.querySelectorAll('[data-setting="replyVoice"]:checked'),
        ).map((input) => input.value);
        if (!nextReplyVoices.length) {
          control.checked = true;
          showToast("至少保留一个回复音色；楼主音色不会分配给其他作者。");
          return;
        }
        settings.replyVoices = nextReplyVoices;
      } else {
        return;
      }
      await saveSettings();
      if (state.segments.length) {
        try {
          const baseSegments = state.segments.map(stripPlaybackFields);
          const assigned = assignSegments(baseSegments);
          state = Player.reduce(state, {
            type: "LOAD_SUCCESS",
            scanId: state.scanId,
            document: state.document,
            segments: assigned,
            index: state.index,
          });
          await stopPlayback();
        } catch (error) {
          showToast(error.message);
        }
      }
      render();
    });

    const markManualScroll = (event) => {
      if (!["playing", "paused", "loading"].includes(state.status)) return;
      if (!Follow.isScrollIntent(event, {
        host,
        viewportWidth: document.documentElement.clientWidth,
      })) return;
      if (!followController.canFollow()) return;
      followController.markManual();
      renderReadingMarker();
      renderNow();
    };
    window.addEventListener("wheel", markManualScroll, { capture: true, passive: true });
    window.addEventListener("touchmove", markManualScroll, { capture: true, passive: true });
    window.addEventListener("keydown", markManualScroll, true);
    window.addEventListener("pointerdown", markManualScroll, true);
    window.addEventListener("scroll", scheduleOverlayUpdate, { capture: true, passive: true });
    window.addEventListener("resize", scheduleOverlayUpdate, { passive: true });
    document.addEventListener("pointermove", handlePagePointerMove, { capture: true, passive: true });
    document.addEventListener("pointerleave", clearHoveredSegment, true);
    document.addEventListener("click", handlePageClick, true);

    const readingMarker = shadow.querySelector('[data-role="reading-marker"]');
    readingMarker.addEventListener("pointerenter", () => clearTimeout(hoverHideTimer));
    readingMarker.addEventListener("pointerleave", () => {
      if (!isPlaybackActive()) scheduleHoverHide();
    });

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message && message.type === "tts:stream:event") {
        handleStreamEvent(message);
        return undefined;
      }
      if (!message || ![
        "reader:snapshot:get", "reader:command",
        "reader:page-context:get", "reader:page-context:apply",
      ].includes(message.type)) return undefined;
      Promise.resolve(handleReaderMessage(message)).then(
        (response) => sendResponse && sendResponse(response),
        (error) => sendResponse && sendResponse({ ok: false, error: { code: "reader_command_failed", message: error && error.message || "网页朗读操作失败。" } }),
      );
      return true;
    });

    if (chrome.storage.onChanged && typeof chrome.storage.onChanged.addListener === "function") {
      chrome.storage.onChanged.addListener((changes, areaName) => {
        const change = changes && changes[SETTINGS_KEY];
        if (areaName !== "local") return;
        const settingsChanged = Boolean(change && adoptSettings(change.newValue));
        if (changes && changes.voiceProfiles) void loadVoices();
        if (!settingsChanged) return;
        void (async () => {
          await stopPlayback();
          if (state.segments.length) {
            try {
              const assigned = assignSegments(
                state.segments.map(stripPlaybackFields),
              );
              state = Player.reduce(state, {
                type: "LOAD_SUCCESS",
                scanId: state.scanId,
                document: state.document,
                segments: assigned,
                index: state.index,
              });
            } catch (error) {
              showToast(error.message);
            }
          }
          render();
        })();
      });
    }
  }

  async function restoreSettings() {
    try {
      const saved = await chrome.storage.local.get(SETTINGS_KEY);
      const value = saved && saved[SETTINGS_KEY];
      if (adoptSettings(value)) {
        await saveSettings();
        render();
      }
    } catch (error) {
      console.warn("Qwen Reader settings could not be restored", error);
    }
  }

  function adoptSettings(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const before = JSON.stringify(settings);
    const next = Object.assign({}, settings, value);
    next.clickToRead = Number(value.interactionVersion || 0) < 2
      ? true
      : Boolean(next.clickToRead);
    next.readingFocus = normalizeReadingFocus(next.readingFocus);
    next.readingFocusStyle = normalizeReadingFocusStyle(next.readingFocusStyle);
    next.wordHighlightStyle = normalizeWordHighlightStyle(next.wordHighlightStyle);
    next.wordHighlightColor = normalizeHighlightColor(next.wordHighlightColor);
    next.wordHighlightGlow = clampNumber(next.wordHighlightGlow, 0, 100, 48);
    next.wordHighlightSpeed = clampNumber(next.wordHighlightSpeed, .6, 1.8, 1);
    next.interactionVersion = 2;
    next.opVoice = String(next.opVoice || DEFAULT_SETTINGS.opVoice || "邵思萌").trim();
    const requestedReplies = Array.isArray(value.replyVoices)
      ? value.replyVoices
      : settings.replyVoices;
    next.replyVoices = unique(
      (requestedReplies || [])
        .map((voice) => String(voice || "").trim())
        .filter((voice) => voice && voice !== next.opVoice),
    );
    if (!next.replyVoices.length) {
      const fallback = unique([
        ...(DEFAULT_SETTINGS.replyVoices || []),
        DEFAULT_SETTINGS.opVoice,
        "qwen-clone",
        "邵思萌",
      ]).find((voice) => voice && voice !== next.opVoice);
      if (fallback) next.replyVoices = [fallback];
    }
    settings = next;
    applyReadingFocusSettings();
    applyWordHighlightSettings();
    knownVoices = unique([
      ...knownVoices,
      settings.opVoice,
      ...settings.replyVoices,
    ]).filter(Boolean);
    return before !== JSON.stringify(settings);
  }

  async function saveSettings() {
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  }

  function normalizeReadingFocus(value) {
    return ["off", "line", "sentence"].includes(value) ? value : "sentence";
  }

  function normalizeReadingFocusStyle(value) {
    return ["soft-glow", "edge-glow", "paper-wash", "underline-guide"].includes(value)
      ? value
      : "soft-glow";
  }

  function applyReadingFocusSettings() {
    const root = document.documentElement;
    if (!root) return;
    const style = normalizeReadingFocusStyle(settings.readingFocusStyle);
    settings.readingFocusStyle = style;
    root.classList.remove(
      "qwen-reader-focus-style-soft-glow",
      "qwen-reader-focus-style-edge-glow",
      "qwen-reader-focus-style-paper-wash",
      "qwen-reader-focus-style-underline-guide",
    );
    root.classList.add(`qwen-reader-focus-style-${style}`);
    const layer = shadow.querySelector('[data-role="line-focus-layer"]');
    if (layer) layer.dataset.style = style;
  }

  function normalizeWordHighlightStyle(value) {
    return ["edge-dissolve", "classic-glow", "aurora-tide", "custom"].includes(value)
      ? value
      : "edge-dissolve";
  }

  function normalizeHighlightColor(value) {
    const color = String(value || "").trim();
    return /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : "#6f58bd";
  }

  function clampNumber(value, minimum, maximum, fallback) {
    const number = Number(value);
    return Number.isFinite(number)
      ? Math.max(minimum, Math.min(maximum, number))
      : fallback;
  }

  function applyWordHighlightSettings() {
    const root = document.documentElement;
    if (!root) return;
    const style = normalizeWordHighlightStyle(settings.wordHighlightStyle);
    const color = normalizeHighlightColor(settings.wordHighlightColor);
    const glow = clampNumber(settings.wordHighlightGlow, 0, 100, 48);
    const speed = clampNumber(settings.wordHighlightSpeed, .6, 1.8, 1);
    settings.wordHighlightStyle = style;
    settings.wordHighlightColor = color;
    settings.wordHighlightGlow = glow;
    settings.wordHighlightSpeed = speed;
    root.classList.remove(
      "qwen-reader-word-style-edge-dissolve",
      "qwen-reader-word-style-classic-glow",
      "qwen-reader-word-style-aurora-tide",
      "qwen-reader-word-style-custom",
    );
    root.classList.add(`qwen-reader-word-style-${style}`);
    root.style.setProperty("--qwen-reader-word-accent", color);
    root.style.setProperty("--qwen-reader-word-glow-strength", String(glow / 100));
    root.style.setProperty("--qwen-reader-word-glow-radius", `${Math.round(2 + glow * .1)}px`);
    root.style.setProperty("--qwen-reader-word-halo-opacity", String(.2 + glow * .0072));
    root.style.setProperty("--qwen-reader-word-motion-duration", `${Math.round(1370 / speed)}ms`);
    const layer = shadow.querySelector('[data-role="word-motion-layer"]');
    if (layer) {
      layer.dataset.style = style;
      layer.style.setProperty("--qr-word-accent", color);
      layer.style.setProperty("--qr-word-glow-strength", String(glow / 100));
      layer.style.setProperty("--qr-word-glow-radius", `${Math.round(2 + glow * .1)}px`);
      layer.style.setProperty("--qr-word-halo-opacity", String(.2 + glow * .0072));
      layer.style.setProperty("--qr-word-motion-duration", `${Math.round(1370 / speed)}ms`);
    }
  }

  function refreshActiveWordStyle() {
    const wordIndex = highlightedWordIndex;
    applyWordHighlightSettings();
    if (wordIndex >= 0) highlightWord(wordIndex);
  }

  async function handlePageClick(event) {
    if ((!event.isTrusted && !TEST_MODE) || !settings.clickToRead || !state.segments.length) return;
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    if (path.includes(host)) return;
    const target = event.target;
    if (!target || target.nodeType !== 1) return;
    if (isInteractivePageTarget(target)) return;
    const selection = typeof window.getSelection === "function" ? window.getSelection() : null;
    if (selectionCoversPoint(selection, event.clientX, event.clientY)) return;
    const matchingIndex = findSegmentIndexAtTarget(target, event.clientX, event.clientY, {
      refreshMissing: true,
    });
    if (matchingIndex < 0) return;
    followController.resume();
    lastScrolledLocatorKey = "";
    hoveredSegmentIndex = matchingIndex;
    await seek(matchingIndex);
  }

  function handlePagePointerMove(event) {
    if (!settings.clickToRead || isPlaybackActive() || pointerFrame != null) {
      if (!settings.clickToRead && hoveredSegmentIndex >= 0) {
        hoveredSegmentIndex = -1;
        renderReadingMarker();
      }
      return;
    }
    const target = event.target;
    const clientX = event.clientX;
    const clientY = event.clientY;
    const eventPath = typeof event.composedPath === "function" ? event.composedPath() : [];
    const insideReader = target === host || eventPath.includes(host);
    pointerFrame = requestAnimationFrame(() => {
      pointerFrame = null;
      if (insideReader) return;
      if (!target || target.nodeType !== 1 || isInteractivePageTarget(target)) {
        scheduleHoverHide();
        return;
      }
      const nextIndex = findSegmentIndexAtTarget(target, clientX, clientY);
      if (nextIndex < 0) {
        scheduleHoverHide();
        return;
      }
      clearTimeout(hoverHideTimer);
      if (hoveredSegmentIndex === nextIndex) {
        positionReadingMarker(nextIndex);
        return;
      }
      hoveredSegmentIndex = nextIndex;
      renderReadingMarker();
    });
  }

  function scheduleHoverHide() {
    clearTimeout(hoverHideTimer);
    hoverHideTimer = setTimeout(clearHoveredSegment, 140);
  }

  function clearHoveredSegment() {
    clearTimeout(hoverHideTimer);
    if (isPlaybackActive() || hoveredSegmentIndex < 0) return;
    hoveredSegmentIndex = -1;
    renderReadingMarker();
  }

  function selectionCoversPoint(selection, clientX, clientY) {
    if (!selection || selection.isCollapsed || !String(selection).trim()) return false;
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return true;
    for (let index = 0; index < selection.rangeCount; index += 1) {
      let rects = [];
      try {
        rects = Array.from(selection.getRangeAt(index).getClientRects());
      } catch (_) {}
      if (rects.some((rect) =>
        clientX >= rect.left - 2 && clientX <= rect.right + 2 &&
        clientY >= rect.top - 2 && clientY <= rect.bottom + 2
      )) return true;
    }
    return false;
  }

  function isPlaybackActive() {
    return Boolean(state.current) && ["playing", "paused", "loading"].includes(state.status);
  }

  function isInteractivePageTarget(target) {
    return Boolean(target && typeof target.closest === "function" && target.closest([
      "a",
      "button",
      "input",
      "select",
      "textarea",
      "label",
      "summary",
      "pre",
      "code",
      "img",
      "video",
      "audio",
      "canvas",
      "svg",
      "[contenteditable='']",
      "[contenteditable='true']",
      "[role='button']",
      "[role='link']",
    ].join(",")));
  }

  function closestReadableTarget(target) {
    return target.closest([
      "p",
      "li",
      "blockquote",
      "pre",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      ".Post-body",
      ".cooked",
      ".message-body",
      ".message-content",
      ".mm-post .card-body",
      ".card-body",
      "[itemprop='articleBody']",
      "#chaptercontent",
      "#content",
      ".article-content",
      ".article-body",
      ".entry-content",
      ".entry-body",
      ".post-content",
      ".chapter-content",
      ".read-content",
      ".reader-content",
      ".novel-content",
      ".content",
      "main",
      "[role='main']",
      "article",
    ].join(",")) || target;
  }

  function findSegmentIndexAtTarget(target, clientX, clientY, options) {
    ensureSourceIndex();
    const contentNode = closestReadableTarget(target);
    const collectIndices = () => {
      let node = contentNode;
      let indices = null;
      while (node && node !== document.documentElement.parentElement) {
        const found = sourceIndicesByElement.get(node);
        if (found && found.length) {
          indices = found;
          break;
        }
        node = node.parentElement;
      }
      if (!indices) {
        indices = sourceElements.reduce((output, element, index) => {
          if (
            element && element.isConnected !== false &&
            (element === contentNode || element.contains(contentNode) || contentNode.contains(element))
          ) output.push(index);
          return output;
        }, []);
      }
      return indices;
    };
    let indices = collectIndices();
    if (!indices.length && options && options.refreshMissing) {
      invalidateSourceIndex();
      ensureSourceIndex();
      indices = collectIndices();
    }
    if (!indices.length) return -1;
    const entries = indices.map((index) => ({
      index,
      rects: getSegmentRects(index),
    })).filter((entry) => entry.rects.length);
    if (entries.length && Number.isFinite(clientX) && Number.isFinite(clientY)) {
      const picked = SentenceRange.pickSegmentIndexAtPoint(entries, clientX, clientY, {
        maxDistance: 68,
      });
      if (Number.isInteger(picked) && picked >= 0) return picked;
    }
    return indices.length === 1 ? indices[0] : -1;
  }

  function isOfflineServiceCode(code) {
    return [
      "network_error",
      "offscreen_unavailable",
      "host_permission_missing",
      "provider_unavailable",
      "gateway_unavailable",
      "offline",
      "disconnected",
    ].includes(String(code || "").toLowerCase());
  }

  function setServiceError(error, fallbackLabel) {
    const code = String(error && error.code || "").toLowerCase();
    const offline = isOfflineServiceCode(code);
    setServiceStatus(offline ? "服务离线" : String(fallbackLabel || "朗读失败"), offline ? "offline" : "error");
  }

  async function checkService() {
    const checkRevision = ++serviceCheckRevision;
    setServiceStatus("正在连接 Provider", "connecting");
    try {
      const response = await chrome.runtime.sendMessage({ type: "tts:status" });
      if (!response || !response.ok) throw response && response.error;
      if (checkRevision !== serviceCheckRevision) return;
      const health = response.status || {};
      const backend = String(health.backend || "").toLowerCase();
      const gateway = String(health.gateway || "").toLowerCase();
      const providerState = String(
        health.providerStatus || health.healthStatus || health.state || health.status || "",
      ).toLowerCase();
      // The gateway can remain healthy while its owned backend has entered
      // the schema-defined error state. Keep backend in the same state set so
      // a gateway `ok` response cannot mask a backend failure.
      const healthStates = new Set([providerState, gateway, backend].filter(Boolean));
      if ([...healthStates].some((value) => ["error", "failed"].includes(value))) {
        setServiceStatus("Provider 连接失败", "error");
        return;
      }
      if (
        ["loading", "starting", "initializing", "model-loading", "model_loading"].includes(backend) ||
        ["loading", "starting", "initializing", "model-loading", "model_loading"].includes(providerState)
      ) {
        setServiceStatus("正在加载模型", "model-loading");
        return;
      }
      if (
        health.unstable === true || health.degraded === true ||
        ["unstable", "degraded", "degraded_service"].includes(providerState) ||
        ["unstable", "degraded", "degraded_service"].includes(gateway)
      ) {
        setServiceStatus("服务不稳定", "unstable");
        return;
      }
      if (["connecting", "provider-connecting", "provider_connecting", "starting", "initializing"].includes(providerState) || gateway === "connecting") {
        setServiceStatus("正在连接 Provider", "connecting");
        return;
      }
      if (
        health.ok !== true &&
        [...healthStates].some((value) =>
          ["offline", "stopped", "unavailable", "disconnected"].includes(value),
        )
      ) {
        setServiceStatus("服务离线", "offline");
        return;
      }
      setServiceStatus(
        backend === "loaded"
          ? "模型已加载 · Vulkan"
          : gateway === "running" || gateway === "ok"
            ? "服务已连接 · 模型待机"
            : "已就绪",
        "ready",
      );
    } catch (error) {
      if (checkRevision !== serviceCheckRevision) return;
      const code = String(error && error.code || "").toLowerCase();
      setServiceStatus(
        isOfflineServiceCode(code)
          ? "服务离线"
          : "Provider 连接失败",
        isOfflineServiceCode(code)
          ? "offline"
          : "error",
      );
    }
  }

  function setServiceStatus(label, kind, options) {
    const nextKind = String(kind || "ready");
    const revision = ++serviceStatusRevision;
    serviceStatus = { kind: nextKind, label: String(label || "") };
    clearTimeout(serviceStatusTimer);
    serviceStatusTimer = null;
    const config = options || {};
    if (config.transient && config.restoreKind) {
      serviceStatusTimer = setTimeout(() => {
        if (revision !== serviceStatusRevision) return;
        serviceStatusTimer = null;
        setServiceStatus(
          String(config.restoreLabel || "已就绪"),
          String(config.restoreKind),
        );
      }, Number(config.durationMs) > 0 ? Number(config.durationMs) : 1800);
    }
    const status = shadow.querySelector('[data-role="service-status"]');
    const text = shadow.querySelector('[data-role="service-label"]');
    if (status && text) {
      status.className = `qr-status is-${nextKind}`;
      text.textContent = label;
    }
    renderShell();
  }

  async function loadVoices() {
    try {
      const response = await chrome.runtime.sendMessage({ type: "voice:list" });
      if (!response || !response.ok) {
        throw new Error(
          (response && response.error && response.error.message) ||
            "无法读取音色库",
        );
      }
      knownVoices = unique([
        ...(response.voices || []).map((voice) =>
          typeof voice === "string" ? voice : voice.name,
        ),
        settings.opVoice,
        ...settings.replyVoices,
      ]).filter(Boolean);
      // Voice discovery is not a health signal. Refresh the real provider
      // health state instead of presenting a synthetic model-loading/ready
      // transition while the catalog request is in flight.
      void checkService();
    } catch (error) {
      setServiceStatus(
        isOfflineServiceCode(String(error && error.code || "").toLowerCase())
          ? "服务离线"
          : "音色库加载失败",
        isOfflineServiceCode(String(error && error.code || "").toLowerCase())
          ? "offline"
          : "error",
      );
      // Popup/page editor will show the last known choices and surface the
      // actual connection state; never resurrect a full in-page voice panel.
    }
  }

  function clearPlaybackControlRetry() {
    clearTimeout(playbackControlRetryTimer);
    playbackControlRetryTimer = null;
    playbackControlRetryAttempt = 0;
  }

  function schedulePlaybackControlRetry() {
    if (playbackControlRetryTimer || !activeSession) return;
    if (!['loading', 'playing', 'paused'].includes(state.status)) return;
    if (playbackControlRetryAttempt >= 40) return;
    const attempt = ++playbackControlRetryAttempt;
    playbackControlRetryTimer = setTimeout(() => {
      playbackControlRetryTimer = null;
      void reconcilePlaybackControl();
    }, Math.min(400, 50 + attempt * 15));
  }

  async function reconcilePlaybackControl() {
    if (playbackControlPending) return;
    if (!activeSession) {
      if (desiredPlaybackPaused) setServiceStatus("暂停已排队", "pause-queued");
      render();
      return;
    }
    const controlSession = activeSession;
    const desiredPaused = desiredPlaybackPaused;
    const type = desiredPaused ? "tts:pause" : "tts:resume";
    playbackControlPending = desiredPaused ? "pause" : "resume";
    setServiceStatus(desiredPaused ? "正在暂停" : "正在继续", desiredPaused ? "pausing" : "resuming");
    render();
    const response = await sendPlaybackControl(type, controlSession);
    if (activeSession !== controlSession || desiredPlaybackPaused !== desiredPaused) {
      playbackControlPending = "";
      if (activeSession) void reconcilePlaybackControl();
      return;
    }
    playbackControlPending = "";
    if (desiredPaused && response && response.ok && response.paused) {
      clearPlaybackControlRetry();
      state = Player.reduce(state, { type: "PAUSE" });
      setServiceStatus("已暂停", "paused");
      render();
      return;
    }
    if (!desiredPaused && response && response.ok && response.resumed) {
      clearPlaybackControlRetry();
      if (state.status === "paused") state = Player.reduce(state, { type: "RESUME" });
      setServiceStatus(state.status === "loading" ? "正在加载模型" : "正在朗读", state.status === "loading" ? "synthesizing" : "playing");
      render();
      return;
    }
    if (response && response.ok && (
      (desiredPaused && response.queued) || (!desiredPaused && response.cancelledQueued)
    )) {
      clearPlaybackControlRetry();
      setServiceStatus(desiredPaused ? "暂停已排队" : "正在加载模型", desiredPaused ? "pause-queued" : "synthesizing");
      render();
      return;
    }
    if (state.status === "loading") {
      setServiceStatus(desiredPaused ? "暂停已排队" : "正在加载模型", desiredPaused ? "pause-queued" : "synthesizing");
      render();
      schedulePlaybackControlRetry();
      return;
    }
    desiredPlaybackPaused = state.status === "paused";
    showToast(desiredPaused ? "当前流式音频暂时无法暂停。" : "当前流式音频暂时无法继续。");
    render();
  }

  async function togglePlayback() {
    if (state.status === "loading") {
      desiredPlaybackPaused = !desiredPlaybackPaused;
      clearPlaybackControlRetry();
      if (desiredPlaybackPaused) {
        setServiceStatus(activeSession ? "正在暂停" : "暂停已排队", activeSession ? "pausing" : "pause-queued");
      } else {
        setServiceStatus("正在加载模型", "synthesizing");
      }
      render();
      if (activeSession) await reconcilePlaybackControl();
      return;
    }
    if (state.status === "playing") {
      if (currentAudio) {
        currentAudio.pause();
        desiredPlaybackPaused = true;
        state = Player.reduce(state, { type: "PAUSE" });
        setServiceStatus("已暂停", "paused");
        render();
        return;
      } else if (activeSession) {
        desiredPlaybackPaused = true;
        await reconcilePlaybackControl();
        return;
      }
      return;
    }
    if (state.status === "paused") {
      if (currentAudio) {
        await currentAudio.play();
        desiredPlaybackPaused = false;
        state = Player.reduce(state, { type: "RESUME" });
        setServiceStatus("正在朗读", "playing");
        render();
        return;
      } else if (activeSession) {
        desiredPlaybackPaused = false;
        await reconcilePlaybackControl();
        return;
      } else {
        await playIndex(state.index || 0);
        return;
      }
      return;
    }
    if (!state.segments.length) {
      showToast(
        state.status === "extracting"
          ? "正在识别本页内容，请稍候。"
          : "本页还没有可朗读内容，请点击“读取本页”。",
      );
      return;
    }
    await playIndex(state.index || 0);
  }

  async function sendPlaybackControl(type, sessionId) {
    if (!sessionId) return { ok: false, count: 0 };
    try {
      return await chrome.runtime.sendMessage({
        type,
        clientId,
        playbackId: sessionId,
        requestId: sessionId,
        sessionId,
      });
    } catch (_) {
      return { ok: false, count: 0 };
    }
  }

  async function refreshCurrentPage() {
    dynamicResumeIndex = null;
    await stopPlayback();
    await scanCurrentPage("manual");
  }

  async function scanCurrentPage(reason) {
    const pageKey = getCurrentPageKey();
    const preserveDynamicQueue =
      reason === "dynamic-content" &&
      state.pageKey === pageKey &&
      state.segments.length > 0;
    const resumeIndex = preserveDynamicQueue
      ? dynamicResumeIndex == null
        ? state.index
        : dynamicResumeIndex
      : 0;
    if (!preserveDynamicQueue) {
      followController.reset();
      lastScrolledLocatorKey = "";
      hoveredSegmentIndex = -1;
      invalidateSourceIndex();
    }
    dynamicResumeIndex = null;
    dynamicScanPending = false;
    clearTimeout(mutationTimer);
    const scanId = ++scanCounter;
    if (activeScanController) activeScanController.abort();
    const controller = new AbortController();
    activeScanController = controller;
    let progressiveReady = false;
    const installProgressiveQueue = (partial) => {
      if (controller.signal.aborted || scanId !== scanCounter || getCurrentPageKey() !== pageKey) return;
      const blocks = partial && Array.isArray(partial.blocks) ? partial.blocks : [];
      if (!blocks.length) return;
      const partialDocument = Object.assign({}, partial, { pageKey });
      const expanded = buildPlaybackSegments(partialDocument);
      const assigned = assignSegments(expanded);
      if (!assigned.length) return;
      state = Player.reduce(state, progressiveReady ? {
        type: "QUEUE_UPDATE",
        scanId,
        document: partialDocument,
        segments: assigned,
        index: state.index,
      } : {
        type: "LOAD_SUCCESS",
        scanId,
        document: partialDocument,
        segments: assigned,
        index: resumeIndex,
      });
      progressiveReady = true;
      invalidateSourceIndex();
      render();
    };
    state = Player.reduce(state, {
      type: "LOAD_START",
      scanId,
      pageKey,
      preserveSegments: preserveDynamicQueue,
    });
    render();
    try {
      let normalized;
      if (typeof Extractors.extractDocument === "function") {
        normalized = await Extractors.extractDocument(document, {
          fetchFn: window.fetch.bind(window),
          signal: controller.signal,
          ReadabilityCtor: globalThis.Readability,
          mode: "page",
          reason,
          onProgress: async (partial) => installProgressiveQueue(partial),
        });
      } else {
        const blocks = await Extractors.extractPage(
          document,
          window.fetch.bind(window),
        );
        normalized = {
          pageKey,
          url: window.location.href,
          title: document.title,
          kind: "article",
          adapter: "legacy",
          blocks: Array.isArray(blocks) ? blocks : [],
        };
      }
      if (controller.signal.aborted || scanId !== scanCounter) return;
      if (getCurrentPageKey() !== pageKey) return;
      const blocks = normalized && Array.isArray(normalized.blocks)
        ? normalized.blocks
        : [];
      if (!blocks.length) {
        throw new Error("没有识别到可朗读正文；可以稍后点击“重新读取”。");
      }
      normalized.pageKey = pageKey;
      const expanded = buildPlaybackSegments(normalized);
      const assigned = assignSegments(expanded);
      state = Player.reduce(state, {
        type: progressiveReady ? "QUEUE_UPDATE" : "LOAD_SUCCESS",
        scanId,
        document: normalized,
        segments: assigned,
        index: progressiveReady ? state.index : resumeIndex,
      });
      invalidateSourceIndex();
      render();
    } catch (error) {
      if (
        controller.signal.aborted ||
        (error && error.name === "AbortError") ||
        scanId !== scanCounter
      ) {
        return;
      }
      state = Player.reduce(state, {
        type: "ERROR",
        scanId,
        message: error.message || "正文识别失败",
      });
      render();
    } finally {
      if (activeScanController === controller) activeScanController = null;
      flushPendingDynamicScan();
    }
  }

  function buildPlaybackSegments(normalized) {
    if (
      DocumentModel &&
      typeof DocumentModel.toPlaybackSegments === "function"
    ) {
      return DocumentModel.toPlaybackSegments(
        normalized,
        Defaults.maxChunkChars || 260,
      );
    }
    const expanded = [];
    normalized.blocks.forEach((segment) => {
      Text.splitText(segment.text, Defaults.maxChunkChars || 260).forEach(
        (chunk, chunkIndex) => {
          expanded.push(
            Object.assign({}, segment, {
              id: `${segment.id || "segment"}:${chunkIndex}`,
              text: chunk,
            }),
          );
        },
      );
    });
    return expanded;
  }

  function assignSegments(segments) {
    return VoiceAssignment.assignVoices(segments, {
      mode: settings.preset,
      opVoice: settings.opVoice,
      replyVoices: settings.replyVoices,
      authorVoices: pageAuthorVoices,
    });
  }

  function findNextSpeakableIndex(segments, startIndex) {
    if (typeof Text.findNextSpeakableIndex === "function") {
      return Text.findNextSpeakableIndex(segments, startIndex);
    }
    const source = Array.isArray(segments) ? segments : [];
    for (let index = Math.max(0, Number(startIndex) || 0); index < source.length; index += 1) {
      if (/[\p{L}\p{N}]/u.test(String(source[index] && source[index].text || ""))) {
        return index;
      }
    }
    return -1;
  }

  function isCurrentStreamEvent(message) {
    if (!message || !activeSession) return false;
    if (message.clientId && String(message.clientId) !== String(clientId)) return false;
    const hasPlaybackId = message.playbackId != null && String(message.playbackId) !== "";
    const hasSessionId = message.sessionId != null && String(message.sessionId) !== "";
    const hasRequestId = message.requestId != null && String(message.requestId) !== "";
    if (!hasPlaybackId && !hasSessionId && !hasRequestId) return false;
    if (hasPlaybackId && String(message.playbackId) !== String(activeSession)) return false;
    if (hasSessionId && String(message.sessionId) !== String(activeSession)) return false;
    if (hasRequestId) {
      const expectedRequestId = String(activeStreamRequest || activeSession);
      if (String(message.requestId) !== expectedRequestId) return false;
    }
    if (message.segmentIndex != null && Number.isInteger(Number(message.segmentIndex))
      && Number(message.segmentIndex) !== state.index) return false;
    if (message.segmentId && state.current && state.current.id
      && String(message.segmentId) !== String(state.current.id)) return false;
    return true;
  }

  function finishBufferedPlayback(audio) {
    if (!audio || currentAudio !== audio) return;
    finishStreamPlayback();
  }

  function finishStreamPlayback() {
    if (!activeSession) return;
    const finishedSession = activeSession;
    if (finishedSession && completedStreamSession === finishedSession) return;
    completedStreamSession = finishedSession;
    desiredPlaybackPaused = false;
    playbackControlPending = "";
    playbackStartPending = false;
    clearPlaybackControlRetry();
    cancelHighlightRetry();
    activeStreamRequest = "";
    if (wordTimeline) WordTimeline.finish(wordTimeline, { done: true });
    clearWordHighlight();
    wordTimeline = null;
    const nextIndex = findNextSpeakableIndex(state.segments, state.index + 1);
    if (nextIndex >= 0) {
      void playIndex(nextIndex);
      return;
    }
    if (dynamicScanPending) dynamicResumeIndex = state.segments.length;
    activeSession = "";
    state = Player.reduce(state, { type: "STOP" });
    setServiceStatus("已就绪", "ready");
    hoveredSegmentIndex = -1;
    render();
    clearHighlight();
    flushPendingDynamicScan();
  }

  function handleStreamEvent(message) {
    if (!isCurrentStreamEvent(message)) return;
    const event = String(message.event || "");
    if (event === "retrying") {
      setServiceStatus("正在重试", "retrying");
      renderShell();
      return;
    }
    if (event === "fallback") {
      setServiceStatus("已切换整段播放", "fallback");
      renderShell();
      return;
    }
    if (event === "started") {
      activeStreamRequest = String(message.requestId || activeSession);
      applyWordProgress(message);
      state = Player.reduce(state, {
        type: "AUDIO_PLAYING",
        sessionId: activeSession,
        prefetchedIndex: state.prefetchedIndex,
      });
      if (message.paused) {
        state = Player.reduce(state, { type: "PAUSE" });
        setServiceStatus(desiredPlaybackPaused ? "已暂停" : "正在继续", desiredPlaybackPaused ? "paused" : "resuming");
      } else {
        setServiceStatus(desiredPlaybackPaused ? "暂停已排队" : "正在朗读", desiredPlaybackPaused ? "pause-queued" : "playing");
      }
      render();
      if (Boolean(message.paused) !== desiredPlaybackPaused) void reconcilePlaybackControl();
      return;
    }
    if (event === "paused") {
      applyWordProgress(message);
      desiredPlaybackPaused = true;
      playbackControlPending = "";
      clearPlaybackControlRetry();
      state = Player.reduce(state, { type: "PAUSE" });
      setServiceStatus("已暂停", "paused");
      render();
      return;
    }
    if (event === "resumed") {
      applyWordProgress(Object.assign({}, message, { paused: false }));
      desiredPlaybackPaused = false;
      playbackControlPending = "";
      clearPlaybackControlRetry();
      state = Player.reduce(state, { type: "RESUME" });
      setServiceStatus("正在朗读", "playing");
      render();
      return;
    }
    if (event === "progress") {
      const progress = applyWordProgress(message);
      if (message.done === true || (progress && progress.done)) finishStreamPlayback();
      return;
    }
    if (event === "ended") {
      finishStreamPlayback();
      return;
    }
    if (event === "error") {
      const detail = message.error || {};
      if (detail.code === "cancelled" || !activeSession) return;
      desiredPlaybackPaused = false;
      playbackControlPending = "";
      playbackStartPending = false;
      clearPlaybackControlRetry();
      activeStreamRequest = "";
      state = Player.reduce(state, {
        type: "ERROR",
        message: detail.message || "流式音频播放失败，请重试。",
      });
      setServiceError(detail, "朗读失败");
      hoveredSegmentIndex = -1;
      clearHighlight();
      render();
      flushPendingDynamicScan();
    }
  }

  async function playIndex(index) {
    index = findNextSpeakableIndex(state.segments, index);
    if (index < 0 || !state.segments[index]) {
      state = Player.reduce(state, { type: "STOP" });
      hoveredSegmentIndex = -1;
      render();
      clearHighlight();
      flushPendingDynamicScan();
      return;
    }
    desiredPlaybackPaused = false;
    playbackControlPending = "";
    clearPlaybackControlRetry();
    const playbackId = playbackGate.begin();
    const pageKey = state.pageKey;
    const segment = Object.assign({}, state.segments[index]);
    let prefetched = null;
    playbackStartPending = true;
    state = Player.reduce(state, { type: "SEEK", index });
    state = Object.assign({}, state, { status: "loading", sessionId: null, error: null });
    setServiceStatus("正在加载模型", "synthesizing");
    render();
    highlightCurrent({ deferBroadFallback: true });
    await cancelActiveSession();
    if (!playbackGate.isCurrent(playbackId) || state.pageKey !== pageKey) return;
    prefetched = requestCache.take(requestCacheKey(pageKey, index));
    await requestCache.cancelAll();
    if (!playbackGate.isCurrent(playbackId) || state.pageKey !== pageKey) {
      await requestCache.discard(prefetched);
      return;
    }
    if (currentAudio) {
      currentAudio.pause();
      currentAudio.removeAttribute("src");
      currentAudio = null;
    }
    const sessionId =
      (prefetched && prefetched.sessionId) ||
      nextIdentity("playback");
    activeSession = sessionId;
    playbackStartPending = false;
    activeStreamRequest = "";
    completedStreamSession = "";
    startWordTimeline(index, sessionId);
    state = Player.reduce(state, {
      type: "AUDIO_LOADING",
      sessionId,
    });
    setServiceStatus(desiredPlaybackPaused ? "暂停已排队" : "正在加载模型", desiredPlaybackPaused ? "pause-queued" : "synthesizing");
    render();
    highlightCurrent({ deferBroadFallback: true });
    if (desiredPlaybackPaused) void reconcilePlaybackControl();

    try {
      const audioResult = await Player.resolveAudioRequest(
        prefetched,
        () => synthesizeSegment(segment, sessionId, { stream: true, startPaused: desiredPlaybackPaused }),
      );
      if (
        !playbackGate.isCurrent(playbackId) ||
        state.sessionId !== sessionId ||
        state.pageKey !== pageKey
      ) {
        return;
      }
      if (audioResult && audioResult.streaming && !audioResult.audioBase64) {
        activeStreamRequest = String(audioResult.requestId || sessionId);
        const streamWasPaused = state.status === "paused" || audioResult.paused === true;
        state = Player.reduce(state, {
          type: "AUDIO_PLAYING",
          sessionId,
          prefetchedIndex: findNextSpeakableIndex(state.segments, index + 1),
        });
        if (streamWasPaused) state = Player.reduce(state, { type: "PAUSE" });
        setServiceStatus(
          streamWasPaused ? (desiredPlaybackPaused ? "已暂停" : "正在继续") : (desiredPlaybackPaused ? "暂停已排队" : "正在朗读"),
          streamWasPaused ? (desiredPlaybackPaused ? "paused" : "resuming") : (desiredPlaybackPaused ? "pause-queued" : "playing"),
        );
        render();
        if (streamWasPaused !== desiredPlaybackPaused) void reconcilePlaybackControl();
        const nextIndex = findNextSpeakableIndex(state.segments, index + 1);
        if (nextIndex >= 0) {
          const nextSegment = Object.assign({}, state.segments[nextIndex]);
          const nextSession = `${sessionId}-prefetch-${nextIndex}`;
          const pendingPrefetch = requestCache.prefetch(
            requestCacheKey(pageKey, nextIndex),
            nextSession,
            () => synthesizeSegment(nextSegment, nextSession, { stream: false }),
          );
          pendingPrefetch.catch(() => {});
        }
        return;
      }
      if (!audioResult || !audioResult.audioBase64) {
        throw new Error("本地 Qwen 服务返回了空音频。");
      }
      if (audioResult.streamFallback) {
        setServiceStatus("已切换整段播放", "fallback", {
          transient: true,
          restoreKind: "playing",
          restoreLabel: "正在朗读",
          durationMs: 1800,
        });
      } else {
        setServiceStatus("正在朗读", "playing");
      }
      const audio = new Audio(
        `data:${audioResult.mimeType || "audio/wav"};base64,${audioResult.audioBase64}`,
      );
      currentAudio = audio;
      audioProgressSequence = 0;
      ["loadedmetadata", "timeupdate", "play", "playing"].forEach((eventName) => {
        audio.addEventListener(eventName, () => updateAudioWordProgress(audio, false));
      });
      audio.addEventListener("pause", () => updateAudioWordProgress(audio, false));
      audio.addEventListener("ended", () => {
        if (!playbackGate.isCurrent(playbackId) || currentAudio !== audio) return;
        updateAudioWordProgress(audio, true);
        finishBufferedPlayback(audio);
      });
      audio.addEventListener("error", () => {
        if (!playbackGate.isCurrent(playbackId) || currentAudio !== audio) return;
        desiredPlaybackPaused = false;
        playbackControlPending = "";
        playbackStartPending = false;
        clearPlaybackControlRetry();
        state = Player.reduce(state, {
          type: "ERROR",
          message: "音频无法播放，请重新加载扩展后重试。",
        });
        setServiceStatus("音频播放失败", "error");
        render();
        flushPendingDynamicScan();
      });
      await audio.play();
      if (!playbackGate.isCurrent(playbackId) || currentAudio !== audio) return;
      const nextIndex = findNextSpeakableIndex(state.segments, index + 1);
      state = Player.reduce(state, {
        type: "AUDIO_PLAYING",
        sessionId,
        prefetchedIndex: nextIndex >= 0 ? nextIndex : null,
      });
      if (desiredPlaybackPaused) {
        audio.pause();
        state = Player.reduce(state, { type: "PAUSE" });
        setServiceStatus("已暂停", "paused");
      } else {
        setServiceStatus("正在朗读", "playing");
      }
      render();
      if (nextIndex >= 0) {
        const nextSegment = Object.assign({}, state.segments[nextIndex]);
        const nextSession = `${sessionId}-prefetch-${nextIndex}`;
        const pendingPrefetch = requestCache.prefetch(
          requestCacheKey(pageKey, nextIndex),
          nextSession,
          () => synthesizeSegment(nextSegment, nextSession, { stream: false }),
        );
        pendingPrefetch.catch(() => {});
      }
    } catch (error) {
      if (!playbackGate.isCurrent(playbackId) || state.pageKey !== pageKey) return;
      if (error && error.code === "cancelled") return;
      desiredPlaybackPaused = false;
      playbackControlPending = "";
      playbackStartPending = false;
      clearPlaybackControlRetry();
      state = Player.reduce(state, {
        type: "ERROR",
        message:
          (error && error.message) ||
          "本地 Qwen 合成失败，请检查托盘服务。",
      });
      setServiceError(error, "朗读失败");
      hoveredSegmentIndex = -1;
      clearHighlight();
      render();
      flushPendingDynamicScan();
    }
  }

  async function synthesizeSegment(segment, sessionId, options) {
    const synthOptions = options || {};
    let segmentIndex = Number.isInteger(synthOptions.segmentIndex)
      ? synthOptions.segmentIndex : null;
    if (segmentIndex == null && segment && segment.id) {
      segmentIndex = state.segments.findIndex((candidate) =>
        candidate && String(candidate.id || "") === String(segment.id),
      );
    }
    if (segmentIndex != null && segmentIndex < 0) segmentIndex = null;
    const speechText = String(segment.speechText || "") || (
      typeof Text.prepareSpeechText === "function"
        ? Text.prepareSpeechText(segment.text)
        : String(segment.text || "").trim()
    );
    if (!speechText) {
      const error = new Error("当前片段只有标点，已跳过合成。");
      error.code = "punctuation_only";
      throw error;
    }
    const response = await chrome.runtime.sendMessage({
      type: "tts:synthesize",
      clientId,
      playbackId: sessionId,
      requestId: sessionId,
      sessionId,
      segmentIndex,
      segmentId: segment.id,
      stream: synthOptions.stream === true,
      startPaused: synthOptions.startPaused === true,
      request: {
        input: speechText,
        voice: segment.voice,
        model: Defaults.model || "qwen3-tts-1.7b-base",
        response_format: Defaults.responseFormat || "wav",
        requestId: sessionId,
        playbackId: sessionId,
        sessionId,
        segmentIndex,
        segmentId: segment.id,
      },
    });
    if (!response || !response.ok) {
      const detail = response && response.error;
      const error = new Error(
        (detail && detail.message) || "本地 Qwen 服务没有返回音频。",
      );
      error.code = detail && detail.code;
      throw error;
    }
    return response;
  }

  function requestCacheKey(pageKey, index) {
    return `${pageKey || "page"}:${index}`;
  }

  async function move(offset) {
    if (!state.segments.length) return;
    const target = Math.max(
      0,
      Math.min(state.index + offset, state.segments.length - 1),
    );
    if (target === state.index) return;
    await playIndex(target);
  }

  async function seek(index) {
    if (!Number.isInteger(index) || !state.segments[index]) return;
    await playIndex(index);
  }

  function stopPlayback() {
    const session = activeSession;
    activeSession = "";
    activeStreamRequest = "";
    desiredPlaybackPaused = false;
    playbackControlPending = "";
    playbackStartPending = false;
    clearPlaybackControlRetry();
    cancelHighlightRetry();
    playbackGate.invalidate();
    if (currentAudio) {
      currentAudio.pause();
      currentAudio.removeAttribute("src");
      try {
        currentAudio.load();
      } catch (_) {
        // Some harness Audio stubs do not implement load().
      }
      currentAudio = null;
    }
    state = Player.reduce(state, { type: "STOP" });
    if (["playing", "paused", "synthesizing", "retrying", "fallback"].includes(serviceStatus.kind)) {
      setServiceStatus("已就绪", "ready");
    }
    hoveredSegmentIndex = -1;
    clearHighlight();
    render();
    flushPendingDynamicScan();
    const cancellations = [requestCache.cancelAll()];
    if (session) cancellations.push(cancelSessionById(session));
    return Promise.all(cancellations).catch(() => {});
  }

  async function cancelActiveSession() {
    if (!activeSession) return;
    const session = activeSession;
    activeSession = "";
    await cancelSessionById(session);
  }

  async function cancelSessionById(sessionId) {
    if (!sessionId) return;
    await chrome.runtime
      .sendMessage({
        type: "tts:cancel",
        clientId,
        playbackId: sessionId,
        requestId: sessionId,
        sessionId,
      })
      .catch(() => {});
  }

  function getCurrentPageKey() {
    if (Extractors && typeof Extractors.pageIdentity === "function") {
      return Extractors.pageIdentity(document);
    }
    if (DocumentModel && typeof DocumentModel.makePageKey === "function") {
      return DocumentModel.makePageKey(window.location.href);
    }
    try {
      const url = new URL(window.location.href);
      if (!/^#!?\//u.test(url.hash)) url.hash = "";
      return url.href;
    } catch (_) {
      return String(window.location.href || "").split("#")[0];
    }
  }

  function startLocationWatcher() {
    const check = () => {
      if (getCurrentPageKey() !== lastObservedPageKey) handleLocationChange();
    };
    window.addEventListener("popstate", check);
    window.addEventListener("hashchange", check);
    window.setInterval(check, 700);

    if (typeof MutationObserver === "function" && document.body) {
      const observer = new MutationObserver((records) => {
        const relevant = records.some((record) =>
          Array.from(record.addedNodes || []).some(isReadableMutation),
        );
        if (!relevant) return;
        dynamicScanPending = true;
        flushPendingDynamicScan();
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }
  }

  function flushPendingDynamicScan() {
    if (!dynamicScanPending) return;
    if (["extracting", "loading", "playing", "paused"].includes(state.status)) return;
    dynamicScanPending = false;
    clearTimeout(mutationTimer);
    mutationTimer = setTimeout(() => {
      if (["extracting", "loading", "playing", "paused"].includes(state.status)) {
        dynamicScanPending = true;
        return;
      }
      if (getCurrentPageKey() === lastObservedPageKey) {
        void scanCurrentPage("dynamic-content");
      }
    }, 800);
  }

  function isReadableMutation(node) {
    if (!node || node.nodeType !== 1 || node.id === "qwen-reader-host") return false;
    const selector = [
      ".PostStream-item",
      ".topic-post",
      ".message--post",
      '[component="post"]',
      "article p",
      "main p",
    ].join(",");
    try {
      return node.matches(selector) || Boolean(node.querySelector(selector));
    } catch (_) {
      return false;
    }
  }

  function handleLocationChange() {
    const pageKey = getCurrentPageKey();
    if (pageKey === lastObservedPageKey) return;
    lastObservedPageKey = pageKey;
    dynamicScanPending = false;
    dynamicResumeIndex = null;
    followController.reset();
    lastScrolledLocatorKey = "";
    hoveredSegmentIndex = -1;
    invalidateSourceIndex();
    clearTimeout(mutationTimer);
    if (activeScanController) activeScanController.abort();
    const invalidationId = ++scanCounter;
    stopPlayback();
    state = Player.reduce(state, {
      type: "PAGE_INVALIDATE",
      pageKey,
      scanId: invalidationId,
    });
    render();
    clearTimeout(routeTimer);
    routeTimer = setTimeout(() => {
      void scanCurrentPage("navigation");
    }, 450);
  }

  function invalidateSourceIndex() {
    indexedSegments = null;
    sourceElements = [];
    sourceIndicesByKey = new Map();
    sourceIndicesByElement = new WeakMap();
    textIndexesByElement = new WeakMap();
    sentenceRanges = new Map();
    sentenceRangeOffsets = new Map();
    sentenceMatches = new Map();
    wordRangesBySegment = new Map();
  }

  function ensureSourceIndex(requestedIndex) {
    const mappingsAreFresh = indexedSegments === state.segments && !sourceElements.some(
      (element) => element && element.isConnected === false,
    );
    if (!mappingsAreFresh) {
      indexedSegments = state.segments;
      sourceElements = new Array(state.segments.length);
      sourceIndicesByKey = new Map();
      sourceIndicesByElement = new WeakMap();
      textIndexesByElement = new WeakMap();
      sentenceRanges = new Map();
      sentenceRangeOffsets = new Map();
      sentenceMatches = new Map();
      wordRangesBySegment = new Map();
      state.segments.forEach((segment, index) => {
        const key = sourceLocatorKey(segment);
        const indices = sourceIndicesByKey.get(key) || [];
        indices.push(index);
        sourceIndicesByKey.set(key, indices);
      });
    }

    if (requestedIndex == null) {
      state.segments.forEach((_, index) => {
        if (sourceElements[index] === undefined) ensureSourceIndex(index);
      });
      return;
    }

    const index = Number(requestedIndex);
    if (!Number.isInteger(index) || index < 0 || index >= state.segments.length) return;
    if (sourceElements[index] !== undefined) return;
    const segment = state.segments[index];
    const key = sourceLocatorKey(segment);
    const indices = sourceIndicesByKey.get(key) || [index];
    const element = resolveRawSegmentElement(segment);
    indices.forEach((candidateIndex) => {
      sourceElements[candidateIndex] = element || null;
    });
    if (!element) return;
    const existing = sourceIndicesByElement.get(element) || [];
    sourceIndicesByElement.set(element, Array.from(new Set([...existing, ...indices])));
  }

  function resolveRawSegmentElement(segment) {
    let element = SourceLocator.resolve(document, segment);
    if (!element && segment.sourceKey && segment.sourceKey.startsWith("dom:")) {
      const index = Number(segment.sourceKey.split(":")[1]) - 1;
      element = document.querySelectorAll(".Post")[index] || null;
    } else if (!element && segment.sourceKey && segment.sourceKey.startsWith("generic:")) {
      const index = Number(segment.sourceKey.split(":")[1]);
      const blocks = document.querySelectorAll(
        "article p, article li, main p, main li, [role='main'] p, [role='main'] li",
      );
      element = blocks[index] || null;
      if (!element) element = findReadableElement(segment.text);
    } else if (
      !element &&
      segment.sourceKey &&
      segment.sourceKey.startsWith("readability:")
    ) {
      element = findReadableElement(segment.text);
    } else if (!element && segment.floor) {
      element =
        document.querySelector(`.Post[data-number="${segment.floor}"]`) ||
        document.querySelector(
          `.PostStream-item[data-index="${segment.floor}"] .Post`,
        );
    }
    return element;
  }

  function getSegmentRange(index) {
    ensureSourceIndex(index);
    if (sentenceRanges.has(index)) return sentenceRanges.get(index);
    const element = sourceElements[index];
    if (!element) {
      return null;
    }
    const indices = sourceIndicesByElement.get(element) || [index];
    let textIndex = textIndexesByElement.get(element);
    if (!textIndex) {
      textIndex = SentenceRange.buildTextIndex(element);
      textIndexesByElement.set(element, textIndex);
    }
    let cursor = 0;
    for (const candidateIndex of indices) {
      if (sentenceRanges.has(candidateIndex)) {
        const cached = sentenceRanges.get(candidateIndex);
        if (sentenceRangeOffsets.has(candidateIndex)) cursor = sentenceRangeOffsets.get(candidateIndex);
        if (candidateIndex === index) return cached;
        continue;
      }
      const candidate = state.segments[candidateIndex];
      const match = SentenceRange.findSegment(textIndex, candidate && candidate.text, cursor);
      if (!match) {
        // An unresolved earlier chunk makes every later repeated sentence
        // ambiguous. Never restart at zero: wait for the lazy DOM refresh so
        // the per-element cursor remains monotonic.
        sentenceMatches.delete(candidateIndex);
        return null;
      }
      sentenceMatches.set(candidateIndex, match);
      const range = match ? createDocumentRange(match) : null;
      if (range && match) {
        sentenceRangeOffsets.set(candidateIndex, match.nextOffset);
        cursor = match.nextOffset;
      }
      // A Flarum jump can expose the semantic container before its lazy DOM
      // text has settled. Successful matches are stable cache entries; failed
      // matches must remain retryable or the first sentence is permanently
      // downgraded to a whole-post highlight.
      if (range) sentenceRanges.set(candidateIndex, range);
      if (candidateIndex === index) return range;
    }
    return null;
  }

  function createDocumentRange(match) {
    try {
      const range = document.createRange();
      range.setStart(match.start.node, match.start.offset);
      range.setEnd(match.end.node, match.end.offset);
      return range;
    } catch (_) {
      return null;
    }
  }

  function getWordRanges(index) {
    ensureSourceIndex(index);
    if (wordRangesBySegment.has(index)) return wordRangesBySegment.get(index);
    const segment = state.segments[index];
    let sentenceMatch = sentenceMatches.get(index);
    const element = sourceElements[index];
    const speechMap = segment && segment.speechSourceMap;
    const words = speechMap && Array.isArray(speechMap.words) ? speechMap.words : [];
    if (!sentenceMatch && element) {
      getSegmentRange(index);
      sentenceMatch = sentenceMatches.get(index);
    }
    if (!words.length) {
      wordRangesBySegment.set(index, []);
      return [];
    }
    if (!element || !sentenceMatch) {
      return [];
    }
    let textIndex = textIndexesByElement.get(element);
    if (!textIndex) {
      textIndex = SentenceRange.buildTextIndex(element);
      textIndexesByElement.set(element, textIndex);
    }
    const sourceText = speechMap.sourceText == null
      ? String(segment.text || '') : String(speechMap.sourceText);
    const matches = SentenceRange.findSubranges(
      textIndex,
      sentenceMatch,
      words.map((word) => ({
        text: word.text,
        sourceText,
        sourceStart: word.sourceStart,
        sourceEnd: word.sourceEnd,
      })),
    );
    const ranges = matches.map((match) => match ? createDocumentRange(match) : null);
    // Do not freeze a transient partial/empty lookup. The active word retry
    // will rebuild the DOM text index after virtualized Flarum content lands.
    if (ranges.length === words.length && ranges.every(Boolean)) {
      wordRangesBySegment.set(index, ranges);
    }
    return ranges;
  }

  function customHighlightRegistry() {
    try {
      if (!globalThis.CSS || !globalThis.CSS.highlights
        || typeof globalThis.Highlight !== "function") return null;
      return globalThis.CSS.highlights;
    } catch (_) {
      return null;
    }
  }

  function textNodesForRange(range) {
    if (!range || !range.startContainer || !range.endContainer) return [];
    const startNode = range.startContainer;
    const endNode = range.endContainer;
    // SentenceRange always resolves to text-node boundaries. Failing closed
    // here avoids wrapping an element or accidentally changing page chrome.
    if (startNode.nodeType !== 3 || endNode.nodeType !== 3) return [];
    const startOffset = Number(range.startOffset);
    const endOffset = Number(range.endOffset);
    if (!Number.isInteger(startOffset) || !Number.isInteger(endOffset)
      || startOffset < 0 || endOffset < startOffset
      || startOffset > String(startNode.nodeValue || "").length
      || endOffset > String(endNode.nodeValue || "").length) return [];

    if (startNode === endNode) {
      return endOffset > startOffset
        ? [{ node: startNode, start: startOffset, end: endOffset }]
        : [];
    }

    const root = range.commonAncestorContainer;
    if (!root || typeof document.createTreeWalker !== "function") return [];
    const walkerRoot = root.nodeType === 3 ? root.parentNode : root;
    if (!walkerRoot) return [];
    const entries = [];
    let started = false;
    let reachedEnd = false;
    try {
      const walker = document.createTreeWalker(walkerRoot, 4);
      let node = walker.nextNode();
      while (node) {
        if (node === startNode) started = true;
        if (started) {
          const text = String(node.nodeValue || "");
          const start = node === startNode ? startOffset : 0;
          const end = node === endNode ? endOffset : text.length;
          if (end > start) entries.push({ node, start, end });
          if (node === endNode) {
            reachedEnd = true;
            break;
          }
        }
        node = walker.nextNode();
      }
    } catch (_) {
      return [];
    }
    return reachedEnd ? entries : [];
  }

  function invalidateWordRangeCaches() {
    // Wrapping a Text node necessarily splits it. Re-resolve all cached
    // boundaries after restoring the node so a later word never targets a
    // detached Text node or a stale UTF-16 offset.
    wordRangesBySegment = new Map();
    sentenceRanges = new Map();
    sentenceRangeOffsets = new Map();
    sentenceMatches = new Map();
    textIndexesByElement = new WeakMap();
  }

  function restoreWordFallback() {
    const marks = wordFallbackMarks;
    wordFallbackMarks = [];
    if (!marks.length) return false;

    for (let index = marks.length - 1; index >= 0; index -= 1) {
      const mark = marks[index];
      const wrapper = mark && mark.wrapper;
      const selected = mark && mark.selected;
      try {
        const expectedParent = mark && mark.parent;
        let parent = expectedParent && expectedParent.nodeType ? expectedParent : null;
        if (wrapper && wrapper.parentNode) {
          parent = wrapper.parentNode;
          if (selected && selected.parentNode === wrapper) {
            parent.replaceChild(selected, wrapper);
          } else {
            while (wrapper.firstChild) parent.insertBefore(wrapper.firstChild, wrapper);
            parent.removeChild(wrapper);
          }
        }

        // Join only the pieces created by this fallback. This restores the
        // original Text node without normalizing unrelated page content.
        let anchor = selected && parent && selected.parentNode === parent ? selected : null;
        const before = mark.before;
        const after = mark.after;
        if (before && anchor && before.parentNode === parent && before.nextSibling === anchor) {
          before.nodeValue += anchor.nodeValue;
          parent.removeChild(anchor);
          anchor = before;
        }
        if (after && anchor && anchor.parentNode === parent && anchor.nextSibling === after) {
          anchor.nodeValue += after.nodeValue;
          parent.removeChild(after);
        }
      } catch (_) {
        // The page may have removed or rewritten the source while audio was
        // playing. Leave its current DOM intact and fail closed.
      }
    }
    invalidateWordRangeCaches();
    return true;
  }

  function installWordFallback(range) {
    const entries = textNodesForRange(range);
    if (!entries.length) return false;
    const marks = [];
    try {
      // Process from the end so every precomputed UTF-16 offset remains valid
      // even when multiple inline text nodes belong to the same word range.
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        const node = entry.node;
        if (!node || !node.parentNode || String(node.nodeValue || "").length < entry.end) {
          throw new Error("Word fallback boundary is no longer connected.");
        }
        const original = node;
        const wrapper = document.createElement("span");
        wrapper.className = "qwen-reader-speaking-word";
        wrapper.setAttribute("data-qwen-reader-word-fallback", "true");
        wrapper.style.setProperty("pointer-events", "none", "important");
        let after = null;
        if (entry.end < original.nodeValue.length) after = original.splitText(entry.end);
        const selected = entry.start > 0 ? original.splitText(entry.start) : original;
        const mark = {
          wrapper,
          selected,
          before: entry.start > 0 ? original : null,
          after,
          parent: selected.parentNode,
        };
        marks.push(mark);
        selected.parentNode.replaceChild(wrapper, selected);
        wrapper.appendChild(selected);
      }
      wordFallbackMarks = marks;
      return true;
    } catch (_) {
      wordFallbackMarks = marks;
      restoreWordFallback();
      return false;
    }
  }

  function clearWordHighlight() {
    try {
      const registry = globalThis.CSS && globalThis.CSS.highlights;
      if (registry && typeof registry.delete === "function") {
        registry.delete("qwen-reader-current-word");
      }
    } catch (_) {}
    restoreWordFallback();
    clearWordMotion();
    highlightedWordIndex = -1;
  }

  function highlightWord(index) {
    retireWordMotion();
    try {
      const registry = globalThis.CSS && globalThis.CSS.highlights;
      if (registry && typeof registry.delete === "function") {
        registry.delete("qwen-reader-current-word");
      }
    } catch (_) {}
    restoreWordFallback();
    highlightedWordIndex = -1;
    if (!wordTimeline || index < 0 || index >= wordTimeline.words.length) return false;
    const ranges = getWordRanges(state.index);
    const range = ranges[index];
    if (!range) {
      scheduleHighlightRetry(state.index);
      return false;
    }
    const registry = customHighlightRegistry();
    if (registry && typeof registry.set === "function") {
      try {
        registry.set(
          "qwen-reader-current-word",
          new globalThis.Highlight(range),
        );
        highlightedWordIndex = index;
        showWordMotion(range, index);
        return true;
      } catch (_) {}
    }
    if (installWordFallback(range)) {
      highlightedWordIndex = index;
      showWordMotion(range, index);
      return true;
    }
    scheduleHighlightRetry(state.index);
    return false;
  }

  function prefersReducedWordMotion() {
    try {
      return typeof window.matchMedia === "function"
        && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch (_) {
      return false;
    }
  }

  function wordMotionRects() {
    const rects = [];
    try {
      const sources = wordFallbackMarks.length
        ? wordFallbackMarks.map((mark) => mark && mark.wrapper).filter(Boolean)
        : wordMotionRange && typeof wordMotionRange.getClientRects === "function"
          ? Array.from(wordMotionRange.getClientRects())
          : [];
      for (const source of sources) {
        const candidate = source && typeof source.getBoundingClientRect === "function"
          ? source.getBoundingClientRect()
          : source;
        if (!candidate) continue;
        const left = Number(candidate.left);
        const top = Number(candidate.top);
        const width = Number(candidate.width);
        const height = Number(candidate.height);
        if (!Number.isFinite(left) || !Number.isFinite(top)
          || !Number.isFinite(width) || !Number.isFinite(height)
          || width <= .5 || height <= .5
          || top > window.innerHeight + 24 || top + height < -24
          || left > window.innerWidth + 24 || left + width < -24) continue;
        rects.push({ left, top, width, height });
      }
    } catch (_) {}
    return rects;
  }

  function wordMotionCursorTarget(rects) {
    if (!rects.length) return null;
    const last = rects[rects.length - 1];
    const sameLine = rects.filter((rect) =>
      Math.abs((rect.top + rect.height) - (last.top + last.height)) < 3
    );
    const left = Math.min(...sameLine.map((rect) => rect.left));
    const right = Math.max(...sameLine.map((rect) => rect.left + rect.width));
    return {
      left: left - 2,
      top: last.top + last.height - 1.5,
      width: Math.max(8, right - left + 4),
    };
  }

  function ensureWordMotionCursor(layer) {
    let cursor = layer.querySelector(".qr-word-motion-cursor");
    if (!cursor) {
      cursor = document.createElement("span");
      cursor.className = "qr-word-motion-cursor";
      cursor.setAttribute("aria-hidden", "true");
      layer.appendChild(cursor);
    }
    return cursor;
  }

  function wordMotionInkRect(rects) {
    return rects.reduce((best, rect) => !best || rect.width > best.width ? rect : best, null);
  }

  function styleWordMotionInk(ink, range) {
    const container = range && range.startContainer;
    const element = container && (container.nodeType === 1 ? container : container.parentElement);
    if (!element || typeof window.getComputedStyle !== "function") return;
    try {
      const computed = window.getComputedStyle(element);
      for (const property of [
        "fontFamily", "fontSize", "fontWeight", "fontStyle", "fontStretch",
        "fontVariant", "fontKerning", "fontFeatureSettings", "letterSpacing",
        "textTransform", "textRendering", "direction",
      ]) {
        if (computed[property]) ink.style[property] = computed[property];
      }
    } catch (_) {}
  }

  function placeWordMotionInk(ink, rect) {
    ink.style.left = `${rect.left}px`;
    ink.style.top = `${rect.top}px`;
    ink.style.width = `${rect.width + 1}px`;
    ink.style.height = `${rect.height}px`;
    ink.style.lineHeight = `${rect.height}px`;
  }

  function setWordMotionCursorBox(cursor, target) {
    cursor.style.left = `${target.left}px`;
    cursor.style.top = `${target.top}px`;
    cursor.style.width = `${target.width}px`;
  }

  function moveWordMotionCursor(cursor, target, wordIndex, instant) {
    cursor.dataset.wordIndex = String(wordIndex);
    setWordMotionCursorBox(cursor, target);
    wordMotionCursorRect = target;
    cursor.classList.remove("is-hidden");
    if (instant) return;
    // The word and underline stay fixed. Restart only the one-way light sweep
    // when speech advances, so there is no glyph bounce or positional recoil.
    cursor.classList.remove("is-running");
    void cursor.offsetWidth;
    cursor.classList.add("is-running");
  }

  function positionWordMotion() {
    if (highlightedWordIndex < 0 || !wordMotionRange) return;
    if (settings.wordHighlightStyle === "classic-glow") return;
    const layer = shadow.querySelector('[data-role="word-motion-layer"]');
    if (!layer) return;
    const target = wordMotionCursorTarget(wordMotionRects());
    const cursor = layer.querySelector(".qr-word-motion-cursor");
    if (!target || !cursor) return;
    moveWordMotionCursor(cursor, target, highlightedWordIndex, true);
    const ink = layer.querySelector(".qr-word-motion-ink:not(.is-exiting)");
    const inkRect = wordMotionInkRect(wordMotionRects());
    if (ink && inkRect) placeWordMotionInk(ink, inkRect);
  }

  function retireWordMotion() {
    wordMotionRange = null;
    document.documentElement.classList.remove("qwen-reader-word-ink-overlay");
    const layer = shadow.querySelector('[data-role="word-motion-layer"]');
    if (!layer) return;
    for (const ink of layer.querySelectorAll(".qr-word-motion-ink")) {
      // The page glyph becomes visible again as soon as its native Highlight is
      // removed. Keeping a translated clone during that hand-off creates a
      // double image, so cloned ink is retired synchronously.
      ink.remove();
    }
    const cursor = layer.querySelector(".qr-word-motion-cursor");
    if (!cursor) return;
    if (wordMotionRetireTimer != null) window.clearTimeout(wordMotionRetireTimer);
    wordMotionRetireTimer = window.setTimeout(() => {
      wordMotionRetireTimer = null;
      if (!wordMotionRange) cursor.classList.add("is-hidden");
    }, prefersReducedWordMotion() ? 0 : 180);
  }

  function clearWordMotion() {
    wordMotionRange = null;
    wordMotionCursorRect = null;
    if (wordMotionRetireTimer != null) window.clearTimeout(wordMotionRetireTimer);
    wordMotionRetireTimer = null;
    const layer = shadow.querySelector('[data-role="word-motion-layer"]');
    if (layer) {
      layer.replaceChildren();
      layer.classList.remove("is-paused");
    }
    document.documentElement.classList.remove("qwen-reader-word-ink-overlay");
    document.documentElement.classList.remove("qwen-reader-word-motion-paused");
  }

  function showWordMotion(range, wordIndex) {
    wordMotionRange = range;
    document.documentElement.classList.remove("qwen-reader-word-ink-overlay");
    const layer = shadow.querySelector('[data-role="word-motion-layer"]');
    if (!layer) return;
    const style = normalizeWordHighlightStyle(settings.wordHighlightStyle);
    layer.dataset.style = style;
    if (wordMotionRetireTimer != null) window.clearTimeout(wordMotionRetireTimer);
    wordMotionRetireTimer = null;
    for (const ink of layer.querySelectorAll(".qr-word-motion-ink")) ink.remove();
    if (style === "classic-glow") {
      const existingCursor = layer.querySelector(".qr-word-motion-cursor");
      if (existingCursor) existingCursor.classList.add("is-hidden");
      syncWordMotionPlaybackState();
      return;
    }
    const rects = wordMotionRects();
    const target = wordMotionCursorTarget(rects);
    if (!target) return;
    const cursor = ensureWordMotionCursor(layer);
    cursor.classList.remove("is-hidden");
    if (!wordFallbackMarks.length) {
      const rect = wordMotionInkRect(rects);
      if (rect) {
        const ink = document.createElement("span");
        ink.className = "qr-word-motion-ink";
        ink.dataset.wordIndex = String(wordIndex);
        ink.dataset.word = range.toString();
        ink.textContent = range.toString();
        styleWordMotionInk(ink, range);
        placeWordMotionInk(ink, rect);
        layer.insertBefore(ink, cursor);
        // Custom Highlight cannot draw a clipped moving light. Hide only the
        // exact original glyph while this fixed-position ink copy is visible;
        // the page layout and the glyph position remain unchanged.
        document.documentElement.classList.add("qwen-reader-word-ink-overlay");
      }
    }
    moveWordMotionCursor(cursor, target, wordIndex, false);
    syncWordMotionPlaybackState();
  }

  function syncWordMotionPlaybackState() {
    const paused = state.status === "paused" && highlightedWordIndex >= 0;
    const layer = shadow.querySelector('[data-role="word-motion-layer"]');
    if (layer) {
      layer.classList.toggle("is-paused", paused);
      const cursor = layer.querySelector(".qr-word-motion-cursor");
      if (cursor) {
        for (const animation of cursor.getAnimations()) {
          if (paused && animation.playState === "running") animation.pause();
          if (!paused && animation.playState === "paused") animation.play();
        }
      }
    }
    document.documentElement.classList.toggle("qwen-reader-word-motion-paused", paused);
  }

  function startWordTimeline(index, playbackId) {
    const segment = state.segments[index];
    const speechMap = segment && segment.speechSourceMap;
    wordTimeline = WordTimeline.createTimeline({
      segmentIndex: index,
      segmentId: segment && segment.id,
      playbackId,
      speechText: segment && segment.speechText,
      words: speechMap && speechMap.words,
    });
    cancelHighlightRetry();
    highlightRetryKey = `${playbackId}:${index}`;
    clearWordHighlight();
  }

  function applyWordProgress(progress) {
    if (!wordTimeline || !progress) return null;
    if (state.status === "paused" && progress.paused !== false) {
      return {
        ignored: true,
        index: wordTimeline.activeWordIndex,
        done: Boolean(progress.done),
      };
    }
    const result = WordTimeline.applyProgress(wordTimeline, progress);
    if (!result.ignored && result.index >= 0 && result.index !== highlightedWordIndex) {
      highlightWord(result.index);
    }
    if (!result.ignored && settings.readingFocus === "line") positionReadingFocus();
    return result;
  }

  function updateAudioWordProgress(audio, done) {
    if (!audio || currentAudio !== audio || !wordTimeline) return;
    const currentTime = Number(audio.currentTime);
    const duration = Number(audio.duration);
    const progress = {
      playedSeconds: Number.isFinite(currentTime) && currentTime >= 0 ? currentTime : 0,
      sequence: ++audioProgressSequence,
    };
    if (Number.isFinite(duration) && duration > 0) progress.durationSeconds = duration;
    if (done) progress.done = true;
    applyWordProgress(progress);
  }

  function getSegmentRects(index) {
    const range = getSegmentRange(index);
    if (range && typeof range.getClientRects === "function") {
      const rects = Array.from(range.getClientRects()).filter((rect) =>
        Number.isFinite(rect.left) && Number.isFinite(rect.top) && rect.width > .5 && rect.height > .5
      );
      if (rects.length) return rects;
    }
    ensureSourceIndex(index);
    const element = sourceElements[index];
    if (!element || typeof element.getBoundingClientRect !== "function") return [];
    const rect = element.getBoundingClientRect();
    return rect && rect.width > .5 && rect.height > .5 ? [rect] : [];
  }

  function refreshSegmentLocation(index) {
    ensureSourceIndex(index);
    const segment = state.segments[index];
    if (!segment) return null;
    const resolved = resolveRawSegmentElement(segment);
    if (!resolved) return null;
    const key = sourceLocatorKey(segment);
    const group = [];
    state.segments.forEach((candidate, candidateIndex) => {
      if (sourceLocatorKey(candidate) !== key) return;
      sourceElements[candidateIndex] = resolved;
      sentenceRanges.delete(candidateIndex);
      sentenceRangeOffsets.delete(candidateIndex);
      sentenceMatches.delete(candidateIndex);
      wordRangesBySegment.delete(candidateIndex);
      group.push(candidateIndex);
    });
    sourceIndicesByElement.set(resolved, group);
    textIndexesByElement.delete(resolved);
    return resolved;
  }

  function cancelHighlightRetry() {
    clearTimeout(highlightRetryTimer);
    highlightRetryTimer = null;
    highlightRetryKey = "";
    highlightRetryAttempt = 0;
  }

  function scheduleHighlightRetry(index) {
    if (!activeSession || !wordTimeline || index !== state.index) return;
    const key = `${activeSession}:${index}`;
    if (highlightRetryKey !== key) {
      clearTimeout(highlightRetryTimer);
      highlightRetryTimer = null;
      highlightRetryKey = key;
      highlightRetryAttempt = 0;
    }
    if (highlightRetryTimer || highlightRetryAttempt >= 30) return;
    const attempt = ++highlightRetryAttempt;
    highlightRetryTimer = setTimeout(() => {
      highlightRetryTimer = null;
      if (!activeSession || `${activeSession}:${state.index}` !== key || !wordTimeline) return;
      refreshSegmentLocation(index);
      const sentenceReady = highlightCurrent({ deferBroadFallback: true, retry: true });
      const activeWord = wordTimeline.activeWordIndex;
      const wordReady = activeWord < 0 ? true : highlightWord(activeWord);
      if (wordReady && settings.readingFocus === "line") positionReadingFocus();
      if (!sentenceReady || !wordReady) scheduleHighlightRetry(index);
    }, Math.min(400, 60 + attempt * 20));
  }

  function highlightCurrent(options) {
    const followOptions = options || {};
    const segment = state.current;
    if (!segment) {
      clearHighlight();
      return;
    }
    const index = state.index;
    ensureSourceIndex(index);
    const element = sourceElements[index];
    if (!element) {
      highlightedElement = null;
      highlightedRange = null;
      highlightedIndex = -1;
      scheduleHighlightRetry(index);
      return false;
    }
    clearElementFallback();
    clearNativeHighlight();
    const range = getSegmentRange(index);
    highlightedElement = element;
    highlightedRange = range;
    highlightedIndex = index;
    const deferBroadFallback = followOptions.deferBroadFallback === true && !range;
    const sharesElement = (sourceIndicesByElement.get(element) || []).length > 1;
    if (settings.readingFocus === "sentence") {
      if (!installNativeHighlight(range) && !deferBroadFallback && !sharesElement) {
        element.classList.add("qwen-reader-speaking");
      }
    } else if (settings.readingFocus === "line") {
      positionReadingFocus();
    }
    if (!range) scheduleHighlightRetry(index);
    const followKey = `${sourceLocatorKey(segment)}:${segment.id || index}`;
    if (
      followController.canFollow() &&
      (followOptions.forceFollow || followKey !== lastScrolledLocatorKey)
    ) {
      centerSegment(index, element);
      lastScrolledLocatorKey = followKey;
    }
    hoveredSegmentIndex = index;
    renderReadingMarker();
    return Boolean(range);
  }

  function installNativeHighlight(range) {
    if (!range) return false;
    const registry = customHighlightRegistry();
    if (!registry || typeof registry.set !== "function") return false;
    try {
      registry.set("qwen-reader-current", new globalThis.Highlight(range));
      return true;
    } catch (_) {
      return false;
    }
  }

  function clearSentenceNativeHighlight() {
    try {
      const registry = globalThis.CSS && globalThis.CSS.highlights;
      if (registry && typeof registry.delete === "function") {
        registry.delete("qwen-reader-current");
      }
    } catch (_) {}
  }

  function hideReadingFocus() {
    const band = shadow.querySelector('[data-role="line-focus-band"]');
    if (!band) return;
    band.classList.remove("is-visible");
    band.style.removeProperty("left");
    band.style.removeProperty("top");
    band.style.removeProperty("width");
    band.style.removeProperty("height");
  }

  function readingFocusAnchorRect(segmentRects) {
    const wordRects = highlightedWordIndex >= 0 ? wordMotionRects() : [];
    const anchor = wordRects[0] || segmentRects[0];
    if (!anchor) return null;
    const top = Number(anchor.top);
    const height = Number(anchor.height ?? (anchor.bottom - anchor.top));
    if (!Number.isFinite(top) || !Number.isFinite(height) || height <= .5) return null;
    return { top, bottom: top + height, height };
  }

  function currentVisualLineRect() {
    if (highlightedIndex < 0 || !highlightedElement) return null;
    const segmentRects = getSegmentRects(highlightedIndex).filter((rect) => {
      const width = Number(rect.width ?? (rect.right - rect.left));
      const height = Number(rect.height ?? (rect.bottom - rect.top));
      return Number.isFinite(rect.left) && Number.isFinite(rect.top)
        && Number.isFinite(width) && Number.isFinite(height) && width > .5 && height > .5;
    });
    const anchor = readingFocusAnchorRect(segmentRects);
    if (!anchor) return null;
    const matchingRects = segmentRects.filter((rect) => {
      const rectBottom = Number(rect.bottom ?? (rect.top + rect.height));
      const overlap = Math.min(rectBottom, anchor.bottom) - Math.max(rect.top, anchor.top);
      const rectHeight = Number(rect.height ?? (rectBottom - rect.top));
      return overlap >= Math.min(anchor.height, rectHeight) * .42;
    });
    const lineRects = matchingRects.length ? matchingRects : segmentRects.slice(0, 1);
    if (!lineRects.length) return null;
    const lineTop = Math.min(...lineRects.map((rect) => Number(rect.top)));
    const lineBottom = Math.max(...lineRects.map((rect) => Number(rect.bottom ?? (rect.top + rect.height))));
    const sourceRect = typeof highlightedElement.getBoundingClientRect === "function"
      ? highlightedElement.getBoundingClientRect()
      : null;
    const fragmentLeft = Math.min(...lineRects.map((rect) => Number(rect.left)));
    const fragmentRight = Math.max(...lineRects.map((rect) => Number(rect.right ?? (rect.left + rect.width))));
    const sourceWidth = sourceRect && Number(sourceRect.width);
    const useSourceWidth = sourceRect && Number.isFinite(sourceRect.left)
      && Number.isFinite(sourceRect.right) && Number.isFinite(sourceWidth)
      && sourceWidth > .5 && sourceWidth <= window.innerWidth * .96;
    const left = useSourceWidth ? sourceRect.left : fragmentLeft;
    const right = useSourceWidth ? sourceRect.right : fragmentRight;
    return {
      left: Math.max(0, left),
      top: lineTop,
      width: Math.max(1, Math.min(window.innerWidth, right) - Math.max(0, left)),
      height: Math.max(1, lineBottom - lineTop),
    };
  }

  function positionReadingFocus() {
    const band = shadow.querySelector('[data-role="line-focus-band"]');
    if (!band || settings.readingFocus !== "line" || highlightedIndex < 0) {
      hideReadingFocus();
      return;
    }
    const rect = currentVisualLineRect();
    if (!rect || rect.top > window.innerHeight + 24 || rect.top + rect.height < -24) {
      hideReadingFocus();
      return;
    }
    band.style.left = `${Math.round(rect.left)}px`;
    band.style.top = `${rect.top}px`;
    band.style.width = `${Math.round(rect.width)}px`;
    band.style.height = `${rect.height}px`;
    band.classList.add("is-visible");
  }

  function refreshReadingFocus() {
    clearElementFallback();
    clearSentenceNativeHighlight();
    hideReadingFocus();
    if (highlightedIndex < 0 || !highlightedElement) return;
    if (settings.readingFocus === "line") {
      positionReadingFocus();
      return;
    }
    if (settings.readingFocus !== "sentence") return;
    const range = highlightedRange || getSegmentRange(highlightedIndex);
    const sharesElement = (sourceIndicesByElement.get(highlightedElement) || []).length > 1;
    if (!installNativeHighlight(range) && !sharesElement) {
      highlightedElement.classList.add("qwen-reader-speaking");
    }
  }

  function clearNativeHighlight() {
    hideReadingFocus();
    try {
      const registry = globalThis.CSS && globalThis.CSS.highlights;
      if (registry && typeof registry.delete === "function") {
        registry.delete("qwen-reader-current");
        registry.delete("qwen-reader-current-word");
      }
    } catch (_) {}
    restoreWordFallback();
    clearWordMotion();
    highlightedWordIndex = -1;
  }

  function centerSegment(index, element) {
    const rects = getSegmentRects(index);
    const rect = rects[0];
    if (rect && typeof window.scrollBy === "function") {
      const delta = rect.top + rect.height / 2 - window.innerHeight / 2;
      if (Math.abs(delta) > 2) {
        window.scrollBy({ top: delta, left: 0, behavior: "smooth" });
      }
      return;
    }
    if (element && typeof element.scrollIntoView === "function") {
      element.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
    }
  }

  function scheduleOverlayUpdate() {
    if (overlayFrame != null) return;
    overlayFrame = requestAnimationFrame(() => {
      overlayFrame = null;
      const displayIndex = isPlaybackActive() ? state.index : hoveredSegmentIndex;
      if (displayIndex >= 0) positionReadingMarker(displayIndex);
      positionReadingFocus();
      positionWordMotion();
    });
  }

  function sourceLocatorKey(segment) {
    const locator = segment && segment.sourceLocator;
    if (locator) {
      return [
        locator.adapter,
        locator.containerSelector,
        locator.unitIndex,
        locator.fingerprint,
      ].join(":");
    }
    return String(
      (segment && (segment.sourceKey || segment.sourceSelector || segment.id)) || "",
    );
  }

  function findReadableElement(spokenText) {
    const needle = Text.cleanText
      ? Text.cleanText(spokenText)
      : String(spokenText || "").trim();
    if (!needle) return null;
    const candidates = document.querySelectorAll([
      "article p",
      "article li",
      "article blockquote",
      "main p",
      "main li",
      '[role="main"] p',
      '[role="main"] li',
      ".article-content p",
      ".entry-content p",
      ".chapter-content p",
      ".read-content p",
      ".mm-post .card-body",
      ".card-body",
      "[itemprop='articleBody']",
      "#chaptercontent",
      "#content",
      ".article-content",
      ".article-body",
      ".entry-content",
      ".entry-body",
      ".post-content",
      ".message-content",
      ".chapter-content",
      ".read-content",
      ".reader-content",
      ".novel-content",
      ".content",
      "article",
      "main",
      "[role='main']",
    ].join(","));
    let best = null;
    let bestRank = Infinity;
    let bestLength = Infinity;
    for (const element of Array.from(candidates).slice(0, 2000)) {
      const candidate = Text.cleanText
        ? Text.cleanText(element.textContent)
        : String(element.textContent || "").trim();
      if (!candidate) continue;
      let rank = Infinity;
      if (candidate === needle) rank = 0;
      else if (candidate.includes(needle)) rank = 1;
      else if (needle.length > 24 && needle.includes(candidate)) rank = 2;
      if (rank < bestRank || (rank === bestRank && candidate.length < bestLength)) {
        best = element;
        bestRank = rank;
        bestLength = candidate.length;
      }
    }
    return best;
  }

  function renderReadingMarker() {
    const controller = shadow.querySelector('[data-role="reading-marker"]');
    const followChip = shadow.querySelector(".qr-follow-chip");
    if (!controller || !followChip) return;
    const active = isPlaybackActive();
    const displayIndex = active ? state.index : settings.clickToRead ? hoveredSegmentIndex : -1;
    const segment = displayIndex >= 0 ? state.segments[displayIndex] : null;
    const showFollow = active && followController.mode === "manual";
    followChip.classList.toggle("is-visible", showFollow);
    if (!segment) {
      controller.classList.remove("is-visible", "is-active");
      controller.replaceChildren();
      lastMarkerIndex = -1;
      return;
    }
    const isCurrentPlaying = displayIndex === state.index && state.status === "playing";
    const icon = `<img class="qr-icon qr-marker-icon" src="${isCurrentPlaying ? iconUrls.pause : iconUrls.play}" alt="">`;
    const actionLabel = isCurrentPlaying ? "暂停当前句" : `从第 ${displayIndex + 1} 句开始朗读`;
    const voiceColor = voiceAccent(segment.voice || segment.authorId || segment.authorName);
    const authorLabel = segment.isOp
      ? "楼主"
      : (segment.authorName || "正文");
    controller.innerHTML = `
      <button class="qr-marker-button" style="--qr-speaker-accent:${voiceColor}" type="button" data-action="marker-play" data-index="${displayIndex}" aria-label="${escapeAttribute(actionLabel)}">
        <span class="qr-marker-action" aria-hidden="true">${icon}</span>
        <span class="qr-marker-voice">${escapeHtml(segment.voice || "默认音色")}</span>
        <span class="qr-marker-separator" aria-hidden="true">·</span>
        <span class="qr-marker-context">${escapeHtml(authorLabel)}</span>
        <span class="qr-marker-progress" aria-label="第 ${displayIndex + 1} 句，共 ${state.segments.length} 句">${displayIndex + 1}/${state.segments.length}</span>
      </button>
    `;
    controller.classList.add("is-visible");
    controller.classList.toggle("is-active", active);
    if (displayIndex !== lastMarkerIndex) {
      controller.classList.remove("is-entering");
      void controller.offsetWidth;
      controller.classList.add("is-entering");
      lastMarkerIndex = displayIndex;
    }
    positionReadingMarker(displayIndex);
  }

  function positionReadingMarker(index) {
    const controller = shadow.querySelector('[data-role="reading-marker"]');
    if (!controller || !controller.classList.contains("is-visible")) return;
    const rects = getSegmentRects(index).filter((rect) =>
      rect.bottom > -32 && rect.top < window.innerHeight + 32
    );
    if (!rects.length) {
      controller.classList.add("is-safe-hidden");
      return;
    }
    const controlWidth = controller.offsetWidth || 150;
    const controlHeight = controller.offsetHeight || 22;
    const placement = MarkerPlacement.chooseMarkerPlacement({
      sentenceRects: rects,
      markerWidth: controlWidth,
      markerHeight: controlHeight,
      viewport: { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight },
      occupiedRects: collectOccupiedTextRects(index),
      gap: 7,
      viewportPadding: 8,
    });
    controller.classList.toggle("is-safe-hidden", !placement);
    if (!placement) return;
    controller.dataset.placement = placement.placement;
    controller.style.left = `${Math.round(placement.left)}px`;
    controller.style.top = `${Math.round(placement.top)}px`;
  }

  function collectOccupiedTextRects(index) {
    ensureSourceIndex(index);
    const source = sourceElements[index];
    if (!source || typeof document.createTreeWalker !== "function" || typeof document.createRange !== "function") {
      return [];
    }
    const parent = source.parentElement;
    const root = parent && parent !== document.body && parent !== document.documentElement ? parent : source;
    const walker = document.createTreeWalker(root, 4);
    const rects = [];
    let visited = 0;
    let node = walker.nextNode();
    while (node && visited < 500 && rects.length < 800) {
      visited += 1;
      const owner = node.parentElement;
      const value = String(node.nodeValue || "").trim();
      if (
        value &&
        owner &&
        !owner.closest("script, style, noscript, template, [hidden], [aria-hidden='true']")
      ) {
        try {
          const range = document.createRange();
          range.selectNodeContents(node);
          for (const rect of Array.from(range.getClientRects())) {
            if (
              rect.width > .5 && rect.height > .5 &&
              rect.bottom > -40 && rect.top < window.innerHeight + 40
            ) {
              rects.push({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom });
            }
          }
          if (typeof range.detach === "function") range.detach();
        } catch (_) {}
      }
      node = walker.nextNode();
    }
    return rects;
  }

  function voiceAccent(value) {
    const palette = ["#7458e8", "#1877c9", "#b34f76", "#167c68", "#a45b18", "#5863c7"];
    let hash = 2166136261;
    for (const character of String(value || "voice")) {
      hash ^= character.codePointAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return palette[(hash >>> 0) % palette.length];
  }

  function clearElementFallback() {
    if (highlightedElement) highlightedElement.classList.remove("qwen-reader-speaking");
  }

  function clearHighlight() {
    cancelHighlightRetry();
    clearElementFallback();
    clearNativeHighlight();
    clearWordMotion();
    wordTimeline = null;
    highlightedElement = null;
    highlightedRange = null;
    highlightedIndex = -1;
    renderReadingMarker();
  }

  // Popup-first render surface: persistent reading affordances remain inline
  // with the page, while the browser action owns configuration and discovery.
  function render() {
    renderShell();
    renderNow();
    renderReadingMarker();
    publishReaderSnapshot();
  }

  function renderShell() {
    syncWordMotionPlaybackState();
  }

  function renderNow() {
    const player = shadow.querySelector('[data-role="mini-player"]');
    if (!player) return;
    const current = state.current;
    const active = ["loading", "playing", "paused"].includes(state.status);
    const isPlaying = state.status === "playing" || (state.status === "loading" && !desiredPlaybackPaused);
    const busy = state.status === "loading" || Boolean(playbackControlPending);
    const avatar = shadow.querySelector('[data-role="mini-avatar"]');
    const speaker = shadow.querySelector('[data-role="mini-speaker"]');
    const meta = shadow.querySelector('[data-role="mini-meta"]');
    const text = shadow.querySelector('[data-role="mini-text"]');
    const playIcon = shadow.querySelector('[data-role="mini-play-icon"]');
    const playButton = player.querySelector('[data-action="play-toggle"]');
    const previous = player.querySelector('[data-action="previous"]');
    const next = player.querySelector('[data-action="next"]');
    const total = state.segments.length;
    player.classList.toggle("is-visible", active);
    player.classList.toggle("is-loading", state.status === "loading");
    player.classList.toggle("is-paused", state.status === "paused" || desiredPlaybackPaused);
    player.setAttribute("aria-hidden", String(!active));
    if (avatar) avatar.textContent = initials(current && current.authorName || "Q");
    if (speaker) speaker.textContent = current ? getDisplayAuthor(current) : "正在准备朗读";
    if (meta) {
      const role = current ? getRoleLabel(current) : "当前网页";
      const voice = current && current.voice ? ` · ${current.voice}` : "";
      meta.textContent = `${role}${voice}`;
    }
    if (text) text.textContent = current ? truncateText(current.text, 72) : "正在连接本地朗读服务…";
    if (playIcon) playIcon.src = isPlaying ? iconUrls.pause : iconUrls.play;
    if (playButton) {
      playButton.disabled = busy && !activeSession && !playbackStartPending;
      playButton.setAttribute("aria-label", isPlaying ? "暂停朗读" : "继续朗读");
    }
    if (previous) previous.disabled = !total || busy;
    if (next) next.disabled = !total || busy;
  }

  function showToast(message) {
    const toast = shadow.querySelector(".qr-toast");
    toast.textContent = message;
    toast.classList.add("is-visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 3200);
  }

  function stripPlaybackFields(segment) {
    const clone = Object.assign({}, segment);
    delete clone.voice;
    return clone;
  }

  function cleanTitle(title) {
    return String(title || "当前网页")
      .replace(/\s*[-–—|]\s*[^-–—|]{1,30}$/u, "")
      .trim();
  }

  function truncateText(value, limit) {
    const text = String(value || "").replace(/\s+/gu, " ").trim();
    const length = Math.max(1, Number(limit) || 80);
    return text.length > length ? `${text.slice(0, Math.max(1, length - 1))}…` : text;
  }

  function initials(value) {
    const text = String(value || "Q").trim();
    if (!text) return "Q";
    return /[\u3400-\u9fff]/u.test(text)
      ? text.slice(0, 1)
      : text.slice(0, 2).toUpperCase();
  }

  function unique(values) {
    return Array.from(new Set(values));
  }

  function createIdentityFactoryFallback() {
    const instanceEntropy = Math.random().toString(16).slice(2);
    let sequence = 0;
    return function nextFallbackIdentity(kind) {
      const label = String(kind || "request");
      sequence += 1;
      if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
        return `qwen-reader-${label}-${globalThis.crypto.randomUUID()}`;
      }
      return `qwen-reader-${label}-${Date.now().toString(36)}-${instanceEntropy}-${sequence.toString(36)}-${Math.random().toString(16).slice(2)}`;
    };
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function escapeAttribute(value) {
    return escapeHtml(value).replace(/`/g, "&#96;");
  }
})();
