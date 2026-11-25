import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '../__tests__',
  testMatch: '**/*.test.ts',
  timeout: 30000,
  retries: 0,
  use: {
    headless: true,
    viewport: { width: 1280, height: 720 },
  },
  reporter: 'line',
});
