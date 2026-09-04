export type ReaderStatus = 'idle' | 'ready' | 'loading' | 'playing' | 'paused' | 'error';

export type SettingsSection = 'reader' | 'ai' | 'voice' | 'appearance' | 'shortcuts' | 'advanced';

export type ProviderConnectionState = 'unconfigured' | 'connecting' | 'connected' | 'failed' | 'unavailable';

export interface ProviderStatus {
  providerId: string;
  connectionState: ProviderConnectionState;
  configured: boolean;
  usable: boolean;
  message: string;
  stage?: 'configuration' | 'permission' | 'health' | 'voices' | 'synthesize' | 'model';
  verifiedAt?: string;
  voiceCount?: number;
  voiceTotalBytes?: number;
  modelCount?: number;
  sourceLabel?: string;
  capabilities?: Record<string, boolean>;
}

export interface VoiceCatalogEntry extends PopupVoice {
  providerId: string;
  languageLabel: string;
  characteristic?: string;
  availability: 'available' | 'download-required' | 'configuration-required' | 'unavailable';
  isDefault?: boolean;
}

export interface ProviderVoiceCatalogState {
  providerId: string;
  status: 'idle' | 'loading' | 'ready' | 'empty' | 'error';
  voices: VoiceCatalogEntry[];
  error?: string;
}

export interface PopupSettings {
  activeProviderId: string;
  playbackRate: number;
  readingMode: 'content' | 'guide';
  readingFocus: 'off' | 'sentence' | 'line';
  readingFocusStyle: 'soft-glow' | 'edge-glow' | 'paper-wash' | 'underline-guide';
  wordHighlightStyle: 'edge-dissolve' | 'classic-glow' | 'aurora-tide' | 'custom';
  wordHighlightColor: string;
  wordHighlightGlow: number;
  wordHighlightSpeed: number;
  showFloatingPlayer: boolean;
  clickToRead: boolean;
  preset: 'everyone-one' | 'op-plus-one' | 'op-stable-random' | 'op-round-robin' | 'op-exclusive' | 'stable-author' | 'round-robin';
}

export interface PopupAuthor {
  id: string;
  name: string;
  voice: string;
  role?: string;
  isOp?: boolean;
  count?: number;
}

export interface PopupVoice {
  id: string;
  rawId?: string;
  alias?: string;
  label: string;
  rawLabel?: string;
  displayLabel?: string;
  lang?: string;
  locale?: string;
  language?: string;
  vendor?: string;
  gender?: string;
  metadataSource?: string;
  recommendedReason?: string;
  note?: string;
  characteristic?: string;
  description?: string;
  style?: string;
  cached?: boolean | null;
  source?: string;
  sizeBytes?: number;
  eventTypes?: string[];
}

export interface PopupModel {
  title: string;
  sourceLabel: string;
  status: ReaderStatus;
  index: number;
  total: number;
  currentText: string;
  currentSpeaker: string;
  currentWords?: Array<{ text: string; sourceStart: number; sourceEnd: number }>;
  currentWordIndex?: number;
  currentWordTiming?: { mode: string; estimated: boolean };
  authors: PopupAuthor[];
  settings: PopupSettings;
  availableVoices?: PopupVoice[];
  selectedVoiceId?: string;
  replyVoiceCount?: number;
  pageVoiceAssignments?: Record<string, string>;
  pageVoiceLoadState?: 'idle' | 'loading' | 'ready' | 'error';
  voiceLoadState?: 'idle' | 'loading' | 'ready' | 'error';
  providerNotice?: string;
  providerBaseUrl?: string;
  providerDevice?: string;
  providerAdapter?: string;
  persistentSiteAccess?: boolean;
  controlNotice?: string;
  message?: string;
  isMock?: boolean;
  currentTabId?: number | null;
  sourceTabId?: number | null;
  globalPlayback?: {
    active: boolean;
    state: string;
    sourceTabId?: number | null;
    pageKey?: string;
    sourceIsCurrentTab?: boolean;
  };
  providerStates?: ProviderState[];
  modelState?: ModelDownloadState;
}

export interface ProviderState extends ProviderStatus {
  ready: boolean;
  status: 'ready' | 'unconfigured' | 'permission-required' | 'unavailable' | 'error';
}

export interface ModelDownloadState {
  state: 'missing' | 'downloading' | 'verifying' | 'ready' | 'corrupt' | 'cancelled' | 'available-unverified';
  ready: boolean;
  cached: boolean;
  cacheId?: string;
  device?: string;
  fallbackReason?: string;
  verifiedAt?: string;
  message?: string;
  source?: string;
  sourceLabel?: string;
  variant?: string;
  variantLabel?: string;
  estimatedBytes?: number;
  concurrency?: number;
  voiceCount?: number;
  voiceTotalBytes?: number;
  starterVoiceIds?: string[];
  installMode?: 'full' | 'custom';
  selectedVoiceIds?: string[];
  voiceCacheRegistry?: Record<string, Record<string, unknown>>;
}

/**
 * Safe UI defaults used before the extension runtime responds.  These are
 * settings defaults only; they intentionally contain no titles, authors,
 * voice IDs, provider catalogs, or playback claims.
 */
export const runtimeDefaultSettings: PopupSettings = {
  activeProviderId: 'browser-system',
  playbackRate: 1,
  readingMode: 'content',
  readingFocus: 'sentence',
  readingFocusStyle: 'soft-glow',
  wordHighlightStyle: 'edge-dissolve',
  wordHighlightColor: '#2563eb',
  wordHighlightGlow: 48,
  wordHighlightSpeed: 1,
  showFloatingPlayer: false,
  clickToRead: false,
  preset: 'everyone-one',
};

export const demoPopupModel: PopupModel = {
  title: '如何让浏览器朗读真正融入阅读？',
  sourceLabel: 'FLARUM · 单帖主题',
  status: 'playing',
  index: 2,
  total: 18,
  currentText: '复杂的作者配音不该挤在一个瞬时小窗里。',
  currentSpeaker: '远山',
  currentWords: [{ text: '作者配音', sourceStart: 3, sourceEnd: 7 }],
  currentWordIndex: 0,
  authors: [
    { id: 'op', name: '楼主', voice: 'browser-system:demo-zh', role: '楼主', isOp: true, count: 8 },
    { id: 'mina', name: 'Mina', voice: 'browser-system:demo-zh', role: '回复', count: 5 },
    { id: 'mountain', name: '远山', voice: 'browser-system:demo-zh', role: '回复', count: 5 },
  ],
  settings: {
    activeProviderId: 'browser-system',
    playbackRate: 1,
    readingMode: 'content',
    readingFocus: 'sentence',
    readingFocusStyle: 'paper-wash',
    wordHighlightStyle: 'edge-dissolve',
    wordHighlightColor: '#2563eb',
    wordHighlightGlow: 48,
    wordHighlightSpeed: 1,
    showFloatingPlayer: true,
    clickToRead: true,
    preset: 'everyone-one',
  },
  availableVoices: [
    { id: 'browser-system:demo-zh', label: '系统中文音色', lang: 'zh-CN', eventTypes: ['word', 'sentence'] },
  ],
  selectedVoiceId: 'browser-system:demo-zh',
  replyVoiceCount: 3,
  pageVoiceAssignments: { op: 'browser-system:demo-zh' },
  pageVoiceLoadState: 'ready',
  voiceLoadState: 'ready',
  providerNotice: '支持逐词边界；实际能力取决于所选系统音色。',
  persistentSiteAccess: false,
  isMock: true,
  currentTabId: null,
  sourceTabId: null,
  globalPlayback: { active: false, state: 'idle' },
};
