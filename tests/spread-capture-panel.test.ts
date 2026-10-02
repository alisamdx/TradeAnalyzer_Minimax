// The spread-capture panel (v1.1.339) — what the BPS-4/BPS-19 harnesses read through
// GET /diagnostics/spread-capture-panel instead of opening the SQLite file themselves.
// It must return exactly the library's old SQL: entry rows only, in run order; and it must report an
// unreadable table as null, so "no capture table" never reads as "no captures".

import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase, type DbHandle } from '../src/main/db/connection.js';
import { runMigrations } from '../src/main/db/migrations.js';
import { MIGRATIONS_DIR } from './helpers.js';
import { spreadCapturePanel } from '../src/main/services/spread-capture-panel.js';
import type { PanelDb } from '../src/main/services/settled-csp-panel.js';

let db: DbHandle;
const panel = (earnings = false) => spreadCapturePanel(db as unknown as PanelDb, earnings);

function capture(r: { date: string; slot?: string; ticker: string; dte: number; reason?: string }): void {
  db.prepare(
    `INSERT INTO spread_chain_capture
       (as_of_date, slot, captured_at, ticker, expiration, dte, reason, underlying_price, contract_count, puts_json)
     VALUES (?, ?, '2026-09-21T14:00:00Z', ?, ?, ?, ?, 100, 2, '[]')`
  ).run(r.date, r.slot ?? 'intraday', r.ticker, `2026-11-${String(r.dte).padStart(2, '0')}`, r.dte, r.reason ?? 'entry');
}

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db, MIGRATIONS_DIR);
});

describe('spreadCapturePanel', () => {
  it('returns entry rows only, ordered by date, slot, ticker, dte', () => {
    capture({ date: '2026-09-22', ticker: 'BBB', dte: 30 });
    capture({ date: '2026-09-21', ticker: 'BBB', dte: 30 });
    capture({ date: '2026-09-21', ticker: 'AAA', dte: 30 });
    capture({ date: '2026-09-21', ticker: 'AAA', dte: 21 });
    capture({ date: '2026-09-21', ticker: 'AAA', dte: 25, reason: 'track' });
    const rows = panel().captures!;
    expect(rows.map(r => `${r.as_of_date} ${r.ticker} ${r.dte}`)).toEqual([
      '2026-09-21 AAA 21', '2026-09-21 AAA 30', '2026-09-21 BBB 30', '2026-09-22 BBB 30',
    ]);
    expect(Object.keys(rows[0]!).sort()).toEqual(
      ['as_of_date', 'dte', 'expiration', 'puts_json', 'slot', 'ticker', 'underlying_price']
    );
  });

  it('includes earnings only when asked', () => {
    db.prepare(`INSERT INTO earnings_calendar (ticker, report_date) VALUES ('AAA', '2026-10-28')`).run();
    expect(panel().earnings).toBeNull();
    expect(panel(true).earnings).toEqual([{ ticker: 'AAA', report_date: '2026-10-28' }]);
  });

  it('reports an unreadable capture table as null, not as an empty list', () => {
    expect(panel().captures).toEqual([]);
    db.exec('DROP TABLE spread_chain_capture');
    expect(panel().captures).toBeNull();
  });
});
