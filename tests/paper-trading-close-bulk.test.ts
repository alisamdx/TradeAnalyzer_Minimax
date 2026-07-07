import { describe, it, expect } from 'vitest';
import { openDatabase } from '../src/main/db/connection.js';
import { runMigrations } from '../src/main/db/migrations.js';
import { PaperTradingService } from '../src/main/services/paper-trading-service.js';
import { MIGRATIONS_DIR } from './helpers.js';

function insertOpenTrade(db: ReturnType<typeof openDatabase>, ticker: string, strategy: string) {
  db.prepare(`
    INSERT INTO paper_trades (brief_strategy, ticker, brief_date, entry_date, entry_price, legs_json, status)
    VALUES (?, ?, '2026-07-01', '2026-07-01', 100, '[]', 'open')
  `).run(strategy, ticker);
  return (db.prepare('SELECT id FROM paper_trades WHERE ticker = ?').get(ticker) as { id: number }).id;
}

describe('PaperTradingService.closePositions (bulk close)', () => {
  it('closes every requested open position and skips ones already closed', () => {
    const db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    const svc = new PaperTradingService(db);

    const id1 = insertOpenTrade(db, 'AAA', 'wheel');
    const id2 = insertOpenTrade(db, 'BBB', 'wheel');
    const id3 = insertOpenTrade(db, 'CCC', 'wheel');

    // AAA already closed before the bulk call — must be skipped, not double-closed
    svc.closePosition(id1);

    const closedCount = svc.closePositions([id1, id2, id3], 'Bulk close — Close Signals');

    expect(closedCount).toBe(2); // only BBB and CCC were open
    const rows = db.prepare('SELECT id, status, exit_notes FROM paper_trades ORDER BY id').all() as
      { id: number; status: string; exit_notes: string | null }[];
    expect(rows.every(r => r.status === 'closed')).toBe(true);
    expect(rows.find(r => r.id === id2)!.exit_notes).toBe('Bulk close — Close Signals');
    expect(rows.find(r => r.id === id3)!.exit_notes).toBe('Bulk close — Close Signals');
  });

  it('returns 0 and touches nothing for an empty id list', () => {
    const db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    const svc = new PaperTradingService(db);
    insertOpenTrade(db, 'AAA', 'wheel');

    expect(svc.closePositions([])).toBe(0);
    const open = db.prepare("SELECT COUNT(*) AS n FROM paper_trades WHERE status = 'open'").get() as { n: number };
    expect(open.n).toBe(1);
  });
});
