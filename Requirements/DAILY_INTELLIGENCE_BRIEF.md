# Daily Intelligence Brief & Trade Scoring Engine
**Capability Requirements Specification**
Version 1.0
Date: June 2026
Status: Approved for implementation

---

## 1. Purpose & Motivation

The app currently exposes five independent tools for finding trade opportunities:

| Tool | What it does |
|---|---|
| Screener | Strict fundamental filters; returns quality-filtered stock list |
| Opportunity | Ranked candidates by strategy (Wheel, CSP, Spreads, Bullish, Bearish) |
| Filters | RSI, Price Alert, IV, Wheel opportunity lenses |
| Analysis | Multi-mode analysis of a watchlist (Buy, Options Income, Wheel, Bullish, Bearish) |
| Strategy Lab | Deep single-stock validation with AI rationale |

Each tool provides a different angle. Finding "best of best" trades today requires manually working across all five — cross-referencing tabs, copying tickers, re-running analyses. This is time-consuming and error-prone.

**This capability automates that synthesis.** The system runs all relevant engines in a post-market batch job, scores every candidate across all dimensions using configurable expert-backed formulas, and produces a concise **Daily Intelligence Brief** — strategy-specific shortlists with AI-written reasoning. The user reviews the brief instead of manually operating five tools.

---

## 2. Scope

### 2.1 In Scope

- **Trade Scoring Engine** — configurable per-strategy scoring formulas, each a weighted set of signals that produces a 0–100 composite score per ticker
- **Daily Intelligence Batch Job** — post-market scheduled job that runs the full funnel and persists a dated brief
- **Daily Intelligence Brief View** — new screen showing today's brief: top picks per strategy with scores and AI reasoning
- **Trade Scoring Config Page** — dedicated UI to edit signal weights, toggle signals, reset to baseline, and track versions
- **Two new computed signal fields** — `priceMomentumPct` and `breakoutScore` (required for scoring formulas; all other signals already exist)

### 2.2 Out of Scope (deferred to Phase 2)

- Relative Strength vs SPY signal (needs SPY price bars synced first)
- Sector Momentum signal (needs 11 sector ETF bars synced)
- Options volume signal (too expensive per-ticker at scoring time)
- Analyst ratings / target prices (no available data source)
- Automated trade execution based on brief output
- Intraday brief refresh (once-per-day post-market is sufficient)

---

## 3. Architecture Overview

### 3.1 The Funnel

The pipeline is a staged funnel — each stage narrows and enriches the candidate set.

```
Stage 1 — Universe Gate
  Input:  Full universe (S&P 500 + Russell 1000 + ETF, ~1,500 tickers)
  Engine: Screener (strict fundamental filters)
  Output: ~50–100 quality candidates

Stage 2 — Strategy Scoring
  Input:  Stage 1 candidates
  Engine: ScoringService — reads stored analysis snapshots + fundamentals,
          computes composite score per ticker per strategy
  Output: Ranked list per strategy (Wheel / Bullish / Bearish / Income / Buy)

Stage 3 — Filter Overlay
  Input:  Stage 2 ranked lists
  Engine: Apply active Filter signals (IV, RSI, Price Alert, Wheel)
          as score modifiers or confirmation gates
  Output: Filtered + adjusted scores

Stage 4 — Strategy Lab Deep Validation
  Input:  Top 5 per strategy from Stage 3 (≤ 25 tickers total)
  Engine: Strategy Lab validation (live E*Trade chain + scoring)
  Output: Validated setups with leg details and liquidity confirmation

Stage 5 — AI Synthesis
  Input:  Stage 4 results
  Engine: Claude haiku — reads structured ranked data, writes a one-paragraph
          rationale per ticker explaining why it's a top pick today
  Output: Prose reasoning per ticker (~$0.01–0.03 total per daily run)

Stage 6 — Brief Persistence
  Action: Persist complete brief to DB (daily_briefs table)
          with timestamp, expiry (next trading day open), all scores, all reasoning
```

### 3.2 Key Principle: Strategy-Specific Shortlists

The output is NOT a single ranked list of all trades. Different strategies are incomparable — a 30-delta CSP and a momentum breakout have different objectives, risk profiles, and holding periods. The brief is organized into strategy sections:

- **Wheel** — top CSP/CC candidates by suitability + IV + premium yield
- **Bullish** — top directional long / call spread candidates
- **Bearish** — top directional short / put spread candidates
- **Options Income** — top short premium (strangle / iron condor) candidates
- **Buy / Swing** — top stock purchase / swing trade candidates

Each section shows 3–5 picks. The user knows which section is relevant to their current trading intent.

### 3.3 Design Constraints

- **Human still decides**: The brief is a ranked shortlist, not a trade signal. The user reviews and makes the final go/no-go. The system surfaces candidates; the user decides.
- **Temporal validity**: Brief is generated post-market (4:30–5:00pm ET). It is marked with a "valid until" timestamp (next trading day 9:30am ET). Stale briefs are visually flagged.
- **Cost awareness**: Stage 4 caps at 25 tickers (5 per strategy × 5 strategies). Stage 5 AI cost is ~$0.01–0.03 per daily run (Claude haiku at current pricing).
- **Run time target**: Full pipeline should complete within 5–10 minutes post-market.

---

## 4. Trade Scoring Engine

### 4.1 Overview

The `ScoringService` computes a 0–100 composite score for any ticker against any strategy. It reads from existing computed data (analysis snapshots, fundamentals cache, IV history) — no new API calls per ticker.

Configuration is loaded from the `scoring_strategy_configs` DB table. Weights are user-editable. Changes take effect on the next brief generation run.

### 4.2 Data Model

```sql
CREATE TABLE scoring_strategy_configs (
  strategy    TEXT PRIMARY KEY,   -- 'wheel' | 'bullish' | 'bearish' | 'income' | 'buy'
  signals     TEXT NOT NULL,      -- JSON: array of ScoringSignal objects (see 4.3)
  version     TEXT NOT NULL,      -- user-assigned label, e.g. 'baseline_v1', 'tastytrade_adjusted'
  updated_at  TEXT NOT NULL
);

CREATE TABLE daily_briefs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  generated_at TEXT NOT NULL,     -- ISO timestamp
  valid_until  TEXT NOT NULL,     -- ISO timestamp (next trading day 9:30am ET)
  strategy    TEXT NOT NULL,      -- 'wheel' | 'bullish' | 'bearish' | 'income' | 'buy'
  picks       TEXT NOT NULL,      -- JSON: array of BriefPick objects (see 4.4)
  run_meta    TEXT                -- JSON: stage timing, tickers evaluated, costs, errors
);
```

### 4.3 ScoringSignal Schema

Each strategy's `signals` JSON is an array of:

```typescript
interface ScoringSignal {
  key:         string;   // e.g. 'ivRank', 'premiumYield', 'rsi'
  label:       string;   // display name in config UI
  weight:      number;   // 0–100, all signals must sum to 100
  enabled:     boolean;  // disabled signals are excluded; remaining weights auto-normalize
  description: string;   // expert rationale shown as tooltip in config UI
  dataSource:  string;   // where the value comes from (for documentation/debugging)
  direction:   'higher_better' | 'lower_better' | 'target_range';
  targetMin?:  number;   // for target_range signals (e.g. RSI 40–65)
  targetMax?:  number;
}
```

### 4.4 BriefPick Schema

```typescript
interface BriefPick {
  ticker:         string;
  compositeScore: number;        // 0–100 final weighted score
  signals:        Record<string, { raw: number; normalized: number; weight: number }>;
  strategyLabResult?: object;    // Stage 4 Strategy Lab output (legs, strikes, premium)
  aiRationale:    string;        // Stage 5 Claude haiku paragraph
  rank:           number;        // 1-based position in this strategy section
}
```

### 4.5 Baseline Scoring Formulas

These are the expert-backed starting weights. All sourced from tastytrade research (Tom Sosnoff), IBD/CANSLIM methodology (William O'Neil), and McMillan's *Options as a Strategic Investment*.

#### 4.5.1 Wheel (CSP → Covered Call)

*Philosophy: sell premium on quality underlyings when IV is elevated. Source: tastytrade.*

| Signal | Key | Weight | Rationale |
|---|---|---|---|
| IV Rank (30-day) | `ivRank` | **30%** | tastytrade rule #1: IVR < 30 = don't sell. Higher IVR = more edge in premium |
| Premium yield (annualized) | `premiumYield` | **25%** | Premium / strike × (365 / DTE). You're a yield business — this is your return |
| Fundamental quality score | `fundamentalScore` | **20%** | Wheel requires owning the stock — never sell a CSP on a stock you wouldn't hold |
| Technical trend neutral (RSI 40–60, price near MA) | `technicalNeutral` | **15%** | Don't sell puts into a downtrend; neutral trend = safer assignment zone |
| Option liquidity score | `optionLiquidity` | **10%** | Wide bid-ask spreads kill theoretical edge; OI + spread composite |

#### 4.5.2 Bullish (directional long / call spread)

*Philosophy: buy strength, not weakness. Source: IBD CANSLIM, O'Neil.*

| Signal | Key | Weight | Rationale |
|---|---|---|---|
| Price trend (above 50MA + 200MA, ADX > 20) | `trendStrength` | **30%** | Institutional consensus — big money is already positioned long |
| Earnings / revenue growth quality | `earningsGrowth` | **25%** | CANSLIM: EPS + sales growth are the primary fundamental trigger for institutional buying |
| RSI momentum (45–70 zone) | `rsiMomentum` | **20%** | Want momentum without being overextended. Below 45 = lagging; above 70 = chasing |
| Relative performance vs universe | `relativeStrength` | **15%** | Leaders lead — if it's lagging peers in an up move, it's weak |
| Price momentum % (52-week return) | `priceMomentumPct` | **10%** | Confirms sustained directional move, not just a 1-day spike |

#### 4.5.3 Bearish (directional short / put spread)

*Philosophy: confirm deterioration before fading. Mirror of bullish.*

| Signal | Key | Weight | Rationale |
|---|---|---|---|
| Downtrend confirmation (below 50MA + 200MA) | `downtrendScore` | **30%** | Don't fight institutional selling — wait for MA confirmation |
| Fundamental deterioration | `fundamentalWeakness` | **25%** | Earnings-driven declines are sustained; pure technical breakdowns often reverse |
| RSI overbought / rolling over (60–80 zone) | `rsiOverbought` | **20%** | Overextended but not yet collapsed = best short entry window |
| Relative weakness vs universe | `relativeWeakness` | **15%** | Weakest stocks in a weak market fall hardest |
| Price momentum % (inverted — negative = good) | `priceDecayPct` | **10%** | Confirms sustained downtrend, not a brief pullback |

#### 4.5.4 Options Income (short premium — strangles, iron condors)

*Philosophy: pure IV edge. Source: tastytrade. No stock ownership backstop.*

| Signal | Key | Weight | Rationale |
|---|---|---|---|
| IV Rank (30-day) | `ivRank` | **35%** | Higher weight than Wheel: no ownership backstop — IV edge is the entire thesis |
| Premium / max risk ratio | `premiumRiskRatio` | **25%** | tastytrade: credit ≥ 1/3 of spread width. Below that, not worth the risk |
| Underlying trend neutrality (range-bound) | `trendNeutral` | **20%** | Short strangles need the stock to stay in a range; strong trends kill this trade |
| Option liquidity (OI, volume, tight spreads) | `optionLiquidity` | **20%** | Multi-leg structures: slippage compounds. Liquidity is non-negotiable |

#### 4.5.5 Buy / Swing Trade (stock purchase)

*Philosophy: momentum + value hybrid. Source: Zacks momentum factor, O'Neil.*

| Signal | Key | Weight | Rationale |
|---|---|---|---|
| Price momentum % (52-week return) | `priceMomentumPct` | **35%** | Momentum is the strongest documented return factor (Jegadeesh-Titman 1993) |
| Earnings quality (EPS consistency + growth rate) | `earningsGrowth` | **25%** | Fundamental anchor — momentum without earnings support is speculation |
| Breakout quality score | `breakoutScore` | **20%** | Entry timing: price near support, volume anomaly, MA alignment = defined risk entry |
| Relative performance vs universe | `relativeStrength` | **20%** | Confirms the stock is leading, not lagging — buy leaders |

### 4.6 Signal Normalization

Raw signal values have different scales (RSI is 0–100, premium yield is 0–10%, IVR is 0–100, etc.). Each signal is normalized to 0–100 before weighting:

- **Higher-is-better signals** (IVR, premium yield, ADX): `score = clamp((value / max_expected) * 100, 0, 100)`
- **Lower-is-better signals** (D/E ratio, bid-ask spread): `score = clamp((1 - value / max_expected) * 100, 0, 100)`
- **Target-range signals** (RSI 40–65, trend neutral): `score = 100` if in range, decays linearly to `0` at the range boundaries

Normalization constants are defined alongside signal defaults in the baseline config and are not user-editable in v1.

### 4.7 New Computed Fields Required

Two signal fields do not yet exist and must be added to the scoring pipeline:

#### 4.7.1 `priceMomentumPct`
```
(currentPrice - price_52_weeks_ago) / price_52_weeks_ago × 100
```
- Source: `price_history` table (already populated)
- Computed at scoring time; not persisted separately
- Positive = upward momentum (good for Bullish/Buy); negative = downward (good for Bearish, inverted)

#### 4.7.2 `breakoutScore` (0–100 composite)
```
breakoutScore = (
  priceNearSupportScore × 0.4   // price within 3% of nearest support level
  + volumeAnomalyScore    × 0.3  // volume anomaly % > 0 (above-average volume)
  + maAlignmentScore      × 0.3  // price > SMA20 > SMA50 (bullish stack)
)
```
- All three components already exist in `ValidateDashboardResult` / `AnalysisService`
- Computed at scoring time; not persisted separately

---

## 5. Daily Intelligence Batch Job

### 5.1 Trigger

- **Scheduled**: daily at 4:30pm ET (post-market, after last quotes settle)
- **Manual**: "Run Now" button in Batch Jobs view
- Registered as a named batch job: `daily-intelligence-brief`
- Respects the global batch enabled/disabled toggle
- Skips non-trading days (uses existing `isTradingDay()` helper)

### 5.2 Pipeline Steps

```
Step 1: Screen universe
  - Run screener on full S&P 500 + Russell 1000 + ETF universe
  - Use most recent cached fundamentals (no live API calls at this stage)
  - Output: candidates list (pass score ≥ threshold, configurable, default: pass ≥ 60% of filters)

Step 2: Score candidates per strategy
  - For each candidate × each strategy: compute composite score via ScoringService
  - Uses existing stored data: analysis snapshots, fundamentals cache, iv_history
  - No live API calls at this stage
  - Output: ranked list per strategy

Step 3: Apply filter overlay
  - Check active Filters (IV alert, RSI alert, Price Alert, Wheel opportunity)
  - Add +5 bonus points per active matching filter signal (configurable)
  - Re-sort each strategy list by adjusted score
  - Output: adjusted ranked lists

Step 4: Strategy Lab deep validation
  - Take top 5 per strategy (≤ 25 tickers, deduplicated across strategies)
  - Run Strategy Lab validation for each ticker's relevant strategy
  - Requires live E*Trade options chain — 1.1s per ticker, ~30s total
  - Output: validated setups with concrete legs, strikes, premiums, liquidity

Step 5: AI synthesis
  - Call Claude haiku with structured JSON of all top picks across strategies
  - Prompt: role as experienced options trader, write 2–3 sentence rationale per pick
    explaining WHY this specific ticker is the top pick for this strategy today,
    citing the top 2–3 signals that drove its score
  - Output: prose rationale per pick

Step 6: Persist brief
  - Write one daily_briefs row per strategy
  - valid_until = next trading day 9:30am ET
  - run_meta records timing, ticker counts, API cost estimate, any errors
```

### 5.3 Error Handling

- Step 1–3 failures abort the run (no brief generated; error surfaced in Batch Jobs view)
- Step 4 per-ticker failures skip that ticker and use next-ranked candidate
- Step 5 failure (AI unavailable / API key missing): persist brief without AI rationale; mark picks with `aiRationale: null`; show "AI reasoning unavailable" in brief view
- If E*Trade is disconnected: skip Step 4, use Step 3 results as final picks, mark as "unvalidated"

### 5.4 Progress Reporting

Uses the existing `BatchProgressEvent` streaming system. Progress events emitted per stage:
- Stage 1 complete: `"Screened universe: N candidates"`
- Stage 2 complete: `"Scored N tickers across 5 strategies"`
- Stage 4 per-ticker: standard ticker progress events (same as other jobs)
- Stage 5 complete: `"AI synthesis complete"`
- Final: `"Brief generated: N picks across 5 strategies"`

---

## 6. Daily Intelligence Brief View

### 6.1 Layout

New dedicated view, accessible from the sidebar. View name: **Daily Brief**.

```
┌─────────────────────────────────────────────────────────────┐
│  📋 Daily Intelligence Brief    Jun 1, 2026  4:47pm ET      │
│  Valid until Jun 2, 2026 9:30am ET   [Run Now]  [History ▼] │
├─────────────────────────────────────────────────────────────┤
│  ── WHEEL ─────────────────────────────────────────────────  │
│  #1  MSFT  Score 87   [→ Strategy Lab]                      │
│       IVR 72 · Premium yield 2.1% ann · Suitability 8/10   │
│       "Microsoft's elevated IV rank combined with..."        │
│  #2  AAPL  Score 81   ...                                    │
│  #3  META  Score 76   ...                                    │
├─────────────────────────────────────────────────────────────┤
│  ── BULLISH ────────────────────────────────────────────────  │
│  #1  NVDA  Score 91   [→ Strategy Lab]                      │
│       Trend ↑ · RSI 58 · EPS growth 42% · Momentum +67%    │
│       "NVDA's breakout above the 200MA with accelerating..."  │
│  ...                                                          │
├─────────────────────────────────────────────────────────────┤
│  ── BEARISH ─── INCOME ─── BUY/SWING ──────────────────────  │
│  (same pattern)                                              │
└─────────────────────────────────────────────────────────────┘
```

### 6.2 Functional Requirements

**FR-DIB-01**: The brief view must show today's brief if one exists, or a "No brief yet — run the job to generate" empty state with a Run Now button.

**FR-DIB-02**: Each pick shows: rank, ticker, composite score, top 3 signal values that drove the score, AI rationale paragraph (or "AI reasoning unavailable" if null), and a "→ Strategy Lab" button that navigates to Strategy Lab pre-loaded with that ticker.

**FR-DIB-03**: A "valid until" timestamp must be shown. If the current time is past `valid_until`, the brief is marked visually stale ("⚠ This brief is from yesterday — run the job to refresh").

**FR-DIB-04**: A "History" dropdown lets the user view past briefs (last 30 days). Historical briefs are always shown with their original date/timestamp regardless of current date.

**FR-DIB-05**: Each strategy section is collapsible. Collapsed state persists across sessions (localStorage).

**FR-DIB-06**: The "Run Now" button triggers the daily intelligence batch job. Progress is shown in the existing Live Activity panel (same as other batch jobs). The brief view auto-refreshes when the run completes.

**FR-DIB-07**: If the batch job is currently running, the Run Now button shows "Running…" and is disabled.

**FR-DIB-08**: Picks that were validated by Strategy Lab (Step 4) show a "✓ Validated" badge. Picks that skipped validation (E*Trade offline) show "⚠ Unvalidated".

### 6.3 Brief History Retention

- Brief records older than 90 days are auto-pruned (configurable)
- run_meta is retained for debugging regardless of pruning

---

## 7. Trade Scoring Config Page

### 7.1 Location

Dedicated page in the sidebar — **not** buried in Settings. Name: **Trade Scoring**.
Reason: this is strategic configuration, not an app preference. Users will revisit it frequently as they refine their formulas.

### 7.2 Layout

```
┌─────────────────────────────────────────────────────────────┐
│  ⚖ Trade Scoring                                            │
│  Strategy: [Wheel ▼]   Version: baseline_v1   [Reset ▼]    │
├─────────────────────────────────────────────────────────────┤
│  Signal              Weight    Enabled   Description        │
│  ─────────────────────────────────────────────────────────  │
│  IV Rank (30-day)    [30%]━━━━  ☑         "tastytrade..."  │
│  Premium Yield       [25%]━━━━  ☑         "annualized..."  │
│  Fundamental Quality [20%]━━━━  ☑         "wheel req..."  │
│  Technical Neutral   [15%]━━━━  ☑         "avoid puts..."  │
│  Option Liquidity    [10%]━━━━  ☑         "OI + spread..." │
│                      ────                                    │
│                      100%  ← auto-normalizes               │
├─────────────────────────────────────────────────────────────┤
│  [Save as version: ___________]  [Save]   [Reset to Baseline]│
└─────────────────────────────────────────────────────────────┘
```

### 7.3 Functional Requirements

**FR-TSC-01**: The page shows one strategy at a time via a strategy selector (Wheel / Bullish / Bearish / Income / Buy).

**FR-TSC-02**: Each signal shows: label, weight input (number field or slider), enabled toggle, description tooltip with expert rationale and data source.

**FR-TSC-03**: Weights auto-normalize to 100% as the user edits. When a weight is changed, the remaining weight is distributed proportionally among other enabled signals. The total always shows as 100%.

**FR-TSC-04**: Signals can be toggled off without deleting them. Disabled signals are grayed out; their weight redistributes to enabled signals.

**FR-TSC-05**: "Reset to Baseline" reloads the expert-default weights for the selected strategy. Requires confirmation ("This will discard your custom weights for Wheel. Continue?").

**FR-TSC-06**: A version name field lets the user label their current configuration (e.g. "tastytrade_v1", "high_iv_market"). Saving without a name auto-increments (v1, v2, v3…). Version name + last modified date are shown in the header.

**FR-TSC-07**: The description field for each signal must show: expert rationale, data source (which service/field the value comes from), and a note when the signal is a Phase 2 placeholder (shown as disabled and labeled "Available in Phase 2 — [description of what's needed]").

**FR-TSC-08**: Changes saved here take effect on the **next** brief generation run. The page must not trigger a re-run automatically.

---

## 8. Phase 2 Signal Slots (reserved)

These signals are defined in the config schema and appear in the Trade Scoring UI as disabled placeholders with explanatory text. They are not computed in Phase 1.

| Signal | Key | Strategies | What's needed |
|---|---|---|---|
| Relative Strength vs SPY | `relativeStrengthVsSpy` | Bullish, Bearish, Buy | SPY price bars in `price_history` (Polygon fetch, no new endpoints). RS = ticker 90-day return / SPY 90-day return |
| Sector Momentum | `sectorMomentum` | Bullish, Bearish, Buy | 11 sector ETF price bars (XLK, XLF, XLV, XLE, XLI, XLP, XLY, XLB, XLRE, XLU, XLC). Ticker→sector ETF mapping required |

When Phase 2 is built: these slots activate, their weights are set to non-zero, and total weights re-normalize. Existing configs that have these at weight 0 are automatically valid.

---

## 9. Signals Permanently Excluded

These were evaluated and excluded. Do not revisit without a compelling new data source.

| Signal | Reason excluded |
|---|---|
| Options volume per ticker | Requires live options chain call per ticker at scoring time. Too expensive for batch scoring (1,100+ tickers × E*Trade rate limit = hours). |
| Analyst ratings / target prices | No Polygon public endpoint. Requires paid add-on ($50+/month). |
| Full sector momentum (real-time) | Approximated by RS vs SPY in Phase 2. Not worth separate real-time feed. |

---

## 10. Functional Requirements (Summary)

### Scoring Engine
- **FR-SE-01**: `ScoringService.scoreTickerForStrategy(ticker, strategy)` returns a `ScoredTicker` with composite score, per-signal breakdown, and signal values used.
- **FR-SE-02**: Scoring uses only data already present in the local DB — no live API calls.
- **FR-SE-03**: If a required signal's data is missing (e.g. no IV history for a ticker), that signal contributes 0 to the composite score and is flagged `missing: true` in the breakdown.
- **FR-SE-04**: `priceMomentumPct` is computable from `price_history`. If fewer than 252 trading days of history exist, use available history; if fewer than 30 days exist, return null and score = 0.
- **FR-SE-05**: `breakoutScore` is computed from `AnalysisService` outputs and is null / 0 if analysis snapshot is more than 7 days old.

### Batch Job
- **FR-BJ-01**: The job is registered in `BatchService` and appears in the Batch Jobs view with the same schedule/enable/disable controls as existing jobs.
- **FR-BJ-02**: The job completes within 10 minutes on a normal trading day (target: 5 minutes).
- **FR-BJ-03**: If Stage 4 (E*Trade) fails entirely, the job still succeeds and marks all picks as unvalidated.
- **FR-BJ-04**: At most one brief per trading day is generated. Running "Run Now" a second time on the same day overwrites the existing brief for that day (with confirmation prompt in the UI).

### Daily Brief View
- **FR-DIB-01** through **FR-DIB-08**: Defined in Section 6.2.

### Trade Scoring Config
- **FR-TSC-01** through **FR-TSC-08**: Defined in Section 7.3.

---

## 11. Non-Functional Requirements

**NFR-01 Performance**: Scoring N candidates across 5 strategies must complete in < 2 seconds for N ≤ 200, using only cached DB data.

**NFR-02 AI Cost**: Claude haiku calls in Stage 5 must be estimated and logged in `run_meta`. Total AI cost per daily run must not exceed $0.05 under normal operation (≤ 25 picks × ~$0.002/pick).

**NFR-03 Persistence**: Daily briefs are retained for 90 days. The DB must not grow unboundedly — auto-prune on each job run.

**NFR-04 Graceful degradation**: If E*Trade is offline, if AI key is missing, or if IV history is sparse, the pipeline must produce a partial brief rather than failing entirely. Each degradation is labeled in the UI.

**NFR-05 Configurability**: All scoring weights are user-editable via the Trade Scoring Config page with no code changes required.

**NFR-06 Auditability**: Every brief records which scoring config version was active at generation time (stored in `run_meta`). The user can always see "this brief was generated with config version X."

---

## 12. Implementation Phases

### Phase 1 (build now)

1. Migration: `scoring_strategy_configs` + `daily_briefs` tables
2. `ScoringService` with all 5 strategy formulas + normalization
3. `priceMomentumPct` and `breakoutScore` computed fields
4. Baseline config JSON seeded on first run (INSERT OR IGNORE)
5. `DailyIntelligenceBriefJob` batch job (all 6 stages)
6. `ScoringService` IPC handlers (`scoring:get-config`, `scoring:update-config`, `scoring:reset-to-baseline`)
7. Daily Brief view
8. Trade Scoring Config page
9. Sidebar wiring for both new views

### Phase 2 (deferred)

1. Sync SPY price bars → activate `relativeStrengthVsSpy` signal
2. Sync 11 sector ETF bars → activate `sectorMomentum` signal
3. Update scoring baseline weights to include Phase 2 signals

---

## 13. Open Questions / Future Refinements

These are intentionally left open for iterative refinement:

- **Formula tuning**: The baseline weights are expert-derived starting points. After 30–60 days of live use, compare brief picks against actual market outcomes and adjust weights based on hit rate per strategy.
- **Screener threshold for Stage 1**: Default pass threshold (60% of filters) may need adjustment based on how many candidates survive. If too few (< 30), lower threshold; if too many (> 150), raise it or add a minimum screener score.
- **AI prompt refinement**: The Stage 5 prompt will need tuning once real outputs are reviewed. Track prompt versions alongside config versions.
- **Per-strategy top-N**: Default of 5 picks per strategy. May want to allow 3–7 per strategy based on how dense the opportunity set is on a given day.
- **Filter overlay bonus points**: The +5 per active filter is a starting assumption. May need calibration.
