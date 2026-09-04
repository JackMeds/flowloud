import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from 'react-aria-components';
import { AudioLines, ChevronDown, RefreshCcw, Sparkles } from 'lucide-react';
import type { ModelDownloadState, ProviderState, VoiceCatalogEntry } from './model';
import { providerRegistry, type ProviderId } from './provider-registry';
import { createRuntimeBridge } from './runtime-bridge';
import { VoiceCatalog } from './VoiceCatalog';
import { VoiceProviderSetup } from './VoiceProviderSetup';
import { VoiceSourceCards } from './VoiceSourceCards';
import { VoiceStrategyPanel } from './VoiceStrategyPanel';
import {
  bytesLabel,
  emptyVoiceSettings,
  localeFamily,
  localeLabel,
  missingVoiceBytes,
  modelVoiceIds,
  namespacedVoiceId,
  preferredLocale,
  providerIds,
  rawVoiceId,
  voiceKey,
  type VoiceAssignment,
  type VoiceOverride,
  type VoicePreset,
  type VoiceSettings,
} from './voice-workbench-model';

const previewText = '你好，这是 Flowloud 的音色试听。';
const pageSize = 24;

function catalogEntry(
  providerId: ProviderId,
  raw: Record<string, unknown>,
  status: ProviderState | undefined,
  override: VoiceOverride | undefined,
): VoiceCatalogEntry {
  const configured = status?.configured !== false && status?.connectionState !== 'unconfigured';
  const id = String(raw.id || raw.voiceId || '');
  const rawId = rawVoiceId(String(raw.rawId || raw.voiceId || id));
  const locale = String(raw.locale || raw.language || raw.lang || '');
  const availability = !configured && ['openai-compatible', 'doubao-tts'].includes(providerId)
    ? 'configuration-required'
    : providerId === 'browser-model' && raw.cached !== true
      ? 'download-required'
      : status?.connectionState === 'failed'
        ? 'unavailable'
        : 'available';
  const rawLabel = String(raw.rawLabel || raw.label || raw.name || rawId);
  const displayLabel = String(override?.alias || raw.displayLabel || raw.label || raw.name || rawId);
  const gender = String(raw.gender || '');
  return {
    ...(raw as unknown as VoiceCatalogEntry),
    id: id || namespacedVoiceId(providerId, rawId),
    rawId,
    alias: String(override?.alias || ''),
    label: displayLabel,
    displayLabel,
    rawLabel,
    providerId,
    locale,
    language: locale,
    lang: locale,
    languageLabel: String(raw.languageLabel || localeLabel(locale)),
    vendor: String(raw.vendor || ''),
    note: String(override?.note || raw.note || ''),
    metadataSource: String(raw.metadataSource || 'runtime'),
    isDefault: raw.isDefault === true || raw.default === true,
    characteristic: String(raw.characteristic || raw.style || (gender === 'female' ? '女声' : gender === 'male' ? '男声' : '未标注')),
    availability,
  };
}

function emptyAssignment(): VoiceAssignment {
  return { narratorVoiceId: '', replyVoiceIds: [], authorVoices: {} };
}

function playResponseAudio(response: Record<string, unknown>) {
  const audioBase64 = String(response.audioBase64 || '');
  if (!audioBase64) return Promise.resolve();
  return new Audio(`data:${String(response.mimeType || 'audio/mpeg')};base64,${audioBase64}`).play();
}

export function VoiceWorkbench({ initialProviderId = '', initialStudioOpen = false }: { initialProviderId?: string; initialStudioOpen?: boolean }) {
  const [bridge] = useState(() => createRuntimeBridge());
  const [settings, setSettings] = useState<VoiceSettings>(emptyVoiceSettings);
  const [statuses, setStatuses] = useState<ProviderState[]>([]);
  const [modelState, setModelState] = useState<ModelDownloadState>();
  const [catalog, setCatalog] = useState<VoiceCatalogEntry[]>([]);
  const [selectedProvider, setSelectedProvider] = useState<ProviderId>(
    providerIds.includes(initialProviderId as ProviderId) ? initialProviderId as ProviderId : 'browser-system',
  );
  const [languageFilter, setLanguageFilter] = useState('auto');
  const [downloadFilter, setDownloadFilter] = useState<'all' | 'downloaded' | 'missing'>('all');
  const [genderFilter, setGenderFilter] = useState<'all' | 'female' | 'male' | 'unknown'>('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [selectedVoice, setSelectedVoice] = useState<VoiceCatalogEntry | null>(null);
  const [downloadQueue, setDownloadQueue] = useState<Set<string>>(new Set());
  const [aliasDraft, setAliasDraft] = useState('');
  const [noteDraft, setNoteDraft] = useState('');
  const [studioOpen, setStudioOpen] = useState(initialStudioOpen);
  const [installMode, setInstallMode] = useState<'full' | 'custom'>('full');
  const [batchProgress, setBatchProgress] = useState<Record<string, unknown> | null>(null);
  const [batchFailures, setBatchFailures] = useState<Array<{ voiceId: string; message: string }>>([]);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [secretStatus, setSecretStatus] = useState<Record<string, { present?: boolean; remembered?: boolean }>>({});
  const catalogRequest = useRef(0);
  const activeRequestId = useRef('');

  const load = async () => {
    if (!bridge.available) {
      setSettings(emptyVoiceSettings);
      setStatuses([]);
      setCatalog([]);
      setNotice('扩展运行时不可用，无法读取真实设置。');
      return;
    }
    const requestId = ++catalogRequest.current;
    const settingsResponse = await bridge.send({ type: 'settings:get' });
    const raw = settingsResponse.settings as VoiceSettings || {};
    const [stateResult, storedSecrets] = await Promise.all([
      bridge.providerStates(raw),
      bridge.secretStatus().catch(() => ({})),
    ]);
    if (requestId !== catalogRequest.current) return;

    setSettings(raw);
    setStatuses(stateResult.providers);
    setModelState(stateResult.model);
    setSecretStatus(storedSecrets as Record<string, { present?: boolean; remembered?: boolean }>);

    const modelConfig = raw.providerSettings?.['browser-model'] || {};
    const mode = String(modelConfig.installMode || stateResult.model.installMode || 'full') === 'custom' ? 'custom' : 'full';
    const savedDownloadIds = Array.isArray(modelConfig.selectedVoiceIds) ? modelConfig.selectedVoiceIds.map(String) : [];
    setInstallMode(mode);
    setDownloadQueue((current) => current.size ? current : new Set(savedDownloadIds));

    const active = String(raw.activeProviderId || 'browser-system') as ProviderId;
    if (!initialProviderId && providerIds.includes(active)) setSelectedProvider(active);
    const savedLanguage = raw.voiceCatalogPreferences?.languageMode === 'fixed' && raw.voiceCatalogPreferences.locale
      ? String(raw.voiceCatalogPreferences.locale)
      : 'auto';
    setLanguageFilter(savedLanguage);

    const overrides = raw.voiceOverridesByProvider || {};
    setCatalog([]);
    await Promise.all(providerIds.map(async (providerId) => {
      try {
        const voices = await bridge.voices(providerId);
        if (requestId !== catalogRequest.current) return;
        const status = stateResult.providers.find((item) => item.providerId === providerId);
        const configuredRemote = !['openai-compatible', 'doubao-tts'].includes(providerId) || status?.configured === true;
        if (!configuredRemote) return;
        const entries = (voices as unknown as Array<Record<string, unknown>>).map((voice) => catalogEntry(
          providerId,
          voice,
          status,
          overrides[providerId]?.[rawVoiceId(String(voice.id || voice.voiceId || ''))],
        ));
        setCatalog((current) => [...current.filter((entry) => entry.providerId !== providerId), ...entries]);
      } catch (_) {
        // The source card keeps the connection error visible when a catalog is offline.
      }
    }));
  };

  useEffect(() => {
    void load().catch((error) => setNotice(error instanceof Error ? error.message : String(error)));
  }, []);

  useEffect(() => bridge.onModelProgress((progress, requestId) => {
    if (activeRequestId.current && requestId !== activeRequestId.current) return;
    setBatchProgress((current) => current?.phase === 'model-download' && progress.phase !== 'voice-batch' && progress.loaded != null
      ? { ...current, loadedBytes: Number(progress.loaded) || 0, sourceTotalBytes: Number(progress.total) || 0, file: String(progress.file || '') }
      : { ...(current || {}), ...progress });
  }), [bridge]);

  useEffect(() => {
    setPage(0);
    setSelectedVoice(null);
    setDownloadFilter('all');
  }, [selectedProvider]);

  useEffect(() => {
    setPage(0);
  }, [languageFilter, downloadFilter, genderFilter, search]);

  useEffect(() => {
    if (!selectedVoice) return;
    setAliasDraft(selectedVoice.alias || '');
    setNoteDraft(selectedVoice.note || '');
  }, [selectedVoice]);

  const assignments = settings.voiceAssignmentsByProvider || {};
  const selectedAssignment = assignments[selectedProvider] || emptyAssignment();
  const selectedStatus = statuses.find((status) => status.providerId === selectedProvider);
  const selectedConfig = settings.providerSettings?.[selectedProvider] || {};
  const activeProviderId = String(settings.activeProviderId || 'browser-system');
  const currentVoice = catalog.find((entry) => voiceKey(entry) === namespacedVoiceId(selectedProvider, selectedAssignment.narratorVoiceId));
  const detectedLocale = String(settings.voiceCatalogPreferences?.languageMode === 'fixed'
    ? settings.voiceCatalogPreferences.locale || preferredLocale()
    : preferredLocale());
  const providerCatalog = useMemo(() => catalog.filter((voice) => voice.providerId === selectedProvider), [catalog, selectedProvider]);
  const languages = useMemo(() => {
    const options = new Map<string, string>();
    for (const voice of providerCatalog) {
      const locale = String(voice.locale || voice.lang || '').trim();
      if (locale && !options.has(locale)) options.set(locale, voice.languageLabel || localeLabel(locale));
    }
    return [...options.entries()].sort((left, right) => left[1].localeCompare(right[1], 'zh-CN'));
  }, [providerCatalog]);
  const filteredVoices = useMemo(() => {
    const query = search.trim().toLowerCase();
    const family = localeFamily(detectedLocale);
    const score = (voice: VoiceCatalogEntry) => {
      const locale = voice.locale || voice.lang || '';
      const exact = locale.toLowerCase() === detectedLocale.toLowerCase();
      const same = localeFamily(locale) === family;
      const boundary = (voice.eventTypes || []).some((type) => ['word', 'sentence'].includes(type));
      return (exact ? 0 : same ? 10 : 30) - (boundary ? 2 : 0) - (voice.isDefault ? 1 : 0);
    };
    return providerCatalog.filter((voice) => {
      const inLanguage = languageFilter === 'all' || languageFilter === 'auto' || String(voice.locale || voice.lang || '') === languageFilter;
      const inDownload = selectedProvider !== 'browser-model' || downloadFilter === 'all' || (downloadFilter === 'downloaded' ? voice.cached === true : voice.cached !== true);
      const inGender = genderFilter === 'all' || (genderFilter === 'unknown' ? !['female', 'male'].includes(String(voice.gender || '')) : String(voice.gender || '') === genderFilter);
      const haystack = `${voice.label} ${voice.rawLabel || ''} ${voice.rawId || ''} ${voice.note || ''} ${voice.languageLabel}`.toLowerCase();
      return inLanguage && inDownload && inGender && (!query || haystack.includes(query));
    }).sort((left, right) => {
      const leftCurrent = currentVoice && voiceKey(left) === voiceKey(currentVoice) ? -1 : 0;
      const rightCurrent = currentVoice && voiceKey(right) === voiceKey(currentVoice) ? -1 : 0;
      return leftCurrent - rightCurrent || score(left) - score(right) || left.label.localeCompare(right.label, 'zh-CN');
    });
  }, [currentVoice, detectedLocale, downloadFilter, genderFilter, languageFilter, providerCatalog, search, selectedProvider]);
  const pageVoices = filteredVoices.slice(0, (page + 1) * pageSize);
  const modelAllVoices = catalog.filter((voice) => voice.providerId === 'browser-model');

  const updateDraft = (patch: Record<string, unknown>) => setSettings((current) => ({
    ...current,
    providerSettings: {
      ...(current.providerSettings || {}),
      [selectedProvider]: { ...(current.providerSettings?.[selectedProvider] || {}), ...patch },
    },
  }));

  const run = async (label: string, operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(label);
    setNotice(`${label}…`);
    try {
      await operation();
      setNotice(`${label}完成。`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy('');
      activeRequestId.current = '';
    }
  };

  const saveProvider = async () => {
    if (!bridge.available) throw new Error('扩展运行时不可用，无法保存来源设置。');
    if (selectedProvider === 'local-service') await bridge.requestLocalOrigin(String(selectedConfig.baseUrl || 'http://127.0.0.1:7811'));
    if (selectedProvider === 'openai-compatible' || selectedProvider === 'doubao-tts') await bridge.requestOnlineOrigin(String(selectedConfig.baseUrl || ''));
    const providerSettings = {
      ...(settings.providerSettings || {}),
      [selectedProvider]: { ...selectedConfig, configured: true, lastConfiguredAt: new Date().toISOString() },
    };
    const merged: VoiceSettings = { ...settings, providerSettings };
    const response = await bridge.saveSettings(merged);
    const next = response.settings as VoiceSettings || merged;
    const secret = secrets[selectedProvider];
    if (['local-service', 'openai-compatible', 'doubao-tts'].includes(selectedProvider) && secret) {
      const remember = selectedConfig.rememberToken === true || selectedConfig.rememberKey === true;
      await bridge.saveSecret(selectedProvider as 'local-service' | 'openai-compatible' | 'doubao-tts', secret, remember);
      setSecrets((current) => ({ ...current, [selectedProvider]: '' }));
      setSecretStatus(await bridge.secretStatus());
    }
    setSettings(next);
    return next;
  };

  const activateProvider = async (baseSettings: VoiceSettings = settings) => {
    const response = await bridge.saveSettings({ ...baseSettings, activeProviderId: selectedProvider });
    setSettings(response.settings as VoiceSettings || { ...baseSettings, activeProviderId: selectedProvider });
  };

  const connectProvider = () => run(`连接${providerRegistry.find((item) => item.id === selectedProvider)?.shortLabel || '声音来源'}`, async () => {
    const saved = await saveProvider();
    const response = await bridge.testProvider(selectedProvider, currentVoice?.id || '', previewText);
    await playResponseAudio(response);
    await activateProvider(saved);
    await load();
  });
  const saveOnly = () => run('保存来源设置', async () => { await saveProvider(); await load(); });
  const activateOnly = () => run('切换声音来源', async () => { await activateProvider(); await load(); });
  const setPreset = (preset: VoicePreset) => run('更新配音方式', async () => {
    const response = await bridge.saveSettings({ ...settings, preset });
    setSettings(response.settings as VoiceSettings || { ...settings, preset });
  });
  const setNarrator = (voice: VoiceCatalogEntry) => run(`设置默认旁白：${voice.label}`, async () => {
    if (voice.availability !== 'available') throw new Error('这个声音尚未可用，请先完成配置或下载。');
    const response = await bridge.assignVoices(voice.providerId, { narratorVoiceId: voice.id });
    setSettings(response.settings as VoiceSettings || settings);
    setSelectedProvider(voice.providerId as ProviderId);
    setSelectedVoice(voice);
  });

  const saveReplyPool = async (voiceIds: string[]) => {
    const response = await bridge.assignVoices(selectedProvider, { replyVoiceIds: voiceIds });
    setSettings(response.settings as VoiceSettings || settings);
  };
  const togglePoolVoice = (voice: VoiceCatalogEntry) => run('更新人物声音池', async () => {
    const current = new Set((selectedAssignment.replyVoiceIds || []).map((value) => namespacedVoiceId(selectedProvider, value)));
    const key = voiceKey(voice);
    if (current.has(key)) current.delete(key); else current.add(key);
    await saveReplyPool([...current]);
  });
  const addPoolVoices = (voices: VoiceCatalogEntry[]) => run('全选当前声音', async () => {
    const current = new Set((selectedAssignment.replyVoiceIds || []).map((value) => namespacedVoiceId(selectedProvider, value)));
    for (const voice of voices) current.add(voiceKey(voice));
    await saveReplyPool([...current]);
  });
  const removePoolVoices = (voices: VoiceCatalogEntry[]) => run('移除当前筛选声音', async () => {
    const remove = new Set(voices.map(voiceKey));
    await saveReplyPool((selectedAssignment.replyVoiceIds || []).filter((voice) => !remove.has(namespacedVoiceId(selectedProvider, voice))));
  });
  const clearPool = () => run('清空人物声音池', async () => saveReplyPool([]));

  const ensureStorage = async (requiredBytes: number) => {
    const estimate = await bridge.estimateStorage().catch(() => ({ available: null }));
    if (estimate.available != null && requiredBytes > estimate.available) throw new Error(`可用空间不足：需要约 ${bytesLabel(requiredBytes)}，当前仅剩 ${bytesLabel(estimate.available)}。`);
  };
  const audition = (voice: VoiceCatalogEntry) => run(`试听 ${voice.label}`, async () => {
    if (!bridge.available) throw new Error('扩展运行时不可用，无法试听真实声音。');
    if (voice.providerId === 'browser-model' && modelState?.ready !== true) throw new Error('请先完成浏览器模型安装。');
    if (voice.providerId === 'browser-model' && voice.cached !== true) {
      await ensureStorage(Number(voice.sizeBytes || 522240));
      const modelConfig = settings.providerSettings?.['browser-model'] || {};
      await bridge.requestModelOrigins(String(modelConfig.source || 'modelscope'));
      const requestId = `voice-audition-download-${Date.now()}`;
      activeRequestId.current = requestId;
      await bridge.modelAction('voice-batch', requestId, { action: 'download', voiceIds: [rawVoiceId(voice.id)] });
      await load();
    }
    await playResponseAudio(await bridge.auditionVoice(voice.providerId, voice.id, previewText));
  });
  const toggleDownload = (voice: VoiceCatalogEntry) => {
    const id = rawVoiceId(voice.id);
    setDownloadQueue((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const batchAction = (action: 'download' | 'repair' | 'delete', ids: string[], all = false) => run(
    action === 'download' ? '批量下载音色' : action === 'repair' ? '修复音色缓存' : '删除音色缓存',
    async () => {
      if (action === 'delete' && !window.confirm(`确定删除${all ? '全部' : `这 ${ids.length} 个`}音色缓存吗？`)) return;
      if (modelState?.ready !== true && action !== 'delete') throw new Error('请先完成浏览器模型安装。');
      const selected = (all ? modelAllVoices : modelAllVoices.filter((voice) => ids.includes(rawVoiceId(voice.id))))
        .filter((voice) => action !== 'download' || voice.cached !== true);
      if (action !== 'delete') await ensureStorage(selected.reduce((total, voice) => total + Number(voice.sizeBytes || 522240), 0));
      const requestId = `voice-batch-${action}-${Date.now()}`;
      activeRequestId.current = requestId;
      setBatchFailures([]);
      setBatchProgress({ phase: 'voice-batch', action, total: all ? modelAllVoices.length : ids.length, completed: 0 });
      const modelConfig = settings.providerSettings?.['browser-model'] || {};
      if (action !== 'delete') await bridge.requestModelOrigins(String(modelConfig.source || 'modelscope'));
      const response = await bridge.modelAction('voice-batch', requestId, {
        action,
        all,
        voiceIds: all ? undefined : ids,
        concurrency: Math.min(4, Math.max(1, Number(modelConfig.downloadConcurrency) || 4)),
      });
      const result = (response.result && typeof response.result === 'object' ? response.result : response) as Record<string, unknown>;
      const failures = (Array.isArray(result.failed) ? result.failed : []).map((item) => {
        const value = item && typeof item === 'object' ? item as Record<string, unknown> : {};
        const error = value.error && typeof value.error === 'object' ? value.error as Record<string, unknown> : {};
        return { voiceId: String(value.voiceId || ''), message: String(error.message || '音色操作失败') };
      });
      setBatchFailures(failures);
      if (action === 'download') setDownloadQueue(new Set());
      await load();
      if (failures.length) setNotice(`已完成，${failures.length} 个音色失败，可重试。`);
    },
  );

  const installModel = () => run(installMode === 'full' ? '完整安装浏览器模型' : '自定义安装浏览器模型', async () => {
    const ids = installMode === 'full' ? modelVoiceIds(modelAllVoices) : [...downloadQueue];
    if (!ids.length) throw new Error('自定义安装至少需要先在下方选择一个音色加入下载队列。');
    const modelBytes = modelState?.ready ? 0 : Number(modelState?.estimatedBytes || 342 * 1024 * 1024);
    const voiceBytes = ids.reduce((total, id) => total + Number(modelAllVoices.find((voice) => rawVoiceId(voice.id) === id && voice.cached !== true)?.sizeBytes || 0), 0);
    await ensureStorage(modelBytes + voiceBytes);
    const modelConfig = settings.providerSettings?.['browser-model'] || {};
    const providerSettings = {
      ...(settings.providerSettings || {}),
      'browser-model': { ...modelConfig, installMode, selectedVoiceIds: installMode === 'custom' ? ids : [] },
    };
    const response = await bridge.saveSettings({ ...settings, providerSettings });
    setSettings(response.settings as VoiceSettings || { ...settings, providerSettings });
    await bridge.requestModelOrigins(String(modelConfig.source || 'modelscope'));
    const requestId = `model-download-${installMode}-${Date.now()}`;
    activeRequestId.current = requestId;
    setBatchFailures([]);
    setBatchProgress({ phase: 'model-download', action: 'download', total: ids.length, completed: 0, totalBytes: modelBytes + voiceBytes, completedBytes: 0 });
    await bridge.modelAction('download', requestId, { installMode, voiceIds: ids, all: installMode === 'full' });
    await load();
  });
  const validateModel = () => run('验证浏览器模型', async () => { await bridge.modelAction('verify'); await load(); });
  const cancelModelOperation = async () => {
    const requestId = activeRequestId.current;
    if (!requestId) return;
    setNotice('正在取消模型操作…');
    try {
      await bridge.modelAction('cancel', requestId);
      setNotice('已请求取消模型操作。');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const saveVoiceMeta = () => run('保存声音名称与备注', async () => {
    if (!selectedVoice) return;
    const provider = selectedVoice.providerId;
    const id = rawVoiceId(selectedVoice.id);
    const nextOverrides = { ...(settings.voiceOverridesByProvider || {}) };
    const nextProvider = { ...(nextOverrides[provider] || {}) };
    const alias = aliasDraft.trim().slice(0, 64);
    const note = noteDraft.trim().slice(0, 500);
    if (!alias && !note) delete nextProvider[id]; else nextProvider[id] = { alias, note, updatedAt: Date.now() };
    nextOverrides[provider] = nextProvider;
    const response = await bridge.saveSettings({ ...settings, voiceOverridesByProvider: nextOverrides });
    setSettings(response.settings as VoiceSettings || { ...settings, voiceOverridesByProvider: nextOverrides });
    await load();
  });
  const setLanguagePreference = (value: string) => {
    if (value === 'all') { setLanguageFilter('all'); return; }
    void run('保存语言筛选', async () => {
      const next = value === 'auto' ? { languageMode: 'auto', locale: '' } : { languageMode: 'fixed', locale: value };
      const response = await bridge.saveSettings({ ...settings, voiceCatalogPreferences: next });
      setSettings(response.settings as VoiceSettings || { ...settings, voiceCatalogPreferences: next });
      setLanguageFilter(value);
    });
  };

  const preset = (['everyone-one', 'op-plus-one', 'op-stable-random', 'op-round-robin'].includes(String(settings.preset)) ? settings.preset : 'everyone-one') as VoicePreset;

  return (
    <div className="fl-voice-workbench" data-settings-section="voice">
      <header className="fl-voice-heading">
        <div><p className="fl-eyebrow">VOICE CENTER</p><h1>声音中心</h1><p>先选来源，再配置连接、默认旁白和人物声音池。</p></div>
        <Button className="fl-secondary-button" onPress={() => setStudioOpen((value) => !value)}><AudioLines aria-hidden={true} />{studioOpen ? '关闭声音创建' : '创建或导入本地音色'}</Button>
      </header>

      <main className="fl-voice-shell">
        <VoiceSourceCards activeProviderId={activeProviderId} selectedProvider={selectedProvider} statuses={statuses} onSelect={setSelectedProvider} />
        <VoiceProviderSetup
          selectedProvider={selectedProvider}
          activeProviderId={activeProviderId}
          status={selectedStatus}
          modelState={modelState}
          config={selectedConfig}
          secret={secrets[selectedProvider] || ''}
          secretStatus={secretStatus[selectedProvider]}
          installMode={installMode}
          downloadQueueSize={downloadQueue.size}
          modelVoiceCount={modelAllVoices.length}
          cachedModelVoiceCount={modelAllVoices.filter((voice) => voice.cached === true).length}
          remainingVoiceBytes={missingVoiceBytes(modelAllVoices)}
          busy={Boolean(busy)}
          studioOpen={studioOpen}
          onConfigChange={updateDraft}
          onSecretChange={(value) => setSecrets((current) => ({ ...current, [selectedProvider]: value }))}
          onInstallModeChange={setInstallMode}
          onSave={saveOnly}
          onConnect={connectProvider}
          onActivate={activateOnly}
          onInstallModel={installModel}
          onValidateModel={validateModel}
          onDownloadQueue={() => void batchAction('download', [...downloadQueue])}
          onDownloadAll={() => void batchAction('download', [], true)}
          onRepairAll={() => void batchAction('repair', [], true)}
          onDeleteAll={() => void batchAction('delete', [], true)}
          onStudioToggle={() => setStudioOpen((value) => !value)}
        />

        {batchProgress || batchFailures.length ? (
          <section className="fl-batch-feedback" aria-label="模型音色操作进度">
            {batchProgress ? <div className="fl-batch-progress" role="status" aria-live="polite"><span>{batchProgress.phase === 'model-download' ? '正在安装模型与音色：' : '正在处理音色：'}{String(batchProgress.completed || 0)} / {String(batchProgress.total || '')}{batchProgress.totalBytes || batchProgress.sourceTotalBytes ? ` · ${bytesLabel(Number(batchProgress.loadedBytes ?? batchProgress.completedBytes ?? 0))} / ${bytesLabel(Number(batchProgress.sourceTotalBytes || batchProgress.totalBytes))}` : ''}</span><progress max={Number(batchProgress.total || 0) || undefined} value={Number(batchProgress.completed || 0)} />{busy && activeRequestId.current ? <Button className="fl-text-button" onPress={cancelModelOperation}>取消</Button> : null}</div> : null}
            {batchFailures.length ? <div className="fl-batch-failures" role="alert"><strong>失败的音色</strong>{batchFailures.slice(0, 8).map((failure) => <span key={failure.voiceId}>{failure.voiceId}：{failure.message}</span>)}{batchFailures.length > 8 ? <small>还有 {batchFailures.length - 8} 个失败项。</small> : null}<Button className="fl-text-button" isDisabled={Boolean(busy)} onPress={() => void batchAction('download', batchFailures.map((failure) => failure.voiceId))}>重试失败</Button></div> : null}
          </section>
        ) : null}

        {studioOpen ? (
          <section className="fl-inline-studio" aria-label="声音创建工作台"><div className="fl-inline-studio-heading"><div><strong>声音创建工作台</strong><span>录音、导入和管理本地声音，完成后直接回到声音目录。</span></div><Button className="fl-text-button" onPress={() => setStudioOpen(false)}>返回声音列表<ChevronDown aria-hidden={true} /></Button></div><iframe title="声音创建工作台" src={`${((globalThis as { chrome?: { runtime?: { getURL?: (value: string) => string } } }).chrome?.runtime?.getURL?.('voice-studio.html') || 'voice-studio.html')}?provider=local-service&embedded=1`} /></section>
        ) : null}

        <VoiceStrategyPanel preset={preset} narratorLabel={currentVoice?.label || '未选择'} poolSize={selectedAssignment.replyVoiceIds?.length || 0} onChange={setPreset} />
        <VoiceCatalog
          providerId={selectedProvider}
          voices={pageVoices}
          allFilteredVoices={filteredVoices}
          assignment={selectedAssignment}
          selectedVoice={selectedVoice}
          detectedLocaleLabel={localeLabel(detectedLocale)}
          languages={languages}
          search={search}
          languageFilter={languageFilter === 'auto' || languageFilter === 'all' || languages.some(([locale]) => locale === languageFilter) ? languageFilter : 'all'}
          downloadFilter={downloadFilter}
          genderFilter={genderFilter}
          downloadQueue={downloadQueue}
          modelState={modelState}
          busy={Boolean(busy)}
          aliasDraft={aliasDraft}
          noteDraft={noteDraft}
          onSearchChange={setSearch}
          onLanguageChange={setLanguagePreference}
          onDownloadFilterChange={setDownloadFilter}
          onGenderFilterChange={setGenderFilter}
          onSelectVoice={setSelectedVoice}
          onSetNarrator={setNarrator}
          onTogglePoolVoice={togglePoolVoice}
          onSelectAllPool={addPoolVoices}
          onRemovePoolVoices={removePoolVoices}
          onClearPool={clearPool}
          onAudition={audition}
          onToggleDownload={toggleDownload}
          onLoadMore={() => setPage((value) => value + 1)}
          onAliasChange={setAliasDraft}
          onNoteChange={setNoteDraft}
          onSaveMetadata={saveVoiceMeta}
        />
      </main>
      {notice ? <div className="fl-operation-status" role="status" aria-live="polite">{busy ? <RefreshCcw className="is-spinning" aria-hidden={true} /> : <Sparkles aria-hidden={true} />}{notice}</div> : null}
    </div>
  );
}
