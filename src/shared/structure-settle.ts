// Realized P&L of a multi-leg option structure held to EXPIRY, settled at intrinsic value
// for a given underlying settle price. No IV / time-value assumptions — at expiry an option
// is worth exactly its intrinsic, so this is the rigorous, assumption-free settlement used by
// the lizard-vs-spread validation harness (scripts/backtest-lizard-vs-spread.mjs).
//
// Entry prices are the leg mids (no slippage/commission haircut), consistent with the existing
// backtest engine — the user declined a haircut. Apply the SAME convention to every structure
// being compared and the relative result is apples-to-apples.

export interface SettleLeg {
  side: 'call' | 'put';
  action: 'buy' | 'sell';
  strike: number;
  /** Entry price per share (leg mid). */
  mid: number;
  qty?: number;
}

/** Intrinsic value per share of a single option leg at the settle price. */
export function legIntrinsic(side: 'call' | 'put', strike: number, settlePrice: number): number {
  return side === 'call' ? Math.max(0, settlePrice - strike) : Math.max(0, strike - settlePrice);
}

/**
 * Per-contract realized P&L (×100) of holding `legs` to expiry and settling at `settlePrice`.
 * Long legs: exitIntrinsic − entryMid. Short legs: entryMid − exitIntrinsic. Summed over legs.
 */
export function settleStructureAtExpiry(legs: readonly SettleLeg[], settlePrice: number): number {
  let pnlPerShare = 0;
  for (const leg of legs) {
    const intrinsic = legIntrinsic(leg.side, leg.strike, settlePrice);
    const sign = leg.action === 'buy' ? 1 : -1;
    pnlPerShare += sign * (intrinsic - leg.mid) * (leg.qty ?? 1);
  }
  return pnlPerShare * 100;
}
