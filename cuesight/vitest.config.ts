import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    testTimeout: 30_000,
    // A macrotask turn after each test keeps vitest's worker RPC alive through long synchronous suites.
    setupFiles: ['tests/setup/yield-between-tests.ts'],
  },
});
