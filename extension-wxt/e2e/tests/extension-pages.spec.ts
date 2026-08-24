import { test, expect } from '../fixtures';
import { assertNoExtensionErrors } from '../scenarios';

test('popup, settings, document workbench, and browser-model protocol load from the release source', async ({
  extensionContext,
  extensionId,
  diagnostics,
}) => {
  const origin = `chrome-extension://${extensionId}`;
  for (const pathname of ['popup-react.html', 'options-react.html', 'document-workbench.html']) {
    const page = await extensionContext.newPage();
    diagnostics.attachPage(page);
    await page.goto(`${origin}/${pathname}`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('body')).not.toBeEmpty();
  }

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
