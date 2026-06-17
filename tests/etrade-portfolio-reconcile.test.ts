// Full-sync reconciliation: open E*Trade-sourced positions that the broker no longer reports
// (e.g. a closed NVDA) must be marked closed, while manual positions and other accounts are
// left untouched. Tests the private closeMissingPositions directly against an in-memory DB.
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { EtradePortfolioService } from '../src/main/services/etrade-portfolio-service.js';

type DB = InstanceType<typeof Database>;
let db: DB;

function insert(p: { id: number; ticker: string; status?: string; etId?: string | null; acct: string }) {
  db.prepare(
    `INSERT INTO positions (id, ticker, status, etrade_position_id, etrade_account_id, last_synced_at, updated_at)
     VALUES (?, ?, ?, ?, ?, '', '')`
  ).run(p.id, p.ticker, p.status ?? 'open', p.etId === undefined ? null : p.etId, p.acct);
}
const statusOf = (id: number) => (db.prepare('SELECT status FROM positions WHERE id = ?').get(id) as { status: string }).status;
const close = (acct: string, seen: string[]) =>
  (new EtradePortfolioService() as unknown as { closeMissingPositions(db: DB, a: string, s: string[]): number })
    .closeMissingPositions(db, acct, seen);

describe('closeMissingPositions — full-sync reconciliation', () => {
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`CREATE TABLE positions (
      id INTEGER PRIMARY KEY, ticker TEXT, status TEXT,
      etrade_position_id TEXT, etrade_account_id TEXT, last_synced_at TEXT, updated_at TEXT);`);
  });

  it('closes an open broker position the broker no longer reports (the NVDA case)', () => {
    insert({ id: 1, ticker: 'AAPL', etId: '111', acct: 'A' }); // still present
    insert({ id: 2, ticker: 'NVDA', etId: '222', acct: 'A' }); // closed at broker
    const n = close('A', ['111']); // only AAPL returned this sync
    expect(n).toBe(1);
    expect(statusOf(1)).toBe('open');
    expect(statusOf(2)).toBe('closed');
  });

  it('never touches manual positions (no etrade_position_id)', () => {
    insert({ id: 1, ticker: 'MANUAL', etId: null, acct: 'A' });
    expect(close('A', [])).toBe(0);
    expect(statusOf(1)).toBe('open');
  });

  it('only reconciles the synced account', () => {
    insert({ id: 1, ticker: 'NVDA', etId: '222', acct: 'A' });
    insert({ id: 2, ticker: 'TSLA', etId: '333', acct: 'B' }); // different account
    close('A', []); // account A is flat
    expect(statusOf(1)).toBe('closed');
    expect(statusOf(2)).toBe('open'); // account B untouched
  });

  it('closes every open broker position when the account is flat (empty fetch)', () => {
    insert({ id: 1, ticker: 'NVDA', etId: '222', acct: 'A' });
    insert({ id: 2, ticker: 'AMD',  etId: '333', acct: 'A' });
    expect(close('A', [])).toBe(2);
    expect(statusOf(1)).toBe('closed');
    expect(statusOf(2)).toBe('closed');
  });

  it('leaves already-closed positions alone (idempotent)', () => {
    insert({ id: 1, ticker: 'NVDA', status: 'closed', etId: '222', acct: 'A' });
    expect(close('A', [])).toBe(0);
    expect(statusOf(1)).toBe('closed');
  });
});

describe('upsertPosition — unrealized P&L from E*Trade totalGain', () => {
  let udb: DB;
  beforeEach(() => {
    udb = new Database(':memory:');
    udb.exec(`CREATE TABLE positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ticker TEXT, position_type TEXT, quantity REAL,
      entry_price REAL, entry_date TEXT, strike_price REAL, expiration_date TEXT,
      premium_received REAL, status TEXT, etrade_position_id TEXT, etrade_account_id TEXT,
      market_value REAL, total_gain_pct REAL, unrealized_pnl REAL, realized_pnl REAL,
      days_gain REAL, days_gain_pct REAL, cost_per_share REAL, pct_of_portfolio REAL,
      delta REAL, gamma REAL, theta REAL, vega REAL, iv REAL, beta REAL,
      current_price REAL, entry_notes TEXT, exit_price REAL,
      last_synced_at TEXT, created_at TEXT, updated_at TEXT);`);
  });

  const stockRaw = (totalGain: number) => ({
    positionId: 'p1', symbolDescription: 'AAPL', quantity: 100, positionType: 'LONG',
    Product: { securityType: 'EQ', symbol: 'AAPL' },
    pricePaid: 150, costPerShare: 150, dateAcquired: Date.UTC(2026, 0, 2),
    marketValue: 15500, totalGain, totalGainPct: 3.33, daysGain: 50, daysGainPct: 0.3,
    pctOfPortfolio: 10, Complete: {},
  });
  const upsert = (db: DB, acct: string, raw: unknown) =>
    (new EtradePortfolioService() as unknown as { upsertPosition(db: DB, a: string, r: unknown): boolean })
      .upsertPosition(db, acct, raw);
  const pnl = () => (udb.prepare('SELECT unrealized_pnl FROM positions WHERE ticker = ?').get('AAPL') as { unrealized_pnl: number | null }).unrealized_pnl;

  it('stores E*Trade dollar totalGain into unrealized_pnl on INSERT', () => {
    upsert(udb, 'A', stockRaw(500));
    expect(pnl()).toBe(500);
  });

  it('refreshes unrealized_pnl from totalGain on UPDATE (re-sync)', () => {
    upsert(udb, 'A', stockRaw(500));
    upsert(udb, 'A', stockRaw(-120)); // same positionId → UPDATE path
    expect(pnl()).toBe(-120);
  });
});
