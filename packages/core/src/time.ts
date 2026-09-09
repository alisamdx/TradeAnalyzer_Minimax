/**
 * The one place an Eastern-Time timestamp is built — NewApp 02 §0.1.
 *
 * Every timestamp stored in a generation is ISO-8601 **with the America/New_York
 * offset**. `new Date().toISOString()` gives UTC, and the two are
 * indistinguishable at a glance: both are ISO-8601, both end in something that
 * looks like a zone. The difference only shows up in the evening, when UTC has
 * already rolled over and every stamp lands on the following day.
 *
 * That is a documented bug class in this project — it once shifted an entire
 * expiration calculation onto Saturday and starved the agent of option contracts
 * for ten days — and `tests/collector-host.test.ts` pins the collector host
 * against it. **The new exe had the bug anyway**, because the rule lived in a
 * test attached to one implementation rather than in a function both could call.
 *
 * Measured 2026-09-09: a corrupt generation's `meta_open_handle` read
 * `TradeAnalyzer 2 … 2026-09-08T03:02:53.252Z` beside
 * `TradeAnalyzer … 2026-09-08T23:54:19-04:00`. The first is 2026-09-07 **23:02
 * ET** — the evening before — and reads as the small hours of the 8th. In the
 * forensic record of a corruption, a timestamp off by a day in one of two rows
 * being compared is worse than no timestamp.
 *
 * So the implementation is here, and both applications call it.
 */

/**
 * `YYYY-MM-DDTHH:MM:SS±HH:MM` in America/New_York.
 *
 * Built from `Intl` parts and a measured offset rather than from a fixed `-04:00`
 * or `-05:00`, so it stays correct across the DST boundary — a hardcoded offset
 * is right for about eight months of the year, which is the worst possible ratio
 * for noticing.
 */
export function etTimestamp(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(now);

  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '00';

  // `hour` comes back as '24' at midnight in some ICU versions; `% 24` maps it
  // to the '00' the format expects without moving the date, which the parts
  // already carry correctly.
  const utcMs = Date.UTC(
    Number(get('year')),
    Number(get('month')) - 1,
    Number(get('day')),
    Number(get('hour')) % 24,
    Number(get('minute')),
    Number(get('second'))
  );

  const offsetMinutes = Math.round((utcMs - now.getTime()) / 60_000);
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  const offset = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;

  return `${get('year')}-${get('month')}-${get('day')}T${get('hour') === '24' ? '00' : get('hour')}:${get('minute')}:${get('second')}${offset}`;
}

/** `YYYY-MM-DD` in America/New_York — the trading date, never the UTC date. */
export function etDate(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(now);
}
