(function providerSettingsController() {
  'use strict';
  const form = document.getElementById('provider-settings-form');
  if (!form) return;
  const schema = globalThis.FlowloudSettings;
  const key = schema.SETTINGS_KEY;
  const status = document.getElementById('provider-save-status');
  const testStatus = document.getElementById('online-test-status');
  const localTestStatus = document.getElementById('local-test-status');
  let settings = schema.migrate({});
  let timer = 0;
  let modelRequestId = '';

  function modelResult(response) {
    return response?.result?.result || response?.result || response || {};
  }

  function showModelState(info) {
    const node = document.getElementById('model-status');
    if (!node) return;
    const state = String(info?.state || (info?.ready ? 'ready' : info?.cached ? 'available-unverified' : 'missing'));
    const labels = {
      missing: '模型未下载，或缓存已被浏览器回收。',
      downloading: '正在下载模型…',
      verifying: '正在进行离线运行校验…',
      ready: `模型已就绪${info?.device ? ` · ${String(info.device).toUpperCase()}` : ''}。`,
      corrupt: '模型缓存损坏或无法运行，请删除后重试。',
      cancelled: '模型下载已取消。',
      'available-unverified': '发现模型缓存，正在等待离线校验。',
    };
    node.textContent = `${labels[state] || `模型状态：${state}`}${info?.fallbackReason ? ` WebGPU 回退原因：${String(info.fallbackReason)}` : ''}`;
  }

  async function refreshBrowserModelState() {
    const infoResponse = await chrome.runtime.sendMessage({ type: 'provider:model:info' });
    if (!infoResponse?.ok) return showModelState({ state: 'missing' });
    let info = modelResult(infoResponse);
    showModelState(info);
    if (info.cached && !info.ready) {
      showModelState({ state: 'verifying' });
      const verifyResponse = await chrome.runtime.sendMessage({ type: 'provider:model:verify', requestId: `verify-${Date.now()}` });
      if (verifyResponse?.ok) info = modelResult(verifyResponse);
      else info = { state: 'corrupt', error: verifyResponse?.error };
      showModelState(info);
    }
    settings.providerSettings['browser-model'].downloaded = info.ready === true;
    if (info.cacheId) {
      settings.modelCacheRegistry = Object.assign({}, settings.modelCacheRegistry, {
        [info.cacheId]: Object.assign({}, settings.modelCacheRegistry?.[info.cacheId] || {}, info),
      });
    }
    await chrome.storage.local.set({ [key]: schema.publicSettings(settings) });
  }

  async function refreshStorageData() {
    const modelList = document.getElementById('storage-model-list');
    const modelSummary = document.getElementById('storage-model-summary');
    const legacySummary = document.getElementById('legacy-data-summary');
    if (!modelList || !modelSummary || !legacySummary) return;
    const [modelsResponse, legacyResponse] = await Promise.all([
      chrome.runtime.sendMessage({ type: 'model:list' }),
      chrome.runtime.sendMessage({ type: 'legacy-data:inspect' }),
    ]);
    const models = modelsResponse?.models || [];
    modelList.replaceChildren();
    modelSummary.textContent = models.length ? `已缓存 ${models.length} 个模型。` : '没有浏览器模型缓存。';
    models.forEach((model) => {
      const item = document.createElement('li');
      const copy = document.createElement('div');
      const name = document.createElement('strong'); name.textContent = model.repoId || '浏览器语音模型';
      const id = document.createElement('code'); id.textContent = model.cacheId;
      copy.append(name, document.createElement('br'), id);
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'secondary-button'; remove.textContent = '删除';
      remove.addEventListener('click', async () => {
        if (!confirm(`将删除模型缓存：\n${model.cacheId}\n\n删除后再次使用需要重新下载。继续吗？`)) return;
        const response = await chrome.runtime.sendMessage({ type: 'model:delete', cacheId: model.cacheId });
        if (!response?.ok) throw new Error(response?.error?.message || '删除失败。');
        await refreshStorageData();
      });
      item.append(copy, remove); modelList.append(item);
    });
    const legacy = legacyResponse?.legacy || {};
    legacySummary.textContent = `本地 Qwen 音色 ${Number(legacy.localQwenVoices) || 0} 个；无法归属的模型缓存 ${(legacy.modelCaches || []).length} 个。旧数据已隔离，不会用于其他朗读引擎。`;
  }

  async function deleteLegacy(targets, description) {
    const statusNode = document.getElementById('storage-action-status');
    if (!confirm(`${description}\n\n此操作无法撤销，是否继续？`)) return;
    statusNode.textContent = '正在清理…';
    const response = await chrome.runtime.sendMessage({ type: 'legacy-data:delete', targets });
    if (!response?.ok) throw new Error(response?.error?.message || '清理失败。');
    statusNode.textContent = '清理完成。';
    await refreshStorageData();
  }

  function values() {
    const online = settings.providerSettings['openai-compatible'];
    const browser = settings.providerSettings['browser-model'];
    const local = settings.providerSettings['local-service'];
    form.activeProviderId.value = settings.activeProviderId;
    form.playbackRate.value = String(settings.playbackRate);
    form.browserModelId.value = browser.modelId;
    form.browserRepoId.value = browser.repoId;
    form.browserRevision.value = browser.revision;
    form.browserDevice.value = browser.device === 'wasm' ? 'wasm' : 'webgpu';
    form.localAdapter.value = local.adapterId;
    form.localBaseUrl.value = local.baseUrl;
    form.localModel.value = local.model;
    form.rememberLocalToken.checked = local.rememberToken === true;
    form.onlineBaseUrl.value = online.baseUrl;
    form.onlineModel.value = online.model;
    form.onlineVoice.value = online.voice;
    form.rememberApiKey.checked = online.rememberKey === true;
    document.querySelectorAll('[data-provider-panel]').forEach((panel) => { panel.hidden = panel.dataset.providerPanel !== settings.activeProviderId; });
    const voiceNav = document.querySelector('[data-settings-section="voices"]');
    const voiceOption = document.querySelector('#settings-section-select option[value="voices"]');
    const cloneAvailable = settings.activeProviderId === 'local-service' && local.adapterId === 'flowloud-qwen';
    if (voiceNav) {
      voiceNav.disabled = !cloneAvailable;
      voiceNav.title = cloneAvailable ? '' : '首版仅 Flowloud Qwen 适配器支持音色克隆';
    }
    if (voiceOption) voiceOption.disabled = !cloneAvailable;
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
    return session[schema.SESSION_SECRET_KEY]?.['local-service']
      || local[schema.REMEMBERED_SECRET_KEY]?.['local-service']
      || session[schema.SESSION_SECRET_KEY]?.['local-qwen']
      || local[schema.REMEMBERED_SECRET_KEY]?.['local-qwen'] || '';
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

  async function saveLocalToken(secret, remember) {
    const currentSession = await chrome.storage.session.get(schema.SESSION_SECRET_KEY).catch(() => ({}));
    const currentLocal = await chrome.storage.local.get(schema.REMEMBERED_SECRET_KEY);
    const sessionSecrets = Object.assign({}, currentSession[schema.SESSION_SECRET_KEY] || {});
    const localSecrets = Object.assign({}, currentLocal[schema.REMEMBERED_SECRET_KEY] || {});
    delete sessionSecrets['local-qwen']; delete localSecrets['local-qwen'];
    if (secret) sessionSecrets['local-service'] = secret; else delete sessionSecrets['local-service'];
    if (remember && secret) localSecrets['local-service'] = secret; else delete localSecrets['local-service'];
    await chrome.storage.session.set({ [schema.SESSION_SECRET_KEY]: sessionSecrets });
    await chrome.storage.local.set({ [schema.REMEMBERED_SECRET_KEY]: localSecrets });
  }

  async function save() {
    status.textContent = '正在保存…';
    settings.activeProviderId = form.activeProviderId.value;
    settings.providerId = settings.activeProviderId;
    settings.playbackRate = schema.rate(form.playbackRate.value);
    const browser = settings.providerSettings['browser-model'];
    Object.assign(browser, { modelId: form.browserModelId.value, repoId: form.browserRepoId.value.trim(), revision: form.browserRevision.value.trim() || 'main', device: form.browserDevice.value });
    const local = settings.providerSettings['local-service'];
    Object.assign(local, {
      adapterId: schema.normalizeLocalAdapter(form.localAdapter.value),
      baseUrl: schema.sanitizeLocalBaseUrl(form.localBaseUrl.value),
      model: form.localModel.value.trim(),
      rememberToken: form.rememberLocalToken.checked,
    });
    const online = settings.providerSettings['openai-compatible'];
    let baseUrl = form.onlineBaseUrl.value.trim();
    if (baseUrl) baseUrl = schema.sanitizeOnlineBaseUrl(baseUrl);
    Object.assign(online, { baseUrl, model: form.onlineModel.value.trim(), voice: form.onlineVoice.value.trim() || 'alloy', rememberKey: form.rememberApiKey.checked });
    settings = schema.publicSettings(settings);
    await chrome.storage.local.set({ [key]: settings });
    await saveSecret(form.onlineApiKey.value.trim(), form.rememberApiKey.checked);
    await saveLocalToken(form.localClientToken.value.trim(), form.rememberLocalToken.checked);
    status.textContent = '已自动保存'; values();
    window.dispatchEvent(new CustomEvent('flowloud:provider-changed', { detail: { providerId: settings.activeProviderId } }));
  }

  function schedule() { clearTimeout(timer); status.textContent = '有更改待保存'; timer = setTimeout(() => save().catch((error) => { status.textContent = error.message; }), 180); }

  form.addEventListener('input', schedule);
  form.addEventListener('change', schedule);
  form.browserModelId.addEventListener('change', () => {
    const presets = {
      'kokoro-zh': ['onnx-community/Kokoro-82M-v1.1-zh-ONNX', '6cc0f0d2ebe369a68b0df87c2b65c1af8c0ac3e3'],
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
      const previewText = form.onlinePreviewText.value.trim();
      if (!previewText) throw new Error('请先填写试听短句。');
      testStatus.textContent = '正在合成试听；这可能产生少量费用…';
      const response = await chrome.runtime.sendMessage({
        type: 'provider:test', providerId: 'openai-compatible', previewText,
        requestId: `audition-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      });
      if (!response || response.ok === false) throw new Error(response?.error?.message || '连接测试失败。');
      if (!response.audioBase64) throw new Error('服务没有返回可试听音频。');
      const audio = document.getElementById('online-test-audio');
      audio.src = `data:${response.mimeType || 'audio/mpeg'};base64,${response.audioBase64}`;
      audio.hidden = false;
      await audio.play();
      testStatus.textContent = '试听成功；未修改当前朗读位置或默认 Provider。';
    } catch (error) { testStatus.textContent = error.message; }
  });
  document.getElementById('local-test').addEventListener('click', async () => {
    try {
      await save();
      const baseUrl = schema.sanitizeLocalBaseUrl(form.localBaseUrl.value);
      const granted = await chrome.permissions.request({ origins: [`${new URL(baseUrl).origin}/*`] });
      if (!granted) throw new Error('未授予此本地服务的主机权限。');
      localTestStatus.textContent = '正在读取服务能力…';
      const response = await chrome.runtime.sendMessage({ type: 'tts:status', providerId: 'local-service' });
      if (!response?.ok) throw new Error(response?.error?.message || '本地服务连接失败。');
      const status = response.status || response.result?.status || {};
      const capabilities = status.capabilities || {};
      const streamLabel = capabilities.incrementalGeneration || capabilities.backendIncrementalGeneration
        ? '真正增量生成' : capabilities.transportStreaming ? 'HTTP 分块传输' : '完整音频';
      localTestStatus.textContent = `连接成功 · ${streamLabel}${capabilities.cancel === false ? ' · 不支持远端取消' : ''}`;
    } catch (error) { localTestStatus.textContent = error.message; }
  });
  document.getElementById('model-download').addEventListener('click', async () => {
    const modelStatus = document.getElementById('model-status');
    const modelProgress = document.getElementById('model-progress');
    const cancelButton = document.getElementById('model-cancel');
    try {
      await save();
      const preset = { size: '约 110 MB', license: 'Apache-2.0' };
      const expectedBytes = 110 * 1048576;
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
      const result = modelResult(response);
      if (!result.ready || result.state !== 'ready') throw new Error('模型下载完成，但离线短句校验没有通过。');
      settings.providerSettings['browser-model'].downloaded = true;
      settings.providerSettings['browser-model'].cacheMetadata = Object.assign({}, result, { sizeLabel: preset.size, license: preset.license });
      settings.modelCacheRegistry = Object.assign({}, settings.modelCacheRegistry, {
        [result.cacheId]: Object.assign({}, result, { sizeLabel: preset.size, license: preset.license }),
      });
      await chrome.storage.local.set({ [key]: schema.publicSettings(settings) });
      showModelState(result);
    } catch (error) { modelStatus.textContent = error.message; }
    finally { modelRequestId = ''; modelProgress.hidden = true; cancelButton.hidden = true; }
  });
  document.getElementById('model-cancel').addEventListener('click', async () => {
    if (!modelRequestId) return;
    await chrome.runtime.sendMessage({ type: 'provider:model:cancel', requestId: modelRequestId }).catch(() => null);
    document.getElementById('model-status').textContent = '正在取消下载…';
  });
  document.getElementById('model-delete').addEventListener('click', async () => {
    const info = await chrome.runtime.sendMessage({ type: 'provider:model:info' });
    const cacheId = info?.result?.cacheId || info?.cacheId || `flowloud-model-${settings.providerSettings['browser-model'].repoId}@${settings.providerSettings['browser-model'].revision}`;
    if (!confirm(`将删除模型缓存：\n${cacheId}\n\n删除后再次使用需要重新下载。继续吗？`)) return;
    const deleted = await chrome.runtime.sendMessage({ type: 'model:delete', cacheId });
    if (!deleted?.ok) throw new Error(deleted?.error?.message || '模型缓存删除失败。');
    settings.providerSettings['browser-model'].downloaded = false;
    if (settings.modelCacheRegistry) delete settings.modelCacheRegistry[cacheId];
    await chrome.storage.local.set({ [key]: schema.publicSettings(settings) });
    showModelState({ state: 'missing' });
    await refreshStorageData();
  });
  document.getElementById('delete-legacy-voices')?.addEventListener('click', () => {
    void deleteLegacy(['local-qwen-voices'], '将删除浏览器中保存的旧 Qwen 音色记录。');
  });
  document.getElementById('delete-all-legacy')?.addEventListener('click', async () => {
    const legacy = await chrome.runtime.sendMessage({ type: 'legacy-data:inspect' });
    const targets = ['local-qwen-voices', ...((legacy?.legacy?.modelCaches) || [])];
    void deleteLegacy(targets, `将删除 ${Number(legacy?.legacy?.localQwenVoices) || 0} 个旧 Qwen 音色和 ${targets.length - 1} 个旧模型缓存。`);
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
    form.localClientToken.value = await readLocalToken();
    await refreshStorageData();
    await refreshBrowserModelState();
  })().catch((error) => { status.textContent = error.message; });
}());
