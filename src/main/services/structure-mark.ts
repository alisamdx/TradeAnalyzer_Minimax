// Mark-to-market P&L for a multi-leg option structure, used by the paper-tracking layer to
// score brief picks on the ACTUAL structure (CSP / credit spread / iron condor), not just the
// stock's direction. Both ends are Black-Scholes-priced at the entry IV (live historical IV per
// strike isn't available), so the result isolates the underlying move + theta. Per-leg expiry is
// honored (PMCC / calendar legs differ). see docs/formulas.md#structure-mark

import { bsPrice } from './black-scholes.js';

export interface MarkLeg {
  action: 'buy' | 'sell';
  side: 'call' | 'put';
  strike: number;
  expiration: string;   // ISO YYYY-MM-DD
  iv: number | null;    // percentage (e.g. 77.0) as stored on brief setup legs
  qty: number;
}

const DAY_MS = 86_400_000;
function yearsBetween(from: string, to: string): number {
  const ms = new Date(to + 'T00:00:00Z').getTime() - new Date(from + 'T00:00:00Z').getTime();
  return Math.max(0, ms) / (365 * DAY_MS);
}

/**
 * Structure P&L in dollars (per the recorded quantity) at `asOfDate`/`curUnderlying` vs entry.
 * Returns null when legs/inputs are unusable. Day-0 (asOf == entry, same price) is exactly 0.
 * A sold leg profits when its value falls; a bought leg when it rises.
 */
export function markStructurePnl(
  legs: MarkLeg[],
  entryUnderlying: number,
  entryDate: string,
  curUnderlying: number,
  asOfDate: string,
  r = 0.04,
): number | null {
  if (!Array.isArray(legs) || legs.length === 0) return null;
  if (!(entryUnderlying > 0) || !(curUnderlying > 0)) return null;

  let pnl = 0;
  for (const l of legs) {
    if (l.strike == null || !l.expiration || l.iv == null || !(l.iv > 0)) return null;
    const iv = l.iv / 100;
    const isCall = l.side === 'call';
    const qty = l.qty ?? 1;
    const entryVal = bsPrice(entryUnderlying, l.strike, yearsBetween(entryDate, l.expiration), iv, r, isCall);
    const nowVal   = bsPrice(curUnderlying,   l.strike, yearsBetween(asOfDate, l.expiration), iv, r, isCall);
    const sign = l.action === 'buy' ? 1 : -1; // sell profits when value falls
    pnl += sign * (nowVal - entryVal) * qty * 100;
  }
  return pnl;
}

/** % of the entry credit/debit captured: structurePnl / |entryPremium| × 100. Null when no base. */
export function structureReturnPct(structurePnl: number | null, entryPremium: number | null): number | null {
  if (structurePnl == null || entryPremium == null || Math.abs(entryPremium) < 1e-9) return null;
  return structurePnl / Math.abs(entryPremium) * 100;
}
