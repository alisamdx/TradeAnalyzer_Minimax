// Unit tests for isEarningsPending — the pure "has this earnings event already happened"
// gate shared by the Daily Brief's Stage-3 earnings penalty and the AI Critic's
// earnings-in-window check (v1.1.116). A prior strict `report_date > today` comparison
// silently treated today's amc/unknown-time earnings as "no earnings", so a stock could
// surface in the morning brief (or ship on the live path via the brief) with no penalty
// or warning hours before it reported.

import { describe, it, expect } from 'vitest';
import { isEarningsPending } from '../src/main/services/earnings-service.js';

describe('isEarningsPending', () => {
  const today = '2026-07-10';

  it('is pending for any future date, regardless of report time', () => {
    expect(isEarningsPending('2026-07-11', 'bmo', today)).toBe(true);
    expect(isEarningsPending('2026-07-11', 'amc', today)).toBe(true);
    expect(isEarningsPending('2026-07-11', null, today)).toBe(true);
    expect(isEarningsPending('2026-08-21', null, today)).toBe(true);
  });

  it('is NOT pending for any past date, regardless of report time', () => {
    expect(isEarningsPending('2026-07-09', 'bmo', today)).toBe(false);
    expect(isEarningsPending('2026-07-09', 'amc', today)).toBe(false);
    expect(isEarningsPending('2026-06-01', null, today)).toBe(false);
  });

  it('same-day bmo (before market open) has already happened', () => {
    expect(isEarningsPending(today, 'bmo', today)).toBe(false);
  });

  it('same-day amc (after close) has not happened yet — still same-day risk', () => {
    expect(isEarningsPending(today, 'amc', today)).toBe(true);
  });

  it('same-day unknown report time is treated conservatively as still pending', () => {
    expect(isEarningsPending(today, null, today)).toBe(true);
  });
});

// v1.1.321: the sources date one share class and not the other. On 2026-09-23 Finnhub had GOOGL
// 10-27 and NWSA 11-04 and nothing for GOOG or NWS, so every earnings_calendar reader saw GOOG as
// having no earnings and passed it. The sibling's date is copied at the writer, where all ten
// readers see it.
describe('syncShareClassSiblings', () => {
  const TODAY = '2026-09-23';
  async function service() {
    const { openDatabase } = await import('../src/main/db/connection.js');
    const { runMigrations } = await import('../src/main/db/migrations.js');
    const { MIGRATIONS_DIR } = await import('./helpers.js');
    const { EarningsService } = await import('../src/main/services/earnings-service.js');
    const db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    return new EarningsService(db);
  }

  it('gives an undated class its sibling\'s date, in either direction', async () => {
    const s = await service();
    s.upsertFromProvider('GOOGL', '2026-10-27', 'amc', 'finnhub', true);
    s.upsertFromProvider('NWS', '2026-11-04', null, 'finnhub', false);
    expect(s.syncShareClassSiblings(TODAY)).toBe(2);
    expect(s.getForTicker('GOOG')).toMatchObject({ reportDate: '2026-10-27', reportTime: 'amc', source: 'share_class', confirmed: true });
    expect(s.getForTicker('NWSA')).toMatchObject({ reportDate: '2026-11-04', source: 'share_class', confirmed: false });
    // Idempotent: a second run writes nothing.
    expect(s.syncShareClassSiblings(TODAY)).toBe(0);
  });

  it('never overwrites a class\'s own future date or a manual entry', async () => {
    const s = await service();
    s.upsertFromProvider('GOOGL', '2026-10-27', 'amc', 'finnhub', true);
    s.upsertFromProvider('GOOG', '2026-10-28', 'amc', 'finnhub', true);
    s.upsertFromProvider('NWSA', '2026-11-04', null, 'finnhub', true);
    s.setManual('NWS', '2026-11-05', 'amc');
    expect(s.syncShareClassSiblings(TODAY)).toBe(0);
    expect(s.getForTicker('GOOG')!.reportDate).toBe('2026-10-28');
    expect(s.getForTicker('NWS')!.source).toBe('manual');
  });

  it('replaces a stale date, and follows the sibling when its date moves', async () => {
    const s = await service();
    s.upsertFromProvider('GOOG', '2026-07-23', 'amc', 'finnhub', true); // last quarter, passed
    s.upsertFromProvider('GOOGL', '2026-10-27', 'amc', 'finnhub', true);
    expect(s.syncShareClassSiblings(TODAY)).toBe(1);
    expect(s.getForTicker('GOOG')!.reportDate).toBe('2026-10-27');
    s.upsertFromProvider('GOOGL', '2026-10-29', 'amc', 'finnhub', true);
    expect(s.syncShareClassSiblings(TODAY)).toBe(1);
    expect(s.getForTicker('GOOG')).toMatchObject({ reportDate: '2026-10-29', source: 'share_class' });
  });

  it('never copies a copy back, and does nothing when neither class is dated', async () => {
    const s = await service();
    s.upsertFromProvider('GOOGL', '2026-10-27', 'amc', 'finnhub', true);
    s.syncShareClassSiblings(TODAY);
    s.deleteTicker('GOOGL');
    // GOOG holds only a share_class copy, which is not a source for GOOGL.
    expect(s.syncShareClassSiblings(TODAY)).toBe(0);
    expect(s.getForTicker('GOOGL')).toBeNull();
    expect(s.getForTicker('BRK.B')).toBeNull();
  });
});
