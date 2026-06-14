// Regression tests for My Stocks "in play" flag + email report (v0.33.5).

import { describe, it, expect } from 'vitest';
import { openDatabase } from '../src/main/db/connection.js';
import { runMigrations } from '../src/main/db/migrations.js';
import { MIGRATIONS_DIR } from './helpers.js';
import { ConvictionService } from '../src/main/services/conviction-service.js';

function svc(): ConvictionService {
  const db = openDatabase(':memory:');
  runMigrations(db, MIGRATIONS_DIR);
  return new ConvictionService(db);
}

describe('conviction in-play flag', () => {
  it('defaults to false and toggles on/off, persisting in list()', () => {
    const s = svc();
    s.add({ ticker: 'NVDA' });
    expect(s.list()[0]!.inPlay).toBe(false);

    expect(s.setInPlay('nvda', true).inPlay).toBe(true);   // case-insensitive
    expect(s.list()[0]!.inPlay).toBe(true);

    s.setInPlay('NVDA', false);
    expect(s.list()[0]!.inPlay).toBe(false);
  });

  it('does not write a band-history snapshot when toggling the flag', () => {
    const s = svc();
    s.add({ ticker: 'AAPL', priceLow: 180 });
    s.setInPlay('AAPL', true);
    expect(s.getHistory('AAPL')).toHaveLength(0); // flag is not a band change
  });
});

describe('conviction email report', () => {
  it('includes the flag, skips the Actions column, and sorts in-play first', () => {
    const s = svc();
    s.add({ ticker: 'AAA', priceLow: 10 });
    s.add({ ticker: 'ZZZ', priceLow: 10 });
    s.setInPlay('ZZZ', true);

    const { subject, html } = s.buildEmailReport();
    expect(html).toContain('AAA');
    expect(html).toContain('ZZZ');
    expect(html).toContain('🚩');               // flag rendered
    expect(html).not.toContain('Actions');      // actions column omitted
    expect(subject).toContain('1 in play');
    // In-play ZZZ should appear before AAA despite alphabetical order
    expect(html.indexOf('ZZZ')).toBeLessThan(html.indexOf('AAA'));
  });

  it('subject omits the in-play count when none are flagged', () => {
    const s = svc();
    s.add({ ticker: 'AAA' });
    expect(s.buildEmailReport().subject).not.toContain('in play');
  });
});
