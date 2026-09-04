import type { Page, Worker } from '@playwright/test';

export interface ReaderSnapshot {
  status: string;
  index: number;
  total: number;
  pageKey?: string;
  sessionId?: string | null;
  current?: { id?: string; postId?: string; floor?: number | null; authorKey?: string; text?: string } | null;
}

export interface TtsProbeSnapshot {
  speaks: Array<{ order: number; textLength: number }>;
  stops: number;
  revocations: Array<{ playbackId: string; reason: string }>;
  tabUpdates: Array<{ tabId: number; status: string; url: string }>;
}

export class ExternalSiteBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExternalSiteBlockedError';
  }
}

export class ReaderPage {
  constructor(
    readonly page: Page,
    readonly serviceWorker: Worker,
  ) {}

  async configureSystemVoice(): Promise<void> {
    await this.serviceWorker.evaluate(async () => {
      const api = (globalThis as any).chrome;
      const key = 'qwenReaderSettings';
      const saved = await api.storage.local.get(key);
      const current = saved[key] || {};
      await api.storage.local.set({
        [key]: {
          ...current,
          showFloatingPlayer: true,
          clickToRead: true,
          interactionVersion: 3,
          activeProviderId: 'browser-system',
          providerId: 'browser-system',
          opVoice: 'Flowloud E2E Voice',
          providerVoices: { ...(current.providerVoices || {}), 'browser-system': 'Flowloud E2E Voice' },
        },
      });
    });
  }

  async installTtsProbe(autoEndCount = 2): Promise<void> {
    await this.serviceWorker.evaluate((endCount) => {
      const api = (globalThis as any).chrome;
      (globalThis as any).__flowloudE2ETts = { speaks: [], stops: 0, revocations: [], tabUpdates: [] };
      api.tabs.onUpdated.addListener((tabId: number, changeInfo: any, tab: any) => {
        (globalThis as any).__flowloudE2ETts.tabUpdates.push({
          tabId,
          status: String(changeInfo?.status || ''),
          url: String(changeInfo?.url || tab?.url || tab?.pendingUrl || ''),
        });
      });
      const originalSendMessage = api.tabs.sendMessage.bind(api.tabs);
      api.tabs.sendMessage = (tabId: number, message: any, ...rest: unknown[]) => {
        if (message?.type === 'reader:playback:revoked') {
          (globalThis as any).__flowloudE2ETts.revocations.push({
            playbackId: String(message.playbackId || ''),
            reason: String(message.reason || ''),
          });
        }
        return originalSendMessage(tabId, message, ...rest);
      };
      const voices = [{ voiceName: 'Flowloud E2E Voice', lang: 'zh-CN', eventTypes: ['start', 'word', 'end'] }];
      api.tts.getVoices = (callback: (items: unknown[]) => void) => {
        callback?.(voices);
        return Promise.resolve(voices);
      };
      api.tts.stop = () => { (globalThis as any).__flowloudE2ETts.stops += 1; };
      api.tts.pause = () => undefined;
      api.tts.resume = () => undefined;
      api.tts.speak = (text: string, options: any, callback?: () => void) => {
        const store = (globalThis as any).__flowloudE2ETts;
        const order = store.speaks.length + 1;
        store.speaks.push({ order, textLength: String(text).length });
        setTimeout(() => options?.onEvent?.({ type: 'start', charIndex: 0 }), 5);
        setTimeout(() => options?.onEvent?.({ type: 'word', charIndex: 0, length: Math.min(2, String(text).length) }), 15);
        if (order <= endCount) {
          setTimeout(() => options?.onEvent?.({ type: 'end', charIndex: String(text).length }), 90);
        }
        callback?.();
      };
    }, autoEndCount);
  }

  async goto(url: string, timeoutMs = 45_000): Promise<void> {
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await this.page.waitForSelector('#qwen-reader-host', { state: 'attached', timeout: 15_000 });
  }

  async reload(): Promise<void> {
    await this.page.reload({ waitUntil: 'domcontentloaded' });
    await this.page.waitForSelector('#qwen-reader-host', { state: 'attached', timeout: 15_000 });
  }

  async waitForReady(minSegments: number, timeoutMs = 30_000): Promise<ReaderSnapshot> {
    const deadline = Date.now() + timeoutMs;
    let last: ReaderSnapshot | null = null;
    let lastError = '';
    while (Date.now() < deadline) {
      try {
        last = await this.snapshot();
        lastError = '';
      } catch (error) {
        last = null;
        lastError = error instanceof Error ? error.message : String(error);
      }
      if (last && last.total >= minSegments && last.status !== 'extracting') return last;
      if (last && last.status === 'error' && last.total === 0) {
        const title = await this.page.title().catch(() => '');
        const challenge = await this.page.locator('#challenge-running, .cf-challenge, [name="cf-turnstile-response"]').count().catch(() => 0);
        if (/just a moment|attention required|cloudflare/iu.test(title) || challenge > 0) {
          throw new ExternalSiteBlockedError(`站点防护阻止了自动浏览器：${title || this.page.url()}`);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`阅读器未在 ${timeoutMs}ms 内准备好，最后状态：${JSON.stringify(last)}${lastError ? `；${lastError}` : ''}`);
  }

  async waitForSpeakCount(count: number, timeoutMs = 10_000): Promise<TtsProbeSnapshot> {
    const deadline = Date.now() + timeoutMs;
    let last: TtsProbeSnapshot = { speaks: [], stops: 0, revocations: [], tabUpdates: [] };
    while (Date.now() < deadline) {
      last = await this.ttsProbe();
      if (last.speaks.length >= count) return last;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`系统语音只启动了 ${last.speaks.length}/${count} 个片段。`);
  }

  async snapshot(): Promise<ReaderSnapshot> {
    const tabId = await this.tabId();
    return this.serviceWorker.evaluate(async (id) => {
      const response = await (globalThis as any).chrome.tabs.sendMessage(id, { type: 'reader:snapshot:get' });
      return response?.snapshot || response;
    }, tabId);
  }

  async command(command: string): Promise<ReaderSnapshot> {
    const tabId = await this.tabId();
    return this.serviceWorker.evaluate(async ({ id, nextCommand }) => {
      const response = await (globalThis as any).chrome.tabs.sendMessage(id, {
        type: 'reader:command',
        command: nextCommand,
        source: 'playwright-e2e',
        takeover: true,
      });
      if (response?.ok === false) throw new Error(response?.error?.message || '阅读器命令失败');
      return response?.snapshot || response;
    }, { id: tabId, nextCommand: command });
  }

  async ttsProbe(): Promise<TtsProbeSnapshot> {
    return this.serviceWorker.evaluate(() => {
      const store = (globalThis as any).__flowloudE2ETts || { speaks: [], stops: 0, revocations: [], tabUpdates: [] };
      return {
        speaks: [...store.speaks],
        stops: Number(store.stops || 0),
        revocations: [...store.revocations],
        tabUpdates: [...store.tabUpdates],
      };
    });
  }

  private async tabId(): Promise<number> {
    await this.page.bringToFront();
    const id = await this.serviceWorker.evaluate(async () => {
      const tabs = await (globalThis as any).chrome.tabs.query({ active: true, currentWindow: true });
      return tabs[0]?.id ?? null;
    });
    if (!Number.isInteger(id)) throw new Error(`找不到测试网页对应的标签页：${this.page.url()}`);
    return Number(id);
  }
}
