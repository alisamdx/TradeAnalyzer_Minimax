import { describe, it, expect } from 'vitest';
import { osiSymbol } from '../src/ingest/osi.js';

/**
 * The constructed OSI symbol (B8).
 *
 * **The whole risk here is a silent mismatch.** `ref_sticky_contract.osi_symbol`
 * is matched against `raw_option_contract_snapshot.osi_symbol`, which E*Trade
 * supplies — so a padding difference does not throw, it pins a contract that
 * never matches anything. The sticky set would look populated and capture
 * nothing.
 *
 * The reference string below is the shape a live E*Trade chain returned
 * (2026-09-07), not one read off a specification.
 */

describe('osiSymbol matches the shape E*Trade sends', () => {
  it('builds the reference SPY contract exactly', () => {
    expect(
      osiSymbol({ ticker: 'SPY', expiration: '2026-09-18', side: 'call', strike: 500 })
    ).toBe('SPY   260918C00500000');
  });

  it('pads the root to six characters, left aligned', () => {
    // Three real roots of different lengths — the padding is where a
    // constructed symbol most easily diverges from a received one.
    expect(osiSymbol({ ticker: 'F', expiration: '2026-10-16', side: 'put', strike: 12 }))
      .toBe('F     261016P00012000');
    expect(osiSymbol({ ticker: 'AAPL', expiration: '2026-10-16', side: 'put', strike: 230 }))
      .toBe('AAPL  261016P00230000');
    expect(osiSymbol({ ticker: 'GOOGL', expiration: '2026-10-16', side: 'call', strike: 175 }))
      .toBe('GOOGL 261016C00175000');
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
      .toBe('SPY   260918C00500000');
  });

  it('refuses a malformed expiration rather than emitting a wrong symbol', () => {
    // Silently producing `NaN` in the date would give a symbol that matches
    // nothing, which is the failure this whole file exists to prevent.
    expect(() => osiSymbol({ ticker: 'SPY', expiration: '18/09/2026', side: 'call', strike: 500 }))
      .toThrow(/YYYY-MM-DD/);
  });
});
