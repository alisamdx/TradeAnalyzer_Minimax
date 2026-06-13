# 09 — Strategy Lab & Knowledge Base

Two linked features for working across the full tastylive options-strategy space: the **Strategy Lab** (score and explore all 31 strategies for a ticker using fresh live data) and the **Knowledge Base** (an embedded quick-reference for each strategy).

---

## Part A — Strategy Lab

Service: `strategy-lab-service.ts`. IPC: `window.api.strategyLab.*`. View: `StrategyLabView.tsx` (🔬 Strategy Lab). Two tabs: **Validate** and **Explore**.

### 9.A.1 The 31 strategies

Each has a `slug`, `name`, and `category`. Categories and members:

| Category | Strategies |
| --- | --- |
| **bullish** (7) | Covered Call, Long Call Vertical, Call Zebra, Poor Man's Covered Call, Call Calendar, Call Butterfly, Big Lizard |
| **bearish** (7) | Covered Put, Long Put Vertical, Put Zebra, Poor Man's Covered Put, Put Calendar, Put Butterfly, Reverse Big Lizard |
| **omnidirectional** (6) | Put Front Ratio, Call Front Ratio, Put Broken Wing Butterfly, Call Broken Wing Butterfly, Call Broken Heart Butterfly, Put Broken Heart Butterfly |
| **neutral** (5) | Short Strangle, Short Straddle, Iron Condor, Dynamic Width Iron Condor, Iron Fly |
| **neutral-bullish** (3) | Short Naked Put, Short Put Vertical, Jade Lizard |
| **neutral-bearish** (3) | Short Naked Call, Short Call Vertical, Reverse Jade Lizard |

Each strategy profile defines its leg construction rules (delta/strike targets, widths, ratios) used by both Validate scoring and Explore setup building.

### 9.A.2 Validate tab — score all 31

Given a ticker, the service fetches **entirely fresh live data** (no cache):
- 90-day daily bars → direction bias (MA20 vs MA50).
- Live options expirations + chain for the nearest **20–50 DTE** expiry (`includeGreeks=true`).
- A second **far-dated chain (~120 DTE, ≥ near+25 DTE)** for the long leg of two-expiration structures (Poor Man's Covered Call/Put, Call/Put Calendar). Fetched once per `validate()` (`selectFarExpiration` + `fetchFarChain`); on failure or when no suitable expiration exists, those strategies report `unavailableReason: 'No suitable far expiration available'` rather than being synthesized. Calendar/diagonal max profit is valued via Black-Scholes (long leg's residual at the short leg's expiry, underlying pinned to the short strike) — see `23-formulas.md` / `docs/formulas.md#calendar-diagonal-pnl`.
- Underlying price resolution (`resolveUnderlyingPrice`): `chain.underlyingPrice` (E*Trade real-time spot) → `DataProvider.getQuote()` → chain-delta estimate (last resort). E*Trade serves stale Greeks on thin OI=0 chains while prices stay live; if the delta-implied ATM strike deviates >8% from the real spot, chain deltas are distrusted and leg selection falls back to moneyness offsets from spot.
- `iv_history` → IV rank / percentile.

Each strategy is scored 0–100 as the sum of four components, then graded:

| Component | Max | Basis |
| --- | --- | --- |
| IV score | 30 | IV rank vs the strategy's volatility preference (premium-sellers want high IV rank; debit strategies want low) |
| Direction score | 30 | Alignment of the 90-day bias with the strategy's directional bucket |
| Premium score | 25 | Credit/debit quality at the target structure — credits/debits are priced at the modeled **fill** (sells below mid, buys above; `SLIPPAGE_FRACTION`×half-spread), not the optimistic mid. See `23-formulas.md` / `docs/formulas.md#fill-model`. |
| Liquidity score | 15 | Bid-ask spread (8) + open interest (4) + same-day volume (3) at the structure's strikes, per leg, averaged. Volume distinguishes stale high-OI strikes from actively traded ones. See `docs/formulas.md#liquidity-score`. |

Grade: **A+ / A / B / C / F** thresholds over the 0–100 total. Results sorted best-first. Each card shows expandable score bars, condition flags (✓ / ~ / ✗), the leg table, and action buttons:
- **→ Explore Strategy** (switch to Explore tab),
- **📈 View in Payoff** (`navigate-to-payoff`),
- **✨ AI Rationale** (`aiRationale(score, ctx)` → Claude `claude-haiku-4-5`, ~\$0.003–0.005/click, requires Anthropic key).

IPC: `validate(ticker)` → `StrategyLabValidateResult`.

### 9.A.3 Explore tab — build a concrete setup

`explore(ticker, slug)` builds the concrete structure for one strategy: actual legs, strikes, mid prices, and a P&L summary (max profit/loss, breakeven). Returns a `StrategySetup`. This is the same builder the Payoff template dropdown (§08) uses to auto-fill legs.

### 9.A.4 Liquidity / data robustness
- `findByDelta` falls back to approximate-strike selection when delta is missing (pre/post-market).
- Bid filter accepts zero-bid contracts (`>= 0`) so thin chains still produce a structure.
- These guards prevent "insufficient option data at target delta" failures.

### 9.A.5 Reuse by other features
Strategy Lab scoring backs the Daily Brief's structure selection (§14) and the local API `/strategy-lab/:ticker` endpoint the external agent calls (§22). `STRATEGY_TO_SLUGS` maps each Brief strategy to its candidate slugs.

---

## Part B — Knowledge Base

View: `KnowledgeView.tsx` (📚 Knowledge). A fully embedded, offline quick-reference for all 31 strategies, extracted from the tastylive Options Strategy Guide.

### 9.B.1 Content
For each strategy, two representations live in `src/renderer/src/knowledge/`:
- **Image** — the original guide page rendered as a 150-DPI PNG (`knowledge/images/`).
- **Text** — a structured JSON one-pager (`knowledge/data/<slug>.json`): parameters, setup, risk/reward, Greeks, "How It Works", volatility behavior, expiration handling, and key takeaways.

### 9.B.2 UI
- A collapsible left drawer with search + a category-color-coded strategy list.
- A content panel with an **Image / Text** toggle: Image mode shows the original page; Text mode renders the structured layout.

No backend or DB — purely bundled renderer assets.
