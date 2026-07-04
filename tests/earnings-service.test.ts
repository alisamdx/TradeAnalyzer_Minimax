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
