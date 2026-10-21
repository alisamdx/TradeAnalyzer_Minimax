// Wheel "No suitable CSP" reason codes (v1.1.370). Every cause used to write the same text, so the
// wheel snapshot could not say whether a ticker had nothing in the delta band or had its Greeks
// withheld by STALE_GREEK_GUARD. Measured 2026-10-20 by joining to stale_greek_shadow_picks:
// 70–78 % of after-close misses were withheld chains (Requirements/v2-execution/06).
//
// These pin the classification and that the tally is filled by the REAL chain walk. The walk's
// selection must be unchanged: the tally is only written, never read.

import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/main/db/connection.js';
import { runMigrations } from '../src/main/db/migrations.js';
import { MIGRATIONS_DIR } from './helpers.js';
import {
  AnalysisService,
  chainHasNoDeltas,
  classifyNoCsp,
  emptyChainSearchTally,
  noCspExplanation,
  type ChainSearchTally,
} from '../src/main/services/analysis-service.js';
import type { OptionContract, OptionsChain, OptionsProvider } from '../src/main/services/options-provider.js';

const tally = (o: Partial<ChainSearchTally>): ChainSearchTally => ({ ...emptyChainSearchTally(), ...o });

describe('classifyNoCsp', () => {
  it('names each cause', () => {
    expect(classifyNoCsp(tally({ expirationsFailed: true }))).toBe('expirations_unavailable');
    expect(classifyNoCsp(tally({ inWindow: 0 }))).toBe('no_expiry_in_window');
    expect(classifyNoCsp(tally({ inWindow: 2, fetched: 0 }))).toBe('chain_unavailable');
    expect(classifyNoCsp(tally({ inWindow: 2, fetched: 2, withheld: 2 }))).toBe('greeks_withheld');
    expect(classifyNoCsp(tally({ inWindow: 2, fetched: 2, withheld: 0 }))).toBe('none_in_band');
  });

  it('blames the band, not the guard, when any chain had Greeks', () => {
    expect(classifyNoCsp(tally({ inWindow: 2, fetched: 2, withheld: 1 }))).toBe('none_in_band');
  });

  it('keeps the historical prefix so text consumers still match', () => {
    const s = noCspExplanation('greeks_withheld', 30, 45);
    expect(s.startsWith('No suitable CSP found (30–45 DTE, delta 0.20–0.30) [greeks_withheld]')).toBe(true);
  });
});

describe('chainHasNoDeltas', () => {
  it('is false for an empty chain — nothing was withheld from it', () => {
    expect(chainHasNoDeltas({ ticker: 'X', expiration: '2026-11-20', contracts: [] })).toBe(false);
  });
});

// ── the real walk ────────────────────────────────────────────────────────────

/** Every Friday from the coming one for `weeks` weeks, all-UTC (matches guessNearTermFridays). */
function fridays(weeks: number): string[] {
  const now = new Date();
  const first = new Date(now);
  first.setUTCDate(now.getUTCDate() + ((5 - now.getUTCDay() + 7) % 7));
  return Array.from({ length: weeks }, (_, w) => {
    const d = new Date(first);
    d.setUTCDate(first.getUTCDate() + w * 7);
    return d.toISOString().slice(0, 10);
  });
}

function contract(exp: string, strike: number, delta: number | null): OptionContract {
  return {
    ticker: 'X', expiration: exp, strike, side: 'put', bid: 1, ask: 1.1,
    delta, gamma: null, theta: null, vega: null, iv: 0.4, openInterest: 100, volume: 10,
  };
}

async function walk(
  listed: string[],
  chainFor: (exp: string) => OptionsChain,
): Promise<{ hit: unknown; tally: ChainSearchTally }> {
  const db = openDatabase(':memory:');
  runMigrations(db, MIGRATIONS_DIR);
  const provider = {
    getOptionsExpirations: async () => listed,
    getOptionsChain: async (_t: string, exp: string) => chainFor(exp),
  } as unknown as OptionsProvider;
  const svc = new AnalysisService(db, {} as never, {} as never, {} as never, provider);
  const t = emptyChainSearchTally();
  const search = (svc as unknown as {
    findSuitableChain: (...a: unknown[]) => Promise<unknown>;
  }).findSuitableChain.bind(svc);
  const hit = await search('X', 30, 45, 0.20, 0.30, false, t);
  return { hit, tally: t };
}

describe('findSuitableChain fills the tally', () => {
  const all = fridays(12);

  it('greeks_withheld: chains come back with prices and no deltas', async () => {
    const { hit, tally: t } = await walk(all, (exp) => ({
      ticker: 'X', expiration: exp, underlyingPrice: 100,
      contracts: [contract(exp, 95, null), contract(exp, 90, null)],
    }));
    expect(hit).toBeNull();
    expect(t.inWindow).toBeGreaterThan(0);
    expect(t.withheld).toBe(t.fetched);
    expect(classifyNoCsp(t)).toBe('greeks_withheld');
  });

  it('none_in_band: deltas present, all outside 0.20–0.30', async () => {
    const { hit, tally: t } = await walk(all, (exp) => ({
      ticker: 'X', expiration: exp, underlyingPrice: 100,
      contracts: [contract(exp, 95, -0.45), contract(exp, 80, -0.05)],
    }));
    expect(hit).toBeNull();
    expect(classifyNoCsp(t)).toBe('none_in_band');
  });

  it('chain_unavailable: every in-window chain fetch fails', async () => {
    const { hit, tally: t } = await walk(all, () => { throw new Error('10031'); });
    expect(hit).toBeNull();
    expect(classifyNoCsp(t)).toBe('chain_unavailable');
  });

  it('no_expiry_in_window: only expiries beyond the window are listed (the monthly gap)', async () => {
    const { hit, tally: t } = await walk(all.slice(8), () => { throw new Error('must not be fetched'); });
    expect(hit).toBeNull();
    expect(classifyNoCsp(t)).toBe('no_expiry_in_window');
  });

  it('a hit is unchanged by the tally — selection still picks the in-band put', async () => {
    const { hit } = await walk(all, (exp) => ({
      ticker: 'X', expiration: exp, underlyingPrice: 100,
      contracts: [contract(exp, 95, -0.40), contract(exp, 90, -0.24)],
    }));
    expect((hit as { contract: OptionContract }).contract.strike).toBe(90);
  });
});
