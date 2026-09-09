import { describe, it, expect } from 'vitest';
import { etTimestamp, etDate } from '../src/time.js';

/**
 * The ET timestamp both applications write — 02 §0.1.
 *
 * Every stamp in a generation carries the America/New_York offset.
 * `toISOString()` gives UTC, the two look alike, and the difference only shows
 * up in the evening once UTC has rolled over.
 *
 * This is not hypothetical here. Measured 2026-09-09, a corrupt generation's
 * `meta_open_handle` held these two rows side by side:
 *
 *     TradeAnalyzer 2  2026-09-08T03:02:53.252Z
 *     TradeAnalyzer    2026-09-08T23:54:19-04:00
 *
 * The first is 2026-09-07 **23:02 ET** — the evening before — and reads as the
 * small hours of the 8th. In the forensic record of a corruption, one of two
 * rows being compared was a day out.
 */
describe('etTimestamp', () => {
  it('stamps an evening in ET, not the next UTC day', () => {
    // 2026-09-08 03:02:53 UTC is 2026-09-07 23:02:53 in New York. This is the
    // exact instant that appeared misdated in the open-handle table.
    expect(etTimestamp(new Date('2026-09-08T03:02:53.252Z'))).toBe('2026-09-07T23:02:53-04:00');
  });

  it('carries the DST offset rather than a hardcoded one', () => {
    // A fixed -04:00 is right for about eight months a year, which is the worst
    // possible ratio for noticing it is wrong.
    expect(etTimestamp(new Date('2026-07-01T16:00:00Z'))).toBe('2026-07-01T12:00:00-04:00'); // EDT
    expect(etTimestamp(new Date('2026-01-15T17:00:00Z'))).toBe('2026-01-15T12:00:00-05:00'); // EST
  });

  it('is parseable back to the instant it was given, to the second', () => {
    // The round trip is the property that matters: a stamp that reads nicely and
    // parses to a different moment is worse than an ugly one.
    //
    // To the SECOND, because the format is `YYYY-MM-DDTHH:MM:SS±HH:MM` and drops
    // milliseconds by design — these are wall-clock stamps for a human reading a
    // forensic table, not high-resolution instants.
    for (const iso of [
      '2026-09-08T03:02:53.252Z',
      '2026-01-15T17:00:00Z',
      '2026-03-08T06:59:00Z', // minutes before the spring-forward transition
      '2026-11-01T05:30:00Z'  // inside the autumn fall-back hour
    ]) {
      const given = new Date(iso);
      const wholeSeconds = Math.floor(given.getTime() / 1000) * 1000;
      expect(new Date(etTimestamp(given)).getTime(), iso).toBe(wholeSeconds);
    }
  });

  it('renders midnight ET as 00, never 24', () => {
    // Some ICU versions return hour '24' for midnight with hour12:false. Left
    // unhandled it produces `T24:00:00`, which `Date` parses as invalid.
    const midnight = etTimestamp(new Date('2026-06-15T04:00:00Z')); // 00:00 EDT
    expect(midnight).toBe('2026-06-15T00:00:00-04:00');
    expect(Number.isNaN(new Date(midnight).getTime())).toBe(false);
  });

  it('never emits a Z', () => {
    // The whole failure mode in one assertion.
    expect(etTimestamp(new Date('2026-09-08T03:02:53.252Z'))).not.toContain('Z');
  });
});

describe('etDate', () => {
  it('gives the trading date, not the UTC date', () => {
    // An evening run in ET is still that day's trading date. Getting this wrong
    // in the other direction — local weekday maths serialised through
    // toISOString — once shifted every weekly expiration onto Saturday and
    // starved the agent of option contracts for ten days.
    expect(etDate(new Date('2026-09-08T03:02:53.252Z'))).toBe('2026-09-07');
    expect(etDate(new Date('2026-09-08T16:00:00Z'))).toBe('2026-09-08');
  });
});
