import { etTimestamp } from '../time.js';

/** When Polygon's daily bar for a date stops settling — spec 02 `is_final`, 04 §phase 2. */
export const BAR_SETTLED_AT_ET = '17:00';

/**
 * Whether a bar for `tradingDate` received at `respondedAt` is final: the response arrived on a
 * later ET date, or on the trading date at or after 17:00 ET (v1.1.287). No response time is no
 * evidence, so it stays provisional.
 *
 * Until v1.1.287 every same-day bar was stored provisional whatever the clock said, so QC-203
 * reported "1083 of 1083 bars are still non-final at run end" on every run of the generation — a
 * check that could not pass, for a run that fetched at 18:23 ET, long after the window the spec
 * sets (`is_final` from `respondedAt >= 17:00 ET`).
 */
export function barSettled(tradingDate: string, respondedAt: string | null): boolean {
  if (respondedAt === null) return false;
  const ms = Date.parse(respondedAt);
  if (Number.isNaN(ms)) return false;
  const et = etTimestamp(new Date(ms));
  const date = et.slice(0, 10);
  return date > tradingDate || (date === tradingDate && et.slice(11, 16) >= BAR_SETTLED_AT_ET);
}
