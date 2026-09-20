import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildBullPutSpread, pickSpreadExpiration, computeSpreadMode, readSpreadModeSettings, writeSpreadModeSettings,
} from '../src/main/services/spread-mode.js';
import type { CapturedPut } from '../src/main/services/spread-chain-capture.js';
import { SPREAD_MODE_LIMITS, type SpreadModeSettings } from '../src/shared/spread-mode.js';
import { openDatabase } from '../src/main/db/connection.js';
import { runMigrations } from '../src/main/db/migrations.js';
import { MIGRATIONS_DIR } from './helpers.js';

// Bull put spread mode (TODO #44, NewApp/requirements/08): 21–35 DTE nearest 30, short 0.20–0.40Δ nearest
// 0.30, long the strike nearest 5% of spot below the short within 3–10% (v1.1.292), options-fill fills, round-trip cost ≤ 25% of mid credit,
// sized by max loss, ranked by return on risk, shadow-stored.

const TODAY = '2026-09-14';
const NOW = new Date('2026-09-14T15:00:00Z');
const EXP_18 = '2026-10-02';
const EXP_28 = '2026-10-12';
const EXP_33 = '2026-10-17';

// [strike, bid, ask, delta, iv_pct, oi, volume]
const put = (strike: number, bid: number, ask: number, delta: number | null, oi = 500): CapturedPut => [strike, bid, ask, delta, 35, oi, 10];

const GOOD_100: CapturedPut[] = [
  put(97.5, 2.9, 3.0, -0.36),   // in band, further from 0.30
  put(95, 1.9, 2.0, -0.30),     // the short
  put(94, 1.6, 1.7, -0.27),     // in band, further from 0.30
  put(92.5, 1.2, 1.3, -0.24),   // in band, further from 0.30
  put(91, 1.0, 1.1, -0.18),     // 4% — allowed, further from target
  put(90, 0.8, 0.9, -0.15),     // the long: exactly 5%
  put(87.5, 0.55, 0.65, -0.11), // 7.5% — allowed, further from target
  put(85, 0.4, 0.5, -0.08),     // 10% — allowed at the edge, furthest
];

describe('buildBullPutSpread', () => {
  it('takes the short nearest 0.30Δ and the long nearest 5% of spot below it, with options-fill fills', () => {
    const r = buildBullPutSpread(GOOD_100, 100);
    if (!('spread' in r)) throw new Error(r.reason);
    const s = r.spread;
    expect(s.short.strike).toBe(95);
    expect(s.long.strike).toBe(90);
    expect(s.width).toBe(5);
    expect(s.shortFill).toBeCloseTo(1.925, 9);   // mid 1.95 − 0.5 × 0.05
    expect(s.longFill).toBeCloseTo(0.875, 9);    // mid 0.85 + 0.5 × 0.05
    expect(s.midCredit).toBeCloseTo(1.10, 9);
    expect(s.netCredit).toBeCloseTo(1.05, 9);
    expect(s.costShare).toBeCloseTo(0.10 / 1.10, 9); // 2 × (0.025 + 0.025) ÷ 1.10
    expect(s.maxLoss).toBeCloseTo(3.95, 9);
    expect(s.returnOnRisk).toBeCloseTo(1.05 / 3.95, 9);
    expect(s.breakeven).toBeCloseTo(93.95, 9);
    expect(s.takeProfitDebit).toBeCloseTo(0.525, 9);
  });

  it('says why when there is no short, no long, too little credit or too much cost', () => {
    const noShort = buildBullPutSpread([put(95, 1.9, 2.0, -0.45), put(90, 0.8, 0.9, -0.15)], 100);
    expect('reason' in noShort && noShort.reason).toMatch(/no two-sided put at 0\.2–0\.4Δ/);

    const oneSided = buildBullPutSpread([put(95, 0, 2.0, -0.30), put(90, 0.8, 0.9, -0.15)], 100);
    expect('reason' in oneSided && oneSided.reason).toMatch(/no two-sided put/);

    const noLong = buildBullPutSpread([put(95, 1.9, 2.0, -0.30), put(93, 1.4, 1.5, -0.24), put(84, 0.4, 0.5, -0.08)], 100);
    expect('reason' in noLong && noLong.reason).toMatch(/no two-sided long put 3–10% of spot below the short strike/);

    const costly = buildBullPutSpread([put(95, 1.5, 2.4, -0.30), put(90, 0.6, 1.1, -0.15)], 100);
    expect('reason' in costly && costly.reason).toMatch(/round-trip cost 64% of credit \(max 25%\)/);

    const thin = buildBullPutSpread([put(95, 0.20, 0.22, -0.30), put(90, 0.17, 0.19, -0.15)], 100);
    expect('reason' in thin && thin.reason).toMatch(/net credit \$0\.02 after fills/);
  });
});

describe('leg rules on real strike grids (v1.1.292)', () => {
  it('takes the wing strike NEAREST short − 5% of spot even when none sits in 5–7.5% (CF, $5 strikes at ~$120)', () => {
    // short 125 on a $121 stock: 120 is 4.1% below, 115 is 8.3% — the old 5–7.5% band rejected both.
    const r = buildBullPutSpread([put(125, 4.0, 4.2, -0.31), put(120, 2.4, 2.5, -0.21), put(115, 1.4, 1.5, -0.13)], 121);
    if (!('spread' in r)) throw new Error(r.reason);
    expect(r.spread.long.strike).toBe(120); // |120 − 118.95| < |115 − 118.95|
  });

  it('finds a short when the strike grid straddles the old 0.25–0.35 band (DVN-like: 0.22 then 0.38)', () => {
    const r = buildBullPutSpread([put(47.5, 1.3, 1.32, -0.38), put(45, 0.6, 0.62, -0.22), put(42.5, 0.25, 0.27, -0.10)], 47.8);
    if (!('spread' in r)) throw new Error(r.reason);
    expect(r.spread.short.strike).toBe(45);  // both 0.08 from 0.30 — the tie goes to the lower strike
    expect(r.spread.long.strike).toBe(42.5);
  });
});

describe('pickSpreadExpiration', () => {
  it('takes the expiry nearest 30 DTE inside 21–35, strictly before earnings', () => {
    const exps = [{ expiration: EXP_18, dte: 18 }, { expiration: EXP_28, dte: 28 }, { expiration: EXP_33, dte: 33 }];
    expect(pickSpreadExpiration(exps, '2026-12-01')).toEqual({ expiration: EXP_28, dte: 28 });
    expect(pickSpreadExpiration(exps, EXP_28)).toBeNull(); // report on the 28-DTE expiry day: both in-window expiries excluded
    expect(pickSpreadExpiration(exps, '2026-10-15')).toEqual({ expiration: EXP_28, dte: 28 });
    expect(pickSpreadExpiration([{ expiration: EXP_18, dte: 18 }], '2026-12-01')).toBeNull();
  });
});

describe('computeSpreadMode', () => {
  function seed() {
    const db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    const GEN = '2026-09-14T14:25:00.000Z';
    const cand = db.prepare(
      `INSERT INTO brief_candidates (as_of_date, generated_at, strategy, ticker, composite_score, rank, disposition, slot)
       VALUES (?, ?, ?, ?, 60, 1, ?, 'intraday')`,
    );
    for (const [s, t, d] of [
      ['wheel', 'AAA', 'picked'], ['wheel', 'HHH', 'capped_out'], ['wheel', 'FLG', 'picked'],
      ['wheel', 'STL', 'picked'], ['wheel', 'ERN', 'picked'], ['wheel', 'NOC', 'picked'],
      ['wheel', 'BIG', 'picked'], ['wheel', 'WID', 'picked'], ['wheel', 'UNK', 'picked'],
      ['wheel', 'ILQ', 'failed_liquidity'],   // not a validated candidate
      ['income', 'INC', 'picked'],            // the challenger pool (08 S11)
    ] as const) cand.run(TODAY, GEN, s, t, d);

    db.prepare(`INSERT INTO daily_briefs (generated_at, valid_until, strategy, picks) VALUES (?, ?, 'wheel', ?)`)
      .run(GEN, GEN, JSON.stringify([{ ticker: 'AAA', criticVerdict: { verdict: 'pass' } }, { ticker: 'FLG', criticVerdict: { verdict: 'flag' } }]));

    const earn = db.prepare('INSERT INTO earnings_calendar (ticker, report_date) VALUES (?, ?)');
    for (const t of ['AAA', 'HHH', 'FLG', 'NOC', 'BIG', 'WID', 'INC', 'ILQ']) earn.run(t, '2026-12-01');
    earn.run('STL', '2026-08-01');   // stale
    earn.run('ERN', '2026-10-05');   // before every 21–35 DTE expiry
    // UNK has no earnings row

    const chain = db.prepare(
      `INSERT INTO spread_chain_capture (as_of_date, slot, captured_at, ticker, expiration, dte, reason, underlying_price, contract_count, puts_json)
       VALUES (?, ?, 'x', ?, ?, ?, ?, ?, 1, ?)`,
    );
    const HHH_50 = [put(47.5, 1.2, 1.25, -0.31), put(45, 0.5, 0.55, -0.16)];
    const BIG_1000 = [put(950, 19, 20, -0.30), put(900, 8, 9, -0.15)];
    const WIDE = [put(95, 1.5, 2.4, -0.30), put(90, 0.6, 1.1, -0.15)];
    for (const t of ['AAA', 'FLG', 'STL', 'ERN', 'UNK', 'INC', 'ILQ']) {
      chain.run(TODAY, 'intraday', t, EXP_18, 18, 'entry', 100, JSON.stringify(GOOD_100));
      chain.run(TODAY, 'intraday', t, EXP_28, 28, 'entry', 100, JSON.stringify(GOOD_100));
    }
    chain.run(TODAY, 'intraday', 'HHH', EXP_28, 28, 'entry', 50, JSON.stringify(HHH_50));
    chain.run(TODAY, 'intraday', 'BIG', EXP_28, 28, 'entry', 1000, JSON.stringify(BIG_1000));
    chain.run(TODAY, 'intraday', 'WID', EXP_28, 28, 'entry', 100, JSON.stringify(WIDE));
    chain.run(TODAY, 'after_close', 'NOC', EXP_28, 28, 'entry', 100, JSON.stringify(GOOD_100)); // other slot only
    return db;
  }
  const SETTINGS = { mode: 'shadow' as const, maxLossPerPosition: 1000, maxOpenPositions: 10, maxOpenPerSector: 3 };

  it('picks, sizes and ranks from this run\'s captured chains, and explains every exclusion', () => {
    const db = seed();
    const r = computeSpreadMode({ db, slot: 'intraday', now: NOW, settings: SETTINGS });

    expect(r.error).toBeNull();
    expect(r.considered).toBe(9);
    // HHH: 0.675 ÷ 1.825 = 0.37 beats AAA: 1.05 ÷ 3.95 = 0.27. BIG ranks last on return and is kept at
    // contracts = 0 — in shadow the budget sizes but does not gate (v1.1.300), so it joins the ranking.
    expect(r.picks.map(p => [p.ticker, p.rank])).toEqual([['HHH', 1], ['AAA', 2], ['BIG', 3]]);
    const aaa = r.picks[1]!;
    expect(aaa.expiration).toBe(EXP_28);
    expect(aaa.contracts).toBe(2);                    // floor(1000 ÷ 395)
    expect(aaa.totalMaxLoss).toBeCloseTo(790, 6);
    expect(aaa.criticVerdict).toBe('pass');
    expect(r.picks[0]!.contracts).toBe(5);            // floor(1000 ÷ 182.5)

    const why = Object.fromEntries(r.rejections.map(x => [x.ticker, x.reason]));
    expect(why['FLG']).toBe('critic flag');
    expect(why['STL']).toMatch(/earnings calendar stale/);
    expect(why['ERN']).toMatch(/earnings 2026-10-05 on\/before every 21–35 DTE expiry/);
    expect(why['UNK']).toBe('earnings date unknown');
    expect(why['NOC']).toBe('no chain captured this run');
    // Shadow SIZES on the budget but does not gate on it (v1.1.300, 08 S10): BIG is unaffordable at
    // $1,000 and is kept with contracts = 0 rather than rejected, so it still settles into the §4 sample.
    expect(why['BIG']).toBeUndefined();
    expect(r.picks.find(p => p.ticker === 'BIG')).toMatchObject({ contracts: 0, totalMaxLoss: 0 });
    expect(why['WID']).toMatch(/round-trip cost/);
    expect(why['ILQ']).toBeUndefined();
    expect(why['INC']).toBeUndefined();

    const rows = db.prepare(`SELECT outcome, COUNT(*) n FROM spread_mode_picks WHERE as_of_date = ? AND slot = 'intraday' GROUP BY outcome ORDER BY outcome`)
      .all(TODAY);
    expect(rows).toEqual([{ outcome: 'pick', n: 3 }, { outcome: 'rejected', n: 6 }]);
    const stored = db.prepare(`SELECT * FROM spread_mode_picks WHERE ticker = 'AAA'`).get() as Record<string, unknown>;
    expect(stored).toMatchObject({ mode: 'shadow', rank: 2, short_strike: 95, long_strike: 90, contracts: 2, expiration: EXP_28 });
    expect(r.rowsWritten).toBe(9);
  });

  it('replaces a re-run of the same slot and keeps the other slot', () => {
    const db = seed();
    computeSpreadMode({ db, slot: 'intraday', now: NOW, settings: SETTINGS });
    computeSpreadMode({ db, slot: 'intraday', now: NOW, settings: SETTINGS });
    computeSpreadMode({ db, slot: 'after_close', now: NOW, settings: SETTINGS });
    const bySlot = db.prepare('SELECT slot, COUNT(*) n FROM spread_mode_picks GROUP BY slot ORDER BY slot').all();
    expect(bySlot).toEqual([{ slot: 'after_close', n: 9 }, { slot: 'intraday', n: 9 }]);
  });

  it('respects the per-position budget', () => {
    const r = computeSpreadMode({ db: seed(), slot: 'intraday', now: NOW, settings: { ...SETTINGS, maxLossPerPosition: 5000 } });
    expect(r.picks.map(p => p.ticker)).toEqual(['HHH', 'AAA', 'BIG']);
    expect(r.picks.every(p => p.contracts >= 1)).toBe(true);
  });

  // 08 S10: the budget sizes but does not gate. Shadow exists to accumulate the evidence §4 is waiting on,
  // and a rejection never becomes a position, so it never settles — a small budget would shrink the sample
  // rather than the book. Return on max loss is a per-share ratio, so an unaffordable spread is evidence
  // about the strategy even though it is not evidence about this account. `on` is the mode that would
  // exclude it (§3.4.5) and does not exist yet, which is why there is no `on` arm here to test:
  // `SpreadModeSwitch` has no such member, and `budgetGates` breaks the build when one is added.
  it('sizes on the budget without gating on it, keeping an unaffordable spread (v1.1.300)', () => {
    const db = seed();
    const r = computeSpreadMode({ db, slot: 'intraday', now: NOW, settings: { ...SETTINGS, maxLossPerPosition: 1000 } });

    const big = r.picks.find(p => p.ticker === 'BIG');
    expect(big).toBeDefined();
    expect(big!.contracts).toBe(0);
    expect(big!.totalMaxLoss).toBe(0);
    // The sizing itself is unchanged for everything the budget CAN afford.
    expect(r.picks.find(p => p.ticker === 'AAA')!.contracts).toBe(2);
    expect(r.rejections.some(x => /per-position budget/.test(x.reason))).toBe(false);
    // It is stored, not just returned — the gate reads the table, not this result.
    const stored = db.prepare(`SELECT outcome, contracts FROM spread_mode_picks WHERE ticker = 'BIG'`).get();
    expect(stored).toMatchObject({ outcome: 'pick', contracts: 0 });
  });

  // 08 S11: wheel and income run as two passes over the same captured chains. They must not overwrite
  // each other — the whole point is a paired same-day sample, and a second pass clobbering the first
  // would leave one arm silently empty while still looking like it ran.
  it('runs each candidate pool as its own pass, and neither overwrites the other (v1.1.301)', () => {
    const db = seed();

    const income = computeSpreadMode({ db, slot: 'intraday', now: NOW, settings: SETTINGS, pool: 'income' });
    expect(income.pool).toBe('income');
    // INC is the only income candidate; the wheel names are invisible to this pass.
    expect(income.picks.map(p => p.ticker)).toEqual(['INC']);
    expect(income.considered).toBe(1);

    const wheel = computeSpreadMode({ db, slot: 'intraday', now: NOW, settings: SETTINGS, pool: 'wheel' });
    expect(wheel.pool).toBe('wheel');
    expect(wheel.picks.some(p => p.ticker === 'INC')).toBe(false);

    // Both arms survive the other's pass, each row tagged with the pool that produced it.
    const byPool = db.prepare(
      `SELECT pool, COUNT(*) n FROM spread_mode_picks WHERE as_of_date = ? AND slot = 'intraday' GROUP BY pool ORDER BY pool`,
    ).all(TODAY) as Array<{ pool: string; n: number }>;
    expect(byPool.map(r => r.pool)).toEqual(['income', 'wheel']);
    expect(db.prepare(`SELECT pool FROM spread_mode_picks WHERE ticker = 'INC'`).get()).toEqual({ pool: 'income' });

    // A re-run of one pool replaces only that pool's rows.
    const before = (db.prepare(`SELECT COUNT(*) n FROM spread_mode_picks WHERE pool = 'wheel'`).get() as { n: number }).n;
    computeSpreadMode({ db, slot: 'intraday', now: NOW, settings: SETTINGS, pool: 'income' });
    expect((db.prepare(`SELECT COUNT(*) n FROM spread_mode_picks WHERE pool = 'wheel'`).get() as { n: number }).n).toBe(before);
    expect((db.prepare(`SELECT COUNT(*) n FROM spread_mode_picks WHERE pool = 'income'`).get() as { n: number }).n).toBe(1);
  });

  it('defaults to the wheel pool when none is given', () => {
    const r = computeSpreadMode({ db: seed(), slot: 'intraday', now: NOW, settings: SETTINGS });
    expect(r.pool).toBe('wheel');
  });

  it('does not apply the earnings gate to an ETF, and stores no earnings date for it (v1.1.292)', () => {
    const db = seed();
    db.prepare(
      `INSERT INTO brief_candidates (as_of_date, generated_at, strategy, ticker, composite_score, rank, disposition, slot)
       VALUES (?, '2026-09-14T14:25:00.000Z', 'wheel', 'EWZ', 60, 1, 'picked', 'intraday')`,
    ).run(TODAY);
    db.prepare(`INSERT INTO constituents (ticker, index_name) VALUES ('EWZ', 'etf')`).run();
    db.prepare(
      `INSERT INTO spread_chain_capture (as_of_date, slot, captured_at, ticker, expiration, dte, reason, underlying_price, contract_count, puts_json)
       VALUES (?, 'intraday', 'x', 'EWZ', ?, 28, 'entry', 100, 1, ?)`,
    ).run(TODAY, EXP_28, JSON.stringify(GOOD_100));
    // EWZ has no earnings row — before v1.1.292 it was rejected as "earnings date unknown".
    const r = computeSpreadMode({ db, slot: 'intraday', now: NOW, settings: SETTINGS });
    const ewz = r.picks.find(p => p.ticker === 'EWZ');
    expect(ewz).toMatchObject({ expiration: EXP_28, earningsDate: null });
    expect(r.rejections.find(x => x.ticker === 'EWZ')).toBeUndefined();
    // A stock with no earnings row is still rejected.
    expect(r.rejections.find(x => x.ticker === 'UNK')?.reason).toBe('earnings date unknown');
    expect((db.prepare(`SELECT earnings_date FROM spread_mode_picks WHERE ticker = 'EWZ'`).get() as { earnings_date: string | null }).earnings_date).toBeNull();
  });

  it('does nothing when off, and never throws', () => {
    const db = seed();
    const off = computeSpreadMode({ db, slot: 'intraday', now: NOW, settings: { ...SETTINGS, mode: 'off' } });
    expect(off).toMatchObject({ mode: 'off', picks: [], rowsWritten: 0, error: null });
    expect((db.prepare('SELECT COUNT(*) n FROM spread_mode_picks').get() as { n: number }).n).toBe(0);

    const broken = computeSpreadMode({ db: openDatabase(':memory:'), slot: 'intraday', now: NOW, settings: SETTINGS });
    expect(broken.error).toBeTruthy();
  });
});

describe('readSpreadModeSettings', () => {
  it('defaults to shadow, $2,500 (the operator\'s 10% of $25,000) and 10 positions, and ignores malformed values', () => {
    const db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    expect(readSpreadModeSettings(db)).toEqual({ mode: 'shadow', maxLossPerPosition: 2500, maxOpenPositions: 10, maxOpenPerSector: 3 });
    const set = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    set.run('bullPutSpreadMode', 'on');               // not built yet → default
    set.run('bullPutSpreadMaxLossPerPosition', '-5'); // invalid → default
    set.run('bullPutSpreadMaxOpenPositions', '4');
    expect(readSpreadModeSettings(db)).toEqual({ mode: 'shadow', maxLossPerPosition: 2500, maxOpenPositions: 4, maxOpenPerSector: 3 });
    set.run('bullPutSpreadMode', 'off');
    set.run('bullPutSpreadMaxLossPerPosition', '750');
    expect(readSpreadModeSettings(db)).toMatchObject({ mode: 'off', maxLossPerPosition: 750 });
  });
});

describe('writeSpreadModeSettings — the one choke point every writer passes (v1.1.296)', () => {
  function db() {
    const d = openDatabase(':memory:');
    runMigrations(d, MIGRATIONS_DIR);
    return d;
  }
  const settings = (over: Partial<SpreadModeSettings> = {}): SpreadModeSettings =>
    ({ mode: 'shadow', maxLossPerPosition: 2500, maxOpenPositions: 10, maxOpenPerSector: 3, ...over });

  it('stores what it returns, and readSpreadModeSettings reads it back', () => {
    const d = db();
    const saved = writeSpreadModeSettings(d, settings({ mode: 'off', maxLossPerPosition: 750, maxOpenPositions: 4, maxOpenPerSector: 2 }));
    expect(saved).toEqual({ mode: 'off', maxLossPerPosition: 750, maxOpenPositions: 4, maxOpenPerSector: 2 });
    expect(readSpreadModeSettings(d)).toEqual(saved);
  });

  it('clamps to the allowed range instead of rejecting, and rounds', () => {
    const d = db();
    expect(writeSpreadModeSettings(d, settings({ maxLossPerPosition: 1, maxOpenPositions: 0 })))
      .toMatchObject({ maxLossPerPosition: SPREAD_MODE_LIMITS.maxLossPerPosition.min, maxOpenPositions: 1 });
    expect(writeSpreadModeSettings(d, settings({ maxLossPerPosition: 2_000_000 })).maxLossPerPosition)
      .toBe(SPREAD_MODE_LIMITS.maxLossPerPosition.max);
    expect(writeSpreadModeSettings(d, settings({ maxLossPerPosition: 2500.6 })).maxLossPerPosition).toBe(2501);
    expect(writeSpreadModeSettings(d, settings({ maxLossPerPosition: Number.NaN })).maxLossPerPosition).toBe(2500);
  });

  it('never stores a sector cap above the position cap — a cap that cannot bind reads as a rule that is on but silent', () => {
    const d = db();
    expect(writeSpreadModeSettings(d, settings({ maxOpenPositions: 4, maxOpenPerSector: 9 })))
      .toMatchObject({ maxOpenPositions: 4, maxOpenPerSector: 4 });
  });

  it('refuses `on`, which is not built: an unknown mode stores as shadow', () => {
    const d = db();
    expect(writeSpreadModeSettings(d, { ...settings(), mode: 'on' as unknown as SpreadModeSettings['mode'] }).mode).toBe('shadow');
  });
});

describe('the brief job runs the spread mode after capturing chains', () => {
  const job = readFileSync(resolve('src/main/services/jobs/daily-intelligence-brief-job.ts'), 'utf8');
  it('calls computeSpreadMode after captureSpreadChains, with this run\'s slot, and logs spread-mode:run', () => {
    const capture = job.indexOf('captureSpreadChains({');
    const mode = job.indexOf('computeSpreadMode({');
    expect(capture).toBeGreaterThan(-1);
    expect(mode).toBeGreaterThan(capture);
    expect(job.slice(mode, mode + 120)).toContain('slot: candidateSlot');
    expect(job).toContain("operation: 'spread-mode:run'");
  });
});
