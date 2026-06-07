# Conviction List — Personal Stock Reference
_Created: 2026-06-05 | App version: v0.23.11_

---

## Problem Statement

The default watchlist is temporary and fluid — stocks come and go based on weekly
interest. There is no permanent place to record **personal price conviction** for
stocks the user is willing to own long-term: what price is a comfortable entry, what
price is too expensive to ever touch, and what is the middle ground for experimenting.
This is entirely separate from market sentiment or technical analysis — it is the
user's own reference frame, updated over time as price levels shift.

---

## What It Is

A single, permanent list of stocks the user is willing to put money on, annotated
with personal price bands and a note. Not a watchlist (multiple, temporary, rotating).
Not a journal (diary-style time entries). A **conviction sheet** — a living reference
that captures where you stand on each name at a point in time.

---

## Data Model

### Per Stock (conviction_stocks table)

| Field | Type | Description |
|-------|------|-------------|
| `ticker` | TEXT PK | Stock symbol |
| `price_low` | REAL | Comfortable entry — "I'd buy here anytime" |
| `price_mid` | REAL | Experimental zone — "I'd try a small position" |
| `price_high` | REAL | Never enter above this price |
| `note` | TEXT | Free-text personal thesis / reasoning |
| `added_at` | TEXT | ISO timestamp when stock was added |
| `updated_at` | TEXT | ISO timestamp of last edit |

**Example:**
```
NVDA — low: 180, mid: 190, high: 200
Note: "AI infrastructure play. Strong moat. Only at 180 or below."

TSLA — low: 350, mid: 375, high: 400
Note: "Volatile. Small position only. Never chase above 400."
```

### Band History (conviction_band_history table)

Whenever price bands or note are edited, the previous values are written here.
Not shown on the main screen — accessible via drill-down only.

| Field | Type |
|-------|------|
| `id` | INTEGER PK |
| `ticker` | TEXT |
| `price_low` | REAL |
| `price_mid` | REAL |
| `price_high` | REAL |
| `note` | TEXT |
| `changed_at` | TEXT |

---

## Main Screen Layout (ConvictionView)

### Header
- Title: "My Stocks — Conviction List"
- Count: "12 stocks"
- Buttons: **+ Add Stock**, **Sync from Default Watchlist** (one-time or on-demand)

### Table Columns

| Column | Source | Notes |
|--------|--------|-------|
| Ticker | DB | Clickable — opens Analysis view |
| Current Price | `quote_cache.last` | Live; red/green vs bands |
| Zone | Computed | Badge showing where price sits (see below) |
| Low Entry | `conviction_stocks.price_low` | Editable inline or via modal |
| Mid | `conviction_stocks.price_mid` | |
| High (Never) | `conviction_stocks.price_high` | |
| IV | `iv_history.atm_iv` (latest) | As percentage |
| IV Rank | Computed from `iv_history` | 0–100 |
| Note | `conviction_stocks.note` | Truncated, full on hover |
| Actions | — | ✎ Edit · 🕓 History · 🗑 Remove |

### Zone Badge (most important column)

Computes where the current price sits relative to the user's bands:

| Badge | Condition | Color |
|-------|-----------|-------|
| **✅ Buy Zone** | `currentPrice ≤ price_low` | Green |
| **🟡 Mid Zone** | `price_low < currentPrice ≤ price_mid` | Yellow |
| **🔵 Watch** | `price_mid < currentPrice < price_high` | Blue/gray |
| **🚫 Too High** | `currentPrice ≥ price_high` | Red |
| **— No Bands** | Bands not set | Gray |

### Price Band Visual (optional, Phase 2)
A small inline bar showing the price range (low → high) with a marker for current
price. Similar to a range slider, read-only.

---

## Add / Edit Modal

Fields:
- Ticker (text, uppercase, validated against known universe — read-only on edit)
- Low Entry price
- Mid price  
- High (Never Enter) price
- Note (textarea, ~3 lines)

Validation:
- `price_low < price_mid < price_high` — enforce order, show inline error if violated
- Ticker must be a valid symbol (check against `constituents` or allow free entry)

### FR-CV-05 — System Band Recommendation

A **"Get Recommendation"** button in the Add/Edit modal triggers the app to assess
the ticker using all available analysis data and suggest values for the three price
bands. The user can apply all, apply individual bands, or ignore.

#### Data Sources Used

All data is already in the local DB — no extra API calls:

| Source | Table | Field Used |
|--------|-------|-----------|
| Buy analysis | `analysis_snapshots` | `entryZoneLow`, `smaStack.sma200`, `smaStack.sma50` |
| Current price | `quote_cache` | `last` |
| IV Rank | `iv_history` | computed from last 252 rows |
| Wheel analysis | `analysis_snapshots` | `annualizedReturn`, `suitabilityScore` |

#### Recommendation Algorithm

**Low (Comfortable Entry):**
Priority order:
1. `entryZoneLow` from the most recent buy-mode analysis snapshot — this is the
   app's own computed support/entry zone, making it the most meaningful anchor
2. Fallback: `sma200` rounded to nearest $0.50 — the 200-day MA is a classic
   long-term support level
3. Fallback 2: `currentPrice × 0.85` — 15% below current as a rough floor

**Mid (Experimental):**
1. `sma50` if it falls between Low and `currentPrice` — the 50-day MA is a natural
   "mid-term fair value" reference
2. Fallback: midpoint of `(price_low + currentPrice) / 2`, rounded to nearest $0.50

**High (Never Enter):**
1. `currentPrice × (1 + premiumPct)` where `premiumPct` is scaled by IV Rank:
   - IV Rank < 30 (low volatility): `+20%` — stock is calm, the ceiling is tighter
   - IV Rank 30–60 (normal): `+25%`
   - IV Rank > 60 (elevated): `+30%` — stock is volatile, wider ceiling appropriate
2. Result rounded to nearest $1.00
3. Floor: must be > `price_mid` (enforced automatically)

**Rationale string:** Each recommended value includes a short explanation shown in
the UI so the user understands the basis:
> Low: $180 — from buy analysis entry zone  
> Mid: $191 — SMA 50 (within range)  
> High: $216 — current $180 + 20% (IVR 22, low volatility)

#### UI Flow

```
[ Get Recommendation ]  ← button in modal, disabled if ticker not yet saved or no analysis data

→ Shows recommendation panel below the price fields:

  ┌─────────────────────────────────────────────────────────┐
  │ 💡 System Recommendation                                 │
  │                                                          │
  │  Low:  $180.00   "Buy analysis entry zone"    [Apply]   │
  │  Mid:  $191.00   "SMA 50 (within range)"      [Apply]   │
  │  High: $216.00   "Current +20% (IVR 22)"      [Apply]   │
  │                                                          │
  │  [Apply All]                          [Dismiss]          │
  └─────────────────────────────────────────────────────────┘

Clicking [Apply] on an individual band fills that field.
Clicking [Apply All] fills all three fields at once.
[Dismiss] closes the panel without changing any field.
```

#### Fallback Behavior

- If no analysis snapshot exists for the ticker → show message:
  "Run analysis on this ticker first to get a recommendation"
- If only partial data (e.g., entry zone available but no SMA data) → recommend
  what's available, mark missing items as "—" with note "insufficient data"
- Recommendation is advisory only — user always has final say

---

## Band History Drill-Down

Accessed via the 🕓 button per row. Opens a modal showing:
- Table of historical band snapshots: date changed, old low/mid/high, old note
- Most recent at top
- Read-only — no editing from here

This gives the user a record of when they "moved the frame" up or down over time.

---

## Alert Integration

### FR-CV-01 — Zone change notification
When the app refreshes quotes (Market Sync or manual quote fetch) and a stock
transitions **into Buy Zone** (`currentPrice ≤ price_low`), surface a notification:
> ⚡ NVDA entered your buy zone ($178.40 ≤ $180 target)

### FR-CV-02 — Daily Brief section
Add a **"Conviction Alerts"** section to the Daily Brief (above or below the strategy
picks) listing any conviction stocks currently in Buy Zone or Mid Zone. Format:

```
⚡ Conviction Alerts
NVDA  $178  ✅ Buy Zone   IV: 42%  IVR: 68
TSLA  $362  🟡 Mid Zone   IV: 58%  IVR: 55
```

Only show if at least one stock is in Buy Zone or Mid Zone. Skip section if all are
in Watch or Too High.

### FR-CV-03 — Sidebar badge
If any conviction stock is in Buy Zone, show a small badge (dot or count) on the
"My Stocks" sidebar nav item so it's visible without opening the screen.

---

## Seeding from Default Watchlist

### FR-CV-04 — Sync from Default Watchlist button
A **"Sync from Default Watchlist"** button in the header adds any tickers from the
user's default watchlist that are not already in the conviction list. Price bands
are left blank (null) — the user fills them in. Already-present tickers are not
touched (no overwrite).

This is on-demand, not automatic — the user controls when to pull watchlist tickers in.

---

## Implementation Phases

### Phase 1 — Core CRUD (ship first)
- DB migration: `conviction_stocks` + `conviction_band_history` tables
- `ConvictionView` with table, add/edit modal, delete, band history modal
- Zone badge (computed client-side from stored bands + `quote_cache.last`)
- IV and IV Rank read from existing `iv_history` table
- Sidebar nav entry: "My Stocks" under a suitable section
- FR-CV-05: "Get Recommendation" button in add/edit modal (all data already in DB,
  no new API calls — pure computation from existing analysis snapshots + quote_cache)

### Phase 2 — Alerts
- FR-CV-01: in-app notification on zone entry (triggered from quote refresh path)
- FR-CV-02: Conviction Alerts section in Daily Brief
- FR-CV-03: sidebar badge

### Phase 3 — Polish
- Price band visual bar
- FR-CV-04: Sync from Default Watchlist button
- Clickable ticker → opens Analysis view for that stock

---

## Key Design Decisions

- **Single list, not multiple** — unlike watchlists there is no multi-list concept.
  One conviction sheet per user.
- **Bands are personal, not market-derived** — the Zone badge is purely
  `currentPrice vs user-set bands`. No overlap with technical analysis signals.
- **History is hidden by default** — the main table shows current state only.
  History is one click away but not cluttering the view.
- **Prices refresh from quote_cache** — no extra API calls. The conviction view
  is read-only for prices; Market Sync keeps them fresh.
- **IV and IV Rank come from iv_history** — same source as the rest of the app.
  No new data fetching needed.
