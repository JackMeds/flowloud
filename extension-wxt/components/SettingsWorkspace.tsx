import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Tab, TabList, TabPanel, Tabs } from 'react-aria-components';
import { AudioLines, BookOpen, Check, Database, Download, Gauge, HardDrive, Keyboard, Languages, Palette, RotateCcw, Search, Settings2, SlidersHorizontal, Upload } from 'lucide-react';
import type { ComponentType, ReactNode } from 'react';
import { AiProfilesSettings } from './AiProfilesSettings';
import { ChoiceSelect, SettingSwitch } from './FormControls';
import { runtimeDefaultSettings, type PopupSettings, type SettingsSection } from './model';
import { createRuntimeBridge } from './runtime-bridge';
import { VoiceWorkbench } from './VoiceWorkbench';

const speedOptions = [0.75, 1, 1.25, 1.5, 1.75, 2].map((speed) => [String(speed), `${speed}×`] as const);
const themeOptions = [['light', '浅色（推荐）'], ['system', '跟随系统'], ['dark', '深色']] as const;
type SaveStatus = 'saved' | 'saving' | 'failed';

function PageHeading({ eyebrow, title, description, aside }: { eyebrow: string; title: string; description: string; aside?: ReactNode }) {
  return <div className="fl-page-heading"><div><p>{eyebrow}</p><h1>{title}</h1><span>{description}</span></div>{aside}</div>;
}

function SettingsCard({ icon: Icon, title, description, children }: { icon: ComponentType<{ 'aria-hidden'?: boolean }>; title: string; description: string; children: ReactNode }) {
  return <section className="fl-settings-card"><div className="fl-card-heading"><Icon aria-hidden={true} /><div><h2>{title}</h2><p>{description}</p></div></div>{children}</section>;
}

const SEARCH_ITEMS: Array<{ id: string; label: string; path: string; keywords: string; section: SettingsSection }> = [
  { id: 'reader-playback', label: '默认播放速度', path: '朗读 / 播放与阅读方式', keywords: '速度 快慢 播放 朗读 rate', section: 'reader' },
  { id: 'reader-click', label: '点击正文朗读', path: '朗读 / 网页中的常用功能', keywords: '点读 点击 正文 朗读', section: 'reader' },
  { id: 'reader-floating', label: '悬浮播放器', path: '朗读 / 网页中的常用功能', keywords: '悬浮球 浮窗 播放器', section: 'reader' },
  { id: 'reader-appearance', label: '当前句聚焦与逐词高亮', path: '朗读 / 阅读外观与高亮', keywords: '外观 高亮 动画 跟随 逐词', section: 'reader' },
  { id: 'reader-shortcuts', label: '快捷键', path: '朗读 / 快捷键', keywords: '快捷键 hotkey shortcut alt o', section: 'reader' },
  { id: 'voice-sources', label: '全部声音来源与独立配置', path: '声音 / 声音来源', keywords: '来源 引擎 provider 本地 tts 浏览器 系统 在线 豆包 api key', section: 'voice' },
  { id: 'voice-strategy', label: '配音方式与人物声音池', path: '声音 / 配音方式与声音池', keywords: '策略 角色 作者 楼主 回复 多选 全选 随机 轮换', section: 'voice' },
  { id: 'voice-select', label: '默认旁白、声音池、试听与备注', path: '声音 / 声音目录', keywords: '音色 声音 voice tts 试听 旁白 角色 作者 多选', section: 'voice' },
  { id: 'voice-sources', label: '浏览器模型、下载与音色缓存', path: '声音 / 浏览器模型与下载', keywords: '模型 下载 缓存 批量 声音库 魔搭 huggingface', section: 'voice' },
  { id: 'ai-ocr', label: 'OCR 与翻译服务', path: '文档工具 / OCR 与翻译服务', keywords: 'ocr 翻译 图片 pdf ai', section: 'ai' },
  { id: 'data-export', label: '导入与导出设置', path: '数据与帮助 / 本地数据与设置', keywords: '导入 导出 json 设置 迁移', section: 'advanced' },
  { id: 'data-diagnostics', label: '诊断与恢复', path: '数据与帮助 / 诊断与恢复', keywords: '诊断 日志 恢复 默认 排障', section: 'advanced' },
];

function normalizeSection(section: SettingsSection): SettingsSection {
  return section === 'appearance' || section === 'shortcuts' ? 'reader' : section;
}

export function SettingsWorkspace({ defaultSection = 'reader', initialProviderId = '', initialStudioOpen = false }: { defaultSection?: SettingsSection; initialProviderId?: string; initialStudioOpen?: boolean }) {
  const [bridge] = useState(() => createRuntimeBridge());
  const [selectedSection, setSelectedSection] = useState<SettingsSection>(normalizeSection(defaultSection));
  const [settings, setSettings] = useState<PopupSettings>({ ...runtimeDefaultSettings });
  const [rawSettings, setRawSettings] = useState<Record<string, unknown>>({});
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('saved');
  const [followSentence, setFollowSentence] = useState(true);
  const [wordSweep, setWordSweep] = useState(true);
  const [highContrast, setHighContrast] = useState(false);
  const [operationStatus, setOperationStatus] = useState('');
  const [search, setSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const saveTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!bridge.available) return;
    let disposed = false;
    void bridge.send({ type: 'settings:get' }).then((response) => {
      if (disposed) return;
      const raw = response.settings || {};
      setRawSettings(raw); setSettings({ ...runtimeDefaultSettings, ...raw } as PopupSettings);
      setFollowSentence(String(raw.readingFocus || 'sentence') !== 'off'); setWordSweep(raw.wordHighlightEnabled !== false); setHighContrast(raw.highContrast === true);
    }).catch(() => setSaveStatus('failed'));
    return () => { disposed = true; window.clearTimeout(saveTimer.current); };
  }, [bridge]);

  const queueSave = (nextSettings: PopupSettings, extra: Record<string, unknown> = {}) => {
    window.clearTimeout(saveTimer.current); setSaveStatus('saving');
    saveTimer.current = window.setTimeout(() => {
      const merged = { ...rawSettings, ...nextSettings, ...extra };
      if (!bridge.available) { setRawSettings(merged); setSaveStatus('saved'); return; }
      void bridge.saveSettings(merged).then((response) => { setRawSettings(response.settings || merged); setSaveStatus('saved'); }).catch(() => setSaveStatus('failed'));
    }, 280);
  };
  const change = <Key extends keyof PopupSettings>(key: Key, value: PopupSettings[Key]) => { const next = { ...settings, [key]: value }; setSettings(next); queueSave(next); };
  const downloadJson = (name: string, value: unknown) => { const url = URL.createObjectURL(new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: 'application/json' })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000); };
  const run = async (label: string, operation: () => Promise<void>) => { setOperationStatus(`${label}…`); try { await operation(); setOperationStatus(`${label}完成。`); } catch (error) { setOperationStatus(error instanceof Error ? error.message : String(error)); } };
  const searchResults = useMemo(() => { const query = search.trim().toLowerCase(); return query ? SEARCH_ITEMS.filter((item) => `${item.label} ${item.path} ${item.keywords}`.toLowerCase().includes(query)).slice(0, 8) : []; }, [search]);
  const jumpTo = (item: typeof SEARCH_ITEMS[number]) => {
    setSelectedSection(item.section); setSearchOpen(false);
    // TabPanel content is mounted after the selection update. A second frame
    // keeps the search result useful even when the target lives in another
    // task, and briefly marks the destination so the user can spot it.
    window.setTimeout(() => {
      const target = document.getElementById(item.id);
      if (!target) return;
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      target.classList.add('is-search-target');
      window.setTimeout(() => target.classList.remove('is-search-target'), 1200);
    }, 40);
  };
  const importSettings = async (file: File) => { const parsed = JSON.parse(await file.text()) as Record<string, unknown>; await bridge.saveSettings(parsed); window.location.reload(); };

  return <main className="fl-workspace" aria-label="Flowloud 设置中心"><Tabs className="fl-workspace-tabs" orientation="vertical" selectedKey={selectedSection} onSelectionChange={(key) => setSelectedSection(normalizeSection(String(key) as SettingsSection))}>
    <aside className="fl-settings-sidebar"><div className="fl-workspace-brand"><img src="/assets/flowloud-mark.svg" alt="" /><div><strong>Flowloud / 流声</strong><span>统一设置中心</span></div></div><div className="fl-settings-search"><Search aria-hidden="true" /><input aria-label="搜索设置" value={search} onChange={(event) => { setSearch(event.target.value); setSearchOpen(true); }} onFocus={() => setSearchOpen(true)} onKeyDown={(event) => { if (event.key === 'Escape') { setSearchOpen(false); event.currentTarget.blur(); } }} placeholder="搜索设置…" />{searchOpen && searchResults.length ? <div className="fl-settings-search-results" role="listbox">{searchResults.map((item) => <Button key={`${item.id}:${item.label}`} aria-label={`${item.path} / ${item.label}`} onPress={() => jumpTo(item)}><strong>{item.label}</strong><small>{item.path}</small></Button>)}</div> : null}</div><TabList aria-label="设置任务"><Tab id="reader"><BookOpen aria-hidden="true" />朗读</Tab><Tab id="voice"><AudioLines aria-hidden="true" />声音</Tab><Tab id="ai"><Languages aria-hidden="true" />文档工具</Tab><Tab id="advanced"><Database aria-hidden="true" />数据与帮助</Tab></TabList><div className={`fl-save-status is-${saveStatus}`} aria-live="polite">{saveStatus === 'saved' ? <Check aria-hidden="true" /> : <span className="fl-save-pulse" />}{saveStatus === 'saved' ? '所有更改已保存' : saveStatus === 'saving' ? '正在保存…' : '保存失败'}</div></aside>
    <div className="fl-workspace-content">
      <TabPanel id="reader"><PageHeading eyebrow="朗读" title="让常用操作随手可用" description="播放、点读、跟随和外观设置会自动保存。" /><div className="fl-settings-stack"><SettingsCard icon={Gauge} title="播放与阅读方式" description="控制默认速度，以及把页面当正文还是导览来读。"><div id="reader-playback"><ChoiceSelect label="默认播放速度" value={String(settings.playbackRate)} options={speedOptions} onChange={(value) => change('playbackRate', Number(value))} /></div><div className="fl-settings-segmented" aria-label="默认阅读方式"><Button className={settings.readingMode === 'content' ? 'is-active' : ''} onPress={() => change('readingMode', 'content')}>正文朗读</Button><Button className={settings.readingMode === 'guide' ? 'is-active' : ''} onPress={() => change('readingMode', 'guide')}>页面导览</Button></div></SettingsCard><SettingsCard icon={SlidersHorizontal} title="网页中的常用功能" description="只保留真正影响当前阅读的开关。"><div id="reader-click"><SettingSwitch title="点击正文朗读" description="点击任意句子，从精确位置开始朗读。" isSelected={settings.clickToRead} onChange={(value) => change('clickToRead', value)} /></div><div id="reader-floating"><SettingSwitch title="显示悬浮播放器" description="在普通网页边缘自动显示入口。" isSelected={settings.showFloatingPlayer} onChange={(value) => change('showFloatingPlayer', value)} /></div></SettingsCard><details className="fl-settings-disclosure" id="reader-appearance"><summary><Palette aria-hidden="true" />阅读外观与高亮<Settings2 aria-hidden="true" /></summary><div className="fl-settings-disclosure-body"><ChoiceSelect label="主题" value="light" options={themeOptions} onChange={(value) => queueSave(settings, { theme: value })} /><SettingSwitch title="当前句聚焦" description="使用浅色定位线跟随当前句。" isSelected={followSentence} onChange={(value) => { setFollowSentence(value); queueSave(settings, { readingFocus: value ? 'sentence' : 'off' }); }} /><SettingSwitch title="逐词高亮" description="以真实边界事件更新当前词。" isSelected={wordSweep} onChange={(value) => { setWordSweep(value); queueSave(settings, { wordHighlightEnabled: value }); }} /><SettingSwitch title="增强对比度" description="适合低对比度网页。" isSelected={highContrast} onChange={(value) => { setHighContrast(value); queueSave(settings, { highContrast: value }); }} /></div></details><details className="fl-settings-disclosure" id="reader-shortcuts"><summary><Keyboard aria-hidden="true" />快捷键<Settings2 aria-hidden="true" /></summary><div className="fl-settings-disclosure-body"><div className="fl-shortcut-row"><span>播放 / 暂停全局朗读</span><kbd>Alt + O</kbd></div><Button className="fl-secondary-button" onPress={() => run('打开快捷键管理', () => bridge.openShortcuts())}><Keyboard aria-hidden="true" />在浏览器中修改快捷键</Button></div></details></div></TabPanel>
      <TabPanel id="voice"><VoiceWorkbench initialProviderId={initialProviderId} initialStudioOpen={initialStudioOpen} /></TabPanel>
      <TabPanel id="ai"><PageHeading eyebrow="文档工具" title="识别、翻译并朗读" description="OCR 和翻译服务只在你主动使用时运行，凭据不会进入设置导出。" aside={<Button className="fl-primary-button" onPress={() => bridge.openDocumentWorkbench(null)}><Languages aria-hidden="true" />打开工作台</Button>} /><div id="ai-ocr"><AiProfilesSettings /></div></TabPanel>
      <TabPanel id="advanced"><PageHeading eyebrow="数据与帮助" title="管理缓存、设置与排障" description="这些操作默认不打扰日常阅读。" /><div className="fl-settings-stack"><SettingsCard icon={HardDrive} title="本地数据与设置" description="模型、语音、别名备注和网页配音均保存在本机。"><div id="data-export"><Button className="fl-settings-action-row" onPress={() => downloadJson(`flowloud-settings-${new Date().toISOString().slice(0, 10)}.json`, rawSettings)}><Download aria-hidden="true" /><span><strong>导出设置</strong><small>不包含 API Key、本地令牌和验证记录</small></span></Button><Button className="fl-settings-action-row" onPress={() => document.getElementById('settings-import')?.click()}><Upload aria-hidden="true" /><span><strong>导入设置</strong><small>导入后由 Schema V9 校验和迁移</small></span></Button><input id="settings-import" hidden type="file" accept="application/json,.json" onChange={(event) => { const file = event.target.files?.[0]; if (file) void run('导入设置', () => importSettings(file)); event.currentTarget.value = ''; }} /></div></SettingsCard><SettingsCard icon={Database} title="诊断与恢复" description="仅在故障排查时使用。"><div id="data-diagnostics"><Button className="fl-settings-action-row" onPress={() => run('生成诊断报告', async () => downloadJson(`flowloud-diagnostics-${Date.now()}.json`, await bridge.diagnostics()))}><Database aria-hidden="true" /><span><strong>下载朗读诊断</strong><small>包含脱敏设置与音频状态</small></span></Button><Button className="fl-settings-action-row" onPress={() => { if (window.confirm('确定恢复默认设置吗？')) void run('恢复默认设置', async () => { await bridge.resetSettings(); window.location.reload(); }); }}><RotateCcw aria-hidden="true" /><span><strong>恢复默认设置</strong><small>不会删除已下载模型和声音</small></span></Button></div></SettingsCard></div></TabPanel>
    </div></Tabs>{operationStatus ? <div className="fl-operation-status" role="status">{operationStatus}</div> : null}</main>;
}
