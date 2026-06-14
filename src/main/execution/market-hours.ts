// US equity-options regular-hours gate (Requirements/v2-execution §1.8, §3.2).
//
// Pure + DST-correct via Intl (America/New_York). The core consults this to decide when
// entries/management may run; reconciliation + safety can run any time the engine is up.
// Holidays are passed in (a small ET 'YYYY-MM-DD' set) — left to config rather than
// hard-coding a calendar that drifts year to year.

const RTH_OPEN_MIN = 9 * 60 + 30; // 09:30 ET
const RTH_CLOSE_MIN = 16 * 60; // 16:00 ET

export interface MarketHoursOptions {
  holidays?: ReadonlySet<string>; // ET dates 'YYYY-MM-DD' the market is closed
}

interface EtParts {
  date: string; // YYYY-MM-DD
  weekday: number; // 0=Sun … 6=Sat
  minutes: number; // minutes since ET midnight
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function etParts(date: Date): EtParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  const hour = get('hour') === '24' ? 0 : parseInt(get('hour'), 10); // Node can emit '24' at midnight
  const minute = parseInt(get('minute'), 10);
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    weekday: WEEKDAY_INDEX[get('weekday')] ?? 0,
    minutes: hour * 60 + minute,
  };
}

/** The ET calendar date ('YYYY-MM-DD') for `date` — used for the day-P&L anchor + holidays. */
export function etDateString(date: Date): string {
  return etParts(date).date;
}

/** True when US equity options are in regular trading hours (Mon–Fri 09:30–16:00 ET, non-holiday). */
export function isMarketOpen(date: Date, opts: MarketHoursOptions = {}): boolean {
  const { date: etDate, weekday, minutes } = etParts(date);
  if (weekday === 0 || weekday === 6) return false; // weekend
  if (opts.holidays?.has(etDate)) return false;
  return minutes >= RTH_OPEN_MIN && minutes < RTH_CLOSE_MIN;
}
