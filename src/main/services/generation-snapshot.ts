// A consistent, standalone copy of the TradeAnalyzer 2 generation, taken by the running app.
//
// Why it exists: validating a gate or dictionary change used to cost a day. The only way to
// see what a fix did was the next nightly run, and every night found the next thing, so each
// round took 24 hours. A snapshot lets `packages/core/scripts/rehearse-gate.mjs` run TODAY's
// whole gate and email with the current code within minutes, with both apps still open.
//
// Why the app takes it rather than a script copying the file: `VACUUM INTO` runs inside a read
// transaction on the connection the app already uses, with the same SQLite library, so the copy
// is consistent even while TradeAnalyzer 2 holds the WAL. A script opening the live generation
// is exactly the second-library / redirected-shell hazard CLAUDE.md records at length. The copy
// is a single rollback-journal file under ~/.tradeanalyzer/rehearsal — not %APPDATA%, so no
// MSIX redirect applies — and nothing else ever opens it, so a rehearsal writing into it can
// corrupt nothing and escalate nothing in the real generation.

import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Snapshots kept; older ones are pruned so the directory cannot grow without bound. Two, not
 * five (v1.1.356): each is a full copy of the generation (5.2 GB on 2026-10-13, growing about
 * 240 MB a night), and a rehearsal only ever reads the newest — the second is there for a
 * before/after comparison.
 */
const KEEP = 2;

export interface SnapshotDb {
  prepare(sql: string): { run(...params: unknown[]): unknown };
}

export interface GenerationSnapshot {
  path: string;
  bytes: number;
  generation: number;
  takenAt: string;
  pruned: string[];
}

/**
 * Copies `db` to `<dir>/gen-NNN-<stamp>.sqlite`. `stamp` is an ET timestamp from the caller
 * (never `toISOString()`, which would date an evening snapshot tomorrow).
 */
export function snapshotGeneration(db: SnapshotDb, dir: string, generation: number, stamp: string): GenerationSnapshot {
  mkdirSync(dir, { recursive: true });
  const safeStamp = stamp.slice(0, 19).replace(/[:T]/g, '-');
  const name = `gen-${String(generation).padStart(3, '0')}-${safeStamp}.sqlite`;
  const path = join(dir, name);
  rmSync(path, { force: true }); // VACUUM INTO refuses an existing file; a same-second retake replaces it
  db.prepare('VACUUM INTO ?').run(path);

  const snapshots = readdirSync(dir)
    .filter((f) => /^gen-\d{3}-.*\.sqlite$/.test(f))
    .sort()
    .reverse();
  const pruned: string[] = [];
  for (const old of snapshots.slice(KEEP)) {
    rmSync(join(dir, old), { force: true });
    pruned.push(old);
  }
  return { path, bytes: statSync(path).size, generation, takenAt: stamp, pruned };
}
