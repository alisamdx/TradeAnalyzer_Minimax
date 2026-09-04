// How much of the operator's capital is working, and how much is sitting idle.
//
// The question that prompted this: "I am not fully utilizing my money, it's idle — that's a waste
// of resource." The app could not answer it. Searched 2026-09-03, no table in the schema held a
// cash, buying-power or net-liquidation figure at all.
//
// SCOPE, as decided by the operator: available cash is E*Trade only, and committed capital is the
// discretionary wheel book only — not the v2 execution broker, whose sizing rules are separate and
// which would make a blended number misleading.
//
// THE ARITHMETIC TRAP THIS FILE EXISTS TO AVOID. E*Trade already withholds cash-secured put
// collateral from `cashAvailableForInvestment`. Available and committed are therefore
// COMPLEMENTARY, not overlapping:
//
//     total = available + committed          utilisation = committed / total
//
// Computing idle as `available − committed` would subtract the same collateral twice and report a
// wheel book as far emptier than it is. `available` IS the idle figure, directly.
//
// THE OTHER DOUBLE-COUNT: a covered call commits no capital of its own — the shares backing it are
// already counted as stock. Its market value is NEGATIVE (a short option liability), so adding it
// would understate committed twice over. `CC` contributes zero here, deliberately.
//
// see migrations/078_account_balances.sql

import type { DbHandle } from '../db/connection.js';

/** One open position, narrowed to what committed capital needs. */
export interface OpenPositionLike {
  ticker: string;
  positionType: string;          // 'Stock' | 'CSP' | 'CC' | 'Long Call' | 'Long Put'
  quantity: number | null;
  entryPrice: number | null;
  strikePrice: number | null;
  marketValue: number | null;
}

export interface CommittedBreakdown {
  /** Cash-secured put collateral: strike x 100 x contracts. */
  csp: number;
  /** Stock at market where known, else at cost. */
  stock: number;
  /** Debit paid for long options. */
  longOptions: number;
  total: number;
  /** Positions whose type this function does not recognise — surfaced, never silently zeroed. */
  unclassified: string[];
}

/**
 * Capital committed by the open discretionary book.
 *
 * Stock is valued at MARKET where available rather than at cost: the question is how much capital
 * is currently tied up, and that is what the position is worth now, not what it cost. Cost is the
 * fallback so a position with no mark still counts for something rather than vanishing.
 */
export function computeCommitted(positions: readonly OpenPositionLike[]): CommittedBreakdown {
  let csp = 0, stock = 0, longOptions = 0;
  const unclassified: string[] = [];

  for (const p of positions) {
    const qty = p.quantity ?? 0;
    const type = (p.positionType ?? '').trim().toUpperCase();

    if (type === 'CSP') {
      // Collateral is the strike, not the premium — this is what the broker withholds.
      if (p.strikePrice != null) csp += p.strikePrice * 100 * Math.abs(qty);
      continue;
    }
    if (type === 'STOCK') {
      const mv = p.marketValue;
      if (mv != null && mv !== 0) stock += Math.abs(mv);
      else if (p.entryPrice != null) stock += p.entryPrice * Math.abs(qty);
      continue;
    }
    if (type === 'CC') {
      // Commits nothing: the shares are already counted above, and its market value is a
      // negative liability. Adding it would double-count in the wrong direction.
      continue;
    }
    if (type === 'LONG CALL' || type === 'LONG PUT') {
      if (p.entryPrice != null) longOptions += p.entryPrice * 100 * Math.abs(qty);
      continue;
    }
    unclassified.push(`${p.ticker}:${p.positionType}`);
  }

  return { csp, stock, longOptions, total: csp + stock + longOptions, unclassified };
}

export interface CapitalUtilisation {
  /** Cash deployable right now, straight from E*Trade. Null when no balance has been fetched. */
  available: number | null;
  committed: CommittedBreakdown;
  /** available + committed. Null when there is no balance to add. */
  total: number | null;
  /** committed / total, as a percentage. Null when total is unknown or zero. */
  utilisationPct: number | null;
  /** As-of date of the balance snapshot, and how stale it is in days. */
  balanceAsOf: string | null;
  balanceAgeDays: number | null;
  /** Consecutive days, ending at the latest snapshot, where available cash never fell.
   *  A crude but honest answer to "how long has this been sitting there". */
  idleStreakDays: number | null;
}

/**
 * Read the current picture: latest balance snapshot + committed capital from the open book.
 *
 * Never throws — this is a reporting surface, and a missing balance is a normal state (nothing has
 * been fetched yet) rather than an error.
 */
export function getCapitalUtilisation(db: DbHandle, todayEt: string): CapitalUtilisation {
  const empty: CapitalUtilisation = {
    available: null,
    committed: { csp: 0, stock: 0, longOptions: 0, total: 0, unclassified: [] },
    total: null, utilisationPct: null, balanceAsOf: null, balanceAgeDays: null,
    idleStreakDays: null,
  };
  try {
    const rows = db.prepare(`
      SELECT ticker, position_type, quantity, entry_price, strike_price, market_value
      FROM positions WHERE status = 'open'
    `).all() as Array<{
      ticker: string; position_type: string; quantity: number | null;
      entry_price: number | null; strike_price: number | null; market_value: number | null;
    }>;
    const committed = computeCommitted(rows.map(r => ({
      ticker: r.ticker, positionType: r.position_type, quantity: r.quantity,
      entryPrice: r.entry_price, strikePrice: r.strike_price, marketValue: r.market_value,
    })));

    // Latest snapshot across accounts. Scope is E*Trade-only and there is one account, but sum
    // rather than pick-one so a second account does not silently disappear.
    const latest = db.prepare(
      'SELECT MAX(as_of_date) d FROM account_balances').get() as { d: string | null };
    if (!latest?.d) return { ...empty, committed };

    const bal = db.prepare(`
      SELECT SUM(cash_available) avail FROM account_balances WHERE as_of_date = ?
    `).get(latest.d) as { avail: number | null };
    const available = bal?.avail ?? null;

    const total = available == null ? null : available + committed.total;
    const ageDays = Math.round(
      (Date.parse(`${todayEt}T00:00:00Z`) - Date.parse(`${latest.d}T00:00:00Z`)) / 86_400_000);

    // Idle streak: walk back while available cash never DROPS. A drop means capital was
    // deployed, which is the event that ends a stretch of sitting still.
    const series = db.prepare(`
      SELECT as_of_date, SUM(cash_available) avail FROM account_balances
      GROUP BY as_of_date ORDER BY as_of_date DESC LIMIT 400
    `).all() as Array<{ as_of_date: string; avail: number | null }>;
    let streak: number | null = null;
    if (series.length > 0 && series[0]!.avail != null) {
      streak = 1;
      for (let i = 1; i < series.length; i++) {
        const cur = series[i - 1]!.avail, prev = series[i]!.avail;
        if (cur == null || prev == null || cur < prev) break;   // cash went to work
        streak++;
      }
    }

    return {
      available,
      committed,
      total,
      utilisationPct: total && total > 0 ? (committed.total / total) * 100 : null,
      balanceAsOf: latest.d,
      balanceAgeDays: ageDays,
      idleStreakDays: streak,
    };
  } catch (err) {
    console.warn('[capital] utilisation read failed:',
      err instanceof Error ? err.message : String(err));
    return empty;
  }
}
