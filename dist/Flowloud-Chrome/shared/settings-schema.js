(function settingsSchemaModule(root, factory) {
  const exported = factory(root.QwenReaderDefaults || {});
  if (typeof module === 'object' && module.exports) module.exports = exported;
  root.FlowloudSettings = exported;
}(typeof globalThis !== 'undefined' ? globalThis : this, function makeSettingsSchema(legacyDefaults) {
  'use strict';

  const SCHEMA_VERSION = 8;
  const SETTINGS_KEY = 'qwenReaderSettings'; // Retained so existing installations migrate in place.
  const SESSION_SECRET_KEY = 'flowloudProviderSecrets';
  const REMEMBERED_SECRET_KEY = 'flowloudRememberedProviderSecrets';
  const PROVIDER_IDS = Object.freeze([
    'browser-system',
    'browser-model',
    'local-service',
    'openai-compatible',
    'doubao-tts',
  ]);
  const LOCAL_ADAPTER_IDS = Object.freeze([
    'flowloud-qwen',
    'gpt-sovits',
    'cosyvoice',
    'openai-local',
  ]);
  const AI_PROTOCOLS = Object.freeze(['openai-chat', 'openai-responses', 'ollama-chat', 'flowloud-document-v1']);

  const DEFAULTS = Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    activeProviderId: 'browser-system',
    providerId: 'browser-system',
    providerVersion: 4,
    playbackRate: 1,
    readingMode: 'content',
    readingFocus: 'sentence',
    readingFocusStyle: legacyDefaults.readingFocusStyle || 'paper-wash',
    wordHighlightStyle: legacyDefaults.wordHighlightStyle || 'edge-dissolve',
    wordHighlightColor: legacyDefaults.wordHighlightColor || '#2563eb',
    wordHighlightGlow: Number.isFinite(Number(legacyDefaults.wordHighlightGlow)) ? Number(legacyDefaults.wordHighlightGlow) : 48,
    wordHighlightSpeed: Number.isFinite(Number(legacyDefaults.wordHighlightSpeed)) ? Number(legacyDefaults.wordHighlightSpeed) : 1,
    preset: 'everyone-one',
    voiceStrategyVersion: 2,
    onboardingComplete: false,
    transcriptionConsent: false,
    alwaysAllowedSites: Object.freeze([]),
    providerVoices: Object.freeze({
      'browser-system': '',
      'browser-model': 'browser-model:zf_001',
      'local-service': `local-service:${legacyDefaults.opVoice || '邵思萌'}`,
      'openai-compatible': 'openai-compatible:alloy',
      'doubao-tts': '',
    }),
    providerSettings: Object.freeze({
      'browser-system': Object.freeze({ rate: 1, pitch: 1, volume: 1, lang: '' }),
      'browser-model': Object.freeze({
        modelId: 'kokoro-zh',
        repoId: 'onnx-community/Kokoro-82M-v1.1-zh-ONNX',
        revision: '71bfd8ce077d1f8c70a183704da7c55c1c4cded6',
        hfRevision: '6cc0f0d2ebe369a68b0df87c2b65c1af8c0ac3e3',
        source: 'modelscope',
        fallbackSource: 'huggingface',
        variant: 'auto',
        dtype: 'auto',
        // The v1.1-zh WebGPU graph can return clipped/spiky PCM on some
        // Chromium/ORT combinations. WASM is the compatibility-safe default;
        // WebGPU remains an explicit opt-in in the settings UI.
        device: 'wasm',
        allowWasmFallback: true,
        downloadConcurrency: 4,
        starterVoiceIds: Object.freeze(['zf_001', 'zf_002', 'zm_009', 'zm_010']),
        downloaded: false,
        cacheMetadata: {},
        voiceCacheRegistry: {},
      }),
      'local-service': Object.freeze({
        adapterId: 'flowloud-qwen',
        baseUrl: 'http://127.0.0.1:7811',
        model: legacyDefaults.model || 'qwen3-tts-0.6b-q4',
        responseFormat: 'wav',
        rememberToken: false,
      }),
      'openai-compatible': Object.freeze({
        baseUrl: '', model: '', voiceIds: Object.freeze(['alloy']), responseFormat: 'mp3', rememberKey: false,
      }),
      'doubao-tts': Object.freeze({
        baseUrl: 'https://openspeech.bytedance.com', path: '/api/v3/tts/unidirectional',
        appId: '', resourceId: 'seed-tts-2.0', voiceIds: Object.freeze([]), responseFormat: 'mp3', rememberKey: false,
      }),
    }),
    voiceAssignmentsByProvider: Object.freeze({
      'browser-system': Object.freeze({ narratorVoiceId: '', replyVoiceIds: Object.freeze([]), authorVoices: Object.freeze({}) }),
      'browser-model': Object.freeze({ narratorVoiceId: 'browser-model:zf_001', replyVoiceIds: Object.freeze(['browser-model:zm_010']), authorVoices: Object.freeze({}) }),
      'local-service': Object.freeze({
        narratorVoiceId: `local-service:${legacyDefaults.opVoice || '邵思萌'}`,
        replyVoiceIds: Object.freeze((legacyDefaults.replyVoices || ['qwen-clone']).map((voice) => `local-service:${voice}`)),
        authorVoices: Object.freeze({}),
      }),
      'openai-compatible': Object.freeze({ narratorVoiceId: 'openai-compatible:alloy', replyVoiceIds: Object.freeze([]), authorVoices: Object.freeze({}) }),
      'doubao-tts': Object.freeze({ narratorVoiceId: '', replyVoiceIds: Object.freeze([]), authorVoices: Object.freeze({}) }),
    }),
    modelCacheRegistry: Object.freeze({}),
    legacyDataState: Object.freeze({ isolated: false, inspectedAt: 0, migratedVoiceProfiles: 0 }),
    guide: Object.freeze({ filter: 'all', continuous: false, announceStates: true }),
    aiProfiles: Object.freeze([]),
    aiProfileSelections: Object.freeze({ ocr: '', translation: '' }),
    documentWorkbench: Object.freeze({ sourceLanguage: 'auto', targetLanguage: 'zh-CN', workflow: 'ocr-translate' }),
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

  function boundedNumber(value, minimum, maximum, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
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

  function sanitizeLocalBaseUrl(value) {
    const candidate = String(value == null ? '' : value).trim().replace(/\/+$/, '');
    if (!candidate) return 'http://127.0.0.1:7811';
    let parsed;
    try { parsed = new URL(candidate); } catch (_) { throw new TypeError('本地 TTS 地址无效。'); }
    const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '[::1]';
    if (!loopback || !['http:', 'https:'].includes(parsed.protocol)) {
      throw new TypeError('本地 TTS 只允许 localhost、127.0.0.1 或 ::1。');
    }
    if (parsed.username || parsed.password) throw new TypeError('本地 TTS 地址不能包含用户名或密码。');
    return parsed.toString().replace(/\/$/, '');
  }

  function normalizeLocalAdapter(value) {
    const id = String(value == null ? '' : value).trim();
    return LOCAL_ADAPTER_IDS.includes(id) ? id : 'flowloud-qwen';
  }

  function sanitizeAiProfile(value) {
    const source = object(value);
    const id = String(source.id == null ? '' : source.id).trim();
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(id)) return null;
    const protocol = AI_PROTOCOLS.includes(String(source.protocol)) ? String(source.protocol) : 'openai-chat';
    const capabilities = object(source.capabilities);
    const customHeaders = {};
    for (const [name, rawValue] of Object.entries(object(source.customHeaders)).slice(0, 12)) {
      const headerName = String(name).trim();
      if (!/^[A-Za-z0-9-]{1,80}$/u.test(headerName) || /authorization|cookie|api[-_]?key|token|secret/i.test(headerName)) continue;
      customHeaders[headerName] = String(rawValue == null ? '' : rawValue).slice(0, 256);
    }
    return {
      id,
      label: String(source.label || id).trim().slice(0, 80) || id,
      protocol,
      baseUrl: sanitizeOnlineBaseUrl(source.baseUrl),
      model: String(source.model || '').trim().slice(0, 256),
      authHeader: String(source.authHeader == null ? (protocol === 'ollama-chat' ? '' : 'Authorization') : source.authHeader).trim().slice(0, 80),
      authScheme: String(source.authScheme == null ? (protocol === 'ollama-chat' ? '' : 'Bearer') : source.authScheme).trim().slice(0, 32),
      timeoutMs: Math.min(600000, Math.max(5000, Number(source.timeoutMs) || 120000)),
      customHeaders,
      rememberSecret: source.rememberSecret === true,
      capabilities: {
        textTranslation: capabilities.textTranslation === true,
        visionOcr: capabilities.visionOcr === true,
        pdfInput: capabilities.pdfInput === true,
        structuredOutput: capabilities.structuredOutput !== false,
        streaming: capabilities.streaming === true,
      },
    };
  }

  function migrate(input) {
    const source = object(input);
    const result = Object.assign({}, clone(legacyDefaults), clone(DEFAULTS), clone(source));
    const requestedProvider = source.activeProviderId || source.providerId;
    result.activeProviderId = requestedProvider === 'local-qwen' ? 'local-service' : (
      PROVIDER_IDS.includes(requestedProvider) ? requestedProvider : 'browser-system'
    );
    result.providerId = result.activeProviderId;
    result.providerVersion = 4;
    result.schemaVersion = SCHEMA_VERSION;
    result.playbackRate = rate(source.playbackRate);
    result.readingMode = source.readingMode === 'guide' ? 'guide' : 'content';
    result.readingFocus = ['off', 'sentence', 'line'].includes(String(source.readingFocus)) ? String(source.readingFocus) : 'sentence';
    result.readingFocusStyle = ['soft-glow', 'edge-glow', 'paper-wash', 'underline-guide'].includes(String(source.readingFocusStyle))
      ? String(source.readingFocusStyle) : DEFAULTS.readingFocusStyle;
    result.wordHighlightStyle = ['edge-dissolve', 'classic-glow', 'aurora-tide', 'custom'].includes(String(source.wordHighlightStyle))
      ? String(source.wordHighlightStyle) : DEFAULTS.wordHighlightStyle;
    result.wordHighlightColor = /^#[0-9a-f]{6}$/iu.test(String(source.wordHighlightColor || ''))
      ? String(source.wordHighlightColor).toLowerCase() : DEFAULTS.wordHighlightColor;
    result.wordHighlightGlow = boundedNumber(source.wordHighlightGlow, 0, 100, DEFAULTS.wordHighlightGlow);
    result.wordHighlightSpeed = boundedNumber(source.wordHighlightSpeed, 0.6, 1.8, DEFAULTS.wordHighlightSpeed);
    const requestedPreset = String(source.preset || source.voiceMode || '').trim();
    const presetAliases = {
      'stable-author': 'op-stable-random',
      'round-robin': 'op-round-robin',
    };
    const supportedPresets = ['everyone-one', 'op-plus-one', 'op-stable-random', 'op-round-robin'];
    const normalizedPreset = presetAliases[requestedPreset] || requestedPreset;
    // V1 used `op-exclusive` as an implicit default. Migrate that implicit
    // default once so existing users do not keep hearing unselected fallback
    // voices after the new single-voice default ships.
    result.preset = Number(source.voiceStrategyVersion || 0) < 2 && (!requestedPreset || requestedPreset === 'op-exclusive')
      ? 'everyone-one'
      : (supportedPresets.includes(normalizedPreset) ? normalizedPreset : 'everyone-one');
    result.voiceStrategyVersion = 2;

    const incomingSettings = object(source.providerSettings);
    result.providerSettings = {};
    for (const id of PROVIDER_IDS) {
      result.providerSettings[id] = Object.assign({}, clone(DEFAULTS.providerSettings[id]), clone(object(incomingSettings[id])));
    }
    const browserModelSettings = result.providerSettings['browser-model'];
    const incomingBrowserModel = object(incomingSettings['browser-model']);
    const replaceObsoleteBrowserModel = Number(source.schemaVersion || 0) < 6 && !['kokoro-zh'].includes(String(browserModelSettings.modelId || ''));
    if (replaceObsoleteBrowserModel) {
      result.providerSettings['browser-model'] = clone(DEFAULTS.providerSettings['browser-model']);
    }
    // Existing installs used the pinned Hugging Face URL implicitly. Preserve
    // their cache metadata for diagnostics, but make the source explicit and
    // switch new downloads to ModelScope. An explicitly selected manual HF
    // source remains untouched.
    const migratedBrowserModel = result.providerSettings['browser-model'];
    const explicitSource = String(incomingBrowserModel.source || incomingBrowserModel.sourceId || '').trim().toLowerCase();
    if (!['modelscope', 'huggingface'].includes(explicitSource)) migratedBrowserModel.source = 'modelscope';
    else migratedBrowserModel.source = explicitSource;
    migratedBrowserModel.fallbackSource = 'huggingface';
    migratedBrowserModel.hfRevision = String(migratedBrowserModel.hfRevision || '6cc0f0d2ebe369a68b0df87c2b65c1af8c0ac3e3');
    if (migratedBrowserModel.source === 'modelscope' && !explicitSource) {
      if (migratedBrowserModel.revision && migratedBrowserModel.revision !== DEFAULTS.providerSettings['browser-model'].revision) {
        migratedBrowserModel.legacyRevision = String(migratedBrowserModel.revision);
      }
      migratedBrowserModel.revision = DEFAULTS.providerSettings['browser-model'].revision;
    } else if (migratedBrowserModel.source === 'huggingface' && !incomingBrowserModel.revision) {
      // An imported/manual HF source may omit revision because the old schema
      // only stored a single implicit URL. Never pair that source with the
      // ModelScope commit inherited from DEFAULTS.
      migratedBrowserModel.revision = migratedBrowserModel.hfRevision;
    }
    const variant = String(migratedBrowserModel.variant || '').toLowerCase();
    // The v1.1-zh ONNX fp16/q8 exports currently produce silent PCM in the
    // bundled browser runtime. Migrate old selections to the verified fp32
    // path so an existing install cannot remain apparently ready but silent.
    migratedBrowserModel.variant = variant === 'fp32' ? 'fp32' : 'auto';
    migratedBrowserModel.dtype = 'fp32';
    // Versions through schema 6 defaulted to WebGPU without validating the
    // returned waveform. Move those installs to the verified WASM path so a
    // reload cannot leave an apparently-ready model producing static.
    if (Number(source.schemaVersion || 0) < 7) migratedBrowserModel.device = 'wasm';
    const concurrency = Number(migratedBrowserModel.downloadConcurrency);
    migratedBrowserModel.downloadConcurrency = Number.isFinite(concurrency) ? Math.min(4, Math.max(1, Math.floor(concurrency))) : 4;
    const starterVoices = Array.isArray(migratedBrowserModel.starterVoiceIds) ? migratedBrowserModel.starterVoiceIds : DEFAULTS.providerSettings['browser-model'].starterVoiceIds;
    migratedBrowserModel.starterVoiceIds = [...new Set(starterVoices.map((voice) => String(voice || '').replace(/^browser-model:/u, '').trim()).filter(Boolean))].slice(0, 16);
    migratedBrowserModel.voiceCacheRegistry = clone(object(migratedBrowserModel.voiceCacheRegistry));
    const legacyLocalSettings = object(incomingSettings['local-qwen']);
    if (Object.keys(legacyLocalSettings).length) {
      result.providerSettings['local-service'] = Object.assign({}, result.providerSettings['local-service'], clone(legacyLocalSettings), {
        adapterId: 'flowloud-qwen',
      });
    }
    if (source.apiBaseUrl || source.model || source.responseFormat || object(source.providerOptions).baseUrl) {
      result.providerSettings['local-service'] = Object.assign({}, result.providerSettings['local-service'], {
        baseUrl: object(source.providerOptions).baseUrl || source.apiBaseUrl || 'http://127.0.0.1:7811',
        model: object(source.providerOptions).model || source.model || result.providerSettings['local-service'].model,
        responseFormat: object(source.providerOptions).responseFormat || source.responseFormat || 'wav',
      });
    }
    result.providerSettings['local-service'].adapterId = normalizeLocalAdapter(result.providerSettings['local-service'].adapterId);
    result.providerSettings['local-service'].baseUrl = sanitizeLocalBaseUrl(result.providerSettings['local-service'].baseUrl);
    result.providerSettings['local-service'].rememberToken = result.providerSettings['local-service'].rememberToken === true;

    // V8 keeps discoverable online voices as an array. The currently selected
    // voice lives only in voiceAssignmentsByProvider.
    const legacyConfigVoices = {};
    for (const id of ['openai-compatible', 'doubao-tts']) {
      const config = result.providerSettings[id];
      const incomingConfig = object(incomingSettings[id]);
      legacyConfigVoices[id] = splitVoice(incomingConfig.voice || config.voice).voiceId;
      const incomingVoiceIds = Array.isArray(incomingConfig.voiceIds) ? incomingConfig.voiceIds : [];
      const defaultVoiceIds = Array.isArray(DEFAULTS.providerSettings[id].voiceIds) ? DEFAULTS.providerSettings[id].voiceIds : [];
      const sourceVoiceIds = incomingVoiceIds.length ? incomingVoiceIds : (legacyConfigVoices[id] ? [legacyConfigVoices[id]] : defaultVoiceIds);
      config.voiceIds = [...new Set(sourceVoiceIds
        .map((voice) => splitVoice(voice).voiceId.trim()).filter(Boolean))].slice(0, 64);
      delete config.voice;
    }

    const incomingProviderVoices = object(source.providerVoices);
    const migratedProviderVoices = Object.assign({}, clone(DEFAULTS.providerVoices), clone(incomingProviderVoices));
    if (replaceObsoleteBrowserModel) migratedProviderVoices['browser-model'] = DEFAULTS.providerVoices['browser-model'];
    const legacyLocalVoice = splitVoice(incomingProviderVoices['local-qwen']).voiceId;
    if (legacyLocalVoice) migratedProviderVoices['local-service'] = namespaceVoice('local-service', legacyLocalVoice);
    if (source.opVoice) migratedProviderVoices['local-service'] = namespaceVoice('local-service', source.opVoice);
    const incomingAssignments = object(source.voiceAssignmentsByProvider);
    result.voiceAssignmentsByProvider = {};
    for (const id of PROVIDER_IDS) {
      const incomingAssignment = object(incomingAssignments[id]);
      const configuredVoice = id === 'openai-compatible' || id === 'doubao-tts'
        ? legacyConfigVoices[id] || result.providerSettings[id].voiceIds[0] : '';
      const providerVoice = id === 'local-service' && legacyLocalVoice
        ? legacyLocalVoice : splitVoice(incomingProviderVoices[id]).voiceId;
      const selectedVoice = splitVoice(incomingAssignment.narratorVoiceId).voiceId
        || providerVoice
        || configuredVoice
        || splitVoice(DEFAULTS.voiceAssignmentsByProvider[id].narratorVoiceId).voiceId;
      result.voiceAssignmentsByProvider[id] = normalizeAssignment(id, {
        ...incomingAssignment,
        narratorVoiceId: selectedVoice,
      }, DEFAULTS.voiceAssignmentsByProvider[id]);
    }
    if (replaceObsoleteBrowserModel) result.voiceAssignmentsByProvider['browser-model'] = clone(DEFAULTS.voiceAssignmentsByProvider['browser-model']);
    if (incomingAssignments['local-qwen']) {
      result.voiceAssignmentsByProvider['local-service'] = normalizeAssignment(
        'local-service', incomingAssignments['local-qwen'], result.voiceAssignmentsByProvider['local-service'],
      );
    }
    // V4 and earlier stored Qwen narrator/reply assignments globally. They
    // remain available only to local-service and can never leak into system TTS.
    if (Number(source.schemaVersion || 0) < 4 && (source.opVoice || Array.isArray(source.replyVoices))) {
      result.voiceAssignmentsByProvider['local-service'] = normalizeAssignment('local-service', {
        narratorVoiceId: source.opVoice || result.voiceAssignmentsByProvider['local-service'].narratorVoiceId,
        replyVoiceIds: Array.isArray(source.replyVoices) ? source.replyVoices : result.voiceAssignmentsByProvider['local-service'].replyVoiceIds,
        authorVoices: object(source.authorVoices),
      }, DEFAULTS.voiceAssignmentsByProvider['local-service']);
    }
    // Compatibility fields are projections only. Runtime surfaces must write
    // voiceAssignmentsByProvider through settings:voice:assign.
    result.providerVoices = {};
    for (const id of PROVIDER_IDS) {
      result.providerVoices[id] = result.voiceAssignmentsByProvider[id].narratorVoiceId;
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
    const seenProfileIds = new Set();
    result.aiProfiles = (Array.isArray(source.aiProfiles) ? source.aiProfiles : [])
      .map(sanitizeAiProfile).filter((profile) => profile && !seenProfileIds.has(profile.id) && seenProfileIds.add(profile.id));
    const incomingSelections = object(source.aiProfileSelections);
    const profileIds = new Set(result.aiProfiles.map((profile) => profile.id));
    result.aiProfileSelections = {
      ocr: profileIds.has(String(incomingSelections.ocr || '')) ? String(incomingSelections.ocr) : '',
      translation: profileIds.has(String(incomingSelections.translation || '')) ? String(incomingSelections.translation) : '',
    };
    const workbench = object(source.documentWorkbench);
    result.documentWorkbench = {
      sourceLanguage: String(workbench.sourceLanguage || 'auto').slice(0, 32),
      targetLanguage: String(workbench.targetLanguage || 'zh-CN').slice(0, 32),
      workflow: ['ocr', 'translate', 'ocr-translate'].includes(String(workbench.workflow)) ? String(workbench.workflow) : 'ocr-translate',
    };
    result.alwaysAllowedSites = Array.isArray(source.alwaysAllowedSites) ? [...new Set(source.alwaysAllowedSites.map(String))] : [];
    return result;
  }

  function publicSettings(value) {
    const settings = migrate(value);
    const secretKeys = ['apiKey', 'secret', 'clientToken', 'token', 'bearerToken', 'authorization', 'password', 'headers'];
    for (const key of secretKeys) delete settings[key];
    for (const config of Object.values(settings.providerSettings)) {
      for (const key of secretKeys) delete config[key];
    }
    return settings;
  }

  return Object.freeze({
    SCHEMA_VERSION, SETTINGS_KEY, SESSION_SECRET_KEY, REMEMBERED_SECRET_KEY,
    PROVIDER_IDS, LOCAL_ADAPTER_IDS, AI_PROTOCOLS, DEFAULTS, migrate, rate, namespaceVoice, splitVoice,
    sanitizeOnlineBaseUrl, sanitizeLocalBaseUrl, normalizeLocalAdapter, sanitizeAiProfile, publicSettings, normalizeAssignment,
  });
}));
