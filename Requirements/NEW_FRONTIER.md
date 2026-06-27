# New Frontier — PhD-Level Research Directions in Options Trading

*A framework for identifying and pursuing genuinely novel research questions in options markets.*

-----

**Document purpose:** Reference document capturing the research framework discussed for approaching options trading at a PhD / serious-research level. Intended as a starting point for future analysis, prioritization, and project selection.

**Author:** Shaikh Ali (with Claude)
**Date:** 2026-05-26
**Status:** Initial draft — exploratory

-----

## Table of Contents

1. [The Hard Truth About “New” Strategies](#1-the-hard-truth-about-new-strategies)
1. [Where the Actual Research Frontier Is](#2-where-the-actual-research-frontier-is)
1. [Five Research Directions](#3-five-research-directions)
- [3.1 Microstructure-Aware Strategy Timing](#31-microstructure-aware-strategy-timing)
- [3.2 Volatility Risk Premium Decomposition by Cause](#32-volatility-risk-premium-decomposition-by-cause)
- [3.3 The Negative Gamma Trap Mapping](#33-the-negative-gamma-trap-mapping)
- [3.4 Cross-Asset Volatility Arbitrage at Retail Scale](#34-cross-asset-volatility-arbitrage-at-retail-scale)
- [3.5 Earnings Event Surgery](#35-earnings-event-surgery)
1. [PhD Structure — A Three-Year Arc](#4-phd-structure--a-three-year-arc)
1. [Recommended Starting Point](#5-recommended-starting-point)
1. [The Meta-Point](#6-the-meta-point)
1. [Next Actions for Future Analysis](#7-next-actions-for-future-analysis)

-----

## 1. The Hard Truth About “New” Strategies

**Most “new” options strategies aren’t new.** They’re recombinations of the same five primitives: long call, short call, long put, short put, underlying. Every “innovation” you see on FinTwit is a relabeling of something tastytrade, CBOE, or academic finance figured out in the 80s–2000s.

Known and not novel:

- Iron condor, jade lizard, broken wing butterfly, ratio spread
- PMCC, wheel, collar
- Synthetic stock, risk reversal, backspread

A real PhD-level contribution doesn’t try to invent a new shape. It finds an **inefficiency** that current strategies don’t exploit, or a **regime** where existing strategies systematically fail, and builds something targeted at that gap.

-----

## 2. Where the Actual Research Frontier Is

The interesting questions aren’t “what new structure can I build” but:

1. **Where does the options market mispricing actually live, and why hasn’t it been arbed away?**
1. **Which existing strategies have failure modes that nobody has properly characterized?**
1. **What information is in options data that nobody is using for trade selection?**
1. **Can machine learning find patterns in greeks/IV surfaces that human rule-based systems miss?**

These are real research questions. Five fertile areas follow.

-----

## 3. Five Research Directions

### 3.1 Microstructure-Aware Strategy Timing

**The gap:** Everyone times entries by IV rank, earnings dates, technicals. Nobody systematically times by options market microstructure — bid/ask dynamics, order flow imbalance, dealer gamma positioning, market maker hedging flows.

**Research question:** Do strategies like the wheel or short strangles have measurably better expectancy when initiated during specific microstructure regimes (e.g., dealer short gamma vs long gamma, high vs low order flow toxicity)?

**Why it’s open:**

- Retail can’t access most of this data easily
- Academic finance has touched it but rarely connected it to retail-executable strategies
- The SpotGamma / SqueezeMetrics / Cboe DataShop world is fragmented and underexplored from a strategy-overlay perspective

**Concrete research path:**

- License gamma exposure data
- Backtest existing wheel-50 with and without a “dealer positioning gate” overlay
- Measure if the gate adds expectancy
- Publishable if yes

**Data requirements:** SpotGamma or equivalent dealer positioning feed, intraday order flow data, historical wheel performance dataset.

-----

### 3.2 Volatility Risk Premium Decomposition by Cause

**The gap:** The volatility risk premium (VRP — IV > realized vol on average) is well-known. Short premium strategies harvest it. But VRP isn’t uniform: it varies by sector, by event type, by macro regime, by stock-specific characteristics.

**Research question:** Can you decompose the VRP into “earnings premium,” “macro premium,” “idiosyncratic crash premium,” and “noise premium” — then build a strategy that only harvests the components with the best risk-adjusted reward?

**Why it’s open:**

- Most short premium research treats VRP as a monolith
- The decomposition exists in academic literature (Bollerslev, Tauchen, Zhou et al.) but hasn’t been turned into trading rules at the retail level

**Concrete research path:**

- Run regressions decomposing historical VRP into components
- Build a scoring overlay that ranks short premium candidates by *which component* of VRP they’re harvesting
- Test whether selective harvesting beats blanket strangling

**Data requirements:** Long historical IV30 surface data, realized vol calculations, macro event calendar, earnings calendar, sector classifications.

**Academic prior art to start with:**

- Bollerslev, Tauchen, Zhou — “Expected Stock Returns and Variance Risk Premia”
- Carr & Wu — “Variance Risk Premiums”
- Drechsler & Yaron — “What’s Vol Got to Do With It”

-----

### 3.3 The Negative Gamma Trap Mapping

**The gap:** PMCC, short strangles, wheel-CSPs all have nonlinear loss profiles when stocks gap. The “gap risk” is acknowledged but not well-characterized.

**Research question:** Can you build a stock-level scoring system that predicts gap probability and magnitude better than IV implies, and use it to filter out stocks where short premium strategies have negative expected value DESPITE high IV?

**Why it’s open:**

- People filter by avoiding earnings, but real gap risk is more nuanced
- Inputs include short interest dynamics, sector contagion, options OI distributions (gamma walls), pre-market news clustering by sector
- These factors are rarely combined into a single predictive model

**Concrete research path:**

- Build a “gap risk score” using historical gap data + current market structure data
- Backtest the wheel with and without a gap-risk filter
- The novel contribution is the gap risk model itself, not the strategy

**Data requirements:** Historical intraday data with overnight gap detection, short interest history, options OI by strike (gamma exposure mapping), news event tags by sector.

**Personal relevance:** This is the closest to existing wheel infrastructure. The wheel modules already implement an earnings hard fail; extending into a richer gap-risk model is a natural progression.

-----

### 3.4 Cross-Asset Volatility Arbitrage at Retail Scale

**The gap:** Institutional vol traders do dispersion (index vol vs single-name vol), correlation trades, and cross-asset vol relationships (equity vol vs credit spreads vs rates vol). Retail traders almost never touch this.

**Research question:** Can a simplified dispersion trade — long single-name vol, short index vol — be made executable and profitable at retail scale using ETFs and a small basket of single names?

**Why it’s open:**

- Retail tools treat each ticker independently
- There’s no mainstream framework for “the SPY iron condor is overpriced relative to the constituent strangles”

**Concrete research path:**

- Build a dispersion screener that scans for periods where SPY/QQQ implied correlation is dislocated from realized
- Construct simplified retail-executable dispersion trades
- Backtest across multiple regimes

**Data requirements:** SPY/QQQ option chains + matching constituent option chains, correlation calculations, transaction cost modeling for multi-leg, multi-ticker trades.

**Difficulty rating:** High. Most academically rigorous but hardest to execute cleanly at retail scale. Transaction costs can eat the entire edge.

**Prior art to study:**

- Driessen, Maenhout, Vilkov — “The Price of Correlation Risk: Evidence from Equity Options”
- Existing institutional dispersion trade structures

-----

### 3.5 Earnings Event Surgery (Recommended Starting Point)

**The gap:** Earnings are the biggest known unknown in options. Everyone says “avoid earnings.” But the IV crush around earnings is THE most reliable phenomenon in retail options.

**Research question:** Can you build a strategy that systematically harvests post-earnings IV crush across hundreds of names, controlled for direction, sized for ruin avoidance?

**Why it’s open (partially):**

- tastytrade and others touch this with “earnings strangles,” but it’s poorly characterized
- Which stocks have predictable IV behavior post-earnings? Which IV setups give the best expectancy? How does it interact with surprise magnitude?
- The systematic, score-based version doesn’t exist publicly

**Concrete research path:**

- Pull every earnings event for SP500 stocks over 10 years
- For each, characterize:
  - Pre-earnings IV setup (IV rank, term structure shape, skew)
  - IV crush trajectory (1d, 3d, 7d post-event)
  - Post-event direction (where did the stock actually go)
  - Stock-specific characteristics (sector, market cap, analyst dispersion)
- Cluster the patterns
- Build a screener that ranks tonight’s earnings reports by predicted IV crush opportunity

**Data requirements:**

- 10+ years of earnings dates with surprise magnitudes
- Daily IV surface data covering pre/post-earnings windows
- Earnings whisper numbers or analyst dispersion data (harder to source)
- Stock-level fundamental and sector data

**Why this is the recommended starting point:**

1. Data is accessible via Polygon + supplementary sources
1. Hypothesis is testable — pre/post earnings IV is observable, P&L is computable
1. Retail-executable — strategies emerging can be traded in a regular brokerage account
1. Personally relevant — existing trading system already treats earnings as a hard fail; flipping that into an opportunity is natural
1. Crowded but not solved — many people trade earnings; few do it systematically with proper expectancy modeling

**The novel contribution would not be “trade earnings”** (everyone does). It would be:

> A stock-level scoring model that predicts which earnings reports will have the best IV crush expectancy, validated out-of-sample over 10 years, with a deployable strategy attached.

-----

## 4. PhD Structure — A Three-Year Arc

### Year 1: Literature + Data Infrastructure

- Read the entire OptionMetrics academic citation set
- Read CBOE white papers, the tastytrade research archive, Euan Sinclair’s books cover to cover (twice)
- Read every Sosnoff / Battista / Carter podcast transcript
- Build a clean historical dataset — IV surfaces, greeks, OI, volume, splits, dividends, earnings — going back 10+ years
- Pick the ONE specific question to spend three years on

**Deliverable:** Literature review document + cleaned, documented dataset + falsifiable research question.

### Year 2: Hypothesis Testing

- State your specific hypothesis in falsifiable terms
- Build the cleanest possible backtest infrastructure
  - Survivorship bias controls
  - Look-ahead bias prevention
  - Transaction cost modeling
- Test the null hypothesis brutally — assume your idea is wrong until the data screams otherwise
- Publish negative results too (most ideas don’t work; that’s information)

**Deliverable:** Backtest engine + hypothesis test results (positive or negative) + interim research paper.

### Year 3: Strategy Construction + Out-of-Sample Validation

- If hypothesis survived, build a deployable strategy around it
- Walk-forward validate (never use the same data for calibration and validation)
- Stress test across regimes — 2008, 2018 Volmageddon, 2020 COVID crash, 2022 rate shock
- Paper trade in live markets for at least 6 months before claiming anything

**Deliverable:** Final thesis = novel inefficiency identified + model that captures it + strategy that exploits it + rigorous evidence the edge survives transaction costs and regime changes.

-----

## 5. Recommended Starting Point

**Pick Earnings Event Surgery (3.5)** for the reasons enumerated in that section. It is:

- Most accessible from a data perspective
- Most testable from a methodology perspective
- Most actionable in a retail account
- Most aligned with existing trading-system infrastructure
- Most likely to produce a result worth publishing or productizing

The second-best choice is **Negative Gamma Trap Mapping (3.3)** because of its alignment with existing wheel infrastructure.

The most academically interesting but hardest is **VRP Decomposition (3.2)**.

The longest shot but most differentiated is **Cross-Asset Vol Arbitrage (3.4)**.

The most under-explored data-wise is **Microstructure-Aware Timing (3.1)**.

-----

## 6. The Meta-Point

The PhD-worthy work isn’t inventing a new option structure. It’s **finding measurable inefficiency, modeling it, and proving the model holds out of sample.**

The strategy is just the wrapper around the model.

The research recipe:

1. Pick a specific, narrow, falsifiable claim about options markets that the world hasn’t proven or disproven yet
1. Spend three years brutalizing it with data
1. The strategy is the deliverable
1. The research is the contribution

-----

## 7. Next Actions for Future Analysis

When revisiting this document:

- [ ] Pick ONE direction (3.1 – 3.5) to deep-dive
- [ ] Inventory existing data assets (current Polygon subscription coverage)
- [ ] List what additional data would need to be sourced and rough cost
- [ ] Survey academic literature for the chosen direction (3–5 papers to start)
- [ ] Define the falsifiable hypothesis in one sentence
- [ ] Sketch the minimum viable backtest needed to falsify it
- [ ] Estimate time budget for hypothesis testing phase
- [ ] Decide: research project or product extension of existing app?

-----

## 8. Data Asset Inventory (added 2026-06-27)

*What we actually have in the live DB vs. what each direction needs. Measured against the production `trade-analyzer.sqlite` (schema v62, v1.1.87) on 2026-06-27.*

### 8.1 What we already have

| Asset | Table | Depth / coverage | Granularity | Source | Good for |
|---|---|---|---|---|---|
| **Daily OHLCV** | `historical_prices` | **~5 years** (2021-05-20 → 2026-06-26), 1,067 tickers, 554k rows; incl. `adjusted_close` | **Daily only** (no intraday) | Polygon | Overnight gap detection, realized vol, beta, drawdown, regime tagging |
| **30-day ATM IV** | `iv_history` | **~13 months** (2025-05-29 →), ~1,059 tickers, ~20k ticker-days/month, 283k rows | Daily, one ATM point | IVolatility / MarketData.app | VRP (IV−RV), IV-rank/percentile, IV-crush *going forward* |
| **Next-earnings date** | `earnings_calendar` | **Forward-only** (2026-06-10 → 2026-12-17), 982 rows, one row/ticker. **No `eps_estimate` populated (0), no actuals, no surprise, no history** | Snapshot | Finnhub + E*Trade | Earnings *avoidance/filtering* only — NOT a research panel |
| **Option premium panel** | `options_premium_history` | **12 days** (started 2026-06-15), 973 tickers, income+wheel; strike/premium/IV/delta/OI/breakeven daily; **never pruned** | Daily, accumulating | E*Trade | Will become a real forward panel; useless for back-history today |
| **Macro events** | `macro_events` | 32 rows (2026-01 → 2026-12), sparse | Event tags | — | Light; not a serious macro calendar yet |
| **Backtest harness** | `backtest_*` | Engine + 5 runs / 176 trades; spread simulation (up→bull-put, down→bear-call) | — | Internal | Hypothesis testing — but prices at **theoretical mid, no slippage/commissions** (intentional, see memory) |
| **Universe** | `constituents` | 1,564 (S&P 500 + Russell 1000 + ETFs) | — | Internal | Cross-sectional studies |
| **Live option chains / Greeks** | (E*Trade, on-demand) | Current only, one ticker at a time, rate-limited | Snapshot | E*Trade | Per-contract IV/Greeks/OI *now*; no historical surface |

### 8.2 What we do NOT have (and would need to source)

- **Historical earnings with surprise magnitude** — none stored, and **Polygon has no earnings endpoint** (the app already routes earnings through Finnhub/E*Trade). The doc's assumption that 3.5 is "data-accessible via Polygon" is **optimistic** — surprise/actuals history is a paid Finnhub/Zacks/EOD tier.
- **Full IV surface** — we store a *single ATM 30-day point* per ticker-day, plus near/far expiry DTE. **No skew, no term structure, no per-strike surface history.** Most of §3.2 and §3.5's "term-structure shape, skew" inputs are absent.
- **Dealer gamma / order-flow / GEX** — nothing. Would need SpotGamma / SqueezeMetrics / Cboe DataShop (all paid). This is the entire premise of §3.1.
- **Historical options OI by strike** — only current-chain OI + the 12-day forward `options_premium_history` snapshot. No history → no "gamma walls" study yet.
- **Short interest history** — not stored anywhere.
- **Implied correlation / constituent-vs-index synchronized chains** — not stored; would require simultaneous SPY/QQQ + constituent chain capture (§3.4).

### 8.3 Feasibility re-ranking (data-grounded — differs from the doc's §5)

The doc recommends **§3.5 Earnings Surgery** as "most accessible." Our actual inventory **inverts that**: earnings is the *most* data-blocked direction right now (zero historical earnings, zero surprise data, only 13 months of single-point IV). The direction best matched to assets **on hand** is **§3.3 Gap-Risk Mapping**.

| Dir | What's needed | Have it? | Verdict today |
|---|---|---|---|
| **3.3 Negative Gamma / Gap-Risk** | Historical overnight gaps, per-ticker gap freq/magnitude; earnings dates to filter | **✅ 5y daily OHLCV** (gaps = open vs prior close), ✅ forward earnings, ✅ wheel infra | **Most feasible now.** A price-based gap-risk score is buildable from data on hand, zero new spend. Short-interest / gamma-wall inputs are *enhancements*, not blockers. |
| **3.2 VRP Decomposition** | Long IV surface + realized vol + macro/earnings tags | ⚠️ RV from 5y prices ✅; IV only **13mo & ATM-only** ✗; macro sparse; earnings history ✗ | **Partial.** Can compute VRP = IV30−RV30 *now* but only ~1yr; decomposition by regime needs the IV panel to deepen (it's accumulating). Start the regression scaffold, revisit in 6–12mo. |
| **3.5 Earnings Surgery** | 10y earnings + surprise + pre/post IV surface | ✗✗ no earnings history, ✗ no surprise, ✗ IV too short & ATM-only | **Blocked on data purchase.** Most appealing thesis, least supported by current assets. Needs a paid earnings-history feed + longer/wider IV before it's testable. |
| **3.1 Microstructure** | Dealer gamma / order flow / GEX | ✗ none | **Blocked.** Requires paid SpotGamma-class feed before any backtest. |
| **3.4 Cross-Asset Vol Arb** | Synced index+constituent chains, implied corr | ✗ no synced capture; ⚠️ ATM IV could proxy corr crudely | **Blocked + hardest execution.** Lowest priority. |

### 8.4 Cheapest first step

**§3.3 gap-risk score is a zero-new-data spike:** compute per-ticker overnight gap distribution from `historical_prices` (5y), define a gap-risk metric, then A/B it as a short-premium entry filter through the existing Brief Replay / backtest harness (FR-SEY-5 gate). If it adds expectancy it ships (possibly disabled-by-default per FR-SEY-5); if not, it's a recorded negative result. Either way it directly extends the wheel/v2 engine, which is where the doc itself says §3.3 belongs.

Meanwhile, both `iv_history` and `options_premium_history` are **accumulating daily** — every day that passes makes §3.2 and §3.5 incrementally more testable without any spend, so the cost of waiting on those two is low.

-----

## 9. Spike scope — §3.3 Gap-Risk entry filter (added 2026-06-27)

*Concrete, falsifiable, zero-new-data first experiment. Written to slot into the existing
FR-SEY validate-before-ship machinery (`Requirements/v2-execution/06-seykota-risk-extensions.md`)
— treat this as a draft **FR-SEY-6** that ships only if it survives Brief Replay.*

### 9.1 The thesis (the doc's §3.3, sharpened)

Short-premium strategies have **negative EV on names that gap more than their IV implies** —
high IV looks like rich premium, but if the name's realized overnight-gap tail is fatter than
the IV-implied daily move, you're underpaid for the jump risk. The novel object is a
**point-in-time gap-risk score**; the strategy is just the filter that drops the worst names.

### 9.2 Metric definition (pure function over `historical_prices`)

For a ticker, as of entry date `T` (strictly `< T`, no look-ahead), over a trailing window
`W` (default **252 trading days**):

1. **Overnight gap** for day *t*: `g_t = (open_t − close_{t-1}) / close_{t-1}`.
   *(Daily bars carry open + prior close, so this is computable directly — no intraday feed.)*
2. **Adverse gaps** are directional: for a **short put / bull-put** (we sell downside) the
   adverse tail is the *negative* gaps; for a **short call / bear-call**, the *positive* gaps.
3. **Realized adverse-gap tail** `G_adv` = the 95th-percentile magnitude of adverse gaps over `W`
   (robust to a single outlier; also record the single worst gap for the tail report).
4. **IV-implied daily move** `M_iv = atm_iv(T) / √252` (from `iv_history`, the same ATM point
   `simulateSingleSpread` already uses; `atm_iv` is stored ×100, so `/100` first).
5. **GapRiskScore** = `G_adv / M_iv`. **> 1 ⇒ the name gaps harder than IV is paying for** —
   exactly the doc's "negative EV despite high IV."

Compute **two variants**: `raw` (all gaps) and `exEarnings` (gaps within ±1 trading day of a
known earnings date removed). Earnings gaps are *already* handled (earnings penalty / avoidance),
so the **novel** signal is `exEarnings` — non-event gappiness IV isn't pricing. Report both.

### 9.3 Falsifiable hypothesis (one sentence)

> Dropping short-premium entries whose trailing `exEarnings` GapRiskScore exceeds a cutoff `c`
> **improves realized return-on-capital and/or shrinks the left tail (worst-decile mean / CVaR)
> of the book, at worst neutral on win rate**, on the Brief-Replay sample — and does so
> **monotonically** across a cutoff sweep (not just at one cherry-picked `c`).

Null result (no lift, or only at a single fragile cutoff) ⇒ **do not ship enabled** — record the
negative finding, exactly as FR-SEY-3 was rejected.

### 9.4 The A/B (reuses the proven harness)

- **Population:** the **up-breakout inflection bull-put** replay picks — the one book already
  validated as solidly profitable (+6.1% / 76%, FR-SEY-3 update). Gap risk should *protect* an
  already-good book; if it can't help here, it won't help the marginal ones. Optionally extend
  to income/wheel CSP picks as a second population.
- **Realized P&L per pick:** the offline replica of `BacktestEngine.simulateSingleSpread`
  (`src/main/services/backtest-engine.ts:625` — Black-Scholes, IV-priced 0.30/0.15-delta
  vertical, 30 DTE, 50% PT / 200% stop), the **same engine** the FR-SEY spread-P&L scripts use.
  Return is **% of spread max-loss capital**; win = `pnl > 0`.
- **Design:** baseline = all picks; treatment = picks with `GapRiskScore ≤ c`. Compare:
  - mean return-on-capital, win rate (central tendency), **and**
  - **worst-decile mean return + 5% CVaR** (the tail — this is where gap risk should bite;
    the mean may barely move while the tail tightens, which is the whole point).
- **Cutoff sweep:** `c ∈ {0.8, 1.0, 1.25, 1.5, 2.0}` plus % dropped at each — robustness/monotonicity
  check, mirroring the FR-SEY-3 recalibration table. A real effect trends; a fluke spikes once.

### 9.5 Ship decision (FR-SEY-5 gate)

| Outcome | Action |
|---|---|
| Treatment ≥ baseline on mean **and** tightens the tail, monotone in `c` | Ship as `exec_config.max_gap_risk` (default **NULL = off**), enforced in `EntryPolicy.filterPick` with reason `gap_risk`, mirroring FR-SEY-1's `per_sector` cap. Operator opt-in. |
| Tail improves but mean dips slightly | Ship **disabled**, documented as a tail-hedge knob; record the mean/tail trade-off. |
| No effect / only a single fragile cutoff | **Don't ship.** Record the negative result in this doc + the FR-SEY doc. |
| Too few tail events to conclude (likely — only 13mo IV / overlapping samples) | Record as **inconclusive — revisit when `iv_history` deepens**; the metric code still lands as a Validate-dashboard display column. |

### 9.6 Deliverables & effort

- `scripts/fr-gap-risk-study.mjs` — copy of an existing `scripts/fr-sey-*.mjs`; add the pure
  `gapRiskScore(bars, ivAsOf, side, asOf, window)` helper + the cutoff-sweep table. **~½ session.**
- If it ships: migration adding `exec_config.max_gap_risk`, the `gap_risk` check in
  `entry-policy.ts`, a unit test in `tests/risk-gate.test.ts`, and the gap-risk column on the
  Validate dashboard — the standard FR-SEY ship checklist. **~½–1 session.**
- **Zero new data, zero API spend** — entirely off `historical_prices` + `iv_history` we already have.

### 9.8 First-run result (2026-06-27) — ❌ HYPOTHESIS FALSIFIED (inverted)

Ran `scripts/fr-gap-risk-study.mjs` over **1,317 resolved up-breakout bull-put** replay picks
(real `simulateSingleSpread` P&L). The filter is **not neutral — it is harmful**, and the gap-risk
signal points the **opposite** way to the thesis:

| up-breakout book | n | win | avgRet/maxloss | worstDecile | CVaR5 |
|---|---|---|---|---|---|
| **BASELINE (all)** | 1317 | 74.6% | **+5.4%** | −60.5% | −69.2% |
| keep score ≤1.50 (drop 10%) | 1179 | 73.4% | +4.6% | −61.2% | −70.0% |
| keep score ≤1.00 (drop 42%) | 765 | 73.3% | +5.0% | −63.8% | −73.6% |
| keep score ≤0.80 (drop 66%) | 443 | 72.2% | +4.6% | −66.1% | −78.3% |
| **DROPPED (score >1.50)** | 138 | **85.5%** | **+11.9%** | **−52.0%** | **−62.7%** |
| gap tercile **LOW** | 439 | 72.2% | +4.6% | −66.5% | −79.3% |
| gap tercile **HIGH** | 439 | **77.4%** | **+6.4%** | **−55.8%** | **−63.5%** |

**The high-gap-risk names are the *best* cohort, not the worst** — higher win, higher return, *and*
a tighter left tail. Filtering them out monotonically **degrades both the mean and the tail**
(CVaR worsens −69%→−78% as you drop more). Verdict: **do not ship.** Recorded negative result,
in the spirit of FR-SEY-3.

**Why it inverts — two structural reasons:**
1. **A defined-risk spread already caps gap risk.** Max loss is the width minus credit *regardless*
   of whether the underlying drifts or gaps to it — a gap can't lose you more than a slow grind to
   the same place. The §3.3 thesis is really about **unbounded** short premium (naked CSP / wheel
   / short strangle), where a gap → assignment far past the strike. Testing it on capped verticals
   was the wrong population.
2. **On up-breakouts, high `GapRiskScore` is a momentum tell, not a danger tell.** A name whose
   realized gap tail exceeds its IV-implied move is simply *more volatile than IV is pricing* — and
   conditioned on an up-breakout, that excess movement is upward, which is exactly what a bull put
   wants. The score behaves like "cheap IV on a runner," a *positive*.

**The real test population is the naked CSP/wheel book** — but Brief-Replay scores those with the
synthetic-strike `stayed_above_strike` proxy (Replay spec §6), not `simulateSingleSpread`, so this
realized-P&L harness can't evaluate them as-is. Next step if pursued: an assignment-cost evaluator
for the wheel/income replay picks (gap → fill at the gapped-through price, not the strike), then
re-run the same A/B. Until then, **§3.3 is parked** — the cheap-and-easy version is disproven on
the only book we can price, and the version that *might* work needs a new evaluator.

### 9.9 Second-run result (2026-06-27) — ⚠️ PARTIAL on the unbounded book (CSP/wheel)

Built the assignment-cost evaluator (`scripts/fr-gap-risk-csp.mjs`): a **naked cash-secured put**
at the stored delta-30 `synth_strike`, BS-priced premium, 30 DTE, 50% PT / 200% stop checked at
each **daily close** (so an overnight gap-down through the strike realizes an uncapped loss — the
mechanism the vertical lacked). Return = % of cash collateral (`K×100`). Run over 2,060 resolved
wheel+income replay picks (758 skipped — too recent for 30 DTE forward bars).

| CSP book | n | win | avgRet | worstDecile | CVaR5 | worst |
|---|---|---|---|---|---|---|
| **BASELINE (all)** | 2060 | 83.7% | +0.19% | −1.7% | −2.9% | −24% |
| keep score ≤1.00 (drop 22%) | 1602 | **85.5%** | +0.23% | −1.7% | −3.0% | −18% |
| keep score ≤0.80 (drop 40%) | 1246 | **85.9%** | +0.22% | −1.8% | −3.3% | −18% |
| gap tercile **LOW** | 686 | **87.0%** | **+0.25%** | −2.3% | **−4.3%** | −18% |
| gap tercile **MID** | 686 | 84.5% | +0.21% | −1.1% | −1.9% | −8% |
| gap tercile **HIGH** | 688 | **79.7%** | **+0.11%** | −1.7% | −2.7% | **−24%** |

**The signal is now directionally correct on win rate and mean** — unlike the defined-risk spread,
which inverted. High-gap-risk names win **less** (79.7% vs 87.0% low tercile) and earn **less**
(+0.11% vs +0.25%); filtering them lifts the book's win rate +2pp and mean ~+0.03pp. **This
confirms the spread's vertical cap was genuinely masking the gap signal** (swing-1 diagnosis #1 was
right).

**But it fails on the thing it was supposed to fix — the tail.** Dropping high-gap names does **not**
shrink the left tail (CVaR −2.9% → −3.3%, slightly *worse*). The low-gap tercile carries its *own*
fat tail (CVaR −4.3%) — those names lose via slow grinds / intraday moves the **overnight-gap**
metric can't see. A gap filter is not a tail hedge here; it's a mild quality/win-rate nudge.

**Verdict: do NOT ship enabled.** The win-rate/mean lift is real but (a) tiny in absolute terms
(+0.03pp on a 0.19% base), (b) on heavily overlapping ~13-month samples (effective N ≪ 2,060), and
(c) accompanied by **no tail improvement**, which was the entire justification. Per FR-SEY-5 this
clears neither the "helps" nor the robustness bar. **Resolution:** keep `GapRiskScore` as a
**Validate-dashboard display column** (it does rank win-quality), and re-run this A/B once
`iv_history` carries 2–3 years so the tail has enough gap events to be conclusive — the predicted
"inconclusive on the tail, revisit when the panel deepens" outcome (§9.5, last row) is what landed.

**Net for §3.3:** the cheap price-based gap score is **not a shippable edge today** on either book —
inverted on defined-risk, marginal-and-tail-blind on naked. The thesis isn't dead, but the version
that would justify the doc's "negative EV despite high IV" claim needs either (i) a longer IV panel,
or (ii) a richer gap model (short interest, OI/gamma walls, intraday) — i.e. the *paid-data* inputs
§3.3 lists, not the free subset. Parked there.

### 9.7 Honest limits (print on the study output)

- **Tail study on a short sample.** Gap blow-ups are rare; 13 months of IV + overlapping replay
  picks (~4–8 independent obs/strategy per Replay spec §7) may simply not contain enough tail
  events. "Inconclusive" is a legitimate, expected outcome — not a failure.
- **Survivorship + regime fit** carry over from the Replay spec — use this to *reject* a broken
  filter, not to tune `c` to two decimals.
- **Daily-bar gaps miss intraday spikes** that round-trip by the close; this measures
  *close-to-open* jump risk specifically, which is the right object for overnight short-premium risk.

-----

## Appendix: Reading List Starter Pack

**Books:**

- Euan Sinclair — *Volatility Trading*
- Euan Sinclair — *Option Trading: Pricing and Volatility Strategies and Techniques*
- Nassim Taleb — *Dynamic Hedging*
- Sheldon Natenberg — *Option Volatility and Pricing*

**Academic foundations:**

- Bollerslev, Tauchen, Zhou — “Expected Stock Returns and Variance Risk Premia” (2009)
- Carr, Wu — “Variance Risk Premiums” (2009)
- Driessen, Maenhout, Vilkov — “The Price of Correlation Risk: Evidence from Equity Options” (2009)
- Drechsler, Yaron — “What’s Vol Got to Do With It” (2011)
- Andersen, Fusari, Todorov — “The Pricing of Short-Term Market Risk” (2015)

**Industry/practitioner:**

- tastytrade research archive
- CBOE white papers (especially on VIX methodology, SKEW index)
- SqueezeMetrics / SpotGamma research on dealer gamma positioning
- Cliff Asness / AQR Capital papers on systematic strategies

**Data providers worth investigating:**

- OptionMetrics IvyDB (gold standard historical IV surface data; institutional pricing)
- Polygon.io (current subscription; sufficient for basic research)
- CBOE DataShop
- SqueezeMetrics
- SpotGamma
- ORATS (options research and tracking)

-----

*End of Document. To be revisited and refined as research direction is selected and pursued.*