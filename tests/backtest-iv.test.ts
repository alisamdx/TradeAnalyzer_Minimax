// Regression test: the backtest engine prices premium off historical IV (iv_history)
// when available, falling back to 20-day realized vol. Same price path → higher entry
// premium when IV history (high IV) is present. (v0.33.8)

import { describe, it, expect } from 'vitest';
import { openDatabase, type DbHandle } from '../src/main/db/connection.js';
import { runMigrations } from '../src/main/db/migrations.js';
import { MIGRATIONS_DIR } from './helpers.js';
import { BacktestEngine } from '../src/main/services/backtest-engine.js';

function seedPrices(db: DbHandle, ticker: string, base = 100) {
  // ~180 sequential days of a gently drifting price → LOW realized vol.
  const ins = db.prepare(
    `INSERT INTO historical_prices (ticker, date, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const start = new Date('2023-01-01T00:00:00Z');
  for (let i = 0; i < 180; i++) {
    const d = new Date(start.getTime() + i * 86_400_000).toISOString().slice(0, 10);
    const px = base + Math.sin(i / 30) * (base * 0.015); // small wiggle, low realized vol
    ins.run(ticker, d, px, px + 0.3, px - 0.3, px, 2_000_000);
  }
}

function seedIv(db: DbHandle, ticker: string, ivPct: number) {
  const ins = db.prepare(`INSERT INTO iv_history (ticker, date, atm_iv) VALUES (?, ?, ?)`);
  const start = new Date('2023-01-01T00:00:00Z');
  for (let i = 0; i < 180; i++) {
    const d = new Date(start.getTime() + i * 86_400_000).toISOString().slice(0, 10);
    ins.run(ticker, d, ivPct);
  }
}

function firstEntryPremium(db: DbHandle, ticker: string): number {
  const eng = new BacktestEngine(db);
  const id = eng.createConfig({
    name: 't', strategy: 'CSP', ticker, startDate: '2023-02-01', endDate: '2023-06-15',
    startingCapital: 25_000, dteTarget: 30, deltaTarget: 0.30, profitTargetPct: 50, stopLossPct: 200,
  });
  const { runId } = eng.simulate(id, () => {});
  const trades = eng.getTrades(runId);
  expect(trades.length).toBeGreaterThan(0);
  return trades[0]!.entryPremium;
}

function seedReplayPicks(db: DbHandle, strategy: string, ticker: string, dates: string[]) {
  for (const d of dates) {
    const b = db.prepare(
      `INSERT INTO replay_briefs (as_of_date, strategy, picks, config_version) VALUES (?, ?, '[]', 'baseline_v3')`
    ).run(d, strategy);
    db.prepare(
      `INSERT INTO replay_outcomes (replay_brief_id, ticker, rank, composite_score, entry_price) VALUES (?, ?, 1, 70, 100)`
    ).run(b.lastInsertRowid as number, ticker);
  }
}

describe('aggregate pick backtest (phase 2)', () => {
  it('simulates a CSP per replay pick and pools the results', () => {
    const db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    seedPrices(db, 'TST');
    seedIv(db, 'TST', 40);
    // Picks on dates that have ≥40 forward calendar days of price data.
    seedReplayPicks(db, 'wheel', 'TST', ['2023-02-10', '2023-03-01', '2023-03-20', '2023-04-05']);

    const res = new BacktestEngine(db).backtestReplayPicks('wheel');
    expect(res.strategy).toBe('wheel');
    expect(res.tradeCount).toBeGreaterThan(0);
    expect(res.winRate).toBeGreaterThanOrEqual(0);
    expect(res.winRate).toBeLessThanOrEqual(100);
    expect(res.equityCurve.length).toBe(res.tradeCount);
    expect(Number.isFinite(res.avgReturnPct)).toBe(true);
    db.close();
  });

  it('returns an empty result when the strategy has no picks', () => {
    const db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    const res = new BacktestEngine(db).backtestReplayPicks('income');
    expect(res.tradeCount).toBe(0);
    expect(res.equityCurve).toEqual([]);
    db.close();
  });

  it('aggregate equity curve is cumulative dollars ending at total P&L', () => {
    const db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    seedPrices(db, 'TST', 100); // 180 days from 2023-01-01
    // One income replay pick whose CSP can resolve within the seeded price range.
    const brief = db.prepare(
      `INSERT INTO replay_briefs (as_of_date, strategy, picks, config_version) VALUES ('2023-02-01','income','[]','baseline_v3')`
    ).run();
    db.prepare(
      `INSERT INTO replay_outcomes (replay_brief_id, ticker, rank, composite_score, entry_price) VALUES (?, 'TST', 1, 70, 100)`
    ).run(brief.lastInsertRowid as number);

    const res = new BacktestEngine(db).backtestReplayPicks('income');
    expect(res.tradeCount).toBeGreaterThan(0);
    expect(res.equityCurve.length).toBe(res.tradeCount);
    // Curve is in dollars and its last point equals the reported total P&L.
    expect(res.equityCurve.at(-1)!.cumPnl).toBe(res.totalPnl);
    expect(res.maxDrawdownPnl).toBeGreaterThanOrEqual(0);
    db.close();
  });

  it('inflection backtests a directional credit spread (defined risk)', () => {
    const db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    seedPrices(db, 'TST', 100);
    const brief = db.prepare(
      `INSERT INTO replay_briefs (as_of_date, strategy, picks, config_version) VALUES ('2023-02-01','inflection','[]','baseline_v3')`
    ).run();
    // direction +1 = up-breakout → bull put spread
    db.prepare(
      `INSERT INTO replay_outcomes (replay_brief_id, ticker, rank, composite_score, entry_price, direction) VALUES (?, 'TST', 1, 72, 100, 1)`
    ).run(brief.lastInsertRowid as number);

    const res = new BacktestEngine(db).backtestReplayPicks('inflection');
    expect(res.structure).toBe('credit-spread');
    expect(res.tradeCount).toBeGreaterThan(0);
    expect(res.equityCurve.at(-1)!.cumPnl).toBe(res.totalPnl);
    db.close();
  });

  it('ivHistoryStart returns the oldest IV date (null when empty)', () => {
    const db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    const eng = new BacktestEngine(db);
    expect(eng.ivHistoryStart()).toBeNull();
    db.prepare(`INSERT INTO iv_history (ticker, date, atm_iv) VALUES ('X','2025-05-29',30),('X','2025-06-01',31)`).run();
    expect(eng.ivHistoryStart()).toBe('2025-05-29');
    db.close();
  });
});

describe('backtest engine uses historical IV', () => {
  it('prices a higher entry premium when IV history (high IV) is present', () => {
    // Run A — no IV history → falls back to ~5% realized vol on the flat series.
    const dbA = openDatabase(':memory:');
    runMigrations(dbA, MIGRATIONS_DIR);
    seedPrices(dbA, 'TST');
    const premRealized = firstEntryPremium(dbA, 'TST');
    dbA.close();

    // Run B — same prices, with 60% IV history.
    const dbB = openDatabase(':memory:');
    runMigrations(dbB, MIGRATIONS_DIR);
    seedPrices(dbB, 'TST');
    seedIv(dbB, 'TST', 60);
    const premIv = firstEntryPremium(dbB, 'TST');
    dbB.close();

    expect(premIv).toBeGreaterThan(premRealized * 2); // IV-priced premium is far richer
  });

  it('runs a high-priced stock without a starting-capital input (capital auto-sized)', () => {
    const db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    seedPrices(db, 'BIG', 645); // ~$645 stock → CSP collateral ~$60k; used to flat-zero with $25k
    const eng = new BacktestEngine(db);
    const id = eng.createConfig({
      name: 't', strategy: 'CSP', ticker: 'BIG', startDate: '2023-02-01', endDate: '2023-06-15',
      startingCapital: 25_000, dteTarget: 30, deltaTarget: 0.30, profitTargetPct: 50, stopLossPct: 200,
    });
    const { runId } = eng.simulate(id, () => {});
    expect(eng.getTrades(runId).length).toBeGreaterThan(0); // no longer capital-gated
    db.close();
  });

  it('records the underlying stock price at entry and exit on each trade', () => {
    const db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    seedPrices(db, 'TST');
    const eng = new BacktestEngine(db);
    const id = eng.createConfig({
      name: 't', strategy: 'CSP', ticker: 'TST', startDate: '2023-02-01', endDate: '2023-06-15',
      startingCapital: 25_000, dteTarget: 30, deltaTarget: 0.30, profitTargetPct: 50, stopLossPct: 200,
    });
    const { runId } = eng.simulate(id, () => {});
    const trades = eng.getTrades(runId);
    expect(trades.length).toBeGreaterThan(0);
    expect(trades[0]!.entrySpot).toBeGreaterThan(90);   // flat series ≈ 100
    const closed = trades.find(t => t.exitDate !== null);
    expect(closed?.exitSpot).toBeGreaterThan(90);
    db.close();
  });
});
