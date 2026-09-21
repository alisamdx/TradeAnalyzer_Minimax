// Candidate pool resolution (08 §3.1, S12) — the one function `spread-mode.ts` and
// `spread-chain-capture.ts` both call. If they disagreed, a pool would have no captured chains and read
// as "no candidates today" rather than as the plumbing gap it would be.
import { describe, it, expect } from 'vitest';
import { resolvePoolTickers } from '../src/main/services/spread-pools.js';
import { PREMIUM_POOL } from '../src/shared/spread-mode.js';
import { openDatabase } from '../src/main/db/connection.js';
import { runMigrations } from '../src/main/db/migrations.js';
import { MIGRATIONS_DIR } from './helpers.js';

function seed() {
  const db = openDatabase(':memory:');
  runMigrations(db, MIGRATIONS_DIR);
  return db;
}

const snapshot = (db: ReturnType<typeof seed>, runAt: string, rows: unknown[]) =>
  db.prepare(`INSERT INTO analysis_snapshots (run_at, mode, payload_json) VALUES (?, 'wheel', ?)`)
    .run(runAt, JSON.stringify(rows));

const row = (ticker: string, annualizedReturn: number | null, over: Record<string, unknown> = {}) =>
  ({ ticker, annualizedReturn, optionLiquidityScore: 8, lastPrice: 100, ...over });

describe('resolvePoolTickers — brief strategies', () => {
  it('takes picked and capped_out from the latest run of that strategy only', () => {
    const db = seed();
    const cand = db.prepare(
      `INSERT INTO brief_candidates (as_of_date, generated_at, strategy, ticker, composite_score, rank, disposition, slot)
       VALUES ('2026-09-21', ?, ?, ?, 60, 1, ?, 'intraday')`);
    cand.run('2026-09-21T14:00:00Z', 'wheel', 'AAA', 'picked');
    cand.run('2026-09-21T14:00:00Z', 'wheel', 'BBB', 'capped_out');
    cand.run('2026-09-21T14:00:00Z', 'wheel', 'CCC', 'failed_liquidity');   // not validated
    cand.run('2026-09-21T14:00:00Z', 'income', 'DDD', 'picked');
    cand.run('2026-09-20T14:00:00Z', 'wheel', 'OLD', 'picked');             // an earlier run

    expect(resolvePoolTickers(db, 'wheel')).toEqual(['AAA', 'BBB']);
    expect(resolvePoolTickers(db, 'income')).toEqual(['DDD']);
  });

  it('is empty, not broken, when no brief has run', () => {
    expect(resolvePoolTickers(seed(), 'wheel')).toEqual([]);
  });
});

describe('resolvePoolTickers — the premium pool (S12)', () => {
  it('ranks the latest snapshot by annualized return and applies the gates', () => {
    const db = seed();
    snapshot(db, '2026-09-21T21:00:00Z', [
      row('RICH', 60),
      row('MID', 30),
      row('POOR', 5),
      row('THIN', 99, { optionLiquidityScore: 4 }),            // below the liquidity gate
      row('DEAR', 99, { lastPrice: PREMIUM_POOL.maxPrice + 1 }), // above the price cap
      // Absent is not the same as worst: a row with no annualized return is SKIPPED, never sorted as
      // zero, or the pool quietly fills with names that have no premium data at all.
      row('NOPREM', null),
      row('NANPREM', Number.NaN as unknown as number),
    ]);
    expect(resolvePoolTickers(db, 'premium')).toEqual(['RICH', 'MID', 'POOR']);
  });

  it('reads the LATEST snapshot, as the batch runs twice a day', () => {
    const db = seed();
    snapshot(db, '2026-09-21T14:00:00Z', [row('MORNING', 60)]);
    snapshot(db, '2026-09-21T21:00:00Z', [row('EVENING', 60)]);
    expect(resolvePoolTickers(db, 'premium')).toEqual(['EVENING']);
  });

  it(`takes at most ${PREMIUM_POOL.topN}, matching the brief pools' size`, () => {
    const db = seed();
    snapshot(db, '2026-09-21T21:00:00Z',
      Array.from({ length: PREMIUM_POOL.topN + 5 }, (_, i) => row(`T${String(i).padStart(2, '0')}`, 100 - i)));
    const got = resolvePoolTickers(db, 'premium');
    expect(got).toHaveLength(PREMIUM_POOL.topN);
    expect(got[0]).toBe('T00');   // richest first
  });

  it('breaks ties by ticker, not by the order the snapshot happened to store', () => {
    const db = seed();
    snapshot(db, '2026-09-21T21:00:00Z', [row('ZZZ', 40), row('AAA', 40), row('MMM', 40)]);
    expect(resolvePoolTickers(db, 'premium')).toEqual(['AAA', 'MMM', 'ZZZ']);
  });

  it('is empty, not broken, on a missing or unreadable snapshot', () => {
    expect(resolvePoolTickers(seed(), 'premium')).toEqual([]);
    const db = seed();
    db.prepare(`INSERT INTO analysis_snapshots (run_at, mode, payload_json) VALUES ('2026-09-21T21:00:00Z', 'wheel', '{oops')`).run();
    expect(resolvePoolTickers(db, 'premium')).toEqual([]);
  });

  it('accepts the {results: [...]} payload shape as well as a bare array', () => {
    const db = seed();
    db.prepare(`INSERT INTO analysis_snapshots (run_at, mode, payload_json) VALUES ('2026-09-21T21:00:00Z', 'wheel', ?)`)
      .run(JSON.stringify({ results: [row('WRAPPED', 50)] }));
    expect(resolvePoolTickers(db, 'premium')).toEqual(['WRAPPED']);
  });
});
