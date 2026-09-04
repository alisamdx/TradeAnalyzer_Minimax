// Nightly portfolio sync (v1.1.159).
//
// Two properties are load-bearing and both are pinned here:
//
//  1. It NEVER returns `failed`. The orchestrator is stop-on-failure, so a failed sub-job halts
//     everything after it. E*Trade's transactions endpoint answered `oauth_problem=nonce_used`
//     after ~120s for weeks — a broker hiccup must not stop the daily brief from generating.
//
//  2. Open positions sync BEFORE closed ones are imported. When a position vanishes from the
//     broker, syncPortfolio writes an estimate ("realized P&L estimated from last mark") and
//     those are systematically wrong — an assigned CSP reads as a large loss when it was a
//     conversion into stock (TSLA $350: estimate −$3,735.53, actual +$499.48). Importing right
//     after supersedes it in the same run, so the wrong figure never reaches the UI.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openDatabase, type DbHandle } from '../src/main/db/connection.js';
import { runMigrations } from '../src/main/db/migrations.js';
import { MIGRATIONS_DIR } from './helpers.js';

const syncPortfolio = vi.hoisted(() => vi.fn());
const syncClosedPositions = vi.hoisted(() => vi.fn());
// Balance snapshotting (v1.1.179) is instrumentation: it resolves to a count and never throws,
// so the stub returns 1 and the job's own behaviour is unchanged by it.
const syncBalances = vi.hoisted(() => vi.fn());
vi.mock('../src/main/services/etrade-portfolio-service.js', () => ({
  EtradePortfolioService: class {
    syncPortfolio = syncPortfolio;
    syncClosedPositions = syncClosedPositions;
    syncBalances = syncBalances;
  },
}));

const { PortfolioSyncJob } = await import('../src/main/services/jobs/portfolio-sync-job.js');
const creds = { consumerKey: 'k', consumerSecret: 's', accessToken: 't', accessSecret: 'a' };
const okResult = (upserted = 0, skipped = 0, errors: string[] = []) => ({
  accountsScanned: 1, positionsUpserted: upserted, positionsSkipped: skipped,
  errors, syncedAt: new Date().toISOString(),
});

describe('PortfolioSyncJob', () => {
  let db: DbHandle;
  const noop = () => {};
  const signal = new AbortController().signal;

  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    syncPortfolio.mockReset().mockResolvedValue(okResult(2, 5));
    syncClosedPositions.mockReset().mockResolvedValue(okResult(1, 24));
    syncBalances.mockReset().mockResolvedValue(1);
  });
  afterEach(() => { db.close(); vi.restoreAllMocks(); });

  it('syncs open positions BEFORE importing closed ones', async () => {
    const order: string[] = [];
    syncPortfolio.mockImplementation(async () => { order.push('open'); return okResult(2, 5); });
    syncClosedPositions.mockImplementation(async () => { order.push('closed'); return okResult(1, 24); });

    await new PortfolioSyncJob(db, () => creds).run(noop, signal);

    // Reversed, a just-closed position would show its wrong estimate until the next run.
    expect(order).toEqual(['open', 'closed']);
  });

  it('does NOT fail the chain when the closed import throws', async () => {
    syncClosedPositions.mockRejectedValue(new Error('The operation was aborted due to timeout'));

    const res = await new PortfolioSyncJob(db, () => creds).run(noop, signal);

    // stop-on-failure: `failed` here would halt every job after it.
    expect(res.status).toBe('success');
    expect(res.notes).toMatch(/WARNING/);
    expect(res.notes).toMatch(/closed import failed/);
  });

  it('does NOT fail the chain when the position sync throws, and still tries the import', async () => {
    syncPortfolio.mockRejectedValue(new Error('terminated'));

    const res = await new PortfolioSyncJob(db, () => creds).run(noop, signal);

    expect(res.status).toBe('success');
    expect(syncClosedPositions).toHaveBeenCalled();   // one failure must not skip the other half
    expect(res.notes).toMatch(/position sync failed/);
  });

  it('surfaces non-fatal E*Trade errors as a warning while still succeeding', async () => {
    syncClosedPositions.mockResolvedValue(okResult(0, 25, ['Executed orders returned no legs; trying transactions.']));

    const res = await new PortfolioSyncJob(db, () => creds).run(noop, signal);
    expect(res.status).toBe('success');
    expect(res.notes).toMatch(/Executed orders returned no legs/);
  });

  it('skips cleanly when E*Trade is not connected, rather than erroring', async () => {
    const res = await new PortfolioSyncJob(db, () => null).run(noop, signal);
    expect(res.status).toBe('skipped');
    expect(syncPortfolio).not.toHaveBeenCalled();
    expect(res.notes).toMatch(/not connected/);
  });

  it('reports what it did, including audited writes to the financial record', async () => {
    db.prepare(`INSERT INTO position_audit
      (occurred_at, action, ticker, new_realized_pnl, source, note)
      VALUES (datetime('now'), 'superseded', 'TSLA', 499.48, 'orders', 'x')`).run();

    const res = await new PortfolioSyncJob(db, () => creds).run(noop, signal);
    expect(res.notes).toMatch(/Positions: 2 updated, 5 unchanged/);
    expect(res.notes).toMatch(/Closed: 1 imported, 24 already present/);
    expect(res.notes).toMatch(/1 audited write/);
  });
});
