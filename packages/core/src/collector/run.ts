import type { SqliteLike } from '../db/sqlite-like.js';
import { COLLECTOR_VERSION } from '../version.js';
import { DICTIONARY_VERSION } from '../dictionary/index.js';
import type { CollectorHost } from './host.js';

/**
 * The `meta_run` lifecycle — 02 §1, 04 §2, §5.
 *
 * A run is the unit everything else points at: every raw row carries its
 * `run_id`, so "what did this day's collection actually do" is one query rather
 * than an archaeology exercise.
 */

export type RunKind =
  | 'daily'
  | 'backfill_bars'
  | 'bootstrap_iv'
  | 'legacy_import'
  | 'replay'
  | 'manual';

export interface RunHandle {
  readonly runId: number;
  readonly tradingDate: string;
  readonly kind: RunKind;
  readonly startedAt: string;
  /** True when an interrupted run for the same day and slot was resumed rather than started. */
  readonly resumed: boolean;
}

/**
 * Opens a run, or resumes the open one for the same trading date and slot.
 *
 * Resuming rather than starting fresh is what makes a crashed run cheap: the
 * checkpoints in `phase_progress_json` say what is already done, and the
 * per-response dedup hash makes re-ingesting anything that slipped through a
 * no-op (04 §5).
 */
export function beginRun(
  db: SqliteLike,
  host: CollectorHost,
  args: { readonly kind: RunKind; readonly tradingDate: string; readonly slot?: 'after_close' | 'morning' }
): RunHandle {
  const slot = args.slot ?? 'after_close';
  const startedAt = host.nowET();

  const open = db
    .prepare(
      `SELECT run_id, started_at FROM meta_run
        WHERE trading_date = ? AND slot = ? AND run_kind = ? AND status = 'running'
        ORDER BY run_id DESC LIMIT 1`
    )
    .get(args.tradingDate, slot, args.kind) as { run_id: number; started_at: string } | undefined;

  if (open) {
    return {
      runId: open.run_id,
      tradingDate: args.tradingDate,
      kind: args.kind,
      startedAt: open.started_at,
      resumed: true
    };
  }

  const info = db
    .prepare(
      `INSERT INTO meta_run (
         run_kind, slot, trading_date, started_at, status,
         host_app, host_version, collector_version, dictionary_version
       ) VALUES (?,?,?,?,'running',?,?,?,?)`
    )
    .run(
      args.kind,
      slot,
      args.tradingDate,
      startedAt,
      host.hostApp.name,
      host.hostApp.version,
      COLLECTOR_VERSION,
      DICTIONARY_VERSION
    );

  return {
    runId: Number(info.lastInsertRowid),
    tradingDate: args.tradingDate,
    kind: args.kind,
    startedAt,
    resumed: false
  };
}

export function finishRun(
  db: SqliteLike,
  host: CollectorHost,
  run: RunHandle,
  status: 'complete' | 'failed' | 'cancelled',
  gateVerdict?: 'green' | 'amber' | 'red'
): void {
  // `gate_verdict` is the verdict AT THE MOMENT THE RUN FINISHED and is never
  // updated afterwards — a historical fact about the run, not a live usability
  // flag. Usability is `qa_domain_day_status` and only that (03 §4); a stored
  // `usable` column would go stale the first time an exception was resolved the
  // next day.
  db.prepare('UPDATE meta_run SET finished_at = ?, status = ?, gate_verdict = ? WHERE run_id = ?').run(
    host.nowET(),
    status,
    gateVerdict ?? null,
    run.runId
  );
}

/** Ensures a capture rule version exists and returns its id (P6). */
export function captureRuleId(
  db: SqliteLike,
  host: CollectorHost,
  domain: string,
  definition: Readonly<Record<string, unknown>>,
  description: string
): number {
  const definitionJson = JSON.stringify(definition);
  const current = db
    .prepare(
      `SELECT capture_rule_id, definition_json FROM meta_capture_rule
        WHERE domain = ? AND valid_to IS NULL ORDER BY version DESC LIMIT 1`
    )
    .get(domain) as { capture_rule_id: number; definition_json: string } | undefined;

  if (current && current.definition_json === definitionJson) return current.capture_rule_id;

  // A changed rule is a NEW version, never an edit: runs already recorded must
  // keep pointing at what was actually asked for at the time.
  const now = host.nowET();
  const nextVersion =
    ((db.prepare('SELECT MAX(version) AS v FROM meta_capture_rule WHERE domain = ?').get(domain) as
      | { v: number | null }
      | undefined)?.v ?? 0) + 1;

  const write = db.transaction(() => {
    if (current) {
      db.prepare('UPDATE meta_capture_rule SET valid_to = ? WHERE capture_rule_id = ?').run(
        now,
        current.capture_rule_id
      );
    }
    db.prepare(
      `INSERT INTO meta_capture_rule (domain, version, definition_json, description, valid_from)
       VALUES (?,?,?,?,?)`
    ).run(domain, nextVersion, definitionJson, description, now);
  });
  write();

  return (
    db
      .prepare('SELECT capture_rule_id FROM meta_capture_rule WHERE domain = ? AND version = ?')
      .get(domain, nextVersion) as { capture_rule_id: number }
  ).capture_rule_id;
}
