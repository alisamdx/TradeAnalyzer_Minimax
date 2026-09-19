// Bull put spread shadow settlement (08 §4.2) — the rules the enable gate is judged on.
import { describe, it, expect } from 'vitest';
import {
  settleSpreadPick, buildSpreadShadowReport, reasonKind, type ShadowPick, type ShadowMark,
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
    expect(r.rejectionReasons).toEqual([{ reason: 'net credit $# after fills', n: 2 }]);
    expect(r.runs).toHaveLength(4);
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
