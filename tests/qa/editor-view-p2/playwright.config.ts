import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.', testMatch: 'editor-view.spec.ts', fullyParallel: false, workers: 1, retries: 0, timeout: 20000,
  expect: { timeout: 5000 },
  outputDir: process.env.PAIRCOACH_QA_RESULTS ?? './.runtime/results',
  reporter: [['list']],
  use: { browserName: 'chromium', headless: true, viewport: { width: 1440, height: 1000 }, trace: 'retain-on-failure',
    ...(process.env.PAIRCOACH_QA_BROWSER ? { launchOptions: { executablePath: process.env.PAIRCOACH_QA_BROWSER } } : {}) },
});
