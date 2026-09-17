// E*Trade can serve an options chain whose deltas were computed off a different price than the
// chain's own underlying — PCTY's implied 113.6 on a 147.3 close on 2026-09-15 AND -16, AMG 405
// on 343, WSM 235 on 218. Every strike chosen "by delta" on such a chain is the wrong contract.
// Built from Black-Scholes so the fault is exact. see CHANGELOG v1.1.252.

import { afterEach, describe, expect, it } from 'vitest';
import {
  assessChainGreeks,
  bsDelta,
  impliedSpotFromDelta,
  MAX_SPOT_DEVIATION,
  staleGreekGuardEnabled,
  withholdStaleGreeks,
} from '../src/main/services/greek-consistency.js';
import type { OptionContract, OptionsChain } from '../src/main/services/data-provider.js';
import { pickShortlistContract } from '../src/main/services/wheel-shortlist.js';

const TODAY = '2026-09-16';
const EXPIRY = '2026-10-16'; // 30 DTE

function chain(ticker: string, spot: number, greekSpot = spot): OptionsChain {
  const contracts: OptionContract[] = [];
  const step = Math.max(1, Math.round(spot / 50));
  for (let k = -8; k <= 8; k++) {
    const strike = Math.round(spot) + k * step;
    for (const side of ['call', 'put'] as const) {
      contracts.push({
        ticker, expiration: EXPIRY, strike, side, bid: 2, ask: 2.2,
        delta: bsDelta(greekSpot, strike, 30, 0.35, side), gamma: 0.01, theta: -0.05, vega: 0.2,
        iv: 0.35, openInterest: 500, volume: 50,
      });
    }
  }
  return { ticker, expiration: EXPIRY, contracts, underlyingPrice: spot };
}

afterEach(() => {
  delete process.env['STALE_GREEK_GUARD'];
});

describe('greek consistency', () => {
  it('inverts a delta back to its spot', () => {
    const d = bsDelta(147.32, 145, 30, 0.46, 'put') as number;
    expect(impliedSpotFromDelta(d, 150, 145, 30, 0.46, 'put')).toBeCloseTo(147.32, 4);
  });

  it('passes a chain whose Greeks match its underlying', () => {
    const a = assessChainGreeks(chain('AAA', 100), TODAY);
    expect(a.stale).toBe(false);
    expect(a.deviation as number).toBeLessThan(0.001);
  });

  it('flags the WSM shape (Greeks 7.7 % off), which the Strategy Lab 8 % guard lets through', () => {
    const a = assessChainGreeks(chain('WSM', 218.2, 234.97), TODAY);
    expect(a.stale).toBe(true);
    expect(a.deviation as number).toBeGreaterThan(MAX_SPOT_DEVIATION);
    expect(a.impliedSpot as number).toBeCloseTo(234.97, 0);
  });

  it('withholds the Greeks of a stale chain and keeps its prices', () => {
    const stale = chain('WSM', 218.2, 234.97);
    const out = withholdStaleGreeks(stale, assessChainGreeks(stale, TODAY));
    expect(out.contracts.every((c) => c.delta === null && c.gamma === null)).toBe(true);
    expect(out.contracts[0]!.bid).toBe(2);
    const fine = chain('AAA', 100);
    expect(withholdStaleGreeks(fine, assessChainGreeks(fine, TODAY))).toBe(fine);
  });

  it('keeps the wheel shortlist from choosing a put by a stale delta', () => {
    const stale = chain('WSM', 218.2, 234.97);
    // Unguarded: a "0.40-delta" put exists, and it is really far closer to the money.
    expect(pickShortlistContract([stale], TODAY)).not.toBeNull();
    // Guarded: no delta, so nothing is chosen by it.
    const guarded = withholdStaleGreeks(stale, assessChainGreeks(stale, TODAY));
    expect(pickShortlistContract([guarded], TODAY)).toBeNull();
  });

  it('passes a chain whose Greeks follow parity rather than the chain price (BBY, a dividend)', async () => {
    const { bsPrice, RISK_FREE_RATE } = await import('../src/main/services/black-scholes.js');
    const quoteSpot = 91.2; // where the quotes price the stock
    const contracts: OptionContract[] = [];
    for (let k = -8; k <= 8; k++) {
      const strike = 91 + k;
      for (const side of ['call', 'put'] as const) {
        const px = bsPrice(quoteSpot, strike, 30 / 365, 0.35, RISK_FREE_RATE, side === 'call');
        contracts.push({
          ticker: 'BBY', expiration: EXPIRY, strike, side, bid: px * 0.99, ask: px * 1.01,
          delta: bsDelta(quoteSpot, strike, 30, 0.35, side), gamma: null, theta: null, vega: null,
          iv: 0.35, openInterest: 100, volume: 10,
        });
      }
    }
    // The chain reports 92.45: 1.4 % from the Greeks, which agree with the quotes.
    const a = assessChainGreeks({ ticker: 'BBY', expiration: EXPIRY, contracts, underlyingPrice: 92.45 }, TODAY);
    expect(a.stale).toBe(false);
    expect(a.deviation as number).toBeLessThan(0.002);
  });

  it('is off unless STALE_GREEK_GUARD=1 (FR-SEY-5)', () => {
    expect(staleGreekGuardEnabled()).toBe(false);
    process.env['STALE_GREEK_GUARD'] = '1';
    expect(staleGreekGuardEnabled()).toBe(true);
  });
});

describe('auditPickGreeks — against the real migrations', () => {
  it('counts a picked row whose stored delta disagrees with its stored spot, and only that one', async () => {
    const { openDatabase } = await import('../src/main/db/connection.js');
    const { runMigrations } = await import('../src/main/db/migrations.js');
    const { MIGRATIONS_DIR } = await import('./helpers.js');
    const { auditPickGreeks } = await import('../src/main/services/greek-consistency.js');
    const db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    const insert = db.prepare(
      `INSERT INTO brief_candidates (as_of_date, generated_at, strategy, ticker, composite_score, rank, disposition,
         strike, dte, spot, delta, leg_iv, slot)
       VALUES (?, '2026-09-16T17:30:00-04:00', 'wheel', ?, 60, 1, ?, ?, 30, ?, ?, ?, 'after_close')`
    );
    // Consistent: delta computed at the stored spot.
    insert.run('2026-09-16', 'AAA', 'picked', 95, 100, bsDelta(100, 95, 30, 0.3, 'put'), 0.3);
    // WSM shape: delta computed 7.7 % above the stored spot.
    insert.run('2026-09-16', 'WSM', 'picked', 210, 218.2, bsDelta(234.97, 210, 30, 0.3, 'put'), 0.3);
    // Stale but never recommended.
    insert.run('2026-09-16', 'OC', 'capped_out', 120, 126.59, bsDelta(136.99, 120, 30, 0.3, 'put'), 0.3);

    const a = auditPickGreeks(db, '2026-09-01', '2026-09-30');
    expect(a.measured).toBe(3);
    expect(a.stalePicks.map((p) => p.ticker)).toEqual(['WSM']);
    expect(a.stalePicks[0]!.impliedSpot as number).toBeCloseTo(234.97, 0);
    expect(a.staleByDisposition['capped_out']).toEqual({ stale: 1, invertible: 1 });
  });
});
