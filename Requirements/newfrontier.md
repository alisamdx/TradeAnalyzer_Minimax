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