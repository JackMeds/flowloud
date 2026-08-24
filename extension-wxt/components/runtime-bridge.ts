import { demoPopupModel, type ModelDownloadState, type PopupAuthor, type PopupModel, type PopupSettings, type PopupVoice, type ProviderState, type ReaderStatus } from './model';
import type { DocumentArtifact, TranslationArtifact } from './document-model';

export interface RuntimeError {
  stage?: string;
  code?: string;
  message?: string;
  retryable?: boolean;
}

export interface RuntimeEnvelope {
  ok?: boolean;
  error?: RuntimeError;
  settings?: Record<string, unknown>;
  snapshot?: Record<string, unknown>;
  playback?: Record<string, unknown>;
  result?: Record<string, unknown>;
  secrets?: Record<string, { present?: boolean; remembered?: boolean }>;
  [key: string]: unknown;
}

export interface RuntimeContext extends RuntimeEnvelope {
  tabId?: number;
  pageKey?: string;
  title?: string;
  sourceLabel?: string;
  authors?: PopupAuthor[];
  currentTab?: { tabId?: number; title?: string; url?: string };
  globalPlayback?: Record<string, unknown>;
  sourceIsCurrentTab?: boolean;
}

interface ChromeRuntimeLike {
  sendMessage: (message: Record<string, unknown>) => Promise<RuntimeEnvelope>;
  openOptionsPage: () => Promise<void>;
  onMessage?: {
    addListener: (listener: (message: Record<string, unknown>) => void) => void;
    removeListener: (listener: (message: Record<string, unknown>) => void) => void;
  };
}

interface ChromeLike {
  runtime?: ChromeRuntimeLike;
  permissions?: {
    contains: (permissions: { origins: string[] }) => Promise<boolean>;
    request: (permissions: { origins: string[] }) => Promise<boolean>;
  };
  tabs?: { create: (options: { url: string }) => Promise<unknown> };
}

declare const chrome: ChromeLike;

function runtimeChrome(): ChromeLike | null {
  return typeof chrome !== 'undefined' ? chrome : null;
}

function runtimeError(response: RuntimeEnvelope, fallback: string) {
  const error = new globalThis.Error(response.error?.message || fallback) as Error & { code?: string; retryable?: boolean };
  error.code = response.error?.code;
  error.retryable = response.error?.retryable;
  return error;
}

function readerStatus(value: unknown): ReaderStatus {
  const status = String(value || 'ready');
  if (status === 'extracting' || status === 'synthesizing') return 'loading';
  return ['idle', 'ready', 'loading', 'playing', 'paused', 'error'].includes(status)
    ? status as ReaderStatus : 'ready';
}

function popupSettings(raw: Record<string, unknown>): PopupSettings {
  return { ...demoPopupModel.settings, ...raw } as PopupSettings;
}

function popupAuthors(raw: unknown): PopupAuthor[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((author) => {
    const source = author && typeof author === 'object' ? author as Record<string, unknown> : {};
    return {
      id: String(source.id || source.key || ''),
      name: String(source.name || source.authorName || source.id || source.key || '未命名作者'),
      voice: String(source.voice || source.effectiveVoice || ''),
      role: String(source.role || ''),
      isOp: source.isOp === true,
      count: Math.max(0, Number(source.count) || 0),
    };
  }).filter((author) => author.id);
}

function popupModel(context: RuntimeContext, snapshot: Record<string, unknown>, settings: PopupSettings, rawSettings: Record<string, unknown>): PopupModel {
  const current = snapshot.current && typeof snapshot.current === 'object'
    ? snapshot.current as Record<string, unknown> : {};
  const words = Array.isArray(current.words) ? current.words.map((word) => {
    const value = word && typeof word === 'object' ? word as Record<string, unknown> : {};
    return { text: String(value.text || ''), sourceStart: Number(value.sourceStart), sourceEnd: Number(value.sourceEnd) };
  }).filter((word) => word.text && Number.isInteger(word.sourceStart) && Number.isInteger(word.sourceEnd) && word.sourceEnd > word.sourceStart) : [];
  const global = context.globalPlayback && typeof context.globalPlayback === 'object'
    ? context.globalPlayback : {};
  const providerId = settings.activeProviderId;
  const providerVoices = rawSettings.providerVoices && typeof rawSettings.providerVoices === 'object'
    ? rawSettings.providerVoices as Record<string, unknown> : {};
  const providerSettings = rawSettings.providerSettings && typeof rawSettings.providerSettings === 'object'
    ? rawSettings.providerSettings as Record<string, Record<string, unknown>> : {};
  const providerConfig = providerSettings[providerId] || {};
  const cacheMetadata = providerConfig.cacheMetadata && typeof providerConfig.cacheMetadata === 'object'
    ? providerConfig.cacheMetadata as Record<string, unknown> : {};
  return {
    title: String(context.title || snapshot.title || '当前网页'),
    sourceLabel: String(context.sourceLabel || snapshot.adapter || '当前网页'),
    status: readerStatus(snapshot.status),
    index: Number(snapshot.index) || 0,
    total: Number(snapshot.segmentCount || snapshot.total) || 0,
    currentText: String(current.speechText || current.text || ''),
    currentSpeaker: String(current.authorName || ''),
    currentWords: words,
    currentWordIndex: Number.isInteger(Number(current.wordIndex)) ? Number(current.wordIndex) : -1,
    message: String(snapshot.error || ''),
    authors: popupAuthors(context.authors),
    settings,
    selectedVoiceId: String(providerVoices[providerId] || ''),
    voiceLoadState: 'idle',
    providerBaseUrl: providerId === 'local-service' ? String(providerConfig.baseUrl || 'http://127.0.0.1:7811') : '',
    providerDevice: providerId === 'browser-model' ? String(cacheMetadata.device || providerConfig.device || '') : '',
    providerAdapter: providerId === 'local-service' ? String(providerConfig.adapterId || 'flowloud-qwen') : '',
    isMock: false,
    currentTabId: Number(context.currentTab?.tabId ?? context.tabId) || null,
    sourceTabId: Number(global.sourceTabId ?? context.tabId) || null,
    globalPlayback: {
      active: global.active === true,
      state: String(global.state || 'idle'),
      sourceTabId: Number(global.sourceTabId) || null,
      pageKey: String(global.pageKey || ''),
      sourceIsCurrentTab: context.sourceIsCurrentTab === true,
    },
  };
}

export class RuntimeBridge {
  readonly available: boolean;
  private readonly runtime: ChromeRuntimeLike | null;
  private readonly registeredPageOrigins = new Set<string>();

  constructor() {
    const api = runtimeChrome();
    this.runtime = api?.runtime?.sendMessage ? api.runtime : null;
    this.available = Boolean(this.runtime);
  }

  async send(message: Record<string, unknown>) {
    if (!this.runtime) throw new globalThis.Error('当前是界面预览，尚未连接扩展运行时。');
    const response = await this.runtime.sendMessage(message);
    if (response?.ok === false) throw runtimeError(response, '扩展操作失败。');
    return response || {};
  }

  async loadPopup() {
    const [contextResponse, settingsResponse, playbackResponse] = await Promise.all([
      this.send({ type: 'reader:active-context' }),
      this.send({ type: 'settings:get' }),
      this.send({ type: 'playback:global:get' }),
    ]);
    const context = contextResponse as RuntimeContext;
    if (!context.globalPlayback && playbackResponse.playback) context.globalPlayback = playbackResponse.playback;
    const rawSettings = settingsResponse.settings || {};
    const settings = popupSettings(rawSettings);
    const snapshot = context.snapshot && typeof context.snapshot === 'object'
      ? context.snapshot : await this.send({ type: 'reader:snapshot:get', tabId: context.tabId });
    const model = popupModel(context, snapshot as Record<string, unknown>, settings, rawSettings);
    model.persistentSiteAccess = await this.hasPageOrigin(context);
    if (model.persistentSiteAccess) await this.registerPageOrigin(context).catch(() => {});
    return {
      context,
      rawSettings,
      model,
    };
  }

  private pageOrigin(context: RuntimeContext | null) {
    const rawUrl = String(context?.currentTab?.url || '');
    let parsed: URL;
    try { parsed = new URL(rawUrl); }
    catch (_) { throw new globalThis.Error('当前页面不支持持续显示悬浮播放器。'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new globalThis.Error('当前页面不支持持续显示悬浮播放器。');
    }
    return `${parsed.origin}/*`;
  }

  async hasPageOrigin(context: RuntimeContext | null) {
    const api = runtimeChrome();
    if (!api?.permissions?.contains) return true;
    try {
      return await api.permissions.contains({ origins: [this.pageOrigin(context)] });
    } catch (_) {
      return false;
    }
  }

  async requestPageOrigin(context: RuntimeContext | null) {
    const api = runtimeChrome();
    if (!api?.permissions?.request) return true;
    const origin = this.pageOrigin(context);
    const granted = await api.permissions.request({ origins: [origin] });
    if (granted) await this.registerPageOrigin(context);
    return granted;
  }

  private async registerPageOrigin(context: RuntimeContext | null) {
    const origin = this.pageOrigin(context);
    if (this.registeredPageOrigins.has(origin)) return;
    await this.send({ type: 'reader:site-access:register', origin });
    this.registeredPageOrigins.add(origin);
  }

  async voices(providerId: string): Promise<PopupVoice[]> {
    const response = await this.send({ type: 'voice:list', providerId });
    const voices = Array.isArray(response.voices) ? response.voices : [];
    return voices.map((voice) => {
      const source = voice && typeof voice === 'object' ? voice as Record<string, unknown> : { name: String(voice || '') };
      const rawId = String(source.id || source.voiceId || source.name || '');
      const id = rawId.includes(':') ? rawId : `${providerId}:${rawId}`;
      return {
        id,
        label: String(source.label || source.name || source.voiceId || id.replace(/^[^:]+:/, '')),
        lang: String(source.lang || ''),
        eventTypes: Array.isArray(source.eventTypes) ? source.eventTypes.map(String) : [],
      };
    }).filter((voice) => voice.id && voice.label);
  }

  async pageVoices(context: RuntimeContext | null) {
    const response = await this.send({
      type: 'reader:page-voices:get',
      tabId: context?.tabId,
      pageKey: context?.pageKey,
    });
    const pageContext = response.pageContext && typeof response.pageContext === 'object'
      ? response.pageContext as Record<string, unknown> : response;
    const authorVoices = pageContext.authorVoices && typeof pageContext.authorVoices === 'object'
      ? pageContext.authorVoices as Record<string, unknown> : {};
    return {
      authors: popupAuthors(pageContext.authors || pageContext.authorSummary),
      assignments: Object.fromEntries(Object.entries(authorVoices)
        .map(([authorId, voiceId]) => [String(authorId), String(voiceId || '')])
        .filter(([authorId, voiceId]) => authorId && voiceId)),
    };
  }

  async applyPageVoices(context: RuntimeContext | null, assignments: Record<string, string>) {
    const response = await this.send({
      type: 'reader:page-voices:apply',
      tabId: context?.tabId,
      pageKey: context?.pageKey,
      assignments: Object.entries(assignments).map(([authorId, voice]) => ({ authorId, voice })),
    });
    const pageContext = response.pageContext && typeof response.pageContext === 'object'
      ? response.pageContext as Record<string, unknown> : response;
    const authorVoices = pageContext.authorVoices && typeof pageContext.authorVoices === 'object'
      ? pageContext.authorVoices as Record<string, unknown> : assignments;
    return {
      authors: popupAuthors(pageContext.authors || pageContext.authorSummary),
      assignments: Object.fromEntries(Object.entries(authorVoices)
        .map(([authorId, voiceId]) => [String(authorId), String(voiceId || '')])
        .filter(([authorId, voiceId]) => authorId && voiceId)),
    };
  }

  async command(context: RuntimeContext | null, command: string, options?: { current?: boolean; takeover?: boolean }) {
    return this.send({
      type: 'reader:command',
      tabId: options?.current ? context?.currentTab?.tabId : context?.tabId,
      pageKey: context?.pageKey,
      command,
      scope: options?.current ? 'current' : 'global',
      takeover: options?.takeover === true,
    });
  }

  async saveSettings(settings: Record<string, unknown>) {
    return this.send({ type: 'settings:set', settings: { ...settings, schemaVersion: 6, providerVersion: 4, interactionVersion: 3 } });
  }

  async resetSettings() {
    return this.send({ type: 'settings:reset' });
  }

  async secretStatus() {
    const response = await this.send({ type: 'settings:secrets:status' });
    return response.secrets || {};
  }

  async saveSecret(providerId: 'local-service' | 'openai-compatible' | 'doubao-tts', secret: string, remember: boolean) {
    return this.send({ type: 'settings:secret:set', providerId, secret, remember });
  }

  async saveAiSecret(profileId: string, secret: string, remember: boolean) {
    return this.send({ type: 'settings:secret:set', secretId: `ai:${profileId}`, secret, remember });
  }

  async testLocalService() {
    return this.send({ type: 'provider:test', providerId: 'local-service', requestId: `local-health-${Date.now()}` });
  }

  async auditionOnline(previewText: string) {
    return this.send({
      type: 'provider:test', providerId: 'openai-compatible', previewText,
      requestId: `online-audition-${Date.now()}`,
    });
  }

  async auditionDoubao(previewText: string) {
    return this.send({ type: 'provider:test', providerId: 'doubao-tts', previewText, requestId: `doubao-audition-${Date.now()}` });
  }

  async modelAction(action: 'info' | 'download' | 'verify' | 'cancel' | 'delete', requestId?: string) {
    return this.send({ type: `provider:model:${action}`, requestId: requestId || `model-${action}-${Date.now()}` });
  }

  onModelProgress(listener: (progress: Record<string, unknown>, requestId: string) => void) {
    if (!this.runtime?.onMessage) return () => {};
    const handle = (message: Record<string, unknown>) => {
      if (message.target !== 'flowloud:model' || message.type !== 'provider:model:progress') return;
      const progress = message.progress && typeof message.progress === 'object'
        ? message.progress as Record<string, unknown> : {};
      listener(progress, String(message.requestId || ''));
    };
    this.runtime.onMessage.addListener(handle);
    return () => this.runtime?.onMessage?.removeListener(handle);
  }

  async estimateStorage() {
    const estimate = await globalThis.navigator?.storage?.estimate?.();
    const quota = Number(estimate?.quota);
    const usage = Number(estimate?.usage);
    return {
      quota: Number.isFinite(quota) ? quota : null,
      usage: Number.isFinite(usage) ? usage : null,
      available: Number.isFinite(quota) && Number.isFinite(usage) ? Math.max(0, quota - usage) : null,
    };
  }

  async diagnostics() {
    const [settings, playback, audio] = await Promise.all([
      this.send({ type: 'settings:get' }),
      this.send({ type: 'playback:global:get' }),
      this.send({ type: 'tts:status' }).catch((error) => ({ ok: false, error: { message: error instanceof Error ? error.message : String(error) } })),
    ]);
    return { generatedAt: new Date().toISOString(), settings: settings.settings || {}, playback: playback.playback || {}, audio };
  }

  async openVoiceStudio() {
    return this.send({ type: 'voice:studio:open' });
  }

  async openShortcuts() {
    const api = runtimeChrome();
    if (!api?.tabs?.create) throw new globalThis.Error('当前浏览器无法打开快捷键管理页。');
    await api.tabs.create({ url: 'chrome://extensions/shortcuts' });
  }

  async requestLocalOrigin(baseUrl: string) {
    const api = runtimeChrome();
    if (!api?.permissions) return true;
    let parsed: URL;
    try { parsed = new URL(baseUrl || 'http://127.0.0.1:7811'); }
    catch (_) { throw new globalThis.Error('请填写有效的服务 Base URL。'); }
    if (!['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) || !['http:', 'https:'].includes(parsed.protocol)) {
      throw new globalThis.Error('本地服务只允许 localhost、127.0.0.1 或 ::1。');
    }
    if (parsed.username || parsed.password) throw new globalThis.Error('本地服务地址不能包含用户名或密码。');
    return api.permissions.request({ origins: [`${parsed.origin}/*`] });
  }

  async requestOnlineOrigin(baseUrl: string) {
    const api = runtimeChrome();
    if (!api?.permissions) return true;
    let parsed: URL;
    try { parsed = new URL(baseUrl); }
    catch (_) { throw new globalThis.Error('请填写有效的在线服务 Base URL。'); }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
      throw new globalThis.Error('在线 TTS 必须使用 HTTPS；仅本机回环地址允许 HTTP。');
    }
    if (parsed.username || parsed.password) throw new globalThis.Error('在线服务地址不能包含用户名或密码。');
    return api.permissions.request({ origins: [`${parsed.origin}/*`] });
  }

  async requestAiOrigin(baseUrl: string) {
    return this.requestOnlineOrigin(baseUrl);
  }

  async openDocumentWorkbench(tabId?: number | null) {
    return this.send({ type: 'document:workspace:open', tabId: tabId ?? undefined });
  }

  async documentWorkspaceSeed() {
    const response = await this.send({ type: 'document:workspace:seed' });
    return response.seed && typeof response.seed === 'object' ? response.seed as Record<string, unknown> : {};
  }

  async sourceDocument(tabId: number) {
    const response = await this.send({ type: 'reader:document:get', tabId });
    const snapshot = response.snapshot && typeof response.snapshot === 'object' ? response.snapshot as Record<string, unknown> : {};
    const document = response.document && typeof response.document === 'object' ? response.document as Record<string, unknown> : {};
    return { snapshot, document };
  }

  async probeAiProfile(profileId: string) {
    return this.documentOperation('probe', profileId, {});
  }

  async documentOperation(operation: 'probe' | 'extract' | 'translate', profileId: string, request: Record<string, unknown>, requestId?: string) {
    const id = requestId || `document-${operation}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const response = await this.send({ type: `document:${operation}`, profileId, requestId: id, request });
    const result = response.result && typeof response.result === 'object' ? response.result as Record<string, unknown> : {};
    return { requestId: id, result };
  }

  async extractDocument(profileId: string, request: Record<string, unknown>, requestId?: string): Promise<{ requestId: string; document: DocumentArtifact }> {
    const response = await this.documentOperation('extract', profileId, request, requestId);
    return { requestId: response.requestId, document: response.result.document as DocumentArtifact };
  }

  async translateDocument(profileId: string, request: Record<string, unknown>, requestId?: string): Promise<{ requestId: string; translation: TranslationArtifact }> {
    const response = await this.documentOperation('translate', profileId, request, requestId);
    return { requestId: response.requestId, translation: response.result.translation as TranslationArtifact };
  }

  async cancelDocument(requestId: string) {
    return this.send({ type: 'document:cancel', requestId });
  }

  async speakText(text: string) {
    const requestId = `workbench-tts-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const response = await this.send({ type: 'tts:synthesize', requestId, clientId: 'document-workbench', playbackId: requestId, request: { input: text } });
    const audioBase64 = String(response.audioBase64 || '');
    if (audioBase64) await new Audio(`data:${String(response.mimeType || 'audio/mpeg')};base64,${audioBase64}`).play();
    return response;
  }

  async requestModelOrigins() {
    const api = runtimeChrome();
    if (!api?.permissions) return true;
    return api.permissions.request({ origins: [
      'https://huggingface.co/*', 'https://*.huggingface.co/*', 'https://*.hf.co/*',
    ] });
  }

  async focusSource() {
    return this.send({ type: 'playback:source:focus' });
  }

  async providerStates(settings: Record<string, unknown>): Promise<{ providers: ProviderState[]; model: ModelDownloadState }> {
    const browserModel = settings.providerSettings && typeof settings.providerSettings === 'object'
      ? (settings.providerSettings as Record<string, Record<string, unknown>>)['browser-model'] || {} : {};
    const local = settings.providerSettings && typeof settings.providerSettings === 'object'
      ? (settings.providerSettings as Record<string, Record<string, unknown>>)['local-service'] || {} : {};
    const online = settings.providerSettings && typeof settings.providerSettings === 'object'
      ? (settings.providerSettings as Record<string, Record<string, unknown>>)['openai-compatible'] || {} : {};
    const doubao = settings.providerSettings && typeof settings.providerSettings === 'object'
      ? (settings.providerSettings as Record<string, Record<string, unknown>>)['doubao-tts'] || {} : {};
    const infoResponse: RuntimeEnvelope = await this.send({ type: 'provider:model:info' }).catch(() => ({}));
    const info = (infoResponse.result && typeof infoResponse.result === 'object' ? infoResponse.result : infoResponse) as Record<string, unknown>;
    const state = String(info.state || (info.ready ? 'ready' : info.cached ? 'available-unverified' : 'missing')) as ModelDownloadState['state'];
    const model: ModelDownloadState = {
      state, ready: info.ready === true, cached: info.cached === true,
      cacheId: String(info.cacheId || ''), device: String(info.device || ''), fallbackReason: String(info.fallbackReason || ''), verifiedAt: String(info.verifiedAt || ''),
    };
    return {
      model,
      providers: [
        { providerId: 'browser-system', ready: true, status: 'ready', message: '浏览器提供 · 正文不离开设备' },
        { providerId: 'browser-model', ready: model.ready, status: model.ready ? 'ready' : model.state === 'corrupt' ? 'error' : 'unavailable', message: model.ready ? `离线校验通过 · ${(model.device || 'wasm').toUpperCase()}${model.fallbackReason ? ` · WebGPU 回退：${model.fallbackReason}` : ''}` : model.state === 'corrupt' ? '缓存损坏，需要重新下载' : '尚未通过离线校验' },
        { providerId: 'local-service', ready: Boolean(local.baseUrl), status: local.baseUrl ? 'permission-required' : 'unconfigured', message: local.baseUrl ? `${String(local.adapterId || 'flowloud-qwen')} · 使用时检查权限` : '尚未配置本地地址' },
        { providerId: 'openai-compatible', ready: Boolean(online.baseUrl && online.model), status: online.baseUrl && online.model ? 'permission-required' : 'unconfigured', message: online.baseUrl && online.model ? '已配置 · 试听时请求权限' : '需要 API 地址、模型与密钥' },
        { providerId: 'doubao-tts', ready: Boolean(doubao.appId && doubao.voice), status: doubao.appId && doubao.voice ? 'permission-required' : 'unconfigured', message: doubao.appId && doubao.voice ? '豆包原生协议已配置 · 试听时请求权限' : '需要 App ID、音色与 API Key' },
      ],
    };
  }

  openOptions() {
    return this.runtime?.openOptionsPage();
  }
}

export function createRuntimeBridge() {
  return new RuntimeBridge();
}
