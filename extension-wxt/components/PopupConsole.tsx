import { Button, Dialog, DialogTrigger, Popover, Tab, TabList, TabPanel, Tabs } from 'react-aria-components';
import {
  AudioLines,
  BookOpen,
  Bot,
  CircleHelp,
  ChevronRight,
  Crown,
  ExternalLink,
  FileText,
  Gauge,
  MousePointerClick,
  Pause,
  Play,
  RefreshCcw,
  SkipBack,
  SkipForward,
  SlidersHorizontal,
  Settings2,
  Sparkles,
  UserRound,
  UsersRound,
  Languages,
} from 'lucide-react';
import type { ComponentType } from 'react';
import type { PopupModel, PopupSettings, SettingsSection } from './model';
import { ChoiceSelect } from './FormControls';
import { configuredProviderOptions, providerSummaryLabels } from './provider-registry';

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
  onPageVoiceChange?: (authorId: string, voiceId: string) => void | Promise<void>;
  onOpenDocuments?: () => void | Promise<void>;
  onOpenVoiceStudio?: () => void | Promise<void>;
}

const speedOptions = [0.75, 1, 1.25, 1.5, 1.75, 2] as const;
const presetOptions = [
  ['everyone-one', '所有人使用同一配音'],
  ['op-plus-one', '楼主独立，其他作者同一配音'],
  ['op-stable-random', '楼主独立，其他作者稳定随机'],
  ['op-round-robin', '楼主独立，其他作者顺序轮换'],
] as const;
const presetGuidance: Record<string, { label: string; description: string }> = {
  'everyone-one': {
    label: '所有人使用同一配音',
    description: '楼主、回复者和旁白都使用“声音”页选中的当前音色。默认推荐，最稳定。',
  },
  'op-plus-one': {
    label: '楼主独立，其他作者同一配音',
    description: '楼主使用主音色；其他所有作者共用一个回复音色。',
  },
  'op-stable-random': {
    label: '楼主独立，其他作者稳定随机',
    description: '楼主独立；每位回复作者从音色池稳定分配，同一作者始终保持同一音色。',
  },
  'op-round-robin': {
    label: '楼主独立，其他作者顺序轮换',
    description: '楼主独立；其余楼层按出现顺序轮换音色，适合角色很多的长帖。',
  },
};
function ActiveSentence({ text, words, wordIndex }: { text: string; words?: PopupModel['currentWords']; wordIndex?: number }) {
  const active = Number.isInteger(wordIndex) && Number(wordIndex) >= 0 ? words?.[Number(wordIndex)] : null;
  if (!active || active.sourceStart < 0 || active.sourceEnd > text.length || active.sourceEnd <= active.sourceStart) return <>{text}</>;
  return <>{text.slice(0, active.sourceStart)}<mark>{text.slice(active.sourceStart, active.sourceEnd)}</mark>{text.slice(active.sourceEnd)}</>;
}

function NavRow({ icon: Icon, label, value, onPress }: { icon: ComponentType<{ 'aria-hidden'?: boolean }>; label: string; value: string; onPress?: () => void | Promise<void> }) {
  return <Button className="fl-popup-nav-row" onPress={onPress}><Icon aria-hidden={true} /><strong>{label}</strong><span>{value}</span><ChevronRight aria-hidden={true} /></Button>;
}

export function PopupConsole({ model, onCommand, onSettingChange, onRequestPersistentSiteAccess, onOpenSettings, onOpenGuide, onReturnSource, onReadCurrentPage, onVoiceChange, onPageVoiceChange, onOpenDocuments, onOpenVoiceStudio }: PopupConsoleProps) {
  const progress = model.total ? Math.min(100, ((model.index + 1) / model.total) * 100) : 0;
  const playing = model.status === 'playing';
  const browserModelVoiceUnavailable = model.settings.activeProviderId === 'browser-model'
    && model.voiceLoadState === 'ready' && !(model.availableVoices || []).length;
  const primaryLabel = browserModelVoiceUnavailable ? '请先下载模型音色' : playing ? '暂停朗读' : model.status === 'paused' ? '继续朗读' : '开始朗读';
  const statusLabel = playing ? '正在朗读' : model.status === 'paused' ? '已暂停' : model.status === 'error' ? '连接异常' : '准备就绪';
  const providerSummary = providerSummaryLabels[model.settings.activeProviderId] || '语音来源';
  const sourceOptions = configuredProviderOptions(model.providerStates || [], model.settings.activeProviderId);
  const availableVoiceOptions = (model.availableVoices || []).map((voice) => [
    voice.id,
    `${voice.label}${voice.lang ? ` · ${voice.lang}` : ''}`,
  ] as const);
  const voiceSelectValue = model.selectedVoiceId || availableVoiceOptions.at(0)?.[0] || '';
  const strategyVoiceKey = '__strategy__';
  const authorVoiceOptions = [[strategyVoiceKey, '跟随配音策略'], ...availableVoiceOptions] as ReadonlyArray<readonly [string, string]>;
  const selectedVoice = (model.availableVoices || []).find((voice) => voice.id === model.selectedVoiceId);
  const providerNotice = model.providerNotice || (
    model.settings.activeProviderId === 'browser-model'
      ? `当前浏览器模型仅提供固定音色，不支持声音克隆${model.providerDevice ? ` · ${model.providerDevice.toUpperCase()}` : ''}`
      : model.settings.activeProviderId === 'local-service'
        ? `${model.providerAdapter || '本地适配器'} · ${model.providerBaseUrl || 'http://127.0.0.1:7811'}`
        : model.settings.activeProviderId === 'browser-system'
          ? selectedVoice?.eventTypes?.includes('word') ? '当前系统音色支持逐词边界。' : '当前系统音色未声明逐词边界，将保留句子高亮。'
          : '音色由所配置的在线服务提供。'
  );
  const selectedPresetGuidance = presetGuidance[model.settings.preset] ?? presetGuidance['everyone-one']!;

  return (
    <section className="fl-console" aria-label="Flowloud 控制台">
      <header className="fl-header">
        <div className="fl-header-summary">
          {model.isMock ? <span className="fl-mock-badge">MOCK</span> : null}
          <span className={`fl-status is-${model.status}`}>{statusLabel}</span>
          <span className="fl-header-provider">{providerSummary}</span>
        </div>
        <span className="fl-header-product">Flowloud / 流声</span>
      </header>

      <div className="fl-console-scroll">
        {model.globalPlayback?.active && model.globalPlayback.sourceIsCurrentTab === false ? (
          <section className="fl-global-playback" aria-label="其他标签页正在朗读">
            <div><strong>正在控制其他标签页的朗读</strong><span>播放不会因为切换标签页而中断。</span></div>
            <Button onPress={onReturnSource}><ExternalLink aria-hidden="true" />回到来源页</Button>
            <Button onPress={onReadCurrentPage}><RefreshCcw aria-hidden="true" />朗读当前页</Button>
          </section>
        ) : null}
        <section className="fl-player" aria-label="当前朗读">
          <div className="fl-caption">
            <div><strong>{model.currentSpeaker || '正在准备'}</strong><span>第 {Math.min(model.index + 1, Math.max(1, model.total))} 段 / 共 {model.total} 段</span></div>
            <p><ActiveSentence text={model.currentText || '正在识别正文，请稍候。'} words={model.currentWords} wordIndex={model.currentWordIndex} /></p>
          </div>
          <div className="fl-progress-line"><div className="fl-progress" role="progressbar" aria-label="朗读进度" aria-valuemin={1} aria-valuemax={Math.max(1, model.total)} aria-valuenow={Math.min(model.index + 1, Math.max(1, model.total))}><span style={{ width: `${progress}%` }} /></div><span>{Math.round(progress)}%</span></div>
          <p className="fl-kicker">{model.sourceLabel}</p>
          <h1>{model.title}</h1>
          <div className="fl-transport" role="group" aria-label="朗读控制">
            <Button className="fl-transport-side" aria-label="上一句" onPress={() => onCommand?.('previous')}><SkipBack aria-hidden="true" /></Button>
            <Button className="fl-transport-primary" aria-label={primaryLabel} isDisabled={browserModelVoiceUnavailable} onPress={() => onCommand?.('toggle-playback')}>{playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}</Button>
            <Button className="fl-transport-side" aria-label="下一句" onPress={() => onCommand?.('next')}><SkipForward aria-hidden="true" /></Button>
          </div>
          {model.controlNotice ? <div className="fl-control-notice" role="status" aria-live="polite"><AudioLines aria-hidden="true" /><span>{model.controlNotice}</span></div> : null}
          {model.message ? <div className="fl-message" role="alert"><span>{model.message}</span>{model.status === 'error' && model.settings.activeProviderId !== 'browser-system' ? <Button onPress={() => onCommand?.('retry-system-once')}>一次性改用系统语音</Button> : null}</div> : null}
        </section>

        <div className="fl-quick-actions" role="group" aria-label="常用功能">
          <Button className={`fl-quick-action ${model.settings.clickToRead ? 'is-active' : ''}`} aria-pressed={model.settings.clickToRead} onPress={() => onSettingChange?.('clickToRead', !model.settings.clickToRead)}><MousePointerClick aria-hidden="true" /><span>点读<small>{model.settings.clickToRead ? '已开启' : '已关闭'}</small></span></Button>
          <Button
            className={`fl-quick-action ${model.settings.showFloatingPlayer ? 'is-active' : ''}`}
            aria-pressed={model.settings.showFloatingPlayer}
            onPress={() => model.settings.showFloatingPlayer && model.persistentSiteAccess === false
              ? onRequestPersistentSiteAccess?.()
              : onSettingChange?.('showFloatingPlayer', !model.settings.showFloatingPlayer)}
          >
            <SlidersHorizontal aria-hidden="true" />
            <span>悬浮播放器<small>{model.settings.showFloatingPlayer
              ? model.persistentSiteAccess === false ? '浏览器已限制本页' : '刷新后自动显示'
              : '已关闭'}</small></span>
          </Button>
          <Button className="fl-quick-action" onPress={() => onCommand?.('locate-current')}><FileText aria-hidden="true" /><span>回到正文</span></Button>
        </div>

        <Tabs className="fl-popup-tabs" defaultSelectedKey="sound">
          <TabList className="fl-popup-tab-list" aria-label="快捷设置分类">
            <Tab id="sound"><AudioLines aria-hidden="true" />声音</Tab>
            <Tab id="reading"><BookOpen aria-hidden="true" />阅读</Tab>
            <Tab id="voices"><UsersRound aria-hidden="true" />配音</Tab>
            <Tab id="more"><SlidersHorizontal aria-hidden="true" />更多</Tab>
          </TabList>

          <TabPanel id="sound" className="fl-popup-tab-panel">
            <div className="fl-popup-card">
              <div className="fl-popup-select-row"><UserRound aria-hidden="true" /><ChoiceSelect label="语音来源" value={model.settings.activeProviderId} options={sourceOptions} onChange={(value) => onSettingChange?.('activeProviderId', value)} /></div>
              {availableVoiceOptions.length ? <div className="fl-popup-select-row"><AudioLines aria-hidden="true" /><ChoiceSelect label="当前音色" value={voiceSelectValue} options={availableVoiceOptions} onChange={(value) => onVoiceChange?.(value)} /></div> : null}
              <div className="fl-popup-speed-row"><Gauge aria-hidden="true" /><span>朗读速度</span><div>{speedOptions.map((speed) => <Button key={speed} className={model.settings.playbackRate === speed ? 'is-active' : ''} onPress={() => onSettingChange?.('playbackRate', speed)}>{speed}×</Button>)}</div></div>
              <div className="fl-provider-note" data-provider={model.settings.activeProviderId}>
                <span>{model.voiceLoadState === 'loading' ? '正在读取可用音色…' : providerNotice}</span>
                <Button aria-label="打开当前来源设置" onPress={() => onOpenSettings?.('voice', model.settings.activeProviderId)}>管理当前来源…</Button>
              </div>
            </div>
          </TabPanel>

          <TabPanel id="reading" className="fl-popup-tab-panel">
            <div className="fl-popup-card fl-popup-reading-card">
              <div className="fl-popup-mode-row">
                <Button className={model.settings.readingMode === 'content' ? 'is-active' : ''} onPress={() => onSettingChange?.('readingMode', 'content')}>正文朗读</Button>
                <Button className={model.settings.readingMode === 'guide' ? 'is-active' : ''} onPress={() => onSettingChange?.('readingMode', 'guide')}>页面导览</Button>
              </div>
              <div className="fl-popup-mode-explainer">
                <strong>{model.settings.readingMode === 'content' ? '连续朗读正文' : '按页面结构逐项浏览'}</strong>
                <span>{model.settings.readingMode === 'content' ? '提取文章或帖子正文，按作者与段落顺序连续播放。' : '按标题、区域、链接和控件浏览；只定位与朗读，不会替你点击网页。'}</span>
                {model.settings.readingMode === 'guide' && onOpenGuide ? <Button onPress={onOpenGuide}>打开页面导览<ChevronRight aria-hidden="true" /></Button> : null}
              </div>
            </div>
          </TabPanel>

          <TabPanel id="voices" className="fl-popup-tab-panel">
            <div className="fl-popup-card">
              <div className="fl-popup-select-row"><Bot aria-hidden="true" /><ChoiceSelect label="配音策略" value={model.settings.preset} options={presetOptions} onChange={(value) => onSettingChange?.('preset', value as PopupSettings['preset'])} /></div>
              <div className="fl-popup-strategy-guidance">
                <CircleHelp aria-hidden="true" />
                <span><strong>{selectedPresetGuidance.label}</strong><small>{selectedPresetGuidance.description}</small></span>
                <DialogTrigger>
                  <Button aria-label="查看全部配音策略说明">查看全部</Button>
                  <Popover className="fl-popup-help-popover" placement="top end">
                    <Dialog className="fl-popup-help-dialog" aria-label="配音策略说明">
                      <h3>配音策略说明</h3>
                      <ul>{presetOptions.map(([id]) => {
                        const guidance = presetGuidance[id]!;
                        return <li key={id}><strong>{guidance.label}</strong><span>{guidance.description}</span></li>;
                      })}</ul>
                    </Dialog>
                  </Popover>
                </DialogTrigger>
              </div>
              <div className="fl-popup-voice-heading"><div><strong>本页角色</strong><span>{model.authors.length} 位</span></div><small>选择后立即应用，不会离开 Popup</small></div>
              {model.pageVoiceLoadState === 'loading' ? <div className="fl-popup-empty">正在读取本页作者…</div> : null}
              {model.pageVoiceLoadState !== 'loading' && !model.authors.length ? <div className="fl-popup-empty">当前页面还没有可分配的作者。</div> : null}
              {model.authors.map((author) => {
                const assignedVoice = model.pageVoiceAssignments?.[author.id] || strategyVoiceKey;
                const value = authorVoiceOptions.some(([voiceId]) => voiceId === assignedVoice) ? assignedVoice : strategyVoiceKey;
                const AuthorIcon = author.isOp ? Crown : UserRound;
                return (
                  <div className="fl-popup-author-row" key={author.id}>
                    <AuthorIcon aria-hidden={true} />
                    <div><strong>{author.name}</strong><small>{author.role || (author.isOp ? '楼主' : '回复')}{author.count ? ` · ${author.count} 段` : ''}</small></div>
                    <ChoiceSelect label={`${author.name}的声音`} value={value} options={authorVoiceOptions} onChange={(voiceId) => onPageVoiceChange?.(author.id, voiceId)} />
                  </div>
                );
              })}
              <Button className="fl-popup-library-link" onPress={onOpenVoiceStudio}><AudioLines aria-hidden="true" />管理、试听与导入声音<ChevronRight aria-hidden="true" /></Button>
            </div>
          </TabPanel>

          <TabPanel id="more" className="fl-popup-tab-panel">
            <nav className="fl-popup-card fl-popup-footer-nav" aria-label="其他设置与工作台">
              <NavRow icon={Languages} label="OCR 与翻译工作台" value="网页、图片与 PDF" onPress={onOpenDocuments} />
              <NavRow icon={Settings2} label="打开全部设置" value="唯一设置中心" onPress={() => onOpenSettings?.('voice', model.settings.activeProviderId)} />
            </nav>
          </TabPanel>
        </Tabs>
      </div>
    </section>
  );
}
