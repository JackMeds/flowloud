/* global chrome, importScripts */
if (typeof importScripts === 'function') {
  const backgroundScripts = [];
  if (!globalThis.QwenReaderApiClient) backgroundScripts.push('shared/api-client.js');
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
  const REQUIRED_ORIGIN = 'http://127.0.0.1:7811/*';
  const SETTINGS_KEY = 'qwenReaderSettings';
  const CLEANUP_QUEUE_KEY = 'voiceCleanupQueue';
  const POPUP_TARGET_KEY = 'qwenReaderPopupTarget';
  const POPUP_SNAPSHOTS_KEY = 'qwenReaderPopupSnapshots';
  const PAGE_EDITOR_CONTEXTS_KEY = 'qwenReaderPageEditorContexts';
  const PAGE_EDITOR_PATH = 'page-voices.html';
  const BUILTIN_VOICES = ['邵思萌', 'qwen-clone'];

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
        await ensureDocument();
        return send(message);
      },
      async control(message) {
        // getContexts()/hasDocument() can briefly lag behind a live offscreen
        // page during MV3 lifecycle transitions. Send the identity-bearing
        // control directly; a missing recipient is still reported as a benign
        // non-applied control below.
        try {
          return await send(message);
        } catch (_) {
          return {
            ok: true,
            paused: message && message.type === 'tts:pause' ? false : undefined,
            resumed: message && message.type === 'tts:resume' ? false : undefined,
            count: 0,
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

  function createMessageRouter({ api, storage, openVoiceStudio, offscreen }) {
    if (!api) throw new TypeError('缺少本地 TTS 客户端。');
    let requestSequence = 0;

    async function profiles() {
      const saved = await storage.get('voiceProfiles');
      return Array.isArray(saved) ? saved : [];
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
          const result = await forward({ type: 'voice:delete', name }, false);
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
          case 'tts:status':
            if (offscreen && typeof offscreen.request === 'function') {
              return await forward(body, false);
            }
            return { ok: true, status: await api.status() };

          case 'tts:voices':
          case 'tts:synthesize':
            return await forward(body, true);

          case 'voice:list':
            await cleanupPendingVoices();
            {
              const result = await forward(body, true);
              if (!result || !result.ok || !Array.isArray(result.voices)) return result;
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
            if (!offscreen || typeof offscreen.cancel !== 'function') {
              return { ok: true, cancelled: false, count: 0 };
            }
            return await offscreen.cancel(body);

          case 'tts:pause':
          case 'tts:resume':
            if (!offscreen || typeof offscreen.control !== 'function') {
              return {
                ok: true,
                paused: body.type === 'tts:pause' ? false : undefined,
                resumed: body.type === 'tts:resume' ? false : undefined,
                count: 0,
              };
            }
            return await offscreen.control(withIdentity(body));

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

  async function cancelPlaybackForTab(offscreen, tabId) {
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
        reason: 'source-tab-closed',
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
    let targetMemory = null;
    const snapshots = new Map();

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
      const target = message && message.type === 'reader:active-context' && message.tabId == null
        ? await beginTarget(true)
        : await targetForTab(message && message.tabId);
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
          });
        }
        case 'reader:snapshot:get': {
          const result = await requestSnapshot(target);
          return result.snapshot || { status: 'idle', index: 0, total: 0, current: null };
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
          const target = await beginTarget(true);
          return Object.assign({ ok: Boolean(target), target }, await requestSnapshot(target));
        }
        case 'popup:snapshot':
        case 'popup:get-state':
          return requestSnapshot(await getTarget());
        case 'popup:command':
          return sendCommand(await getTarget(), message);
        case 'popup:reset-target':
          await clearTarget();
          return { ok: true, target: null };
        case 'reader:active-context':
        case 'reader:snapshot:get':
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
      return Boolean(await rememberSnapshot(normalizeTabTarget(sender.tab), message));
    }

    async function forgetTab(tabId) {
      const numericId = Number(tabId);
      if (targetMemory && targetMemory.tabId === numericId) await clearTarget();
      await readSnapshots();
      snapshots.delete(String(numericId));
      await persistSnapshots();
    }

    return { beginTarget, getTarget, clearTarget, sendToTarget, sendCommand, requestSnapshot, targetForTab, handleReaderMessage, handle, acceptSnapshot, forgetTab };
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
    const openVoiceStudio = () => chromeApi.tabs.create({
      url: `${chromeApi.runtime.getURL('voice-studio.html')}#voices`,
    });
    const router = createMessageRouter({ api, storage, openVoiceStudio, offscreen });

    async function setBadge(target, snapshot) {
      if (!target || target.tabId == null || !chromeApi.action) return;
      const status = String(snapshot && snapshot.status || 'idle');
      const text = status === 'playing' ? '▶' : status === 'paused' ? '❚❚' : status === 'error' ? '!' : '';
      try {
        if (typeof chromeApi.action.setBadgeText === 'function') {
          await chromeApi.action.setBadgeText({ tabId: target.tabId, text });
        }
        if (typeof chromeApi.action.setBadgeBackgroundColor === 'function' && text) {
          await chromeApi.action.setBadgeBackgroundColor({
            tabId: target.tabId,
            color: status === 'error' ? '#dc2626' : status === 'paused' ? '#475569' : '#6d28d9',
          });
        }
        if (typeof chromeApi.action.setBadgeTextColor === 'function' && text) {
          await chromeApi.action.setBadgeTextColor({ tabId: target.tabId, color: '#ffffff' });
        }
      } catch (_) {
        // The badge is a convenience, never a playback dependency.
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
        respondWith(popupBroker.acceptSnapshot(message, sender).then(() => ({ ok: true })), sendResponse);
        return true;
      }
      const sourceTabId = sender && sender.tab && sender.tab.id != null
        ? sender.tab.id : null;
      const forwarded = sourceTabId == null || !message || message.sourceTabId != null
        ? message
        : Object.assign({}, message, { sourceTabId });
      respondWith(router(forwarded), sendResponse);
      return true;
    });
    if (chromeApi.commands && chromeApi.commands.onCommand) {
      chromeApi.commands.onCommand.addListener(async (command) => {
        if (command !== 'toggle-reader') return;
        const tabs = await chromeApi.tabs.query({ active: true, currentWindow: true });
        const tab = normalizeTabTarget(tabs && tabs[0]);
        const result = await popupBroker.requestSnapshot(tab);
        const pageKey = result && result.snapshot && result.snapshot.pageKey;
        if (!pageKey) return;
        const target = Object.assign({}, tab, { pageKey });
        const commandResult = await popupBroker.sendCommand(target, {
          command: 'play-toggle', source: 'shortcut', pageKey,
        });
        if (commandResult && commandResult.snapshot) await setBadge(target, commandResult.snapshot);
      });
    }
    if (chromeApi.tabs && chromeApi.tabs.onRemoved && typeof chromeApi.tabs.onRemoved.addListener === 'function') {
      chromeApi.tabs.onRemoved.addListener((tabId) => {
        void cancelPlaybackForTab(offscreen, tabId);
        void popupBroker.forgetTab(tabId);
        void pageEditorBroker.forgetTab(tabId);
      });
    }
    return { popupBroker, pageEditorBroker, stopPlaybackForTab: (tabId) => cancelPlaybackForTab(offscreen, tabId) };
  }

  return {
    OFFSCREEN_TARGET,
    STREAM_EVENT_TARGET,
    OFFSCREEN_PATH,
    REQUIRED_ORIGIN,
    SETTINGS_KEY,
    CLEANUP_QUEUE_KEY,
    cancelPlaybackForTab,
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
