# 06 — Analysis Engine

The Analysis Engine runs five analysis modes over a watchlist (or ticker subset) and produces ranked, filterable, exportable result sets. Service: `analysis-service.ts` (modes + the full indicator library). IPC: `window.api.analysis.*`. View: `AnalysisView.tsx` (📊 Analysis).

## 6.1 Workflow

- **FR-3.1/3.2/3.3** Select a watchlist (dropdown shows ticker count); optionally select a subset.
- **One click runs all five modes** (`runAll`). The legacy single-mode `run(mode)` still exists. After a run, five strategy tabs populate: 📈 Buy · 💰 Options Income · 🎯 Wheel · 🐂 Bullish · 🐻 Bearish.
- **FR-3.4** Progress is shown ("Analyzing 47 of 120…") and cancellable (`cancel`, `onProgress` with a `mode` field).
- **FR-3.5** Results are sortable, filterable, CSV-exportable. Each tab has a default sort: Buy → score desc, Options Income → premium desc, Wheel → suitability desc, Bullish/Bearish → max loss desc.
- **FR-3.6** "Save as Watchlist" from selected rows.
- **FR-3.7** Each run is timestamped and stored as a snapshot. A combined run saves one `analysis_snapshots` row with `mode='all'` holding all five mode outputs. Snapshots are listed newest-first below results, individually deletable, with Clear All.

IPC: `listModes`, `run(watchlistId, mode, subset?)`, `runAll(watchlistId, subset?)`, `getSnapshots`, `getSnapshot`, `getAllModesSnapshot`, `deleteSnapshot`, `clearSnapshots`, `saveAsWatchlist`, `cancel`, `onProgress`.

The same `analyzeTicker` engine, with `forceCache: true`, also powers the nightly Daily Options Snapshot job (§20), reading quote/fundamentals/bars from the DB to skip live calls.

## 6.2 Mode 1 — Buy Opportunities

Identifies stocks in a "buy zone." Output columns: ticker, last price, suggested entry zone, stop-loss, target, risk/reward, composite score (0–10).

Composite score combines trend, momentum (RSI), valuation/quality, and volume-profile position. Full point table in §23 (`buy-composite-score`). Entry zone / stop / target derive from ATR and the recent swing low (§23 `entry-zone-and-stop`).

## 6.3 Mode 2 — Options Income (CSP & CC)

For each ticker, evaluates cash-secured put and covered call candidates **30–45 DTE, delta 0.20–0.35**. Output columns: ticker, strategy (CSP/CC), strike, expiration, DTE, delta, premium, annualized return, IV rank, breakeven, capital required (plus Bid, Ask, OI of the selected contract).

Annualized return: `(premium / (strike × 100)) × (365 / DTE) × 100` (§23 `annualized-options-return`).

## 6.4 Mode 3 — Wheel Strategy

Screens for wheel-suitable stocks: stable uptrend or sideways, IV rank ≥ 30, no earnings within the DTE window, option liquidity (OI ≥ 500, bid-ask ≤ 5% of mid), acceptable assignment risk (not at 52-week extremes). Recommends a CSP **30–45 DTE at delta 0.20–0.30**.

Output columns: ticker, recommended CSP strike, expiration, DTE, delta, premium, annualized return on capital, IV rank, days to earnings, option liquidity score, overall suitability score (1–10). The suitability formula is a transparent weighted score (§23 `wheel-suitability-score`).

## 6.5 Mode 4 — Bullish Trend Strategies

Identifies bullish-trending stocks and proposes the appropriate structure: long call, bull call spread, or short put, with strikes and expirations. Output columns: ticker, trend strength, suggested strategy, structure (legs/strikes/expirations), max profit, max loss, breakeven, probability of profit.

## 6.6 Mode 5 — Bearish Trend Strategies

Same shape as Mode 4 for bearish trends: long put, bear put spread, or short call.

## 6.7 Indicator library

`analysis-service.ts` implements the shared indicator math used here, in Validate (§07), and in the technical-signals job (§20). All formulas are written out in §23:
- `computeSMA(n)`, `computeEMA(n)`, `computeRSI(14)`, `computeATR(14)`, `computeADX(14)`, `computeMACD(12/26/9)`, Bollinger Bands (20, 2σ).
- `computeVolumeProfileLevels()` → POC / VAH / VAL (24 bins, 70% value area).
- Trend classification: Bullish = price > SMA50 > SMA200 & ADX > 20; Bearish = price < SMA50 < SMA200 & ADX > 20; else Sideways.

## 6.8 Acceptance criteria

- Running all modes on a watchlist completes with progress + cancel, produces five populated tabs, and stores one resumable snapshot.
- Saving N selected result rows creates a watchlist with exactly those N tickers.
- Every derived number traces to a §23 formula.
