// Bull put spread shadow settlement (08 §4.2) — the rules the enable gate is judged on.
import { describe, it, expect } from 'vitest';
import {
  settleSpreadPick, buildSpreadShadowReport, reasonKind, diagnoseLegs, type ShadowPick, type ShadowMark,
} from '../src/main/services/spread-mode-settle.js';
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

describe('reasonKind', () => {
  it('groups rejection reasons by kind', () => {
    expect(reasonKind('net credit $0.03 after fills')).toBe('net credit $# after fills');
    expect(reasonKind('round-trip cost 31% of credit (max 25%)')).toBe('round-trip cost #% of credit (max #%)');
    expect(reasonKind('earnings 2026-10-01 on/before every 21–35 DTE expiry')).toBe('earnings DATE on/before every #–# DTE expiry');
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
      tickers: [{ ticker: 'CCC', n: 1 }, { ticker: 'DDD', n: 1 }], causes: [],
    }]);
    expect(r.runs).toHaveLength(4);
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
});
