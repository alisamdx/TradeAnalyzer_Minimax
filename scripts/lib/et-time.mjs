// ET calendar date and hour for the analysis scripts.
//
// Several scripts used a fixed −4 h offset (`getTime() - 4 * 3600_000`). That is right only
// under EDT. From the first Sunday of November it reads one hour late: every ET hour comes out
// one too high, and a timestamp from 23:00 to 23:59 ET lands on the next day. Intl with
// America/New_York switches between EDT and EST on its own.

const DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
});
const HOUR = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23',
});

/** 'YYYY-MM-DD' in ET for an ISO string, epoch ms or Date. */
export function etDate(when) {
  return DATE.format(new Date(when));
}

/** ET calendar date and hour (0–23) for an ISO string, epoch ms or Date. */
export function etParts(when) {
  const d = new Date(when);
  return { date: DATE.format(d), hour: Number(HOUR.format(d)) };
}
