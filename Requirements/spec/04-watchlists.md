# 04 — Watchlists

Watchlists are named collections of tickers the user curates manually or saves from screener/analysis results. They are the input to the Analysis Engine and Validate views.

Backed by `watchlists`, `watchlist_items` (§2.3). Service: `watchlist-service.ts`. IPC namespace: `window.api.watchlists.*`. UI: integrated into `App.tsx` (sidebar watchlist panel) and consumed by every view with a watchlist selector.

## 4.1 Watchlist CRUD

- **FR-1.1** Create unlimited named watchlists. Names are unique **case-insensitively** (enforced by the `lower(name)` unique index plus a service pre-check that returns a clean error).
- **FR-1.2** Rename and delete any watchlist; delete prompts a confirmation.
- **FR-1.3** A **`Default`** watchlist exists on first run and **cannot be deleted** (the service throws on attempts) — only renamed. It is created idempotently on startup.

IPC: `list`, `get(id)`, `create(name)`, `rename(id, newName)`, `delete(id)`.

## 4.2 Tickers within a watchlist

- **FR-1.4** Add tickers individually (text input with autocomplete from the constituents universe).
- **FR-1.5** Adding an invalid/unknown ticker shows an inline error and does not corrupt the list.
- **FR-1.6** Multi-select tickers and remove in one action.
- **FR-1.7** Each ticker row shows: symbol, last price, day % change, volume, sector. Prices auto-refresh on a configurable interval (default 60s) via `quotes.refreshBulk`.

Tickers are uppercased and trimmed on entry. IPC: `items.list(id)`, `items.add(id, ticker, notes?)`, `items.addBulk(id, items[])` (returns `{ added, skipped[] }`), `items.remove(id, itemIds[])`.

## 4.3 CSV import / export

- **FR-1.8** Export the active watchlist to CSV with columns `ticker, added_date, notes`.
- **FR-1.9** Import a CSV into a new or existing watchlist. **Required column: `ticker`**. Optional: `notes`, `added_date`. Header row mandatory (RFC-4180-ish, hand-rolled parser in `csv.ts`).
- **FR-1.10** On import, invalid/empty-ticker rows are reported in a summary dialog (e.g. "47 imported, 3 skipped: XYZ, ABC, DEF") and skipped — never silently dropped.

IPC: `csv.export(watchlistId)` → `CsvExportResult | null`; `csv.import({ watchlistId?, createWithName? })` → `CsvImportResult`.

## 4.4 Acceptance criteria

- Create/rename/delete persist across restarts.
- Round-trip CSV export → import produces an identical watchlist.
- The Default watchlist cannot be deleted but can be renamed.
- A ticker cannot be added twice to the same list (case-insensitive).
