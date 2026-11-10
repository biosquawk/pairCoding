// Explicit Windows reference campaign; not silently skipped in the GATE001 smoke.
import { defineConfig } from '@playwright/test';
import base from '../../playwright.config';

export default defineConfig(base, {
  testDir: './metrics', testMatch: 'reference.spec.ts', timeout: 180000,
  webServer: { ...base.webServer as object,
    command: 'npm run build && node --import tsx tests/qa/e2e/launch.ts',
    url: `http://127.0.0.1:${process.env.PAIRCOACH_QA_PORT || 8080}/`,
    reuseExistingServer: false, timeout: 60000,
    env: { PAIRCOACH_QA_REFERENCE: '1' },
  },
  outputDir: './.runtime/reference-results',
  reporter: [['list'], ['json', { outputFile: './tests/qa/.runtime/reference-playwright-report.json' }]],
});
