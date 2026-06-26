import { describe, it, expect } from 'vitest';
import { markStructurePnl, structureReturnPct, type MarkLeg } from '../src/main/services/structure-mark.js';

const ENTRY = '2026-06-01', EXP = '2026-07-01';
const csp = (K: number): MarkLeg => ({ action: 'sell', side: 'put', strike: K, expiration: EXP, iv: 40, qty: 1 });
const longPut = (K: number): MarkLeg => ({ action: 'buy', side: 'put', strike: K, expiration: EXP, iv: 40, qty: 1 });
const shortCall = (K: number): MarkLeg => ({ action: 'sell', side: 'call', strike: K, expiration: EXP, iv: 40, qty: 1 });

describe('markStructurePnl', () => {
  it('is exactly 0 at entry (same date + price)', () => {
    expect(markStructurePnl([csp(95)], 100, ENTRY, 100, ENTRY)).toBeCloseTo(0, 6);
  });

  it('a short put (CSP) profits when the stock rises, loses when it falls', () => {
    const up = markStructurePnl([csp(95)], 100, ENTRY, 110, '2026-06-10')!;
    const down = markStructurePnl([csp(95)], 100, ENTRY, 90, '2026-06-10')!;
    expect(up).toBeGreaterThan(0);
    expect(down).toBeLessThan(0);
  });

  it('a short call profits when the stock falls', () => {
    expect(markStructurePnl([shortCall(105)], 100, ENTRY, 90, '2026-06-10')!).toBeGreaterThan(0);
    expect(markStructurePnl([shortCall(105)], 100, ENTRY, 115, '2026-06-10')!).toBeLessThan(0);
  });

  it('a put credit spread profit is capped (less than the naked short put on a big up move)', () => {
    const spread = markStructurePnl([csp(95), longPut(90)], 100, ENTRY, 120, '2026-06-20')!;
    const naked = markStructurePnl([csp(95)], 100, ENTRY, 120, '2026-06-20')!;
    expect(spread).toBeGreaterThan(0);
    expect(spread).toBeLessThanOrEqual(naked + 1e-6); // long wing costs a little
  });

  it('theta accrues for a short premium structure held flat (small positive as time passes)', () => {
    const flatLater = markStructurePnl([csp(95), longPut(90)], 100, ENTRY, 100, '2026-06-25')!;
    expect(flatLater).toBeGreaterThan(0); // net theta captured, price unchanged
  });

  it('returns null on unusable legs', () => {
    expect(markStructurePnl([], 100, ENTRY, 110, '2026-06-10')).toBeNull();
    expect(markStructurePnl([{ ...csp(95), iv: null }], 100, ENTRY, 110, '2026-06-10')).toBeNull();
    expect(markStructurePnl([csp(95)], 0, ENTRY, 110, '2026-06-10')).toBeNull();
  });

  it('structureReturnPct = pnl / |entryPremium| × 100', () => {
    expect(structureReturnPct(110, 220)).toBeCloseTo(50);
    expect(structureReturnPct(-110, 220)).toBeCloseTo(-50);
    expect(structureReturnPct(50, null)).toBeNull();
    expect(structureReturnPct(null, 220)).toBeNull();
  });
});
