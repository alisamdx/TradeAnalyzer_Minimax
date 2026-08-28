# 17 — Earnings Calendar

Earnings is the #1 event that blows up CSP/CC positions, so the app tracks upcoming earnings dates and annotates them everywhere a DTE window matters. Service: `earnings-service.ts` (+ `earnings-refresh-job.ts`). IPC: `window.api.earnings.*`. View: `EarningsCalendarView.tsx` (📅 Earnings). Table: `earnings_calendar` (§2.19).

## 17.1 Source & smart caching

- **Finnhub-primary** (no Polygon public earnings endpoint). The batch job (§17.3) bulk-fetches Finnhub's earnings calendar; **E*Trade is a per-ticker fallback** used by the daily-brief job for the final picks (`refreshTickers` → `fetchFromEtrade`: `GET /v1/market/quote/{ticker}?detailFlag=ALL&requireEarningsDate=true` → `QuoteResponse.QuoteData[0].All.nextEarningDate`, an `MM/DD/YYYY` string; `requireEarningsDate=true` is **required** or the field returns `""`).
- **One row per ticker, NEAREST future date wins.** `earnings_calendar` is keyed by ticker. Earnings is the #1 event risk for short premium, and three consumers read this single row for the *next* earnings — the v2 entry gate (`brief-entry-source` earningsBeforeExpiry), the critic (`earnings_in_window`), and the brief's Stage-3 −20 earnings penalty (§20) — so the stored date **must** be the nearest upcoming one. Any ingest that writes from multiple date sources/windows must keep the nearest future date, never overwrite a near date with a later one. **A bulk/paged source must also prove it actually saw the near date — a result cap that truncates can make "no near date in the response" indistinguishable from "no near date exists" (v1.1.136, §17.3).** (Regression: `tests/earnings-refresh-job.test.ts`; fixed v1.1.75, hardened v1.1.136 — see §17.3.)
- **Smart caching** (`refreshTickers`, unless `force`): never overwrite a `manual` entry; **skip** a ticker that already has a *future* `report_date` (still valid); only (re)fetch tickers whose stored date is in the past or missing. Skipped tickers incur no API delay. If E*Trade is not connected, the fallback refresh returns `skipped` with a message rather than looping failed calls.

## 17.2 Date parsing & the Saturday→Friday correction

- `MM/DD/YYYY` is parsed **by regex**, not `new Date()`, to avoid local-time→UTC drift: `mdy → ${yyyy}-${mm}-${dd}`. ISO and Unix-seconds inputs are also handled.
- **E*Trade dates are UTC.** Companies report after ET market close, so a date that is "Saturday UTC" is actually "Friday ET". The service shifts **Saturday → Friday** (`−1 day`) and marks the entry `confirmed = 0`. Sunday dates are left as-is but also marked unconfirmed (UI warning). Weekday dates are `confirmed = 1`.

## 17.3 Refresh batch job

`earnings-refresh-job.ts` is a batch job (§20): universe = all unique tickers from `constituents` (S&P 500 + Russell 1000). Runs on startup (+60s) and after close (`after_close_only`). Two phases:
- **Phase 1 — Finnhub adaptive bulk sweep (rewritten v1.1.136).** One recursive sweep over `today→+180d`. **Finnhub's free tier caps a bulk response at 1500 entries and truncates from the FRONT, so a full response means "this window overflowed and you are seeing only its tail" — never "here is the whole window."** `sweepBulkWindow` therefore treats a response *at* the cap as a subdivision signal and halves the range until every slice returns under it (guarded by `MAX_BULK_CALLS` = 160; 1 call/s). A fixed chunk size is not sufficient — peak season needs slices as narrow as ~5 days (measured 2026-08: `2026-10-27…10-31` = 639 entries, but `2026-10-27…11-05` overflows). Collected entries are filtered to the constituent set, reduced to the **nearest future date per ticker in one pass** (so slice order cannot affect the result), then upserted with source `'finnhub'`.
- **Bulk may only ever move a stored future date NEARER (v1.1.136).** Never further out: Finnhub's bulk has coverage gaps, and a gap that hides a near date while returning the following quarter would push the stored date out — which is precisely the failure this job exists to prevent. Moving nearer is fail-safe (the penalty engages earlier) and is also what heals rows poisoned by the pre-v1.1.136 truncation, since poison always reads too FAR. A report that genuinely slips later is picked up by Phase 2 once the stored date goes stale.
- **The pre-v1.1.136 fixed windows (`today→+90d`, `+90d→+180d`) could only ever write far dates during earnings season.** Verified against the live API: the exact call the job made on 2026-08-25 (`from=2026-08-25&to=2026-11-23`) returned 1500 entries spanning **only 2026-11-09 … 11-23**. This stored NVDA's **2026-08-26** report as **2026-11-17**, hiding it from the −20 penalty on the very day it printed (brief ranked it wheel #1). The v1.1.75 nearest-wins guard was powerless — the near date was never in the payload to compare against.
- **Phase 2 — Finnhub per-ticker.** A 365-day window is fetched per ticker, future entries sorted ascending, **nearest** kept. Rate-limited 1 call/s. Selected when a ticker has **no row**, a **stale row** (stored date has passed), or — **v1.1.136** — a row dated **beyond the 180d sweep horizon**, which is the truncation bug's signature and is past what the sweep can see to correct. Before v1.1.136 the filter trusted *any* stored future date, so a bogus far date written by the truncated bulk call permanently suppressed the very lookup that would have corrected it: the per-ticker endpoint returns every quarter and picks the nearest (`NVDA → [2026-11-17, 2026-08-26]`), so it always had the right answer and was simply never asked.

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
