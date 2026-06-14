import { describe, it, expect } from 'vitest';
import { isMarketOpen, etDateString } from '../src/main/execution/market-hours.js';

// 2026-06-15 is a Monday; June is EDT (UTC−4), so 13:30Z = 09:30 ET, 20:00Z = 16:00 ET.

describe('isMarketOpen', () => {
  it('is open mid-session on a weekday', () => {
    expect(isMarketOpen(new Date('2026-06-15T18:00:00Z'))).toBe(true); // Mon 14:00 ET
  });

  it('is open exactly at the 09:30 ET bell and closed just before', () => {
    expect(isMarketOpen(new Date('2026-06-15T13:30:00Z'))).toBe(true); // 09:30 ET
    expect(isMarketOpen(new Date('2026-06-15T13:29:00Z'))).toBe(false); // 09:29 ET
  });

  it('is closed at and after the 16:00 ET close', () => {
    expect(isMarketOpen(new Date('2026-06-15T20:00:00Z'))).toBe(false); // 16:00 ET
    expect(isMarketOpen(new Date('2026-06-15T19:59:00Z'))).toBe(true); // 15:59 ET
  });

  it('is closed on weekends', () => {
    expect(isMarketOpen(new Date('2026-06-13T18:00:00Z'))).toBe(false); // Sat
    expect(isMarketOpen(new Date('2026-06-14T18:00:00Z'))).toBe(false); // Sun
  });

  it('is closed on a configured holiday', () => {
    const holidays = new Set(['2026-06-15']);
    expect(isMarketOpen(new Date('2026-06-15T18:00:00Z'), { holidays })).toBe(false);
  });
});

describe('etDateString', () => {
  it('returns the ET calendar date', () => {
    expect(etDateString(new Date('2026-06-15T18:00:00Z'))).toBe('2026-06-15');
  });

  it('rolls to the previous ET day before ET midnight', () => {
    // 03:00Z = 23:00 ET the previous day
    expect(etDateString(new Date('2026-06-15T03:00:00Z'))).toBe('2026-06-14');
  });
});
