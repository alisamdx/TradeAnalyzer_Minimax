// Regression tests for StrategyLabService underlying-price resolution (v0.32.69).
//
// 2026-06-10: E*Trade served stale Greeks on thin (OI=0) chains — WSO's $450
// put claimed delta −0.50 while the stock traded at $375.66 (option PRICES were
// correct; deltas were computed at a months-old spot). The lab estimated the
// underlying from those deltas and built a wheel put 11.8% ITM. The fix:
// prefer chain.underlyingPrice (E*Trade's real-time spot), then a live quote,
// and distrust chain deltas when their implied ATM deviates > 8% from spot.

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { StrategyLabService } from '../src/main/services/strategy-lab-service.js';
import type { DataProvider, OptionsChain, OptionContract } from '../src/main/services/data-provider.js';
import type { OptionsProvider } from '../src/main/services/options-provider.js';
import type { Bar } from '../src/shared/types.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const REAL_SPOT = 375.66;
const STALE_SPOT = 450; // the price E*Trade's garbage deltas were computed at

function isoDaysFromNow(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

const EXPIRATION = isoDaysFromNow(30);

/** Black-Scholes-ish garbage: deltas anchored to STALE_SPOT, prices anchored to REAL_SPOT. */
function makeContract(side: 'call' | 'put', strike: number): OptionContract {
  // Delta as if spot were STALE_SPOT (the bug we're simulating)
  const moneyness = (STALE_SPOT - strike) / STALE_SPOT;
  const rawDelta = side === 'call'
    ? Math.min(0.99, Math.max(0.01, 0.5 + moneyness * 2.5))
    : -Math.min(0.99, Math.max(0.01, 0.5 - moneyness * 2.5));
  // Price (intrinsic + small extrinsic) as if spot were REAL_SPOT (reality)
  const intrinsic = side === 'call' ? Math.max(0, REAL_SPOT - strike) : Math.max(0, strike - REAL_SPOT);
  const mid = intrinsic + 2.5;
  return {
    ticker: `WSO${EXPIRATION.replace(/-/g, '')}${side === 'call' ? 'C' : 'P'}${strike}`,
    expiration: EXPIRATION,
    strike,
    side,
    bid: mid - 0.2,
    ask: mid + 0.2,
    delta: rawDelta,
    gamma: 0.01, theta: -0.05, vega: 0.1,
    iv: 0.35,
    openInterest: 0,
    volume: 0,
  };
}

function makeChain(underlyingPrice: number | null): OptionsChain {
  const contracts: OptionContract[] = [];
  for (let strike = 330; strike <= 470; strike += 10) {
    contracts.push(makeContract('call', strike));
    contracts.push(makeContract('put', strike));
  }
  return { ticker: 'WSO', expiration: EXPIRATION, contracts, underlyingPrice };
}

function makeBars(n: number, price: number): Bar[] {
  return Array.from({ length: n }, (_, i) => ({
    t: Date.now() - (n - i) * 86_400_000,
    o: price, h: price * 1.01, l: price * 0.99, c: price, v: 1_000_000,
  }));
}

function makeProviders(chain: OptionsChain, quoteLast: number | null) {
  const dataProvider = {
    getQuote: async () => {
      if (quoteLast === null) throw new Error('quote unavailable');
      return { ticker: 'WSO', last: quoteLast, prevClose: quoteLast, bid: null, ask: null, volume: null, dayHigh: null, dayLow: null };
    },
    getHistoricalBars: async () => makeBars(90, REAL_SPOT),
  } as unknown as DataProvider;

  const optionsProvider = {
    getOptionsExpirations: async () => [EXPIRATION],
    getOptionsChain: async () => chain,
  } as unknown as OptionsProvider;

  return { dataProvider, optionsProvider };
}

function makeDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE iv_history (ticker TEXT, date TEXT, atm_iv REAL);
    CREATE TABLE constituents (ticker TEXT, index_name TEXT);
  `);
  return db;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('StrategyLabService underlying-price resolution', () => {
  it('uses chain.underlyingPrice over the chain-delta estimate (stale Greeks regression)', async () => {
    const { dataProvider, optionsProvider } = makeProviders(makeChain(REAL_SPOT), null);
    const svc = new StrategyLabService(dataProvider, optionsProvider);
    const result = await svc.validate(makeDb(), 'WSO');

    expect(result.context.underlyingPx).toBe(REAL_SPOT);
  });

  it('falls back to the live quote when the chain has no underlying price', async () => {
    const { dataProvider, optionsProvider } = makeProviders(makeChain(null), REAL_SPOT);
    const svc = new StrategyLabService(dataProvider, optionsProvider);
    const result = await svc.validate(makeDb(), 'WSO');

    expect(result.context.underlyingPx).toBe(REAL_SPOT);
  });

  it('falls back to the chain-delta estimate when no spot source is available', async () => {
    const { dataProvider, optionsProvider } = makeProviders(makeChain(null), null);
    const svc = new StrategyLabService(dataProvider, optionsProvider);
    const result = await svc.validate(makeDb(), 'WSO');

    // Garbage deltas put ATM near STALE_SPOT — last-resort behavior, unchanged
    expect(Math.abs(result.context.underlyingPx - STALE_SPOT)).toBeLessThanOrEqual(10);
  });

  it('distrusts garbage deltas: short put strike is selected by moneyness, below real spot', async () => {
    const { dataProvider, optionsProvider } = makeProviders(makeChain(REAL_SPOT), null);
    const svc = new StrategyLabService(dataProvider, optionsProvider);
    const result = await svc.validate(makeDb(), 'WSO');

    const snp = result.scores.find(s => s.slug === 'short-naked-put');
    expect(snp?.setup?.legs?.length).toBeGreaterThan(0);
    const put = snp!.setup!.legs.find(l => l.side === 'put' && l.action === 'sell');
    // Pre-fix this chose $420 (delta-target on garbage deltas) — 11.8% ITM.
    // With distrusted deltas, moneyness selection must pick an OTM strike.
    expect(put!.strike).toBeLessThan(REAL_SPOT);
  });

  it('still trusts deltas when they agree with the real spot', async () => {
    // Sane chain: deltas anchored to the same spot as prices
    const chain = makeChain(REAL_SPOT);
    for (const c of chain.contracts) {
      const moneyness = (REAL_SPOT - c.strike) / REAL_SPOT;
      c.delta = c.side === 'call'
        ? Math.min(0.99, Math.max(0.01, 0.5 + moneyness * 2.5))
        : -Math.min(0.99, Math.max(0.01, 0.5 - moneyness * 2.5));
    }
    const { dataProvider, optionsProvider } = makeProviders(chain, null);
    const svc = new StrategyLabService(dataProvider, optionsProvider);
    const result = await svc.validate(makeDb(), 'WSO');

    const snp = result.scores.find(s => s.slug === 'short-naked-put');
    const put = snp!.setup!.legs.find(l => l.side === 'put' && l.action === 'sell');
    expect(put!.strike).toBeLessThan(REAL_SPOT); // delta-targeted OTM put, sane
  });
});
