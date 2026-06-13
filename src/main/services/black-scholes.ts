// Shared Black-Scholes option pricing — used for time-horizon P&L valuation where a
// leg must be priced before its expiry (collared-LEAPS P&L grids, Strategy Lab
// calendar/diagonal max-profit). see docs/formulas.md#black-scholes

/** Default annual risk-free rate used across option valuations. */
export const RISK_FREE_RATE = 0.05;

/** Abramowitz & Stegun approximation for the standard normal CDF (error < 7.5e-8). */
export function normCdf(x: number): number {
  if (x < -8) return 0;
  if (x > 8) return 1;
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422820 * Math.exp(-0.5 * x * x);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.7814779 + t * (-1.8212560 + t * 1.3302744))));
  return x > 0 ? 1 - p : p;
}

/**
 * Black-Scholes European option price.
 * @param S  current spot
 * @param K  strike
 * @param T  time to expiry in years (≤ 0 → intrinsic only)
 * @param iv implied volatility as a fraction (e.g. 0.285)
 * @param r  risk-free rate (e.g. 0.05)
 * @param isCall true for call, false for put
 */
export function bsPrice(S: number, K: number, T: number, iv: number, r: number, isCall: boolean): number {
  if (T <= 0 || iv <= 0 || S <= 0 || K <= 0) {
    // At expiry or degenerate: intrinsic only
    return isCall ? Math.max(0, S - K) : Math.max(0, K - S);
  }
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * iv * iv) * T) / (iv * sqrtT);
  const d2 = d1 - iv * sqrtT;
  if (isCall) {
    return S * normCdf(d1) - K * Math.exp(-r * T) * normCdf(d2);
  } else {
    return K * Math.exp(-r * T) * normCdf(-d2) - S * normCdf(-d1);
  }
}
