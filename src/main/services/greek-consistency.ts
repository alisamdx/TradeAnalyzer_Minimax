// Detects an options chain whose Greeks were computed off a different underlying price than the
// one the chain reports. see docs/formulas.md#greek-consistency
//
// Measured 2026-09-15/16 over ~500 tickers (packages/core/scripts/qc410-study.mjs): E*Trade's
// option PRICES agree with the session close by put-call parity (median -0.03 %), but on 50-70
// tickers a day its deltas imply a different price — PCTY 113.6 on a 147.3 close on both days,
// AMG 405 on 343, WSM 235 on 218. Every strike selected "by delta" on such a chain is the wrong
// contract. The Strategy Lab already had a guard (`resolveUnderlyingPrice`, 8 %, reading the
// strike nearest put delta -0.50), but it resolves no finer than the strike spacing and misses
// the 3-8 % cases, and the wheel shortlist and analysis paths had no guard at all.

import { normCdf, RISK_FREE_RATE } from './black-scholes.js';
import type { OptionContract, OptionsChain } from './data-provider.js';

/**
 * Past this gap between the delta-implied spot and the chain's underlying price the deltas are
 * not usable. Per ticker in the study, the share of contracts whose delta missed our model by
 * more than 0.05: 1.3-2.8 % under 0.25 % apart, 12-20 % at 0.5-1 %, 39-48 % at 1-3 %, 86-94 %
 * beyond 3 %. The same threshold TradeAnalyzer 2's QC-410 flags at.
 */
export const MAX_SPOT_DEVIATION = 0.01;

/** Below this many invertible contracts a chain's median is not a reading. */
const MIN_CONTRACTS = 3;

/**
 * ON since v1.1.255, by the operator's decision, as an explicit exception to FR-SEY-5. Nulling a
 * chain's Greeks changes which strikes get recommended, and no replay can show that neutral: stored
 * candidates keep the stale delta but not the chain. The evidence it rests on instead
 * (`scripts/pick-greek-audit.mjs`, 2026-01-01..09-16): 33 of 322 invertible picks had a delta
 * implying a spot > 1 % from the stored one, 7 rows by >= 2.8 % — OLLI's 9/16 wheel put (implied
 * 76.09 on 73.23, matching TA2's independent 76.12), ORCL's 9/10 wheel and income puts, AVAV's 9/9
 * income put — each nearer the money than its delta said. The guard acts only where the Greeks
 * disagree with both the chain price and the parity price, and invents nothing: Strategy Lab falls
 * back to moneyness, the shortlist and analysis paths skip the chain.
 * `STALE_GREEK_GUARD=0` turns it off for a comparison run or a test; checked live, not cached.
 */
const STALE_GREEK_GUARD = true;
export function staleGreekGuardEnabled(): boolean {
  const env = process.env['STALE_GREEK_GUARD'];
  if (env === '0') return false;
  if (env === '1') return true;
  return STALE_GREEK_GUARD;
}

/** Black-Scholes delta, European, no dividend. `iv` as a fraction. */
export function bsDelta(spot: number, strike: number, dteDays: number, iv: number, side: 'call' | 'put', rate = RISK_FREE_RATE): number | null {
  if (!(spot > 0) || !(strike > 0) || !(iv > 0) || !(dteDays > 0)) return null;
  const t = dteDays / 365;
  const d1 = (Math.log(spot / strike) + (rate + (iv * iv) / 2) * t) / (iv * Math.sqrt(t));
  return side === 'call' ? normCdf(d1) : normCdf(d1) - 1;
}

/**
 * The spot at which Black-Scholes reproduces `delta`, by bisection (delta rises with spot for
 * calls and puts alike). Null for a saturated delta (|delta| < 0.05 or > 0.95, flat in spot) or
 * when no root lies within half to one-and-a-half times `nearSpot`.
 */
export function impliedSpotFromDelta(
  delta: number, nearSpot: number, strike: number, dteDays: number, iv: number, side: 'call' | 'put', rate = RISK_FREE_RATE,
): number | null {
  if (!(nearSpot > 0) || Math.abs(delta) < 0.05 || Math.abs(delta) > 0.95) return null;
  const gap = (s: number): number | null => {
    const d = bsDelta(s, strike, dteDays, iv, side, rate);
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

export interface GreekAssessment {
  /** Median delta-implied spot over invertible contracts; null when too few could be inverted. */
  impliedSpot: number | null;
  /** |impliedSpot / underlying - 1|; null when not measurable. */
  deviation: number | null;
  /** True only when measured AND past MAX_SPOT_DEVIATION. */
  stale: boolean;
  contracts: number;
}

/** E*Trade sends IV as a fraction; tolerate a percentage so a scale change reads as data, not NaN. */
function fractionIv(iv: number): number {
  return iv > 5 ? iv / 100 : iv;
}

export function assessChainGreeks(chain: OptionsChain, todayEt: string): GreekAssessment {
  const spot = chain.underlyingPrice;
  const dteDays = Math.round((Date.parse(`${chain.expiration}T00:00:00Z`) - Date.parse(`${todayEt}T00:00:00Z`)) / 86_400_000);
  if (!(spot && spot > 0) || dteDays < 1) return { impliedSpot: null, deviation: null, stale: false, contracts: 0 };
  const implied: number[] = [];
  for (const c of chain.contracts) {
    if (c.delta === null || !(c.iv > 0)) continue;
    // Near the money, where delta answers to spot; far strikes are saturated anyway.
    if (Math.abs(c.strike - spot) > spot * 0.1) continue;
    const s = impliedSpotFromDelta(c.delta, spot, c.strike, dteDays, fractionIv(c.iv), c.side);
    if (s !== null) implied.push(s);
  }
  if (implied.length < MIN_CONTRACTS) return { impliedSpot: null, deviation: null, stale: false, contracts: implied.length };
  const impliedSpot = median(implied);
  // Consistent if the Greeks agree with EITHER reading of the price. A dividend before expiry
  // separates the chain price from the parity price, and which one a provider's Greeks follow
  // depends on whether its model prices the dividend — BBY's followed parity (90.97 vs 91.17, chain
  // 92.45), EIX's followed the chain. Same rule as TradeAnalyzer 2's QC-410 (v1.1.254).
  const parity = paritySpotOf(chain, dteDays);
  const deviation = Math.min(
    Math.abs(impliedSpot / spot - 1),
    parity === null ? Number.POSITIVE_INFINITY : Math.abs(impliedSpot / parity - 1),
  );
  return { impliedSpot, deviation, stale: deviation > MAX_SPOT_DEVIATION, contracts: implied.length };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

/**
 * Put-call parity spot, S = C − P + K·e^(−rT), median over strikes where both sides quote a market
 * (spread ≤ 50 % of mid). Null below 3 pairs. see docs/formulas.md#greek-consistency
 */
function paritySpotOf(chain: OptionsChain, dteDays: number): number | null {
  const mid = (c: OptionContract | undefined): number | null =>
    c && c.bid > 0 && c.ask > c.bid && (c.ask - c.bid) / ((c.ask + c.bid) / 2) <= 0.5 ? (c.bid + c.ask) / 2 : null;
  const byStrike = new Map<number, { call?: OptionContract; put?: OptionContract }>();
  for (const c of chain.contracts) {
    const pair = byStrike.get(c.strike) ?? {};
    pair[c.side] = c;
    byStrike.set(c.strike, pair);
  }
  const spots: number[] = [];
  const discount = Math.exp(-RISK_FREE_RATE * (dteDays / 365));
  for (const [strike, { call, put }] of byStrike) {
    const cm = mid(call);
    const pm = mid(put);
    if (cm !== null && pm !== null) spots.push(cm - pm + strike * discount);
  }
  return spots.length >= MIN_CONTRACTS ? median(spots) : null;
}

/**
 * OFF by default (v1.1.319), by the operator's decision: on a stale chain, replace the provider's
 * delta with a Black-Scholes delta at the chain's OWN underlying price and E*Trade's IV, instead of
 * withholding it. Measured by `scripts/wheel-delta-selection-study.mjs` on TradeAnalyzer 2's raw
 * chains, 2026-09-14..23: on 228 flagged ticker-days the model delta yields a correctly targeted
 * wheel put on ~200, about 25 a day the guard currently drops; E*Trade's IV is usable there (an
 * IV solved from each contract's mid picks the same contract 2,898 times in 3,110). It stays off
 * because it ADDS candidates — which trades get recommended changes, so FR-SEY-5 applies — and
 * those picks cannot be scored until they expire. Only stale chains are touched, so a clean
 * chain's pick is identical either way (plain Black-Scholes and E*Trade's pricer differ on 19 % of
 * clean picks, which is why this is not applied everywhere). `STALE_GREEK_MODEL_DELTA=1` turns it
 * on; checked live, not cached. see docs/formulas.md#greek-consistency
 */
const STALE_GREEK_MODEL_DELTA = false;
export function staleGreekModelDeltaEnabled(): boolean {
  const env = process.env['STALE_GREEK_MODEL_DELTA'];
  if (env === '1') return true;
  if (env === '0') return false;
  return STALE_GREEK_MODEL_DELTA;
}

/**
 * The chain with its Greeks withheld when they are stale: delta/gamma/theta/vega become null, so
 * every consumer that selects by delta falls back to moneyness (Strategy Lab) or skips the chain
 * (wheel shortlist, analysis), rather than picking the wrong contract. Prices and IV are kept.
 *
 * With `staleGreekModelDeltaEnabled()` and `todayEt` given, delta is instead our Black-Scholes
 * delta at the chain's underlying price (null where it cannot be computed); gamma/theta/vega are
 * still withheld, since nothing selects by them.
 */
export function withholdStaleGreeks(chain: OptionsChain, assessment: GreekAssessment, todayEt?: string): OptionsChain {
  if (!assessment.stale) return chain;
  const spot = chain.underlyingPrice;
  const dteDays = todayEt === undefined
    ? 0
    : Math.round((Date.parse(`${chain.expiration}T00:00:00Z`) - Date.parse(`${todayEt}T00:00:00Z`)) / 86_400_000);
  const model = staleGreekModelDeltaEnabled() && spot !== null && spot > 0 && dteDays >= 1;
  const contracts: OptionContract[] = chain.contracts.map((c) => ({
    ...c,
    // see docs/formulas.md#greek-consistency
    delta: model && c.iv > 0 ? bsDelta(spot as number, c.strike, dteDays, fractionIv(c.iv), c.side) : null,
    gamma: null, theta: null, vega: null,
  }));
  return { ...chain, contracts };
}

// ─── the stored-pick audit ────────────────────────────────────────────────────

/** The subset of better-sqlite3 this audit needs. */
export interface PickAuditDb {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
}

export interface PickGreekRow {
  asOfDate: string;
  slot: string | null;
  strategy: string;
  ticker: string;
  disposition: string;
  strike: number;
  spot: number;
  dte: number;
  delta: number;
  legIv: number;
  impliedSpot: number | null;
  deviation: number | null;
}

export interface PickGreekAudit {
  from: string;
  to: string;
  /** Rows with every input present. */
  measured: number;
  /** Rows whose delta could be inverted (not saturated). */
  invertible: number;
  /** Invertible rows past MAX_SPOT_DEVIATION, by disposition. */
  staleByDisposition: Record<string, { stale: number; invertible: number }>;
  /** Every stale `picked` row, worst first — the recommendations that reached an email. */
  stalePicks: PickGreekRow[];
}

/**
 * How many stored brief candidates were chosen on a delta that disagrees with the spot stored
 * beside it. One contract per row, so noisier than a chain median; it answers "did this reach a
 * pick", not "was this chain stale". Read-only. see docs/formulas.md#greek-consistency
 */
export function auditPickGreeks(db: PickAuditDb, from: string, to: string): PickGreekAudit {
  const rows = db.prepare(
    `SELECT as_of_date, slot, strategy, ticker, disposition, strike, spot, dte, delta, leg_iv
       FROM brief_candidates
      WHERE as_of_date BETWEEN ? AND ?
        AND strike > 0 AND spot > 0 AND dte > 0 AND delta IS NOT NULL AND leg_iv > 0`
  ).all(from, to) as Array<{
    as_of_date: string; slot: string | null; strategy: string; ticker: string; disposition: string;
    strike: number; spot: number; dte: number; delta: number; leg_iv: number;
  }>;

  const staleByDisposition: PickGreekAudit['staleByDisposition'] = {};
  const stalePicks: PickGreekRow[] = [];
  let invertible = 0;
  for (const r of rows) {
    // The stored leg is the SHORT leg; its sign says the side (a put delta is negative).
    const side: 'call' | 'put' = r.delta < 0 ? 'put' : 'call';
    const impliedSpot = impliedSpotFromDelta(r.delta, r.spot, r.strike, r.dte, fractionIv(r.leg_iv), side);
    const bucket = (staleByDisposition[r.disposition] ??= { stale: 0, invertible: 0 });
    if (impliedSpot === null) continue;
    invertible++;
    bucket.invertible++;
    const deviation = Math.abs(impliedSpot / r.spot - 1);
    if (deviation <= MAX_SPOT_DEVIATION) continue;
    bucket.stale++;
    if (r.disposition === 'picked') {
      stalePicks.push({
        asOfDate: r.as_of_date, slot: r.slot, strategy: r.strategy, ticker: r.ticker, disposition: r.disposition,
        strike: r.strike, spot: r.spot, dte: r.dte, delta: r.delta, legIv: r.leg_iv, impliedSpot, deviation,
      });
    }
  }
  stalePicks.sort((a, b) => (b.deviation ?? 0) - (a.deviation ?? 0));
  return { from, to, measured: rows.length, invertible, staleByDisposition, stalePicks };
}
