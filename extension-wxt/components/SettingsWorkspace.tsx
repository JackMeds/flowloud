import { useEffect, useRef, useState } from 'react';
import { Button, Tab, TabList, TabPanel, Tabs } from 'react-aria-components';
import { AudioLines, BookOpen, Check, Database, Download, Gauge, HardDrive, Keyboard, Languages, Palette, RotateCcw, Settings2, SlidersHorizontal, Upload } from 'lucide-react';
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

export function SettingsWorkspace({ defaultSection = 'reader', initialProviderId = '' }: { defaultSection?: SettingsSection; initialProviderId?: string }) {
  const [bridge] = useState(() => createRuntimeBridge());
  const [selectedSection, setSelectedSection] = useState<SettingsSection>(defaultSection);
  const [settings, setSettings] = useState<PopupSettings>({ ...runtimeDefaultSettings });
  const [rawSettings, setRawSettings] = useState<Record<string, unknown>>({});
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('saved');
  const [followSentence, setFollowSentence] = useState(true);
  const [wordSweep, setWordSweep] = useState(true);
  const [highContrast, setHighContrast] = useState(false);
  const [operationStatus, setOperationStatus] = useState('');
  const saveTimer = useRef<number | undefined>(undefined);
  const importInput = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!bridge.available) return;
    let disposed = false;
    void bridge.send({ type: 'settings:get' }).then((response) => {
      if (disposed) return;
      const raw = response.settings || {};
      setRawSettings(raw);
      setSettings({ ...runtimeDefaultSettings, ...raw } as PopupSettings);
      setFollowSentence(String(raw.readingFocus || 'sentence') !== 'off');
      setWordSweep(raw.wordHighlightEnabled !== false);
      setHighContrast(raw.highContrast === true);
    }).catch(() => setSaveStatus('failed'));
    return () => { disposed = true; window.clearTimeout(saveTimer.current); };
  }, [bridge]);

  const queueSave = (nextSettings: PopupSettings, extra: Record<string, unknown> = {}) => {
    window.clearTimeout(saveTimer.current);
    setSaveStatus('saving');
    saveTimer.current = window.setTimeout(() => {
      const merged = { ...rawSettings, ...nextSettings, ...extra };
      if (!bridge.available) { setRawSettings(merged); setSaveStatus('saved'); return; }
      void bridge.saveSettings(merged).then((response) => {
        setRawSettings(response.settings || merged);
        setSaveStatus('saved');
      }).catch(() => setSaveStatus('failed'));
    }, 360);
  };

  const change = <Key extends keyof PopupSettings>(key: Key, value: PopupSettings[Key]) => {
    const next = { ...settings, [key]: value };
    setSettings(next);
    queueSave(next);
  };

  const downloadJson = (name: string, value: unknown) => {
    const url = URL.createObjectURL(new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = name; anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const run = async (label: string, operation: () => Promise<void>) => {
    setOperationStatus(`${label}…`);
    try { await operation(); setOperationStatus(`${label}完成。`); }
    catch (error) { setOperationStatus(error instanceof Error ? error.message : String(error)); }
  };

  const importSettings = async (file: File) => {
    const parsed = JSON.parse(await file.text()) as Record<string, unknown>;
    await bridge.saveSettings(parsed);
    window.location.reload();
  };

  return <main className="fl-workspace" aria-label="Flowloud 设置中心">
    <Tabs className="fl-workspace-tabs" orientation="vertical" selectedKey={selectedSection} onSelectionChange={(key) => setSelectedSection(String(key) as SettingsSection)}>
      <aside className="fl-settings-sidebar">
        <div className="fl-workspace-brand"><img src="/assets/flowloud-mark.svg" alt="" /><div><strong>Flowloud / 流声</strong><span>统一设置中心</span></div></div>
        <TabList aria-label="设置分类">
          <Tab id="reader"><BookOpen aria-hidden="true" />朗读与交互</Tab>
          <Tab id="ai"><Languages aria-hidden="true" />OCR 与翻译</Tab>
          <Tab id="voice"><AudioLines aria-hidden="true" />语音与音色</Tab>
          <Tab id="appearance"><Palette aria-hidden="true" />阅读外观</Tab>
          <Tab id="shortcuts"><Keyboard aria-hidden="true" />快捷键</Tab>
          <Tab id="advanced"><Settings2 aria-hidden="true" />高级</Tab>
        </TabList>
        <div className={`fl-save-status is-${saveStatus}`} aria-live="polite">{saveStatus === 'saved' ? <Check aria-hidden="true" /> : <span className="fl-save-pulse" />}{saveStatus === 'saved' ? '所有更改已保存' : saveStatus === 'saving' ? '正在保存…' : '保存失败'}</div>
      </aside>

      <div className="fl-workspace-content">
        <TabPanel id="reader">
          <PageHeading eyebrow="朗读与交互" title="让常用操作随手可用" description="播放、点读和悬浮播放器会自动保存，并立即作用于网页。" />
          <div className="fl-settings-stack">
            <SettingsCard icon={Gauge} title="播放与阅读方式" description="控制默认速度，以及把页面当正文还是导览来读。">
              <ChoiceSelect label="默认播放速度" value={String(settings.playbackRate)} options={speedOptions} onChange={(value) => change('playbackRate', Number(value))} />
              <div className="fl-settings-segmented" aria-label="默认阅读方式"><Button className={settings.readingMode === 'content' ? 'is-active' : ''} onPress={() => change('readingMode', 'content')}>正文朗读</Button><Button className={settings.readingMode === 'guide' ? 'is-active' : ''} onPress={() => change('readingMode', 'guide')}>页面导览</Button></div>
            </SettingsCard>
            <SettingsCard icon={SlidersHorizontal} title="网页中的常用功能" description="这两个开关也会固定显示在 Popup 播放器下方。">
              <SettingSwitch title="点击正文朗读" description="点击任意句子，从精确位置开始朗读。" isSelected={settings.clickToRead} onChange={(value) => change('clickToRead', value)} />
              <SettingSwitch title="显示悬浮播放器" description="在普通网页边缘自动显示入口。" isSelected={settings.showFloatingPlayer} onChange={(value) => change('showFloatingPlayer', value)} />
            </SettingsCard>
          </div>
        </TabPanel>

        <TabPanel id="ai"><PageHeading eyebrow="OCR 与翻译" title="分别连接视觉与翻译模型" description="凭据不会进入设置导出。" aside={<Button className="fl-primary-button" onPress={() => bridge.openDocumentWorkbench(null)}><Languages aria-hidden="true" />打开工作台</Button>} /><AiProfilesSettings /></TabPanel>

        <TabPanel id="voice"><VoiceWorkbench initialProviderId={initialProviderId} /></TabPanel>

        <TabPanel id="appearance">
          <PageHeading eyebrow="阅读外观" title="突出进度，不遮住正文" description="句子聚焦与逐词反馈分为两层；右侧预览会即时更新。" />
          <div className="fl-appearance-layout">
            <SettingsCard icon={Palette} title="主题与高亮" description="使用中性蓝白作为默认外观。">
              <ChoiceSelect label="主题" value="light" options={themeOptions} onChange={(value) => queueSave(settings, { theme: value })} />
              <SettingSwitch title="当前句聚焦" description="使用很浅的蓝色衬底和左侧定位线。" isSelected={followSentence} onChange={(value) => { setFollowSentence(value); queueSave(settings, { readingFocus: value ? 'sentence' : 'off' }); }} />
              <SettingSwitch title="逐词轻扫" description="当前词使用蓝字与细底线。" isSelected={wordSweep} onChange={(value) => { setWordSweep(value); queueSave(settings, { wordHighlightEnabled: value }); }} />
              <SettingSwitch title="增强对比度" description="适合低对比度网页。" isSelected={highContrast} onChange={(value) => { setHighContrast(value); queueSave(settings, { highContrast: value }); }} />
            </SettingsCard>
            <aside className={`fl-reading-preview ${highContrast ? 'is-strong' : ''}`}><span>实时预览</span><h2>如何让朗读真正融入阅读？</h2><p>真正自然的网页朗读，不该把阅读从页面里夺走。</p><p className={followSentence ? 'is-current' : ''}>它应该让你始终知道自己听到了哪里，<mark className={wordSweep ? 'is-active' : ''}>当前词</mark>又推进到了什么位置。</p></aside>
          </div>
        </TabPanel>

        <TabPanel id="shortcuts"><PageHeading eyebrow="快捷键" title="不用离开正文也能控制朗读" description="快捷键由浏览器统一管理。" /><SettingsCard icon={Keyboard} title="全局播放控制" description="快捷键优先控制当前全局会话。"><div className="fl-shortcut-row"><span>播放 / 暂停全局朗读</span><kbd>Alt + O</kbd></div><Button className="fl-primary-button" onPress={() => run('打开快捷键管理', () => bridge.openShortcuts())}><Keyboard aria-hidden="true" />在浏览器中修改快捷键</Button></SettingsCard></TabPanel>

        <TabPanel id="advanced">
          <PageHeading eyebrow="高级" title="存储、诊断与数据管理" description="这些操作不会出现在日常朗读流程里。" />
          <div className="fl-settings-stack">
            <SettingsCard icon={Database} title="本地数据" description="模型、语音与网页配音均保存在本机。">
              <Button className="fl-settings-action-row" onPress={() => downloadJson(`flowloud-settings-${new Date().toISOString().slice(0, 10)}.json`, rawSettings)}><Download aria-hidden="true" /><span><strong>导出设置</strong><small>不包含 API Key、本地令牌和验证记录</small></span></Button>
              <Button className="fl-settings-action-row" onPress={() => importInput.current?.click()}><Upload aria-hidden="true" /><span><strong>导入设置</strong><small>导入后由 Schema V8 校验和迁移</small></span></Button>
              <input ref={importInput} hidden type="file" accept="application/json,.json" onChange={(event) => { const file = event.target.files?.[0]; if (file) void run('导入设置', () => importSettings(file)); event.currentTarget.value = ''; }} />
            </SettingsCard>
            <SettingsCard icon={HardDrive} title="诊断与恢复" description="仅在故障排查时使用。">
              <Button className="fl-settings-action-row" onPress={() => run('生成诊断报告', async () => downloadJson(`flowloud-diagnostics-${Date.now()}.json`, await bridge.diagnostics()))}><Database aria-hidden="true" /><span><strong>下载朗读诊断</strong><small>包含脱敏设置与音频状态</small></span></Button>
              <Button className="fl-settings-action-row" onPress={() => { if (window.confirm('确定恢复默认设置吗？')) void run('恢复默认设置', async () => { await bridge.resetSettings(); window.location.reload(); }); }}><RotateCcw aria-hidden="true" /><span><strong>恢复默认设置</strong><small>不会删除已下载模型和声音</small></span></Button>
            </SettingsCard>
          </div>
        </TabPanel>
      </div>
    </Tabs>
    {operationStatus ? <div className="fl-operation-status" role="status">{operationStatus}</div> : null}
  </main>;
}
