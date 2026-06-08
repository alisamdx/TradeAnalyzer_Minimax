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

**Income** — ivRank 25, premiumYield 21, fundamentalScore 18, technicalNeutral (RSI 40–60, target) 13, recentVolatility (lower) 10, optionLiquidity 9, leverageQuality (ND/EBITDA, lower) 4.

**Wheel** — ivRank 30, premiumRiskRatio 22, recentVolatility (lower) 20, trendNeutral (lower) 15, optionLiquidity 13.

**Bullish** — trendStrength 24, earningsGrowth 20, rsiMomentum (45–70, target) 15, buySignalScore 12, relativeStrength 12, priceMomentumPct 7, sectorMomentum 5, revenueGrowth5Y 5.

**Bearish** — downtrendScore 26, fundamentalWeakness (lower) 22, rsiOverbought (60–80, target) 17, relativeWeakness (lower) 13, priceDecayPct (lower) 9, sectorWeakness 7, leverageRisk 6.

**Buy** — priceMomentumPct 24, earningsGrowth 18, breakoutScore 14, buySignalScore 14, relativeStrength 14, revenueGrowth5Y 7, sectorMomentum 6, epsGrowth5Y 3.

Signal value provenance (examples): `ivRank` ← `iv_history`; `buySignalScore` ← `technical_signals`; `relativeStrength`/`priceMomentumPct`/`sectorMomentum` ← `historical_prices` (90-day / 252-day returns, SPDR sector ETF map); `fundamentalScore`/`revenueGrowth5Y`/`epsGrowth5Y`/`leverageQuality` ← `screen_results.payload_json`; `optionLiquidity`/`premiumYield`/`premiumRiskRatio` ← analysis snapshots / wheel metrics; `breakoutScore` ← analysis snapshot (price vs entry-zone-low + MA alignment, null if snapshot > 7 days old).

## 13.4 UI

Pill tabs per strategy; a signal grid with direction badges (↑ higher / ↓ lower / ◎ range), weight bars, enable toggles, and a green/red running total row (must reach 100). Version label per strategy. "Reset to Baseline" restores the seed.

## 13.5 Signal correlations (learning aid)

`signalCorrelations(strategy)` computes Pearson r between each signal's value and Day+1 positive paper-trade outcomes (§15), surfaced as a suggestion table ("this signal correlated with winners — consider raising its weight"). Advisory only; does not auto-change weights.

IPC: `getConfig(strategy?)`, `updateConfig(strategy, signals, version)`, `resetToBaseline(strategy)`, `getLatestBrief(strategy?)`, `getBriefHistory(limit?)`, `resendBriefEmail()`, `signalCorrelations(strategy)`.
