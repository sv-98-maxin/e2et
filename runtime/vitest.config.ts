import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

const root = resolve(__dirname);

export default defineConfig({
  test: {
    root,
    include: ['__tests__/*.test.ts'],
    globals: true,
  },
});
