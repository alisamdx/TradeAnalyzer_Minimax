# IV History — Detailed Design
_Designed: 2026-05-30 | Implements ENH-1 from enhancements.md_

---

## Goal

Compute accurate IV Rank and IV Percentile for every ticker in the screener universe.
These metrics are the primary entry filter for premium-selling strategies (wheel, CSP, CC, spreads).
No proxy calculations — this uses real implied volatility from options markets.

---

## What IV Rank Is

```
IV Rank       = (current_iv − min_iv_252d) / (max_iv_252d − min_iv_252d) × 100
IV Percentile = count(days where daily_iv < current_iv) / total_days × 100
```

`current_iv` and each daily reading = **30-day constant-maturity ATM implied volatility**:
the market's implied vol interpolated to a fixed 30-day horizon, computed fresh each trading day
from the live options chain. This matches how tastytrade (IVx) and thinkorswim (IV30) compute it.

---

## ATM IV Computation (per ticker, per day)

Given an options chain for a specific date:

1. Find the **two expirations that bracket 30 DTE** on that date (e.g., 22 DTE and 43 DTE).
   If only one side is available, use it directly without interpolation.
2. At each expiration, find the **ATM strike**: the strike nearest to the underlying price.
3. Average the call IV and put IV at that strike:
   `atm_iv = (call_iv + put_iv) / 2`
   (Put-call parity keeps these close; averaging removes the small skew bias.)
4. **Linear interpolation by DTE weight** between the two expirations:
   ```
   weight_near = (dte_far − 30) / (dte_far − dte_near)
   weight_far  = 1 − weight_near
   iv_30d      = iv_near × weight_near + iv_far × weight_far
   ```
5. Store `iv_30d` as the day's reading. Skip the day if no valid chain is returned.

All IV values stored and computed as **decimals** (0.285 = 28.5%) consistent with the rest of the app.

---

## Data Sources

| Operation | Source | Reason |
|---|---|---|
| Initial 252-day backfill | MarketData.app (Trader trial) | Historical options chains with `date=` param; 100k credits/day |
| Ongoing gap fills | MarketData.app (Starter, $12/month) | Same historical endpoint; 10k credits/day — sufficient for weekly fills |
| Daily auto-capture | E*Trade (free, already integrated) | When app fetches any options chain, silently store today's IV — no extra cost |

**API provider search conducted 2026-05-30:** E*Trade (`detailFlag=ALL`), Tradier, MarketData.app,
and Seeking Alpha were all evaluated. None pre-compute IV rank. MarketData.app was chosen as the
historical source because it supports date-range queries on options chains at a reasonable price.

### MarketData.app API Token

Stored encrypted in settings under key `marketdataApiToken` (same secure-settings pattern as E*Trade).
A single token covers both the Trader trial and the Starter plan after downgrade — the token does not
change when the plan tier changes, only the daily credit limit does.

Two configurable fields in Settings → Data Sources:
- **API Token** — the MarketData.app bearer token
- **Daily Credit Limit** — user sets this to match their plan (100,000 for Trader, 10,000 for Starter)
  Used by the rate limiter to avoid exceeding the daily cap.

---

## Database Schema

```sql
-- migration: 013_iv_history.sql
CREATE TABLE IF NOT EXISTS iv_history (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker          TEXT    NOT NULL,
  date            TEXT    NOT NULL,        -- YYYY-MM-DD (trading day, ET)
  atm_iv          REAL    NOT NULL,        -- 30-day constant-maturity IV, decimal (0.285 = 28.5%)
  underlying_px   REAL,                   -- stock price when IV was captured
  exp_near        TEXT,                   -- nearer expiration used (YYYY-MM-DD)
  exp_far         TEXT,                   -- farther expiration used (YYYY-MM-DD)
  dte_near        INTEGER,                -- DTE of near expiration on this date
  dte_far         INTEGER,                -- DTE of far expiration on this date
  source          TEXT    NOT NULL,        -- 'marketdata' | 'etrade' | 'polygon'
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_iv_history_ticker_date ON iv_history(ticker, date);
CREATE INDEX IF NOT EXISTS idx_iv_history_ticker           ON iv_history(ticker);
CREATE INDEX IF NOT EXISTS idx_iv_history_date             ON iv_history(date);
```

---

## Screen: "Historical IV Sync"

New sidebar tab: **📊 IV History**. Follows the existing `.card` pattern from DataView/ValidateView.

### Coverage Summary (always visible)

Four stat cards:

| Stat | Description |
|---|---|
| Complete | Tickers with ≥ 252 days of history |
| Partial | Tickers with 1–251 days |
| No History | Tickers with zero rows |
| Last Refresh | Most recent date across all tickers, or "Never" |

---

### Section 1 — Initial Load

Two sequential steps. Step 2 is disabled until Step 1 shows Complete status.

```
┌─ Initial Load ───────────────────────────────────────────────────────┐
│                                                                       │
│  Step 1 — S&P 500                                                     │
│  503 tickers × 252 days ≈ 126,756 API calls                          │
│  Uses: MarketData.app (Trader trial — 100,000 credits/day)            │
│  Estimated time: ~1.5 days at max rate                               │
│  Status: [badge — Not Started | In Progress | ✓ Complete YYYY-MM-DD] │
│  [▶ Load S&P 500]                                                     │
│                                                                       │
│  Step 2 — Russell 1000                                                │
│  ~497 new tickers  ·  503 already loaded from S&P 500 will be skipped │
│  Uses: MarketData.app (Trader trial — 100,000 credits/day)            │
│  Status: [badge]                                                      │
│  [▶ Load Russell 1000]   (disabled until Step 1 complete)             │
│                                                                       │
└───────────────────────────────────────────────────────────────────────┘
```

The "already loaded" count is live — queried from `iv_history` at render time and updates as the
backfill progresses. Step 2 skips any ticker that already has ≥ 1 row in `iv_history`.

---

### Section 2 — Ongoing Refresh

```
┌─ Ongoing Refresh ────────────────────────────────────────────────────┐
│                                                                       │
│  Uses: MarketData.app Starter token  ·  10,000 credits/day limit     │
│                                                                       │
│  Last refresh: 2026-05-27    Universe: S&P 500                        │
│                                                                       │
│  Gap analysis                                                         │
│  3 missing trading days  (2026-05-28 → 2026-05-30)                   │
│  503 tickers × 3 days = 1,509 API calls  (within daily limit)        │
│                                                                       │
│  [↻ Fill Missing Days]                                                │
│                                                                       │
│  ℹ  Run weekly or whenever convenient. The system fetches only        │
│     missing (ticker, date) pairs. Weekends and market holidays        │
│     are automatically excluded from the gap calculation.              │
│                                                                       │
│  Also: today's IV is captured automatically whenever the app          │
│  fetches an options chain via E*Trade — no manual action needed       │
│  for the current trading day.                                         │
│                                                                       │
└───────────────────────────────────────────────────────────────────────┘
```

**Gap detection algorithm:**
1. Get all tickers in the loaded universe from the `constituents` table
2. For each ticker, find its `MAX(date)` in `iv_history`
3. Find the global minimum of those max dates = the "oldest gap frontier"
4. Generate all trading days from the oldest gap frontier + 1 day through yesterday (ET)
5. For each `(ticker, date)` pair that is absent from `iv_history`, add to the fetch queue
6. Order queue by date ascending so history fills in chronologically

**Trading days:** weekdays excluding NYSE holidays. A hardcoded holiday list is maintained in
`iv-history-service.ts` covering ±2 years from the current date. No API call required.

**Yesterday cutoff:** IV rank uses end-of-day IV. The cutoff is always the previous trading day —
today's market may still be open or the close not yet settled.

---

### Section 3 — Progress Panel (shown only while a job is running)

```
┌─ Progress ───────────────────────────────────────────────────────────┐
│  Phase: Initial Load — S&P 500                                        │
│  Fetching: AAPL  ·  Date: 2025-08-14  ·  Pair 14,223 of 42,000      │
│                                                                       │
│  [████████████░░░░░░░░░░░░░░░░░░░░░]  34%                           │
│  52 calls/min  ·  Elapsed: 4h 33m  ·  Remaining: ~9h                │
│                                                                       │
│  [⏸ Pause]   [■ Cancel]                                              │
└───────────────────────────────────────────────────────────────────────┘
```

Pause suspends between (ticker, date) pairs — the next resume picks up from the last completed pair.
Cancel marks the job stopped; a future run fills any remaining gaps automatically.

---

## API Credit Estimates

| Operation | Calls | Trader (100k/day) | Starter (10k/day) |
|---|---|---|---|
| S&P 500 initial backfill | ~126,756 | ~1.5 days | ~13 days |
| Russell 1000 top-up (~497 new tickers) | ~125,244 | ~1.5 days | ~13 days |
| Weekly gap fill — S&P 500 (5 days) | 2,515 | minutes | minutes |
| Weekly gap fill — Russell 1000 (5 days) | 5,000 | minutes | ~30 min |

Weekly gap fills comfortably fit within the Starter 10,000/day limit with capacity to spare.

---

## Rate Limiting

MarketData.app calls go through a dedicated `TokenBucketRateLimiter` instance separate from Polygon.
Default rate: **50 req/min** (conservative, well within both Trader and Starter plan limits).
The rate is configurable in Settings alongside the daily credit limit.

---

## Service: `IvHistoryService`

Key methods:

| Method | Description |
|---|---|
| `computeAtmIv(chain, underlyingPx)` | Computes 30-day constant-maturity IV from a raw options chain |
| `storeReading(ticker, date, atmIv, meta)` | Upserts one row into `iv_history` |
| `getIvRank(ticker)` | Returns `{ ivRank, ivPercentile, currentIv, dataPoints, oldestDate }` or null if < 21 days |
| `getCoverage()` | Returns stat card data (complete / partial / none counts, last refresh) |
| `getGaps(universe)` | Returns sorted list of `(ticker, date)` pairs missing from `iv_history` |
| `runBackfill(type, universe)` | Orchestrates full backfill or gap fill with progress events |
| `captureToday(ticker, chain)` | Called by existing IPC handlers — stores today's IV from an E*Trade chain |

`getIvRank` requires a minimum of **21 data points** before returning a value (returns null below
this threshold so downstream views show "Accumulating" rather than a misleading number).

---

## Settings Additions

Under Settings → Data Sources (new subsection: MarketData.app):

| Field | Key | Description |
|---|---|---|
| API Token | `marketdataApiToken` | Bearer token from marketdata.app dashboard |
| Daily Credit Limit | `marketdataDailyCredits` | 100000 (Trader) or 10000 (Starter) — controls rate limiter |

Token stored encrypted via `secure-settings.ts`. Never logged.

---

## Integration Points (consuming IV rank)

Once `iv_history` has data, IV rank is surfaced in:

| View | Usage |
|---|---|
| Screener | New filter: `IV Rank ≥ N` (default 30 for options income presets) |
| Analysis view — Options Income & Wheel modes | IV rank + percentile displayed prominently |
| Validate dashboard | IV rank row in the options section |
| LEAPS+CSP screener | Replaces the current null IV rank in the market gate and candidate scoring |
| Morning Briefing — Top Setups | IV rank column in the setups table |

---

## Build Checklist

- [ ] `migrations/013_iv_history.sql` — table + indexes
- [ ] `src/main/services/marketdata-provider.ts` — HTTP client, rate limiter, `getOptionsChain(ticker, date)`
- [ ] `src/main/services/iv-history-service.ts` — ATM IV computation, gap detection, rank queries, backfill orchestration
- [ ] `src/main/ipc/ipc-iv-history.ts` — IPC handlers + progress events
- [ ] `src/preload/index.ts` — `window.api.ivHistory.*` bridge
- [ ] Settings — MarketData.app token + daily credit limit fields
- [ ] `src/renderer/src/views/IvHistoryView.tsx` — the sync screen
- [ ] `src/renderer/src/App.tsx` — add "📊 IV History" sidebar tab
- [ ] Integration — wire `getIvRank()` into screener, analysis, validate, LEAPS+CSP, briefing views

---

_See `Requirements/enhancements.md` ENH-1 for the high-level context and prioritization._
