// Realistic option fill modeling — used wherever a credit/debit must reflect what you
// would actually transact at, rather than the mid. Mid is the best case; real fills cross
// the spread (a sell fills below mid toward the bid, a buy above mid toward the ask). The
// effect is largest exactly where liquidity is worst, so every premium/credit/debit figure
// that uses mid is optimistic there. see docs/formulas.md#fill-model

// Fraction of the half-spread given up to slippage on each leg.
//   0   → fill at mid (optimistic; the old behavior)
//   0.5 → halfway between mid and the natural price (realistic retail marketable-limit)
//   1   → fill at the natural price (bid for sells / ask for buys; worst case)
export const SLIPPAGE_FRACTION = 0.5;

/**
 * Modeled execution price for a single option leg, haircut toward the disadvantageous side.
 * Falls back to the mid when the quote is degenerate or locked/crossed (no usable spread).
 */
export function fillPrice(
  bid: number, ask: number, action: 'buy' | 'sell', slip: number = SLIPPAGE_FRACTION
): number {
  const mid = (bid + ask) / 2;
  if (!(ask > bid) || mid <= 0) return Math.max(0, mid); // locked/crossed/degenerate → mid
  const adj = slip * (ask - bid) / 2;
  return action === 'sell' ? Math.max(0, mid - adj) : mid + adj;
}
