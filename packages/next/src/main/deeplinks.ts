import type { BrowserWindow } from 'electron';
import { tableNames } from '@tradeanalyzer/core';
import { findDeepLink, parseDeepLink, type DeepLinkRoute } from '../shared/deeplink.js';

/**
 * Delivering `tradeanalyzer-next://` links — 05 §11.1.
 *
 * On Windows a clicked link does not reach the running app: it starts a
 * **second instance** with the URL in `argv`, and the single-instance lock
 * hands that `argv` to the first one through `second-instance`. So this is the
 * real implementation, and `open-url` (macOS) is not.
 *
 * A link can arrive before there is a renderer to show it — it is the link
 * that launched the app, or the window is still loading — so it is held as
 * `pending` and the renderer asks for it once it is listening. Delivered either
 * way; lost neither way.
 */

let pending: DeepLinkRoute | null = null;
let target: BrowserWindow | null = null;

function parse(url: string): DeepLinkRoute {
  const known = new Set(tableNames());
  return parseDeepLink(url, (t) => known.has(t));
}

/** A link that launched the app is held until the renderer asks for it. */
export function captureStartupLink(argv: readonly string[]): void {
  const url = findDeepLink(argv);
  if (url) pending = parse(url);
}

export function attachWindow(window: BrowserWindow): void {
  target = window;
  window.on('closed', () => {
    if (target === window) target = null;
  });
}

/** A second instance was started — usually by a clicked link. Bring the one window forward and navigate it. */
export function handleSecondInstance(argv: readonly string[]): void {
  const url = findDeepLink(argv);
  const route = url ? parse(url) : null;
  const window = target;
  if (!window) {
    if (route) pending = route;
    return;
  }
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  if (!route) return;
  if (window.webContents.isLoading()) pending = route;
  else window.webContents.send('deeplink:navigate', route);
}

export function takePendingLink(): DeepLinkRoute | null {
  const route = pending;
  pending = null;
  return route;
}
