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
const edge = args.edge || process.env.QWEN_EDGE || (
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

const lab = await context.newPage();
await lab.goto(`${extensionOrigin}/popup-lab.html`, { waitUntil: 'domcontentloaded' });
await lab.screenshot({ path: path.join(output, 'popup-lab.png'), fullPage: true });

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
await captureSettings('settings-voices.png', 'voices', '#record-pane');

const settingsSmoke = await context.newPage();
await settingsSmoke.goto(`${extensionOrigin}/voice-studio.html#reader`, { waitUntil: 'domcontentloaded' });
await settingsSmoke.selectOption('[name="readingFocus"]', 'line');
await settingsSmoke.waitForFunction(async () => {
  const saved = await chrome.storage.local.get('qwenReaderSettings');
  return saved.qwenReaderSettings?.readingFocus === 'line';
}, null, { timeout: 10000 });
await settingsSmoke.click('[data-settings-section="voices"]');
await settingsSmoke.click('#import-tab');
await settingsSmoke.waitForSelector('#import-pane', { state: 'visible' });
await settingsSmoke.screenshot({ path: path.join(output, 'settings-voice-upload.png'), fullPage: true });
await settingsSmoke.close();

// The page harness loads the production content reader and its real CSS in a
// deterministic article fixture. This captures the other half of B+C: the
// active-only mini player plus the inline author/voice and word indicators.
const harnessBase = pathToFileURL(path.join(extensionRoot, 'tests', 'browser', 'ui-harness.html')).href;
async function captureReaderHarness(name, query) {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${harnessBase}${query || ''}`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.documentElement.dataset.testStatus === 'pass', null, { timeout: 15000 });
  await page.waitForTimeout(350);
  const result = await page.locator('#test-result').textContent();
  await page.screenshot({ path: path.join(output, name), fullPage: true });
  await page.close();
  return result;
}

const readerPlaying = await captureReaderHarness('reader-playing.png', '?audit=playing');
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
  readerHarness: { playing: readerPlaying, stopped: readerStopped },
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
