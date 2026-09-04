-- 079: Keep BOTH of a day's batch runs in the candidate pool, and capture leg volume.
--
-- WHY. The batch runs the brief twice every trading day (~10:15 ET and ~17:00 ET) and every
-- consumer so far has treated the after-close run as the day's answer: `scoring-service.saveBrief`
-- deletes the same-ET-day rows before inserting, and this table's unique index collapsed the two
-- runs onto one row per (date, strategy, ticker). Both were deliberate — the morning slot writes a
-- PARTIAL view and the after-close slot must overwrite it (CLAUDE.md, "the batch runs twice a
-- trading day"). The cost of that was invisible until 2026-09-04.
--
-- WHAT IT HID. The dice emails BOTH runs, so the pick the operator reads at 10:35 ET is produced
-- from data that is then destroyed at 17:00 ET. Observed that day: DINO scored liquidity 9/15 in
-- the evening run and 6/15 the next morning — and the score's own components explain the gap
-- without the contract having become any harder to trade:
--
--   evening  K=100.0  OI 112 -> 2.5   volume 27 -> 1.5   spread 7.2% -> 5   = 9.0 -> 9  PASS
--   morning  K= 97.5  OI  77 -> 0.5   volume  0 -> 0     spread 9.2% -> 5   = 5.5 -> 6  REJECT
--
-- The spread — 8 of the 15 points, and the component that actually sets fill cost — did not move
-- a point. What moved was two step-function counters, one of which (same-day VOLUME) is a
-- cumulative counter: at 10:35 ET it holds one hour of tape, at 17:36 ET the whole session. It is
-- monotonic within a day, so the morning run scores systematically lower on up to 3 of 15 points
-- and the ~8/15 gate (MIN_TRADABLE_LIQUIDITY_SCORE) sits in the densest part of the score
-- distribution: across 250 stored wheel picks the mode is exactly 7, one point below the gate.
--
-- None of that is measurable today, because only the evening reading survives. This migration
-- does not change the gate, the formula, or which trades are taken — it only stops discarding
-- the evidence needed to judge them (FR-SEY-5: a rule change needs a replay, and a replay needs
-- a sample). Capture is one-directional: what is not written today cannot be recovered.
--
-- `slot` is a PHASE ('intraday' | 'after_close'), not a clock time, so re-running the same phase
-- still REPLACES rather than accumulating — at most two rows per (date, strategy, ticker), which
-- is exactly the pairing a morning-vs-evening study needs. ~20 MB/trading-year becomes ~40 MB.
--
-- `volume` closes the other half: the liquidity score reads it, and this table stored bid, ask and
-- open_interest but not the one input that varies with WHEN the run happened. Note the score
-- treats a NULL volume as 0 points (`leg.volume ?? 0`) — 23 of 250 stored legs — so the column is
-- nullable on purpose: a study must be able to tell "did not trade" from "not reported".
--
-- see CLAUDE.md "the batch runs twice a trading day", docs/formulas.md#liquidity-score,
--     migrations/076_brief_candidates.sql

ALTER TABLE brief_candidates ADD COLUMN slot TEXT;
ALTER TABLE brief_candidates ADD COLUMN volume INTEGER;

-- Backfill the existing rows from their own timestamp. `generated_at` is UTC; -4h is EDT, which
-- is correct for every row present when this ships (all 2026-09-04) and only ever mislabels a run
-- started within an hour of the 14:00 ET boundary — which no scheduled slot is near.
UPDATE brief_candidates
   SET slot = CASE WHEN CAST(strftime('%H', datetime(generated_at, '-4 hours')) AS INTEGER) < 14
                   THEN 'intraday' ELSE 'after_close' END
 WHERE slot IS NULL;

-- The unique key gains the phase, so the two runs of a day no longer overwrite each other.
DROP INDEX IF EXISTS idx_brief_candidates_unique;
CREATE UNIQUE INDEX IF NOT EXISTS idx_brief_candidates_unique
  ON brief_candidates (as_of_date, strategy, ticker, slot);

-- A morning/evening comparison scans one date across both phases.
CREATE INDEX IF NOT EXISTS idx_brief_candidates_slot
  ON brief_candidates (as_of_date, slot);
