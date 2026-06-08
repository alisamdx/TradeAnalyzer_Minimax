# 07 — Validation Dashboard

The deep-dive, per-stock screen. The user selects a watchlist, drills into a single ticker, and sees a full validation dashboard. "Validate All" runs the dashboard for every ticker in the watchlist as a resumable batch. Service: `validate-all-service.ts` (builds the dashboard result + indicators). IPC: `window.api.validate.*` and `window.api.validateAll.*`. View: `ValidateView.tsx` (🎯 Validate).

## 7.1 Workflow

- **FR-4.1** Pick a watchlist → its tickers appear in a left-hand panel (`getTickers`).
- **FR-4.2** Click a ticker → the right pane loads the dashboard (`openTickerById`). A spinner shows; sections render as data arrives.
- **FR-4.3** A Refresh button re-pulls all data for the active stock and timestamps the result.
- **FR-4.4** "Validate All" iterates every ticker sequentially (resumable via `job_runs`/`job_progress`), caches results, and shows a status grid (green = pass, yellow = caution, red = fail), sortable. Streams per-ticker results via `onTickerSignal`. IPC: `runValidateAll`, `getStatus`, `cancel`.

## 7.2 Dashboard sections

### A. Executive summary (fundamental verdict)
Plain-language verdict — **Strong / Acceptable / Caution / Avoid** — with a 2–4 sentence explanation. Shows P/E, EPS (TTM), revenue growth, profit margin, D/E, ROE. Shows next earnings date, days until earnings, and last 4 quarters EPS estimate vs actual (table/sparkline). **Earnings within 14 days → warning banner.** (Earnings data from §17.)

### B. Market opinion (Buy / Hold / Sell)
Aggregate analyst rating: counts of buys/holds/sells, average price target, % upside vs current price. Rendered as a badge — **BUY** (green) / **HOLD** (gray) / **SELL** (red). (`onTickerSignal` carries `analystBuy/Hold/Sell`, `avgPriceTarget`, `upsidePct`, `analystBadge`.)

### C. Trend (Bullish / Bearish / Sideways)
From price vs 20/50/200 SMA and ADX. Bullish = price > SMA50 > SMA200, ADX > 20; Bearish = price < SMA50 < SMA200, ADX > 20; else Sideways. Shows trend label, ADX value, SMA stack as numeric chips.

### D. Candlestick chart with entry/exit zones
Daily candlestick, default 6-month window, toggleable 1M / 3M / 1Y / 5Y. Overlays: 20/50/200 SMA, volume sub-pane, auto-detected support/resistance lines (swing highs/lows via `support-resistance.ts`). A shaded **suggested entry zone** band and a **stop/exit** line, computed from recent support + ATR + trend mode, with a "how was this calculated?" tooltip (§23 `entry-zone-and-stop`). **Pattern callouts** in the last 5 candles: doji, engulfing, hammer, shooting star, morning/evening star (`pattern-detector.ts`), rendered at price/time coordinates.

### E. Other indicators
- RSI(14), MACD(12/26/9), Bollinger Bands(20, 2σ).
- Volume profile: 30-day average vs today's volume, % anomaly.
- Supply/demand zones: most recent demand zone (base before an up-move) and supply zone (base before a down-move), shaded.
- Implied volatility: current IV, 52-week IV range, **IV rank, IV percentile** (from `iv_history`, §11).
- Short interest % of float (if the provider supplies it).

## 7.3 Buy-signal strength

The dashboard computes a 0–100 buy-signal score (mirrored by the nightly technical-signals job, §20) and a strength label (strong/moderate/none) shown on the ticker row and grid. `onTickerSignal` carries `strength`, `score`, `reasons[]`, `trend`, and the entry/stop/target levels.

## 7.4 Navigation

The ticker symbol and result rows link out to Analysis, Options chain, and Payoff via the cross-view CustomEvents (§1.5). Earnings/News/Brief views deep-link into Validate via `navigate-to-validate`.

## 7.5 Performance (acceptance)

- **FR-4.5** Single-stock validation renders within 5s warm / 10s cold.
- **FR-4.6** Validate All on 50 tickers completes within 5 minutes without freezing the UI (runs in the main-process pipeline; UI stays responsive).
