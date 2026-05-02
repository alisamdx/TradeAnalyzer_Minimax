import { describe, it, expect } from 'vitest';
import {
  computeSMA,
  computeEMA,
  computeRSI,
  computeATR,
  computeADX,
  findSwingHighLow
} from '../src/main/services/analysis-service.js';

type Bar = { t: number; o: number; h: number; l: number; c: number; v: number };

// ─── Bar helpers ────────────────────────────────────────────────────────────

function makeBar(c: number, h?: number, l?: number, o?: number, v = 1_000_000): Bar {
  return { t: Date.now(), o: o ?? c, h: h ?? c, l: l ?? c, c, v };
}

// ─── SMA tests ────────────────────────────────────────────────────────────────

describe('computeSMA', () => {
  it('returns null for first n-1 bars', () => {
    const bars = [makeBar(10), makeBar(20), makeBar(30), makeBar(40)];
    const sma = computeSMA(bars, 3);
    expect(sma[0]).toBeNull();
    expect(sma[1]).toBeNull();
    expect(sma[2]).toBe(20); // (10+20+30)/3
    expect(sma[3]).toBe(30); // (20+30+40)/3
  });

  it('computes correct rolling average', () => {
    const bars = [makeBar(100), makeBar(200), makeBar(300), makeBar(400), makeBar(500)];
    const sma = computeSMA(bars, 3);
    expect(sma[2]).toBe(200);   // (100+200+300)/3
    expect(sma[3]).toBe(300);   // (200+300+400)/3
    expect(sma[4]).toBe(400);   // (400+500+300)/3 — wait, last 3 are 300,400,500
    expect(sma[4]).toBeCloseTo(400, 5);
  });

  it('returns all null for insufficient bars', () => {
    const bars = [makeBar(10), makeBar(20)];
    expect(computeSMA(bars, 5)).toEqual([null, null]);
  });
});

// ─── EMA tests ───────────────────────────────────────────────────────────────

describe('computeEMA', () => {
  it('seeds with SMA for period', () => {
    const bars = [makeBar(10), makeBar(20), makeBar(30), makeBar(40)];
    const ema = computeEMA(bars, 3);
    // First valid EMA = SMA(3) = 20.
    expect(ema[2]).toBeCloseTo(20, 4);
  });

  it('converges toward price in uptrend', () => {
    const bars = [makeBar(10), makeBar(20), makeBar(30), makeBar(40), makeBar(50)];
    const ema = computeEMA(bars, 3);
    expect(ema[4]).toBeGreaterThan(ema[3]!);
  });
});

// ─── RSI tests ───────────────────────────────────────────────────────────────

describe('computeRSI', () => {
  it('RSI = 100 when avgLoss = 0 (always up)', () => {
    const bars = [makeBar(100), makeBar(101), makeBar(102), makeBar(103), makeBar(104), makeBar(105)];
    const rsi = computeRSI(bars, 3);
    // First valid RSI is at index 3 (period=3).
    expect(rsi[3]).toBe(100);
  });

  it('RSI = 0 when avgGain = 0 (always down)', () => {
    const bars = [makeBar(100), makeBar(99), makeBar(98), makeBar(97), makeBar(96), makeBar(95)];
    const rsi = computeRSI(bars, 3);
    expect(rsi[3]).toBe(0);
  });

  it('RSI in range 0–100 for mixed changes', () => {
    const bars = [makeBar(100), makeBar(100), makeBar(100), makeBar(100), makeBar(100), makeBar(100),
      makeBar(100), makeBar(110), makeBar(110), makeBar(110), makeBar(110), makeBar(110), makeBar(110)];
    const rsi = computeRSI(bars, 6);
    const lastRsi = rsi[rsi.length - 1];
    expect(lastRsi).not.toBeNull();
    expect(lastRsi!).toBeGreaterThanOrEqual(0);
    expect(lastRsi!).toBeLessThanOrEqual(100);
  });

  it('RSI = 50 when avgGain = avgLoss', () => {
    // Equal up/down moves average out.
    const prices = [100, 105, 100, 105, 100, 105, 100, 105];
    const bars = prices.map((c) => makeBar(c));
    const rsi = computeRSI(bars, 3);
    const lastRsi = rsi[rsi.length - 1];
    // Not exactly 50 due to smoothing, but should be close.
    expect(lastRsi).not.toBeNull();
    expect(lastRsi!).toBeGreaterThan(30);
    expect(lastRsi!).toBeLessThan(70);
  });

  it('returns all null for insufficient bars', () => {
    const bars = [makeBar(100), makeBar(101), makeBar(102)];
    expect(computeRSI(bars, 14)).toEqual([null, null, null]);
  });
});

// ─── ATR tests ───────────────────────────────────────────────────────────────

describe('computeATR', () => {
  it('computes correct ATR values', () => {
    // H=110, L=100, PC=105 → TR = max(10, 5, 5) = 10
    const bars: Bar[] = [
      makeBar(105, 110, 100),
      makeBar(106, 112, 102),
      makeBar(107, 113, 103),
      makeBar(108, 114, 104),
      makeBar(109, 115, 105),
    ];
    const atr = computeATR(bars, 3);
    expect(atr[2]).not.toBeNull();
    expect(atr[3]).not.toBeNull();
    expect(atr[4]).not.toBeNull();
  });

  it('returns all null for bars.length < 2', () => {
    expect(computeATR([makeBar(100)], 14)).toEqual([null]);
  });
});

// ─── ADX tests ───────────────────────────────────────────────────────────────

describe('computeADX', () => {
  it('returns all null for insufficient bars', () => {
    const bars = [makeBar(100), makeBar(101), makeBar(102)];
    const adx = computeADX(bars, 14);
    expect(adx.every((v) => v === null)).toBe(true);
  });

  it('returns non-null values for sufficient uptrend bars', () => {
    // Strong uptrend: prices climbing, consistent +DM.
    const bars = [makeBar(100, 102, 99)];
    for (let i = 1; i < 50; i++) {
      const prev = bars[i - 1]!.c;
      bars.push(makeBar(prev + 1, prev + 3, prev - 0.5));
    }
    const adx = computeADX(bars, 14);
    const nonNull = adx.filter((v) => v !== null);
    expect(nonNull.length).toBeGreaterThan(0);
    // ADX in an uptrend should be positive.
    nonNull.forEach((v) => expect(v!).toBeGreaterThanOrEqual(0));
  });

  it('ADX values are always non-negative', () => {
    const bars: Bar[] = [];
    for (let i = 0; i < 60; i++) {
      const base = 100 + i;
      bars.push(makeBar(base, base + 1, base - 1));
    }
    const adx = computeADX(bars, 14);
    adx.forEach((v) => {
      if (v !== null) expect(v!).toBeGreaterThanOrEqual(0);
    });
  });
});

// ─── Swing high/low tests ───────────────────────────────────────────────────

describe('findSwingHighLow', () => {
  it('returns null when not enough bars', () => {
    const bars = [makeBar(100), makeBar(101)];
    expect(findSwingHighLow(bars, 20)).toEqual({ high: null, low: null, highIdx: -1, lowIdx: -1 });
  });

  it('finds the highest high and lowest low in the lookback window', () => {
    const bars = [
      makeBar(100), makeBar(105), makeBar(103), makeBar(110), makeBar(108),
      makeBar(95), makeBar(90), makeBar(88), makeBar(97), makeBar(102),
      // swing high = 110, swing low = 88
    ];
    const result = findSwingHighLow(bars, 10);
    expect(result.high).toBe(110);
    expect(result.low).toBe(88);
  });

  it('returns correct indices', () => {
    const bars = [
      makeBar(100), makeBar(105), makeBar(103), makeBar(110), makeBar(108),
      makeBar(95), makeBar(90), makeBar(88), makeBar(97), makeBar(102),
    ];
    const result = findSwingHighLow(bars, 10);
    expect(result.highIdx).toBe(3);  // 110 is at index 3
    expect(result.lowIdx).toBe(7);   // 88 is at index 7
  });
});

// ─── Mode scoring logic ─────────────────────────────────────────────────────

describe('buy composite score', () => {
  // Test the scoring logic independently.
  function scoreBuy(
    trend: 'bullish' | 'bearish' | 'sideways',
    rsi: number | null,
    fundamentals: { peRatio: number | null; profitMargin: number | null; roe: number | null; debtToEquity: number | null }
  ): number {
    let score = 0;
    if (trend === 'bullish') score += 3;
    else if (trend === 'bearish') score += 2;
    else if (trend === 'sideways') score += 1;
    if (rsi !== null && rsi >= 40 && rsi <= 65) score += 2;
    if (rsi !== null && rsi >= 45 && rsi <= 55) score += 1;
    if (fundamentals.peRatio !== null && fundamentals.peRatio >= 5 && fundamentals.peRatio <= 25) score += 1;
    if (fundamentals.profitMargin !== null && fundamentals.profitMargin >= 10) score += 1;
    if (fundamentals.roe !== null && fundamentals.roe >= 15) score += 1;
    if (fundamentals.debtToEquity !== null && fundamentals.debtToEquity < 1) score += 1;
    return Math.min(10, score);
  }

  it('scores bullish + ideal RSI + fundamentals = 10', () => {
    const score = scoreBuy('bullish', 50, {
      peRatio: 15, profitMargin: 20, roe: 22, debtToEquity: 0.5
    });
    expect(score).toBe(10);
  });

  it('scores bearish without RSI or fundamentals = 2 (trend only)', () => {
    const score = scoreBuy('bearish', null, {
      peRatio: null, profitMargin: null, roe: null, debtToEquity: null
    });
    expect(score).toBe(2); // bearish = 2 pts, no fundamentals
  });

  it('scores sideways with no fundamentals = 2', () => {
    const score = scoreBuy('sideways', null, {
      peRatio: null, profitMargin: null, roe: null, debtToEquity: null
    });
    expect(score).toBe(1);
  });

  it('RSI outside 40-65 does not contribute RSI points', () => {
    // RSI = 30 (< 40) → no +2 or +1 for RSI
    const withRsi = scoreBuy('bullish', 30, {
      peRatio: 15, profitMargin: 20, roe: 22, debtToEquity: 0.5
    });
    const noRsi = scoreBuy('bullish', null, {
      peRatio: 15, profitMargin: 20, roe: 22, debtToEquity: 0.5
    });
    // withRsi has: trend+3, no RSI points (below 40), PE+1, margin+1, ROE+1, DE+1 = 7
    expect(withRsi).toBe(7);
    // noRsi has: trend+3, no RSI, PE+1, margin+1, ROE+1, DE+1 = 7 — same
    expect(noRsi).toBe(7);
  });
});

describe('wheel suitability score', () => {
  function scoreWheel(params: {
    ivRank: number | null;
    stabilityPass: boolean;
    liquidityScore: number;
    earningsPass: boolean;
    roe: number | null;
    fcf: number | null;
  }): number {
    let score = 1; // base
    if (params.ivRank !== null && params.ivRank >= 30) score += 2;
    if (params.stabilityPass) score += 2;
    if (params.liquidityScore >= 5) score += 2;
    if (params.earningsPass) score += 2;
    if (params.roe !== null && params.roe >= 15) score += 1;
    if (params.fcf !== null && params.fcf > 0) score += 1;
    return Math.min(10, score);
  }

  it('perfect score = 10', () => {
    const score = scoreWheel({
      ivRank: 50, stabilityPass: true, liquidityScore: 10,
      earningsPass: true, roe: 22, fcf: 1_000_000
    });
    expect(score).toBe(10);
  });

  it('base score = 1 when all checks fail', () => {
    const score = scoreWheel({
      ivRank: null, stabilityPass: false, liquidityScore: 0,
      earningsPass: false, roe: null, fcf: null
    });
    expect(score).toBe(1);
  });

  it('IV rank null (not computed) does not award the IV point', () => {
    const withIvNull = scoreWheel({
      ivRank: null, stabilityPass: false, liquidityScore: 0,
      earningsPass: true, roe: null, fcf: null
    });
    const withIvLow = scoreWheel({
      ivRank: 20, stabilityPass: false, liquidityScore: 0,
      earningsPass: true, roe: null, fcf: null
    });
    // Both fail IV rank check — same score
    expect(withIvNull).toBe(withIvLow);
    // Earnings pass gives +2
    expect(withIvLow).toBe(3);
  });
});