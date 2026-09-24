// Shadow log for STALE_GREEK_MODEL_DELTA (v1.1.320). For every chain the stale-Greek guard flags
// inside the wheel DTE window, record the put the wheel CSP rule would pick by our model delta —
// the evidence the OFF flag is to be decided on. Never read on the live path.
// see migrations/088_stale_greek_shadow_picks.sql, docs/formulas.md#greek-consistency

import type { DbHandle } from '../db/connection.js';
import { withTransaction } from '../db/connection.js';
import type { OptionsChain } from './data-provider.js';
import { bsDelta, type GreekAssessment } from './greek-consistency.js';
import { wheelDteWindow } from './analysis-service.js';
import { resolveSlot } from './brief-candidates.js';

/** The wheel CSP band and target, as `AnalysisService.findSuitableChain` applies them. */
const MIN_DELTA = 0.20;
const MAX_DELTA = 0.30;
const TARGET_DELTA = 0.25;

export interface ShadowPick {
  strike: number;
  modelDelta: number;
  providerDelta: number | null;
  bid: number;
  ask: number;
  iv: number;
  openInterest: number | null;
  volume: number | null;
}

/** E*Trade sends IV as a fraction; tolerate a percentage (same rule as greek-consistency.ts). */
const fractionIv = (iv: number): number => (iv > 5 ? iv / 100 : iv);

/**
 * The put the wheel rule picks on `chain` when delta is our Black-Scholes value at the chain's own
 * price: |delta| in [0.20, 0.30], bid > 0, nearest 0.25. Null when none qualifies.
 */
export function shadowWheelPick(chain: OptionsChain, dteDays: number): ShadowPick | null {
  const spot = chain.underlyingPrice;
  if (!(spot && spot > 0) || dteDays < 1) return null;
  let best: ShadowPick | null = null;
  for (const c of chain.contracts) {
    if (c.side !== 'put' || !(c.bid > 0) || !(c.iv > 0)) continue;
    // see docs/formulas.md#greek-consistency
    const d = bsDelta(spot, c.strike, dteDays, fractionIv(c.iv), 'put');
    if (d === null || Math.abs(d) < MIN_DELTA || Math.abs(d) > MAX_DELTA) continue;
    if (!best || Math.abs(Math.abs(d) - TARGET_DELTA) < Math.abs(Math.abs(best.modelDelta) - TARGET_DELTA)) {
      best = {
        strike: c.strike, modelDelta: d, providerDelta: c.delta, bid: c.bid, ask: c.ask, iv: c.iv,
        openInterest: c.openInterest, volume: c.volume,
      };
    }
  }
  return best;
}

/**
 * Records a stale chain and its shadow pick. `chain` must be the chain AS FETCHED, before its
 * Greeks were withheld, so `provider_delta` keeps what E*Trade actually sent. Chains outside the
 * wheel DTE window are ignored — no wheel rule would read them.
 */
export function recordStaleGreekShadow(
  db: DbHandle, chain: OptionsChain, assessment: GreekAssessment, todayEt: string, now: Date = new Date(),
): void {
  if (!assessment.stale || !(chain.underlyingPrice && chain.underlyingPrice > 0)) return;
  const dte = Math.round((Date.parse(`${chain.expiration}T00:00:00Z`) - Date.parse(`${todayEt}T00:00:00Z`)) / 86_400_000);
  const { minDTE, maxDTE } = wheelDteWindow();
  if (dte < minDTE || dte > maxDTE) return;
  const pick = shadowWheelPick(chain, dte);
  withTransaction(db, () => {
    db.prepare(
      `INSERT OR REPLACE INTO stale_greek_shadow_picks
         (as_of_date, slot, ticker, expiration, dte, underlying_price, implied_spot, deviation,
          strike, model_delta, provider_delta, bid, ask, iv, open_interest, volume, recorded_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      todayEt, resolveSlot(null, now), chain.ticker.toUpperCase(), chain.expiration, dte, chain.underlyingPrice,
      assessment.impliedSpot, assessment.deviation,
      pick?.strike ?? null, pick?.modelDelta ?? null, pick?.providerDelta ?? null, pick?.bid ?? null, pick?.ask ?? null,
      pick?.iv ?? null, pick?.openInterest ?? null, pick?.volume ?? null, now.toISOString(),
    );
  });
}

export interface StaleGreekShadowRow {
  asOfDate: string; slot: string; ticker: string; expiration: string; dte: number;
  underlyingPrice: number; impliedSpot: number | null; deviation: number | null;
  strike: number | null; modelDelta: number | null; providerDelta: number | null;
  bid: number | null; ask: number | null; iv: number | null; openInterest: number | null; volume: number | null;
}

/** Every shadow row in a date range, oldest first — for `GET /diagnostics/stale-greek-shadow`. */
export function readStaleGreekShadow(db: DbHandle, from: string, to: string): StaleGreekShadowRow[] {
  return db.prepare(
    `SELECT as_of_date AS asOfDate, slot, ticker, expiration, dte, underlying_price AS underlyingPrice,
            implied_spot AS impliedSpot, deviation, strike, model_delta AS modelDelta,
            provider_delta AS providerDelta, bid, ask, iv, open_interest AS openInterest, volume
       FROM stale_greek_shadow_picks
      WHERE as_of_date BETWEEN ? AND ?
      ORDER BY as_of_date, slot, ticker, expiration`
  ).all(from, to) as StaleGreekShadowRow[];
}
