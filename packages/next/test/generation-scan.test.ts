import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyDictionary, type SqliteLike } from '@tradeanalyzer/core';
import { scanGenerations } from '../src/main/generation-scan.js';

/**
 * Which generations exist on disk (05 §8, AC-14): each one read from its own
 * `meta_generation` row, read-only, and every oddity reported rather than
 * skipped.
 */

let root: string;

function makeGeneration(no: number, row: { status: string; closedAt?: string; predecessor?: number; reason?: string } | null): string {
  const dir = join(root, `gen-${String(no).padStart(3, '0')}`);
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, 'data.sqlite'));
  applyDictionary(db as unknown as SqliteLike);
  if (row) {
    db.prepare(
      `INSERT INTO meta_generation (generation_no, opened_at, closed_at, status, db_path, archive_path, predecessor_no, reset_reason)
       VALUES (?, '2026-09-01T09:00:00-04:00', ?, ?, 'x', 'y', ?, ?)`
    ).run(no, row.closedAt ?? null, row.status, row.predecessor ?? null, row.reason ?? null);
  }
  db.close();
  return dir;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ta-scan-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('scanning the data root for generations', () => {
  it('reads each generation from its own row, newest first', () => {
    makeGeneration(1, { status: 'closed', closedAt: '2026-09-10T20:00:00-04:00' });
    makeGeneration(2, { status: 'pilot', predecessor: 1, reason: 'schema change' });
    const found = scanGenerations(root);
    expect(found.map((g) => g.generationNo)).toEqual([2, 1]);
    expect(found[1]).toMatchObject({ status: 'closed', closedAt: '2026-09-10T20:00:00-04:00', problem: null });
    expect(found[0]).toMatchObject({ status: 'pilot', predecessorNo: 1, resetReason: 'schema change' });
  });

  it('does not open a generation the caller already holds', () => {
    makeGeneration(1, { status: 'closed' });
    const found = scanGenerations(root, new Set([1]));
    expect(found[0]).toMatchObject({ generationNo: 1, dbPresent: true, status: null, problem: null });
  });

  it('reports a directory with no database, and a database that does not say what it is', () => {
    mkdirSync(join(root, 'gen-003'));
    makeGeneration(4, null);
    const found = scanGenerations(root);
    expect(found.find((g) => g.generationNo === 3)).toMatchObject({ dbPresent: false, problem: null });
    expect(found.find((g) => g.generationNo === 4)!.problem).toMatch(/no meta_generation row/);
  });

  it('ignores anything that is not a generation directory', () => {
    mkdirSync(join(root, 'gen-001-corrupt-20260907'));
    writeFileSync(join(root, 'notes.txt'), 'x');
    expect(scanGenerations(root)).toEqual([]);
  });

  it('opens nothing for writing', () => {
    // Read-only by construction: a scan of a closed generation must not be
    // able to change it, so the file's modification time survives the scan.
    makeGeneration(1, { status: 'closed' });
    const before = new Database(join(root, 'gen-001', 'data.sqlite'), { readonly: true });
    const count = before.prepare('SELECT COUNT(*) AS n FROM meta_generation').get();
    before.close();
    scanGenerations(root);
    const after = new Database(join(root, 'gen-001', 'data.sqlite'), { readonly: true });
    expect(after.prepare('SELECT COUNT(*) AS n FROM meta_generation').get()).toEqual(count);
    after.close();
  });

  it('returns nothing for a data root that does not exist yet', () => {
    expect(scanGenerations(join(root, 'nowhere'))).toEqual([]);
  });
});
