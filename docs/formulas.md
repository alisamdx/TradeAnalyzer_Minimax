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

### annualized-options-return

```
Annualized Return (%) = (premium / (strike × 100)) × (365 / DTE) × 100
```

Premium = mid-price credit received per share. Strike = strike price. DTE = days to expiration.
Used in `AnalysisService.modeOptionsIncome()` and `modeWheel()`. see SPEC: §5.3, Mode 2.

### wheel-suitability-score

Weighted 1–10 score for wheel strategy candidates. Implemented in `AnalysisService.modeWheel()`.

| Criterion | Weight | Pass condition |
|-----------|--------|----------------|
| IV rank ≥ 30 | +2 | `iv_rank >= 30` |
| Price within 25% of 52-wk high AND ≥ 15% above 52-wk low | +2 | stability pass |
| Option liquidity (OI ≥ 500, bid-ask ≤ 5%) | +2 | liquidity score ≥ 5 |
| No earnings within DTE window (45 days) | +2 | earnings pass |
| ROE ≥ 15% (fundamental quality) | +1 | `roe >= 15` |
| Free cash flow > 0 | +1 | `fcf > 0` |
| **Base score** | 1 | minimum viable |

Score = base(1) + sum of applicable bonuses, capped at 10.
see SPEC: §5.3, Mode 3 (Wheel). Implemented in `src/main/services/analysis-service.ts` → `modeWheel()`.

### buy-composite-score

Composite score 0–10 for buy opportunities. Implemented in `AnalysisService.modeBuy()`.

| Criterion | Points |
|-----------|--------|
| Trend = bullish (price > SMA50 > SMA200) | +3 |
| Trend = sideways | +1 |
| RSI 40–65 | +2 |
| RSI 45–55 (sweet spot) | +1 bonus |
| P/E 5–25 | +1 |
| Profit margin ≥ 10% | +1 |
| ROE ≥ 15% | +1 |
| D/E < 1.0 | +1 |

Score = min(10, sum of applicable criteria). see SPEC: §5.3, Mode 1 (Buy Opportunities).

### iv-rank, iv-percentile

```
IV rank = (current IV − 52w min IV) / (52w max IV − 52w min IV) × 100
IV percentile = % of trading days in past 252 where IV was below today's
```

Polygon snapshot does not provide these directly — Phase 3's producer/consumer pipeline computes them post-fetch from 52-week IV history. Until then, both are `null`. see SPEC: §5.4.2 E, §4.4.

### sma

Simple Moving Average of period `n`:

```
SMA(n) = (C[t] + C[t-1] + … + C[t-n+1]) / n
```

For the first `n-1` bars, SMA is `null`. Implemented in `computeSMA()` in `analysis-service.ts`.

### ema

Exponential Moving Average with smoothing factor `k`:

```
k = 2 / (n + 1)
EMA(n)[t] = C[t] × k + EMA[n][t-1] × (1 − k)
```

Seed: first EMA = SMA of first `n` bars. Implemented in `computeEMA()` in `analysis-service.ts`.
see docs/formulas.md#ema

### rsi-14

Relative Strength Index (Wilder's smoothed method, period = 14):

```
RSI(n) = 100 − 100 / (1 + RS)
RS = avg_gain / avg_loss  (over the last n periods)

avg_gain[t] = (avg_gain[t-1] × (n − 1) + gain[t]) / n
avg_loss[t] = (avg_loss[t-1] × (n − 1) + loss[t]) / n
```

Seed: first `avg_gain` / `avg_loss` are arithmetic means of the first `n` changes.
RS = `Infinity` when `avg_loss = 0` → RSI = 100.
Implemented in `computeRSI()` in `analysis-service.ts`. see docs/formulas.md#rsi-14

### atr

Average True Range (Wilder's smoothed, default period = 14):

```
TR = max(H − L, |H − PC|, |L − PC|)   (PC = prior close)
ATR(t) = (ATR(t-1) × (n − 1) + TR[t]) / n   (after seed period)
ATR(seed) = sum(TR[0..n-1]) / n
```

Used in buy-opportunity entry zone and stop-loss computation. Implemented in `computeATR()` in `analysis-service.ts`. see docs/formulas.md#atr

### adx

Average Directional Index (Wilder, period = 14):

```
+DM = max(0, H − PH)  (PH = prior high)
−DM = max(0, PL − L)  (PL = prior low)
TR = max(H − L, |H − PL|, |L − PH|)

Smoothed values over period n using Wilder's method.

+DI = 100 × (+DM_smooth / TR_smooth)
−DI = 100 × (−DM_smooth / TR_smooth)
DX = |+DI − −DI| / (+DI + −DI) × 100
ADX = Wilder_smoothing(DX, n)
```

Trend confirmed: ADX > 20 AND appropriate price/SMA relationship.
Implemented in `computeADX()` in `analysis-service.ts`. see docs/formulas.md#adx

### bollinger-bands

```
Mid = SMA(20)
σ = sqrt(mean((C[i] − Mid)²))
Upper = Mid + 2σ
Lower = Mid − 2σ
Position = (Price − Lower) / (Upper − Lower) × 100  (in % of band range)
```

Used in the Validate All indicator section. Implemented in `buildValidateResult()` in `validate-all-service.ts`.

### entry-zone-and-stop

For buy opportunities, stop-loss and target are derived from ATR and swing low:

```
Entry zone lower = recent swing low (20-bar lookback)
Entry zone upper = SMA50 (or current price if no SMA50)
Stop-loss = Entry zone low − 1.5 × ATR(14)
Target = Entry zone low + 3 × ATR(14)
Risk/Reward = (Target − Entry zone low) / (Entry zone low − Stop-loss)
```

These formulas surface in the UI tooltip in the validation dashboard (Phase 4).
Implemented in `modeBuy()` in `analysis-service.ts`. see docs/formulas.md#entry-zone-and-stop
