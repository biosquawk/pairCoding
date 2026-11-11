import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  testDir: './tests/qa/e2e', testMatch: 'g1.spec.ts',
  fullyParallel: false, workers: 1, retries: 0, timeout: 20000,
  expect: { timeout: 5000 },
  outputDir: process.env.PAIRCOACH_QA_RESULTS || './tests/qa/.runtime/playwright-results',
  reporter: [['list'], ['json', { outputFile: './tests/qa/.runtime/playwright-report.json' }]],
  use: {
    browserName: 'chromium', headless: true,
    ...(process.env.PAIRCOACH_QA_BROWSER ? { launchOptions: { executablePath: process.env.PAIRCOACH_QA_BROWSER } } : {}),
    baseURL: `http://127.0.0.1:${process.env.PAIRCOACH_QA_PORT || 8080}`,
    viewport: { width: 1440, height: 1000 }, trace: 'retain-on-failure', screenshot: 'only-on-failure',
  },
  webServer: {
    cwd: fileURLToPath(new URL('.', import.meta.url)),
    command: 'npm run build && node --import tsx tests/qa/e2e/launch.ts',
    url: `http://127.0.0.1:${process.env.PAIRCOACH_QA_PORT || 8080}/`,
    reuseExistingServer: false, timeout: 60000,
  },
});
