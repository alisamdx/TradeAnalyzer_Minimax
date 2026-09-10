-- 082 — the two SCHEDULED collector jobs go back on. The one-shot stays manual.
--
-- Migration 080 switched all three off after the collector emailed a RED gate
-- report 70 times in one day. Both causes are gone: the 2-minute claim loop —
-- the actual emitter — was deleted in v1.1.206, and the generation has since
-- survived four consecutive clean `universe_seed` runs (v1.1.211-215).
--
-- **Why this is necessary and not merely safe.** The pilot's 20-clean-day exit
-- criterion and the IV bootstrap's 20-paired-day overlap both advance only on
-- days the collector actually runs. Left manual, they advance when somebody
-- remembers — and 20 *consecutive* days is exactly the thing intermittent
-- attention cannot produce.
--
-- `collector-oneshot` is deliberately NOT re-enabled. It carried the retry loop,
-- and a one-shot is operator-initiated by nature: it has nothing to do on a
-- schedule. Its Run button is unaffected — `BatchService.runJob` has never
-- consulted `enabled`, so "off" means "does not start on its own".
--
-- The two are switched together on purpose. The watchdog exists to email when
-- no daily run happened, so with the daily run off it would alarm every night
-- about a run nobody scheduled; with it on, it is the thing that notices a
-- swallowed day. Enabling one without the other is incoherent in both
-- directions.
UPDATE batch_jobs
   SET enabled                = 1,
       daily_schedule_enabled = 1,
       run_on_startup         = 0
 WHERE id IN ('data-collector', 'collector-watchdog');

-- Left explicitly alone, so the omission reads as a decision rather than a
-- forgotten row.
-- UPDATE batch_jobs SET enabled = 1 WHERE id = 'collector-oneshot';
