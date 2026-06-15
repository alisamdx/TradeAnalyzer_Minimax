# Professional Trader Review — TradeAnalyzer

> **Context:** Generated 2026-06-07 via a structured review of the full codebase (scoring engine, strategy lab, backtest, screener, formulas, all 26 views) from the perspective of an experienced professional trader. Intended as input for future roadmap prioritization.

---

## Short Answer

**Conditionally yes, with a clear ceiling.** The app earns its claim for the specific trader it was built for, with identifiable gaps that cap its edge for more active professionals.

---

## Where the App Genuinely Earns Its Claim

**1. The screener + scoring engine is real work.**
The wheel scoring signal set (IV rank 25%, premium yield 21%, fundamental quality 18%, RSI neutral 13%, recent realized vol 10%, liquidity 9%, leverage 4%) is legitimately grounded — that's the Tom Sosnoff/McMillan framework applied correctly. Most retail traders eyeball these things; this enforces discipline automatically every morning. That alone is worth money over time.

**2. The screening universe is the right one.**
S&P 500 + Russell 1000 + ETFs with market cap ≥ $2B, avg volume ≥ 1M, EPS > 0 is a sound options-grade universe. Garbage in = garbage out — this starts with a clean pool.

**3. IV rank as a first-class signal.**
The `ivRank < 30 = don't sell` enforcement baked into scoring is the single most valuable rule for premium sellers. Most retail traders violate it constantly. This app makes it structural.

**4. Strategy Lab covering 31 strategies.**
Comprehensive. The delta-targeted leg construction is mechanically correct. The IV preference / direction matching is exactly how a tastytrade-style trader thinks.

**5. Portfolio Greeks (delta / theta / vega) from live E*Trade data.**
Portfolio-level delta and theta decay awareness is a professional-grade feature. Retail traders almost never track these at book level.

**6. Earnings-aware filtering.**
`daysToEarnings` in the wheel screener, the Saturday→Friday UTC shift in the earnings service, and the 45-day window check prevent the single most common retail CSP disaster.

---

## Limitations That Cap the Edge

**1. Data quality is the critical gap.**
Polygon.io Stocks Starter is end-of-day / 15-min delayed. E*Trade options is 15-min delayed unless the user has a live data subscription. Every scoring decision — IV rank, delta targeting, premium yield — is built on potentially stale data. In calm markets that's fine. In volatile markets (exactly when IV rank is actionable), a 15-min-old chain is dangerous. Users must confirm current prices and Greeks in their broker before executing.

**2. The backtest engine is synthetic, not historical.**
Using 20-day realized vol as the Black-Scholes sigma to price historical options is a fundamental limitation. Actual IV at any historical point was not the realized vol — it was usually higher (the vol risk premium). This means the backtest systematically overestimates premium income and underestimates time-value on the buy side. Conclusions from the backtest require real skepticism. Professional-grade backtesting needs actual historical option chain data.

**3. No closed feedback loop.**
The scoring engine recommends trades. The portfolio tracks manually entered trades. But there is no linkage between:
- "Trade Scoring recommended MSFT wheel at score 82 on date X"
- "You entered it at price Y"
- "Closed at Z — P&L was $A"

Without this feedback loop you cannot know whether the scoring is calibrated to actual outcomes. This is the difference between a signal generator and a trading system.

**4. No position sizing guidance.**
The app tells you *what* to trade but not *how much*. Missing:
- Kelly criterion or fixed-fractional sizing
- Max % of buying power per ticker
- Beta-weighted delta-to-SPY target
- Max notional per sector

For a multi-position wheel book, position sizing is where most risk management actually lives.

**5. Phase 2 signals score zero.**
Several signals in the scoring configs are marked `phase2: true` and always score 0. While weighted in the config, they dilute the meaningful signals and produce phantom scores. Users should disable or remove them until implemented.

**6. AI brief quality (Haiku model).**
`claude-haiku-4-5` is used for the daily intelligence brief. For market synthesis, Sonnet or Opus quality reasoning is preferable — Haiku risks being superficially correct but missing second-order connections.

---

## Verdict by Trader Profile

| Trader profile | Would it help? | Reason |
|---|---|---|
| Disciplined retail trader, wheel/CSP/CC, $50K–$200K | **Yes, materially** | Enforces IV rank, earnings avoidance, fundamental quality — replaces hours of manual research and prevents common mistakes |
| Semi-active retail trader, multiple strategies | **Yes, moderately** | Strategy Lab + payoff modeling is solid for planning; scoring creates a forcing function for selectivity |
| Active professional, $500K+, real-time decisions | **Yes for research, no for execution** | Delayed data and no closed feedback loop make it a morning planning tool, not an intraday decision engine |
| Pure day trader / scalper | **No** | Entire architecture is end-of-day batch — not relevant to intraday style |

---

## Top 3 Recommended Additions (Prioritized)

### 1. Outcome Tracking (highest ROI)
Link a closed position back to its scoring recommendation and log the actual P&L. After 6 months you'll know which signals are predictive for *your* stocks and can tune weights empirically rather than relying on expert priors alone.

- Schema: join `positions` closed records back to `scoring_strategy_configs` runs at entry date
- UI: a "Signal Attribution" view showing which signals correlated with profitable vs losing trades
- This transforms the scoring engine from a signal generator into a learning system

### 2. Position Sizing Module
Even a simple constraint layer adds professional-grade risk control:
- Max X% of buying power per ticker (e.g., 5%)
- Target portfolio beta-weighted delta range (e.g., ±50 deltas)
- Max notional per sector
- Alert when any constraint would be breached by a new trade

### 3. Historical Options Data for Backtest
Replace or supplement the synthetic Black-Scholes backtest with actual historical option chain data:
- Source candidates: CBOE DataShop, OptionMetrics, Unusual Whales historical data
- At minimum, label the current synthetic backtest clearly as "illustrative" in the UI to prevent over-reliance on its results

---

## Summary

The bones are good. The screening discipline, IV rank enforcement, and scoring framework will prevent bad trades more than they'll find great ones — and that asymmetry (loss prevention over alpha generation) is where most retail edge actually lives.

The weakness is not in the features. It is in the feedback loop that would prove the features are working.
