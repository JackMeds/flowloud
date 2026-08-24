import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDirectory, '..');
const harnessPath = path.join(repoRoot, 'extension', 'tests', 'browser', 'ui-harness.html');
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
const playwrightEntry = await fs.access(bundledPlaywright).then(
  () => bundledPlaywright,
  async () => {
    await fs.access(fallbackPlaywright);
    return fallbackPlaywright;
  },
);
const browserCandidates = [
  process.env.FLOWLOUD_BROWSER,
  process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
].filter(Boolean);
let executablePath = '';
for (const candidate of browserCandidates) {
  try {
    await fs.access(candidate);
    executablePath = candidate;
    break;
  } catch (_) {}
}
if (!executablePath) throw new Error('没有找到可用于朗读连续性测试的 Edge。');

const require = createRequire(import.meta.url);
const { chromium } = require(playwrightEntry);
const browser = await chromium.launch({
  headless: true,
  executablePath,
  args: ['--allow-file-access-from-files', '--no-first-run', '--no-default-browser-check'],
});
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(pathToFileURL(harnessPath).href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => ['pass', 'fail'].includes(document.documentElement.dataset.testStatus || ''),
    null,
    { timeout: 20000 },
  );
  const result = await page.evaluate(() => ({
    status: document.documentElement.dataset.testStatus || '',
    message: document.querySelector('#test-result')?.textContent || '',
  }));
  if (result.status !== 'pass') {
    throw new Error(`${result.message || '浏览器朗读连续性夹具失败'}${errors.length ? `；${errors.join('；')}` : ''}`);
  }
  console.log(`READER CONTINUATION PASS · ${result.message}`);
} finally {
  await browser.close();
}
