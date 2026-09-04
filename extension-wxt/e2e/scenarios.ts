import { expect } from '@playwright/test';

import type { DiagnosticCollector } from './diagnostics';
import type { ReaderPage, ReaderSnapshot } from './reader-page';
import type { RealSiteCase } from './site-cases';

export async function runExtractionScenario(reader: ReaderPage, target: RealSiteCase): Promise<ReaderSnapshot> {
  await reader.configureSystemVoice();
  await reader.installTtsProbe(0);
  await reader.goto(target.url, target.timeoutMs);
  const snapshot = await reader.waitForReady(target.minSegments, target.timeoutMs);
  expect(snapshot.total).toBeGreaterThanOrEqual(target.minSegments);
  expect(snapshot.current).toBeTruthy();
  return snapshot;
}

export async function runContinuationScenario(reader: ReaderPage, target: RealSiteCase): Promise<ReaderSnapshot> {
  await reader.configureSystemVoice();
  await reader.installTtsProbe(2);
  await reader.goto(target.url, target.timeoutMs);
  await reader.waitForReady(target.minSegments, target.timeoutMs);

  await reader.reload();
  const before = await reader.waitForReady(target.minSegments, target.timeoutMs);
  await reader.command('play');
  await reader.waitForSpeakCount(3, 12_000);

  const playing = await reader.snapshot();
  expect(playing.status).toBe('playing');
  expect(playing.index).toBeGreaterThanOrEqual(2);
  expect(playing.total).toBeGreaterThanOrEqual(before.total);

  // The third utterance is deliberately held open. A late revocation from an
  // older sentence used to reset this state to ready after roughly 500 ms.
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const stable = await reader.snapshot();
  const probe = await reader.ttsProbe();
  expect(stable.status, JSON.stringify({
    stable: { status: stable.status, index: stable.index, total: stable.total, pageKey: stable.pageKey },
    probe,
  }, null, 2)).toBe('playing');
  expect(stable.index).toBeGreaterThanOrEqual(playing.index);
  expect(stable.total).toBeGreaterThanOrEqual(before.total);
  return stable;
}

export async function runInteractionScenario(reader: ReaderPage, target: RealSiteCase): Promise<ReaderSnapshot> {
  // Point-reading is deliberately enabled only for this isolated scenario;
  // the regular extraction/continuation matrix remains free of click side
  // effects.  The TTS probe is deterministic, so a successful click is
  // observable without relying on speakers or timing a human gesture.
  await reader.configureSystemVoice();
  await reader.installTtsProbe(0);
  await reader.goto(target.url, target.timeoutMs);
  await reader.waitForReady(target.minSegments, target.timeoutMs);

  await reader.page.evaluate(() => {
    const stream = (globalThis as any).app?.current?.get?.('stream');
    if (stream && typeof stream.goToNumber === 'function') stream.goToNumber(320);
  });
  const targetPost = reader.page.locator('.PostStream-item[data-number="320"]');
  await targetPost.first().waitFor({ state: 'visible', timeout: target.timeoutMs });
  const postId = String(await targetPost.first().getAttribute('data-id') || '').replace(/^post-/u, '');
  const body = targetPost.first().locator('.Post-body').first();
  const expected = (await body.innerText()).trim().slice(0, 24);
  const clickTarget = body.locator('p, li').first();
  const clickTargetCount = await clickTarget.count();
  const clickAt = Date.now();
  await (clickTargetCount ? clickTarget : body).click();
  const probe = await reader.waitForSpeakCount(1, 1_000);
  expect(Date.now() - clickAt).toBeLessThanOrEqual(1_000);
  expect(probe.speaks.length).toBeGreaterThanOrEqual(1);
  const clicked = await reader.snapshot();
  expect(String(clicked.current?.id || '')).toContain(postId);
  expect(clicked.current?.floor).toBe(320);
  if (expected) expect(String(clicked.current?.text || '')).toContain(expected.slice(0, 8));

  // Flarum's main-world bridge must move the virtual stream without a page
  // reload.  Keep the active reader session and its playback state intact.
  const sessionId = clicked.sessionId || null;
  await reader.page.evaluate(() => {
    const stream = (globalThis as any).app?.current?.get?.('stream');
    if (!stream || typeof stream.goToNumber !== 'function') throw new Error('Flarum stream bridge unavailable');
    stream.goToNumber(330);
  });
  await reader.page.locator('.PostStream-item[data-number="330"]').first().waitFor({ state: 'attached', timeout: 8_000 });
  const afterNavigation = await reader.snapshot();
  expect(afterNavigation.sessionId || null).toBe(sessionId);
  expect(['playing', 'loading', 'paused']).toContain(afterNavigation.status);
  await new Promise((resolve) => setTimeout(resolve, 120));
  const hasWordHighlight = await reader.page.evaluate(() => Boolean((globalThis as any).CSS?.highlights?.has?.('qwen-reader-current-word')));
  expect(hasWordHighlight).toBe(true);
  return afterNavigation;
}

export function assertNoExtensionErrors(diagnostics: DiagnosticCollector): void {
  expect(diagnostics.extensionErrors(), JSON.stringify(diagnostics.extensionErrors(), null, 2)).toEqual([]);
}
