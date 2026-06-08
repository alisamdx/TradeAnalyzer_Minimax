# 10 — LEAPS Strategy Screeners

Two specialized multi-leg screeners for long-dated structures: **LEAPS + CSP** (a LEAPS call funded/offset by a cash-secured put) and **Collared LEAPS** (a deep-ITM LEAPS call protected by a long OTM put). Both gate on the broad market, screen the universe, score and grade opportunities, and let the user mark positions as opened for monitoring.

Both take a `DataProvider` (quotes/fundamentals/bars) and an `OptionsProvider` (chain/IV) and run through the rate limiter. Universe ∈ `sp500 | russell1000 | both | etf` (or a watchlist for Collared).

---

## Part A — LEAPS + CSP

Service: `leaps-csp-service.ts`. IPC: `window.api.leapsCsp.*`. View: `LeapsCspView.tsx` (⚡ LEAPS). Tables: `leaps_csp_runs`, `leaps_csp_opportunities`, `leaps_csp_opened` (§2.10).

### 10.A.1 Pipeline
1. **Market gate** — evaluate SPY vs its 50-day & 200-day MA, VIX level and 5-day change, and the HYG/IEF credit ratio + trend → **PASS / CAUTION / FAIL**, with a human-readable effect. Stored as `market_gate` + `gate_detail_json` + `gate_effect`.
2. **Universe** — candidate tickers from the screener cache for the chosen universe.
3. **LEAPS hard-fail filters** — keep only LEAPS calls with: delta **0.70–0.90**, DTE **365–730**, bid-ask spread **≤ 5%**, OI **≥ 100**, extrinsic **≤ 15%** of premium.
4. **CSP pool** — short puts with: delta **−0.15 to −0.30**, DTE **25–50**, annualized return **≥ 12%**.
5. **Pairing** — pair a LEAPS with a CSP (same ticker, different ticker, or LEAPS-only) → `pairing_mode`.
6. **Combined score** = LEAPS sub-score × 60% + CSP sub-score × 40% → grade **A+/A/B/C/F**.

### 10.A.2 Output
Ranked table; each row carries both legs' full detail (strike, expiry, DTE, delta, premium, extrinsic %, IV %, IVR, OI, sub-score), the combined score, grade, `caution_flags`, and `total_cash_to_deploy`. An expandable panel shows the scoring breakdown and alternatives (`detail_json`). "Mark as Opened" records actual entry debits/credits in `leaps_csp_opened`.

IPC: `runScreen(universe, forceRun?, watchlistId?)`, `getRuns`, `getRun(runId)`, `markOpened(opportunityId, entry)`, `getOpened`, `deleteRun`, `onProgress`, `onProgressDetail`.

---

## Part B — Collared LEAPS

Service: `collared-leaps-service.ts`. IPC: `window.api.collaredLeaps.*`. View: `CollaredLeapsView.tsx` (🛡️ Collared LEAPS). Tables: `collared_leaps_runs`, `collared_leaps_opportunities`, `collared_leaps_opened` (§2.10).

Position = **long deep-ITM LEAPS call + long OTM protective put** on the same underlying. The put is insurance on the LEAPS; its parameters derive from the chosen LEAPS.

### 10.B.1 Pipeline
1. **Market gate** — same style as LEAPS+CSP (`CollaredLeapsGateDetail`). A `gate_survived` flag marks collars whose structural hedge passes even under a FAIL gate.
2. **Universe / watchlist** filter → candidate tickers (with spot and 200-day MA).
3. **LEAPS call leg** — deep-ITM call (strike, expiry, DTE, delta, debit, extrinsic %, IV %, IVR, OI, spread %, sub-score).
4. **Protective put leg** — OTM put (strike, expiry, DTE, negative delta, debit, IV %, IVR, OI, spread %, sub-score).
5. **Structural metrics** (all stored): `cost_drag_pct` = put debit / LEAPS debit × 100; `floor_depth_pct` = (spot − put strike) / spot × 100; `breakeven` = LEAPS strike + total debit/100; `max_loss_at_put`; `max_loss_at_zero` (can be negative = fully hedged); `upside_retention_pct` (collared vs naked LEAPS P&L at +20%); `hedge_efficiency_pct`; `rr_ratio`.
6. **Combined score** = LEAPS + put + structural sub-scores → grade **A+/A/B/C/F**.

### 10.B.2 Output
Ranked table with expandable score breakdowns and a payoff grid (`detail_json`) for the collar's P&L. `caution_flags`. "Mark as Opened" → `collared_leaps_opened` (LEAPS + put entry debits).

IPC: `runScreen(universe, forceRun?, watchlistId?)`, `getRuns`, `getRun(runId)`, `markOpened(opportunityId, entry)`, `getOpened`, `deleteRun`, `onProgress`, `onProgressDetail`.

---

## 10.C Scheduling
Both screeners can run as scheduled batch jobs (§20). They are heavy (per-ticker chain fetches) so they honor the rate limiter, support cancel, and stream per-ticker progress.
