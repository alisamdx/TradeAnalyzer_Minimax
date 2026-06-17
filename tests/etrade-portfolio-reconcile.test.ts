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
