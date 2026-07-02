import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase, type DbHandle } from '../src/main/db/connection.js';
import { runMigrations } from '../src/main/db/migrations.js';
import { MIGRATIONS_DIR } from './helpers.js';
import {
  extractLoggableScores,
  logStructureLiquidity,
  pruneStructureLiquidityLog,
} from '../src/main/services/structure-liquidity-log.js';

const labResult = {
  scores: [
    { slug: 'big-lizard', grade: 'A+', liquidityScore: 6, setup: { unavailableReason: null, legs: [{ bid: 1.2 }, { bid: 0.8 }, { bid: 0.4 }] } },
    { slug: 'long-call-vertical', grade: 'B', liquidityScore: 9, setup: { unavailableReason: null, legs: [{ bid: 2.1 }, { bid: 0 }] } }, // zero-bid leg
    { slug: 'call-butterfly', grade: 'C', liquidityScore: 3, setup: { unavailableReason: 'no viable strikes' } }, // unavailable → skipped
    { slug: 'iron-condor', grade: 'A', setup: { legs: [{ bid: 0.5 }] } }, // no liquidityScore → null
  ],
};

describe('structure-liquidity-log instrumentation', () => {
  let db: DbHandle;

  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
  });

  afterEach(() => db.close());

  it('extracts only constructible structures, flagging zero-bid legs', () => {
    const rows = extractLoggableScores('MRVL', labResult);
    expect(rows.map((r) => r.slug).sort()).toEqual(['big-lizard', 'iron-condor', 'long-call-vertical']);
    expect(rows.find((r) => r.slug === 'big-lizard')).toMatchObject({ liquidityScore: 6, grade: 'A+', noBidLeg: false });
    expect(rows.find((r) => r.slug === 'long-call-vertical')?.noBidLeg).toBe(true);
    expect(rows.find((r) => r.slug === 'iron-condor')?.liquidityScore).toBeNull();
  });

  it('persists rows with ET date and uppercased ticker', () => {
    logStructureLiquidity(db, extractLoggableScores('mrvl', labResult));
    const stored = db.prepare(`SELECT * FROM structure_liquidity_log ORDER BY slug`).all() as Array<Record<string, unknown>>;
    expect(stored.length).toBe(3);
    expect(stored[0]!['ticker']).toBe('MRVL');
    expect(String(stored[0]!['date_et'])).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(stored.find((r) => r['slug'] === 'long-call-vertical')!['no_bid_leg']).toBe(1);
  });

  it('prunes rows older than the retention window and keeps recent ones', () => {
    logStructureLiquidity(db, extractLoggableScores('MRVL', labResult));
    // Backdate one row past the 120-day window.
    db.prepare(`UPDATE structure_liquidity_log SET captured_at = '2020-01-01T00:00:00.000Z' WHERE slug = 'big-lizard'`).run();
    pruneStructureLiquidityLog(db);
    const slugs = (db.prepare(`SELECT slug FROM structure_liquidity_log`).all() as Array<{ slug: string }>).map((r) => r.slug);
    expect(slugs).not.toContain('big-lizard');
    expect(slugs.length).toBe(2);
  });

  it('no-ops cleanly on an empty extraction (validation returned nothing loggable)', () => {
    logStructureLiquidity(db, extractLoggableScores('XYZ', { scores: [] }));
    logStructureLiquidity(db, extractLoggableScores('XYZ', null));
    const n = (db.prepare(`SELECT COUNT(*) n FROM structure_liquidity_log`).get() as { n: number }).n;
    expect(n).toBe(0);
  });
});
