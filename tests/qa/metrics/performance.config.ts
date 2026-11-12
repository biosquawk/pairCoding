import { defineConfig } from '@playwright/test';
import base from '../metrics.config';

// Calibration and AC011 controls keep their ordinary tracing configuration.
export default defineConfig({
  ...base,
  testDir: '.',
  grep: /AC-027 TEST-027:/,
  use: { ...base.use, trace: 'off' },
});
