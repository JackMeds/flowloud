import { useEffect, useRef, useState } from 'react';
import { Button, Tab, TabList, TabPanel, Tabs } from 'react-aria-components';
import {
  AudioLines,
  BookOpen,
  Check,
  ChevronRight,
  CircleHelp,
  Cloud,
  Crown,
  Database,
  Download,
  Gauge,
  HardDrive,
  Keyboard,
  Library,
  Languages,
  Mic2,
  MonitorSpeaker,
  Palette,
  Play,
  Radio,
  RotateCcw,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Upload,
  UsersRound,
  Volume2,
} from 'lucide-react';
import type { ComponentType, ReactNode } from 'react';
import { ChoiceSelect, SettingSwitch } from './FormControls';
import { demoPopupModel, type ModelDownloadState, type PopupSettings, type ProviderState } from './model';
import { createRuntimeBridge } from './runtime-bridge';
import { AiProfilesSettings } from './AiProfilesSettings';

const speedOptions = [0.75, 1, 1.25, 1.5, 1.75, 2].map((speed) => [String(speed), `${speed}×`] as const);
const providerOptions = [
  ['browser-system', '浏览器系统语音'],
  ['browser-model', '浏览器下载模型'],
  ['local-service', '本地服务'],
  ['openai-compatible', 'OpenAI 兼容在线 TTS'],
  ['doubao-tts', '豆包原生 TTS'],
] as const;
const strategyOptions = [
  ['everyone-one', '所有人使用同一配音'],
  ['op-plus-one', '楼主独立，其他作者同一配音'],
  ['op-stable-random', '楼主独立，其他作者稳定随机'],
  ['op-round-robin', '楼主独立，其他作者顺序轮换'],
] as const;
const strategyGuidance: Record<string, { title: string; description: string }> = {
  'everyone-one': { title: '推荐：所有人同一音色', description: '楼主、回复者和旁白全部使用当前音色，设置最简单，也不会自动混入机械音。' },
  'op-plus-one': { title: '楼主 + 统一回复音色', description: '楼主使用主音色，其他所有作者共用一个回复音色。' },
  'op-stable-random': { title: '按作者稳定分配', description: '每位回复作者从音色池稳定获得一个声音，同一作者不会在刷新后变声。' },
  'op-round-robin': { title: '按楼层顺序轮换', description: '其余楼层按出现顺序轮换声音，适合多人长帖。' },
};
const themeOptions = [
  ['light', '浅色（推荐）'],
  ['system', '跟随系统'],
  ['dark', '深色'],
] as const;

type SaveStatus = 'saved' | 'saving' | 'failed';
type ProviderDrafts = {
  'browser-model': { modelId: string; repoId: string; revision: string; device: string; allowWasmFallback: boolean };
  'local-service': { adapterId: string; baseUrl: string; model: string; responseFormat: string; rememberToken: boolean };
  'openai-compatible': { baseUrl: string; model: string; voice: string; responseFormat: string; rememberKey: boolean };
  'doubao-tts': { baseUrl: string; path: string; appId: string; resourceId: string; voice: string; responseFormat: string; rememberKey: boolean };
};

const defaultProviderDrafts: ProviderDrafts = {
  'browser-model': { modelId: 'kokoro-zh', repoId: 'onnx-community/Kokoro-82M-v1.1-zh-ONNX', revision: '6cc0f0d2ebe369a68b0df87c2b65c1af8c0ac3e3', device: 'webgpu', allowWasmFallback: true },
  'local-service': { adapterId: 'flowloud-qwen', baseUrl: 'http://127.0.0.1:7811', model: 'qwen3-tts-0.6b-q4', responseFormat: 'wav', rememberToken: false },
  'openai-compatible': { baseUrl: '', model: '', voice: 'alloy', responseFormat: 'mp3', rememberKey: false },
  'doubao-tts': { baseUrl: 'https://openspeech.bytedance.com', path: '/api/v3/tts/unidirectional', appId: '', resourceId: 'seed-tts-2.0', voice: '', responseFormat: 'mp3', rememberKey: false },
};

const browserModelCatalog = {
  'kokoro-zh': {
    label: 'Kokoro v1.1 中英', license: 'Apache-2.0', sizeLabel: '约 110 MB（按需缓存）', expectedBytes: 110 * 1024 * 1024,
    repoId: 'onnx-community/Kokoro-82M-v1.1-zh-ONNX', revision: '6cc0f0d2ebe369a68b0df87c2b65c1af8c0ac3e3',
  },
} as const;

function storageLabel(bytes: number | null) {
  if (bytes == null) return '浏览器未报告可用空间';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB 可用`;
  return `${Math.round(bytes / 1024 ** 2)} MB 可用`;
}

function PageHeading({ eyebrow, title, description, aside }: { eyebrow: string; title: string; description: string; aside?: ReactNode }) {
  return <div className="fl-page-heading"><div><p>{eyebrow}</p><h1>{title}</h1><span>{description}</span></div>{aside}</div>;
}

function SettingsCard({ icon: Icon, title, description, children, className = '' }: { icon: ComponentType<{ 'aria-hidden'?: boolean }>; title: string; description: string; children: ReactNode; className?: string }) {
  return <section className={`fl-settings-card ${className}`}><div className="fl-card-heading"><Icon aria-hidden={true} /><div><h2>{title}</h2><p>{description}</p></div></div>{children}</section>;
}

function ActionRow({ icon: Icon, title, description, action = '打开', onPress }: { icon: ComponentType<{ 'aria-hidden'?: boolean }>; title: string; description: string; action?: string; onPress?: () => void }) {
  return <Button className="fl-settings-action-row" onPress={onPress}><Icon aria-hidden={true} /><span><strong>{title}</strong><small>{description}</small></span><em>{action}</em><ChevronRight aria-hidden={true} /></Button>;
}

export function SettingsWorkspace({ defaultSection = 'reader' }: { defaultSection?: string }) {
  const [bridge] = useState(() => createRuntimeBridge());
  const [selectedSection, setSelectedSection] = useState(defaultSection);
  const [settings, setSettings] = useState<PopupSettings>(() => demoPopupModel.settings);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('saved');
  const [providerStates, setProviderStates] = useState<ProviderState[]>([]);
  const [modelState, setModelState] = useState<ModelDownloadState>({ state: 'missing', ready: false, cached: false });
  const [followSentence, setFollowSentence] = useState(true);
  const [wordSweep, setWordSweep] = useState(true);
  const [highContrast, setHighContrast] = useState(false);
  const [providerDrafts, setProviderDrafts] = useState<ProviderDrafts>(defaultProviderDrafts);
  const [localToken, setLocalToken] = useState('');
  const [onlineKey, setOnlineKey] = useState('');
  const [doubaoKey, setDoubaoKey] = useState('');
  const [onlinePreview, setOnlinePreview] = useState('你好，这是 Flowloud 在线语音试听。');
  const [operationStatus, setOperationStatus] = useState('');
  const [operationBusy, setOperationBusy] = useState(false);
  const [secretStatus, setSecretStatus] = useState<Record<string, { present?: boolean; remembered?: boolean }>>({});
  const [storageAvailable, setStorageAvailable] = useState<number | null>(null);
  const saveTimer = useRef<number | undefined>(undefined);
  const activeModelRequestId = useRef('');
  const rawSettings = useRef<Record<string, unknown>>({});
  const importInput = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let disposed = false;
    const stopProgress = bridge.onModelProgress((progress, requestId) => {
      if (disposed) return;
      if (activeModelRequestId.current && requestId && requestId !== activeModelRequestId.current) return;
      const ratio = Number(progress.progress);
      const loaded = Number(progress.loaded);
      const total = Number(progress.total);
      const percent = Number.isFinite(ratio) ? Math.round(ratio <= 1 ? ratio * 100 : ratio)
        : total > 0 ? Math.round((loaded / total) * 100) : null;
      const file = String(progress.file || progress.name || '模型文件');
      setOperationStatus(`模型下载 · ${file}${percent == null ? '' : ` · ${Math.max(0, Math.min(100, percent))}%`}`);
    });
    if (bridge.available) {
      void bridge.estimateStorage().then((estimate) => { if (!disposed) setStorageAvailable(estimate.available); });
      void bridge.send({ type: 'settings:get' }).then(async (response) => {
        const raw = response.settings || {};
        const next = { ...demoPopupModel.settings, ...raw } as PopupSettings;
        const [states, secrets] = await Promise.all([bridge.providerStates(raw), bridge.secretStatus()]);
        if (disposed) return;
        rawSettings.current = raw;
        setSettings(next);
        setProviderStates(states.providers);
        setModelState(states.model);
        const configured = raw.providerSettings && typeof raw.providerSettings === 'object'
          ? raw.providerSettings as Record<string, Record<string, unknown>> : {};
        setProviderDrafts({
          'browser-model': { ...defaultProviderDrafts['browser-model'], ...configured['browser-model'] } as ProviderDrafts['browser-model'],
          'local-service': { ...defaultProviderDrafts['local-service'], ...configured['local-service'] } as ProviderDrafts['local-service'],
          'openai-compatible': { ...defaultProviderDrafts['openai-compatible'], ...configured['openai-compatible'] } as ProviderDrafts['openai-compatible'],
          'doubao-tts': { ...defaultProviderDrafts['doubao-tts'], ...configured['doubao-tts'] } as ProviderDrafts['doubao-tts'],
        });
        setSecretStatus(secrets);
      }).catch(() => { if (!disposed) setSaveStatus('failed'); });
    }
    return () => { disposed = true; stopProgress(); window.clearTimeout(saveTimer.current); };
  }, [bridge]);

  const queueSave = (nextSettings = settings, extra: Record<string, unknown> = {}) => {
    window.clearTimeout(saveTimer.current);
    setSaveStatus('saving');
    saveTimer.current = window.setTimeout(() => {
      if (!bridge.available) { setSaveStatus('saved'); return; }
      const merged = { ...rawSettings.current, ...nextSettings, ...extra };
      void bridge.saveSettings(merged).then((response) => {
        rawSettings.current = response.settings || merged;
        setSaveStatus('saved');
      }).catch(() => setSaveStatus('failed'));
    }, 420);
  };

  const change = async <Key extends keyof PopupSettings>(key: Key, value: PopupSettings[Key]) => {
    const next = { ...settings, [key]: value };
    setSettings(next);
    queueSave(next);
  };

  const changeBoolean = (setter: (value: boolean) => void, value: boolean, extra: Record<string, unknown>) => {
    setter(value);
    queueSave(settings, extra);
  };

  const stateFor = (providerId: string) => providerStates.find((item) => item.providerId === providerId);
  const selectedBrowserModel = browserModelCatalog[providerDrafts['browser-model'].modelId as keyof typeof browserModelCatalog]
    || browserModelCatalog['kokoro-zh'];
  const selectedStrategyGuidance = strategyGuidance[settings.preset] ?? strategyGuidance['everyone-one']!;

  const updateProvider = <Key extends keyof ProviderDrafts>(providerId: Key, patch: Partial<ProviderDrafts[Key]>) => {
    setProviderDrafts((current) => ({ ...current, [providerId]: { ...current[providerId], ...patch } }));
  };

  const persistProvider = async (providerId: keyof ProviderDrafts) => {
    const providerSettings = rawSettings.current.providerSettings && typeof rawSettings.current.providerSettings === 'object'
      ? rawSettings.current.providerSettings as Record<string, Record<string, unknown>> : {};
    const merged = { ...rawSettings.current, providerSettings: { ...providerSettings, [providerId]: providerDrafts[providerId] } };
    const response = await bridge.saveSettings(merged);
    rawSettings.current = response.settings || merged;
    if (providerId === 'local-service' && localToken) {
      await bridge.saveSecret(providerId, localToken, providerDrafts[providerId].rememberToken);
      setLocalToken('');
    }
    if (providerId === 'openai-compatible' && onlineKey) {
      await bridge.saveSecret(providerId, onlineKey, providerDrafts[providerId].rememberKey);
      setOnlineKey('');
    }
    if (providerId === 'doubao-tts' && doubaoKey) {
      await bridge.saveSecret(providerId, doubaoKey, providerDrafts[providerId].rememberKey);
      setDoubaoKey('');
    }
    setSecretStatus(await bridge.secretStatus());
  };

  const runOperation = async (label: string, operation: () => Promise<void>) => {
    if (operationBusy) return;
    setOperationBusy(true);
    setOperationStatus(`${label}…`);
    try {
      await operation();
      setOperationStatus(`${label}完成。`);
      const states = await bridge.providerStates(rawSettings.current);
      setProviderStates(states.providers);
      setModelState(states.model);
    } catch (error) {
      setOperationStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setOperationBusy(false);
    }
  };

  const downloadJson = (name: string, value: unknown) => {
    const url = URL.createObjectURL(new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = name; anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const exportSettings = () => downloadJson(`flowloud-settings-${new Date().toISOString().slice(0, 10)}.json`, rawSettings.current);

  const importSettings = async (file: File) => {
    const parsed = JSON.parse(await file.text()) as Record<string, unknown>;
    const response = await bridge.saveSettings(parsed);
    rawSettings.current = response.settings || parsed;
    window.location.reload();
  };

  return (
    <main className="fl-workspace" aria-label="Flowloud 设置中心">
      <header className="fl-workspace-header">
        <div className="fl-workspace-brand"><img src="/assets/flowloud-mark.svg" alt="" /><div><strong>Flowloud / 流声</strong><span>全部设置{bridge.available ? '' : ' · MOCK 预览'}</span></div></div>
        <div className={`fl-save-status is-${saveStatus}`} aria-live="polite">{saveStatus === 'saved' ? <Check aria-hidden="true" size={15} /> : <span className="fl-save-pulse" />}{saveStatus === 'saved' ? '已保存' : saveStatus === 'saving' ? '正在保存…' : '保存失败，点击重试'}</div>
      </header>

      <Tabs className="fl-workspace-tabs" orientation="vertical" selectedKey={selectedSection} onSelectionChange={(key) => setSelectedSection(String(key))}>
        <aside className="fl-settings-sidebar">
          <div className="fl-settings-nav-label">设置分类</div>
          <TabList aria-label="设置分类">
            <Tab id="reader"><BookOpen aria-hidden="true" />朗读与交互</Tab>
            <Tab id="engine"><Radio aria-hidden="true" />语音来源</Tab>
            <Tab id="ai"><Languages aria-hidden="true" />OCR 与翻译</Tab>
            <Tab id="voices"><Library aria-hidden="true" />声音库</Tab>
            <Tab id="roles"><UsersRound aria-hidden="true" />角色配音</Tab>
            <Tab id="appearance"><Palette aria-hidden="true" />阅读外观</Tab>
            <Tab id="shortcuts"><Keyboard aria-hidden="true" />快捷键</Tab>
            <Tab id="advanced"><Settings2 aria-hidden="true" />高级</Tab>
          </TabList>
          <div className="fl-settings-nav-help"><CircleHelp aria-hidden="true" /><span><strong>遇到问题？</strong><small>打开诊断工具并复制报告</small></span></div>
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
                <SettingSwitch title="显示悬浮播放器" description="在普通网页边缘自动显示入口；无需为每个网站重复授权。" isSelected={settings.showFloatingPlayer} onChange={(value) => change('showFloatingPlayer', value)} />
              </SettingsCard>
            </div>
          </TabPanel>

          <TabPanel id="engine">
            <PageHeading eyebrow="语音来源" title="选择声音从哪里生成" description="每一种来源都明确展示连接、隐私和存储状态。" />
            <div className="fl-settings-stack">
            <SettingsCard icon={Radio} title="当前语音来源" description="来源切换立即保存；服务失败不会静默改写默认来源。">
              <ChoiceSelect label="语音来源" value={settings.activeProviderId} options={providerOptions} onChange={(value) => change('activeProviderId', value)} />
              <div className="fl-provider-grid">
                <div className={stateFor('browser-system')?.ready ? 'is-ready' : ''}><MonitorSpeaker aria-hidden="true" /><strong>浏览器系统语音</strong><span>{stateFor('browser-system')?.message || '等待运行时状态'}</span></div>
                <div className={modelState.ready ? 'is-ready' : modelState.state === 'corrupt' ? 'is-error' : ''}><Download aria-hidden="true" /><strong>浏览器下载模型</strong><span>{stateFor('browser-model')?.message || `状态：${modelState.state}`}</span></div>
                <div className={stateFor('local-service')?.ready ? 'is-ready' : ''}><HardDrive aria-hidden="true" /><strong>本地服务</strong><span>{stateFor('local-service')?.message || '尚未配置'}</span></div>
                <div className={stateFor('openai-compatible')?.ready ? 'is-ready' : ''}><Cloud aria-hidden="true" /><strong>在线 TTS</strong><span>{stateFor('openai-compatible')?.message || '尚未配置'}</span></div>
                <div className={stateFor('doubao-tts')?.ready ? 'is-ready' : ''}><Cloud aria-hidden="true" /><strong>豆包原生 TTS</strong><span>{stateFor('doubao-tts')?.message || '尚未配置'}</span></div>
              </div>
              <div className="fl-inline-note"><ShieldCheck aria-hidden="true" /><strong>隐私提示</strong><span>系统语音和本地模型不会上传正文；在线 TTS 仅发送当前待朗读文本。</span></div>
            </SettingsCard>

            <SettingsCard icon={Download} title="浏览器下载模型" description="正式模型固定到完整 commit；下载后必须通过离线合成校验。">
              <div className="fl-settings-form-grid">
                <label><span>模型</span><select value="kokoro-zh" disabled><option value="kokoro-zh">Kokoro v1.1 中英（预设音色）</option></select></label>
                <label><span>运行设备</span><select value={providerDrafts['browser-model'].device} onChange={(event) => updateProvider('browser-model', { device: event.target.value })}><option value="webgpu">WebGPU（失败后回退 WASM）</option><option value="wasm">WASM</option></select></label>
                <label className="is-wide"><span>固定 revision</span><input value={providerDrafts['browser-model'].revision} readOnly /></label>
              </div>
              <div className="fl-inline-note"><Database aria-hidden="true" /><strong>{selectedBrowserModel.sizeLabel} · {selectedBrowserModel.license}</strong><span>{storageLabel(storageAvailable)}；下载后会关闭远程加载并重新合成短句，校验通过才标记为可用。</span></div>
              {modelState.fallbackReason ? <div className="fl-inline-note"><MonitorSpeaker aria-hidden="true" /><strong>当前使用 WASM</strong><span>WebGPU 初始化失败：{modelState.fallbackReason}。首次生成和长文本会明显更慢。</span></div> : null}
              <div className="fl-operation-row"><span>状态：{modelState.state}{modelState.device ? ` · ${modelState.device.toUpperCase()}` : ''}</span><div><Button isDisabled={operationBusy} className="fl-secondary-button" onPress={() => runOperation('模型下载与离线校验', async () => {
                const estimate = await bridge.estimateStorage();
                setStorageAvailable(estimate.available);
                const requiredBytes = selectedBrowserModel.expectedBytes * 1.2;
                if (estimate.available != null && estimate.available < requiredBytes) {
                  throw new Error(`浏览器存储空间不足；该模型至少需要预留 ${storageLabel(requiredBytes).replace(' 可用', '')}。`);
                }
                const granted = await bridge.requestModelOrigins();
                if (!granted) throw new Error('没有获得 Hugging Face 模型下载权限。');
                await persistProvider('browser-model');
                const requestId = `model-download-${Date.now()}-${Math.random().toString(36).slice(2)}`;
                activeModelRequestId.current = requestId;
                try { await bridge.modelAction('download', requestId); }
                finally { activeModelRequestId.current = ''; }
              })}>{modelState.ready ? '重新校验下载' : '下载并校验'}</Button><Button isDisabled={!operationBusy || !operationStatus.startsWith('模型下载')} className="fl-secondary-button" onPress={() => {
                const requestId = activeModelRequestId.current;
                if (!requestId) return;
                void bridge.modelAction('cancel', requestId).then(() => setOperationStatus('已请求取消模型下载。')).catch((error) => setOperationStatus(error instanceof Error ? error.message : String(error)));
              }}>取消下载</Button><Button isDisabled={operationBusy || !modelState.cached} className="fl-secondary-button" onPress={() => runOperation('模型校验', async () => { await persistProvider('browser-model'); await bridge.modelAction('verify'); })}>离线校验</Button><Button isDisabled={operationBusy || (!modelState.cached && !modelState.ready)} className="fl-danger-button" onPress={() => runOperation('删除模型', async () => { await bridge.modelAction('delete'); })}>删除</Button></div></div>
            </SettingsCard>

            <SettingsCard icon={HardDrive} title="本地服务" description="仅允许 localhost、127.0.0.1 或 ::1；能力以真实健康检查结果为准。">
              <div className="fl-settings-form-grid">
                <label><span>适配器</span><select value={providerDrafts['local-service'].adapterId} onChange={(event) => updateProvider('local-service', { adapterId: event.target.value })}><option value="flowloud-qwen">Flowloud Qwen</option><option value="gpt-sovits">GPT-SoVITS</option><option value="cosyvoice">CosyVoice</option><option value="openai-local">OpenAI 本地兼容</option></select></label>
                <label><span>Base URL</span><input value={providerDrafts['local-service'].baseUrl} onChange={(event) => updateProvider('local-service', { baseUrl: event.target.value })} placeholder="http://127.0.0.1:7811" /></label>
                <label><span>模型</span><input value={providerDrafts['local-service'].model} onChange={(event) => updateProvider('local-service', { model: event.target.value })} /></label>
                <label><span>访问令牌</span><input type="password" autoComplete="new-password" value={localToken} onChange={(event) => setLocalToken(event.target.value)} placeholder={secretStatus['local-service']?.present ? '已保存；留空保持不变' : '可选'} /></label>
              </div>
              <SettingSwitch title="跨浏览器会话记住令牌" description="关闭时仅保存在当前浏览器会话；重新输入令牌后生效。" isSelected={providerDrafts['local-service'].rememberToken} onChange={(value) => updateProvider('local-service', { rememberToken: value })} />
              <div className="fl-operation-row"><span>{secretStatus['local-service']?.remembered ? '令牌已持久保存在本机扩展存储；不会进入导出或日志' : secretStatus['local-service']?.present ? '令牌仅在当前会话可用' : '未保存令牌'}</span><div><Button isDisabled={operationBusy} className="fl-primary-button" onPress={() => runOperation('本地服务连接测试', async () => {
                const granted = await bridge.requestLocalOrigin(providerDrafts['local-service'].baseUrl);
                if (!granted) throw new Error('没有获得本地服务访问权限。');
                await persistProvider('local-service');
                const result = await bridge.testLocalService();
                setOperationStatus(`连接成功 · ${String(result.adapterId || providerDrafts['local-service'].adapterId)}`);
              })}>保存并测试</Button><Button className="fl-secondary-button" onPress={() => runOperation('清除本地令牌', async () => { await bridge.saveSecret('local-service', '', false); setSecretStatus(await bridge.secretStatus()); })}>清除令牌</Button></div></div>
            </SettingsCard>

            <SettingsCard icon={Cloud} title="OpenAI 兼容在线 TTS" description="试听会发送下方短句，可能产生少量费用；不会发送当前网页全文。">
              <div className="fl-settings-form-grid">
                <label className="is-wide"><span>Base URL</span><input value={providerDrafts['openai-compatible'].baseUrl} onChange={(event) => updateProvider('openai-compatible', { baseUrl: event.target.value })} placeholder="https://api.example.com" /></label>
                <label><span>模型</span><input value={providerDrafts['openai-compatible'].model} onChange={(event) => updateProvider('openai-compatible', { model: event.target.value })} /></label>
                <label><span>音色</span><input value={providerDrafts['openai-compatible'].voice} onChange={(event) => updateProvider('openai-compatible', { voice: event.target.value })} /></label>
                <label><span>格式</span><select value={providerDrafts['openai-compatible'].responseFormat} onChange={(event) => updateProvider('openai-compatible', { responseFormat: event.target.value })}><option value="mp3">MP3</option><option value="wav">WAV</option><option value="opus">Opus</option><option value="aac">AAC</option></select></label>
                <label><span>API Key</span><input type="password" autoComplete="new-password" value={onlineKey} onChange={(event) => setOnlineKey(event.target.value)} placeholder={secretStatus['openai-compatible']?.present ? '已保存；留空保持不变' : '必填'} /></label>
                <label className="is-wide"><span>试听短句</span><input value={onlinePreview} onChange={(event) => setOnlinePreview(event.target.value)} /></label>
              </div>
              <SettingSwitch title="跨浏览器会话记住 API Key" description="显式开启并重新输入 Key 后才会持久保存；导出设置永远不包含它。" isSelected={providerDrafts['openai-compatible'].rememberKey} onChange={(value) => updateProvider('openai-compatible', { rememberKey: value })} />
              <div className="fl-operation-row"><span>{secretStatus['openai-compatible']?.remembered ? 'API Key 已持久保存' : secretStatus['openai-compatible']?.present ? 'API Key 仅在当前会话可用' : '尚未保存 API Key'}</span><div><Button isDisabled={operationBusy || !onlinePreview.trim()} className="fl-primary-button" onPress={() => runOperation('在线真实试听', async () => {
                const granted = await bridge.requestOnlineOrigin(providerDrafts['openai-compatible'].baseUrl);
                if (!granted) throw new Error('没有获得在线服务精确 Origin 权限。');
                await persistProvider('openai-compatible');
                const response = await bridge.auditionOnline(onlinePreview.trim());
                const audioBase64 = String(response.audioBase64 || '');
                if (!audioBase64) throw new Error('服务没有返回可试听音频。');
                await new Audio(`data:${String(response.mimeType || 'audio/mpeg')};base64,${audioBase64}`).play();
              })}>保存并试听</Button><Button className="fl-secondary-button" onPress={() => runOperation('清除 API Key', async () => { await bridge.saveSecret('openai-compatible', '', false); setSecretStatus(await bridge.secretStatus()); })}>清除 Key</Button></div></div>
            </SettingsCard>

            <SettingsCard icon={Cloud} title="豆包原生 TTS" description="使用豆包语音原生单向流式协议，不会伪装成 OpenAI /audio/speech。">
              <div className="fl-settings-form-grid">
                <label className="is-wide"><span>Base URL</span><input value={providerDrafts['doubao-tts'].baseUrl} onChange={(event) => updateProvider('doubao-tts', { baseUrl: event.target.value })} /></label>
                <label><span>App ID</span><input value={providerDrafts['doubao-tts'].appId} onChange={(event) => updateProvider('doubao-tts', { appId: event.target.value })} /></label>
                <label><span>Resource ID</span><input value={providerDrafts['doubao-tts'].resourceId} onChange={(event) => updateProvider('doubao-tts', { resourceId: event.target.value })} /></label>
                <label><span>音色 ID</span><input value={providerDrafts['doubao-tts'].voice} onChange={(event) => updateProvider('doubao-tts', { voice: event.target.value })} /></label>
                <label><span>API Key</span><input type="password" autoComplete="new-password" value={doubaoKey} onChange={(event) => setDoubaoKey(event.target.value)} placeholder={secretStatus['doubao-tts']?.present ? '已保存；留空保持不变' : '必填'} /></label>
              </div>
              <SettingSwitch title="跨浏览器会话记住 API Key" description="关闭时仅保存在当前浏览器会话。" isSelected={providerDrafts['doubao-tts'].rememberKey} onChange={(value) => updateProvider('doubao-tts', { rememberKey: value })} />
              <div className="fl-operation-row"><span>{secretStatus['doubao-tts']?.remembered ? 'API Key 已持久保存' : secretStatus['doubao-tts']?.present ? 'API Key 仅在当前会话可用' : '尚未保存 API Key'}</span><div><Button isDisabled={operationBusy || !onlinePreview.trim()} className="fl-primary-button" onPress={() => runOperation('豆包原生协议试听', async () => {
                const granted = await bridge.requestOnlineOrigin(providerDrafts['doubao-tts'].baseUrl);
                if (!granted) throw new Error('没有获得豆包服务精确 Origin 权限。');
                await persistProvider('doubao-tts');
                const response = await bridge.auditionDoubao(onlinePreview.trim());
                const audioBase64 = String(response.audioBase64 || '');
                if (!audioBase64) throw new Error('豆包服务没有返回可试听音频。');
                await new Audio(`data:${String(response.mimeType || 'audio/mpeg')};base64,${audioBase64}`).play();
              })}>保存并试听</Button><Button className="fl-secondary-button" onPress={() => runOperation('清除豆包 Key', async () => { await bridge.saveSecret('doubao-tts', '', false); setSecretStatus(await bridge.secretStatus()); })}>清除 Key</Button></div></div>
            </SettingsCard>
            </div>
          </TabPanel>

          <TabPanel id="ai">
            <PageHeading eyebrow="OCR 与翻译" title="分别连接视觉与翻译模型" description="支持 OpenAI Chat/Responses、Ollama 和 Flowloud 本地文档协议；凭据不会进入设置导出。" aside={<Button className="fl-primary-button" onPress={() => bridge.openDocumentWorkbench(null)}><Languages aria-hidden="true" />打开工作台</Button>} />
            <AiProfilesSettings />
          </TabPanel>

          <TabPanel id="voices">
            <PageHeading eyebrow="声音库" title="寻找、试听和管理声音" description="声音列表来自当前 Provider；导入和克隆仅在服务声明支持时出现。" aside={<Button className="fl-primary-button" onPress={() => runOperation('打开声音工作室', async () => { await bridge.openVoiceStudio(); })}><Upload aria-hidden="true" />打开声音工作室</Button>} />
            <SettingsCard icon={Library} title="声音管理" description="复杂的试听、导入、重命名与删除在独立工作室中完成，避免在设置瞬时小窗中误操作。">
              <div className="fl-provider-grid">
                {providerStates.map((provider) => <div className={provider.ready ? 'is-ready' : provider.status === 'error' ? 'is-error' : ''} key={provider.providerId}><Volume2 aria-hidden="true" /><strong>{providerOptions.find(([id]) => id === provider.providerId)?.[1] || provider.providerId}</strong><span>{provider.message}</span></div>)}
              </div>
              <Button className="fl-primary-button" onPress={() => runOperation('打开声音工作室', async () => { await bridge.openVoiceStudio(); })}><Library aria-hidden="true" />管理、试听与导入声音</Button>
            </SettingsCard>
          </TabPanel>

          <TabPanel id="roles">
            <PageHeading eyebrow="角色配音" title="先定算法，再处理特殊角色" description="大多数论坛页面无需逐个作者指定；楼主始终可以单独设置。" />
            <div className="fl-settings-stack">
              <SettingsCard icon={UsersRound} title="默认配音算法" description="作者与声音的映射会在同一主题中保持稳定。">
                <ChoiceSelect label="配音策略" value={settings.preset} options={strategyOptions} onChange={(value) => change('preset', value as PopupSettings['preset'])} />
                <div className="fl-strategy-explainer"><Sparkles aria-hidden="true" /><span><strong>{selectedStrategyGuidance.title}</strong><small>{selectedStrategyGuidance.description}</small></span></div>
              </SettingsCard>
              <SettingsCard icon={Crown} title="楼主与例外角色" description="当前页面的常用角色分配直接在 Popup 完成；这里仅保留声音库管理。">
                <ActionRow icon={Crown} title="楼主声音" description="在声音工作室中修改当前 Provider 的默认楼主声音" action="更换" onPress={() => { void bridge.openVoiceStudio(); }} />
                <ActionRow icon={UsersRound} title="回复作者声音池" description="维护用于稳定随机或顺序轮换的声音池" action="管理" onPress={() => { void bridge.openVoiceStudio(); }} />
                <ActionRow icon={Mic2} title="逐角色指定" description="在 Popup 的“配音”页直接选择本页每位作者的声音" action="已内置" onPress={() => { setOperationStatus('打开正在朗读页面的 Popup，在“配音”页即可直接调整，无需跳转。'); }} />
              </SettingsCard>
            </div>
          </TabPanel>

          <TabPanel id="appearance">
            <PageHeading eyebrow="阅读外观" title="突出进度，不遮住正文" description="句子聚焦与逐词反馈分为两层；右侧预览会即时更新。" />
            <div className="fl-appearance-layout">
              <div className="fl-settings-stack">
                <SettingsCard icon={Palette} title="主题与高亮" description="使用中性蓝白作为默认外观。">
                  <ChoiceSelect label="主题" value="light" options={themeOptions} onChange={(value) => queueSave(settings, { theme: value })} />
                  <SettingSwitch title="当前句聚焦" description="使用很浅的蓝色衬底和左侧定位线。" isSelected={followSentence} onChange={(value) => changeBoolean(setFollowSentence, value, { readingFocus: value ? 'sentence' : 'off' })} />
                  <SettingSwitch title="逐词轻扫" description="当前词使用蓝字与细底线；暂停时停在当前位置。" isSelected={wordSweep} onChange={(value) => changeBoolean(setWordSweep, value, { wordHighlightEnabled: value })} />
                  <SettingSwitch title="增强对比度" description="适合低对比度网页；不会改变原网页排版。" isSelected={highContrast} onChange={(value) => changeBoolean(setHighContrast, value, { highContrast: value })} />
                </SettingsCard>
              </div>
              <aside className={`fl-reading-preview ${highContrast ? 'is-strong' : ''}`} aria-label="阅读高亮实时预览">
                <span>实时预览</span><h2>如何让朗读真正融入阅读？</h2>
                <p>真正自然的网页朗读，不该把阅读从页面里夺走。</p>
                <p className={followSentence ? 'is-current' : ''}>它应该让你始终知道自己听到了哪里，<mark className={wordSweep ? 'is-active' : ''}>当前词</mark>又推进到了什么位置。</p>
                <p>当句子离开视口时，再出现一个克制的定位入口。</p>
              </aside>
            </div>
          </TabPanel>

          <TabPanel id="shortcuts">
            <PageHeading eyebrow="快捷键" title="不用离开正文也能控制朗读" description="快捷键由浏览器统一管理，扩展不会伪造或覆盖已被占用的组合键。" />
            <SettingsCard icon={Keyboard} title="全局播放控制" description="快捷键优先暂停或继续当前全局会话；没有活动会话时朗读当前页。">
              <div className="fl-shortcut-row"><span>播放 / 暂停全局朗读</span><kbd>Alt + O</kbd></div>
              <Button className="fl-primary-button" onPress={() => runOperation('打开浏览器快捷键管理', async () => { await bridge.openShortcuts(); })}><Keyboard aria-hidden="true" />在浏览器中修改快捷键</Button>
            </SettingsCard>
          </TabPanel>

          <TabPanel id="advanced">
            <PageHeading eyebrow="高级" title="存储、诊断与数据管理" description="这些操作不会出现在日常朗读流程里。" />
            <div className="fl-settings-stack">
              <SettingsCard icon={Database} title="本地数据" description="模型、语音与网页配音均保存在本机。">
                <ActionRow icon={HardDrive} title="模型与缓存" description={`状态：${modelState.state}${modelState.device ? ` · ${modelState.device}` : ''}`} action="转到语音来源" onPress={() => setSelectedSection('engine')} />
                <ActionRow icon={Download} title="导出设置" description="导出文件不会包含 API Key、本地令牌或自定义请求头" action="导出" onPress={exportSettings} />
                <ActionRow icon={Upload} title="导入设置" description="导入后由 Schema v6 校验和迁移，不接受凭据字段" action="导入" onPress={() => importInput.current?.click()} />
                <input ref={importInput} hidden type="file" accept="application/json,.json" onChange={(event) => { const file = event.target.files?.[0]; if (file) void runOperation('导入设置', async () => { await importSettings(file); }); event.currentTarget.value = ''; }} />
              </SettingsCard>
              <SettingsCard icon={Settings2} title="诊断与恢复" description="仅在故障排查时使用。">
                <ActionRow icon={AudioLines} title="下载朗读诊断" description="包含脱敏设置、全局会话和音频状态，不包含正文与凭据" action="下载" onPress={() => { void runOperation('生成诊断报告', async () => { downloadJson(`flowloud-diagnostics-${Date.now()}.json`, await bridge.diagnostics()); }); }} />
                <ActionRow icon={RotateCcw} title="恢复默认设置" description="不会删除已下载模型和声音；会恢复交互与 Provider 偏好" action="重置" onPress={() => { if (window.confirm('确定恢复默认设置吗？已下载模型和声音不会删除。')) void runOperation('恢复默认设置', async () => { await bridge.resetSettings(); window.location.reload(); }); }} />
              </SettingsCard>
            </div>
          </TabPanel>
        </div>
      </Tabs>
      {operationStatus ? <div className="fl-operation-status" role="status" aria-live="polite">{operationStatus}</div> : null}
    </main>
  );
}
