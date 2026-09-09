import type { SqliteLike } from './sqlite-like.js';

/**
 * Recording which application opened this generation — `meta_open_handle`.
 *
 * The companion to `assertNotRedirected`. That guard **prevents** the one split
 * we understand; this makes any future split **visible**, which the guard on its
 * own cannot do. Both applications call it on open, so a reader that finds only
 * one row — or two rows disagreeing about `db_path` — is looking at file sets
 * that have come apart, and it says so immediately rather than after a
 * corrupted btree.
 *
 * Keyed on **`(app_name, db_path)`**, not on `app_name` alone. One row per
 * application sounds right — the question is "who has this open now" — but the
 * upsert then holds only each app's LATEST open, so a redirected open is
 * overwritten by the next healthy one and the split becomes unaskable.
 *
 * Measured 2026-09-09 on a corrupt generation: the table reported both
 * applications on the same `db_path`, which was true of their last opens and
 * evidence of nothing. With the path in the key, a second row is permanent —
 * an application that ever resolved a different file says so forever, which is
 * the entire reason the table exists.
 */
export interface OpenHandleFacts {
  readonly appName: string;
  readonly appVersion: string;
  readonly dbPath: string;
  readonly dictionaryVersion: number;
  /** ET timestamp; passed in because `core` never reads a clock it did not receive. */
  readonly openedAt: string;
  readonly processId: number;
}

export function recordOpenHandle(db: SqliteLike, facts: OpenHandleFacts): void {
  db.prepare(
    `INSERT INTO meta_open_handle (app_name, app_version, opened_at, process_id, db_path, dictionary_version)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(app_name, db_path) DO UPDATE SET
       app_version = excluded.app_version,
       opened_at = excluded.opened_at,
       process_id = excluded.process_id,
       dictionary_version = excluded.dictionary_version,
       closed_at = NULL`
  ).run(
    facts.appName,
    facts.appVersion,
    facts.openedAt,
    facts.processId,
    facts.dbPath,
    facts.dictionaryVersion
  );
}

/**
 * Records that this application let the generation go.
 *
 * The other half of `recordOpenHandle`, and the table was incomplete without it.
 * Opens alone cannot answer **"did two applications hold this file at the same
 * time"** — the question the table exists for — because two open timestamps are
 * consistent with any amount of overlap or none. On 2026-09-09 that gap meant a
 * corruption investigation had to take "the other app was closed" on
 * recollection, at the exact point where concurrency was the live hypothesis.
 *
 * With a close stamped, an interval that overlaps another row's is two writers,
 * read rather than remembered. A NULL `closed_at` beside a later open elsewhere
 * is itself informative: that process died without closing.
 *
 * Deliberately does NOT fail if the row is absent — a close is a best-effort
 * annotation on the way out, and throwing here would turn "we could not record
 * the close" into "the application could not shut down".
 */
export function recordCloseHandle(
  db: SqliteLike,
  facts: { readonly appName: string; readonly dbPath: string; readonly closedAt: string }
): void {
  try {
    db.prepare(
      'UPDATE meta_open_handle SET closed_at = ? WHERE app_name = ? AND db_path = ?'
    ).run(facts.closedAt, facts.appName, facts.dbPath);
  } catch {
    /* a close annotation must never be the reason a shutdown fails */
  }
}
