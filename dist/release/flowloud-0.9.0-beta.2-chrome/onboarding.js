(function onboarding() {
  'use strict'; const schema = globalThis.FlowloudSettings;
  async function finish(openSettings) { const saved = await chrome.storage.local.get(schema.SETTINGS_KEY); const settings = schema.migrate(saved[schema.SETTINGS_KEY]); settings.activeProviderId = 'browser-system'; settings.providerId = 'browser-system'; settings.onboardingComplete = true; await chrome.storage.local.set({ [schema.SETTINGS_KEY]: schema.publicSettings(settings) }); if (openSettings) await chrome.runtime.openOptionsPage(); window.close(); }
  document.getElementById('start').onclick = () => finish(false); document.getElementById('settings').onclick = () => finish(true);
}());
