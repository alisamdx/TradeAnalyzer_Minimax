// Regression: the /api/v1/options/:ticker route guesses upcoming Friday
// expirations when no explicit expiration is given. A local-time / UTC mismatch
// in the original helper shifted every date to Saturday when run in the evening
// (local clock past UTC midnight). E*Trade lists Friday expirations only, so the
// chain lookups missed every guess and the endpoint returned an empty array —
// which starved the TraderAgent scout of contracts and produced zero new trades.
// see CHANGELOG v1.1.47.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextFridays } from '../src/main/api/routes-options.js';

describe('nextFridays (options route expiration guesses)', () => {
  afterEach(() => vi.useRealTimers());

  it('returns only Friday (UTC) dates regardless of run time of day', () => {
    // Evening in a timezone behind UTC: 2026-06-17 21:00 EDT == 2026-06-18 01:00 UTC.
    // This is precisely when the old local/UTC mix produced Saturdays.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-18T01:00:00Z'));

    const fridays = nextFridays(8);
    expect(fridays).toHaveLength(8);
    for (const d of fridays) {
      // 5 == Friday. The bug emitted 6 (Saturday).
      expect(new Date(`${d}T12:00:00Z`).getUTCDay()).toBe(5);
    }
    // The next real Friday after 2026-06-18 is the 19th, not Saturday the 20th.
    expect(fridays[0]).toBe('2026-06-19');
    // Spaced exactly one week apart.
    expect(fridays).toEqual([
      '2026-06-19', '2026-06-26', '2026-07-03', '2026-07-10',
      '2026-07-17', '2026-07-24', '2026-07-31', '2026-08-07',
    ]);
  });

  it('skips the current day when it is already Friday', () => {
    vi.useFakeTimers();
    // 2026-07-17 is a Friday (12:00 UTC).
    vi.setSystemTime(new Date('2026-07-17T12:00:00Z'));
    const fridays = nextFridays(3);
    expect(fridays[0]).toBe('2026-07-24'); // not 07-17
    expect(fridays).toEqual(['2026-07-24', '2026-07-31', '2026-08-07']);
  });
});
