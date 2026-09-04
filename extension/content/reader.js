/* global chrome, QwenReaderDefaults, QwenReaderText, QwenReaderDocument, QwenReaderExtractors, QwenReaderSourceLocator, QwenReaderSentenceRange, QwenReaderMarkerPlacement, QwenReaderFollow, QwenReaderVoiceAssignment, QwenReaderPlayer, Readability */
(function installQwenReader() {
  "use strict";

  if (document.getElementById("qwen-reader-host")) return;

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
  if (!Text || !Extractors || !SourceLocator || !SentenceRange || !MarkerPlacement || !Follow || !VoiceAssignment || !Player) {
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
  stylesheet.addEventListener("error", () => {
    console.error("Qwen Reader: failed to load the reader stylesheet.");
    host.remove();
  }, { once: true });
  shadow.append(stylesheet);

  const logoUrl = chrome.runtime.getURL("assets/qwen-reader-128.png");
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
    <button class="qr-orb" type="button" data-role="floating-orb" data-action="toggle-panel" aria-label="打开 Qwen 网页朗读">
      <img class="qr-orb-logo" src="${logoUrl}" alt="" aria-hidden="true">
    </button>
    <aside class="qr-panel" aria-label="Qwen 网页朗读侧栏">
      <div class="qr-resize-handle" data-role="panel-resize" role="separator" aria-label="拖动调整侧栏宽度" aria-orientation="vertical"></div>
      <div class="qr-panel-inner">
        <header class="qr-header">
          <div>
            <h2 class="qr-brand">Qwen 网页朗读</h2>
            <div class="qr-status" data-role="service-status">
              <span class="qr-status-dot" aria-hidden="true"></span>
              <span data-role="service-label">检查本地服务…</span>
            </div>
          </div>
          <button class="qr-icon-button" type="button" data-action="close-panel" aria-label="关闭侧栏"><img class="qr-icon" src="${iconUrls.close}" alt=""></button>
        </header>
        <nav class="qr-tabs" role="tablist" aria-label="朗读功能">
          <button class="qr-tab" type="button" role="tab" aria-selected="true" data-tab="now">正在朗读</button>
          <button class="qr-tab" type="button" role="tab" aria-selected="false" data-tab="authors">作者配音</button>
          <button class="qr-tab" type="button" role="tab" aria-selected="false" data-tab="voices">音色库</button>
        </nav>
        <div class="qr-content">
          <section class="qr-view is-active" data-view="now"></section>
          <section class="qr-view" data-view="authors"></section>
          <section class="qr-view" data-view="voices"></section>
        </div>
      </div>
    </aside>
    <div class="qr-reading-marker" data-role="reading-marker" role="group" aria-label="当前句音色与朗读控制"></div>
    <button class="qr-follow-chip" type="button" data-action="resume-follow" aria-label="回到当前朗读位置">
      <span class="qr-follow-chip-dot" aria-hidden="true"></span>
      回到朗读位置
    </button>
    <div class="qr-toast" role="status" aria-live="polite"></div>
  `;
  shadow.append(shell);

  const pageStyle = document.createElement("style");
  pageStyle.id = "qwen-reader-page-style";
  pageStyle.textContent = `
    ::highlight(qwen-reader-current) {
      color: inherit;
      text-shadow:
        0 0 1px rgba(100, 74, 220, .9),
        0 0 5px rgba(100, 74, 220, .62),
        0 0 13px rgba(91, 102, 226, .38),
        0 0 24px rgba(55, 151, 232, .2);
      animation: qwen-reader-text-bloom 1.1s cubic-bezier(.2, .72, .2, 1) 1 forwards;
    }
    .qwen-reader-speaking {
      background: transparent !important;
      box-shadow: none !important;
      outline: 0 !important;
      text-shadow:
        0 0 1px rgba(100, 74, 220, .9),
        0 0 5px rgba(100, 74, 220, .62),
        0 0 13px rgba(91, 102, 226, .38),
        0 0 24px rgba(55, 151, 232, .2) !important;
      animation: qwen-reader-text-bloom 1.1s cubic-bezier(.2, .72, .2, 1) 1 forwards !important;
    }
    @keyframes qwen-reader-text-bloom {
      0% {
        text-shadow:
          0 0 1px rgba(100, 74, 220, .46),
          0 0 2px rgba(100, 74, 220, .24),
          0 0 5px rgba(91, 102, 226, .12),
          0 0 9px rgba(55, 151, 232, .06);
      }
      42% {
        text-shadow:
          0 0 2px rgba(115, 86, 236, .82),
          0 0 8px rgba(100, 74, 220, .58),
          0 0 20px rgba(91, 102, 226, .36),
          0 0 36px rgba(55, 151, 232, .2);
      }
      100% {
        text-shadow:
          0 0 1px rgba(100, 74, 220, .68),
          0 0 5px rgba(100, 74, 220, .4),
          0 0 13px rgba(91, 102, 226, .24),
          0 0 24px rgba(55, 151, 232, .12);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      ::highlight(qwen-reader-current),
      .qwen-reader-speaking {
        animation: none !important;
      }
    }
  `;
  (document.head || document.documentElement).appendChild(pageStyle);

  let state = Player.createInitialState();
  let settings = Object.assign({}, DEFAULT_SETTINGS, {
    replyVoices: (DEFAULT_SETTINGS.replyVoices || []).slice(),
    panelWidth: clampPanelWidth(DEFAULT_SETTINGS.panelWidth || 376),
    clickToRead: DEFAULT_SETTINGS.clickToRead !== false,
    orbEdge: DEFAULT_SETTINGS.orbEdge === "left" ? "left" : "right",
    orbY: clampUnit(DEFAULT_SETTINGS.orbY, 0.82),
    interactionVersion: 2,
  });
  let knownVoices = unique([
    settings.opVoice,
    ...(settings.replyVoices || []),
  ]).filter(Boolean);
  let currentAudio = null;
  let activeSession = "";
  let activeStreamRequest = "";
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
  let sourceIndicesByElement = new WeakMap();
  let sentenceRanges = new Map();
  let sentenceRangeOffsets = new Map();
  let indexedSegments = null;
  let lastScrolledLocatorKey = "";
  let toastTimer = null;
  let orbDrag = null;
  let suppressOrbClick = false;

  bindEvents();
  render();
  void initialize();

  async function initialize() {
    await restoreSettings();
    startLocationWatcher();
    await scanCurrentPage("initial");
    void checkService();
  }

  function bindEvents() {
    shadow.addEventListener("click", async (event) => {
      if (!event.isTrusted && !TEST_MODE) return;
      const button = event.target.closest("button");
      if (!button) return;
      const action = button.dataset.action;
      if (action === "toggle-panel") {
        if (suppressOrbClick) {
          suppressOrbClick = false;
          event.preventDefault();
          return;
        }
        state = Player.reduce(state, { type: "PANEL_TOGGLE" });
        renderShell();
      } else if (action === "close-panel") {
        state = Player.reduce(state, { type: "PANEL_CLOSE" });
        renderShell();
      } else if (action === "play-toggle") {
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
      } else if (action === "open-studio") {
        const response = await chrome.runtime.sendMessage({
          type: "voice:studio:open",
        });
        if (!response || !response.ok) {
          window.open(chrome.runtime.getURL("voice-studio.html"), "_blank");
        }
      } else if (button.dataset.index != null) {
        await seek(Number(button.dataset.index));
      } else if (button.dataset.tab) {
        state = Player.reduce(state, {
          type: "TAB_SELECT",
          tab: button.dataset.tab,
        });
        renderShell();
        if (button.dataset.tab === "voices") await loadVoices();
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

    let resizePointerId = null;
    shadow.addEventListener("pointerdown", (event) => {
      const orb = event.target.closest('[data-role="floating-orb"]');
      if (orb && (event.isTrusted || TEST_MODE) && (event.button == null || event.button === 0)) {
        const rect = orb.getBoundingClientRect();
        orbDrag = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          centerOffsetX: event.clientX - (rect.left + rect.width / 2),
          centerOffsetY: event.clientY - (rect.top + rect.height / 2),
          moved: false,
        };
        try { orb.setPointerCapture?.(event.pointerId); } catch (_) {}
        event.preventDefault();
        return;
      }
      const handle = event.target.closest('[data-role="panel-resize"]');
      if (!handle || (!event.isTrusted && !TEST_MODE)) return;
      resizePointerId = event.pointerId;
      handle.setPointerCapture?.(event.pointerId);
      host.classList.add("is-resizing");
      event.preventDefault();
    });
    shadow.addEventListener("pointermove", (event) => {
      if (orbDrag && event.pointerId === orbDrag.pointerId) {
        const orb = shadow.querySelector('[data-role="floating-orb"]');
        const dx = event.clientX - orbDrag.startX;
        const dy = event.clientY - orbDrag.startY;
        if (!orbDrag.moved && Math.hypot(dx, dy) >= 5) {
          orbDrag.moved = true;
          orb.classList.add("is-dragging");
        }
        if (orbDrag.moved) {
          const size = orb.offsetWidth || 34;
          const padding = 8;
          const centerX = event.clientX - orbDrag.centerOffsetX;
          const centerY = event.clientY - orbDrag.centerOffsetY;
          orb.style.left = `${Math.round(Math.max(padding, Math.min(window.innerWidth - size - padding, centerX - size / 2)))}px`;
          orb.style.top = `${Math.round(Math.max(padding, Math.min(window.innerHeight - size - padding, centerY - size / 2)))}px`;
          orb.style.right = "auto";
          orb.style.bottom = "auto";
        }
        event.preventDefault();
        return;
      }
      if (resizePointerId == null || event.pointerId !== resizePointerId) return;
      settings.panelWidth = clampPanelWidth(window.innerWidth - event.clientX - 14);
      applyPanelWidth();
    });
    async function finishOrbDrag(event) {
      if (!orbDrag || event.pointerId !== orbDrag.pointerId) return false;
      const drag = orbDrag;
      orbDrag = null;
      const orb = shadow.querySelector('[data-role="floating-orb"]');
      orb.classList.remove("is-dragging");
      if (!drag.moved) return true;
      suppressOrbClick = true;
      const rect = orb.getBoundingClientRect();
      settings.orbEdge = rect.left + rect.width / 2 < window.innerWidth / 2 ? "left" : "right";
      const padding = 12;
      const available = Math.max(1, window.innerHeight - rect.height - padding * 2);
      settings.orbY = clampUnit((rect.top - padding) / available, settings.orbY);
      applyOrbPosition();
      await saveSettings();
      window.setTimeout(() => { suppressOrbClick = false; }, 120);
      return true;
    }
    const finishResize = async (event) => {
      if (await finishOrbDrag(event)) return;
      if (resizePointerId == null || event.pointerId !== resizePointerId) return;
      resizePointerId = null;
      host.classList.remove("is-resizing");
      await saveSettings();
    };
    shadow.addEventListener("pointerup", finishResize);
    shadow.addEventListener("pointercancel", finishResize);

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
    window.addEventListener("resize", () => {
      applyOrbPosition();
      scheduleOverlayUpdate();
    }, { passive: true });
    document.addEventListener("pointermove", handlePagePointerMove, { capture: true, passive: true });
    document.addEventListener("pointerleave", clearHoveredSegment, true);
    document.addEventListener("click", handlePageClick, true);

    const readingMarker = shadow.querySelector('[data-role="reading-marker"]');
    readingMarker.addEventListener("pointerenter", () => clearTimeout(hoverHideTimer));
    readingMarker.addEventListener("pointerleave", () => {
      if (!isPlaybackActive()) scheduleHoverHide();
    });

    chrome.runtime.onMessage.addListener((message) => {
      if (message && message.type === "ui:toggle") {
        state = Player.reduce(state, { type: "PANEL_TOGGLE" });
        renderShell();
        return;
      }
      if (message && message.type === "tts:stream:event") handleStreamEvent(message);
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
    next.panelWidth = clampPanelWidth(next.panelWidth);
    next.orbEdge = next.orbEdge === "left" ? "left" : "right";
    next.orbY = clampUnit(next.orbY, DEFAULT_SETTINGS.orbY || 0.82);
    next.clickToRead = Number(value.interactionVersion || 0) < 2
      ? true
      : Boolean(next.clickToRead);
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

  function clampPanelWidth(value) {
    const viewportLimit = Math.max(300, Math.min(640, (window.innerWidth || 1024) - 48));
    const width = Number.isFinite(Number(value)) ? Math.round(Number(value)) : 376;
    return Math.max(300, Math.min(viewportLimit, width));
  }

  function applyPanelWidth() {
    settings.panelWidth = clampPanelWidth(settings.panelWidth);
    host.style.setProperty("--qr-panel-width", `${settings.panelWidth}px`);
  }

  function clampUnit(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : fallback;
  }

  function applyOrbPosition() {
    const orb = shadow.querySelector('[data-role="floating-orb"]');
    if (!orb || (orbDrag && orbDrag.moved)) return;
    const size = orb.offsetHeight || 34;
    const padding = 12;
    const available = Math.max(1, window.innerHeight - size - padding * 2);
    orb.style.top = `${Math.round(padding + clampUnit(settings.orbY, 0.82) * available)}px`;
    orb.style.bottom = "auto";
    const panelOffset = state.panelOpen && window.innerWidth > 700
      ? settings.panelWidth + 20
      : padding;
    if (settings.orbEdge === "left") {
      orb.style.left = `${padding}px`;
      orb.style.right = "auto";
    } else {
      orb.style.left = "auto";
      orb.style.right = `${panelOffset}px`;
    }
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

  async function checkService() {
    try {
      const response = await chrome.runtime.sendMessage({ type: "tts:status" });
      if (!response || !response.ok) throw response && response.error;
      const backend = response.status && response.status.backend;
      setServiceStatus(
        backend === "loaded" ? "模型已加载 · Vulkan" : "网关在线 · 模型休眠",
        "ready",
      );
    } catch (_) {
      setServiceStatus("本地服务未运行", "error");
    }
  }

  function setServiceStatus(label, kind) {
    const status = shadow.querySelector('[data-role="service-status"]');
    const text = shadow.querySelector('[data-role="service-label"]');
    if (!status || !text) return;
    status.className = `qr-status is-${kind}`;
    text.textContent = label;
  }

  async function loadVoices() {
    setServiceStatus("正在加载音色库…", "online");
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
      setServiceStatus("模型已加载 · Vulkan", "ready");
      renderAuthors();
      renderVoices(response.voices || []);
    } catch (error) {
      setServiceStatus("音色库加载失败", "error");
      renderVoices([], error.message);
    }
  }

  async function togglePlayback() {
    if (state.status === "playing") {
      if (currentAudio) currentAudio.pause();
      state = Player.reduce(state, { type: "PAUSE" });
      render();
      return;
    }
    if (state.status === "paused" && currentAudio) {
      await currentAudio.play();
      state = Player.reduce(state, { type: "RESUME" });
      render();
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

  async function refreshCurrentPage() {
    dynamicResumeIndex = null;
    stopPlayback();
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
        type: "LOAD_SUCCESS",
        scanId,
        document: normalized,
        segments: assigned,
        index: resumeIndex,
      });
      invalidateSourceIndex();
      ensureSourceIndex();
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
    if (message.playbackId && String(message.playbackId) !== String(activeSession)) return false;
    if (activeStreamRequest && message.requestId && String(message.requestId) !== String(activeStreamRequest)) {
      return false;
    }
    return true;
  }

  function finishStreamPlayback() {
    activeStreamRequest = "";
    const nextIndex = findNextSpeakableIndex(state.segments, state.index + 1);
    if (nextIndex >= 0) {
      void playIndex(nextIndex);
      return;
    }
    if (dynamicScanPending) dynamicResumeIndex = state.segments.length;
    activeSession = "";
    state = Player.reduce(state, { type: "STOP" });
    hoveredSegmentIndex = -1;
    render();
    clearHighlight();
    flushPendingDynamicScan();
  }

  function handleStreamEvent(message) {
    if (!isCurrentStreamEvent(message)) return;
    const event = String(message.event || "");
    if (event === "started") {
      activeStreamRequest = String(message.requestId || activeSession);
      state = Player.reduce(state, {
        type: "AUDIO_PLAYING",
        sessionId: activeSession,
        prefetchedIndex: state.prefetchedIndex,
      });
      render();
      return;
    }
    if (event === "ended") {
      finishStreamPlayback();
      return;
    }
    if (event === "error") {
      const detail = message.error || {};
      if (detail.code === "cancelled" || !activeSession) return;
      activeStreamRequest = "";
      state = Player.reduce(state, {
        type: "ERROR",
        message: detail.message || "流式音频播放失败，请重试。",
      });
      setServiceStatus("合成失败", "error");
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
    const playbackId = playbackGate.begin();
    const pageKey = state.pageKey;
    const segment = Object.assign({}, state.segments[index]);
    let prefetched = null;
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
    state = Player.reduce(state, { type: "SEEK", index });
    const sessionId =
      (prefetched && prefetched.sessionId) ||
      nextIdentity("playback");
    activeSession = sessionId;
    activeStreamRequest = "";
    state = Player.reduce(state, {
      type: "AUDIO_LOADING",
      sessionId,
    });
    render();
    highlightCurrent();

    try {
      const audioResult = await Player.resolveAudioRequest(
        prefetched,
        () => synthesizeSegment(segment, sessionId, { stream: true }),
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
        state = Player.reduce(state, {
          type: "AUDIO_PLAYING",
          sessionId,
          prefetchedIndex: findNextSpeakableIndex(state.segments, index + 1),
        });
        render();
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
      const audio = new Audio(
        `data:${audioResult.mimeType || "audio/wav"};base64,${audioResult.audioBase64}`,
      );
      currentAudio = audio;
      audio.addEventListener("ended", () => {
        if (!playbackGate.isCurrent(playbackId) || currentAudio !== audio) return;
        const nextIndex = findNextSpeakableIndex(state.segments, state.index + 1);
        if (nextIndex >= 0) {
          void playIndex(nextIndex);
        } else {
          if (dynamicScanPending) dynamicResumeIndex = state.segments.length;
          state = Player.reduce(state, { type: "STOP" });
          hoveredSegmentIndex = -1;
          render();
          clearHighlight();
          flushPendingDynamicScan();
        }
      });
      audio.addEventListener("error", () => {
        if (!playbackGate.isCurrent(playbackId) || currentAudio !== audio) return;
        state = Player.reduce(state, {
          type: "ERROR",
          message: "音频无法播放，请重新加载扩展后重试。",
        });
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
      state = Player.reduce(state, {
        type: "ERROR",
        message:
          (error && error.message) ||
          "本地 Qwen 合成失败，请检查托盘服务。",
      });
      setServiceStatus("合成失败", "error");
      hoveredSegmentIndex = -1;
      clearHighlight();
      render();
      flushPendingDynamicScan();
    }
  }

  async function synthesizeSegment(segment, sessionId, options) {
    const synthOptions = options || {};
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
      stream: synthOptions.stream === true,
      request: {
        input: speechText,
        voice: segment.voice,
        model: Defaults.model || "qwen3-tts-1.7b-base",
        response_format: Defaults.responseFormat || "wav",
        requestId: sessionId,
        playbackId: sessionId,
        sessionId,
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
    sourceIndicesByElement = new WeakMap();
    sentenceRanges = new Map();
    sentenceRangeOffsets = new Map();
  }

  function ensureSourceIndex() {
    const mappingsAreFresh = indexedSegments === state.segments && sourceElements.every(
      (element) => !element || element.isConnected !== false,
    );
    if (mappingsAreFresh) return;
    indexedSegments = state.segments;
    sourceElements = [];
    sourceIndicesByElement = new WeakMap();
    sentenceRanges = new Map();
    sentenceRangeOffsets = new Map();
    const elementByKey = new Map();
    state.segments.forEach((segment, index) => {
      const key = sourceLocatorKey(segment);
      let element = key && elementByKey.get(key);
      if (!element) {
        element = resolveRawSegmentElement(segment);
        if (element && key) elementByKey.set(key, element);
      }
      sourceElements[index] = element || null;
      if (!element) return;
      const indices = sourceIndicesByElement.get(element) || [];
      indices.push(index);
      sourceIndicesByElement.set(element, indices);
    });
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
    ensureSourceIndex();
    if (sentenceRanges.has(index)) return sentenceRanges.get(index);
    const element = sourceElements[index];
    if (!element) {
      sentenceRanges.set(index, null);
      return null;
    }
    const indices = sourceIndicesByElement.get(element) || [index];
    const textIndex = SentenceRange.buildTextIndex(element);
    let cursor = 0;
    for (const candidateIndex of indices) {
      if (sentenceRanges.has(candidateIndex)) {
        const cached = sentenceRanges.get(candidateIndex);
        if (sentenceRangeOffsets.has(candidateIndex)) cursor = sentenceRangeOffsets.get(candidateIndex);
        if (candidateIndex === index) return cached;
        continue;
      }
      const candidate = state.segments[candidateIndex];
      let match = SentenceRange.findSegment(textIndex, candidate && candidate.text, cursor);
      if (!match && cursor > 0) match = SentenceRange.findSegment(textIndex, candidate && candidate.text, 0);
      const range = match ? createDocumentRange(match) : null;
      if (range && match) {
        sentenceRangeOffsets.set(candidateIndex, match.nextOffset);
        cursor = match.nextOffset;
      }
      sentenceRanges.set(candidateIndex, range);
      if (candidateIndex === index) return range;
    }
    sentenceRanges.set(index, null);
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

  function getSegmentRects(index) {
    const range = getSegmentRange(index);
    if (range && typeof range.getClientRects === "function") {
      const rects = Array.from(range.getClientRects()).filter((rect) =>
        Number.isFinite(rect.left) && Number.isFinite(rect.top) && rect.width > .5 && rect.height > .5
      );
      if (rects.length) return rects;
    }
    ensureSourceIndex();
    const element = sourceElements[index];
    if (!element || typeof element.getBoundingClientRect !== "function") return [];
    const rect = element.getBoundingClientRect();
    return rect && rect.width > .5 && rect.height > .5 ? [rect] : [];
  }

  function highlightCurrent(options) {
    const followOptions = options || {};
    const segment = state.current;
    if (!segment) {
      clearHighlight();
      return;
    }
    ensureSourceIndex();
    const index = state.index;
    const element = sourceElements[index];
    if (!element) {
      clearHighlight();
      return;
    }
    const range = getSegmentRange(index);
    clearElementFallback();
    clearNativeHighlight();
    highlightedElement = element;
    highlightedRange = range;
    highlightedIndex = index;
    if (!installNativeHighlight(range)) element.classList.add("qwen-reader-speaking");
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
  }

  function installNativeHighlight(range) {
    if (
      !range ||
      !globalThis.CSS ||
      !globalThis.CSS.highlights ||
      typeof globalThis.Highlight !== "function"
    ) return false;
    try {
      globalThis.CSS.highlights.set("qwen-reader-current", new globalThis.Highlight(range));
      return true;
    } catch (_) {
      return false;
    }
  }

  function clearNativeHighlight() {
    try {
      if (globalThis.CSS && globalThis.CSS.highlights) {
        globalThis.CSS.highlights.delete("qwen-reader-current");
      }
    } catch (_) {}
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
    ensureSourceIndex();
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
    clearElementFallback();
    clearNativeHighlight();
    highlightedElement = null;
    highlightedRange = null;
    highlightedIndex = -1;
    renderReadingMarker();
  }

  function render() {
    renderShell();
    renderNow();
    renderAuthors();
    renderVoices();
    renderReadingMarker();
  }

  function renderShell() {
    const panel = shadow.querySelector(".qr-panel");
    const orb = shadow.querySelector(".qr-orb");
    applyPanelWidth();
    panel.classList.toggle("is-open", state.panelOpen);
    orb.classList.toggle("is-shifted", state.panelOpen);
    orb.classList.toggle("is-reading", ["playing", "loading"].includes(state.status));
    orb.classList.toggle("is-paused", state.status === "paused");
    applyOrbPosition();
    orb.setAttribute(
      "aria-label",
      state.panelOpen ? "收起 Qwen 网页朗读" : "打开 Qwen 网页朗读",
    );
    shadow.querySelectorAll('[role="tab"]').forEach((tab) => {
      tab.setAttribute("aria-selected", String(tab.dataset.tab === state.tab));
    });
    shadow.querySelectorAll(".qr-view").forEach((view) => {
      view.classList.toggle("is-active", view.dataset.view === state.tab);
    });
  }

  function renderNow() {
    const view = shadow.querySelector('[data-view="now"]');
    const current = state.current;
    const total = state.segments.length;
    const progress = total ? ((state.index + 1) / total) * 100 : 0;
    const isBusy = ["extracting", "loading"].includes(state.status);
    const isPlaying = state.status === "playing";
    const isScanning = state.status === "extracting";
    const scanLabel = isScanning
      ? "正在读取…"
      : state.document
        ? "重新读取"
        : "读取本页";
    const adapterLabel =
      state.document && (state.document.adapter || state.document.adapterId);
    const mainIcon = `<img class="qr-icon qr-main-icon" src="${isPlaying ? iconUrls.pause : iconUrls.play}" alt="">`;
    const mainLabel = isPlaying ? "暂停" : state.status === "paused" ? "继续" : "播放";
    const queue = state.segments.slice(0, 40).map((segment, index) => `
      <button class="qr-queue-item ${index === state.index ? "is-current" : ""}" type="button" data-index="${index}">
        <span class="qr-mini-avatar">${escapeHtml(initials(segment.authorName || (segment.isOp ? "楼主" : "文")))}</span>
        <span class="qr-queue-copy">
          <span class="qr-queue-name">${escapeHtml(segment.authorName || (segment.isOp ? "楼主" : "正文"))}</span>
          <span class="qr-queue-text">第 ${escapeHtml(index + 1)} 句${segment.floor ? ` · ${escapeHtml(segment.floor)} 楼` : ""} · ${escapeHtml(segment.text)}</span>
        </span>
        <span class="qr-voice-badge">${escapeHtml(segment.voice || "未分配")}</span>
      </button>
    `).join("");

    view.innerHTML = `
      <p class="qr-kicker">当前主题 · ${total ? `第 ${state.index + 1} / ${total} 句` : "等待识别"}</p>
      <h3 class="qr-title">${escapeHtml(cleanTitle(document.title))}</h3>
      <div class="qr-scan-row">
        <span class="qr-scan-summary">${total ? `已识别 ${total} 句${adapterLabel ? ` · ${escapeHtml(adapterLabel)}` : ""}` : isScanning ? "正在分析正文和作者…" : "自动识别未得到结果"}</span>
        <button class="qr-primary qr-scan-button" type="button" data-action="scan-page" ${isScanning ? "disabled" : ""}>${scanLabel}</button>
      </div>
      ${state.status === "error" ? `<div class="qr-error">${escapeHtml(state.error)}</div>` : ""}
      <div class="qr-speaker">
        <span class="qr-avatar ${current && !current.isOp ? "is-reply" : ""}">${escapeHtml(initials(current && current.authorName || "Q"))}</span>
        <span class="qr-speaker-meta">
          <span class="qr-speaker-name">${escapeHtml(current && current.authorName || "尚未开始")}</span>
          <span class="qr-speaker-voice">${escapeHtml(current && current.voice || (isScanning ? "正在识别正文" : "识别完成后可播放"))}</span>
        </span>
        ${current && current.isOp ? '<span class="qr-op-badge">楼主</span>' : ""}
      </div>
      <div class="qr-reading-box"><strong>${isBusy ? "正在准备：" : "当前句："}</strong> ${escapeHtml(current && current.text || "页面会自动识别，但不会自动发声。")}</div>
      <div class="qr-progress" aria-label="朗读进度"><span style="width:${progress}%"></span></div>
      <div class="qr-progress-labels"><span>${total ? state.index + 1 : 0}</span><span>${total}</span></div>
      <div class="qr-controls">
        <button class="qr-control" type="button" data-action="previous" aria-label="上一句" ${!total || isBusy ? "disabled" : ""}><img class="qr-icon qr-skip-image" src="${iconUrls.previous}" alt=""></button>
        <button class="qr-control is-main" type="button" data-action="play-toggle" aria-label="${mainLabel}" ${isBusy || !total ? "disabled" : ""}>${mainIcon}</button>
        <button class="qr-control" type="button" data-action="next" aria-label="下一句" ${!total || isBusy ? "disabled" : ""}><img class="qr-icon qr-skip-image" src="${iconUrls.next}" alt=""></button>
      </div>
      <div class="qr-section">
        <div class="qr-section-head">
          <h4 class="qr-section-title">朗读预设</h4>
          <select class="qr-select" data-setting="preset" aria-label="朗读预设">
            <option value="op-exclusive" ${settings.preset === "op-exclusive" ? "selected" : ""}>楼主专属</option>
            <option value="stable-author" ${settings.preset === "stable-author" ? "selected" : ""}>作者稳定</option>
            <option value="round-robin" ${settings.preset === "round-robin" ? "selected" : ""}>顺序轮换</option>
          </select>
        </div>
        <label class="qr-toggle-row">
          <span><strong>网页点读</strong><small>点击正文，从对应句子开始朗读</small></span>
          <span class="qr-switch-control">
            <input type="checkbox" role="switch" data-setting="clickToRead" aria-label="网页点读" ${settings.clickToRead ? "checked" : ""}>
            <span class="qr-switch-track" aria-hidden="true"></span>
          </span>
        </label>
      </div>
      <div class="qr-section">
        <div class="qr-section-head"><h4 class="qr-section-title">即将朗读</h4><button class="qr-icon-button" type="button" data-action="stop" aria-label="停止朗读"><img class="qr-icon" src="${iconUrls.stop}" alt=""></button></div>
        <div class="qr-queue">${queue || '<div class="qr-empty">识别完成后会显示作者、楼层与分配音色</div>'}</div>
      </div>
    `;
  }

  function renderAuthors() {
    const view = shadow.querySelector('[data-view="authors"]');
    const authors = [];
    const seen = new Set();
    state.segments.forEach((segment) => {
      const key = segment.authorId || segment.authorName || "article";
      if (!seen.has(key)) {
        seen.add(key);
        authors.push(segment);
      }
    });
    const voiceOptions = knownVoices.map((voice) =>
      `<option value="${escapeAttribute(voice)}" ${voice === settings.opVoice ? "selected" : ""}>${escapeHtml(voice)}</option>`
    ).join("");
    const replyOptions = knownVoices
      .filter((voice) => voice !== settings.opVoice)
      .map((voice) => `
        <label class="qr-list-card">
          <input type="checkbox" data-setting="replyVoice" value="${escapeAttribute(voice)}" ${settings.replyVoices.includes(voice) ? "checked" : ""}>
          <span class="qr-list-copy">
            <span class="qr-list-name">${escapeHtml(voice)}</span>
            <span class="qr-list-subtitle">用于非楼主发言</span>
          </span>
        </label>
      `).join("");
    const authorCards = authors.map((author) => `
      <div class="qr-list-card">
        <span class="qr-avatar ${author.isOp ? "" : "is-reply"}">${escapeHtml(initials(author.authorName || "文"))}</span>
        <span class="qr-list-copy">
          <span class="qr-list-name">${escapeHtml(author.authorName || "文章正文")}</span>
          <span class="qr-list-subtitle">${author.isOp ? "楼主专属" : "回复作者"} · ${escapeHtml(author.voice || "等待分配")}</span>
        </span>
        ${author.isOp ? '<span class="qr-op-badge">A</span>' : '<span class="qr-voice-badge">回复</span>'}
      </div>
    `).join("");
    view.innerHTML = `
      <p class="qr-kicker">音色分配</p>
      <h3 class="qr-title">楼主固定，其他作者轮换</h3>
      <div class="qr-form-row">
        <label for="qr-op-voice">楼主专属音色 A</label>
        <select id="qr-op-voice" class="qr-select" data-setting="opVoice">${voiceOptions}</select>
      </div>
      <p class="qr-help">A 只给楼主使用；其他作者不会占用楼主音色。</p>
      <div class="qr-form-row">
        <label>回复音色池 B / C / …</label>
        <div>${replyOptions || '<div class="qr-error">请先在音色库录制一个不同于楼主的音色。</div>'}</div>
      </div>
      <div class="qr-section">
        <div class="qr-section-head"><h4 class="qr-section-title">当前作者</h4><span class="qr-voice-badge">${authors.length} 人</span></div>
        <div class="qr-author-list">${authorCards || '<div class="qr-empty">开始朗读后显示作者映射</div>'}</div>
      </div>
    `;
  }

  function renderVoices(voices, errorMessage) {
    const view = shadow.querySelector('[data-view="voices"]');
    const list = Array.isArray(voices) && voices.length
      ? voices
      : knownVoices.map((name) => ({ name, kind: "configured" }));
    const cards = list.map((voice) => {
      const name = typeof voice === "string" ? voice : voice.name;
      const kind = typeof voice === "string" ? "registered" : voice.kind;
      return `
        <div class="qr-list-card">
          <span class="qr-avatar">${escapeHtml(initials(name))}</span>
          <span class="qr-list-copy">
            <span class="qr-list-name">${escapeHtml(name)}</span>
            <span class="qr-list-subtitle">${kind === "registered" ? "已注册到本地 Qwen" : "已配置"}</span>
          </span>
          <span class="qr-voice-badge">${name === settings.opVoice ? "楼主 A" : "可选"}</span>
        </div>
      `;
    }).join("");
    view.innerHTML = `
      <p class="qr-kicker">完全本地 · 不上传录音</p>
      <h3 class="qr-title">管理克隆音色</h3>
      ${errorMessage ? `<div class="qr-error">${escapeHtml(errorMessage)}</div>` : ""}
      <p class="qr-help">录制 5～15 秒干净人声，保存后即可加入楼主或回复音色池。切换音色不需要重启模型。</p>
      <button class="qr-primary" type="button" data-action="open-studio">＋ 录制新音色</button>
      <div class="qr-section">
        <div class="qr-section-head"><h4 class="qr-section-title">可用音色</h4><span class="qr-voice-badge">${list.length}</span></div>
        <div class="qr-voice-list">${cards || '<div class="qr-empty">还没有可用音色</div>'}</div>
      </div>
    `;
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
