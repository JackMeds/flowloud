import type { ModelDownloadState, ProviderState, VoiceCatalogEntry } from './model';
import { providerRegistry, type ProviderId } from './provider-registry';

export type VoicePreset = 'everyone-one' | 'op-plus-one' | 'op-stable-random' | 'op-round-robin';

export interface VoiceAssignment {
  narratorVoiceId: string;
  replyVoiceIds: string[];
  authorVoices: Record<string, string>;
}

export interface VoiceOverride {
  alias?: string;
  note?: string;
  updatedAt?: number;
}

export type ProviderConfig = Record<string, unknown>;

export type VoiceSettings = Record<string, unknown> & {
  activeProviderId?: string;
  preset?: VoicePreset;
  providerSettings?: Record<string, ProviderConfig>;
  voiceAssignmentsByProvider?: Record<string, VoiceAssignment>;
  voiceCatalogPreferences?: { languageMode?: string; locale?: string };
  voiceOverridesByProvider?: Record<string, Record<string, VoiceOverride>>;
};

export const providerIds = providerRegistry.map((provider) => provider.id);
export const emptyVoiceSettings: VoiceSettings = {
  activeProviderId: 'browser-system',
  preset: 'everyone-one',
  providerSettings: {},
  voiceAssignmentsByProvider: {},
};

const LANGUAGE_LABELS: Record<string, string> = {
  'zh-CN': '简体中文',
  zh: '中文',
  'zh-TW': '繁體中文',
  'zh-HK': '粤语',
  'en-US': 'English (US)',
  en: 'English',
  'en-GB': 'English (UK)',
  'ja-JP': '日本語',
  ja: '日本語',
  'ko-KR': '한국어',
  ko: '한국어',
};

export function connectionLabel(state?: ProviderState) {
  if (!state) return '正在读取';
  return ({
    connected: '已连接',
    connecting: '连接中',
    failed: '连接失败',
    unconfigured: '未配置',
    unavailable: '待验证',
  } as Record<string, string>)[state.connectionState] || '待验证';
}

export function providerStatusMessage(providerId: ProviderId, state?: ProviderState) {
  const message = String(state?.message || '').trim();
  if (providerId === 'local-service' && state?.connectionState === 'failed') {
    if (/401|client[_\s-]?auth|token|令牌|unauthor/i.test(message)) {
      return '本地网关已启动，但配对令牌缺失或已失效。请从 Qwen 托盘菜单复制“扩展配对令牌”，粘贴后重新连接。';
    }
    if (/network|无法连接|failed to fetch|receiving end/i.test(message)) {
      return '没有连接到本地网关。请确认 QwenTrayGateway 正在运行，地址保持为 http://127.0.0.1:7811。';
    }
  }
  if (message) return message;
  return providerRegistry.find((provider) => provider.id === providerId)?.privacy || '等待配置';
}

export function canActivateProvider(providerId: ProviderId, state?: ProviderState, model?: ModelDownloadState) {
  if (providerId === 'browser-system') return true;
  if (providerId === 'browser-model') return model?.ready === true || state?.usable === true;
  return state?.connectionState === 'connected' && state.usable === true;
}

export function rawVoiceId(value: string) {
  return String(value || '').replace(/^[^:]+:/u, '');
}

export function namespacedVoiceId(providerId: string, value: string) {
  const raw = rawVoiceId(value);
  return raw ? `${providerId}:${raw}` : '';
}

export function voiceKey(voice: VoiceCatalogEntry) {
  return namespacedVoiceId(voice.providerId, voice.rawId || voice.id);
}

export function voiceInitial(label: string) {
  return /^[A-Za-z]/u.test(label) ? label.slice(0, 2).toUpperCase() : label.slice(0, 1);
}

export function bytesLabel(bytes: number) {
  const value = Number(bytes) || 0;
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
  return `${(value / (1024 * 1024)).toFixed(value >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

export function localeLabel(locale: string) {
  const value = String(locale || '').trim();
  return LANGUAGE_LABELS[value] || value || '未标注';
}

export function localeFamily(locale: string) {
  return String(locale || '').trim().toLowerCase().split(/[-_]/u)[0];
}

export function preferredLocale() {
  const api = (globalThis as { chrome?: { i18n?: { getUILanguage?: () => string } } }).chrome;
  try {
    const value = api?.i18n?.getUILanguage?.();
    if (value) return String(value);
  } catch (_) {
    // Test pages may not expose chrome.i18n.
  }
  return String(globalThis.navigator?.language || 'zh-CN');
}

export function modelVoiceIds(voices: VoiceCatalogEntry[]) {
  return voices.filter((voice) => voice.providerId === 'browser-model').map((voice) => rawVoiceId(voice.id));
}

export function missingVoiceBytes(voices: VoiceCatalogEntry[]) {
  return voices
    .filter((voice) => voice.cached !== true)
    .reduce((total, voice) => total + Number(voice.sizeBytes || 522240), 0);
}
