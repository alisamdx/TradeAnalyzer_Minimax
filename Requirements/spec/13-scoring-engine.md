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

**Graded wheel liquidity scoring — built and calibrated, ENABLING REJECTED on realized outcomes (v1.1.131 → v1.1.133).** `scripts/fr-income-liquidity-realized-ab.mjs` replayed 6,777 settled income CSPs (937 tickers, 16 dates) with the composite reconstructed point-in-time and outcomes settled at intrinsic. Enabling the graded scheme made results **worse**: top-5 per date went 60.0% → 71.3% assigned and −2.92% → −4.80% mean return on capital (**Δ −1.88 pts/trade**, −1.33 at top-10). **More fundamentally, `optionLiquidity` does not predict outcomes at all** — Spearman(score, realized return) is −0.015 (legacy) / +0.032 (graded) — and the graded score is mildly *anti*-predictive by quartile (bottom 25% +0.95% return at 14.8% assignment; top 25% +0.21% at 26.6%). The confound is visible in the same cut: top-quartile liquidity carries 55% realized vol vs 43% at the bottom with IV rank flat, i.e. liquidity tracks attention and attention tracks names that move. **Liquidity is an execution-cost property, not an outcome-prediction property** — it belongs as a gate (which is exactly how `EntryPolicy` uses it, `liquidityScore ≥ 8`), not as 13% (income) / 9% (wheel) of a ranking composite. The graded formula and flag are kept because a better-calibrated score makes a better gate; v1.1.131's calibration was right on its own terms (Spearman −0.419 → −0.799 against real fill cost). **Indicated follow-up, not yet taken: reduce or remove `optionLiquidity`'s composite weight** — itself FR-SEY-5-gated.

**Original build note (v1.1.131).** The follow-on to the finding below: fixing *which* contract is measured did not fix how it is *scored*. `optionLiquidityScore`'s three binary gates collapse to a near-constant 0 or 4 because `spread ≤5%` and `volume ≥50` almost never fire. `WHEEL_GRADED_LIQUIDITY` (`analysis-service.ts`, default `false`, override `WHEEL_GRADED_LIQUIDITY=1`) replaces them with a continuous, cliff-free formula, calibrated by `scripts/fr-wheel-liquidity-calibration.mjs` against **1,278 real market-hours short-put quotes** from stored `daily_briefs` structures, scored against actual execution cost under the app's fill model. Legacy: 6 distinct values, 38% scoring zero, Spearman −0.419 vs cost. Graded: **21 distinct values, 2% scoring zero, Spearman −0.799**. FR-SEY-5-gated (weight 9 wheel / 13 income → re-ranking follows) and **independent of `WHEEL_MONTHLY_FIRST_EXPIRY`** — either helps alone; the two are complementary. See `23-formulas.md` / `docs/formulas.md#liquidity-score`.

**Live validation of monthly-first (2026-08-05, v1.1.130) — necessary but not sufficient.** `scripts/fr-wheel-monthly-first-ab.mjs` prices both policies in one pass through the API server (the arms must share an instant; time of day moves option liquidity too much for A-now/B-later). Over 39 tickers the flag fixed *which contract* is measured — expiry changed 87%, monthly landing 13% → 100%, median OI 8 → 416, median spread 50.5% → 23.8%, score zeros 79% → 10%, estimated composite +1.92 pts — **but tickers clearing the ≥5/10 suitability gate went only 0% → 8%.** The OI component (+4) does all the work; `spread ≤5%` and `volume ≥50` almost never fire, so the signal moves from near-constant 0 to near-constant 4. On blue chips OI improved 32× and spread 4× with the median score unchanged at 4 — **WMT at OI 13,824 / spread 5.2% still scores 4/10, missing the ≤5% gate by 0.2pp.** The remaining defect is therefore **threshold calibration**, not contract selection: a 5% *relative* bid-ask on a 25-delta put is unreachable for any name, which is why the Strategy Lab's graded 8-point spread component rates the same contracts sanely. Separable from the flag, which stays off.

**Brief Replay is blind to the options-derived signals (v1.1.129).** Replay has no historical option chains — none were ever stored — so `annualizedReturn`, `optionLiquidityScore` and `suitabilityScore` are null for **every** ticker on **every** replay date. Under the missing-signal rule above (contributes 0 to the numerator, full weight to the denominator) the signals they feed are a permanent zero at full weight:

| strategy | blind weight | composite built from |
| --- | --- | --- |
| wheel | `premiumYield` 19 + `optionLiquidity` 9 = **28** | 72% of live weight |
| income | `premiumRiskRatio` 22 + `optionLiquidity` 13 = **35** | 65% of live weight |
| bullish / bearish / buy / inflection | 0 | faithful to live |

Ranking *within* a replay run is unaffected (the blind signals are zero for every ticker, so they scale all composites by the same constant), but **replay and live are not on the same scale and their wheel/income rankings genuinely differ** — live populates these signals with per-ticker values that vary. Never carry an absolute composite threshold between replay and live for wheel/income; bearish's ≥70 gate is safe because bearish has no options-based signal. Replay also **cannot A/B any of these signals** — toggling one shows a flat zero since it is already null for everyone; use the `analysis_snapshots` panel instead. Codified as `REPLAY_BLIND_SIGNAL_KEYS` / `replayWeightCoverage()` in `brief-replay-service.ts`, pinned by `tests/replay-weight-coverage.test.ts`.

**Wheel monthly-first expiry — NOT YET ENABLED (v1.1.128).** `optionLiquidity`'s value is only as good as the contract it measures, and today it measures a **weekly**: `findSuitableChain` returns the first delta-band match in ascending date order, and the 30–45 DTE window is narrower than the ~30-day monthly cycle. At the same ~25 delta the weekly carries 1–2 orders of magnitude less OI than the monthly (PG 7 vs 4,063; WMT 109 vs 13,824), so the signal reads 0/10 across ~94% of the universe and cannot separate a mega-cap from a microcap — it is effectively a constant, contributing its full weight (wheel 9, income 13) as a near-uniform penalty. `WHEEL_MONTHLY_FIRST_EXPIRY` (`analysis-service.ts`, default `false`, override `WHEEL_MONTHLY_FIRST=1`) tries 3rd Fridays first and widens the window to 28–52 DTE. **FR-SEY-5-gated**: it changes the recommended CSP itself, so `premiumYield` (weight 19) and Stage-4 pool selection move with it, and it puts a discontinuity in the `options_premium_history` series. A clean retrospective A/B is **not possible** — the `analysis_snapshots` panel holds the old measurements and recomputing needs historical chains that were never stored — so validation must be forward-looking. See `06-analysis-engine.md` and `23-formulas.md` / `docs/formulas.md#liquidity-score`.

**ETF-aware wheel scoring — NOT YET ENABLED (v1.1.118).** Wheel's `fundamentalScore` (17) and `leverageQuality` (4) are structurally inapplicable to ETFs (no P/E, ROE, or traditional debt for a fund wrapper), so under the missing-signal rule above they are *always* null for an ETF and always zero-contribute — every ETF's wheel composite is deflated ~21% relative to a fully-scored stock, for no reason related to trade quality. Confirmed against the production DB (2026-07-03): 56 of 60 curated ETFs have no `fundamentals_cache` row, and 0 of the last 5 daily wheel briefs contained a single ETF pick — ETF wheel candidates are effectively invisible to the brief regardless of how well they'd otherwise wheel (FiltersView's wheel templates already work around this with an explicit ETF branch; the live brief's scoring engine did not, until this flag). `ETF_AWARE_WHEEL_SCORING` in `scoring-service.ts` (default `false`; override via `SCORING_ETF_AWARE_WHEEL=1` for a validation run) excludes those two signals from **both** the numerator and denominator for an ETF ticker, renormalizing the rest to 100% rather than zero-contributing them (e.g. SPY-shaped signals: composite 58.3 disabled → 73.8 enabled, in `tests/scoring-etf-wheel.test.ts`). This changes wheel composite scores — and therefore Stage-4 pool selection / final picks — for ETF tickers, so per FR-SEY-5 it needs a Brief Replay improvement (or at least neutrality) on ETF wheel outcomes before shipping enabled; left off until validated.

## 13.4 UI

Pill tabs per strategy; a signal grid with direction badges (↑ higher / ↓ lower / ◎ range), weight bars, enable toggles, and a green/red running total row (must reach 100). Version label per strategy. "Reset to Baseline" restores the seed.

## 13.5 Signal correlations (learning aid)

`signalCorrelations(strategy)` computes Pearson r between each signal's value and Day+1 positive paper-trade outcomes (§15), surfaced as a suggestion table ("this signal correlated with winners — consider raising its weight"). Advisory only; does not auto-change weights.

IPC: `getConfig(strategy?)`, `updateConfig(strategy, signals, version)`, `resetToBaseline(strategy)`, `getLatestBrief(strategy?)`, `getBriefHistory(limit?)`, `resendBriefEmail()`, `signalCorrelations(strategy)`.
