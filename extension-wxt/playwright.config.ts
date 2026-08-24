import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e/tests',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  outputDir: '../.tmp-playwright/test-results',
  reporter: [
    ['list'],
    ['json', { outputFile: '../.tmp-playwright/results.json' }],
    ['html', { outputFolder: '../.tmp-playwright/report', open: 'never' }],
  ],
  use: {
    actionTimeout: 10_000,
    navigationTimeout: 45_000,
  },
});
