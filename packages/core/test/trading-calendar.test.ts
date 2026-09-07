import { describe, it, expect } from 'vitest';
import {
  buildTradingCalendar,
  nyseHolidays,
  nyseEarlyCloses
} from '../src/collector/trading-calendar.js';

/**
 * The trading calendar — 02 §2 (`ref_trading_day`).
 *
 * The centrepiece is the cross-check below: the generated rules are compared
 * against the **existing app's independently maintained** hardcoded list for
 * 2023–2027. Two sources built from different information agreeing on 50 dates
 * is far better evidence than either alone, and where they disagree the
 * disagreement is itself the finding.
 */

/**
 * Verbatim from the existing app's `iv-history-service.ts`, which has been in
 * production since 2026-05-30. Copied rather than imported: importing it would
 * make one source of truth wearing two names, and then the comparison proves
 * nothing.
 */
const EXISTING_APP_HOLIDAYS: readonly string[] = [
  '2023-01-02', '2023-01-16', '2023-02-20', '2023-04-07',
  '2023-05-29', '2023-06-19', '2023-07-04', '2023-09-04',
  '2023-11-23', '2023-12-25',
  '2024-01-01', '2024-01-15', '2024-02-19', '2024-03-29',
  '2024-05-27', '2024-06-19', '2024-07-04', '2024-09-02',
  '2024-11-28', '2024-12-25',
  '2025-01-01', '2025-01-09', '2025-01-20', '2025-02-17',
  '2025-04-18', '2025-05-26', '2025-06-19', '2025-07-04',
  '2025-09-01', '2025-11-27', '2025-12-25',
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03',
  '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07',
  '2026-11-26', '2026-12-25',
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26',
  '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06',
  '2027-11-25', '2027-12-24'
];

describe('the trading calendar — rules against the existing app\'s list', () => {
  it('reproduces every 2023–2027 holiday the existing app hardcodes', () => {
    const generated = new Set<string>();
    for (let y = 2023; y <= 2027; y++) {
      for (const h of nyseHolidays(y)) generated.add(h.date);
    }
    // The calendar builder folds in the unscheduled closures; the rules alone
    // cannot produce them, which is the next test.
    const closed = new Set(
      buildTradingCalendar('2023-01-01', '2027-12-31')
        .filter((d) => !d.isTradingDay && d.holidayName !== null)
        .map((d) => d.date)
    );

    const missing = EXISTING_APP_HOLIDAYS.filter((d) => !closed.has(d));
    expect(missing).toEqual([]);
  });

  it('generates no holiday the existing app does not have', () => {
    // The other direction matters just as much: a rule that fires too often
    // marks an open market closed, and the expected-count model then stops
    // expecting bars on a day that has them.
    const known = new Set(EXISTING_APP_HOLIDAYS);
    const extra = buildTradingCalendar('2023-01-01', '2027-12-31')
      .filter((d) => !d.isTradingDay && d.holidayName !== null && !known.has(d.date))
      .map((d) => `${d.date} (${d.holidayName})`);
    expect(extra).toEqual([]);
  });

  it('cannot generate 2025-01-09 from rules, and says so by its source', () => {
    // The National Day of Mourning for Jimmy Carter. No rule produces it, which
    // is exactly why the row records `manual` — the two kinds of closure stay
    // distinguishable in the data rather than in someone's memory.
    const fromRules = nyseHolidays(2025).map((h) => h.date);
    expect(fromRules).not.toContain('2025-01-09');

    const row = buildTradingCalendar('2025-01-01', '2025-01-31')
      .find((d) => d.date === '2025-01-09');
    expect(row?.isTradingDay).toBe(false);
    expect(row?.source).toBe('manual');
  });
});

describe('the trading calendar — the rules that are easy to get wrong', () => {
  it('does not observe New Year\'s Day when it falls on a Saturday', () => {
    // 2022-01-01 was a Saturday. The NYSE does NOT close the preceding Friday
    // for it, unlike every other fixed-date holiday — so Dec 31 2021 was a
    // normal session. This is the exception that makes a calendar right four
    // years in five if it is missed.
    const dates = nyseHolidays(2022).map((h) => h.date);
    expect(dates).not.toContain('2021-12-31');
    expect(dates).not.toContain('2022-01-01');

    const dec31 = buildTradingCalendar('2021-12-30', '2022-01-03')
      .find((d) => d.date === '2021-12-31');
    expect(dec31?.isTradingDay).toBe(true);
  });

  it('moves a Saturday Independence Day back to the Friday', () => {
    // 2026-07-04 is a Saturday, so the market closes Friday the 3rd.
    expect(nyseHolidays(2026).map((h) => h.date)).toContain('2026-07-03');
  });

  it('moves a Sunday New Year\'s Day forward to the Monday', () => {
    // 2023-01-01 was a Sunday, observed Monday the 2nd.
    expect(nyseHolidays(2023).map((h) => h.date)).toContain('2023-01-02');
  });

  it('computes Good Friday, the one holiday with no fixed date', () => {
    // Easter 2026 is April 5, so Good Friday is April 3.
    const good = nyseHolidays(2026).find((h) => h.name === 'Good Friday');
    expect(good?.date).toBe('2026-04-03');
    expect(nyseHolidays(2024).find((h) => h.name === 'Good Friday')?.date).toBe('2024-03-29');
  });

  it('starts Juneteenth in 2022 and not before', () => {
    expect(nyseHolidays(2021).some((h) => h.name === 'Juneteenth')).toBe(false);
    expect(nyseHolidays(2022).some((h) => h.name === 'Juneteenth')).toBe(true);
  });

  it('marks today (2026-09-07) as Labor Day, not a trading day', () => {
    const row = buildTradingCalendar('2026-09-01', '2026-09-30')
      .find((d) => d.date === '2026-09-07');
    expect(row?.isTradingDay).toBe(false);
    expect(row?.holidayName).toBe('Labor Day');
  });
});

describe('the trading calendar — early closes and expirations', () => {
  it('marks the day after Thanksgiving a 13:00 close', () => {
    const rows = buildTradingCalendar('2026-11-01', '2026-11-30');
    const friday = rows.find((d) => d.date === '2026-11-27');
    expect(friday?.isTradingDay).toBe(true);
    expect(friday?.earlyCloseTime).toBe('13:00');
  });

  it('lists the early closes a year actually has', () => {
    // 2026: July 3 is the Independence Day holiday itself (the 4th is a
    // Saturday), so it is NOT also an early close — a rule that emitted both
    // would mark a closed market as trading at 13:00.
    const closes = nyseEarlyCloses(2026);
    const dates = closes.map((c) => c.date).sort();
    expect(dates).toEqual(['2026-11-27', '2026-12-24']);
    expect(dates).not.toContain('2026-07-03');
  });

  it('includes the Independence Day eve session when the 4th is a weekday', () => {
    // 2024-07-04 was a Thursday, so July 3 was a normal session with a 13:00
    // close rather than the holiday itself.
    expect(nyseEarlyCloses(2024).map((c) => c.date)).toContain('2024-07-03');
  });

  it('gives an ordinary session no early close', () => {
    const rows = buildTradingCalendar('2026-11-01', '2026-11-30');
    expect(rows.find((d) => d.date === '2026-11-30')?.earlyCloseTime).toBeNull();
  });

  it('marks the third Friday as the monthly expiration', () => {
    const rows = buildTradingCalendar('2026-09-01', '2026-09-30');
    const expirations = rows.filter((d) => d.isMonthlyExpiration).map((d) => d.date);
    expect(expirations).toEqual(['2026-09-18']);
  });

  it('walks the expiration back when the third Friday is a holiday', () => {
    // The rare year where Good Friday IS the third Friday: 2019-04-19 was both,
    // so the expiration moved to Thursday the 18th. It needs a month where the
    // two genuinely collide — 2015-04-03 was Good Friday but only the FIRST
    // Friday, which is why the first version of this test asserted the wrong
    // date and the code was right all along.
    const rows = buildTradingCalendar('2019-04-01', '2019-04-30');
    const expirations = rows.filter((d) => d.isMonthlyExpiration).map((d) => d.date);
    expect(expirations).toEqual(['2019-04-18']);
    expect(rows.find((d) => d.date === '2019-04-19')?.isTradingDay).toBe(false);
    expect(rows.find((d) => d.date === '2019-04-19')?.holidayName).toBe('Good Friday');
  });

  it('gives every month exactly one expiration', () => {
    // A month with none would silently drop an expiry from the capture window;
    // a month with two would double-count it.
    const rows = buildTradingCalendar('2026-01-01', '2026-12-31');
    const byMonth = new Map<string, number>();
    for (const d of rows.filter((r) => r.isMonthlyExpiration)) {
      byMonth.set(d.date.slice(0, 7), (byMonth.get(d.date.slice(0, 7)) ?? 0) + 1);
    }
    expect(byMonth.size).toBe(12);
    expect([...byMonth.values()].every((n) => n === 1)).toBe(true);
  });
});

describe('the trading calendar — shape', () => {
  it('covers every calendar day in the range, not only sessions', () => {
    // The expected-count model asks "was the market open on X". A table holding
    // only open days cannot answer that for a holiday — absence would have to
    // mean both "closed" and "not seeded", which is the ambiguity the whole
    // table exists to remove.
    const rows = buildTradingCalendar('2026-09-01', '2026-09-30');
    expect(rows).toHaveLength(30);
    expect(rows.filter((d) => !d.isTradingDay)).toHaveLength(9); // 8 weekend days + Labor Day
  });

  it('produces about 252 trading days in a year', () => {
    const n = buildTradingCalendar('2026-01-01', '2026-12-31').filter((d) => d.isTradingDay).length;
    expect(n).toBeGreaterThanOrEqual(250);
    expect(n).toBeLessThanOrEqual(253);
  });
});
