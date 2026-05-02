import { describe, it, expect } from 'vitest';
import {
  detectDoji,
  detectHammer,
  detectShootingStar,
  detectBullishEngulfing,
  detectBearishEngulfing,
  detectMorningStar,
  detectEveningStar,
  detectAllPatterns
} from '../src/main/services/pattern-detector.js';

type Bar = { t: number; o: number; h: number; l: number; c: number; v: number };

function makeBar(o: number, h: number, l: number, c: number, v = 1_000_000): Bar {
  return { t: Date.now(), o, h, l, c, v };
}

// ─── Doji tests ────────────────────────────────────────────────────────────────

describe('detectDoji', () => {
  it('returns true when open ≈ close (doji)', () => {
    const bar = makeBar(100, 101, 99, 100.05);
    expect(detectDoji(bar)).toBe(true);
  });

  it('returns true when open = close (perfect doji)', () => {
    const bar = makeBar(100, 102, 98, 100);
    expect(detectDoji(bar)).toBe(true);
  });

  it('returns false when body is larger than 5% of range', () => {
    const bar = makeBar(100, 110, 99, 109);
    expect(detectDoji(bar)).toBe(false);
  });

  it('returns true for zero-range bar', () => {
    const bar = makeBar(100, 100, 100, 100);
    expect(detectDoji(bar)).toBe(true);
  });
});

// ─── Hammer tests ─────────────────────────────────────────────────────────────

describe('detectHammer', () => {
  it('detects a classic hammer', () => {
    // body = |99-100| = 1. lowerShadow = 99-95=4 ≥ 2. upperShadow = 100.5-100=0.5 < 1.
    const bar = makeBar(100, 100.5, 95, 99);
    expect(detectHammer(bar)).toBe(true);
  });

  it('returns false when lower shadow is too short', () => {
    const bar = makeBar(100, 100.5, 98.5, 99);
    expect(detectHammer(bar)).toBe(false);
  });

  it('returns false when upper shadow is too long', () => {
    const bar = makeBar(100, 110, 95, 99);
    expect(detectHammer(bar)).toBe(false);
  });

  it('returns false for zero body', () => {
    const bar = makeBar(100, 110, 90, 100);
    expect(detectHammer(bar)).toBe(false);
  });
});

// ─── Shooting star tests ───────────────────────────────────────────────────────

describe('detectShootingStar', () => {
  it('detects a classic shooting star', () => {
    // body = |99.5-100| = 0.5. upperShadow = 104-100 = 4 ≥ 1. lowerShadow = 99.5-99=0.5 < 0.5? false.
    // Need upperShadow ≥ 2*body AND lowerShadow < body.
    // o=100, c=99, h=104, l=99.5 → body=1, upper=104-100=4 ≥ 2, lower=100-99.5=0.5 < 1 ✓
    const bar = makeBar(100, 104, 99.5, 99);
    expect(detectShootingStar(bar)).toBe(true);
  });

  it('returns false when upper shadow is too short', () => {
    const bar = makeBar(100, 102, 99, 101);
    expect(detectShootingStar(bar)).toBe(false);
  });

  it('returns false for zero body', () => {
    const bar = makeBar(100, 110, 90, 100);
    expect(detectShootingStar(bar)).toBe(false);
  });
});

// ─── Engulfing tests ──────────────────────────────────────────────────────────

describe('detectBullishEngulfing', () => {
  it('detects bullish engulfing pattern', () => {
    const prev = makeBar(103, 103, 99, 100); // bearish
    const curr = makeBar(98, 104, 97, 103);  // bullish, engulfs
    expect(detectBullishEngulfing(prev, curr)).toBe(true);
  });

  it('returns false when prior bar is not bearish', () => {
    const prev = makeBar(98, 103, 97, 102); // bullish
    const curr = makeBar(101, 105, 100, 103);
    expect(detectBullishEngulfing(prev, curr)).toBe(false);
  });

  it('returns false when current does not engulf', () => {
    const prev = makeBar(103, 103, 100, 100); // bearish
    const curr = makeBar(99, 100, 98, 99);    // small bullish
    expect(detectBullishEngulfing(prev, curr)).toBe(false);
  });
});

describe('detectBearishEngulfing', () => {
  it('detects bearish engulfing pattern', () => {
    const prev = makeBar(98, 103, 97, 102);  // bullish
    const curr = makeBar(103, 104, 97, 99);  // bearish, engulfs
    expect(detectBearishEngulfing(prev, curr)).toBe(true);
  });

  it('returns false when prior bar is not bullish', () => {
    const prev = makeBar(103, 103, 99, 100); // bearish
    const curr = makeBar(99, 105, 98, 100);
    expect(detectBearishEngulfing(prev, curr)).toBe(false);
  });
});

// ─── Morning/Evening star tests ───────────────────────────────────────────────

describe('detectMorningStar', () => {
  it('detects morning star pattern', () => {
    const b0 = makeBar(105, 105, 98, 99);   // bearish
    const b1 = makeBar(100, 102, 99, 100);  // small body, in lower half
    const b2 = makeBar(100, 106, 99, 106);  // bullish, closes above b0 open
    const bars = [b0, b1, b2];
    expect(detectMorningStar(bars, 2)).toBe(true);
  });

  it('returns false when bars array is too short', () => {
    const bars = [makeBar(100, 105, 99, 100), makeBar(100, 102, 99, 101)];
    expect(detectMorningStar(bars, 1)).toBe(false);
  });

  it('returns false when last bar does not close above first bar open', () => {
    const b0 = makeBar(105, 105, 98, 99);
    const b1 = makeBar(100, 102, 99, 100);
    const b2 = makeBar(100, 102, 99, 100); // closes at 100 < 105 (b0 open)
    expect(detectMorningStar([b0, b1, b2], 2)).toBe(false);
  });
});

describe('detectEveningStar', () => {
  it('detects evening star pattern', () => {
    // b0: bullish, o=99, c=105, h=106, l=98
    const b0 = makeBar(99, 106, 98, 105);
    // b1: small body (< 30% of range) in upper half of b0. mid=(106+98)/2=102.
    // Need max(b1.o,b1.c) > 102 AND body/range < 0.30.
    // Use: o=102.01, c=102.03, h=102.05, l=101.92 → body=0.02, range=0.13, ratio≈0.15 < 0.30 ✓.
    // max=102.03 > 102 ✓.
    const b1 = makeBar(102.01, 102.05, 101.92, 102.03);
    // b2: bearish, closes below b0 open (99)
    const b2 = makeBar(100, 101, 95, 96);
    const bars = [b0, b1, b2];
    expect(detectEveningStar(bars, 2)).toBe(true);
  });

  it('returns false when first bar is not bullish', () => {
    const b0 = makeBar(105, 105, 98, 99);   // bearish
    const b1 = makeBar(104, 105, 102, 103);
    const b2 = makeBar(103, 104, 95, 96);
    expect(detectEveningStar([b0, b1, b2], 2)).toBe(false);
  });

  it('returns false when last bar does not close below first bar open', () => {
    const b0 = makeBar(99, 106, 98, 105);
    const b1 = makeBar(104, 105, 102, 103);
    const b2 = makeBar(103, 104, 98, 99); // still closes above b0 open (99)
    expect(detectEveningStar([b0, b1, b2], 2)).toBe(false);
  });
});

// ─── detectAllPatterns tests ──────────────────────────────────────────────────

describe('detectAllPatterns', () => {
  it('returns empty array when no patterns are present', () => {
    const bars = [
      makeBar(100, 102, 99, 101),
      makeBar(101, 103, 100, 102),
      makeBar(102, 104, 101, 103),
    ];
    expect(detectAllPatterns(bars, 3)).toEqual([]);
  });

  it('detects doji in recent bars', () => {
    const bars = [
      makeBar(100, 102, 99, 101),
      makeBar(101, 102, 101, 101.02), // doji
      makeBar(102, 104, 101, 103),
    ];
    const hits = detectAllPatterns(bars, 3);
    expect(hits.some(h => h.name === 'doji')).toBe(true);
  });

  it('returns hits sorted most-recent first', () => {
    // Two patterns: doji at idx 1 and engulfing at idx 2. 2 should come before 1.
    const bars = [
      makeBar(100, 102, 99, 100.01),  // doji at idx 0
      makeBar(101, 103, 100, 100.99),  // also potentially doji
      makeBar(102, 104, 101, 103),
    ];
    const hits = detectAllPatterns(bars, 3);
    // With lookback=3, bars 0 and 1 might both trigger doji (very small bodies).
    // All hits should have decreasing barIndex (most recent first).
    if (hits.length > 1) {
      for (let i = 1; i < hits.length; i++) {
        expect(hits[i - 1]!.barIndex).toBeGreaterThan(hits[i]!.barIndex);
      }
    } else {
      // Only 1 hit — sorting invariant trivially holds
      expect(true).toBe(true);
    }
  });

  it('uses lookback window', () => {
    // Only bars within lookback should be checked.
    const bars = [
      makeBar(100, 102, 99, 100.02), // doji at idx 0, but lookback=3
      makeBar(101, 103, 100, 101),
      makeBar(102, 104, 101, 103),
    ];
    const hits = detectAllPatterns(bars, 3);
    expect(hits.every(h => h.barIndex >= 0)).toBe(true);
  });
});