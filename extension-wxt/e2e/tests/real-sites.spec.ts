import { test } from '../fixtures';
import { ExternalSiteBlockedError } from '../reader-page';
import { assertNoExtensionErrors, runContinuationScenario, runExtractionScenario } from '../scenarios';
import { REAL_SITE_CASES } from '../site-cases';

for (const target of REAL_SITE_CASES) {
  test(`real site · ${target.id}`, async ({ reader, diagnostics }) => {
    test.setTimeout(target.timeoutMs + 30_000);
    try {
      if (target.scenario === 'continuation') await runContinuationScenario(reader, target);
      else await runExtractionScenario(reader, target);
    } catch (error) {
      if (error instanceof ExternalSiteBlockedError) {
        test.info().annotations.push({ type: 'external-blocker', description: error.message });
        test.skip(true, error.message);
      }
      throw error;
    }
    assertNoExtensionErrors(diagnostics);
  });
}
