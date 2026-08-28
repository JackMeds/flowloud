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
  await expect(options.getByRole('heading', { name: '语音与音色' })).toBeVisible();
  await expect(options.getByRole('tab', { name: '语音与音色' })).toBeVisible();
  await expect(options.getByRole('tab', { name: '语音来源' })).toHaveCount(0);
  await expect(options.getByRole('tab', { name: '声音库' })).toHaveCount(0);
  await expect(options.getByRole('tab', { name: '角色配音' })).toHaveCount(0);
  await expect(options.getByLabel('浏览器下载模型配置')).toBeVisible();
  const overflow = await options.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  const optionsScreenshot = testInfo.outputPath('options-settings.png');
  await options.screenshot({ path: optionsScreenshot, fullPage: true });
  await testInfo.attach('Independent settings page', { path: optionsScreenshot, contentType: 'image/png' });

  const visual = await extensionContext.newPage();
  diagnostics.attachPage(visual);
  await visual.setViewportSize({ width: 1440, height: 1024 });
  await visual.goto(`${origin}/options-react.html?section=voice&provider=browser-model`, { waitUntil: 'domcontentloaded' });
  await expect(visual.getByRole('heading', { name: '语音与音色' })).toBeVisible();
  await expect(visual.locator('[role="row"]').nth(1)).toBeVisible({ timeout: 15_000 });
  await expect(visual.getByText('跟随默认', { exact: true })).toBeVisible();
  const visualScreenshot = testInfo.outputPath('voice-workbench-1440x1024.png');
  await visual.screenshot({ path: visualScreenshot });
  await testInfo.attach('Voice workbench 1440 x 1024', { path: visualScreenshot, contentType: 'image/png' });

  const studio = await extensionContext.newPage();
  diagnostics.attachPage(studio);
  await studio.setViewportSize({ width: 1200, height: 800 });
  await studio.goto(`${origin}/voice-studio.html?provider=local-service`, { waitUntil: 'domcontentloaded' });
  await expect(studio.getByRole('heading', { name: '创建与管理音色' })).toBeVisible();
  await expect(studio.locator('[data-settings-section]')).toHaveCount(0);
  await expect(studio.locator('#reader-settings-pane, #engine-settings-pane, #storage-settings-pane')).toHaveCount(0);

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
