// Bull put spread shadow settlement (08 §4.2) — the rules the enable gate is judged on.
import { describe, it, expect } from 'vitest';
import {
  settleSpreadPick, buildSpreadShadowReport, reasonKind, diagnoseLegs, diagnoseStoredRejection, parseLegBand,
  simulateSectorCap, liquidityVsCost, parseCostShareFromReason,
  type ShadowPick, type ShadowMark, type ShadowPickRow,
} from '../src/main/services/spread-mode-settle.js';
import { SPREAD_MODE_PROFILE as P } from '../src/shared/spread-mode.js';
import type { CapturedPut } from '../src/main/services/spread-chain-capture.js';
import { openDatabase } from '../src/main/db/connection.js';
import { runMigrations } from '../src/main/db/migrations.js';
import { MIGRATIONS_DIR } from './helpers.js';

// A 95/90 spread on a $100 stock, $1.60 net credit → $3.40 max loss; target at a $0.80 mid debit.
const PICK: ShadowPick = {
  id: 1, asOfDate: '2026-09-14', slot: 'intraday', ticker: 'AAA', expiration: '2026-10-16', spot: 100,
  shortStrike: 95, longStrike: 90, netCredit: 1.6, maxLoss: 3.4,
};
const put = (strike: number, bid: number, ask: number): CapturedPut => [strike, bid, ask, -0.3, 40, 500, 10];
const mark = (asOfDate: string, slot: ShadowMark['slot'], short: [number, number], long: [number, number]): ShadowMark =>
  ({ asOfDate, slot, puts: [put(90, ...long), put(95, ...short)] });

describe('settleSpreadPick', () => {
  it('takes the target on the first later mark whose MID debit is ≤ 50% of the credit, realised with fills', () => {
    const s = settleSpreadPick(PICK, [
      mark('2026-09-14', 'intraday', [0.1, 0.2], [0, 0.1]),       // the entry itself — never an exit
      mark('2026-09-16', 'after_close', [1.2, 1.4], [0.4, 0.5]),  // mid 0.85 — not yet
      mark('2026-09-17', 'intraday', [1.0, 1.2], [0.3, 0.4]),     // mid 0.75 — target
      mark('2026-09-18', 'intraday', [0.2, 0.3], [0, 0.05]),
    ], null, '2026-09-19');
    expect(s.status).toBe('target');
    if (s.status !== 'target') return;
    expect(s.exitDate).toBe('2026-09-17');
    // fills: buy short at 1.15, sell long at 0.325 → 0.825 debit, above the 0.75 mid
    expect(s.exitDebit).toBeCloseTo(0.825, 6);
    expect(s.returnOnMaxLoss).toBeCloseTo((1.6 - 0.825) / 3.4, 6);
    expect(s.daysHeld).toBe(3);
  });

  it('an after-close mark on the entry day counts; the entry slot itself does not', () => {
    const s = settleSpreadPick(PICK, [mark('2026-09-14', 'after_close', [0.6, 0.7], [0.1, 0.2])], null, '2026-09-15');
    expect(s.status).toBe('target');
  });

  it('a missing or crossed leg is a gap, not a mark', () => {
    const s = settleSpreadPick(PICK, [
      { asOfDate: '2026-09-15', slot: 'intraday', puts: [put(95, 0.1, 0.2)] },     // long leg absent
      mark('2026-09-16', 'intraday', [0.3, 0.2], [0, 0.1]),                          // short crossed
    ], null, '2026-09-17');
    expect(s).toEqual({ status: 'open', marks: 0, gaps: 2, lastMarkDate: null, lastMidDebit: null });
  });

  it('with no target, settles at intrinsic on the expiry close with no closing cost — a max loss when below the long strike', () => {
    expect(settleSpreadPick(PICK, [], 88, '2026-10-17')).toMatchObject({ status: 'expired', exitDebit: 5, returnOnMaxLoss: -1 });
    const partial = settleSpreadPick(PICK, [], 93, '2026-10-17');
    expect(partial).toMatchObject({ status: 'expired', exitDebit: 2 });
    if (partial.status === 'expired') expect(partial.returnOnMaxLoss).toBeCloseTo(-0.4 / 3.4, 6);
    expect(settleSpreadPick(PICK, [], 110, '2026-10-17')).toMatchObject({ status: 'expired', exitDebit: 0 });
  });

  it('stays open through expiry day itself, and is unsettleable afterwards without a close', () => {
    expect(settleSpreadPick(PICK, [], 110, '2026-10-16').status).toBe('open');
    expect(settleSpreadPick(PICK, [], null, '2026-10-17')).toMatchObject({ status: 'unsettleable', reason: 'no close stored for the expiry date' });
  });

  it('refuses to settle on a close that looks like a split, and says why', () => {
    const s = settleSpreadPick(PICK, [], 24, '2026-10-17'); // 4:1 split would read as a max loss
    expect(s.status).toBe('unsettleable');
    if (s.status === 'unsettleable') expect(s.reason).toContain('possible split');
  });
});

describe('diagnoseLegs — why a stored chain yields no spread (v1.1.291)', () => {
  const p = (strike: number, bid: number, ask: number, delta: number | null): CapturedPut => [strike, bid, ask, delta, 40, 100, 1];
  it('names each cause in the order buildBullPutSpread would meet it', () => {
    expect(diagnoseLegs([p(95, 1, 1.1, -0.3)], null)).toBe('no underlying price');
    expect(diagnoseLegs([p(95, 1, 1.1, null), p(90, 0.5, 0.6, null)], 100)).toBe('chain carried no deltas');
    expect(diagnoseLegs([p(95, 1, 1.1, -0.45)], 100)).toBe('no put in the Δ band');
    expect(diagnoseLegs([p(95, 0, 1.1, -0.3)], 100)).toBe('Δ-band put not two-sided');
    expect(diagnoseLegs([p(95, 1, 1.1, -0.3), p(80, 0.1, 0.2, -0.05)], 100)).toBe('no strike in the wing range');
    expect(diagnoseLegs([p(95, 1, 1.1, -0.3), p(90, 0, 0.05, -0.08)], 100)).toBe('wing strike has no bid');
    expect(diagnoseLegs([p(95, 1, 1.1, -0.3), p(90, 0.3, 0.4, -0.12)], 100)).toBe('legs present (another expiry was chosen)');
  });
});

describe('re-judging a stored rejection under the band that made it (v1.1.299)', () => {
  const p = (strike: number, bid: number, ask: number, delta: number | null): CapturedPut => [strike, bid, ask, delta, 40, 100, 1];
  const DELTA_THEN = 'no two-sided put at 0.25–0.35Δ';
  const WING_THEN = 'no two-sided long put 5–7.5% of spot below the short strike';

  it('recovers the band from the rejection text, and falls back to the current profile', () => {
    expect(parseLegBand(DELTA_THEN)).toMatchObject({ deltaMin: 0.25, deltaMax: 0.35 });
    expect(parseLegBand(WING_THEN)).toMatchObject({ wingMinPct: 0.05, wingMaxPct: 0.075 });
    // The half a reason does not name keeps today's value.
    expect(parseLegBand(DELTA_THEN)).toMatchObject({ wingMinPct: P.wingMinPct, wingMaxPct: P.wingMaxPct });
    expect(parseLegBand(WING_THEN)).toMatchObject({ deltaMin: P.deltaMin, deltaMax: P.deltaMax });
    // A hyphen instead of the en dash still parses, so a reworded reason does not silently stop matching.
    expect(parseLegBand('no two-sided put at 0.25-0.35Δ')).toMatchObject({ deltaMin: 0.25, deltaMax: 0.35 });
    // Unparseable, reversed or non-numeric → today's band, which makes the comparison a no-op, not a lie.
    for (const bad of ['critic flag', 'no two-sided put at 0.35–0.25Δ', 'no two-sided put at a–bΔ']) {
      expect(parseLegBand(bad)).toMatchObject({ deltaMin: P.deltaMin, deltaMax: P.deltaMax });
    }
  });

  it('separates a rule change from an expiry choice', () => {
    // DVN/EOG/COP/MDT shape: the only Δ-band strike sits at 0.38, outside the old 0.25–0.35 and inside 0.20–0.40.
    const deltaCase = [p(95, 1, 1.1, -0.38), p(90, 0.3, 0.4, -0.12)];
    expect(diagnoseLegs(deltaCase, 100, parseLegBand(DELTA_THEN))).toBe('no put in the Δ band');
    expect(diagnoseStoredRejection(deltaCase, 100, DELTA_THEN)).toBe('the widened rules would now build it');

    // CF shape: $5 strikes at ~$120, so the wings sit at 4.17% and 8.33% — neither inside the old 5–7.5%.
    const wingCase = [p(115, 2, 2.2, -0.3), p(110, 0.9, 1.0, -0.18), p(105, 0.4, 0.5, -0.1)];
    expect(diagnoseLegs(wingCase, 120, parseLegBand(WING_THEN))).toBe('no strike in the wing range');
    expect(diagnoseStoredRejection(wingCase, 120, WING_THEN)).toBe('the widened rules would now build it');

    // Legs under BOTH bands: the widening changed nothing, so the expiry really was the choice.
    const bothCase = [p(95, 1, 1.1, -0.3), p(90, 0.3, 0.4, -0.12)];
    expect(diagnoseStoredRejection(bothCase, 100, DELTA_THEN)).toBe('legs present (another expiry was chosen)');

    // A cause that is not about the band is reported as itself, never as a rule change.
    expect(diagnoseStoredRejection([p(95, 1, 1.1, null)], 100, DELTA_THEN)).toBe('chain carried no deltas');
    expect(diagnoseStoredRejection([p(95, 1, 1.1, -0.3), p(90, 0, 0.05, -0.12)], 100, WING_THEN)).toBe('wing strike has no bid');
  });
});

describe('simulateSectorCap — the operator\'s 3-per-sector book (08 S9)', () => {
  const pos = (ticker: string, asOfDate: string, sector: string | null, exit: string | null): ShadowPickRow => ({
    ...PICK, ticker, asOfDate, sector, pool: 'wheel', rank: 1, dte: 30, repeats: 0, sectorCapSkipped: false, affordable: true,
    settlement: exit
      ? { status: 'target', exitDate: exit, exitSlot: 'intraday', exitDebit: 0.8, returnOnMaxLoss: 0.2, daysHeld: 5, marks: 1, gaps: 0 }
      : { status: 'open', marks: 0, gaps: 0, lastMarkDate: null, lastMidDebit: null },
  });

  it('skips the 4th concurrent position in a sector, in entry order, and never pools unknown sectors', () => {
    const book = [
      pos('EOG', '2026-09-14', 'Energy', null),
      pos('APA', '2026-09-14', 'Energy', null),
      pos('DVN', '2026-09-16', 'Energy', null),
      pos('COP', '2026-09-16', 'Energy', null),   // 4th open Energy — skipped
      pos('CRWD', '2026-09-18', 'Information Technology', null),
      pos('X1', '2026-09-18', null, null), pos('X2', '2026-09-18', null, null),
      pos('X3', '2026-09-18', null, null), pos('X4', '2026-09-18', null, null), // unknown: each its own bucket
    ];
    simulateSectorCap(book, 3);
    expect(book.filter(p => p.sectorCapSkipped).map(p => p.ticker)).toEqual(['COP']);
  });

  it('frees a slot once a position has exited — on or before the new entry date', () => {
    const book = [
      pos('EOG', '2026-09-14', 'Energy', '2026-09-20'),  // exits on the 4th entry's date
      pos('APA', '2026-09-14', 'Energy', null),
      pos('DVN', '2026-09-15', 'Energy', null),
      pos('COP', '2026-09-20', 'Energy', null),          // EOG's slot is free
      pos('OXY', '2026-09-21', 'Energy', null),          // 3 open again — skipped
    ];
    simulateSectorCap(book, 3);
    expect(book.map(p => [p.ticker, p.sectorCapSkipped])).toEqual([
      ['EOG', false], ['APA', false], ['DVN', false], ['COP', false], ['OXY', true],
    ]);
  });

  it('a skipped position never occupies a slot', () => {
    const book = [
      pos('A', '2026-09-14', 'Energy', null), pos('B', '2026-09-14', 'Energy', null), pos('C', '2026-09-14', 'Energy', null),
      pos('D', '2026-09-15', 'Energy', null),            // skipped
      pos('E', '2026-09-16', 'Materials', null),
    ];
    simulateSectorCap(book, 3);
    expect(book.map(p => p.sectorCapSkipped)).toEqual([false, false, false, true, false]);
  });
});

describe('reasonKind', () => {
  it('groups rejection reasons by kind', () => {
    expect(reasonKind('net credit $0.03 after fills')).toBe('net credit $# after fills');
    expect(reasonKind('round-trip cost 31% of credit (max 25%)')).toBe('round-trip cost #% of credit (max #%)');
    expect(reasonKind('earnings 2026-10-01 on/before every 21–35 DTE expiry')).toBe('earnings DATE on/before every #–# DTE expiry');
  });
});

// BPS-3: the pool's gate scores a ONE-leg structure, so it never sees the long wing. This check asks
// whether it predicts the spread's own round-trip cost at all. It must be able to come out BOTH ways —
// a check that can only report "flat" would be decoration, the shape of the conviction band that could
// never fire (v1.1.168).
describe('liquidityVsCost — the BPS-3 proxy check (v1.1.303)', () => {
  it('recovers the cost share a rejection kept only in its sentence', () => {
    expect(parseCostShareFromReason('round-trip cost 64% of credit (max 25%)')).toBeCloseTo(0.64, 9);
    expect(parseCostShareFromReason('round-trip cost 7.5% of credit (max 25%)')).toBeCloseTo(0.075, 9);
    expect(parseCostShareFromReason('net credit $0.03 after fills')).toBeNull();
    expect(parseCostShareFromReason('critic flag')).toBeNull();
  });

  it('detects a proxy that WORKS — more liquid really is cheaper', () => {
    const rows = [
      { liquidity: 14, costShare: 0.05 }, { liquidity: 13, costShare: 0.07 },
      { liquidity: 10, costShare: 0.12 }, { liquidity: 9, costShare: 0.15 },
      { liquidity: 6, costShare: 0.40 }, { liquidity: 5, costShare: 0.55 },
    ];
    const r = liquidityVsCost(rows);
    expect(r.paired).toBe(6);
    expect(r.spearman).not.toBeNull();
    expect(r.spearman!).toBeLessThan(-0.9);           // strongly negative = the proxy tracks cost
    expect(r.bands.find(b => b.label === '11–15')!.medianCostShare).toBeLessThan(0.1);
    expect(r.bands.find(b => b.label === '0–6')!.overGate).toBe(2);
  });

  it('detects a proxy that does NOT work — cost is flat across the score', () => {
    const rows = [
      { liquidity: 14, costShare: 0.30 }, { liquidity: 13, costShare: 0.10 },
      { liquidity: 10, costShare: 0.31 }, { liquidity: 9, costShare: 0.09 },
      { liquidity: 6, costShare: 0.29 }, { liquidity: 5, costShare: 0.11 },
    ];
    const r = liquidityVsCost(rows);
    expect(Math.abs(r.spearman!)).toBeLessThan(0.3);   // no relationship where the gate operates
  });

  it('counts rows it cannot pair rather than dropping them, and stays null below 3 pairs', () => {
    const r = liquidityVsCost([
      { liquidity: 10, costShare: 0.1 },
      { liquidity: null, costShare: 0.2 },   // the premium pool has no brief_candidates row
      { liquidity: 8, costShare: null },     // a pick with no cost recorded
    ]);
    expect(r).toMatchObject({ paired: 1, unpaired: 2, spearman: null });
  });
});

describe('buildSpreadShadowReport', () => {
  it('collapses a position picked on several runs into one, settles it, and reports gate progress', () => {
    const db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    const pick = db.prepare(
      `INSERT INTO spread_mode_picks (as_of_date, slot, generated_at, mode, ticker, outcome, rank, reason, expiration, dte, spot,
         short_strike, long_strike, net_credit, max_loss) VALUES (?, ?, 'x', 'shadow', ?, ?, ?, ?, ?, 30, 100, 95, 90, 1.6, 3.4)`,
    );
    pick.run('2026-09-14', 'intraday', 'AAA', 'pick', 1, null, '2026-10-16');
    pick.run('2026-09-14', 'after_close', 'AAA', 'pick', 1, null, '2026-10-16'); // same position
    pick.run('2026-09-15', 'intraday', 'BBB', 'pick', 1, null, '2026-10-16');
    pick.run('2026-09-15', 'intraday', 'CCC', 'rejected', null, 'net credit $0.03 after fills', null);
    pick.run('2026-09-16', 'intraday', 'DDD', 'rejected', null, 'net credit $0.04 after fills', null);

    const cap = db.prepare(
      `INSERT INTO spread_chain_capture (as_of_date, slot, captured_at, ticker, expiration, dte, reason, underlying_price, contract_count, puts_json)
       VALUES (?, ?, 'x', ?, '2026-10-16', 30, 'track', 100, 2, ?)`,
    );
    cap.run('2026-09-17', 'intraday', 'AAA', JSON.stringify([put(90, 0.3, 0.4), put(95, 1.0, 1.2)])); // AAA hits target
    cap.run('2026-09-15', 'intraday', 'ZZZ', JSON.stringify([put(95, 1, 1.1)]));                        // a second capture day

    const r = buildSpreadShadowReport(db, '2026-09-19');
    expect(r.counts).toMatchObject({ pickRows: 3, positions: 2, target: 1, open: 1 });
    expect(r.positions.find(p => p.ticker === 'AAA')?.repeats).toBe(1);
    expect(r.gate).toMatchObject({ intradayCaptureDays: 2, settledPositions: 1, captureDaysMet: false, settledMet: false, meanPositive: true });
    expect(r.rejectionReasons).toEqual([{
      reason: 'net credit $# after fills', n: 2,
      tickers: [{ ticker: 'CCC', n: 1 }, { ticker: 'DDD', n: 1 }],
      pools: [{ pool: 'wheel', n: 2 }], causes: [],
    }]);
    expect(r.runs).toHaveLength(4);
    // Nothing here was cut by the ranking, so the eligible set is just the picks (BPS-10).
    expect(r.runs.every(x => x.eligible === x.picks && x.rankedBelow === 0)).toBe(true);
    // No constituents rows here: both sectors unknown, nothing capped, both books identical.
    expect(r.sectorCap).toMatchObject({ cap: 3, unknownSector: 2, skipped: 0 });
    expect(r.sectorCap.capped).toEqual(r.sectorCap.all);
    // `contracts` is NULL on these rows — written when the budget was still a gate, so they cleared it by
    // definition. A null must read as affordable, not as unaffordable (v1.1.300).
    expect(r.budget).toMatchObject({ maxLossPerPosition: 2500, unaffordable: 0 });
    expect(r.budget.affordable).toEqual(r.sectorCap.all);
    expect(r.positions.every(p => p.affordable)).toBe(true);
    expect(r.concentration).toEqual({ bySector: [{ key: '(unknown)', n: 1 }], byExpiry: [{ key: '2026-10-16', n: 1 }] });
  });

  // 08 S10: a shadow pick the budget could not afford is stored with contracts = 0 rather than rejected,
  // so the report must show both books — the full one is the §4 sample, the affordable one is this account.
  it('reports the affordable book beside the full one, keeping an over-budget pick in the sample (v1.1.300)', () => {
    const db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    const pick = db.prepare(
      `INSERT INTO spread_mode_picks (as_of_date, slot, generated_at, mode, ticker, outcome, rank, reason, expiration, dte, spot,
         short_strike, long_strike, net_credit, max_loss, contracts) VALUES (?, 'intraday', 'x', 'shadow', ?, 'pick', 1, NULL,
         '2026-10-16', 30, 100, 95, 90, 1.6, 3.4, ?)`,
    );
    pick.run('2026-09-14', 'AAA', 2); // affordable
    pick.run('2026-09-15', 'BIG', 0); // one contract cost more than the budget

    const r = buildSpreadShadowReport(db, '2026-09-19');
    expect(r.counts.positions).toBe(2);
    expect(r.budget.unaffordable).toBe(1);
    // The over-budget position stays in the full book — it is evidence about the strategy.
    expect(r.sectorCap.all.positions).toBe(2);
    expect(r.budget.affordable.positions).toBe(1);
    expect(r.positions.find(p => p.ticker === 'BIG')!.affordable).toBe(false);
    expect(r.positions.find(p => p.ticker === 'AAA')!.affordable).toBe(true);
  });

  // 08 S11: wheel and income run as separate books. The comparison only means anything if the two arms
  // cannot contaminate each other — and the same ticker in both is the paired observation, not a repeat.
  it('keeps the two candidate pools as separate books (v1.1.301)', () => {
    const db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    const pick = db.prepare(
      `INSERT INTO spread_mode_picks (as_of_date, slot, generated_at, mode, ticker, outcome, rank, reason, expiration, dte, spot,
         short_strike, long_strike, net_credit, max_loss, contracts, pool) VALUES (?, 'intraday', 'x', 'shadow', ?, 'pick', 1, NULL,
         '2026-10-16', 30, 100, 95, 90, 1.6, 3.4, 2, ?)`,
    );
    pick.run('2026-09-14', 'AAA', 'wheel');
    pick.run('2026-09-14', 'AAA', 'income');  // same name, both screens — a PAIR, not a repeat
    pick.run('2026-09-15', 'BBB', 'income');  // income-only name
    pick.run('2026-09-14', 'CCC', 'premium'); // EVERY arm must have run, or no date is paired at all

    const r = buildSpreadShadowReport(db, '2026-09-19');
    // Four positions: the episode collapse is keyed by pool as well as ticker.
    expect(r.counts.positions).toBe(4);
    expect(r.positions.filter(p => p.ticker === 'AAA').map(p => p.pool).sort()).toEqual(['income', 'wheel']);
    expect(r.positions.every(p => p.repeats === 0)).toBe(true);

    expect(r.pools.gatePool).toBe('wheel');
    expect(r.pools).toMatchObject({ pairedFrom: '2026-09-14', pairedDays: 1 });
    expect(r.pools.books).toEqual([
      { pool: 'wheel', positions: 1, settled: 0, meanReturnOnMaxLoss: null, winRate: null },
      { pool: 'income', positions: 2, settled: 0, meanReturnOnMaxLoss: null, winRate: null },
      { pool: 'premium', positions: 1, settled: 0, meanReturnOnMaxLoss: null, winRate: null },
    ]);
    // Overlap is what EVERY pool picked. AAA is in wheel and income but not premium, so nothing is
    // common to all three — a three-way overlap is a stricter thing than a pairwise one, deliberately:
    // it answers "are the screens choosing the same names", and one arm differing is the answer.
    expect(r.pools.overlap).toBe(0);

    // The gate counts the gate pool ALONE — the challenger must not inflate the §4 sample.
    expect(r.gate.settledPositions).toBe(0);
    expect(r.counts.open).toBe(1);

    // Runs are grouped per pool, or one arm's funnel is unreadable.
    expect(r.runs.filter(x => x.asOfDate === '2026-09-14').map(x => x.pool).sort()).toEqual(['income', 'premium', 'wheel']);
  });

  // The arms start on different days, so the first reports have a full wheel book beside an empty income
  // one. A lifetime comparison there would read as "income is worse" when it simply has not run — the
  // zero-paired-days failure (QC-907), where "no overlap" and "clean overlap" looked identical.
  it('refuses to compare pools that have never run on the same day (v1.1.301)', () => {
    const db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    db.prepare(
      `INSERT INTO spread_mode_picks (as_of_date, slot, generated_at, mode, ticker, outcome, rank, reason, expiration, dte, spot,
         short_strike, long_strike, net_credit, max_loss, contracts, pool) VALUES (?, 'intraday', 'x', 'shadow', ?, 'pick', 1, NULL,
         '2026-10-16', 30, 100, 95, 90, 1.6, 3.4, 2, 'wheel')`,
    ).run('2026-09-14', 'AAA');

    const r = buildSpreadShadowReport(db, '2026-09-19');
    expect(r.pools).toMatchObject({ pairedFrom: null, pairedDays: 0, overlap: 0 });
    // Every book reads empty — the wheel-only day is NOT presented as a one-sided win.
    expect(r.pools.books.every(b => b.positions === 0)).toBe(true);
    // The position itself is still counted everywhere else; only the comparison is withheld.
    expect(r.counts.positions).toBe(1);
  });

  it('reads sectors from constituents and reports the capped book beside the full one', () => {
    const db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    const pick = db.prepare(
      `INSERT INTO spread_mode_picks (as_of_date, slot, generated_at, mode, ticker, outcome, rank, expiration, dte, spot,
         short_strike, long_strike, net_credit, max_loss) VALUES (?, 'intraday', 'x', 'shadow', ?, 'pick', 1, '2026-10-16', 30, 100, 95, 90, 1.6, 3.4)`,
    );
    const sector = db.prepare(`INSERT INTO constituents (ticker, index_name, sector) VALUES (?, 'sp500', ?)`);
    for (const [t, d] of [['EOG', '2026-09-14'], ['APA', '2026-09-14'], ['DVN', '2026-09-16'], ['COP', '2026-09-16']] as const) {
      pick.run(d, t);
      sector.run(t, 'Energy');
    }
    const r = buildSpreadShadowReport(db, '2026-09-19');
    expect(r.positions.filter(p => p.sectorCapSkipped).map(p => p.ticker)).toEqual(['COP']);
    expect(r.sectorCap).toMatchObject({ skipped: 1, unknownSector: 0, all: { positions: 4 }, capped: { positions: 3 } });
    expect(r.concentration.bySector).toEqual([{ key: 'Energy', n: 4 }]);
  });

  it('counts one position per ticker episode: different strikes within 14 days collapse, day 15 is new (v1.1.291)', () => {
    const db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    const pick = db.prepare(
      `INSERT INTO spread_mode_picks (as_of_date, slot, generated_at, mode, ticker, outcome, rank, expiration, dte, spot,
         short_strike, long_strike, net_credit, max_loss) VALUES (?, 'intraday', 'x', 'shadow', 'EOG', 'pick', 1, ?, 30, 150, ?, ?, 2, 8)`,
    );
    pick.run('2026-09-14', '2026-10-16', 145, 135); // kept
    pick.run('2026-09-16', '2026-10-16', 140, 130); // other strikes, 2 days later — the same bet
    pick.run('2026-09-28', '2026-10-30', 140, 130); // 14 days after the kept entry — still the episode
    pick.run('2026-09-29', '2026-10-30', 140, 130); // 15 days — a new position
    const r = buildSpreadShadowReport(db, '2026-09-30');
    expect(r.positions.map(p => [p.asOfDate, p.repeats])).toEqual([['2026-09-14', 2], ['2026-09-29', 0]]);
  });

  it('lists the tickers behind a missing-leg rejection and what their stored chain shows', () => {
    const db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    const rej = db.prepare(
      `INSERT INTO spread_mode_picks (as_of_date, slot, generated_at, mode, ticker, outcome, reason) VALUES ('2026-09-18', 'intraday', 'x', 'shadow', ?, 'rejected', ?)`,
    );
    rej.run('NODELTA', 'no two-sided put at 0.25–0.35Δ');
    rej.run('NOCHAIN', 'no two-sided put at 0.25–0.35Δ');
    rej.run('ZEROBID', 'no two-sided long put 5–7.5% of spot below the short strike');
    const cap = db.prepare(
      `INSERT INTO spread_chain_capture (as_of_date, slot, captured_at, ticker, expiration, dte, reason, underlying_price, contract_count, puts_json)
       VALUES ('2026-09-18', 'intraday', 'x', ?, ?, ?, 'entry', 100, 2, ?)`,
    );
    cap.run('NODELTA', '2026-10-16', 28, JSON.stringify([[95, 1, 1.1, null, null, 1, 1], [90, 0.5, 0.6, null, null, 1, 1]]));
    cap.run('ZEROBID', '2026-10-16', 28, JSON.stringify([[95, 1, 1.1, -0.3, 40, 1, 1], [90, 0, 0.05, -0.08, 40, 1, 1]]));
    cap.run('ZEROBID', '2026-11-20', 63, JSON.stringify([[95, 2, 2.1, -0.3, 40, 1, 1], [90, 1, 1.1, -0.2, 40, 1, 1]])); // out of window
    const byReason = Object.fromEntries(buildSpreadShadowReport(db, '2026-09-19').rejectionReasons.map(x => [x.reason, x]));
    expect(byReason['no two-sided put at #–#Δ']).toMatchObject({
      n: 2, causes: expect.arrayContaining([{ cause: 'chain carried no deltas', n: 1 }, { cause: 'no chain stored', n: 1 }]),
    });
    expect(byReason['no two-sided long put #–#% of spot below the short strike']).toMatchObject({
      tickers: [{ ticker: 'ZEROBID', n: 1 }], causes: [{ cause: 'wing strike has no bid', n: 1 }],
    });
  });

  it('settles an expired position on the stored close, falling back to the last session before a holiday expiry', () => {
    const db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    db.prepare(
      `INSERT INTO spread_mode_picks (as_of_date, slot, generated_at, mode, ticker, outcome, rank, expiration, dte, spot,
         short_strike, long_strike, net_credit, max_loss) VALUES ('2026-09-14', 'intraday', 'x', 'shadow', 'AAA', 'pick', 1, '2026-10-16', 30, 100, 95, 90, 1.6, 3.4)`,
    ).run();
    db.prepare(`INSERT INTO historical_prices (ticker, date, open, high, low, close, volume) VALUES ('AAA', '2026-10-15', 93, 93, 93, 93, 1)`).run();
    const r = buildSpreadShadowReport(db, '2026-10-19');
    expect(r.positions[0]!.settlement).toMatchObject({ status: 'expired', expiryClose: 93, exitDebit: 2 });
  });

  // BPS-10 (v1.1.310). The ranking can only matter on a run where more candidates reached it than there
  // are slots. The wheel tiebreak was studied before anyone counted that it faced a choice on 7 of 62
  // days — so the count comes first, and it has to separate "reached the cut" from "was cut by it".
  describe('eligible-set size — does the top-N cut face a choice? (BPS-10)', () => {
    const seed = (db: ReturnType<typeof openDatabase>) => db.prepare(
      `INSERT INTO spread_mode_picks (as_of_date, slot, generated_at, mode, ticker, outcome, rank, reason, expiration, dte, spot,
         short_strike, long_strike, net_credit, max_loss, contracts, pool) VALUES (?, ?, 'x', 'shadow', ?, ?, NULL, ?,
         '2026-10-16', 30, 100, 95, 90, 1.6, 3.4, 2, ?)`,
    );

    it('counts only the candidates that reached the ranking, not every rejection', () => {
      const db = openDatabase(':memory:');
      runMigrations(db, MIGRATIONS_DIR);
      const p = seed(db);
      // One run: 5 picks, 1 cut by the ranking, 4 refused upstream. Eligible is 6, never 10.
      for (const t of ['A1', 'A2', 'A3', 'A4', 'A5']) p.run('2026-09-21', 'intraday', t, 'pick', null, 'premium');
      p.run('2026-09-21', 'intraday', 'A6', 'rejected', 'ranked below the top 5', 'premium');
      for (const t of ['B1', 'B2', 'B3', 'B4']) {
        p.run('2026-09-21', 'intraday', t, 'rejected', 'round-trip cost 60% of credit (max 25%)', 'premium');
      }

      const r = buildSpreadShadowReport(db, '2026-09-22');
      const run = r.runs.find(x => x.pool === 'premium')!;
      expect(run).toMatchObject({ picks: 5, rejected: 5, eligible: 6, rankedBelow: 1 });

      const e = r.eligibility.find(x => x.pool === 'premium')!;
      expect(e).toMatchObject({ topN: 5, runs: 1, binding: 1, droppedTotal: 1, medianEligible: 6, maxEligible: 6 });
      expect(e.histogram).toEqual([{ size: 6, runs: 1 }]);
    });

    // The half that matters: a pool can fill all five slots every run and still never have made a choice.
    // If that read as "binding" the check would be the liquidity gate that always fired.
    it('does not call the cut binding on a run where nothing was cut', () => {
      const db = openDatabase(':memory:');
      runMigrations(db, MIGRATIONS_DIR);
      const p = seed(db);
      for (const t of ['A1', 'A2', 'A3', 'A4', 'A5']) p.run('2026-09-21', 'intraday', t, 'pick', null, 'wheel');
      p.run('2026-09-21', 'intraday', 'B1', 'rejected', 'critic flag', 'wheel');

      const e = buildSpreadShadowReport(db, '2026-09-22').eligibility.find(x => x.pool === 'wheel')!;
      expect(e).toMatchObject({ runs: 1, binding: 0, droppedTotal: 0, maxEligible: 5 });
    });

    // BPS-1: an arm that picks nothing is a real finding about the arm, and summing the pools hides it.
    it('splits a rejection reason by pool, so an arm that refuses everything is visible', () => {
      const db = openDatabase(':memory:');
      runMigrations(db, MIGRATIONS_DIR);
      const p = seed(db);
      p.run('2026-09-21', 'intraday', 'AAA', 'pick', null, 'wheel');
      p.run('2026-09-21', 'intraday', 'CCC', 'rejected', 'critic flag', 'wheel');
      for (const t of ['D1', 'D2', 'D3']) p.run('2026-09-21', 'intraday', t, 'rejected', 'critic flag', 'income');

      const r = buildSpreadShadowReport(db, '2026-09-22');
      expect(r.rejectionReasons.find(x => x.reason === 'critic flag')!.pools)
        .toEqual([{ pool: 'wheel', n: 1 }, { pool: 'income', n: 3 }]);
      // The empty arm still gets a row — "ran and picked nothing" must not look like "never ran".
      expect(r.eligibility.find(x => x.pool === 'income')).toMatchObject({ runs: 1, maxEligible: 0 });
      expect(r.eligibility.find(x => x.pool === 'premium')).toMatchObject({ runs: 0, medianEligible: null });
    });
  });
});
