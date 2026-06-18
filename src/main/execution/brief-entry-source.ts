// Brief → PickInput entry source (Requirements/v2-execution 03-lifecycle §3.2, Phase 6b).
//
// Maps the daily brief's inflection picks into the normalized `PickInput` the EntryPolicy
// consumes. The brief already emits the direction-locked structure (short-put-vertical for an
// up-breakout, short-call-vertical for a down-breakout) with strikes/legs from Strategy Lab;
// this reads the latest committed inflection brief and projects each viable pick onto a
// PickInput. The mapping is pure + testable; the loader is a thin DB read.
//
// Note: this only *selects and shapes* candidates. All eligibility (composite floor, critic
// verdict, entry window, caps) is enforced downstream by EntryPolicy, and every proposal is
// re-priced against the live IBKR chain — so a stale brief never trades a stale price.

import type { DbHandle } from '../db/connection.js';
import type {
  BriefPick,
  ExecStructure,
  SetupLeg,
  StrategyLabValidateResult,
  StrategyScore,
} from '../../shared/types.js';
import type { LegSpec } from './execution-broker.js';
import type { PickInput } from './entry-policy.js';
import { pickRelevantStructure } from '../../shared/strategy-structures.js';
import { etDateString } from './market-hours.js';

// The lab's liquidityScore is 0–15; require a reasonable floor as the execution proxy for the
// brief's liquidity assessment (legs must also have two-sided quotes). Calibrated in Phase 7.
const MIN_LIQUIDITY_SCORE = 8;

/** YYYY-MM-DD (strip any time component a setup expiration might carry). */
function normalizeExpiry(s: string): string {
  return s.length >= 10 ? s.slice(0, 10) : s;
}

function sideToRight(side: 'call' | 'put'): 'P' | 'C' {
  return side === 'call' ? 'C' : 'P';
}

/** One Strategy Lab setup leg → an execution LegSpec for the given underlying. */
export function setupLegToLegSpec(ticker: string, leg: SetupLeg): LegSpec {
  return {
    ticker,
    right: sideToRight(leg.side),
    action: leg.action,
    strike: leg.strike,
    expiry: normalizeExpiry(leg.expiration),
    ratio: leg.qty,
  };
}

export interface MapPickOptions {
  /** Next earnings date (YYYY-MM-DD) for the ticker, if any — drives earningsBeforeExpiry. */
  nextEarningsDate?: string | null;
}

/**
 * Project one inflection BriefPick onto a PickInput, or null when it can't be traded as a
 * defined-risk vertical (no viable direction-matched structure, unavailable setup, or
 * unbounded/absent max loss). Pure — earnings is injected, not queried.
 */
export function briefPickToPickInput(
  pick: BriefPick,
  sourceBriefId: number | null,
  opts: MapPickOptions = {}
): PickInput | null {
  const scores = (pick.strategyLabResult as StrategyLabValidateResult | null)?.scores as
    | StrategyScore[]
    | undefined;
  const chosen = pickRelevantStructure(scores, 'inflection', pick.breakoutDirection);
  if (!chosen) return null;
  if (chosen.slug !== 'short-put-vertical' && chosen.slug !== 'short-call-vertical') return null;

  const setup = chosen.setup;
  if (!setup || setup.unavailableReason || setup.maxLoss == null) return null;
  if (!setup.legs?.length) return null;

  const legs = setup.legs.map((l) => setupLegToLegSpec(pick.ticker, l));
  const expiry = legs[0]!.expiry; // a vertical's legs share one expiry
  const earningsBeforeExpiry = opts.nextEarningsDate != null && opts.nextEarningsDate <= expiry;
  const hasAdequateLiquidity =
    (chosen.liquidityScore ?? 0) >= MIN_LIQUIDITY_SCORE && setup.legs.every((l) => l.bid > 0 && l.ask > 0);

  return {
    ticker: pick.ticker,
    strategy: 'inflection',
    structure: chosen.slug as ExecStructure,
    legs,
    compositeScore: pick.compositeScore,
    criticVerdict: pick.criticVerdict?.verdict ?? null,
    hasAdequateLiquidity,
    earningsBeforeExpiry,
    maxLossPerContract: Math.abs(setup.maxLoss),
    sourceBriefId,
  };
}

/**
 * Load the latest committed inflection brief and map its picks to PickInput[]. Resolves each
 * ticker's next earnings date from `earnings_calendar` for the earnings-before-expiry filter.
 * Returns an empty list (never throws) when there is no brief or it can't be parsed.
 */
export function loadInflectionPickInputs(
  db: DbHandle,
  now: Date = new Date()
): { briefId: number | null; picks: PickInput[] } {
  const row = db
    .prepare(
      "SELECT id, picks FROM daily_briefs WHERE strategy = 'inflection' ORDER BY generated_at DESC LIMIT 1"
    )
    .get() as { id: number; picks: string } | undefined;
  if (!row) return { briefId: null, picks: [] };

  let parsed: BriefPick[];
  try {
    parsed = JSON.parse(row.picks) as BriefPick[];
  } catch {
    return { briefId: row.id, picks: [] };
  }

  const today = etDateString(now);
  const earningsStmt = db.prepare(
    'SELECT report_date FROM earnings_calendar WHERE ticker = ? AND report_date >= ? ORDER BY report_date LIMIT 1'
  );

  const picks: PickInput[] = [];
  for (const pick of parsed) {
    const er = earningsStmt.get(pick.ticker, today) as { report_date: string } | undefined;
    const mapped = briefPickToPickInput(pick, row.id, { nextEarningsDate: er?.report_date ?? null });
    if (mapped) picks.push(mapped);
  }
  return { briefId: row.id, picks };
}
