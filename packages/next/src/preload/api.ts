/**
 * The shape exposed on `window.api`. Declared once here and re-declared nowhere
 * else — the existing app's TS2717 quirk (CLAUDE.md) comes from per-file
 * redeclaration, so this package keeps a single source from the start.
 */
export interface NextApi {
  appVersion: string | null;
  platform: NodeJS.Platform;
}
