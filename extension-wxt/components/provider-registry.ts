export const providerRegistry = [
  { id: 'browser-system', label: '浏览器系统语音', summary: '系统语音', kind: 'system' },
  { id: 'browser-model', label: '浏览器下载模型', summary: '浏览器模型', kind: 'model' },
  { id: 'local-service', label: '本地 TTS 服务', summary: '本地服务', kind: 'local' },
  { id: 'openai-compatible', label: 'OpenAI 兼容在线 TTS', summary: '在线 TTS', kind: 'online' },
  { id: 'doubao-tts', label: '豆包原生 TTS', summary: '豆包 TTS', kind: 'online' },
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
