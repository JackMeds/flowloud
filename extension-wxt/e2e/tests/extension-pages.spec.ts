import { test, expect } from '../fixtures';
import { assertNoExtensionErrors } from '../scenarios';

test('popup, settings, document workbench, and browser-model protocol load from the release source', async ({
  extensionContext,
  extensionId,
  diagnostics,
}, testInfo) => {
  const origin = `chrome-extension://${extensionId}`;
  const popup = await extensionContext.newPage();
  diagnostics.attachPage(popup);
  await popup.setViewportSize({ width: 420, height: 600 });
  await popup.goto(`${origin}/popup-react.html`, { waitUntil: 'domcontentloaded' });
  await expect(popup.getByRole('region', { name: '当前朗读' })).toBeVisible();
  await expect(popup.getByText('声音来源', { exact: true })).toBeVisible();
  for (const source of ['浏览器系统语音', '浏览器下载模型', '本地 TTS 服务', 'OpenAI 兼容在线 TTS', '豆包原生 TTS']) {
    await expect(popup.getByRole('button', { name: new RegExp(source) }).first()).toBeVisible();
  }
  const popupSoundScreenshot = testInfo.outputPath('popup-sound-sources.png');
  await popup.screenshot({ path: popupSoundScreenshot, fullPage: true });
  await testInfo.attach('Popup visible voice sources', { path: popupSoundScreenshot, contentType: 'image/png' });
  await expect(popup.getByText('高级设置')).toHaveCount(0);
  await expect(popup.getByRole('region', { name: '语音来源设置' })).toHaveCount(0);
  await popup.getByRole('tab', { name: '更多' }).click();
  await expect(popup.getByRole('button', { name: /打开全部设置/ })).toHaveCount(1);
  const popupScreenshot = testInfo.outputPath('popup-provider-settings.png');
  await popup.screenshot({ path: popupScreenshot, fullPage: true });
  await testInfo.attach('Popup Provider settings', { path: popupScreenshot, contentType: 'image/png' });

  const options = await extensionContext.newPage();
  diagnostics.attachPage(options);
  await options.setViewportSize({ width: 960, height: 640 });
  await options.goto(`${origin}/options-react.html?section=voice&provider=browser-model`, { waitUntil: 'domcontentloaded' });
  await expect(options.getByRole('heading', { name: '声音中心' })).toBeVisible();
  await expect(options.getByRole('tab', { name: '声音' })).toBeVisible();
  await expect(options.getByRole('tab', { name: '语音来源' })).toHaveCount(0);
  await expect(options.getByRole('tab', { name: '声音库' })).toHaveCount(0);
  await expect(options.getByRole('tab', { name: '角色配音' })).toHaveCount(0);
  await expect(options.getByRole('heading', { name: '选择并配置声音来源' })).toBeVisible();
  await expect(options.getByRole('button', { name: /浏览器下载模型.*查看配置/ })).toBeVisible();
  await expect(options.getByText('模型来源', { exact: true })).toBeVisible();
  await expect(options.getByText('完整安装', { exact: true })).toBeVisible();
  const settingsSearch = options.getByRole('textbox', { name: '搜索设置' });
  await settingsSearch.fill('缓存');
  await expect(options.getByRole('button', { name: /声音 \/ 浏览器模型与下载 \/ 浏览器模型、下载与音色缓存/ })).toBeVisible();
  await options.getByRole('button', { name: /声音 \/ 浏览器模型与下载 \/ 浏览器模型、下载与音色缓存/ }).click();
  await expect(options.locator('#voice-sources')).toHaveClass(/is-search-target/);
  const overflow = await options.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  const optionsScreenshot = testInfo.outputPath('options-settings.png');
  await options.screenshot({ path: optionsScreenshot, fullPage: true });
  await testInfo.attach('Independent settings page', { path: optionsScreenshot, contentType: 'image/png' });

  const visual = await extensionContext.newPage();
  diagnostics.attachPage(visual);
  await visual.setViewportSize({ width: 1440, height: 1024 });
  await visual.goto(`${origin}/options-react.html?section=voice&provider=browser-model`, { waitUntil: 'domcontentloaded' });
  await expect(visual.getByRole('heading', { name: '声音中心' })).toBeVisible();
  await expect(visual.locator('[role="row"]').nth(1)).toBeVisible({ timeout: 15_000 });
  await expect(visual.getByText(/模型尚未安装或验证|模型已就绪/).first()).toBeVisible();
  const visualScreenshot = testInfo.outputPath('voice-workbench-1440x1024.png');
  await visual.screenshot({ path: visualScreenshot });
  await testInfo.attach('Voice workbench 1440 x 1024', { path: visualScreenshot, contentType: 'image/png' });

  const studio = await extensionContext.newPage();
  diagnostics.attachPage(studio);
  await studio.setViewportSize({ width: 1200, height: 800 });
  await studio.goto(`${origin}/voice-studio.html?provider=local-service`, { waitUntil: 'domcontentloaded' });
  await expect(studio).toHaveURL(/options-react\.html\?section=voice&view=studio&provider=local-service/);
  await expect(studio.getByRole('heading', { name: '声音中心' })).toBeVisible();
  await expect(studio.locator('iframe[title="声音创建工作台"]')).toBeVisible();

  const localSetup = await extensionContext.newPage();
  diagnostics.attachPage(localSetup);
  await localSetup.setViewportSize({ width: 1200, height: 900 });
  await localSetup.goto(`${origin}/options-react.html?section=voice&provider=local-service`, { waitUntil: 'domcontentloaded' });
  await expect(localSetup.getByRole('heading', { name: '本地 TTS 服务' })).toBeVisible();
  await expect(localSetup.getByRole('list', { name: '重新连接本地 TTS 的步骤' })).toBeVisible();
  await expect(localSetup.getByText('从托盘复制配对令牌', { exact: true })).toBeVisible();
  await expect(localSetup.getByText(/发布包不包含网关和模型/)).toBeVisible();
  await expect(localSetup.getByText(/关闭时只保留到本次浏览器会话结束/)).toBeVisible();
  const localScreenshot = testInfo.outputPath('local-tts-reconnect.png');
  await localSetup.screenshot({ path: localScreenshot, fullPage: true });
  await testInfo.attach('Local TTS reconnect guidance', { path: localScreenshot, contentType: 'image/png' });

  const voicePool = await extensionContext.newPage();
  diagnostics.attachPage(voicePool);
  await voicePool.setViewportSize({ width: 1440, height: 900 });
  await voicePool.goto(`${origin}/options-react.html?section=voice&provider=browser-system`, { waitUntil: 'domcontentloaded' });
  await voicePool.evaluate(async () => (globalThis as any).chrome.runtime.sendMessage({
    type: 'settings:voice:assign',
    providerId: 'browser-system',
    assignment: { replyVoiceIds: [] },
  }));
  await voicePool.reload({ waitUntil: 'domcontentloaded' });
  const poolChoices = voicePool.locator('.fl-voice-row .fl-pool-check-cell input:not(:disabled)');
  await expect(poolChoices.nth(1)).toBeVisible({ timeout: 15_000 });
  await poolChoices.nth(0).check();
  await expect(poolChoices.nth(1)).toBeEnabled();
  await poolChoices.nth(1).check();
  const selectedPool = await voicePool.evaluate(async () => {
    const response = await (globalThis as any).chrome.runtime.sendMessage({ type: 'settings:get' });
    return response.settings.voiceAssignmentsByProvider['browser-system'].replyVoiceIds;
  });
  expect(new Set(selectedPool).size).toBeGreaterThanOrEqual(2);
  await voicePool.getByRole('button', { name: '全选当前结果' }).click();
  await expect(voicePool.getByText(/个声音已加入人物声音池/)).toBeVisible();
  await voicePool.getByRole('button', { name: '清空声音池' }).click();
  const clearedPool = await voicePool.evaluate(async () => {
    const response = await (globalThis as any).chrome.runtime.sendMessage({ type: 'settings:get' });
    return response.settings.voiceAssignmentsByProvider['browser-system'].replyVoiceIds;
  });
  expect(clearedPool).toEqual([]);

  const workbench = await extensionContext.newPage();
  diagnostics.attachPage(workbench);
  await workbench.setViewportSize({ width: 1440, height: 900 });
  await workbench.goto(`${origin}/document-workbench.html`, { waitUntil: 'domcontentloaded' });
  await expect(workbench.getByRole('heading', { name: '先完成服务配置' })).toBeVisible();
  await expect(workbench.getByRole('button', { name: /^配置(?:OCR和)?翻译服务$/ })).toBeVisible();
  await expect(workbench.getByRole('button', { name: '开始处理' })).toHaveCount(0);
  const workbenchScreenshot = testInfo.outputPath('document-workbench-prerequisite.png');
  await workbench.screenshot({ path: workbenchScreenshot, fullPage: true });
  await testInfo.attach('Document workbench prerequisite', { path: workbenchScreenshot, contentType: 'image/png' });

  const controller = await extensionContext.newPage();
  diagnostics.attachPage(controller);
  await controller.goto(`${origin}/options-react.html`, { waitUntil: 'domcontentloaded' });
  const modelInfo = await controller.evaluate(async () => {
    return (globalThis as any).chrome.runtime.sendMessage({
      type: 'provider:model:info',
      providerId: 'browser-model',
      requestId: `playwright-model-info-${Date.now()}`,
    });
  });
  expect(modelInfo?.ok).not.toBe(false);
  assertNoExtensionErrors(diagnostics);
});
