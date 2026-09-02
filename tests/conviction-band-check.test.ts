// Schema-level enforcement of the conviction band ordering (migration 075, v1.1.165).
//
// validateBandOrder() covers every in-app writer; these tests cover the CHECK constraint
// that backs it at the schema level, and the table rebuild that installs it — which has
// to move conviction_band_history out of the way first, because its FK to
// conviction_stocks cascades on delete and PRAGMA foreign_keys=OFF is a no-op inside the
// transaction migrations run in.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type DbHandle } from '../src/main/db/connection.js';
import { runMigrations, listMigrations } from '../src/main/db/migrations.js';
import { MIGRATIONS_DIR } from './helpers.js';
import { ConvictionService } from '../src/main/services/conviction-service.js';

const CHECK_MIGRATION = 75;

/** A DB migrated to just BEFORE the CHECK lands, so violating rows can still be written. */
function preCheckDb(): DbHandle {
  const dir = mkdtempSync(join(tmpdir(), 'conv-mig-'));
  mkdirSync(dir, { recursive: true });
  for (const m of listMigrations(MIGRATIONS_DIR)) {
    if (m.version >= CHECK_MIGRATION) continue;
    copyFileSync(m.fullPath, join(dir, m.fileName));
  }
  const db = openDatabase(':memory:');
  runMigrations(db, dir);
  return db;
}

function applyCheckMigration(db: DbHandle): void {
  const m = listMigrations(MIGRATIONS_DIR).find(x => x.version === CHECK_MIGRATION)!;
  db.exec(readFileSync(m.fullPath, 'utf8'));
}

function migratedDb(): DbHandle {
  const db = openDatabase(':memory:');
  runMigrations(db, MIGRATIONS_DIR);
  return db;
}

function bands(db: DbHandle, ticker: string) {
  return db.prepare(
    'SELECT price_low, price_mid, price_high FROM conviction_stocks WHERE ticker = ?'
  ).get(ticker) as { price_low: number | null; price_mid: number | null; price_high: number | null };
}

describe('migration 075 — installing the CHECK', () => {
  it('normalises a pre-existing low/mid inversion into a swap instead of failing', () => {
    const db = preCheckDb();
    // The three rows that actually sat inverted for three weeks.
    db.exec(`INSERT INTO conviction_stocks (ticker, price_low, price_mid, price_high) VALUES
      ('MSFT', 433, 409, 520), ('NOW', 123, 108, 200), ('PLTR', 152, 133, 190)`);

    applyCheckMigration(db);

    expect(bands(db, 'MSFT')).toEqual({ price_low: 409, price_mid: 433, price_high: 520 });
    expect(bands(db, 'NOW')).toEqual({ price_low: 108, price_mid: 123, price_high: 200 });
    expect(bands(db, 'PLTR')).toEqual({ price_low: 133, price_mid: 152, price_high: 190 });
  });

  it('snapshots the original values into band history before normalising', () => {
    const db = preCheckDb();
    db.exec(`INSERT INTO conviction_stocks (ticker, price_low, price_mid, price_high, note)
             VALUES ('MSFT', 433, 409, 520, 'keeper')`);
    applyCheckMigration(db);

    const hist = db.prepare(
      'SELECT price_low, price_mid, price_high, note FROM conviction_band_history WHERE ticker = ?'
    ).all('MSFT');
    expect(hist).toHaveLength(1);
    expect(hist[0]).toMatchObject({ price_low: 433, price_mid: 409, price_high: 520, note: 'keeper' });
  });

  it('leaves already-valid rows completely untouched and writes them no history', () => {
    const db = preCheckDb();
    db.exec(`INSERT INTO conviction_stocks (ticker, price_low, price_mid, price_high) VALUES
      ('AAPL', 180, 200, 240), ('TSLA', NULL, NULL, NULL), ('AMD', 100, NULL, 160)`);
    applyCheckMigration(db);

    expect(bands(db, 'AAPL')).toEqual({ price_low: 180, price_mid: 200, price_high: 240 });
    expect(bands(db, 'TSLA')).toEqual({ price_low: null, price_mid: null, price_high: null });
    expect(bands(db, 'AMD')).toEqual({ price_low: 100, price_mid: null, price_high: 160 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM conviction_band_history').get())
      .toEqual({ n: 0 });
  });

  it('drops a duplicate band, which sorting alone cannot separate under a strict CHECK', () => {
    const db = preCheckDb();
    db.exec(`INSERT INTO conviction_stocks (ticker, price_low, price_mid, price_high) VALUES
      ('EQ1', 100, 100, 160),
      ('EQ2', 100, 160, 160),
      ('EQ3', 140, NULL, 140),
      ('EQ4', 100, 100, 100)`);
    applyCheckMigration(db);

    expect(bands(db, 'EQ1')).toEqual({ price_low: 100, price_mid: null, price_high: 160 });
    expect(bands(db, 'EQ2')).toEqual({ price_low: 100, price_mid: null, price_high: 160 });
    expect(bands(db, 'EQ3')).toEqual({ price_low: 140, price_mid: null, price_high: null });
    expect(bands(db, 'EQ4')).toEqual({ price_low: 100, price_mid: null, price_high: null });
  });

  it('normalises a two-band inversion in whichever pair of slots is populated', () => {
    const db = preCheckDb();
    db.exec(`INSERT INTO conviction_stocks (ticker, price_low, price_mid, price_high) VALUES
      ('P1', 200, 100, NULL),
      ('P2', 200, NULL, 100),
      ('P3', NULL, 200, 100)`);
    applyCheckMigration(db);

    expect(bands(db, 'P1')).toEqual({ price_low: 100, price_mid: 200, price_high: null });
    expect(bands(db, 'P2')).toEqual({ price_low: 100, price_mid: null, price_high: 200 });
    expect(bands(db, 'P3')).toEqual({ price_low: null, price_mid: 100, price_high: 200 });
  });

  it('preserves the entire audit trail — rows, ids and inverted values alike', () => {
    const db = preCheckDb();
    db.exec(`INSERT INTO conviction_stocks (ticker, price_low, price_mid) VALUES ('MSFT', 400, 450)`);
    db.exec(`INSERT INTO conviction_band_history (id, ticker, price_low, price_mid, price_high, note)
             VALUES (7, 'MSFT', 433, 409, 520, 'was inverted'), (9, 'MSFT', 390, 420, 500, NULL)`);

    applyCheckMigration(db);

    const rows = db.prepare(
      'SELECT id, price_low, price_mid, note FROM conviction_band_history ORDER BY id'
    ).all();
    expect(rows).toHaveLength(2);
    // History is a record of what was stored — the inverted snapshot must survive verbatim.
    expect(rows[0]).toMatchObject({ id: 7, price_low: 433, price_mid: 409, note: 'was inverted' });
    expect(rows[1]).toMatchObject({ id: 9, price_low: 390, price_mid: 420 });
  });

  it('keeps the history FK working after the rebuild (delete still cascades)', () => {
    const db = migratedDb();
    const s = new ConvictionService(db);
    s.add({ ticker: 'NVDA', priceLow: 100, priceMid: 120, priceHigh: 160 });
    s.update('NVDA', { priceLow: 105, priceMid: 125, priceHigh: 165 });
    expect(s.getHistory('NVDA')).toHaveLength(1);

    s.remove('NVDA');
    expect(db.prepare('SELECT COUNT(*) AS n FROM conviction_band_history').get()).toEqual({ n: 0 });
  });

  it('leaves AUTOINCREMENT continuing past the restored ids', () => {
    const db = preCheckDb();
    db.exec(`INSERT INTO conviction_stocks (ticker) VALUES ('MSFT')`);
    db.exec(`INSERT INTO conviction_band_history (id, ticker) VALUES (7, 'MSFT')`);
    applyCheckMigration(db);

    db.exec(`INSERT INTO conviction_band_history (ticker, price_low) VALUES ('MSFT', 1)`);
    const maxId = db.prepare('SELECT MAX(id) AS id FROM conviction_band_history').get() as { id: number };
    expect(maxId.id).toBeGreaterThan(7); // no id collision with the restored rows
  });
});

describe('conviction band CHECK constraint', () => {
  it('rejects inverted bands written by raw SQL, bypassing the service entirely', () => {
    const db = migratedDb();
    expect(() => db.exec(
      `INSERT INTO conviction_stocks (ticker, price_low, price_mid) VALUES ('SNOW', 120, 110)`
    )).toThrow(/conviction_bands_low_lt_mid/);
    expect(() => db.exec(
      `INSERT INTO conviction_stocks (ticker, price_mid, price_high) VALUES ('SNOW', 140, 130)`
    )).toThrow(/conviction_bands_mid_lt_high/);
    expect(() => db.exec(
      `INSERT INTO conviction_stocks (ticker, price_low, price_high) VALUES ('SNOW', 140, 130)`
    )).toThrow(/conviction_bands_low_lt_high/);
  });

  it('rejects a raw UPDATE that inverts an already-valid row', () => {
    const db = migratedDb();
    db.exec(`INSERT INTO conviction_stocks (ticker, price_low, price_mid, price_high)
             VALUES ('NVDA', 100, 120, 160)`);
    expect(() => db.exec(`UPDATE conviction_stocks SET price_low = 130 WHERE ticker = 'NVDA'`))
      .toThrow(/conviction_bands_low_lt_mid/);
    expect(bands(db, 'NVDA')).toEqual({ price_low: 100, price_mid: 120, price_high: 160 });
  });

  it('rejects equal bands — the CHECK is strict, matching validateBandOrder', () => {
    const db = migratedDb();
    expect(() => db.exec(
      `INSERT INTO conviction_stocks (ticker, price_low, price_mid) VALUES ('X', 100, 100)`
    )).toThrow(/CHECK constraint failed/);
  });

  it('still allows partial bands and a bare ticker', () => {
    const db = migratedDb();
    expect(() => db.exec(`INSERT INTO conviction_stocks (ticker) VALUES ('A')`)).not.toThrow();
    expect(() => db.exec(
      `INSERT INTO conviction_stocks (ticker, price_low) VALUES ('B', 100)`
    )).not.toThrow();
    expect(() => db.exec(
      `INSERT INTO conviction_stocks (ticker, price_low, price_high) VALUES ('C', 100, 160)`
    )).not.toThrow();
  });

  it('does NOT constrain band history — it must keep inverted rows verbatim', () => {
    const db = migratedDb();
    db.exec(`INSERT INTO conviction_stocks (ticker) VALUES ('MSFT')`);
    expect(() => db.exec(
      `INSERT INTO conviction_band_history (ticker, price_low, price_mid) VALUES ('MSFT', 433, 409)`
    )).not.toThrow();
  });

  it('preserves in_play across the rebuild', () => {
    const db = preCheckDb();
    db.exec(`INSERT INTO conviction_stocks (ticker, price_low, in_play) VALUES ('NVDA', 100, 1)`);
    applyCheckMigration(db);
    expect(db.prepare('SELECT in_play FROM conviction_stocks WHERE ticker = ?').get('NVDA'))
      .toEqual({ in_play: 1 });
  });
});
