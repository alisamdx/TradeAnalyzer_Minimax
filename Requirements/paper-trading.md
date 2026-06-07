# Paper Trading — Brief Validation Engine

**Status:** Planned  
**Priority:** High — closes the feedback loop on Daily Intelligence Brief quality  
**Estimated scope:** 3–4 sessions  
**Depends on:** Daily Intelligence Brief (v0.22.x), StrategyLab, historical_prices, batch job infrastructure

---

## Problem

The Daily Intelligence Brief produces ranked trade picks with AI rationale and StrategyLab grades,
but there is no feedback mechanism to measure whether those picks actually perform. Without this,
there is no way to know if the scoring engine, signal weights, or AI rationale are producing
actionable, profitable recommendations.

Paper trading closes this loop: record brief picks at inception with full context, track stock
price movement using data already in the app, and surface win rate, avg return, and per-strategy
accuracy over time.

---

## Goals

1. One-click capture of any Daily Brief pick into a paper trading ledger
2. Daily P&L tracking using existing `historical_prices` data (no new API calls for Tier 1)
3. A dashboard that shows open positions, closed positions, and brief accuracy metrics
4. Per-strategy performance breakdown so signal weights can be tuned based on real outcomes
5. Auto-expire positions when the StrategyLab expiry date passes

---

## Out of Scope (Tier 2 — future)

- **Option mark-to-market**: fetching live option quotes daily to compute true option P&L
  requires one Polygon options snapshot call per open position per day. Feasible but rate-limit
  expensive. Deferred until Tier 1 proves the concept.
- **Broker execution / auto-fill**: paper trades are manual/simulated only.
- **Greeks simulation / theta decay curves**: not computed in Tier 1.
- **Portfolio margin / buying power**: not tracked.

---

## Data Model

### Migration: `paper_trades` table

```sql
CREATE TABLE paper_trades (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Origin
  brief_id          INTEGER REFERENCES daily_briefs(id) ON DELETE SET NULL,
  brief_strategy    TEXT NOT NULL,          -- 'wheel' | 'bullish' | 'bearish' | 'income' | 'buy'
  brief_score       REAL,                   -- compositeScore at time of brief
  brief_rank        INTEGER,                -- pick rank in the strategy list

  -- Trade identity
  ticker            TEXT NOT NULL,
  strategy_name     TEXT NOT NULL,          -- e.g. 'Cash-Secured Put', 'Iron Condor'
  legs_json         TEXT NOT NULL,          -- JSON array of SetupLeg from StrategyLab

  -- Entry
  entry_date        TEXT NOT NULL,          -- YYYY-MM-DD (brief date)
  entry_price       REAL NOT NULL,          -- stock price at entry
  entry_premium     REAL,                   -- net credit (positive) or debit (negative) per share
  expiry_date       TEXT,                   -- YYYY-MM-DD from primary leg (null if no expiry)

  -- Status
  status            TEXT NOT NULL DEFAULT 'open',  -- 'open' | 'closed' | 'expired'
  exit_date         TEXT,                   -- YYYY-MM-DD when closed/expired
  exit_price        REAL,                   -- stock price at exit
  exit_notes        TEXT,                   -- user notes on why closed

  -- Computed at close
  stock_return_pct  REAL,                   -- (exit_price - entry_price) / entry_price * 100
  outcome           TEXT,                   -- 'win' | 'loss' | 'breakeven' (set at close)

  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX paper_trades_ticker   ON paper_trades(ticker);
CREATE INDEX paper_trades_status   ON paper_trades(status);
CREATE INDEX paper_trades_strategy ON paper_trades(brief_strategy);
```

### No separate snapshots table (Tier 1)

Daily P&L is computed on-the-fly from `historical_prices` at view time. No separate snapshot
table needed — query `historical_prices WHERE ticker = ? ORDER BY date DESC LIMIT 1` for
current price, join with entry_price for unrealized P&L.

---

## P&L Calculation (Tier 1 — Stock Return)

### Open position unrealized P&L
```
stock_return_pct = (current_price - entry_price) / entry_price * 100
days_held = today - entry_date
days_to_expiry = expiry_date - today  (null if no expiry)
```

### Option P&L approximation (Tier 1 — delta-based)
When StrategyLab legs include delta values, show an estimated option P&L:
```
For each leg:
  estimated_leg_pnl = leg.delta * (current_price - entry_price) * 100 * leg.qty * sign(leg.action)
net_estimated_pnl = sum of all leg estimated P&Ls
```
This is an approximation (delta only, no gamma/theta). Label it clearly as "estimated".

### Win/loss determination at close
- **Win**: stock moved in the favorable direction for the strategy
  - Wheel/bullish/buy: stock_return_pct > 0
  - Bearish: stock_return_pct < 0
  - Income: abs(stock_return_pct) < threshold (stock stayed range-bound)
- **Loss**: opposite of above
- **Breakeven**: within ±1%

---

## Service: `PaperTradingService`

Location: `src/main/services/paper-trading-service.ts`

### Methods

```typescript
// Add a pick from the daily brief
addFromBrief(pick: BriefPick, strategy: ScoringStrategy, briefId: number): PaperTrade

// Add manually (not from brief)
addManual(trade: PaperTradeInput): PaperTrade

// List open positions with current P&L (reads historical_prices)
getOpenPositions(): PaperTradeWithPnl[]

// List closed/expired positions
getClosedPositions(limit?: number): PaperTrade[]

// Close a position manually
closePosition(id: number, exitPrice: number, notes?: string): void

// Auto-expire positions where expiry_date < today and status = 'open'
// Called by the batch job or on view load
expireStalePositions(): number  // returns count expired

// Summary stats for the accuracy dashboard
getSummary(): PaperTradeSummary

// Per-strategy breakdown
getStrategyBreakdown(): StrategyBreakdown[]
```

### `PaperTradeSummary` type

```typescript
interface PaperTradeSummary {
  totalTrades:    number;
  openTrades:     number;
  closedTrades:   number;
  winRate:        number | null;   // % of closed trades that were wins
  avgReturn:      number | null;   // avg stock_return_pct of closed trades
  bestTrade:      { ticker: string; returnPct: number } | null;
  worstTrade:     { ticker: string; returnPct: number } | null;
  unrealizedPnl:  number | null;   // sum of estimated P&L on open positions
}

interface StrategyBreakdown {
  strategy:     ScoringStrategy;
  total:        number;
  wins:         number;
  losses:       number;
  winRate:      number | null;
  avgReturn:    number | null;
}
```

---

## IPC Handlers

Location: `src/main/ipc/ipc-paper-trading.ts`

```
paper:list-open         → PaperTradeWithPnl[]
paper:list-closed       → PaperTrade[]
paper:add               → PaperTrade
paper:close             → void
paper:delete            → void
paper:summary           → PaperTradeSummary
paper:strategy-breakdown → StrategyBreakdown[]
paper:expire-stale      → number
```

---

## UI Changes

### 1. DailyBriefView — "Add to Paper" button per pick

Add a small `📋 Paper` button to each `PickCard` alongside the existing
`Payoff | Validate | Options` nav row.

- Click → calls `paper:add` with the full pick context
- Button changes to `✓ In Paper` (green) if this ticker+strategy is already tracked for today's brief
- Tooltip: "Add this pick to paper trading to track its performance"

### 2. New view: `PaperTradingView`

Add to sidebar under Daily Brief (or as a tab within it).

**Layout: three sections**

#### Section A — Summary bar (top, always visible)
```
Open: 12   Closed: 34   Win Rate: 68%   Avg Return: +4.2%   Unrealized: +$1,240 est.
```

#### Section B — Open Positions table

| # | Ticker | Strategy | Entry | Entry $ | Now $ | Stock % | Est. P&L | Days | Expiry | Actions |
|---|--------|----------|-------|---------|-------|---------|----------|------|--------|---------|
| 1 | AAPL | CSP | Jun 2 | 189.50 | 194.20 | +2.5% | +$85 est | 4d | Jun 20 | Close · Delete |

- Color code Stock %: green > 0, red < 0 (adjusted for strategy direction)
- "Est. P&L" shows delta-based estimate with "est." label if deltas available, else "—"
- Expiry shows orange when ≤ 7 days, red when ≤ 2 days
- Clicking a row expands to show all legs from StrategyLab

#### Section C — Performance Dashboard

**Strategy accuracy cards** — one per strategy (wheel, bullish, bearish, income, buy):
```
🎡 Wheel     8 trades   Win 75%   Avg +3.8%   ████████░░
🐂 Bullish   5 trades   Win 60%   Avg +2.1%   ██████░░░░
```

**Closed positions table** — scrollable, last 90 days
- Same columns as open positions but with exit date, final return, win/loss badge

---

## Batch Integration

Add `expire-stale-paper-trades` logic to the existing daily brief job or as a step in the
daily batch sequence:
- Call `paperTradingService.expireStalePositions()` once daily
- Looks up the final stock price from `historical_prices` for the expiry date
- Sets status = 'expired', outcome = win/loss, stock_return_pct computed

Alternatively, run on `PaperTradingView` mount (lighter weight, no new job needed).

---

## Key Design Decisions

### Why stock return, not option P&L (for now)

Option P&L requires fetching current option quotes daily for each open position. At 12 open
positions, that's 12 Polygon API calls/day just for paper trading — hits rate limits and adds
complexity. Stock return answers the more fundamental question: **is the brief finding stocks
that move in the right direction?** This is the primary validation goal.

### Why link to brief_id

Preserving the `brief_id` reference lets us compute "brief accuracy" — for a given brief,
what % of picks were profitable? This can be surfaced in the DailyBriefView itself as a
retrospective score on past briefs.

### Auto-expire vs manual close

Positions auto-expire at `expiry_date` using the last available `historical_prices` close for
that date. Users can also manually close early (simulating rolling or cutting losses).

### No buying power / account simulation

Paper trading tracks directional performance, not capital allocation. No account balance,
no margin, no position sizing. One paper trade = one pick from one brief.

---

## Implementation Order

### Session 1 — Data layer
1. DB migration — `paper_trades` table
2. `PaperTradingService` — add, list, close, expire, summary methods
3. IPC handlers + preload

### Session 2 — Daily Brief integration
1. `PaperTradeWithPnl` type (computed from historical_prices)
2. "Add to Paper" button on each PickCard
3. "Already tracking" state (query open positions for today's brief)

### Session 3 — PaperTradingView
1. Summary bar
2. Open positions table with expand-to-legs
3. Close / delete actions

### Session 4 — Performance dashboard + polish
1. Strategy accuracy cards
2. Closed positions table
3. Auto-expire on view mount
4. Brief retrospective score in DailyBriefView history

---

## Acceptance Criteria

- FR-PT-01: Clicking "Add to Paper" on a Daily Brief pick creates a record with full leg context
- FR-PT-02: Open positions show stock return % sourced from `historical_prices` (no API calls)
- FR-PT-03: Positions with a StrategyLab expiry auto-expire within 24h of expiry date
- FR-PT-04: Win rate and avg return are displayed per strategy, updated on every view load
- FR-PT-05: A position can be manually closed with a user-entered exit price and optional note
- FR-PT-06: Brief history view shows a retrospective accuracy score for briefs with ≥ 3 closed trades
- FR-PT-07: No new Polygon API calls are required for Tier 1 P&L tracking
