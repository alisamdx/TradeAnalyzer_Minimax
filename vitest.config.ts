import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 10_000,
    pool: 'forks',
    server: {
      deps: {
        // Don't try to transform Node built-ins like `node:sqlite`.
        external: [/^node:/, 'sqlite']
      }
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov']
    }
  },
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      '@main': resolve('src/main')
    }
  }
});
