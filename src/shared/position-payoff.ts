// Reconstruct a held portfolio position as Payoff Visualizer legs, so the Payoff view shows
// the ACTUAL position (exact strike, expiry, entry premium) instead of rebuilding a generic
// near-term structure off the live chain (which snapped expiry to the nearest of only 7
// weeklies and re-priced at market mid — the v1.1.79 bug this fixes).

import type { PayoffLeg } from './types.js';

export interface PositionLike {
  id: number;
  positionType: 'CSP' | 'CC' | 'Stock' | 'Long Put' | 'Long Call';
  quantity: number;
  entryPrice: number;          // per-share premium received (short) / paid (long) / entry (stock)
  strikePrice: number | null;
  expirationDate: string | null;
  delta: number | null;        // stored greeks — convention varies (raw OR position-signed);
  theta: number | null;        // normalized to canonical raw by rawGreeks() before use.
  vega: number | null;
}

const OPTION_MAP: Record<string, { side: 'buy' | 'sell'; type: 'put' | 'call' }> = {
  CSP:         { side: 'sell', type: 'put' },
  CC:          { side: 'sell', type: 'call' },
  'Long Put':  { side: 'buy',  type: 'put' },
  'Long Call': { side: 'buy',  type: 'call' },
};

/**
 * Normalize stored greeks to **canonical raw (long-option) convention** by leg type, so the
 * Payoff engine can apply the side sign exactly once. This is defensive because the E*Trade
 * sync has been observed storing greeks BOTH raw (put δ<0, θ<0, ν>0) and position-signed
 * (short put δ>0, θ>0, ν<0) — the convention is not stable. Taking |value| and re-imposing the
 * canonical sign (put δ negative / call δ positive; a long option always pays θ and is long ν)
 * makes the result correct whichever way the source stored it. A double-signed delta is what
 * made a CSP read as "bearish" in the Pre-Trade Validator.
 */
function rawGreeks(type: 'put' | 'call', delta: number | null, theta: number | null, vega: number | null) {
  return {
    delta: delta == null ? null : (type === 'put' ? -Math.abs(delta) : Math.abs(delta)),
    theta: theta == null ? null : -Math.abs(theta), // long option always pays time decay
    vega:  vega  == null ? null : Math.abs(vega),    // long option is always long vega
  };
}

/**
 * Build the Payoff legs for a held position. Greeks are normalized to canonical raw
 * (option-level) by `rawGreeks` — NOT passed through as stored — because the sync's sign
 * convention is unstable and `computePayoffMetrics` applies the side sign itself. Returns
 * `undefined` for an option position missing the strike/expiry needed to build it.
 */
export function positionToPayoffLegs(pos: PositionLike, idSeq = 0): PayoffLeg[] | undefined {
  const qty = Math.max(1, pos.quantity);
  const id = `pos-${pos.id}-${idSeq}`;

  if (pos.positionType === 'Stock') {
    return [{
      id, side: 'buy', type: 'stock', strike: 0, expiry: '',
      premium: pos.entryPrice, quantity: qty,
      delta: null, theta: null, vega: null, iv: null,
      label: `Stock @ $${pos.entryPrice}`,
    }];
  }

  const m = OPTION_MAP[pos.positionType];
  if (!m || pos.strikePrice == null || !pos.expirationDate) return undefined;

  const sideLabel = m.side === 'buy' ? 'Buy' : 'Sell';
  const typeLabel = m.type === 'put' ? 'Put' : 'Call';
  const g = rawGreeks(m.type, pos.delta, pos.theta, pos.vega);
  return [{
    id, side: m.side, type: m.type,
    strike: pos.strikePrice, expiry: pos.expirationDate,
    premium: pos.entryPrice, quantity: qty,
    delta: g.delta, theta: g.theta, vega: g.vega, iv: null,
    label: `${sideLabel} ${typeLabel} $${pos.strikePrice}`,
  }];
}
