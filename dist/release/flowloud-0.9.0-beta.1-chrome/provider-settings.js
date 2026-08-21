(function providerSettingsController() {
  'use strict';
  const form = document.getElementById('provider-settings-form');
  if (!form) return;
  const schema = globalThis.FlowloudSettings;
  const key = schema.SETTINGS_KEY;
  const status = document.getElementById('provider-save-status');
  const testStatus = document.getElementById('online-test-status');
  let settings = schema.migrate({});
  let timer = 0;
  let modelRequestId = '';

  function values() {
    const online = settings.providerSettings['openai-compatible'];
    const browser = settings.providerSettings['browser-model'];
    form.activeProviderId.value = settings.activeProviderId;
    form.playbackRate.value = String(settings.playbackRate);
    form.browserModelId.value = browser.modelId;
    form.browserRepoId.value = browser.repoId;
    form.browserRevision.value = browser.revision;
    form.browserDevice.value = browser.device === 'wasm' ? 'wasm' : 'webgpu';
    form.qwenModel.value = settings.providerSettings['local-qwen'].model;
    form.onlineBaseUrl.value = online.baseUrl;
    form.onlineModel.value = online.model;
    form.onlineVoice.value = online.voice;
    form.rememberApiKey.checked = online.rememberKey === true;
    document.querySelectorAll('[data-provider-panel]').forEach((panel) => { panel.hidden = panel.dataset.providerPanel !== settings.activeProviderId; });
    const voiceNav = document.querySelector('[data-settings-section="voices"]');
    const cloneAvailable = settings.activeProviderId === 'local-qwen';
    if (voiceNav) {
      voiceNav.disabled = !cloneAvailable;
      voiceNav.title = cloneAvailable ? '' : '首版仅本地 Qwen 支持音色克隆';
    }
    if (!cloneAvailable && location.hash === '#voices') location.hash = '#engine';
  }

  async function readSecret() {
    const session = await chrome.storage.session.get(schema.SESSION_SECRET_KEY).catch(() => ({}));
    const local = await chrome.storage.local.get(schema.REMEMBERED_SECRET_KEY);
    return session[schema.SESSION_SECRET_KEY]?.['openai-compatible'] || local[schema.REMEMBERED_SECRET_KEY]?.['openai-compatible'] || '';
  }

  async function readLocalToken() {
    const session = await chrome.storage.session.get(schema.SESSION_SECRET_KEY).catch(() => ({}));
    const local = await chrome.storage.local.get(schema.REMEMBERED_SECRET_KEY);
    return session[schema.SESSION_SECRET_KEY]?.['local-qwen'] || local[schema.REMEMBERED_SECRET_KEY]?.['local-qwen'] || '';
  }

  async function saveSecret(secret, remember) {
    const currentSession = await chrome.storage.session.get(schema.SESSION_SECRET_KEY).catch(() => ({}));
    const currentLocal = await chrome.storage.local.get(schema.REMEMBERED_SECRET_KEY);
    const sessionSecrets = Object.assign({}, currentSession[schema.SESSION_SECRET_KEY] || {});
    const localSecrets = Object.assign({}, currentLocal[schema.REMEMBERED_SECRET_KEY] || {});
    if (secret) sessionSecrets['openai-compatible'] = secret; else delete sessionSecrets['openai-compatible'];
    await chrome.storage.session.set({ [schema.SESSION_SECRET_KEY]: sessionSecrets });
    if (remember && secret) localSecrets['openai-compatible'] = secret; else delete localSecrets['openai-compatible'];
    await chrome.storage.local.set({ [schema.REMEMBERED_SECRET_KEY]: localSecrets });
  }

  async function saveLocalToken(secret) {
    const current = await chrome.storage.local.get(schema.REMEMBERED_SECRET_KEY);
    const secrets = Object.assign({}, current[schema.REMEMBERED_SECRET_KEY] || {});
    if (secret) secrets['local-qwen'] = secret; else delete secrets['local-qwen'];
    await chrome.storage.local.set({ [schema.REMEMBERED_SECRET_KEY]: secrets });
  }

  async function save() {
    status.textContent = '正在保存…';
    settings.activeProviderId = form.activeProviderId.value;
    settings.providerId = settings.activeProviderId;
    settings.playbackRate = schema.rate(form.playbackRate.value);
    const browser = settings.providerSettings['browser-model'];
    Object.assign(browser, { modelId: form.browserModelId.value, repoId: form.browserRepoId.value.trim(), revision: form.browserRevision.value.trim() || 'main', device: form.browserDevice.value });
    settings.providerSettings['local-qwen'].model = form.qwenModel.value;
    const online = settings.providerSettings['openai-compatible'];
    let baseUrl = form.onlineBaseUrl.value.trim();
    if (baseUrl) baseUrl = schema.sanitizeOnlineBaseUrl(baseUrl);
    Object.assign(online, { baseUrl, model: form.onlineModel.value.trim(), voice: form.onlineVoice.value.trim() || 'alloy', rememberKey: form.rememberApiKey.checked });
    settings = schema.publicSettings(settings);
    await chrome.storage.local.set({ [key]: settings });
    await saveSecret(form.onlineApiKey.value.trim(), form.rememberApiKey.checked);
    await saveLocalToken(form.qwenClientToken.value.trim());
    status.textContent = '已自动保存'; values();
  }

  function schedule() { clearTimeout(timer); status.textContent = '有更改待保存'; timer = setTimeout(() => save().catch((error) => { status.textContent = error.message; }), 180); }

  form.addEventListener('input', schedule);
  form.addEventListener('change', schedule);
  form.browserModelId.addEventListener('change', () => {
    const presets = {
      'cmn-vits': ['BricksDisplay/vits-cmn', '3265ca20151fb9c79fa00c8f3874cacb2c15b2ce'],
      'kokoro-en': ['onnx-community/Kokoro-82M-v1.0-ONNX', '1939ad2a8e416c0acfeecc08a694d14ef25f2231'],
    };
    const selected = presets[form.browserModelId.value];
    if (selected) { form.browserRepoId.value = selected[0]; form.browserRevision.value = selected[1]; }
  });
  document.getElementById('online-test').addEventListener('click', async () => {
    try {
      await save();
      const baseUrl = schema.sanitizeOnlineBaseUrl(form.onlineBaseUrl.value);
      const origin = `${new URL(baseUrl).origin}/*`;
      const granted = await chrome.permissions.request({ origins: [origin] });
      if (!granted) throw new Error('未授予此在线服务的主机权限。');
      testStatus.textContent = '正在测试…';
      const response = await chrome.runtime.sendMessage({ type: 'provider:test', providerId: 'openai-compatible' });
      if (!response || response.ok === false) throw new Error(response?.error?.message || '连接测试失败。');
      testStatus.textContent = '连接成功。';
    } catch (error) { testStatus.textContent = error.message; }
  });
  document.getElementById('model-download').addEventListener('click', async () => {
    const modelStatus = document.getElementById('model-status');
    const modelProgress = document.getElementById('model-progress');
    const cancelButton = document.getElementById('model-cancel');
    try {
      await save();
      const preset = form.browserModelId.value === 'kokoro-en' ? { size: '约 350 MB', license: 'Apache-2.0' } : { size: '约 160 MB', license: 'Apache-2.0' };
      const expectedBytes = form.browserModelId.value === 'kokoro-en' ? 350 * 1048576 : 160 * 1048576;
      const estimate = await navigator.storage?.estimate?.();
      if (estimate && Number.isFinite(estimate.quota) && Number.isFinite(estimate.usage) && estimate.quota - estimate.usage < expectedBytes * 1.2) {
        throw new Error(`浏览器存储空间不足；至少需要约 ${Math.ceil(expectedBytes * 1.2 / 1048576)} MB 可用空间。`);
      }
      if (form.browserDevice.value === 'webgpu' && !navigator.gpu && !confirm('当前浏览器未检测到 WebGPU，将使用较慢的 WASM。继续吗？')) return;
      if (!confirm(`将从 Hugging Face 下载模型（${preset.size}，${preset.license}）并保存在浏览器缓存中。继续吗？`)) return;
      const granted = await chrome.permissions.request({ origins: ['https://huggingface.co/*', 'https://*.huggingface.co/*'] });
      if (!granted) throw new Error('未授予 Hugging Face 下载权限。');
      modelStatus.textContent = '正在下载和初始化模型，请保持此页面打开…';
      modelRequestId = `model-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      modelProgress.hidden = false; modelProgress.removeAttribute('value'); cancelButton.hidden = false;
      const response = await chrome.runtime.sendMessage({ type: 'provider:model:download', requestId: modelRequestId });
      if (!response?.ok) throw new Error(response?.error?.message || '模型下载失败。');
      settings.providerSettings['browser-model'].downloaded = true;
      settings.providerSettings['browser-model'].cacheMetadata = Object.assign({}, response.result?.result || response.result || {}, { sizeLabel: preset.size, license: preset.license });
      await chrome.storage.local.set({ [key]: schema.publicSettings(settings) });
      modelStatus.textContent = '模型已下载并通过运行时校验。';
    } catch (error) { modelStatus.textContent = error.message; }
    finally { modelRequestId = ''; modelProgress.hidden = true; cancelButton.hidden = true; }
  });
  document.getElementById('model-cancel').addEventListener('click', async () => {
    if (!modelRequestId) return;
    await chrome.runtime.sendMessage({ type: 'provider:model:cancel', requestId: modelRequestId }).catch(() => null);
    document.getElementById('model-status').textContent = '正在取消下载…';
  });
  document.getElementById('model-delete').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'provider:model:delete' }).catch(() => null);
    const names = await caches.keys(); await Promise.all(names.filter((name) => name.startsWith('flowloud-model-')).map((name) => caches.delete(name)));
    settings.providerSettings['browser-model'].downloaded = false; await chrome.storage.local.set({ [key]: schema.publicSettings(settings) });
    document.getElementById('model-status').textContent = '模型缓存已删除。';
  });
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.target !== 'flowloud:model' || message.type !== 'provider:model:progress' || message.requestId !== modelRequestId) return;
    const progress = document.getElementById('model-progress');
    const value = Number(message.progress?.progress ?? message.progress?.percentage);
    if (Number.isFinite(value)) { progress.value = Math.max(0, Math.min(100, value)); progress.hidden = false; }
    const loaded = Number(message.progress?.loaded); const total = Number(message.progress?.total);
    if (loaded > 0 && total > 0) document.getElementById('model-status').textContent = `正在下载：${Math.round(loaded / 1048576)} / ${Math.round(total / 1048576)} MB`;
  });

  (async () => {
    const saved = await chrome.storage.local.get(key); settings = schema.migrate(saved[key]);
    form.onlineApiKey.value = await readSecret(); values();
    form.qwenClientToken.value = await readLocalToken();
  })().catch((error) => { status.textContent = error.message; });
}());
