// Roll the Dice — the gates are the whole feature, so each one gets a test that proves it
// REJECTS, not merely that a happy path passes. A filter that silently stops filtering is
// indistinguishable from one that works, right up until it recommends something it shouldn't.

import { describe, it, expect } from 'vitest';
import {
  rollTheDice, DEFAULT_MAX_CAPITAL,
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

/** No conviction list at all — since v1.1.168 that annotates the pick, it never blocks one. */
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
    expect(r.pick?.fit.withinCapital).toBe(true);
    expect(r.withinBudget).toBeNull();   // the pick already fits; nothing to add
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

  // ── Capital: reported, never a gate (v1.1.168) ────────────────────────────
  // Share price was the original gate and it is a lossy proxy: a dear stock struck low commits
  // less than a cheap one struck near the money. Capital replaced it — and then stopped
  // excluding anything at all, because what the operator can fund is their call, not the
  // filter's. These tests exist to prove the gate STAYS gone.
  it('measures capital committed, not share price', () => {
    // $310 stock, $290 strike -> $29,000, under the $30,000 line.
    const dear = rollTheDice([pick({ ticker: 'DEAR', price: 310 }, 290)], clear('DEAR'), NO_CONV, TODAY, TODAY);
    expect(dear.pick?.capitalRequired).toBe(29_000);
    expect(dear.pick?.fit.withinCapital).toBe(true);

    // $299 stock, $295 strike -> $29,500. The cheaper-looking stock costs MORE.
    const cheap = rollTheDice([pick({ ticker: 'CHP', price: 299 }, 295)], clear('CHP'), NO_CONV, TODAY, TODAY);
    expect(cheap.pick?.capitalRequired).toBe(29_500);
  });

  // The regression this release exists for. On 2026-09-03 MPC was refused at $37,000 purely for
  // being absent from a conviction list the operator no longer maintains — its score was never
  // even evaluated. Capital and conviction must now annotate, never remove.
  it('SELECTS an over-budget pick rather than rejecting it, and flags the size', () => {
    const r = rollTheDice([pick({ ticker: 'MPC', price: 400 }, 370)], clear('MPC'), NO_CONV, TODAY, TODAY);
    expect(r.pick?.ticker).toBe('MPC');
    expect(r.pick?.capitalRequired).toBe(37_000);
    expect(r.pick?.fit.withinCapital).toBe(false);
    expect(r.pick?.fit.maxCapital).toBe(30_000);
    expect(r.rejections).toHaveLength(0);          // nothing was removed for size
    expect(r.withinBudget).toBeNull();             // and nothing smaller was available
  });

  it('never rejects for absence from the conviction list, however large the position', () => {
    const r = rollTheDice([pick({ ticker: 'BIG', price: 900 }, 880)], clear('BIG'), NO_CONV, TODAY, TODAY);
    expect(r.pick?.ticker).toBe('BIG');            // $88,000 — no ceiling exists any more
    expect(r.pick?.fit.conviction).toBeNull();
    expect(r.rejections).toHaveLength(0);
  });

  // ── The within-budget alternative ──────────────────────────────────────────
  // Demoting the capital gate must not cost the operator an actionable day: when the merit pick
  // is unfundable they still get the best one that fits, and choose between them.
  it('names the best within-budget candidate when the merit pick is over the line', () => {
    const r = rollTheDice(
      [pick({ ticker: 'BIG', price: 400, compositeScore: 88 }, 370),   // $37,000
       pick({ ticker: 'MID', price: 200, compositeScore: 71 }, 190),   // $19,000
       pick({ ticker: 'LOW', price: 150, compositeScore: 64 }, 140)],  // $14,000
      clear('BIG', 'MID', 'LOW'), NO_CONV, TODAY, TODAY,
    );
    expect(r.pick?.ticker).toBe('BIG');
    // Highest-scoring FITTING candidate, not merely the cheapest one.
    expect(r.withinBudget?.ticker).toBe('MID');
    expect(r.withinBudget?.capitalRequired).toBe(19_000);
    expect(r.withinBudget?.fit.withinCapital).toBe(true);
  });

  it('offers no alternative when the pick already fits, or when nothing else does', () => {
    const fits = rollTheDice(
      [pick({ ticker: 'AAA', compositeScore: 80 }), pick({ ticker: 'BBB', compositeScore: 70 })],
      clear('AAA', 'BBB'), NO_CONV, TODAY, TODAY,
    );
    expect(fits.pick?.ticker).toBe('AAA');
    expect(fits.withinBudget).toBeNull();

    const noneFit = rollTheDice(
      [pick({ ticker: 'BIG', price: 400, compositeScore: 88 }, 370),
       pick({ ticker: 'ALSO', price: 400, compositeScore: 75 }, 350)],
      clear('BIG', 'ALSO'), NO_CONV, TODAY, TODAY,
    );
    expect(noneFit.pick?.ticker).toBe('BIG');
    expect(noneFit.withinBudget).toBeNull();
  });

  it('honours a caller-supplied capital line for the split, still without excluding', () => {
    const picks = [pick({ ticker: 'BIG', price: 400, compositeScore: 88 }, 370),
                   pick({ ticker: 'MID', price: 200, compositeScore: 71 }, 190)];
    const r = rollTheDice(picks, clear('BIG', 'MID'), NO_CONV, TODAY, TODAY, 40_000);
    expect(r.pick?.ticker).toBe('BIG');
    expect(r.pick?.fit.withinCapital).toBe(true);   // $37,000 is under a $40,000 line
    expect(r.withinBudget).toBeNull();
  });

  // ── Conviction: reported in four distinct states, gating in none ───────────
  it('reports conviction state without ever acting on it', () => {
    const p = (t: string) => [pick({ ticker: t, price: 500, compositeScore: 73.8 }, 470)];

    const absent = rollTheDice(p('AMD'), clear('AMD'), NO_CONV, TODAY, TODAY);
    expect(absent.pick?.ticker).toBe('AMD');
    expect(absent.pick?.fit.conviction).toBeNull();

    const inside = rollTheDice(p('AMD'), clear('AMD'), bands('AMD', 554), TODAY, TODAY);
    expect(inside.pick?.fit.conviction).toEqual({ priceHigh: 554, strikeWithinBand: true });

    // The strike breaches the operator's own never-above line. Still picked — still LOUD.
    const breach = rollTheDice(p('AMD'), clear('AMD'), bands('AMD', 400), TODAY, TODAY);
    expect(breach.pick?.ticker).toBe('AMD');
    expect(breach.pick?.fit.conviction).toEqual({ priceHigh: 400, strikeWithinBand: false });

    // Listed but no band set — there is nothing to check against, which is not a pass.
    const noBand = rollTheDice(p('AMD'), clear('AMD'), bands('AMD', null), TODAY, TODAY);
    expect(noBand.pick?.fit.conviction).toEqual({ priceHigh: null, strikeWithinBand: null });
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
       // C is a flag, not an oversized position — size stopped rejecting anything in v1.1.168.
       pick({ ticker: 'C', criticVerdict: { verdict: 'flag', rationale: null } })],
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

  it('defaults the budget line to $30k — a reporting split, not a ceiling', () => {
    expect(DEFAULT_MAX_CAPITAL).toBe(30_000);
  });
});
