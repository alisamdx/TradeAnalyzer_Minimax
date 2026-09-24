// The STALE_GREEK_MODEL_DELTA shadow log (v1.1.320): for every chain the stale-Greek guard flags in
// the wheel DTE window, the put the wheel rule would pick by our model delta. It exists so the OFF
// flag can be decided on realized outcomes — the guard makes the wheel skip these tickers, so
// nothing else records what the fallback would have done.

import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type DbHandle } from '../src/main/db/connection.js';
import { runMigrations } from '../src/main/db/migrations.js';
import { MIGRATIONS_DIR } from './helpers.js';
import { assessChainGreeks, bsDelta } from '../src/main/services/greek-consistency.js';
import { readStaleGreekShadow, recordStaleGreekShadow, shadowWheelPick } from '../src/main/services/stale-greek-shadow.js';
import type { OptionContract, OptionsChain } from '../src/main/services/data-provider.js';

const TODAY = '2026-09-16';
const AFTER_CLOSE = new Date('2026-09-16T21:30:00Z'); // 17:30 ET
const INTRADAY = new Date('2026-09-16T14:30:00Z');    // 10:30 ET

function chain(ticker: string, spot: number, greekSpot: number, expiry = '2026-10-16'): OptionsChain {
  const dte = Math.round((Date.parse(`${expiry}T00:00:00Z`) - Date.parse(`${TODAY}T00:00:00Z`)) / 86_400_000);
  const contracts: OptionContract[] = [];
  const step = Math.max(1, Math.round(spot / 50));
  for (let k = -12; k <= 8; k++) {
    const strike = Math.round(spot) + k * step;
    for (const side of ['call', 'put'] as const) {
      contracts.push({
        ticker, expiration: expiry, strike, side, bid: 2, ask: 2.2,
        delta: bsDelta(greekSpot, strike, dte, 0.35, side), gamma: 0.01, theta: -0.05, vega: 0.2,
        iv: 0.35, openInterest: 500, volume: 50,
      });
    }
  }
  return { ticker, expiration: expiry, contracts, underlyingPrice: spot };
}

function db(): DbHandle {
  const d = openDatabase(':memory:');
  runMigrations(d, MIGRATIONS_DIR);
  return d;
}

type Row = { ticker: string; slot: string; strike: number | null; model_delta: number | null; provider_delta: number | null; dte: number };
const rows = (d: DbHandle): Row[] =>
  d.prepare('SELECT ticker, slot, strike, model_delta, provider_delta, dte FROM stale_greek_shadow_picks ORDER BY id').all() as Row[];

afterEach(() => { delete process.env['STALE_GREEK_GUARD']; });

describe('stale-Greek shadow log', () => {
  it('records the put the wheel rule would pick by model delta, beside the stale delta E*Trade sent', () => {
    const d = db();
    const stale = chain('WSM', 218.2, 234.97);
    recordStaleGreekShadow(d, stale, assessChainGreeks(stale, TODAY), TODAY, AFTER_CLOSE);
    const [r] = rows(d);
    expect(r).toMatchObject({ ticker: 'WSM', slot: 'after_close', dte: 30 });
    // In the 0.20-0.30 band by OUR delta at the chain's own price...
    expect(Math.abs(r!.model_delta!)).toBeGreaterThanOrEqual(0.20);
    expect(Math.abs(r!.model_delta!)).toBeLessThanOrEqual(0.30);
    expect(r!.model_delta!).toBeCloseTo(bsDelta(218.2, r!.strike!, 30, 0.35, 'put')!, 10);
    // ...while the delta E*Trade sent for the same contract, computed at 234.97, reads further out.
    expect(Math.abs(r!.provider_delta!)).toBeLessThan(Math.abs(r!.model_delta!));
    // And it is the contract nearest 0.25 by model delta, as findSuitableChain would choose.
    expect(shadowWheelPick(stale, 30)!.strike).toBe(r!.strike);
  });

  it('records nothing for a clean chain', () => {
    const d = db();
    const fine = chain('AAA', 100, 100);
    recordStaleGreekShadow(d, fine, assessChainGreeks(fine, TODAY), TODAY, AFTER_CLOSE);
    expect(rows(d)).toHaveLength(0);
  });

  it('ignores a stale chain outside the wheel DTE window', () => {
    const d = db();
    const near = chain('WSM', 218.2, 234.97, '2026-09-26'); // 10 DTE
    recordStaleGreekShadow(d, near, assessChainGreeks(near, TODAY), TODAY, AFTER_CLOSE);
    expect(rows(d)).toHaveLength(0);
  });

  it('keeps one row per slot: a re-fetch overwrites, the other slot is its own row', () => {
    const d = db();
    const stale = chain('WSM', 218.2, 234.97);
    const a = assessChainGreeks(stale, TODAY);
    recordStaleGreekShadow(d, stale, a, TODAY, INTRADAY);
    recordStaleGreekShadow(d, stale, a, TODAY, AFTER_CLOSE);
    recordStaleGreekShadow(d, stale, a, TODAY, AFTER_CLOSE);
    expect(rows(d).map((r) => r.slot)).toEqual(['intraday', 'after_close']);
  });

  it('still records a stale chain with no put in the band, with a null strike', () => {
    const d = db();
    const stale = chain('WSM', 218.2, 234.97);
    stale.contracts = stale.contracts.map((c) => (c.side === 'put' ? { ...c, bid: 0 } : c));
    recordStaleGreekShadow(d, stale, assessChainGreeks(stale, TODAY), TODAY, AFTER_CLOSE);
    expect(rows(d)).toEqual([expect.objectContaining({ ticker: 'WSM', strike: null, model_delta: null })]);
  });

  it('reads back by date range for the diagnostics route', () => {
    const d = db();
    const stale = chain('WSM', 218.2, 234.97);
    recordStaleGreekShadow(d, stale, assessChainGreeks(stale, TODAY), TODAY, AFTER_CLOSE);
    const got = readStaleGreekShadow(d, '2026-09-01', '2026-09-30');
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ asOfDate: TODAY, ticker: 'WSM', slot: 'after_close', dte: 30, underlyingPrice: 218.2 });
    expect(readStaleGreekShadow(d, '2026-10-01', '2026-10-31')).toHaveLength(0);
  });

  it('is fed by the provider with the chain AS FETCHED, and a failing sink never costs the chain', async () => {
    const { ETradeDataProvider } = await import('../src/main/services/etrade-data-provider.js');
    const todayEt = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const expiry = new Date(Date.parse(`${todayEt}T00:00:00Z`) + 35 * 86_400_000).toISOString().slice(0, 10);
    const legs = (side: 'CALL' | 'PUT') =>
      chain('WSM', 218.2, 234.97, expiry).contracts
        .filter((c) => c.side === side.toLowerCase())
        .map((c) => ({
          symbol: 'WSM', osiKey: 'x', optionType: side, strikePrice: c.strike, bid: c.bid, ask: c.ask,
          bidSize: 1, askSize: 1, lastPrice: null, volume: c.volume, openInterest: c.openInterest, inTheMoney: false,
          greek: { delta: c.delta, gamma: c.gamma, theta: c.theta, vega: c.vega, rho: 0, iv: c.iv },
          hasGreeks: true, hasBidAsk: true,
        }));
    const fetched = async () => ({ calls: legs('CALL'), puts: legs('PUT'), underlyingPrice: 218.2 });

    const seen: OptionsChain[] = [];
    const recording = new ETradeDataProvider(() => ({}) as never, (c) => { seen.push(c); });
    (recording as unknown as { withRenew: () => Promise<unknown> }).withRenew = fetched;
    const out = await recording.getOptionsChain('WSM', expiry);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.contracts.some((c) => c.delta !== null)).toBe(true); // before the Greeks were withheld
    expect(out.contracts.every((c) => c.delta === null)).toBe(true);     // live path unchanged

    const failing = new ETradeDataProvider(() => ({}) as never, () => { throw new Error('disk full'); });
    (failing as unknown as { withRenew: () => Promise<unknown> }).withRenew = fetched;
    await expect(failing.getOptionsChain('WSM', expiry)).resolves.toMatchObject({ ticker: 'WSM' });
  });
});
