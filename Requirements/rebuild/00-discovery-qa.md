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

### Q1 — Universe  `CLOSED`
**Question.** Which tickers does the collector capture every day? Full S&P 500 + Russell 1000 + ETFs (as today), or a curated wheel-candidate list of a few hundred? ~10x difference in API load, especially for option chains.
**Recommendation.** Full equity universe for bars/fundamentals; curated subset for option chains; both lists versioned so membership changes are recorded.
**Answer (2026-09-04).** Full S&P 500 + Russell 1000 + ETFs, like today. (Today's `constituents` table holds **1,587** tickers.)
**Notes.** Universe membership must be **versioned** in the new DB (a ticker's entry/exit date recorded, never overwritten) so history is reproducible. Whether the *option-chain* capture also covers the full universe is not stated — see Q15.

### Q2 — Option chain depth  `CLOSED`
**Question.** Per ticker per day: all expirations and strikes, or a bounded window?
**Recommendation (original).** Expirations out to 90 DTE, strikes within 25% of spot, full contract detail as E*Trade returns it (bid, ask, last, volume, open interest, IV, Greeks).
**Recommendation (revised 2026-09-04).** Checked `etrade-options.ts`: the provider fetches **one expiration per call with no strike limit**, so E*Trade returns the whole ladder and any strike filter is ours — a strike band saves storage, **not API calls**. Storage is the cheap resource (~2–3× rows, ~25 GB/yr for a 300-ticker subset). Uncaptured chain data is **unrecoverable** on current subscriptions (no historical option quotes source). Therefore:
1. **Capture every strike** E*Trade returns; no moneyness filter.
2. **Bound expirations** (the call-cost lever): e.g. all expirations ≤ 90 DTE plus the two nearest monthlies beyond, to keep LEAPS-shaped history cheaply.
3. **Sticky capture**: any contract ever recommended, held in the book, or flagged for a study stays in the capture set until expiry regardless of DTE/moneyness — closes the "mark disappears on the blow-up day" gap.
4. **Store the capture rule with every snapshot** so an absent contract reads as "outside that day's window", never "unknown".
**Look-back impact of a bounded band (why revised):** replaying own picks and settling at expiry are unaffected; marking a position after a >25% adverse move, tail/skew studies, LEAPS/collar history, and not-yet-asked questions are all lost. Same survivorship shape as the brief storing only winners.
**Answer (2026-09-04).** Agree with the revised recommendation (all strikes; bounded expirations; sticky capture; capture rule stored per snapshot). The exact expiration bound (≤ 90 DTE + two nearest monthlies beyond) is the working default and may be tuned once Q15 fixes the ticker count.

### Q3 — Capture timing  `CLOSED`
**Question.** One after-close snapshot (~17:00 ET) or also a mid-session snapshot (today's ~10:15 slot)? Every snapshot is stored separately, never overwritten; two slots double option-chain cost.
**Recommendation.** One after-close capture in stage 1, designed so adding a slot is a config change.
**Answer (2026-09-04).** Agree: one after-close capture.
**User question — does this affect the morning brief?** Not in stage 1: the old app is untouched (D1) and keeps its two slots; the new layer has no brief yet (D3). For the *future* rebuilt brief the design consequence is recorded here so it is not lost:
- The brief's analysis (screens, scoring, own-at-strike, earnings proximity) is an **end-of-day computation** over the after-close snapshot. Running it on partial intraday data is what made the old morning slot incomparable to the evening one (same-day volume counters, partial daily bar — CLAUDE.md quirks, v1.1.185). Anchoring to the after-close snapshot removes that inconsistency.
- What a morning slot legitimately adds is **fresh prices for a shortlist**: re-quote only the brief's candidates (tens of tickers, a few expirations) at ~10:15 ET and store that as a **separate, slot-labelled snapshot** — never overwriting the after-close data. Cost is a few hundred calls, not a second full-universe capture.
- Schema requirement that falls out: every snapshot row carries `slot` (or capture timestamp + rule id) from day one, so a targeted morning re-quote is a config addition, not a migration.

### Q4 — Who owns the E*Trade token  `CLOSED`
**Question.** (a) collector runs as a new batch job inside the existing app's process, writing to the new DB (one token holder, one rate limiter); (b) separate process, old app's E*Trade features switched off; (c) second E*Trade consumer key for the new app.
**Recommendation.** (a) for stage 1 — zero token fights, no double API spend; moves to the new exe when it becomes the daily driver. Note D5: the new exe's UI reads the new DB regardless of who writes it.
**Answer (2026-09-04).** Agree: option (a).
**Consequences recorded.**
- D1 gets one explicit exception: the existing app gains **a new batch job (the collector)** plus a second SQLite connection to the **new database file**. Nothing else in the old app changes.
- The collector must be written as an **importable package** (ties to Q11), not as code embedded in the old app's services, so moving it into the new exe later is a re-wire, not a rewrite. The old app only hosts it.
- The collector runs on the old app's **rate limiter and E*Trade transport** (`etradeGet` / `sendETradeRequest`) — inheriting the logging, timeout and renew-and-retry behaviour already hardened there.
- Scheduling: the collector is a **separate schedule** (own time, ~17:00 ET or later per the "final daily bar" quirk), not appended to the existing after-close chain, so a multi-hour chain fetch cannot delay the old app's brief or be halted by an upstream job failure. Both share the batch mutex, so they serialize.
- The new exe's UI opens the new DB **write-capable** (WAL quirk) and, in stage 1, only reads it.

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

### Q15 — Option-chain coverage within the universe  `CLOSED`  (raised by Q1)
**Question.** Q1 sets the universe at ~1,587 tickers. Does the daily **option-chain** capture cover all of them, or a subset? Cost reference (from sizing notes): E*Trade serves one expiration per call, so full-universe chains at 90 DTE ≈ **15,000 calls/day** vs ≈ 2,400 for a ~300-ticker subset. At the current app's observed pace that is a multi-hour nightly fetch, which also raises the odds of a mid-run token dormancy.
**Recommendation.** Chains for a defined subset: every ticker that is optionable **and** passes a cheap liquidity screen computed from the bars/quotes already captured (e.g. price ≥ $10, average dollar volume above a threshold), re-evaluated daily and versioned like the universe itself. That keeps coverage rule-based (no hand-curated list) while bounding the fetch. If you want full-universe chains regardless, Q2 (depth) must shrink to compensate.
**Addendum (2026-09-04).** A rule-based subset has the same "uncapturable past" property as a strike band: a ticker failing the screen today has no chain history when it becomes a candidate next month. So the screen must be generous and the **sticky rule applies at the ticker level**: once a ticker has been captured it stays in the chain set (not dropped for dipping below threshold); removal only on delisting / loss of optionability / explicit operator action, and every add/remove is recorded with its date and reason.
**Answer (2026-09-04).** Agree with the recommendation; apply the sticky rule at the ticker level. Concrete screen thresholds (price floor, dollar-volume floor) to be set in the spec with a measured count of how many tickers they admit.

---

## Session log
| Date | What happened |
|---|---|
| 2026-09-04 | Opening conversation; D1–D7 decided; Q1–Q14 posed. |
| 2026-09-04 | Sizing notes added. Q1 answered (full universe); Q15 raised (chain coverage). |
| 2026-09-04 | Q2 CLOSED on the revised recommendation. |
| 2026-09-04 | Q15 CLOSED (rule-based chain subset, sticky at ticker level); Q1 moves to CLOSED since its only follow-up is resolved. |
| 2026-09-04 | Q3 CLOSED (one after-close capture); morning-brief consequence recorded under Q3. |
| 2026-09-04 | Q4 CLOSED (collector hosted in the old app as a batch job, packaged for later move). |
