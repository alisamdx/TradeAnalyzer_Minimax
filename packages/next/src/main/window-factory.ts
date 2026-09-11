import type { BrowserWindow } from 'electron';

/**
 * How the rest of the main process opens a window without importing the entry
 * point — `index.ts` registers its `createWindow` here at startup. A direct
 * import would be a cycle (index → ipc → index), and a second copy of the
 * window options would be a second place for `contextIsolation` to be wrong.
 */

export interface WindowOptions {
  /** Open a closed generation, read-only, in a window that says so (05 §8, B9c). */
  readonly readOnlyGeneration?: number;
}

let factory: ((opts: WindowOptions) => BrowserWindow) | null = null;

export function setWindowFactory(create: (opts: WindowOptions) => BrowserWindow): void {
  factory = create;
}

export function openWindow(opts: WindowOptions): BrowserWindow {
  if (!factory) throw new Error('No window factory registered — the application has not finished starting.');
  return factory(opts);
}
