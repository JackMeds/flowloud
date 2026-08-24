import { useEffect, useRef, useState } from 'react';
import { PopupConsole, type ReaderCommand } from './PopupConsole';
import { demoPopupModel, type PopupModel, type PopupSettings } from './model';
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
    pageVoiceAssignments: samePage ? current.pageVoiceAssignments : {},
    pageVoiceLoadState: samePage ? current.pageVoiceLoadState : 'idle',
  };
}

export function RuntimePopup() {
  const [bridge] = useState(() => createRuntimeBridge());
  const [model, setModel] = useState<PopupModel>(() => bridge.available
    ? { ...demoPopupModel, status: 'loading', isMock: false, message: '正在连接当前网页…' }
    : { ...demoPopupModel, isMock: true, message: 'Mock 界面预览：未连接扩展运行时。' });
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
      setModel((current) => {
        const selected = voices.find((voice) => voice.id === current.selectedVoiceId) || voices[0];
        let providerNotice: string | undefined;
        if (providerId === 'browser-system') {
          providerNotice = selected?.eventTypes?.includes('word')
            ? '当前系统音色支持逐词边界。'
            : '当前系统音色未声明逐词边界，将保留句子高亮。';
        } else if (providerId === 'browser-model') {
          providerNotice = `当前浏览器模型只有固定音色，不支持声音克隆${current.providerDevice ? ` · ${current.providerDevice.toUpperCase()}` : ''}`;
        }
        return {
          ...current,
          availableVoices: voices,
          selectedVoiceId: selected?.id || current.selectedVoiceId,
          voiceLoadState: 'ready',
          providerNotice,
        };
      });
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

  useEffect(() => {
    if (!bridge.available || context?.tabId == null) return;
    let disposed = false;
    setModel((current) => ({ ...current, pageVoiceLoadState: 'loading' }));
    void bridge.pageVoices(context).then((pageVoices) => {
      if (disposed) return;
      setModel((current) => ({
        ...current,
        authors: pageVoices.authors.length ? pageVoices.authors : current.authors,
        pageVoiceAssignments: pageVoices.assignments,
        pageVoiceLoadState: 'ready',
      }));
    }).catch((error) => {
      if (disposed) return;
      setModel((current) => ({
        ...current,
        pageVoiceLoadState: 'error',
        message: messageFrom(error, '暂时无法读取本页配音。'),
      }));
    });
    return () => { disposed = true; };
  }, [bridge, context?.tabId, context?.pageKey]);

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
      const providerVoices = {
        ...(savedSettings.current.providerVoices as Record<string, unknown> || {}),
        [providerId]: voiceId,
      };
      const assignments = savedSettings.current.voiceAssignmentsByProvider as Record<string, Record<string, unknown>> | undefined;
      const voiceAssignmentsByProvider = {
        ...(assignments || {}),
        [providerId]: {
          ...(assignments?.[providerId] || {}),
          narratorVoiceId: voiceId,
        },
      };
      const merged = { ...savedSettings.current, providerVoices, voiceAssignmentsByProvider };
      const response = await bridge.saveSettings(merged);
      savedSettings.current = response.settings || merged;
    } catch (error) {
      setModel((current) => ({
        ...current,
        selectedVoiceId: previousVoiceId,
        message: messageFrom(error, '音色保存失败。'),
      }));
    }
  };

  const changePageVoice = async (authorId: string, voiceId: string) => {
    const strategyVoiceKey = '__strategy__';
    const previous = { ...(model.pageVoiceAssignments || {}) };
    const next = { ...previous };
    if (voiceId === strategyVoiceKey) delete next[authorId];
    else next[authorId] = voiceId;
    setModel((current) => ({ ...current, pageVoiceAssignments: next, message: undefined }));
    if (!bridge.available) return;
    try {
      const pageVoices = await bridge.applyPageVoices(context, next);
      setModel((current) => ({
        ...current,
        authors: pageVoices.authors.length ? pageVoices.authors : current.authors,
        pageVoiceAssignments: pageVoices.assignments,
        pageVoiceLoadState: 'ready',
      }));
    } catch (error) {
      setModel((current) => ({
        ...current,
        pageVoiceAssignments: previous,
        message: messageFrom(error, '本页配音保存失败。'),
      }));
    }
  };

  const testLocalService = async () => {
    const baseUrl = model.providerBaseUrl || 'http://127.0.0.1:7811';
    setModel((current) => ({ ...current, providerNotice: `正在检查 ${baseUrl}…` }));
    try {
      const granted = await bridge.requestLocalOrigin(baseUrl);
      if (!granted) throw new globalThis.Error('未授予本地服务连接权限。');
      const response = await bridge.testLocalService();
      const capabilities = response.capabilities && typeof response.capabilities === 'object'
        ? response.capabilities as Record<string, unknown> : {};
      const streamLabel = capabilities.incrementalGeneration === true ? '增量生成' : capabilities.transportStreaming === true ? '分块传输' : '整段音频';
      setModel((current) => ({ ...current, providerNotice: `连接成功 · ${baseUrl} · ${streamLabel}` }));
    } catch (error) {
      setModel((current) => ({ ...current, providerNotice: messageFrom(error, `无法连接 ${baseUrl}。`) }));
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

  const focusSource = async () => {
    if (!bridge.available) return;
    try { await bridge.focusSource(); } catch (error) {
      setModel((current) => ({ ...current, message: messageFrom(error, '无法返回朗读来源页。') }));
    }
  };

  return (
    <PopupConsole
      model={model}
      onCommand={sendCommand}
      onSettingChange={changeSetting}
      onRequestPersistentSiteAccess={requestPersistentSiteAccess}
      onOpenOptions={() => bridge.openOptions()}
      onOpenGuide={openGuide}
      onReturnSource={focusSource}
      onReadCurrentPage={readCurrentPage}
      onVoiceChange={changeVoice}
      onPageVoiceChange={changePageVoice}
      onTestLocalService={testLocalService}
      onOpenDocuments={openDocuments}
    />
  );
}
