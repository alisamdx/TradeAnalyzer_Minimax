// Roll the Dice — the gates are the whole feature, so each one gets a test that proves it
// REJECTS, not merely that a happy path passes. A filter that silently stops filtering is
// indistinguishable from one that works, right up until it recommends something it shouldn't.

import { describe, it, expect } from 'vitest';
import {
  rollTheDice, DEFAULT_MAX_CAPITAL, DEFAULT_STRETCH_CAPITAL,
  type DicePickInput, type ConvictionBands,
} from '../src/main/services/roll-the-dice.js';

const TODAY = '2026-09-02';
const EXPIRY = '2026-09-25';

function pick(over: Partial<DicePickInput> & { ticker: string }, strike = 140): DicePickInput {
  return {
    compositeScore: 80,
    rank: 1,
    price: 150,
    aiRationale: 'quality name',
    criticVerdict: { verdict: 'pass', confidence: 'high', rationale: 'clean', degraded: false },
    strategyLabResult: {
      scores: [{
        slug: 'short-naked-put',
        grade: 'A',
        liquidityScore: 12,
        setup: {
          expiration: EXPIRY,
          dte: 23,
          legs: [{ action: 'sell', side: 'put', strike, mid: 3.5, qty: 1 }],
          netCredit: 350,
          maxLoss: -13650,
          breakevens: [strike - 3.5],
          annualizedReturn: 39.7,
          popEstimate: 72,
          unavailableReason: null,
        },
      }],
    },
    ...over,
  };
}

/** Every ticker present with a next-report date safely AFTER the test expiry.
 *  `earnings_calendar.report_date` is NOT NULL, so "clear" is a far date, never a null. */
function clear(...tickers: string[]): Map<string, string> {
  return new Map(tickers.map(t => [t, '2026-12-31']));
}

/** No conviction list — the stretch tier is unavailable. */
const NO_CONV = new Map<string, ConvictionBands>();

function bands(ticker: string, priceHigh: number | null): Map<string, ConvictionBands> {
  return new Map([[ticker, { priceLow: null, priceMid: null, priceHigh }]]);
}

describe('rollTheDice', () => {
  it('returns the highest composite score among eligible picks, with the runner-up named', () => {
    const r = rollTheDice(
      [pick({ ticker: 'AAA', compositeScore: 71 }),
       pick({ ticker: 'BBB', compositeScore: 88 }),
       pick({ ticker: 'CCC', compositeScore: 79 })],
      clear('AAA', 'BBB', 'CCC'), NO_CONV, TODAY, TODAY,
    );
    expect(r.pick?.ticker).toBe('BBB');
    expect(r.runnerUp?.ticker).toBe('CCC');
    expect(r.pick?.tier).toBe('base');
  });

  it('rejects a critic caution AND a flag — only an outright pass qualifies', () => {
    const r = rollTheDice(
      [pick({ ticker: 'CAU', criticVerdict: { verdict: 'caution', rationale: 'x', degraded: false } }),
       pick({ ticker: 'FLG', criticVerdict: { verdict: 'flag', rationale: 'y', degraded: false } })],
      clear('CAU', 'FLG'), NO_CONV, TODAY, TODAY,
    );
    expect(r.pick).toBeNull();
    expect(r.rejections.map(x => x.reason)).toEqual(['critic caution', 'critic flag']);
  });

  // The subtle one: verdict is 'pass' but the LLM critic never ran, so nothing adversarial
  // reviewed it. Fail closed, exactly as the v2 entry gate does.
  it('rejects a DEGRADED pass — un-vetted is not an all-clear', () => {
    const r = rollTheDice(
      [pick({ ticker: 'DEG', criticVerdict: { verdict: 'pass', rationale: 'rule-based', degraded: true } })],
      clear('DEG'), NO_CONV, TODAY, TODAY,
    );
    expect(r.pick).toBeNull();
    expect(r.rejections[0]?.reason).toContain('degraded');
  });

  // ── Capital, not share price ───────────────────────────────────────────────
  // Share price is a lossy proxy: a dear stock struck low can commit less than a cheap one
  // struck near the money. The gate is on what is actually tied up.
  it('gates on capital committed, not on share price', () => {
    // $310 stock, $290 strike -> $29,000. Passes, though the old price gate would have refused.
    const dear = rollTheDice([pick({ ticker: 'DEAR', price: 310 }, 290)], clear('DEAR'), NO_CONV, TODAY, TODAY);
    expect(dear.pick?.ticker).toBe('DEAR');
    expect(dear.pick?.capitalRequired).toBe(29_000);

    // $299 stock, $295 strike -> $29,500. Also passes, and costs MORE than the dear one.
    const cheap = rollTheDice([pick({ ticker: 'CHP', price: 299 }, 295)], clear('CHP'), NO_CONV, TODAY, TODAY);
    expect(cheap.pick?.capitalRequired).toBe(29_500);
  });

  it('rejects a position over the capital limit when no exception applies', () => {
    const r = rollTheDice([pick({ ticker: 'BIG', price: 400 }, 380)], clear('BIG'), NO_CONV, TODAY, TODAY);
    expect(r.pick).toBeNull();
    expect(r.rejections[0]?.reason).toContain('$38,000 over $30,000');
    expect(r.rejections[0]?.reason).toContain('not on your conviction list');
  });

  // ── The exception tier ─────────────────────────────────────────────────────
  it('allows an exception only when every higher bar is cleared', () => {
    const p = [pick({ ticker: 'AMD', price: 500, compositeScore: 73.8 }, 470)];
    const r = rollTheDice(p, clear('AMD'), bands('AMD', 554), TODAY, TODAY);
    expect(r.pick?.ticker).toBe('AMD');
    expect(r.pick?.tier).toBe('stretch');
    expect(r.pick?.capitalRequired).toBe(47_000);
    expect(r.pick?.stretchReason).toContain('never-above');
  });

  it('refuses the exception when the strike breaches the never-above band', () => {
    const r = rollTheDice(
      [pick({ ticker: 'AMD', price: 500, compositeScore: 73.8 }, 470)],
      clear('AMD'), bands('AMD', 400), TODAY, TODAY,
    );
    expect(r.pick).toBeNull();
    expect(r.rejections[0]?.reason).toContain('above your $400 never-above line');
  });

  // Calibrated against 62 stored briefs: eligible composites ran 58.9-76.0, median 65.9. An
  // ordinary-quality setup must not buy its way past the size limit.
  it('refuses the exception on an ordinary score or thin liquidity', () => {
    const lowScore = rollTheDice(
      [pick({ ticker: 'AMD', price: 500, compositeScore: 66 }, 470)],
      clear('AMD'), bands('AMD', 554), TODAY, TODAY,
    );
    expect(lowScore.pick).toBeNull();
    expect(lowScore.rejections[0]?.reason).toContain('under the 70 exception bar');

    const thin = pick({ ticker: 'AMD', price: 500, compositeScore: 73.8 }, 470);
    thin.strategyLabResult!.scores![0]!.liquidityScore = 9;   // clears base 8, misses stretch 11
    const r = rollTheDice([thin], clear('AMD'), bands('AMD', 554), TODAY, TODAY);
    expect(r.pick).toBeNull();
    expect(r.rejections[0]?.reason).toContain('under the 11 exception bar');
  });

  it('caps the exception — an unbounded exception is not an exception', () => {
    const r = rollTheDice(
      [pick({ ticker: 'SPY', price: 700, compositeScore: 90 }, 600)],   // $60,000
      clear('SPY'), bands('SPY', 900), TODAY, TODAY,
    );
    expect(r.pick).toBeNull();
    expect(r.rejections[0]?.reason).toContain('exception ceiling');
  });

  it('refuses the exception for a conviction name with no never-above band set', () => {
    const r = rollTheDice(
      [pick({ ticker: 'VOO', price: 500, compositeScore: 90 }, 400)],
      clear('VOO'), bands('VOO', null), TODAY, TODAY,
    );
    expect(r.pick).toBeNull();
    expect(r.rejections[0]?.reason).toContain('no "never above" band');
  });

  // ── Earnings ───────────────────────────────────────────────────────────────
  // The bug this session opened with: a -20 penalty still leaves a high scorer on top, so for a
  // pick meant to be taken unread the earnings gate has to be an exclusion.
  it('rejects earnings landing on or before expiry, and allows earnings after it', () => {
    const p = [pick({ ticker: 'ERN' })];
    expect(rollTheDice(p, new Map([['ERN', '2026-09-15']]), NO_CONV, TODAY, TODAY).pick).toBeNull();
    expect(rollTheDice(p, new Map([['ERN', EXPIRY]]), NO_CONV, TODAY, TODAY).pick).toBeNull();
    expect(rollTheDice(p, new Map([['ERN', '2026-10-20']]), NO_CONV, TODAY, TODAY).pick?.ticker).toBe('ERN');
  });

  it('rejects an UNKNOWN earnings date — absent from the calendar is not "clear"', () => {
    const r = rollTheDice([pick({ ticker: 'UNK' })], new Map(), NO_CONV, TODAY, TODAY);
    expect(r.pick).toBeNull();
    expect(r.rejections[0]?.reason).toContain('unknown');
  });

  // 57 of 1,069 calendar rows were stale like this when measured. A past date means the row
  // was never refreshed after that report, so the NEXT date is unknown -- fail closed.
  it('rejects a STALE past earnings date rather than reading it as clear', () => {
    const r = rollTheDice([pick({ ticker: 'OLD' })], new Map([['OLD', '2026-08-01']]), NO_CONV, TODAY, TODAY);
    expect(r.pick).toBeNull();
    expect(r.rejections[0]?.reason).toContain('stale');
  });

  it('rejects an illiquid chain at the same bar the critic and v2 engine use', () => {
    const p = pick({ ticker: 'ILQ' });
    p.strategyLabResult!.scores![0]!.liquidityScore = 5;
    const r = rollTheDice([p], clear('ILQ'), NO_CONV, TODAY, TODAY);
    expect(r.pick).toBeNull();
    expect(r.rejections[0]?.reason).toContain('illiquid');
  });

  it('rejects an unavailable or missing CSP, and a non-positive credit', () => {
    const noSetup = pick({ ticker: 'NOS' });
    noSetup.strategyLabResult!.scores![0]!.setup!.unavailableReason = 'no chain';
    expect(rollTheDice([noSetup], clear('NOS'), NO_CONV, TODAY, TODAY).pick).toBeNull();

    const wrongSlug = pick({ ticker: 'WSL' });
    wrongSlug.strategyLabResult!.scores![0]!.slug = 'covered-call';
    expect(rollTheDice([wrongSlug], clear('WSL'), NO_CONV, TODAY, TODAY).pick).toBeNull();

    const noCredit = pick({ ticker: 'NCR' });
    noCredit.strategyLabResult!.scores![0]!.setup!.netCredit = 0;
    expect(rollTheDice([noCredit], clear('NCR'), NO_CONV, TODAY, TODAY).pick).toBeNull();
  });

  it('explains a no-pick day with the most common rejection reason', () => {
    const r = rollTheDice(
      [pick({ ticker: 'A', criticVerdict: { verdict: 'caution', rationale: null } }),
       pick({ ticker: 'B', criticVerdict: { verdict: 'caution', rationale: null } }),
       pick({ ticker: 'C', price: 900 }, 880)],
      clear('A', 'B', 'C'), NO_CONV, TODAY, TODAY,
    );
    expect(r.pick).toBeNull();
    expect(r.considered).toBe(3);
    expect(r.noPickReason).toContain('No dice today');
    expect(r.noPickReason).toContain('critic caution');
  });

  it('handles an empty wheel bucket without pretending it filtered anything', () => {
    const r = rollTheDice([], new Map(), NO_CONV, TODAY, TODAY);
    expect(r.pick).toBeNull();
    expect(r.considered).toBe(0);
    expect(r.noPickReason).toBe('No wheel picks in the latest brief.');
  });

  it('computes capital, cost basis and discount from the short put', () => {
    const r = rollTheDice([pick({ ticker: 'MTH', price: 150 })], clear('MTH'), NO_CONV, TODAY, TODAY);
    expect(r.pick?.strike).toBe(140);
    expect(r.pick?.capitalRequired).toBe(14_000);          // 140 × 100
    expect(r.pick?.effectiveCostBasis).toBeCloseTo(136.5); // 140 − 3.50
    expect(r.pick?.discountToSpotPct).toBeCloseTo(9.0, 1); // (150 − 136.5) / 150
    expect(r.pick?.creditTotal).toBe(350);
  });

  it('warns when the brief is stale but still returns the pick', () => {
    const fresh = rollTheDice([pick({ ticker: 'F' })], clear('F'), NO_CONV, TODAY, TODAY);
    expect(fresh.staleWarning).toBeNull();

    const old = rollTheDice([pick({ ticker: 'S' })], clear('S'), NO_CONV, TODAY, '2026-08-26');
    expect(old.briefAgeDays).toBe(7);
    expect(old.staleWarning).toContain('7 days old');
    expect(old.pick?.ticker).toBe('S');   // surfaced, not suppressed
  });

  it('defaults the limits to $30k normal and $50k exception', () => {
    expect(DEFAULT_MAX_CAPITAL).toBe(30_000);
    expect(DEFAULT_STRETCH_CAPITAL).toBe(50_000);
  });
});
