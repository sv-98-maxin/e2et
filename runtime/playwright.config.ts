import { defineConfig } from '@playwright/test';
import { resolveViewport } from './shared/viewport';

export default defineConfig({
  testDir: '../__tests__',
  testMatch: '**/*.test.ts',
  timeout: 30000,
  retries: 0,
  use: {
    headless: true,
    viewport: resolveViewport(),
  },
  reporter: 'line',
});
