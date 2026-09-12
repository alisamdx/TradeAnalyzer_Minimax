# Pending work — numbered

The one list to work from. **Numbers are permanent**: an item keeps its number when done
(struck through with the date and what closed it) and new items are added at the end, so
"do #13" means the same thing next week as today. Created 2026-09-12 after the pre-pilot
audit. State at creation: existing app **v1.1.239**, `core` **0.6.8**, TradeAnalyzer 2
**0.4.8**, dictionary **v15**, generation **gen-002** (reset 2026-09-12 16:50).

---

## A. Monday 2026-09-14 — pilot day 1

1. **Install the new build and keep TradeAnalyzer running** through 17:05 (daily run) and
   19:30 (watchdog). Open it from `release\win-unpacked\TradeAnalyzer.exe`; status bar
   **v1.1.239**. TradeAnalyzer 2 from `packages\next\release\win-unpacked\TradeAnalyzer2.exe`
   (footer **v0.4.8 · core 0.6.8**).
2. **E\*Trade token valid before 17:05.** A dormant token renews itself; one that expired at
   midnight needs a manual re-login. Settings → Test Connection.
3. **After the ~10:15 brief: confirm the legacy hand-off worked** — its first production
   success since the fix (v1.1.232). TA2 → Data → `legacy_brief_candidate`, filter
   `as_of_date = 2026-09-14`: rows present. `meta_response.parse_status` for it is `ok`.
4. **After the daily run: bring the gate email and the run's checks table** (TA2 → Runs →
   the daily run). Especially QC-205, QC-209 (did the three early SOLS QC-205 findings stop
   firing, and does SOLS 2025-10-30 appear under QC-209?) and QC-904.
5. **Measure the chain phase**: call count, failures, duration (Runs → domains). First
   measurement of 04 §11's pending "expected chain calls/day"; confirms the 120/min E\*Trade
   pace (v1.1.239) holds with no throttling failures and finishes well before 19:15.
6. **Short interest came back?** `raw_short_interest` row count and newest
   `settlement_date`. Rows → do #8. Refusal → do #9.
7. **19:30 watchdog stays quiet** (no NO-RUN email).

## B. Short code follow-ups

8. **Short interest verified** (after #6 returns rows): remove `verify` from
   `raw_short_interest.short_interest` (clears that pilot-exit blocker); remove the pointless
   `skipped('chain subset is empty')` in `runShortInterest` (the sweep is whole-market); fix
   the stale "plan coverage unverified" comments in `ingest/events.ts` and the dictionary.
   Package.
9. **Short interest refused** (after #6): read the actual response. A plan refusal → build the
   FINRA fallback (decided 2026-09-12, 02 §12).
10. **Host timestamps in ET**: `ElectronCollectorHost` stamps `requestedAt`/`respondedAt` —
    and therefore raw `observed_at` — with `toISOString()` (UTC). Switch to `etTimestamp()`.
    Consistent within a table today, so nothing orders wrongly; best done early in the pilot.
11. **`legacy_brief_candidate.composite_score` unit**: declared a fraction ("0–100 stored as a
    fraction"), but both the importer and the live hand-off write the raw 0–100 value.
    Decide: divide by 100 at both writers, or re-declare the column. Both paths together.
12. **Write the measured chain budget into 04 §3/§11** from #5 (calls/day,
    expirations/ticker, duration) and revisit the 120/min pace if it is far from the limit.

## C. Pilot exit — before promotion (20 clean days; earliest ~2026-10-09)

13. **Rule on the backfill findings** (QC-204 / QC-205 / QC-209) after Monday's run
    re-evaluates them. Start with likely ticker reuse: SPCX 2026-06-12, BNY 2026-05-21,
    FIG 2025-07-31, NIQ 2025-07-23, HHH 2023-08-14, SOLS 2025-10-30. Then genuine moves: GME,
    WAL, SMMT, APLD, BMNR. (Draft classification from 2026-09-12 — verify each before ruling.)
14. **Close calls needing a filing check**: QXO 2024-07-24/30 (SilverSun → QXO recap: same
    entity, different business) and JAN 2022-05-31 / 06-07 (unknown).
15. **Weekly replay**: TA2 → Jobs → queue `replay`; TradeAnalyzer → Batch → Collector one-shot.
    First by ~2026-09-18 (QC-956 warns after 7 sessions, ~9/21). Then weekly.
16. **Never-fired checks — rule on each** (TA2 → Pilot exit).
17. **Working thresholds — rule on each**, including QC-209's new `minGapSessions = 20`.
18. **Every gate domain inspected by a person** (TA2 → Pilot exit → inspections).
19. **18 checks specified in 03 but not built** — build or formally de-scope each in 03:
    QC-002 archive integrity, QC-003 dictionary conformance, QC-005 mutation guard,
    QC-006 run completeness, QC-007 capture-rule reference, QC-101 universe drift,
    QC-102 reference staleness, QC-103 sector mapping gap, QC-104 optionability
    contradiction, QC-105 calendar coverage, QC-106 unexpected market status,
    QC-206 series consistency after re-fetch, QC-208 zero-volume day, QC-304 stale snapshot,
    QC-952 fire-count review, QC-953 archive/DB drift, QC-954 exception aging,
    QC-955 threshold distance. Highest value for trusting a "clean day": QC-006, QC-105,
    QC-106, QC-002, QC-005. (Check first whether B10a's Pilot-exit reviews already cover
    QC-952/955 in substance.)
20. **Watch generation integrity** through the pilot — the corruption investigation is
    downgraded, not closed. Run `diagnose-generation.mjs` from an ordinary (non-Claude,
    non-redirected) terminal with both apps closed, e.g. weekly.

## D. Later

21. **IV bootstrap purchase** (IVolatility), ~4 weeks after phase 9 first ran in production —
    i.e. around early October. Ask the vendor first whether history is sold from the signup
    date, which would invert the timing.
22. **Set QC-205 / QC-209 thresholds from the pilot's own distributions.**
23. **FINRA as a cross-source check for short interest** (optional, after #8).
24. **Stage 2** — derived layer and the new app taking over daily use — after promotion.

## E. Existing app (TradeAnalyzer) backlog carried in notes

25. **Validate `WHEEL_MONTHLY_FIRST`** — shipped default-off (v1.1.128); needs a market-hours
    side-by-side run before enabling. Cannot be validated retrospectively.
26. **Bec's strategy — Tier-1 additive work**, starting with a rollability score
    (`docs/Bec/STRATEGY-SUMMARY.md`).
