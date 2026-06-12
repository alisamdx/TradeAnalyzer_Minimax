# Brief Replay — point-in-time backtest of the Daily Intelligence Brief

> **Status: PROPOSED (not built).** Design doc from the 2026-06-11 brainstorm session.
> When implemented, merge into `Requirements/spec/` as its own numbered section and
> remove this file. Listed in `.ai/AI_CONTEXT.md §11 Open decisions`.

## 1. Goal

Run the daily brief pipeline **as of past dates** to backfill weeks/months of picks,
then evaluate them against known forward outcomes — so scoring-config tuning has a
meaningful sample size instead of waiting for live runs to accumulate one day at a
time (the §15 paper-trading retrospect collects the same evidence, but slowly).

**Non-goals:**
- Not a replacement for the live brief or the paper-trading retrospect — replay
  *bootstraps* the sample; live capture remains the ground truth going forward.
- Not an options-pricing backtest. Structure P&L is approximated (see §5); the
  `BacktestEngine` (§21) remains the tool for strategy-level payoff simulation.
- No AI stages in replay (rationale/critic annotate picks but don't change them) —
  replay is deterministic and free of LLM cost.

## 2. Why this is feasible — point-in-time data inventory

| Input | Live source | Point-in-time replay source | Fidelity |
|---|---|---|---|
| Prices, technicals (momentum, MAs, RSI, breakout, rel. strength, sector momentum) | `historical_prices` | same table, `date <= asOf` | exact (~5y depth) |
| IV rank / percentile | `iv_history` | same table, `date <= asOf` | exact within backfill depth (**verify depth before choosing replay window**) |
| Quote (last price, volume) | `quote_cache` | close/volume from bars at `asOf` | exact EOD |
| **Fundamentals** | EDGAR via `sec-edgar-provider.ts` | **same companyfacts JSON, filtered to entries with `filed <= asOf`** | exact knowable-at-the-time — every XBRL fact carries its filing date, so this is true point-in-time incl. restatement correctness |
| Market cap / shares | Polygon ticker details | EDGAR shares outstanding (filed-dated) × close(asOf) | good (buyback drift ~1%/qtr) |
| Beta | `beta-service.ts` (local bars) | same, bars `<= asOf` | exact |
| Dividend yield | Polygon dividends | same endpoint, ex-dates `<= asOf` windowed | exact |
| Earnings dates | Finnhub bulk + E*Trade fallback | Finnhub historical calendar range query | slightly optimistic (replay knows confirmed dates; live had some unconfirmed) |
| Options chains (stage 4) | E*Trade live | **not available** — see §5 | approximated or skipped |
| Constituents | `constituents` (current) | same (today's membership applied backward) | survivorship bias — negligible ≤1 month, real at 12 |

Key implementation note: **one `companyfacts` fetch per ticker serves every replay
date** (filter by `filed` per date in memory). ~1,000 fetches once at SEC's 10 req/s
(~3 min), cached to disk (`data/edgar-cache/` or a table) so re-runs are free.

## 3. Architecture

```
BriefReplayService (new, src/main/services/brief-replay-service.ts)
  runForDate(asOf: string): ReplayBrief
    1. buildSignalDataAsOf(asOf)        ← point-in-time TickerSignalData builder
    2. scoringService.scoreAll(...)     ← UNCHANGED ScoringService + live configs
    3. liquidity proxy gate (§5)
    4. persist top-5/strategy → replay_briefs
  runRange(from, to): iterate NYSE trading days; resumable; progress events
  evaluateOutcomes(): fills outcome columns for matured picks (§6)
```

- **Reuse, don't fork**: stage 2 must call the same `ScoringService` with the same
  `ScoringConfig` rows — the entire point is testing the production configs.
  Signal-data assembly is the only new code path (~80% of the work).
- The point-in-time fundamentals builder lives next to (or inside)
  `sec-edgar-provider.ts`: `getEdgarFundamentalsAsOf(ticker, asOf)` — identical
  slot/TTM/composite logic, with all entry lists pre-filtered to `filed <= asOf`.
- Runs as a manual batch job (`BatchJobHandler`) or an IPC-triggered tool from a
  small view/tab; never on the daily schedule.

## 4. Schema (new tables — own migration)

```sql
replay_briefs (
  id INTEGER PK, as_of_date TEXT, strategy TEXT, picks TEXT /*JSON*/,
  config_version TEXT, created_at TEXT,
  UNIQUE(as_of_date, strategy, config_version)   -- re-run with new configs side-by-side
);
replay_outcomes (
  id INTEGER PK, replay_brief_id INT REFERENCES replay_briefs(id),
  ticker TEXT, rank INT, composite_score REAL,
  entry_price REAL, ret_5d REAL, ret_10d REAL, ret_21d REAL,
  synth_strike REAL, stayed_above_strike INT,    -- wheel/income proxy (§6)
  max_drawdown_21d REAL, evaluated_at TEXT
);
```

`daily_briefs` and paper-trading tables are **never** written by replay.

## 5. Stage-4 problem (no historical E*Trade chains) — decision needed

| Option | Approach | Cost | Fidelity |
|---|---|---|---|
| **A (recommended v1)** | Skip structures. Picks = top-5 by composite after a liquidity proxy (stock avg volume ≥ 1M, price band). | none | rankings exact; no credits/POP |
| B | Synthesize: strike = delta-target via Black-Scholes from close(asOf) + ATM IV(asOf); credit/POP approximated | none | ±, good enough for win/loss proxies |
| C | MarketData.app historical chains for picks only (~25/day) | API credits (~550/replayed month) | real chains |

v1 ships A with B's synthetic strike used only by the outcome evaluator (§6).
C is an upgrade path if synthetic results look promising but credit-sized decisions
are needed.

## 6. Outcome evaluation (from forward bars only)

- **buy / bullish**: 5/10/21-day forward returns vs SPY (excess return), max drawdown.
- **bearish**: inverse — did the name underperform/decline.
- **wheel / income**: synthesize short strike (≈ delta-30: `K = S·(1 − 0.5·IV·√(DTE/365))`,
  30 DTE), then `stayed_above_strike` through expiry from daily lows ⇒ win proxy
  (premium capture); breach ⇒ assignment/loss proxy. No chain needed.
- Aggregations for the analysis pass: hit rate by strategy / by signal bucket /
  by score decile; signal-level lift (picks where signal X was top-weighted vs not).
  Surface as CSV export first; a view is a later nicety.

## 7. Biases & honest limits (print these on the analysis output)

1. **Overlapping samples**: ~22 daily briefs/month ≈ 4–8 independent observations
   per strategy (picks repeat; hold windows overlap). One month = trend signal only.
   Tuning-grade conclusions want 6–12 months — bounded by `iv_history` depth.
2. **Survivorship**: current constituents replayed backward.
3. **Earnings hindsight**: replay uses confirmed dates the live run may not have had.
4. **Regime fit**: tuning weights on one window fits one regime (cf. 2025–26's
   negative-beta energy/staples year). Use replay to *reject broken signals*, not to
   optimize weights to two decimals.
5. **No liquidity truth**: stage-4's real chain-based liquidity gate is approximated.

## 8. Open design questions

1. Replay window: how far back does `iv_history` actually go per ticker? (Check
   before promising 6–12 months.)
2. Stage-4 option A/B/C above.
3. Where outcomes surface: CSV export only, or a Replay tab with the accuracy-chip
   styling from the brief history bar?
4. Reuse `BacktestEngine` (§21) for outcome math vs the lightweight evaluator in §6?
5. Config sweeps: `UNIQUE(as_of_date, strategy, config_version)` already allows
   replaying the same window under candidate configs — in scope for v1 or later?

## 9. Effort estimate

- Point-in-time signal builder (incl. `getEdgarFundamentalsAsOf` + EDGAR disk cache): ~1 session
- Replay service + tables + batch job + range runner: ~½ session
- Outcome evaluator + CSV export: ~½ session
- Optional view/tab: ~½ session
