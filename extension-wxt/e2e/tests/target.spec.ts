import { test } from '../fixtures';
import { ExternalSiteBlockedError } from '../reader-page';
import { assertNoExtensionErrors, runContinuationScenario, runExtractionScenario } from '../scenarios';
import { targetSiteCase } from '../site-cases';

const targetUrl = String(process.env.FLOWLOUD_TARGET_URL || '').trim();
const scenario = String(process.env.FLOWLOUD_TARGET_SCENARIO || 'continuation').trim();

test.describe('user supplied real-site target', () => {
  test.skip(!targetUrl, '使用 pnpm e2e:target --url <URL> 运行定向用例');

  test('loads the release extension and completes the requested scenario', async ({ reader, diagnostics }) => {
    const target = targetSiteCase(targetUrl, scenario);
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
});
