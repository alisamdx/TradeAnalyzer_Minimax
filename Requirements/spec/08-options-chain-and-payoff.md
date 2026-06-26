# 08 — Options Chain & Payoff Visualizer

Two linked features: the **Options Chain** viewer (browse live chains, send legs to Payoff) and the **Payoff Visualizer** (model any multi-leg structure, see the P&L curve and a risk matrix, get an AI assessment).

---

## Part A — Options Chain

Service: options IPC reads through the active `OptionsProvider` (E*Trade by default). IPC: `window.api.optionsChain.*` and `window.api.etrade.*`. View: `OptionsChainView.tsx` (📉 Options).

### 8.A.1 Behavior
- User enters a ticker → `getNearExpirations(ticker)` returns expiration summaries, the full expirations list, current price, and current IV.
- Selecting an expiration → `getChain(ticker, expiration)` returns calls and puts side-by-side with strike, bid, ask, last, volume, OI, IV, and Greeks (delta/gamma/theta/vega).
- The table is split call-side | strike | put-side, ATM-centered.

### 8.A.2 B / S quick actions
Each row has **B** (buy, green) and **S** (sell, orange) buttons on both the call and put side. Clicking one builds a single `PayoffLeg` and dispatches `navigate-to-payoff` with `{ ticker, spot, expiry, legs:[leg] }`:

```ts
PayoffLeg = {
  id: string,            // unique (e.g. String(Date.now()))
  side: 'buy' | 'sell',
  type: 'call' | 'put',
  strike, expiry,
  premium,               // mid = (bid + ask) / 2
  quantity: 1,
  delta, theta, vega, iv,
  label,                 // e.g. "Sell Put 240"
}
```

This is the primary path from "I see a contract" to "model the trade."

---

## Part B — Payoff Visualizer

Service: `payoff-service.ts` (P&L math + AI assessment). IPC: `window.api.payoff.*`. View: `PayoffView.tsx` (📐 Payoff). Saved structures persist in `payoff_strategies` (§2.10).

### 8.B.1 Leg model & entry paths
A structure is an array of `PayoffLeg` (above). Payoff can be entered from: Options Chain B/S buttons, Strategy Lab "View in Payoff", Daily Brief pick nav, Opportunity drill-in, a strategy template dropdown, the **Portfolio position 📐 button**, or manual leg entry. All paths set `ticker`, and a dedicated `useEffect` on `ticker` fetches the earnings date for the annotation (so it shows regardless of entry path). The **Portfolio path passes the held position as pre-built legs** (`shared/position-payoff.ts` `positionToPayoffLegs` — exact strike/expiry/entry premium/quantity, raw greeks) so the diagram is the *actual* position, not a chain-rebuilt approximation (v1.1.79); it falls back to the chain-rebuild path only when a position lacks the strike/expiry to reconstruct.

### 8.B.2 Strategy templates
A grouped dropdown offers all 31 tastylive strategies (§09). Selecting one with a ticker set: loads the live chain, snaps each leg to the nearest real Friday expiry for the target DTE, and fills premiums + Greeks from live mid-prices (skeleton legs show while loading). Spot is taken from the live chain when a ticker is set — no manual spot needed.

### 8.B.3 P&L chart
An SVG payoff curve across a price range, with:
- Max profit, max loss, breakeven(s) computed from the legs.
- **Unlimited-risk detection** that excludes the left side for short-put structures (stock can't go below \$0) and computes max loss at price=\$0; avoids false "∞ loss"/"∞ profit".
- Hover crosshair + tooltip showing exact price and P&L, with an auto-flipping tooltip box.
- An amber **earnings annotation** strip below the chart when the ticker reports before expiry (§17).
- A **Strategy Formula Panel**: `recognizeStrategy()` identifies the structure (covers verticals, iron condor/fly, straddle/strangle, jade/big/reverse lizard, zebras, front ratios, butterflies incl. broken-wing/heart, calendar, PMCC/PMCP, covered put, etc.) and shows its key rules with ✓/✗ per computed value.

### 8.B.4 Risk Matrix
A "📈 Chart / ⬛ Risk Matrix" toggle. The matrix is a 2D P&L grid:
- **Rows** = chain strike prices (±25% of spot, **extended to include every leg strike** even when outside that band; leg-strike rows highlighted amber with a ◀ marker).
- **Columns** = Today + each chain expiry (all ≤45 DTE, min 10; when no chain is loaded, synthetic weekly date columns marked `~` are generated between today and the leg expiry).
- **Cells** = position P&L. Pre-expiry cells via Black-Scholes (r = 4.5%, sigma = each leg's IV as a decimal fraction, or 30% fallback); the final column uses intrinsic-only math. Color-coded green→red, spot row highlighted, a Zone label per row at expiry.
- The earnings column is highlighted amber with a 📅 icon (§17).
- Clicking a cell expands a per-leg breakdown: entry price, current theoretical value, P&L, and an action label (Take profits ≥80%, Consider ≥50%, Close — loss > premium, Watch >50% at risk, Hold).

> **Black-Scholes IV note:** `OptionContract.iv` / `leg.iv` is already a decimal fraction (0.38 = 38%). Use it directly as sigma — do **not** divide by 100. (A historical bug double-divided and made all OTM options look worthless.)

### 8.B.5 AI "Assess Trade"
`assess(legs, input)` streams (`onAssessProgress`) a Claude (`claude-opus-4-7`) assessment of the structure: structured cards covering thesis fit, risk, probability of profit, and management notes. DTE is computed from `leg.expiry` and passed inline (so the year in the ISO date isn't misread as DTE). Requires an Anthropic key; absent → feature hidden/disabled.

### 8.B.6 Persistence
`save(name, ticker, legs)`, `list()`, `delete(id)` for named reusable structures.

### 8.B.7 Pre-Trade Validator (v1.1.76)
A **PRE-TRADE VALIDATION** panel above the AI assessment: validate the hand-built structure
against declared **intent** (purpose income/ownership/directional/hedge · happy-to-own? ·
multi-quarter thesis) and get a **good / caution / bad** verdict from deterministic checks
(reward-vs-risk for defined-risk spreads only — a CSP's structural max-loss is *not* false-flagged;
undefined-risk; IV-regime fit — buying expensive vol → warn; selling cheap vol → warn for income/directional but **info** for ownership/happy-to-own (intent-gated, premium-secondary, v1.1.78); direction-vs-trend,
intent-gated; earnings-before-expiry, intent-gated; cushion-vs-`atr_pct`; horizon match;
ownership basis). When flagged, the Strategy Lab **suggests a better structure** for the same
ticker (intent + IV-regime filtered; may advise not selling premium) — with an **Open in Lab →**
button (v1.1.77) that jumps to the Strategy Lab's Explore tab pre-populated with that
ticker + structure and auto-builds the setup. Verdict roll-up: any
`fail` → bad, any `warn` → caution, else good. **Intent-aware** because the same trade can be a
bad income trade but a fine ownership trade. Decision-support only — places no orders, not wired
to the execution engine. `window.api.pretradeValidator.validate/history`; pure core
`pretrade-checks.ts` (`PRETRADE_THRESHOLDS` tunable); `pretrade-validator-service.ts` (lab
context cached 10 min + Refresh action); every validation persisted to `pretrade_validations`
(migration 061). Design doc: `Requirements/PRE_TRADE_VALIDATOR_SPEC.md`. Acceptance:
`tests/pretrade-checks.test.ts`.
