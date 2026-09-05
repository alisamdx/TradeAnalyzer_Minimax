# TradeAnalyzer rebuild — discovery Q&A

> **Working document.** This tracks the requirements-discovery conversation for the ground-up rebuild.
> Status per question: `OPEN` (no answer yet), `ANSWERED` (answer recorded, may need follow-up), `CLOSED` (agreed, feeds the spec).
> Answers arrive one at a time across sessions. **Always append, never rewrite an answer** — if the user revises one, add a dated revision line under it.
> Next document after this one: `01-purpose-and-principles.md` (written only once enough questions are CLOSED).

Started: 2026-09-04.

---

## Decisions already made (from the opening conversation)

| # | Decision | Date |
|---|---|---|
| D1 | The **existing app stays fully functional and untouched** (except data-capture fixes). It remains the daily driver until the new UI is usable. Nothing is deleted or destroyed. | 2026-09-04 |
| D2 | The rebuild is a **new application with a new exe and a new canvas** that **re-uses existing code** where it is sound (E*Trade transport, formulas, rate limiter, ...). Functions are picked up and migrated/copied one at a time over many sessions. | 2026-09-04 |
| D3 | **Stage 1 is purely data-focused**: capture, store and inspect raw data of unquestionable quality. No analysis, scoring, AI or trading logic in stage 1. | 2026-09-04 |
| D4 | **Fresh data gathering.** No migration of prior stored history into the new database ("poisoned data"). Exception under discussion: one-time whole-range backfills (see Q7). | 2026-09-04 |
| D5 | **Stage 1 is NOT headless.** The new exe ships with a UI from day one; every stored table must be visually inspectable in a section of the UI as the foundation is built. | 2026-09-04 |
| D6 | Quality bar restated (agreed as the working definition): not "100% accurate" (providers can be wrong) but **"never in doubt"** — every stored value traceable to a raw provider response, every gap stored as an explicit gap (never an ambiguous null), every derived number reproducible from raw inputs, every anomaly detected and flagged before anything reads it. | 2026-09-04 |
| D7 | Motivating failures the new data layer must make impossible: NVDA proposed in its earnings week; DINO picked by the dice at a price that made no sense to own; replay always finding a data fault; inconsistent P&L trend figures; values stored null forever; percentage stored where a number was expected. | 2026-09-04 |

## Design implications already accepted

- **Every table gets a view by construction.** A schema-driven inspector reads the data dictionary and renders any table (sort, filter, null highlighting, unit labels, that run's quality flags). Bespoke views only where shape matters (option chain grid, price chart with split markers, earnings calendar).
- **Two apps, one E*Trade session** is a real conflict: one access token per consumer key; a re-auth in one app kills the other's token; both draw on one Polygon rate budget. Q4 resolves who makes the calls.
- If the old app collects and the new exe only reads the new SQLite file, the reader must open it **write-capable** (a readonly connection on Windows silently misses recent WAL writes — see CLAUDE.md quirks).

## Sizing notes (2026-09-04)

- Current production DB: **600 MB after 4 months**, ~1.6M rows in the six large tables (`historical_prices` 622k, `screen_results` 397k, `iv_history` 333k, `structure_liquidity_log` 137k, `options_premium_history` 72k, `paper_trade_snapshots` 47k) → ~370 bytes/row, i.e. heavy JSON blobs. Do not repeat that pattern for queried data.
- SQLite limits: 281 TB theoretical; 10–50 GB routine on a desktop; a few hundred GB workable with indexing + date partitioning. **Storage is not the stage-1 constraint.**
- Real constraints: one writer at a time (WAL → many readers OK); better-sqlite3 is synchronous on Electron's main thread → heavy aggregates in a worker or on indexes; backups/integrity checks scale with file size.
- Projected chain volume/year: 300 tickers × 90 DTE × ±25% strikes ≈ 48M rows ≈ 10 GB; 1,500 tickers same depth ≈ 240M rows ≈ 50 GB; full chains ≈ 150 GB+. Everything else combined < 1 GB/yr. **E*Trade fetch time (one call per expiration: ~2,400 vs ~15,000 calls/day) binds before storage does** → drives Q1/Q2.
- Recommendations: (1) SQLite stays the system of record; **archive every raw provider response compressed on disk** (gzipped JSON-lines per source per day) as the provenance layer — replayable if a schema mistake is found later, ~1/10 the DB size. (2) If year-scale analytics over chains gets slow, add **DuckDB** as a read-only analytics engine over the same data — a later addition, not a stack change.

---

## Questions

### Q1 — Universe  `ANSWERED`
**Question.** Which tickers does the collector capture every day? Full S&P 500 + Russell 1000 + ETFs (as today), or a curated wheel-candidate list of a few hundred? ~10x difference in API load, especially for option chains.
**Recommendation.** Full equity universe for bars/fundamentals; curated subset for option chains; both lists versioned so membership changes are recorded.
**Answer (2026-09-04).** Full S&P 500 + Russell 1000 + ETFs, like today. (Today's `constituents` table holds **1,587** tickers.)
**Notes.** Universe membership must be **versioned** in the new DB (a ticker's entry/exit date recorded, never overwritten) so history is reproducible. Whether the *option-chain* capture also covers the full universe is not stated — see Q15.

### Q2 — Option chain depth  `OPEN`
**Question.** Per ticker per day: all expirations and strikes, or a bounded window?
**Recommendation.** Expirations out to 90 DTE, strikes within 25% of spot, full contract detail as E*Trade returns it (bid, ask, last, volume, open interest, IV, Greeks).
**Answer.** _pending_

### Q3 — Capture timing  `OPEN`
**Question.** One after-close snapshot (~17:00 ET) or also a mid-session snapshot (today's ~10:15 slot)? Every snapshot is stored separately, never overwritten; two slots double option-chain cost.
**Recommendation.** One after-close capture in stage 1, designed so adding a slot is a config change.
**Answer.** _pending_

### Q4 — Who owns the E*Trade token  `OPEN`
**Question.** (a) collector runs as a new batch job inside the existing app's process, writing to the new DB (one token holder, one rate limiter); (b) separate process, old app's E*Trade features switched off; (c) second E*Trade consumer key for the new app.
**Recommendation.** (a) for stage 1 — zero token fights, no double API spend; moves to the new exe when it becomes the daily driver. Note D5: the new exe's UI reads the new DB regardless of who writes it.
**Answer.** _pending_

### Q5 — Domains in scope for stage 1  `OPEN`
**Question.** Proposed raw layer: daily bars, end-of-day quotes, option chains, corporate actions (splits, dividends), earnings dates, fundamentals, VIX + a few macro series, E*Trade positions/balances/executed orders. Out of scope: news, insider transactions, AI outputs. Add or remove anything?
**Answer.** _pending_

### Q6 — Recording the old app's decisions  `OPEN`
**Question.** Should the collector store what the old app recommended each day (brief picks, dice pick, exact legs) as observations in the new DB, so the new data can later grade them?
**Recommendation.** Yes.
**Answer.** _pending_

### Q7 — Historical backfill  `OPEN`
**Question.** SMA200 / 52-week range need ~250 days of bars on day one. Accept a one-time whole-range fetch of adjusted bars from Polygon, discontinuity-validated on arrival, as clean? Same for a one-time IV-history backfill?
**Recommendation.** Yes for bars (a single full fetch does not have the incremental-split bug). No for IV history unless the source is trustworthy.
**Answer.** _pending_

### Q8 — Unit and type conventions  `OPEN`
**Question.** Proposed rule: storage holds the mathematical form (IV as decimal fraction 0.3882, yields as fractions, money as decimal USD per share, dates as ISO strings in one declared timezone); formatting only in the UI; every column has a data-dictionary entry stating unit, nullability and what null means. Agree, or prefer percentages in storage?
**Answer.** _pending_

### Q9 — Definition of a quality gate  `OPEN`
**Question.** Proposed per-run quality report stored alongside the data: row count vs expected, null count per field vs declared allowed nulls, range-check failures, cross-source disagreements (Polygon close vs E*Trade last), discontinuity checks. A failing day is marked unusable, not deleted. Matches your bar? Anything else to check?
**Answer.** _pending_

### Q10 — Providers and budget  `OPEN`
**Question.** Keep Polygon Stocks Starter, E*Trade, SEC EDGAR, Finnhub as-is? Would you pay for a dedicated corporate-actions or options-history source if it removed a class of doubt, or strictly forward-only on current subscriptions?
**Answer.** _pending_

### Q11 — Repository layout  `OPEN`
**Question.** New repo, or a new package inside this repo so shared code is imported rather than copied?
**Recommendation.** Same repo, `packages/` workspace: `core` (shared), current app, new app. Copying code means fixing the same E*Trade bug twice.
**Answer.** _pending_

### Q12 — Stack for the new exe  `OPEN`
**Question.** Electron + React + SQLite + Vitest again, or is anything on the table?
**Recommendation.** Same stack; separate SQLite file for the new DB from day one.
**Answer.** _pending_

### Q13 — Personal book  `OPEN`
**Question.** Are real E*Trade positions, fills and cash balances part of stage 1 (so P&L history is captured correctly from the start), or a later stage?
**Answer.** _pending_

### Q14 — Timeline pressure  `OPEN`
**Question.** Collector capturing raw data within ~2 weeks so history accumulates while design continues, or complete design document as the gate before any collection?
**Recommendation.** Design the raw layer + quality gate first, start capturing early; derived layers and UI depth designed while it runs.
**Answer.** _pending_

---

## Follow-up questions raised by answers
_(numbered Q15+, appended as they arise)_

### Q15 — Option-chain coverage within the universe  `OPEN`  (raised by Q1)
**Question.** Q1 sets the universe at ~1,587 tickers. Does the daily **option-chain** capture cover all of them, or a subset? Cost reference (from sizing notes): E*Trade serves one expiration per call, so full-universe chains at 90 DTE ≈ **15,000 calls/day** vs ≈ 2,400 for a ~300-ticker subset. At the current app's observed pace that is a multi-hour nightly fetch, which also raises the odds of a mid-run token dormancy.
**Recommendation.** Chains for a defined subset: every ticker that is optionable **and** passes a cheap liquidity screen computed from the bars/quotes already captured (e.g. price ≥ $10, average dollar volume above a threshold), re-evaluated daily and versioned like the universe itself. That keeps coverage rule-based (no hand-curated list) while bounding the fetch. If you want full-universe chains regardless, Q2 (depth) must shrink to compensate.
**Answer.** _pending_

---

## Session log
| Date | What happened |
|---|---|
| 2026-09-04 | Opening conversation; D1–D7 decided; Q1–Q14 posed. |
| 2026-09-04 | Sizing notes added. Q1 answered (full universe); Q15 raised (chain coverage). |
