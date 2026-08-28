import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from 'react-aria-components';
import {
  AudioLines,
  Check,
  ChevronDown,
  CircleAlert,
  Cloud,
  Download,
  ExternalLink,
  Globe2,
  HardDrive,
  Library,
  Play,
  RefreshCcw,
  Search,
  Settings2,
  Sparkles,
  Star,
  UsersRound,
} from 'lucide-react';
import type { ProviderState, VoiceCatalogEntry } from './model';
import { providerLabel, providerRegistry, type ProviderId } from './provider-registry';
import { createRuntimeBridge } from './runtime-bridge';

type Assignment = { narratorVoiceId: string; replyVoiceIds: string[]; authorVoices: Record<string, string> };
type RawSettings = Record<string, unknown> & {
  activeProviderId?: string;
  providerSettings?: Record<string, Record<string, unknown>>;
  voiceAssignmentsByProvider?: Record<string, Assignment>;
};

const providerIds = providerRegistry.map((provider) => provider.id);
const previewText = '你好，这是 Flowloud 的音色试听。';

const emptySettings: RawSettings = {
  activeProviderId: 'browser-system',
  providerSettings: {},
  voiceAssignmentsByProvider: {},
};

function connectionLabel(state?: ProviderState) {
  if (!state) return '正在读取';
  return {
    connected: '已连接', connecting: '连接中', failed: '连接失败',
    unconfigured: '未配置', unavailable: '待验证',
  }[state.connectionState];
}

function voiceId(value: string) {
  return value.replace(/^[^:]+:/u, '');
}

function voiceInitial(label: string) {
  return /^[A-Za-z]/u.test(label) ? label.slice(0, 2).toUpperCase() : label.slice(0, 1);
}

function catalogEntry(providerId: ProviderId, raw: { id: string; label: string; lang?: string; language?: string; gender?: string; characteristic?: string; description?: string; style?: string; cached?: boolean | null }, status?: ProviderState): VoiceCatalogEntry {
  const configured = status?.configured !== false && status?.connectionState !== 'unconfigured';
  const availability = !configured && ['openai-compatible', 'doubao-tts'].includes(providerId)
    ? 'configuration-required' : providerId === 'browser-model' && raw.cached !== true
      ? 'download-required' : status?.connectionState === 'failed'
        ? 'unavailable' : 'available';
  const lang = raw.language || raw.lang || '';
  return {
    ...raw,
    providerId,
    languageLabel: lang || '未标注',
    characteristic: raw.characteristic || raw.style || raw.description || raw.gender || (providerId === 'local-service' ? '本地音色' : providerId === 'browser-model' ? '离线模型' : '标准音色'),
    availability,
  };
}

export function VoiceWorkbench({ initialProviderId = '' }: { initialProviderId?: string }) {
  const [bridge] = useState(() => createRuntimeBridge());
  const [settings, setSettings] = useState<RawSettings>(emptySettings);
  const [statuses, setStatuses] = useState<ProviderState[]>([]);
  const [catalog, setCatalog] = useState<VoiceCatalogEntry[]>([]);
  const [selectedProvider, setSelectedProvider] = useState<ProviderId>(providerIds.includes(initialProviderId as ProviderId) ? initialProviderId as ProviderId : 'browser-system');
  const [providerFilter, setProviderFilter] = useState<ProviderId | 'all'>('all');
  const [languageFilter, setLanguageFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [panelOpen, setPanelOpen] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, Record<string, unknown>>>({});
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [secretStatus, setSecretStatus] = useState<Record<string, { present?: boolean; remembered?: boolean }>>({});
  const catalogRequest = useRef(0);

  const load = async () => {
    if (!bridge.available) {
      setSettings(emptySettings);
      setStatuses([]);
      setCatalog([]);
      setDrafts({});
      setNotice('扩展运行时不可用，无法读取真实设置。');
      return;
    }
    const requestId = ++catalogRequest.current;
    const settingsResponse = await bridge.send({ type: 'settings:get' });
    const raw = settingsResponse.settings as RawSettings || {};
    const [stateResult, storedSecrets] = await Promise.all([bridge.providerStates(raw), bridge.secretStatus()]);
    if (requestId !== catalogRequest.current) return;
    setSettings(raw);
    setDrafts(raw.providerSettings || {});
    setStatuses(stateResult.providers);
    setSecretStatus(storedSecrets);
    // Render the real settings and Provider states immediately. Each catalog
    // is fetched independently so a stopped local service or a slow model
    // cache cannot hold every other Provider's real voices behind a spinner.
    setCatalog([]);
    const active = String(raw.activeProviderId || 'browser-system') as ProviderId;
    if (!initialProviderId && providerIds.includes(active)) setSelectedProvider(active);
    await Promise.all(providerIds.map(async (providerId) => {
      try {
        const voices = await bridge.voices(providerId);
        if (requestId !== catalogRequest.current) return;
        const status = stateResult.providers.find((item) => item.providerId === providerId);
        const configuredRemote = !['openai-compatible', 'doubao-tts'].includes(providerId)
          || status?.configured === true;
        if (!configuredRemote) return;
        const entries = voices.map((voice) => catalogEntry(providerId, voice, status));
        setCatalog((current) => [...current.filter((entry) => entry.providerId !== providerId), ...entries]);
      } catch (_) {
        // A provider with no reachable catalog contributes no rows. Its
        // persisted status remains visible in the Provider panel and can be
        // retried there; no placeholder voice is fabricated.
      }
    }));
  };

  useEffect(() => { void load().catch((error) => setNotice(error instanceof Error ? error.message : String(error))); }, []);

  const selectedStatus = statuses.find((status) => status.providerId === selectedProvider);
  const selectedConfig = drafts[selectedProvider] || {};
  const assignments = settings.voiceAssignmentsByProvider || {};
  const selectedAssignment = assignments[selectedProvider] || { narratorVoiceId: '', replyVoiceIds: [], authorVoices: {} };
  const currentVoice = catalog.find((entry) => entry.id === selectedAssignment.narratorVoiceId);

  const languages = useMemo(() => [...new Set(catalog.map((voice) => voice.languageLabel).filter(Boolean))], [catalog]);
  const visibleVoices = useMemo(() => catalog.filter((voice) => {
    const query = search.trim().toLowerCase();
    return (providerFilter === 'all' || voice.providerId === providerFilter)
      && (languageFilter === 'all' || voice.languageLabel === languageFilter)
      && (!query || `${voice.label} ${voice.id} ${voice.languageLabel} ${providerLabel(voice.providerId)}`.toLowerCase().includes(query));
  }), [catalog, languageFilter, providerFilter, search]);

  const updateDraft = (patch: Record<string, unknown>) => setDrafts((current) => ({
    ...current,
    [selectedProvider]: { ...(current[selectedProvider] || {}), ...patch },
  }));

  const saveProvider = async () => {
    const providerSettings = { ...(settings.providerSettings || {}), [selectedProvider]: { ...selectedConfig, configured: true, lastConfiguredAt: new Date().toISOString() } };
    const merged: RawSettings = { ...settings, providerSettings };
    if (!bridge.available) throw new Error('扩展运行时不可用，无法保存 Provider 设置。');
    if (selectedProvider === 'local-service') await bridge.requestLocalOrigin(String(selectedConfig.baseUrl || 'http://127.0.0.1:7811'));
    if (selectedProvider === 'openai-compatible' || selectedProvider === 'doubao-tts') await bridge.requestOnlineOrigin(String(selectedConfig.baseUrl || ''));
    const response = await bridge.saveSettings(merged);
    const next = response.settings as RawSettings || merged;
    if (['local-service', 'openai-compatible', 'doubao-tts'].includes(selectedProvider) && secrets[selectedProvider]) {
      const remember = selectedConfig.rememberToken === true || selectedConfig.rememberKey === true;
      await bridge.saveSecret(selectedProvider as 'local-service' | 'openai-compatible' | 'doubao-tts', secrets[selectedProvider], remember);
      setSecrets((current) => ({ ...current, [selectedProvider]: '' }));
      setSecretStatus(await bridge.secretStatus());
    }
    setSettings(next);
    return next;
  };

  const run = async (label: string, operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(label); setNotice(`${label}…`);
    try { await operation(); setNotice(`${label}完成。`); }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(''); }
  };

  const validate = () => run('配置并验证', async () => {
    await saveProvider();
    if (selectedProvider === 'browser-model') {
      await bridge.modelAction('verify');
      await load();
      return;
    }
    const response = await bridge.testProvider(selectedProvider, currentVoice?.id || '', previewText);
    const audioBase64 = String(response.audioBase64 || '');
    if (audioBase64) await new Audio(`data:${String(response.mimeType || 'audio/mpeg')};base64,${audioBase64}`).play();
    await load();
  });

  const selectVoice = (voice: VoiceCatalogEntry) => run(`选用 ${voice.label}`, async () => {
    if (voice.availability !== 'available') throw new Error('这个音色尚不可用，请先完成当前主操作。');
    setSelectedProvider(voice.providerId as ProviderId);
    if (!bridge.available) throw new Error('扩展运行时不可用，无法保存音色。');
    const response = await bridge.assignVoices(voice.providerId, { narratorVoiceId: voice.id });
    setSettings(response.settings as RawSettings || settings);
  });

  const audition = (voice: VoiceCatalogEntry) => run(`试听 ${voice.label}`, async () => {
    if (!bridge.available) throw new Error('扩展运行时不可用，无法试听真实音色。');
    const response = await bridge.auditionVoice(voice.providerId, voice.id, previewText);
    const audioBase64 = String(response.audioBase64 || '');
    if (audioBase64) await new Audio(`data:${String(response.mimeType || 'audio/mpeg')};base64,${audioBase64}`).play();
  });

  const downloadVoice = (voice: VoiceCatalogEntry) => run(`下载 ${voice.label}`, async () => {
    await bridge.modelAction('voice-download', `voice-download-${voiceId(voice.id)}-${Date.now()}`, { voiceId: voiceId(voice.id) });
    await load();
  });

  const setReplyVoice = (value: string) => run('更新人物对白音色', async () => {
    const replyVoiceIds = value ? [value] : [];
    if (!bridge.available) throw new Error('扩展运行时不可用，无法保存人物对白音色。');
    const response = await bridge.assignVoices(selectedProvider, { replyVoiceIds });
    setSettings(response.settings as RawSettings || settings);
  });

  const renderConfig = () => {
    if (selectedProvider === 'browser-system') return <div className="fl-provider-summary"><Globe2 aria-hidden="true" /><div><strong>无需配置</strong><span>音色由浏览器和操作系统提供，刷新音色即可同步系统变化。</span></div></div>;
    if (selectedProvider === 'browser-model') return <>
      <label><span>模型来源</span><select value={String(selectedConfig.source || 'modelscope')} onChange={(event) => updateDraft({ source: event.target.value })}><option value="modelscope">魔搭社区</option><option value="huggingface">Hugging Face</option></select></label>
      <label><span>运行设备</span><select value={String(selectedConfig.device || 'wasm')} onChange={(event) => updateDraft({ device: event.target.value })}><option value="wasm">WASM（推荐）</option><option value="webgpu">WebGPU（实验）</option></select></label>
      <Button className="fl-secondary-button" isDisabled={Boolean(busy)} onPress={() => run('下载并校验模型', async () => { await saveProvider(); await bridge.requestModelOrigins(String(selectedConfig.source || 'modelscope')); await bridge.modelAction('download'); await load(); })}><Download aria-hidden="true" />下载并校验模型</Button>
    </>;
    if (selectedProvider === 'local-service') return <>
      <label><span>Base URL</span><input value={String(selectedConfig.baseUrl || '')} onChange={(event) => updateDraft({ baseUrl: event.target.value })} /></label>
      <label><span>模型</span><input value={String(selectedConfig.model || '')} onChange={(event) => updateDraft({ model: event.target.value })} /></label>
      <label><span>访问令牌</span><input type="password" autoComplete="new-password" value={secrets[selectedProvider] || ''} onChange={(event) => setSecrets((current) => ({ ...current, [selectedProvider]: event.target.value }))} placeholder={secretStatus[selectedProvider]?.present ? '已保存；留空保持' : '可选'} /></label>
      <Button className="fl-text-button" onPress={() => bridge.openVoiceStudio(selectedProvider)}>打开声音工作室<ExternalLink aria-hidden="true" /></Button>
    </>;
    if (selectedProvider === 'openai-compatible') return <>
      <label><span>Base URL</span><input value={String(selectedConfig.baseUrl || '')} onChange={(event) => updateDraft({ baseUrl: event.target.value })} placeholder="https://api.example.com" /></label>
      <label><span>模型</span><input value={String(selectedConfig.model || '')} onChange={(event) => updateDraft({ model: event.target.value })} /></label>
      <label><span>音色 ID（逗号分隔）</span><input value={(Array.isArray(selectedConfig.voiceIds) ? selectedConfig.voiceIds : ['alloy']).join(', ')} onChange={(event) => updateDraft({ voiceIds: event.target.value.split(',').map((value) => value.trim()).filter(Boolean) })} /></label>
      <label><span>API Key</span><input type="password" autoComplete="new-password" value={secrets[selectedProvider] || ''} onChange={(event) => setSecrets((current) => ({ ...current, [selectedProvider]: event.target.value }))} placeholder={secretStatus[selectedProvider]?.present ? '已保存；留空保持' : '必填'} /></label>
    </>;
    return <>
      <label><span>App ID</span><input value={String(selectedConfig.appId || '')} onChange={(event) => updateDraft({ appId: event.target.value })} /></label>
      <label><span>Resource ID</span><input value={String(selectedConfig.resourceId || '')} onChange={(event) => updateDraft({ resourceId: event.target.value })} /></label>
      <label><span>音色 ID（逗号分隔）</span><input value={(Array.isArray(selectedConfig.voiceIds) ? selectedConfig.voiceIds : []).join(', ')} onChange={(event) => updateDraft({ voiceIds: event.target.value.split(',').map((value) => value.trim()).filter(Boolean) })} /></label>
      <label><span>API Key</span><input type="password" autoComplete="new-password" value={secrets[selectedProvider] || ''} onChange={(event) => setSecrets((current) => ({ ...current, [selectedProvider]: event.target.value }))} placeholder={secretStatus[selectedProvider]?.present ? '已保存；留空保持' : '必填'} /></label>
    </>;
  };

  return <div className="fl-voice-workbench">
    <header className="fl-voice-heading">
      <div><h1>语音与音色</h1><p>找到喜欢的声音，试听后直接用于朗读</p></div>
      <Button className="fl-text-button" onPress={() => bridge.openVoiceStudio(selectedProvider)}><AudioLines aria-hidden="true" />打开声音工作室<ExternalLink aria-hidden="true" /></Button>
    </header>

    <div className="fl-voice-layout">
      <section className="fl-voice-main" aria-label="统一音色库">
        <div className="fl-voice-searchbar">
          <label><Search aria-hidden="true" /><span className="sr-only">搜索音色</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索音色、语言或来源" /></label>
          <label className="fl-language-filter"><Globe2 aria-hidden="true" /><span className="sr-only">语言筛选</span><select value={languageFilter} onChange={(event) => setLanguageFilter(event.target.value)}><option value="all">全部语言</option>{languages.map((language) => <option key={language} value={language}>{language}</option>)}</select><ChevronDown aria-hidden="true" /></label>
        </div>

        <div className="fl-provider-filters" aria-label="按语音来源筛选">
          <Button className={providerFilter === 'all' ? 'is-selected' : ''} onPress={() => setProviderFilter('all')}>全部</Button>
          {providerRegistry.map((provider) => {
            const state = statuses.find((item) => item.providerId === provider.id);
            return <Button key={provider.id} className={providerFilter === provider.id ? 'is-selected' : ''} onPress={() => { setProviderFilter(provider.id); setSelectedProvider(provider.id); }}>{provider.summary}{provider.id === 'browser-model' ? ` · ${state?.voiceCount || 0}` : ''}{state?.connectionState === 'unconfigured' ? <em>未配置</em> : null}</Button>;
          })}
        </div>

        <div className="fl-voice-table" role="table" aria-label="音色列表">
          <div className="fl-voice-table-head" role="row"><span>音色</span><span>特点</span><span>来源</span><span>操作</span></div>
          {visibleVoices.map((voice) => {
            const selected = voice.id === selectedAssignment.narratorVoiceId;
            return <div className={`fl-voice-row ${selected ? 'is-current' : ''}`} role="row" key={voice.id}>
              <div className="fl-voice-name"><span className="fl-voice-avatar">{voiceInitial(voice.label)}</span><span className="fl-voice-radio" aria-hidden="true">{selected ? <Check /> : null}</span><div><strong>{voice.label}</strong><small>{voice.languageLabel}</small></div></div>
              <div><span>{voice.characteristic || '—'}</span>{selected ? <small className="fl-current-tag">当前音色</small> : null}</div>
              <div><span className={`fl-provider-tag is-${voice.providerId}`}>{providerLabel(voice.providerId)}</span></div>
              <div className="fl-voice-actions">
                {voice.availability === 'available' ? <><Button aria-label={`试听 ${voice.label}`} className="fl-icon-button" isDisabled={Boolean(busy)} onPress={() => audition(voice)}><Play aria-hidden="true" /></Button><Button className={selected ? 'fl-secondary-button' : 'fl-primary-button'} isDisabled={Boolean(busy) || selected} onPress={() => selectVoice(voice)}>{selected ? '已选用' : '选用'}</Button></> : null}
                {voice.availability === 'download-required' ? <Button className="fl-primary-button" isDisabled={Boolean(busy)} onPress={() => downloadVoice(voice)}><Download aria-hidden="true" />下载</Button> : null}
                {voice.availability === 'configuration-required' ? <Button className="fl-secondary-button" onPress={() => setSelectedProvider(voice.providerId as ProviderId)}>配置</Button> : null}
                {voice.availability === 'unavailable' ? <Button className="fl-secondary-button" isDisabled>不可用</Button> : null}
              </div>
            </div>;
          })}
          {!visibleVoices.length ? <div className="fl-voice-empty"><Search aria-hidden="true" /><strong>没有匹配的音色</strong><span>清除筛选或切换语音来源。</span></div> : null}
          <footer><CircleAlert aria-hidden="true" />下载的音色可立即使用；未下载的模型音色需要先完成下载。</footer>
        </div>

        <section className="fl-assignment-bar" aria-label="音色分配">
          <label><Star aria-hidden="true" /><span><small>默认旁白</small><strong>{currentVoice?.label || '未选择'}</strong></span><select value={selectedAssignment.narratorVoiceId || ''} onChange={(event) => { const voice = catalog.find((item) => item.id === event.target.value); if (voice) void selectVoice(voice); }}>{catalog.filter((voice) => voice.providerId === selectedProvider && voice.availability === 'available').map((voice) => <option key={voice.id} value={voice.id}>{voice.label}</option>)}</select></label>
          <label><UsersRound aria-hidden="true" /><span><small>人物对白</small><strong>{catalog.find((voice) => voice.id === selectedAssignment.replyVoiceIds?.[0])?.label || '跟随旁白'}</strong></span><select value={selectedAssignment.replyVoiceIds?.[0] || ''} onChange={(event) => void setReplyVoice(event.target.value)}><option value="">跟随旁白</option>{catalog.filter((voice) => voice.providerId === selectedProvider && voice.availability === 'available').map((voice) => <option key={voice.id} value={voice.id}>{voice.label}</option>)}</select></label>
          <div><Globe2 aria-hidden="true" /><span><small>网页临时音色</small><strong>跟随默认</strong></span><em>在 Popup 调整</em></div>
        </section>
      </section>

      <aside className={`fl-provider-panel ${panelOpen ? 'is-open' : ''}`} aria-label={`${providerLabel(selectedProvider)}配置`}>
        <Button className="fl-provider-panel-toggle" onPress={() => setPanelOpen((value) => !value)}><div><strong>{providerLabel(selectedProvider)}</strong><span className={`fl-connection-pill is-${selectedStatus?.connectionState || 'connecting'}`}>{connectionLabel(selectedStatus)}</span></div><ChevronDown aria-hidden="true" /></Button>
        <div className="fl-provider-panel-body">
        {currentVoice ? <div className="fl-provider-current-block"><div className="fl-provider-current"><span className="fl-voice-avatar">{voiceInitial(currentVoice.label)}</span><div><strong>{currentVoice.label}</strong><span>{currentVoice.languageLabel} · {currentVoice.characteristic}</span></div></div><div className="fl-provider-current-actions"><Button className="fl-secondary-button" onPress={() => audition(currentVoice)}><Play aria-hidden="true" />试听</Button><Button className="fl-primary-button" isDisabled={currentVoice.id === selectedAssignment.narratorVoiceId} onPress={() => selectVoice(currentVoice)}><Star aria-hidden="true" />{currentVoice.id === selectedAssignment.narratorVoiceId ? '当前默认' : '设为默认'}</Button></div></div> : null}
        <div className="fl-provider-form">{renderConfig()}</div>
        <div className={`fl-validation-summary is-${selectedStatus?.connectionState || 'connecting'}`}>
          {selectedStatus?.connectionState === 'connected' ? <Check aria-hidden="true" /> : selectedStatus?.connectionState === 'failed' ? <CircleAlert aria-hidden="true" /> : <RefreshCcw aria-hidden="true" />}
          <span><strong>{selectedStatus?.message || '正在读取状态'}</strong><small>{selectedStatus?.verifiedAt ? `验证于 ${new Date(selectedStatus.verifiedAt).toLocaleString()}` : '配置或凭据变化后需要重新验证'}</small></span>
        </div>
        <div className="fl-provider-buttons"><Button className="fl-secondary-button" isDisabled={Boolean(busy)} onPress={() => void validate()}><RefreshCcw aria-hidden="true" />{selectedStatus?.connectionState === 'failed' ? '重新验证' : '配置并验证'}</Button><Button className="fl-secondary-button" isDisabled={Boolean(busy)} onPress={() => void load()}><Library aria-hidden="true" />刷新音色</Button></div>
        <details className="fl-advanced-disclosure"><summary><Settings2 aria-hidden="true" />高级参数<ChevronDown aria-hidden="true" /></summary><p>高级参数默认折叠。请求格式、设备回退与缓存修复仅在排障时调整。</p></details>
        {selectedStatus?.connectionState === 'failed' ? <Button className="fl-provider-help"><CircleAlert aria-hidden="true" /><span><strong>验证失败时</strong><small>检查失败阶段、地址、服务状态和令牌</small></span><ChevronDown aria-hidden="true" /></Button> : null}
        </div>
      </aside>
    </div>
    {notice ? <div className="fl-operation-status" role="status" aria-live="polite">{busy ? <RefreshCcw className="is-spinning" aria-hidden="true" /> : <Sparkles aria-hidden="true" />}{notice}</div> : null}
  </div>;
}
