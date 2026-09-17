// Regression: the collector's universe lists are read straight from `constituents`, and
// were the one reader that ignored `constituents_excluded` (migration 085) — so a
// universe_seed could hand TradeAnalyzer 2 the delisted names every writer keeps out.
// (085 seeds EA and WBS itself, hence OR IGNORE.)
// On 2026-09-16 E*Trade answered "The symbol entered is invalid" for EA, EQR and WBS.
// Built on the real migrations, not a fixture written from the reader. see CHANGELOG v1.1.252.

import { describe, expect, it } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openDatabase } from '../src/main/db/connection.js';
import { runMigrations } from '../src/main/db/migrations.js';
import { MIGRATIONS_DIR } from './helpers.js';
import { newAppUniverseSources } from '../src/main/collector-host/universe-sources.js';

describe('newAppUniverseSources', () => {
  it('leaves out tickers in constituents_excluded, whatever their case', async () => {
    const db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    for (const t of ['AAPL', 'EA', 'wbs']) {
      db.prepare(`INSERT INTO constituents (ticker, index_name) VALUES (?, 'sp500')`).run(t);
    }
    for (const t of ['ETF1']) {
      db.prepare(`INSERT INTO constituents (ticker, index_name) VALUES (?, 'russell1000')`).run(t);
      db.prepare(`INSERT INTO constituents (ticker, index_name) VALUES (?, 'etf')`).run(t);
    }
    db.prepare(`INSERT OR IGNORE INTO constituents_excluded (ticker, reason) VALUES ('EA', 'delisted'), ('WBS', 'delisted')`).run();

    const sp500 = newAppUniverseSources(db as unknown as Database).find((s) => s.listSource === 'sp500')!;
    const response = await sp500.fetch();
    expect(sp500.parse(response.body)).toEqual(['AAPL']);
  });
});
