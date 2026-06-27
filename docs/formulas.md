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

How far the underlying can move before a short-premium structure loses — the distance from spot to the **nearest** breakeven. This is **strike-aware**: the breakeven sits at `shortStrike ± credit`, so where the short strikes sit relative to spot matters.

```
creditPerShare = |netCredit| / 100                       (netCredit is per-contract = per-share × 100)
lower breakeven = (nearest short put strike)  − creditPerShare
upper breakeven = (nearest short call strike) + creditPerShare
breakevenDistancePct (%) = min( present sides ) of:
    (price − lowerBE) / price × 100        // downside, if a short put exists
    (upperBE − price) / price × 100        // upside,   if a short call exists
```

**Why not `|netCredit| / price`?** That older proxy is the credit as a percent of spot, which equals the breakeven distance **only for an at-the-money short straddle** (both legs at spot). For a short strangle, iron condor, or an OTM-strike cash-secured put the short strikes sit *away* from spot, so the true breakeven is much farther and `credit/price` badly **understates** it — e.g. a 25%-OTM iron condor reads ~2% on the old proxy but is really ~28%, which made the critic flag structurally-wide condors as "thin breakeven."

Example (ATM short straddle, where old and new agree): credit $8.00/share, spot $100 → BE 92/108 → **8.0%**.
Example (iron condor): short put 80 / short call 120, $3.00/share credit, spot $100 → lower BE 77, upper BE 123 → **23.0%** (old proxy would say 3.0%).

Long wings (the bought legs of a condor/fly) cap loss, not breakeven, so only the **short** legs enter the calculation. Leg `side` (`put`/`call`) is used when present; older data without it infers side from strike-vs-spot.

Implemented as the exported pure `breakevenDistancePct(legs, netCredit, price)` in `critic-service.ts`; used by `synthesizeVerdict()` (the `structure.breakevenDistancePct` field for income) and the `thin_breakeven` rule (income/wheel).

### expected-move

The expected **1-sigma move** of the underlying over the hold — how far it is expected to move (≈68% probability band) by expiry, from its annualized at-the-money implied volatility.

```
expectedMove1SigmaPct ($%) = impliedVolPct × √(DTE / 365)
expectedMove1SigmaUsd ($)  = price × expectedMove1SigmaPct / 100
```

`impliedVolPct` is the annualized ATM IV as a **percentage** (e.g. 70.3 = 70.3%); DTE is calendar days; `√(DTE/365)` scales annual vol to the hold. Example (AMD, 2026-06-16): IV 70.271%, 31 DTE, spot $507.29 → `70.271 × √(31/365)` = **20.5%** → `507.29 × 0.205` = **±$104**.

This is **precomputed** and passed to the Daily-Brief critic in `volatility.expectedMove1SigmaPct` / `expectedMove1SigmaUsd`, with the prompt instructing the LLM to cite the provided numbers and **not** compute the move itself — its manual arithmetic routinely overstated it (AMD wheel "±$149 (~29%)" vs the true ±$104/20.5%; MRVL bullish "~$152" vs ±$82/29.5%), the same class of error as the IV fabrication the volatility context already eliminated. Implemented as the exported pure `expectedOneSigmaMove(impliedVolPct, dte, price)` in `critic-service.ts`; returns nulls (→ the prompt skips expected-move reasoning) when IV is missing or DTE ≤ 0.

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
ADX = Wilder_smoothing(DX, n)            // a running AVERAGE of DX → bounded [0, 100]
```

Trend confirmed: ADX > 20 AND appropriate price/SMA relationship.
Implemented in `computeADX()` in `analysis-service.ts` and `daily-technical-signals-job.ts`.

**Bounded [0, 100] (v1.1.x fix).** The final step is the Wilder *average* of DX, not the sum. `analysis-service.computeADX` reused the Wilder running-SUM helper (correct for the +DI/−DI ratios, where the sums cancel) for the ADX step too, omitting the `÷ period` — so ADX came out ≈ `period`× too large (AMD ~648 vs the true ~46), saturating the trend signals. Fixed by dividing the smoothed DX by `period` (`smoothDX/period` is the exact Wilder ADX recursion).

**ADX is NOT used in the composite scoring (FR-SEY-5).** A full-year Brief-Replay A/B (corrected ADX vs ADX-absent) showed feeding ADX into scoring is net-negative — bullish −1.50pp, bearish −1.15pp, income −0.43pp on direction-aware forward returns (high-ADX names mean-revert over ~21d). So `ScoringService.USE_ADX_IN_SCORING = false`: `trendStrength`/`downtrendScore` use only their MA-stack component and income's `trendNeutral` goes missing. The corrected ADX is retained for **display** (Validate dashboard, Analysis view) only. Re-validate on `tests/adx-replay-validation.test.ts` (`REPLAY_WITH_ADX`) before re-enabling.

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

### atm-iv

Single-expiration ATM implied vol — the **average IV of the call and the put at the strike closest to spot** (plus any duplicate contracts at that strike):

```
atmStrike = strike (among contracts with IV > 0) minimising |strike − underlyingPx|
ATM_IV    = mean( IV of every contract at atmStrike )
```

Averaging both sides captures put/call skew. Implemented once as the pure `atmIvAtClosestStrike(items, underlyingPx)` in `src/main/services/iv-utils.ts` (units pass through unchanged — decimal in → decimal out; callers ×100 for percentage storage), and shared by:

- **`strategy-lab-service.computeAtmIv`** → the brief/critic `context.currentAtmIv`, for the lab's chosen ~30-DTE expiration.
- **`etrade-data-provider.getOptionsIVAndPremium`** → `quote_cache.current_iv` and the options-chain / dashboard / screener surfaces, for the **nearest** expiration (with a median-IV fallback when no strike has a usable IV).

Both now share this one definition; before v1.1.32 the E*Trade path used the closest **call only**, so the same expiration could read differently from the lab's call+put average.

**Tenor matters — two correct ATM-IVs can legitimately differ.** The lab/brief measures the ~30-DTE expiration it actually trades; the provider's chain-view value measures the *nearest* expiration. On a sharp move these diverge (short-dated IV spikes hardest) — e.g. AMD on 2026-06-16 (−7.3% day): ~70% at 30 DTE vs ~82% at the nearest weekly. The brief uses only the horizon-matched 30-DTE value; `quote_cache.current_iv` is for the live chain view and never feeds a trade decision. The 30-day constant-maturity figure for `iv_history` is a separate, interpolated measure — see below.

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

## Single-expiration structure P&L {#structure-pnl}

`classifySingleExpiryPnl(legs, dollarCredit, netCreditPerShare)` (in `strategy-lab-service.ts`) returns `maxProfit` / `maxLoss` / `breakevens` for a single-expiration structure by evaluating its **actual expiry payoff** (v1.1.28 — replaced the earlier leg-signature classifier, which mis-priced long/debit verticals and broken-wing butterflies).

Per-share P&L at an underlying expiry price `S`:
```
pnl(S) = netCreditPerShare + Σ_legs  dir(leg) · qty(leg) · intrinsic(leg, S)
         dir   = +1 long (buy), −1 short (sell)
         intrinsic(call) = max(S − strike, 0)
         intrinsic(put)  = max(strike − S, 0)
```
The payoff is piecewise-linear with kinks only at the strikes, so it is sampled at `xs = {0, …each strike…, sFar}` (`sFar` = last strike·3 + 1000, safely into the linear tail):
```
maxProfit = 100 · max(pnl(x) for x in xs)      (null if net-long calls → unbounded upside)
maxLoss   = 100 · min(pnl(x) for x in xs)      (null if net-short calls → unbounded loss)
breakevens = zero-crossings of pnl, linearly interpolated between adjacent kinks
```
**Unbounded detection (→ `null`)** is driven by net call exposure as `S→∞`, `callSlope = Σ dir·qty` over call legs: `< 0` ⇒ unbounded loss (net-short calls — naked call, strangle, reverse lizard); `> 0` ⇒ unbounded profit (net-long calls — long call, zebra). **Puts are always bounded** because `S ≥ 0`. `dollarCredit = netCreditPerShare · 100`.

This prices every single-expiration structure from first principles — verticals in *both* orientations (a long/debit vertical's max profit = `width − debit`, not a wrong-sign negative), balanced **and broken-wing** butterflies (whose true max loss is the wing imbalance, not just the debit), condors, lizards, and ratio/zebra structures — and recovers breakevens the old classifier dropped (e.g. a big lizard's upper breakeven). `annualizedReturn` (computed in `buildSetup`) is `null` whenever `maxLoss` is `null` (capital undefined). The calendar/PMCC diagonal P&L uses a separate Black-Scholes branch (below), not this function.

History: before v1.1.24 the reverse lizards reported the bounded put-spread residual as max loss (FLUT −$11), hiding the naked call's unlimited risk and yielding ~100,000% annualized returns. Before v1.1.28, long/debit verticals showed a negative max profit and broken-wing butterflies understated max loss ~5–30× (ARE −$8.75 vs −$258.75). The payoff evaluator fixes the whole class.

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

## Risk-budget spread width {#budget-width}

For v2 execution, a short vertical's hedge (long) leg can be sized to a **per-trade risk budget** instead of a fixed delta, so the spread is sizeable on a small account. The default delta legs (sell 0.30Δ, buy 0.15Δ) produce an uncontrolled width — $60 wide on a high-priced/high-IV name (e.g. AMAT 580/520), whose ~$4,400 max loss can't be sized into a $500 budget (5% of $10k) → the risk gate rejects it.

When `exec_config.budget_width_enabled = 1`, the brief passes the per-trade budget `B = (max_risk_per_trade_pct / 100) × capital_ceiling` to the lab, and `findBudgetWidthHedge()` selects the **widest** long strike whose per-contract max loss still fits `B`:

```
maxLoss(L) = (|S − L|) × 100 − (shortMid − longMid(L)) × 100   // monotonically ↑ with width
choose L* = argmax |S − L|   s.t.  maxLoss(L) ≤ B   and   |S − L| ≤ maxWidth
```

The hedge is further OTM than the short (puts below S, calls above). Returns null — structure `unavailable` ("No spread within the per-trade risk budget") — when even the nearest one-strike spread exceeds `B`; skipping is correct (better than an un-sizeable pick). Wider spreads collect more credit and carry better reward/risk, so taking the widest within budget is preferred. Default off pending FR-SEY-5 validation. See `findBudgetWidthHedge` / `buildSetup` in `strategy-lab-service.ts`.

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

## Wheel structure label (CSP vs CC) {#wheel-structure-label}

The wheel analysis (`findSuitableChain`) recommends a **cash-secured put** when a put exists in the 0.20–0.30 delta band with a live bid; if none does, it **falls back to a covered call** in the same band. Both are valid wheel legs. `WheelResult` doesn't carry the contract's put/call side, so when recording the recommendation into `options_premium_history`, the structure is derived from **delta sign**: a put has delta ≤ 0 → `CSP`; a call has delta > 0 → `CC`. Sign is robust because it's fixed by option type, not the spot level — so it survives E*Trade's stale-greek drift (which only skews magnitude). `findSuitableChain` guarantees a non-null delta on any real recommendation; a null delta defaults to `CSP`. Without this, covered-call fallbacks (~12% of daily wheel picks, concentrated in lower-priced names where the coarse strike grid has no put in the tight band) were mislabeled `CSP`, which would corrupt future CSP-vs-CC return-on-capital analysis.

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

## structure-mark

Mark-to-market P&L of a brief pick's actual option structure (CSP / credit spread / iron condor),
used by the paper-tracking layer (`structure-mark.ts`) to score brief performance on the real
options outcome rather than the underlying's direction. Both ends are Black-Scholes-priced at the
**entry IV** (historical per-strike IV isn't available), so the result isolates the underlying
move + theta; per-leg expiry is honored (PMCC/calendar):

```
T_leg(d)      = max(0, daysBetween(d, leg.expiration)) / 365
legValue(S,d) = bsPrice(S, leg.strike, T_leg(d), leg.iv/100, r=0.04, leg.side==='call')
P&L_leg       = (leg.action==='buy' ? +1 : -1) × (legValue(S_now, asOf) − legValue(S_entry, entry)) × qty × 100
structurePnl  = Σ P&L_leg                      // sold leg profits when its value falls
structureReturnPct = structurePnl / |entryPremium| × 100   // % of entry credit/debit captured
```

Day-0 (asOf == entry, same price) is exactly 0. A closed trade's `outcome` derives from the sign
of `structurePnl` (win > +$5, loss < −$5, else breakeven), falling back to the stock-direction
proxy only when legs can't be priced. `stock_return_pct` is retained for reference.

## structure-settle (hold-to-expiry intrinsic) {#structure-settle}

Realized P&L of a structure held to expiry, settled at **intrinsic** value — no IV / time-value
assumptions (at expiry an option is worth exactly its intrinsic). Used by the lizard-vs-spread
validation harness (`src/shared/structure-settle.ts`, `scripts/backtest-lizard-vs-spread.mjs`):

```
intrinsic(leg, S) = leg.side==='call' ? max(0, S − strike) : max(0, strike − S)
P&L_leg           = (leg.action==='buy' ? +1 : −1) × (intrinsic(leg, S) − leg.mid) × qty
settlePnl         = Σ P&L_leg × 100        // S = close on the last trading day ≤ expiration
```

Entry prices are leg mids (no slippage haircut, consistent with the backtest engine).

## pop-weighted-premium (EXPERIMENTAL, disabled) {#pop-weighted-premium}

Alternative Strategy-Lab `premiumScore` for short-premium structures, gated behind
`USE_POP_WEIGHTED_PREMIUM` (**default false**). The shipped score saturates — any structure
returning ≥1.5%/30d on capital gets the full 25 pts — so a Big Lizard (return-on-risk ~16%, PoP
~52%, a coin-flip ATM range trade) ties a bull put spread (~30% return-on-risk, PoP ~71%). This
term re-grades by graduated capital-efficiency × probability-of-profit:

```
eff   = clamp(ret30dPct / 3.0, 0, 1)                 // capital-efficiency ramp (0 → full at 3%/30d)
popF  = popEstimate==null ? 0.7 : clamp((popEstimate − 40) / 35, 0.3, 1)   // PoP weight (52%→0.36, 71%→0.87)
premiumScore = round(25 × eff × popF)                // ∈ [0,25], preserves grade calibration
```

Constants are **provisional** — disabled pending an FR-SEY-5 realized-P&L backtest delta
(`scripts/backtest-lizard-vs-spread.mjs`; the bullish sample doesn't settle until Jul 2026). See
`Requirements/v2-execution/06-seykota-risk-extensions.md`.

## gap-risk (display-only) {#gap-risk}

Downside overnight gap risk relative to what implied volatility is pricing. Surfaced on the
Validate dashboard as a context metric — **not** a trade gate (see the FR-SEY-6 finding in
`Requirements/NEW_FRONTIER.md §9`). Computed in `src/shared/gap-risk.ts` (`computeGapRisk`).

```
gap_t          = (open_t − close_{t-1}) / close_{t-1}     // overnight gap, daily bars
adverseGapP95  = P95 of |gap_t| over downside gaps (gap_t < 0), trailing ~252 trading days
ivDailyMove    = atmIv / √252                              // IV-implied 1-day move (atmIv as %)
gapRiskScore   = adverseGapP95 / ivDailyMove
```

`score > 1` ⇒ the name's realized downside-gap tail is fatter than IV implies (historically
under-compensated by premium for jump risk — relevant to owning the stock or selling CSPs).
P95 (not the max) keeps it robust to a single outlier and naturally mostly ex-earnings (the few
earnings gaps/yr sit above P95). `atmIv` is the latest stored `iv_history.atm_iv` (a percentage),
falling back to the live ATM IV; needs ≥60 bars and ≥10 downside-gap observations or returns null.
