// Bull put spread mode — settling shadow picks forward on their own captured quotes (08 §4.2).
//
// The enable gate needs "≥ 30 shadow picks settled with a positive mean return on max loss after
// modelled fills". Nothing computed that until v1.1.290. This does, read-only, from:
//   spread_mode_picks     — the pick, its strikes and its net credit after fills
//   spread_chain_capture  — later quotes of the same ticker+expiry (any reason), both legs
//   historical_prices     — the close on expiry, for a pick that never reached its target
//
// Rules, the same as the #43 study and 08 §3.7:
//   • TARGET — the first mark strictly after the entry (date, then slot) whose MID debit to close is
//     ≤ 50% of the net credit. The exit is DECIDED on mid and REALISED with options-fill.ts fills, so
//     a wide quote cannot trigger a target it could not be filled at, nor hide its cost.
//   • EXPIRY — no target by expiry: settled at intrinsic on the expiry-day close, no closing cost.
//   • No loss stop, no time stop.
// Outcomes are never stored (migration 084): recomputed each read, so a split repair corrects them.
//
// De-biasing (CLAUDE.md): picks of one ticker within 14 days of its last kept entry are ONE position — the gate
// counts positions, first entry kept; a close on expiry that is < 0.5× or > 2× the entry spot is not
// settled (a split between entry and expiry would manufacture the result) but listed for a look.
//
// see docs/formulas.md#bull-put-spread-mode

import type { DbHandle } from '../db/connection.js';
import type { CapturedPut } from './spread-chain-capture.js';
import { fillPrice } from './options-fill.js';
import { SPREAD_MODE_PROFILE as P } from '@shared/spread-mode.js';

/** 08 §4 thresholds. */
export const SPREAD_ENABLE_GATE = {
  minIntradayCaptureDays: 15,
  minSettledPositions: 30,
} as const;

/** Picks of one ticker within this many calendar days of its last kept entry are one position (#43 study). */
export const EPISODE_DAYS = 14;

/** Close-on-expiry vs entry spot outside this band is treated as a possible split. */
const SCALE_BAND = { min: 0.5, max: 2 } as const;

export interface ShadowPick {
  id: number;
  asOfDate: string;
  slot: 'intraday' | 'after_close';
  ticker: string;
  expiration: string;
  spot: number;
  shortStrike: number;
  longStrike: number;
  netCredit: number;
  maxLoss: number;
}

export interface ShadowMark {
  asOfDate: string;
  slot: 'intraday' | 'after_close';
  puts: CapturedPut[];
}

export type SpreadSettlement =
  | { status: 'open'; marks: number; gaps: number; lastMarkDate: string | null; lastMidDebit: number | null }
  | { status: 'target'; exitDate: string; exitSlot: string; exitDebit: number; returnOnMaxLoss: number; daysHeld: number; marks: number; gaps: number }
  | { status: 'expired'; exitDate: string; expiryClose: number; exitDebit: number; returnOnMaxLoss: number; daysHeld: number; marks: number; gaps: number }
  | { status: 'unsettleable'; reason: string; marks: number; gaps: number };

const slotOrder = (s: string): number => (s === 'intraday' ? 0 : 1);
const after = (a: { asOfDate: string; slot: string }, b: { asOfDate: string; slot: string }): boolean =>
  a.asOfDate > b.asOfDate || (a.asOfDate === b.asOfDate && slotOrder(a.slot) > slotOrder(b.slot));
const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/** A leg with a usable quote: an ask, and a bid that does not cross it. A 0 bid is a real quote on a far wing. */
function leg(puts: readonly CapturedPut[], strike: number): { bid: number; ask: number } | null {
  const p = puts.find(x => Math.abs(x[0] - strike) < 1e-6);
  if (!p || !(p[2] > 0) || !(p[1] >= 0) || p[1] > p[2]) return null;
  return { bid: p[1], ask: p[2] };
}

/**
 * Settle one pick. `marks` may be in any order and may include marks at or before the entry (ignored).
 * `expiryClose` is the underlying's close on the expiry date, or null if not stored yet.
 */
export function settleSpreadPick(
  pick: ShadowPick,
  marks: readonly ShadowMark[],
  expiryClose: number | null,
  todayEt: string,
): SpreadSettlement {
  const takeProfitDebit = pick.netCredit * P.takeProfitAtDebitFraction;
  const later = marks
    .filter(m => after(m, pick) && m.asOfDate <= pick.expiration)
    .sort((a, b) => a.asOfDate.localeCompare(b.asOfDate) || slotOrder(a.slot) - slotOrder(b.slot));

  let gaps = 0, used = 0;
  let lastMarkDate: string | null = null, lastMidDebit: number | null = null;
  for (const m of later) {
    const s = leg(m.puts, pick.shortStrike), l = leg(m.puts, pick.longStrike);
    if (!s || !l) { gaps++; continue; }
    used++;
    const midDebit = (s.bid + s.ask) / 2 - (l.bid + l.ask) / 2;
    lastMarkDate = m.asOfDate; lastMidDebit = midDebit;
    if (midDebit <= takeProfitDebit) {
      const exitDebit = fillPrice(s.bid, s.ask, 'buy') - fillPrice(l.bid, l.ask, 'sell');
      return {
        status: 'target', exitDate: m.asOfDate, exitSlot: m.slot, exitDebit,
        returnOnMaxLoss: (pick.netCredit - exitDebit) / pick.maxLoss,
        daysHeld: daysBetween(pick.asOfDate, m.asOfDate), marks: used, gaps,
      };
    }
  }

  // Settled at expiry only once the expiry session is over — the close must exist.
  if (todayEt <= pick.expiration || expiryClose == null) {
    if (todayEt > pick.expiration) return { status: 'unsettleable', reason: 'no close stored for the expiry date', marks: used, gaps };
    return { status: 'open', marks: used, gaps, lastMarkDate, lastMidDebit };
  }
  const ratio = expiryClose / pick.spot;
  if (ratio < SCALE_BAND.min || ratio > SCALE_BAND.max) {
    return {
      status: 'unsettleable', marks: used, gaps,
      reason: `expiry close ${expiryClose} is ${ratio.toFixed(2)}× the entry spot ${pick.spot} — possible split, check before settling`,
    };
  }
  const exitDebit = Math.max(0, pick.shortStrike - expiryClose) - Math.max(0, pick.longStrike - expiryClose);
  return {
    status: 'expired', exitDate: pick.expiration, expiryClose, exitDebit,
    returnOnMaxLoss: (pick.netCredit - exitDebit) / pick.maxLoss,
    daysHeld: daysBetween(pick.asOfDate, pick.expiration), marks: used, gaps,
  };
}

export interface ShadowPickRow extends ShadowPick {
  rank: number | null;
  dte: number | null;
  /** Later picks of the same ticker within EPISODE_DAYS of this entry, collapsed into it. */
  repeats: number;
  settlement: SpreadSettlement;
}

export interface SpreadShadowReport {
  asOf: string;
  gate: {
    intradayCaptureDays: number;
    intradayCaptureDaysNeeded: number;
    settledPositions: number;
    settledPositionsNeeded: number;
    meanReturnOnMaxLoss: number | null;
    captureDaysMet: boolean;
    settledMet: boolean;
    meanPositive: boolean | null;
  };
  counts: { pickRows: number; positions: number; open: number; target: number; expired: number; unsettleable: number };
  winRate: number | null;
  medianDaysHeld: number | null;
  runs: Array<{ asOfDate: string; slot: string; picks: number; rejected: number }>;
  rejectionReasons: Array<{
    reason: string;
    n: number;
    tickers: Array<{ ticker: string; n: number }>;
    /** Only for the two missing-leg reasons: what the stored chain shows. */
    causes: Array<{ cause: LegCause; n: number }>;
  }>;
  positions: ShadowPickRow[];
}

export type LegCause =
  | 'no chain stored'
  | 'no underlying price'
  | 'chain carried no deltas'
  | 'no put in the Δ band'
  | 'Δ-band put not two-sided'
  | 'no strike in the wing range'
  | 'wing strike has no bid'
  | 'legs present (another expiry was chosen)';

/**
 * Why a chain yields no spread, mirroring `buildBullPutSpread`'s leg rules. "chain carried no deltas" is
 * the stale-Greeks guard (v1.1.255 withholds deltas on a chain whose Greeks disagree with its prices) or
 * E*Trade not sending them; "wing strike has no bid" is a far put quoted 0 bid, which the two-sided rule
 * refuses. see spread-mode.ts
 */
export function diagnoseLegs(puts: readonly CapturedPut[], spot: number | null): LegCause {
  if (spot == null || !(spot > 0)) return 'no underlying price';
  if (!puts.some(p => p[3] != null)) return 'chain carried no deltas';
  const twoSided = (p: CapturedPut): boolean => p[1] > 0 && p[2] >= p[1];
  const inBand = puts.filter(p => p[3] != null && Math.abs(p[3]) >= P.deltaMin && Math.abs(p[3]) <= P.deltaMax);
  if (inBand.length === 0) return 'no put in the Δ band';
  const shorts = inBand.filter(twoSided)
    .sort((a, b) => Math.abs(Math.abs(a[3]!) - P.deltaTarget) - Math.abs(Math.abs(b[3]!) - P.deltaTarget) || a[0] - b[0]);
  const short = shorts[0];
  if (!short) return 'Δ-band put not two-sided';
  const eps = 1e-9;
  const wing = puts.filter(p => {
    if (p[0] >= short[0]) return false;
    const w = (short[0] - p[0]) / spot;
    return w >= P.wingMinPct - eps && w <= P.wingMaxPct + eps;
  });
  if (wing.length === 0) return 'no strike in the wing range';
  if (!wing.some(twoSided)) return 'wing strike has no bid';
  return 'legs present (another expiry was chosen)';
}

/** "net credit $0.03 after fills" → "net credit $# after fills" — so reasons group by kind. */
export function reasonKind(reason: string): string {
  return reason.replace(/\d{4}-\d{2}-\d{2}/g, 'DATE')
    .replace(/\$?\d+(?:\.\d+)?%?/g, (m) => (m.startsWith('$') ? '$#' : m.endsWith('%') ? '#%' : '#'));
}

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** Read-only: every shadow pick settled as of `todayEt`, plus progress against the 08 §4 gate. */
export function buildSpreadShadowReport(db: DbHandle, todayEt: string): SpreadShadowReport {
  const rows = db.prepare(
    `SELECT id, as_of_date, slot, ticker, rank, expiration, dte, spot, short_strike, long_strike, net_credit, max_loss
       FROM spread_mode_picks
      WHERE outcome = 'pick' AND expiration IS NOT NULL AND short_strike IS NOT NULL AND long_strike IS NOT NULL
        AND net_credit IS NOT NULL AND max_loss > 0 AND spot > 0
      ORDER BY as_of_date, CASE slot WHEN 'intraday' THEN 0 ELSE 1 END, rank`,
  ).all() as Array<{
    id: number; as_of_date: string; slot: 'intraday' | 'after_close'; ticker: string; rank: number | null;
    expiration: string; dte: number | null; spot: number; short_strike: number; long_strike: number;
    net_credit: number; max_loss: number;
  }>;

  // One position per ticker episode, the #43 study's rule: a pick of a ticker within EPISODE_DAYS of that
  // ticker's last KEPT entry is a repeat, whatever its strikes or expiry — a second EOG spread two days
  // after the first is the same bet, and counting it twice inflates the gate's n with one risk (v1.1.291).
  // The first entry is the one that would have been placed. `rows` is in (date, slot, rank) order.
  const positions = new Map<number, ShadowPickRow>();
  const lastKept = new Map<string, ShadowPickRow>();
  for (const r of rows) {
    const kept = lastKept.get(r.ticker);
    if (kept && daysBetween(kept.asOfDate, r.as_of_date) <= EPISODE_DAYS) { kept.repeats++; continue; }
    const position: ShadowPickRow = {
      id: r.id, asOfDate: r.as_of_date, slot: r.slot, ticker: r.ticker, expiration: r.expiration, spot: r.spot,
      shortStrike: r.short_strike, longStrike: r.long_strike, netCredit: r.net_credit, maxLoss: r.max_loss,
      rank: r.rank, dte: r.dte, repeats: 0, settlement: { status: 'open', marks: 0, gaps: 0, lastMarkDate: null, lastMidDebit: null },
    };
    positions.set(r.id, position);
    lastKept.set(r.ticker, position);
  }

  const marksStmt = db.prepare(
    `SELECT as_of_date, slot, puts_json FROM spread_chain_capture WHERE ticker = ? AND expiration = ? AND as_of_date >= ?`,
  );
  const closeStmt = db.prepare(
    `SELECT close FROM historical_prices WHERE ticker = ? AND date <= ? AND date >= ? ORDER BY date DESC LIMIT 1`,
  );
  for (const p of positions.values()) {
    const marks: ShadowMark[] = [];
    for (const m of marksStmt.all(p.ticker, p.expiration, p.asOfDate) as Array<{ as_of_date: string; slot: 'intraday' | 'after_close'; puts_json: string }>) {
      try { marks.push({ asOfDate: m.as_of_date, slot: m.slot, puts: JSON.parse(m.puts_json) as CapturedPut[] }); } catch { /* an unreadable mark is a gap */ }
    }
    // A holiday expiry settles on the last session before it (at most four days back).
    const floor = new Date(Date.parse(`${p.expiration}T00:00:00Z`) - 4 * 86_400_000).toISOString().slice(0, 10);
    const close = (closeStmt.get(p.ticker, p.expiration, floor) as { close: number } | undefined)?.close ?? null;
    p.settlement = settleSpreadPick(p, marks, close, todayEt);
  }

  const list = [...positions.values()];
  const settled = list.filter(p => p.settlement.status === 'target' || p.settlement.status === 'expired');
  const returns = settled.map(p => (p.settlement as { returnOnMaxLoss: number }).returnOnMaxLoss);
  const mean = returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : null;
  const count = (s: SpreadSettlement['status']) => list.filter(p => p.settlement.status === s).length;

  const intradayCaptureDays = (db.prepare(
    `SELECT COUNT(DISTINCT as_of_date) AS n FROM spread_chain_capture WHERE slot = 'intraday'`,
  ).get() as { n: number }).n;

  const runs = db.prepare(
    `SELECT as_of_date, slot, SUM(outcome = 'pick') AS picks, SUM(outcome = 'rejected') AS rejected
       FROM spread_mode_picks GROUP BY as_of_date, slot
      ORDER BY as_of_date, CASE slot WHEN 'intraday' THEN 0 ELSE 1 END`,
  ).all() as Array<{ as_of_date: string; slot: string; picks: number; rejected: number }>;

  // Rejections by kind, with the tickers behind each, and — for a missing leg — what the stored chain says
  // caused it (v1.1.291). The chain examined is that run's captured entry chain nearest 30 DTE in the window.
  const chainStmt = db.prepare(
    `SELECT dte, underlying_price, puts_json FROM spread_chain_capture
      WHERE as_of_date = ? AND slot = ? AND ticker = ? AND dte BETWEEN ? AND ?`,
  );
  const kinds = new Map<string, { n: number; tickers: Map<string, number>; causes: Map<LegCause, number> }>();
  for (const r of db.prepare(
    `SELECT as_of_date, slot, ticker, reason FROM spread_mode_picks WHERE outcome = 'rejected' AND reason IS NOT NULL`,
  ).all() as Array<{ as_of_date: string; slot: string; ticker: string; reason: string }>) {
    const k = reasonKind(r.reason);
    const e = kinds.get(k) ?? { n: 0, tickers: new Map<string, number>(), causes: new Map<LegCause, number>() };
    e.n++;
    e.tickers.set(r.ticker, (e.tickers.get(r.ticker) ?? 0) + 1);
    if (r.reason.startsWith('no two-sided')) {
      const chains = chainStmt.all(r.as_of_date, r.slot, r.ticker, P.dteMin, P.dteMax) as Array<{ dte: number; underlying_price: number | null; puts_json: string }>;
      const chain = chains.sort((a, b) => Math.abs(a.dte - P.dteTarget) - Math.abs(b.dte - P.dteTarget) || a.dte - b.dte)[0];
      let cause: LegCause = 'no chain stored';
      if (chain) {
        try { cause = diagnoseLegs(JSON.parse(chain.puts_json) as CapturedPut[], chain.underlying_price); } catch { /* stays 'no chain stored' */ }
      }
      e.causes.set(cause, (e.causes.get(cause) ?? 0) + 1);
    }
    kinds.set(k, e);
  }

  return {
    asOf: todayEt,
    gate: {
      intradayCaptureDays,
      intradayCaptureDaysNeeded: SPREAD_ENABLE_GATE.minIntradayCaptureDays,
      settledPositions: settled.length,
      settledPositionsNeeded: SPREAD_ENABLE_GATE.minSettledPositions,
      meanReturnOnMaxLoss: mean,
      captureDaysMet: intradayCaptureDays >= SPREAD_ENABLE_GATE.minIntradayCaptureDays,
      settledMet: settled.length >= SPREAD_ENABLE_GATE.minSettledPositions,
      meanPositive: mean == null ? null : mean > 0,
    },
    counts: {
      pickRows: rows.length, positions: list.length,
      open: count('open'), target: count('target'), expired: count('expired'), unsettleable: count('unsettleable'),
    },
    winRate: returns.length ? returns.filter(r => r > 0).length / returns.length : null,
    medianDaysHeld: median(settled.map(p => (p.settlement as { daysHeld: number }).daysHeld)),
    runs: runs.map(r => ({ asOfDate: r.as_of_date, slot: r.slot, picks: r.picks, rejected: r.rejected })),
    rejectionReasons: [...kinds]
      .map(([reason, e]) => ({
        reason, n: e.n,
        tickers: [...e.tickers].map(([ticker, n]) => ({ ticker, n })).sort((a, b) => b.n - a.n || a.ticker.localeCompare(b.ticker)),
        causes: [...e.causes].map(([cause, n]) => ({ cause, n })).sort((a, b) => b.n - a.n),
      }))
      .sort((a, b) => b.n - a.n),
    positions: list,
  };
}
