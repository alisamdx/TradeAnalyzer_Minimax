// Regression: the brief's earnings "net" — EarningsService.refreshTickers — must
// actually verify the rows that claim there is no near-term earnings risk (v1.1.138).
//
// It previously skipped ANY stored future date as "still valid". That made it inert
// against the one failure that matters: a stored date wrong in the FAR direction
// silently disables the -20 earnings penalty. NVDA held a bogus 2026-11-17 while its
// true report was 2026-08-26, so the net skipped it as valid on the day it reported
// and the brief ranked NVDA wheel #1. Proof it did nothing that run, from run_meta:
// {"updated":0,"skipped":53,"failed":3}.
//
// Policy now: trust a stored date already INSIDE the risk horizon (the gate is
// engaged; re-checking cannot change the outcome, and an error there is fail-safe),
// and confirm everything else against E*Trade.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openDatabase, type DbHandle } from '../src/main/db/connection.js';
import { runMigrations } from '../src/main/db/migrations.js';
import { MIGRATIONS_DIR } from './helpers.js';

const etradeGet = vi.hoisted(() => vi.fn());
vi.mock('../src/main/services/etrade-auth.js', () => ({ etradeGet }));

const { EarningsService } = await import('../src/main/services/earnings-service.js');

function iso(daysFromNow: number): string {
  return new Date(Date.now() + daysFromNow * 86_400_000).toISOString().slice(0, 10);
}

const creds = { consumerKey: 'k', consumerSecret: 's', accessToken: 't', accessSecret: 'a' };

/** E*Trade replies with `date` for every ticker asked. */
function stubEtradeReturning(date: string) {
  etradeGet.mockResolvedValue({
    QuoteResponse: { QuoteData: [{ All: { nextEarningDate: date } }] },
  });
}

describe('EarningsService.refreshTickers — the brief earnings net', () => {
  let db: DbHandle;

  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    etradeGet.mockReset();
  });

  afterEach(() => { db.close(); vi.restoreAllMocks(); });

  it('VERIFIES a far stored date and catches a hidden near-term report (the NVDA case)', async () => {
    const svc = new EarningsService(db);
    const bogusFar = iso(80);   // what the truncated bulk call stored
    const truthNear = iso(2);   // the real report, days away
    svc.upsertFromProvider('NVDA', bogusFar, 'amc', 'finnhub', true);
    stubEtradeReturning(truthNear);

    const res = await svc.refreshTickers(['NVDA'], creds);

    expect(etradeGet).toHaveBeenCalledTimes(1);          // it actually asked
    expect(res.updated).toBe(1);
    expect(res.skipped).toBe(0);
    expect(svc.getForTicker('NVDA')?.reportDate).toBe(truthNear);
  });

  it('TRUSTS a stored date already inside the risk horizon — no wasted call', async () => {
    const svc = new EarningsService(db);
    const near = iso(20);   // inside the 45d penalty window; the gate is already engaged
    svc.upsertFromProvider('AAPL', near, 'amc', 'finnhub', true);

    const res = await svc.refreshTickers(['AAPL'], creds);

    expect(etradeGet).not.toHaveBeenCalled();
    expect(res.skipped).toBe(1);
    expect(svc.getForTicker('AAPL')?.reportDate).toBe(near);
  });

  it('still fetches when there is no row at all', async () => {
    const svc = new EarningsService(db);
    stubEtradeReturning(iso(30));

    const res = await svc.refreshTickers(['MSFT'], creds);

    expect(etradeGet).toHaveBeenCalledTimes(1);
    expect(res.updated).toBe(1);
  });

  it('still fetches when the stored date has already passed', async () => {
    const svc = new EarningsService(db);
    svc.upsertFromProvider('TSLA', iso(-5), 'amc', 'finnhub', true);
    stubEtradeReturning(iso(40));

    const res = await svc.refreshTickers(['TSLA'], creds);

    expect(etradeGet).toHaveBeenCalledTimes(1);
    expect(res.updated).toBe(1);
  });

  it('never overwrites a manual entry — even with force=true', async () => {
    const svc = new EarningsService(db);
    const manual = iso(90);
    svc.upsertFromProvider('GLW', manual, 'amc', 'manual', true);
    stubEtradeReturning(iso(3));

    const res = await svc.refreshTickers(['GLW'], creds, true);

    // Before v1.1.138 `force` skipped the whole guard block, manual check included,
    // contradicting the documented "manual entries are never overwritten" contract.
    expect(etradeGet).not.toHaveBeenCalled();
    expect(res.skipped).toBe(1);
    expect(svc.getForTicker('GLW')?.reportDate).toBe(manual);
  });

  it('force=true re-fetches a near date that would otherwise be trusted', async () => {
    const svc = new EarningsService(db);
    svc.upsertFromProvider('PCG', iso(20), 'amc', 'finnhub', true);
    stubEtradeReturning(iso(18));

    const res = await svc.refreshTickers(['PCG'], creds, true);

    expect(etradeGet).toHaveBeenCalledTimes(1);
    expect(res.updated).toBe(1);
    expect(svc.getForTicker('PCG')?.reportDate).toBe(iso(18));
  });
});
