-- 080 — the NewApp collector jobs become manual-only.
--
-- `registerJob` seeds `batch_jobs` with INSERT OR IGNORE, so the options in
-- `index.ts` only ever apply to a FRESH install. On this machine the three rows
-- already exist with `enabled = 1`, and nothing in code can change that — the
-- same frozen-column trap as `sequence_order`, `config_json` and
-- `after_close_only` before it (v1.1.121, v1.1.123, migration 067).
--
-- Why they are being switched off: gen-001 is malformed, so `finishJob` cannot
-- write a terminal state for a claimed request. The row stays `queued`, the
-- 2-minute claim loop re-claims it, the run fails, the gate emails RED — 70 runs
-- in a day. The loop is removed in the same version; this closes the other three
-- triggers (the orchestrator chain, the daily schedules, startup).
--
-- `enabled = 0` does NOT mean "cannot run". `BatchService.runJob` has never
-- consulted this column, so the Batch view's Run button still works — which is
-- exactly the "these can be manual" the operator asked for. Re-enabling is one
-- toggle per job in that view.
UPDATE batch_jobs
   SET enabled                = 0,
       daily_schedule_enabled = 0,
       run_on_startup         = 0
 WHERE id IN ('data-collector', 'collector-watchdog', 'collector-oneshot');

-- Any request left mid-flight by the removed claim loop is released back to
-- `queued`… except that it lives in the NEW generation's database, not this one,
-- so there is nothing to do here. Recorded so the absence is deliberate rather
-- than an oversight: the collector's queue is `meta_job_request` in
-- `%APPDATA%/trade-analyzer-next/data/gen-NNN/data.sqlite`, and this app's
-- migrations must never reach into it.
