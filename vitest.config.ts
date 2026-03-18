import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./tests/setup.ts'],
    fileParallelism: false, // CycleTLS binds to a fixed port — can't run test files in parallel
    testTimeout: 15000,
  },
});
