# Wheel Strategy Enhancement — Future Considerations

Sourced from: WheelMetrics Pro analysis (May 2026)

---

## Priority 1 — Fundamental Quality Gate (Philosophy Change)

**What:** Require candidates to pass a minimum fundamental quality bar before the wheel scorer runs. Today, a company with garbage fundamentals but elevated IV can score 8/10 and appear as a strong wheel candidate. The gate inverts this: fundamentals first, options signals second.

**Proposed gate criteria (must pass all to proceed to options scoring):**
- ROIC ≥ 15%
- FCF / Net Income ≥ 80%
- D/E ≤ 0.8 (tighter than current ≤ 1.0)
- Net Debt / EBITDA ≤ 3.0

**Where to implement:** `src/main/services/analysis-service.ts` `modeWheel()` + `src/main/services/opportunity-service.ts` fundamentals scoring block.

**Current gap:** Wheel scorer awards 6/10 points to options-market signals (IV Rank, liquidity, earnings timing) and only 2/10 to fundamentals (ROE ≥ 15%, FCF > 0). This should be rebalanced once the gate is in place.

---

## Priority 2 — Replace / Supplement ROE with ROIC

**What:** Add ROIC (Return on Invested Capital) to `src/main/services/fundamentals-computer.ts`. Replace or supplement ROE in the wheel scorer with ROIC.

**Why ROIC over ROE:** ROE is inflatable via leverage — a debt-heavy company can show great ROE while destroying value. ROIC measures returns on all invested capital and is much harder to game. Threshold: ≥ 15% (S&P 500 historical avg ≈ 10%; 15% means compounding faster than the broad market).

**Formula:** `ROIC = NOPAT / Invested Capital` where `NOPAT = Operating Income × (1 - tax rate)` and `Invested Capital = Total Equity + Total Debt - Cash`.

**Data available:** All inputs already pulled from Polygon fundamentals. No new data source needed.

**Also add:** FCF / Net Income ratio (FCFToNetIncome). Current check is only `FCF > 0`. The ratio ≥ 80% confirms reported earnings are backed by real cash — catches accrual-inflated profits.

---

## Priority 3 — PEUpside% (P/E Mean-Reversion Signal)

**What:** For each stock, compute how much upside exists if the P/E ratio reverts to its own historical median.

**Formula:**
```
implied_price = historical_median_PE × forward_EPS
PEUpside% = (implied_price - current_price) / current_price × 100
```

**Why it matters for wheel:** Answers "if I get assigned, is there upside from here?" A stock at 80% PEUpside% is a quality name trading well below its own historical valuation — ideal assignment territory. A stock at -40% PEUpside% means you'd be buying at the top of its historical multiple.

**Green threshold (per WheelMetrics):** ≥ 60%

**Data requirements:** Historical annual P/E (need 3-5 years of year-end P/E data) + forward EPS (analyst consensus). Forward EPS is not currently available from Polygon's free tier — this may require a data source decision.

**Where to implement:** New column in `src/main/services/fundamentals-computer.ts`, surfaced in Analysis and Opportunity views.

---

## Lower Priority — Multi-Year Growth Trends

**What:** Replace YoY revenue/EPS growth with 5-year CAGRs.

**Why:** A company can show strong 1-year growth from a one-time event while being structurally stagnant. 5Y CAGR reveals the underlying compounding rate.

**Thresholds (per WheelMetrics):**
- Revenue CAGR 5Y ≥ 5%
- EPS CAGR 5Y ≥ 7%

**Data requirements:** Requires storing 5 years of annual revenue and EPS data. Currently only YoY snapshots are stored. This is a non-trivial pipeline change — needs a historical annual fundamentals table in the DB and a backfill strategy.

---

## Lower Priority — 10-Year Price Position

**What:** Flag when a stock is trading below its 10-year median price — quality companies temporarily out of favor.

**Why:** A stock can be near its 52-week high yet still well below its decade median, signaling a genuinely depressed valuation in a longer context. We currently only track the 52-week range.

**Green threshold:** Current price < 10-year median price (i.e., 10YPctChange < 0%)

**Data requirements:** 10 years of weekly/monthly price history. Significant storage and backfill requirement. Lower priority until the data pipeline supports it.

---

## Notes

- Items 1 and 2 are implementable now with existing data — no new data sources required.
- Item 3 (PEUpside%) is partially blocked by forward EPS availability; historical P/E history is the other dependency.
- Items 4 and 5 are data-pipeline problems first, feature problems second.
- Net Debt / EBITDA requires EBITDA, which Polygon does not currently provide in the data pull — needs investigation.
