# AI Portfolio Advisor — E*Trade Sync & Position Analysis

## Overview

Pull live positions from E*Trade into the Portfolio screen, then provide AI-driven recommendations on exit strategy, roll opportunities, and optimization for each position — acting as a private advisor that helps you make money.

## Current State

- **E*Trade OAuth** is fully implemented (`etrade-auth.ts`) — request token, access token, signing, renewal
- **E*TradeDataProvider** exists for options chains
- **Portfolio view** exists but is purely manual — add/close positions by hand
- **Analysis engine** already computes SMA, RSI, ATR, ADX, IV, suitability scores
- **Settings** already has E*Trade credential management (consumer key/secret, OAuth flow)

## E*Trade API Capabilities

The `/v1/accounts/{accountIdKey}/portfolio` endpoint returns rich position data:

- **Stock positions**: symbol, quantity, pricePaid, current price, marketValue, totalGain, totalGainPct, daysGain, costPerShare, pctOfPortfolio
- **Option positions**: symbol, callPut, strikePrice, expiry, premium, Greeks (delta, gamma, theta, vega, rho, IV)
- **Lots** (when `lotsRequired=true`): individual lot cost basis, acquired date, remaining qty
- **Account totals**: totalMarketValue, totalGainLoss, cashBalance
- **Fundamentals** (with `view=COMPLETE`): PE, EPS, dividend yield, market cap, 52-wk range, beta

Supporting endpoints:
- `GET /v1/accounts/list` — list all accounts
- `GET /v1/accounts/{id}/portfolio` — positions for an account
- `GET /v1/accounts/{id}/transactions` — transaction history
- `GET /v1/accounts/{id}/balance` — account balances

---

## Phase 1 — E*Trade Position Sync

### Goal
Replace manual position entry with a one-click sync that pulls all positions from E*Trade.

### Features

1. **"Sync E*Trade" button** in the Portfolio header (next to "Add Position")
2. Pulls all accounts via `/v1/accounts/list`
3. Fetches portfolio for each account via `/v1/accounts/{id}/portfolio?totalsRequired=true&lotsRequired=true&view=COMPLETE`
4. Maps E*Trade positions into the local positions table:
   - Stocks: `positionType = 'Stock'`, `quantity`, `entryPrice = pricePaid/costPerShare`, `currentPrice`, `unrealizedPnl`, etc.
   - Options (CSP/CC): `positionType = 'CSP' | 'CC'`, `strikePrice`, `expirationDate`, `premiumReceived`, Greeks
   - Use `positionId` from E*Trade as a unique key for upsert (avoid duplicates on re-sync)
5. Updates `currentPrice` and `unrealizedPnl` for existing positions on each sync
6. Shows sync status (last sync time, number of positions updated)
7. Account selection — if multiple accounts, let user pick which to sync

### DB Schema Changes

Extend the `positions` table with:
- `etrade_position_id` (integer, nullable) — E*Trade positionId for upsert matching
- `etrade_account_id` (text, nullable) — which E*Trade account
- `market_value` (real, nullable) — current market value from E*Trade
- `total_gain_pct` (real, nullable) — total gain/loss percentage from E*Trade
- `days_gain` (real, nullable) — today's gain/loss dollar amount
- `days_gain_pct` (real, nullable) — today's gain/loss percentage
- `cost_per_share` (real, nullable) — average cost per share
- `pct_of_portfolio` (real, nullable) — position weight in portfolio
- `delta` (real, nullable) — option delta
- `gamma` (real, nullable) — option gamma
- `theta` (real, nullable) — option theta
- `vega` (real, nullable) — option vega
- `iv` (real, nullable) — implied volatility (percentage)
- `beta` (real, nullable) — stock beta
- `last_synced_at` (text, nullable) — timestamp of last E*Trade sync

### IPC Channels

- `portfolio:syncEtrade` — trigger full sync, returns sync results
- `portfolio:syncStatus` — get last sync time and status

### UI Changes

- "Sync E*Trade" button in portfolio header
- Progress indicator during sync
- Last synced timestamp shown
- Positions table gains new columns: Market Value, Day Gain, % of Portfolio
- Greeks columns for options positions (Delta, Theta, IV)
- Visual indicator showing which positions came from E*Trade vs manual entry

---

## Phase 2 — Per-Position Analysis

### Goal
Run the existing analysis engine against each synced position to produce structured recommendations.

### Features

1. **"Analyze" button** per position row (or bulk "Analyze All" for open positions)
2. For each position, run relevant analysis:
   - **Stocks**: SMA trend, RSI, support/resistance, volume profile, fundamentals
   - **CSPs**: Delta decay status, IV rank (is IV collapsing = good time to close/roll?), breakeven distance, assignment risk
   - **CCs**: Assignment probability (delta proximity), remaining premium vs time decay, roll-up/out opportunity
   - **All**: Earnings proximity check, beta-adjusted risk
3. Store analysis results linked to the position (new `position_analysis` table)
4. Show analysis summary inline in the positions table (color-coded score/badge)
5. Clicking a position expands a detail panel with the full analysis

### Analysis Output Per Position

```typescript
interface PositionAnalysis {
  positionId: number;
  ticker: string;
  positionType: 'Stock' | 'CSP' | 'CC';
  analyzedAt: string;

  // Technical signals
  trend: 'bullish' | 'bearish' | 'sideways';
  rsi: number | null;
  smaStack: { sma20: number | null; sma50: number | null; sma200: number | null };
  supportLevel: number | null;
  resistanceLevel: number | null;

  // Position-specific
  daysInPosition: number;
  currentReturnPct: number;
  annualizedReturn: number | null;

  // Options-specific (CSP/CC only)
  currentDelta: number | null;
  thetaDecay: number | null;    // daily theta
  ivRank: number | null;
  assignmentRisk: 'low' | 'medium' | 'high' | null;
  rollOpportunity: RollOpportunity | null;

  // Recommendation
  action: 'hold' | 'close' | 'roll' | 'hedge' | 'take_profits';
  conviction: 1 | 2 | 3;       // 1=low, 2=medium, 3=high
  explanation: string;           // natural language explanation
}

interface RollOpportunity {
  type: 'roll_out' | 'roll_up' | 'roll_down' | 'roll_out_and_up';
  currentStrike: number;
  suggestedStrike: number;
  currentExpiry: string;
  suggestedExpiry: string;
  estimatedPremium: number;
  estimatedAnnualReturn: number;
}
```

---

## Phase 3 — AI Private Advisor (The Killer Feature)

### Goal
Generate natural language, personalized recommendations — like having a private advisor.

### Features

1. **"Get Advice" button** on the portfolio screen (or per-position)
2. Sends position data + analysis results to an LLM (Claude API)
3. The LLM receives:
   - All open positions with cost basis, P&L, days held
   - Analysis results (trend, RSI, Greeks, earnings proximity)
   - Portfolio-level context (concentration risk, sector exposure)
4. The LLM returns structured advice:
   - Prioritized action items (what to act on now vs. what to watch)
   - Per-position recommendation with specific strike/expiry for rolls
   - Portfolio-level observations (e.g., "You're 60% concentrated in tech — consider diversifying")
   - Risk warnings (earnings approaching, IV expansion, over-concentration)

### LLM Prompt Structure

```
You are a private investment advisor for an options income trader.
Analyze the following portfolio and provide specific, actionable recommendations.

For each position, consider:
- Current P&L and time in position
- Technical trend and momentum
- Options Greeks (if applicable)
- Implied volatility context
- Upcoming earnings dates
- Position sizing relative to portfolio

Provide:
1. Priority-ordered action items
2. Per-position recommendation (hold/close/roll/hedge) with specific parameters
3. Portfolio-level observations on concentration, risk, and optimization
```

### UI for AI Advice

- Expandable advisor panel below the positions table
- Shows prioritized action items with color coding (urgent = red, watch = yellow, good = green)
- Per-position recommendation cards that can be expanded for detail
- "Refresh Advice" button to re-run with latest data
- History of past advice (stored in DB) so the user can see how recommendations played out

---

## Technical Notes

### E*Trade Token Refresh
- E*Trade access tokens expire at midnight ET daily
- After 2 hours of inactivity, tokens go dormant and need renewal
- The sync flow should: (1) attempt API call, (2) if 401, renew token, (3) retry
- Existing `renewAccessToken()` in `etrade-auth.ts` handles this

### Rate Limits
- E*Trade API is rate-limited; batch position fetches carefully
- Cache synced data locally; don't re-fetch unchanged positions
- Background sync could run on a schedule (e.g., every 5 minutes during market hours)

### Data Mapping — E*Trade to Local Schema

| E*Trade Field | Local Field | Notes |
|---|---|---|
| `positionId` | `etrade_position_id` | Unique key for upsert |
| `symbolDescription` | `ticker` | Parse option symbols for strike/expiry |
| `quantity` | `quantity` | |
| `pricePaid` | `entryPrice` | Per-share cost basis |
| `price` / `lastTrade` | `currentPrice` | |
| `totalGain` | `unrealizedPnl` | For open positions |
| `totalGainPct` | `total_gain_pct` | |
| `daysGain` | `days_gain` | |
| `daysGainPct` | `days_gain_pct` | |
| `marketValue` | `market_value` | |
| `positionType` (LONG/SHORT) | position direction | |
| `Product.securityType` | `positionType` | EQ→Stock, OPTN→map callPut |
| `Product.callPut` | CSP or CC | CALL held short = CC, PUT held short = CSP |
| `Product.strikePrice` | `strikePrice` | |
| `Product.expiryDay/Month/Year` | `expirationDate` | |
| Greeks (delta, theta, etc.) | `delta`, `theta`, etc. | From CompleteView |

### Option Symbol Parsing
E*Trade option symbols follow OCC format: e.g., `AAPL250620C00150000` (underlying + expiry + C/P + strike × 1000). Need a parser to extract strike and expiry from the symbol when the structured fields are missing.

---

## Implementation Priority

1. **Phase 1** — E*Trade sync (highest value, unlocks everything else)
2. **Phase 2** — Per-position analysis (leverages existing engine)
3. **Phase 3** — AI advisor (highest impact, requires Phase 2 data)

Phase 1 can ship independently and immediately adds value by replacing manual entry. Phases 2 and 3 build on the synced data.