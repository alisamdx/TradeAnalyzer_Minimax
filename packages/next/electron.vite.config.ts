import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

// Shown in the sidebar footer, like the existing app's status bar. The core
// version is shown beside it because it is the other half of a build's identity:
// the dictionary and the collector both live in core, and a TA2 build carrying a
// stale core looked identical from the outside (06 §6).
const version = (path: string): string =>
  (JSON.parse(readFileSync(resolve(path), 'utf8')) as { version: string }).version;

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
    define: {
      __APP_VERSION__: JSON.stringify(version('package.json')),
      __CORE_VERSION__: JSON.stringify(version('../core/package.json'))
    },
    build: {
      rollupOptions: {
        input: { index: resolve('src/renderer/index.html') }
      }
    },
    plugins: [react()]
  }
});
