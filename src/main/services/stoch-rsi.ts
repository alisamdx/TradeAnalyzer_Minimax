// Stochastic RSI — Bec's single entry-timing input (docs/Bec/STRATEGY-SUMMARY.md §3, §9.3).
//
// DISPLAY ONLY (v1.1.358). It is computed and shown on brief picks so the operator can watch it
// beside the engine's own reads; it feeds no score, gate or ranking. Deciding whether it should
// is an FR-SEY-5 question for later, on replay evidence — not something to settle by eye.
//
// Her rule is about the TURN, not the level: do not enter while it points down; enter once it has
// reached the bottom and turned back up. So the stored state names the turn, and the level is kept
// beside it rather than turned into a threshold.
// see docs/formulas.md#stoch-rsi

import type { Bar, StochRsiReading, StochRsiState } from '@shared/types.js';
import { computeRSI } from './analysis-service.js';

export type { StochRsiState };

/** %K and %D are 0–100 (3-bar SMAs of raw stochastic RSI, and of %K); state is null when there is
 *  too little history to say. */
export type StochRsi = StochRsiReading;

/** Standard settings: RSI 14, stochastic window 14, %K smoothing 3, %D smoothing 3. */
export const STOCH_RSI = {
  rsiPeriod: 14,
  stochPeriod: 14,
  kSmooth: 3,
  dSmooth: 3,
  /** %K at or below this counts as "the bottom". */
  oversold: 20,
  /** A cross up counts as a fresh turn for this many bars… */
  turnBars: 3,
  /** …if %K touched the bottom within this many bars. */
  lowLookback: 5,
} as const;

function smaNullable(values: readonly (number | null)[], period: number): (number | null)[] {
  return values.map((_, i) => {
    if (i < period - 1) return null;
    const win = values.slice(i - period + 1, i + 1);
    if (win.some(v => v == null)) return null;
    return (win as number[]).reduce((a, b) => a + b, 0) / period;
  });
}

/** %K and %D series aligned with `bars` (null where undefined). */
export function stochRsiSeries(bars: readonly Bar[]): { k: (number | null)[]; d: (number | null)[] } {
  const P = STOCH_RSI;
  const rsi = computeRSI(bars as Bar[], P.rsiPeriod);
  const raw = rsi.map((r, i) => {
    if (r == null || i < P.stochPeriod - 1) return null;
    const win = rsi.slice(i - P.stochPeriod + 1, i + 1);
    if (win.some(v => v == null)) return null;
    const lo = Math.min(...(win as number[]));
    const hi = Math.max(...(win as number[]));
    // A flat RSI window has no position inside its range. Null, not an invented 50 or 0.
    return hi === lo ? null : ((r - lo) / (hi - lo)) * 100;
  });
  const k = smaNullable(raw, P.kSmooth);
  const d = smaNullable(k, P.dSmooth);
  return { k, d };
}

/** The latest %K/%D and the turn state. see docs/formulas.md#stoch-rsi */
export function computeStochRsi(bars: readonly Bar[]): StochRsi {
  const P = STOCH_RSI;
  const { k, d } = stochRsiSeries(bars);
  const n = bars.length;
  const kNow = n > 0 ? k[n - 1] ?? null : null;
  const dNow = n > 0 ? d[n - 1] ?? null : null;
  if (kNow == null || dNow == null) return { k: kNow, d: dNow, state: null };

  // Both lines pin at 0 after a hard sell-off and at 100 after a hard rally, so EQUALITY is common
  // and must not decide anything by accident: K = D at the bottom has not turned yet (falling —
  // Bec's "do not enter"); K = D at the top is still up (rising). Found by the sell-off fixture:
  // `K < D → falling` alone read a stock pinned at 0 as having crossed up.
  if (kNow < dNow || (kNow === dNow && kNow <= P.oversold)) return { k: kNow, d: dNow, state: 'falling' };

  // A strict cross of %K above %D in the last `turnBars` bars (K ≤ D on the bar before, so a cross
  // out of a pinned 0/0 counts), with %K at the bottom shortly before.
  let crossed = false;
  for (let i = Math.max(1, n - P.turnBars); i < n; i++) {
    const pk = k[i - 1], pd = d[i - 1], ck = k[i], cd = d[i];
    if (pk != null && pd != null && ck != null && cd != null && pk <= pd && ck > cd) { crossed = true; break; }
  }
  const recentK = k.slice(Math.max(0, n - P.lowLookback)).filter((v): v is number => v != null);
  const touchedLow = recentK.some(v => v <= P.oversold);
  return { k: kNow, d: dNow, state: crossed && touchedLow ? 'turned_up' : 'rising' };
}
