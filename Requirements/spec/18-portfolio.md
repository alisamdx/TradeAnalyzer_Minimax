# 18 — Portfolio (Positions, Greeks, Advisor, Alerts)

Tracks the user's real positions, syncs them from E*Trade, computes P&L and aggregate Greeks, runs an AI advisor, and raises trade-management alerts. Services: `portfolio-service.ts`, `etrade-portfolio-service.ts`, `position-analysis-service.ts`, `ai-advisor-service.ts`, `alerts-service.ts`. IPC: `window.api.portfolio.*`, `window.api.alerts.*`. Views: `PortfolioView.tsx` (💼 Portfolio), `AlertsView.tsx` (🔔 Alerts). Tables: `positions`, `position_analysis`, `advisor_sessions`, `alerts` (§2.9, §2.12).

## 18.1 Position CRUD & P&L

Position types: **CSP**, **CC**, **Stock**. Fields per §2.9. The view has Open / Closed tabs and P&L summary cards (positions, unrealized/realized, capital deployed, win rate, average return). The open-positions table shows both **Day's G/L** (single-session change, E*Trade `daysGain`/`daysGainPct`) and **Total G/L** (full-position unrealized gain since entry, in $ and %, from E*Trade `totalGain` [stored as `unrealized_pnl`] / `totalGainPct`, falling back to stored `unrealized_pnl`). Capital required, days held, return %, and annualized return are computed (SQL views + service):
- Stock capital = `entry_price × quantity`; option collateral = `strike_price × quantity × 100`.
- Realized P&L (option) = `(exit − entry) × qty × 100 + premium_received`.

IPC: `add`, `list(status?)`, `get(id)`, `update(id, …)`, `close(id, {exitPrice, exitDate, exitNotes?})`, `delete(id)`, `pnlSummary`, `getWithMetrics(id)`, `updatePrice(ticker, price)`, `listByTicker(ticker)`.

### 18.1a Premium vs cost basis (v1.1.359)

Bec's "risk line" (`docs/Bec/STRATEGY-SUMMARY.md` §6a, §9.6): a holding worth keeping is one whose
basis only ever falls as calls are sold against it. Reporting only. It is a panel on the Open tab
(`PremiumBasisPanel`, IPC `portfolio:premium-basis`, also `GET /api/v1/diagnostics/premium-basis`).
It shows one row per ticker holding open stock:
- **Columns:** shares, share-weighted cost, premium kept per share, net basis, % reduced, the line
  verdict, and open short-option credit.
- **Steps:** the row expands to the closed options in order, each with the basis after it.

Rules (`src/shared/premium-basis.ts`, `docs/formulas.md#premium-basis`):
- **Window:** short options on the ticker closed on or after the earliest open lot's acquisition
  date, plus the **assigning put**. That put is found by expiry (≤ 7 days before acquisition) and a
  strike matching a lot's cost (±1%, as strike or as strike − premium), never by an "Assigned" note,
  because the orders import has no order for an assignment.
- **Kept** = `realized_pnl` from real fills, so a buyback at a loss is negative and is a step UP.
  Verdict: **✓ only fallen** if no step rose, otherwise **↑ rose N×**.
- **Estimated rows** (closed, `exit_price` NULL, "estimated from last mark"):
  - vanished on or after expiry → counted at the full credit and flagged;
  - vanished before expiry → not counted, listed as unresolved ("run Sync Closed Positions").

  The mark estimate is never used: measured wrong by thousands on assigned puts.
- **No double count:** if a lot's cost sits nearer strike − premium than the strike, the broker
  already netted the assigning put into the cost. It is shown, not subtracted again.
- **Open short-option credit** is shown apart from kept premium; it is not yet earned.

## 18.2 E*Trade sync

`etrade-portfolio-service.ts`:
- **Open positions** — `sync(accountIdKey?)` pulls live positions with market value, gains, Greeks (delta/gamma/theta/vega), IV (stored as %), beta, and `pct_of_portfolio`. Matched to existing rows by `etrade_position_id` (unique).
- **Closed positions** — `syncClosed()` fetches YTD transaction history (`/v1/accounts/{id}/transactions`, paginated/marker-based), classifies each transaction as open/close/expired/assigned by OCC-symbol parsing, pairs open+close legs FIFO per symbol, and inserts matched closed positions with a dedup guard. Surfaced as "↓ Import Closed (YTD)".
  - The YTD range is **never requested whole** — that endpoint stalls on wide windows. `buildDateSlices(start, end, maxSpanDays = 30)` (exported from `etrade-portfolio-service.ts`) splits it into contiguous windows of at most 30 days, with no gaps and no overlap. Because the stride is 31 days, a range length that is an exact multiple of 31 would leave a **one-day tail**; that tail is **folded into its predecessor** (which becomes 31 days wide) rather than emitted as its own request or dropped — dropping it would leave a hole in the coverage. A one-day window is still emitted when the entire range is one day. Exported, rather than inline, so the arithmetic can be tested against dates other than today (v1.1.193).

IPC: `etrade.listAccounts`, `etrade.sync(accountIdKey?)`, `etrade.syncClosed(accountIdKey?)`, `etrade.lastSync`, `etrade.listPositions`.

## 18.3 Aggregate Greeks monitor

A summary bar over open positions: **Net Δ**, **Θ/day ($)**, **Total Vega**, **BP Used %** (vs `accountSize` setting), and expiration buckets (≤7 / ≤14 / ≤21 days). Greeks come from the E*Trade sync (per-share) × position multiplier (options: `quantity × 100`; stock: `quantity`, Δ=1/share). Full formula in §23 `portfolio-greeks`. **⚡ Refresh Greeks** (`fetchGreeks`) fetches live delta/theta/vega for open CSP/CC positions via the options chain and stores position-adjusted values (short convention: +theta, −vega).

## 18.4 Trade-management alerts (banner)

A collapsible **⚡ Trade Management** banner above the open-positions table with three rules:
- **Take Profits** — E*Trade `total_gain_pct` ≥ 50%.
- **Manage Now** — DTE ≤ 21.
- **Delta Drift** — `|delta| > 0.45`.

Severity-coded; "View →" expands and scrolls to the position row. Earnings badges (📅 / 📅!) appear per position when earnings fall before expiry (§17).

## 18.5 Per-position analysis (Phase 2)

`position-analysis-service.ts` writes one `position_analysis` row per position (upsert): trend, RSI, SMA stack, support/resistance, composite score, days in position, current/annualized return, current delta, theta decay, IV rank, assignment risk, roll opportunity, and a recommendation (`action` = hold/close/roll/hedge/take_profits, `conviction` 1–3, `explanation`). IPC: `analysis.run(positionId)`, `analysis.runAll()`, `analysis.get(positionId)`.

## 18.6 AI Portfolio Advisor (Phase 3)

`ai-advisor-service.ts` sends a snapshot of all positions to Claude (`claude-opus-4-7`) and returns an `AdvisorSession`: free-text advice, structured `action_items`, per-position advice map, and portfolio-level observations, plus model + token counts (stored in `advisor_sessions`). A dedicated tab auto-loads the most recent session, shows a history sidebar, and streams progress (`advisor.onProgress`). IPC: `advisor.run()`, `advisor.history(limit?)`, `advisor.setApiKey(key)`, `advisor.hasApiKey()`, `advisor.onProgress`.

## 18.7 Alerts (standalone)

`alerts-service.ts` + `AlertsView`. Three alert types backed by `alerts` (§2.12): **price** (above/below threshold), **expiration** (N days before), **delta** (above/below threshold). Price alerts are monitored via the optional Polygon delayed WebSocket feed; triggering sets `is_triggered`/`triggered_at` and optionally plays a sound. IPC: `create`, `list(activeOnly?)`, `get(id)`, `update(id, …)`, `delete(id)`, `markTriggered(id)`, `resetTriggered(id)`.
