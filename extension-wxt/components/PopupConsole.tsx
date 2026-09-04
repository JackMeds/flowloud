import { Button, Tab, TabList, TabPanel, Tabs } from 'react-aria-components';
import {
  AudioLines,
  BookOpen,
  ChevronRight,
  Cloud,
  Cpu,
  ExternalLink,
  FileText,
  Gauge,
  Globe2,
  HardDrive,
  Languages,
  MousePointerClick,
  Pause,
  Play,
  Radio,
  RefreshCcw,
  Settings2,
  SkipBack,
  SkipForward,
  SlidersHorizontal,
  UserRound,
  UsersRound,
} from 'lucide-react';
import type { ComponentType } from 'react';
import type { PopupModel, PopupSettings, ProviderState, SettingsSection } from './model';
import { ChoiceSelect } from './FormControls';
import { providerRegistry, type ProviderId } from './provider-registry';
import { canActivateProvider, connectionLabel } from './voice-workbench-model';

export type ReaderCommand = 'previous' | 'toggle-playback' | 'next' | 'locate-current' | 'retry-system-once';

interface PopupConsoleProps {
  model: PopupModel;
  onCommand?: (command: ReaderCommand) => void | Promise<void>;
  onSettingChange?: <Key extends keyof PopupSettings>(key: Key, value: PopupSettings[Key]) => void | Promise<void>;
  onRequestPersistentSiteAccess?: () => void | Promise<void>;
  onOpenSettings?: (section: SettingsSection, providerId?: string) => void;
  onOpenGuide?: () => void | Promise<void>;
  onReturnSource?: () => void | Promise<void>;
  onReadCurrentPage?: () => void | Promise<void>;
  onVoiceChange?: (voiceId: string) => void | Promise<void>;
  onOpenPageVoices?: () => void | Promise<void>;
  onOpenDocuments?: () => void | Promise<void>;
}

const speedOptions = [0.75, 1, 1.25, 1.5, 1.75, 2] as const;
const sourceIcons: Record<ProviderId, ComponentType<{ 'aria-hidden'?: boolean }>> = {
  'browser-system': Globe2,
  'browser-model': Cpu,
  'local-service': HardDrive,
  'openai-compatible': Cloud,
  'doubao-tts': Radio,
};

function ActiveSentence({ text, words, wordIndex }: { text: string; words?: PopupModel['currentWords']; wordIndex?: number }) {
  const active = Number.isInteger(wordIndex) && Number(wordIndex) >= 0 ? words?.[Number(wordIndex)] : null;
  if (!active || active.sourceStart < 0 || active.sourceEnd > text.length || active.sourceEnd <= active.sourceStart) return <>{text}</>;
  return <>{text.slice(0, active.sourceStart)}<mark>{text.slice(active.sourceStart, active.sourceEnd)}</mark>{text.slice(active.sourceEnd)}</>;
}

function NavRow({ icon: Icon, label, value, onPress }: { icon: ComponentType<{ 'aria-hidden'?: boolean }>; label: string; value: string; onPress?: () => void | Promise<void> }) {
  return (
    <Button className="fl-popup-nav-row" onPress={onPress}>
      <Icon aria-hidden={true} /><strong>{label}</strong><span>{value}</span><ChevronRight aria-hidden={true} />
    </Button>
  );
}

function popupSourceStatus(providerId: ProviderId, state: ProviderState | undefined, active: boolean) {
  if (active) return '当前';
  if (state?.connectionState === 'connected' || state?.usable) return '可用';
  if (state?.connectionState === 'failed') return '异常';
  if (providerId === 'browser-model') return '需下载';
  if (providerId === 'browser-system') return '可用';
  return '需配置';
}

export function PopupConsole({
  model,
  onCommand,
  onSettingChange,
  onRequestPersistentSiteAccess,
  onOpenSettings,
  onOpenGuide,
  onReturnSource,
  onReadCurrentPage,
  onVoiceChange,
  onOpenPageVoices,
  onOpenDocuments,
}: PopupConsoleProps) {
  const progress = model.total ? Math.min(100, ((model.index + 1) / model.total) * 100) : 0;
  const playing = model.status === 'playing';
  const browserModelVoiceUnavailable = model.settings.activeProviderId === 'browser-model'
    && model.voiceLoadState === 'ready'
    && !(model.availableVoices || []).length;
  const primaryLabel = browserModelVoiceUnavailable ? '请先安装模型音色' : playing ? '暂停朗读' : model.status === 'paused' ? '继续朗读' : '开始朗读';
  const statusLabel = playing ? '正在朗读' : model.status === 'paused' ? '已暂停' : model.status === 'error' ? '连接异常' : '准备就绪';
  const availableVoiceOptions = (model.availableVoices || []).map((voice) => [voice.id, `${voice.label}${voice.lang ? ` · ${voice.lang}` : ''}`] as const);
  const voiceSelectValue = model.selectedVoiceId || availableVoiceOptions.at(0)?.[0] || '';
  const selectedVoice = (model.availableVoices || []).find((voice) => voice.id === model.selectedVoiceId);
  const providerNotice = model.providerNotice || (model.currentWordTiming?.estimated
    ? '当前来源没有词时间戳，高亮按实际音频时长估算。'
    : selectedVoice?.eventTypes?.includes('word') ? '支持逐词边界，高亮会跟随真实语音事件。' : '当前声音以句子进度同步。');

  return (
    <section className="fl-console" aria-label="Flowloud 控制台">
      <header className="fl-header">
        <div className="fl-header-summary">
          {model.isMock ? <span className="fl-mock-badge">MOCK</span> : null}
          <span className={`fl-status is-${model.status}`}>{statusLabel}</span>
        </div>
        <span className="fl-header-product">Flowloud / 流声</span>
      </header>

      <div className="fl-console-scroll">
        {model.globalPlayback?.active && model.globalPlayback.sourceIsCurrentTab === false ? (
          <section className="fl-global-playback" aria-label="其他标签页正在朗读">
            <div><strong>正在控制其他标签页的朗读</strong><span>播放不会因为切换标签页而中断。</span></div>
            <Button onPress={onReturnSource}><ExternalLink aria-hidden={true} />回到来源页</Button>
            <Button onPress={onReadCurrentPage}><RefreshCcw aria-hidden={true} />朗读当前页</Button>
          </section>
        ) : null}

        <section className="fl-player" aria-label="当前朗读">
          <div className="fl-caption"><div><strong>{model.currentSpeaker || '正在准备'}</strong><span>第 {Math.min(model.index + 1, Math.max(1, model.total))} 段 / 共 {model.total} 段</span></div><p><ActiveSentence text={model.currentText || '正在识别正文，请稍候。'} words={model.currentWords} wordIndex={model.currentWordIndex} /></p></div>
          <div className="fl-progress-line"><div className="fl-progress" role="progressbar" aria-label="朗读进度" aria-valuemin={1} aria-valuemax={Math.max(1, model.total)} aria-valuenow={Math.min(model.index + 1, Math.max(1, model.total))}><span style={{ width: `${progress}%` }} /></div><span>{Math.round(progress)}%</span></div>
          <p className="fl-kicker">{model.sourceLabel}</p>
          <h1>{model.title}</h1>
          <div className="fl-transport" role="group" aria-label="朗读控制">
            <Button className="fl-transport-side" aria-label="上一句" onPress={() => onCommand?.('previous')}><SkipBack aria-hidden={true} /></Button>
            <Button className="fl-transport-primary" aria-label={primaryLabel} isDisabled={browserModelVoiceUnavailable} onPress={() => onCommand?.('toggle-playback')}>{playing ? <Pause aria-hidden={true} /> : <Play aria-hidden={true} />}</Button>
            <Button className="fl-transport-side" aria-label="下一句" onPress={() => onCommand?.('next')}><SkipForward aria-hidden={true} /></Button>
          </div>
          {model.controlNotice ? <div className="fl-control-notice" role="status" aria-live="polite"><AudioLines aria-hidden={true} /><span>{model.controlNotice}</span></div> : null}
          {model.message ? <div className="fl-message" role="alert"><span>{model.message}</span>{model.status === 'error' && model.settings.activeProviderId !== 'browser-system' ? <Button onPress={() => onCommand?.('retry-system-once')}>一次性改用系统语音</Button> : null}</div> : null}
        </section>

        <div className="fl-quick-actions" role="group" aria-label="常用功能">
          <Button className={`fl-quick-action ${model.settings.clickToRead ? 'is-active' : ''}`} aria-pressed={model.settings.clickToRead} onPress={() => onSettingChange?.('clickToRead', !model.settings.clickToRead)}><MousePointerClick aria-hidden={true} /><span>点读<small>{model.settings.clickToRead ? '已开启' : '已关闭'}</small></span></Button>
          <Button className={`fl-quick-action ${model.settings.showFloatingPlayer ? 'is-active' : ''}`} aria-pressed={model.settings.showFloatingPlayer} onPress={() => model.settings.showFloatingPlayer && model.persistentSiteAccess === false ? onRequestPersistentSiteAccess?.() : onSettingChange?.('showFloatingPlayer', !model.settings.showFloatingPlayer)}><SlidersHorizontal aria-hidden={true} /><span>悬浮播放器<small>{model.settings.showFloatingPlayer ? model.persistentSiteAccess === false ? '浏览器已限制本页' : '刷新后自动显示' : '已关闭'}</small></span></Button>
          <Button className="fl-quick-action" onPress={() => onCommand?.('locate-current')}><FileText aria-hidden={true} /><span>回到正文</span></Button>
        </div>

        <Tabs className="fl-popup-tabs" defaultSelectedKey="sound">
          <TabList className="fl-popup-tab-list" aria-label="快捷设置分类">
            <Tab id="sound"><AudioLines aria-hidden={true} />声音</Tab>
            <Tab id="more"><SlidersHorizontal aria-hidden={true} />更多</Tab>
          </TabList>

          <TabPanel id="sound" className="fl-popup-tab-panel">
            <section className="fl-popup-source-section" aria-labelledby="popup-source-title">
              <div className="fl-popup-source-heading"><div><strong id="popup-source-title">声音来源</strong><small>全部来源都可以直接查看和配置</small></div><Button onPress={() => onOpenSettings?.('voice', model.settings.activeProviderId)}>声音中心<ChevronRight aria-hidden={true} /></Button></div>
              <div className="fl-popup-source-grid">
                {providerRegistry.map((provider) => {
                  const Icon = sourceIcons[provider.id];
                  const state = model.providerStates?.find((item) => item.providerId === provider.id);
                  const active = model.settings.activeProviderId === provider.id;
                  const usable = canActivateProvider(provider.id, state, model.modelState);
                  return (
                    <div key={provider.id} className={`fl-popup-source-card ${active ? 'is-active' : ''}`}>
                      <Button className="fl-popup-source-main" aria-label={`${active ? '当前来源：' : usable ? '切换到' : '配置'}${provider.label}`} onPress={() => usable ? onSettingChange?.('activeProviderId', provider.id) : onOpenSettings?.('voice', provider.id)}>
                        <Icon aria-hidden={true} /><span><strong>{provider.shortLabel}</strong><small>{popupSourceStatus(provider.id, state, active)}</small></span>
                      </Button>
                      <Button className="fl-popup-source-settings" aria-label={`配置${provider.label}`} onPress={() => onOpenSettings?.('voice', provider.id)}><Settings2 aria-hidden={true} /></Button>
                    </div>
                  );
                })}
              </div>
            </section>

            <div className="fl-popup-card fl-popup-sound-card">
              <div className="fl-popup-select-row"><AudioLines aria-hidden={true} />{availableVoiceOptions.length ? <ChoiceSelect label="当前音色" value={voiceSelectValue} options={availableVoiceOptions} onChange={(value) => onVoiceChange?.(value)} /> : <Button className="fl-popup-empty-voice" onPress={() => onOpenSettings?.('voice', model.settings.activeProviderId)}><span><strong>当前没有可用声音</strong><small>{connectionLabel(model.providerStates?.find((item) => item.providerId === model.settings.activeProviderId))}</small></span><ChevronRight aria-hidden={true} /></Button>}</div>
              <div className="fl-popup-speed-row"><Gauge aria-hidden={true} /><span>朗读速度</span><div>{speedOptions.map((speed) => <Button key={speed} className={model.settings.playbackRate === speed ? 'is-active' : ''} onPress={() => onSettingChange?.('playbackRate', speed)}>{speed}×</Button>)}</div></div>
              <div className="fl-provider-note"><span>{model.voiceLoadState === 'loading' ? '正在读取可用声音…' : `${providerNotice}${model.replyVoiceCount ? ` · 人物声音池 ${model.replyVoiceCount} 个` : ''}`}</span><Button aria-label="打开声音中心" onPress={() => onOpenSettings?.('voice', model.settings.activeProviderId)}>管理声音与声音池…</Button></div>
            </div>
          </TabPanel>

          <TabPanel id="more" className="fl-popup-tab-panel">
            <nav className="fl-popup-card fl-popup-footer-nav" aria-label="其他设置与工作台">
              <NavRow icon={BookOpen} label="阅读方式与快捷键" value="朗读、外观、点读" onPress={() => onOpenSettings?.('reader')} />
              <NavRow icon={UsersRound} label="本页角色配音" value="按当前页面覆盖作者声音" onPress={onOpenPageVoices} />
              <NavRow icon={UserRound} label="全局声音中心" value="来源、声音池与角色策略" onPress={() => onOpenSettings?.('voice', model.settings.activeProviderId)} />
              <NavRow icon={Languages} label="OCR 与翻译工作台" value="网页、图片与 PDF" onPress={onOpenDocuments} />
              <NavRow icon={Settings2} label="打开全部设置" value="按任务查找全部功能" onPress={() => onOpenSettings?.('reader', model.settings.activeProviderId)} />
              {onOpenGuide ? <NavRow icon={FileText} label="页面导览" value="按结构浏览当前页" onPress={onOpenGuide} /> : null}
            </nav>
          </TabPanel>
        </Tabs>
      </div>
    </section>
  );
}
