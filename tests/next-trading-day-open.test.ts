// Regression tests for nextTradingDayOpen() — the brief's valid_until computation.
//
// Two bugs fixed (v1.1.26): it was based on the UTC date of generated_at, so an
// evening-ET run (already "tomorrow" in UTC) skipped a trading day; and it hardcoded
// 9:30 ET as 13:30Z (EDT), which is an hour early all winter (EST → 14:30Z).

import { describe, it, expect } from 'vitest';
import { nextTradingDayOpen } from '../src/main/services/jobs/daily-intelligence-brief-job.js';

describe('nextTradingDayOpen — valid_until (ET-date based, DST-aware)', () => {
  it('evening-ET run does not skip a trading day (the core bug)', () => {
    // Mon 2026-06-15 8:57pm EDT = 2026-06-16T00:57Z. ET date is the 15th, so the next
    // trading day is Tue the 16th — NOT Wed the 17th (the UTC-date version skipped a day).
    expect(nextTradingDayOpen('2026-06-16T00:57:38Z')).toBe('2026-06-16T13:30:00.000Z');
  });

  it('daytime-ET run rolls to the next trading day', () => {
    // Tue 2026-06-16 10:00am EDT → next trading day Wed the 17th, 9:30 EDT = 13:30Z.
    expect(nextTradingDayOpen('2026-06-16T14:00:00Z')).toBe('2026-06-17T13:30:00.000Z');
  });

  it('uses the correct UTC instant for 9:30 ET in winter (EST, not the EDT hardcode)', () => {
    // Tue 2026-01-06 3:00pm EST → next trading day Wed the 7th. 9:30 EST = 14:30Z (UTC−5),
    // where the old hardcoded 13:30Z would have been an hour early.
    expect(nextTradingDayOpen('2026-01-06T20:00:00Z')).toBe('2026-01-07T14:30:00.000Z');
  });

  it('skips the weekend (Friday → Monday)', () => {
    // Fri 2026-06-12 6:00pm EDT → Mon 2026-06-15, 9:30 EDT = 13:30Z.
    expect(nextTradingDayOpen('2026-06-12T22:00:00Z')).toBe('2026-06-15T13:30:00.000Z');
  });

  it('skips a holiday + weekend (Thu before Juneteenth → Monday)', () => {
    // Thu 2026-06-18 6:00pm EDT → Fri the 19th is Juneteenth (holiday), 20–21 weekend,
    // so the next trading day is Mon 2026-06-22.
    expect(nextTradingDayOpen('2026-06-18T22:00:00Z')).toBe('2026-06-22T13:30:00.000Z');
  });

  it('is stable regardless of the machine timezone (keys off ET only)', () => {
    // Same instant, asserted as a fixed UTC string — the result must not depend on the
    // host clock. (Runs in whatever TZ CI uses; the ET-based logic must still hold.)
    const r = nextTradingDayOpen('2026-06-16T00:57:38Z');
    expect(r).toBe('2026-06-16T13:30:00.000Z');
  });
});
