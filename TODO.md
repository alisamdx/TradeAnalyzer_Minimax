# TODO

## Planned Features

### Backtesting Engine (v0.13.0)
- **Status**: Designed, not yet implemented
- **Goal**: Simulate Wheel/CSP/Covered Call strategies against historical OHLCV data and report performance metrics
- **Sprint 1 — Foundation**:
  - [ ] `migrations/009_backtest.sql` — 4 new tables: `backtest_configs`, `backtest_runs`, `backtest_trades`, `backtest_metrics`
  - [ ] `src/shared/types.ts` — add `BacktestConfig`, `BacktestRunSummary`, `BacktestRunDetail`, `BacktestMetrics`, `BacktestTradeRow`, `BacktestProgressEvent`
  - [ ] `src/main/services/backtest-data-service.ts` — OHLCV cache reuse, rolling vol, Black-Scholes option pricing, strike finder
  - [ ] `src/main/services/backtest-metrics.ts` — pure computation: Sharpe, max drawdown, win rate, equity curve, annualized return
- **Sprint 2 — Engine + IPC**:
  - [ ] `src/main/services/backtest-engine.ts` — day-by-day simulation loop (expiration check → exit check → entry check → equity snapshot)
  - [ ] `src/main/ipc/ipc-backtest.ts` — 12 channels: `backtest:config:*`, `backtest:run:*`
  - [ ] Wire into `src/main/index.ts` and extend `JobType` in `job-queue.ts`
- **Sprint 3 — Preload + Basic UI**:
  - [ ] `src/preload/index.ts` — expose `window.api.backtest.*`
  - [ ] `src/renderer/src/hooks/useBacktest.ts`
  - [ ] `src/renderer/src/views/BacktestView.tsx` — config form + run progress sub-views
  - [ ] Add Backtest nav entry to `src/renderer/src/App.tsx`
- **Sprint 4 — Results + Compare**:
  - [ ] Results panel: metrics cards, Recharts equity curve, paginated trade log
  - [ ] Compare panel: dual equity curves on one chart, metrics diff table
- **Key design decisions**:
  - Options pricing via Black-Scholes + 20-day rolling historical vol (no live options history needed)
  - Batch SQLite writes every 50 days to avoid per-row insert overhead
  - Progress events pushed every 5 simulation days (not every day) to avoid IPC flooding
  - Cancel token is a shared `{ cancelled: boolean }` reference in the main process

---

## Data Fields Still Missing

### Beta
- **Status**: Not available from Polygon API
- **Issue**: Polygon's `/v3/reference/tickers/{ticker}` endpoint does not include beta coefficient
- **Impact**: Beta filter in screener defaults to 1.0 (neutral)
- **Options**:
  1. Compute beta from historical price data vs SPY (requires fetching price history)
  2. Use a third-party data source for beta
  3. Leave as null and document the limitation

### Free Cash Flow (FCF) / Capital Expenditures
- **Status**: Capital expenditures not consistently available in Polygon financials
- **Issue**: Polygon's `/vX/reference/financials` response has `net_cash_flow_from_operating_activities` but `capital_expenditures` field is often missing
- **Impact**: FCF calculation may be incomplete (only operating cash flow, minus unknown capex)
- **Current Behavior**: FCF will show operating cash flow value if capex is unavailable, which is an overestimate
- **Options**:
  1. Accept the limitation and show "OCF only" when capex is unavailable
  2. Estimate capex from investing cash flow section
  3. Mark FCF as null when capex is unavailable