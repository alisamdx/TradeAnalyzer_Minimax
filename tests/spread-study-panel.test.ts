// The bull-put-spread study panel (v1.1.338) — what scripts/fr-bull-put-spread-study.mjs reads through
// GET /diagnostics/spread-study-panel instead of opening the SQLite file itself (which a redirected
// shell must never do). The script filters each pick's bars to [date − 90, date + 75] itself, so the
// panel must hold at least that span for every pick and must not invent rows.

import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase, type DbHandle } from '../src/main/db/connection.js';
import { runMigrations } from '../src/main/db/migrations.js';
import { MIGRATIONS_DIR } from './helpers.js';
import { spreadStudyPanel } from '../src/main/services/spread-study-panel.js';
import type { PanelDb } from '../src/main/services/settled-csp-panel.js';

let db: DbHandle;
const panel = (strategy = 'wheel', quotes = false) => spreadStudyPanel(db as unknown as PanelDb, strategy, quotes);

function day(i: number): string {
  return new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
}

function bars(ticker: string, from: number, to: number, close = 100): void {
  const stmt = db.prepare(
    `INSERT INTO historical_prices (ticker, date, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, 1000)`
  );
  for (let i = from; i <= to; i++) stmt.run(ticker, day(i), close, close, close, close);
}

function pick(strategy: string, date: string, ticker: string, rank: number): void {
  let id = (db.prepare(`SELECT id FROM replay_briefs WHERE as_of_date = ? AND strategy = ?`).get(date, strategy) as { id: number } | undefined)?.id;
  if (id === undefined) {
    id = db.prepare(
      `INSERT INTO replay_briefs (as_of_date, strategy, picks, config_version) VALUES (?, ?, '[]', 'baseline_v3')`
    ).run(date, strategy).lastInsertRowid as number;
  }
  db.prepare(`INSERT INTO replay_outcomes (replay_brief_id, ticker, rank, composite_score) VALUES (?, ?, ?, 60)`).run(id, ticker, rank);
}

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db, MIGRATIONS_DIR);
});

describe('spreadStudyPanel', () => {
  it('returns the strategy picks, one row per ticker and date at its best rank', () => {
    pick('wheel', day(100), 'AAA', 3);
    pick('wheel', day(100), 'BBB', 1);
    pick('income', day(100), 'CCC', 1);
    const p = panel();
    expect(p.picks).toEqual([
      { ticker: 'AAA', date: day(100), rank: 3 },
      { ticker: 'BBB', date: day(100), rank: 1 },
    ]);
  });

  it('holds every bar in [first pick − 90, last pick + 75] and nothing outside it', () => {
    pick('wheel', day(100), 'AAA', 1);
    pick('wheel', day(130), 'AAA', 1);
    bars('AAA', 0, 300);
    const b = panel().bars['AAA']!;
    expect(b[0]![0]).toBe(day(10));          // 100 − 90
    expect(b[b.length - 1]![0]).toBe(day(205)); // 130 + 75
    expect(b).toHaveLength(196);
  });

  it('skips non-positive closes, exactly as the script query did', () => {
    pick('wheel', day(100), 'ZERO', 1);
    bars('ZERO', 95, 105);
    db.prepare(`UPDATE historical_prices SET close = 0 WHERE ticker = 'ZERO' AND date = ?`).run(day(100));
    expect(panel().bars['ZERO']!.map(([d]) => d)).not.toContain(day(100));
  });

  it('returns iv_history as stored, for picked tickers only', () => {
    pick('wheel', day(100), 'AAA', 1);
    db.prepare(`INSERT INTO iv_history (ticker, date, atm_iv) VALUES ('AAA', ?, 38.8), ('OTHER', ?, 20)`).run(day(99), day(99));
    const p = panel();
    expect(p.iv['AAA']).toEqual([[day(99), 38.8]]);
    expect(p.iv['OTHER']).toBeUndefined();
  });

  it('omits quotes unless asked, and returns them when asked', () => {
    pick('wheel', day(100), 'AAA', 1);
    db.prepare(
      `INSERT INTO options_premium_history (as_of_date, ticker, strategy, structure, strike, expiration, premium, bid, ask)
       VALUES (?, 'AAA', 'wheel', 'CSP', 95, ?, 2, 1.9, 2.1)`
    ).run(day(100), day(130));
    expect(panel().quotes).toBeNull();
    expect(panel('wheel', true).quotes!.premiumHistory).toEqual([{ ticker: 'AAA', bid: 1.9, ask: 2.1 }]);
  });

  it('reports an unreadable quote table as null, not as an empty list', () => {
    db.exec('DROP TABLE spread_chain_capture');
    const q = panel('wheel', true).quotes!;
    expect(q.spreadChains).toBeNull();
    expect(q.premiumHistory).toEqual([]);
  });
});
