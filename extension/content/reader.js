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
    <section class="qr-mini-player" aria-label="Qwen 网页朗读控制" aria-hidden="true">
      <div class="qr-mini-context">
        <span class="qr-mini-avatar" data-role="speaker-avatar" aria-hidden="true">Q</span>
        <span class="qr-mini-copy">
          <span class="qr-mini-speaker" data-role="speaker-name">正在准备朗读</span>
          <span class="qr-mini-meta" data-role="speaker-meta">当前网页</span>
          <span class="qr-mini-text" data-role="segment-text"></span>
        </span>
      </div>
      <div class="qr-mini-controls" aria-label="朗读控制">
        <button class="qr-mini-button" type="button" data-action="previous" aria-label="上一段">
          <span class="qr-skip-icon is-back" aria-hidden="true"></span>
        </button>
        <button class="qr-mini-button is-primary" type="button" data-action="play-toggle" aria-label="暂停朗读">
          <span class="qr-pause-icon" aria-hidden="true"></span>
        </button>
        <button class="qr-mini-button" type="button" data-action="next" aria-label="下一段">
          <span class="qr-skip-icon is-forward" aria-hidden="true"></span>
        </button>
        <button class="qr-mini-button is-stop" type="button" data-action="stop" aria-label="停止朗读并关闭控制条">×</button>
      </div>
    </section>
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
      background-image: linear-gradient(100deg, rgba(118, 87, 232, .13), rgba(164, 126, 248, .05), rgba(118, 87, 232, .13)) !important;
      background-size: 220% 100% !important;
      box-shadow: 0 0 0 5px rgba(118, 87, 232, .08) !important;
      animation: qwen-reader-speaking-flow 2.2s ease-in-out infinite !important;
    }
    @keyframes qwen-reader-speaking-flow {
      0%, 100% { background-position: 100% 50%; }
      50% { background-position: 0 50%; }
    }
    @media (prefers-reduced-motion: reduce) {
      .qwen-reader-speaking { animation: none !important; }
    }
  `;
  (document.head || document.documentElement).appendChild(pageStyle);

  let state = Player.createInitialState();
  let settings = Object.assign({}, DEFAULT_SETTINGS, {
    replyVoices: (DEFAULT_SETTINGS.replyVoices || []).slice(),
  });
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
  let pageAuthorVoices = {};
  let stateRevision = 0;
  let playbackRate = 1;

  bindEvents();
  render();
  void initialize();

  async function initialize() {
    await restoreSettings();
    startLocationWatcher();
    await scanCurrentPage("initial");
  }

  function bindEvents() {
    shadow.addEventListener("click", async (event) => {
      if (!event.isTrusted && !TEST_MODE) return;
      const button = event.target.closest("button");
      if (!button) return;
      const action = button.dataset.action;
      if (["play-toggle", "next", "previous", "stop"].includes(action)) {
        const response = await runReaderCommand({
          type: "reader:command",
          command: action,
          pageKey: state.pageKey || getCurrentPageKey(),
        });
        if (!response.ok && response.error === "page_context_mismatch") {
          showToast("网页已发生变化，请重新打开扩展弹窗后再操作。");
        }
      }
    });

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!message || typeof message.type !== "string") return undefined;
      const type = message.type;
      if (
        type !== "reader:snapshot:get" &&
        type !== "reader:command" &&
        type !== "reader:page-context:get" &&
        type !== "reader:page-context:apply"
      ) {
        return undefined;
      }
      const respond = (response) => {
        if (typeof sendResponse === "function") sendResponse(response);
      };
      Promise.resolve(handleReaderMessage(message)).then(respond, (error) => {
        respond({
          ok: false,
          error: {
            code: "reader_command_failed",
            message: (error && error.message) || "网页朗读操作失败。",
          },
        });
      });
      return true;
    });

    if (chrome.storage.onChanged && typeof chrome.storage.onChanged.addListener === "function") {
      chrome.storage.onChanged.addListener((changes, areaName) => {
        const change = changes && changes[SETTINGS_KEY];
        if (areaName !== "local") return;
        const settingsChanged = Boolean(change && adoptSettings(change.newValue));
        if (!settingsChanged) return;
        void (async () => {
          await stopPlayback();
          reassignCurrentSegments();
        })();
      });
    }
  }

  async function handleReaderMessage(message) {
    switch (message.type) {
      case "reader:snapshot:get":
        return { ok: true, snapshot: getReaderSnapshot() };
      case "reader:command":
        return runReaderCommand(message);
      case "reader:page-context:get":
        return { ok: true, pageContext: getPageContext() };
      case "reader:page-context:apply":
        return applyPageContext(message);
      default:
        return {
          ok: false,
          error: { code: "unknown_reader_message", message: "不支持的网页朗读请求。" },
        };
    }
  }

  async function runReaderCommand(message) {
    const requestedPageKey = String(message && message.pageKey || "");
    const statePageKey = String(state.pageKey || "");
    const livePageKey = getCurrentPageKey();
    if (
      !requestedPageKey ||
      requestedPageKey !== livePageKey ||
      (statePageKey && statePageKey !== livePageKey)
    ) {
      return {
        ok: false,
        error: "page_context_mismatch",
        errorDetail: {
          code: "page_context_mismatch",
          message: "网页已发生变化，请重新打开扩展弹窗后再操作。",
        },
        snapshot: getReaderSnapshot(),
      };
    }
    const payload = message && message.payload && typeof message.payload === "object"
      ? message.payload
      : {};
    const command = String(message.command || message.action || payload.command || "")
      .trim()
      .toLowerCase();
    switch (command) {
      case "toggle":
      case "play-toggle":
        await togglePlayback();
        break;
      case "play":
      case "resume":
        if (state.status !== "playing") await togglePlayback();
        break;
      case "pause":
        if (state.status === "playing") await togglePlayback();
        break;
      case "previous":
      case "prev":
        await move(-1);
        break;
      case "next":
        await move(1);
        break;
      case "seek": {
        const index = Number(message.index == null ? payload.index : message.index);
        if (!Number.isInteger(index)) {
          return {
            ok: false,
            error: { code: "invalid_reader_index", message: "朗读位置无效。" },
            snapshot: getReaderSnapshot(),
          };
        }
        await seek(index);
        break;
      }
      case "set-speed": {
        const requestedRate = Number(
          message.value == null ? payload.value : message.value,
        );
        if (!Number.isFinite(requestedRate) || requestedRate < 0.5 || requestedRate > 2) {
          return {
            ok: false,
            error: { code: "invalid_playback_rate", message: "朗读速度应在 0.5× 到 2.0× 之间。" },
            snapshot: getReaderSnapshot(),
          };
        }
        playbackRate = Math.round(requestedRate * 100) / 100;
        if (currentAudio) currentAudio.playbackRate = playbackRate;
        render();
        break;
      }
      case "scan":
      case "scan-page":
      case "refresh":
        await refreshCurrentPage();
        break;
      case "stop":
      case "close":
        await stopPlayback();
        break;
      default:
        return {
          ok: false,
          error: { code: "unknown_reader_command", message: "不支持的朗读操作。" },
          snapshot: getReaderSnapshot(),
        };
    }
    return { ok: true, snapshot: getReaderSnapshot() };
  }

  async function applyPageContext(message) {
    const context = message && message.context && typeof message.context === "object"
      ? message.context
      : message && message.pageContext && typeof message.pageContext === "object"
        ? message.pageContext
        : message || {};
    const currentPageKey = state.pageKey || getCurrentPageKey();
    const requestedPageKey = String(context.pageKey || "");
    if (requestedPageKey && requestedPageKey !== currentPageKey) {
      return {
        ok: false,
        error: {
          code: "page_context_mismatch",
          message: "该配音设置不属于当前网页。",
        },
        pageContext: getPageContext(),
      };
    }
    const normalize = VoiceAssignment.normalizeAuthorVoices;
    pageAuthorVoices = typeof normalize === "function"
      ? normalize(context.authorVoices)
      : normalizeAuthorVoicesFallback(context.authorVoices);
    if (state.segments.length) {
      await stopPlayback();
      reassignCurrentSegments();
    } else {
      render();
    }
    return { ok: true, pageContext: getPageContext() };
  }

  function getReaderSnapshot() {
    const authors = getAuthorSummary();
    const current = state.current;
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
      current: current
        ? {
            authorKey: getAuthorKey(current, state.index),
            authorName: getDisplayAuthor(current),
            role: getRoleLabel(current),
            voice: current.voice || "",
            text: truncateText(current.text, 120),
          }
        : null,
    };
  }

  function getPageContext() {
    const snapshot = getReaderSnapshot();
    return {
      pageKey: snapshot.pageKey,
      revision: snapshot.revision,
      authorVoices: Object.assign({}, pageAuthorVoices),
      hasMultipleAuthors: snapshot.hasMultipleAuthors,
      authorSummary: snapshot.authorSummary,
      // These aliases are intentionally compact and let the separate page
      // editor use the exact same canonical author key as the assignment code.
      authors: snapshot.authorSummary.map((author) => ({
        id: author.key,
        name: author.name,
        role: author.role,
        isOp: author.isOp,
        count: author.count,
        // effectiveVoice is the result after global strategy plus an optional
        // page override. authorVoices below contains only explicit overrides.
        effectiveVoice: author.voice,
      })),
      voices: unique([
        settings.opVoice,
        ...(settings.replyVoices || []),
        ...Object.values(pageAuthorVoices),
      ]).filter(Boolean),
    };
  }

  function normalizeAuthorVoicesFallback(value) {
    const result = {};
    if (!value || typeof value !== "object" || Array.isArray(value)) return result;
    Object.entries(value).forEach(([key, voice]) => {
      const normalizedKey = String(key || "").trim();
      const normalizedVoice = String(voice || "").trim();
      if (normalizedKey && normalizedVoice) result[normalizedKey] = normalizedVoice;
    });
    return result;
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
    return before !== JSON.stringify(settings);
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
      authorVoices: pageAuthorVoices,
    });
  }

  function reassignCurrentSegments() {
    if (!state.segments.length) {
      render();
      return;
    }
    try {
      const assigned = assignSegments(state.segments.map(stripPlaybackFields));
      state = Player.reduce(state, {
        type: "LOAD_SUCCESS",
        scanId: state.scanId,
        document: state.document,
        segments: assigned,
        index: state.index,
      });
    } catch (error) {
      showToast(error.message || "无法更新本页音色分配。");
    }
    render();
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
      audio.playbackRate = playbackRate;
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
        clearHighlight();
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
      clearHighlight();
      showToast("合成失败，请检查本地服务后重试。");
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
    // Per-page assignments are deliberately ephemeral. The popup/background can
    // restore the matching page context after navigation through reader:page-context:apply.
    pageAuthorVoices = {};
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
    stateRevision += 1;
    renderMiniPlayer();
    void publishSnapshot();
  }

  function publishSnapshot() {
    if (!chrome.runtime || typeof chrome.runtime.sendMessage !== "function") return;
    Promise.resolve(chrome.runtime.sendMessage({
      type: "reader:snapshot",
      snapshot: getReaderSnapshot(),
    })).catch(() => {
      // The background worker may be restarting. Popup reads still request a
      // fresh snapshot directly from this page, so publishing is best-effort.
    });
  }

  function renderMiniPlayer() {
    const player = shadow.querySelector(".qr-mini-player");
    if (!player) return;
    const isVisible = ["loading", "playing", "paused"].includes(state.status);
    const current = state.current;
    const isLoading = state.status === "loading";
    const isPlaying = state.status === "playing";
    const canMove = state.segments.length > 0 && !isLoading;
    player.classList.toggle("is-visible", isVisible);
    player.classList.toggle("is-loading", isLoading);
    player.dataset.state = state.status;
    player.setAttribute("aria-hidden", String(!isVisible));
    player.setAttribute("aria-busy", String(isLoading));

    const avatar = shadow.querySelector('[data-role="speaker-avatar"]');
    const name = shadow.querySelector('[data-role="speaker-name"]');
    const meta = shadow.querySelector('[data-role="speaker-meta"]');
    const text = shadow.querySelector('[data-role="segment-text"]');
    const displayAuthor = getDisplayAuthor(current);
    if (avatar) avatar.textContent = initials(displayAuthor);
    if (name) {
      name.textContent = isLoading
        ? `正在为 ${displayAuthor} 合成`
        : displayAuthor;
    }
    if (meta) {
      const context = [getRoleLabel(current), current && current.voice, getPlaybackStatusLabel()]
        .filter(Boolean)
        .join(" · ");
      meta.textContent = context || "当前网页";
    }
    if (text) text.textContent = current ? truncateText(current.text, 94) : "";

    const previous = shadow.querySelector('[data-action="previous"]');
    const next = shadow.querySelector('[data-action="next"]');
    const toggle = shadow.querySelector('[data-action="play-toggle"]');
    if (previous) previous.disabled = !canMove || state.index <= 0;
    if (next) next.disabled = !canMove || state.index >= state.segments.length - 1;
    if (toggle) {
      toggle.disabled = isLoading || !state.segments.length;
      toggle.setAttribute("aria-label", isPlaying ? "暂停朗读" : "继续朗读");
      toggle.innerHTML = isPlaying
        ? '<span class="qr-pause-icon" aria-hidden="true"></span>'
        : '<span class="qr-play-icon" aria-hidden="true"></span>';
    }
  }

  function getPlaybackStatusLabel() {
    if (state.status === "loading") return "正在合成";
    if (state.status === "playing") return "正在朗读";
    if (state.status === "paused") return "已暂停";
    return "";
  }

  function getAuthorSummary() {
    const authors = new Map();
    state.segments.forEach((segment, index) => {
      const key = getAuthorKey(segment, index);
      const existing = authors.get(key);
      if (existing) {
        existing.count += 1;
        return;
      }
      authors.set(key, {
        key,
        name: getDisplayAuthor(segment),
        role: getRoleLabel(segment),
        voice: segment.voice || pageAuthorVoices[key] || "",
        isOp: Boolean(segment.isOp),
        count: 1,
      });
    });
    return Array.from(authors.values()).slice(0, 12);
  }

  function getAuthorKey(segment, index) {
    if (VoiceAssignment && typeof VoiceAssignment.authorKey === "function") {
      return VoiceAssignment.authorKey(segment, index);
    }
    const source = segment || {};
    return String(source.authorId || source.authorName || source.sourceKey || source.id || index || "article");
  }

  function getDisplayAuthor(segment) {
    const source = segment || {};
    return String(
      source.character || source.speaker || source.authorName ||
      (source.isOp ? "楼主" : source.type === "selection" ? "选中文本" : "正文"),
    ).trim() || "正文";
  }

  function getRoleLabel(segment) {
    const source = segment || {};
    const explicitRole = String(source.role || source.characterRole || "").trim();
    if (explicitRole) return explicitRole;
    if (source.isOp) return "楼主";
    if (source.type === "selection") return "选中文本";
    if (source.type === "article") return "正文";
    if (source.authorId || source.authorName) return "回复作者";
    return "正文";
  }

  function truncateText(value, maxLength) {
    const text = String(value || "").replace(/\s+/gu, " ").trim();
    const limit = Math.max(1, Number(maxLength) || 1);
    return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
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
