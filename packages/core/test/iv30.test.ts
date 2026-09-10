import { describe, it, expect } from 'vitest';
import {
  deriveIv30,
  IV30_DERIVATION_VERSION,
  TARGET_DTE,
  type Iv30ContractRow
} from '../src/derive/iv30.js';

/**
 * `derived_iv30_daily` (NewApp 02 §13, Q7) — the one derived table in stage 1.
 *
 * A pure function, so it is tested as one: fixtures in, row out, no database and
 * no clock. The cases that matter are the ones where the honest answer is *no
 * answer*, because a derivation that quietly produces a plausible number from
 * data that cannot support one is worse than a gap — the gap is visible in
 * `status`, the plausible number never is.
 */

const AS_OF = '2026-09-09';

/** A full call+put pair at one strike, which is what an ATM reading requires. */
function pair(
  expiration: string,
  strike: number,
  iv: number,
  overrides: Partial<Iv30ContractRow> = {}
): Iv30ContractRow[] {
  return [
    { expirationDate: expiration, strike, right: 'call', iv, ivStatus: 'ok', ...overrides },
    { expirationDate: expiration, strike, right: 'put', iv, ivStatus: 'ok', ...overrides }
  ];
}

/** Two bracketing strikes at one expiration, both legs, one flat vol. */
function flatExpiration(expiration: string, iv: number): Iv30ContractRow[] {
  return [...pair(expiration, 95, iv), ...pair(expiration, 105, iv)];
}

describe('deriveIv30 — the constant-maturity construction', () => {
  it('returns the vol itself when the term structure is flat', () => {
    // The invariant that makes variance-time interpolation checkable without
    // recomputing it by hand: whatever the two maturities, equal vols at both
    // ends must give exactly that vol at 30 days. It holds for variance
    // interpolation and for naive vol interpolation alike, which is why the
    // sloped case below is the one that distinguishes them.
    const row = deriveIv30({
      ticker: 'TEST',
      asOfDate: AS_OF,
      underlyingPrice: 100,
      contracts: [...flatExpiration('2026-09-25', 0.4), ...flatExpiration('2026-10-30', 0.4)]
    });

    expect(row.status).toBe('ok');
    expect(row.iv30).toBeCloseTo(0.4, 10);
    expect(row.nearExpiration).toBe('2026-09-25');
    expect(row.farExpiration).toBe('2026-10-30');
    expect(row.derivationVersion).toBe(IV30_DERIVATION_VERSION);
  });

  it('interpolates TOTAL VARIANCE in time, not the volatilities', () => {
    // 16 and 51 days around a 30-day target, vols 0.20 and 0.40.
    //   nearVar = 0.04 * 16 = 0.64      farVar = 0.16 * 51 = 8.16
    //   w = (30 - 16) / (51 - 16) = 0.4
    //   var30 = 0.64 + 0.4 * (8.16 - 0.64) = 3.648
    //   iv30  = sqrt(3.648 / 30) = 0.348712...
    // Interpolating the vols directly would give 0.20 + 0.4*0.20 = 0.28, so the
    // two methods are 7 vol points apart here and the test cannot pass by
    // accident.
    const row = deriveIv30({
      ticker: 'TEST',
      asOfDate: AS_OF,
      underlyingPrice: 100,
      contracts: [...flatExpiration('2026-09-25', 0.2), ...flatExpiration('2026-10-30', 0.4)]
    });

    expect(row.iv30).toBeCloseTo(Math.sqrt(3.648 / 30), 10);
    expect(row.iv30).not.toBeCloseTo(0.28, 3);
    expect(row.nearIv).toBeCloseTo(0.2, 10);
    expect(row.farIv).toBeCloseTo(0.4, 10);
  });

  it('uses a listed expiration sitting exactly on the horizon without interpolating', () => {
    const exact = new Date(Date.UTC(2026, 8, 9) + TARGET_DTE * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const row = deriveIv30({
      ticker: 'TEST',
      asOfDate: AS_OF,
      underlyingPrice: 100,
      contracts: [...flatExpiration('2026-09-20', 0.9), ...flatExpiration(exact, 0.33)]
    });

    // Both endpoints are that expiration: the stored inputs still say how the
    // number was reached, rather than leaving a reader to infer it.
    expect(row.iv30).toBeCloseTo(0.33, 10);
    expect(row.nearExpiration).toBe(exact);
    expect(row.farExpiration).toBe(exact);
  });

  it('interpolates ATM across the strikes bracketing spot', () => {
    // Spot 102 between strikes 100 (0.30) and 110 (0.40) → 0.32 at both
    // expirations, so the flat-structure invariant pins the strike step alone.
    const legs = (expiration: string) => [
      ...pair(expiration, 100, 0.3),
      ...pair(expiration, 110, 0.4)
    ];
    const row = deriveIv30({
      ticker: 'TEST',
      asOfDate: AS_OF,
      underlyingPrice: 102,
      contracts: [...legs('2026-09-25'), ...legs('2026-10-30')]
    });

    expect(row.iv30).toBeCloseTo(0.32, 10);
  });

  it('takes the mid of call and put, not either leg', () => {
    const skewed = (expiration: string): Iv30ContractRow[] => [
      { expirationDate: expiration, strike: 100, right: 'call', iv: 0.3, ivStatus: 'ok' },
      { expirationDate: expiration, strike: 100, right: 'put', iv: 0.5, ivStatus: 'ok' }
    ];
    const row = deriveIv30({
      ticker: 'TEST',
      asOfDate: AS_OF,
      underlyingPrice: 100,
      contracts: [...skewed('2026-09-25'), ...skewed('2026-10-30')]
    });

    expect(row.iv30).toBeCloseTo(0.4, 10);
  });
});

describe('deriveIv30 — a gap is declared, never guessed', () => {
  it('refuses to extrapolate when every expiration is nearer than the horizon', () => {
    const row = deriveIv30({
      ticker: 'TEST',
      asOfDate: AS_OF,
      underlyingPrice: 100,
      contracts: [...flatExpiration('2026-09-11', 0.4), ...flatExpiration('2026-09-18', 0.4)]
    });

    expect(row.status).toBe('insufficient_expirations');
    expect(row.iv30).toBeNull();
    expect(row.iv30Status).toBe('omitted');
    // The endpoints are null too: a partial record of a computation that did not
    // happen would read as one that did.
    expect(row.nearExpiration).toBeNull();
    expect(row.farExpiration).toBeNull();
  });

  it('refuses to extrapolate when every expiration is beyond the horizon', () => {
    const row = deriveIv30({
      ticker: 'TEST',
      asOfDate: AS_OF,
      underlyingPrice: 100,
      contracts: [...flatExpiration('2026-11-20', 0.4), ...flatExpiration('2026-12-18', 0.4)]
    });

    expect(row.status).toBe('insufficient_expirations');
    expect(row.iv30).toBeNull();
  });

  it('reports no_atm_quotes when the chain exists but nothing prices at the money', () => {
    // Strikes present at both expirations, but every one carries an unusable IV.
    const broken = (expiration: string) => [
      ...pair(expiration, 95, 0.4, { ivStatus: 'invalid' }),
      ...pair(expiration, 105, 0.4, { ivStatus: 'omitted' })
    ];
    const row = deriveIv30({
      ticker: 'TEST',
      asOfDate: AS_OF,
      underlyingPrice: 100,
      contracts: [...broken('2026-09-25'), ...broken('2026-10-30')]
    });

    expect(row.status).toBe('no_atm_quotes');
    expect(row.iv30).toBeNull();
  });

  it('distinguishes an empty chain from an unpriceable one', () => {
    const row = deriveIv30({
      ticker: 'TEST',
      asOfDate: AS_OF,
      underlyingPrice: 100,
      contracts: []
    });

    // Different remedies: no coverage is a collection problem, bad quotes are a
    // quote-quality problem, and a single status for both would hide which.
    expect(row.status).toBe('insufficient_expirations');
  });

  it('needs BOTH legs at a strike, so a one-sided quote is not an ATM reading', () => {
    const callsOnly = (expiration: string): Iv30ContractRow[] => [
      { expirationDate: expiration, strike: 95, right: 'call', iv: 0.4, ivStatus: 'ok' },
      { expirationDate: expiration, strike: 105, right: 'call', iv: 0.4, ivStatus: 'ok' }
    ];
    const row = deriveIv30({
      ticker: 'TEST',
      asOfDate: AS_OF,
      underlyingPrice: 100,
      contracts: [...callsOnly('2026-09-25'), ...callsOnly('2026-10-30')]
    });

    // Falling back to the single available leg would make `iv30` sometimes a
    // call/put mid and sometimes a one-sided reading, with nothing in the row
    // to say which.
    expect(row.status).toBe('no_atm_quotes');
  });

  it('refuses when spot sits outside the quoted strike range', () => {
    const row = deriveIv30({
      ticker: 'TEST',
      asOfDate: AS_OF,
      underlyingPrice: 250,
      contracts: [...flatExpiration('2026-09-25', 0.4), ...flatExpiration('2026-10-30', 0.4)]
    });

    // Clamping to the nearest strike would substitute a deep-ITM vol for an
    // at-the-money one and report it as `ok`.
    expect(row.status).toBe('no_atm_quotes');
  });

  it('will not use an expiration that cannot be priced as a bracketing endpoint', () => {
    // 24 days out exists but has no usable IV; 25 and 51 days do. The pair must
    // be 25/51, not 24/51 — picking the endpoint before checking it can be
    // priced would silently interpolate over the wrong interval.
    const row = deriveIv30({
      ticker: 'TEST',
      asOfDate: AS_OF,
      underlyingPrice: 100,
      contracts: [
        ...flatExpiration('2026-10-03', 0.9).map((c) => ({ ...c, ivStatus: 'invalid' })),
        ...flatExpiration('2026-10-04', 0.2),
        ...flatExpiration('2026-10-30', 0.4)
      ]
    });

    expect(row.status).toBe('ok');
    expect(row.nearExpiration).toBe('2026-10-04');
    expect(row.nearIv).toBeCloseTo(0.2, 10);
  });

  it('ignores expirations at or before the as-of date', () => {
    const row = deriveIv30({
      ticker: 'TEST',
      asOfDate: AS_OF,
      underlyingPrice: 100,
      contracts: [
        ...flatExpiration(AS_OF, 0.4),
        ...flatExpiration('2026-09-04', 0.4),
        ...flatExpiration('2026-10-30', 0.4)
      ]
    });

    // Only the far expiration survives, so there is no bracketing pair. A
    // zero-DTE contract has no time value and a past one is a data fault;
    // either as an endpoint would poison the interpolation.
    expect(row.status).toBe('insufficient_expirations');
  });
});

describe('deriveIv30 — date handling', () => {
  it('counts calendar days in one time base across a month boundary', () => {
    // 2026-09-09 -> 2026-10-09 is 30 days. If the day count ever mixed a local
    // weekday with a UTC serialisation, this pair would drift by one and the
    // exact-horizon branch would silently stop firing.
    const row = deriveIv30({
      ticker: 'TEST',
      asOfDate: AS_OF,
      underlyingPrice: 100,
      contracts: [...flatExpiration('2026-09-20', 0.9), ...flatExpiration('2026-10-09', 0.25)]
    });

    expect(row.nearExpiration).toBe('2026-10-09');
    expect(row.farExpiration).toBe('2026-10-09');
    expect(row.iv30).toBeCloseTo(0.25, 10);
  });
});
