// Pattern detector — pure functions for Japanese candlestick pattern detection.
// see SPEC: FR-4.4 §D (pattern callouts)
// see docs/formulas.md#doji, #hammer, #shooting-star, #engulfing, #morning-star, #evening-star

import type { Bar } from './analysis-service.js';
import type { PatternHit } from '@shared/types.js';

// ─── Bar helpers ─────────────────────────────────────────────────────────────

function body(b: Bar): number { return Math.abs(b.c - b.o); }
function range(b: Bar): number { return b.h - b.l; }
function isBullish(b: Bar): boolean { return b.c > b.o; }
function isBearish(b: Bar): boolean { return b.c < b.o; }

// ─── Single-bar patterns ─────────────────────────────────────────────────────

/** Doji — body ≤ 5% of range (indecision / potential reversal). */
export function detectDoji(bar: Bar): boolean {
  const r = range(bar);
  if (r === 0) return true;
  return body(bar) / r <= 0.05;
}

/** Hammer — lower shadow ≥ 2× body, upper shadow minimal. Bullish reversal. */
export function detectHammer(bar: Bar): boolean {
  const b = body(bar);
  if (b === 0) return false;
  // Shadow from body bottom (min(o,c)) down to low: positive when low is below body.
  const lowerShadow = Math.min(bar.o, bar.c) - bar.l;
  // Shadow from body top (max(o,c)) up to high: positive when high is above body.
  const upperShadow = bar.h - Math.max(bar.o, bar.c);
  // Lower shadow at least 2× body, upper shadow less than body.
  return lowerShadow >= 2 * b && upperShadow < b;
}

/** Shooting star — upper shadow ≥ 2× body, lower shadow minimal. Bearish reversal. */
export function detectShootingStar(bar: Bar): boolean {
  const b = body(bar);
  if (b === 0) return false;
  const lowerShadow = Math.min(bar.o, bar.c) - bar.l;
  const upperShadow = bar.h - Math.max(bar.o, bar.c);
  // Upper shadow at least 2× body, lower shadow less than body.
  return upperShadow >= 2 * b && lowerShadow < b;
}

// ─── Two-bar patterns ────────────────────────────────────────────────────────

/** Bullish engulfing — prior bar bearish, current bar bullish and engulfs prior body. */
export function detectBullishEngulfing(prev: Bar, curr: Bar): boolean {
  return isBearish(prev) && isBullish(curr)
    && curr.l <= prev.l && curr.h >= prev.h;
}

/** Bearish engulfing — prior bar bullish, current bar bearish and engulfs prior body. */
export function detectBearishEngulfing(prev: Bar, curr: Bar): boolean {
  return isBullish(prev) && isBearish(curr)
    && curr.h >= prev.h && curr.l <= prev.l;
}

// ─── Three-bar patterns ─────────────────────────────────────────────────────

/**
 * Morning star — three-candle bullish reversal:
 * 1. Bar -2: bearish
 * 2. Bar -1: small body (body < 30% of range), opens/trades in lower half of bar-2 range
 * 3. Bar  0: bullish, closes above open of bar -2
 */
export function detectMorningStar(bars: Bar[], idx: number): boolean {
  if (idx < 2 || idx >= bars.length) return false;
  const b0 = bars[idx - 2]!;
  const b1 = bars[idx - 1]!;
  const b2 = bars[idx]!;
  // Bar 0: bearish open/close
  if (isBullish(b0)) return false;
  // Bar 1: small real body
  const b1Body = body(b1);
  const b1Range = range(b1);
  if (b1Range === 0 || b1Body / b1Range >= 0.30) return false;
  // Bar 1 opens/trades in lower half of prior bar range
  const mid = (b0.h + b0.l) / 2;
  if (Math.max(b1.o, b1.c) > mid) return false;
  // Bar 2: bullish and closes above open of bar 0
  return isBullish(b2) && b2.c > b0.o;
}

/**
 * Evening star — three-candle bearish reversal:
 * 1. Bar -2: bullish
 * 2. Bar -1: small body, opens/trades in upper half of bar-2 range
 * 3. Bar  0: bearish, closes below open of bar -2
 */
export function detectEveningStar(bars: Bar[], idx: number): boolean {
  if (idx < 2 || idx >= bars.length) return false;
  const b0 = bars[idx - 2]!;
  const b1 = bars[idx - 1]!;
  const b2 = bars[idx]!;
  // Bar 0: bullish open/close
  if (isBearish(b0)) return false;
  // Bar 1: small real body
  const b1Body = body(b1);
  const b1Range = range(b1);
  if (b1Range === 0 || b1Body / b1Range >= 0.30) return false;
  // Bar 1 opens/trades in upper half of prior bar range
  const mid = (b0.h + b0.l) / 2;
  // For upper half: the minimum of open/close must be above the midpoint
  if (Math.min(b1.o, b1.c) < mid) return false;
  // Bar 2: bearish and closes below open of bar 0
  return isBearish(b2) && b2.c < b0.o;
}

// ─── Scan all patterns across bars ──────────────────────────────────────────

/**
 * Detect all candlestick patterns in the last N bars.
 * Returns an array of PatternHit sorted by bar index (most recent first).
 */
export function detectAllPatterns(bars: Bar[], lookback = 5): PatternHit[] {
  const hits: PatternHit[] = [];
  const start = Math.max(0, bars.length - lookback);

  for (let i = start; i < bars.length; i++) {
    const bar = bars[i]!;

    // Single-bar patterns
    if (detectDoji(bar)) {
      hits.push({ name: 'doji', barIndex: i, direction: 'neutral' });
    }
    if (detectHammer(bar)) {
      hits.push({ name: 'hammer', barIndex: i, direction: 'bullish' });
    }
    if (detectShootingStar(bar)) {
      hits.push({ name: 'shooting_star', barIndex: i, direction: 'bearish' });
    }

    // Two-bar patterns
    if (i > 0) {
      const prev = bars[i - 1]!;
      if (detectBullishEngulfing(prev, bar)) {
        hits.push({ name: 'bullish_engulfing', barIndex: i, direction: 'bullish' });
      }
      if (detectBearishEngulfing(prev, bar)) {
        hits.push({ name: 'bearish_engulfing', barIndex: i, direction: 'bearish' });
      }
    }

    // Three-bar patterns
    if (i >= 2) {
      if (detectMorningStar(bars, i)) {
        hits.push({ name: 'morning_star', barIndex: i, direction: 'bullish' });
      }
      if (detectEveningStar(bars, i)) {
        hits.push({ name: 'evening_star', barIndex: i, direction: 'bearish' });
      }
    }
  }

  // Sort: most recent first
  return hits.sort((a, b) => b.barIndex - a.barIndex);
}