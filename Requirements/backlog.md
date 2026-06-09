# TradeAnalyzer — Improvement Backlog

> Ideas captured during real-world usage validation. Grouped by theme. Not yet committed to a release — review and prioritize as v1.x planning begins.
>
> Status key: `[ ]` = not started · `[~]` = in progress · `[x]` = done

---

## 🔁 Closing the Feedback Loop

### B-01 · Brief Performance Summary in Brief Header
**Value**: Highest ROI — gives immediate calibration on whether today's picks should be trusted.

Surface last week's brief performance directly in the Daily Brief header, e.g.:
> *"Last week's brief: 4/5 wheel picks +2.1% avg at Day+5 · 2/4 buy picks hit target."*

- Data source: `paper_trade_snapshots` + `daily_briefs` (already populated by existing jobs)
- Retrospect view has the Day+1/Day+5 logic — extract it into a shared helper
- Show per-strategy: hit-rate %, avg return at Day+5, count of picks that closed profitable

Status: `[ ]`

---

### B-02 · Brief Health Trending (Critic Pass Rate Over Time)
**Value**: Shows whether scoring/critic improvements are sticking.

Track pass/caution/flag rates per strategy over time. Display as a small sparkline or text summary in the brief header:
> *"Critic pass rate (last 7 briefs): Wheel 14% → 38% → 55%"*

- Query: `SELECT picks FROM daily_briefs WHERE strategy = ? ORDER BY generated_at DESC LIMIT 7` and count verdict distribution
- No new data needed — everything is in `daily_briefs` today

Status: `[ ]`

---

## 📊 Recommendation Quality

### B-03 · Position-Aware Brief
**Value**: Removes noise — don't recommend what the user already holds.

Cross-reference each brief pick against `positions` (live portfolio) and `paper_trades` (open paper trades). Badge the 1-liner summary row:
- `📂 In Portfolio` — already a live position
- `📝 Paper Active` — open paper trade exists

No filtering needed — just surface the badge so the user can decide. Optionally de-rank or move to a "Already Held" section.

- Data sources: `positions` (status = 'open'), `paper_trades` (status = 'open')
- Check at brief-load time in the renderer (no backend change needed)

Status: `[ ]`

---

### B-04 · Sector Concentration Guard
**Value**: Prevents correlated risk from slipping through when all picks cluster in one sector.

After scoring produces final picks per strategy, add a brief-level warning if ≥ 60% of picks share the same sector:
> *"⚠️ 4/5 wheel picks are Technology — consider diversifying."*

- Sector data from `fundamentals_cache` (payload_json → sector field)
- Surface as a yellow banner above the strategy's pick list in the UI
- Optionally include in AI Critic context so LLM can flag it

Status: `[ ]`

---

### B-05 · sectorMomentum Signal Fix
**Value**: Unlocks a currently null signal across all 5 strategies.

Root cause: `fundamentals_cache` stores SIC description strings (e.g., "Electronic Computers") while `SECTOR_ETF` keys use GICS top-level names (e.g., "Technology"). The lookup always misses.

Fix options (pick one):
1. **SIC-to-GICS lookup table** — map common SIC descriptions to GICS names at scoring time
2. **Store GICS name at ingest** — when `DailyMarketSyncJob` writes to `fundamentals_cache`, also store a normalized `gics_sector` field (Polygon's `sic_description` → map)

Affects: `scoring-service.ts` `loadSectorMomentum()` and `market-sync-job.ts`

Status: `[ ]`

---

### B-06 · Brief-Level Risk Summary per Strategy
**Value**: Quick batch-level health check before drilling into individual picks.

Below each strategy section header, show a one-line aggregate:
> *"Avg IV rank: 62 · Avg DTE: 41 · 2 picks have earnings in window"*

- Computed from the pick array already in memory at render time
- No backend change needed

Status: `[ ]`

---

## ⚡ Friction Reduction

### B-07 · One-Click Paper Trade from Critic PASS
**Value**: Closes the gap between "good pick" and measurable outcome — the feedback loop only works if picks are paper-traded.

On the expanded pick card, when `criticVerdict.verdict === 'pass'`, show a `📝 Paper Trade` button that pre-fills the paper trade dialog with:
- Ticker, strategy, suggested strike/expiry from the pick's signals
- Entry date = today, entry price from `lastPrice`

One click → paper trade opened → snapshot job captures it tonight → Retrospect measures it.

Status: `[ ]`

---

### B-08 · Earnings Pill in the 1-Liner Summary Row
**Value**: Surfaces the most actionable risk without requiring expansion.

`earningsInWindow` is already pre-computed in the critic context. If it is non-null, add a small `⚠️ ERN` pill on the collapsed pick row (next to the critic verdict badge), e.g.:
> `#3 NVDA $142.50  87.2  A (wheel)  ✅ Pass  ⚠️ ERN 18d`

- Renderer-only change — the data is already in `pick.criticVerdict` context or can be added to the `DailyBriefPick` type

Status: `[ ]`

---

## 🎯 Signal Depth

### B-09 · Conviction List Integration in Brief
**Value**: Bridges two siloed views — surfaces when stocks you already believe in appear as brief picks.

When a ticker from `conviction_stocks` appears in the brief, show a ⭐ badge on the summary row. No new data needed — cross-reference at render time.

Optionally: in the AI Critic context, note "this ticker is in the user's conviction list" so the LLM can factor in long-term thesis alignment.

Status: `[ ]`

---

## 🏗️ Infrastructure / Longer Builds

### B-10 · Scoring Weight Auto-Tuning Suggestions
**Value**: The endgame — scoring engine improves itself based on real outcomes.

After sufficient paper trade history (suggest: 30+ closed trades per strategy), analyze which signal weights predicted profitable outcomes. Surface suggestions in Trade Scoring view:
> *"Your 'wheel' breakoutScore weight is 1.2 but picks with high breakoutScore underperformed at Day+5 (n=12). Consider reducing to 0.8."*

- Requires `paper_trade_snapshots` Day+5 returns joined to `daily_briefs` picks + signal scores
- Display as non-blocking suggestions the user can accept or dismiss
- Accepted suggestions auto-update `scoring_strategy_configs`

Status: `[ ]`

---

## Priority Order (suggested)

| # | Item | Effort | Impact |
|---|------|--------|--------|
| 1 | B-07 One-click paper trade from PASS | Small | High — directly feeds feedback loop |
| 2 | B-01 Brief performance summary | Medium | High — calibrates trust in the brief |
| 3 | B-03 Position-aware brief | Small | High — removes noise |
| 4 | B-08 Earnings pill on summary row | Small | Medium — visible risk at a glance |
| 5 | B-04 Sector concentration guard | Small | Medium — catches correlated risk |
| 6 | B-09 Conviction list integration | Small | Medium — bridges two views |
| 7 | B-06 Risk summary per strategy | Small | Medium — batch health check |
| 8 | B-02 Critic pass rate trending | Medium | Medium — improvement tracking |
| 9 | B-05 sectorMomentum fix | Medium | Medium — unlocks missing signal |
| 10 | B-10 Score auto-tuning | Large | High (long-term) |
