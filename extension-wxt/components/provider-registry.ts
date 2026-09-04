export const providerRegistry = [
  {
    id: 'browser-system',
    label: '浏览器系统语音',
    shortLabel: '系统语音',
    summary: '系统语音',
    kind: 'system',
    description: '无需配置，直接使用浏览器和 Windows 已安装的声音。',
    privacy: '正文不离开设备',
  },
  {
    id: 'browser-model',
    label: '浏览器下载模型',
    shortLabel: '浏览器模型',
    summary: '浏览器模型',
    kind: 'model',
    description: '下载 Kokoro 模型后在浏览器内离线合成。',
    privacy: '需下载模型与音色',
  },
  {
    id: 'local-service',
    label: '本地 TTS 服务',
    shortLabel: '本地 TTS',
    summary: '本地服务',
    kind: 'local',
    description: '连接本机 Qwen、GPT-SoVITS、CosyVoice 或兼容服务。',
    privacy: '需本机地址与配对信息',
  },
  {
    id: 'openai-compatible',
    label: 'OpenAI 兼容在线 TTS',
    shortLabel: '在线 TTS',
    summary: '在线 TTS',
    kind: 'online',
    description: '连接支持 /v1/audio/speech 的 HTTPS 服务。',
    privacy: '需地址、模型和 API Key',
  },
  {
    id: 'doubao-tts',
    label: '豆包原生 TTS',
    shortLabel: '豆包 TTS',
    summary: '豆包 TTS',
    kind: 'online',
    description: '使用豆包原生单向流式语音接口。',
    privacy: '需 App ID、音色和 API Key',
  },
] as const;

export type ProviderId = typeof providerRegistry[number]['id'];

export const providerOptions = providerRegistry.map(({ id, label }) => [id, label] as const);

export const providerSummaryLabels = Object.fromEntries(
  providerRegistry.map(({ id, summary }) => [id, summary]),
) as Record<string, string>;

export function providerLabel(providerId: string) {
  return providerRegistry.find((provider) => provider.id === providerId)?.label || providerId;
}

/**
 * The daily Popup selector should contain only sources that can actually be
 * used right now.  The full settings page still renders every provider so an
 * unconfigured source remains discoverable through the dedicated management
 * entry point.
 */
export function configuredProviderOptions(
  states: ReadonlyArray<{ providerId: string; status?: string; configured?: boolean; ready?: boolean }>,
  activeProviderId?: string,
) {
  const active = String(activeProviderId || '');
  return providerRegistry
    .filter((provider) => {
      const state = states.find((item) => item.providerId === provider.id);
      if (provider.id === 'browser-system') return true;
      if (provider.id === active) return true;
      if (!state) return false;
      if (state.configured === true || state.ready === true) return true;
      return ['ready', 'permission-required', 'error'].includes(String(state.status || ''));
    })
    .map(({ id, label }) => [id, label] as const);
}
