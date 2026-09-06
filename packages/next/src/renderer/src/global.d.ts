import type { NextApi } from '../../shared/types.js';

/**
 * `window.api` is declared here and **nowhere else**. Per-file redeclaration is
 * what produces TS2717 in the existing app (CLAUDE.md).
 */
declare global {
  interface Window {
    api: NextApi;
  }
}

export {};
