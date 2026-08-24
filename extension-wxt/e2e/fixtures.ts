import { test as base, chromium, expect, type BrowserContext, type Worker } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { DiagnosticCollector } from './diagnostics';
import { ReaderPage } from './reader-page';

interface FlowloudFixtures {
  extensionContext: BrowserContext;
  extensionId: string;
  serviceWorker: Worker;
  diagnostics: DiagnosticCollector;
  reader: ReaderPage;
}

export const test = base.extend<FlowloudFixtures>({
  extensionContext: async ({}, use, testInfo) => {
    const extensionPath = path.resolve(import.meta.dirname, '..', '..', 'extension');
    const profilePath = await fs.mkdtemp(path.join(os.tmpdir(), 'flowloud-e2e-'));
    const context = await chromium.launchPersistentContext(profilePath, {
      channel: 'chromium',
      headless: true,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
      ],
    });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    try {
      await use(context);
    } finally {
      if (testInfo.status !== testInfo.expectedStatus) {
        await context.tracing.stop({ path: testInfo.outputPath('trace.zip') }).catch(() => undefined);
        await testInfo.attach('trace', { path: testInfo.outputPath('trace.zip'), contentType: 'application/zip' }).catch(() => undefined);
      } else {
        await context.tracing.stop().catch(() => undefined);
      }
      await context.close().catch(() => undefined);
      await fs.rm(profilePath, { recursive: true, force: true }).catch(() => undefined);
    }
  },

  serviceWorker: async ({ extensionContext }, use) => {
    const isFlowloudWorker = async (candidate: Worker) => candidate.evaluate(() => {
      const manifest = (globalThis as any).chrome?.runtime?.getManifest?.();
      return manifest?.version === '0.10.0.1' || manifest?.version_name === '0.10.0-alpha.1';
    }).catch(() => false);
    let worker: Worker | undefined;
    for (const candidate of extensionContext.serviceWorkers()) {
      if (await isFlowloudWorker(candidate)) {
        worker = candidate;
        break;
      }
    }
    const deadline = Date.now() + 15_000;
    while (!worker && Date.now() < deadline) {
      const candidate = await extensionContext.waitForEvent('serviceworker', { timeout: Math.max(1, deadline - Date.now()) });
      if (await isFlowloudWorker(candidate)) worker = candidate;
    }
    if (!worker) throw new Error('没有找到 Flowloud MV3 Service Worker');
    await use(worker);
  },

  extensionId: async ({ serviceWorker }, use) => {
    await use(new URL(serviceWorker.url()).hostname);
  },

  diagnostics: async ({ extensionContext, serviceWorker }, use, testInfo) => {
    const collector = new DiagnosticCollector();
    collector.attachContext(extensionContext);
    collector.attachWorker(serviceWorker);
    await use(collector);
    if (testInfo.status !== testInfo.expectedStatus) await collector.saveFailureArtifacts(testInfo);
  },

  reader: async ({ extensionContext, serviceWorker, diagnostics }, use) => {
    const page = await extensionContext.newPage();
    diagnostics.attachPage(page);
    await use(new ReaderPage(page, serviceWorker));
  },
});

export { expect };
