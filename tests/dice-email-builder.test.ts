// The subject line is the part most likely to be read — on a phone, without opening anything —
// so it gets as much test weight as the body.

import { describe, it, expect } from 'vitest';
import { buildDiceEmailHtml, diceEmailSubject } from '../src/main/services/dice-email-builder.js';
import type { DiceResult } from '../src/main/services/roll-the-dice.js';

const WITH_PICK: DiceResult = {
  pick: {
    ticker: 'MKC', price: 52.85, compositeScore: 61.6, briefRank: 1,
    strike: 50, expiration: '2026-09-25', dte: 23,
    premiumPerShare: 0.95, creditTotal: 95, capitalRequired: 5000,
    effectiveCostBasis: 49.05, discountToSpotPct: 7.19,
    annualizedReturn: 30.1, popEstimate: 74, liquidityScore: 11, grade: 'A',
    criticRationale: 'Defensive staple, IV rank elevated without an event driving it.',
    aiRationale: 'quality name',
    fit: {
      withinCapital: true, maxCapital: 30_000,
      conviction: { priceHigh: 58, strikeWithinBand: true },
      ownership: { costBasis: 49.05, sma200: 51.0, basisVsSma200Pct: -3.82,
                   atOrBelowSma200: true, rangePctile: 41.2, hi52: 58.0, lo52: 42.0,
                   strike: 50, swingLow20: 51.2, strikeBelowSwing: true },
    },
  },
  withinBudget: null,
  noPickReason: null,
  briefDate: '2026-09-02',
  briefAgeDays: 0,
  staleWarning: null,
  considered: 5,
  rejections: [{ ticker: 'NVDA', reason: 'critic caution' }],
  runnerUp: { ticker: 'JNJ', compositeScore: 58.9 },
};

const NO_PICK: DiceResult = {
  pick: null,
  withinBudget: null,
  noPickReason: 'No dice today — 4 wheel picks considered, none cleared every gate (most common: critic caution, 3).',
  briefDate: '2026-09-02',
  briefAgeDays: 0,
  staleWarning: null,
  considered: 4,
  rejections: [{ ticker: 'AAPL', reason: 'critic caution' }],
  runnerUp: null,
};

describe('diceEmailSubject', () => {
  // Actionable from a lock screen: ticker, strike, expiry and credit all in the subject.
  it('carries the whole trade', () => {
    const s = diceEmailSubject(WITH_PICK);
    expect(s).toContain('MKC');
    expect(s).toContain('$50 put');
    expect(s).toContain('Sep 25');
    expect(s).toContain('$95');
  });

  it('says plainly when there is nothing, with the count', () => {
    const s = diceEmailSubject(NO_PICK);
    expect(s).toContain('No dice today');
    expect(s).toContain('4 considered');
  });
});

describe('buildDiceEmailHtml', () => {
  it('leads with the order to place', () => {
    const h = buildDiceEmailHtml(WITH_PICK, 'Tue, Sep 2');
    // The ticker inside the headline is an E*Trade quote link, so the sentence is split by markup
    // — assert its parts and the anchor rather than the flat string.
    expect(h).toContain('Sell 1 <a href="https://us.etrade.com/e/t/invest/quotesandresearch?sym=mkc"');
    expect(h).toContain('>MKC</a> $50 put');
    expect(h).toContain('The order');
  });

  it('shows the three numbers that decide a wheel entry', () => {
    const h = buildDiceEmailHtml(WITH_PICK, 'Tue, Sep 2');
    expect(h).toContain('You collect');
    expect(h).toContain('$95');
    expect(h).toContain('Cash required');
    expect(h).toContain('$5,000');
    expect(h).toContain('If assigned, you own it at');
    expect(h).toContain('$49.05');
    expect(h).toContain('7.2% below');
  });

  it('states the downside in plain language with real numbers', () => {
    const h = buildDiceEmailHtml(WITH_PICK, 'Tue, Sep 2');
    expect(h).toContain('The risk, plainly');
    expect(h).toContain('buy 100 shares at $50');
    expect(h).toContain('$49.05');
  });

  it('lists the gates it passed and the runner-up', () => {
    const h = buildDiceEmailHtml(WITH_PICK, 'Tue, Sep 2');
    expect(h).toContain('Passed every gate');
    expect(h).toContain('no earnings before expiry');
    expect(h).toContain('JNJ');
  });

  // Silence cannot be told apart from a failed job or broken SMTP, so a no-pick day still sends.
  it('renders a no-pick day as a normal outcome, not an error', () => {
    const h = buildDiceEmailHtml(NO_PICK, 'Tue, Sep 2');
    expect(h).toContain('No dice today');
    // The reassurance must name what a blank day is NOT about: size and conviction stopped
    // removing anything in v1.1.168, so a silent day can only mean the trades themselves failed.
    expect(h).toContain('no longer remove anything');
    expect(h).not.toContain('The order');
  });

  it('surfaces a staleness warning when the brief is old', () => {
    const h = buildDiceEmailHtml({ ...WITH_PICK, staleWarning: 'This brief is 4 days old — re-run the batch.' }, 'Tue, Sep 2');
    expect(h).toContain('4 days old');
  });

  it('always carries the not-advice note', () => {
    for (const r of [WITH_PICK, NO_PICK]) {
      expect(buildDiceEmailHtml(r, 'Tue, Sep 2')).toContain('Not investment advice');
    }
  });

  // A critic rationale is model output; it reaches an HTML email and must not be able to inject.
  it('escapes untrusted text', () => {
    const h = buildDiceEmailHtml(
      { ...WITH_PICK, pick: { ...WITH_PICK.pick!, criticRationale: '<script>alert(1)</script>' } },
      'Tue, Sep 2',
    );
    expect(h).not.toContain('<script>');
    expect(h).toContain('&lt;script&gt;');
  });

  // An over-budget pick is not an exception being granted — capital stopped gating in v1.1.168 —
  // so the banner states the number and hands the decision over rather than justifying itself.
  it('leads with the size when the pick is over the usual line, without calling it a rejection', () => {
    const h = buildDiceEmailHtml({
      ...WITH_PICK,
      pick: { ...WITH_PICK.pick!, capitalRequired: 47_000,
              fit: { ...WITH_PICK.pick!.fit, withinCapital: false } },
    }, 'Tue, Sep 2');
    expect(h).toContain('TIES UP $47,000');
    expect(h).toContain('ABOVE YOUR USUAL $30,000');
    expect(h).toContain('Not a rejection');
    // and it comes BEFORE the order, not as a footnote after it
    expect(h.indexOf('TIES UP')).toBeLessThan(h.indexOf('The order'));
  });

  it('shows no size banner on a pick that fits', () => {
    expect(buildDiceEmailHtml(WITH_PICK, 'Tue, Sep 2')).not.toContain('TIES UP');
  });

  // The other half of demoting the capital gate: an unfundable pick must never leave the day
  // with nothing actionable in it.
  it('offers the within-budget alternative after the order when the pick is over the line', () => {
    const h = buildDiceEmailHtml({
      ...WITH_PICK,
      pick: { ...WITH_PICK.pick!, capitalRequired: 47_000,
              fit: { ...WITH_PICK.pick!.fit, withinCapital: false } },
      withinBudget: { ...WITH_PICK.pick!, ticker: 'JNJ', strike: 150, capitalRequired: 15_000 },
    }, 'Tue, Sep 2');
    expect(h).toContain('Within your usual size');
    expect(h).toContain('Sell 1 JNJ $150 put');
    expect(h).toContain('$15,000 cash');
    expect(h).toContain('The best one that fits your usual size is at the bottom.');
    expect(h.indexOf('Within your usual size')).toBeGreaterThan(h.indexOf('The order'));
  });

  // Conviction membership stopped gating the pick, so the email is now the ONLY place the
  // own-at-strike question gets asked. All four states must be distinguishable.
  it('states the conviction position in words, including when the ticker is not listed', () => {
    const off = buildDiceEmailHtml(
      { ...WITH_PICK, pick: { ...WITH_PICK.pick!, fit: { ...WITH_PICK.pick!.fit, conviction: null } } },
      'Tue, Sep 2');
    expect(off).toContain('Not on your conviction list');
    expect(off).toContain('live question');

    const inside = buildDiceEmailHtml(WITH_PICK, 'Tue, Sep 2');
    expect(inside).toContain('inside your $58 never-above line');

    const breach = buildDiceEmailHtml({
      ...WITH_PICK,
      pick: { ...WITH_PICK.pick!, fit: { ...WITH_PICK.pick!.fit,
              conviction: { priceHigh: 45, strikeWithinBand: false } } },
    }, 'Tue, Sep 2');
    expect(breach).toContain('ABOVE your $45');
    expect(breach).toContain('a price you already ruled out');

    const noBand = buildDiceEmailHtml({
      ...WITH_PICK,
      pick: { ...WITH_PICK.pick!, fit: { ...WITH_PICK.pick!.fit,
              conviction: { priceHigh: null, strikeWithinBand: null } } },
    }, 'Tue, Sep 2');
    expect(noBand).toContain('band is set for MKC');   // quotes arrive HTML-escaped
  });

  // The own-at-strike read replaces a conviction check that fired on 0 of 39 picks, so it must
  // LEAD and the band must not read as an all-clear beside it.
  it('leads the ownership question with the cost-basis read, band as secondary context', () => {
    const h = buildDiceEmailHtml(WITH_PICK, 'Tue, Sep 2');
    expect(h).toContain('If assigned you own MKC at $49.05');
    expect(h).toContain('3.8% BELOW its 200-day average');
    expect(h).toContain('41st percentile');
    expect(h.indexOf('If assigned you own MKC')).toBeLessThan(h.indexOf('conviction list'));
  });

  it('warns in words when the cost basis is above the long-run average', () => {
    const h = buildDiceEmailHtml({
      ...WITH_PICK,
      pick: { ...WITH_PICK.pick!, fit: { ...WITH_PICK.pick!.fit,
        ownership: { costBasis: 49.05, sma200: 44.0, basisVsSma200Pct: 11.48,
                     atOrBelowSma200: false, rangePctile: 88.0, hi52: 52.0, lo52: 40.0,
                     // Cell D: both axes unfavourable, so the "extended price" clause stands.
                     strike: 50, swingLow20: 48.0, strikeBelowSwing: false } } },
    }, 'Tue, Sep 2');
    expect(h).toContain('ABOVE its 200-day average');
    expect(h).toContain('An extended price with no recent floor under it.');
  });

  it('says so plainly when there is not enough history, rather than implying a pass', () => {
    const h = buildDiceEmailHtml(
      { ...WITH_PICK, pick: { ...WITH_PICK.pick!, fit: { ...WITH_PICK.pick!.fit, ownership: null } } },
      'Tue, Sep 2');
    expect(h).toContain('Not enough price history for MKC');
  });

  // Regression: the gate list must not restate size or conviction as bars the trade cleared.
  it('does not claim the price was checked against a limit', () => {
    const h = buildDiceEmailHtml(WITH_PICK, 'Tue, Sep 2');
    expect(h).toContain('Passed every gate:');
    expect(h).not.toContain('within limit');
  });

  // Both E*Trade pages, because they answer different questions: the quote page is "what is it
  // doing now", the chain is "what is this strike actually bid". The casing differs per page and
  // the `&` in the options URL must be escaped for the href to survive an HTML parser.
  it('links the pick to both E*Trade pages', () => {
    const h = buildDiceEmailHtml(WITH_PICK, 'Tue, Sep 2');
    expect(h).toContain('https://us.etrade.com/e/t/invest/quotesandresearch?sym=mkc');
    expect(h).toContain('https://us.etrade.com/e/t/invest/quotesandresearch?content=3&amp;sym=mkc');
    expect(h).not.toContain('content=3&sym=');   // a bare & in an href is invalid HTML
    // The logged-in quote page loses its symbol through E*Trade's login redirect (the target is
    // double-encoded, so `?` arrives literal and the page renders "symbol 'NULL'"). An emailed
    // link is clicked cold, which is exactly that case — it must never come back.
    expect(h).not.toContain('etx/mkt/quotes');
  });

  it('links the within-your-size alternative too', () => {
    const h = buildDiceEmailHtml({
      ...WITH_PICK,
      withinBudget: { ...WITH_PICK.pick!, ticker: 'JNJ', strike: 145, capitalRequired: 14_500 },
    }, 'Tue, Sep 2');
    expect(h).toContain('https://us.etrade.com/e/t/invest/quotesandresearch?sym=jnj');
    expect(h).toContain('sym=jnj');
  });

  it('is a single-column card sized for a phone', () => {
    const h = buildDiceEmailHtml(WITH_PICK, 'Tue, Sep 2');
    expect(h).toContain('max-width:560px');
    expect(h).not.toContain('<style>');   // Gmail strips these — everything must be inline
  });
});
