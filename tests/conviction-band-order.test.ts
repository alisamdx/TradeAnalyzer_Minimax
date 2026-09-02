// Regression tests for the conviction band-ordering invariant (v1.1.165).
//
// The edit modal always validated low < mid < high, but the service did not — and the
// modal is not the only writer. The AI review "Apply" path merges recommended values
// field-by-field into the stored bands, so a recommended low can land above an untouched
// mid. That wrote inverted bands that sat unnoticed for three weeks across three tickers,
// silently feeding wrong buy-zone alerts and the daily-brief conviction callout.

import { describe, it, expect } from 'vitest';
import { openDatabase } from '../src/main/db/connection.js';
import { runMigrations } from '../src/main/db/migrations.js';
import { MIGRATIONS_DIR } from './helpers.js';
import { ConvictionService, validateBandOrder } from '../src/main/services/conviction-service.js';

function svc(): ConvictionService {
  const db = openDatabase(':memory:');
  runMigrations(db, MIGRATIONS_DIR);
  return new ConvictionService(db);
}

describe('validateBandOrder', () => {
  it('accepts strictly increasing bands', () => {
    expect(() => validateBandOrder('T', 100, 110, 130)).not.toThrow();
  });

  it('accepts partial bands — nulls are skipped, not treated as zero', () => {
    expect(() => validateBandOrder('T', 100, null, null)).not.toThrow();
    expect(() => validateBandOrder('T', null, 110, null)).not.toThrow();
    expect(() => validateBandOrder('T', null, null, 130)).not.toThrow();
    expect(() => validateBandOrder('T', 100, null, 130)).not.toThrow();
    expect(() => validateBandOrder('T', undefined, undefined, undefined)).not.toThrow();
  });

  it('rejects every inverted pair', () => {
    expect(() => validateBandOrder('T', 120, 110, 130)).toThrow(/Low entry.*less than Mid/);
    expect(() => validateBandOrder('T', 100, 140, 130)).toThrow(/Mid price.*less than High/);
    expect(() => validateBandOrder('T', 140, null, 130)).toThrow(/Low entry.*less than High/);
  });

  it('rejects equal bands — a degenerate zone has no width', () => {
    expect(() => validateBandOrder('T', 100, 100, 130)).toThrow();
    expect(() => validateBandOrder('T', 100, 130, 130)).toThrow();
    expect(() => validateBandOrder('T', 130, null, 130)).toThrow();
  });

  it('names the ticker and both offending values so the message is actionable', () => {
    expect(() => validateBandOrder('SNOW', 120, 110, null))
      .toThrow(/SNOW.*\$120.*\$110/);
  });
});

describe('ConvictionService band-order enforcement', () => {
  it('refuses to add a stock with low > mid', () => {
    const s = svc();
    expect(() => s.add({ ticker: 'SNOW', priceLow: 120, priceMid: 110, priceHigh: 200 })).toThrow();
    expect(s.list()).toHaveLength(0); // nothing persisted
  });

  it('refuses to update into an inverted band and leaves the stored values intact', () => {
    const s = svc();
    s.add({ ticker: 'NVDA', priceLow: 100, priceMid: 120, priceHigh: 160 });

    expect(() => s.update('NVDA', { priceLow: 130, priceMid: 120, priceHigh: 160 })).toThrow();

    const row = s.list()[0]!;
    expect(row.priceLow).toBe(100);
    expect(row.priceMid).toBe(120);
    expect(row.priceHigh).toBe(160);
  });

  it('writes no band-history snapshot for a rejected update', () => {
    const s = svc();
    s.add({ ticker: 'AAPL', priceLow: 180, priceMid: 200, priceHigh: 240 });
    expect(() => s.update('AAPL', { priceLow: 210, priceMid: 200, priceHigh: 240 })).toThrow();
    expect(s.getHistory('AAPL')).toHaveLength(0); // validation runs before the transaction
  });

  it('rejects the AI-apply merge shape: a new low above the untouched stored mid', () => {
    const s = svc();
    s.add({ ticker: 'MSFT', priceLow: 380, priceMid: 400, priceHigh: 460 });
    // AI returns only a new low; the view merges it with the stored mid/high.
    const recommendedLow = 420;
    expect(() => s.update('MSFT', {
      priceLow: recommendedLow,
      priceMid: 400,   // stock.priceMid — untouched
      priceHigh: 460,  // stock.priceHigh — untouched
    })).toThrow(/Low entry.*less than Mid/);
  });

  it('still accepts a valid update and records history', () => {
    const s = svc();
    s.add({ ticker: 'AMD', priceLow: 100, priceMid: 120, priceHigh: 160 });
    s.update('AMD', { priceLow: 105, priceMid: 125, priceHigh: 165 });

    const row = s.list()[0]!;
    expect(row.priceLow).toBe(105);
    expect(s.getHistory('AMD')).toHaveLength(1);
    expect(s.getHistory('AMD')[0]!.priceLow).toBe(100); // pre-edit snapshot
  });

  it('accepts a ticker with no bands at all (sync from watchlist adds bare tickers)', () => {
    const s = svc();
    expect(() => s.add({ ticker: 'TSLA' })).not.toThrow();
    expect(s.list()[0]!.priceLow).toBeNull();
  });
});
