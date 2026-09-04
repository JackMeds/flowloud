/* global chrome, importScripts */
if (typeof importScripts === 'function') {
  const backgroundScripts = [];
  if (!globalThis.FlowloudSettings) backgroundScripts.push('shared/settings-schema.js');
  if (!globalThis.QwenReaderApiClient) backgroundScripts.push('shared/api-client.js');
  if (!globalThis.FlowloudProviderCore) backgroundScripts.push('shared/provider-core.js');
  if (!globalThis.FlowloudBrowserModelManifest) backgroundScripts.push('shared/browser-model-manifest.js');
  if (!globalThis.FlowloudProviderV3) backgroundScripts.push('shared/provider-v3.js');
  if (!globalThis.FlowloudProviderV4) backgroundScripts.push('shared/provider-v4.js');
  if (!globalThis.FlowloudDocumentProviderV1) backgroundScripts.push('shared/document-provider-v1.js');
  if (!globalThis.QwenReaderVoiceLibrary) {
    if (!globalThis.QwenReaderVoiceNaming) backgroundScripts.push('shared/voice-naming.js');
    backgroundScripts.push('shared/voice-library.js');
  }
  if (backgroundScripts.length) importScripts(...backgroundScripts);
}

(function backgroundModule(root, factory) {
  const apiModule = root.QwenReaderApiClient || (typeof require === 'function'
    ? require('./shared/api-client.js') : null);
  const voiceLibrary = root.QwenReaderVoiceLibrary || (typeof require === 'function'
    ? require('./shared/voice-library.js') : null);
  const exported = factory(apiModule, voiceLibrary);
  if (typeof module === 'object' && module.exports) module.exports = exported;
  root.QwenReaderBackground = exported;

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    exported.install(chrome);
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function makeBackground(apiModule, voiceLibrary) {
  'use strict';

  const OFFSCREEN_TARGET = 'qwen-reader-offscreen';
  const STREAM_EVENT_TARGET = 'qwen-reader-stream-event';
  const OFFSCREEN_PATH = 'offscreen.html';
  const REQUIRED_ORIGIN = 'http://127.0.0.1/*';
  const SETTINGS_KEY = 'qwenReaderSettings';
  const CLEANUP_QUEUE_KEY = 'voiceCleanupQueue';
  const POPUP_TARGET_KEY = 'qwenReaderPopupTarget';
  const POPUP_SNAPSHOTS_KEY = 'qwenReaderPopupSnapshots';
  const READER_ENABLED_TABS_KEY = 'qwenReaderEnabledTabsV1';
  const READER_SITE_SCRIPT_ID = 'flowloud-reader-sites-v1';
  const PAGE_EDITOR_CONTEXTS_KEY = 'qwenReaderPageEditorContexts';
  const GLOBAL_PLAYBACK_KEY = 'flowloudGlobalPlaybackV1';
  const DOCUMENT_WORKSPACE_SEED_KEY = 'flowloudDocumentWorkspaceSeedV1';
  const PROVIDER_VALIDATION_KEY = 'flowloudProviderValidationV1';
  const PAGE_EDITOR_PATH = 'page-voices.html';
  const BUILTIN_VOICES = ['邵思萌', 'qwen-clone'];

  function actionIconPaths(status) {
    const normalized = ['playing', 'paused', 'error'].includes(String(status || ''))
      ? String(status)
      : 'idle';
    return {
      16: `assets/flowloud-toolbar-${normalized}-16.png`,
      32: `assets/flowloud-toolbar-${normalized}-32.png`,
    };
  }

  function isReadOnlyProfile(profile) {
    if (!profile || typeof profile !== 'object') return false;
    const kind = String(profile.kind || '').trim().toLowerCase();
    const nonLocalKinds = ['builtin', 'alias', 'remote', 'provider'];
    const hasWav = Boolean(String(profile.wavB64 || profile.wav_b64 || ''));
    const hasExtractedVoice = Boolean(
      String(profile.spkB64 || profile.spk_b64 || '') &&
      String(profile.rvqB64 || profile.rvq_b64 || ''),
    );
    return (
      profile.local === false || profile.remote === true || profile.builtIn || profile.builtin ||
      nonLocalKinds.includes(kind) || BUILTIN_VOICES.includes(profile.name) ||
      (!hasWav && !hasExtractedVoice)
    );
  }

  function repairVoiceSettings(current, deletedName, remainingProfiles) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return null;
    const deleted = String(deletedName || '').trim();
    const existingReplies = Array.isArray(current.replyVoices)
      ? current.replyVoices.map((voice) => String(voice || '').trim()).filter(Boolean)
      : [];
    const profileNames = (Array.isArray(remainingProfiles) ? remainingProfiles : [])
      .map((profile) => String(profile && profile.name || '').trim())
      .filter(Boolean);
    const candidates = [];
    [...existingReplies, current.opVoice, ...profileNames, ...BUILTIN_VOICES]
      .map((voice) => String(voice || '').trim())
      .filter((voice) => voice && voice !== deleted)
      .forEach((voice) => {
        if (!candidates.includes(voice)) candidates.push(voice);
      });

    let opVoice = String(current.opVoice || '').trim();
    if (!opVoice || opVoice === deleted) opVoice = candidates[0] || '';
    const replyVoices = existingReplies.filter(
      (voice, index, list) =>
        voice !== deleted &&
        voice !== opVoice &&
        list.indexOf(voice) === index,
    );
    if (!replyVoices.length) {
      const replacement = candidates.find((voice) => voice !== opVoice);
      if (replacement) replyVoices.push(replacement);
    }
    if (!opVoice || !replyVoices.length) {
      const error = new Error('删除后将没有可用的独立楼主与回复音色，请先录制另一个音色。');
      error.code = 'voice_in_use';
      throw error;
    }
    return Object.assign({}, current, { opVoice, replyVoices });
  }

  function chromeStorage(chromeApi) {
    return {
      async get(key) {
        const values = await chromeApi.storage.local.get(key);
        return values[key] || [];
      },
      async set(key, value) {
        await chromeApi.storage.local.set({ [key]: value });
      },
      async setMany(values) {
        await chromeApi.storage.local.set(values);
      },
      async remove(key) {
        if (chromeApi.storage.local?.remove) await chromeApi.storage.local.remove(key);
      },
    };
  }

  // Popup targets are browser-session state. Keeping them out of local storage
  // avoids restoring an old tab id after a browser restart.
  function chromeSessionStorage(chromeApi) {
    const memory = new Map();
    const area = chromeApi && chromeApi.storage && chromeApi.storage.session;
    return {
      async get(key) {
        if (area && typeof area.get === 'function') {
          const values = await area.get(key);
          return values && Object.prototype.hasOwnProperty.call(values, key)
            ? values[key]
            : undefined;
        }
        return memory.get(key);
      },
      async set(key, value) {
        if (area && typeof area.set === 'function') {
          await area.set({ [key]: value });
          return;
        }
        memory.set(key, value);
      },
      async remove(key) {
        if (area && typeof area.remove === 'function') {
          await area.remove(key);
          return;
        }
        memory.delete(key);
      },
    };
  }

  function safeJsonClone(value) {
    if (value == null) return value;
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_) {
      return null;
    }
  }

  function normalizeTabTarget(tab) {
    if (!tab || tab.id == null) return null;
    return {
      tabId: Number(tab.id),
      windowId: tab.windowId == null ? null : Number(tab.windowId),
      pageKey: String(tab.pageKey || ''),
      url: String(tab.url || ''),
      title: String(tab.title || ''),
    };
  }

  function isPopupMessage(type) {
    return [
      'popup:init',
      'popup:target',
      'popup:snapshot',
      'popup:get-state',
      'popup:command',
      'popup:reset-target',
      'reader:active-context',
      'reader:snapshot:get',
      'reader:document:get',
      'reader:command',
      'reader:page-voices:get',
      'reader:page-voices:apply',
    ].includes(type);
  }

  function isPageEditorMessage(type) {
    return [
      'page-editor:open',
      'page-editor:init',
      'page-editor:register',
      'page-editor:get-context',
      'page-editor:context',
      'page-editor:command',
      'page-editor:close',
      'page-voices:open',
      'reader:page-editor:open',
    ].includes(type);
  }

  function normalizeCommand(message) {
    const body = message || {};
    const raw = body.command || body.action || body.name || body.intent;
    const command = String(raw || '').trim().toLowerCase();
    const aliases = {
      toggle: 'play-toggle',
      'toggle-playback': 'play-toggle',
      play: 'play-toggle',
      pause: 'play-toggle',
      resume: 'play-toggle',
      'play-toggle': 'play-toggle',
      next: 'next',
      previous: 'previous',
      prev: 'previous',
      stop: 'stop',
      scan: 'scan-page',
      'scan-page': 'scan-page',
      refresh: 'scan-page',
    };
    return aliases[command] || command;
  }

  function snapshotFromMessage(message) {
    const body = message || {};
    const snapshot = body.snapshot || body.state || body.player || body;
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
    const document = snapshot.document && typeof snapshot.document === 'object'
      ? snapshot.document
      : null;
    const segments = Array.isArray(snapshot.segments) ? snapshot.segments : null;
    const current = snapshot.current && typeof snapshot.current === 'object'
      ? snapshot.current
      : (segments && snapshot.index != null ? segments[Number(snapshot.index)] : null);
    const total = Number.isFinite(Number(snapshot.total))
      ? Number(snapshot.total)
      : Number.isFinite(Number(snapshot.segmentCount))
        ? Number(snapshot.segmentCount)
        : segments ? segments.length : 0;
    return {
      status: String(snapshot.status || 'idle'),
      pageKey: String(snapshot.pageKey || (document && document.pageKey) || ''),
      title: String(snapshot.title || (document && (document.title || document.name)) || ''),
      index: Number.isFinite(Number(snapshot.index)) ? Number(snapshot.index) : 0,
      total,
      segmentCount: total,
      current: safeJsonClone(current),
      document: safeJsonClone(document),
      revision: Number.isFinite(Number(snapshot.revision)) ? Number(snapshot.revision) : 0,
      hasMultipleAuthors: Boolean(snapshot.hasMultipleAuthors),
      authorSummary: safeJsonClone(snapshot.authorSummary || snapshot.authors || []),
      speed: snapshot.speed == null ? null : snapshot.speed,
      rate: snapshot.rate == null ? null : snapshot.rate,
      error: snapshot.error ? String(snapshot.error.message || snapshot.error) : null,
      updatedAt: Date.now(),
    };
  }

  function errorEnvelope(error) {
    if (error && error.name === 'AbortError') {
      return { ok: false, error: { stage: 'provider', code: 'cancelled', message: '朗读已取消。', retryable: false } };
    }
    return {
      ok: false,
      error: {
        stage: String(error && (error.stage || error.operation) || 'provider'),
        code: error && error.code ? error.code : 'unexpected_error',
        message: error && error.message ? error.message : '本地朗读服务发生未知错误。',
        retryable: error && error.retryable != null
          ? Boolean(error.retryable)
          : ['network_error', 'timeout', 'offscreen_unavailable'].includes(String(error && error.code || ''))
            || /^http_5\d\d$/u.test(String(error && error.code || '')),
      },
    };
  }

  function createOffscreenManager(chromeApi) {
    const documentUrl = chromeApi.runtime.getURL(OFFSCREEN_PATH);
    let creating = null;
    let assumedOpen = false;

    async function hasDocument() {
      if (typeof chromeApi.runtime.getContexts === 'function') {
        const contexts = await chromeApi.runtime.getContexts({
          contextTypes: ['OFFSCREEN_DOCUMENT'],
          documentUrls: [documentUrl],
        });
        return Array.isArray(contexts) && contexts.some((context) => (
          context && context.documentUrl === documentUrl
        ));
      }
      if (chromeApi.offscreen && typeof chromeApi.offscreen.hasDocument === 'function') {
        return chromeApi.offscreen.hasDocument();
      }
      return assumedOpen;
    }

    async function assertPermission(baseUrl) {
      if (!chromeApi.permissions || typeof chromeApi.permissions.contains !== 'function') return;
      let origin = REQUIRED_ORIGIN;
      try { origin = `${new URL(String(baseUrl || 'http://127.0.0.1:7811')).origin}/*`; } catch (_) {}
      const granted = await chromeApi.permissions.contains({ origins: [origin] });
      if (granted) return;
      const error = new Error(`请先允许扩展访问本地服务：${origin.replace(/\/\*$/, '')}`);
      error.code = 'host_permission_missing';
      error.retryable = true;
      throw error;
    }

    async function ensureDocument(message) {
      const providerId = String(message && message.providerId || '');
      if (providerId === 'local-qwen' || providerId === 'local-service') {
        await assertPermission(message && message.providerSettings && message.providerSettings.baseUrl);
      }
      if (await hasDocument()) {
        assumedOpen = true;
        return;
      }
      if (!chromeApi.offscreen || typeof chromeApi.offscreen.createDocument !== 'function') {
        const error = new Error('当前 Edge 版本无法创建后台音频运行环境。');
        error.code = 'offscreen_unavailable';
        throw error;
      }
      if (!creating) {
        creating = chromeApi.offscreen.createDocument({
          url: OFFSCREEN_PATH,
          reasons: ['BLOBS', 'AUDIO_PLAYBACK'],
          justification: 'Convert local Qwen TTS WAV blobs and schedule bounded streaming playback during long model cold starts.',
        }).then(() => {
          assumedOpen = true;
        }).catch(async (error) => {
          if (await hasDocument()) {
            assumedOpen = true;
            return;
          }
          const wrapped = new Error(error && error.message
            ? error.message
            : '无法创建后台音频运行环境。');
          wrapped.code = 'offscreen_unavailable';
          throw wrapped;
        }).finally(() => {
          creating = null;
        });
      }
      await creating;
    }

    async function send(message) {
      const result = await chromeApi.runtime.sendMessage(Object.assign({}, message, {
        target: OFFSCREEN_TARGET,
      }));
      if (result) return result;
      const error = new Error('后台音频运行环境没有响应。');
      error.code = 'offscreen_unavailable';
      throw error;
    }

    return {
      async request(message) {
        await ensureDocument(message);
        return send(message);
      },
      async control(message) {
        // getContexts()/hasDocument() can briefly lag behind a live offscreen
        // page during MV3 lifecycle transitions. Send the identity-bearing
        // control directly; a missing recipient is still reported as a benign
        // non-applied control below.
        try {
          return await send(message);
        } catch (error) {
          return {
            ok: false,
            count: 0,
            error: {
              code: error && error.code ? error.code : 'offscreen_unavailable',
              message: error && error.message ? error.message : '后台音频运行环境没有响应。',
              retryable: true,
            },
          };
        }
      },
      async cancel(message) {
        if (!(await hasDocument())) return { ok: true, cancelled: false, count: 0 };
        return send(message);
      },
      hasDocument,
      ensureDocument,
    };
  }

  function normalizeReaderSitePattern(value) {
    const source = String(value || '').replace(/\/\*$/u, '');
    let parsed;
    try { parsed = new URL(source); } catch (_) {
      const error = new Error('悬浮播放器站点权限不是有效网址。');
      error.code = 'invalid_site_origin';
      throw error;
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      const error = new Error('悬浮播放器只接受 HTTP 或 HTTPS 网站 origin。');
      error.code = 'invalid_site_origin';
      throw error;
    }
    return `${parsed.origin}/*`;
  }

  async function registerReaderSite(chromeApi, value) {
    const pattern = normalizeReaderSitePattern(value);
    if (chromeApi.permissions?.contains && !await chromeApi.permissions.contains({ origins: [pattern] })) {
      const error = new Error('当前网站尚未授权。');
      error.code = 'host_permission_missing';
      throw error;
    }
    const scripting = chromeApi.scripting;
    if (!scripting?.registerContentScripts || !scripting?.getRegisteredContentScripts) {
      return { ok: true, pattern, registered: false };
    }
    const existing = await scripting.getRegisteredContentScripts({ ids: [READER_SITE_SCRIPT_ID] });
    const current = Array.isArray(existing) ? existing[0] : null;
    const matches = Array.from(new Set([...(Array.isArray(current?.matches) ? current.matches : []), pattern]));
    const definition = {
      id: READER_SITE_SCRIPT_ID,
      matches,
      js: ['content/reader-bootstrap.js'],
      runAt: 'document_idle',
      persistAcrossSessions: true,
    };
    if (current && scripting.updateContentScripts) await scripting.updateContentScripts([definition]);
    else if (!current) await scripting.registerContentScripts([definition]);
    return { ok: true, pattern, registered: true };
  }

  function createGlobalPlaybackCoordinator(options) {
    const config = options || {};
    const session = config.session || null;
    const cancel = typeof config.cancel === 'function' ? config.cancel : async () => ({ ok: true, cancelled: false });
    let active = null;
    let restored = false;
    let intentSequence = 0;
    let serial = Promise.resolve();

    function identity(message) {
      const body = message || {};
      const sourceTabValue = body.sourceTabId;
      return {
        sourceTabId: sourceTabValue == null || sourceTabValue === ''
          ? null : (Number.isInteger(Number(sourceTabValue)) ? Number(sourceTabValue) : null),
        sourceDocumentId: String(body.sourceDocumentId || ''),
        pageKey: String(body.pageKey || ''),
        segmentId: String(body.segmentId || body.request && body.request.segmentId || ''),
        playbackId: String(body.playbackId || body.sessionId || ''),
        requestId: String(body.requestId || body.request && body.request.requestId || ''),
        clientId: String(body.clientId || ''),
        providerId: String(body.providerId || ''),
      };
    }

    async function restore() {
      if (restored) return active;
      restored = true;
      const saved = session && typeof session.get === 'function' ? await session.get(GLOBAL_PLAYBACK_KEY) : null;
      if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
        active = Object.assign({}, saved);
        intentSequence = Math.max(intentSequence, Number(active.intentSequence) || 0);
      }
      return active;
    }

    async function persist() {
      if (!session) return;
      if (active && typeof session.set === 'function') await session.set(GLOBAL_PLAYBACK_KEY, active);
      else if (typeof session.remove === 'function') await session.remove(GLOBAL_PLAYBACK_KEY);
    }

    function samePlayback(left, right) {
      if (!left || !right) return false;
      if (left.playbackId && right.playbackId) return left.playbackId === right.playbackId;
      return left.sourceTabId === right.sourceTabId && left.requestId && left.requestId === right.requestId;
    }

    function snapshot() {
      return active ? Object.assign({ active: true }, safeJsonClone(active)) : {
        active: false, state: 'idle', intentSequence,
      };
    }

    async function claim(message) {
      const requested = identity(message);
      if (requested.sourceTabId == null || !requested.playbackId) {
        const error = new Error('全局播放会话缺少来源标签页或 playbackId。');
        error.code = 'invalid_playback_identity';
        throw error;
      }
      serial = serial.then(async () => {
        await restore();
        if (active && !samePlayback(active, requested)) {
          await cancel(Object.assign({}, active), 'replaced-by-new-playback');
        }
        if (active && samePlayback(active, requested)) {
          active = Object.assign({}, active, requested, {
            state: active.state === 'idle' ? 'loading' : active.state,
            updatedAt: Date.now(),
          });
        } else {
          intentSequence += 1;
          active = Object.assign({}, requested, {
            intentSequence,
            state: String(message && message.state || 'loading'),
            desiredPaused: Boolean(message && message.startPaused),
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
        }
        await persist();
        return snapshot();
      });
      return { ok: true, playback: await serial };
    }

    async function resolve(message) {
      await restore();
      const body = Object.assign({}, message || {});
      if (!active) return body;
      const supplied = identity(body);
      // Control messages commonly carry playbackId/requestId but omit the
      // provider.  Returning them unchanged used to route a session that had
      // fallen back to system TTS through the currently selected provider
      // (usually browser-model), making pause/resume appear to fail.  Merge
      // the active session identity whenever the supplied identity belongs to
      // that session; keep an explicitly supplied field authoritative.
      const suppliedPlayback = supplied.playbackId;
      const suppliedRequest = supplied.requestId;
      const suppliedTab = supplied.sourceTabId;
      if (suppliedPlayback && active.playbackId && suppliedPlayback !== active.playbackId) return body;
      if (!suppliedPlayback && suppliedRequest && active.requestId && suppliedRequest !== active.requestId) return body;
      if (suppliedTab != null && active.sourceTabId != null && suppliedTab !== active.sourceTabId) return body;
      return Object.assign({
        sourceTabId: active.sourceTabId,
        sourceDocumentId: active.sourceDocumentId,
        pageKey: active.pageKey,
        segmentId: active.segmentId,
        playbackId: active.playbackId,
        requestId: active.requestId,
        sessionId: active.playbackId,
        clientId: active.clientId,
        providerId: active.providerId,
        intentSequence: active.intentSequence,
      }, body);
    }

    async function update(patch, matcher) {
      await restore();
      if (!active) return snapshot();
      const expected = matcher ? identity(matcher) : null;
      if (expected && (expected.playbackId || expected.requestId || expected.sourceTabId != null)) {
        if (expected.playbackId && expected.playbackId !== active.playbackId) return snapshot();
        if (expected.requestId && expected.requestId !== active.requestId) return snapshot();
        if (expected.sourceTabId != null && expected.sourceTabId !== active.sourceTabId) return snapshot();
      }
      active = Object.assign({}, active, patch || {}, { updatedAt: Date.now() });
      await persist();
      return snapshot();
    }

    async function release(message, reason) {
      serial = serial.then(async () => {
        await restore();
        if (!active) return snapshot();
        const expected = identity(message);
        if (expected.playbackId && expected.playbackId !== active.playbackId) return snapshot();
        if (expected.sourceTabId != null && expected.sourceTabId !== active.sourceTabId) return snapshot();
        active = null;
        await persist();
        return Object.assign(snapshot(), { reason: String(reason || 'released') });
      });
      return serial;
    }

    async function stopForTab(tabId, reason) {
      serial = serial.then(async () => {
        await restore();
        if (!active || Number(active.sourceTabId) !== Number(tabId)) return snapshot();
        const previous = Object.assign({}, active);
        await cancel(previous, reason || 'source-tab-stopped');
        active = null;
        await persist();
        return Object.assign(snapshot(), { stopped: true, reason: String(reason || '') });
      });
      return serial;
    }

    async function acceptStreamEvent(message) {
      await restore();
      if (!active) return snapshot();
      const incoming = identity(message);
      if (incoming.playbackId && incoming.playbackId !== active.playbackId) return snapshot();
      if (incoming.requestId && incoming.requestId !== active.requestId) return snapshot();
      const event = String(message && message.event || '').toLowerCase();
      if (['ended', 'cancelled', 'error'].includes(event)) return release(message, event);
      const states = { started: 'playing', progress: active.state, paused: 'paused', resumed: 'playing', retrying: 'loading' };
      return update({
        state: states[event] || active.state,
        desiredPaused: event === 'paused' ? true : event === 'resumed' ? false : active.desiredPaused,
      }, message);
    }

    async function acceptReaderSnapshot(value, source) {
      await restore();
      const normalized = snapshotFromMessage(value);
      const tabId = source && source.tabId != null ? Number(source.tabId) : null;
      if (!normalized || !active || tabId !== active.sourceTabId) return snapshot();
      if (normalized.pageKey && active.pageKey && normalized.pageKey !== active.pageKey) return snapshot();
      if (['playing', 'paused', 'loading', 'extracting', 'ready'].includes(normalized.status)) {
        return update({ state: normalized.status, readerSnapshot: normalized }, { sourceTabId: tabId, playbackId: active.playbackId });
      }
      if (['idle', 'error'].includes(normalized.status)) return release({ sourceTabId: tabId, playbackId: active.playbackId }, `reader-${normalized.status}`);
      return snapshot();
    }

    return Object.freeze({
      claim, resolve, update, release, stopForTab, acceptStreamEvent, acceptReaderSnapshot,
      getSnapshot: async () => { await restore(); return snapshot(); },
      getActive: async () => { await restore(); return active ? Object.assign({}, active) : null; },
    });
  }

  const MICROSOFT_SYSTEM_VOICES = Object.freeze([
    { match: /^Microsoft\s+Huihui(?:\s+Desktop)?(?:\s*-\s*Chinese\s*\(Simplified\))?$/iu, name: '慧慧', locale: 'zh-CN', languageLabel: '简体中文', gender: 'female' },
    { match: /^Microsoft\s+Yaoyao(?:\s+Desktop)?(?:\s*-\s*Chinese\s*\(Simplified\))?$/iu, name: '瑶瑶', locale: 'zh-CN', languageLabel: '简体中文', gender: 'female' },
    { match: /^Microsoft\s+Kangkang(?:\s+Desktop)?(?:\s*-\s*Chinese\s*\(Simplified\))?$/iu, name: '康康', locale: 'zh-CN', languageLabel: '简体中文', gender: 'male' },
    { match: /^Microsoft\s+Hanhan(?:\s+Desktop)?(?:\s*-\s*Chinese\s*\(Traditional\))?$/iu, name: '韩韩', locale: 'zh-TW', languageLabel: '繁體中文', gender: 'female' },
    { match: /^Microsoft\s+Yating(?:\s+Desktop)?(?:\s*-\s*Chinese\s*\(Traditional\))?$/iu, name: '雅婷', locale: 'zh-TW', languageLabel: '繁體中文', gender: 'female' },
    { match: /^Microsoft\s+Zhiwei(?:\s+Desktop)?(?:\s*-\s*Chinese\s*\(Traditional\))?$/iu, name: '志伟', locale: 'zh-TW', languageLabel: '繁體中文', gender: 'male' },
    { match: /^Microsoft\s+Tracy(?:\s+Desktop)?(?:\s*-\s*Chinese\s*\(Traditional\))?$/iu, name: 'Tracy', locale: 'zh-HK', languageLabel: '粤语', gender: 'female' },
    { match: /^Microsoft\s+David(?:\s+Desktop)?(?:\s*-\s*English\s*\(United\s+States\))?$/iu, name: 'David', locale: 'en-US', languageLabel: 'English (US)', gender: 'male' },
    { match: /^Microsoft\s+Mark(?:\s+Desktop)?(?:\s*-\s*English\s*\(United\s+States\))?$/iu, name: 'Mark', locale: 'en-US', languageLabel: 'English (US)', gender: 'male' },
    { match: /^Microsoft\s+Zira(?:\s+Desktop)?(?:\s*-\s*English\s*\(United\s+States\))?$/iu, name: 'Zira', locale: 'en-US', languageLabel: 'English (US)', gender: 'female' },
    { match: /^Microsoft\s+Hazel(?:\s+Desktop)?(?:\s*-\s*English\s*\(United\s+Kingdom\))?$/iu, name: 'Hazel', locale: 'en-GB', languageLabel: 'English (UK)', gender: 'female' },
    { match: /^Microsoft\s+George(?:\s+Desktop)?(?:\s*-\s*English\s*\(United\s+Kingdom\))?$/iu, name: 'George', locale: 'en-GB', languageLabel: 'English (UK)', gender: 'male' },
  ]);

  function enrichMicrosoftSystemVoice(voice) {
    const rawLabel = String(voice && (voice.voiceName || voice.name) || '').trim();
    const match = MICROSOFT_SYSTEM_VOICES.find((item) => item.match.test(rawLabel));
    if (!match) return {
      rawLabel,
      displayLabel: rawLabel,
      metadataSource: 'runtime',
    };
    return {
      rawLabel,
      displayLabel: `${match.name} · ${match.languageLabel} · 微软`,
      locale: match.locale,
      languageLabel: match.languageLabel,
      vendor: 'Microsoft',
      gender: match.gender,
      metadataSource: 'microsoft-official',
    };
  }

  function createChromeTtsManager(chromeApi) {
    const tts = chromeApi && chromeApi.tts;
    let active = null;
    let tokenSequence = 0;
    let eventObserver = null;
    function voices() {
      return new Promise((resolve, reject) => {
        if (!tts || typeof tts.getVoices !== 'function') return reject(Object.assign(new Error('浏览器系统语音不可用。'), { code: 'system_voice_unavailable' }));
        const done = (items) => resolve((items || []).map((voice) => {
          const metadata = enrichMicrosoftSystemVoice(voice);
          const lang = voice.lang || metadata.locale || '';
          return {
            id: `browser-system:${voice.voiceName}`,
            rawId: voice.voiceName,
            voiceId: voice.voiceName,
            name: metadata.displayLabel || voice.voiceName,
            label: metadata.displayLabel || voice.voiceName,
            rawLabel: metadata.rawLabel || voice.voiceName,
            displayLabel: metadata.displayLabel || voice.voiceName,
            lang,
            locale: lang,
            language: lang,
            languageLabel: metadata.languageLabel || lang,
            vendor: metadata.vendor || '',
            gender: metadata.gender || '',
            metadataSource: metadata.metadataSource || 'runtime',
            remote: voice.remote === true,
            local: voice.remote !== true,
            default: Boolean(voice.default),
            extensionId: voice.extensionId || '',
            providerId: 'browser-system',
            eventTypes: voice.eventTypes || [],
          };
        }));
        try { const result = tts.getVoices(done); if (result && typeof result.then === 'function') result.then(done, reject); } catch (error) { reject(error); }
      });
    }
    function matches(message) {
      if (!active) return false; const body = message || {};
      if (body.sourceTabId != null && Number(body.sourceTabId) !== active.sourceTabId) return false;
      if (body.requestId && String(body.requestId) !== active.requestId) return false;
      if (body.playbackId && String(body.playbackId) !== active.playbackId) return false;
      return true;
    }
    function clearWatchdog(session) {
      if (!session) return;
      if (session.watchdog) clearTimeout(session.watchdog);
      if (session.retryTimer) clearTimeout(session.retryTimer);
      session.watchdog = null;
      session.retryTimer = null;
    }
    function emit(event, extra, session) {
      const current = session || active;
      if (!current || current.sourceTabId == null || !chromeApi.tabs?.sendMessage) return;
      const payload = Object.assign({ target: STREAM_EVENT_TARGET, event, type: 'tts:stream:event', streamEventType: `tts:stream:${event}`, requestId: current.requestId, playbackId: current.playbackId, sessionId: current.sessionId, clientId: current.clientId, sourceTabId: current.sourceTabId, providerId: 'browser-system', utteranceToken: current.token, capabilityMode: current.capabilityMode, directPlayback: true, transportStreaming: false, progressivePlayback: true }, extra || {});
      const deliver = () => {
        try { const sent = chromeApi.tabs.sendMessage(current.sourceTabId, payload); sent?.catch?.(() => {}); } catch (_) {}
      };
      let observed;
      try { observed = eventObserver && eventObserver(payload); } catch (_) {}
      // A terminal system-voice event must release the old global playback
      // before the content script is told to start the next sentence. Without
      // this ordering Edge can treat normal continuation as a takeover and
      // revoke the successor it has just created.
      if (['ended', 'error', 'cancelled'].includes(String(event)) && observed && typeof observed.then === 'function') {
        Promise.resolve(observed).then(deliver, deliver);
      } else {
        deliver();
      }
    }
    function terminal(session, event, extra) {
      if (!session || active !== session) return;
      clearWatchdog(session);
      session.state = event === 'ended' ? 'ended' : event === 'error' ? 'error' : 'cancelled';
      emit(event, extra, session);
      active = null;
    }
    function speakSession(session, offset, restartedFromBoundary) {
      if (!session || active !== session) return;
      clearWatchdog(session);
      session.generation += 1;
      const generation = session.generation;
      session.offset = Math.max(0, Math.min(session.input.length, Number(offset) || 0));
      session.lastActivityAt = Date.now();
      session.startedAt = 0;
      session.state = 'starting';
      const options = Object.assign({}, session.options, { onEvent(event) {
        if (active !== session || session.generation !== generation) return;
        const type = String(event && event.type || '');
        session.lastActivityAt = Date.now();
        if (type === 'start') {
          session.startedAt = Date.now();
          session.state = session.desiredPaused ? 'paused' : 'playing';
          emit('started', { charIndex: session.offset, restartedFromBoundary: Boolean(restartedFromBoundary) }, session);
        } else if (type === 'word' || type === 'sentence' || type === 'marker') {
          const localIndex = Math.max(0, Number(event.charIndex) || 0);
          session.lastBoundary = session.offset + localIndex;
          session.capabilityMode = type === 'word' ? 'word' : session.capabilityMode === 'word' ? 'word' : 'sentence';
          session.boundarySequence += 1;
          emit('boundary', { boundaryType: type, charIndex: session.lastBoundary, charLength: Math.max(0, Number(event.length ?? event.charLength) || 0), sequence: session.boundarySequence, preciseBoundary: type === 'word', restartedFromBoundary: Boolean(restartedFromBoundary) }, session);
        } else if (type === 'pause') {
          session.state = 'paused';
        } else if (type === 'resume') {
          session.state = 'playing';
        } else if (type === 'end') {
          if (!session.desiredPaused) terminal(session, 'ended', { done: true, charIndex: session.input.length });
        } else if (type === 'cancelled' || type === 'interrupted') {
          if (!session.restarting) terminal(session, 'cancelled');
        } else if (type === 'error') {
          const message = String(event && (event.errorMessage || event.error) || '').trim() || '系统语音播放失败。';
          const noProgress = Number(session.lastBoundary || 0) <= Number(session.offset || 0);
          const earlyFailure = !session.startedAt || Date.now() - session.startedAt < 800;
          if (!session.desiredPaused && noProgress && earlyFailure && Number(session.retryCount || 0) < 1) {
            session.retryCount = Number(session.retryCount || 0) + 1;
            session.generation += 1;
            session.state = 'retrying';
            emit('retrying', { retryAttempt: session.retryCount, error: { code: 'system_voice_transient', message } }, session);
            session.retryTimer = setTimeout(() => {
              session.retryTimer = null;
              if (active === session && !session.desiredPaused) speakSession(session, session.offset, true);
            }, 120);
          } else {
            terminal(session, 'error', { error: { code: 'system_voice_error', message } });
          }
        }
      } });
      try {
        tts.speak(session.input.slice(session.offset), options);
      } catch (error) {
        terminal(session, 'error', { error: { code: 'system_voice_error', message: error?.message || '系统语音播放失败。' } });
      }
    }
    function restartFromBoundary(session) {
      if (!session || active !== session || session.desiredPaused) return;
      const offset = Math.max(0, Number(session.lastBoundary) || Number(session.sentenceOffset) || 0);
      session.restarting = true;
      session.generation += 1;
      try { tts.stop(); } catch (_) {}
      session.restarting = false;
      speakSession(session, offset, true);
      session.state = 'playing';
      emit('resumed', { charIndex: offset, restartedFromBoundary: true }, session);
    }
    async function request(message) {
      const body = message || {};
      if (body.type === 'tts:status') return { ok: true, status: { ok: true, ready: Boolean(tts), providerId: 'browser-system' } };
      if (body.type === 'tts:voices' || body.type === 'voice:list') return { ok: true, voices: await voices() };
      if (body.type !== 'tts:synthesize') return { ok: false, error: { code: 'unknown_message', message: '系统语音不支持此请求。' } };
      if (!tts || typeof tts.speak !== 'function') return { ok: false, error: { code: 'system_voice_unavailable', message: '浏览器系统语音不可用。' } };
      const speech = body.request || {}; const input = String(speech.input || speech.text || '').trim();
      if (!input) return { ok: false, error: { code: 'invalid_input', message: '朗读内容不能为空。' } };
      if (active) { const previous = active; try { tts.stop(); } catch (_) {} terminal(previous, 'cancelled'); }
      const sourceTabId = Number(body.sourceTabId);
      const selectedVoice = String(speech.voice || '').replace(/^browser-system:/, '');
      const catalog = await voices().catch(() => []);
      const selectedMetadata = catalog.find((voice) => voice.voiceId === selectedVoice) || {};
      const eventTypes = Array.isArray(selectedMetadata.eventTypes) ? selectedMetadata.eventTypes : [];
      active = { requestId: String(body.requestId || ''), playbackId: String(body.playbackId || ''), sessionId: String(body.sessionId || ''), clientId: String(body.clientId || ''), sourceTabId: Number.isInteger(sourceTabId) && sourceTabId >= 0 ? sourceTabId : null, token: `system-${Date.now().toString(36)}-${++tokenSequence}`, generation: 0, boundarySequence: 0, state: 'idle', desiredPaused: false, restarting: false, watchdog: null, retryTimer: null, retryCount: 0, startedAt: 0, input, offset: 0, sentenceOffset: 0, lastBoundary: 0, capabilityMode: eventTypes.includes('word') ? 'word' : eventTypes.includes('sentence') ? 'sentence' : 'sentence-restart' };
      const acceptedRequestId = active.requestId;
      active.options = { enqueue: false, rate: Math.max(.75, Math.min(2, Number(speech.rate || body.playbackRate) || 1)), pitch: Math.max(0, Math.min(2, Number(speech.pitch) || 1)), volume: Math.max(0, Math.min(1, speech.volume == null ? 1 : Number(speech.volume))) };
      if (selectedVoice) active.options.voiceName = selectedVoice; if (speech.lang) active.options.lang = String(speech.lang);
      speakSession(active, 0, false);
      return { ok: true, requestId: acceptedRequestId, utteranceToken: active?.token, streaming: true, directPlayback: true, transportStreaming: false, progressivePlayback: true, boundaryMode: active?.capabilityMode || 'sentence-restart' };
    }
    async function control(message) {
      if (!matches(message)) return { ok: true, count: 0 };
      if (message.type === 'tts:pause') {
        const session = active;
        session.desiredPaused = true; session.state = 'paused'; clearWatchdog(session);
        // Several operating-system voices implement chrome.tts.pause() only at
        // a word/sentence boundary. Stop the utterance immediately and retain
        // the latest safe boundary; resume re-speaks only the remaining text.
        session.restarting = true;
        session.generation += 1;
        try { tts.stop(); } catch (_) {}
        session.restarting = false;
        emit('paused', { charIndex: session.lastBoundary, hardPaused: true }, session);
        return { ok: true, paused: true, hardPaused: true, count: 1, utteranceToken: session.token };
      }
      if (message.type === 'tts:resume') {
        const session = active;
        const offset = Math.max(0, Number(session.lastBoundary) || Number(session.sentenceOffset) || 0);
        session.desiredPaused = false; session.state = 'starting'; session.lastActivityAt = Date.now();
        speakSession(session, offset, true);
        if (active === session) {
          session.state = 'playing';
          emit('resumed', { charIndex: offset, restartedFromBoundary: true, hardPaused: true }, session);
        }
        return { ok: true, resumed: true, count: 1, utteranceToken: session.token };
      }
      if (message.type === 'tts:cancel') { const session = active; try { tts.stop(); } catch (_) {} terminal(session, 'cancelled'); return { ok: true, cancelled: true, count: 1 }; }
      return { ok: true, count: 0 };
    }
    return {
      request,
      control,
      voices,
      active: () => active,
      setEventObserver(observer) {
        eventObserver = typeof observer === 'function' ? observer : null;
      },
    };
  }

  function createMessageRouter({ api, storage, session, openVoiceStudio, openDocumentWorkspace, captureVisibleTab, offscreen, systemTts, testProvider, playbackCoordinator }) {
    if (!api) throw new TypeError('缺少本地 TTS 客户端。');
    let requestSequence = 0;

    async function providerValidations() {
      const value = await storage.get(PROVIDER_VALIDATION_KEY);
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    }

    async function invalidateProviderValidation(providerId) {
      const validations = await providerValidations();
      if (!providerId) return;
      delete validations[providerId];
      await storage.set(PROVIDER_VALIDATION_KEY, validations);
    }

    async function profiles() {
      const saved = await storage.get('voiceProfiles');
      return Array.isArray(saved) ? saved : [];
    }

    async function activeProviderId() {
      const saved = await storage.get(SETTINGS_KEY);
      const schema = globalThis.FlowloudSettings;
      return schema ? schema.migrate(saved).activeProviderId : String(saved?.activeProviderId || saved?.providerId || 'browser-system');
    }

    async function requestedProviderId(body) {
      if (body?.providerId) return String(body.providerId);
      const saved = await storage.get(SETTINGS_KEY);
      const explicit = saved && typeof saved === 'object' && !Array.isArray(saved) && (saved.activeProviderId || saved.providerId);
      if (explicit) return activeProviderId();
      // One-version read compatibility: pre-V4 voice messages had no
      // providerId. Legacy Qwen data is now owned by local-service.
      if ((await profiles()).length) return globalThis.FlowloudSettings ? 'local-service' : 'local-qwen';
      return activeProviderId();
    }

    function withIdentity(message) {
      const body = message || {};
      const sessionId = String(body.sessionId || '');
      const clientId = String(body.clientId || sessionId || 'legacy-client');
      const playbackId = String(body.playbackId || sessionId || 'legacy-playback');
      const requestId = String(body.requestId || `${sessionId || clientId}:${++requestSequence}`);
      const normalized = Object.assign({}, body, { clientId, playbackId, requestId });
      if (body.request && typeof body.request === 'object' && !Array.isArray(body.request)) {
        normalized.request = Object.assign({}, body.request, {
          requestId,
          playbackId,
          sessionId,
        });
      }
      return normalized;
    }

    async function forward(message, includeProfiles) {
      if (!offscreen || typeof offscreen.request !== 'function') {
        const error = new Error('后台音频运行环境不可用。');
        error.code = 'offscreen_unavailable';
        throw error;
      }
      const payload = withIdentity(message);
      if (includeProfiles) payload.profiles = await profiles();
      if (/^(tts:|provider:model:)/.test(String(payload.type || '')) || payload.type === 'voice:list') {
        const schema = globalThis.FlowloudSettings;
        if (schema) {
          const settings = schema.migrate(await storage.get(SETTINGS_KEY));
          payload.providerId = String(payload.providerId || settings.activeProviderId);
          payload.playbackRate = schema.rate(payload.playbackRate || settings.playbackRate);
          payload.providerSettings = settings.providerSettings[payload.providerId] || {};
          if (payload.request && typeof payload.request === 'object') {
            payload.request.rate = payload.playbackRate;
            const assignment = settings.voiceAssignmentsByProvider?.[payload.providerId] || {};
            if (!payload.request.voice && assignment.narratorVoiceId) payload.request.voice = assignment.narratorVoiceId;
            if (!payload.request.model && payload.providerSettings.model) payload.request.model = payload.providerSettings.model;
            if (!payload.request.response_format && payload.providerSettings.responseFormat) {
              payload.request.response_format = payload.providerSettings.responseFormat;
            }
          }
          if (payload.providerId === 'openai-compatible' && session) {
            const sessionSecrets = await session.get(schema.SESSION_SECRET_KEY) || {};
            const remembered = await storage.get(schema.REMEMBERED_SECRET_KEY) || {};
            payload.apiKey = sessionSecrets['openai-compatible'] || remembered['openai-compatible'] || '';
          }
          if (payload.providerId === 'doubao-tts' && session) {
            const sessionSecrets = await session.get(schema.SESSION_SECRET_KEY) || {};
            const remembered = await storage.get(schema.REMEMBERED_SECRET_KEY) || {};
            payload.apiKey = sessionSecrets['doubao-tts'] || remembered['doubao-tts'] || '';
          }
          if (payload.providerId === 'local-service' && session) {
            const sessionSecrets = await session.get(schema.SESSION_SECRET_KEY) || {};
            const remembered = await storage.get(schema.REMEMBERED_SECRET_KEY) || {};
            payload.clientToken = sessionSecrets['local-service'] || remembered['local-service']
              || sessionSecrets['local-qwen'] || remembered['local-qwen'] || '';
          }
        }
      }
      if (/^document:(probe|extract|translate|cancel)$/u.test(String(payload.type || ''))) {
        const schema = globalThis.FlowloudSettings;
        if (schema && payload.type !== 'document:cancel') {
          const settings = schema.migrate(await storage.get(SETTINGS_KEY));
          const operation = payload.type.slice('document:'.length);
          const selectedId = String(payload.profileId || (operation === 'extract'
            ? settings.aiProfileSelections?.ocr : settings.aiProfileSelections?.translation) || '');
          const profile = settings.aiProfiles.find((item) => item && item.id === selectedId);
          if (!profile) throw Object.assign(new Error('请选择并配置可用的 AI Profile。'), { code: 'ai_profile_missing' });
          const secretKey = `ai:${profile.id}`;
          const sessionSecrets = session ? await session.get(schema.SESSION_SECRET_KEY) || {} : {};
          const remembered = await storage.get(schema.REMEMBERED_SECRET_KEY) || {};
          payload.profileId = profile.id;
          payload.profile = profile;
          payload.secret = sessionSecrets[secretKey] || remembered[secretKey] || '';
        }
      }
      if (payload.type === 'tts:synthesize' && payload.prefetch !== true && playbackCoordinator) {
        const claimed = await playbackCoordinator.claim(payload);
        if (claimed && claimed.playback) {
          payload.intentSequence = claimed.playback.intentSequence;
          payload.sourceDocumentId = claimed.playback.sourceDocumentId || payload.sourceDocumentId;
          payload.pageKey = claimed.playback.pageKey || payload.pageKey;
        }
      }
      if (payload.providerId === 'browser-system' && systemTts) return systemTts.request(payload);
      return offscreen.request(payload);
    }

    async function deferCleanup(name, activeName) {
      const queued = await storage.get(CLEANUP_QUEUE_KEY);
      const names = [...(Array.isArray(queued) ? queued : []), name]
        .map((item) => String(item || '').trim())
        .filter((item, index, list) => (
          item && item !== activeName && list.indexOf(item) === index
        ));
      await storage.set(CLEANUP_QUEUE_KEY, names);
    }

    async function cleanupPendingVoices() {
      let queued;
      try {
        queued = await storage.get(CLEANUP_QUEUE_KEY);
      } catch (_) {
        return;
      }
      if (!Array.isArray(queued) || !queued.length) return;

      const uniqueNames = queued
        .map((name) => String(name || '').trim())
        .filter((name, index, list) => name && list.indexOf(name) === index);
      const remaining = [];
      for (const name of uniqueNames) {
        try {
          const result = await forward({ type: 'voice:delete', name, providerId: 'local-service' }, false);
          if (!result || !result.ok) remaining.push(name);
        } catch (_) {
          remaining.push(name);
        }
      }
      try {
        await storage.set(CLEANUP_QUEUE_KEY, remaining);
      } catch (_) {
        // Cleanup is best-effort and must never block listing voices.
      }
    }

    return async function route(message) {
      const body = message || {};
      try {
        switch (body.type) {
          case 'settings:get': {
            const schema = globalThis.FlowloudSettings;
            return { ok: true, settings: schema ? schema.migrate(await storage.get(SETTINGS_KEY)) : await storage.get(SETTINGS_KEY) };
          }
          case 'settings:set': {
            const schema = globalThis.FlowloudSettings;
            const current = schema ? schema.migrate(await storage.get(SETTINGS_KEY)) : await storage.get(SETTINGS_KEY);
            const next = schema ? schema.publicSettings(body.settings) : body.settings;
            await storage.set(SETTINGS_KEY, next);
            if (schema) {
              const validations = await providerValidations();
              let changed = false;
              for (const providerId of schema.PROVIDER_IDS) {
                if (JSON.stringify(current?.providerSettings?.[providerId] || {}) !== JSON.stringify(next?.providerSettings?.[providerId] || {})) {
                  delete validations[providerId];
                  changed = true;
                }
              }
              if (changed) await storage.set(PROVIDER_VALIDATION_KEY, validations);
            }
            return { ok: true, settings: next };
          }
          case 'settings:voice:assign': {
            const schema = globalThis.FlowloudSettings;
            if (!schema) throw Object.assign(new Error('设置 Schema 尚未加载。'), { code: 'settings_schema_unavailable' });
            const providerId = String(body.providerId || '');
            if (!schema.PROVIDER_IDS.includes(providerId)) throw Object.assign(new Error('未知的语音来源。'), { code: 'invalid_provider' });
            const requested = body.assignment && typeof body.assignment === 'object' ? body.assignment : {};
            const assertScoped = (voice) => {
              const split = schema.splitVoice(voice);
              if (split.providerId && split.providerId !== providerId) {
                throw Object.assign(new Error('音色与当前语音来源不匹配。'), { code: 'voice_provider_mismatch' });
              }
              return schema.namespaceVoice(providerId, split.voiceId);
            };
            const current = schema.migrate(await storage.get(SETTINGS_KEY));
            const previous = current.voiceAssignmentsByProvider[providerId] || {};
            const authorVoices = Object.assign({}, previous.authorVoices || {});
            if (requested.authorVoices && typeof requested.authorVoices === 'object') {
              for (const [authorId, voice] of Object.entries(requested.authorVoices)) {
                const scoped = assertScoped(voice);
                if (scoped) authorVoices[String(authorId)] = scoped;
                else delete authorVoices[String(authorId)];
              }
            }
            const assignment = schema.normalizeAssignment(providerId, {
              narratorVoiceId: requested.narratorVoiceId === undefined ? previous.narratorVoiceId : assertScoped(requested.narratorVoiceId),
              replyVoiceIds: requested.replyVoiceIds === undefined ? previous.replyVoiceIds : (Array.isArray(requested.replyVoiceIds) ? requested.replyVoiceIds : []).map(assertScoped),
              authorVoices,
            }, previous);
            const next = schema.publicSettings(Object.assign({}, current, {
              activeProviderId: providerId,
              voiceAssignmentsByProvider: Object.assign({}, current.voiceAssignmentsByProvider, { [providerId]: assignment }),
            }));
            await storage.set(SETTINGS_KEY, next);
            return { ok: true, settings: next, assignment: next.voiceAssignmentsByProvider[providerId] };
          }
          case 'settings:reset': {
            const schema = globalThis.FlowloudSettings;
            const current = schema ? schema.migrate(await storage.get(SETTINGS_KEY)) : {};
            const defaults = schema ? schema.migrate(schema.DEFAULTS) : {};
            // Reset preferences without deleting or orphaning downloaded model
            // metadata. Model deletion remains an explicit, separate action.
            defaults.modelCacheRegistry = current.modelCacheRegistry || {};
            if (defaults.providerSettings?.['browser-model'] && current.providerSettings?.['browser-model']) {
              const currentBrowserModel = current.providerSettings['browser-model'];
              const preservedModelKeys = [
                'modelId', 'repoId', 'revision', 'hfRevision', 'source', 'fallbackSource', 'variant', 'dtype',
                'device', 'allowWasmFallback', 'downloadConcurrency', 'starterVoiceIds', 'installMode', 'selectedVoiceIds', 'downloaded',
                'cacheMetadata', 'voiceCacheRegistry', 'configured', 'lastConfiguredAt', 'legacyRevision',
              ];
              for (const key of preservedModelKeys) {
                if (currentBrowserModel[key] !== undefined) {
                  defaults.providerSettings['browser-model'][key] = currentBrowserModel[key];
                }
              }
            }
            const next = schema ? schema.publicSettings(defaults) : defaults;
            await storage.set(SETTINGS_KEY, next);
            return { ok: true, settings: next };
          }
          case 'settings:secrets:status': {
            const schema = globalThis.FlowloudSettings;
            if (!schema) throw Object.assign(new Error('设置 Schema 尚未加载。'), { code: 'settings_schema_unavailable' });
            const sessionSecrets = session ? await session.get(schema.SESSION_SECRET_KEY) || {} : {};
            const rememberedSecrets = await storage.get(schema.REMEMBERED_SECRET_KEY) || {};
            const status = {};
            for (const providerId of ['local-service', 'openai-compatible', 'doubao-tts']) {
              status[providerId] = {
                present: Boolean(sessionSecrets[providerId] || rememberedSecrets[providerId]),
                remembered: Boolean(rememberedSecrets[providerId]),
              };
            }
            const settings = schema.migrate(await storage.get(SETTINGS_KEY));
            for (const profile of settings.aiProfiles) {
              const key = `ai:${profile.id}`;
              status[key] = {
                present: Boolean(sessionSecrets[key] || rememberedSecrets[key]),
                remembered: Boolean(rememberedSecrets[key]),
              };
            }
            return { ok: true, secrets: status };
          }
          case 'settings:secret:set': {
            const schema = globalThis.FlowloudSettings;
            if (!schema) throw Object.assign(new Error('设置 Schema 尚未加载。'), { code: 'settings_schema_unavailable' });
            const providerId = String(body.providerId || body.secretId || '');
            const settings = schema.migrate(await storage.get(SETTINGS_KEY));
            const validAiSecret = providerId.startsWith('ai:')
              && settings.aiProfiles.some((profile) => `ai:${profile.id}` === providerId);
            if (!['local-service', 'openai-compatible', 'doubao-tts'].includes(providerId) && !validAiSecret) {
              throw Object.assign(new Error('不支持保存该 Provider 的凭据。'), { code: 'invalid_secret_provider' });
            }
            const secret = String(body.secret || '').trim();
            if (secret.length > 8192) throw Object.assign(new Error('凭据长度超出限制。'), { code: 'secret_too_long' });
            const sessionSecrets = session ? await session.get(schema.SESSION_SECRET_KEY) || {} : {};
            const rememberedSecrets = await storage.get(schema.REMEMBERED_SECRET_KEY) || {};
            if (secret) sessionSecrets[providerId] = secret;
            else delete sessionSecrets[providerId];
            if (body.remember === true && secret) rememberedSecrets[providerId] = secret;
            else delete rememberedSecrets[providerId];
            if (session) await session.set(schema.SESSION_SECRET_KEY, sessionSecrets);
            await storage.set(schema.REMEMBERED_SECRET_KEY, rememberedSecrets);
            await invalidateProviderValidation(providerId);
            return { ok: true, providerId, present: Boolean(secret), remembered: Boolean(body.remember && secret) };
          }
          case 'reader:position:get':
            return { ok: true, position: await storage.get('qwenReaderMiniPlayerPosition') };
          case 'reader:position:set': {
            const x = Number(body.position && body.position.x);
            const y = Number(body.position && body.position.y);
            if (!Number.isFinite(x) || !Number.isFinite(y)) throw Object.assign(new Error('悬浮播放器位置无效。'), { code: 'invalid_position' });
            const position = { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) };
            await storage.set('qwenReaderMiniPlayerPosition', position);
            return { ok: true, position };
          }
          case 'playback:claim':
            if (!playbackCoordinator) return { ok: false, error: { code: 'playback_coordinator_unavailable', message: '全局播放协调器不可用。' } };
            return playbackCoordinator.claim(body);
          case 'playback:snapshot:get':
          case 'playback:global:get':
            return { ok: true, playback: playbackCoordinator ? await playbackCoordinator.getSnapshot() : { active: false, state: 'idle' } };
          case 'playback:release':
            return { ok: true, playback: playbackCoordinator ? await playbackCoordinator.release(body, body.reason) : { active: false, state: 'idle' } };
          case 'provider:status:list': {
            const schema = globalThis.FlowloudSettings;
            const settings = schema ? schema.migrate(await storage.get(SETTINGS_KEY)) : {};
            const validations = await providerValidations();
            const statuses = (schema?.PROVIDER_IDS || []).map((providerId) => {
              if (providerId === 'browser-system') return { providerId, configured: true, usable: true, connectionState: 'connected', stage: 'voices', message: '浏览器系统音色可用' };
              const validation = validations[providerId];
              const config = settings.providerSettings?.[providerId] || {};
              const configured = providerId === 'browser-model'
                ? Boolean(config.downloaded || config.configured || Object.keys(config.voiceCacheRegistry || {}).length)
                : providerId === 'local-service'
                  ? Boolean(config.configured || config.lastConfiguredAt)
                  : providerId === 'openai-compatible'
                    ? Boolean(config.baseUrl && config.model && (config.voiceIds || []).length)
                    : Boolean(config.appId && (config.voiceIds || []).length);
              return validation || { providerId, configured, usable: false, connectionState: configured ? 'unavailable' : 'unconfigured', stage: 'configuration', message: configured ? '已配置，等待验证' : '尚未配置' };
            });
            return { ok: true, statuses };
          }
          case 'provider:test': {
            if (typeof testProvider !== 'function') throw Object.assign(new Error('朗读引擎测试不可用。'), { code: 'provider_test_unavailable' });
            const providerId = String(body.providerId || '');
            try {
              const result = await testProvider(providerId, body);
              const validations = await providerValidations();
              const now = new Date().toISOString();
              validations[providerId] = {
                providerId, configured: true, usable: true, connectionState: 'connected',
                stage: String(result.stage || 'synthesize'), verifiedAt: now,
                voiceCount: Number(result.voiceCount) || undefined,
                message: String(result.message || `已验证 · ${now}`),
              };
              await storage.set(PROVIDER_VALIDATION_KEY, validations);
              return Object.assign({}, result, { verifiedAt: now });
            } catch (error) {
              const validations = await providerValidations();
              validations[providerId] = {
                providerId, configured: true, usable: false, connectionState: 'failed',
                stage: String(error.stage || 'configuration'), verifiedAt: new Date().toISOString(),
                message: String(error.message || '验证失败'),
              };
              await storage.set(PROVIDER_VALIDATION_KEY, validations);
              throw error;
            }
          }

          case 'document:workspace:open':
            if (typeof openDocumentWorkspace !== 'function') throw Object.assign(new Error('文档工作台暂时无法打开。'), { code: 'document_workspace_unavailable' });
            await openDocumentWorkspace(Number(body.tabId));
            return { ok: true };
          case 'document:workspace:seed': {
            const seed = session ? await session.get(DOCUMENT_WORKSPACE_SEED_KEY) : null;
            return { ok: true, seed: seed && typeof seed === 'object' ? seed : {} };
          }
          case 'document:capture-visible':
            if (typeof captureVisibleTab !== 'function') throw Object.assign(new Error('当前浏览器无法截取可见区域。'), { code: 'capture_unavailable' });
            return { ok: true, dataUrl: await captureVisibleTab() };
          case 'document:probe':
          case 'document:extract':
          case 'document:translate':
          case 'document:cancel':
            return await forward(body, false);

          case 'provider:model:info':
          case 'provider:model:download':
          case 'provider:model:verify':
          case 'provider:model:delete':
          case 'provider:model:cancel':
          case 'provider:model:voice-list':
          case 'provider:model:voice-info':
          case 'provider:model:voice-download':
          case 'provider:model:voice-repair':
          case 'provider:model:voice-delete':
          case 'provider:model:voice-batch': {
            const response = await forward(Object.assign({}, body, { providerId: 'browser-model' }), false);
            if (response?.ok === false || !['provider:model:download', 'provider:model:verify', 'provider:model:delete', 'provider:model:voice-list', 'provider:model:voice-info', 'provider:model:voice-download', 'provider:model:voice-repair', 'provider:model:voice-delete', 'provider:model:voice-batch'].includes(body.type)) return response;
            const schema = globalThis.FlowloudSettings;
            const settings = schema ? schema.migrate(await storage.get(SETTINGS_KEY)) : await storage.get(SETTINGS_KEY);
            const result = response?.result && typeof response.result === 'object' ? response.result : {};
            const browserModel = settings?.providerSettings?.['browser-model'];
            if (!browserModel) return response;
            if (body.type === 'provider:model:voice-list' || body.type === 'provider:model:voice-info') return response;
            settings.modelCacheRegistry = Object.assign({}, settings.modelCacheRegistry || {});
            if (body.type === 'provider:model:delete') {
              browserModel.downloaded = false;
              browserModel.cacheMetadata = {};
              if (result.cacheId) delete settings.modelCacheRegistry[result.cacheId];
            } else if (body.type === 'provider:model:voice-download' || body.type === 'provider:model:voice-repair' || body.type === 'provider:model:voice-delete') {
              const voiceId = String(result.voiceId || body.voiceId || body.voice || '').replace(/^browser-model:/u, '');
              browserModel.voiceCacheRegistry = Object.assign({}, browserModel.voiceCacheRegistry || {});
              if (voiceId) browserModel.voiceCacheRegistry[voiceId] = Object.assign({}, browserModel.voiceCacheRegistry[voiceId] || {}, result, {
                voiceId, cached: body.type === 'provider:model:voice-delete' ? false : result.cached !== false,
              });
            } else if (body.type === 'provider:model:voice-batch') {
              browserModel.voiceCacheRegistry = Object.assign({}, browserModel.voiceCacheRegistry || {});
              const items = Array.isArray(result.results) ? result.results : [];
              for (const item of items) {
                const voiceId = String(item.voiceId || '').replace(/^browser-model:/u, '');
                if (!voiceId) continue;
                const itemResult = item.result && typeof item.result === 'object' ? item.result : {};
                const deleted = String(result.action || body.action || 'download') === 'delete';
                browserModel.voiceCacheRegistry[voiceId] = Object.assign({}, browserModel.voiceCacheRegistry[voiceId] || {}, itemResult, {
                  voiceId, cached: deleted ? false : item.status !== 'failed' && item.cached !== false,
                });
              }
            } else {
              browserModel.downloaded = result.ready === true;
              browserModel.cacheMetadata = Object.assign({}, result);
              if (Array.isArray(result.downloadedVoiceIds)) {
                browserModel.voiceCacheRegistry = Object.assign({}, browserModel.voiceCacheRegistry || {});
                for (const rawVoiceId of result.downloadedVoiceIds) {
                  const voiceId = String(rawVoiceId || '').replace(/^browser-model:/u, '');
                  if (!voiceId) continue;
                  browserModel.voiceCacheRegistry[voiceId] = Object.assign({}, browserModel.voiceCacheRegistry[voiceId] || {}, {
                    voiceId,
                    cached: true,
                    downloadedAt: result.downloadedAt || new Date().toISOString(),
                    source: result.source,
                  });
                }
              }
              if (result.cacheId) settings.modelCacheRegistry[result.cacheId] = Object.assign({}, settings.modelCacheRegistry[result.cacheId] || {}, result);
            }
            await storage.set(SETTINGS_KEY, schema ? schema.publicSettings(settings) : settings);
            return response;
          }

          case 'model:list': {
            const schema = globalThis.FlowloudSettings;
            const settings = schema ? schema.migrate(await storage.get(SETTINGS_KEY)) : await storage.get(SETTINGS_KEY);
            const cacheNames = typeof caches !== 'undefined' ? await caches.keys() : [];
            const registry = settings?.modelCacheRegistry || {};
            return { ok: true, models: cacheNames.filter((name) => name.startsWith('flowloud-model-')).map((cacheId) => Object.assign({ cacheId, cached: true }, registry[cacheId] || {})) };
          }
          case 'model:delete': {
            const cacheId = String(body.cacheId || '');
            if (!cacheId.startsWith('flowloud-model-')) throw Object.assign(new Error('模型缓存标识无效。'), { code: 'invalid_cache_id' });
            const result = await forward({ type: 'provider:model:delete', providerId: 'browser-model', cacheId }, false);
            if (typeof caches !== 'undefined') await caches.delete(cacheId);
            const schema = globalThis.FlowloudSettings;
            const settings = schema ? schema.migrate(await storage.get(SETTINGS_KEY)) : await storage.get(SETTINGS_KEY);
            if (settings?.modelCacheRegistry) delete settings.modelCacheRegistry[cacheId];
            if (settings?.providerSettings?.['browser-model']) settings.providerSettings['browser-model'].downloaded = false;
            await storage.set(SETTINGS_KEY, schema ? schema.publicSettings(settings) : settings);
            return Object.assign({ ok: true, cacheId }, result || {});
          }
          case 'legacy-data:inspect': {
            const savedProfiles = await profiles();
            const cacheNames = typeof caches !== 'undefined' ? await caches.keys() : [];
            const settings = globalThis.FlowloudSettings?.migrate(await storage.get(SETTINGS_KEY));
            return { ok: true, legacy: {
              localQwenVoices: savedProfiles.length,
              localQwenAudioBytes: savedProfiles.reduce((total, profile) => total + Math.max(0, Number(profile?.size || profile?.audioBytes) || 0), 0),
              modelCaches: cacheNames.filter((name) => name.startsWith('flowloud-model-')),
              state: settings?.legacyDataState || {},
            } };
          }
          case 'legacy-data:delete': {
            const targets = Array.isArray(body.targets) ? body.targets.map(String) : [];
            const deleted = { localQwenVoices: 0, modelCaches: [] };
            if (targets.includes('local-qwen-voices')) {
              const savedProfiles = await profiles();
              deleted.localQwenVoices = savedProfiles.length;
              await storage.set('voiceProfiles', []);
              await storage.set(CLEANUP_QUEUE_KEY, []);
            }
            for (const target of targets.filter((value) => value.startsWith('flowloud-model-'))) {
              if (typeof caches !== 'undefined' && await caches.delete(target)) deleted.modelCaches.push(target);
            }
            return { ok: true, deleted };
          }

          case 'tts:status':
            if (offscreen && typeof offscreen.request === 'function') {
              return await forward(body, false);
            }
            return { ok: true, status: await api.status() };

          case 'tts:voices':
          case 'tts:synthesize':
            return await forward(body, true);

          case 'voice:list':
            {
              const providerId = await requestedProviderId(body);
              const editableLocal = providerId === 'local-service' || providerId === 'local-qwen';
              if (editableLocal) await cleanupPendingVoices();
              const result = await forward(Object.assign({}, body, { providerId }), editableLocal);
              if (!result || !result.ok || !Array.isArray(result.voices)) return result;
              if (!editableLocal) {
                return Object.assign({}, result, {
                  voices: result.voices.map((voice) => {
                    const sourceVoice = voice && typeof voice === 'object' ? voice : {};
                    return Object.assign({}, sourceVoice, {
                      providerId,
                      local: false,
                      editable: false,
                      readOnly: true,
                      source: providerId === 'browser-system' ? 'system' : sourceVoice.source || 'provider',
                    });
                  }),
                });
              }
              const savedProfiles = await profiles();
              const profileByName = new Map(savedProfiles
                .filter((profile) => profile && profile.name)
                .map((profile) => [String(profile.name), profile]));
              return Object.assign({}, result, {
                voices: result.voices.map((voice) => {
                  const sourceVoice = voice && typeof voice === 'object' ? voice : {};
                  const profile = profileByName.get(String(sourceVoice.name || ''));
                  const editable = Boolean(profile && !isReadOnlyProfile(profile));
                  const presented = Object.assign({}, sourceVoice, {
                    local: editable,
                    editable,
                    readOnly: !editable,
                    source: editable ? 'browser' : 'backend',
                  });
                  if (editable) {
                    presented.sourceFileName = String(profile.sourceFileName || '');
                    presented.durationSeconds = Number(profile.durationSeconds) || 0;
                    presented.refText = String(profile.refText || profile.ref_text || '');
                  }
                  return presented;
                }),
              });
            }

          case 'tts:cancel':
            {
              const control = playbackCoordinator ? await playbackCoordinator.resolve(body) : body;
              let result;
              if (systemTts && String(control.providerId || await activeProviderId()) === 'browser-system') result = await systemTts.control(control);
              else if (!offscreen || typeof offscreen.cancel !== 'function') result = { ok: true, cancelled: false, count: 0 };
              else result = await offscreen.cancel(control);
              if (playbackCoordinator) await playbackCoordinator.release(control, body.reason || 'cancelled');
              return result;
            }

          case 'tts:pause':
          case 'tts:resume':
            {
              const resolved = playbackCoordinator ? await playbackCoordinator.resolve(body) : body;
              const control = withIdentity(resolved);
              let result;
              if (systemTts && String(control.providerId || await activeProviderId()) === 'browser-system') result = await systemTts.control(control);
              else if (!offscreen || typeof offscreen.control !== 'function') {
                result = {
                  ok: false,
                  error: {
                    code: 'offscreen_unavailable',
                    message: '后台音频运行环境不可用。',
                    retryable: true,
                  },
                  count: 0,
                };
              } else result = await offscreen.control(control);
              if (playbackCoordinator && result && result.ok !== false) {
                await playbackCoordinator.update({
                  state: body.type === 'tts:pause' ? (result.paused ? 'paused' : 'loading') : (result.resumed ? 'playing' : 'loading'),
                  desiredPaused: body.type === 'tts:pause',
                }, control);
              }
              return result;
            }

          case 'voice:save': {
            const profile = body.profile || {};
            const saved = await profiles();
            const previousProfile = saved.find((item) => item && item.name === profile.name) || null;
            const result = await forward(body, false);
            if (!result || !result.ok) return result;
            const nextProfiles = saved.slice();
            const index = nextProfiles.findIndex((item) => item && item.name === profile.name);
            if (index >= 0) nextProfiles[index] = profile;
            else nextProfiles.push(profile);
            try {
              await storage.set('voiceProfiles', nextProfiles);
            } catch (error) {
              try {
                if (previousProfile) {
                  await forward({ type: 'voice:save', profile: previousProfile }, false);
                } else {
                  await forward({ type: 'voice:delete', name: profile.name }, false);
                }
              } catch (_) {
                // The storage failure remains primary; rollback is best-effort.
              }
              throw error;
            }
            return result;
          }

          case 'voice:rename': {
            const saved = await profiles();
            const currentSettings = await storage.get(SETTINGS_KEY);
            const matchedProfile = saved.find((profile) => profile && profile.name === body.oldName);
            if (!matchedProfile || isReadOnlyProfile(matchedProfile)) {
              const error = new Error('该音色为只读，无法重命名。');
              error.code = 'voice_read_only';
              throw error;
            }
            const plan = voiceLibrary.planRename(
              saved,
              currentSettings,
              body.oldName,
              body.newName,
            );
            const registered = await forward({ type: 'voice:save', profile: plan.newProfile }, false);
            if (!registered || !registered.ok) return registered;
            try {
              await storage.setMany({
                voiceProfiles: plan.profiles,
                [SETTINGS_KEY]: plan.settings,
              });
            } catch (error) {
              try {
                await forward({ type: 'voice:delete', name: plan.newProfile.name }, false);
              } catch (_) {
                // The storage error remains the primary transaction failure.
              }
              throw error;
            }

            let deleted;
            try {
              deleted = await forward({ type: 'voice:delete', name: body.oldName }, false);
            } catch (_) {
              deleted = null;
            }
            if (deleted && deleted.ok) return deleted;

            await deferCleanup(body.oldName, plan.newProfile.name);
            return {
              ok: true,
              warning: {
                code: 'old_voice_cleanup_pending',
                message: '旧音色将在下次列出音色时重试清理。',
              },
            };
          }

          case 'voice:delete': {
            const name = String(body.name || '');
            const saved = (await profiles()).filter((profile) => profile && profile.name !== name);
            const currentSettings = await storage.get(SETTINGS_KEY);
            const repairedSettings = repairVoiceSettings(currentSettings, name, saved);
            const result = await forward(body, false);
            if (!result || !result.ok) return result;
            await storage.set('voiceProfiles', saved);
            if (repairedSettings) await storage.set(SETTINGS_KEY, repairedSettings);
            return result;
          }

          case 'voice:studio:open':
            if (typeof openVoiceStudio !== 'function') {
              throw new Error('音色录制室暂时无法打开。');
            }
            await openVoiceStudio(String(body.providerId || 'local-service'));
            return { ok: true };

          default:
            return { ok: false, error: { code: 'unknown_message', message: '不支持的扩展请求。' } };
        }
      } catch (error) {
        return errorEnvelope(error);
      }
    };
  }

  async function cancelPlaybackForTab(offscreen, tabId, reason) {
    const sourceTabId = Number(tabId);
    if (!Number.isInteger(sourceTabId) || sourceTabId < 0) {
      return { ok: false, error: { code: 'invalid_source_tab', message: '来源标签页无效。' } };
    }
    if (!offscreen || typeof offscreen.cancel !== 'function') {
      return { ok: true, cancelled: false, count: 0 };
    }
    try {
      return await offscreen.cancel({
        type: 'tts:cancel',
        sourceTabId,
        reason: String(reason || 'source-tab-closed'),
      });
    } catch (_) {
      return { ok: true, cancelled: false, count: 0 };
    }
  }

  // The popup is transient, so it owns a fixed tab target for its lifetime and
  // requests a compact snapshot from the content script. Playback itself stays
  // in the page/offscreen pipeline when the popup closes.
  function createPopupBroker(chromeApi, options) {
    const config = options || {};
    const session = config.session || chromeSessionStorage(chromeApi);
    const onSnapshot = typeof config.onSnapshot === 'function' ? config.onSnapshot : () => {};
    const getGlobalPlayback = typeof config.getGlobalPlayback === 'function'
      ? config.getGlobalPlayback : async () => ({ active: false, state: 'idle' });
    let targetMemory = null;
    const snapshots = new Map();
    let enabledTabs = null;
    const contentScriptFiles = [
      'shared/defaults.js', 'shared/settings-schema.js', 'shared/text.js', 'shared/forum-content.js',
      'shared/generic-thread-detector.js', 'vendor/readability/Readability.js', 'shared/normalized-document.js',
      'shared/extractors.js', 'shared/sentence-range.js', 'shared/marker-placement.js', 'shared/source-locator.js',
      'shared/follow-controller.js', 'shared/voice-assignment.js', 'shared/player-state.js', 'shared/word-timeline.js',
      'shared/semantic-guide.js', 'content/page-guide-content.js', 'content/reader.js',
    ];

    async function readEnabledTabs() {
      if (enabledTabs) return enabledTabs;
      const stored = await session.get(READER_ENABLED_TABS_KEY);
      enabledTabs = new Set((Array.isArray(stored) ? stored : [])
        .map((tabId) => Number(tabId))
        .filter((tabId) => Number.isInteger(tabId) && tabId >= 0));
      return enabledTabs;
    }

    async function rememberEnabledTab(tabId) {
      const numericId = Number(tabId);
      if (!Number.isInteger(numericId) || numericId < 0) return false;
      const tabs = await readEnabledTabs();
      if (tabs.has(numericId)) return true;
      tabs.add(numericId);
      await session.set(READER_ENABLED_TABS_KEY, Array.from(tabs));
      return true;
    }

    async function forgetEnabledTab(tabId) {
      const numericId = Number(tabId);
      const tabs = await readEnabledTabs();
      if (!tabs.delete(numericId)) return;
      await session.set(READER_ENABLED_TABS_KEY, Array.from(tabs));
    }

    async function injectContentScripts(tabId) {
      if (!chromeApi.scripting?.executeScript) return false;
      const tab = chromeApi.tabs?.get ? await chromeApi.tabs.get(tabId) : null;
      if (tab?.url && !/^https?:/i.test(tab.url)) return false;
      await chromeApi.scripting.insertCSS({ target: { tabId }, files: ['content/page-highlight.css'] });
      await chromeApi.scripting.executeScript({ target: { tabId }, files: contentScriptFiles });
      await rememberEnabledTab(tabId);
      return true;
    }

    async function hasPersistentTabAccess(tabId) {
      if (!chromeApi.permissions?.contains || !chromeApi.storage?.local?.get) return false;
      const tab = chromeApi.tabs?.get ? await chromeApi.tabs.get(tabId) : null;
      if (!tab?.url || !/^https?:/i.test(tab.url)) return false;
      const saved = await chromeApi.storage.local.get(SETTINGS_KEY);
      const storedSettings = saved && saved[SETTINGS_KEY];
      const settings = globalThis.FlowloudSettings?.migrate(storedSettings) || storedSettings || {};
      if (settings.showFloatingPlayer === false) return false;
      const origin = `${new URL(tab.url).origin}/*`;
      return chromeApi.permissions.contains({ origins: [origin] });
    }

    async function ensureInjected(tabId) {
      const tabs = await readEnabledTabs();
      if (!tabs.has(Number(tabId)) && !await hasPersistentTabAccess(tabId)) return false;
      try {
        return await injectContentScripts(tabId);
      } catch (error) {
        console.warn('[Flowloud] 无法在页面加载后恢复悬浮播放器。', error && error.message ? error.message : error);
        return false;
      }
    }

    async function readSnapshots() {
      if (snapshots.size) return snapshots;
      const stored = await session.get(POPUP_SNAPSHOTS_KEY);
      if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
        Object.entries(stored).forEach(([tabId, snapshot]) => {
          if (snapshot && typeof snapshot === 'object') snapshots.set(String(tabId), snapshot);
        });
      }
      return snapshots;
    }

    async function persistSnapshots() {
      const stored = {};
      snapshots.forEach((snapshot, tabId) => { stored[tabId] = snapshot; });
      await session.set(POPUP_SNAPSHOTS_KEY, stored);
    }

    async function persistTarget(target) {
      if (target) await session.set(POPUP_TARGET_KEY, target);
      else await session.remove(POPUP_TARGET_KEY);
    }

    async function tabStillExists(target) {
      if (!target) return false;
      if (!chromeApi.tabs || typeof chromeApi.tabs.get !== 'function') return true;
      try {
        const tab = await chromeApi.tabs.get(target.tabId);
        return Boolean(tab && tab.id != null);
      } catch (_) {
        return false;
      }
    }

    async function queryActiveTab() {
      if (!chromeApi.tabs || typeof chromeApi.tabs.query !== 'function') return null;
      const tabs = await chromeApi.tabs.query({ active: true, currentWindow: true });
      return normalizeTabTarget(Array.isArray(tabs) ? tabs[0] : null);
    }

    async function restoreTarget() {
      if (targetMemory) return targetMemory;
      const stored = await session.get(POPUP_TARGET_KEY);
      if (stored && stored.tabId != null && await tabStillExists(stored)) {
        targetMemory = normalizeTabTarget(stored);
      }
      return targetMemory;
    }

    async function beginTarget(force) {
      if (!force) {
        const restored = await restoreTarget();
        if (restored) return restored;
      }
      targetMemory = await queryActiveTab();
      await persistTarget(targetMemory);
      return targetMemory;
    }

    async function getTarget() {
      return (await restoreTarget()) || beginTarget(false);
    }

    async function targetForTab(tabId) {
      if (tabId == null || tabId === '') return getTarget();
      const numericId = Number(tabId);
      if (!Number.isFinite(numericId)) return getTarget();
      const existing = await getTarget();
      if (existing && existing.tabId === numericId) return existing;
      if (chromeApi.tabs && typeof chromeApi.tabs.get === 'function') {
        try {
          return normalizeTabTarget(await chromeApi.tabs.get(numericId));
        } catch (_) {}
      }
      return normalizeTabTarget({ id: numericId });
    }

    async function clearTarget() {
      targetMemory = null;
      await persistTarget(null);
    }

    async function sendToTarget(target, message) {
      if (!target || target.tabId == null) {
        return { ok: false, error: { code: 'popup_target_unavailable', message: '没有找到可控制的网页标签页。' } };
      }
      if (!chromeApi.tabs || typeof chromeApi.tabs.sendMessage !== 'function') {
        return { ok: false, error: { code: 'tabs_unavailable', message: '当前浏览器不支持向网页发送朗读控制。' } };
      }
      try {
        const response = await chromeApi.tabs.sendMessage(target.tabId, message);
        return { ok: true, response: response == null ? null : response };
      } catch (error) {
        try {
          if (await injectContentScripts(target.tabId)) {
            const response = await chromeApi.tabs.sendMessage(target.tabId, message);
            return { ok: true, response: response == null ? null : response };
          }
        } catch (_) {
          // Return the original delivery error with a stable, readable code.
        }
        return {
          ok: false,
          error: {
            code: 'content_script_unavailable',
            message: error && error.message ? error.message : '当前页面暂时不能接收朗读控制。',
          },
        };
      }
    }

    async function rememberSnapshot(target, value) {
      const snapshot = snapshotFromMessage(value);
      if (!target || !snapshot) return null;
      if (targetMemory && targetMemory.tabId === target.tabId) {
        targetMemory = Object.assign({}, targetMemory, {
          pageKey: snapshot.pageKey || targetMemory.pageKey || '',
          title: snapshot.title || targetMemory.title || '',
        });
        await persistTarget(targetMemory);
      }
      await readSnapshots();
      snapshots.set(String(target.tabId), snapshot);
      await persistSnapshots();
      onSnapshot(target, snapshot);
      return snapshot;
    }

    async function requestSnapshot(target) {
      const sent = await sendToTarget(target, { type: 'reader:snapshot:get', request: 'snapshot', source: 'popup' });
      const body = sent.response;
      const snapshot = body && (body.snapshot || body.state || body.player)
        ? await rememberSnapshot(target, body)
        : (await readSnapshots()).get(String(target && target.tabId)) || null;
      if (body && body.ok === false) {
        return Object.assign({}, sent, { ok: false, error: body.error, target, snapshot });
      }
      return Object.assign({}, sent, { target, snapshot });
    }

    async function sendCommand(target, message) {
      const command = normalizeCommand(message);
      if (!command) return { ok: false, error: { code: 'invalid_command', message: '缺少朗读控制命令。' } };
      const payload = {
        type: 'reader:command',
        command,
        action: command,
        source: message && message.source ? String(message.source) : 'popup',
        contextId: message && message.contextId ? String(message.contextId) : '',
        pageKey: message && message.pageKey
          ? String(message.pageKey)
          : target && target.pageKey ? String(target.pageKey) : '',
      };
      if (message && message.value !== undefined) payload.value = message.value;
      if (message && message.index !== undefined) payload.index = message.index;
      if (message && message.payload && typeof message.payload === 'object') payload.payload = message.payload;
      const sent = await sendToTarget(target, payload);
      const body = sent.response;
      const snapshot = body && (body.snapshot || body.state || body.player)
        ? await rememberSnapshot(target, body)
        : null;
      return Object.assign({}, sent, { target, command, snapshot });
    }

    async function handlePageVoices(target, message) {
      if (!target || target.tabId == null) {
        return { ok: false, error: { code: 'popup_target_unavailable', message: '没有找到要调整配音的网页。' } };
      }
      const pageKey = String(message && message.pageKey || target.pageKey || '');
      const payload = {
        type: message.type === 'reader:page-voices:apply'
          ? 'reader:page-context:apply'
          : 'reader:page-context:get',
        source: 'popup',
        pageKey,
      };
      if (payload.type === 'reader:page-context:apply') {
        const authorVoices = {};
        (Array.isArray(message.assignments) ? message.assignments : []).forEach((assignment) => {
          const authorId = String(assignment && assignment.authorId || '').trim();
          const voice = String(assignment && assignment.voice || '').trim();
          if (authorId && voice) authorVoices[authorId] = voice;
        });
        payload.context = { pageKey, authorVoices };
      }
      const sent = await sendToTarget(target, payload);
      if (!sent.ok) return sent;
      const body = sent.response && typeof sent.response === 'object' ? sent.response : {};
      if (body.ok === false) return body;
      return Object.assign({ ok: true }, body);
    }

    async function handleReaderMessage(message) {
      // Opening a new toolbar popup always starts from the tab that is active
      // at that moment. Follow-up snapshot and command messages carry tabId,
      // so they remain pinned even if the user changes tabs while it is open.
      const currentTarget = message && message.type === 'reader:active-context' && message.tabId == null
        ? await beginTarget(true)
        : await targetForTab(message && message.tabId);
      const globalPlayback = await getGlobalPlayback();
      const useCurrent = message && (message.scope === 'current' || message.takeover === true);
      const target = globalPlayback && globalPlayback.active && !useCurrent
        ? await targetForTab(globalPlayback.sourceTabId)
        : currentTarget;
      switch (message && message.type) {
        case 'reader:active-context': {
          const result = await requestSnapshot(target);
          if (!result.ok && !result.snapshot) {
            return { ok: false, error: result.error || { code: 'reader_unavailable', message: '当前页面暂时不能朗读。' } };
          }
          const snapshot = result.snapshot || {};
          return Object.assign({}, target || {}, {
            tabId: target && target.tabId,
            pageKey: snapshot.pageKey || target && target.pageKey || '',
            title: snapshot.title || target && target.title || '',
            status: snapshot.status || 'idle',
            index: snapshot.index || 0,
            total: snapshot.total || 0,
            authors: snapshot.authorSummary || [],
            snapshot,
            currentTab: currentTarget,
            globalPlayback,
            controllingGlobalPlayback: Boolean(globalPlayback && globalPlayback.active),
            sourceIsCurrentTab: Boolean(globalPlayback && globalPlayback.active && currentTarget && Number(globalPlayback.sourceTabId) === Number(currentTarget.tabId)),
          });
        }
        case 'reader:snapshot:get': {
          const result = await requestSnapshot(target);
          return result.snapshot || { status: 'idle', index: 0, total: 0, current: null };
        }
        case 'reader:document:get': {
          const sent = await sendToTarget(target, { type: 'reader:document:get', source: 'document-workbench' });
          if (!sent.ok) return sent;
          const body = sent.response && typeof sent.response === 'object' ? sent.response : {};
          return Object.assign({ ok: true }, body);
        }
        case 'reader:command': {
          const result = await sendCommand(target, message);
          const body = result.response && typeof result.response === 'object' ? result.response : {};
          if (!result.ok || body.ok === false) {
            return { ok: false, error: body.error || result.error || { code: 'reader_unavailable', message: '当前页面暂时不能朗读。' }, snapshot: result.snapshot || null };
          }
          return Object.assign({}, body, { ok: true, snapshot: result.snapshot || snapshotFromMessage(body) || null });
        }
        case 'reader:page-voices:get':
        case 'reader:page-voices:apply':
          return handlePageVoices(target, message);
        default:
          return { ok: false, error: { code: 'unknown_message', message: '不支持的网页朗读请求。' } };
      }
    }

    async function handle(message) {
      switch (message && message.type) {
        case 'popup:init':
        case 'popup:target': {
          const currentTarget = await beginTarget(true);
          const globalPlayback = await getGlobalPlayback();
          const target = globalPlayback.active
            ? await targetForTab(globalPlayback.sourceTabId) : currentTarget;
          return Object.assign({ ok: Boolean(target), target, currentTarget, globalPlayback }, await requestSnapshot(target));
        }
        case 'popup:snapshot':
        case 'popup:get-state':
          return requestSnapshot(await getTarget());
        case 'popup:command': {
          const globalPlayback = await getGlobalPlayback();
          const target = globalPlayback.active && message.scope !== 'current' && message.takeover !== true
            ? await targetForTab(globalPlayback.sourceTabId) : await getTarget();
          return sendCommand(target, message);
        }
        case 'popup:reset-target':
          await clearTarget();
          return { ok: true, target: null };
        case 'reader:active-context':
        case 'reader:snapshot:get':
        case 'reader:document:get':
        case 'reader:command':
        case 'reader:page-voices:get':
        case 'reader:page-voices:apply':
          return handleReaderMessage(message);
        default:
          return { ok: false, error: { code: 'unknown_message', message: '不支持的 Popup 请求。' } };
      }
    }

    async function acceptSnapshot(message, sender) {
      if (!sender || !sender.tab || sender.tab.id == null) return false;
      await rememberEnabledTab(sender.tab.id);
      return Boolean(await rememberSnapshot(normalizeTabTarget(sender.tab), message));
    }

    async function forgetTab(tabId, disableReader) {
      const numericId = Number(tabId);
      if (targetMemory && targetMemory.tabId === numericId) await clearTarget();
      await readSnapshots();
      snapshots.delete(String(numericId));
      await persistSnapshots();
      if (disableReader) await forgetEnabledTab(numericId);
    }

    return { beginTarget, getTarget, clearTarget, sendToTarget, sendCommand, requestSnapshot, targetForTab, handleReaderMessage, handle, acceptSnapshot, forgetTab, ensureInjected };
  }

  function createPageEditorBroker(chromeApi, options) {
    const config = options || {};
    const session = config.session || chromeSessionStorage(chromeApi);
    const sendCommand = typeof config.sendCommand === 'function' ? config.sendCommand : null;
    let contexts = null;

    async function readContexts() {
      if (contexts) return contexts;
      const stored = await session.get(PAGE_EDITOR_CONTEXTS_KEY);
      contexts = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
      return contexts;
    }

    async function persist() {
      await session.set(PAGE_EDITOR_CONTEXTS_KEY, contexts || {});
    }

    function makeContextId() {
      return globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
        ? `qwen-page-${globalThis.crypto.randomUUID()}`
        : `qwen-page-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }

    async function open(body, sender, fallbackTarget) {
      const contextId = String(body && body.contextId || makeContextId());
      const map = await readContexts();
      const existing = map[contextId];
      const tabId = fallbackTarget && fallbackTarget.tabId != null
        ? Number(fallbackTarget.tabId)
        : sender && sender.tab && sender.tab.id != null ? Number(sender.tab.id)
          : existing && existing.tabId != null ? Number(existing.tabId) : null;
      const pageKey = String(fallbackTarget && fallbackTarget.pageKey || existing && existing.pageKey || '');
      if (tabId == null) return { ok: false, error: { code: 'page_context_missing', message: '没有找到要编辑的页面。' } };
      if (!chromeApi.tabs || typeof chromeApi.tabs.create !== 'function') {
        return { ok: false, error: { code: 'tabs_unavailable', message: '当前浏览器无法打开页面编辑器。' } };
      }
      const url = chromeApi.runtime.getURL(`${PAGE_EDITOR_PATH}?${new URLSearchParams({ contextId }).toString()}`);
      try {
        const editorTab = await chromeApi.tabs.create({ url, openerTabId: tabId });
        map[contextId] = { contextId, tabId, pageKey, editorTabId: editorTab && editorTab.id != null ? Number(editorTab.id) : null, updatedAt: Date.now() };
        await persist();
        return { ok: true, context: map[contextId], tab: editorTab || null };
      } catch (error) {
        return { ok: false, error: { code: 'page_editor_open_failed', message: error && error.message || '无法打开页面编辑器。' } };
      }
    }

    async function getContext(body) {
      const map = await readContexts();
      const contextId = String(body && body.contextId || '');
      return { ok: true, context: contextId ? map[contextId] || null : map };
    }

    async function command(body) {
      const map = await readContexts();
      const context = map[String(body && body.contextId || '')];
      if (!context || context.tabId == null) return { ok: false, error: { code: 'page_context_missing', message: '页面编辑上下文已失效，请重新打开。' } };
      if (sendCommand) return sendCommand({ tabId: context.tabId, pageKey: context.pageKey }, Object.assign({}, body, { source: 'page-editor', pageKey: context.pageKey }));
      const payload = Object.assign({}, body, { type: 'ui:command', command: normalizeCommand(body), pageKey: context.pageKey });
      try {
        const response = await chromeApi.tabs.sendMessage(context.tabId, payload);
        return { ok: true, context, response: response || null };
      } catch (error) {
        return { ok: false, error: { code: 'content_script_unavailable', message: error && error.message || '原页面暂时无法接收编辑操作。' } };
      }
    }

    async function close(body) {
      const map = await readContexts();
      const contextId = String(body && body.contextId || '');
      if (contextId) delete map[contextId];
      await persist();
      return { ok: true };
    }

    async function handle(body, sender, fallbackTarget) {
      switch (body && body.type) {
        case 'page-editor:open':
        case 'page-editor:init':
        case 'page-voices:open':
        case 'reader:page-editor:open': return open(body, sender, fallbackTarget);
        case 'page-editor:get-context':
        case 'page-editor:context': return getContext(body);
        case 'page-editor:command': return command(body);
        case 'page-editor:close': return close(body);
        default: return { ok: false, error: { code: 'unknown_message', message: '不支持的页面编辑请求。' } };
      }
    }

    async function forgetTab(tabId) {
      const map = await readContexts();
      const numericId = Number(tabId);
      Object.keys(map).forEach((contextId) => {
        const context = map[contextId];
        if (context && (Number(context.tabId) === numericId || Number(context.editorTabId) === numericId)) delete map[contextId];
      });
      await persist();
    }

    return { handle, open, getContext, command, close, forgetTab };
  }

  function install(chromeApi) {
    const storage = chromeStorage(chromeApi);
    const session = chromeSessionStorage(chromeApi);
    const api = apiModule.createApiClient({ storage });
    const offscreen = createOffscreenManager(chromeApi);
    const systemTts = createChromeTtsManager(chromeApi);
    for (const area of [chromeApi.storage.session, chromeApi.storage.local]) {
      try {
        const result = area?.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' });
        if (result && typeof result.catch === 'function') result.catch(() => {});
      } catch (_) { /* Older Chromium builds may not expose storage access levels. */ }
    }
    const openVoiceStudio = (providerId = 'local-service') => chromeApi.tabs.create({
      url: `${chromeApi.runtime.getURL('voice-studio.html')}?provider=${encodeURIComponent(providerId)}`,
    });
    const openDocumentWorkspace = async (requestedTabId) => {
      let sourceTabId = Number(requestedTabId);
      let sourceTab = Number.isInteger(sourceTabId) ? await chromeApi.tabs.get(sourceTabId).catch(() => null) : null;
      if (!sourceTab) {
        const [active] = await chromeApi.tabs.query({ active: true, currentWindow: true });
        sourceTab = active || null;
        sourceTabId = Number(sourceTab?.id);
      }
      let screenshotDataUrl = '';
      if (sourceTab?.active && sourceTab.windowId != null && chromeApi.tabs.captureVisibleTab) {
        try { screenshotDataUrl = await chromeApi.tabs.captureVisibleTab(sourceTab.windowId, { format: 'png' }); } catch (_) {}
      }
      if (session) await session.set(DOCUMENT_WORKSPACE_SEED_KEY, {
        sourceTabId: Number.isInteger(sourceTabId) ? sourceTabId : null,
        sourceTitle: String(sourceTab?.title || ''), sourceUrl: String(sourceTab?.url || ''),
        screenshotDataUrl, capturedAt: Date.now(),
      });
      return chromeApi.tabs.create({
        url: `${chromeApi.runtime.getURL('document-workbench.html')}?sourceTabId=${Number.isInteger(sourceTabId) ? sourceTabId : ''}`,
      });
    };
    const captureVisibleTab = async () => {
      if (!chromeApi.tabs?.query || !chromeApi.tabs?.captureVisibleTab) {
        throw Object.assign(new Error('浏览器未提供可见区域截图能力。'), { code: 'capture_unavailable' });
      }
      const [tab] = await chromeApi.tabs.query({ active: true, currentWindow: true });
      if (!tab || tab.windowId == null) throw Object.assign(new Error('没有可截图的活动网页。'), { code: 'active_tab_missing' });
      return chromeApi.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    };
    const playbackCoordinator = createGlobalPlaybackCoordinator({
      session,
      async cancel(playback, reason) {
        const message = Object.assign({ type: 'tts:cancel', reason }, playback || {});
        const sourceWideCancel = {
          type: 'tts:cancel',
          sourceTabId: playback && playback.sourceTabId,
          reason,
        };
        const results = await Promise.allSettled([
          systemTts && typeof systemTts.control === 'function'
            ? systemTts.control(message) : Promise.resolve({ ok: true, cancelled: false }),
          offscreen && typeof offscreen.cancel === 'function'
            ? offscreen.cancel(sourceWideCancel) : Promise.resolve({ ok: true, cancelled: false }),
          playback && Number.isInteger(Number(playback.sourceTabId))
            && chromeApi.tabs && typeof chromeApi.tabs.sendMessage === 'function'
            ? chromeApi.tabs.sendMessage(Number(playback.sourceTabId), {
              type: 'reader:playback:revoked',
              pageKey: String(playback.pageKey || ''),
              playbackId: String(playback.playbackId || ''),
              reason: String(reason || 'replaced-by-new-playback'),
            }).catch(() => null)
            : Promise.resolve(null),
        ]);
        return { ok: true, cancelled: results.some((item) => item.status === 'fulfilled' && item.value && item.value.cancelled) };
      },
    });
    systemTts?.setEventObserver?.((message) => playbackCoordinator.acceptStreamEvent(message));
    async function testProvider(providerId, request) {
      const schema = globalThis.FlowloudSettings;
      const providerApi = globalThis.FlowloudProviderV4 || globalThis.FlowloudProviderV3;
      const stored = await chromeApi.storage.local.get([SETTINGS_KEY, schema.REMEMBERED_SECRET_KEY]);
      const sessionStored = await chromeApi.storage.session.get(schema.SESSION_SECRET_KEY).catch(() => ({}));
      const settings = schema.migrate(stored[SETTINGS_KEY]);
      const requestId = String(request && request.requestId || `provider-test-${Date.now().toString(36)}`);
      const previewText = String(request && request.previewText || '你好，这是 Flowloud 语音连接测试。').trim();
      const assignment = settings.voiceAssignmentsByProvider?.[providerId] || {};
      const requestedVoice = String(request && request.voiceId || assignment.narratorVoiceId || '');
      const runStage = async (stage, operation) => {
        try { return await operation(); }
        catch (error) {
          if (error && error.stage && error.stage !== stage) error.providerStage = error.stage;
          if (error) error.stage = stage;
          throw error;
        }
      };
      const audioPayload = async (result, fallbackMime = 'audio/mpeg') => {
        const blob = result && (result.blob || result.audio);
        if (!blob || typeof blob.arrayBuffer !== 'function') {
          throw Object.assign(new Error('服务没有返回可试听的音频。'), { code: 'invalid_response', stage: 'synthesize' });
        }
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
        return { audioBase64: btoa(binary), mimeType: result.mimeType || blob.type || fallbackMime };
      };
      if (providerId === 'browser-system') {
        const voices = await runStage('voices', () => systemTts.voices());
        if (!Array.isArray(voices) || !voices.length) throw Object.assign(new Error('浏览器没有返回系统音色。'), { code: 'empty_voice_list', stage: 'voices' });
        return { ok: true, providerId, ready: true, stage: 'voices', voiceCount: voices.length, voices, message: `已读取 ${voices.length} 个系统音色` };
      }
      if (providerId === 'local-service') {
        const config = settings.providerSettings['local-service'];
        const clientToken = sessionStored[schema.SESSION_SECRET_KEY]?.['local-service']
          || stored[schema.REMEMBERED_SECRET_KEY]?.['local-service'] || '';
        const provider = providerApi.createLocalServiceProvider(Object.assign({}, config, { clientToken }));
        const health = await runStage('health', () => provider.health({ requestId }));
        if (health && health.ok === false) throw Object.assign(new Error('本地服务健康检查失败。'), { code: 'health_failed', stage: 'health' });
        const voices = await runStage('voices', () => provider.voices({ requestId }));
        if (!Array.isArray(voices) || !voices.length) throw Object.assign(new Error('本地服务已响应，但没有返回任何音色。'), { code: 'empty_voice_list', stage: 'voices' });
        const voice = requestedVoice || String(voices[0].id || voices[0].voiceId || voices[0].name || '');
        const result = await runStage('synthesize', () => provider.synthesize({ input: previewText, voice, response_format: config.responseFormat, requestId }));
        return Object.assign({ ok: true, audition: true, providerId, adapterId: health.adapterId || config.adapterId, ready: true, stage: 'synthesize', voiceCount: voices.length, voices, capabilities: health.capabilities || provider.capabilities, requestId: result.requestId || requestId, message: `连接成功 · 已获取 ${voices.length} 个音色` }, await audioPayload(result, 'audio/wav'));
      }
      if (providerId === 'doubao-tts') {
        const config = settings.providerSettings['doubao-tts'];
        const apiKey = sessionStored[schema.SESSION_SECRET_KEY]?.['doubao-tts'] || stored[schema.REMEMBERED_SECRET_KEY]?.['doubao-tts'] || '';
        const provider = providerApi.createDoubaoTtsProvider(Object.assign({}, config, { apiKey }));
        const voices = await runStage('voices', () => provider.voices({ requestId }));
        const voice = requestedVoice || String(config.voiceIds?.[0] || '');
        if (!voice) throw Object.assign(new Error('请先配置豆包音色 ID。'), { code: 'voice_required', stage: 'voices' });
        const result = await runStage('synthesize', () => provider.synthesize({ input: previewText, voice, response_format: config.responseFormat, requestId }));
        return Object.assign({ ok: true, audition: true, providerId, stage: 'synthesize', voiceCount: voices.length, requestId: result.requestId || requestId, message: '真实短句合成验证通过' }, await audioPayload(result));
      }
      if (providerId !== 'openai-compatible') throw Object.assign(new Error('当前引擎暂不支持连接测试。'), { code: 'provider_test_unsupported' });
      const config = settings.providerSettings['openai-compatible'];
      const apiKey = sessionStored[schema.SESSION_SECRET_KEY]?.['openai-compatible'] || stored[schema.REMEMBERED_SECRET_KEY]?.['openai-compatible'] || '';
      const provider = providerApi.createOpenAICompatibleProvider(Object.assign({}, config, { apiKey }));
      const voices = await runStage('voices', () => provider.voices({ requestId }));
      const voice = requestedVoice || String(config.voiceIds?.[0] || 'alloy');
      const result = await runStage('synthesize', () => provider.synthesize({
        input: previewText,
        model: config.model,
        voice,
        response_format: config.responseFormat,
        requestId,
      }, { apiKey }));
      return Object.assign({ ok: true, audition: true, providerId, stage: 'synthesize', voiceCount: voices.length, requestId: result.requestId || requestId, message: '真实短句合成验证通过' }, await audioPayload(result));
    }
    const router = createMessageRouter({
      api, storage, session, openVoiceStudio, openDocumentWorkspace, captureVisibleTab,
      offscreen, systemTts, testProvider, playbackCoordinator,
    });

    async function setToolbarPlaybackState(target, snapshot) {
      if (!target || target.tabId == null || !chromeApi.action) return;
      const status = String(snapshot && snapshot.status || 'idle');
      try {
        if (typeof chromeApi.action.setBadgeText === 'function') {
          await chromeApi.action.setBadgeText({ tabId: target.tabId, text: '' });
        }
        if (typeof chromeApi.action.setIcon === 'function') {
          await chromeApi.action.setIcon({ tabId: target.tabId, path: actionIconPaths(status) });
        }
        if (typeof chromeApi.action.setTitle === 'function') {
          const labels = { playing: '正在朗读', paused: '已暂停', error: '朗读异常', idle: '准备就绪' };
          await chromeApi.action.setTitle({ tabId: target.tabId, title: `Flowloud · ${labels[status] || labels.idle}` });
        }
      } catch (_) {
        // Toolbar state is a convenience, never a playback dependency.
      }
    }

    const popupBroker = createPopupBroker(chromeApi, {
      session,
      onSnapshot: (target, snapshot) => { void setToolbarPlaybackState(target, snapshot); },
      getGlobalPlayback: () => playbackCoordinator.getSnapshot(),
    });
    const pageEditorBroker = createPageEditorBroker(chromeApi, {
      session,
      sendCommand: popupBroker.sendCommand,
    });
    const snapshotEvents = new Set([
      'ui:state', 'ui:snapshot', 'reader:state', 'reader:snapshot',
      'player:state', 'playback:state', 'playback:status',
    ]);

    function isOffscreenSender(sender) {
      const expectedUrl = chromeApi.runtime.getURL(OFFSCREEN_PATH);
      const source = sender || {};
      return source.url === expectedUrl || source.documentUrl === expectedUrl;
    }

    function forwardStreamEvent(message) {
      if (!isOffscreenSender(message && message.sender)) return;
      const sourceTabId = message && message.message && message.message.sourceTabId;
      if (!Number.isInteger(sourceTabId) || sourceTabId < 0) return;
      void playbackCoordinator.acceptStreamEvent(message.message);
      if (!chromeApi.tabs || typeof chromeApi.tabs.sendMessage !== 'function') return;
      try {
        const result = chromeApi.tabs.sendMessage(sourceTabId, message.message);
        if (result && typeof result.catch === 'function') result.catch(() => {});
      } catch (_) {
        // A tab can close between stream completion and event delivery.
      }
    }

    async function handlePageContextMessage(message) {
      const contextId = String(message && message.contextId || '').trim();
      if (!contextId) {
        return { ok: false, error: { code: 'context_id_missing', message: '缺少页面编辑上下文。' } };
      }
      const saved = await pageEditorBroker.getContext({ contextId });
      const context = saved && saved.context;
      if (!context || context.tabId == null) {
        return { ok: false, error: { code: 'page_context_missing', message: '页面编辑上下文已失效，请重新打开。' } };
      }
      const target = { tabId: context.tabId, pageKey: context.pageKey };
      const payload = { type: message.type, contextId, pageKey: String(context.pageKey || '') };
      if (message.type === 'reader:page-context:apply') {
        const authorVoices = {};
        (Array.isArray(message.assignments) ? message.assignments : []).forEach((assignment) => {
          const authorId = String(assignment && assignment.authorId || '').trim();
          const voice = String(assignment && assignment.voice || '').trim();
          if (authorId && voice) authorVoices[authorId] = voice;
        });
        payload.context = { pageKey: payload.pageKey, authorVoices };
      }
      const sent = await popupBroker.sendToTarget(target, payload);
      return sent.ok && sent.response && typeof sent.response === 'object'
        ? sent.response
        : sent;
    }

    function respondWith(promise, sendResponse) {
      Promise.resolve(promise).then(sendResponse, (error) => sendResponse(errorEnvelope(error)));
    }

    chromeApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message && message.target === STREAM_EVENT_TARGET) {
        forwardStreamEvent({ message, sender });
        return undefined;
      }
      if (message && message.target === OFFSCREEN_TARGET) {
        return undefined;
      }
      if (message && message.type === 'guide:open') {
        const tabId = Number(message.tabId);
        respondWith(chromeApi.tabs.create({ url: `${chromeApi.runtime.getURL('page-guide.html')}?tabId=${tabId}` }).then(() => ({ ok: true })), sendResponse);
        return true;
      }
      if (message && message.type === 'reader:site-access:register') {
        respondWith(registerReaderSite(chromeApi, message.origin), sendResponse);
        return true;
      }
      if (message && message.type === 'reader:auto-restore') {
        const tabId = sender && sender.tab && sender.tab.id;
        respondWith(tabId == null
          ? { ok: false, error: { code: 'reader_tab_missing', message: '无法识别当前网页标签页。' } }
          : popupBroker.ensureInjected(tabId).then((injected) => ({ ok: injected })), sendResponse);
        return true;
      }
      if (message && message.type === 'playback:source:focus') {
        respondWith((async () => {
          const playback = await playbackCoordinator.getSnapshot();
          if (!playback.active || playback.sourceTabId == null) {
            return { ok: false, error: { code: 'playback_source_missing', message: '当前没有可返回的朗读来源页。' } };
          }
          const tab = await chromeApi.tabs.update(Number(playback.sourceTabId), { active: true });
          if (tab?.windowId != null && chromeApi.windows?.update) {
            await chromeApi.windows.update(tab.windowId, { focused: true }).catch(() => {});
          }
          return { ok: true, tabId: playback.sourceTabId };
        })(), sendResponse);
        return true;
      }
      if (message && (message.type === 'guide:snapshot' || message.type === 'guide:focus')) {
        const targetType = message.type === 'guide:snapshot' ? 'flowloud:guide:snapshot' : 'flowloud:guide:focus';
        respondWith(chromeApi.tabs.sendMessage(Number(message.tabId), { type: targetType, filter: message.filter, id: message.id }), sendResponse);
        return true;
      }
      if (message && message.type === 'reader/tts') {
        const tabId = Number(message.tabId);
        const identity = `guide-${tabId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        respondWith(router({
          type: 'tts:synthesize', sourceTabId: tabId, clientId: `guide-${tabId}`,
          playbackId: identity, requestId: identity, sessionId: identity, stream: true,
          request: { input: String(message.text || ''), requestId: identity, playbackId: identity, sessionId: identity },
        }), sendResponse);
        return true;
      }
      if (isPopupMessage(message && message.type)) {
        respondWith(popupBroker.handle(message, sender), sendResponse);
        return true;
      }
      if (isPageEditorMessage(message && message.type)) {
        respondWith(
          Promise.resolve(popupBroker.getTarget())
            .then((target) => pageEditorBroker.handle(message, sender, target)),
          sendResponse,
        );
        return true;
      }
      if (message && (message.type === 'reader:page-context:get' || message.type === 'reader:page-context:apply')) {
        respondWith(handlePageContextMessage(message), sendResponse);
        return true;
      }
      if (snapshotEvents.has(message && message.type)) {
        respondWith(Promise.all([
          popupBroker.acceptSnapshot(message, sender),
          playbackCoordinator.acceptReaderSnapshot(message, {
            tabId: sender && sender.tab && sender.tab.id,
            documentId: sender && sender.documentId,
          }),
        ]).then(() => ({ ok: true })), sendResponse);
        return true;
      }
      const sourceTabId = sender && sender.tab && sender.tab.id != null
        ? sender.tab.id : null;
      let forwarded = sourceTabId == null || !message || message.sourceTabId != null
        ? message
        : Object.assign({}, message, { sourceTabId });
      if (forwarded && sender && sender.documentId && !forwarded.sourceDocumentId) {
        forwarded = Object.assign({}, forwarded, { sourceDocumentId: String(sender.documentId) });
      }
      respondWith(router(forwarded), sendResponse);
      return true;
    });
    if (chromeApi.commands && chromeApi.commands.onCommand) {
      chromeApi.commands.onCommand.addListener(async (command) => {
        if (command !== 'toggle-reader') return;
        const globalPlayback = await playbackCoordinator.getSnapshot();
        if (globalPlayback.active) {
          const target = await popupBroker.targetForTab(globalPlayback.sourceTabId);
          const commandResult = await popupBroker.sendCommand(target, {
            command: 'play-toggle', source: 'shortcut', pageKey: globalPlayback.pageKey,
          });
          if (commandResult && commandResult.snapshot) await setToolbarPlaybackState(target, commandResult.snapshot);
          return;
        }
        const tabs = await chromeApi.tabs.query({ active: true, currentWindow: true });
        const tab = normalizeTabTarget(tabs && tabs[0]);
        const result = await popupBroker.requestSnapshot(tab);
        const pageKey = result && result.snapshot && result.snapshot.pageKey;
        if (!pageKey) return;
        const target = Object.assign({}, tab, { pageKey });
        const commandResult = await popupBroker.sendCommand(target, {
          command: 'play-toggle', source: 'shortcut', pageKey,
        });
        if (commandResult && commandResult.snapshot) await setToolbarPlaybackState(target, commandResult.snapshot);
      });
    }
    if (chromeApi.runtime.onInstalled && typeof chromeApi.runtime.onInstalled.addListener === 'function') {
      chromeApi.runtime.onInstalled.addListener(async (details) => {
        const schema = globalThis.FlowloudSettings;
        const saved = await chromeApi.storage.local.get(SETTINGS_KEY);
        const migrated = schema ? schema.migrate(saved[SETTINGS_KEY]) : saved[SETTINGS_KEY];
        await chromeApi.storage.local.set({ [SETTINGS_KEY]: migrated });
        if (details.reason === 'install') await chromeApi.tabs.create({ url: chromeApi.runtime.getURL('onboarding.html') });
      });
    }
    if (chromeApi.tabs && chromeApi.tabs.onRemoved && typeof chromeApi.tabs.onRemoved.addListener === 'function') {
      chromeApi.tabs.onRemoved.addListener((tabId) => {
        void playbackCoordinator.stopForTab(tabId, 'source-tab-closed');
        void cancelPlaybackForTab(offscreen, tabId);
        void popupBroker.forgetTab(tabId, true);
        void pageEditorBroker.forgetTab(tabId);
      });
    }
    if (chromeApi.tabs && chromeApi.tabs.onUpdated && typeof chromeApi.tabs.onUpdated.addListener === 'function') {
      chromeApi.tabs.onUpdated.addListener((tabId, changeInfo) => {
        if (!changeInfo) return;
        if (changeInfo.status === 'complete') {
          void popupBroker.ensureInjected(tabId);
          return;
        }
        if (changeInfo.status === 'loading') {
          // Flarum and other SPA forums emit repeated tab loading updates while
          // they extend or reposition a discussion stream. Treating every one
          // as a document teardown revokes the successor utterance during
          // normal auto-continuation. The content script's pagehide handler is
          // the authoritative cancellation path for an actual document exit;
          // tab removal remains the crash/close safety net.
          void setToolbarPlaybackState({ tabId }, { status: 'idle' });
          void popupBroker.forgetTab(tabId, false);
          void pageEditorBroker.forgetTab(tabId);
        }
      });
    }
    chromeApi.storage.onChanged?.addListener((changes, areaName) => {
      if (areaName !== 'local' || !changes[SETTINGS_KEY]) return;
      const settings = globalThis.FlowloudSettings?.migrate(changes[SETTINGS_KEY].newValue) || changes[SETTINGS_KEY].newValue;
      chromeApi.tabs.query({}).then((tabs) => Promise.allSettled((tabs || []).map((tab) => (
        tab.id == null ? null : chromeApi.tabs.sendMessage(tab.id, { type: 'flowloud:settings:changed', settings })
      )))).catch(() => {});
    });
    return {
      popupBroker, pageEditorBroker, playbackCoordinator,
      stopPlaybackForTab: (tabId) => playbackCoordinator.stopForTab(tabId, 'explicit-stop'),
    };
  }

  return {
    OFFSCREEN_TARGET,
    STREAM_EVENT_TARGET,
    OFFSCREEN_PATH,
    REQUIRED_ORIGIN,
    SETTINGS_KEY,
    CLEANUP_QUEUE_KEY,
    READER_SITE_SCRIPT_ID,
    normalizeReaderSitePattern,
    registerReaderSite,
    cancelPlaybackForTab,
    POPUP_TARGET_KEY,
    POPUP_SNAPSHOTS_KEY,
    PAGE_EDITOR_CONTEXTS_KEY,
    PAGE_EDITOR_PATH,
    actionIconPaths,
    createMessageRouter,
    createOffscreenManager,
    createChromeTtsManager,
    chromeStorage,
    chromeSessionStorage,
    createPopupBroker,
    createGlobalPlaybackCoordinator,
    createPageEditorBroker,
    errorEnvelope,
    repairVoiceSettings,
    install,
  };
}));
