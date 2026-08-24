import type { BrowserContext, ConsoleMessage, Page, Request, TestInfo, Worker } from '@playwright/test';
import fs from 'node:fs/promises';

import { COMMON_PAGE_NOISE } from './site-cases';

export interface DiagnosticEvent {
  at: string;
  source: 'page' | 'service-worker' | 'network';
  level: string;
  text: string;
  url?: string;
  classification: 'extension-error' | 'site-warning' | 'external-blocker' | 'info';
}

function allowedNoise(text: string): boolean {
  return COMMON_PAGE_NOISE.some((pattern) => pattern.test(text));
}

export class DiagnosticCollector {
  readonly events: DiagnosticEvent[] = [];
  private readonly pages = new Set<Page>();

  attachContext(context: BrowserContext): void {
    context.pages().forEach((page) => this.attachPage(page));
    context.on('page', (page) => this.attachPage(page));
  }

  attachWorker(worker: Worker): void {
    worker.on('console', (message) => this.recordConsole('service-worker', message));
  }

  attachPage(page: Page): void {
    if (this.pages.has(page)) return;
    this.pages.add(page);
    page.on('console', (message) => this.recordConsole('page', message));
    page.on('pageerror', (error) => {
      const text = error.stack || error.message;
      this.push('page', 'error', text, page.url(), this.classify(text, page.url(), true));
    });
    page.on('requestfailed', (request) => this.recordRequestFailure(request));
  }

  extensionErrors(): DiagnosticEvent[] {
    return this.events.filter((event) => event.classification === 'extension-error');
  }

  externalBlockers(): DiagnosticEvent[] {
    return this.events.filter((event) => event.classification === 'external-blocker');
  }

  async saveFailureArtifacts(testInfo: TestInfo): Promise<void> {
    const diagnosticsPath = testInfo.outputPath('diagnostics.json');
    await fs.mkdir(testInfo.outputDir, { recursive: true });
    await fs.writeFile(diagnosticsPath, `${JSON.stringify({
      title: testInfo.title,
      status: testInfo.status,
      events: this.events,
    }, null, 2)}\n`, 'utf8');
    await testInfo.attach('diagnostics', { path: diagnosticsPath, contentType: 'application/json' });
    let index = 0;
    for (const page of this.pages) {
      if (page.isClosed()) continue;
      const screenshotPath = testInfo.outputPath(`page-${++index}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: false }).catch(() => undefined);
      await testInfo.attach(`page-${index}`, { path: screenshotPath, contentType: 'image/png' }).catch(() => undefined);
    }
  }

  private recordConsole(source: 'page' | 'service-worker', message: ConsoleMessage): void {
    const text = message.text();
    const url = message.location().url || '';
    const isError = message.type() === 'error';
    this.push(source, message.type(), text, url, this.classify(text, url, isError));
  }

  private recordRequestFailure(request: Request): void {
    const text = `${request.failure()?.errorText || 'request failed'} ${request.url()}`;
    const url = request.url();
    const classification = allowedNoise(text)
      ? 'site-warning'
      : url.startsWith('chrome-extension://')
        ? 'extension-error'
        : 'external-blocker';
    this.push('network', 'error', text, url, classification);
  }

  private classify(text: string, url: string, isError: boolean): DiagnosticEvent['classification'] {
    if (allowedNoise(text)) return 'site-warning';
    const extensionOwned = url.startsWith('chrome-extension://') || /chrome-extension:\/\//iu.test(text) || /\[Flowloud\]/u.test(text);
    if (isError && extensionOwned) return 'extension-error';
    return isError ? 'external-blocker' : 'info';
  }

  private push(source: DiagnosticEvent['source'], level: string, text: string, url: string, classification: DiagnosticEvent['classification']): void {
    this.events.push({ at: new Date().toISOString(), source, level, text, url: url || undefined, classification });
  }
}
