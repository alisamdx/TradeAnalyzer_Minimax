import { describe, it, expect } from 'vitest';
import { osiSymbol, hasLegacySpacePadding } from '../src/ingest/osi.js';

/**
 * The constructed OSI symbol (B8).
 *
 * **The whole risk here is a silent mismatch.** `ref_sticky_contract.osi_symbol`
 * is matched against `raw_option_contract_snapshot.osi_symbol`, which E*Trade
 * supplies — so a padding difference does not throw, it pins a contract that
 * never matches anything. The sticky set would look populated and capture
 * nothing.
 *
 * **And it happened.** Every string in this file said `SPY   260918C00500000`
 * until 2026-09-15, padded with spaces, on a docstring claiming it came from a
 * live chain. It did not: the OCC specification pads with spaces and E*Trade
 * pads with dashes. So this file asserted the bug, the builder implemented it,
 * and the two agreed for as long as neither was compared to a provider byte —
 * which is what a fixture written from the reader always does.
 *
 * The anchors below are copied out of `raw_option_contract_snapshot`, where the
 * value is E*Trade's `osiKey` stored verbatim. That is the only kind of sample
 * worth pinning here; a symbol any of us typed is worth nothing.
 */

/**
 * Captured 2026-09-15, gen-002, `raw_option_contract_snapshot.osi_symbol`.
 * Four-character roots, so the padding is visible and unambiguous.
 */
const CAPTURED = [
  { osi: 'ACGL--260918C00095000', ticker: 'ACGL', expiration: '2026-09-18', side: 'call' as const, strike: 95 },
  { osi: 'BMNR--270115P00095000', ticker: 'BMNR', expiration: '2027-01-15', side: 'put' as const, strike: 95 },
  // Captured 2026-09-18, gen-002: all 8,850 BRK.B contracts arrived rooted `BRKB--`. The pin
  // was built `BRK.B-261016P00495000` and QC-409 reported it unhonoured on a night its chain
  // was fetched and stored.
  { osi: 'BRKB--261016P00495000', ticker: 'BRK.B', expiration: '2026-10-16', side: 'put' as const, strike: 495 }
];

describe('the constructed symbol reproduces bytes the provider actually sent', () => {
  it.each(CAPTURED)('rebuilds $osi', ({ osi, ...args }) => {
    expect(osiSymbol(args)).toBe(osi);
  });

  it('never emits the space padding that matched nothing', () => {
    for (const t of ['F', 'AIZ', 'ACGL', 'GOOGL', 'ABCDEF']) {
      const built = osiSymbol({ ticker: t, expiration: '2026-10-16', side: 'call', strike: 280 });
      expect(hasLegacySpacePadding(built), t).toBe(false);
    }
    // The form 415 live pins were stored in, kept as a fixture so the repair
    // that converts them has something to be tested against.
    expect(hasLegacySpacePadding('AIZ   261016C00280000')).toBe(true);
  });
});

describe('osiSymbol matches the shape E*Trade sends', () => {
  it('builds the reference SPY contract exactly', () => {
    expect(
      osiSymbol({ ticker: 'SPY', expiration: '2026-09-18', side: 'call', strike: 500 })
    ).toBe('SPY---260918C00500000');
  });

  it('pads the root to six characters, left aligned', () => {
    // Three real roots of different lengths — the padding is where a
    // constructed symbol most easily diverges from a received one.
    expect(osiSymbol({ ticker: 'F', expiration: '2026-10-16', side: 'put', strike: 12 }))
      .toBe('F-----261016P00012000');
    expect(osiSymbol({ ticker: 'AAPL', expiration: '2026-10-16', side: 'put', strike: 230 }))
      .toBe('AAPL--261016P00230000');
    expect(osiSymbol({ ticker: 'GOOGL', expiration: '2026-10-16', side: 'call', strike: 175 }))
      .toBe('GOOGL-261016C00175000');
  });

  it('is always 21 characters', () => {
    for (const ticker of ['F', 'SPY', 'AAPL', 'GOOGL', 'ABCDEF']) {
      expect(
        osiSymbol({ ticker, expiration: '2026-10-16', side: 'put', strike: 100 }).length,
        ticker
      ).toBe(21);
    }
  });

  it('writes the strike in thousandths, eight digits', () => {
    expect(osiSymbol({ ticker: 'SPY', expiration: '2026-10-16', side: 'put', strike: 7.5 }))
      .toContain('00007500');
    expect(osiSymbol({ ticker: 'SPY', expiration: '2026-10-16', side: 'put', strike: 1234.5 }))
      .toContain('01234500');
  });

  it('rounds a float strike rather than truncating it', () => {
    // 42.499999... × 1000 truncated is 42499, which is a different strike and a
    // contract that does not exist. Rounding happens once, at the end.
    expect(osiSymbol({ ticker: 'X', expiration: '2026-10-16', side: 'put', strike: 42.5 - 1e-12 }))
      .toContain('00042500');
  });

  it('uppercases the root', () => {
    expect(osiSymbol({ ticker: 'spy', expiration: '2026-09-18', side: 'call', strike: 500 }))
      .toBe('SPY---260918C00500000');
  });

  it('refuses a malformed expiration rather than emitting a wrong symbol', () => {
    // Silently producing `NaN` in the date would give a symbol that matches
    // nothing, which is the failure this whole file exists to prevent.
    expect(() => osiSymbol({ ticker: 'SPY', expiration: '18/09/2026', side: 'call', strike: 500 }))
      .toThrow(/YYYY-MM-DD/);
  });
});
