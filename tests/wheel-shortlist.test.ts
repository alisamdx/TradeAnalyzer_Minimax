import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  pickShortlistContract, computeRollRoom, pickRollExpiration, computeWheelShortlist, dteFrom,
} from '../src/main/services/wheel-shortlist.js';
import { buildShortlistEmailHtml, shortlistEmailSubject, rollRoomText } from '../src/main/services/shortlist-email-builder.js';
import { sendShortlistEmail, type EmailOutcomeLog } from '../src/main/services/brief-emails.js';
import type { OptionContract } from '../src/main/services/data-provider.js';
import type { ShortlistResult } from '../src/shared/wheel-shortlist.js';
import { openDatabase } from '../src/main/db/connection.js';
import { runMigrations } from '../src/main/db/migrations.js';
import { MIGRATIONS_DIR } from './helpers.js';

// NewApp/requirements/07-opportunity-engine.md §3 — the interim, advisory Wheel Shortlist.
// Operator profile: 0.35–0.45Δ puts at 14–30 DTE, ranked by premium return on capital, top 5,
// no capital cap; roll when ITM with ≤ 7 days left to the next 14–30 DTE expiry, same or lower
// strike, for a credit.

const TODAY = '2026-09-14';
const NOW = new Date('2026-09-14T15:00:00Z');
const EXP_18 = '2026-10-02'; // 18 DTE
const EXP_25 = '2026-10-09'; // 25 DTE — also the D3 roll target for EXP_18 (+7)
const EXP_32 = '2026-10-16'; // 32 DTE — outside the window
const EXP_10 = '2026-09-24'; // 10 DTE — outside the window

const put = (ticker: string, exp: string, strike: number, bid: number, ask: number, delta: number | null): OptionContract => ({
  ticker, expiration: exp, strike, side: 'put', bid, ask, delta,
  gamma: null, theta: null, vega: null, iv: 0.4, openInterest: 900, volume: 50,
});

describe('pickShortlistContract', () => {
  it('takes the highest-ROC put inside 0.35–0.45Δ and 14–30 DTE, two-sided only', () => {
    const chains = [
      { expiration: EXP_10, contracts: [put('A', EXP_10, 100, 5, 5.2, -0.40)] },          // DTE out
      { expiration: EXP_18, contracts: [
        put('A', EXP_18, 100, 2.0, 2.2, -0.40),                                              // 2.1/100·365/18 = 42.6%
        put('A', EXP_18, 105, 4.0, 4.4, -0.55),                                              // delta out
        put('A', EXP_18, 98, 0, 1.9, -0.36),                                                 // one-sided
      ] },
      { expiration: EXP_25, contracts: [put('A', EXP_25, 100, 2.9, 3.1, -0.38)] },         // 3/100·365/25 = 43.8%
      { expiration: EXP_32, contracts: [put('A', EXP_32, 100, 9, 9.2, -0.40)] },          // DTE out
    ];
    const c = pickShortlistContract(chains, TODAY)!;
    expect(c.expiration).toBe(EXP_25);
    expect(c.strike).toBe(100);
    expect(c.delta).toBeCloseTo(0.38, 6);
    expect(c.premiumRocAnnualPct).toBeCloseTo((3 / 100) * (365 / 25) * 100, 6);
  });

  it('returns null when nothing is in the profile', () => {
    expect(pickShortlistContract([{ expiration: EXP_18, contracts: [put('A', EXP_18, 100, 2, 2.2, -0.2)] }], TODAY)).toBeNull();
  });
});

describe('roll room (D3 at today\'s prices)', () => {
  const chosen = pickShortlistContract([{ expiration: EXP_18, contracts: [put('A', EXP_18, 100, 2.0, 2.2, -0.40)] }], TODAY)!;

  it('finds the lowest same-or-lower strike whose mid covers the buy-back', () => {
    const roll = { expiration: EXP_25, contracts: [
      put('A', EXP_25, 100, 2.7, 2.9, -0.42), put('A', EXP_25, 97.5, 2.1, 2.3, -0.36), put('A', EXP_25, 95, 1.8, 2.0, -0.31),
    ] };
    expect(computeRollRoom(chosen, roll)).toEqual({ expiration: EXP_25, strike: 97.5, dollarsLower: 2.5, strikesLower: 1 });
  });

  it('says so when no strike covers the buy-back, and null when the roll expiry was not priced', () => {
    const roll = { expiration: EXP_25, contracts: [put('A', EXP_25, 100, 1.5, 1.7, -0.4)] };
    expect(computeRollRoom(chosen, roll)).toEqual({ expiration: EXP_25, strike: null, dollarsLower: null, strikesLower: 0 });
    expect(computeRollRoom(chosen, null)).toBeNull();
  });

  it('targets the nearest expiry 7–30 days after the chosen one', () => {
    expect(pickRollExpiration([EXP_10, EXP_18, '2026-10-05', EXP_25, EXP_32], EXP_18)).toBe(EXP_25);
    expect(dteFrom(EXP_18, EXP_25)).toBe(7);
  });
});

describe('computeWheelShortlist', () => {
  function seed() {
    const db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    const GEN = '2026-09-14T14:25:00.000Z';
    const cand = db.prepare(
      `INSERT INTO brief_candidates (as_of_date, generated_at, strategy, ticker, composite_score, rank, disposition, slot, spot)
       VALUES (?, ?, ?, ?, 60, ?, ?, 'intraday', ?)`,
    );
    const rows: Array<[string, string, number, string, number]> = [
      ['wheel', 'AAA', 1, 'picked', 101],
      ['income', 'BBB', 1, 'capped_out', 52],
      ['wheel', 'CCC', 2, 'failed_liquidity', 40],   // excluded by disposition
      ['wheel', 'DDD', 3, 'picked', 80],             // critic flag
      ['income', 'EEE', 2, 'picked', 70],            // earnings stale
      ['income', 'FFF', 3, 'picked', 60],            // earnings before every expiry
      ['wheel', 'GGG', 4, 'picked', 90],             // no profile contract
      ['income', 'AAA', 4, 'picked', 101],           // same ticker in both pools — deduped
    ];
    for (const [s, t, r, d, spot] of rows) cand.run(TODAY, GEN, s, t, r, d, spot);
    // An older run whose rows must be ignored.
    cand.run('2026-09-11', '2026-09-11T21:30:00.000Z', 'wheel', 'OLD', 1, 'picked', 10);

    db.prepare(`INSERT INTO daily_briefs (generated_at, valid_until, strategy, picks) VALUES (?, ?, 'wheel', ?)`)
      .run(GEN, GEN, JSON.stringify([
        { ticker: 'AAA', criticVerdict: { verdict: 'pass' } },
        { ticker: 'DDD', criticVerdict: { verdict: 'flag' } },
      ]));
    const earn = db.prepare(`INSERT INTO earnings_calendar (ticker, report_date) VALUES (?, ?)`);
    earn.run('AAA', '2026-11-01'); earn.run('BBB', '2026-11-01'); earn.run('DDD', '2026-11-01');
    earn.run('EEE', '2026-08-01'); earn.run('FFF', '2026-09-30'); earn.run('GGG', '2026-11-01');
    return db;
  }

  const chainsFor: Record<string, Record<string, OptionContract[]>> = {
    AAA: { [EXP_18]: [put('AAA', EXP_18, 100, 2.0, 2.2, -0.40)], [EXP_25]: [put('AAA', EXP_25, 97.5, 2.2, 2.4, -0.37)] },
    BBB: { [EXP_18]: [put('BBB', EXP_18, 50, 1.3, 1.4, -0.42)], [EXP_25]: [] },
    GGG: { [EXP_18]: [put('GGG', EXP_18, 85, 0.4, 0.5, -0.15)], [EXP_25]: [] },
  };
  const calls: string[] = [];
  const provider = {
    async getOptionsExpirations(t: string) { calls.push(`exp:${t}`); return [EXP_10, EXP_18, EXP_25, EXP_32]; },
    async getOptionsChain(t: string, exp: string) {
      calls.push(`chain:${t}:${exp}`);
      return { ticker: t, expiration: exp, contracts: chainsFor[t]?.[exp] ?? [], underlyingPrice: null };
    },
  };

  it('ranks the qualifying contracts by return on capital and explains every exclusion', async () => {
    const r = await computeWheelShortlist({ db: seed(), provider, now: NOW });

    // BBB 1.35/50·365/18 = 54.8% beats AAA's 2.4/97.5… AAA best is 2.1/100·365/18 = 42.6%.
    expect(r.entries.map(e => e.ticker)).toEqual(['BBB', 'AAA']);
    expect(r.considered).toBe(6); // AAA BBB DDD EEE FFF GGG — CCC (failed_liquidity) and OLD excluded
    const aaa = r.entries.find(e => e.ticker === 'AAA')!;
    expect(aaa.strategies.sort()).toEqual(['income', 'wheel']);
    expect(aaa.criticVerdict).toBe('pass');
    expect(aaa.capitalRequired).toBe(10_000);
    expect(aaa.rollRoom).toEqual({ expiration: EXP_25, strike: 97.5, dollarsLower: 2.5, strikesLower: 1 });

    const why = Object.fromEntries(r.rejections.map(x => [x.ticker, x.reason]));
    expect(why['DDD']).toBe('critic flag');
    expect(why['EEE']).toMatch(/earnings calendar stale/);
    expect(why['FFF']).toMatch(/before every 14–30 DTE expiry/);
    expect(why['GGG']).toMatch(/no put at 0\.35–0\.45Δ/);
    expect(r.noResultReason).toBeNull();
    // The flagged and stale tickers never cost an E*Trade call.
    expect(calls.some(c => c.includes('DDD') || c.includes('EEE'))).toBe(false);
  });

  it('keeps only the top 5 and says why when nothing qualifies', async () => {
    const db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    const empty = await computeWheelShortlist({ db, provider, now: NOW });
    expect(empty.entries).toEqual([]);
    expect(empty.noResultReason).toMatch(/run the brief first/);
  });
});

describe('the shortlist email', () => {
  const result: ShortlistResult = {
    briefGeneratedAt: '2026-09-14T14:25:00.000Z', considered: 6, rejections: [{ ticker: 'DDD', reason: 'critic flag' }],
    noResultReason: null,
    entries: [{
      ticker: 'BBB', spot: 52, strategies: ['income'], creditPerContract: 135, capitalRequired: 5000, assignmentProbPct: 42,
      earningsDate: '2026-11-01', ownership: null, criticVerdict: null,
      contract: { expiration: EXP_18, dte: 18, strike: 50, bid: 1.3, ask: 1.4, mid: 1.35, delta: 0.42, openInterest: null, spreadPct: 7.4, premiumRocAnnualPct: 54.75 },
      rollRoom: null,
    }],
  };

  it('puts the top idea in the subject and builds without throwing', () => {
    expect(shortlistEmailSubject(result)).toContain('BBB $50 put');
    const html = buildShortlistEmailHtml(result, 'Mon, Sep 14');
    expect(html).toContain('Wheel Shortlist');
    expect(html).toContain('not yet validated on this profile');
    expect(rollRoomText(result.entries[0]!)).toContain('not priced');
  });

  it('still sends when nothing qualified, stating why', async () => {
    const logs: EmailOutcomeLog[] = [];
    const sent: string[] = [];
    const db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    const out = await sendShortlistEmail({
      email: { async send(subject) { sent.push(subject); } },
      db, provider: { getOptionsExpirations: async () => [], getOptionsChain: async () => { throw new Error('unused'); } },
      log: (e) => logs.push(e), source: 'brief', now: NOW,
    });
    expect(out.status).toBe('sent');
    expect(sent[0]).toMatch(/Wheel Shortlist — nothing qualified \(0 considered\) · \d{2}:\d{2} ET$/);
    expect(logs).toEqual([expect.objectContaining({ operation: 'shortlist-email:sent' })]);
  });
});

describe('the brief job sends the shortlist after every run', () => {
  const job = readFileSync(resolve('src/main/services/jobs/daily-intelligence-brief-job.ts'), 'utf8');
  it('calls sendShortlistEmail after the dice, inside the email-configured block', () => {
    const dice = job.indexOf('sendDiceEmail({');
    const shortlist = job.indexOf('sendShortlistEmail({');
    expect(dice).toBeGreaterThan(-1);
    expect(shortlist).toBeGreaterThan(dice);
  });
});
