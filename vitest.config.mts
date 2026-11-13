import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/fixtures/**/*.test.ts'],
    testTimeout: 30000,
  },
});
