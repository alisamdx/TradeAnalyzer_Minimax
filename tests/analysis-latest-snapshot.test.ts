// Regression: batch jobs save the wheel panel as a GLOBAL snapshot (watchlist_id NULL), and
// listSnapshots filters `watchlist_id = ?`, so the API could never return it. The only way a
// script could read the live panel was to open the SQLite file — which, from an MSIX-redirected
// shell, is the WAL-moving open CLAUDE.md warns about. getLatestSnapshotByMode backs
// GET /api/v1/analysis/snapshots/latest. see CHANGELOG v1.1.220.

import { describe, expect, it } from 'vitest';
import { openDatabase, type DbHandle } from '../src/main/db/connection.js';
import { runMigrations } from '../src/main/db/migrations.js';
import { MIGRATIONS_DIR } from './helpers.js';
import { AnalysisService } from '../src/main/services/analysis-service.js';

function setup(): { db: DbHandle; svc: AnalysisService } {
  const db = openDatabase(':memory:');
  runMigrations(db, MIGRATIONS_DIR);
  const svc = new AnalysisService(db, {} as never, {} as never, {} as never);
  return { db, svc };
}

function insert(db: DbHandle, watchlistId: number | null, mode: string, runAt: string, tag: string): void {
  db.prepare(
    `INSERT INTO analysis_snapshots (watchlist_id, mode, result_count, payload_json, run_at)
     VALUES (?, ?, 1, ?, ?)`
  ).run(watchlistId, mode, JSON.stringify({ jobRunId: null, results: [{ ticker: tag }] }), runAt);
}

describe('getLatestSnapshotByMode', () => {
  it('returns a global (watchlist_id NULL) snapshot, which listSnapshots cannot', () => {
    const { db, svc } = setup();
    const wl = Number(db.prepare(`INSERT INTO watchlists (name) VALUES ('W')`).run().lastInsertRowid);
    insert(db, wl, 'wheel', '2026-05-14 03:41:23', 'OLD');
    insert(db, null, 'wheel', '2026-09-10 21:05:00', 'GLOBAL');

    const snap = svc.getLatestSnapshotByMode('wheel');
    expect(snap?.watchlistId).toBeNull();
    expect(JSON.parse(snap!.payloadJson).results[0].ticker).toBe('GLOBAL');
    // The defect: no watchlist id reaches the NULL row.
    expect(svc.listSnapshots(0).length).toBe(0);
  });

  it('filters by mode and breaks run_at ties by id', () => {
    const { db, svc } = setup();
    insert(db, null, 'buy', '2026-09-11 13:00:00', 'BUY');
    insert(db, null, 'wheel', '2026-09-10 21:05:00', 'FIRST');
    insert(db, null, 'wheel', '2026-09-10 21:05:00', 'SECOND');

    expect(JSON.parse(svc.getLatestSnapshotByMode('wheel')!.payloadJson).results[0].ticker).toBe('SECOND');
    expect(svc.getLatestSnapshotByMode('bearish')).toBeNull();
  });
});
