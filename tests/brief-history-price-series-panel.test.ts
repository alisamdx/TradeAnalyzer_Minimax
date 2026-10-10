// The stored-brief and price-series panels (v1.1.346): what fr-expiry-liquidity-study,
// fr-expiry-realized-ab, fr-liquidity-slot-comparison and fr-wheel-liquidity-calibration read
// through the API instead of opening trade-analyzer.sqlite themselves. From Claude Code's
// MSIX-redirected shell such an open MOVES a WAL database (CLAUDE.md).

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase, type DbHandle } from '../src/main/db/connection.js';
import { runMigrations } from '../src/main/db/migrations.js';
import { MIGRATIONS_DIR } from './helpers.js';
import { briefHistoryPanel } from '../src/main/services/brief-history-panel.js';
import { priceSeriesPanel } from '../src/main/services/price-series-panel.js';
import type { PanelDb } from '../src/main/services/settled-csp-panel.js';

let db: DbHandle;
const pdb = () => db as unknown as PanelDb;

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db, MIGRATIONS_DIR);
});

function brief(strategy: string, generatedAt: string, picks: string): void {
  db.prepare(`INSERT INTO daily_briefs (generated_at, valid_until, strategy, picks) VALUES (?, ?, ?, ?)`)
    .run(generatedAt, generatedAt, strategy, picks);
}

describe('briefHistoryPanel', () => {
  it('returns every brief oldest first, picks as the stored text', () => {
    brief('wheel', '2026-10-02T21:00:00Z', '[{"ticker":"BBB"}]');
    brief('income', '2026-10-01T14:20:00Z', '[{"ticker":"AAA"}]');
    const p = briefHistoryPanel(pdb());
    expect(p.briefs).toEqual([
      { strategy: 'income', generatedAt: '2026-10-01T14:20:00Z', picks: '[{"ticker":"AAA"}]' },
      { strategy: 'wheel', generatedAt: '2026-10-02T21:00:00Z', picks: '[{"ticker":"BBB"}]' },
    ]);
  });

  it('passes a malformed picks row through unparsed — the script decides to skip it', () => {
    brief('wheel', '2026-10-01T14:20:00Z', 'not json');
    expect(briefHistoryPanel(pdb()).briefs[0]!.picks).toBe('not json');
  });

  it('filters by strategy when asked', () => {
    brief('wheel', '2026-10-01T14:20:00Z', '[]');
    brief('income', '2026-10-01T14:20:00Z', '[]');
    expect(briefHistoryPanel(pdb(), { strategy: 'income' }).briefs.map((b) => b.strategy)).toEqual(['income']);
  });

  it('returns the liquidity log only when asked, and null (not []) when the table is unreadable', () => {
    db.prepare(`INSERT INTO structure_liquidity_log (captured_at, date_et, ticker, slug, liquidity_score, no_bid_leg)
                VALUES ('2026-10-01T14:20:00Z', '2026-10-01', 'AAA', 'short-naked-put', 9, 0)`).run();
    expect(briefHistoryPanel(pdb()).liquidityLog).toBeNull();
    expect(briefHistoryPanel(pdb(), { liquidityLog: true }).liquidityLog).toEqual([
      { capturedAt: '2026-10-01T14:20:00Z', dateEt: '2026-10-01', ticker: 'AAA', slug: 'short-naked-put', liquidityScore: 9, noBidLeg: 0 },
    ]);
    db.exec('DROP TABLE structure_liquidity_log');
    expect(briefHistoryPanel(pdb(), { liquidityLog: true }).liquidityLog).toBeNull();
  });
});

describe('priceSeriesPanel', () => {
  function bar(ticker: string, date: string, close: number): void {
    db.prepare(`INSERT INTO historical_prices (ticker, date, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, 1000)`)
      .run(ticker, date, close, close, close, close);
  }

  it('returns closes inside [from, to] in date order, and MAX(date) across the table', () => {
    bar('AAA', '2026-01-05', 11); bar('AAA', '2026-01-02', 10); bar('AAA', '2026-01-09', 12);
    bar('ZZZ', '2026-02-01', 50);
    const p = priceSeriesPanel(pdb(), ['AAA'], '2026-01-01', '2026-01-06', false);
    expect(p.bars['AAA']).toEqual([['2026-01-02', 10], ['2026-01-05', 11]]);
    expect(p.maxPx).toBe('2026-02-01');
    expect(p.iv).toBeNull();
  });

  it('lists an asked ticker with no rows as empty, never drops it', () => {
    expect(priceSeriesPanel(pdb(), ['NONE'], '2026-01-01', '2026-12-31', true)).toMatchObject({
      bars: { NONE: [] }, iv: { NONE: [] },
    });
  });

  it('returns iv_history with atm_iv > 0 only, as stored', () => {
    db.prepare(`INSERT INTO iv_history (ticker, date, atm_iv) VALUES ('AAA', '2026-01-02', 38.5), ('AAA', '2026-01-05', 0)`).run();
    expect(priceSeriesPanel(pdb(), ['AAA'], '2026-01-01', '2026-12-31', true).iv!['AAA']).toEqual([['2026-01-02', 38.5]]);
  });
});

describe('the four expiry/liquidity scripts read through the API', () => {
  const scripts = ['fr-expiry-liquidity-study', 'fr-expiry-realized-ab', 'fr-liquidity-slot-comparison', 'fr-wheel-liquidity-calibration'];
  // Comments stripped (CLAUDE.md, source-scan quirk): headers explain the old SQLite open.
  const code = (f: string) => readFileSync(join(__dirname, `../scripts/${f}.mjs`), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  for (const f of scripts) {
    it(`${f} never opens the SQLite file`, () => {
      const src = code(f);
      expect(src).toContain("from './lib/app-api.mjs'");
      expect(src).not.toMatch(/better-sqlite3|new Database\(|trade-analyzer\.sqlite/);
    });
  }
});
