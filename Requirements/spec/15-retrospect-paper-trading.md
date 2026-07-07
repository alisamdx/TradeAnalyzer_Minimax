# 15 — Retrospect & Paper Trading

Every Daily Brief pick is automatically tracked as a paper trade so the scoring engine can be validated against real outcomes. Service: `paper-trading-service.ts` (+ `daily-paper-snapshot-job.ts`). IPC: `window.api.paper.*`. View: `RetrospectView.tsx` (🪞 Retrospect). Tables: `paper_trades`, `paper_trade_snapshots`, `brief_learning_recommendations` (§2.15).

## 15.1 Auto-capture

After each brief run (Stage 6, §14), `autoCapture()` inserts every post-liquidity-gate pick as a paper trade: strategy, brief score/rank, ticker, brief date, the Strategy-Lab structure (legs JSON), entry date/price, entry premium (net credit + / debit −), and expiry. The unique key `(ticker, brief_strategy, brief_date)` means a same-day re-run **updates** rather than duplicates. No API calls beyond what the brief already made (Tier-1 stock-return tracking).

## 15.2 Daily snapshots

`daily-paper-snapshot-job.ts` (§20) writes one `paper_trade_snapshots` row per open trade per trading day after entry: EOD close (from `historical_prices`), `days_held`, `return_pct` (stock), a strategy-aware `verdict` (positive / negative / neutral), and — since v1.1.84 — the real **`structure_pnl` / `structure_return_pct`** (Black-Scholes-marked from the trade's legs at entry IV, per-leg expiry; `structure-mark.ts`, `docs/formulas.md#structure-mark`). Idempotent via the `(paper_trade_id, snapshot_date)` unique key. These fixed-horizon snapshots (Day+1, Day+5, …) drive accuracy metrics and signal correlations.

## 15.3 Expiry & close

On view load, open trades past expiry are auto-expired from `historical_prices`. The user can also Close or Delete a trade. At close/expire `stock_return_pct` and realized `structure_pnl` are set, and **`outcome` (win/loss/breakeven) derives from `structure_pnl`** — the real option-structure money outcome (win > +$5 / loss < −$5), falling back to the stock-direction proxy (income = within ±8%, bearish = stock fell, else = stock rose) only when the legs can't be priced (v1.1.84). The Retrospect History table shows a **Struct P&L** column beside the stock %. Day-0 verdicts are suppressed (`daysHeld < 1` → Neutral/Hold, since the price may predate the entry).

## 15.4 Retrospect view (4 tabs)

- **In Progress** — open positions grouped by brief date: stock return %, delta-based estimated P&L, a Positive/Negative/Neutral verdict, a Hold/Close-signal recommendation, expandable legs, Close/Delete actions. A Close signal is raised when estimated option P&L < −(2× entry premium) regardless of stock move (catches IV/theta losses). The header's "⚠ N Close Signals" / "✓ N Take Profits" badges (counted across *all* brief dates, not just the one shown) each carry a **Close All** button that bulk-closes every open position matching that flag in one confirm-gated action, instead of switching through each brief date and closing rows individually.
- **Summary** — win rate and average return per strategy, best/worst trade, and the learning recommendations.
- **History** — closed/expired trades.
- **Settings** — per-strategy thresholds (configurable `RetroSettings`).

IPC: `listOpen`, `listClosed(limit?)`, `close(id, notes?)`, `closeBulk(ids[], notes?)`, `delete(id)`, `summary`, `strategyBreakdown`, `expireStale`, `getSettings`, `saveSettings`, `briefAccuracy(briefDates[])`, `snapshotAccuracy`, `getLearningRecommendations`, `acknowledgeRecommendation(id)`.

## 15.5 Learning capture

When a trade closes/expires, Claude (`claude-haiku-4-5`) classifies the structured **gap cause** (`IV_CRUSH | TREND_REVERSAL | EARNINGS_GAP_RISK | THETA_UNDERESTIMATE | EARLY_CLOSE_MISSED | MODEL_ERROR`) plus a narrative `TradeLearning` (strategyWorked, entryFit, keyLesson, suggestedTweak), stored in `paper_trades.learning_json`. When the same `(strategy, gap_cause)` recurs **≥ 3×**, a `brief_learning_recommendations` row is generated (description + proposed tweak) and shown in the Summary tab and the Daily Brief.

## 15.6 Accuracy feedback

`briefAccuracy` / `snapshotAccuracy` compute hit rates at fixed horizons; the Daily Brief history bar shows an accuracy chip and banner. This closes the loop: scoring weights → picks → outcomes → correlations/recommendations → weight adjustments (§13.5).
