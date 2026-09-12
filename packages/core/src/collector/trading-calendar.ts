import type { SqliteLike } from '../db/sqlite-like.js';
import type { CollectorHost } from './host.js';

/**
 * The NYSE trading calendar — 02 §2 (`ref_trading_day`, Q16.2).
 *
 * **Generated from exchange rules, not from a pasted list**, which is what the
 * dictionary's `source = 'nyse_rules'` has always meant. A hardcoded table of
 * dates works until the year it runs out, and it runs out silently: the
 * existing app's covers 2023–2027, so a 2028 run would read every weekday as a
 * trading day and quietly expect bars on Christmas.
 *
 * The expected-count model in 03 reads this table. Without it no holiday can be
 * distinguished from a collection failure, and — the reason this was built
 * before the first daily run rather than after — **preflight and the watchdog
 * both fail open on an empty calendar.** That is the right default (a needless
 * run costs calls, a skipped one costs a day that cannot be recovered), but it
 * means an unseeded calendar produces weekend runs writing Saturday-dated
 * snapshots of Friday's data, and a watchdog emailing "no daily run" every
 * Saturday and Sunday. A watchdog that cries on a schedule is one nobody reads.
 *
 * **Rules cannot produce every closure**, and that is a real limit rather than
 * an oversight. 2025-01-09 was the National Day of Mourning for Jimmy Carter —
 * an unscheduled closure no rule generates. Those are listed explicitly and
 * carry `source = 'manual'`, so the two kinds stay distinguishable in the row
 * itself; `polygon_marketstatus` is the intended yearly refresh for the ones
 * nobody has heard about yet.
 */

/** Closures no rule can generate. Each is a decision someone made, so each is listed by hand. */
const UNSCHEDULED_CLOSURES: Readonly<Record<string, string>> = {
  '2025-01-09': 'National Day of Mourning (Jimmy Carter)',
  '2018-12-05': 'National Day of Mourning (George H. W. Bush)',
  '2012-10-29': 'Hurricane Sandy',
  '2012-10-30': 'Hurricane Sandy'
};

function iso(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Day of week in a single time base — 0 Sunday .. 6 Saturday. */
function dow(date: string): number {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/** The n-th given weekday of a month (n is 1-based). */
function nthWeekday(year: number, month: number, weekday: number, n: number): string {
  const first = iso(year, month, 1);
  const shift = (weekday - dow(first) + 7) % 7;
  return addDays(first, shift + (n - 1) * 7);
}

/** The last given weekday of a month. */
function lastWeekday(year: number, month: number, weekday: number): string {
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const last = iso(year, month, daysInMonth);
  return addDays(last, -((dow(last) - weekday + 7) % 7));
}

/**
 * Easter Sunday — the anonymous Gregorian algorithm.
 *
 * Present only because Good Friday is the one NYSE holiday with no fixed date
 * and no n-th-weekday rule, so a calendar that skips it marks a closed market
 * open every spring.
 */
function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return iso(year, month, day);
}

/**
 * A fixed-date holiday's observed date.
 *
 * Saturday moves to the preceding Friday and Sunday to the following Monday —
 * **except New Year's Day**, which the NYSE simply does not observe when it
 * falls on a Saturday (December 31 stays a normal session). Encoding that
 * exception is the difference between a calendar that is right and one that is
 * right four years in five.
 */
function observed(date: string, opts: { readonly saturdayToFriday: boolean }): string | null {
  const day = dow(date);
  if (day === 6) return opts.saturdayToFriday ? addDays(date, -1) : null;
  if (day === 0) return addDays(date, 1);
  return date;
}

export interface HolidayRule {
  readonly date: string;
  readonly name: string;
}

/** Every scheduled NYSE closure in one year. */
export function nyseHolidays(year: number): readonly HolidayRule[] {
  const out: HolidayRule[] = [];
  const push = (date: string | null, name: string): void => {
    if (date && date.slice(0, 4) === String(year)) out.push({ date, name });
  };

  push(observed(iso(year, 1, 1), { saturdayToFriday: false }), "New Year's Day");
  // MLK Day has been an NYSE holiday since 1998.
  if (year >= 1998) push(nthWeekday(year, 1, 1, 3), 'Martin Luther King Jr. Day');
  push(nthWeekday(year, 2, 1, 3), "Washington's Birthday");
  push(addDays(easterSunday(year), -2), 'Good Friday');
  push(lastWeekday(year, 5, 1), 'Memorial Day');
  // Juneteenth became a market holiday in 2022, its first year as a federal one.
  if (year >= 2022) push(observed(iso(year, 6, 19), { saturdayToFriday: true }), 'Juneteenth');
  push(observed(iso(year, 7, 4), { saturdayToFriday: true }), 'Independence Day');
  push(nthWeekday(year, 9, 1, 1), 'Labor Day');
  push(nthWeekday(year, 11, 4, 4), 'Thanksgiving Day');
  push(observed(iso(year, 12, 25), { saturdayToFriday: true }), 'Christmas Day');

  return out;
}

/** Sessions closing at 13:00 ET. */
export function nyseEarlyCloses(year: number): readonly HolidayRule[] {
  const out: HolidayRule[] = [];
  const holidays = new Set(nyseHolidays(year).map((h) => h.date));
  const isSession = (d: string): boolean => dow(d) !== 0 && dow(d) !== 6 && !holidays.has(d);

  // The day after Thanksgiving.
  const blackFriday = addDays(nthWeekday(year, 11, 4, 4), 1);
  if (isSession(blackFriday)) out.push({ date: blackFriday, name: 'Day after Thanksgiving' });

  // July 3, only when it is itself a session and the 4th is the holiday.
  const julyThird = iso(year, 7, 3);
  if (isSession(julyThird) && dow(iso(year, 7, 4)) !== 0 && dow(iso(year, 7, 4)) !== 6) {
    out.push({ date: julyThird, name: 'Independence Day eve' });
  }

  // Christmas Eve, only when Christmas itself falls Tuesday–Friday, which is
  // what leaves the 24th a weekday session rather than part of the weekend.
  const eve = iso(year, 12, 24);
  if (isSession(eve)) out.push({ date: eve, name: 'Christmas Eve' });

  return out;
}

export interface TradingDayRow {
  readonly date: string;
  readonly isTradingDay: boolean;
  readonly earlyCloseTime: string | null;
  readonly holidayName: string | null;
  readonly isMonthlyExpiration: boolean;
  readonly source: 'nyse_rules' | 'manual';
}

/**
 * Every calendar day in the range, marked.
 *
 * `is_monthly_expiration` is the third Friday, **or the preceding Thursday when
 * that Friday is a holiday** — options settle on the last session before the
 * Saturday expiration, and the one year in several where Good Friday lands on a
 * third Friday is exactly the year a naive rule silently points at a closed
 * market.
 */
export function buildTradingCalendar(from: string, to: string): readonly TradingDayRow[] {
  const rows: TradingDayRow[] = [];
  const firstYear = Number(from.slice(0, 4));
  const lastYear = Number(to.slice(0, 4));

  const holidays = new Map<string, string>();
  const earlyCloses = new Map<string, string>();
  const expirations = new Set<string>();

  for (let y = firstYear; y <= lastYear; y++) {
    for (const h of nyseHolidays(y)) holidays.set(h.date, h.name);
    for (const e of nyseEarlyCloses(y)) earlyCloses.set(e.date, e.name);
  }
  for (const [date, name] of Object.entries(UNSCHEDULED_CLOSURES)) {
    const y = Number(date.slice(0, 4));
    if (y >= firstYear && y <= lastYear) holidays.set(date, name);
  }

  for (let y = firstYear; y <= lastYear; y++) {
    for (let m = 1; m <= 12; m++) {
      let day = nthWeekday(y, m, 5, 3); // third Friday
      // Walk back to the last session on or before it.
      while (holidays.has(day) || dow(day) === 0 || dow(day) === 6) day = addDays(day, -1);
      expirations.add(day);
    }
  }

  for (let date = from; date <= to; date = addDays(date, 1)) {
    const weekday = dow(date) !== 0 && dow(date) !== 6;
    const holiday = holidays.get(date) ?? null;
    const isTradingDay = weekday && holiday === null;

    rows.push({
      date,
      isTradingDay,
      earlyCloseTime: isTradingDay && earlyCloses.has(date) ? '13:00' : null,
      holidayName: holiday,
      isMonthlyExpiration: isTradingDay && expirations.has(date),
      source: date in UNSCHEDULED_CLOSURES ? 'manual' : 'nyse_rules'
    });
  }
  return rows;
}

/**
 * Trading days in `[from, to]`, ascending.
 *
 * Reads `ref_trading_day` and falls back to the rule generator for any date the
 * table does not hold — so a reader never mistakes an unseeded calendar for a
 * range with no sessions in it, which would turn "count the sessions since X"
 * into zero and "walk back day by day" into a walk over nothing. Where the table
 * does hold a date it wins, because an operator's `manual` row outranks a rule.
 */
/**
 * The last session strictly before `date`, or null if none is in range.
 *
 * Looks back a fortnight, which covers any weekend plus the longest run of
 * consecutive market holidays. Written for the EDGAR insider sweep: the daily
 * form index for a date is published late that evening, after the collector
 * runs, so "today's index" is routinely a 404 and yesterday's is the honest
 * fallback.
 */
export function previousTradingDay(db: SqliteLike, date: string): string | null {
  const from = addDays(date, -14);
  const days = tradingDaysInRange(db, from, date).filter((d) => d < date);
  return days.length > 0 ? (days[days.length - 1] as string) : null;
}

export function tradingDaysInRange(db: SqliteLike, from: string, to: string): readonly string[] {
  if (from > to) return [];
  const stored = new Map(
    (
      db
        .prepare('SELECT date, is_trading_day FROM ref_trading_day WHERE date BETWEEN ? AND ?')
        .all(from, to) as { date: string; is_trading_day: number }[]
    ).map((r) => [r.date, r.is_trading_day === 1] as const)
  );
  return buildTradingCalendar(from, to)
    .filter((r) => stored.get(r.date) ?? r.isTradingDay)
    .map((r) => r.date);
}

export interface CalendarSeedResult {
  readonly from: string;
  readonly to: string;
  readonly written: number;
  readonly tradingDays: number;
}

/**
 * Seeds or tops up the calendar — five years back, two years forward (02 §2).
 *
 * Idempotent by upsert and cheap enough to run on every daily run, which is why
 * it is called from preflight rather than left to a one-shot: a calendar that
 * only exists if somebody remembered to seed it is a calendar that will be
 * missing on the day it matters. `manual` rows are never overwritten by the
 * rule generator — an operator's ruling outranks a rule.
 */
export function ensureTradingCalendar(
  db: SqliteLike,
  host: CollectorHost,
  asOf: string,
  opts: { readonly yearsBack?: number; readonly yearsForward?: number } = {}
): CalendarSeedResult {
  const year = Number(asOf.slice(0, 4));
  const from = `${year - (opts.yearsBack ?? 5)}-01-01`;
  const to = `${year + (opts.yearsForward ?? 2)}-12-31`;

  const rows = buildTradingCalendar(from, to);
  const observedAt = host.nowET();

  const upsert = db.prepare(
    `INSERT INTO ref_trading_day
       (date, is_trading_day, early_close_time, holiday_name, is_monthly_expiration, source, observed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET
       is_trading_day = excluded.is_trading_day,
       early_close_time = excluded.early_close_time,
       holiday_name = excluded.holiday_name,
       is_monthly_expiration = excluded.is_monthly_expiration,
       observed_at = excluded.observed_at
     WHERE ref_trading_day.source <> 'manual'`
  );

  let written = 0;
  for (const r of rows) {
    const info = upsert.run(
      r.date,
      r.isTradingDay ? 1 : 0,
      r.earlyCloseTime,
      r.holidayName,
      r.isMonthlyExpiration ? 1 : 0,
      r.source,
      observedAt
    );
    written += info.changes;
  }

  return {
    from,
    to,
    written,
    tradingDays: rows.filter((r) => r.isTradingDay).length
  };
}
