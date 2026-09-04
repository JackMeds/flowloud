import { useEffect, useRef, useState } from 'react';
import { PopupConsole, type ReaderCommand } from './PopupConsole';
import { runtimeDefaultSettings, type PopupModel, type PopupSettings, type SettingsSection } from './model';
import { createRuntimeBridge, type RuntimeContext } from './runtime-bridge';

function messageFrom(error: unknown, fallback: string) {
  if (error && typeof error === 'object' && 'message' in error) {
    const message = String((error as { message?: unknown }).message || '').trim();
    if (message) return message;
  }
  return fallback;
}

function preserveRuntimeDetails(current: PopupModel, next: PopupModel): PopupModel {
  if (current.settings.activeProviderId !== next.settings.activeProviderId) return next;
  const samePage = current.sourceTabId === next.sourceTabId && current.title === next.title;
  return {
    ...next,
    availableVoices: current.availableVoices,
    selectedVoiceId: next.selectedVoiceId || current.selectedVoiceId,
    voiceLoadState: current.voiceLoadState,
    providerNotice: current.providerNotice,
    controlNotice: current.controlNotice,
    authors: samePage && current.authors.length ? current.authors : next.authors,
  };
}

function initialRuntimeModel(available: boolean): PopupModel {
  return {
    title: '当前网页',
    sourceLabel: '',
    status: available ? 'loading' : 'error',
    index: 0,
    total: 0,
    currentText: '',
    currentSpeaker: '',
    authors: [],
    settings: { ...runtimeDefaultSettings },
    availableVoices: [],
    selectedVoiceId: '',
    pageVoiceAssignments: {},
    pageVoiceLoadState: 'idle',
    voiceLoadState: 'idle',
    persistentSiteAccess: false,
    isMock: false,
    currentTabId: null,
    sourceTabId: null,
    globalPlayback: { active: false, state: 'idle' },
    message: available ? '正在连接当前网页…' : '扩展运行时不可用，请从已安装的扩展页面打开。',
  };
}

export function RuntimePopup() {
  const [bridge] = useState(() => createRuntimeBridge());
  const [model, setModel] = useState<PopupModel>(() => initialRuntimeModel(bridge.available));
  const [context, setContext] = useState<RuntimeContext | null>(null);
  const savedSettings = useRef<Record<string, unknown>>({});
  const controlNoticeTimer = useRef<number | null>(null);

  useEffect(() => () => {
    if (controlNoticeTimer.current != null) window.clearTimeout(controlNoticeTimer.current);
  }, []);

  const showControlNotice = (notice: string, duration = 2600) => {
    if (controlNoticeTimer.current != null) window.clearTimeout(controlNoticeTimer.current);
    setModel((current) => ({ ...current, controlNotice: notice }));
    controlNoticeTimer.current = window.setTimeout(() => {
      controlNoticeTimer.current = null;
      setModel((current) => ({ ...current, controlNotice: undefined }));
    }, duration);
  };

  useEffect(() => {
    if (!bridge.available) return;
    let disposed = false;
    let timer = 0;
    const load = async () => {
      try {
        const next = await bridge.loadPopup();
        if (disposed) return;
        savedSettings.current = next.rawSettings;
        setContext(next.context);
        setModel((current) => preserveRuntimeDetails(current, next.model));
      } catch (error) {
        if (!disposed) setModel((current) => ({
          ...current, status: 'error', isMock: false,
          message: messageFrom(error, '无法连接当前网页。'),
        }));
      }
    };
    void load();
    timer = window.setInterval(() => void load(), 900);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [bridge]);

  useEffect(() => {
    if (!bridge.available) return;
    const providerId = model.settings.activeProviderId;
    let disposed = false;
    setModel((current) => ({ ...current, voiceLoadState: 'loading', providerNotice: undefined }));
    void bridge.voices(providerId).then((voices) => {
      if (disposed) return;
      const overrides = savedSettings.current.voiceOverridesByProvider as Record<string, Record<string, { alias?: string; note?: string }>> | undefined;
      const labelledVoices = voices.map((voice) => {
        const rawId = String(voice.rawId || voice.id || '').replace(/^[^:]+:/u, '');
        const override = overrides?.[providerId]?.[rawId];
        return override ? { ...voice, label: override.alias || voice.label, displayLabel: override.alias || voice.displayLabel || voice.label, note: override.note || voice.note } : voice;
      });
      const playableVoices = providerId === 'browser-model'
        ? labelledVoices.filter((voice) => voice.cached === true)
        : labelledVoices;
      const assignments = savedSettings.current.voiceAssignmentsByProvider as Record<string, Record<string, unknown>> | undefined;
      const configuredVoiceId = String(assignments?.[providerId]?.narratorVoiceId || '');
      const selected = playableVoices.find((voice) => voice.id === configuredVoiceId) || playableVoices[0];
      setModel((current) => {
        let providerNotice: string | undefined;
        if (providerId === 'browser-system') {
          providerNotice = selected?.eventTypes?.includes('word')
            ? '当前系统音色支持逐词边界。'
            : '当前系统音色未声明逐词边界，将保留句子高亮。';
        } else if (providerId === 'browser-model') {
          providerNotice = playableVoices.length
            ? `已下载 ${playableVoices.length} / ${labelledVoices.length} 个音色；这里只显示现在可播放的音色${current.providerDevice ? ` · ${current.providerDevice.toUpperCase()}` : ''}`
            : '当前没有已下载且可播放的模型音色，请先到“声音”下载。';
        }
        return {
          ...current,
          availableVoices: playableVoices,
          selectedVoiceId: selected?.id || current.selectedVoiceId,
          voiceLoadState: 'ready',
          providerNotice,
        };
      });
      if (providerId === 'browser-model' && selected && configuredVoiceId !== selected.id) {
        void bridge.assignVoices(providerId, { narratorVoiceId: selected.id }).then((response) => {
          savedSettings.current = response.settings || savedSettings.current;
        }).catch((error) => {
          if (!disposed) setModel((current) => ({ ...current, message: messageFrom(error, '无法切换到已下载音色。') }));
        });
      }
    }).catch((error) => {
      if (!disposed) setModel((current) => ({
        ...current,
        availableVoices: [],
        voiceLoadState: 'error',
        providerNotice: messageFrom(error, '暂时无法读取音色列表。'),
      }));
    });
    return () => { disposed = true; };
  }, [bridge, model.settings.activeProviderId]);

  const refresh = async () => {
    if (!bridge.available) return;
    const next = await bridge.loadPopup();
    savedSettings.current = next.rawSettings;
    setContext(next.context);
    setModel((current) => preserveRuntimeDetails(current, next.model));
  };

  const sendCommand = async (command: ReaderCommand) => {
    if (!bridge.available) return;
    const toggling = command === 'toggle-playback';
    const pausing = toggling && model.status === 'playing';
    const resuming = toggling && model.status === 'paused';
    if (pausing) {
      setModel((current) => ({ ...current, status: 'paused', controlNotice: '正在立即停止声音并保存当前位置…' }));
    } else if (resuming) {
      setModel((current) => ({ ...current, status: 'loading', controlNotice: '正在从暂停位置继续…' }));
    }
    try {
      await bridge.command(context, command);
      await refresh();
      if (pausing) {
        showControlNotice(model.settings.activeProviderId === 'browser-system'
          ? '已立即停止声音；继续时会从当前词重新开始。'
          : '已暂停，当前播放位置已保留。');
      } else if (resuming) {
        showControlNotice('已继续朗读。', 1800);
      }
    } catch (error) {
      setModel((current) => ({ ...current, controlNotice: undefined, message: messageFrom(error, '操作未完成，请重试。') }));
    }
  };

  const readCurrentPage = async () => {
    if (!bridge.available) return;
    try {
      await bridge.command(context, 'toggle-playback', { current: true, takeover: true });
      await refresh();
    } catch (error) {
      setModel((current) => ({ ...current, message: messageFrom(error, '无法朗读当前页。') }));
    }
  };

  const changeSetting = async <Key extends keyof PopupSettings>(key: Key, value: PopupSettings[Key]) => {
    const previous = model.settings;
    const nextSettings = { ...previous, [key]: value };
    setModel((current) => ({ ...current, settings: nextSettings, message: undefined }));
    if (!bridge.available) return;
    try {
      if (key === 'activeProviderId' && value === 'local-service') {
        const providerSettings = savedSettings.current.providerSettings as Record<string, Record<string, unknown>> | undefined;
        const baseUrl = String(providerSettings?.['local-service']?.baseUrl || 'http://127.0.0.1:7811');
        const granted = await bridge.requestLocalOrigin(baseUrl);
        if (!granted) throw new globalThis.Error('未授予本地服务连接权限。');
      }
      const merged = { ...savedSettings.current, ...nextSettings };
      const response = await bridge.saveSettings(merged);
      savedSettings.current = response.settings || merged;
    } catch (error) {
      setModel((current) => ({
        ...current, settings: previous,
        message: messageFrom(error, '设置保存失败。'),
      }));
    }
  };

  const requestPersistentSiteAccess = async () => {
    if (!bridge.available) return;
    try {
      const granted = await bridge.requestPageOrigin(context);
      if (!granted) throw new globalThis.Error('浏览器未允许扩展在当前网页运行。');
      setModel((current) => ({ ...current, persistentSiteAccess: true, message: undefined }));
      showControlNotice('悬浮播放器会在普通网页刷新后自动显示。', 3200);
    } catch (error) {
      setModel((current) => ({ ...current, message: messageFrom(error, '浏览器阻止了扩展在当前网页运行。') }));
    }
  };

  const changeVoice = async (voiceId: string) => {
    const providerId = model.settings.activeProviderId;
    const previousVoiceId = model.selectedVoiceId || '';
    setModel((current) => ({ ...current, selectedVoiceId: voiceId, message: undefined }));
    if (!bridge.available) return;
    try {
      const response = await bridge.assignVoices(providerId, { narratorVoiceId: voiceId });
      savedSettings.current = response.settings || savedSettings.current;
    } catch (error) {
      setModel((current) => ({
        ...current,
        selectedVoiceId: previousVoiceId,
        message: messageFrom(error, '音色保存失败。'),
      }));
    }
  };

  const openGuide = async () => {
    if (!bridge.available) return;
    await bridge.send({ type: 'guide:open', tabId: context?.tabId });
    window.close();
  };

  const openDocuments = async () => {
    if (!bridge.available) return;
    await bridge.openDocumentWorkbench(context?.currentTab?.tabId ?? context?.tabId);
    window.close();
  };

  const openPageVoices = async () => {
    if (!bridge.available) return;
    try {
      await bridge.openPageVoices(context);
      window.close();
    } catch (error) {
      setModel((current) => ({ ...current, message: messageFrom(error, '无法打开本页角色配音。') }));
    }
  };

  const focusSource = async () => {
    if (!bridge.available) return;
    try { await bridge.focusSource(); } catch (error) {
      setModel((current) => ({ ...current, message: messageFrom(error, '无法返回朗读来源页。') }));
    }
  };

  const openSettings = async (section: SettingsSection, providerId = '') => {
    if (!bridge.available) return;
    try {
      await bridge.openSettingsTab(section, providerId);
      window.close();
    } catch (error) {
      setModel((current) => ({ ...current, message: messageFrom(error, '无法打开完整设置。') }));
    }
  };

  return (
    <PopupConsole
      model={model}
      onCommand={sendCommand}
      onSettingChange={changeSetting}
      onRequestPersistentSiteAccess={requestPersistentSiteAccess}
      onOpenSettings={(section, providerId) => { void openSettings(section, providerId); }}
      onOpenGuide={openGuide}
      onReturnSource={focusSource}
      onReadCurrentPage={readCurrentPage}
      onVoiceChange={changeVoice}
      onOpenPageVoices={openPageVoices}
      onOpenDocuments={openDocuments}
    />
  );
}
