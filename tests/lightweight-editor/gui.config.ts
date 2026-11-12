import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir:'.',testMatch:'gui.spec.ts',workers:1,retries:0,timeout:45000,expect:{timeout:5000},
  outputDir:'../../artifacts/lightweight-gui',reporter:[['list']],
  use:{headless:true,viewport:{width:1365,height:900},trace:'on',screenshot:'only-on-failure',
    launchOptions:process.env.PAIRCOACH_QA_BROWSER?{executablePath:process.env.PAIRCOACH_QA_BROWSER}:{}},
});
