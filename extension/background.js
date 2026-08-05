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

  function install(chromeApi) {
    const storage = chromeStorage(chromeApi);
    const api = apiModule.createApiClient({ storage });
    const offscreen = createOffscreenManager(chromeApi);
    const openVoiceStudio = () => chromeApi.tabs.create({
      url: chromeApi.runtime.getURL('voice-studio.html'),
    });
    const router = createMessageRouter({ api, storage, openVoiceStudio, offscreen });
    chromeApi.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message && message.target === OFFSCREEN_TARGET) return undefined;
      router(message).then(sendResponse);
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
    OFFSCREEN_PATH,
    REQUIRED_ORIGIN,
    SETTINGS_KEY,
    createMessageRouter,
    createOffscreenManager,
    chromeStorage,
    errorEnvelope,
    repairVoiceSettings,
    install,
  };
}));
