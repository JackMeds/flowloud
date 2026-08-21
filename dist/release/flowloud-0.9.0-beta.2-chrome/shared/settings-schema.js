(function settingsSchemaModule(root, factory) {
  const exported = factory(root.QwenReaderDefaults || {});
  if (typeof module === 'object' && module.exports) module.exports = exported;
  root.FlowloudSettings = exported;
}(typeof globalThis !== 'undefined' ? globalThis : this, function makeSettingsSchema(legacyDefaults) {
  'use strict';

  const SCHEMA_VERSION = 4;
  const SETTINGS_KEY = 'qwenReaderSettings'; // Retained so existing installations migrate in place.
  const SESSION_SECRET_KEY = 'flowloudProviderSecrets';
  const REMEMBERED_SECRET_KEY = 'flowloudRememberedProviderSecrets';
  const PROVIDER_IDS = Object.freeze([
    'browser-system',
    'browser-model',
    'local-qwen',
    'openai-compatible',
  ]);

  const DEFAULTS = Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    activeProviderId: 'browser-system',
    providerId: 'browser-system',
    providerVersion: 3,
    playbackRate: 1,
    readingMode: 'content',
    onboardingComplete: false,
    transcriptionConsent: false,
    alwaysAllowedSites: Object.freeze([]),
    providerVoices: Object.freeze({
      'browser-system': '',
      'browser-model': 'browser-model:cmn-default',
      'local-qwen': `local-qwen:${legacyDefaults.opVoice || '邵思萌'}`,
      'openai-compatible': 'openai-compatible:alloy',
    }),
    providerSettings: Object.freeze({
      'browser-system': Object.freeze({ rate: 1, pitch: 1, volume: 1, lang: '' }),
      'browser-model': Object.freeze({
        modelId: 'cmn-vits',
        repoId: 'BricksDisplay/vits-cmn',
        revision: '3265ca20151fb9c79fa00c8f3874cacb2c15b2ce',
        dtype: 'q8',
        device: 'webgpu',
        allowWasmFallback: true,
        downloaded: false,
        cacheMetadata: {},
      }),
      'local-qwen': Object.freeze({
        baseUrl: 'http://127.0.0.1:7811',
        model: legacyDefaults.model || 'qwen3-tts-0.6b-q4',
        responseFormat: 'wav',
      }),
      'openai-compatible': Object.freeze({
        baseUrl: '', model: '', voice: 'alloy', responseFormat: 'mp3', rememberKey: false,
      }),
    }),
    voiceAssignmentsByProvider: Object.freeze({
      'browser-system': Object.freeze({ narratorVoiceId: '', replyVoiceIds: Object.freeze([]), authorVoices: Object.freeze({}) }),
      'browser-model': Object.freeze({ narratorVoiceId: 'browser-model:cmn-default', replyVoiceIds: Object.freeze([]), authorVoices: Object.freeze({}) }),
      'local-qwen': Object.freeze({
        narratorVoiceId: `local-qwen:${legacyDefaults.opVoice || '邵思萌'}`,
        replyVoiceIds: Object.freeze((legacyDefaults.replyVoices || ['qwen-clone']).map((voice) => `local-qwen:${voice}`)),
        authorVoices: Object.freeze({}),
      }),
      'openai-compatible': Object.freeze({ narratorVoiceId: 'openai-compatible:alloy', replyVoiceIds: Object.freeze([]), authorVoices: Object.freeze({}) }),
    }),
    modelCacheRegistry: Object.freeze({}),
    legacyDataState: Object.freeze({ isolated: false, inspectedAt: 0, migratedVoiceProfiles: 0 }),
    guide: Object.freeze({ filter: 'all', continuous: false, announceStates: true }),
  });

  function object(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function clone(value) {
    if (Array.isArray(value)) return value.map(clone);
    if (!value || typeof value !== 'object') return value;
    const copy = {};
    for (const [key, item] of Object.entries(value)) copy[key] = clone(item);
    return copy;
  }

  function rate(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.min(2, Math.max(0.75, parsed)) : 1;
  }

  function namespaceVoice(providerId, voiceId) {
    const provider = PROVIDER_IDS.includes(String(providerId)) ? String(providerId) : 'browser-system';
    const raw = String(voiceId == null ? '' : voiceId).trim();
    if (!raw) return '';
    return raw.startsWith(`${provider}:`) ? raw : `${provider}:${raw}`;
  }

  function splitVoice(value) {
    const raw = String(value == null ? '' : value);
    const separator = raw.indexOf(':');
    if (separator < 1) return { providerId: '', voiceId: raw };
    return { providerId: raw.slice(0, separator), voiceId: raw.slice(separator + 1) };
  }

  function normalizeAssignment(providerId, input, fallback) {
    const source = object(input);
    const base = object(fallback);
    const narrator = namespaceVoice(providerId, splitVoice(source.narratorVoiceId || base.narratorVoiceId).voiceId);
    const replies = Array.isArray(source.replyVoiceIds) ? source.replyVoiceIds : (Array.isArray(base.replyVoiceIds) ? base.replyVoiceIds : []);
    const authorVoices = {};
    for (const [authorId, voice] of Object.entries(object(source.authorVoices || base.authorVoices))) {
      const normalized = namespaceVoice(providerId, splitVoice(voice).voiceId);
      if (normalized) authorVoices[String(authorId)] = normalized;
    }
    return {
      narratorVoiceId: narrator,
      replyVoiceIds: [...new Set(replies.map((voice) => namespaceVoice(providerId, splitVoice(voice).voiceId)).filter((voice) => voice && voice !== narrator))],
      authorVoices,
    };
  }

  function sanitizeOnlineBaseUrl(value) {
    const candidate = String(value == null ? '' : value).trim().replace(/\/+$/, '');
    if (!candidate) return '';
    let parsed;
    try { parsed = new URL(candidate); } catch (_) { throw new TypeError('在线 TTS 地址无效。'); }
    const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '[::1]';
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
      throw new TypeError('在线 TTS 必须使用 HTTPS；仅回环地址允许 HTTP。');
    }
    if (parsed.username || parsed.password) throw new TypeError('在线 TTS 地址不能包含用户名或密码。');
    return parsed.toString().replace(/\/$/, '');
  }

  function migrate(input) {
    const source = object(input);
    const result = Object.assign({}, clone(legacyDefaults), clone(DEFAULTS), clone(source));
    const requestedProvider = source.activeProviderId || source.providerId;
    result.activeProviderId = PROVIDER_IDS.includes(requestedProvider) ? requestedProvider :
      (source.schemaVersion ? 'browser-system' : (requestedProvider === 'local-qwen' ? 'local-qwen' : 'browser-system'));
    result.providerId = result.activeProviderId;
    result.providerVersion = 3;
    result.schemaVersion = SCHEMA_VERSION;
    result.playbackRate = rate(source.playbackRate);
    result.readingMode = source.readingMode === 'guide' ? 'guide' : 'content';

    const incomingSettings = object(source.providerSettings);
    result.providerSettings = {};
    for (const id of PROVIDER_IDS) {
      result.providerSettings[id] = Object.assign({}, clone(DEFAULTS.providerSettings[id]), clone(object(incomingSettings[id])));
    }
    if (source.apiBaseUrl || source.model || source.responseFormat || object(source.providerOptions).baseUrl) {
      result.providerSettings['local-qwen'] = Object.assign({}, result.providerSettings['local-qwen'], {
        baseUrl: object(source.providerOptions).baseUrl || source.apiBaseUrl || 'http://127.0.0.1:7811',
        model: object(source.providerOptions).model || source.model || result.providerSettings['local-qwen'].model,
        responseFormat: object(source.providerOptions).responseFormat || source.responseFormat || 'wav',
      });
    }

    result.providerVoices = Object.assign({}, clone(DEFAULTS.providerVoices), clone(object(source.providerVoices)));
    if (source.opVoice) result.providerVoices['local-qwen'] = namespaceVoice('local-qwen', source.opVoice);
    for (const id of PROVIDER_IDS) {
      result.providerVoices[id] = namespaceVoice(id, splitVoice(result.providerVoices[id]).voiceId);
    }
    const incomingAssignments = object(source.voiceAssignmentsByProvider);
    result.voiceAssignmentsByProvider = {};
    for (const id of PROVIDER_IDS) {
      result.voiceAssignmentsByProvider[id] = normalizeAssignment(id, incomingAssignments[id], DEFAULTS.voiceAssignmentsByProvider[id]);
    }
    // V3 and earlier stored Qwen narrator/reply assignments globally. They
    // remain available only to local-qwen and can never leak into system TTS.
    if (Number(source.schemaVersion || 0) < 4 && (source.opVoice || Array.isArray(source.replyVoices))) {
      result.voiceAssignmentsByProvider['local-qwen'] = normalizeAssignment('local-qwen', {
        narratorVoiceId: source.opVoice || result.voiceAssignmentsByProvider['local-qwen'].narratorVoiceId,
        replyVoiceIds: Array.isArray(source.replyVoices) ? source.replyVoices : result.voiceAssignmentsByProvider['local-qwen'].replyVoiceIds,
        authorVoices: object(source.authorVoices),
      }, DEFAULTS.voiceAssignmentsByProvider['local-qwen']);
    }
    result.modelCacheRegistry = clone(object(source.modelCacheRegistry));
    result.legacyDataState = Object.assign({}, clone(DEFAULTS.legacyDataState), clone(object(source.legacyDataState)), {
      isolated: true,
    });
    const activeAssignment = result.voiceAssignmentsByProvider[result.activeProviderId];
    // Compatibility projection for older content scripts during the V4
    // rollout. Values are always scoped to the active provider.
    result.opVoice = splitVoice(activeAssignment.narratorVoiceId).voiceId;
    result.replyVoices = activeAssignment.replyVoiceIds.map((voice) => splitVoice(voice).voiceId);
    result.guide = Object.assign({}, clone(DEFAULTS.guide), clone(object(source.guide)));
    result.alwaysAllowedSites = Array.isArray(source.alwaysAllowedSites) ? [...new Set(source.alwaysAllowedSites.map(String))] : [];
    return result;
  }

  function publicSettings(value) {
    const settings = migrate(value);
    delete settings.apiKey;
    delete settings.secret;
    for (const config of Object.values(settings.providerSettings)) {
      delete config.apiKey;
      delete config.authorization;
    }
    return settings;
  }

  return Object.freeze({
    SCHEMA_VERSION, SETTINGS_KEY, SESSION_SECRET_KEY, REMEMBERED_SECRET_KEY,
    PROVIDER_IDS, DEFAULTS, migrate, rate, namespaceVoice, splitVoice,
    sanitizeOnlineBaseUrl, publicSettings, normalizeAssignment,
  });
}));
