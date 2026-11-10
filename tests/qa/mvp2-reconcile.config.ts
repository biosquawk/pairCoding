import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

// No inherited webServer: each case owns a separate real backend process/port.
export default defineConfig({
  testDir: './mvp2-reconcile', testMatch: 'reconcile.spec.ts', workers: 1,
  fullyParallel: false, retries: 0, timeout: 60000, expect: { timeout: 10000 },
  outputDir: fileURLToPath(new URL('../../artifacts/mvp2-reconcile/results', import.meta.url)),
  reporter: [['list'], ['json', { outputFile: fileURLToPath(new URL('../../artifacts/mvp2-reconcile/playwright-report.json', import.meta.url)) }]],
  use: { browserName: 'chromium', headless: process.env.PAIRCOACH_QA_HEADLESS === '1',
    viewport: { width: 1600, height: 1000 }, trace: 'on', screenshot: 'only-on-failure',
    ...(process.env.PAIRCOACH_QA_BROWSER ? { launchOptions: { executablePath: process.env.PAIRCOACH_QA_BROWSER } } : {}),
  },
});
