// Roll the Dice — the gates are the whole feature, so each one gets a test that proves it
// REJECTS, not merely that a happy path passes. A filter that silently stops filtering is
// indistinguishable from one that works, right up until it recommends something it shouldn't.

import { describe, it, expect } from 'vitest';
import {
  rollTheDice, DEFAULT_MAX_PRICE,
  type DicePickInput,
} from '../src/main/services/roll-the-dice.js';

const TODAY = '2026-09-02';
const EXPIRY = '2026-09-25';

function pick(over: Partial<DicePickInput> & { ticker: string }): DicePickInput {
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
          legs: [{ action: 'sell', side: 'put', strike: 140, mid: 3.5, qty: 1 }],
          netCredit: 350,
          maxLoss: -13650,
          breakevens: [136.5],
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

describe('rollTheDice', () => {
  it('returns the highest composite score among eligible picks, with the runner-up named', () => {
    const r = rollTheDice(
      [pick({ ticker: 'AAA', compositeScore: 71 }),
       pick({ ticker: 'BBB', compositeScore: 88 }),
       pick({ ticker: 'CCC', compositeScore: 79 })],
      clear('AAA', 'BBB', 'CCC'), TODAY, TODAY,
    );
    expect(r.pick?.ticker).toBe('BBB');
    expect(r.runnerUp?.ticker).toBe('CCC');
    expect(r.noPickReason).toBeNull();
  });

  it('rejects a critic caution AND a flag — only an outright pass qualifies', () => {
    const r = rollTheDice(
      [pick({ ticker: 'CAU', criticVerdict: { verdict: 'caution', rationale: 'x', degraded: false } }),
       pick({ ticker: 'FLG', criticVerdict: { verdict: 'flag', rationale: 'y', degraded: false } })],
      clear('CAU', 'FLG'), TODAY, TODAY,
    );
    expect(r.pick).toBeNull();
    expect(r.rejections.map(x => x.reason)).toEqual(['critic caution', 'critic flag']);
  });

  // The subtle one: verdict is 'pass' but the LLM critic never ran, so nothing adversarial
  // reviewed it. Fail closed, exactly as the v2 entry gate does.
  it('rejects a DEGRADED pass — un-vetted is not an all-clear', () => {
    const r = rollTheDice(
      [pick({ ticker: 'DEG', criticVerdict: { verdict: 'pass', rationale: 'rule-based', degraded: true } })],
      clear('DEG'), TODAY, TODAY,
    );
    expect(r.pick).toBeNull();
    expect(r.rejections[0]?.reason).toContain('degraded');
  });

  it('enforces the share-price ceiling and honours an override', () => {
    const picks = [pick({ ticker: 'RICH', price: 420 })];
    expect(rollTheDice(picks, clear('RICH'), TODAY, TODAY).pick).toBeNull();
    expect(rollTheDice(picks, clear('RICH'), TODAY, TODAY, 500).pick?.ticker).toBe('RICH');
  });

  // The bug this session opened with: a -20 penalty still leaves a high scorer on top, so for a
  // pick meant to be taken unread the earnings gate has to be an exclusion.
  it('rejects earnings landing on or before expiry, and allows earnings after it', () => {
    const p = [pick({ ticker: 'ERN' })];
    expect(rollTheDice(p, new Map([['ERN', '2026-09-15']]), TODAY, TODAY).pick).toBeNull();
    expect(rollTheDice(p, new Map([['ERN', EXPIRY]]), TODAY, TODAY).pick).toBeNull();
    expect(rollTheDice(p, new Map([['ERN', '2026-10-20']]), TODAY, TODAY).pick?.ticker).toBe('ERN');
  });

  it('rejects an UNKNOWN earnings date — absent from the calendar is not "clear"', () => {
    const r = rollTheDice([pick({ ticker: 'UNK' })], new Map(), TODAY, TODAY);
    expect(r.pick).toBeNull();
    expect(r.rejections[0]?.reason).toContain('unknown');
  });

  // 57 of 1,069 calendar rows were stale like this when measured. A past date means the row
  // was never refreshed after that report, so the NEXT date is unknown -- fail closed.
  it('rejects a STALE past earnings date rather than reading it as clear', () => {
    const r = rollTheDice([pick({ ticker: 'OLD' })], new Map([['OLD', '2026-08-01']]), TODAY, TODAY);
    expect(r.pick).toBeNull();
    expect(r.rejections[0]?.reason).toContain('stale');
  });

  it('rejects an illiquid chain at the same bar the critic and v2 engine use', () => {
    const p = pick({ ticker: 'ILQ' });
    p.strategyLabResult!.scores![0]!.liquidityScore = 5;
    const r = rollTheDice([p], clear('ILQ'), TODAY, TODAY);
    expect(r.pick).toBeNull();
    expect(r.rejections[0]?.reason).toContain('illiquid');
  });

  it('rejects an unavailable or missing CSP, and a non-positive credit', () => {
    const noSetup = pick({ ticker: 'NOS' });
    noSetup.strategyLabResult!.scores![0]!.setup!.unavailableReason = 'no chain';
    expect(rollTheDice([noSetup], clear('NOS'), TODAY, TODAY).pick).toBeNull();

    const wrongSlug = pick({ ticker: 'WSL' });
    wrongSlug.strategyLabResult!.scores![0]!.slug = 'covered-call';
    expect(rollTheDice([wrongSlug], clear('WSL'), TODAY, TODAY).pick).toBeNull();

    const noCredit = pick({ ticker: 'NCR' });
    noCredit.strategyLabResult!.scores![0]!.setup!.netCredit = 0;
    expect(rollTheDice([noCredit], clear('NCR'), TODAY, TODAY).pick).toBeNull();
  });

  it('explains a no-pick day with the most common rejection reason', () => {
    const r = rollTheDice(
      [pick({ ticker: 'A', criticVerdict: { verdict: 'caution', rationale: null } }),
       pick({ ticker: 'B', criticVerdict: { verdict: 'caution', rationale: null } }),
       pick({ ticker: 'C', price: 900 })],
      clear('A', 'B', 'C'), TODAY, TODAY,
    );
    expect(r.pick).toBeNull();
    expect(r.considered).toBe(3);
    expect(r.noPickReason).toContain('No dice today');
    expect(r.noPickReason).toContain('critic caution');
  });

  it('handles an empty wheel bucket without pretending it filtered anything', () => {
    const r = rollTheDice([], new Map(), TODAY, TODAY);
    expect(r.pick).toBeNull();
    expect(r.considered).toBe(0);
    expect(r.noPickReason).toBe('No wheel picks in the latest brief.');
  });

  it('computes capital, cost basis and discount from the short put', () => {
    const r = rollTheDice([pick({ ticker: 'MTH', price: 150 })], clear('MTH'), TODAY, TODAY);
    expect(r.pick?.strike).toBe(140);
    expect(r.pick?.capitalRequired).toBe(14_000);          // 140 × 100
    expect(r.pick?.effectiveCostBasis).toBeCloseTo(136.5); // 140 − 3.50
    expect(r.pick?.discountToSpotPct).toBeCloseTo(9.0, 1); // (150 − 136.5) / 150
    expect(r.pick?.creditTotal).toBe(350);
  });

  it('warns when the brief is stale but still returns the pick', () => {
    const fresh = rollTheDice([pick({ ticker: 'F' })], clear('F'), TODAY, TODAY);
    expect(fresh.staleWarning).toBeNull();
    expect(fresh.briefAgeDays).toBe(0);

    const old = rollTheDice([pick({ ticker: 'S' })], clear('S'), TODAY, '2026-08-26');
    expect(old.briefAgeDays).toBe(7);
    expect(old.staleWarning).toContain('7 days old');
    expect(old.pick?.ticker).toBe('S');   // surfaced, not suppressed
  });

  it('defaults the price ceiling to $300', () => {
    expect(DEFAULT_MAX_PRICE).toBe(300);
    expect(rollTheDice([pick({ ticker: 'X', price: 301 })], clear('X'), TODAY, TODAY).pick).toBeNull();
    expect(rollTheDice([pick({ ticker: 'X', price: 300 })], clear('X'), TODAY, TODAY).pick?.ticker).toBe('X');
  });
});
