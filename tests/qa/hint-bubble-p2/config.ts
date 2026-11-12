import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: '.', testMatch: 'bubble.spec.ts', workers: 1, retries: 0,
  timeout: 45000, expect: { timeout: 5000 }, outputDir: '../../../artifacts/hint-bubble-p2',
  reporter: [['list']], use: { headless: true, viewport: { width: 1440, height: 1000 }, trace: 'retain-on-failure', screenshot: 'only-on-failure' } });
