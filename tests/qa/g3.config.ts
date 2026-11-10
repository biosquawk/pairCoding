import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
// G3 owns its real listeners. No inherited G1/G2/metrics servers, no retries or skips.
export default defineConfig({
  testDir: './g3', testMatch: 'g3.spec.ts', workers: 1, fullyParallel: false, retries: 0,
  timeout: 25000, expect: { timeout: 5000 },
  outputDir: fileURLToPath(new URL('../../artifacts/g3/results', import.meta.url)),
  reporter: [['list'], ['json', { outputFile: fileURLToPath(new URL('../../artifacts/g3/playwright-report.json', import.meta.url)) }]],
  use: { browserName: 'chromium', headless: false, viewport: { width: 1600, height: 1000 },
    trace: 'on', screenshot: 'only-on-failure',
    ...(process.env.PAIRCOACH_QA_BROWSER ? { launchOptions: { executablePath: process.env.PAIRCOACH_QA_BROWSER } } : {}),
  },
});
