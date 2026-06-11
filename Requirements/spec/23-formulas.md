# 23 — Formula Reference (self-contained)

Every derived metric in the app, written out in full. This section is the single source of truth for the math; feature sections reference these anchors. All formulas are implementation-faithful. (In code, each metric carries a `// see docs/formulas.md#anchor` comment; this spec consolidates them so the app can be rebuilt without that file.)

Conventions: prices per share; money USD; IV as a decimal fraction inside Black-Scholes, as a percentage in display/storage; DTE = calendar days.

---

## 23.1 Fundamental ratios

Computed from raw Polygon financial statements (TTM = sum of last 4 quarters; LTM = latest filing). Implemented in `fundamentals-computer.ts`.

```
EPS_TTM        = sum(last_4_quarter_net_income) / share_count
P/E (TTM)      = current_price / EPS_TTM                         (null if EPS ≤ 0 or shares null)
Net margin     = sum(4q net_income) / sum(4q revenue) × 100
ROE            = net_income_TTM / shareholders_equity_LTM × 100   (end-of-period equity)
D/E            = total_debt / shareholders_equity                 (null for financial sector*)
Revenue growth = (rev_TTM − rev_prior_TTM) / |rev_prior_TTM| × 100   (null if prior ≤ 0)
EPS growth     = (EPS_TTM − EPS_prior_TTM) / |EPS_prior_TTM| × 100
FCF (TTM)      = operating_cash_flow_TTM − |capex_TTM|
Current ratio  = current_assets / current_liabilities            (null if liabilities = 0)
```
\* Financial-sector detection: sector string contains `bank`, `financial`, `insurance`, or `investment` → D/E returned null.

Quality signals (same source): ROIC, FCF-to-net-income, net-debt-to-EBITDA, 5-year revenue/EPS CAGR (compound annual growth), value/growth composite scores, beta, dividend yield.

---

## 23.2 Options & strategy math

### annualized-options-return
```
Annualized Return (%) = (premium / strike) × (365 / DTE) × 100
```
premium = mid-price credit per share; strike is also per-share, so premium/strike is the period
return on collateral directly. (Pre-v0.32.67 divided by strike × 100 — per-contract collateral
against per-share premium — understating results 100× and zeroing the premiumYield /
premiumRiskRatio scoring signals.) Used in Options Income & Wheel modes.

### wheel-suitability-score (1–10)
```
base = 1
+2  if IV rank ≥ 30
+2  if price within 25% of 52-wk high AND ≥ 15% above 52-wk low      (stability)
+2  if option liquidity score ≥ 5 (OI ≥ 500, bid-ask ≤ 5% of mid)
+2  if no earnings within the 45-day DTE window
+1  if ROE ≥ 15%
+1  if FCF > 0
score = min(10, base + applicable bonuses)
```

### buy-composite-score (0–10)
```
+3 trend bullish (price > SMA50 > SMA200)   |  +1 trend sideways
+2 RSI in 40–65                              |  +1 bonus if RSI 45–55
+1 P/E in 5–25
+1 profit margin ≥ 10%
+1 ROE ≥ 15%
+1 D/E < 1.0
+1 price > POC (volume profile)
+1 price > VAH (breakout)  OR  within 2% above VAL (support test)
score = min(10, sum)
```

### entry-zone-and-stop (buy mode)
```
entry_zone_low  = recent swing low (20-bar lookback)
entry_zone_high = SMA50 (or current price if SMA50 unavailable)
stop_loss       = entry_zone_low − 1.5 × ATR(14)
target          = entry_zone_low + 3 × ATR(14)
risk_reward     = (target − entry_zone_low) / (entry_zone_low − stop_loss)
```

### LEAPS+CSP scoring (§10A)
```
combined_score = leaps_sub_score × 0.60 + csp_sub_score × 0.40
extrinsic_pct  = (premium − intrinsic) / premium × 100
csp annualized = (csp_premium / (csp_strike × 100)) × (365 / csp_dte) × 100
```
LEAPS hard-fail filters: delta 0.70–0.90, DTE 365–730, spread ≤ 5%, OI ≥ 100, extrinsic ≤ 15%. CSP pool: delta −0.15 to −0.30, DTE 25–50, annualized ≥ 12%.

### Collared-LEAPS structural metrics (§10B)
```
cost_drag_pct        = put_debit / leaps_debit × 100
floor_depth_pct      = (spot − put_strike) / spot × 100
breakeven            = leaps_strike + total_debit / 100
max_loss_at_zero     = loss with stock → 0  (negative ⇒ fully hedged)
upside_retention_pct = collared P&L / naked-LEAPS P&L at +20% move
hedge_efficiency_pct = (naked_max_loss − collared_max_loss) / naked_max_loss × 100
rr_ratio             = max_profit_est / max_loss_at_put
```

### Black-Scholes (payoff risk matrix, pre-expiry cells)
Standard European Black-Scholes with r = 4.5% (risk matrix) / 4.5% elsewhere, sigma = each leg's IV **as a decimal fraction** (fallback 0.30). Never divide `leg.iv` by 100 — it is already a fraction. Final/expiry column uses intrinsic value only.

---

## 23.3 Indicators

All implemented in `analysis-service.ts` (mirrored by the technical-signals job and Validate).

### sma / ema
```
SMA(n)[t] = mean(C[t−n+1 .. t])                          (null for first n−1 bars)
k = 2 / (n + 1)
EMA(n)[t] = C[t] × k + EMA(n)[t−1] × (1 − k)             (seed: EMA = SMA of first n bars)
```

### rsi-14 (Wilder)
```
RS = avg_gain / avg_loss
RSI = 100 − 100 / (1 + RS)
avg_gain[t] = (avg_gain[t−1]×(n−1) + gain[t]) / n        (seed: arithmetic mean of first n)
avg_loss[t] = (avg_loss[t−1]×(n−1) + loss[t]) / n
avg_loss = 0 ⇒ RSI = 100
```

### atr-14 (Wilder)
```
TR = max(H−L, |H−PC|, |L−PC|)            (PC = prior close)
ATR(seed) = mean(TR[0..n−1])
ATR[t]    = (ATR[t−1]×(n−1) + TR[t]) / n
```

### adx-14 (Wilder)
```
+DM = max(0, H−PH);  −DM = max(0, PL−L)   (zero out the smaller of the two each bar)
TR  = max(H−L, |H−PL|, |L−PH|)
Smooth +DM, −DM, TR over n via Wilder smoothing
+DI = 100 × (+DM_s / TR_s);  −DI = 100 × (−DM_s / TR_s)
DX  = |+DI − −DI| / (+DI + −DI) × 100
ADX = Wilder_smooth(DX, n)
```
Trend confirmed when ADX > 20 with the matching price/SMA relationship.

### macd (12/26/9)
```
MACD line   = EMA(12) − EMA(26)
Signal line = EMA(9) of the MACD line
Histogram   = MACD line − Signal line
Bullish cross = MACD line crosses above Signal line
```

### bollinger-bands (20, 2σ)
```
Mid   = SMA(20)
σ     = sqrt(mean((C[i] − Mid)²)) over the 20-window
Upper = Mid + 2σ;  Lower = Mid − 2σ
Position (%) = (Price − Lower) / (Upper − Lower) × 100
```

### volume-profile (24 bins, 70% value area)
```
binSize = (max(high) − min(low)) / 24
each bar's volume spread across the bins it spans
POC = midpoint of the highest-volume bin
Value Area = highest-volume bins accumulated until they hold 70% of total volume
VAL = lower edge of the lowest value-area bin;  VAH = upper edge of the highest
```

### trend classification
```
Bullish  : price > SMA50 > SMA200  AND ADX > 20
Bearish  : price < SMA50 < SMA200  AND ADX > 20
Sideways : otherwise
```

---

## 23.4 IV history

### atm-iv-interpolation (30-day constant maturity)
```
For each expiration: ATM_IV_exp = (call_iv + put_iv) / 2 at the ATM strike
near = highest DTE ≤ 30;  far = lowest DTE > 30
w_near = (dte_far − 30) / (dte_far − dte_near);  w_far = 1 − w_near
ATM_IV_30d = ATM_IV_near × w_near + ATM_IV_far × w_far
```
Single-sided bracket ⇒ use that expiration directly. IVs are decimal fractions.

### iv-rank / iv-percentile (252 trading-day window)
```
IV Rank       = (current_iv − min_iv_252d) / (max_iv_252d − min_iv_252d) × 100
IV Percentile = count(days where iv < current_iv) / total_days × 100
```
Require ≥ 21 data points, else null.

---

## 23.5 Portfolio Greeks

```
isOption   = positionType ∈ {CSP, CC}
multiplier = isOption ? quantity × 100 : quantity

Net Delta       = Σ(et.delta × multiplier) over positions with ET Greeks
                + Σ(quantity) for stock positions without ET data (Δ = 1/share)
Total Theta/day = Σ(et.theta × multiplier)         (options only; $/day)
Total Vega      = Σ(et.vega × multiplier)          (options only; $ per 1% IV)
BP Used %       = totalCapitalDeployed / accountSize × 100
  totalCapitalDeployed = Σ(entry_price × quantity)        [Stock]
                       + Σ(strike_price × quantity × 100)  [CSP/CC]
```
E*Trade Greeks are per-share; × multiplier gives position-level impact. `accountSize` default 0 ⇒ BP% hidden.

---

## 23.6 Scoring-engine normalization (§13)

```
higher_better : norm = clamp(value / normMax × 100, 0, 100)
lower_better  : norm = clamp((1 − value / normMax) × 100, 0, 100)
target_range  : 100 inside [targetMin, targetMax], linear falloff outside
composite     = Σ(norm_i × weight_i) / Σ(weight_i)   over enabled signals with data
```

---

## 23.7 Backtest metrics (§21)

```
total_return_pct      = (final_equity − starting_capital) / starting_capital × 100
annualized_return_pct = ((1 + total_return_pct/100) ^ (365 / span_days) − 1) × 100
                        span_days = days between first and last equity-curve points
max_drawdown_pct      = max over the curve of (running_peak − equity) / running_peak × 100
win_rate              = winning_trades / total_trades
avg_trade_pnl         = net_pnl / total_trades

Sharpe (from daily equity returns, ≥ 3 points):
  daily_rf = 0.02 / 252                         (2% annual risk-free)
  r[i]     = (equity[i] − equity[i−1]) / equity[i−1]
  Sharpe   = (mean(r) − daily_rf) / stddev(r) × sqrt(252)
```
