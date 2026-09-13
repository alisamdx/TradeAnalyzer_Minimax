import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { selectPuts, captureSpreadChains, type CapturedPut } from '../src/main/services/spread-chain-capture.js';
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

  it('never throws, even without a usable database', async () => {
    const db = openDatabase(':memory:'); // no migrations
    const r = await captureSpreadChains({ db, provider, slot: 'intraday', now: NOW });
    expect(r.failures[0]).toEqual(expect.objectContaining({ step: 'capture' }));
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
