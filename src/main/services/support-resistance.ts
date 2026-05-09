// Support/resistance and entry zone computation.
// see SPEC: FR-4.4 §D (supply/demand zones, entry/exit zones)
// see docs/formulas.md#demand-zone, #supply-zone, #entry-zone-and-stop

import type { Bar } from './analysis-service.js';
import { computeATR } from './analysis-service.js';

// ─── Swing high/low detection ────────────────────────────────────────────────

/** Find all local swing highs and lows in the given window. */
export function findSwingHighsLows(
  bars: Bar[],
  lookback: number
): { highs: { idx: number; price: number }[]; lows: { idx: number; price: number }[] } {
  if (bars.length < lookback) {
    return { highs: [], lows: [] };
  }
  const window = bars.slice(-lookback);
  const pivotHighs: { idx: number; price: number }[] = [];
  const pivotLows: { idx: number; price: number }[] = [];

  // Simple pivot high: bar[i] > neighbors within lookback
  for (let i = 2; i < window.length - 2; i++) {
    const curr = window[i]!;
    let isHigh = true;
    let isLow = true;
    for (let j = Math.max(0, i - 2); j <= Math.min(window.length - 1, i + 2); j++) {
      if (j === i) continue;
      if (window[j]!.h >= curr.h) isHigh = false;
      if (window[j]!.l <= curr.l) isLow = false;
    }
    if (isHigh) pivotHighs.push({ idx: bars.length - lookback + i, price: curr.h });
    if (isLow) pivotLows.push({ idx: bars.length - lookback + i, price: curr.l });
  }

  return { highs: pivotHighs, lows: pivotLows };
}

// ─── Supply/demand zones ─────────────────────────────────────────────────────

export interface Zone {
  price: number;
  type: 'demand' | 'supply';
  /** % of price, for reference */
  strengthPct: number;
}

/**
 * Find recent demand zone — last consolidation range before a significant up-move.
 * Detection: find the lowest swing low in the last `lookback` bars where the bar
 * after that range shows price rising > 2%.
 */
export function findRecentDemandZone(bars: Bar[], lookback = 50): Zone | null {
  if (bars.length < lookback + 10) return null;
  const segment = bars.slice(-lookback - 10, -10); // before the recent 10 bars
  const after = bars.slice(-10);                  // recent 10 bars to check for rise

  // Find pivot lows in the segment
  const pivotLows: { idx: number; price: number }[] = [];
  for (let i = 1; i < segment.length - 1; i++) {
    const curr = segment[i]!;
    if (curr.l <= segment[i - 1]!.l && curr.l <= segment[i + 1]!.l) {
      pivotLows.push({ idx: bars.length - lookback - 10 + i, price: curr.l });
    }
  }

  if (pivotLows.length === 0) return null;

  // Check if price rose > 2% from each pivot low
  const lastPivot = pivotLows[pivotLows.length - 1]!;
  const priceAtPivot = lastPivot.price;
  const priceNow = after[after.length - 1]!.c;
  const risePct = ((priceNow - priceAtPivot) / priceAtPivot) * 100;

  if (risePct >= 2) {
    return {
      price: priceAtPivot,
      type: 'demand',
      strengthPct: Math.min(risePct, 10) // cap at 10% for display
    };
  }
  return null;
}

/**
 * Find recent supply zone — last consolidation range before a significant down-move.
 * Detection: find the highest swing high in the last `lookback` bars where the bar
 * after that range shows price falling > 2%.
 */
export function findRecentSupplyZone(bars: Bar[], lookback = 50): Zone | null {
  if (bars.length < lookback + 10) return null;
  const segment = bars.slice(-lookback - 10, -10);
  const after = bars.slice(-10);

  const pivotHighs: { idx: number; price: number }[] = [];
  for (let i = 1; i < segment.length - 1; i++) {
    const curr = segment[i]!;
    if (curr.h >= segment[i - 1]!.h && curr.h >= segment[i + 1]!.h) {
      pivotHighs.push({ idx: bars.length - lookback - 10 + i, price: curr.h });
    }
  }

  if (pivotHighs.length === 0) return null;

  const lastPivot = pivotHighs[pivotHighs.length - 1]!;
  const priceAtPivot = lastPivot.price;
  const priceNow = after[after.length - 1]!.c;
  const fallPct = ((priceAtPivot - priceNow) / priceAtPivot) * 100;

  if (fallPct >= 2) {
    return {
      price: priceAtPivot,
      type: 'supply',
      strengthPct: Math.min(fallPct, 10)
    };
  }
  return null;
}

// ─── Entry zone and stop computation ─────────────────────────────────────────

export interface EntryZoneResult {
  entryZoneLow: number | null;
  entryZoneHigh: number | null;
  stopLoss: number | null;
  target: number | null;
  riskReward: number | null;
  reason: string;
}

/**
 * Compute entry zone lower/upper, stop-loss, and target for a given bar sequence.
 * Logic per docs/formulas.md#entry-zone-and-stop:
 *   entryZoneLow  = recent swing low (20-bar lookback)
 *   entryZoneHigh = SMA50 or current price
 *   stopLoss      = entryZoneLow − 1.5 × ATR(14)
 *   target        = entryZoneLow + 3 × ATR(14)
 *   riskReward    = (target − entryZoneLow) / (entryZoneLow − stopLoss)
 */
export function computeEntryZoneAndStop(
  bars: Bar[],
  trend: 'Bullish' | 'Bearish' | 'Sideways'
): EntryZoneResult {
  if (bars.length < 20) {
    return { entryZoneLow: null, entryZoneHigh: null, stopLoss: null, target: null, riskReward: null, reason: 'Insufficient bars for entry zone calculation.' };
  }

  const recent20 = bars.slice(-20);
  // Swing low in last 20 bars
  const swingLow = recent20.reduce((min, b) => b.l < min ? b.l : min, Infinity);

  // SMA50 — need 50 bars
  const sma50Arr = bars.map((_, i) => {
    if (i < 49) return null;
    const slice = bars.slice(i - 49, i + 1).map(b => b.c);
    return slice.reduce((a, c) => a + c, 0) / 50;
  });
  const sma50 = sma50Arr[sma50Arr.length - 1] ?? null;

  // Current price (safe because we checked bars.length >= 20)
  const lastBar = bars[bars.length - 1];
  const currentPrice = lastBar?.c;
  if (currentPrice === undefined) {
    return { entryZoneLow: null, entryZoneHigh: null, stopLoss: null, target: null, riskReward: null, reason: 'Unable to determine current price.' };
  }

  // ATR
  const atrArr = computeATR(bars, 14);
  const atr = atrArr[atrArr.length - 1];

  if (atr === null || atr === undefined || atr === 0) {
    return {
      entryZoneLow: swingLow,
      entryZoneHigh: sma50 ?? currentPrice,
      stopLoss: null,
      target: null,
      riskReward: null,
      reason: 'ATR unavailable — cannot compute stop/target.'
    };
  }

  const entryLow = swingLow;
  const entryHigh = sma50 ?? currentPrice;
  const stopLoss = entryLow - 1.5 * atr;
  const target = entryLow + 3 * atr;
  const risk = entryLow - stopLoss; // = 1.5 * atr
  const reward = target - entryLow; // = 3 * atr
  const riskReward = risk > 0 ? reward / risk : null;

  let reason: string;
  if (trend === 'Bullish') {
    reason = `Bullish setup. Entry zone: $${entryLow.toFixed(2)}–$${entryHigh.toFixed(2)}. Stop: $${stopLoss.toFixed(2)}. Target: $${target.toFixed(2)} (R:R ${riskReward?.toFixed(1) ?? '—'}).`;
  } else if (trend === 'Bearish') {
    reason = `Bearish setup. Entry zone: $${entryLow.toFixed(2)}–$${entryHigh.toFixed(2)}. Stop: $${stopLoss.toFixed(2)}. Target: $${target.toFixed(2)} (R:R ${riskReward?.toFixed(1) ?? '—'}).`;
  } else {
    reason = `Sideways. Entry zone: $${entryLow.toFixed(2)}–$${entryHigh.toFixed(2)}. Stop: $${stopLoss.toFixed(2)}. Target: $${target.toFixed(2)} (R:R ${riskReward?.toFixed(1) ?? '—'}).`;
  }

  return { entryZoneLow: entryLow, entryZoneHigh: entryHigh, stopLoss, target, riskReward, reason };
}