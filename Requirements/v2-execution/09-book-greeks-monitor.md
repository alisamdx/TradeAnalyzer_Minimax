# v2 Execution — Book Greeks monitor (beta-weighted delta / net theta / net vega)

> A small, read-only portfolio-level Greeks aggregation: surface the **net beta-weighted
> delta, net theta, and net vega** of the open book so a premium-income portfolio can tell at
> a glance whether it has quietly become a directional bet. This is the "Greek-based income"
> idea translated to fit **this app** (single $10k account, defined-risk, ≤5 concurrent) —
> the *monitor*, not the *active delta-neutral manager*.
>
> Status legend: ✅ shipped · 🚧 in progress · 📋 planned · ❌ rejected/declined.
>
> **Status: 📋 planned (post-inflection-launch).** Tier 1 (FR-GRK-1) is read-only and ships
> independently. Tier 2 (FR-GRK-2, an entry guardrail) is a trade-logic change → gated behind
> FR-SEY-5 validation. Tier 3 (active management) is explicitly **out of scope** — wrong tool
> at this account size / risk profile.

---

## Why this, and why only the monitor

Classic "Greek-based income" (the portfolio-margin / tastytrade school) runs a book to a net
**theta** target while holding net **delta** in a band (beta-weighted to SPY) and capping net
**vega** so a vol spike can't take the book. It shines with portfolio margin and 20–40
occurrences. **We have $10k Reg-T, defined-risk-only, ≤5 concurrent positions** — too few
positions and too BP-constrained to run an actual delta-neutral theta machine, and
defined-risk (correctly) caps theta-per-BP. So the *active manager* is the wrong target.

What *is* worth stealing is the **portfolio-level exposure read**: with a handful of credit
spreads / CSPs across different names, it is easy for the book's *aggregate* delta to drift
into a meaningful directional position without any single trade looking wrong. The monitor
makes that visible; the optional tier-2 gate keeps a new entry from making it worse.

**The infrastructure already exists** — this is mostly an aggregation, not new machinery:

- `positions` carries per-position `delta`/`gamma`/`theta`/`vega` (migration 014), stored
  **RAW (per-contract, long-option convention)** exactly as E\*Trade returns them
  (`etrade-portfolio-service.ts` writes `Complete.delta/...` verbatim and stores
  `quantity = Math.abs(raw.quantity)`). **The stored Greeks are NOT position-signed and the
  quantity is unsigned — direction lives only in `position_type`.** (Verified 2026-06-25
  against the live synced book: every CSP had δ<0 / θ<0 / ν>0, i.e. raw long-put Greeks, even
  though a short put is +δ / +θ / −ν. The old `Position`-type comment claiming a
  "short-position convention" was wrong and has been corrected.)
- `BetaService` (`beta-service.ts`) computes beta to SPY from local `historical_prices`
  (252-day window, pure, unit-tested, zero API cost; `docs/formulas.md#beta`).
- SPY history + per-ticker underlying prices are already local (`quote_cache` /
  `historical_prices`).

What is missing today: **no portfolio-level Greek aggregation** (`PnLSummary` sums P&L and
capital only) and **no beta-weighting is ever applied** to the stored Greeks.

---

## FR-GRK-1 — Book Greeks monitor (read-only) — 📋

New `PortfolioService.getBookGreeks(): BookGreeks`, aggregating over **open positions only**.

```ts
export interface BookGreeks {
  netDeltaDollars: number;        // Σ beta-weighted dollar delta (SPY-equivalent direction)
  netDeltaSpyShares: number;      // netDeltaDollars / spyPx — "SPY share equivalents"
  netTheta: number;               // $/day        (position-signed)
  netVega: number;                // $ per 1 vol-point move (position-signed)
  deltaPctOfNetLiq: number | null;// netDeltaDollars / accountNetLiq — the HEADLINE tilt number
  coverage: {
    withGreeks: number;           // positions included in the delta sum
    total: number;                // open positions
    missingBeta: string[];        // tickers with <200 obs → beta fell back to 1.0
    missingPrice: string[];       // tickers with no underlying price → omitted from delta sum
  };
}
```

### Aggregation formula

The stored Greeks are **raw long-option** values; derive position direction from
`positionType`:

```
dir_i =  positionType ∈ {CSP, CC}        ? -1   // short option → negate raw greeks
         positionType ∈ {Long Put, Long Call} ? +1
         positionType === Stock          ? +1   // long stock (current model is long-only)

sharesEquivalent_i =
   positionType === 'Stock'  ?  quantity                       // qty in shares, delta = +1
                             :  delta_i × dir_i × quantity × 100 // options: qty in contracts

dollarDelta_i   = sharesEquivalent_i × beta_ticker × underlyingPx_ticker
netDeltaDollars = Σ dollarDelta_i

netTheta = Σ theta_i × dir_i × quantity × 100
netVega  = Σ vega_i  × dir_i × quantity × 100
```

The SPY price **cancels** out of the dollar-delta term (`shares × beta × Px_underlying`), so
`spyPx` is needed only for the optional `netDeltaSpyShares` display. Document at
`docs/formulas.md#beta-weighted-delta`.

### The one correctness rule — sign convention (the whole ballgame)

Because the stored Greeks are raw and the quantity is unsigned, **`positionType` is the sole
source of direction** — apply `dir_i` above; never trust the stored Greek sign. A unit test
must pin that the *resulting position-level* sign is correct end-to-end:

| Position        | raw stored (δ/θ/ν) | → position net delta | net theta | net vega |
|-----------------|--------------------|----------------------|-----------|----------|
| CSP (short put) | −/−/+              | **+** (bullish)      | **+**     | **−**    |
| CC (short call) | +/−/+              | **−**                | **+**     | **−**    |
| Long Call       | +/−/+              | **+**                | **−**     | **+**    |
| Long Put        | −/−/+              | **−**                | **−**     | **+**    |

> ⚠ **This is not hypothetical.** The live synced book (2026-06-25) stores CSPs with δ<0 /
> θ<0 / ν>0 (raw long-put Greeks) and `quantity = +1`. Summing as-is would report the book as
> net-short-delta / paying-theta when the CSPs are actually net-long-delta / collecting-theta
> — a fully **inverted** exposure. The `dir_i` derivation above is mandatory; the table is its
> regression test. (Do **not** instead "fix" the sign at sync time — other readers may depend
> on the raw E\*Trade values; normalize only at aggregation.)

### Edge cases (explicit)

- **Closed positions** excluded.
- **`delta` null** → omit from the delta sum, count in `coverage` (never silently zero it).
- **`beta` null** (under `MIN_OBSERVATIONS` = 200 paired returns) → fall back to `beta = 1.0`
  and record the ticker in `coverage.missingBeta`, so the operator knows that name is
  *unweighted*, not *mis-weighted*.
- **Underlying price missing** (no `quote_cache.last` / `historical_prices.close`) → omit from
  the delta sum, record in `coverage.missingPrice`. Theta/vega still sum (price-independent).
- **Stock** positions: `delta = +1` per share (long-only in the current `positions` model),
  `theta = vega = 0`.
- **Underlying price source:** `quote_cache.last` first, fall back to the latest
  `historical_prices.close` for the ticker (same precedence the codebase already uses).
- **`accountNetLiq` source:** the most recent E\*Trade account-summary value the portfolio
  already syncs; if unavailable, `deltaPctOfNetLiq = null` (don't fabricate a denominator).

### Surfacing

- IPC `portfolio:get-book-greeks` → `window.api.portfolio.getBookGreeks()`.
- A one-line strip on the Portfolio view, e.g.:
  `Δ +$4,820 (48% of NetLiq) · Θ +$31/day · V −$190/pt   [2 names unweighted]`
- **`deltaPctOfNetLiq` is the headline.** For a book that is supposed to be premium income, a
  net delta that is a large fraction of net-liq means it has become a directional bet. That
  single number is the reason the feature exists.

### Scope boundary (tier 1)

Tier 1 covers the **`positions` book only** (E\*Trade-synced + manual). It is pure read-only
with **no execution-engine coupling**. The v2 `exec_positions` book is deliberately excluded
here (its Greeks live in `legs_json`, entry-time only) — it folds in at tier 2.

---

## FR-GRK-2 — Book-delta / short-vega entry guardrail — 📋 (FR-SEY-5 gated)

A fail-closed pre-trade gate in the risk governor, in the same family as the existing caps. On
a new proposal, compute the proposal's beta-weighted delta from its leg deltas, add it to the
open book's exposure, and **reject** (`book_delta_band` / `book_vega_cap`) if the book would
breach a configured band/cap.

- New `exec_config` columns (one migration), **default OFF** (NULL band = disabled), e.g.
  `max_book_delta_pct_netliq`, `max_book_short_vega`.
- Reuses the FR-GRK-1 aggregation; adds the **v2 `exec_positions`** book (entry-time leg
  Greeks summed from `legs_json`) so the gate sees the engine's own positions. Entry-time
  Greeks drift, but for gating the *next* entry an approximate current exposure is sufficient
  — this is exactly why tier 3 (which would need live re-quoting) is not attempted here.
- **FR-SEY-5:** this changes which trades the engine takes, so it must show neutral-or-better
  on a Brief-Replay / backtest delta before shipping enabled; otherwise it ships disabled with
  the finding recorded.

---

## Explicitly NOT doing — tier 3, active Greek management — ❌

Continuous live re-quoting of book Greeks plus rolling untested sides to recenter delta (the
full delta-neutral theta machine). Rejected because it fights the account: ≤5 defined-risk
positions can't net to neutral, it's BP-constrained, the management cadence would have to be
intraday/continuous (the engine is batch + a coarse management loop), and `exec_positions`
only holds entry-time Greeks. The validated edge here is **theta over weeks** (inflection /
wheel / income at ~30 DTE), not intraday delta scalping. If a directional long/debit sleeve is
ever added, revisit — but that is a separate *product*, not a parameter.

---

## Acceptance tests

- `getBookGreeks` sign convention: the four-row table above (CSP/CC/Long Call/Long Put) each
  pinned to the correct delta/theta/vega sign.
- Beta-weighting: a high-beta name contributes more SPY-equivalent delta than a low-beta name
  of equal raw delta; `beta=null` falls back to 1.0 and lands in `missingBeta`.
- Mixed book nets correctly (a CSP + a CC on different names → deltas partially offset).
- `missingPrice` excludes a name from the delta sum but not from theta/vega.
- `deltaPctOfNetLiq` is null when net-liq is unavailable.
