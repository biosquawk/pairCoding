import { defineConfig } from '@playwright/test';
import base from '../metrics.config';

export default defineConfig({
  ...base,
  testDir: '.', testMatch: 'calibration.spec.ts',
  outputDir: '../.runtime/calibration-results',
  reporter: [['list'], ['json', { outputFile: '../.runtime/calibration-playwright-report.json' }]],
});
