/**
 * Just enough Black-Scholes for QC-410 — 03 §3.5.
 *
 * **What QC-410 verifies is that E*Trade's Greeks are on the scale the
 * dictionary claims, not that they match our model.** Measured 2026-09-07 on a
 * live SPY chain, E*Trade's delta sits 0.018–0.029 below a European
 * Black-Scholes, monotonically in moneyness: largest at the money, near zero
 * deep in. Adding SPY's ~1.15 % dividend yield halves the worst gap (0.0287 to
 * 0.0179) without closing it, and the residual's shape says *model* — SPY
 * options are American and E*Trade does not publish its pricer.
 *
 * So the tolerance is 0.05: far above a model difference, far below anything a
 * unit or scale fault could produce, since those are off by 100× or sign
 * flipped. Reproducing a vendor's American pricer to three decimals is a
 * different and much harder goal, and not what P4 asks for.
 */

/**
 * Standard normal CDF via Abramowitz & Stegun 7.1.26.
 *
 * Accurate to ~1.5e-7, which is four orders of magnitude finer than the 0.05
 * tolerance it feeds — the approximation cannot be what makes this check fire.
 */
export function normCdf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-z * z);
  return 0.5 * (1 + sign * y);
}

/**
 * European Black-Scholes delta.
 *
 * Returns null rather than a number whenever an input makes the formula
 * meaningless — expired, zero vol, non-positive price. A check that silently
 * substituted a default here would compare against a fabricated value, which is
 * the failure mode this project exists to avoid.
 */
export function bsDelta(args: {
  readonly spot: number;
  readonly strike: number;
  readonly dteDays: number;
  readonly iv: number;
  readonly rate: number;
  readonly right: 'call' | 'put';
}): number | null {
  const { spot, strike, dteDays, iv, rate, right } = args;
  if (!(spot > 0) || !(strike > 0) || !(iv > 0) || !(dteDays > 0)) return null;

  const t = dteDays / 365;
  const d1 = (Math.log(spot / strike) + (rate + (iv * iv) / 2) * t) / (iv * Math.sqrt(t));
  return right === 'call' ? normCdf(d1) : normCdf(d1) - 1;
}

/**
 * The underlying price at which our Black-Scholes delta equals `delta`.
 *
 * QC-410 compares this with the put-call-parity spot to ask whether a
 * provider's Greeks were computed off the price its own option quotes imply.
 * Measured 2026-09-15/16: parity reproduced the session close to a median of
 * -0.03 % across ~500 tickers, while PCTY's deltas implied 113.6 on a 147.3
 * close on both days.
 *
 * Delta rises with spot for calls and puts alike, so bisection finds the one
 * root. Returns null for a saturated delta (|delta| < 0.05 or > 0.95), where
 * delta is flat in spot and any root is arbitrary, and when no root lies within
 * half to one-and-a-half times `nearSpot`.
 */
export function impliedSpotFromDelta(args: {
  readonly delta: number;
  readonly nearSpot: number;
  readonly strike: number;
  readonly dteDays: number;
  readonly iv: number;
  readonly rate: number;
  readonly right: 'call' | 'put';
}): number | null {
  const { delta, nearSpot, ...rest } = args;
  const magnitude = Math.abs(delta);
  if (!(nearSpot > 0) || magnitude < 0.05 || magnitude > 0.95) return null;
  const gap = (spot: number): number | null => {
    const d = bsDelta({ ...rest, spot });
    return d === null ? null : d - delta;
  };
  let lo = nearSpot * 0.5;
  let hi = nearSpot * 1.5;
  const atLo = gap(lo);
  const atHi = gap(hi);
  if (atLo === null || atHi === null || atLo > 0 || atHi < 0) return null;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if ((gap(mid) as number) > 0) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

/**
 * The underlying price a call/put pair's quoted mids imply, by put-call parity:
 * S = C - P + K·e^(-rT). No Greek and no volatility enters it, which is what
 * makes it the reference QC-410 measures the provider's delta against.
 *
 * European and dividend-free, so it is biased low by the present value of any
 * dividend before expiry and slightly by early exercise; both are small against
 * the 1 % QC-410 tests at.
 */
export function paritySpot(args: {
  readonly callMid: number;
  readonly putMid: number;
  readonly strike: number;
  readonly dteDays: number;
  readonly rate: number;
}): number | null {
  const { callMid, putMid, strike, dteDays, rate } = args;
  if (!(strike > 0) || !(dteDays > 0) || !(callMid >= 0) || !(putMid >= 0)) return null;
  return callMid - putMid + strike * Math.exp(-rate * (dteDays / 365));
}
