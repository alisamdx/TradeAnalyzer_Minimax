// The same-day rehearsal loop starts from a snapshot the running app takes of the TradeAnalyzer 2
// generation. It must be a consistent standalone copy, must leave the source untouched, must not
// date an evening snapshot tomorrow, and must not let the directory grow without bound.
// see CHANGELOG v1.1.256.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { snapshotGeneration } from '../src/main/services/generation-snapshot.js';

let dir: string;
let source: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ta-snap-'));
  source = new Database(join(dir, 'data.sqlite'));
  source.pragma('journal_mode = WAL');
  source.exec('CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1), (2), (3);');
});

afterEach(() => {
  source.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('snapshotGeneration', () => {
  it('copies committed WAL content into a standalone file and leaves the source alone', () => {
    const snap = snapshotGeneration(source, join(dir, 'rehearsal'), 2, '2026-09-16T21:30:05-04:00');
    expect(snap.path.endsWith('gen-002-2026-09-16-21-30-05.sqlite')).toBe(true);
    const copy = new Database(snap.path, { readonly: true });
    expect(copy.prepare('SELECT COUNT(*) AS n FROM t').get()).toEqual({ n: 3 });
    copy.close();
    // Writing to the copy never reaches the source.
    const writable = new Database(snap.path);
    writable.exec('DELETE FROM t');
    writable.close();
    expect(source.prepare('SELECT COUNT(*) AS n FROM t').get()).toEqual({ n: 3 });
  });

  it('names the file by the ET stamp it is given, so an evening snapshot is not dated tomorrow', () => {
    const snap = snapshotGeneration(source, join(dir, 'rehearsal'), 2, '2026-09-16T23:59:59-04:00');
    expect(snap.path).toContain('2026-09-16-23-59-59');
  });

  it('keeps the five newest snapshots', () => {
    const target = join(dir, 'rehearsal');
    for (let s = 10; s < 17; s++) snapshotGeneration(source, target, 2, `2026-09-16T21:30:${s}-04:00`);
    const kept = readdirSync(target).sort();
    expect(kept).toHaveLength(5);
    expect(kept[0]).toContain('21-30-12');
    expect(existsSync(join(target, 'gen-002-2026-09-16-21-30-10.sqlite'))).toBe(false);
  });

  it('replaces a same-second retake instead of failing (VACUUM INTO refuses an existing file)', () => {
    const target = join(dir, 'rehearsal');
    snapshotGeneration(source, target, 2, '2026-09-16T21:30:05-04:00');
    source.exec('INSERT INTO t VALUES (4)');
    const again = snapshotGeneration(source, target, 2, '2026-09-16T21:30:05-04:00');
    const copy = new Database(again.path, { readonly: true });
    expect(copy.prepare('SELECT COUNT(*) AS n FROM t').get()).toEqual({ n: 4 });
    copy.close();
  });
});
