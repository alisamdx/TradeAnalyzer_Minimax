// Which tickers a bull put spread candidate pool contains — the ONE function every caller uses.
//
// There are two callers and they must not disagree: `spread-chain-capture.ts` decides whose chains get
// fetched, and `spread-mode.ts` decides whose spreads get built. If capture misses a pool's tickers, that
// pool silently produces nothing and looks like a strategy with no candidates rather than a plumbing gap.
// This project has been bitten four times by a capability that lived in each call site instead of the
// function they all call (the portfolio cash snapshot, the E*Trade OAuth transport, the earnings write,
// the dev scripts' four refusals), so the resolution lives here once.
//
// `wheel` and `income` are brief strategies: the latest run's validated candidates.
// `premium` is NOT a strategy (08 S12, v1.1.302) — it is the whole universe ranked by annualized premium
// return, read from `analysis_snapshots`, which `DailyOptionsSnapshotJob` already fills nightly with a
// live E*Trade chain for ~1,100 tickers. So the pool costs no new market-data calls of its own; only the
// spread chain capture for its tickers is new.
//
// see NewApp/requirements/08-bull-put-spread-mode.md §3.1, docs/wheel-parameters.md T7

import type { DbHandle } from '../db/connection.js';
import { PREMIUM_POOL, type SpreadPool } from '@shared/spread-mode.js';

/** One universe row as `analysis-service` writes it into `analysis_snapshots.payload_json`. */
interface SnapshotRow {
  ticker?: string;
  annualizedReturn?: number | null;
  optionLiquidityScore?: number | null;
  lastPrice?: number | null;
  recommendedStrike?: number | null;
}

/**
 * The tickers in `pool` for the latest data available, in a stable order.
 *
 * Never throws: an unreadable payload or a missing table yields an empty pool, which reads downstream as
 * "no candidates today" — the same as a genuinely empty screen. A throw here would take down the brief's
 * chain capture, which is a far worse outcome than one quiet arm.
 */
export function resolvePoolTickers(db: DbHandle, pool: SpreadPool): string[] {
  try {
    if (pool === 'premium') return premiumPoolTickers(db);
    return strategyPoolTickers(db, pool);
  } catch {
    return [];
  }
}

/** A brief strategy's validated candidates: `picked` (the shown 5) plus `capped_out` (liquid but outranked). */
function strategyPoolTickers(db: DbHandle, strategy: string): string[] {
  const latest = db.prepare(
    `SELECT generated_at FROM brief_candidates WHERE strategy = ? ORDER BY generated_at DESC LIMIT 1`,
  ).get(strategy) as { generated_at: string } | undefined;
  if (!latest) return [];
  return (db.prepare(
    `SELECT DISTINCT ticker FROM brief_candidates
      WHERE generated_at = ? AND strategy = ? AND disposition IN ('picked', 'capped_out')
      ORDER BY ticker`,
  ).all(latest.generated_at, strategy) as Array<{ ticker: string }>).map(r => r.ticker);
}

/**
 * The whole universe ranked by annualized premium return, gated on liquidity and price so the three pools
 * face the same universe.
 *
 * The snapshot is one JSON blob per run, overwritten in place, so the LATEST run is read — the same
 * "later run wins" rule `fr-spread-pool-selection-study.mjs` and the T5/T6 harnesses use. A row without a
 * usable annualized return is skipped rather than sorted as zero: absent is not the same as worst, and
 * ranking on a fabricated zero would quietly fill the pool with names that have no premium data at all.
 */
function premiumPoolTickers(db: DbHandle): string[] {
  const row = db.prepare(
    `SELECT payload_json FROM analysis_snapshots WHERE mode = 'wheel' ORDER BY run_at DESC LIMIT 1`,
  ).get() as { payload_json: string } | undefined;
  if (!row) return [];

  let parsed: unknown;
  try { parsed = JSON.parse(row.payload_json); } catch { return []; }
  const rows: SnapshotRow[] = Array.isArray(parsed)
    ? parsed as SnapshotRow[]
    : ((parsed as { results?: SnapshotRow[] } | null)?.results ?? []);

  const eligible = rows.filter(r =>
    typeof r?.ticker === 'string' && r.ticker.length > 0
    && typeof r.annualizedReturn === 'number' && Number.isFinite(r.annualizedReturn)
    && (r.optionLiquidityScore ?? 0) >= PREMIUM_POOL.minLiquidity
    && (r.lastPrice == null || r.lastPrice <= PREMIUM_POOL.maxPrice));

  return eligible
    // Ties by ticker, not by input order: a snapshot's row order is not a documented property, and a
    // rank that depends on it would drift without any signal changing.
    .sort((a, b) => (b.annualizedReturn! - a.annualizedReturn!) || a.ticker!.localeCompare(b.ticker!))
    .slice(0, PREMIUM_POOL.topN)
    .map(r => r.ticker!);
}
