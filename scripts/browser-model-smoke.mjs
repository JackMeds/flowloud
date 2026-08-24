import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from './playwright-runtime.mjs';

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    if (['reuse-profile', 'keep-cache'].includes(key)) values[key] = true;
    else { values[key] = argv[index + 1]; index += 1; }
  }
  return values;
}

const MODELS = Object.freeze({
  'kokoro-zh': Object.freeze({
    repoId: 'onnx-community/Kokoro-82M-v1.1-zh-ONNX',
    revision: '6cc0f0d2ebe369a68b0df87c2b65c1af8c0ac3e3',
    voice: 'zf_001',
    text: '你好，这是浏览器离线语音校验。',
  }),
});

const args = parseArgs(process.argv.slice(2));
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDirectory, '..');
const modelId = String(args.model || 'kokoro-zh');
const model = MODELS[modelId];
if (!model) throw new Error(`Unsupported model: ${modelId}. Use ${Object.keys(MODELS).join(' or ')}.`);
const mode = String(args.mode || 'all');
if (!['cancel', 'full', 'verify', 'all'].includes(mode)) throw new Error('Mode must be cancel, full, verify, or all.');
const profile = path.resolve(args.profile || path.join(repoRoot, `.tmp-browser-model-smoke-${modelId}`));
const output = path.resolve(args.output || path.join(profile, 'artifacts'));
const extensionRoot = path.resolve(args['extension-root'] || path.join(repoRoot, 'extension'));
const instrumentedRoot = path.join(profile, 'extension-e2e');
const timeoutMs = Math.max(60_000, Number(args['timeout-minutes'] || 35) * 60_000);
const dtype = String(args.dtype || 'fp32');
const device = String(args.device || 'wasm');
if (!['wasm', 'webgpu'].includes(device)) throw new Error('Device must be wasm or webgpu.');

if (!args['reuse-profile']) await fs.rm(profile, { recursive: true, force: true });
await fs.mkdir(output, { recursive: true });
await fs.rm(instrumentedRoot, { recursive: true, force: true });
await fs.cp(extensionRoot, instrumentedRoot, { recursive: true });
const manifestPath = path.join(instrumentedRoot, 'manifest.json');
const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
// Test-only required origins avoid an unautomatable Chromium permission bubble.
// The real release manifest retains optional origins and is checked separately.
manifest.host_permissions = [
  'https://huggingface.co/*',
  'https://*.huggingface.co/*',
  'https://*.hf.co/*',
];
await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

const configuredBrowser = args.browser || process.env.FLOWLOUD_BROWSER || '';
const browserCandidates = [
  configuredBrowser,
  process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
].filter(Boolean);
let executablePath = '';
for (const candidate of browserCandidates) {
  try { await fs.access(candidate); executablePath = candidate; break; } catch (_) {}
}
if (!executablePath) throw new Error(`Edge/Chrome not found. Checked: ${browserCandidates.join(', ')}`);

const { chromium } = loadPlaywright();
const report = {
  generatedAt: new Date().toISOString(),
  browser: executablePath,
  modelId,
  repoId: model.repoId,
  revision: model.revision,
  mode,
  dtype,
  device,
  cancellation: null,
  download: null,
  offlineVerify: null,
  offlineSynthesis: null,
  deletion: null,
  diagnostics: [],
};

async function launch() {
  const context = await chromium.launchPersistentContext(profile, {
    headless: false,
    executablePath,
    args: [
      `--disable-extensions-except=${instrumentedRoot}`,
      `--load-extension=${instrumentedRoot}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20_000 });
  const extensionId = new URL(worker.url()).hostname;
  const page = await context.newPage();
  page.on('pageerror', (error) => report.diagnostics.push(`pageerror: ${error.message}`));
  page.on('console', (message) => { if (message.type() === 'error') report.diagnostics.push(`console: ${message.text()}`); });
  await page.goto(`chrome-extension://${extensionId}/options-react.html`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    window.__flowloudModelSmoke = { progress: [], done: true, response: null };
    chrome.runtime.onMessage.addListener((message) => {
      if (message?.target !== 'flowloud:model' || message?.type !== 'provider:model:progress') return;
      window.__flowloudModelSmoke.progress.push({ requestId: message.requestId, progress: message.progress });
    });
  });
  return { context, page, extensionId };
}

async function configure(page) {
  const response = await page.evaluate(async ({ modelId: selectedId, selected, selectedDtype, selectedDevice }) => {
    const loaded = await chrome.runtime.sendMessage({ type: 'settings:get' });
    const settings = loaded.settings || {};
    settings.activeProviderId = 'browser-model';
    settings.providerId = 'browser-model';
    settings.providerSettings = settings.providerSettings || {};
    settings.providerSettings['browser-model'] = {
      ...(settings.providerSettings['browser-model'] || {}),
      modelId: selectedId,
      repoId: selected.repoId,
      revision: selected.revision,
      dtype: selectedDtype,
      device: selectedDevice,
      allowWasmFallback: true,
      downloaded: false,
    };
    return chrome.runtime.sendMessage({ type: 'settings:set', settings });
  }, { modelId, selected: model, selectedDtype: dtype, selectedDevice: device });
  if (response?.ok === false) throw new Error(response.error?.message || 'Could not configure browser model.');
}

async function startDownload(page, requestId) {
  await page.evaluate((id) => {
    window.__flowloudModelSmoke = { progress: [], done: false, response: null, requestId: id };
    chrome.runtime.sendMessage({ type: 'provider:model:download', requestId: id }).then(
      (response) => { window.__flowloudModelSmoke.done = true; window.__flowloudModelSmoke.response = response; },
      (error) => { window.__flowloudModelSmoke.done = true; window.__flowloudModelSmoke.response = { ok: false, error: { message: error?.message || String(error) } }; },
    );
  }, requestId);
}

async function waitForProgressOrCompletion(page, requestId) {
  await page.waitForFunction((id) => {
    const state = window.__flowloudModelSmoke;
    return state?.done || state?.progress?.some((item) => item.requestId === id);
  }, requestId, { timeout: Math.min(timeoutMs, 180_000), polling: 500 });
  return page.evaluate(() => window.__flowloudModelSmoke);
}

async function waitForDownload(page) {
  await page.waitForFunction(() => window.__flowloudModelSmoke?.done === true, null, { timeout: timeoutMs, polling: 1000 });
  return page.evaluate(() => window.__flowloudModelSmoke);
}

async function send(page, message) {
  return page.evaluate((body) => chrome.runtime.sendMessage(body), message);
}

async function cacheDiagnostics(page) {
  return page.evaluate(async () => {
    const names = await caches.keys();
    const result = [];
    for (const name of names) {
      const cache = await caches.open(name);
      const keys = await cache.keys();
      const jsonEntries = [];
      for (const key of keys.filter((item) => /\.json(?:$|\?)/i.test(item.url))) {
        const response = await cache.match(key);
        const body = await response?.clone().text();
        let parsed = null;
        try { parsed = JSON.parse(body || ''); } catch (_) {}
        jsonEntries.push({ url: key.url, status: response?.status, bytes: body?.length || 0, keys: parsed && typeof parsed === 'object' ? Object.keys(parsed).slice(0, 12) : [] });
      }
      result.push({
        name,
        entries: keys.length,
        tokenizerEntries: keys.map((item) => item.url).filter((url) => /tokenizer(?:_config)?\.json/i.test(url)),
        jsonEntries,
      });
    }
    return result;
  });
}

let session = await launch();
try {
  await configure(session.page);

  if (mode === 'verify') {
    report.diagnostics.push({ cacheBeforeVerify: await cacheDiagnostics(session.page) });
    await session.context.setOffline(true);
    const verified = await send(session.page, { type: 'provider:model:verify', requestId: `model-offline-verify-${Date.now()}` });
    report.offlineVerify = verified;
    report.diagnostics.push({ cacheAfterVerify: await cacheDiagnostics(session.page) });
    if (verified?.ok === false || verified?.result?.ready !== true) throw new Error(verified?.error?.message || verified?.result?.error?.message || 'Offline verification failed.');
  }

  if (mode === 'cancel' || mode === 'all') {
    const requestId = `model-cancel-smoke-${Date.now()}`;
    await startDownload(session.page, requestId);
    const observed = await waitForProgressOrCompletion(session.page, requestId);
    if (observed.done) {
      throw new Error(observed.response?.error?.message
        || 'Model download completed before cancellation could be exercised; use a clean profile.');
    }
    const cancelResponse = await send(session.page, { type: 'provider:model:cancel', requestId });
    const finished = await waitForDownload(session.page);
    report.cancellation = { cancelResponse, downloadResponse: finished.response, progressEvents: finished.progress.length };
    if (cancelResponse?.cancelled !== true) throw new Error('Cancellation did not match the active model request.');
    if (finished.response?.error?.code !== 'cancelled') throw new Error(`Cancelled download returned ${finished.response?.error?.code || 'no typed cancellation error'}.`);
    await send(session.page, { type: 'provider:model:delete', requestId: `model-clean-${Date.now()}` });
  }

  if (mode === 'full' || mode === 'all') {
    const requestId = `model-full-smoke-${Date.now()}`;
    await startDownload(session.page, requestId);
    const finished = await waitForDownload(session.page);
    report.download = { response: finished.response, progressEvents: finished.progress.length };
    const result = finished.response?.result || {};
    if (finished.response?.ok === false || result.ready !== true || result.state !== 'ready') {
      throw new Error(finished.response?.error?.message || result.error?.message || 'Model did not pass post-download offline verification.');
    }

    await session.context.close();
    session = await launch();
    await session.context.setOffline(true);
    const verified = await send(session.page, { type: 'provider:model:verify', requestId: `model-offline-verify-${Date.now()}` });
    report.offlineVerify = verified;
    if (verified?.ok === false || verified?.result?.ready !== true) throw new Error(verified?.error?.message || verified?.result?.error?.message || 'Offline verification failed.');
    const synthesis = await send(session.page, {
      type: 'tts:synthesize', providerId: 'browser-model', requestId: `model-offline-synth-${Date.now()}`,
      request: { input: model.text, voice: model.voice },
    });
    report.offlineSynthesis = {
      ok: synthesis?.ok === true,
      mimeType: synthesis?.mimeType || '',
      audioBytes: synthesis?.audioBase64 ? Math.floor(synthesis.audioBase64.length * 0.75) : 0,
      error: synthesis?.error || null,
    };
    if (synthesis?.ok === false || !synthesis?.audioBase64) throw new Error(synthesis?.error?.message || 'Offline synthesis returned no audio.');
    await session.context.setOffline(false);

    if (!args['keep-cache']) {
      const deleted = await send(session.page, { type: 'provider:model:delete', requestId: `model-delete-${Date.now()}` });
      const info = await send(session.page, { type: 'provider:model:info', requestId: `model-info-${Date.now()}` });
      report.deletion = { deleted, info };
      if (deleted?.ok === false || info?.result?.cached === true || info?.result?.state !== 'missing') throw new Error('Exact model cache deletion was not confirmed.');
    }
  }

  await fs.writeFile(path.join(output, 'browser-model-smoke-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`BROWSER MODEL SMOKE PASS ${modelId}`);
  console.log(path.join(output, 'browser-model-smoke-report.json'));
} catch (error) {
  report.failure = { message: error?.message || String(error), stack: error?.stack || '' };
  await fs.writeFile(path.join(output, 'browser-model-smoke-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  throw error;
} finally {
  await session.context.close().catch(() => {});
}
