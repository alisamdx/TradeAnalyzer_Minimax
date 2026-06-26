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
  delta: number | null;        // RAW option greeks as stored (option-level, not position-signed)
  theta: number | null;
  vega: number | null;
}

const OPTION_MAP: Record<string, { side: 'buy' | 'sell'; type: 'put' | 'call' }> = {
  CSP:         { side: 'sell', type: 'put' },
  CC:          { side: 'sell', type: 'call' },
  'Long Put':  { side: 'buy',  type: 'put' },
  'Long Call': { side: 'buy',  type: 'call' },
};

/**
 * Build the Payoff legs for a held position. Greeks pass through RAW (option-level) because
 * `computePayoffMetrics` applies the side sign itself (a sold put's stored delta is negative;
 * the sell side flips it to a positive position delta). Returns `undefined` for an option
 * position missing the strike/expiry needed to build it (caller can fall back).
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
  return [{
    id, side: m.side, type: m.type,
    strike: pos.strikePrice, expiry: pos.expirationDate,
    premium: pos.entryPrice, quantity: qty,
    delta: pos.delta, theta: pos.theta, vega: pos.vega, iv: null,
    label: `${sideLabel} ${typeLabel} $${pos.strikePrice}`,
  }];
}
