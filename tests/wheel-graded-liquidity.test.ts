// Graded wheel liquidity scoring (WHEEL_GRADED_LIQUIDITY, default OFF).
//
// The legacy score is three binary gates and two of them almost never fire: a 5% RELATIVE bid-ask
// on a 25-delta put is institutional-grade tight (WMT at OI 13,824 / spread 5.2% misses by 0.2pp)
// and per-strike volume >= 50 is rare. So it collapses to a near-constant 0 or 4 and ranks
// nothing. Calibrated on 1,278 real market-hours short-put quotes
// (scripts/fr-wheel-liquidity-calibration.mjs): legacy uses 6 distinct values with 38% scoring 0
// and correlates -0.419 with real execution cost; the graded scheme uses 21, scores 0 on 2%, and
// correlates -0.799.
import { describe, it, expect, afterEach } from 'vitest';
import { wheelOptionLiquidityScore, wheelGradedLiquidityEnabled } from '../src/main/services/analysis-service.js';

const ORIGINAL = process.env['WHEEL_GRADED_LIQUIDITY'];
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env['WHEEL_GRADED_LIQUIDITY'];
  else process.env['WHEEL_GRADED_LIQUIDITY'] = ORIGINAL;
});

/** bid/ask giving an exact relative spread around a ~$1 mid. */
const quoteFor = (spreadPct: number, openInterest: number, volume: number) => {
  const mid = 1;
  const half = (spreadPct / 100) * mid / 2;
  return { bid: mid - half, ask: mid + half, openInterest, volume };
};
const graded = (c: Parameters<typeof wheelOptionLiquidityScore>[0]) => wheelOptionLiquidityScore(c, true);
const legacy = (c: Parameters<typeof wheelOptionLiquidityScore>[0]) => wheelOptionLiquidityScore(c, false);

describe('WHEEL_GRADED_LIQUIDITY gate', () => {
  it('is OFF by default — FR-SEY-5, must stay inert until validated', () => {
    delete process.env['WHEEL_GRADED_LIQUIDITY'];
    expect(wheelGradedLiquidityEnabled()).toBe(false);
    // Default call path must reproduce the legacy gates exactly.
    const c = quoteFor(13.9, 0, 39);
    expect(wheelOptionLiquidityScore(c)).toBe(legacy(c));
  });

  it('WHEEL_GRADED_LIQUIDITY=1 turns it on; any other value does not', () => {
    process.env['WHEEL_GRADED_LIQUIDITY'] = '1';
    expect(wheelGradedLiquidityEnabled()).toBe(true);
    process.env['WHEEL_GRADED_LIQUIDITY'] = 'yes';
    expect(wheelGradedLiquidityEnabled()).toBe(false);
  });

  it('still returns null when there is no contract, under either scheme', () => {
    expect(graded(null)).toBeNull();
    expect(legacy(null)).toBeNull();
  });
});

describe('legacy scheme — the defect being fixed', () => {
  it('scores a genuinely cheap contract 0/10 (the KO case)', () => {
    // KO, 2026-08: spread 13.9%, volume 39, OI 0 — real entry cost only 3.6% of credit.
    expect(legacy(quoteFor(13.9, 0, 39))).toBe(0);
  });

  it('misses the spread gate by a hair on a deeply liquid contract (the WMT case)', () => {
    // WMT: OI 13,824, spread 5.2% — 0.2pp over the <=5% gate, so only the OI term pays.
    expect(legacy(quoteFor(5.2, 13_824, 0))).toBe(4);
    // A hair tighter and it jumps 4 points. That cliff is the problem.
    expect(legacy(quoteFor(4.9, 13_824, 0))).toBe(8);
  });
});

describe('graded scheme', () => {
  it('gives the KO contract real credit instead of zero', () => {
    const score = graded(quoteFor(13.9, 0, 39));
    expect(score).toBeGreaterThan(3);
    expect(score).toBeLessThan(6);
  });

  it('has no cliff — a 0.3pp spread move cannot swing the score 4 points', () => {
    const a = graded(quoteFor(5.2, 13_824, 0))!;
    const b = graded(quoteFor(4.9, 13_824, 0))!;
    expect(Math.abs(a - b)).toBeLessThan(0.2);
    // ...whereas the legacy scheme swings the full 4.
    expect(Math.abs(legacy(quoteFor(5.2, 13_824, 0))! - legacy(quoteFor(4.9, 13_824, 0))!)).toBe(4);
  });

  it('is monotone decreasing in spread', () => {
    const scores = [5, 10, 20, 30, 40].map((s) => graded(quoteFor(s, 500, 50))!);
    for (let i = 1; i < scores.length; i++) expect(scores[i]!).toBeLessThan(scores[i - 1]!);
  });

  it('is monotone increasing in open interest and volume', () => {
    const byOi = [1, 50, 500, 5000].map((oi) => graded(quoteFor(15, oi, 10))!);
    for (let i = 1; i < byOi.length; i++) expect(byOi[i]!).toBeGreaterThan(byOi[i - 1]!);
    const byVol = [1, 10, 100].map((v) => graded(quoteFor(15, 100, v))!);
    for (let i = 1; i < byVol.length; i++) expect(byVol[i]!).toBeGreaterThan(byVol[i - 1]!);
  });

  it('stays within 0–10 at both extremes', () => {
    expect(graded(quoteFor(0, 1_000_000, 1_000_000))).toBeLessThanOrEqual(10);
    expect(graded(quoteFor(200, 0, 0))).toBeGreaterThanOrEqual(0);
    // A wide-spread, no-interest contract should score near the floor.
    expect(graded(quoteFor(200, 0, 0))).toBeLessThan(1);
  });

  it('treats a LOCKED quote as zero spread (full credit), same as legacy', () => {
    // v3 snapshots use day.close as the bid/ask proxy — there genuinely is no spread to measure.
    const locked = { bid: 1, ask: 1, openInterest: 10, volume: 1 };
    expect(graded(locked)).toBeGreaterThanOrEqual(4);   // full spread credit
    expect(legacy(locked)).toBe(4);
  });

  it('gives a NO-BID contract zero spread credit — worst liquidity, not best', () => {
    // The shared spread expression reports 0 for any degenerate quote, which would otherwise hand
    // a contract nobody will buy the same full credit as a locked one. Legacy has this bug
    // (it pays +4); the graded branch does not. Unreachable via findSuitableChain (`bid > 0`).
    const noBid = { bid: 0, ask: 2, openInterest: 0, volume: 0 };
    expect(graded(noBid)).toBe(0);
    expect(legacy(noBid)).toBe(4);   // documents the legacy behaviour, deliberately unchanged
  });

  it('discriminates where legacy is flat — three contracts legacy scores identically', () => {
    // All three clear OI>=50 and fail the other two gates ⇒ legacy says 4 for every one.
    const a = quoteFor(6, 60, 0);      // nearly tight, thin interest
    const b = quoteFor(20, 800, 0);    // mediocre spread, deep interest
    const c = quoteFor(38, 55, 0);     // wide spread, thin interest
    expect([legacy(a), legacy(b), legacy(c)]).toEqual([4, 4, 4]);
    const g = [graded(a)!, graded(b)!, graded(c)!];
    expect(new Set(g.map((x) => x.toFixed(2))).size).toBe(3);
    expect(g[1]).toBeGreaterThan(g[2]!);   // deep interest + better spread beats wide + thin
  });
});
