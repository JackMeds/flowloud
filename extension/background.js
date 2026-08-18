/* global chrome, importScripts */
if (typeof importScripts === 'function' && !globalThis.QwenReaderApiClient) {
  importScripts('shared/api-client.js');
}

(function backgroundModule(root, factory) {
  const apiModule = root.QwenReaderApiClient || (typeof require === 'function'
    ? require('./shared/api-client.js') : null);
  const exported = factory(apiModule);
  if (typeof module === 'object' && module.exports) module.exports = exported;
  root.QwenReaderBackground = exported;

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    exported.install(chrome);
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function makeBackground(apiModule) {
  'use strict';

  const OFFSCREEN_TARGET = 'qwen-reader-offscreen';
  const OFFSCREEN_PATH = 'offscreen.html';
  const REQUIRED_ORIGIN = 'http://127.0.0.1:7811/*';
  const SETTINGS_KEY = 'qwenReaderSettings';
  const POPUP_TARGET_KEY = 'qwenReaderPopupTarget';
  const POPUP_SNAPSHOTS_KEY = 'qwenReaderPopupSnapshots';
  const PAGE_EDITOR_CONTEXTS_KEY = 'qwenReaderPageEditorContexts';
  const PAGE_EDITOR_PATH = 'page-voices.html';
  const BUILTIN_VOICES = ['邵思萌', 'qwen-clone'];

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
    };
  }

  // Popup targets and page-editor contexts are deliberately session scoped. They
  // describe open browser tabs, so persisting them in local storage would leave
  // stale tab ids after a browser restart. Older Chromium builds without
  // storage.session fall back to a service-worker-local map; all callers keep
  // the same async contract either way.
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
      'reader:command',
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
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      return null;
    }
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
        : segments
          ? segments.length
          : 0;
    return {
      status: String(snapshot.status || 'idle'),
      pageKey: String(snapshot.pageKey || (document && document.pageKey) || ''),
      title: String(
        snapshot.title ||
          (document && (document.title || document.name)) ||
          '',
      ),
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
      return { ok: false, error: { code: 'cancelled', message: '朗读已取消。' } };
    }
    return {
      ok: false,
      error: {
        code: error && error.code ? error.code : 'unexpected_error',
        message: error && error.message ? error.message : '本地朗读服务发生未知错误。',
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

    async function assertPermission() {
      if (!chromeApi.permissions || typeof chromeApi.permissions.contains !== 'function') return;
      const granted = await chromeApi.permissions.contains({ origins: [REQUIRED_ORIGIN] });
      if (granted) return;
      const error = new Error('请在 Edge 扩展详情中允许访问 127.0.0.1:7811。');
      error.code = 'host_permission_missing';
      throw error;
    }

    async function ensureDocument() {
      await assertPermission();
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
          reasons: ['BLOBS'],
          justification: 'Convert local Qwen TTS WAV blobs to transferable Base64 during long model cold starts.',
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
        await ensureDocument();
        return send(message);
      },
      async cancel(message) {
        if (!(await hasDocument())) return { ok: true, cancelled: false, count: 0 };
        return send(message);
      },
      hasDocument,
      ensureDocument,
    };
  }

  function createMessageRouter({ api, storage, openVoiceStudio, offscreen }) {
    if (!api) throw new TypeError('缺少本地 TTS 客户端。');
    let requestSequence = 0;

    async function profiles() {
      const saved = await storage.get('voiceProfiles');
      return Array.isArray(saved) ? saved : [];
    }

    async function saveProfile(profile) {
      const saved = await profiles();
      const index = saved.findIndex((item) => item && item.name === profile.name);
      if (index >= 0) saved[index] = profile;
      else saved.push(profile);
      await storage.set('voiceProfiles', saved);
    }

    function withIdentity(message) {
      const body = message || {};
      const sessionId = String(body.sessionId || '');
      const clientId = String(body.clientId || sessionId || 'legacy-client');
      const playbackId = String(body.playbackId || sessionId || 'legacy-playback');
      const requestId = String(body.requestId || `${sessionId || clientId}:${++requestSequence}`);
      return Object.assign({}, body, { clientId, playbackId, requestId });
    }

    async function forward(message, includeProfiles) {
      if (!offscreen || typeof offscreen.request !== 'function') {
        const error = new Error('后台音频运行环境不可用。');
        error.code = 'offscreen_unavailable';
        throw error;
      }
      const payload = withIdentity(message);
      if (includeProfiles) payload.profiles = await profiles();
      return offscreen.request(payload);
    }

    return async function route(message) {
      const body = message || {};
      try {
        switch (body.type) {
          case 'tts:status':
            return { ok: true, status: await api.status() };

          case 'tts:voices':
          case 'voice:list':
          case 'tts:synthesize':
            return await forward(body, true);

          case 'tts:cancel':
            if (!offscreen || typeof offscreen.cancel !== 'function') {
              return { ok: true, cancelled: false, count: 0 };
            }
            return await offscreen.cancel(body);

          case 'voice:save': {
            const profile = body.profile || {};
            const result = await forward(body, false);
            if (result && result.ok) await saveProfile(profile);
            return result;
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
            await openVoiceStudio();
            return { ok: true };

          default:
            return { ok: false, error: { code: 'unknown_message', message: '不支持的扩展请求。' } };
        }
      } catch (error) {
        return errorEnvelope(error);
      }
    };
  }

  function createPopupBroker(chromeApi, options) {
    const config = options || {};
    const session = config.session || chromeSessionStorage(chromeApi);
    const onSnapshot = typeof config.onSnapshot === 'function'
      ? config.onSnapshot
      : () => {};
    let targetMemory = null;
    const snapshotMemory = new Map();

    function targetError(message, code) {
      return {
        ok: false,
        error: { code: code || 'popup_target_unavailable', message },
      };
    }

    async function queryActiveTab() {
      if (!chromeApi.tabs || typeof chromeApi.tabs.query !== 'function') {
        return null;
      }
      const tabs = await chromeApi.tabs.query({ active: true, currentWindow: true });
      return normalizeTabTarget(Array.isArray(tabs) ? tabs[0] : null);
    }

    async function tabStillExists(target) {
      if (!target || !chromeApi.tabs || typeof chromeApi.tabs.get !== 'function') {
        return Boolean(target);
      }
      try {
        const tab = await chromeApi.tabs.get(target.tabId);
        return Boolean(tab && tab.id != null);
      } catch (_) {
        return false;
      }
    }

    async function persistTarget(target) {
      if (target) await session.set(POPUP_TARGET_KEY, target);
      else await session.remove(POPUP_TARGET_KEY);
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
      const active = await queryActiveTab();
      targetMemory = active;
      await persistTarget(active);
      return active;
    }

    async function getTarget() {
      const restored = await restoreTarget();
      if (restored) return restored;
      return beginTarget(false);
    }

    async function targetForTab(tabId) {
      if (tabId == null || tabId === '') return getTarget();
      const numericId = Number(tabId);
      if (!Number.isFinite(numericId)) return getTarget();
      const current = await getTarget();
      if (current && current.tabId === numericId) return current;
      if (chromeApi.tabs && typeof chromeApi.tabs.get === 'function') {
        try {
          return normalizeTabTarget(await chromeApi.tabs.get(numericId));
        } catch (_) {
          // The tab may have closed between the popup render and this command.
        }
      }
      return normalizeTabTarget({ id: numericId });
    }

    async function clearTarget() {
      targetMemory = null;
      await persistTarget(null);
    }

    async function sendToTarget(target, message) {
      if (!target || target.tabId == null) {
        return targetError('没有找到可控制的网页标签页。');
      }
      if (!chromeApi.tabs || typeof chromeApi.tabs.sendMessage !== 'function') {
        return targetError('当前浏览器不支持向网页发送朗读控制。', 'tabs_unavailable');
      }
      try {
        const response = await chromeApi.tabs.sendMessage(target.tabId, message);
        return { ok: true, response: response == null ? null : response };
      } catch (error) {
        return {
          ok: false,
          error: {
            code: 'content_script_unavailable',
            message: error && error.message
              ? error.message
              : '当前页面暂时不能接收朗读控制。',
          },
        };
      }
    }

    async function readSnapshots() {
      if (snapshotMemory.size) return snapshotMemory;
      const saved = await session.get(POPUP_SNAPSHOTS_KEY);
      if (!saved || typeof saved !== 'object' || Array.isArray(saved)) {
        return snapshotMemory;
      }
      Object.entries(saved).forEach(([tabId, snapshot]) => {
        if (snapshot && typeof snapshot === 'object') {
          snapshotMemory.set(String(tabId), snapshot);
        }
      });
      return snapshotMemory;
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
      snapshotMemory.set(String(target.tabId), snapshot);
      const persisted = {};
      snapshotMemory.forEach((entry, tabId) => {
        persisted[tabId] = entry;
      });
      await session.set(POPUP_SNAPSHOTS_KEY, persisted);
      onSnapshot(target, snapshot);
      return snapshot;
    }

    function cachedSnapshot(target) {
      return target ? snapshotMemory.get(String(target.tabId)) || null : null;
    }

    async function requestSnapshot(target) {
      const response = await sendToTarget(target, {
        type: 'reader:snapshot:get',
        request: 'snapshot',
        source: 'popup',
      });
      const direct = response.response && (
        response.response.snapshot ||
        response.response.state ||
        response.response.player
      );
      const pageError = response.response && response.response.ok === false
        ? response.response.error || { code: 'reader_unavailable', message: '当前页面暂时不能朗读。' }
        : null;
      const snapshot = direct
        ? await rememberSnapshot(target, direct)
        : cachedSnapshot(target);
      return Object.assign({}, response, pageError ? { ok: false, error: pageError } : {}, {
        target,
        snapshot: snapshot || null,
        source: direct ? 'page' : snapshot ? 'session' : 'empty',
      });
    }

    async function sendCommand(target, message) {
      const command = normalizeCommand(message);
      if (!command) {
        return { ok: false, error: { code: 'invalid_command', message: '缺少朗读控制命令。' } };
      }
      const commandMessage = {
        type: 'reader:command',
        command,
        action: command,
        source: message && message.source ? String(message.source) : 'popup',
        contextId: message && message.contextId ? String(message.contextId) : '',
        pageKey: message && message.pageKey
          ? String(message.pageKey)
          : target && target.pageKey
            ? String(target.pageKey)
            : '',
      };
      // Keep command-specific values intact (for example the Popup's
      // set-speed value and seek index) while still using a small, explicit
      // broker envelope.
      if (message && message.value !== undefined) commandMessage.value = message.value;
      if (message && message.index !== undefined) commandMessage.index = message.index;
      if (message && message.payload && typeof message.payload === 'object') {
        commandMessage.payload = message.payload;
      }
      const response = await sendToTarget(target, commandMessage);
      const direct = response.response && (
        response.response.snapshot ||
        response.response.state ||
        response.response.player
      );
      const snapshot = direct ? await rememberSnapshot(target, direct) : null;
      return Object.assign({}, response, { target, command, snapshot });
    }

    async function handleReaderMessage(message) {
      const body = message || {};
      const target = await targetForTab(body.tabId);
      switch (body.type) {
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
          });
        }
        case 'reader:snapshot:get': {
          const result = await requestSnapshot(target);
          return result.snapshot || { status: 'idle', index: 0, total: 0, current: null };
        }
        case 'reader:command': {
          const result = await sendCommand(target, body);
          if (!result || !result.ok) {
            return {
              ok: false,
              error: result && result.error || { code: 'reader_unavailable', message: '当前页面暂时不能朗读。' },
              snapshot: result && result.snapshot || null,
            };
          }
          const contentResponse = result.response && typeof result.response === 'object'
            ? result.response
            : { ok: true };
          return Object.assign({}, contentResponse, {
            ok: contentResponse.ok !== false,
            snapshot: result.snapshot || snapshotFromMessage(contentResponse) || null,
          });
        }
        default:
          return { ok: false, error: { code: 'unknown_message', message: '不支持的网页朗读请求。' } };
      }
    }

    async function handle(message) {
      const body = message || {};
      switch (body.type) {
        case 'popup:init':
        case 'popup:target': {
          const target = await beginTarget(true);
          return Object.assign({ ok: Boolean(target), target }, await requestSnapshot(target));
        }
        case 'popup:snapshot':
        case 'popup:get-state': {
          const target = await getTarget();
          return requestSnapshot(target);
        }
        case 'popup:command': {
          const target = await getTarget();
          return sendCommand(target, body);
        }
        case 'popup:reset-target':
          await clearTarget();
          return { ok: true, target: null };
        case 'reader:active-context':
        case 'reader:snapshot:get':
        case 'reader:command':
          return handleReaderMessage(body);
        default:
          return { ok: false, error: { code: 'unknown_message', message: '不支持的 Popup 请求。' } };
      }
    }

    async function acceptSnapshot(message, sender) {
      if (!sender || !sender.tab || sender.tab.id == null) return false;
      const snapshot = snapshotFromMessage(message);
      if (!snapshot) return false;
      const target = normalizeTabTarget(sender.tab);
      await rememberSnapshot(target, snapshot);
      return true;
    }

    async function forgetTab(tabId) {
      const numericId = Number(tabId);
      if (targetMemory && targetMemory.tabId === numericId) await clearTarget();
      await readSnapshots();
      snapshotMemory.delete(String(numericId));
      const persisted = {};
      snapshotMemory.forEach((entry, key) => { persisted[key] = entry; });
      await session.set(POPUP_SNAPSHOTS_KEY, persisted);
    }

    return {
      beginTarget,
      getTarget,
      clearTarget,
      sendToTarget,
      sendCommand,
      requestSnapshot,
      targetForTab,
      handleReaderMessage,
      handle,
      acceptSnapshot,
      forgetTab,
    };
  }

  function createPageEditorBroker(chromeApi, options) {
    const config = options || {};
    const session = config.session || chromeSessionStorage(chromeApi);
    const sendCommand = typeof config.sendCommand === 'function'
      ? config.sendCommand
      : null;
    let contextsMemory = null;

    async function readContexts() {
      if (contextsMemory) return contextsMemory;
      const saved = await session.get(PAGE_EDITOR_CONTEXTS_KEY);
      contextsMemory = saved && typeof saved === 'object' && !Array.isArray(saved)
        ? saved
        : {};
      return contextsMemory;
    }

    async function persistContexts() {
      await session.set(PAGE_EDITOR_CONTEXTS_KEY, contextsMemory || {});
    }

    function makeContextId() {
      if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
        return `qwen-page-${globalThis.crypto.randomUUID()}`;
      }
      return `qwen-page-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }

    async function open(body, sender, fallbackTarget) {
      const contextId = String(body.contextId || makeContextId());
      const contexts = await readContexts();
      const existing = contexts[contextId];
      // Opening an editor is the trust boundary: bind it to the popup's fixed
      // target (or the sending content tab), never to a tab id supplied by the
      // extension page.
      const trustedTabId = fallbackTarget && fallbackTarget.tabId != null
        ? fallbackTarget.tabId
        : sender && sender.tab && sender.tab.id != null
          ? sender.tab.id
          : existing && existing.tabId;
      const tabId = trustedTabId == null ? null : Number(trustedTabId);
      const pageKey = String(
        fallbackTarget && fallbackTarget.pageKey ||
          existing && existing.pageKey ||
          '',
      );
      if (tabId == null) {
        return { ok: false, error: { code: 'page_context_missing', message: '没有找到要编辑的页面。' } };
      }
      if (!chromeApi.tabs || typeof chromeApi.tabs.create !== 'function') {
        return { ok: false, error: { code: 'tabs_unavailable', message: '当前浏览器无法打开页面编辑器。' } };
      }
      const query = new URLSearchParams({ contextId });
      const url = chromeApi.runtime.getURL(`${PAGE_EDITOR_PATH}?${query.toString()}`);
      let editorTab;
      try {
        editorTab = await chromeApi.tabs.create({
          url,
          openerTabId: Number.isFinite(tabId) ? tabId : undefined,
        });
      } catch (error) {
        return {
          ok: false,
          error: { code: 'page_editor_open_failed', message: error && error.message || '无法打开页面编辑器。' },
        };
      }
      contexts[contextId] = {
        contextId,
        tabId,
        pageKey,
        editorTabId: editorTab && editorTab.id != null ? Number(editorTab.id) : null,
        updatedAt: Date.now(),
      };
      await persistContexts();
      return { ok: true, context: contexts[contextId], tab: editorTab || null };
    }

    async function register(body, sender) {
      const contextId = String(body.contextId || '');
      if (!contextId) {
        return { ok: false, error: { code: 'context_id_missing', message: '缺少页面编辑上下文。' } };
      }
      const contexts = await readContexts();
      const current = contexts[contextId] || {};
      const explicitTabId = body.sourceTabId != null
        ? body.sourceTabId
        : body.tabId != null
          ? body.tabId
          : null;
      const tabId = explicitTabId != null
        ? Number(explicitTabId)
        : current.tabId != null
          ? Number(current.tabId)
          : sender && sender.tab && sender.tab.id != null
            ? Number(sender.tab.id)
            : null;
      contexts[contextId] = Object.assign({}, current, {
        contextId,
        tabId,
        pageKey: String(body.pageKey || current.pageKey || ''),
        editorTabId: sender && sender.tab && sender.tab.id != null
          ? Number(sender.tab.id)
          : current.editorTabId || null,
        updatedAt: Date.now(),
      });
      await persistContexts();
      return { ok: true, context: contexts[contextId] };
    }

    async function getContext(body) {
      const contexts = await readContexts();
      const contextId = String(body.contextId || '');
      return { ok: true, context: contextId ? contexts[contextId] || null : contexts };
    }

    async function command(body, sender) {
      const contexts = await readContexts();
      const contextId = String(body.contextId || '');
      const context = contexts[contextId];
      if (!context || context.tabId == null) {
        return { ok: false, error: { code: 'page_context_missing', message: '页面编辑上下文已失效，请重新打开。' } };
      }
      if (sendCommand) {
        const target = { tabId: context.tabId, pageKey: context.pageKey };
        return sendCommand(target, Object.assign({}, body, {
          source: 'page-editor',
          contextId,
          pageKey: context.pageKey,
        }));
      }
      const payload = Object.assign({}, body, {
        type: 'ui:command',
        command: normalizeCommand(body),
        source: 'page-editor',
        contextId,
        pageKey: context.pageKey,
      });
      try {
        const response = await chromeApi.tabs.sendMessage(context.tabId, payload);
        return { ok: true, context, response: response || null };
      } catch (error) {
        return { ok: false, error: { code: 'content_script_unavailable', message: error && error.message || '原页面暂时无法接收编辑操作。' } };
      }
    }

    async function close(body) {
      const contexts = await readContexts();
      const contextId = String(body.contextId || '');
      if (contextId) delete contexts[contextId];
      await persistContexts();
      return { ok: true };
    }

    async function handle(body, sender, fallbackTarget) {
      switch (body && body.type) {
        case 'page-editor:open':
        case 'page-editor:init':
        case 'page-voices:open':
        case 'reader:page-editor:open':
          return open(body || {}, sender, fallbackTarget);
        case 'page-editor:register':
          return register(body || {}, sender);
        case 'page-editor:get-context':
        case 'page-editor:context':
          return getContext(body || {});
        case 'page-editor:command':
          return command(body || {}, sender);
        case 'page-editor:close':
          return close(body || {});
        default:
          return { ok: false, error: { code: 'unknown_message', message: '不支持的页面编辑请求。' } };
      }
    }

    async function forgetTab(tabId) {
      const contexts = await readContexts();
      const numericId = Number(tabId);
      let changed = false;
      Object.keys(contexts).forEach((contextId) => {
        const context = contexts[contextId];
        if (context && (Number(context.tabId) === numericId || Number(context.editorTabId) === numericId)) {
          delete contexts[contextId];
          changed = true;
        }
      });
      if (changed) await persistContexts();
    }

    return { handle, open, register, getContext, command, close, forgetTab };
  }

  function install(chromeApi) {
    const storage = chromeStorage(chromeApi);
    const session = chromeSessionStorage(chromeApi);
    const api = apiModule.createApiClient({ storage });
    const offscreen = createOffscreenManager(chromeApi);
    const openVoiceStudio = () => chromeApi.tabs.create({
      url: chromeApi.runtime.getURL('voice-studio.html'),
    });
    const router = createMessageRouter({ api, storage, openVoiceStudio, offscreen });
    async function setBadge(target, snapshot) {
      if (!target || target.tabId == null || !chromeApi.action) return;
      const status = snapshot && String(snapshot.status || 'idle');
      const text = status === 'playing'
        ? '▶'
        : status === 'paused'
          ? 'Ⅱ'
          : status === 'error'
            ? '!'
            : '';
      try {
        if (typeof chromeApi.action.setBadgeText === 'function') {
          await chromeApi.action.setBadgeText({ tabId: target.tabId, text });
        }
        if (typeof chromeApi.action.setBadgeBackgroundColor === 'function') {
          const color = status === 'error'
            ? '#dc2626'
            : status === 'paused'
              ? '#d97706'
              : '#6d28d9';
          await chromeApi.action.setBadgeBackgroundColor({
            tabId: target.tabId,
            color,
          });
        }
      } catch (_) {
        // Badge updates are a convenience; a browser that lacks the promise
        // form of the Action API must not break playback controls.
      }
    }

    const popupBroker = createPopupBroker(chromeApi, {
      session,
      onSnapshot: (target, snapshot) => { void setBadge(target, snapshot); },
    });
    const pageEditorBroker = createPageEditorBroker(chromeApi, {
      session,
      sendCommand: popupBroker.sendCommand,
    });

    const snapshotEvents = new Set([
      'ui:state',
      'ui:snapshot',
      'reader:state',
      'reader:snapshot',
      'player:state',
      'playback:state',
      'playback:status',
    ]);

    async function handlePageContextMessage(message) {
      const contextId = String(message && message.contextId || '').trim();
      if (!contextId) {
        return {
          ok: false,
          error: { code: 'context_id_missing', message: '缺少页面编辑上下文。' },
        };
      }
      const contextResult = await pageEditorBroker.getContext({ contextId });
      const mappedContext = contextResult && contextResult.context;
      if (!mappedContext || mappedContext.tabId == null) {
        return {
          ok: false,
          error: { code: 'page_context_missing', message: '页面编辑上下文已失效，请重新打开。' },
        };
      }
      const target = { tabId: mappedContext.tabId, pageKey: mappedContext.pageKey };
      const payload = {
        type: message.type,
        contextId,
        pageKey: String(mappedContext.pageKey || ''),
      };
      if (message.type === 'reader:page-context:apply') {
        const assignments = Array.isArray(message.assignments) ? message.assignments : [];
        const authorVoices = {};
        assignments.forEach((assignment) => {
          const authorId = String(assignment && assignment.authorId || '').trim();
          const voice = String(assignment && assignment.voice || '').trim();
          if (!authorId) return;
          if (voice) authorVoices[authorId] = voice;
          else delete authorVoices[authorId];
        });
        payload.context = {
          pageKey: payload.pageKey,
          authorVoices,
        };
      }
      const response = await popupBroker.sendToTarget(target, payload);
      if (!response.ok) return response;
      const body = response.response;
      if (body && typeof body === 'object') return body;
      return { ok: true };
    }

    function respondWith(promise, sendResponse) {
      Promise.resolve(promise).then(sendResponse, (error) => sendResponse(errorEnvelope(error)));
    }

    chromeApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message && message.target === OFFSCREEN_TARGET) return undefined;
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
      if (
        message &&
        (message.type === 'reader:page-context:get' ||
          message.type === 'reader:page-context:apply')
      ) {
        respondWith(handlePageContextMessage(message), sendResponse);
        return true;
      }
      if (snapshotEvents.has(message && message.type)) {
        respondWith(
          popupBroker.acceptSnapshot(message, sender).then(() => ({ ok: true })),
          sendResponse,
        );
        return true;
      }
      respondWith(router(message), sendResponse);
      return true;
    });

    if (chromeApi.commands && chromeApi.commands.onCommand) {
      chromeApi.commands.onCommand.addListener(async (command) => {
        if (command !== 'toggle-reader') return;
        const tabs = await chromeApi.tabs.query({ active: true, currentWindow: true });
        const tab = normalizeTabTarget(tabs && tabs[0]);
        const state = await popupBroker.requestSnapshot(tab);
        const pageKey = state && state.snapshot && state.snapshot.pageKey;
        if (!pageKey) return;
        const target = Object.assign({}, tab, { pageKey });
        const result = await popupBroker.sendCommand(target, {
          command: 'play-toggle',
          source: 'shortcut',
          pageKey,
        });
        if (result && result.snapshot) await setBadge(target, result.snapshot);
      });
    }

    if (chromeApi.tabs && chromeApi.tabs.onRemoved &&
      typeof chromeApi.tabs.onRemoved.addListener === 'function') {
      chromeApi.tabs.onRemoved.addListener((tabId) => {
        void popupBroker.forgetTab(tabId);
        void pageEditorBroker.forgetTab(tabId);
      });
    }

    // Expose the brokers for browser harnesses without making them part of the
    // extension's public runtime API. This is useful for deterministic tests
    // that install the service-worker module with a mocked chrome object.
    return { popupBroker, pageEditorBroker };
  }

  return {
    OFFSCREEN_TARGET,
    OFFSCREEN_PATH,
    REQUIRED_ORIGIN,
    SETTINGS_KEY,
    POPUP_TARGET_KEY,
    POPUP_SNAPSHOTS_KEY,
    PAGE_EDITOR_CONTEXTS_KEY,
    PAGE_EDITOR_PATH,
    createMessageRouter,
    createOffscreenManager,
    chromeStorage,
    chromeSessionStorage,
    createPopupBroker,
    createPageEditorBroker,
    errorEnvelope,
    repairVoiceSettings,
    install,
  };
}));
