# 13 — Trade Scoring Engine

A configurable, transparent engine that scores every universe ticker for each of five strategies. It is the ranking brain behind the Daily Brief (§14). Service: `scoring-service.ts`. IPC: `window.api.scoring.*`. View: `TradeScoringView.tsx` (⚖ Trade Scoring). Tables: `scoring_strategy_configs`, plus read access to `technical_signals`, `screen_results`, `historical_prices`, `iv_history`, `analysis_snapshots` (§2.14).

## 13.1 Five strategies

`wheel | bullish | bearish | income | buy`. Each has its own weighted signal set whose **weights sum to 100**.

## 13.2 Signal model

Each `ScoringSignal`:
```ts
{
  key: string,             // e.g. 'ivRank'
  label, description, dataSource,
  weight: number,          // 0–… (set sums to 100)
  enabled: boolean,
  direction: 'higher_better' | 'lower_better' | 'target_range',
  normMax?: number,        // value mapped to 100 for higher/lower_better
  targetMin?, targetMax?,  // for target_range
}
```

**Normalization** maps each raw signal value to 0–100:
- `higher_better`: `clamp(value / normMax × 100, 0, 100)`.
- `lower_better`: `clamp((1 − value / normMax) × 100, 0, 100)`.
- `target_range`: 100 inside `[targetMin, targetMax]`, falling off linearly outside.

**Composite score** = Σ (normalized signal × weight) / Σ weights, over enabled signals only. Missing signal data is skipped (its weight drops out), so partial data still scores.

`gatherSignalData()` assembles raw values per ticker from the local tables (no live API calls — the batch jobs precompute everything).

## 13.3 Baseline configs (`baseline_v2`)

Seeded on first run; user can edit weights/toggles and **Reset to Baseline** per strategy. Baseline weights:

**Wheel** — ivRank 22, premiumYield 19, fundamentalScore 17, technicalNeutral (RSI 40–60, target) 11, notDowntrend 8, recentVolatility (lower) 10, optionLiquidity 9, leverageQuality (ND/EBITDA, lower) 4.

**Income** — ivRank 30, premiumRiskRatio 22, recentVolatility (lower) 20, trendNeutral (lower) 15, optionLiquidity 13. No fundamentals-based signal (income is a pure premium-selling structure, no ownership thesis) — see ETF note below.

**Bullish** — trendStrength 24, earningsGrowth 20, rsiMomentum (45–70, target) 15, buySignalScore 12, relativeStrength 12, priceMomentumPct 7, sectorMomentum 5, revenueGrowth5Y 5.

**Bearish** — downtrendScore 26, fundamentalWeakness (lower) 22, rsiOverbought (60–80, target) 17, relativeWeakness (lower) 13, priceDecayPct (lower) 9, sectorWeakness 7, leverageRisk 6.

**Buy** — priceMomentumPct 24, earningsGrowth 18, breakoutScore 14, buySignalScore 14, relativeStrength 14, revenueGrowth5Y 7, sectorMomentum 6, epsGrowth5Y 3.

**Inflection** (breakout credit spread) — breakoutDecisiveness 30, volumeSurge 25, breakoutIvRank 25, breakoutAtrPct 20. **All four signals are gated on a fresh with-trend breakout** (`technical_signals.breakout_state`): a ticker without one returns null for every signal → composite 0 → never surfaces. Direction (bull put vs bear call spread) comes from the breakout sign — both up and down breakouts are eligible. Brief Replay stores per-pick direction (`replay_outcomes.direction`) so the mixed long/short hit-rate and (direction-adjusted) returns aggregate correctly. See `23-formulas.md` / `docs/formulas.md#breakout-signals`.

Signal value provenance (examples): `ivRank` ← `iv_history`; `buySignalScore` ← `technical_signals`; `relativeStrength`/`priceMomentumPct`/`sectorMomentum` ← `historical_prices` (90-day / 252-day returns, SPDR sector ETF map); `fundamentalScore`/`revenueGrowth5Y`/`epsGrowth5Y`/`leverageQuality` ← `screen_results.payload_json`; `optionLiquidity`/`premiumYield`/`premiumRiskRatio` ← analysis snapshots / wheel metrics; `breakoutScore` ← analysis snapshot (price vs entry-zone-low + MA alignment, null if snapshot > 7 days old).

**`optionLiquidity` null-vs-zero (v1.1.127).** The wheel snapshot's `optionLiquidityScore` is `null` — not `0` — when no CSP chain resolved in the 30–45 DTE / 0.20–0.30 delta window (`wheelOptionLiquidityScore()`, `23-formulas.md` / `docs/formulas.md#liquidity-score`). This is the majority case: **695 of 1,029 rows** on the 2026-08-03 full-universe snapshot. Before the fix those rows persisted a hard `0`, indistinguishable from a genuinely illiquid contract, and carried a *"Low option liquidity."* explanation about a measurement that never ran. **Note this changes no composite**: under the missing-signal rule above, a missing signal contributes 0 to the numerator *and its full weight to the denominator*, identically to a measured 0. The fix corrects the `missing` flag, the Analysis view (`—` rather than `0/10`) and the explanation text — not the score. Making missing-vs-zero actually differ requires excluding missing signals from the denominator (what `ETF_AWARE_WHEEL_SCORING` does for its two signals), which is a separate FR-SEY-5-gated change.

**ETF-aware wheel scoring — NOT YET ENABLED (v1.1.118).** Wheel's `fundamentalScore` (17) and `leverageQuality` (4) are structurally inapplicable to ETFs (no P/E, ROE, or traditional debt for a fund wrapper), so under the missing-signal rule above they are *always* null for an ETF and always zero-contribute — every ETF's wheel composite is deflated ~21% relative to a fully-scored stock, for no reason related to trade quality. Confirmed against the production DB (2026-07-03): 56 of 60 curated ETFs have no `fundamentals_cache` row, and 0 of the last 5 daily wheel briefs contained a single ETF pick — ETF wheel candidates are effectively invisible to the brief regardless of how well they'd otherwise wheel (FiltersView's wheel templates already work around this with an explicit ETF branch; the live brief's scoring engine did not, until this flag). `ETF_AWARE_WHEEL_SCORING` in `scoring-service.ts` (default `false`; override via `SCORING_ETF_AWARE_WHEEL=1` for a validation run) excludes those two signals from **both** the numerator and denominator for an ETF ticker, renormalizing the rest to 100% rather than zero-contributing them (e.g. SPY-shaped signals: composite 58.3 disabled → 73.8 enabled, in `tests/scoring-etf-wheel.test.ts`). This changes wheel composite scores — and therefore Stage-4 pool selection / final picks — for ETF tickers, so per FR-SEY-5 it needs a Brief Replay improvement (or at least neutrality) on ETF wheel outcomes before shipping enabled; left off until validated.

## 13.4 UI

Pill tabs per strategy; a signal grid with direction badges (↑ higher / ↓ lower / ◎ range), weight bars, enable toggles, and a green/red running total row (must reach 100). Version label per strategy. "Reset to Baseline" restores the seed.

## 13.5 Signal correlations (learning aid)

`signalCorrelations(strategy)` computes Pearson r between each signal's value and Day+1 positive paper-trade outcomes (§15), surfaced as a suggestion table ("this signal correlated with winners — consider raising its weight"). Advisory only; does not auto-change weights.

IPC: `getConfig(strategy?)`, `updateConfig(strategy, signals, version)`, `resetToBaseline(strategy)`, `getLatestBrief(strategy?)`, `getBriefHistory(limit?)`, `resendBriefEmail()`, `signalCorrelations(strategy)`.
