import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

// Mirrors the existing app's config shape (06 §3) so a future session's
// instincts transfer. No path aliases: `next` uses relative imports internally
// and imports `core` by package name.
export default defineConfig({
  main: {
    // `core` is deliberately NOT externalized: it is pure ESM TypeScript with no
    // native module, so bundling it into out/main means the packaged exe has no
    // workspace symlink to resolve at runtime. Everything else (electron,
    // better-sqlite3 later) stays external.
    plugins: [externalizeDepsPlugin({ exclude: ['@tradeanalyzer/core'] })],
    build: {
      rollupOptions: {
        input: { index: resolve('src/main/index.ts') }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: resolve('src/renderer'),
    build: {
      rollupOptions: {
        input: { index: resolve('src/renderer/index.html') }
      }
    },
    plugins: [react()]
  }
});
