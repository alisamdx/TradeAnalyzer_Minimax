// Single source of truth for the greek SIGN convention on stored positions.
//
// `positions.delta/theta/vega` are stored POSITION-SIGNED ("short-position convention"): a
// short option (CSP/CC) negates the raw contract greeks, so a short put reads +delta / +theta /
// −vega (bullish, collecting decay, short vol); long positions keep the contract sign. The
// Portfolio net-greek aggregation and the planned Book Greeks monitor sum these directly.
//
// This used to be applied inline in the chain-refresh path ONLY, while the E*Trade sync stored
// raw greeks verbatim — so the stored sign flipped depending on which path wrote last (the
// v1.1.80 "CSP reads bearish" bug). Both write paths now go through this helper so they can't
// drift again.

export type GreekPositionType = 'CSP' | 'CC' | 'Stock' | 'Long Put' | 'Long Call';

export interface SignedGreeks {
  delta: number | null;
  theta: number | null;
  vega: number | null;
}

/** −1 for short options (CSP/CC), +1 otherwise. */
export function positionGreekSign(positionType: GreekPositionType): 1 | -1 {
  return positionType === 'CSP' || positionType === 'CC' ? -1 : 1;
}

/**
 * Convert RAW (contract / long-option) greeks — as returned by E*Trade and the options chain —
 * to the canonical position-signed convention stored on `positions`. Nulls pass through.
 * Gamma is intentionally NOT handled here: it isn't part of the stored convention (the
 * chain-refresh `updateGreeks` path never wrote it) and no consumer reads a signed gamma.
 */
export function toPositionSignedGreeks(
  positionType: GreekPositionType,
  delta: number | null,
  theta: number | null,
  vega: number | null,
): SignedGreeks {
  const sign = positionGreekSign(positionType);
  return {
    delta: delta == null ? null : sign * delta,
    theta: theta == null ? null : sign * theta,
    vega:  vega  == null ? null : sign * vega,
  };
}
