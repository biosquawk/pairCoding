import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './report-history-p2', testMatch: 'history.spec.ts', workers: 1, retries: 0,
  timeout: 45000, expect: { timeout: 5000 }, outputDir: '../../artifacts/report-history-p2',
  reporter: [['list']], use: { headless: true, viewport: { width: 1365, height: 900 },
    launchOptions: process.env.PAIRCOACH_QA_BROWSER ? { executablePath: process.env.PAIRCOACH_QA_BROWSER } : {},
    trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
