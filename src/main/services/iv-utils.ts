// Single canonical definition of "ATM implied volatility" shared across the codebase, so the
// brief/lab and the live providers can't drift apart on how they measure it.
//
// ATM IV = the AVERAGE implied vol of every contract sitting at the strike CLOSEST to the
// underlying price (i.e. both the call and the put at that strike, plus any duplicates).
// Averaging call+put captures put/call skew; an earlier E*Trade path used the closest CALL
// only, which read differently from the lab's call+put average for the same expiration.
//
// Units are passed through unchanged: feed decimal-fraction IV (0.70) → get a decimal-fraction
// average back; the caller multiplies by 100 if it stores/displays IV as a percentage.
// see docs/formulas.md#atm-iv

/**
 * Average IV of the contracts at the strike closest to `underlyingPx`. Considers only items
 * with a positive IV. Returns null when there is no usable data (no items with IV > 0, or no
 * underlying price). Does NOT scale units — the returned value is in the same units as the
 * input IVs.
 */
export function atmIvAtClosestStrike(
  items: ReadonlyArray<{ strike: number; iv: number | null }>,
  underlyingPx: number | null | undefined,
): number | null {
  if (typeof underlyingPx !== 'number' || !Number.isFinite(underlyingPx)) return null;

  // Find the strike closest to spot among contracts that actually carry an IV.
  let atmStrike: number | null = null;
  let minDist = Infinity;
  for (const it of items) {
    if (it.iv === null || !(it.iv > 0)) continue;
    const d = Math.abs(it.strike - underlyingPx);
    if (d < minDist) {
      minDist = d;
      atmStrike = it.strike;
    }
  }
  if (atmStrike === null) return null;

  // Average every valid IV at that strike (call + put + any duplicates).
  let sum = 0;
  let n = 0;
  for (const it of items) {
    if (it.strike === atmStrike && it.iv !== null && it.iv > 0) {
      sum += it.iv;
      n += 1;
    }
  }
  return n > 0 ? sum / n : null;
}
