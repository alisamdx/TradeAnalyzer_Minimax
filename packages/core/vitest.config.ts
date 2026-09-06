import { defineConfig } from 'vitest/config';

// No `resolve.alias` here, deliberately. 06 §1: `core` has no path aliases —
// that is the whole reason a plain-node harness can import it (CLAUDE.md).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 10_000
  }
});
