import type { NextApi } from '../../shared/types.js';

/**
 * `window.api` is declared here and **nowhere else**. Per-file redeclaration is
 * what produces TS2717 in the existing app (CLAUDE.md).
 */
declare global {
  interface Window {
    api: NextApi;
  }
  /** This exe's `package.json` version, injected at build (`electron.vite.config.ts`). */
  const __APP_VERSION__: string;
  /** The bundled `@tradeanalyzer/core` version, injected at build. */
  const __CORE_VERSION__: string;
}

export {};
