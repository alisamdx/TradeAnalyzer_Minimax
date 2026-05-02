# Troubleshooting

## `npm install` fails on better-sqlite3

Symptom: `Error: The module ... was compiled against a different Node.js version`.

Fix: `npx electron-rebuild -f -w better-sqlite3`. The `postinstall` script should already do this; run manually if it didn't.

On Windows, ensure Visual Studio Build Tools 2022 (Desktop development with C++) is installed. Native rebuilds need a working toolchain.

## App launches but window is blank

Likely the renderer failed to load. Open DevTools (`Ctrl+Shift+I` on Windows / `Cmd+Opt+I` on macOS) and check the console. Common causes:

- Missing build output (`out/renderer/index.html` not built). Run `npm run dev` (electron-vite serves the renderer for dev mode).
- CSP blocking inline scripts. The dev server should set CSP headers; production builds should pass through electron-builder. If you see a CSP error in dev, check `src/main/index.ts → createWindow`.

## SQLite says `database is locked`

Phase 1 uses a single connection per main process; locking should not happen. If it does, look for a stray process holding the file (a previous instance of the app that didn't exit cleanly).

To reset state during development:

```bash
# macOS
rm -f "$HOME/Library/Application Support/TradeAnalyzer/trade-analyzer.sqlite"

# Windows (PowerShell)
Remove-Item "$env:APPDATA\TradeAnalyzer\trade-analyzer.sqlite"
```

## CSV import skips rows I expected to keep

The parser is strict about the header row (`ticker` column required) and about blank/whitespace-only ticker cells. The summary dialog reports each skipped row with the reason; check there first. The import never silently drops rows (FR-1.10).

## Tests time out or hang

The offline suite must complete in <90s (EP-6.5). If it doesn't:

- Check for leaked DB connections — every test that creates a `WatchlistService` should close it in `afterEach`.
- `:memory:` DBs are recreated per test; running with file-backed DBs can be slow on Windows. Make sure tests are using `':memory:'` unless explicitly testing migration persistence.
