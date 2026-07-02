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

## 10. Spike scope — §3.2 VRP decomposition (added 2026-06-27)

*Second research thread, the doc's §3.2. Scoped to what the panel supports today, with the
data-blocked components named explicitly so we don't over-promise (cf. the §3.5 earnings inversion).*

### 10.1 The thesis (the doc's §3.2)

The volatility risk premium (VRP = IV − subsequent realized vol, positive on average — you're paid
to sell vol) is **not uniform**: it varies by sector, IV regime, event type, macro regime. If we can
**measure where the VRP is reliably fat vs thin**, we can rank short-premium candidates by *expected
VRP harvest* instead of blanket-selling vol.

### 10.2 Metric definition (computable now)

For a ticker on IV-observation date `d` (from `iv_history.atm_iv`, a 30-day ATM IV in %):

```
fwdRV30(d)  = annualized realized vol of daily log returns over the next ~21 trading days
              = √(252 · var(Δln close)) × 100        (from historical_prices)
VRP(d)      = atm_iv(d) − fwdRV30(d)                  // vol points; >0 = IV was rich
```

Only usable for `d ≤ maxPriceDate − ~30 days` (need the forward window to have closed). With
`iv_history` spanning 2025-05 → 2026-06, that's **~12 months** of VRP observations per name.

### 10.3 Decomposition — what we can vs. can't tag (the honest split)

| Component (doc's §3.2) | Tag source | Feasible now? |
|---|---|---|
| **Sector premium** | `fundamentals_cache.sector` (SIC) | ✅ yes |
| **IV-regime premium** | IV-rank bucket from trailing `iv_history` | ✅ yes |
| **Realized-vol regime** | trailing RV20 bucket from `historical_prices` | ✅ yes |
| **Idiosyncratic vs market** | VRP residual after regressing on SPY VRP / beta | ⚠️ partial (beta exists; SPY IV30 panel is the same 12mo) |
| **Earnings premium** | earnings date inside the forward window | ❌ no historical earnings stored (same block as §3.5) |
| **Macro premium** | macro regime / VIX over the window | ❌ `macro_events` sparse (32 rows), VIX not historized |

So the **answerable v1 question** is: *does VRP vary systematically by sector × IV-regime × RV-regime
on our 12-month panel, enough to rank short-premium candidates?* The earnings/macro components are
parked behind the same data purchases §3.5 needs.

### 10.4 Falsifiable hypothesis (one sentence)

> The forward VRP (`atm_iv − fwdRV30`) is **not** uniform across IV-rank / sector / RV-regime buckets
> — at least one tag splits the cross-section into reliably-fatter vs reliably-thinner VRP cohorts
> (monotone, not a single fragile bucket) — and selecting the fat-VRP cohort improves short-premium
> replay P&L (the §9 CSP harness) vs blanket selling.

Null result ⇒ VRP is effectively a monolith on our data and there's nothing to rank on (record it,
don't build a VRP overlay).

### 10.5 The study & ship path

- **Measure:** `scripts/vrp-measure.mjs` — VRP per ticker-day, aggregated overall and by IV-rank /
  sector / RV-regime bucket (mean, median, % positive, n). **First read run below (§10.6).**
- **Validate (if a split appears):** reuse the §9 naked-CSP harness (`fr-gap-risk-csp.mjs`) — does
  picking the fat-VRP cohort beat the baseline book on win/mean/tail? FR-SEY-5 gate.
- **Ship (if it survives):** a `vrpBucket` / `expectedVrp` **display column** on the screener or
  Validate dashboard first (like Gap Risk); a scoring-weight or entry-gate only after a Replay delta.

### 10.6 First-read result (2026-06-27) — ✅ VRP is real and NOT a monolith

Ran `scripts/vrp-measure.mjs` over **260,198 ticker-day observations** (1,059 tickers, ~12mo).
**The premium exists and splits cleanly — the §10.4 hypothesis holds on the answerable components.**

| cut | n | mean VRP | median VRP | % positive | (IV − RV) |
|---|---|---|---|---|---|
| **ALL** | 260,198 | **+2.9** | **+4.0** | **70%** | 37.3 − 34.5 |
| IVR **low** (0–33) | 92,227 | +1.8 | +2.8 | 68% | 31.5 − 29.7 |
| IVR **mid** (33–66) | 92,675 | +2.9 | +4.1 | 71% | 37.2 − 34.3 |
| IVR **high** (66–100) | 74,243 | **+4.1** | **+6.1** | **73%** | 44.8 − 40.7 |
| RV20 **low/calm** | 86,449 | +2.3 | +3.4 | **73%** | 25.9 − 23.6 |
| RV20 **high/stormy** | 86,449 | +3.7 | +5.1 | 68% | 50.6 − 46.9 |
| sector range (≥200 obs) | — | **+15.2 … −20.7** | (medians mostly +) | — | wide |

**Findings:**
1. **There is a real, positive VRP on our panel** — mean +2.9 vol pts, median +4.0, **positive 70%
   of the time** (IV 37.3 vs subsequent RV 34.5). Selling ATM vol was paid, on average.
2. **IV-rank is the clean, monotone splitter** — VRP rises low→mid→high (+1.8 → +2.9 → +4.1 mean;
   68% → 71% → 73% positive). **Rich IV was genuinely richer**, not mean-reverting in premium terms
   on this sample. This is the most robust, actionable cut.
3. **RV regime is a *trade-off*, not a free lunch** — stormy names carry a higher *average* VRP
   (+3.7) but a *lower* hit rate (68% vs calm's 73%): the mean is dragged up by fat wins and is less
   reliable. Calm names give a smaller-but-steadier premium.
4. **Sector dispersion is large but tail-fragile** — top sectors run +10 to +15 mean VRP, bottom
   ones negative (optical instruments −20.7), but the negative sectors' *medians* are ~0-to-positive,
   so the negative means are outlier-driven (a vol explosion in one or two names). Sector is a real
   axis but means are noisy in thin buckets; trust the median.

**Verdict: the thesis survives the first cut** — VRP is non-uniform and IV-rank ranks it cleanly.
**But the honest caveat for shipping:** the engine's short-premium scoring **already weights IV rank
heavily**, so the open question isn't "does VRP vary" (it does) but "does an explicit VRP/expected-
harvest score add anything *beyond* the IV-rank the engine already uses?" That's the FR-SEY-5 test:
A/B the fat-VRP cohort against the baseline CSP book (§9 harness) **and** against an IVR-matched
control, to isolate marginal value. If VRP-bucketing only re-expresses IVR, it ships as a clearer
*display* (expected-harvest column), not a new scoring weight.

**Recommended next step:** the IVR-matched A/B above — the one cut here (RV-regime trade-off, sector
median vs mean) that *isn't* just IV-rank in disguise is where any genuinely new edge would live.

### 10.8 IVR-matched A/B (2026-06-27) — ✅ VRP ADDS VALUE BEYOND IV-RANK (first shippable signal)

Ran `scripts/vrp-csp-ab.mjs`: attached **entry-time** (point-in-time, no look-ahead) IVR, trailing
RV20, and sector-historical-VRP to the real naked-CSP P&L (§9 harness) over 2,032 wheel+income
replay picks, then tested whether the VRP axis discriminates **within** an IVR-matched control.

| cohort | n | win | avgRet | CVaR5 |
|---|---|---|---|---|
| BASELINE (all) | 2032 | 83.7% | +0.19% | −3.0% |
| **STEP 1 — IVR alone** (picks are already high-IVR: terciles 53–93 / ~100 / 100) | | | | |
| IVR low | 677 | 83.0% | +0.16% | −1.8% |
| IVR high | 678 | 84.4% | +0.29% | −4.0% |
| **STEP 2 — within high-IVR, split by RV-regime** ← the marginal test | | | | |
| high-IVR (control) | 678 | 84.4% | +0.29% | −4.0% |
| **high-IVR ∩ calm (low RV20)** | 226 | **85.4%** | **+0.41%** | **−0.5%** |
| high-IVR ∩ stormy (high RV20) | 226 | 84.1% | +0.19% | **−7.1%** |

**The VRP axis is NOT just IVR.** Holding IV-rank high (the engine's existing signal) and *adding* a
**low-realized-vol** condition lifts mean return **+0.29% → +0.41%** (~40% relative) **and tightens
the tail 8× (CVaR −4.0% → −0.5%)**. The stormy mirror at the same IVR has a −7.1% tail. This is the
genuine VRP harvest made concrete: **"IV is high *and* the stock isn't actually moving"** — you're
paid rich implied vol on a name whose realized vol stays low — and it survives IVR-matching, which
gap-risk never did. (Sector-historical-VRP, STEP 3, was non-monotone/noisy as predicted — drop it.)

**This is the first positive, FR-SEY-5-actionable result of the whole New-Frontier thread.** The
candidate: a short-premium **IV/RV (or IV−RV) favorability term** — prefer high IVR *conditioned on
low trailing realized vol* — as a scoring weight or entry gate.

**Before it ships (FR-SEY-5):** run it as a proper Brief-Replay A/B across **all** short-premium
strategies (not just the CSP proxy), confirm the lift holds on the live scoring path, and ship
**disabled by default** with this evidence — the calm-tail figure rests on n=226 in one ~12-month
regime, so the magnitude needs confirmation even though the direction is clean and economically
sound. Likely home: a `realizedVolGate` / `ivToRvRatio` config on `exec_config` + a scoring signal,
mirroring the FR-SEY-1/2 disabled-by-default pattern.

### 10.9 Resolution (2026-06-27) — ⚠️ THE TERM ALREADY EXISTS; no change justified

Before building anything, checked the scoring path — **the IV/RV signal is already in the live
engine.** Short-premium scoring already combines `ivRank` (higher-better) with **`recentVolatility`**
(20-day realized vol, *lower-better*, `normMax 60`): **income weights it 20/100, wheel 10/100**
(`scoring-service.ts` `BASELINE_INCOME` / `BASELINE_WHEEL`). So §10.8 didn't find a *new* signal —
it re-derived an existing one. The honest question collapses to: *is that term pulling its weight,
and is it weighted right?*

**Ranking A/B** (`scripts/vrp-csp-ab.mjs` STEP 5 — rank the CSP book by each composite, take the top
quantile, measure real P&L):

| top 20% by composite | win | avgRet | CVaR5 |
|---|---|---|---|
| **IVR only** | **87.7%** | **+0.28%** | −1.8% |
| engine WHEEL (22:10) | 82.8% | +0.22% | −1.5% |
| engine INCOME (30:20) | 84.0% | +0.24% | −1.0% |
| **calm-HEAVY (30:40)** | 84.2% | +0.23% | **−0.8%** |

**The calm term is a TAIL-HEDGE that costs a little return — not a free lunch.** IVR-only ranking has
the *best* win and mean but the *worst* tail; adding calm weight monotonically tightens CVaR
(−1.8% → −0.8%) while shaving win/mean. This **refines §10.8**: the "calm is better on *both* mean and
tail" result was an artifact of conditioning on IVR≈100 (max IVR). In a full ranking, calm competes
with IVR for selection slots, so weighting it more trades expected return for a safer left tail —
a *preference*, not a strict improvement.

**Decision: ship no scoring change.** (1) The signal already exists; a new term would double-count.
(2) The only lever is its *weight*, and more-calm is a return-vs-tail trade-off, not a Pareto win, on
a single ~12-month regime — exactly the kind of weight-tuning FR-SEY-5 and prior precedent
(`project_scoring_replay_validation`) say not to do on this sample. (3) The current weights (income
20, wheel 10) already sit sensibly between the extremes. **FR-SEY-5 did its job: it stopped a
redundant signal and an unjustified re-weight.**

**One parked observation (not a ship):** wheel weights calm at 10 vs income's 20, and the tail is
where CSP/wheel assignment risk actually lives — so *if* a future, multi-regime sample confirms the
tail benefit is worth the mean cost, the cleanest single change would be nudging **wheel's
`recentVolatility` weight toward income's**. Not now — recorded for the next deeper IV panel.

**Net for §3.2:** VRP is real and non-uniform (§10.6), and the engine already harvests its most
robust, IVR-orthogonal piece (low realized vol) as a tail control. There is no new short-premium
edge to ship from this thread on current data — the value was *confirming the existing design is
sound* and identifying the wheel-weight question for later.

### 10.7 Honest limits

- **~12 months, overlapping 30-day windows** → ~12 quasi-independent obs/ticker, **one regime**
  (the 2025–26 negative-beta energy/staples year noted in the Replay spec). Trend-only: use it to
  *reject* a uniform-VRP null or find a gross sector/IV split, **not** to calibrate weights.
- **ATM-only IV** → this is ATM VRP, not a skew/term-structure-aware VRP. The richer decomposition
  (variance risk premium across the surface) needs the wider IV panel we don't have.
- **Survivorship**: current `fundamentals_cache` sector mapping applied backward; negligible at 12mo.

-----

## 11. Spike — liquidity-aware structure selection for the Brief/Critic (added 2026-07-01)

**Motivation.** The 2026-07-01 brief produced 23 picks / 1 critic pass; 15 non-passes carried
`low_liquidity` flags on mega-cap names (MRVL, DELL, NVDA…). Hypothesis: `pickRelevantStructure`
selects the highest-graded structure (big-lizard, put-butterfly), whose liquidity sits below the
8/15 tradability bar, while a plainer strategy-relevant structure clears it — i.e. the passes are
hiding behind structure *selection*, not structure *absence*.

**Method.** `scripts/fr-liquidity-aware-structure-study.mjs` — replays selection over every stored
brief pick (319 unique after de-dupe, ~2 months): V0 = current grade-first selection; V1 = same
defined-risk/pin-bet tiers, then prefer structures with liquidityScore ≥ 8, no zero-bid leg,
grade ≥ C. Emulates the critic's warning branch for both; settles both structures at expiry
intrinsic where possible.

**Result — hypothesis FALSIFIED (no ship).**
- **Unresolvable warning pools**: income 47/47, inflection 18/18 (direction-locked by design),
  bearish 29/30 — *no* strategy-relevant structure clears the bar on those picks. Selection
  cannot convert them; the liquidity wall there is real (4-leg structures on these names, as
  measured, are below the engine's own tradability bar).
- **Convertible but costly**: bullish 12/35, buy 14/41 — mean grade cost **−1.59 ranks**,
  typically A+ big-lizard (liq 6) → C call-zebra (liq 8-10). Presenting a materially worse-priced
  marginal structure to earn a cleaner badge is a bad trade; not shipped.
- **P&L delta**: no changed pick had settled by 2026-07-01 (27 pending) — no realized evidence.

**Secondary finding — after-close measurement artifact (needs data).**
`scripts/fr-liquidity-slot-comparison.mjs`: on paired same-day observations (same
date+strategy+ticker+slug in both the 10:15 and after-close briefs), evening liquidityScore reads
**−1.42** vs morning; bar clearance 68% (morning) vs 47% (evening); **all** paired deltas ≤ 0
(4 pass→fail flips, 0 reverse). The bar is 8 — a −1.4 shift flips structures right at the margin,
so evening-measured flags overstate illiquidity vs the intraday market where trades actually
happen. **Sample: 19 observations from a single date**, because `ScoringService.storeBrief`
deletes same-ET-day rows per strategy — the evening brief erases the morning brief's intraday
measurements every day. Compounding: the 17:00 orchestrator slot failed its E*Trade connectivity
check on ~8 of the last 10 trading days, so evening briefs actually ran 18:30–22:00 ET (manual
re-runs) on even staler quotes.

**Next actions.**
1. ~~Persist intraday liquidity measurements instead of discarding them~~ — **DONE v1.1.93**:
   `structure_liquidity_log` (migration 064) is appended by Stage 4 for every constructible
   structure; `fr-liquidity-slot-comparison.mjs` prefers it. Pairs accumulate from 2026-07-02.
2. After ~2–3 weeks of paired data (~mid-July 2026), re-run
   `node scripts/fr-liquidity-slot-comparison.mjs`. If the −1.4 artifact holds, design the fix
   (critic/gate uses the same-day intraday measurement when available) and take it through
   FR-SEY-5 (critic verdicts gate the engine's entries via `entry-policy.ts`).
3. ~~Separately fix the 17:00 connectivity failure~~ — **DONE v1.1.92**: dormant tokens can fail
   as a terminated stream (not a 401); the IV-job probe now renews-and-retries on any failure,
   so the evening chain runs at its designed ~17:05 slot again.

-----

## 12. Spike — expiry selection lands on thin weeklies (added 2026-07-01)

**Motivation.** Drilling into a specific `low_liquidity` flag (MRVL 2026-07-01, big-lizard
6/15) revealed the flagged legs sat on the **Jul 31 end-of-month WEEKLY** (OI 30–119) — not a
liquidity failure of MRVL (a top-5 options name), but of the *contract the lab chose*.
`selectExpiration` (`strategy-lab-service.ts`) picks the expiration in **[20,50] DTE closest to
30 with NO liquidity awareness**. Standard **monthly** options (3rd Friday) carry far more open
interest and tighter spreads than mid-month / EOM weeklies. When neither monthly lands near 30
DTE (2026-07-01: Jul monthly = 16 DTE, Aug monthly = 51 DTE), the rule snaps to the 30-DTE
weekly.

**Method.** `scripts/fr-expiry-liquidity-study.mjs` — over 9,567 unique stored brief structures,
classify each chosen near-expiration as monthly (3rd Friday) vs weekly and compare liquidity,
with a within-slug control to remove structure-composition confounds.

**Result — CONFIRMED (real, sizable, liquidity-blind selection).**
- **54% of structures land on a WEEKLY**, 46% on a monthly.
- Weekly-landed vs monthly-landed: mean **liquidityScore 5.97 vs 7.00**, **OI/leg 303 vs 984**
  (~3×), **clears the 8/15 bar 25% vs 36%**.
- **Within-slug control (same structure type): 27 of 29 slugs are more liquid on the monthly**,
  by +0.8 to +1.7 liquidityScore on the directional/short structures that matter (long-call-vert
  +1.56, big-lizard +1.16, short-put-vert +0.77, verticals/lizards all positive). The two
  exceptions (put-zebra −0.28, put-calendar −0.63) are calendar/ratio types whose liquidity is
  dominated by the far monthly leg. Confounded per-leg spread% (far-OTM wings) is NOT the basis
  — liquidityScore and OI are.
- On **62% of weekly-landed picks a monthly ALSO fell within [20,50] DTE** — an in-band monthly
  the current rule could have chosen but skipped because the weekly was marginally closer to 30.

**The +1.0–1.5 liquidity gap is exactly the size that flips marginal 6/15–7/15 flags over the 8
bar** — i.e. this, not structure selection (§11 falsified) or measurement staleness (§11, still
open at 19 obs), is the largest identified lever on the low-pass-rate complaint.

**Honest caveats before any change.**
- **The MRVL example itself is in the harder 38%** where NO monthly fell in [20,50] (16 vs 51
  DTE). A "prefer the in-band monthly" rule fixes the 62%, not MRVL; fixing MRVL needs *widening*
  the band (e.g. [14,55]) so 16/51 DTE becomes eligible — a bigger DTE swing.
- **DTE cost is real**: snapping a weekly to the nearest monthly moves the chosen DTE a mean
  **8.6 days** further from 30, changing credit/theta economics. Liquidity improvement is **not**
  the FR-SEY-5 acceptance test — net realized outcome is.

**Next actions (FR-SEY-5 — the lab feeds what the engine trades: wheel/income/inflection).**
1. **Realized-P&L A/B**: re-select each historical pick's structure at the nearest monthly and
   settle both to expiry (net credit − execution friction − DTE/theta economics). Blocked like
   the lizard-vs-spread study — the July structures don't settle until Jul 17–31 2026; re-run
   after. Only ship a monthly-preference (or widened band) if at-worst-neutral on net outcome.
2. ~~Same-ticker live A/B~~ — **DONE 2026-07-02**: MRVL big-lizard legs priced live at all three
   expiries in one request (zero time-of-day confound — same instant, settled OI). The Jul 31
   weekly the lab chose vs the flanking monthlies: ATM put **OI 30** vs 4,888 (Jul 17) / 1,423
   (Aug 21); ATM call **OI 68** vs 2,783 / 3,233; wing **OI 119 @ 19% spread** vs 783 @ 9% /
   1,466 @ 5%. **The weekly is 40–160× thinner in OI and 2–4× wider in spread than either
   neighbour** — structural, not a stale-quote artifact. Confirms the lever is real and large;
   an ATM leg going OI 30→4,888 / spread 7%→3% clears the 8 bar. Caveat holds: neither monthly
   is at 30 DTE (Jul 17 = 15, Aug 21 = 50), so the DTE/theta economics change — item 1 remains
   the acceptance test.
3. If it survives item 1: a liquidity-aware tie-break in `selectExpiration` (prefer the monthly
   when its DTE is within an acceptable band), NOT a blind "always monthly."

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