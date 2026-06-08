# 11 — IV History (true IV Rank / Percentile)

Polygon's snapshot does not provide IV rank or percentile, yet they are the single most important variables for premium selling. This feature builds them from real historical implied volatility. Service: `iv-history-service.ts` (+ `marketdata-provider.ts`, `ivolatility-provider.ts`). IPC: `window.api.ivHistory.*`. View: `IvHistoryView.tsx` (🗓️ History). Table: `iv_history` (§2.8).

## 11.1 What is stored

One row per ticker per trading day holding the **30-day constant-maturity ATM implied volatility** (`atm_iv`, a decimal fraction, e.g. 0.285). With ≥ 252 trading days of history, IV rank and percentile become exact.

## 11.2 30-day ATM IV computation (`computeAtmIv`)

```
1. Group all contracts by expiration date.
2. For each expiration, find the ATM strike (nearest to underlying) that has both a
   call IV and a put IV.  ATM_IV_exp = (call_iv + put_iv) / 2.
3. near = expiration with the highest DTE ≤ 30; far = the lowest DTE > 30.
4. weight_near = (dte_far − 30) / (dte_far − dte_near);  weight_far = 1 − weight_near
   ATM_IV_30d  = ATM_IV_near × weight_near + ATM_IV_far × weight_far
```
If only one side of the 30-DTE bracket exists, use that expiration's IV directly. IVs are decimal fractions throughout.

## 11.3 IV Rank / Percentile (`getIvRank`)

```
IV Rank       = (current_iv − min_iv_252d) / (max_iv_252d − min_iv_252d) × 100
IV Percentile = count(days where iv < current_iv) / total_days × 100
```
- `current_iv` = today's most recent reading.
- min/max over the trailing 252 trading-day window.
- **At least 21 data points required**, else returns null.

NYSE trading days = calendar weekdays minus a hardcoded `NYSE_HOLIDAYS` set (2023–2027, extend as needed). `tradingDaysInRange(from, to)` drives gap detection.

## 11.4 Data sourcing

- **Backfill** (historical): MarketData.app historical chains (Trader trial gives ~100k credits/day for the initial 252-day load; Starter ~10k/day for ongoing gaps). IVolatility is an alternative IVX source. `source` column records origin (`marketdata|etrade|polygon`).
- **Daily auto-capture**: whenever the app fetches an E*Trade options chain for any reason, `captureFromEtradeChain()` silently stores today's ATM IV — no extra API call.

## 11.5 Backfill orchestration

`runBackfill(phase)` runs phased loads with progress events: `initial_sp500`, `initial_russell` (only the names new vs S&P 500), `etf`, and `gap_fill` (fills missing `(ticker, date)` pairs). Cancellable.

IPC: `getCoverage(universe)` (complete/partial/none counts), `getGaps(universe)`, `startBackfill(phase)`, `cancel`, `getRank(ticker)`, `getRanks(tickers[])`, `getRows(ticker)`, `getInitialLoadStatus()`, `onProgress`.

## 11.6 Consumers

IV rank/percentile feed the screener filters, wheel suitability, Opportunity score (§12), scoring engine (§13), LEAPS screeners (§10), Strategy Lab (§09), and the Validate dashboard IV section (§07). The MarketData.app and IVolatility keys are entered in Settings/Test API and stored encrypted.
