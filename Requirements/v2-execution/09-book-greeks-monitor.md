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
  **POSITION-SIGNED** (short-position convention: CSP/CC negated → short put +δ/+θ/−ν; longs
  keep sign). This was made **deterministic in v1.1.81** — both write paths (E\*Trade sync +
  chain-refresh) go through `shared/position-greeks.ts` `toPositionSignedGreeks` (before that the
  sync stored raw and the sign flipped per-sync — the v1.1.80 "CSP reads bearish" bug).
  `quantity` is an unsigned magnitude (`Math.abs`). **So the monitor SUMS THE STORED GREEKS
  DIRECTLY — it must NOT re-apply a `position_type` sign** (doing so would double-sign). Caveat:
  rows last written by a pre-v1.1.81 sync may still be raw until re-synced, so a defensive
  per-type normalization is still acceptable belt-and-braces.
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

The stored Greeks are already **position-signed** (v1.1.81), so the monitor sums them directly —
**no `positionType` sign is applied** (that would double-sign). `quantity` is magnitude.

```
sharesEquivalent_i =
   positionType === 'Stock'  ?  quantity                  // qty in shares, delta = +1
                             :  delta_i × quantity × 100   // options: delta_i already signed

dollarDelta_i   = sharesEquivalent_i × beta_ticker × underlyingPx_ticker
netDeltaDollars = Σ dollarDelta_i

netTheta = Σ theta_i × quantity × 100   // theta_i already signed (short = +)
netVega  = Σ vega_i  × quantity × 100   // vega_i  already signed (short = −)
```

(Belt-and-braces: if supporting pre-v1.1.81 rows that might still be raw, first pass each leg
through a per-type normalizer keyed on `positionType` — but do this *instead of*, never *in
addition to*, trusting the stored sign.)

The SPY price **cancels** out of the dollar-delta term (`shares × beta × Px_underlying`), so
`spyPx` is needed only for the optional `netDeltaSpyShares` display. Document at
`docs/formulas.md#beta-weighted-delta`.

### The one correctness rule — sign convention (the whole ballgame)

As of **v1.1.81** the stored Greeks are **position-signed at the write paths** (via
`shared/position-greeks.ts` `toPositionSignedGreeks`), so the monitor's job is simply to **sum
them directly** and *not* re-apply any direction. The end-to-end position-level signs are:

| Position        | stored (δ/θ/ν) | net delta | net theta | net vega |
|-----------------|----------------|-----------|-----------|----------|
| CSP (short put) | +/+/−          | **+** (bullish) | **+** | **−** |
| CC (short call) | −/+/−          | **−**     | **+**     | **−**    |
| Long Call       | +/−/+          | **+**     | **−**     | **+**    |
| Long Put        | −/−/+          | **−**     | **−**     | **+**    |

> ⚠ **History (why this rule exists):** before v1.1.81 the sync stored *raw* greeks while the
> chain-refresh stored *position-signed* ones, so the same CSP flipped sign between syncs and the
> Pre-Trade Validator read it as "bearish" (v1.1.80). The lesson: there must be exactly ONE place
> that decides the sign. Re-applying a `positionType` sign on top of the now-signed storage would
> re-introduce the inversion — sum directly.

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
