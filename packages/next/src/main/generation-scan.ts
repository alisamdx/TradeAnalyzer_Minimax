import Database from 'better-sqlite3';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Which generations exist on disk — 05 §8, AC-14 (B9c).
 *
 * No Electron import, so it can be tested with real files. The current
 * generation is described by the caller from its own open handle and is never
 * opened a second time here; every other one is opened **read-only** just long
 * enough to read its own `meta_generation` row, because each generation
 * describes itself and no other file is the authority on what it is.
 */

export interface ScannedGeneration {
  readonly generationNo: number;
  readonly dir: string;
  /** A `gen-NNN` directory with no database — the leftovers of a failed attempt, or a directory made by hand. */
  readonly dbPresent: boolean;
  /**
   * A write-ahead log is present. On a generation nobody has open that means it
   * was not closed cleanly — and a read-only connection may not be able to
   * attach it, so its view could be missing the last writes.
   */
  readonly walPresent: boolean;
  readonly status: string | null;
  readonly openedAt: string | null;
  readonly closedAt: string | null;
  readonly predecessorNo: number | null;
  readonly resetReason: string | null;
  /** Why the row could not be read, when it could not. */
  readonly problem: string | null;
}

const GENERATION_DIR = /^gen-(\d{3,})$/;

export function scanGenerations(dataRoot: string, skip: ReadonlySet<number> = new Set()): readonly ScannedGeneration[] {
  if (!existsSync(dataRoot)) return [];
  const found: ScannedGeneration[] = [];

  for (const name of readdirSync(dataRoot)) {
    const match = GENERATION_DIR.exec(name);
    if (!match) continue;
    const generationNo = Number(match[1]);
    const dir = join(dataRoot, name);
    const dbPath = join(dir, 'data.sqlite');
    const base: ScannedGeneration = {
      generationNo,
      dir,
      dbPresent: existsSync(dbPath),
      walPresent: existsSync(`${dbPath}-wal`),
      status: null,
      openedAt: null,
      closedAt: null,
      predecessorNo: null,
      resetReason: null,
      problem: null
    };
    if (!base.dbPresent || skip.has(generationNo)) {
      found.push(base);
      continue;
    }

    try {
      const db = new Database(dbPath, { readonly: true, fileMustExist: true });
      try {
        const row = db
          .prepare(
            `SELECT status, opened_at, closed_at, predecessor_no, reset_reason
               FROM meta_generation WHERE generation_no = ?`
          )
          .get(generationNo) as
          | { status: string; opened_at: string; closed_at: string | null; predecessor_no: number | null; reset_reason: string | null }
          | undefined;
        found.push(
          row
            ? {
                ...base,
                status: row.status,
                openedAt: row.opened_at,
                closedAt: row.closed_at,
                predecessorNo: row.predecessor_no,
                resetReason: row.reset_reason
              }
            : { ...base, problem: 'no meta_generation row — this file does not say which generation it is' }
        );
      } finally {
        db.close();
      }
    } catch (err) {
      found.push({ ...base, problem: err instanceof Error ? err.message : String(err) });
    }
  }

  return found.sort((a, b) => b.generationNo - a.generationNo);
}
