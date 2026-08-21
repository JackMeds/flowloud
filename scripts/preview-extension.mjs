import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    if (key === 'keep-open') {
      values[key] = true;
      continue;
    }
    values[key] = argv[index + 1];
    index += 1;
  }
  return values;
}

const args = parseArgs(process.argv.slice(2));
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDirectory, '..');
const extensionRoot = path.resolve(args['extension-root'] || path.join(repoRoot, 'extension'));
const profile = path.resolve(args.profile || path.join(repoRoot, '.tmp-popup-preview-edge'));
const output = path.resolve(args.output || path.join(profile, 'artifacts'));
const edge = args.edge || process.env.FLOWLOUD_BROWSER || process.env.QWEN_EDGE || (
  process.env.ProgramFiles
    ? path.join(process.env.ProgramFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
    : ''
);

if (!edge) throw new Error('Microsoft Edge executable was not provided.');
await fs.mkdir(output, { recursive: true });

const nodeRoot = path.resolve(process.execPath, '..', '..');
const bundledPlaywright = path.join(nodeRoot, 'node_modules', 'playwright', 'index.js');
const fallbackPlaywright = path.join(
  process.env.LOCALAPPDATA || '',
  'Programs',
  'nodejs',
  'node_modules',
  'playwright',
  'index.js',
);
const playwrightEntry = await fs.access(bundledPlaywright).then(() => bundledPlaywright).catch(async () => {
  await fs.access(fallbackPlaywright);
  return fallbackPlaywright;
});
const require = createRequire(import.meta.url);
const { chromium } = require(playwrightEntry);

const context = await chromium.launchPersistentContext(profile, {
  headless: false,
  executablePath: edge,
  args: [
    `--disable-extensions-except=${extensionRoot}`,
    `--load-extension=${extensionRoot}`,
    '--no-first-run',
    '--no-default-browser-check',
  ],
});

let keepOpen = Boolean(args['keep-open']);
let worker = context.serviceWorkers()[0];
if (!worker) {
  worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
}
const extensionId = new URL(worker.url()).hostname;
const extensionOrigin = `chrome-extension://${extensionId}`;
async function selectSystemProvider() {
  await worker.evaluate(async () => {
    const key = 'qwenReaderSettings';
    const saved = await chrome.storage.local.get(key);
    const current = saved[key] || {};
    const assignments = { ...(current.voiceAssignmentsByProvider || {}), 'browser-system': { narratorVoiceId: '', replyVoiceIds: [], authorVoices: {} } };
    await chrome.storage.local.set({ [key]: { ...current, schemaVersion: 4, activeProviderId: 'browser-system', providerId: 'browser-system', providerVoices: { ...(current.providerVoices || {}), 'browser-system': '' }, voiceAssignmentsByProvider: assignments } });
  });
}
await selectSystemProvider();

const lab = await context.newPage();
await lab.goto(`${extensionOrigin}/popup-lab.html`, { waitUntil: 'domcontentloaded' });
await lab.screenshot({ path: path.join(output, 'popup-lab.png'), fullPage: true });
await lab.locator('.qr-lab-card .qr-popup-root').first().screenshot({ path: path.join(output, 'popup-playing-390.png') });
const popupBounds = await lab.locator('.qr-lab-card .qr-popup').first().boundingBox();
if (!popupBounds || popupBounds.width > 390.5 || popupBounds.height > 600.5) throw new Error(`Popup exceeds release bounds: ${JSON.stringify(popupBounds)}`);
const transportSizes = await lab.locator('.qr-lab-card').first().locator('.qr-controls .qr-control').evaluateAll((items) => items.map((item) => ({ width: item.getBoundingClientRect().width, height: item.getBoundingClientRect().height })));
if (transportSizes.some((item) => item.width < 44 || item.height < 44)) throw new Error(`Popup transport target is below 44px: ${JSON.stringify(transportSizes)}`);

async function captureSettings(name, hash, selector) {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${extensionOrigin}/voice-studio.html#${hash}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(selector, { state: 'visible', timeout: 10000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(output, name), fullPage: true });
  await page.close();
}

await captureSettings('settings-reading.png', 'reader', '#reader-settings-form');
await captureSettings('settings-engine.png', 'engine', '#provider-settings-form');
await captureSettings('settings-storage.png', 'storage', '#storage-settings-pane');
const narrowSettings = await context.newPage();
await narrowSettings.setViewportSize({ width: 320, height: 800 });
await narrowSettings.goto(`${extensionOrigin}/voice-studio.html#reader`, { waitUntil: 'domcontentloaded' });
await narrowSettings.waitForSelector('#settings-section-select', { state: 'visible', timeout: 10000 });
await narrowSettings.emulateMedia({ reducedMotion: 'reduce' });
await narrowSettings.screenshot({ path: path.join(output, 'settings-320-reduced-motion.png'), fullPage: true });
await narrowSettings.close();
await worker.evaluate(async () => {
  const key = 'qwenReaderSettings';
  const saved = await chrome.storage.local.get(key);
  await chrome.storage.local.set({ [key]: { ...(saved[key] || {}), schemaVersion: 3, activeProviderId: 'local-qwen', providerId: 'local-qwen' } });
});
await captureSettings('settings-voices.png', 'voices', '#voice-settings-pane');
await worker.evaluate(async () => {
  const key = 'qwenReaderSettings';
  const saved = await chrome.storage.local.get(key);
  await chrome.storage.local.set({ [key]: { ...(saved[key] || {}), activeProviderId: 'browser-system', providerId: 'browser-system' } });
});

const onboarding = await context.newPage();
await onboarding.setViewportSize({ width: 1280, height: 800 });
await onboarding.goto(`${extensionOrigin}/onboarding.html`, { waitUntil: 'domcontentloaded' });
await onboarding.screenshot({ path: path.join(output, 'onboarding-1280x800.png') });
await onboarding.close();

const guide = await context.newPage();
await guide.setViewportSize({ width: 1000, height: 800 });
await guide.goto(`${extensionOrigin}/page-guide.html?tabId=-1`, { waitUntil: 'domcontentloaded' });
await guide.waitForTimeout(300);
await guide.screenshot({ path: path.join(output, 'page-guide.png'), fullPage: true });
await guide.close();

const settingsSmoke = await context.newPage();
await settingsSmoke.goto(`${extensionOrigin}/voice-studio.html#reader`, { waitUntil: 'domcontentloaded' });
await settingsSmoke.selectOption('[name="readingFocus"]', 'line');
await settingsSmoke.waitForFunction(async () => {
  const saved = await chrome.storage.local.get('qwenReaderSettings');
  return saved.qwenReaderSettings?.readingFocus === 'line';
}, null, { timeout: 10000 });
if (await settingsSmoke.locator('[data-settings-section="voices"]').isEnabled()) throw new Error('Voice cloning must be disabled for browser-system.');
await settingsSmoke.click('[data-settings-section="engine"]');
await settingsSmoke.selectOption('[name="activeProviderId"]', 'local-qwen');
await settingsSmoke.waitForFunction(() => !document.querySelector('[data-settings-section="voices"]')?.disabled, null, { timeout: 10000 });
await settingsSmoke.click('[data-settings-section="voices"]');
await settingsSmoke.click('#import-tab');
await settingsSmoke.waitForSelector('#import-pane', { state: 'visible' });
await settingsSmoke.screenshot({ path: path.join(output, 'settings-voice-upload.png'), fullPage: true });
await settingsSmoke.close();
await selectSystemProvider();

// The page harness loads the production content reader and its real CSS in a
// deterministic article fixture. This captures the other half of B+C: the
// active-only mini player plus the inline author/voice and word indicators.
const harnessBase = pathToFileURL(path.join(extensionRoot, 'tests', 'browser', 'ui-harness.html')).href;
async function captureReaderHarness(name, query) {
  const page = await context.newPage();
  const diagnostics = [];
  let screenshotCaptured = false;
  page.on('pageerror', (error) => diagnostics.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') diagnostics.push(`console: ${message.text()}`);
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${harnessBase}${query || ''}`, { waitUntil: 'load' });
  try {
    await page.waitForFunction(() => document.documentElement.dataset.testStatus === 'pass', null, { timeout: 15000 });
  } catch (error) {
    const status = await page.locator('#test-result').textContent().catch(() => 'missing result');
    await page.screenshot({ path: path.join(output, name.replace(/\.png$/u, '-failed.png')), fullPage: true }).catch(() => {});
    throw new Error(`${error.message}; harness=${status}; ${diagnostics.join(' | ')}`);
  }
  if (String(query || '').includes('audit=playing')) {
    const clickShadowButton = async (selector) => {
      const rect = await page.evaluate((buttonSelector) => {
        const button = window.__QWEN_READER_TEST_ROOT__?.querySelector(buttonSelector);
        if (!button) return null;
        const bounds = button.getBoundingClientRect();
        return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
      }, selector);
      if (!rect) throw new Error(`missing interactive mini player control: ${selector}`);
      await page.mouse.click(rect.x, rect.y);
    };
    const dragRect = await page.evaluate(() => {
      const player = window.__QWEN_READER_TEST_ROOT__?.querySelector('[data-role="mini-player"]');
      if (!player) return null;
      const bounds = player.getBoundingClientRect();
      return { x: bounds.left + 18, y: bounds.top + 18 };
    });
    if (!dragRect) throw new Error('missing mini player for real pointer drag');
    await page.mouse.move(dragRect.x, dragRect.y);
    await page.mouse.down();
    await page.mouse.move(Math.max(2, dragRect.x - 90), Math.max(2, dragRect.y - 90), { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    await clickShadowButton('[data-role="mini-full-controls"] [data-action="play-toggle"]');
    await page.waitForFunction(() => window.__QWEN_READER_TEST_ROOT__?.querySelector('[data-role="mini-player"]')?.classList.contains('is-paused'));
    await clickShadowButton('[data-role="mini-full-controls"] [data-action="play-toggle"]');
    await page.waitForFunction(() => !window.__QWEN_READER_TEST_ROOT__?.querySelector('[data-role="mini-player"]')?.classList.contains('is-paused'));
    await clickShadowButton('[data-action="toggle-mini-size"]');
    await page.waitForFunction(() => window.__QWEN_READER_TEST_ROOT__?.querySelector('[data-role="mini-player"]')?.classList.contains('is-minimized'));
    await clickShadowButton('[data-action="toggle-mini-size"]');
    await page.waitForFunction(() => !window.__QWEN_READER_TEST_ROOT__?.querySelector('[data-role="mini-player"]')?.classList.contains('is-minimized'));
    await page.evaluate(() => window.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -120 })));
    await page.waitForFunction(() => !window.__QWEN_READER_TEST_ROOT__?.querySelector('[data-role="mini-full-controls"] [data-action="resume-follow"]')?.disabled);
    await clickShadowButton('[data-role="mini-full-controls"] [data-action="resume-follow"]');
    await page.waitForFunction(() => window.__QWEN_READER_TEST_ROOT__?.querySelector('[data-role="mini-full-controls"] [data-action="resume-follow"]')?.disabled);
    await page.screenshot({ path: path.join(output, name), fullPage: true });
    screenshotCaptured = true;
    await page.evaluate(() => {
      const current = window.__qrHarness.savedSettings || {};
      window.__qrHarness.storageListener({ qwenReaderSettings: { newValue: { ...current, showFloatingPlayer: false, interactionVersion: 3 } } }, 'local');
    });
    await page.waitForFunction(() => !window.__QWEN_READER_TEST_ROOT__?.querySelector('[data-role="mini-player"]')?.classList.contains('is-visible'));
    await page.evaluate(() => {
      const current = window.__qrHarness.savedSettings || {};
      window.__qrHarness.storageListener({ qwenReaderSettings: { newValue: { ...current, showFloatingPlayer: true, interactionVersion: 3 } } }, 'local');
    });
    await page.waitForFunction(() => window.__QWEN_READER_TEST_ROOT__?.querySelector('[data-role="mini-player"]')?.classList.contains('is-visible'));
  }
  await page.waitForTimeout(350);
  const result = await page.locator('#test-result').textContent();
  if (!screenshotCaptured) await page.screenshot({ path: path.join(output, name), fullPage: true });
  await page.close();
  return result;
}

const readerPlaying = await captureReaderHarness('reader-playing.png', '?audit=playing');
const readerMinimized = await captureReaderHarness('reader-minimized.png', '?audit=minimized');
const readerStopped = await captureReaderHarness('reader-stopped.png', '');

let actionPopup = null;
let actionPopupMode = 'direct-extension-page';
let actionPopupError = null;
try {
  // Register the page listener before openPopup. Chromium creates the action
  // popup asynchronously and otherwise the new target can be missed.
  const popupPromise = context.waitForEvent('page', { timeout: 10000 });
  await worker.evaluate(() => chrome.action.openPopup());
  actionPopup = await popupPromise;
  actionPopupMode = 'native-action-popup';
  await actionPopup.waitForLoadState('domcontentloaded').catch(() => {});
  await actionPopup.screenshot({ path: path.join(output, 'popup-action.png'), fullPage: true });
} catch (error) {
  actionPopupError = error && error.message ? error.message : String(error);
  // Edge versions or Playwright builds that do not expose openPopup still get
  // an accurate extension-origin screenshot. Popup anchoring and close-on-
  // blur remain an explicitly documented manual smoke-test boundary.
  actionPopup = await context.newPage();
  await actionPopup.setViewportSize({ width: 390, height: 600 });
  await actionPopup.goto(`${extensionOrigin}/popup.html`, { waitUntil: 'domcontentloaded' });
  await actionPopup.screenshot({ path: path.join(output, 'popup-action.png'), fullPage: true });
}

const report = {
  extensionId,
  extensionOrigin,
  profile,
  output,
  actionPopupMode,
  actionPopupError,
  readerHarness: { playing: readerPlaying, minimized: readerMinimized, stopped: readerStopped },
  manualSmokeTest: actionPopupMode === 'native-action-popup'
    ? '仍需人工确认工具栏锚点和失焦自动关闭。'
    : 'openPopup 自动化不可用；需人工确认工具栏锚点和失焦自动关闭。',
};
await fs.writeFile(path.join(output, 'preview-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`PREVIEW PASS mode=${actionPopupMode} extension=${extensionId} output=${output}`);
if (actionPopupError) console.log(`ACTION POPUP FALLBACK ${actionPopupError}`);

if (!keepOpen) {
  await context.close();
} else {
  console.log('Edge preview remains open (--keep-open). Close it before rerunning with the same profile.');
}
