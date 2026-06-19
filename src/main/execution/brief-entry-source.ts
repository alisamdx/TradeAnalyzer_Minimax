// Brief → PickInput entry source (Requirements/v2-execution 03-lifecycle §3.2, Phase 6b).
//
// Maps the daily brief's picks into the normalized `PickInput` the EntryPolicy consumes, per
// eligible strategy. Each strategy maps to the defined-risk credit structure the engine trades:
//   inflection → direction-locked vertical (short-put-vertical up / short-call-vertical down)
//   wheel      → short-put-vertical (the small-account, defined-risk "wheel": sell a put credit
//                spread on a name you'd own — a naked CSP can't be sized at $10k)
// The lab computes every structure for every ticker, so a wheel pick already carries a
// (budget-sized) short-put-vertical setup. The mapping is pure + testable; the loader is a thin
// per-strategy DB read.
//
// Note: this only *selects and shapes* candidates. All eligibility (eligible-strategy set,
// composite floor, critic verdict, entry window, caps) is enforced downstream by EntryPolicy,
// and every proposal is re-priced against the live IBKR chain — so a stale brief never trades a
// stale price.

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

// Strategies traded as a defined-risk put credit spread (short-put-vertical) — the small-account
// premium-selling vehicle. Their lab result already carries a (budget-sized) short-put-vertical.
const PUT_CREDIT_SPREAD_STRATEGIES = new Set(['wheel']);

/** The Strategy Lab score the engine trades for `strategy` on this pick (null = none viable). */
function chosenScore(pick: BriefPick, strategy: string): StrategyScore | null {
  const scores = (pick.strategyLabResult as StrategyLabValidateResult | null)?.scores as
    | StrategyScore[]
    | undefined;
  if (!scores) return null;
  if (strategy === 'inflection') {
    const c = pickRelevantStructure(scores, 'inflection', pick.breakoutDirection);
    return c && (c.slug === 'short-put-vertical' || c.slug === 'short-call-vertical') ? c : null;
  }
  if (PUT_CREDIT_SPREAD_STRATEGIES.has(strategy)) {
    return (
      scores.find(
        (s) => s.slug === 'short-put-vertical' && s.setup && !s.setup.unavailableReason && s.setup.maxLoss != null
      ) ?? null
    );
  }
  return null;
}

/**
 * Project one BriefPick onto a PickInput for `strategy`, or null when it can't be traded as a
 * defined-risk credit structure (no viable structure, unavailable setup, unbounded/absent max
 * loss). Pure — earnings is injected, not queried.
 */
export function briefPickToPickInput(
  pick: BriefPick,
  strategy: string,
  sourceBriefId: number | null,
  opts: MapPickOptions = {}
): PickInput | null {
  const chosen = chosenScore(pick, strategy);
  if (!chosen) return null;

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
    strategy,
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
 * Load the latest committed brief for each eligible strategy and map its picks to PickInput[].
 * Resolves each ticker's next earnings date from `earnings_calendar` for the earnings filter.
 * Never throws; skips strategies with no brief or unparseable picks.
 */
export function loadBriefPickInputs(
  db: DbHandle,
  strategies: readonly string[],
  now: Date = new Date()
): { picks: PickInput[]; briefIds: Record<string, number> } {
  const today = etDateString(now);
  const briefStmt = db.prepare(
    'SELECT id, picks FROM daily_briefs WHERE strategy = ? ORDER BY generated_at DESC LIMIT 1'
  );
  const earningsStmt = db.prepare(
    'SELECT report_date FROM earnings_calendar WHERE ticker = ? AND report_date >= ? ORDER BY report_date LIMIT 1'
  );

  const picks: PickInput[] = [];
  const briefIds: Record<string, number> = {};
  for (const strategy of strategies) {
    const row = briefStmt.get(strategy) as { id: number; picks: string } | undefined;
    if (!row) continue;
    briefIds[strategy] = row.id; // record the brief even if its picks don't parse
    let parsed: BriefPick[];
    try {
      parsed = JSON.parse(row.picks) as BriefPick[];
    } catch {
      continue;
    }
    for (const pick of parsed) {
      const er = earningsStmt.get(pick.ticker, today) as { report_date: string } | undefined;
      const mapped = briefPickToPickInput(pick, strategy, row.id, { nextEarningsDate: er?.report_date ?? null });
      if (mapped) picks.push(mapped);
    }
  }
  return { picks, briefIds };
}

/** Back-compat convenience: just the inflection strategy. */
export function loadInflectionPickInputs(
  db: DbHandle,
  now: Date = new Date()
): { briefId: number | null; picks: PickInput[] } {
  const { picks, briefIds } = loadBriefPickInputs(db, ['inflection'], now);
  return { briefId: briefIds['inflection'] ?? null, picks };
}
