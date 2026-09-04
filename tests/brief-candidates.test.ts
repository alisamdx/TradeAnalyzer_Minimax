// Regression tests for Stage-4 candidate capture (v1.1.175).
//
// This table exists because the losers are the data a selection study needs, and the brief threw
// them away — it persists only the top PICKS_PER_STRATEGY of a STAGE4_POOL_SIZE pool, so the cut
// from 15 to 5 has never been measurable. These tests lock in the two properties that make the
// capture trustworthy: a re-run REPLACES rather than duplicates (the batch runs twice a trading
// day and the after-close slot must overwrite the morning), and a failure here can never break
// the brief that produces the actual recommendations.

import { describe, it, expect } from 'vitest';
import {
  saveBriefCandidates, pruneBriefCandidates,
  type BriefCandidateRow,
} from '../src/main/services/brief-candidates.js';
import { openDatabase, type DbHandle } from '../src/main/db/connection.js';
import { runMigrations } from '../src/main/db/migrations.js';
import { MIGRATIONS_DIR } from './helpers.js';

function db(): DbHandle {
  const d = openDatabase(':memory:');
  runMigrations(d, MIGRATIONS_DIR);
  return d;
}

function row(over: Partial<BriefCandidateRow> & { ticker: string }): BriefCandidateRow {
  return {
    asOfDate: '2026-09-03', generatedAt: '2026-09-03T20:30:00.000Z',
    strategy: 'wheel', compositeScore: 65, rank: 1, disposition: 'picked',
    signalsJson: '{"ivRank":{"raw":82.2,"normalized":82.2,"weight":22,"missing":false}}',
    structureSlug: 'short-naked-put', grade: 'A', strike: 140, premium: 3.5,
    expiration: '2026-10-16', dte: 43, liquidityScore: 11, spot: 150,
    delta: -0.3, legIv: 34.8, bid: 3.4, ask: 3.6, openInterest: 1804,
    netCredit: 350, maxLoss: -13650, annualizedReturn: 39.7, popEstimate: 72, atmIv: 31.2,
    earningsDate: '2026-11-05', daysToEarnings: 63,
    ...over,
  };
}

const count = (d: DbHandle) => (d.prepare('SELECT COUNT(*) n FROM brief_candidates').get() as { n: number }).n;

describe('saveBriefCandidates', () => {
  it('stores survivors and losers alike — the losers are the point', () => {
    const d = db();
    saveBriefCandidates(d, [
      row({ ticker: 'AAA', rank: 1, disposition: 'picked' }),
      row({ ticker: 'BBB', rank: 6, disposition: 'capped_out' }),
      row({ ticker: 'CCC', rank: 9, disposition: 'failed_liquidity' }),
      row({ ticker: 'DDD', rank: 12, disposition: 'not_validated', structureSlug: null, strike: null }),
    ]);
    expect(count(d)).toBe(4);
    const kept = d.prepare(
      `SELECT disposition, COUNT(*) n FROM brief_candidates GROUP BY disposition ORDER BY disposition`,
    ).all() as Array<{ disposition: string; n: number }>;
    expect(kept).toEqual([
      { disposition: 'capped_out', n: 1 },
      { disposition: 'failed_liquidity', n: 1 },
      { disposition: 'not_validated', n: 1 },
      { disposition: 'picked', n: 1 },
    ]);
    d.close();
  });

  // The batch runs twice a trading day and the evening slot must overwrite the morning's partial
  // view — the same rule every other job follows. see CLAUDE.md
  it('REPLACES on a same-day re-run instead of duplicating', () => {
    const d = db();
    saveBriefCandidates(d, [row({ ticker: 'AAA', compositeScore: 60, disposition: 'capped_out' })]);
    saveBriefCandidates(d, [row({ ticker: 'AAA', compositeScore: 71, disposition: 'picked' })]);
    expect(count(d)).toBe(1);
    const r = d.prepare('SELECT composite_score, disposition FROM brief_candidates').get() as
      { composite_score: number; disposition: string };
    expect(r.composite_score).toBe(71);
    expect(r.disposition).toBe('picked');
    d.close();
  });

  it('keeps the same ticker separately per strategy and per date', () => {
    const d = db();
    saveBriefCandidates(d, [
      row({ ticker: 'AAA', strategy: 'wheel' }),
      row({ ticker: 'AAA', strategy: 'income' }),
      row({ ticker: 'AAA', strategy: 'wheel', asOfDate: '2026-09-02' }),
    ]);
    expect(count(d)).toBe(3);
    d.close();
  });

  it('rejects an unknown disposition at the schema level', () => {
    const d = db();
    expect(() => d.prepare(
      `INSERT INTO brief_candidates (as_of_date, generated_at, strategy, ticker, composite_score, rank, disposition)
       VALUES ('2026-09-03','x','wheel','AAA',65,1,'bogus')`).run()).toThrow();
    d.close();
  });

  // Instrumentation must never be able to fail the brief that produces the recommendations.
  it('never throws — a broken table returns 0 rather than propagating', () => {
    const d = db();
    d.prepare('DROP TABLE brief_candidates').run();
    expect(() => saveBriefCandidates(d, [row({ ticker: 'AAA' })])).not.toThrow();
    expect(saveBriefCandidates(d, [row({ ticker: 'AAA' })])).toBe(0);
    expect(() => pruneBriefCandidates(d)).not.toThrow();
    d.close();
  });

  it('is a no-op on an empty batch', () => {
    const d = db();
    expect(saveBriefCandidates(d, [])).toBe(0);
    expect(count(d)).toBe(0);
    d.close();
  });

  // Capture is one-directional — what is not written today cannot be recovered. Three studies in
  // this project were blocked by capture rather than analysis, so the columns that unblock the
  // known follow-ups are asserted explicitly.
  it('captures the signals behind the composite, not just the composite', () => {
    const d = db();
    saveBriefCandidates(d, [row({ ticker: 'AAA' })]);
    const r = d.prepare('SELECT signals_json FROM brief_candidates').get() as { signals_json: string };
    const sig = JSON.parse(r.signals_json);
    // Without this, "the composite selected badly" can never become "THIS signal selected badly".
    expect(sig.ivRank.raw).toBeCloseTo(82.2);
    expect(sig.ivRank.weight).toBe(22);
    d.close();
  });

  it('captures the short-leg option economics that earlier studies lacked', () => {
    const d = db();
    saveBriefCandidates(d, [row({ ticker: 'AAA' })]);
    const r = d.prepare(
      'SELECT delta, bid, ask, open_interest, pop_estimate, annualized_return FROM brief_candidates').get() as
      Record<string, number>;
    // delta: v1.1.171 showed it drives outcomes, so a selection study must control for it.
    expect(r['delta']).toBeCloseTo(-0.3);
    // bid/ask/OI: their absence on wheel rows is what forced the v1.1.170 liquidity A/B onto income.
    expect(r['bid']).toBeCloseTo(3.4);
    expect(r['ask']).toBeCloseTo(3.6);
    expect(r['open_interest']).toBe(1804);
    expect(r['pop_estimate']).toBe(72);
    expect(r['annualized_return']).toBeCloseTo(39.7);
    d.close();
  });

  it('accepts a candidate with no constructible structure — nulls, not a dropped row', () => {
    const d = db();
    saveBriefCandidates(d, [row({
      ticker: 'NOS', disposition: 'not_validated', signalsJson: null, structureSlug: null,
      grade: null, strike: null, premium: null, expiration: null, dte: null, liquidityScore: null,
      delta: null, legIv: null, bid: null, ask: null, openInterest: null,
      netCredit: null, maxLoss: null, annualizedReturn: null, popEstimate: null, atmIv: null,
      earningsDate: null, daysToEarnings: null,
    })]);
    expect(count(d)).toBe(1);
    const r = d.prepare('SELECT composite_score, disposition, strike FROM brief_candidates').get() as
      { composite_score: number; disposition: string; strike: number | null };
    // The composite and rank still matter for a selection study even with no tradeable structure.
    expect(r.composite_score).toBe(65);
    expect(r.disposition).toBe('not_validated');
    expect(r.strike).toBeNull();
    d.close();
  });

  // The earnings gate is the ONE rule in the wheel path no study has ever been able to evaluate:
  // earnings_calendar keeps one row per ticker with no history, so a replay sees today's date
  // rather than the one live on the pick date, and analysis_snapshots.daysToEarnings is null on
  // every row. Capturing it here is the only fix, and it works forward only.
  it('captures the earnings date as known on the pick date', () => {
    const d = db();
    saveBriefCandidates(d, [row({ ticker: 'AAA', earningsDate: '2026-11-05', daysToEarnings: 63, dte: 43 })]);
    const r = d.prepare('SELECT earnings_date, days_to_earnings, dte FROM brief_candidates').get() as
      { earnings_date: string; days_to_earnings: number; dte: number };
    expect(r.earnings_date).toBe('2026-11-05');
    expect(r.days_to_earnings).toBe(63);
    // The gate's actual question: does the report land inside the hold window?
    expect(r.days_to_earnings > r.dte).toBe(true);
  });

  // NULL is not "clear" — it is unknown-or-stale, which roll-the-dice.ts rejects. A study that
  // read it as clear would reproduce exactly the blindness this column exists to remove.
  it('records unknown or stale earnings as NULL, distinct from a known-clear date', () => {
    const d = db();
    saveBriefCandidates(d, [
      row({ ticker: 'KNOWN', earningsDate: '2026-11-05', daysToEarnings: 63 }),
      row({ ticker: 'UNKNOWN', earningsDate: null, daysToEarnings: null }),
    ]);
    const rows = d.prepare(
      'SELECT ticker, earnings_date FROM brief_candidates ORDER BY ticker').all() as
      Array<{ ticker: string; earnings_date: string | null }>;
    expect(rows).toEqual([
      { ticker: 'KNOWN', earnings_date: '2026-11-05' },
      { ticker: 'UNKNOWN', earnings_date: null },
    ]);
    d.close();
  });

  it('stores spot, which a later split repair would otherwise make unrecoverable', () => {
    const d = db();
    saveBriefCandidates(d, [row({ ticker: 'AAA', spot: 150, strike: 140 })]);
    const r = d.prepare('SELECT spot, strike FROM brief_candidates').get() as { spot: number; strike: number };
    // The scale guard compares these two; without `spot` as of the pick date it cannot run.
    expect(r.spot).toBe(150);
    expect(Math.abs(r.strike / r.spot - 1)).toBeLessThan(0.35);
    d.close();
  });
});

describe('pruneBriefCandidates', () => {
  it('keeps two years by default — far longer than the briefs, which is the whole point', () => {
    const d = db();
    const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
    saveBriefCandidates(d, [
      row({ ticker: 'OLD', asOfDate: daysAgo(800) }),
      row({ ticker: 'MID', asOfDate: daysAgo(400) }),   // outlives the briefs' 90-day window
      row({ ticker: 'NEW', asOfDate: daysAgo(1) }),
    ]);
    expect(pruneBriefCandidates(d)).toBe(1);
    const left = (d.prepare('SELECT ticker FROM brief_candidates ORDER BY ticker').all() as Array<{ ticker: string }>)
      .map(r => r.ticker);
    expect(left).toEqual(['MID', 'NEW']);
    d.close();
  });

  it('honours an explicit retention window', () => {
    const d = db();
    const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
    saveBriefCandidates(d, [row({ ticker: 'A', asOfDate: daysAgo(100) }), row({ ticker: 'B', asOfDate: daysAgo(10) })]);
    expect(pruneBriefCandidates(d, 90)).toBe(1);
    expect(count(d)).toBe(1);
    d.close();
  });
});
