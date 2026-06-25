# 17 — Earnings Calendar

Earnings is the #1 event that blows up CSP/CC positions, so the app tracks upcoming earnings dates and annotates them everywhere a DTE window matters. Service: `earnings-service.ts` (+ `earnings-refresh-job.ts`). IPC: `window.api.earnings.*`. View: `EarningsCalendarView.tsx` (📅 Earnings). Table: `earnings_calendar` (§2.19).

## 17.1 Source & smart caching

- **Finnhub-primary** (no Polygon public earnings endpoint). The batch job (§17.3) bulk-fetches Finnhub's earnings calendar; **E*Trade is a per-ticker fallback** used by the daily-brief job for the final picks (`refreshTickers` → `fetchFromEtrade`: `GET /v1/market/quote/{ticker}?detailFlag=ALL&requireEarningsDate=true` → `QuoteResponse.QuoteData[0].All.nextEarningDate`, an `MM/DD/YYYY` string; `requireEarningsDate=true` is **required** or the field returns `""`).
- **One row per ticker, NEAREST future date wins.** `earnings_calendar` is keyed by ticker. Earnings is the #1 event risk for short premium, and three consumers read this single row for the *next* earnings — the v2 entry gate (`brief-entry-source` earningsBeforeExpiry), the critic (`earnings_in_window`), and the brief's Stage-3 −20 earnings penalty (§20) — so the stored date **must** be the nearest upcoming one. Any ingest that writes from multiple date sources/windows must keep the nearest future date, never overwrite a near date with a later one. (Regression: `tests/earnings-refresh-job.test.ts`; fixed v1.1.75 — see §17.3.)
- **Smart caching** (`refreshTickers`, unless `force`): never overwrite a `manual` entry; **skip** a ticker that already has a *future* `report_date` (still valid); only (re)fetch tickers whose stored date is in the past or missing. Skipped tickers incur no API delay. If E*Trade is not connected, the fallback refresh returns `skipped` with a message rather than looping failed calls.

## 17.2 Date parsing & the Saturday→Friday correction

- `MM/DD/YYYY` is parsed **by regex**, not `new Date()`, to avoid local-time→UTC drift: `mdy → ${yyyy}-${mm}-${dd}`. ISO and Unix-seconds inputs are also handled.
- **E*Trade dates are UTC.** Companies report after ET market close, so a date that is "Saturday UTC" is actually "Friday ET". The service shifts **Saturday → Friday** (`−1 day`) and marks the entry `confirmed = 0`. Sunday dates are left as-is but also marked unconfirmed (UI warning). Weekday dates are `confirmed = 1`.

## 17.3 Refresh batch job

`earnings-refresh-job.ts` is a batch job (§20): universe = all unique tickers from `constituents` (S&P 500 + Russell 1000). Runs on startup (+60s) and after close (`after_close_only`). Two phases:
- **Phase 1 — Finnhub bulk.** Two date windows — `today→+90d`, then `+90d→+180d` — are fetched in order (two calls dodge the ~1500-entry result cap). Entries are filtered to the constituent set and upserted with source `'finnhub'`. **Nearest-wins guard (v1.1.75):** a candidate is skipped if it is past/today, or if a *future* `report_date` is already stored that is on/before the candidate. Without this, a quarterly reporter present in **both** windows had its near date (window 1) overwritten by the **following** quarter (window 2) — silently dropping the next earnings from the risk gates (observed live: NVDA/MRVL/AMAT/ADI stored Nov, dropping the real Aug report; the unconditional `ON CONFLICT … DO UPDATE` always kept whichever window wrote last).
- **Phase 2 — Finnhub per-ticker.** Only tickers still missing a future date after Phase 1 (the bulk cap drops some, e.g. AAPL). A 365-day window is fetched per ticker, future entries sorted ascending, **nearest** kept. Rate-limited 1 call/s.

Manual entries are never overwritten in either phase. If no Finnhub key is configured the job early-exits as `skipped`.

## 17.4 Views

`EarningsCalendarView` defaults to a **monthly calendar grid** (7-col Sun–Sat, prev/next/today nav) with a ☰ **List** toggle (grouped-by-date). Local dates are formatted without UTC shift. Ticker chips: blue = confirmed, dim = estimated, amber with a ⚠ prefix = weekend-adjusted/unconfirmed. Clicking a chip dispatches `navigate-to-validate` (opens the ticker's Validate dashboard). Data window ≈ 180 days.

## 17.5 Annotations across the app

Earnings is surfaced wherever an earnings-before-expiry risk exists:
- **Validate** (§07): warning banner when earnings ≤ 45 DTE from selection.
- **Portfolio** (§18): 📅 badge on open positions, 📅! when earnings fall before expiry.
- **Payoff** (§08): amber earnings-date annotation strip below the P&L chart (fetched on `ticker` change so it shows for every entry path), and the Risk Matrix earnings column highlighted amber with a 📅 icon.

## 17.6 Manual override & API

`setManual(ticker, reportDate, reportTime?)` stores a user date (`source='manual'`, `confirmed=1`) that auto-refresh never overwrites. `EarningsEntry` carries `ticker`, `reportDate`, `reportTime` (`bmo|amc|null`), `epsEstimate`, `source`, `confirmed`, `cachedAt`, and a read-time-computed `dte`.

IPC: `get(ticker)`, `upcoming(days?)`, `refresh(tickers?, force?)`, `setManual(ticker, reportDate, reportTime?)`, `delete(ticker)`.
