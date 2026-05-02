# Formulas

Every financial-metric formula in code must reference the matching anchor here via `// see docs/formulas.md#anchor`. This document is intentionally short while the codebase is in Phase 1; it grows as analytical features land.

## Why this file exists

The spec (EP-12.2) requires every derived financial metric to point back to its formula and source. This protects against silent drift: if a contributor changes the implementation, the formula doc is the next thing they read, and the original definition (with citation) is right there.

## Ratios (Phase 2)

The following sections will be filled in as the screener and fundamentals-computer module land. Placeholders below name the anchors that code may reference.

### price-to-earnings

> _Phase 2._ TTM P/E = price / TTM EPS. Source: standard. Spec §5.2.2.

### profit-margin-net

> _Phase 2._ Net margin = net income (TTM) / revenue (TTM). Spec §5.2.2.

### return-on-equity

> _Phase 2._ ROE = net income (TTM) / average shareholders' equity. Spec §5.2.2.

### debt-to-equity

> _Phase 2._ D/E = total debt / shareholders' equity. Total debt = short-term + long-term. Spec §5.2.2.

### revenue-growth-yoy

> _Phase 2._ Revenue growth YoY = (revenue_TTM − revenue_prior_TTM) / revenue_prior_TTM. Spec §5.2.2.

### eps-growth-yoy

> _Phase 2._ EPS growth YoY = (EPS_TTM − EPS_prior_TTM) / EPS_prior_TTM. Spec §5.2.2.

### free-cash-flow

> _Phase 2._ FCF (TTM) = operating cash flow (TTM) − capital expenditures (TTM). Spec §5.2.2.

### current-ratio

> _Phase 2._ Current ratio = current assets / current liabilities. Spec §5.2.2.

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
