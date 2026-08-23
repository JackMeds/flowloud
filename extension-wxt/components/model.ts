export type ReaderStatus = 'idle' | 'ready' | 'loading' | 'playing' | 'paused' | 'error';

export interface PopupSettings {
  activeProviderId: string;
  playbackRate: number;
  readingMode: 'content' | 'guide';
  readingFocusStyle: 'soft-glow' | 'edge-glow' | 'paper-wash' | 'underline-guide';
  wordHighlightStyle: 'edge-dissolve' | 'classic-glow' | 'aurora-tide' | 'custom';
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
  label: string;
  lang?: string;
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
  authors: PopupAuthor[];
  settings: PopupSettings;
  availableVoices?: PopupVoice[];
  selectedVoiceId?: string;
  pageVoiceAssignments?: Record<string, string>;
  pageVoiceLoadState?: 'idle' | 'loading' | 'ready' | 'error';
  voiceLoadState?: 'idle' | 'loading' | 'ready' | 'error';
  providerNotice?: string;
  providerBaseUrl?: string;
  providerDevice?: string;
  providerAdapter?: string;
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
}

export interface ProviderState {
  providerId: string;
  ready: boolean;
  status: 'ready' | 'unconfigured' | 'permission-required' | 'unavailable' | 'error';
  message: string;
  capabilities?: Record<string, boolean>;
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
}

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
    readingFocusStyle: 'paper-wash',
    wordHighlightStyle: 'edge-dissolve',
    showFloatingPlayer: true,
    clickToRead: true,
    preset: 'everyone-one',
  },
  availableVoices: [
    { id: 'browser-system:demo-zh', label: '系统中文音色', lang: 'zh-CN', eventTypes: ['word', 'sentence'] },
  ],
  selectedVoiceId: 'browser-system:demo-zh',
  pageVoiceAssignments: { op: 'browser-system:demo-zh' },
  pageVoiceLoadState: 'ready',
  voiceLoadState: 'ready',
  providerNotice: '支持逐词边界；实际能力取决于所选系统音色。',
  isMock: true,
  currentTabId: null,
  sourceTabId: null,
  globalPlayback: { active: false, state: 'idle' },
};
