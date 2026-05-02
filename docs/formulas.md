# Formulas

Every financial-metric formula in code must reference the matching anchor here via `// see docs/formulas.md#anchor`. This document is intentionally short while the codebase is in Phase 1; it grows as analytical features land.

## Why this file exists

The spec (EP-12.2) requires every derived financial metric to point back to its formula and source. This protects against silent drift: if a contributor changes the implementation, the formula doc is the next thing they read, and the original definition (with citation) is right there.

## Ratios (Phase 2)

Implemented by `src/main/services/fundamentals-computer.ts`.

### price-to-earnings

```
P/E (TTM) = current_price / EPS_TTM
EPS_TTM   = sum(last_4_quarter_net_incomes) / share_count
```
Source: standard. Spec §5.2.2. Null when EPS is zero or share count is null.

Implementation: `computeRatios()` in fundamentals-computer.ts.

### earnings-per-share

```
EPS_TTM = sum(last_4_quarter_net_incomes) / share_count
```
Source: standard. Spec §5.2.2.

Implementation: `computeRatios()` → `eps` field.

### profit-margin-net

```
Net margin (TTM) = sum(last_4_q_net_income) / sum(last_4_q_revenue) × 100
```
Source: standard. Spec §5.2.2.

Implementation: `computeRatios()` → `profitMargin` field.

### return-on-equity

```
ROE = net_income_TTM / shareholders_equity_LTM × 100
```
Source: standard. Spec §5.2.2.

Implementation: `computeRatios()` → `roe` field. Note: uses end-of-period equity (single latest filing), not average — per spec §10 this is a known simplification.

### debt-to-equity

```
D/E = total_debt / shareholders_equity
```
Source: standard. Spec §5.2.2. Financial sector (banks, insurance, investment) is **exempt** — D/E is returned as null. Detection: sector string contains 'bank', 'financial', 'insurance', or 'investment'.

Implementation: `computeRatios()` → `debtToEquity` field.

### revenue-growth-yoy

```
Revenue growth YoY = (revenue_current_TTM − revenue_prior_TTM) / |revenue_prior_TTM| × 100
```
Source: standard. Spec §5.2.2. Null when prior revenue is ≤ 0 or unavailable.

Implementation: `computeRatios()` → `revenueGrowth` field.

### eps-growth-yoy

```
EPS growth YoY = (EPS_current_TTM − EPS_prior_TTM) / |EPS_prior_TTM| × 100
EPS_TTM = sum(last_4_q_net_income) / share_count
```
Source: standard. Spec §5.2.2.

Implementation: `computeRatios()` → `epsGrowth` field.

### free-cash-flow

```
FCF (TTM) = operating_cash_flow_TTM − |capital_expenditures_TTM|
```
Source: standard. Spec §5.2.2.

Implementation: `computeRatios()` → `freeCashFlow` field.

### current-ratio

```
Current ratio = total_current_assets / total_current_liabilities
```
Source: standard. Spec §5.2.2. Null when liabilities are zero.

Implementation: `computeRatios()` → `currentRatio` field.

## Indicators (Phase 4)

### sma, ema, rsi-14, macd, adx, bollinger-bands

> _Phase 4._ Standard formulas; source: Wilder (RSI/ADX), Appel (MACD), Bollinger (BBands). Anchors will land with the indicator module.

## Strategy math (Phase 3)

### iv-rank, iv-percentile

> _Phase 3._ IV rank = (current IV − 52w min IV) / (52w max IV − 52w min IV) × 100. IV percentile = % of trading days in past 252 where IV was below today's. Spec §5.4.2 E.

### wheel-suitability-score

> _Phase 3._ Transparent weighted formula combining trend stability, IV rank, liquidity, distance to earnings, assignment-comfort. Exact weights TBD; will be documented here when the analysis engine ships.

### entry-zone-and-stop

> _Phase 4._ Suggested entry = recent support ± k·ATR; stop below entry by k_stop·ATR. Exact constants TBD; per spec §5.4.2 D the math must be visible in a UI tooltip and source-cited here.
