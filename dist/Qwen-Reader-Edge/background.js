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

  function install(chromeApi) {
    const storage = chromeStorage(chromeApi);
    const api = apiModule.createApiClient({ storage });
    const offscreen = createOffscreenManager(chromeApi);
    const openVoiceStudio = () => chromeApi.tabs.create({
      url: chromeApi.runtime.getURL('voice-studio.html'),
    });
    const router = createMessageRouter({ api, storage, openVoiceStudio, offscreen });

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

    chromeApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message && message.target === STREAM_EVENT_TARGET) {
        forwardStreamEvent({ message, sender });
        return undefined;
      }
      if (message && message.target === OFFSCREEN_TARGET) {
        return undefined;
      }
      const sourceTabId = sender && sender.tab && sender.tab.id != null
        ? sender.tab.id : null;
      const forwarded = sourceTabId == null || !message || message.sourceTabId != null
        ? message
        : Object.assign({}, message, { sourceTabId });
      router(forwarded).then(sendResponse);
      return true;
    });

    async function toggleTab(tab) {
      if (!tab || tab.id == null) return;
      try {
        await chromeApi.tabs.sendMessage(tab.id, { type: 'ui:toggle' });
      } catch (_) {
        // Restricted Edge pages cannot receive content-script messages.
      }
    }

    if (chromeApi.action && chromeApi.action.onClicked) {
      chromeApi.action.onClicked.addListener(toggleTab);
    }
    if (chromeApi.commands && chromeApi.commands.onCommand) {
      chromeApi.commands.onCommand.addListener(async (command) => {
        if (command !== 'toggle-reader') return;
        const tabs = await chromeApi.tabs.query({ active: true, currentWindow: true });
        await toggleTab(tabs && tabs[0]);
      });
    }
  }

  return {
    OFFSCREEN_TARGET,
    STREAM_EVENT_TARGET,
    OFFSCREEN_PATH,
    REQUIRED_ORIGIN,
    SETTINGS_KEY,
    CLEANUP_QUEUE_KEY,
    createMessageRouter,
    createOffscreenManager,
    chromeStorage,
    errorEnvelope,
    repairVoiceSettings,
    install,
  };
}));
