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

**Wheel `optionLiquidityScore` (0–10 | null)** — on the recommended CSP contract: open interest ≥50 → +4, relative spread ≤5% → +4, volume ≥50 → +2. Computed by the pure `wheelOptionLiquidityScore()` (`analysis-service.ts`).

> **These binary thresholds are miscalibrated and are the binding constraint on this signal.** The **`spread ≤5%` gate is effectively unreachable**: a 5% *relative* bid-ask on a 25-delta put is institutional-grade tight, so it almost never fires — **WMT with open interest 13,824 and a 5.2% spread still scores 4/10**, missing by 0.2pp. `volume ≥50` on a *single strike* rarely fires either (and accrues through the session, so it reads lower in the morning). The OI component alone carries the score, which sits at a near-constant 0 or 4 rather than discriminating.

**Graded alternative — `WHEEL_GRADED_LIQUIDITY` (`analysis-service.ts`, default off, `WHEEL_GRADED_LIQUIDITY=1` to force on, v1.1.131).** Continuous, no cliffs:

```
spread pts (max 4) = 4 × clamp01(1 − (spread% − 5) / 35)     // 5% → 4, 40% → 0; 0 when there is no bid
OI     pts (max 4) = 4 × clamp01(log10(max(OI, 1)) / 3.3)     // saturates ≈ 2,000 contracts
volume pts (max 2) = 2 × clamp01(log10(max(vol, 1)) / 2)      // saturates ≈ 100 contracts
```

Calibrated by `scripts/fr-wheel-liquidity-calibration.mjs` on **1,278 real short-put quotes** (0.20–0.30 delta) pulled from stored `daily_briefs` structures — all captured during market hours. Ground truth is what the contract actually costs to trade under the fill model above: `0.5 × half-spread` as a share of the credit collected. Panel medians: OI 74, spread **16.9%**, volume 6, entry cost 4.4% of credit.

| scheme | distinct values | % scoring 0 | entropy | Spearman(score, cost%) |
|---|---|---|---|---|
| legacy (binary gates) | 6 | 38% | 0.75 | −0.419 |
| **graded (continuous)** | **21** | 2% | **0.97** | **−0.799** |

The legacy scheme scores KO — spread 13.9%, volume 39, real entry cost 3.6% of credit — a flat **0.0/10**. *Caveat: `cost%` is derived from the spread, so a scheme that grades spread will always correlate better than one that gates it. Read the Spearman column as "graded beats binary on the component it measures", not as proof the OI and volume weights are right — those price exit optionality and depth, which a single-contract entry-cost measure cannot see.* The graded branch also fixes a latent bug the legacy one keeps: a **no-bid** quote (`bid = 0`) falls into the degenerate-quote path and is handed *full* spread credit, when no bid is the worst liquidity there is (unreachable via `findSuitableChain`, which filters `bid > 0`).

**Enabling it for composite scoring was validated and REJECTED (v1.1.133).** Replayed over 6,777 settled income CSPs, the graded scheme made realized outcomes *worse* (top-5/date −2.92% → −4.80% mean return on capital, Δ −1.88 pts/trade), and `optionLiquidity` turns out to have **no predictive relation to outcome at all** (Spearman −0.015 legacy / +0.032 graded). High-liquidity names carry higher realized vol (55% vs 43%), so liquidity tracks names that move — bad for short premium. The calibration above is still correct on its own terms: this is a better **execution-cost** model and a worse **ranking** signal, because liquidity answers *can I trade this*, not *should I*. It belongs as a gate — which is how `EntryPolicy` uses it (`liquidityScore ≥ 8`) — so the formula and flag are kept for that role. Independent of `WHEEL_MONTHLY_FIRST_EXPIRY`, which changes *which* contract is recommended (a real fill-cost saving) rather than how candidates are ranked.

**Which contract is measured matters more than the formula.** `findSuitableChain` walks expirations in ascending date order and returns the **first** delta-band match, so the earliest qualifying expiry — structurally a **weekly** — always wins, and the `[30,45]` DTE window is narrower than the ~30-day monthly cycle so a 3rd Friday is frequently out of range entirely. At the same ~25 delta a weekly carries 1–2 orders of magnitude less open interest than the monthly (2026-08-05, Sep-4 weekly vs Sep-18 monthly: PG **7 vs 4,063**, V 15 vs 802, DIS 56 vs 2,982, WMT 109 vs 13,824, AAPL 450 vs 7,668). The score therefore measures a contract nobody would wheel and charges the **ticker** for it — 94% of a full-universe snapshot reads 0/10 and the signal cannot separate WMT from a microcap. `WHEEL_MONTHLY_FIRST_EXPIRY` (`analysis-service.ts`, **default off**, `WHEEL_MONTHLY_FIRST=1` to force on) tries 3rd Fridays first and widens the window to `[28,52]`; it is FR-SEY-5-gated because it changes the recommended CSP itself, and therefore `premiumYield` too. Note `[28,52]` does **not** guarantee a monthly is in range — consecutive 3rd Fridays are 28–35 days apart, so a guarantee needs a ~35-day-wide window and a 63-DTE CSP is outside the wheel's tenor; coverage goes ~53% → ~82% of days, weekly fallback on the rest.

**`null` ≠ 0.** The score is `null` when there is **no contract to measure** — `findSuitableChain` resolved nothing in the 30–45 DTE / 0.20–0.30 delta window, or price history was insufficient. A `0` is the stronger claim "measured, and illiquid". The distinction is the common case, not an edge case: on a full-universe snapshot (2026-08-03) **695 of 1,029 rows resolved no chain**. Collapsing those to 0 also made the wheel explanation assert *"Low option liquidity."* about tickers whose liquidity was never looked at. Note that under the scoring engine's current FR-SE-03 arithmetic a missing signal and a measured 0 contribute identically to the composite (0 to the numerator, full weight to the denominator) — so this distinction is currently about **data honesty**, surfaced via the `missing` flag, stored snapshots and the Analysis view, not about score movement.

Rationale: open interest is *standing* interest; volume is *today's* activity. A high-OI/zero-volume strike (stale interest) is no longer scored as fully liquid, and an actively traded low-OI strike is credited. The brief's hard liquidity gate (drop best relevant structure `< 5/15`) is unchanged.

> **The 0–15 score is not comparable between the day's two batch runs — and the dice's gate is 8/15, not 5/15.** Same-day volume is a *cumulative* counter: at the ~10:15 ET slot it holds about an hour of tape, at the ~17:00 ET slot the whole session. It is monotonic within a day, so the morning run scores systematically lower on up to 3 of the 15 points, on an identical contract. Measured 2026-09-04: DINO read **9/15 in the evening run and 6/15 the next morning** — `OI 112→2.5, vol 27→1.5, spread 7.2%→5 = 9` against `OI 77→0.5, vol 0→0, spread 9.2%→5 = 5.5→6` — while the **spread, 8 of the 15 points and the only component that sets fill cost, did not move a point**. The other two are step functions, and the ≥8 gate (`MIN_TRADABLE_LIQUIDITY_SCORE`, inherited from the v2 engine's tradability bar) sits in the densest part of the distribution: across 250 stored wheel picks the mode is **exactly 7**, one below the gate, and **93 (37%) would flip to passing on the volume component alone** while **78 (31%) have a tradable ≤15% spread and are rejected as illiquid anyway**. Note the component was introduced (v0.32.97) against the brief's **5**/15 gate with the stated expectation that it would "rescue or penalize at the margin"; at 8/15 it is not marginal. Also `leg.volume ?? 0` scores an unreported volume identically to a genuine zero (23 of 250 stored legs). **Nothing here is yet a reason to change the gate** — that is FR-SEY-5 territory and needs a replay. `brief_candidates` keeps both phases from v1.1.185 so the drift is measurable at all; `scripts/slot-liquidity-drift-study.mjs`.

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

## level2-debit-vertical (display-only) {#level2-debit-vertical}

The IBKR-Level-2-tradeable (debit) vertical the Daily Brief surfaces alongside a bullish/bearish
pick — a **long call spread** (bullish) or **long put spread** (bearish), narrowed at
brief-generation time to a small max-risk budget so a Level-2 account can place a small,
defined-risk directional trade (e.g. to build options history toward Level 3). Built in
`src/main/services/level2-debit-vertical.ts` (`buildNarrowDebitVertical`) from the same live chain
the lab already fetched. **Display-only** — no scoring/engine impact (no FR-SEY-5 gate).

```
long  = the same-side strike closest to spot (ATM)                       // priced at chain mid
short = the widest OTM strike (above for calls, below for puts) whose     //  → maximizes profit
        debit = mid(long) − mid(short) keeps  debit × 100 ≤ targetRisk    //     under the cap
targetRisk  = $750 (DEFAULT_TARGET_MAX_RISK)
debit       = mid(long) − mid(short)                       // per share (positive = you pay)
maxRisk     = debit × 100                                  // total $ at risk
maxProfit   = (|short − long| − debit) × 100
breakeven   = call: long + debit ;  put: long − debit
moveToBE%   = (breakeven − spot) / spot × 100              // signed: + needs up, − needs down
```

A leg with no usable bid/ask is priced by Black-Scholes from its chain IV (`bsPrice`). When even
the narrowest spread exceeds `targetRisk`, the narrowest is surfaced with `exceededBudget=true`
(so a small account sees — and can skip — the trade rather than getting no chip). The chip shows
**breakeven + move-to-profit, NOT a PoP**: the lab's `popEstimate` is short-strike (credit-spread)
semantics and would badly overstate a debit spread's true probability of profit.

## Roll analyzer

`src/main/services/roll-analyzer-service.ts` — exit-side analysis for a single short option
(cash-secured put or covered call). All marks are bid/ask midpoints; credit-rolls only.

- **Close-now P&L** = `openCredit − closeCost`, where `openCredit = entryCredit × 100 × contracts`
  and `closeCost = markToClose × 100 × contracts` (buy-to-close the current short at its mid).
- **% of max profit** = `unrealizedPnl / openCredit` (how much of the credit is already banked).
- **Breakeven (current)** = put: `strike − entryCredit`; call: `strike + entryCredit`.
- **Assignment probability** ≈ `|delta|` of the short leg.
- **Roll net credit / sh** = `sellToOpenMid(new) − buyToCloseMid(current)`; only candidates > 0 are kept.
- **Capital / sh** = put: new `strike`; call: `underlyingPrice`. **Capital at risk** = `capital/sh × 100 × contracts`.
- **Annualized ROC** = `(netCredit/sh ÷ capital/sh) ÷ addedDte × 365`, where `addedDte = dte(new) − dte(current)` (≥ 1).
- **Capital efficiency** = `netCredit/sh ÷ capital/sh` (credit per $ committed; not annualized — favors rolling down).
- **Risk-adjusted score** = `annualizedRoc × (1 − assignmentProbability)`.
- **New breakeven** (after roll) folds the roll credit into the cumulative basis: cumulative credit
  = `entryCredit + netCredit/sh`; breakeven = put: `newStrike − cumulative`; call: `newStrike + cumulative`.

The four metrics are user-selectable on the screen; ranking is pure (`scoreByMetric`) so switching
the metric re-ranks client-side without re-fetching chains.

### rollability {#rollability}

Bec's check (`docs/Bec/STRATEGY-SUMMARY.md` §6b, §9.1): given what it costs to buy back the short,
how far out does a credit roll have to go before the strike reaches safety? `computeRollability`
in `roll-analyzer-service.ts`. Reporting only — it ranks and gates nothing.

- **Target** — covered call: the stock **cost basis** when given (called away without a loss), else
  the underlying price; short put: the **underlying price** (strike at or below spot).
- **At target** — put: `strike ≤ target`; call: `strike ≥ target`.
- **Horizons** — the listed expiry nearest each of **+7, +14, +30, +60, +90, +180, +365 days** beyond
  the current expiry (deduplicated).
- **Best strike per horizon** — the most-improved strike (put: lowest; call: highest) of the same
  type with a two-sided quote and `mid(bid, ask) − buyToCloseMid > 0` (a net credit). A worse
  strike never counts as a repair. **Strikes gained** = listed strikes of that type strictly
  improved up to and including the best one.
- **Weeks to target** = `addedDte ÷ 7` (1 d.p.) at the first horizon whose best strike reaches the
  target; `0` when already at target; `null` when none does.
- **Verdict** — `easy` ≤ 4 weeks, `workable` ≤ 13 weeks, `trap` beyond that **or** not reached
  while horizons out to ≥ 180 added days were priced; `unknown` when there is no target or the
  listing does not extend that far. Bands are working values from "if the answer is a year, the
  trade is a trap" — not validated.

Far-dated chains fetched for this feed only rollability; the candidate table still ranks the next
6 expiries, unchanged.

## Wheel shortlist {#wheel-shortlist}

`src/main/services/wheel-shortlist.ts` — interim, advisory (NewApp `07-opportunity-engine.md` §3).
Operator profile: short put **0.35 ≤ |delta| ≤ 0.45**, **14 ≤ DTE ≤ 30**, top 5, no capital cap.

- **Pool** — the latest brief run's `brief_candidates` for `wheel` and `income` with disposition
  `picked` or `capped_out`, deduped by ticker. The composite rank is not used.
- **Exclusions** — critic verdict `flag` (where a verdict exists); earnings date unknown, stale
  (`report_date < today`), or on/before every in-window expiry; no qualifying two-sided put.
- **Contract** — among expiries before the next report: the put with the highest
  **premium ROC (annualized) = `mid ÷ strike × 365 ÷ DTE × 100`**, `mid = (bid + ask) ÷ 2`.
- **Ranking** — premium ROC descending; keep 5.
- **Assignment probability** ≈ `|delta| × 100`. **Credit** = `mid × 100`; **cash required** = `strike × 100`.
- **Spread %** = `(ask − bid) ÷ mid × 100`.
- **Roll room** (D3 at today's prices) — roll expiry = the nearest listed expiry **7–30 days after**
  the chosen one; roll strike = the **lowest** put strike ≤ the chosen strike with `mid ≥ chosen mid`
  (a net credit). `dollarsLower = chosenStrike − rollStrike`; `strikesLower` = listed put strikes in
  `[rollStrike, chosenStrike)`. A proxy: at a real roll the put is in the money and costs more to buy back.
- **Own-at-strike** — the existing read with cost basis `strike − mid` (`docs/formulas.md#own-at-strike`).

## Bull put spread mode {#bull-put-spread-mode}

`src/main/services/spread-mode.ts` — shadow (NewApp `08-bull-put-spread-mode.md`). Per share unless noted.

- **Expiry** — among captured expiries with **21 ≤ DTE ≤ 35** and `expiration < next report date` (no report date for an ETF): minimise
  `|DTE − 30|`, earlier on a tie.
- **Short leg** — two-sided (`bid > 0`, `ask ≥ bid`), **0.20 ≤ |Δ| ≤ 0.40**, minimise `||Δ| − 0.30|`, lower strike on a tie (v1.1.292; was 0.25–0.35).
- **Long leg** — two-sided, `strike < short strike`, **0.03 ≤ (short − long) ÷ spot ≤ 0.10** (v1.1.292; was 0.05–0.075), minimise
  `|long − (short − 0.05 × spot)|`.
- **Fills** — `docs/formulas.md#fill-model`: short = `fillPrice(bid, ask, 'sell')`, long = `fillPrice(bid, ask, 'buy')`.
- **Mid credit** = `short mid − long mid`; **net credit** = `short fill − long fill`.
- **Round-trip cost share** = `2 × [(short mid − short fill) + (long fill − long mid)] ÷ mid credit`. Excluded if `> 0.25`.
- **Width** = `short − long`; **max loss** = `width − net credit`; **return on risk** = `net credit ÷ max loss`;
  **breakeven** = `short − net credit`; **take-profit debit** = `0.5 × net credit`.
- **Contracts** = `floor(maxLossPerPosition ÷ (max loss × 100))`; excluded if `< 1`. `maxLossPerPosition`,
  `maxOpenPositions` and `maxOpenPerSector` are operator settings (Settings → Strategies, v1.1.296), clamped by
  `writeSpreadModeSettings`; the sector cap is never stored above the position cap. **Total max loss** = `contracts × max loss × 100`.
- **Ranking** — return on risk descending, ties by ticker; keep 5. Unvalidated.

**Capture quality** (`spread-capture-quality.ts`, v1.1.297). Over the same captures, warnings only:
- **SC-1** — no capture for ≥ 4 days while positions are open (or none ever).
- **SC-2** — a live position has no row on a date the capture ran for other series; `missingMarks` counts them.
- **SC-3** — `gaps ÷ (marks + gaps) > 5%`, a capture present but missing one of the two legs.
- **SC-4** — an open position's four quote numbers identical across the last 3 captures.

**Shadow settlement** (`spread-mode-settle.ts`, v1.1.290 — the 08 §4.2 gate). Recomputed on every read, never stored.
- **Marks** — `spread_chain_capture` rows of the same ticker + expiry strictly after the entry (date, then
  intraday < after_close), up to expiry. A leg is usable when `ask > 0` and `0 ≤ bid ≤ ask`; a mark missing
  either leg is a *gap*.
- **Target** — the first mark with `short mid − long mid ≤ 0.5 × net credit` (decided on mid). Exit debit =
  `fillPrice(short, 'buy') − fillPrice(long, 'sell')` (realised with fills).
- **Expiry** — no target: exit debit = `max(0, short − S) − max(0, long − S)`, S = close on the expiry date (or
  the last session ≤ 4 days before it); no closing cost. Settled only after the expiry date; not settled when
  `S ÷ entry spot` is outside [0.5, 2] (possible split — listed, not dropped).
- **Return on max loss** = `(net credit − exit debit) ÷ max loss`.
- **Positions** — a pick of a ticker within **14 calendar days** of that ticker's last kept entry is a repeat of it,
  whatever its strikes or expiry (the #43 study's episode rule, v1.1.291); the first entry is kept.
  The gate counts positions: ≥ 15 intraday capture days, ≥ 30 settled positions, mean return on max loss > 0.
- **Sector cap** (`simulateSectorCap`, v1.1.294, 08 S9) — walk positions in entry order (date, slot, rank, id); a
  position is skipped when **3** kept positions of its `constituents.sector` are open on its entry date (open =
  no exit yet, or exit date after the entry date). Skipped positions never occupy a slot; an unknown sector is
  its own bucket. The report shows the full and the capped book side by side; shadow picks are not capped.

## split-adjustment (data integrity) {#split-adjustment}

`historical_prices` must hold a **self-consistent, split-adjusted** close series: every bar
expressed in today's share terms. Polygon aggregates are fetched with `adjusted=true`, so
each response is correct *as of that fetch* — but bars are stored incrementally and old
ones are never revisited (price-gap-fill re-fetches only a ~3-day window). When a split
occurs later, pre-split bars keep their old prices while new bars arrive post-split,
leaving a permanent step in the middle of the series.

**Detection** (`split-repair.ts`, v1.1.139) — for consecutive stored closes:

```
ratio = close[i] / close[i-1]
flagged  ⇔  |ratio − 1| > SPLIT_THRESHOLD          (default 0.25)
```

A split shows as a ratio near a simple fraction: `0.5` = 2:1, `0.25` = 4:1, `2/3` = 3:2,
`2.0` = 1:2 reverse, `3.0` = 1:3 reverse.

**Repair** — re-fetch the ticker's whole stored range (bounded to 800 days) and
`INSERT OR REPLACE`. Polygon returns the series adjusted to today, so one pass corrects
every bar. The operation is **idempotent**: re-fetching a ticker that did not split
rewrites identical bars, so a false positive costs one API call and changes nothing.

**Classification** — a jump that survives the re-fetch is treated as a genuine market move
(earnings collapse, buyout) and recorded in `price_split_repairs` as `confirmed_real`.
That verdict **expires after `CONFIRMED_REAL_TTL_DAYS` (30)** and the discontinuity is then
re-verified (v1.1.140): providers backfill corporate actions late, so a split absent from
the adjusted series today can appear next week, and a permanent verdict would hide it
forever. Threshold choice is asymmetric on purpose: a false positive is cheap (one call),
a false negative silently corrupts every indicator spanning that date.

**Split-ratio labelling** (`nearestSplitRatio`, descriptive only — never drives a repair):
matched with `SPLIT_RATIO_TOLERANCE` = ±8%. The tolerance is wide **by necessity** — a split
day also carries that day's real price move, so the observed ratio is never exact (CRWD's
genuine 4:1 printed at 0.2649 vs 0.25, because the stock rose 6% that session). False labels
are therefore controlled by the candidate *set*, not a narrower band: 3:2 (−33%) was removed
in v1.1.140 because it overlaps ordinary one-day crashes, leaving only ratios implying a
move ≥ 46%.

**Why it matters** — unadjusted splits corrupt SMA/RSI/ADX, `volume_surge`, breakout
detection, relative strength, the backtest engine, and Brief Replay, which FR-SEY-5 relies
on to validate trade-logic changes. Measured 2026-08-28: CRWD −74% in one day (4:1),
DD +203%, MRNA +177%, HON +95%, KLAC −89%, against SPY's largest genuine daily move of
2.58% over the same quarter.

## ticker-reuse detection (data integrity) {#ticker-reuse}

A symbol reassigned to a different company (rename, reverse merger, de-SPAC, delisting then
reuse) splices two unrelated entities into one series. Unlike an unadjusted split this is
**not repairable by re-fetching** — the provider keys by ticker too.

The discriminator is the **volume regime**, not price. Over `REGIME_WINDOW_BARS` (20) either
side of the discontinuity, skipping `REGIME_BUFFER_BARS` (3) so the event-day spike is
excluded:

```
volumeRegimeRatio = median(volume after) / median(volume before)
ticker reuse  <=>  ratio >= 15  or  ratio <= 1/15
```

Rationale: a split rescales share count and settles; a news event spikes volume then decays
back toward its old level; only a different company shifts the regime permanently.
Calibrated 2026-09-01 — reuse: BNY 76x, SPCX 53,592x; genuine moves: MRNA 5.0x, PRIM 2.7x,
FMC 2.6x, CORT 2.0x, KD 2.0x, CAR 0.4x.

**Intraday range is a second, independent check**: a split day's OHLC are all already in the
new scale, so its range is normal (~2-5%). MRNA's 35.7% range on its +177% day is what
confirms a real repricing rather than an unadjusted reverse split.

**The action is truncation** — bars before the splice are deleted from `historical_prices`
and `iv_history`, so every consumer sees only the current entity without any consumer-side
change. `iv_history` is included because IV rank reads a 252-day window.

## roll-the-dice (selection filter) {#roll-the-dice}

One wheel entry from the latest brief, or nothing. Not a score — a chain of HARD gates over
picks the brief has already scored and ranked. This layer only removes.

**The gates judge the TRADE, never the OPERATOR (v1.1.168).** Two different kinds of "no" were
originally mixed here: trade-quality gates (facts about the setup) and operator-fit gates (facts
about the operator — the capital ceiling and conviction-list membership). The second kind was
deleting candidates exactly as if they were quality failures. Fit is now computed, reported, and
excludes nothing.

```
eligible(pick) =                               # trade quality ONLY
      criticVerdict.verdict == 'pass'          # caution and flag both fail
  AND criticVerdict.degraded != true           # un-vetted is not an all-clear
  AND price != null                            # needed for the cost-basis maths
  AND exists CSP (slug 'short-naked-put', setup constructible)
  AND liquidityScore >= MIN_TRADABLE_LIQUIDITY_SCORE   # = 8
  AND earnings_calendar HAS the ticker         # absent = unknown = fail closed
  AND earningsDate >= today                    # a PAST stored date is stale, not "clear"
  AND earningsDate  > expiration               # no report inside the hold window
  AND netCredit > 0

pick         = argmax(compositeScore) over eligible, else NOTHING
withinBudget = argmax(compositeScore) over {eligible : capital <= maxCapital}
               ONLY when pick itself exceeds maxCapital; else null
```

Derived on the winner:

```
capitalRequired     = strike × 100 × qty                  # cash-secured
effectiveCostBasis  = strike − premiumPerShare
discountToSpotPct   = (price − effectiveCostBasis) / price × 100
```

### Fit — reported, never a filter (v1.1.168)

```
fit.withinCapital          = capital <= maxCapital        # capital = strike x 100 x qty
fit.maxCapital             = maxCapital                   # default $30,000
fit.conviction             = null  if ticker not on the conviction list
                             else { priceHigh, strikeWithinBand: strike <= priceHigh }
```

Capital is measured, not share price, because the strike sits below spot: a $306 stock struck at
$285 commits $28,500 while a $299 stock struck at $295 commits $29,500 — the cheaper-looking stock
costs more. But the number is now a **budget line, not a ceiling**. It splits the report rather
than trimming the field: when the merit pick is over it, `withinBudget` names the best candidate
that fits, so demoting the gate never leaves a day with nothing fundable in it.

**Why fit stopped gating.** The v1.1.164 exception tier (`qualifiesForStretch` — conviction list
AND `strike <= price_high` AND composite >= 70 AND liquidity >= 11, capped at $50,000) existed for
exactly one purpose: letting good trades escape the capital gate. With the capital gate gone it
had nothing to do, and it went with it. The trigger was 2026-09-03, when MPC was refused at
$37,000 purely for being absent from a conviction list the operator no longer actively maintains —
its score was never evaluated at all. Absence from a stale list is evidence about the LIST, not
about the trade, and what the operator can fund is a decision they make on the day. A filter that
deletes a setup before they see it does not inform that decision, it replaces it.

**Measured cost of the demotion** (`scripts/dice-fit-demotion-study.mjs`, 62 stored wheel briefs,
both arms sharing identical quality gates): pick-days 26 → 34 (41.9% → 54.8%), median composite of
the winner unchanged at 65.9 — removing a non-merit filter cannot lower the winner's merit, and a
drop would have meant a bug. Of the 34 new pick-days, 12 need more than $30,000 and only 3 of those
have a within-budget alternative to offer; 17 are not on the conviction list; 0 breach a
never-above band. The replay's earnings gate is not independently valid (see below) but is applied
identically to both arms, so the delta holds.

**What is lost, deliberately.** Nothing now enforces the operator's own own-at-strike rule. The
conviction band is still computed and stated in four distinct states — not listed / listed with no
band / strike inside the band / strike ABOVE the band — and the last is surfaced loudly, but a
badge is not a gate. `price_high` is used rather than `price_low` because only the never-above line
is semantically reliable (3 of 13 stored rows sat inverted for three weeks before migration 075).
`criticVerdict.confidence` remains deliberately unused — it reads `high` on 40 of 41 eligible
picks, so it discriminates nothing.

**Why the earnings gate is an exclusion, not the brief's −20 penalty.** A penalty on a high
scorer still leaves it on top; the session that produced this feature opened with the brief
ranking NVDA wheel #1 on the day it reported. For a pick meant to be acted on unread, an
earnings event inside the hold window disqualifies outright.

**Why an unknown or past earnings date fails closed.** `earnings_calendar` is keyed by ticker
with one row each and no history, so a `report_date` in the past means the row was never
refreshed after that report — the NEXT date is unknown. Measured 2026-09-02: 57 of 1,069 rows
were stale this way. "There is a date stored" is not "the stored date is right."

**Email delivery (v1.1.163).** The same result is rendered as a single card by
`dice-email-builder.ts` and sent from inside the brief job after its own email. All routes
(nightly send, in-app button, IPC) resolve through `computeRollTheDice(db)` so they cannot
disagree about the day's pick. A no-pick day still sends — silence is indistinguishable from a
failed job.

see `src/main/services/roll-the-dice.ts`, `src/main/services/dice-email-builder.ts`

## greek consistency (provider-data integrity) {#greek-consistency}

Does a chain's delta agree with the underlying price the chain reports? (v1.1.252)

- **Delta-implied spot**, per contract: the `S` at which the European, dividend-free Black-Scholes delta
  `N(d1)` (call) or `N(d1) − 1` (put), `d1 = (ln(S/K) + (r + σ²/2)·T) / (σ·√T)`, equals the provider
  delta — by bisection on `[0.5·S₀, 1.5·S₀]`, since delta rises with spot for both rights. Undefined for
  a saturated delta (`|Δ| < 0.05` or `> 0.95`), which is flat in spot. `T` = calendar DTE / 365.
- **Chain reading**: the median over contracts within 10 % of spot (old app) or the ATM band (TA2).
- **Parity spot** (TA2, QC-410): `S = C_mid − P_mid + K·e^(−rT)` per strike, median over pairs whose
  spread is ≤ 50 % of mid. No Greek and no volatility enters it.
- **Stale** when `min(|implied / chain − 1|, |implied / parity − 1|) > 1 %` — the Greeks are consistent
  if they agree with EITHER reading, because a dividend before expiry separates the two and a provider's
  Greeks may follow either (EIX followed the chain, BBY followed parity). Parity is omitted when fewer
  than 3 strikes quote both sides. Same rule in both apps (v1.1.254). The old app's rate is
  `RISK_FREE_RATE`; TA2 uses the stored 3M par yield.

Threshold evidence: see `MAX_SPOT_DEVIATION` in `src/main/services/greek-consistency.ts` and
NewApp 03 §3.

## own-at-strike (cost-basis read) {#own-at-strike}

"Would I be happy owning this at the strike?" — answered from the stock's own price history
instead of a hand-maintained list. Reported on `pick.fit.ownership`; **never a gate.**

```
costBasis         = strike − premiumPerShare        # what assignment actually costs
basisVsSma200Pct  = (costBasis / sma200 − 1) × 100  # negative = below the long-run average
atOrBelowSma200   = costBasis <= sma200
rangePctile       = (costBasis − lo52) / (hi52 − lo52) × 100    # 0 = 52w low, 100 = 52w high

# support axis (v1.1.188) — note it tests the STRIKE, not the basis
swingLow20        = min(low) over the last 20 sessions           # null when < 20 bars
strikeBelowSwing  = strike < swingLow20                          # null when swingLow20 is null
```

**The asymmetry is deliberate and must not be "tidied".** The long-run half tests the **cost
basis**; the support half tests the **strike**. That is exactly what was measured — the T8 study
and its replay both split on `basis ≤ SMA200` and `strike < 20-day low` — so the code matches the
study rather than the other way round.

`sma200`, `hi52` and `lo52` come from `historical_prices` filtered to `date <= briefDate` — fully
point-in-time, available for **100% of stored wheel picks**, and impossible to leave stale.
`rangePctile` is deliberately **not clamped**: a basis outside the 52-week range is real
information. A ticker with fewer than 200 sessions yields `null`, reported as "not enough
history" — never as a pass, the same fail-closed reasoning the earnings gate uses.

### Why the conviction band needed replacing

The never-above band was supposed to answer this question and **arithmetically could not**. It is
anchored to spot on the day it was written — across all 13 stored rows, `price_high / spot` at
write time had median **1.126** — while an OTM cash-secured put strikes at median **0.930** of
spot. So `strike / price_high ≈ 0.83` by construction, and the test cannot fire until spot has
risen ~21% above where the band was last written. Measured over 62 briefs: **0 of 39** picks on a
listed ticker breached the line, and the closest came within 10%. It was decorative *before*
v1.1.168 demoted it — not a protection that demotion removed.

### What the replacement is worth (`scripts/own-at-strike-study.mjs`)

Outcome = the underlying's return **from the cost basis** at expiry + 30 days, **excess of SPY**
over the identical window, for every pick rather than only the ~27% actually assigned.

| | accept (`strike ≤ SMA200`) | reject | separation |
|---|---|---|---|
| raw return | +14.20% | +0.61% | 13.6 pts |
| SPY, same windows | +3.95% | +3.89% | — (regime is not the explanation) |
| excess of SPY | +10.24% | −3.29% | 13.5 pts |
| **per independent episode** | **+12.10%** (n=12) | **−5.32%** (n=35) | **17.4 pts** |

Episodes collapse repeated picks of the same ticker+expiry into one observation — NVDA appeared 7
times and AVGO 6 times across 8 consecutive days, which is one move counted 13 times. Separation
*grew* under de-duplication, survived leave-one-out (14.3 pts with the +46% INTU outlier removed)
and survived dropping NVDA and AVGO entirely (19.1 pts, n=8). 11 of 12 accept episodes were
positive.

### The support axis, and why adding it REMOVED a warning (v1.1.188)

`scripts/fr-wheel-entry-quality-study.mjs` (T8) tested the Validate view's entry machinery on 4,917
settled liquidity-gated rows across 45 dates. Two measures separate and are **complementary**;
`scripts/dice-entry-annotation-replay.mjs` then re-ran them on the dice's own population — 250
stored brief picks, 186 settled:

| cell | share of brief picks | mean | median | assigned |
|---|---|---|---|---|
| both | 18% | +2.17% | 2.51% | **8%** |
| long-run only | 16% | +2.97% | 2.71% | **4%** |
| **support only** | 14% | **+3.46%** | **5.49%** | 26% |
| neither | **52%** | **−2.10%** | 2.15% | **44%** |

Both survive the obvious confound: below-swing strikes sit **2.6× further OTM** (8.46% vs 3.28%),
but held inside ATR-cushion quartiles the split persists in all four, largest in the *thinnest*
cushion (+1.48% at 19.5% assigned vs −4.55% at 60.8%).

**The wording change is a withdrawal, not an addition.** *"That is an extended price, not a
discount"* used to fire on every basis above SMA200 — **166 of 250 picks (66%)**, which includes
the support-only cell that outperformed all three others. It now fires only when **both** axes
agree (52%), reworded as *"An extended price with no recent floor under it."* The in-app panel's
warning colour follows the same condition (`ownershipWarns`). Nothing new fires at 50%; an
existing line fires less, and stops being wrong about the best cell.

The connective carries the relationship: **and** when the axes agree, **but** when they conflict.
An **unknown** support axis (fewer than 20 bars) falls back to the exact pre-v1.1.188 sentence,
clause included — an axis that could not be measured must never be the reason a caution disappears.

The entry *zone* itself was tested and adds nothing: `entryZoneLow = min(swingLow, SMA50)`, so its
split (858 episodes) is the swing-low split (869) renamed, and "IN ENTRY ZONE" is the mediocre
middle. Both of its bounds are **recency anchors**, which is the construction that made the
conviction band undetectable — see above.

### Why it is an annotation and not a gate

The accept arm is **12 episodes spanning three expiries in one ~4-week window**. Only picks whose
expiry + 30d has already passed are measurable, which truncates the sample to June–early July
2026. Several levers in this project looked exactly this good on a single regime and were
rejected on wider data (the SPY-regime gate, the overbought guard, the expiry-selection lever;
see `Requirements/v2-execution/06-seykota-risk-extensions.md`). Under FR-SEY-5 a rule this thinly
evidenced does not ship on the live path, so it informs the operator and the operator decides.
Re-run the study once ≥3 months of briefs have matured past expiry+30d.

**Fundamentals are deliberately excluded.** `fundamentals_cache` holds one row per ticker with no
history, so any P/E- or grade-based signal would be scored against *today's* values in a replay —
the same trap that makes the earnings gate unreplayable. Only price anchors are honestly testable.

see `src/main/services/own-at-strike.ts`, `scripts/own-at-strike-study.mjs`
