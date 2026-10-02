// The BPS-2 pool-selection panel (v1.1.340) — what scripts/fr-spread-pool-selection-study.mjs reads
// through GET /diagnostics/pool-selection-panel instead of opening the SQLite file. The study's own
// self-test exercises its fixture path; this pins the reduction the API path does on the server:
// latest run per date, both payload shapes, rows never dropped, and a series long enough that every
// bar-index lookback (SMA200 at most) sees exactly the bars the full series would.

import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase, type DbHandle } from '../src/main/db/connection.js';
import { runMigrations } from '../src/main/db/migrations.js';
import { MIGRATIONS_DIR } from './helpers.js';
import { poolSelectionPanel, SERIES_LOOKBACK_DAYS } from '../src/main/services/pool-selection-panel.js';
import type { PanelDb } from '../src/main/services/settled-csp-panel.js';

let db: DbHandle;
const panel = () => poolSelectionPanel(db as unknown as PanelDb);

function snap(runAt: string, payload: unknown, mode = 'wheel'): void {
  db.prepare(`INSERT INTO analysis_snapshots (run_at, mode, payload_json) VALUES (?, ?, ?)`)
    .run(runAt, mode, typeof payload === 'string' ? payload : JSON.stringify(payload));
}

function day(i: number): string {
  return new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10);
}

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db, MIGRATIONS_DIR);
});

describe('poolSelectionPanel', () => {
  it('keeps the latest wheel run per date and ignores other modes', () => {
    snap('2026-09-21T14:15:00Z', [{ ticker: 'MORNING' }]);
    snap('2026-09-21T21:05:00Z', [{ ticker: 'EVENING' }]);
    snap('2026-09-21T22:00:00Z', [{ ticker: 'INCOME' }], 'income');
    const p = panel();
    expect(p.snapshots).toHaveLength(1);
    expect(p.snapshots[0]!.rows.map(r => r.ticker)).toEqual(['EVENING']);
  });

  it('reads both payload shapes and projects only the fields the study uses', () => {
    snap('2026-09-21T21:00:00Z', { results: [{
      ticker: 'AAA', recommendedStrike: 95, premium: 1.2, expiration: '2026-10-16', lastPrice: 100,
      optionLiquidityScore: 6, ivRank: 40, annualizedReturn: 18, unrelated: 'x',
    }] });
    snap('2026-09-22T21:00:00Z', [{ ticker: 'BBB' }]);
    const p = panel();
    expect(p.snapshots[0]!.rows[0]).toEqual({
      ticker: 'AAA', recommendedStrike: 95, premium: 1.2, expiration: '2026-10-16', lastPrice: 100,
      optionLiquidityScore: 6, ivRank: 40, annualizedReturn: 18,
    });
    expect(p.snapshots[1]!.rows[0]!.ticker).toBe('BBB');
    expect(p.snapshots[1]!.rows[0]!.recommendedStrike).toBeNull();
  });

  it('keeps an unparsable payload as an empty date and a non-object row as a row', () => {
    snap('2026-09-21T21:00:00Z', '{not json');
    snap('2026-09-22T21:00:00Z', [42, { ticker: 'OK' }]);
    const p = panel();
    expect(p.snapshots.find(s => s.date === '2026-09-21')!.rows).toEqual([]);
    const rows = p.snapshots.find(s => s.date === '2026-09-22')!.rows;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.ticker).toBeNull();
  });

  it(`sends each ticker's closes from ${SERIES_LOOKBACK_DAYS} days before the first snapshot — over 200 sessions`, () => {
    const stmt = db.prepare(`INSERT INTO historical_prices (ticker, date, open, high, low, close, volume) VALUES ('AAA', ?, 1, 1, 1, ?, 1)`);
    for (let i = 0; i < 700; i++) stmt.run(day(i), 100 + i);
    const firstSnap = day(600);
    snap(`${firstSnap}T21:00:00Z`, [{ ticker: 'AAA' }]);
    const s = panel().series['AAA']!;
    expect(s[0]![0]).toBe(day(600 - SERIES_LOOKBACK_DAYS));
    expect(s[s.length - 1]![0]).toBe(day(699));
    // Bars strictly before the first snapshot: calendar-day fixture, so 400 — well over SMA200's 200.
    expect(s.filter(([d]) => d < firstSnap).length).toBeGreaterThanOrEqual(200);
  });

  it('returns no series and no snapshots on an empty table', () => {
    expect(panel()).toMatchObject({ snapshots: [], series: {} });
  });
});
