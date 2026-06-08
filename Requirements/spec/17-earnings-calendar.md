# 17 — Earnings Calendar

Earnings is the #1 event that blows up CSP/CC positions, so the app tracks upcoming earnings dates and annotates them everywhere a DTE window matters. Service: `earnings-service.ts` (+ `earnings-refresh-job.ts`). IPC: `window.api.earnings.*`. View: `EarningsCalendarView.tsx` (📅 Earnings). Table: `earnings_calendar` (§2.19).

## 17.1 Source & smart caching

- **E*Trade only** (no Polygon public earnings endpoint). The date comes from the quote: `GET /v1/market/quote/{ticker}?detailFlag=ALL&requireEarningsDate=true` → `QuoteResponse.QuoteData[0].All.nextEarningDate` (an `MM/DD/YYYY` string). The `requireEarningsDate=true` param is **required** — without it the field returns `""`.
- **Smart caching** (`refreshTickers`, unless `force`): never overwrite a `manual` entry; **skip** a ticker that already has a *future* `report_date` (still valid); only (re)fetch tickers whose stored date is in the past or missing. Skipped tickers incur no API delay. If E*Trade is not connected, the refresh returns `skipped` with a message rather than looping failed calls.

## 17.2 Date parsing & the Saturday→Friday correction

- `MM/DD/YYYY` is parsed **by regex**, not `new Date()`, to avoid local-time→UTC drift: `mdy → ${yyyy}-${mm}-${dd}`. ISO and Unix-seconds inputs are also handled.
- **E*Trade dates are UTC.** Companies report after ET market close, so a date that is "Saturday UTC" is actually "Friday ET". The service shifts **Saturday → Friday** (`−1 day`) and marks the entry `confirmed = 0`. Sunday dates are left as-is but also marked unconfirmed (UI warning). Weekday dates are `confirmed = 1`.

## 17.3 Refresh batch job

`earnings-refresh-job.ts` is a batch job (§20): universe = all unique tickers from `constituents` (S&P 500 + Russell 1000). Runs on startup (+60s, after E*Trade tokens load) and respects the smart cache, so most launches are all-skips. Per-job `callDelayMs` config (default 500ms) applies only to tickers that actually call E*Trade. Early-exits as `skipped` if E*Trade is not connected.

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
