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

### dividend-yield

```
Dividend yield (%) = TTM_regular_cash_dividends_per_share / current_price × 100
```
Source: standard trailing yield. Numerator = sum of `cash_amount` from Polygon
`/v3/reference/dividends` with `ex_dividend_date` in the last 365 days, excluding
special dividends (`dividend_type = 'SC'`) so one-off payouts don't inflate the
yield the wheel/income scoring sees. 0 = confirmed non-payer; null = fetch failed.

Implementation: `PolygonDataProvider.getTtmDividendsPerShare()` → `computeRatios()` → `dividendYield` field. (v0.32.84)

### beta

```
Beta = cov(r_stock, r_SPY) / var(r_SPY)
```
over the last 252 daily returns (253 closes), joined on date so holidays/gaps in
either series can't misalign returns. Closes use `adjusted_close` when available.
Null when fewer than 200 overlapping observations (new listings, sparse backfill)
or when market variance is ~0 — never a synthesized value.

Implementation: `beta-service.ts` (`computeBeta` pure function + `BetaService.getBeta`
reading local `historical_prices`) → injected into `PolygonDataProvider` → `computeRatios()` → `beta` field. (v0.32.84)

### quality-signals

```
FCFToNetIncome  = operating_cash_flow_TTM / net_income_TTM × 100      (null if NI ≤ 0)
ROIC            = NOPAT / (total_debt + equity) × 100
                  NOPAT = op_income × (1 − taxRate); implied taxRate clamped [5%, 50%]
NetDebtToEBITDA = (total_debt − cash) / (op_income_TTM + D&A_TTM)
```

`NetDebtToEBITDA` null conditions (v0.32.87):
- **Financial sector** (same detection as D/E) — EBITDA is meaningless for banks, and
  their cash positions produced absurd negatives (RF: −176) that spuriously passed
  the ≤3 value-score criterion.
- **|ratio| > 50** — near-zero EBITDA denominators carry no signal (observed: 252, 909).
- EBITDA ≤ 0, or D&A unavailable (publishing EBIT/debt as "EBITDA" would mislead).
- Legitimate negative values (true net-cash companies) are kept.

Implementation: `computeRatios()` → `fcfToNetIncome`, `roic`, `netDebtToEbitda` fields.

## Indicators (Phase 4)

### sma, ema, rsi-14, macd, adx, bollinger-bands

> _Phase 4._ Standard formulas; source: Wilder (RSI/ADX), Appel (MACD), Bollinger (BBands). Anchors will land with the indicator module.

## Strategy math (Phase 3)

### breakeven-distance

For income structures (strangles, condors, iron-flies), how far the underlying can move before the net credit is consumed:

```
breakevenDistancePct (%) = |netCredit| / underlyingPrice
```

**Key invariant:** `netCredit` from the Strategy Lab is stored **per-contract** (= per-share value × 100). `underlyingPrice` is **per-share**. Therefore `netCredit / price` already yields a percentage directly — do **not** multiply by 100.

Example: XOM credit $1,132.50/contract ÷ $148.91/share = 7.6% breakeven distance.

Used in `CriticService.synthesizeVerdict()` → `structure.breakevenDistancePct` field passed to the critic LLM prompt.

### annualized-options-return

```
Annualized Return (%) = (premium / strike) × (365 / DTE) × 100
```

Premium = mid-price credit received per share. Strike = strike price. DTE = days to expiration.
Both premium and strike are **per-share**, so `premium / strike` is the period return on collateral
directly. (Before v0.32.67 this divided by `strike × 100` — per-contract collateral against per-share
premium — understating the result 100× and zeroing the `premiumYield` / `premiumRiskRatio` scoring signals.)
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
| Price > POC (volume profile) | +1 |
| Price > VAH (breakout) OR within 2% above VAL (support test) | +1 |

Score = min(10, sum of applicable criteria). see SPEC: §5.3, Mode 1 (Buy Opportunities).

### volume-profile-levels

Computed in `computeVolumeProfileLevels()` in `analysis-service.ts` (also mirrored in `VolumeProfile.ts` for chart rendering).

Given N bars and `binCount = 24`:

```
binSize = (max(high) − min(low)) / binCount
bins[i] += bar.volume / numBinsSpanned   for each bar
POC  = midpoint of the bin with the highest accumulated volume
Value Area = set of bins (highest-vol first) that together contain 70% of total volume
VAL  = lower edge of the lowest-index bin in the value area
VAH  = upper edge of the highest-index bin in the value area
```

Buy signal interpretation:
- Price > VAH → breakout above value area (+1 in buy score)
- Price within 2% of VAL from above → support test (+1 in buy score)
- Price > POC → buyers in control (+1 in buy score)

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
Implemented in `computeADX()` in `analysis-service.ts` and `daily-technical-signals-job.ts`. see docs/formulas.md#adx

### support-level

20-day low — used as a support zone proxy for the `breakoutScore` `priceNearSupport` component when no `analysis_snapshots` entry exists for the ticker.

```
support_level = min(low) over last 20 bars
```

Stored in `technical_signals.support_level`, populated by `DailyTechnicalSignalsJob`.

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

## IV History (v0.17.0)

### iv-history

IV History stores daily 30-day constant-maturity ATM implied volatility per ticker.
Used to compute IV Rank and IV Percentile over a 252 trading-day window.

```
IV Rank      = (current_iv − min_iv_252d) / (max_iv_252d − min_iv_252d) × 100
IV Percentile = count(days where iv < current_iv) / total_days × 100
```

- `current_iv` is today's most recent reading (decimal, e.g. 0.285).
- `min_iv_252d` / `max_iv_252d` are the min and max of the last 252 trading-day window.
- At least 21 data points required before returning a value (returns null otherwise).

Implemented in `IvHistoryService.getIvRank()` in `src/main/services/iv-history-service.ts`.

### atm-iv-interpolation

30-day constant-maturity ATM IV is computed from two expirations bracketing 30 DTE:

```
1. Group all contracts by expiration date.
2. For each expiration: find the ATM strike (nearest to underlying price) that has
   both a call IV and a put IV.  ATM_IV_exp = (call_iv + put_iv) / 2.
3. Identify near = highest DTE ≤ 30, far = lowest DTE > 30.
4. weight_near = (dte_far − 30) / (dte_far − dte_near)
   weight_far  = 1 − weight_near
   ATM_IV_30d  = ATM_IV_near × weight_near + ATM_IV_far × weight_far
```

If only one side of the bracket is available, use that expiration's IV directly.
IVs are stored as decimal fractions (0.285 = 28.5%).

Implemented in `computeAtmIv()` in `src/main/services/iv-history-service.ts`.

### trading-days

NYSE trading days are calendar weekdays excluding the NYSE_HOLIDAYS set
(hardcoded for 2023–2027; extend as needed). The gap-detection logic uses
`tradingDaysInRange(from, to)` to enumerate missing dates.

Implemented in `src/main/services/iv-history-service.ts`.

## Portfolio Greeks (ENH-3)

Computed in `PortfolioView.tsx` from `PositionEtrade` data and position records.

### portfolio-greeks

```
For each open position:
  isOption = positionType ∈ { 'CSP', 'CC' }
  multiplier = isOption ? quantity × 100 : quantity

Net Delta      = Σ (et.delta × multiplier)            [all open positions with ET data]
               + Σ (quantity)                          [stock positions with no ET data; assumes Δ=1/share]

Total Theta/day = Σ (et.theta × multiplier)            [options only; result is $/day]

Total Vega     = Σ (et.vega × multiplier)              [options only; result is $ per 1% IV move]

BP Used %      = totalCapitalDeployed / accountSize × 100
  where totalCapitalDeployed = Σ (entryPrice × quantity)         [Stock]
                              + Σ (strikePrice × quantity × 100)  [CSP / CC]
```

Greeks (delta, theta, vega) come from E*Trade Complete response — per-share values.
The × 100 multiplier converts to per-contract position-level impact.
`accountSize` is a user-configured setting (default 0 = BP% hidden).

Implemented in `greeksSummary` useMemo in `src/renderer/src/views/PortfolioView.tsx`.



## Scoring Engine — Trend Alignment

### trend-alignment

Used by `computeTrendDirectionScore()` in `scoring-service.ts` for signals `trendAlignment` (Buy, Bullish) and `notDowntrend` (Wheel).

**Direction resolution (in priority order):**

1. `d.trendLabel` from `analysis_snapshots` (buy mode) — explicit label set by the analysis engine
2. Derived from `smaStack` + `lastPrice` (populated from `technical_signals` for all universe tickers):
   - `price > sma50 > sma200` → `'bullish'`
   - `price < sma50 < sma200` → `'bearish'`
   - mixed alignment → `'sideways'`
   - only SMA200 available: `price > sma200` → `'bullish'`, else `'bearish'`
   - only SMA50 available: cannot reliably determine → `null` (signal missing)

**Raw score mapping:**

| Direction | `mode='directional'` (Buy, Bullish) | `mode='wheel'` (Wheel) |
|-----------|--------------------------------------|------------------------|
| bullish   | 100                                  | 100                    |
| sideways  | 25                                   | 75                     |
| bearish   | 0                                    | 10                     |
| null      | signal missing (counts as 0)         | signal missing         |

**Rationale:**
- *Directional* (Buy / Bullish): sideways = ~7.5 pt composite penalty at weight 10; bearish = full 10 pt penalty. A sideways stock is an income candidate, not a directional one.
- *Wheel*: downtrend = ~7 pt composite penalty at weight 8 (avoid falling-knife CSP assignment); sideways (75) is acceptable — CSP selling on stable range-bound stocks is the wheel's native environment.

## Black-Scholes {#black-scholes}

European option price, used wherever a leg must be valued before its own expiry (collared-LEAPS P&L grids; Strategy Lab calendar/diagonal max profit). Implemented in `src/main/services/black-scholes.ts`.

```
d1 = [ ln(S/K) + (r + σ²/2)·T ] / (σ·√T)
d2 = d1 − σ·√T
Call = S·N(d1) − K·e^(−rT)·N(d2)
Put  = K·e^(−rT)·N(−d2) − S·N(−d1)
```

- `S` spot, `K` strike, `T` years to expiry, `σ` IV (fraction), `r` risk-free rate (`RISK_FREE_RATE = 0.05`).
- `N(·)` is the standard normal CDF (Abramowitz & Stegun approximation, error < 7.5e-8).
- `T ≤ 0` (or any degenerate input) returns intrinsic value only.

## Calendar / diagonal (PMCC) max profit {#calendar-diagonal-pnl}

Calendars (same strike, short near + long far) and diagonals (PMCC/PMCP: long far ITM + short near OTM, same side) have **no closed-form max profit** — the long (far) leg still carries time value when the short (near) leg expires. Strategy Lab estimates it at the profit peak, where the underlying pins the **short strike** at the near expiry:

```
remYears      = (farDTE − nearDTE) / 365
longResidual  = bsPrice(shortStrike, longStrike, remYears, longIV, r, isCall)   // per share
shortIntrinsic= max(0, ±(shortStrike − shortStrike)) = 0  at the pin
posValue/sh   = longResidual·longQty − shortIntrinsic·shortQty
maxProfit     = posValue/sh × 100 − netDebit          // close both legs at near expiry
maxLoss       = −netDebit                              // worst case ≈ the debit paid
```

`netDebit = (longMid·longQty − shortMid·shortQty) × 100`. For a calendar the edge is the short leg decaying faster than the long; `maxProfit` is positive when the short premium captured exceeds the long leg's decay over the period. Breakevens are not computed (no closed form). See `buildSetup()` in `strategy-lab-service.ts`. (Net debit/credit are priced at the modeled fill, not mid — see below.)

## Option fill model (slippage) {#fill-model}

Mid is the best case; real fills cross the spread. A leg's modeled execution price is haircut toward the disadvantageous side (`src/main/services/options-fill.ts`):

```
mid        = (bid + ask) / 2
fill_sell  = mid − slip · (ask − bid)/2        // sell below mid, toward the bid
fill_buy   = mid + slip · (ask − bid)/2        // buy above mid, toward the ask
```

- `slip = SLIPPAGE_FRACTION = 0.5` — the fraction of the half-spread given up. `slip=0` → mid (optimistic), `slip=1` → natural price (bid for sells / ask for buys).
- Locked / crossed / degenerate quotes (`ask ≤ bid` or `mid ≤ 0`) fall back to mid. Result is floored at 0.
- Applied to: Strategy Lab `buildSetup` net credit/debit (and thus PMCC/calendar net debit + reward/risk), and wheel/income `premium` in `analysis-service.ts` (which replaced the old flat `mid/2` placeholder). The haircut is largest on wide-spread (illiquid) legs — where mid is least achievable.

## Option liquidity score {#liquidity-score}

Two scores measure tradability; both now weigh same-day **volume** alongside open interest and spread.

**Strategy Lab `liquidityScore` (0–15)** — per leg, averaged across legs:

| Component | Max | Thresholds |
|---|---|---|
| Bid-ask spread (relative `(ask−bid)/mid`) | 8 | ≤5% → 8, ≤15% → 5, else 1 |
| Open interest | 4 | ≥500 → 4, ≥100 → 2.5, else 0.5 |
| Same-day volume | 3 | ≥100 → 3, ≥10 → 1.5, else 0 |

**Wheel `optionLiquidityScore` (0–10)** — on the recommended CSP contract: open interest ≥50 → +4, relative spread ≤5% → +4, volume ≥50 → +2.

Rationale: open interest is *standing* interest; volume is *today's* activity. A high-OI/zero-volume strike (stale interest) is no longer scored as fully liquid, and an actively traded low-OI strike is credited. The brief's hard liquidity gate (drop best relevant structure `< 5/15`) is unchanged.

## Breakout / continuation signals {#breakout-signals}

Inputs to the **Inflection** strategy (a directional credit spread anchored at a breakout level), computed nightly by `DailyTechnicalSignalsJob` and stored on `technical_signals`. A breakout is **fresh** (today crosses, yesterday hadn't) and **with-trend** (continuation, not fade):

```
prior20High = max(high[t−20 … t−1]) ;  prior20Low = min(low[t−20 … t−1])
ATR14       = mean(trueRange) over the last 14 bars
up-break    = close > prior20High AND prevClose ≤ prior20High AND close > SMA50
down-break  = close < prior20Low  AND prevClose ≥ prior20Low  AND close < SMA50

breakout_state         = +1 (up) | −1 (down) | 0 (none)
breakout_level         = prior20High (up) | prior20Low (down)
breakout_decisiveness  = |close − level| / ATR14        (how far beyond, in ATR units)
volume_surge           = volume[t] / mean(volume[t−20 … t−1])
atr_pct                = ATR14 / close × 100             (expected-move / range potential)
```

The strategy ranks top-quintile breakouts by a composite of decisiveness + volume_surge + atr_pct and sells a credit spread with the short strike placed ~0.5–1 ATR beyond `breakout_level` (further OTM), filtered to high IV rank. Validation: top-quintile breakouts let that spread expire OTM ~84–90% of the time; requiring high IV costs ~2% win rate.

## Backtest volatility input {#backtest-iv}

The backtest engine (`backtest-engine.ts`) prices options via Black-Scholes (`#black-scholes`); the volatility input (`sigma`) per simulated day is:

```
sigma = ivAsOf(date)  ?? rollingVol(closes, 20)
ivAsOf(date) = (latest iv_history.atm_iv on/before date) / 100   // % → fraction
rollingVol   = stddev(daily log returns over last 20) × √252,  floored at 0.05
```

Historical ATM IV (`iv_history`) is preferred because premium sellers are paid IV, which typically exceeds realized volatility (the variance risk premium) — pricing off realized vol systematically under-states the premium a CSP/CC/Wheel would have collected. Realized vol is the fallback only on dates with no IV history. The same `sigma` is used for strike selection (target delta), entry premium, and daily mark-to-market of the open position.
