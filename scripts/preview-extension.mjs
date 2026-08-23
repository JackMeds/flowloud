import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    if (key === 'keep-open' || key === 'reuse-profile') {
      values[key] = true;
      continue;
    }
    values[key] = argv[index + 1];
    index += 1;
  }
  return values;
}

const args = parseArgs(process.argv.slice(2));

function createDigitalPdf(text = 'Digital PDF text layer') {
  const escaped = String(text).replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
  const stream = `BT /F1 18 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
  ];
  let source = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(source, 'latin1'));
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(source, 'latin1');
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  source += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(source, 'latin1');
}

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDirectory, '..');
const extensionRoot = path.resolve(args['extension-root'] || path.join(repoRoot, 'extension'));
const profile = path.resolve(args.profile || path.join(repoRoot, '.tmp-popup-preview-edge'));
const output = path.resolve(args.output || path.join(profile, 'artifacts'));
const instrumentedExtensionRoot = path.join(profile, 'extension-e2e');
const configuredBrowser = args.edge || process.env.FLOWLOUD_BROWSER || process.env.QWEN_EDGE || '';
const browserCandidates = [
  configuredBrowser,
  process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
].filter(Boolean);
let edge = '';
for (const candidate of browserCandidates) {
  try {
    await fs.access(candidate);
    edge = candidate;
    break;
  } catch (_) {}
}
if (!edge) throw new Error(`No supported Edge/Chrome executable was found. Checked: ${browserCandidates.join(', ')}`);
if (!args['reuse-profile']) await fs.rm(profile, { recursive: true, force: true });
await fs.mkdir(output, { recursive: true });
await fs.rm(instrumentedExtensionRoot, { recursive: true, force: true });
await fs.cp(extensionRoot, instrumentedExtensionRoot, { recursive: true });
const harnessRelativePath = path.join('tests', 'browser', 'ui-harness.html');
const instrumentedHarness = path.join(instrumentedExtensionRoot, harnessRelativePath);
try {
  await fs.access(instrumentedHarness);
} catch (_) {
  // Store packages intentionally exclude tests. Copy only the deterministic
  // HTML harness beside the packaged production assets so its relative
  // reader.js/reader.css references still exercise the exact release files.
  await fs.mkdir(path.dirname(instrumentedHarness), { recursive: true });
  await fs.copyFile(path.join(repoRoot, 'extension', harnessRelativePath), instrumentedHarness);
}
const instrumentedManifestPath = path.join(instrumentedExtensionRoot, 'manifest.json');
const instrumentedManifest = JSON.parse(await fs.readFile(instrumentedManifestPath, 'utf8'));
// Browser automation cannot create the user gesture that grants activeTab.
// The copied test-only manifest therefore grants capture access; all fixtures
// still use loopback, and release-gate rejects required hosts in the real package.
instrumentedManifest.host_permissions = ['<all_urls>'];
await fs.writeFile(instrumentedManifestPath, `${JSON.stringify(instrumentedManifest, null, 2)}\n`, 'utf8');

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

const siteServer = http.createServer((request, response) => {
  if (request.url === '/v1/chat/completions' && request.method === 'POST') {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', async () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const content = body.messages?.[0]?.content;
        const prompt = Array.isArray(content) ? content.map((item) => item?.text || '').join('\n') : String(content || '');
        if (prompt.includes('delay-smoke')) await new Promise((resolve) => setTimeout(resolve, 4000));
        let result;
        if (prompt.includes('请忠实识别图像')) {
          result = { document: { title: 'OCR fixture', sourceType: 'image', blocks: [{ id: 'page-1-block-1', kind: 'paragraph', text: '浏览器图片 OCR 结果', page: 1 }], warnings: [] } };
        } else {
          const input = JSON.parse(prompt.slice(prompt.lastIndexOf('输入：') + 3));
          result = { translation: { sourceLanguage: 'auto', targetLanguage: 'zh-CN', blocks: input.map((item) => ({ id: item.id, translatedText: `译：${item.text}` })), warnings: [] } };
        }
        response.setHeader('content-type', 'application/json; charset=utf-8');
        response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }));
      } catch (error) {
        response.statusCode = 500;
        response.end(JSON.stringify({ error: { message: error?.message || String(error) } }));
      }
    });
    return;
  }
  const pageName = request.url === '/b' ? '页面 B' : '页面 A';
  const paragraphs = Array.from({ length: 16 }, (_, index) => `<p>${pageName}第 ${index + 1} 段用于持续朗读。这里包含第一句话，也包含第二句话，确保全局接管发生时旧会话仍在播放。</p>`).join('');
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${pageName} · Flowloud E2E</title></head><body><main><article><h1>${pageName}</h1>${paragraphs}</article></main></body></html>`);
});
await new Promise((resolve, reject) => {
  siteServer.once('error', reject);
  siteServer.listen(0, '127.0.0.1', resolve);
});
siteServer.unref();
const siteAddress = siteServer.address();
const siteOrigin = `http://127.0.0.1:${siteAddress.port}`;

let context = null;
const keepOpen = Boolean(args['keep-open']);
try {
context = await chromium.launchPersistentContext(profile, {
  headless: false,
  executablePath: edge,
  args: [
    `--disable-extensions-except=${instrumentedExtensionRoot}`,
    `--load-extension=${instrumentedExtensionRoot}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--auto-accept-browser-permission-prompts',
  ],
});
console.log(`PREVIEW STAGE browser-launched ${path.basename(edge)}`);
const popupDiagnostics = [];
context.on('page', (page) => {
  page.on('pageerror', (error) => popupDiagnostics.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') popupDiagnostics.push(`console: ${message.text()}`);
  });
});

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
    await chrome.storage.local.set({ [key]: { ...current, schemaVersion: 6, providerVersion: 4, activeProviderId: 'browser-system', providerId: 'browser-system', providerVoices: { ...(current.providerVoices || {}), 'browser-system': '' }, voiceAssignmentsByProvider: assignments } });
  });
}
await selectSystemProvider();

const e2eController = await context.newPage();
await e2eController.goto(`${extensionOrigin}/options-react.html`, { waitUntil: 'domcontentloaded' });
const runtimeMessage = (message) => e2eController.evaluate((payload) => chrome.runtime.sendMessage(payload), message);
async function withStageTimeout(label, operation, timeout = 15000) {
  console.log(`PREVIEW STAGE ${label}-start`);
  let timeoutId;
  try {
    return await Promise.race([
      operation(),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`Timed out during preview stage: ${label}`)), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}
async function activeTabId() {
  return worker.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id || null);
}
async function waitForPlayback(predicate, description) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const response = await runtimeMessage({ type: 'playback:global:get' });
    const playback = response?.playback || {};
    if (predicate(playback)) return playback;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error(`Timed out waiting for ${description}`);
}
async function activateReader(page) {
  await page.bringToFront();
  const tabId = await activeTabId();
  if (!Number.isInteger(tabId)) throw new Error('Unable to resolve active E2E tab id.');
  let snapshot = await runtimeMessage({ type: 'reader:snapshot:get', tabId, scope: 'current' });
  if (snapshot?.ok === false) throw new Error(`Unable to inject reader: ${JSON.stringify(snapshot.error)}`);
  await page.waitForSelector('#qwen-reader-host', { state: 'attached', timeout: 10000 });
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && !(Number(snapshot?.segmentCount || snapshot?.total) > 0 && snapshot?.status !== 'extracting')) {
    await new Promise((resolve) => setTimeout(resolve, 120));
    snapshot = await runtimeMessage({ type: 'reader:snapshot:get', tabId, scope: 'current' });
  }
  if (!(Number(snapshot?.segmentCount || snapshot?.total) > 0)) {
    throw new Error(`Reader did not finish extracting the E2E article: ${JSON.stringify(snapshot)}`);
  }
  return tabId;
}

const sourceA = await context.newPage();
await withStageTimeout('source-a-navigation', () => sourceA.goto(`${siteOrigin}/a`, { waitUntil: 'domcontentloaded' }));
const tabAId = await withStageTimeout('source-a-activation', () => activateReader(sourceA));
const startA = await withStageTimeout('source-a-command', () => runtimeMessage({ type: 'reader:command', tabId: tabAId, command: 'play-toggle', scope: 'current', takeover: true }));
if (startA?.ok === false) throw new Error(`Unable to start source A: ${JSON.stringify(startA.error)}`);
await waitForPlayback((playback) => playback.active === true && playback.sourceTabId === tabAId, 'source A playback');
console.log('PREVIEW STAGE source-a-playing');

const sourceB = await context.newPage();
await withStageTimeout('source-b-navigation', () => sourceB.goto(`${siteOrigin}/b`, { waitUntil: 'domcontentloaded' }));
const tabBId = await withStageTimeout('source-b-activation', () => activateReader(sourceB));
const startB = await withStageTimeout('source-b-command', () => runtimeMessage({ type: 'reader:command', tabId: tabBId, command: 'play-toggle', scope: 'current', takeover: true }));
if (startB?.ok === false) throw new Error(`Unable to start source B: ${JSON.stringify(startB.error)}`);
const takeover = await waitForPlayback((playback) => playback.active === true && playback.sourceTabId === tabBId, 'source B takeover');
const sourceASnapshot = await runtimeMessage({ type: 'reader:snapshot:get', tabId: tabAId, scope: 'current' });
if (['loading', 'playing', 'paused'].includes(String(sourceASnapshot?.status || ''))) {
  throw new Error(`Source A remained active after source B takeover: ${JSON.stringify(sourceASnapshot)}`);
}
console.log('PREVIEW STAGE cross-tab-takeover');

await sourceB.goto(`${siteOrigin}/b?full-navigation=1`, { waitUntil: 'domcontentloaded' });
await waitForPlayback((playback) => playback.active !== true, 'full-navigation cleanup');

await sourceA.bringToFront();
const restartA = await runtimeMessage({ type: 'reader:command', tabId: tabAId, command: 'play-toggle', scope: 'current', takeover: true });
if (restartA?.ok === false) throw new Error(`Unable to restart source A: ${JSON.stringify(restartA.error)}`);
await waitForPlayback((playback) => playback.active === true && playback.sourceTabId === tabAId, 'source A restart');
await sourceA.close();
await waitForPlayback((playback) => playback.active !== true, 'source-tab close cleanup');
await sourceB.close();
await e2eController.close();
const globalPlaybackE2E = {
  sourceATabId: tabAId,
  sourceBTabId: tabBId,
  takeoverSourceTabId: takeover.sourceTabId,
  oldSourceStopped: true,
  navigationStopped: true,
  sourceCloseStopped: true,
};
console.log('PREVIEW STAGE lifecycle-cleanup');

const reactSettings = await context.newPage();
await reactSettings.setViewportSize({ width: 1280, height: 900 });
await reactSettings.goto(`${extensionOrigin}/options-react.html`, { waitUntil: 'domcontentloaded' });
await reactSettings.waitForSelector('.fl-workspace', { state: 'visible', timeout: 10000 });
const reactSettingsAudit = await reactSettings.locator('.fl-workspace').evaluate((root) => ({
  mock: root.textContent?.includes('MOCK') === true,
  tabs: Array.from(root.querySelectorAll('[role="tab"]')).map((tab) => tab.textContent?.trim()),
  hasSecretInput: false,
}));
if (reactSettingsAudit.mock || reactSettingsAudit.tabs.length !== 8 || !reactSettingsAudit.tabs.includes('OCR 与翻译')) {
  throw new Error(`React settings did not load as a production surface: ${JSON.stringify(reactSettingsAudit)}`);
}
await reactSettings.getByRole('tab', { name: '语音来源' }).click();
await reactSettings.waitForSelector('input[type="password"]', { state: 'visible', timeout: 5000 });
reactSettingsAudit.hasSecretInput = await reactSettings.locator('input[type="password"]').count() >= 2;
if (!reactSettingsAudit.hasSecretInput) throw new Error('React settings is missing protected Provider credential inputs.');
await reactSettings.screenshot({ path: path.join(output, 'options-react-engine.png'), fullPage: true });
await reactSettings.close();
console.log('PREVIEW STAGE react-settings');

await worker.evaluate(async ({ baseUrl }) => {
  const key = 'qwenReaderSettings';
  const saved = await chrome.storage.local.get(key);
  const profile = {
    id: 'browser-workbench-smoke', label: '浏览器工作台夹具', protocol: 'openai-chat', baseUrl,
    model: 'fixture-model', authHeader: '', authScheme: '', timeoutMs: 15000, rememberSecret: false,
    capabilities: { visionOcr: true, textTranslation: true, structuredOutput: true, pdfInput: false, streaming: false },
  };
  await chrome.storage.local.set({ [key]: {
    ...(saved[key] || {}), schemaVersion: 6, aiProfiles: [profile],
    aiProfileSelections: { ocr: profile.id, translation: profile.id },
  } });
}, { baseUrl: siteOrigin });

const workbench = await context.newPage();
await workbench.setViewportSize({ width: 1440, height: 960 });
await workbench.goto(`${extensionOrigin}/document-workbench.html`, { waitUntil: 'domcontentloaded' });
await workbench.waitForSelector('.fl-document-workbench', { state: 'visible', timeout: 10000 });
const workbenchAudit = {
  sources: await workbench.locator('.fl-source-buttons button').allTextContents(),
  workflows: await workbench.locator('.fl-workflow-buttons button').allTextContents(),
  pasteBlocks: 0,
  imageOcr: false,
  digitalPdf: false,
  cancellation: false,
  screenshotSeed: false,
  currentPage: false,
};
if (workbenchAudit.sources.length !== 5 || workbenchAudit.workflows.length !== 3) throw new Error(`Document workbench inputs/workflows are incomplete: ${JSON.stringify(workbenchAudit)}`);

await workbench.getByRole('button', { name: '粘贴文本' }).click();
await workbench.locator('textarea[placeholder*="粘贴需要翻译"]').fill('First paragraph.\n\nSecond paragraph.');
await workbench.getByRole('button', { name: '仅翻译' }).click();
await workbench.getByRole('button', { name: '开始处理' }).click();
await workbench.waitForFunction(() => document.querySelectorAll('.fl-document-block').length === 2 && document.body.textContent?.includes('翻译完成'), null, { timeout: 15000 });
workbenchAudit.pasteBlocks = await workbench.locator('.fl-document-block').count();
await workbench.locator('.fl-document-block textarea').first().fill('Edited source block.');
await workbench.getByRole('button', { name: '重试本段翻译' }).first().click();
await workbench.waitForFunction(() => document.body.textContent?.includes('单块翻译已更新'), null, { timeout: 10000 });

await workbench.locator('.fl-document-block textarea').first().fill('delay-smoke');
await workbench.getByRole('button', { name: '开始处理' }).click();
await workbench.getByRole('button', { name: '取消' }).click();
await workbench.waitForFunction(() => !Array.from(document.querySelectorAll('button')).some((button) => button.textContent?.includes('取消')), null, { timeout: 10000 });
workbenchAudit.cancellation = true;

await workbench.getByRole('button', { name: '上传图片' }).click();
await workbench.locator('input[type="file"][accept*="image/png"]').setInputFiles(path.join(extensionRoot, 'assets', 'flowloud-128.png'));
await workbench.waitForFunction(() => document.body.textContent?.includes('已载入图片'), null, { timeout: 5000 });
await workbench.getByRole('button', { name: '仅识别' }).click();
await workbench.getByRole('button', { name: '开始处理' }).click();
await workbench.waitForFunction(() => document.body.textContent?.includes('浏览器图片 OCR 结果'), null, { timeout: 15000 });
workbenchAudit.imageOcr = true;

const digitalPdfPath = path.join(output, 'workbench-digital.pdf');
await fs.writeFile(digitalPdfPath, createDigitalPdf());
await workbench.getByRole('button', { name: '上传 PDF' }).click();
await workbench.locator('input[type="file"][accept*="application/pdf"]').setInputFiles(digitalPdfPath);
try {
  await workbench.waitForFunction(() => document.body.textContent?.includes('1 页有文字层'), null, { timeout: 15000 });
} catch (error) {
  const pdfStatus = await workbench.locator('.fl-document-status').innerText().catch(() => 'missing PDF status');
  throw new Error(`${error.message}; PDF status=${JSON.stringify(pdfStatus)}`);
}
await workbench.getByRole('button', { name: '开始处理' }).click();
await workbench.waitForFunction(() => document.body.textContent?.includes('Digital PDF text layer'), null, { timeout: 10000 });
workbenchAudit.digitalPdf = true;
await workbench.screenshot({ path: path.join(output, 'document-workbench.png'), fullPage: true });
await workbench.close();

const workbenchSource = await context.newPage();
await workbenchSource.goto(`${siteOrigin}/a`, { waitUntil: 'domcontentloaded' });
await workbenchSource.bringToFront();
const workbenchSourceTabId = await activeTabId();
const workbenchController = await context.newPage();
await workbenchController.goto(`${extensionOrigin}/options-react.html`, { waitUntil: 'domcontentloaded' });
const sendWorkbenchMessage = (message) => workbenchController.evaluate((payload) => chrome.runtime.sendMessage(payload), message);
await workbenchSource.bringToFront();
const openedWorkbench = await sendWorkbenchMessage({ type: 'document:workspace:open', tabId: workbenchSourceTabId });
if (openedWorkbench?.ok === false) throw new Error(`Could not open seeded document workbench: ${JSON.stringify(openedWorkbench.error)}`);
await workbenchSource.waitForTimeout(500);
const seedCheck = await sendWorkbenchMessage({ type: 'document:workspace:seed' });
if (!seedCheck?.seed?.screenshotDataUrl) throw new Error(`Document workbench did not capture a screenshot seed: ${JSON.stringify(seedCheck)}`);
for (const existing of context.pages().filter((page) => page.url().includes('/document-workbench.html'))) await existing.close();
const seededWorkbench = await context.newPage();
await seededWorkbench.goto(`${extensionOrigin}/document-workbench.html?sourceTabId=${workbenchSourceTabId}`, { waitUntil: 'domcontentloaded' });
await seededWorkbench.waitForLoadState('domcontentloaded');
await seededWorkbench.getByRole('button', { name: '网页截图' }).click();
await seededWorkbench.waitForSelector('img[alt="网页可见区域截图预览"]', { state: 'visible', timeout: 10000 });
workbenchAudit.screenshotSeed = true;
await seededWorkbench.getByRole('button', { name: '当前网页' }).click();
await seededWorkbench.getByRole('button', { name: '提取网页正文' }).click();
await seededWorkbench.waitForFunction(() => document.querySelectorAll('.fl-document-block').length > 0, null, { timeout: 15000 });
workbenchAudit.currentPage = true;
await seededWorkbench.close();
await workbenchController.close();
await workbenchSource.close();
console.log('PREVIEW STAGE document-workbench');

let popupLabMode = 'excluded-from-release';
try {
  await fs.access(path.join(extensionRoot, 'popup-lab.html'));
  popupLabMode = 'audited';
  const lab = await context.newPage();
  await lab.goto(`${extensionOrigin}/popup-lab.html`, { waitUntil: 'domcontentloaded' });
  await lab.screenshot({ path: path.join(output, 'popup-lab.png'), fullPage: true });
  await lab.locator('.qr-lab-card .qr-popup-root').first().screenshot({ path: path.join(output, 'popup-playing-390.png') });
  const popupBounds = await lab.locator('.qr-lab-card .qr-popup').first().boundingBox();
  if (!popupBounds || popupBounds.width > 390.5 || popupBounds.height > 600.5) throw new Error(`Popup exceeds release bounds: ${JSON.stringify(popupBounds)}`);
  const transportSizes = await lab.locator('.qr-lab-card').first().locator('.qr-controls .qr-control').evaluateAll((items) => items.map((item) => ({ width: item.getBoundingClientRect().width, height: item.getBoundingClientRect().height })));
  if (transportSizes.some((item) => item.width < 40 || item.height < 40)) throw new Error(`Popup transport target is below 40px: ${JSON.stringify(transportSizes)}`);
  const popupState = await lab.locator('.qr-lab-card .qr-popup-root').first().evaluate((root) => {
    const popup = root.querySelector('.qr-popup');
    popup.scrollTop = 160;
    const before = popup.scrollTop;
    const beforeScrollHeight = popup.scrollHeight;
    const model = {
      title: '如何让浏览器朗读真正融入阅读？',
      sourceLabel: 'V2EX · 当前主题',
      authors: [
        { id: 'op', name: '楼主', voice: '邵思萌', count: 8, isOp: true },
        { id: 'reply-a', name: 'Mina', voice: '清朗', count: 4 },
        { id: 'reply-b', name: '远山', voice: '温和', count: 2 },
        { id: 'reply-c', name: 'Terry', voice: '清朗', count: 1 },
      ],
      settings: { readingMode: 'content', activeProviderId: 'browser-system', playbackRate: 1, showFloatingPlayer: true, clickToRead: false, preset: 'op-exclusive' },
      snapshot: { status: 'playing', index: 2, segmentCount: 4, current: { authorName: '远山', text: '复杂的作者配音不该挤在一个瞬时小窗里。' } },
    };
    window.QwenPopupView.mountPopup(root, model);
    return {
      before,
      after: popup.scrollTop,
      stable: root.dataset.popupView === 'reader',
      beforeScrollHeight,
      clientHeight: popup.clientHeight,
      scrollHeight: popup.scrollHeight,
    };
  });
  if (!popupState.stable || Math.abs(popupState.before - popupState.after) > 1) throw new Error(`Popup scroll state was not preserved: ${JSON.stringify(popupState)}`);
  const primary = lab.locator('.qr-lab-card .qr-page-card .qr-control-primary').first();
  await primary.hover();
  const primaryColors = await primary.evaluate((node) => {
    const style = getComputedStyle(node);
    return { color: style.color, background: style.backgroundColor };
  });
  if (primaryColors.color !== 'rgb(255, 255, 255)' || primaryColors.background === 'rgb(246, 243, 237)') {
    throw new Error(`Primary hover state is not readable: ${JSON.stringify(primaryColors)}`);
  }
  await lab.close();
} catch (error) {
  if (popupLabMode === 'audited') throw error;
}

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
await settingsSmoke.selectOption('[name="activeProviderId"]', 'local-service');
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
const harnessBase = pathToFileURL(instrumentedHarness).href;
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
      const found = await page.evaluate((buttonSelector) => {
        const button = window.__QWEN_READER_TEST_ROOT__?.querySelector(buttonSelector);
        if (!button) return false;
        button.click();
        return true;
      }, selector);
      if (!found) throw new Error(`missing interactive mini player control: ${selector}`);
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
    await page.waitForFunction(() => ['left', 'right'].includes(window.__QWEN_READER_TEST_ROOT__?.querySelector('[data-role="mini-player"]')?.dataset.edge));
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
const zoomMatrix = {};
for (const zoom of [0.8, 1, 1.5, 2]) {
  zoomMatrix[String(zoom)] = await captureReaderHarness(`reader-point-read-${String(zoom).replace('.', '-')}.png`, `?zoom=${zoom}`);
}
console.log('PREVIEW STAGE reader-harness-and-zoom');

let actionPopup = null;
let actionPopupMode = 'direct-extension-page';
let actionPopupError = null;
const releaseManifest = JSON.parse(await fs.readFile(path.join(extensionRoot, 'manifest.json'), 'utf8'));
const releasePopupPath = String(releaseManifest.action?.default_popup || 'popup-react.html');
try {
  // Register the page listener before openPopup. Chromium creates the action
  // popup asynchronously and otherwise the new target can be missed.
  const popupPromise = context.waitForEvent('page', { timeout: 10000 });
  await worker.evaluate(() => chrome.action.openPopup());
  actionPopup = await popupPromise;
  actionPopupMode = 'native-action-popup';
  await actionPopup.waitForLoadState('domcontentloaded').catch(() => {});
} catch (error) {
  actionPopupError = error && error.message ? error.message : String(error);
  // Edge versions or Playwright builds that do not expose openPopup still get
  // an accurate extension-origin screenshot. Popup anchoring and close-on-
  // blur remain an explicitly documented manual smoke-test boundary.
  actionPopup = await context.newPage();
  await actionPopup.setViewportSize({ width: 390, height: 600 });
  await actionPopup.goto(`${extensionOrigin}/${releasePopupPath}`, { waitUntil: 'domcontentloaded' });
}

let popupReady = false;
if (actionPopup && !actionPopup.isClosed()) {
  try {
    await actionPopup.waitForSelector('.fl-console', { state: 'visible', timeout: 4000 });
    popupReady = true;
  } catch (error) {
    const detail = error && error.message ? error.message : String(error);
    actionPopupError = actionPopupError ? `${actionPopupError}; ${detail}` : detail;
  }
}
if (!popupReady) {
  await actionPopup?.close().catch(() => {});
  actionPopupMode = 'direct-extension-page';
  actionPopup = await context.newPage();
  await actionPopup.setViewportSize({ width: 420, height: 620 });
  await actionPopup.goto(`${extensionOrigin}/${releasePopupPath}`, { waitUntil: 'domcontentloaded' });
  try {
    await actionPopup.waitForSelector('.fl-console', { state: 'visible', timeout: 10000 });
  } catch (error) {
    const url = actionPopup.url();
    const body = (await actionPopup.locator('body').innerText().catch(() => '')).slice(0, 1000);
    throw new Error(`${error.message}; url=${url}; body=${JSON.stringify(body)}; diagnostics=${popupDiagnostics.join(' | ')}`);
  }
}
await actionPopup.waitForTimeout(1100);
const reactPopupAudit = await actionPopup.locator('.fl-console').evaluate((root) => {
  const bounds = root.getBoundingClientRect();
  const tabs = Array.from(root.querySelectorAll('[role="tab"]'));
  const transport = Array.from(root.querySelectorAll('.fl-transport button')).map((button) => {
    const rect = button.getBoundingClientRect();
    return { width: rect.width, height: rect.height, label: button.getAttribute('aria-label') || '' };
  });
  return {
    width: bounds.width,
    height: bounds.height,
    mock: root.textContent?.includes('MOCK') === true,
    tabs: tabs.map((tab) => tab.textContent?.trim()),
    transport,
    hasOptions: Boolean(root.querySelector('button[aria-label="全部设置"], button')),
  };
});
if (reactPopupAudit.mock) throw new Error('Release Popup unexpectedly rendered the Storybook MOCK state.');
if (reactPopupAudit.width > 420.5 || reactPopupAudit.height > 620.5) throw new Error(`React Popup exceeds release bounds: ${JSON.stringify(reactPopupAudit)}`);
if (reactPopupAudit.tabs.length !== 4) throw new Error(`React Popup must expose four aligned top-level tabs: ${JSON.stringify(reactPopupAudit.tabs)}`);
if (reactPopupAudit.transport.length !== 3 || reactPopupAudit.transport.some((item) => item.width < 44 || item.height < 44)) {
  throw new Error(`React Popup transport targets must remain at least 44px: ${JSON.stringify(reactPopupAudit.transport)}`);
}
await actionPopup.screenshot({ path: path.join(output, 'popup-action.png'), fullPage: true });

const report = {
  extensionId,
  extensionOrigin,
  profile,
  output,
  actionPopupMode,
  actionPopupError,
  popupLabMode,
  reactPopupAudit,
  reactSettingsAudit,
  workbenchAudit,
  globalPlaybackE2E,
  e2ePermissionMode: 'temporary-test-host-permission',
  readerHarness: { playing: readerPlaying, minimized: readerMinimized, stopped: readerStopped, zoomMatrix },
  manualSmokeTest: actionPopupMode === 'native-action-popup'
    ? '仍需人工确认工具栏锚点和失焦自动关闭。'
    : 'openPopup 自动化不可用；需人工确认工具栏锚点和失焦自动关闭。',
};
await fs.writeFile(path.join(output, 'preview-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`PREVIEW PASS mode=${actionPopupMode} extension=${extensionId} output=${output}`);
if (actionPopupError) console.log(`ACTION POPUP FALLBACK ${actionPopupError}`);

if (keepOpen) {
  console.log('Edge preview remains open (--keep-open). Close it before rerunning with the same profile.');
}
} finally {
  if (!keepOpen) {
    await context?.close().catch(() => {});
    siteServer.closeAllConnections?.();
    await new Promise((resolve) => siteServer.close(resolve));
    await fs.rm(instrumentedExtensionRoot, { recursive: true, force: true }).catch(() => {});
  }
}
