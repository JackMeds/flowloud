/* global chrome, QwenReaderDefaults, QwenReaderText, QwenReaderDocument, QwenReaderExtractors, QwenReaderVoiceAssignment, QwenReaderPlayer, Readability */
(function installQwenReader() {
  "use strict";

  if (document.getElementById("qwen-reader-host")) return;

  const Defaults = globalThis.QwenReaderDefaults || {};
  const Text = globalThis.QwenReaderText;
  const DocumentModel = globalThis.QwenReaderDocument;
  const Extractors = globalThis.QwenReaderExtractors;
  const VoiceAssignment =
    globalThis.QwenReaderVoiceAssignment || globalThis.QwenReaderVoices;
  const Player = globalThis.QwenReaderPlayer;
  if (!Text || !Extractors || !VoiceAssignment || !Player) {
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
  };

  const host = document.createElement("div");
  host.id = "qwen-reader-host";
  document.documentElement.appendChild(host);
  const TEST_MODE = globalThis.__QWEN_READER_TEST__ === true;
  const shadow = host.attachShadow({ mode: "closed" });
  if (TEST_MODE) globalThis.__QWEN_READER_TEST_ROOT__ = shadow;
  const stylesheet = document.createElement("link");
  stylesheet.rel = "stylesheet";
  stylesheet.href = chrome.runtime.getURL("content/reader.css");
  shadow.append(stylesheet);

  const shell = document.createElement("div");
  shell.innerHTML = `
    <button class="qr-orb" type="button" data-action="toggle-panel" aria-label="打开 Qwen 网页朗读">
      <span class="qr-orb-mark" aria-hidden="true">Q</span>
    </button>
    <aside class="qr-panel" aria-label="Qwen 网页朗读侧栏">
      <div class="qr-panel-inner">
        <header class="qr-header">
          <div>
            <h2 class="qr-brand">Qwen 网页朗读</h2>
            <div class="qr-status" data-role="service-status">
              <span class="qr-status-dot" aria-hidden="true"></span>
              <span data-role="service-label">检查本地服务…</span>
            </div>
          </div>
          <button class="qr-icon-button" type="button" data-action="close-panel" aria-label="关闭侧栏">×</button>
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
    <div class="qr-toast" role="status" aria-live="polite"></div>
  `;
  shadow.append(shell);

  const pageStyle = document.createElement("style");
  pageStyle.id = "qwen-reader-page-style";
  pageStyle.textContent = `
    .qwen-reader-speaking {
      outline: 3px solid rgba(118, 87, 232, .48) !important;
      outline-offset: 5px !important;
      border-radius: 8px !important;
      transition: outline-color .2s ease !important;
    }
  `;
  (document.head || document.documentElement).appendChild(pageStyle);

  let state = Player.createInitialState();
  let settings = Object.assign({}, DEFAULT_SETTINGS, {
    replyVoices: (DEFAULT_SETTINGS.replyVoices || []).slice(),
  });
  let knownVoices = unique([
    settings.opVoice,
    ...(settings.replyVoices || []),
  ]).filter(Boolean);
  let currentAudio = null;
  let sessionCounter = 0;
  let activeSession = "";
  const playbackGate = Player.createInvocationGate();
  const clientId = createClientId();
  let scanCounter = 0;
  let activeScanController = null;
  let lastObservedPageKey = getCurrentPageKey();
  let routeTimer = null;
  let mutationTimer = null;
  let dynamicScanPending = false;
  let dynamicResumeIndex = null;
  const requestCache = Player.createRequestCache(cancelSessionById);
  let highlightedElement = null;
  let toastTimer = null;

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
        state = Player.reduce(state, { type: "PANEL_TOGGLE" });
        renderShell();
      } else if (action === "close-panel") {
        state = Player.reduce(state, { type: "PANEL_CLOSE" });
        renderShell();
      } else if (action === "play-toggle") {
        await togglePlayback();
      } else if (action === "scan-page") {
        await refreshCurrentPage();
      } else if (action === "next") {
        await move(1);
      } else if (action === "previous") {
        await move(-1);
      } else if (action === "stop") {
        await stopPlayback();
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
      if (control.dataset.setting === "preset") {
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

    chrome.runtime.onMessage.addListener((message) => {
      if (message && message.type === "ui:toggle") {
        state = Player.reduce(state, { type: "PANEL_TOGGLE" });
        renderShell();
      }
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
      if (adoptSettings(value)) render();
    } catch (error) {
      console.warn("Qwen Reader settings could not be restored", error);
    }
  }

  function adoptSettings(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const before = JSON.stringify(settings);
    const next = Object.assign({}, settings, value);
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

  async function playIndex(index) {
    if (!state.segments[index]) return;
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
      `qwen-reader-${Date.now()}-${++sessionCounter}`;
    activeSession = sessionId;
    state = Player.reduce(state, {
      type: "AUDIO_LOADING",
      sessionId,
    });
    render();
    highlightCurrent();

    try {
      const audioResult = await Player.resolveAudioRequest(
        prefetched,
        () => synthesizeSegment(segment, sessionId),
      );
      if (
        !playbackGate.isCurrent(playbackId) ||
        state.sessionId !== sessionId ||
        state.pageKey !== pageKey
      ) {
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
        const nextIndex = state.index + 1;
        if (nextIndex < state.segments.length) {
          void playIndex(nextIndex);
        } else {
          if (dynamicScanPending) dynamicResumeIndex = state.segments.length;
          state = Player.reduce(state, { type: "STOP" });
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
      state = Player.reduce(state, {
        type: "AUDIO_PLAYING",
        sessionId,
        prefetchedIndex:
          index + 1 < state.segments.length ? index + 1 : null,
      });
      render();
      if (index + 1 < state.segments.length) {
        const nextSegment = Object.assign({}, state.segments[index + 1]);
        const nextSession = `${sessionId}-prefetch-${index + 1}`;
        const pendingPrefetch = requestCache.prefetch(
          requestCacheKey(pageKey, index + 1),
          nextSession,
          () => synthesizeSegment(nextSegment, nextSession),
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
      render();
      flushPendingDynamicScan();
    }
  }

  async function synthesizeSegment(segment, sessionId) {
    const response = await chrome.runtime.sendMessage({
      type: "tts:synthesize",
      clientId,
      playbackId: sessionId,
      requestId: sessionId,
      sessionId,
      request: {
        input: segment.text,
        voice: segment.voice,
        model: Defaults.model || "qwen3-tts-1.7b-base",
        response_format: Defaults.responseFormat || "wav",
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

  function highlightCurrent() {
    clearHighlight();
    const segment = state.current;
    if (!segment) return;
    let element = null;
    if (segment.sourceSelector) {
      try {
        element = document.querySelector(segment.sourceSelector);
      } catch (_) {
        element = null;
      }
    }
    if (!element && segment.sourceKey && segment.sourceKey.startsWith("dom:")) {
      const index = Number(segment.sourceKey.split(":")[1]) - 1;
      element = document.querySelectorAll(".Post")[index] || null;
    } else if (!element && segment.sourceKey && segment.sourceKey.startsWith("generic:")) {
      const index = Number(segment.sourceKey.split(":")[1]);
      const blocks = document.querySelectorAll(
        "article p, article li, main p, main li, [role='main'] p, [role='main'] li",
      );
      element = blocks[index] || null;
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
    if (element) {
      highlightedElement = element;
      element.classList.add("qwen-reader-speaking");
      element.scrollIntoView({ behavior: "smooth", block: "center" });
    }
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
    ].join(","));
    for (const element of Array.from(candidates).slice(0, 2000)) {
      const candidate = Text.cleanText
        ? Text.cleanText(element.textContent)
        : String(element.textContent || "").trim();
      if (!candidate) continue;
      if (
        candidate === needle ||
        candidate.includes(needle) ||
        (needle.length > 24 && needle.includes(candidate))
      ) {
        return element;
      }
    }
    return null;
  }

  function clearHighlight() {
    if (highlightedElement) {
      highlightedElement.classList.remove("qwen-reader-speaking");
      highlightedElement = null;
    }
  }

  function render() {
    renderShell();
    renderNow();
    renderAuthors();
    renderVoices();
  }

  function renderShell() {
    const panel = shadow.querySelector(".qr-panel");
    const orb = shadow.querySelector(".qr-orb");
    panel.classList.toggle("is-open", state.panelOpen);
    orb.classList.toggle("is-shifted", state.panelOpen);
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
    const mainIcon = isPlaying
      ? '<span class="qr-pause-icon" aria-hidden="true"></span>'
      : '<span class="qr-play-icon" aria-hidden="true"></span>';
    const mainLabel = isPlaying ? "暂停" : state.status === "paused" ? "继续" : "播放";
    const queue = state.segments.slice(0, 40).map((segment, index) => `
      <button class="qr-queue-item ${index === state.index ? "is-current" : ""}" type="button" data-index="${index}">
        <span class="qr-mini-avatar">${escapeHtml(initials(segment.authorName || (segment.isOp ? "楼主" : "文")))}</span>
        <span class="qr-queue-copy">
          <span class="qr-queue-name">${escapeHtml(segment.authorName || (segment.isOp ? "楼主" : "正文"))}</span>
          <span class="qr-queue-text">第 ${escapeHtml(segment.floor || index + 1)} 段 · ${escapeHtml(segment.text)}</span>
        </span>
        <span class="qr-voice-badge">${escapeHtml(segment.voice || "未分配")}</span>
      </button>
    `).join("");

    view.innerHTML = `
      <p class="qr-kicker">当前主题 · ${total ? `第 ${state.index + 1} / ${total} 段` : "等待识别"}</p>
      <h3 class="qr-title">${escapeHtml(cleanTitle(document.title))}</h3>
      <div class="qr-scan-row">
        <span class="qr-scan-summary">${total ? `已识别 ${total} 段${adapterLabel ? ` · ${escapeHtml(adapterLabel)}` : ""}` : isScanning ? "正在分析正文和作者…" : "自动识别未得到结果"}</span>
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
        <button class="qr-control" type="button" data-action="previous" aria-label="上一段" ${!total || isBusy ? "disabled" : ""}><span class="qr-skip-icon is-back" aria-hidden="true"></span></button>
        <button class="qr-control is-main" type="button" data-action="play-toggle" aria-label="${mainLabel}" ${isBusy || !total ? "disabled" : ""}>${mainIcon}</button>
        <button class="qr-control" type="button" data-action="next" aria-label="下一段" ${!total || isBusy ? "disabled" : ""}><span class="qr-skip-icon is-forward" aria-hidden="true"></span></button>
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
      </div>
      <div class="qr-section">
        <div class="qr-section-head"><h4 class="qr-section-title">即将朗读</h4><button class="qr-icon-button" type="button" data-action="stop" aria-label="停止朗读">■</button></div>
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

  function createClientId() {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
      return `qwen-reader-${globalThis.crypto.randomUUID()}`;
    }
    return `qwen-reader-${Date.now()}-${Math.random().toString(16).slice(2)}`;
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
