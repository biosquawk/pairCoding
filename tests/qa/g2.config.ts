import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

// Independent G2 discovery/run. Deliberately does NOT inherit G1 or metrics webServer.
// Each test owns an ephemeral real loopback listener; build first with npm run build.
export default defineConfig({
  testDir: './g2', testMatch: 'g2.spec.ts', workers: 1, fullyParallel: false, retries: 0,
  timeout: 20000, expect: { timeout: 5000 },
  outputDir: fileURLToPath(new URL('./.runtime/g2/results', import.meta.url)),
  reporter: [['list'], ['json', { outputFile: fileURLToPath(new URL('./.runtime/g2/playwright-report.json', import.meta.url)) }]],
  use: { browserName: 'chromium', headless: true, viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure', screenshot: 'only-on-failure',
    ...(process.env.PAIRCOACH_QA_BROWSER ? { launchOptions: { executablePath: process.env.PAIRCOACH_QA_BROWSER } } : {}),
  },
});
