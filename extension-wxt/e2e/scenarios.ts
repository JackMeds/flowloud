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

export function assertNoExtensionErrors(diagnostics: DiagnosticCollector): void {
  expect(diagnostics.extensionErrors(), JSON.stringify(diagnostics.extensionErrors(), null, 2)).toEqual([]);
}
