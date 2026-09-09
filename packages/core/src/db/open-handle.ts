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
       dictionary_version = excluded.dictionary_version`
  ).run(
    facts.appName,
    facts.appVersion,
    facts.openedAt,
    facts.processId,
    facts.dbPath,
    facts.dictionaryVersion
  );
}
