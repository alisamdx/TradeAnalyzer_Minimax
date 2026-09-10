import { describe, it, expect } from 'vitest';
import {
  makeIvBootstrapIngest,
  pickIv30,
  extractRows,
  outOfBandCount
} from '../src/ingest/iv-bootstrap.js';
import type { IngestContext } from '../src/collector/capture.js';

/**
 * The `bootstrap_iv` loader (04 §7.3, Q17).
 *
 * **This parser could not be written against a live response** — the
 * subscription is a spend decision that has not been taken — so these fixtures
 * encode the existing app's evidence rather than a measurement, and the tests
 * are shaped around exactly that weakness. What they pin is not "IVolatility
 * sends X"; it is "whatever it sends, this code does not silently rescale it".
 *
 * The first live response must be read and these fixtures corrected against it.
 */

const CTX: IngestContext = {
  runId: 7,
  asOfDate: '2026-09-09',
  observedAt: '2026-09-09T17:00:00-04:00',
  captureRuleId: 3,
  sourceResponseId: 11
};

const ingest = makeIvBootstrapIngest({ ticker: 'AAPL', source: 'ivolatility' });

describe('the unit is never inferred from the magnitude', () => {
  it('stores a fraction exactly as sent, with no ×100 anywhere', () => {
    // 02 §0.1 stores fractions. The existing app multiplies by 100 because IT
    // stores percentages; carrying that habit across would inflate every row a
    // hundredfold.
    const rows = ingest(JSON.stringify([{ date: '2026-08-03', iv30: 0.3882 }]), CTX);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.values['iv30']).toBe(0.3882);
  });

  it('does NOT divide a value above 2, which is a real implied vol', () => {
    // The existing app's `pickNum` does `n > 2 ? n / 100 : n`. 200%+ IV is
    // ordinary for a biotech binary or a squeezed meme name, so that rule
    // corrupts precisely the highest-vol tickers — the ones a premium seller
    // cares most about — and leaves a plausible number behind.
    expect(pickIv30({ iv30: 2.4 })).toBe(2.4);
    expect(pickIv30({ iv30: '2.4' })).toBe(2.4);

    const rows = ingest(JSON.stringify([{ date: '2026-08-03', iv30: 2.4 }]), CTX);
    expect(rows[0]!.values['iv30']).toBe(2.4);
  });

  it('parses a numeric string without treating it as a different unit', () => {
    // A number arriving as a string is a formatting choice, not a unit change.
    expect(pickIv30({ iv30: '0.412' })).toBeCloseTo(0.412, 10);
  });

  it('stores an out-of-band value rather than correcting or dropping it', () => {
    // If IVolatility turns out to send percentages, every row of the first load
    // is out of band at once and says so. Dropping would look like sparse
    // coverage; correcting would make the unit error invisible.
    const body = JSON.stringify([
      { date: '2026-08-03', iv30: 28.5 },
      { date: '2026-08-04', iv30: 31.2 }
    ]);
    const rows = ingest(body, CTX);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.values['iv30']).toBe(28.5);

    const counted = outOfBandCount(JSON.parse(body));
    expect(counted).toEqual({ total: 2, outOfBand: 2 });
  });

  it('counts nothing out of band on a plausible fraction series', () => {
    const body = JSON.stringify([
      { date: '2026-08-03', iv30: 0.28 },
      { date: '2026-08-04', iv30: 1.9 }
    ]);
    expect(outOfBandCount(JSON.parse(body))).toEqual({ total: 2, outOfBand: 0 });
  });
});

describe('loading is not accepting', () => {
  it('writes `accepted = 0` explicitly on every row', () => {
    const rows = ingest(JSON.stringify([{ date: '2026-08-03', iv30: 0.4 }]), CTX);
    // Written rather than defaulted, at the one place that could blur the
    // distinction: nothing reads an unaccepted row, and rank computes from our
    // own series alone until an operator rules.
    expect(rows[0]!.values['accepted']).toBe(0);
    expect(rows[0]!.values['accepted_at']).toBeNull();
    expect(rows[0]!.values['accepted_note']).toBeNull();
  });

  it('carries the method note on every row, so a lapsed subscription still explains itself', () => {
    const rows = ingest(JSON.stringify([{ date: '2026-08-03', iv30: 0.4 }]), CTX);
    // Two vendors' "30-day ATM IV" are not the same number, and the difference
    // is only recoverable if the method travels with the data.
    expect(String(rows[0]!.values['method_note'])).toContain('constant-maturity');
    expect(String(rows[0]!.values['method_note'])).toContain('NOT the same construction');
  });
});

describe('envelopes and missing fields', () => {
  it('reads a bare array, and the four wrapped shapes', () => {
    const row = { date: '2026-08-03', iv30: 0.4 };
    expect(extractRows([row])).toHaveLength(1);
    for (const key of ['data', 'rows', 'results', 'records', 'ivx']) {
      expect(extractRows({ [key]: [row] }), key).toHaveLength(1);
    }
  });

  it('finds the spaced field name the existing app discovered', () => {
    expect(pickIv30({ '30d IV Mean': 0.33 })).toBe(0.33);
    expect(pickIv30({ '30d IV Call': 0.31 })).toBe(0.31);
  });

  it('skips a row with no date rather than inventing one', () => {
    // A row with no date cannot be paired with anything, so it can never
    // contribute to the overlap — storing it under a guessed date would put a
    // fabricated pairing into the one comparison this whole step exists for.
    const rows = ingest(JSON.stringify([{ iv30: 0.4 }, { date: '2026-08-03', iv30: 0.4 }]), CTX);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.values['date']).toBe('2026-08-03');
  });

  it('skips a day whose 30-day tenor is genuinely absent', () => {
    const rows = ingest(
      JSON.stringify([{ date: '2026-08-03', iv60: 0.4 }, { date: '2026-08-04', iv30: 0.4 }]),
      CTX
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.values['date']).toBe('2026-08-04');
  });

  it('returns nothing for a body that is not JSON, rather than throwing', () => {
    // The archived response is on disk either way; a throw here would take the
    // whole load down over one bad ticker.
    expect(ingest('<html>rate limited</html>', CTX)).toHaveLength(0);
  });

  it('is deterministic — the same body gives byte-identical rows', () => {
    const body = JSON.stringify([{ date: '2026-08-03', iv30: 0.4 }]);
    expect(JSON.stringify(ingest(body, CTX))).toBe(JSON.stringify(ingest(body, CTX)));
  });

  it('truncates a timestamped date to the day', () => {
    const rows = ingest(JSON.stringify([{ date: '2026-08-03T00:00:00Z', iv30: 0.4 }]), CTX);
    expect(rows[0]!.values['date']).toBe('2026-08-03');
  });
});
