import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

const extensionPath = path.resolve('..', 'extension');
const profilePath = path.resolve('..', '.tmp-flowloud-dev-browser', '.flowloud-e2e-profile');
await fs.mkdir(profilePath, { recursive: true });

const context = await chromium.launchPersistentContext(profilePath, {
  channel: 'chromium',
  headless: false,
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
  ],
});
let worker = context.serviceWorkers()[0];
if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
console.log(`Flowloud 开发浏览器已启动 · extension=${new URL(worker.url()).hostname}`);
console.log(`隔离 Profile：${profilePath}`);

await new Promise((resolve) => context.once('close', resolve));
