import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from './playwright-runtime.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDirectory, '..');
const sourceExtension = path.join(repoRoot, 'extension');
const smokeRoot = path.join(repoRoot, '.tmp-reader-refresh-smoke');
const smokeExtension = path.join(smokeRoot, 'extension');

const browserCandidates = [
  process.env.FLOWLOUD_BROWSER,
  process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
].filter(Boolean);

let browserPath = '';
for (const candidate of browserCandidates) {
  try {
    await fs.access(candidate);
    browserPath = candidate;
    break;
  } catch (_) {}
}
if (!browserPath) throw new Error('未找到 Edge 或 Chrome。');

const { chromium } = loadPlaywright();

const server = http.createServer((_request, response) => {
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>刷新恢复测试</title></head><body><main><article><h1>刷新恢复测试</h1><p>这是第一句话。这是第二句话。悬浮播放器应当在刷新后自动出现。</p></article></main></body></html>`);
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
server.unref();
const address = server.address();
const testUrl = `http://127.0.0.1:${address.port}/article`;

let context;
try {
  await fs.rm(smokeRoot, { recursive: true, force: true });
  await fs.mkdir(smokeRoot, { recursive: true });
  await fs.cp(sourceExtension, smokeExtension, { recursive: true });
  const manifestPath = path.join(smokeExtension, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  // Test-only equivalent of a user-granted exact origin. The release gate
  // continues to reject required host permissions in the published manifest.
  manifest.host_permissions = ['<all_urls>'];
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  context = await chromium.launchPersistentContext(path.join(smokeRoot, 'profile'), {
    headless: false,
    executablePath: browserPath,
    args: [
      `--disable-extensions-except=${smokeExtension}`,
      `--load-extension=${smokeExtension}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
  await worker.evaluate(async () => {
    const key = 'qwenReaderSettings';
    const saved = await chrome.storage.local.get(key);
    await chrome.storage.local.set({ [key]: { ...(saved[key] || {}), showFloatingPlayer: true } });
    await chrome.storage.session.remove('qwenReaderEnabledTabsV1');
  });
  const extensionUrl = new URL(worker.url());
  const extensionOrigin = `${extensionUrl.protocol}//${extensionUrl.hostname}`;
  const controller = await context.newPage();
  await controller.goto(`${extensionOrigin}/options-react.html`, { waitUntil: 'domcontentloaded' });
  const result = await controller.evaluate(
    (origin) => chrome.runtime.sendMessage({ type: 'reader:site-access:register', origin }),
    `${new URL(testUrl).origin}/*`,
  );
  const scripts = await worker.evaluate(
    () => chrome.scripting.getRegisteredContentScripts({ ids: ['flowloud-reader-sites-v1'] }),
  );
  const registration = { result, scripts };
  if (registration.result?.ok !== true || registration.scripts?.[0]?.runAt !== 'document_idle') {
    throw new Error(`站点内容脚本登记失败：${JSON.stringify(registration)}`);
  }
  await controller.close();

  const page = await context.newPage();
  const initialStart = Date.now();
  await page.goto(testUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#qwen-reader-host', { state: 'attached', timeout: 5000 });
  const initialMs = Date.now() - initialStart;

  const refreshStart = Date.now();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#qwen-reader-host', { state: 'attached', timeout: 5000 });
  const refreshMs = Date.now() - refreshStart;
  if (initialMs > 5000 || refreshMs > 5000) {
    throw new Error(`悬浮播放器恢复过慢：initial=${initialMs}ms refresh=${refreshMs}ms`);
  }
  console.log(`READER REFRESH PASS initial=${initialMs}ms refresh=${refreshMs}ms popupOpened=false`);
} finally {
  await context?.close().catch(() => {});
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(smokeRoot, { recursive: true, force: true });
}
