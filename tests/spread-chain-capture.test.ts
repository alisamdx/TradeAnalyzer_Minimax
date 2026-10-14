import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  selectPuts, captureSpreadChains, coverageCandidates, intradayQuoteCounts, type CapturedPut,
} from '../src/main/services/spread-chain-capture.js';
import type { OptionContract } from '../src/main/services/data-provider.js';
import { openDatabase } from '../src/main/db/connection.js';
import { runMigrations } from '../src/main/db/migrations.js';
import { MIGRATIONS_DIR } from './helpers.js';

// Bull put spread capture (NewApp/TODO.md #42): both legs' quotes, entry + tracked series, both slots.

const TODAY = '2026-09-14';
const NOW = new Date('2026-09-14T15:00:00Z');
const EXP_10 = '2026-09-24'; // 10 DTE — outside the entry window
const EXP_18 = '2026-10-02'; // 18 DTE
const EXP_46 = '2026-10-30'; // 46 DTE — outside the entry window

const c = (strike: number, side: 'put' | 'call', delta: number | null, extra: Partial<OptionContract> = {}): OptionContract => ({
  ticker: 'AAA', expiration: EXP_18, strike, side, bid: 1, ask: 1.1, delta,
  gamma: null, theta: null, vega: null, iv: 0.3882, openInterest: 500, volume: 0, ...extra,
});

describe('selectPuts', () => {
  it('keeps puts in the delta band, sorted, IV as a percentage, zero volume kept as 0 and missing as null', () => {
    const puts = selectPuts([
      c(95, 'put', -0.30),
      c(80, 'put', -0.02),                       // below band
      c(105, 'put', -0.60),                      // above band
      c(90, 'put', -0.12, { volume: null }),
      c(95, 'call', 0.7),                        // calls never
    ], 100, null);
    expect(puts.map(p => p[0])).toEqual([90, 95]);
    expect(puts[1]).toEqual([95, 1, 1.1, -0.30, 38.82, 500, 0]);
    expect(puts[0]![6]).toBeNull();
  });

  it('falls back to moneyness when delta is missing, and widens to the tracked strike range', () => {
    const chain = [c(70, 'put', null), c(60, 'put', null), c(110, 'put', -0.85), c(101, 'put', null)];
    expect(selectPuts(chain, 100, null).map(p => p[0])).toEqual([70]);
    expect(selectPuts(chain, 100, { min: 60, max: 110 }).map(p => p[0])).toEqual([60, 70, 101, 110]);
  });
});

describe('captureSpreadChains', () => {
  function seed() {
    const db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    const GEN = '2026-09-14T14:25:00.000Z';
    const cand = db.prepare(
      `INSERT INTO brief_candidates (as_of_date, generated_at, strategy, ticker, composite_score, rank, disposition, slot)
       VALUES (?, ?, ?, ?, 60, 1, ?, 'intraday')`,
    );
    cand.run(TODAY, GEN, 'wheel', 'AAA', 'picked');
    cand.run(TODAY, GEN, 'bullish', 'BBB', 'capped_out');
    cand.run(TODAY, GEN, 'income', 'AAA', 'picked');          // deduped
    cand.run(TODAY, GEN, 'wheel', 'CCC', 'failed_liquidity'); // not a validated candidate
    cand.run(TODAY, GEN, 'bearish', 'DDD', 'picked');         // not a spread pool
    cand.run('2026-09-11', '2026-09-11T21:00:00.000Z', 'wheel', 'OLD', 'picked'); // older run

    // A spread series entered last week on a name that has left every pool: must still be marked.
    const ins = db.prepare(
      `INSERT INTO spread_chain_capture (as_of_date, slot, captured_at, ticker, expiration, dte, reason, underlying_price, contract_count, puts_json)
       VALUES (?, 'after_close', 'x', ?, ?, 25, ?, 50, 2, ?)`,
    );
    const range: CapturedPut[] = [[45, 1, 1.1, -0.3, 40, 1, 1], [40, 0.5, 0.6, -0.15, 42, 1, 1]];
    ins.run('2026-09-08', 'ZZZ', EXP_18, 'entry', JSON.stringify(range));
    ins.run('2026-09-08', 'EXP', '2026-09-11', 'entry', JSON.stringify(range));  // expired — not tracked
    ins.run('2026-08-01', 'STALE', EXP_46, 'entry', JSON.stringify(range));     // entry too long ago
    return db;
  }

  const calls: string[] = [];
  const provider = {
    async getOptionsExpirations(t: string) { calls.push(`exp:${t}`); return [EXP_10, EXP_18, EXP_46]; },
    async getOptionsChain(t: string, exp: string) {
      calls.push(`chain:${t}:${exp}`);
      if (t === 'BBB') throw new Error('E*Trade timeout');
      // ZZZ has fallen hard: its old short strike is now far past the delta band and must still be kept.
      const contracts = t === 'ZZZ'
        ? [c(45, 'put', -0.92), c(40, 'put', -0.75), c(30, 'put', -0.28)]
        : [c(95, 'put', -0.3), c(90, 'put', -0.15)];
      return { ticker: t, expiration: exp, contracts, underlyingPrice: t === 'ZZZ' ? 35 : 100 };
    },
  };

  it('captures entry chains in the DTE window plus unexpired tracked series, and records failures', async () => {
    const db = seed();
    const r = await captureSpreadChains({ db, provider, slot: 'intraday', now: NOW });

    expect(r.entryTickers).toBe(2);             // AAA, BBB
    expect(r.trackedSeries).toBe(1);            // ZZZ only
    expect(r.rowsWritten).toBe(2);              // AAA@18, ZZZ@18
    expect(r.failures).toEqual([expect.objectContaining({ ticker: 'BBB', step: `chain ${EXP_18}` })]);
    expect(calls.some(x => x.includes(EXP_10) && x.startsWith('chain'))).toBe(false);
    expect(calls.some(x => x.includes('exp:ZZZ'))).toBe(false); // tracked series need no listing call

    const rows = db.prepare(`SELECT ticker, reason, dte, puts_json FROM spread_chain_capture WHERE as_of_date = ? ORDER BY ticker`)
      .all(TODAY) as Array<{ ticker: string; reason: string; dte: number; puts_json: string }>;
    expect(rows.map(x => [x.ticker, x.reason, x.dte])).toEqual([['AAA', 'entry', 18], ['ZZZ', 'track', 18]]);
    expect((JSON.parse(rows[1]!.puts_json) as CapturedPut[]).map(p => p[0])).toEqual([30, 40, 45]);
  });

  it('keeps both slots and replaces a re-run of the same slot', async () => {
    const db = seed();
    await captureSpreadChains({ db, provider, slot: 'intraday', now: NOW });
    await captureSpreadChains({ db, provider, slot: 'intraday', now: NOW });
    await captureSpreadChains({ db, provider, slot: 'after_close', now: NOW });
    const n = db.prepare(`SELECT slot, COUNT(*) n FROM spread_chain_capture WHERE as_of_date = ? GROUP BY slot ORDER BY slot`)
      .all(TODAY);
    expect(n).toEqual([{ slot: 'after_close', n: 2 }, { slot: 'intraday', n: 2 }]);
  });

  it('tracks a spread-mode pick to expiry, past the 21-day entry window, across both legs (v1.1.290)', async () => {
    const db = seed();
    // Picked 2026-08-20 at 42 DTE — its entry row is older than trackDays, so only the pick keeps it marked.
    const pick = db.prepare(
      `INSERT INTO spread_mode_picks (as_of_date, slot, generated_at, mode, ticker, outcome, expiration, short_strike, long_strike)
       VALUES (?, 'intraday', 'x', 'shadow', ?, ?, ?, ?, ?)`,
    );
    pick.run('2026-08-20', 'PKD', 'pick', EXP_18, 45, 40);
    pick.run('2026-08-20', 'GONE', 'pick', '2026-09-11', 45, 40);   // expired — not tracked
    pick.run('2026-08-20', 'REJ', 'rejected', EXP_18, null, null);  // a rejection is not a position
    calls.length = 0;
    const r = await captureSpreadChains({ db, provider, slot: 'intraday', now: NOW });

    expect(r.trackedSeries).toBe(2);            // ZZZ (entry) + PKD (pick)
    expect(calls).toContain(`chain:PKD:${EXP_18}`);
    expect(calls.some(x => x.includes('GONE') || x.includes('REJ'))).toBe(false);
    const row = db.prepare(`SELECT reason, puts_json FROM spread_chain_capture WHERE ticker = 'PKD'`).get() as { reason: string; puts_json: string };
    expect(row.reason).toBe('track');
    // The provider's PKD chain holds 95/90 at spot 100; the pick's legs (40–45) widen the kept range,
    // so the 90/95 strikes stay (delta band) and nothing is lost.
    expect((JSON.parse(row.puts_json) as CapturedPut[]).map(p => p[0])).toEqual([90, 95]);
  });

  it('tracks a name the top-N cut discarded to expiry, so BPS-10 can settle it (v1.1.327)', async () => {
    const db = seed();
    const row = db.prepare(
      `INSERT INTO spread_mode_picks (as_of_date, slot, generated_at, mode, ticker, outcome, reason, expiration, short_strike, long_strike)
       VALUES ('2026-08-20', 'intraday', 'x', 'shadow', ?, 'rejected', ?, ?, ?, ?)`,
    );
    row.run('CUT', 'ranked below the top 5', EXP_18, 45, 40);
    // Cut before v1.1.327: a bare reason with no legs — nothing to track, and it must not be fetched.
    row.run('OLD', 'ranked below the top 5', EXP_18, null, null);
    calls.length = 0;
    const r = await captureSpreadChains({ db, provider, slot: 'intraday', now: NOW });

    expect(r.trackedSeries).toBe(2);            // ZZZ (entry) + CUT
    expect(calls).toContain(`chain:CUT:${EXP_18}`);
    expect(calls.some(x => x.includes('OLD'))).toBe(false);
  });

  it('never throws, even without a usable database', async () => {
    const db = openDatabase(':memory:'); // no migrations
    const r = await captureSpreadChains({ db, provider, slot: 'intraday', now: NOW });
    expect(r.failures[0]).toEqual(expect.objectContaining({ step: 'capture' }));
  });
});

// v1.1.357 (BPS-14): the study's replay set is fixed, so pool-driven capture stopped raising its quoted
// coverage (660 / 1,495 on both 10-09 and 10-13). Coverage rows quote replay tickers it cannot price yet.
describe('coverage capture for the study\'s replay tickers', () => {
  const EXP_31 = '2026-10-15'; // 31 DTE — nearest 30 in the window

  function seed() {
    const db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    const brief = db.prepare(`INSERT INTO replay_briefs (as_of_date, strategy) VALUES (?, ?)`);
    const outcome = db.prepare(
      `INSERT INTO replay_outcomes (replay_brief_id, ticker, rank, composite_score) VALUES (?, ?, 1, 60)`,
    );
    // Entries per ticker: T00 20, T01 19, … T16 4 (17 tickers, so the 15-ticker cap binds);
    // QUO 30 (already quoted), REC 25 (covered 3 days ago), BEAR 30 (a bearish replay, not the study's).
    const entries: Array<[string, number, string]> = [
      ...Array.from({ length: 17 }, (_, i) => [`T${String(i).padStart(2, '0')}`, 20 - i, 'wheel'] as [string, number, string]),
      ['QUO', 30, 'wheel'], ['REC', 25, 'wheel'], ['BEAR', 30, 'bearish'],
    ];
    const briefIds = new Map<string, number>();
    for (const [ticker, n, strategy] of entries) {
      for (let d = 0; d < n; d++) {
        const date = `2025-07-${String(d + 1).padStart(2, '0')}`;
        const key = `${strategy}|${date}`;
        if (!briefIds.has(key)) briefIds.set(key, Number(brief.run(date, strategy).lastInsertRowid));
        outcome.run(briefIds.get(key), ticker);
      }
    }
    // QUO: three valid intraday brief quotes. One after-close and one zero-bid row must not count.
    const cand = db.prepare(
      `INSERT INTO brief_candidates (as_of_date, generated_at, strategy, ticker, composite_score, rank, disposition, slot, bid, ask)
       VALUES (?, ?, 'wheel', ?, 60, 1, 'failed_liquidity', ?, ?, ?)`,
    );
    for (let i = 0; i < 3; i++) cand.run(`2026-09-0${i + 1}`, `g${i}`, 'QUO', 'intraday', 1, 1.2);
    cand.run('2026-09-04', 'g3', 'T00', 'after_close', 1, 1.2);
    cand.run('2026-09-05', 'g4', 'T00', 'intraday', 0, 1.2);
    db.prepare(
      `INSERT INTO spread_chain_capture (as_of_date, slot, captured_at, ticker, expiration, dte, reason, underlying_price, contract_count, puts_json)
       VALUES ('2026-09-11', 'intraday', 'x', 'REC', ?, 25, 'coverage', 100, 0, '[]')`,
    ).run(EXP_18);
    return db;
  }

  const calls: string[] = [];
  const provider = {
    async getOptionsExpirations(t: string) { calls.push(`exp:${t}`); return [EXP_10, EXP_18, EXP_31, EXP_46]; },
    async getOptionsChain(t: string, exp: string) {
      calls.push(`chain:${t}:${exp}`);
      return { ticker: t, expiration: exp, contracts: [c(95, 'put', -0.3), c(90, 'put', -0.15), c(85, 'put', -0.05)], underlyingPrice: 100 };
    },
  };

  it('counts intraday quotes the way the study does', () => {
    const n = intradayQuoteCounts(seed());
    expect(n.get('QUO')).toBe(3);
    expect(n.get('T00')).toBeUndefined(); // after-close and zero-bid rows do not count
  });

  it('lists uncovered wheel replay tickers, most entries first, skipping quoted and recently covered ones', () => {
    const list = coverageCandidates(seed(), TODAY);
    expect(list.slice(0, 3)).toEqual(['T00', 'T01', 'T02']);
    expect(list).toHaveLength(17);
    expect(list).not.toContain('QUO');
    expect(list).not.toContain('REC');
    expect(list).not.toContain('BEAR');
  });

  it('fetches one chain nearest 30 DTE for up to 15 tickers, intraday only, stored as coverage', async () => {
    const db = seed();
    calls.length = 0;
    const r = await captureSpreadChains({ db, provider, slot: 'intraday', now: NOW });
    expect(r.coverageTickers).toBe(15);
    expect(calls.filter(x => x.startsWith('chain:'))).toHaveLength(15);
    expect(calls).toContain(`chain:T00:${EXP_31}`);
    expect(calls.some(x => x.includes('T15') || x.includes('T16'))).toBe(false);

    const rows = db.prepare(`SELECT DISTINCT reason, dte FROM spread_chain_capture WHERE as_of_date = ?`).all(TODAY);
    expect(rows).toEqual([{ reason: 'coverage', dte: 31 }]);
    // Three puts captured (0.03–0.50Δ), two inside the study's 0.10–0.40 band: T00 is not yet quoted…
    expect(intradayQuoteCounts(db).get('T00')).toBe(2);
    // …but is not asked again within the retry window.
    expect(coverageCandidates(db, TODAY)).not.toContain('T00');

    calls.length = 0;
    const late = await captureSpreadChains({ db, provider, slot: 'after_close', now: NOW });
    expect(late.coverageTickers).toBe(0);
    expect(calls).toEqual([]);
  });

  it('does not let tickers E*Trade cannot serve use up the run', async () => {
    const db = seed();
    const failing = {
      ...provider,
      async getOptionsExpirations(t: string) {
        if (Number(t.slice(1)) < 5) throw new Error('E*Trade API error (400) at /v1/market/optionexpiredate: <code>10033</code>');
        return provider.getOptionsExpirations(t);
      },
    };
    const r = await captureSpreadChains({ db, provider: failing, slot: 'intraday', now: NOW });
    expect(r.failures.filter(f => f.step === 'coverage expirations')).toHaveLength(5);
    expect(r.coverageTickers).toBe(12); // T05…T16, all that remain; the 25-attempt cap was not reached
  });
});

describe('migration 093', () => {
  it('accepts reason = coverage and still rejects anything else', () => {
    const db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    const ins = db.prepare(
      `INSERT INTO spread_chain_capture (as_of_date, slot, captured_at, ticker, expiration, dte, reason, contract_count, puts_json)
       VALUES ('2026-10-14', 'intraday', 'x', ?, '2026-11-13', 30, ?, 0, '[]')`,
    );
    expect(() => ins.run('A', 'coverage')).not.toThrow();
    expect(() => ins.run('B', 'other')).toThrow(/CHECK/);
  });
});

describe('the brief job captures spread chains after the shortlist', () => {
  const job = readFileSync(resolve('src/main/services/jobs/daily-intelligence-brief-job.ts'), 'utf8');
  it('calls captureSpreadChains after sendShortlistEmail, with this run\'s slot', () => {
    const shortlist = job.indexOf('sendShortlistEmail({');
    const capture = job.indexOf('captureSpreadChains({');
    expect(shortlist).toBeGreaterThan(-1);
    expect(capture).toBeGreaterThan(shortlist);
    expect(job.slice(capture, capture + 200)).toContain('slot: candidateSlot');
  });
});
