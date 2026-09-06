# TradeAnalyzer rebuild — discovery Q&A

> **Working document.** This tracks the requirements-discovery conversation for the ground-up rebuild.
> Status per question: `OPEN` (no answer yet), `ANSWERED` (answer recorded, may need follow-up), `CLOSED` (agreed, feeds the spec).
> Answers arrive one at a time across sessions. **Always append, never rewrite an answer** — if the user revises one, add a dated revision line under it.
> Next document after this one: `NewApp/requirements/01-purpose-and-principles.md` (written only once enough questions are CLOSED).

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

### Q5 — Domains in scope for stage 1  `CLOSED`
**Question.** Proposed raw layer: daily bars, end-of-day quotes, option chains, corporate actions (splits, dividends), earnings dates, fundamentals, VIX + a few macro series, E*Trade positions/balances/executed orders. Out of scope: news, insider transactions, AI outputs. Add or remove anything?
**Answer (2026-09-04).** Agree with the proposed scope. **Final stage-1 raw domains (with Q16):** daily bars, end-of-day quotes, option chains, corporate actions (splits, dividends), earnings dates, fundamentals, VIX + macro series, E*Trade positions/balances/executed orders, ticker reference data, trading calendar, macro event calendar, risk-free rate. Out: news, insider transactions, AI outputs.
**User question — is this everything an app that picks the best trading opportunities will need?** Audit against what the current engine actually consumes found **four small gaps**, all cheap, proposed as Q16. Everything else the current scoring/analysis uses is *derivable* from the listed raw domains (SMA/RSI/ADX/realized vol/beta/relative strength from bars; IV rank from daily chain snapshots once a year has accumulated; own-at-strike from bars + book; earnings proximity from the calendar; sector momentum from sector ETFs, which are inside the universe).
**Framing note.** Stage-1 scope is the **input** side. Picking good trades also needs the **decision record** — what was considered, what was picked, why, and what happened — which is what Q6 (old app's picks) starts and what stage 2 makes central. Outcomes are derivable from point-in-time inputs, so nothing is lost by deferring them, *provided the inputs are stored point-in-time*.

### Q6 — Recording the old app's decisions  `CLOSED`
**Question.** Should the collector store what the old app recommended each day (brief picks, dice pick, exact legs) as observations in the new DB, so the new data can later grade them?
**Recommendation.** Yes.
**Answer (2026-09-04).** Agree, with two refinements:
1. **Store the complete data needed for analysis**, unlike the current app, which persists only survivors. Concretely, per brief run: the **full candidate set** (every ticker considered, with every gate's pass/fail and reject reason — the losers), the **signal values and composite inputs** per candidate as computed at decision time, the **exact legs as priced** (strike, expiry, bid/ask/mid, IV, Greeks, OI, volume), the **dice eligibility and selection trace**, the **critic input and verdict**, the run's `slot`, and the pick that was actually emailed.
2. **Segregation.** This is external reference information, kept in **separate tables** (own prefix, e.g. `legacy_*`, each row stamped with the source app version and run id), never mixed with or joined into the new app's own raw/derived tables by default. It exists so the new data can grade the old app's decisions, nothing more.
**Consequence for D1.** The old app does not currently expose its losers or its full decision trace, so capturing "complete" data needs a **small data-capture change in the old brief job** (hand the full candidate set + trace to the collector). This is inside D1's "data-capture fixes" exception; it must not change what the old app decides or emails.

### Q7 — Historical backfill  `CLOSED`
**Question.** SMA200 / 52-week range need ~250 days of bars on day one. Accept a one-time whole-range fetch of adjusted bars from Polygon, discontinuity-validated on arrival, as clean? Same for a one-time IV-history backfill?
**Recommendation.** Yes for bars (a single full fetch does not have the incremental-split bug). No for IV history unless the source is trustworthy.
**User questions (2026-09-04).** (a) Bars: Polygon API or import from the old app's table? (b) IV history: source or old app's table? (c) Note: some one-time-fetch subscriptions from the old app's start may have lapsed; the user is willing to re-subscribe if that is what accuracy and completeness need.
**Findings.** Old `historical_prices`: 2021-05-20 → today, 1,136 tickers (universe is 1,587 — ~450 have no bars at all), and it is the table with the measured 153 split discontinuities, repaired incrementally, with ticker-reuse cases truncated by hand. Old `iv_history` is **three stitched sources with different methods**: IVolatility 262k rows (2025-05-29 → 2026-05-29, one-time backfill), MarketData.app 1k rows (2 days), and 70k rows since 2026-06-01 computed by the old app's own `daily-iv-update` from E*Trade chains. No raw responses were archived for any of them.
**Recommendation (final).**
- **Bars: Polygon API, never the old table.** One whole-range fetch per ticker today returns a series adjusted consistently as of today; the raw responses are archived (provenance the old table never had); discontinuity + volume-regime checks run on arrival and flag ticker-reuse cases before they are accepted. Cost ≈ 1,600 calls once, well inside the Stocks Starter plan (which carries multi-year history). Depth: fetch the full depth the plan allows (5 years) — it is one call either way and long history is what studies want.
- **IV history: neither the old table nor a stitched backfill by default.** Three methods spliced at two dates is precisely the "second thoughts" situation D6 forbids. Default plan: the new layer computes its own 30-day constant-maturity ATM IV from every day's chain snapshot with one documented method from day one; IV rank/percentile are **explicitly unavailable** (a declared gap, shown as such) until 252 trading days have accumulated.
- **Optional bootstrap (Q17):** if a year without IV rank is unacceptable, re-subscribe to **one** source (IVolatility was the bulk of the old backfill) for a one-time pull, stored as a **separate, source-labelled external series** with its method documented and the stitch date recorded, used only to bootstrap rank until own history overtakes it. Never merged into the own-computed series.
**Closed (2026-09-05)** with Q17: bars from Polygon API (full plan depth); IV own-computed from day one plus a one-time segregated external bootstrap.

### Q8 — Unit and type conventions  `CLOSED`
**Question.** Proposed rule: storage holds the mathematical form (IV as decimal fraction 0.3882, yields as fractions, money as decimal USD per share, dates as ISO strings in one declared timezone); formatting only in the UI; every column has a data-dictionary entry stating unit, nullability and what null means. Agree, or prefer percentages in storage?
**Answer (2026-09-05).** Agree with the recommendation.
**Conventions locked for the spec.** IV, yields, returns, rates, deltas → decimal fractions. Money → decimal USD **per share** (contract multiplier applied only in derived/UI layers). Quantities → integers (shares, contracts, open interest, volume). Dates → `YYYY-MM-DD` trading-day in **America/New_York**; timestamps → ISO-8601 with explicit offset (`2026-09-05T17:02:11-04:00`), never naive. Booleans → 0/1 integers. Every column has a data-dictionary row: type, unit, allowed-null (yes/no), **null meaning** (e.g. "provider omitted field", "outside capture window", "not applicable") — where more than one meaning is possible, a companion status column, not a bare null. Provider values are converted **once, at ingestion**, with the raw value preserved in the archived response; no conversion ever happens downstream.

### Q9 — Definition of a quality gate  `CLOSED`
**Question.** Proposed per-run quality report stored alongside the data: row count vs expected, null count per field vs declared allowed nulls, range-check failures, cross-source disagreements (Polygon close vs E*Trade last), discontinuity checks. A failing day is marked unusable, not deleted. Matches your bar? Anything else to check?
**Answer (2026-09-05).** Agreed.
**User question — how are issues alerted and resolved as soon as possible? Exception report by email?** Yes, and alerting is only half of it; the resolution workflow is proposed as Q18.

### Q10 — Providers and budget  `CLOSED`
**Question.** Keep Polygon Stocks Starter, E*Trade, SEC EDGAR, Finnhub as-is? Would you pay for a dedicated corporate-actions or options-history source if it removed a class of doubt, or strictly forward-only on current subscriptions?
**Recommendation.** Keep current subscriptions. Corporate actions: use Polygon's splits + dividends endpoints (on the current plan) first; add a paid source only if the quality gate shows Polygon missing actions.
**Answer (2026-09-05).** Agree, keep current subscriptions. **Ongoing** providers: Polygon, E*Trade, Finnhub (+ SEC EDGAR, free). **One-time subscriptions are acceptable whenever historical accuracy/completeness needs them** (as with the IV history last time).
**Policy recorded — one-time historical loads.** The Q17 pattern is the standard for *any* one-time load: one source per domain; raw responses archived so the load is reproducible after the subscription lapses; stored as a **segregated, source-labelled external series** with method documented; recorded stitch date; overlap check against own-captured data stored in the quality report before acceptance; never merged into own-captured tables. Candidates for later stages (not stage 1): **historical option chains** (would let stage-2 backtests reach before own capture began), **historical earnings dates** (past-report studies), **historical constituents** (survivorship-free universe history).

### Q11 — Repository layout  `CLOSED`
**Question.** New repo, or a new package inside this repo so shared code is imported rather than copied?
**Recommendation.** Same repo, `packages/` workspace: `core` (shared), current app, new app. Copying code means fixing the same E*Trade bug twice.
**Answer (2026-09-05).** Agree with the recommendation.
**Layout constraints recorded (to protect D1).**
- **The old app is NOT moved.** It stays at the repo root exactly as it is; the root `package.json` gains a `workspaces` entry pointing at `packages/*`. Relocating 76k lines under `packages/legacy/` would touch every import path and build script for zero benefit.
- `packages/core` — shared, **Electron-free, dependency-light** TypeScript (E*Trade transport + OAuth, rate limiter, formulas, unit conventions/data dictionary types, the collector). Must run under plain Node so Vitest and scripts can import it without the Electron ABI. Code moves from the old app into `core` **only when the collector needs it**, and the old app then imports it from `core` — one implementation, two hosts.
- `packages/next` (working name) — the new exe: its own electron-vite build, its own SQLite file, its own migrations, own `package.json` version line.
- Both Electron apps carry the better-sqlite3 ABI swap scripts; `core` itself never links a native module directly.
- Path aliases (`@shared/*`) were the reason plain-node harnesses could not import the real services (CLAUDE.md quirk) — `core` uses **package imports only**, no path aliases.

### Q12 — Stack for the new exe  `CLOSED`
**Question.** Electron + React + SQLite + Vitest again, or is anything on the table?
**Recommendation.** Same stack; separate SQLite file for the new DB from day one.
**Answer (2026-09-05).** Agree with the recommendation.
**User question — can useful data (settings, ETF list, ...) be copied from the old DB to the new one?** Technically trivial (same SQLite engine; `ATTACH DATABASE` or a script). The real question is *what* may cross under D4 — proposed as a category policy in Q19.

### Q13 — Personal book  `CLOSED`
**Question.** Are real E*Trade positions, fills and cash balances part of stage 1 (so P&L history is captured correctly from the start), or a later stage?
**Recommendation.** Capture the **raw broker records daily from day one** — positions snapshot, account balances, executed orders (the fills), and the `/transactions` fallback for dividends/fees/corporate actions — because they cannot be recovered later if E*Trade's order-history window closes. **Defer the derived layer** (pairing opens to closes, lot construction, realised/unrealised P&L, assignment-as-conversion) to stage 2, built on months of clean fills.
**Answer (2026-09-05).** Agree with the recommendation.
**Capture notes for the spec.** Positions are a **daily snapshot** (never overwritten; a position that disappears is detected by comparing snapshots, not by deletion). Executed orders are **append-only keyed by broker order id** (idempotent re-pull; the first pull reaches back as far as E*Trade's window allows and that reach is recorded). Balances one row per day. All via the old app's `etradeGet` path under Q4; the account key is masked in logs as today; success bodies are archived to the raw store (which, unlike the API log, is not plaintext-with-retention — the raw archive for account data must be protected the same way as credentials, see Q20).

### Q14 — Timeline pressure  `CLOSED`
**Question.** Collector capturing raw data within ~2 weeks so history accumulates while design continues, or complete design document as the gate before any collection?
**Recommendation.** Design the raw layer + quality gate first, start capturing early; derived layers and UI depth designed while it runs.
**Answer (2026-09-05).** Agree. **The early collection is a pilot / provisional run**: if data issues are found, it must be possible to reset to a clean slate and start over.
**Design consequences recorded.**
- **Data generations.** The new DB file and its raw archive live under a generation directory (`gen-001/`, `gen-002/`, ...). A **reset is a first-class, deliberate operation** in the new UI: it closes the current generation and opens the next one. The old generation is **kept, never deleted** (renamed aside, read-only) so it can be compared against or mined for what went wrong.
- **Re-derive before reset.** Two different failures, two different remedies: if the *raw capture* was wrong (wrong parameters, missed expirations, misread field), reset. If only the *parsing/schema/derivation* was wrong, do **not** reset — **replay the raw archive into a fresh DB** with the fixed code. That replay path is a required, tested feature of the collector, not an emergency script; it is the reason the archive exists.
- **Config survives a reset.** The legacy import (Q19) and any configuration made in the new exe are re-runnable/exportable, so a reset costs data-days only, never setup.
- **Pilot exit criterion.** The pilot generation becomes the production generation when it has run **20 consecutive trading days with zero unresolved blocking exceptions** and the operator has visually inspected every domain at least once (D5). Until then everything is provisional and no downstream stage consumes it.
- Until the pilot exits, the expiration bound (Q2) and chain-subset thresholds (Q15) are tunable without a reset — a change of capture rule is recorded per snapshot, so it widens coverage forward rather than invalidating what was captured.

---

## Follow-up questions raised by answers
_(numbered Q15+, appended as they arise)_

### Q15 — Option-chain coverage within the universe  `CLOSED`  (raised by Q1)
**Question.** Q1 sets the universe at ~1,587 tickers. Does the daily **option-chain** capture cover all of them, or a subset? Cost reference (from sizing notes): E*Trade serves one expiration per call, so full-universe chains at 90 DTE ≈ **15,000 calls/day** vs ≈ 2,400 for a ~300-ticker subset. At the current app's observed pace that is a multi-hour nightly fetch, which also raises the odds of a mid-run token dormancy.
**Recommendation.** Chains for a defined subset: every ticker that is optionable **and** passes a cheap liquidity screen computed from the bars/quotes already captured (e.g. price ≥ $10, average dollar volume above a threshold), re-evaluated daily and versioned like the universe itself. That keeps coverage rule-based (no hand-curated list) while bounding the fetch. If you want full-universe chains regardless, Q2 (depth) must shrink to compensate.
**Addendum (2026-09-04).** A rule-based subset has the same "uncapturable past" property as a strike band: a ticker failing the screen today has no chain history when it becomes a candidate next month. So the screen must be generous and the **sticky rule applies at the ticker level**: once a ticker has been captured it stays in the chain set (not dropped for dipping below threshold); removal only on delisting / loss of optionability / explicit operator action, and every add/remove is recorded with its date and reason.
**Answer (2026-09-04).** Agree with the recommendation; apply the sticky rule at the ticker level. Concrete screen thresholds (price floor, dollar-volume floor) to be set in the spec with a measured count of how many tickers they admit.

### Q16 — Four additions to the stage-1 raw layer  `CLOSED`  (raised by Q5)
**Question.** Confirm adding these to the Q5 scope:
1. **Ticker reference data** — sector, industry, market cap, shares outstanding, primary exchange, optionable flag, security type (stock/ETF), name. The current engine's `sectorMomentum` / `sectorWeakness` signals and the risk governor's sector cap depend on the sector tag; sizing needs market cap. Source: Polygon ticker details (already used). Versioned like the universe (sector reclassifications happen).
2. **Trading calendar** — market holidays, early closes, standard monthly expiration Fridays. Needed for DTE, "is today a trading day", and validating that a captured expiration is real. Tiny table; source: exchange calendar (static + yearly refresh).
3. **Macro event calendar** — FOMC, CPI, PPI, jobs report dates. The old app seeds these by hand in a migration (`macro_events`, 033); the new layer should store them with a source and an as-of date so a rescheduled event is a new row, not an edit.
4. **Risk-free rate series** — 13-week T-bill or similar daily yield. E*Trade supplies Greeks, but any *reproduction* of Greeks/IV from stored prices (which the "never in doubt" principle implies we must be able to do) needs the rate used. One number per day.
**Recommendation.** Add all four. Combined cost: a few dozen calls per day and negligible storage.
**Answer (2026-09-04).** Agree, add all four.

### Q17 — IV-history bootstrap subscription  `CLOSED`  (raised by Q7)
**Question.** Is a year without IV rank/percentile (until 252 days of own chain snapshots exist) acceptable, or should one external IV-history source be re-subscribed for a one-time bootstrap? If bootstrap: which source (IVolatility supplied the old backfill; MarketData.app is the alternative), stored as a segregated, source-labelled series with a recorded stitch date, never merged with the own-computed series.
**Recommendation.** Bootstrap from one source only if the wheel scoring is expected to be rebuilt on the new data within the first year (it uses IV rank). Otherwise accept the declared gap — a clean own-computed year is worth more than a spliced one.
**Answer (2026-09-05).** Agree; the user will subscribe to one source for a one-time load.
**Spec requirements that follow.** (1) Source choice deferred to the spec (IVolatility vs MarketData.app — pick on documented method, depth and per-ticker coverage of the Q15 chain set; one source only). (2) The pull is a **one-shot job with archived raw responses**, stored in its own `ext_iv_history_*` series carrying source, method description and as-of date. (3) A **recorded stitch date**; rank/percentile computations read external rows only for dates before it and own-computed rows after, and the UI labels any rank that used external rows. (4) The subscription can lapse after the pull — the archived raw makes the load reproducible without it. (5) Overlap check: run the own-computed method against the external series over any overlapping days and store the disagreement statistic as part of the quality report before the bootstrap is accepted.

### Q18 — Exception alerting and resolution workflow  `CLOSED`  (raised by Q9)
**Question.** Confirm this design for turning quality-gate findings into fixes:
1. **Every finding is a first-class record** (`exceptions` table): id, run id, domain/table, ticker or key, check name, severity, detail, first seen, last seen, state. States: `open` → `acknowledged` → `resolved` (with how) or `accepted` (a known, explained condition — e.g. a genuine 40% move — with an expiry date so it is re-examined, per the 30-day TTL lesson in CLAUDE.md).
2. **Severity decides the day's fate.** `blocking` → that domain's day is marked unusable for downstream use until resolved or accepted; `warning` → usable, flagged; `info` → recorded only.
3. **An exception never ages out silently.** It appears in every report until its state changes. Resolved exceptions are kept (audit), never deleted.
4. **Daily email after every collector run — including green days.** A one-screen status: per-domain row counts vs expected, new/open/resolved exception counts, blocking items first with a one-line cause each. Silence must never be the signal — a dead scheduler and a clean day look identical without a green email (the old app's evening chain was halted 8 of 10 days before anyone noticed). Reuse the old app's nodemailer path.
5. **Exceptions view in the new UI** (D5): filter by state/severity/domain, acknowledge/resolve/accept with a note, drill to the offending rows in the inspector. This is where resolution happens; email is the nudge.
6. **Auto-remediation only where the fix is deterministic and additive**: e.g. a discontinuity triggers an automatic whole-range re-fetch and re-check; a missing ticker triggers one retry. The exception records what was attempted. **Never** auto-delete or auto-overwrite; anything ambiguous (ticker reuse vs real move) stays for the operator.
7. **Escalation for repeat offenders**: the same check failing for the same key on N consecutive runs is promoted one severity level and called out separately in the email.
**Recommendation.** Adopt all seven.
**Answer (2026-09-05).** Agree, adopt all seven.

### Q19 — What may be copied from the old database  `CLOSED`  (raised by Q12)
**Question.** Confirm this category policy for a one-time, explicit **"Import from legacy"** action in the new exe (logged: source table, row count, date; every imported row stamped `origin = 'legacy_import'`; import runs while the old app is closed, or via a write-capable attach — WAL quirk):
1. **User-authored configuration — COPY.** Non-secret settings, watchlists, conviction stocks + bands, ETF list, universe/constituents list, scoring-strategy configs, screen presets, payoff strategies. This is your intent, not provider data. Each row is **validated against the new data dictionary on import** and rejected rows are listed (the old conviction table held inverted bands for three weeks — the import must catch that, not carry it).
2. **Secrets — DO NOT COPY.** E*Trade keys/tokens are DPAPI-encrypted and, under Q4, the old app keeps making the calls in stage 1. When the new exe later takes over, credentials are re-entered, not migrated.
3. **Provider-sourced market data — DO NOT COPY** (bars, quotes, chains, IV, earnings, fundamentals, corporate actions). D4/Q7: refetch from source under the new rules.
4. **Your book (positions, fills, balances) — DO NOT COPY; RE-SYNC** from E*Trade executed orders into the new schema. The old rows include "estimated from last mark" P&L that real fills proved wrong in both directions; the source of truth is the broker, and it is still available.
5. **Old app's stored decisions (62+ briefs, picks, dice picks, replays) — COPY INTO `legacy_*` ONLY**, marked `pre_collector = 1` (survivors-only, incomplete). Segregated per Q6, it is the only record of those decisions and costs nothing to keep.
**Recommendation.** Adopt the five categories.
**Answer (2026-09-05).** Agree, adopt the five categories.

### Q20 — Protection of the raw archive for account data  `CLOSED`  (raised by Q13)
**Question.** The raw-response archive (sizing notes) stores every provider response verbatim. For E*Trade **account** endpoints (positions, balances, orders, transactions) that means your holdings and cash in clear text on disk — exactly what the API log deliberately never stores. Options: (a) encrypt the account-domain archive files at rest with the same OS keychain (DPAPI) mechanism as the credentials; (b) archive account responses with account key masked and balances/quantities intact (still sensitive); (c) do not archive account responses at all — store only the parsed rows in the DB (which is itself unencrypted).
**Recommendation.** (a). The archive is the provenance layer and account data needs provenance as much as market data (the estimated-P&L saga proves it); encrypting one directory is cheap. The SQLite file stays unencrypted (as today) — the threat model is "a file copied off the machine", and the archive is the only place where *complete* raw statements would sit.
**Answer (2026-09-05).** Agree, option (a).
**Spec note.** Encryption key from Electron `safeStorage` (DPAPI on Windows), same as `secure-settings.ts`; encrypted files carry a header naming the mechanism so a decrypt failure is diagnosable; the inspector decrypts on read in-process and never writes a decrypted copy to disk; a backup of the archive is only readable on the same Windows user account — document this as a known limitation of DPAPI (restoring on a new machine requires re-pulling from E*Trade, which is why the pull is idempotent).

### Q21 — Sentiment-side data domains  `CLOSED`  (raised while writing 02)
**Question.** The operator asked whether the twelve domains hold every data point needed to judge "is this stock worth owning at this price" (financials, technicals, valuation, trend, sentiment). Audit (02 §12): financials, trailing valuation, technicals, volatility regime, options-implied sentiment and ownership/quality are all covered or derivable. **Three gaps**, all structured and provenance-clean: (1) **short interest** (FINRA twice-monthly via Polygon or Finnhub); (2) **analyst view** — recommendation trend and, if the plan allows, EPS/revenue consensus estimates (Finnhub), which is the only route to *forward* valuation (forward P/E, PEG); (3) **insider transactions** (SEC Form 4), excluded by Q5 as "news" but actually structured EDGAR data the existing app already parses. **News sentiment stays out** — unstructured and model-dependent, it cannot meet D6.
**Recommendation.** Add all three as raw domains (tables drafted in 02 §12); a few calls per day each. If Finnhub estimates turn out to be premium-only, forward valuation is recorded as a declared gap rather than approximated.
**Answer (2026-09-05).** Agree, add all three. Stage-1 raw domains are now **fifteen**; 02 §12 promoted from "proposed" to in-scope.

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
| 2026-09-04 | Q5 ANSWERED (scope agreed); completeness audit raised Q16 (reference data, trading calendar, macro calendar, risk-free rate). |
| 2026-09-04 | Q16 CLOSED (all four added); Q5 CLOSED with the final 12-domain list. |
| 2026-09-04 | Q6 CLOSED: record old app's decisions, complete (incl. losers + trace), in segregated `legacy_*` tables. |
| 2026-09-04 | Q7 ANSWERED with findings (old iv_history is three spliced sources; ~450 universe tickers have no bars); Q17 raised (IV bootstrap subscription). |
| 2026-09-05 | Q17 CLOSED (one-time external IV bootstrap, user will subscribe); Q7 CLOSED. |
| 2026-09-05 | Q8 CLOSED (mathematical-form storage; data dictionary with null meanings). |
| 2026-09-05 | Q9 CLOSED (per-run quality report); Q18 raised (exception alerting + resolution workflow). |
| 2026-09-05 | Q18 CLOSED (all seven adopted). |
| 2026-09-05 | Q10 CLOSED (current subscriptions ongoing; one-time historical subscriptions allowed under the Q17 pattern). |
| 2026-09-05 | Q11 CLOSED (same repo; old app stays at root; packages/core + packages/next). |
| 2026-09-05 | Q12 CLOSED (same stack, separate DB file); Q19 raised (legacy copy policy by category). |
| 2026-09-05 | Q19 CLOSED (five-category legacy import policy). |
| 2026-09-05 | Q13 CLOSED (raw broker records daily from day one; P&L derivation deferred); Q20 raised (encrypting the account-data raw archive). |
| 2026-09-05 | Q20 CLOSED (account-domain archive encrypted at rest via safeStorage/DPAPI). |
| 2026-09-05 | Q14 CLOSED (early pilot collection; data generations + reset + raw replay; 20-day exit criterion). **All Q1–Q20 CLOSED.** |
| 2026-09-05 | Documents moved to `NewApp/`. **Document 01 (purpose and principles) drafted** — P1–P15, AC-1–AC-15, glossary, traceability. |
| 2026-09-05 | **Document 02 (raw domains + data dictionary) drafted** — conventions, meta/ref/raw/ext/derived/legacy tables, expected-count model, verify list. Q21 raised (short interest, analyst view, insider transactions). |
| 2026-09-05 | Q21 CLOSED (all three added → 15 raw domains). |
| 2026-09-05 | **Document 03 (quality gate + exceptions) drafted** — 60+ checks (QC-001…954), severity/usability model, exception lifecycle, 7 permitted remediations, status email + watchdog, pilot-exit procedure. |
| 2026-09-05 | **Document 04 (collector) drafted** — CollectorHost seam, 10-phase daily run (~4,600 calls, ~35 min from 17:05 ET), per-response archive+ingest contract, capture rules v1, sticky sets, one-shot jobs (seed/backfill/bootstrap/import/replay/reset), legacy hand-off payload, failure semantics, QC-412/413 from the measured log (34 % chain 400s, 1,383 renews/day), pre-pilot checklist. |
| 2026-09-05 | **Document 05 (inspector UI) drafted** — 15-section IA, schema-driven inspector (null glyphs, version mode, quality overlay, provenance viewer), 7 bespoke views, exceptions workbench, dictionary + pilot-exit checklist, jobs with scaled confirmations, NFRs (worker-thread queries, write-capable WAL, decrypt-in-memory), typed IPC surface. |
| 2026-09-05 | **Document 06 (repository, packaging, cut-over) drafted** — workspace layout (old app unmoved), core purity rules, next exe (distinct userData, no migrations: dictionary-generated DDL, additive-only within a generation), shared data-root pointer, the complete D1 change list for the old app, versioning/release, test placement, build order B1–B10, definition of done. **Document set 01–06 complete (draft v1).** |
| 2026-09-05 | Open items closed: `SqliteLike` interface for `core` (06 §10/§11); `docs/formulas.md` not bundled; `productName` = **TradeAnalyzer 2**; watchdog stays collector-only (03 §10); deep-link grammar fixed (05 §11.1); no grid library; saved questions confirmed for B9. Remaining open items are the † thresholds and the 04 §11 measurements only. |
