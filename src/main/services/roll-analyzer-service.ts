/**
 * RollAnalyzerService — exit-side companion to the Payoff visualizer.
 *
 * Given a single short option (cash-secured put or covered call) the user holds (or a
 * hypothetical one), it prices the current close-now vs hold-to-expiry economics and
 * ranks credit-roll candidates across later expiries and strikes by a user-selected
 * efficiency metric. Credit-rolls only (net credit > 0), matching the wheel discipline.
 *
 * The metric math is pure and unit-tested (buildRollCandidates / scoreByMetric); the
 * service only orchestrates the live chain fetches.
 * see docs/formulas.md#roll-analyzer
 */

import type { OptionsProvider, OptionContract } from './options-provider.js';
import type {
  RollPositionInput, RollMetric, RollAnalysis, RollCandidate,
  RollCurrentState, RollRecommendation, RollDirection,
  Rollability, RollabilityHorizon, RollabilityVerdict,
} from '@shared/types.js';

// Scan parameters — kept deliberately modest so a run stays within a handful of
// rate-limited E*Trade chain calls.
const MAX_ROLL_EXPIRIES = 6;   // future expiries to scan beyond the current one
const STRIKE_BAND_LOW = 0.80;  // scan strikes from currentStrike × 0.80 …
const STRIKE_BAND_HIGH = 1.15; // … to currentStrike × 1.15 (covers roll down / same / up)
const MAX_CANDIDATES = 30;
const MIN_ADDED_DTE = 1;       // guard annualization against divide-by-~0
const MAX_SPREAD_PCT = 0.20;   // a leg wider than this is flagged not-liquid

// ─── Pure helpers (unit-tested) ────────────────────────────────────────────────

export function dteDays(expiration: string, now = Date.now()): number {
  return Math.max(0, Math.round((new Date(expiration + 'T16:00:00Z').getTime() - now) / 86_400_000));
}
const mid = (bid: number, ask: number): number => (bid + ask) / 2;
const spreadPct = (bid: number, ask: number): number => {
  const m = mid(bid, ask);
  return m > 0 ? (ask - bid) / m : 1;
};

function directionOf(newStrike: number, currentStrike: number): RollDirection {
  if (Math.abs(newStrike - currentStrike) < 0.01) return 'same';
  return newStrike < currentStrike ? 'out-down' : 'out-up';
}

/** The ranking value for a candidate under the selected metric (higher = better). */
export function scoreByMetric(c: RollCandidate, metric: RollMetric): number {
  switch (metric) {
    case 'netCredit':          return c.netCredit;
    case 'capitalEfficiency':  return c.capitalEfficiency;
    case 'annualizedRoc':      return c.annualizedRoc ?? -Infinity;
    case 'riskAdjusted':       return (c.annualizedRoc ?? 0) * (1 - (c.assignmentProbability ?? 0.5));
  }
}

/**
 * Build ranked credit-roll candidates. Pure: takes the current short's mark and a set of
 * later-expiry chains, returns candidates sorted by the selected metric. Only net-credit
 * rolls (netCreditPerShare > 0) are included.
 */
export function buildRollCandidates(
  input: RollPositionInput,
  currentMark: number,                 // per-share buy-to-close cost of the current short
  currentDte: number,
  underlyingPrice: number | null,
  chains: { expiration: string; contracts: OptionContract[] }[],
  metric: RollMetric,
  now = Date.now(),
): RollCandidate[] {
  const out: RollCandidate[] = [];
  const loStrike = input.strike * STRIKE_BAND_LOW;
  const hiStrike = input.strike * STRIKE_BAND_HIGH;

  for (const chain of chains) {
    const newDte = dteDays(chain.expiration, now);
    if (newDte <= currentDte) continue; // roll OUT only — a later expiry
    const addedDte = Math.max(MIN_ADDED_DTE, newDte - currentDte);

    for (const c of chain.contracts) {
      if (c.side !== input.optionType) continue;
      if (c.strike < loStrike || c.strike > hiStrike) continue;
      if (!(c.bid > 0) || !(c.ask > 0)) continue; // need a two-sided quote to sell into

      const sellToOpen = mid(c.bid, c.ask);
      const netCreditPerShare = sellToOpen - currentMark;
      if (netCreditPerShare <= 0) continue; // credit-rolls only

      const capitalPerShare = input.optionType === 'put' ? c.strike : (underlyingPrice ?? c.strike);
      const capitalEfficiency = capitalPerShare > 0 ? netCreditPerShare / capitalPerShare : 0;
      const annualizedRoc = capitalPerShare > 0 ? capitalEfficiency / addedDte * 365 : null;
      const assignmentProbability = c.delta != null ? Math.abs(c.delta) : null;
      // Cumulative credit collected since inception after this roll (per share).
      const cumulativeCredit = input.entryCredit + netCreditPerShare;
      const breakeven = input.optionType === 'put'
        ? c.strike - cumulativeCredit
        : c.strike + cumulativeCredit;

      const candidate: RollCandidate = {
        expiration: chain.expiration,
        dte: newDte,
        addedDte: newDte - currentDte,
        strike: c.strike,
        optionType: input.optionType,
        direction: directionOf(c.strike, input.strike),
        newBid: c.bid,
        newAsk: c.ask,
        newMid: sellToOpen,
        newDelta: c.delta,
        buyToCloseMid: currentMark,
        netCreditPerShare,
        netCredit: netCreditPerShare * 100 * input.contracts,
        capitalAtRisk: capitalPerShare * 100 * input.contracts,
        annualizedRoc,
        capitalEfficiency,
        assignmentProbability,
        breakeven,
        liquidityOk: spreadPct(c.bid, c.ask) <= MAX_SPREAD_PCT,
        score: 0, // set below
      };
      candidate.score = scoreByMetric(candidate, metric);
      out.push(candidate);
    }
  }

  out.sort((a, b) => b.score - a.score);
  return out.slice(0, MAX_CANDIDATES);
}

// ─── Rollability (Bec's check — docs/Bec/STRATEGY-SUMMARY.md §6b, §9.1) ──────────
//
// "Look at the cost to buy back the in-the-money option, then look forward one week, two
// weeks, a month: how many strikes can that same credit buy you? That tells you how far into
// the future you would have to go to get back above your break-even. If the answer is a year,
// the trade is a trap." Pure chain arithmetic; it ranks and gates nothing.
// see docs/formulas.md#rollability

/** Roll horizons, in calendar days ADDED beyond the current expiry. */
export const ROLLABILITY_HORIZON_DAYS = [7, 14, 30, 60, 90, 180, 365] as const;
/** Verdict bands in weeks. Working values from Bec's "a year is a trap" — not validated. */
export const ROLLABILITY_EASY_WEEKS = 4;
export const ROLLABILITY_WORKABLE_WEEKS = 13;
/** Scanning at least this far without reaching the target is a trap, not "unknown". */
const ROLLABILITY_TRAP_SCAN_DAYS = 180;

/**
 * The listed expirations nearest to each horizon, later than the current one. Deduplicated, so
 * a sparse listing (few far-dated expiries) costs fewer chain calls, never duplicate ones.
 */
export function pickRollabilityExpirations(expirations: readonly string[], currentDte: number, now = Date.now()): string[] {
  const later = expirations
    .map((e) => ({ e, added: dteDays(e, now) - currentDte }))
    .filter((x) => x.added > 2);
  const picked = new Set<string>();
  for (const h of ROLLABILITY_HORIZON_DAYS) {
    let best: { e: string; added: number } | undefined;
    for (const x of later) {
      if (!best || Math.abs(x.added - h) < Math.abs(best.added - h)) best = x;
    }
    if (best) picked.add(best.e);
  }
  return [...picked].sort();
}

/**
 * How far out a credit roll has to go before the strike reaches safety.
 *
 * Target: a covered call's stock cost basis when given (called away without a loss), else the
 * underlying price (back out of the money); a short put's underlying price (strike at or below
 * spot — a lower assignment price, Bec's second roll guarantee). For each later expiry, the best
 * strike is the most-improved one (lower for a put, higher for a call) whose sell-to-open mid
 * still exceeds the buy-to-close mark, i.e. a net credit.
 */
export function computeRollability(
  input: RollPositionInput,
  currentMark: number,
  currentDte: number,
  underlyingPrice: number | null,
  chains: { expiration: string; contracts: OptionContract[] }[],
  now = Date.now(),
): Rollability {
  const isPut = input.optionType === 'put';
  const target = !isPut && input.costBasis != null && input.costBasis > 0
    ? input.costBasis
    : underlyingPrice;
  const targetKind: Rollability['targetKind'] = target == null
    ? null
    : !isPut && input.costBasis != null && input.costBasis > 0 ? 'cost_basis' : 'underlying';
  const improvementOf = (strike: number): number => (isPut ? input.strike - strike : strike - input.strike);
  const reaches = (strike: number): boolean => target != null && (isPut ? strike <= target : strike >= target);
  const atTarget = target != null && reaches(input.strike);

  const horizons: RollabilityHorizon[] = [];
  for (const chain of [...chains].sort((a, b) => a.expiration.localeCompare(b.expiration))) {
    const dte = dteDays(chain.expiration, now);
    if (dte <= currentDte) continue;
    const side = chain.contracts.filter((c) => c.side === input.optionType);
    let best: OptionContract | undefined;
    for (const c of side) {
      if (!(c.bid > 0) || !(c.ask > 0)) continue;
      if (improvementOf(c.strike) < 0) continue; // a worse strike is not a repair
      if (mid(c.bid, c.ask) - currentMark <= 0) continue; // credit rolls only
      if (!best || improvementOf(c.strike) > improvementOf(best.strike)) best = c;
    }
    const improvement = best ? improvementOf(best.strike) : null;
    const gained = improvement == null
      ? 0
      : new Set(side.map((c) => c.strike).filter((s) => improvementOf(s) > 0 && improvementOf(s) <= improvement)).size;
    horizons.push({
      expiration: chain.expiration,
      dte,
      addedDte: dte - currentDte,
      bestStrike: best?.strike ?? null,
      strikesGained: gained,
      improvement,
      netCreditPerShare: best ? mid(best.bid, best.ask) - currentMark : null,
      reachesTarget: best != null && reaches(best.strike),
    });
  }

  const first = horizons.find((h) => h.reachesTarget);
  const weeksToTarget = atTarget ? 0 : first ? Math.round((first.addedDte / 7) * 10) / 10 : null;
  const scanned = horizons.reduce((m, h) => Math.max(m, h.addedDte), 0);

  let verdict: RollabilityVerdict;
  let summary: string;
  if (target == null) {
    verdict = 'unknown';
    summary = 'No target: the underlying price is unavailable' + (isPut ? '.' : ' and no cost basis was given.');
  } else if (atTarget) {
    verdict = 'at_target';
    summary = isPut
      ? `The $${input.strike} strike is already at or below the underlying ($${target.toFixed(2)}) — nothing to repair.`
      : `The $${input.strike} strike is already at or above the ${targetKind === 'cost_basis' ? 'cost basis' : 'underlying'} ($${target.toFixed(2)}).`;
  } else if (weeksToTarget != null && first) {
    verdict = weeksToTarget <= ROLLABILITY_EASY_WEEKS ? 'easy' : weeksToTarget <= ROLLABILITY_WORKABLE_WEEKS ? 'workable' : 'trap';
    summary = `A credit roll reaches the $${target.toFixed(2)} ${targetKind === 'cost_basis' ? 'cost basis' : 'target'} at $${first.bestStrike} on ${first.expiration} — ${weeksToTarget} weeks out.`;
  } else if (scanned >= ROLLABILITY_TRAP_SCAN_DAYS) {
    verdict = 'trap';
    summary = `No credit roll reaches the $${target.toFixed(2)} ${targetKind === 'cost_basis' ? 'cost basis' : 'target'} within ${scanned} days — a trap by Bec's rule.`;
  } else {
    verdict = 'unknown';
    summary = horizons.length === 0
      ? 'No later expiries could be priced.'
      : `Not reachable within the ${scanned} days that are listed — cannot see far enough to call it.`;
  }

  return { target, targetKind, atTarget, horizons, weeksToTarget, verdict, summary };
}

/** Rule-based close/hold/roll recommendation (transparent, no LLM). */
export function recommendAction(
  current: RollCurrentState,
  candidates: RollCandidate[],
): RollRecommendation {
  const pct = current.pctOfMaxProfit;
  const assign = current.assignmentProbability;
  const best = candidates[0];

  // Banked most of the credit with little time value left → take profit / close.
  if (pct != null && pct >= 0.8) {
    return { action: 'close', reason: `You've captured ${(pct * 100).toFixed(0)}% of the max credit — little left to gain; close to free the capital and remove tail risk.` };
  }
  // In-the-money / high assignment risk → roll if a credit roll exists, else decide on assignment.
  if ((current.moneyness === 'ITM') || (assign != null && assign >= 0.5)) {
    if (best) {
      const dirWord = best.direction === 'out-down' ? 'down and out' : best.direction === 'out-up' ? 'up and out' : 'out';
      return { action: 'roll', reason: `The short is under pressure (assignment prob ~${assign != null ? (assign * 100).toFixed(0) : '?'}%). Rolling ${dirWord} to $${best.strike} / ${best.expiration} collects a further $${best.netCredit.toFixed(0)} credit while extending duration.` };
    }
    return { action: 'close', reason: `The short is ITM / high assignment risk and no net-credit roll is available — close (or accept assignment if you want the shares).` };
  }
  // Comfortable OTM with time left → hold and let theta work; roll only for a strong efficiency pickup.
  if (best && best.annualizedRoc != null && best.annualizedRoc >= 0.30 && best.addedDte >= 7) {
    return { action: 'hold', reason: `Position is comfortable (${current.moneyness}). Holding is fine; the best roll (${(best.annualizedRoc * 100).toFixed(0)}%/yr) is only worth taking if you want to lock the extra credit now.` };
  }
  return { action: 'hold', reason: `Position is ${current.moneyness} with ${current.dte}d left — let theta work; no roll offers a compelling efficiency pickup yet.` };
}

// ─── Service ────────────────────────────────────────────────────────────────────

export class RollAnalyzerService {
  constructor(private readonly provider: OptionsProvider) {}

  async analyze(input: RollPositionInput, metric: RollMetric): Promise<RollAnalysis> {
    const notes: string[] = [];
    const now = Date.now();
    const currentDte = dteDays(input.expiration, now);

    // 1. Price the current short leg from the live chain.
    let shortLeg: OptionContract | undefined;
    let underlyingPrice: number | null = null;
    try {
      const chain = await this.provider.getOptionsChain(input.ticker, input.expiration);
      underlyingPrice = chain.underlyingPrice;
      shortLeg = chain.contracts.find(
        (c) => c.side === input.optionType && Math.abs(c.strike - input.strike) < 0.01,
      );
    } catch (e) {
      notes.push(`Could not fetch the current chain (${input.expiration}): ${e instanceof Error ? e.message : String(e)}`);
    }

    const markToClose = shortLeg ? mid(shortLeg.bid, shortLeg.ask) : null;
    if (markToClose == null) {
      notes.push('Current short leg not found / not priced in the live chain — close & roll economics are unavailable. Check the strike and expiry.');
    }

    const openCredit = input.entryCredit * 100 * input.contracts;
    const closeCost = markToClose != null ? markToClose * 100 * input.contracts : null;
    const unrealizedPnl = closeCost != null ? openCredit - closeCost : null;
    const capitalPerShare = input.optionType === 'put' ? input.strike : (underlyingPrice ?? input.strike);

    const moneyness: RollCurrentState['moneyness'] = underlyingPrice == null
      ? 'ATM'
      : input.optionType === 'put'
        ? (underlyingPrice < input.strike ? 'ITM' : underlyingPrice > input.strike ? 'OTM' : 'ATM')
        : (underlyingPrice > input.strike ? 'ITM' : underlyingPrice < input.strike ? 'OTM' : 'ATM');

    const current: RollCurrentState = {
      underlyingPrice,
      markToClose,
      bid: shortLeg?.bid ?? null,
      ask: shortLeg?.ask ?? null,
      delta: shortLeg?.delta ?? null,
      iv: shortLeg?.iv ?? null,
      dte: currentDte,
      moneyness,
      openCredit,
      closeCost,
      unrealizedPnl,
      pctOfMaxProfit: unrealizedPnl != null && openCredit > 0 ? unrealizedPnl / openCredit : null,
      capitalAtRisk: capitalPerShare * 100 * input.contracts,
      breakeven: input.optionType === 'put' ? input.strike - input.entryCredit : input.strike + input.entryCredit,
      assignmentProbability: shortLeg?.delta != null ? Math.abs(shortLeg.delta) : null,
      chainStale: markToClose == null,
    };

    // 2. Roll candidates across later expiries.
    let candidates: RollCandidate[] = [];
    let rollability: Rollability | null = null;
    if (markToClose != null) {
      let expirations: string[] = [];
      try {
        expirations = await this.provider.getOptionsExpirations(input.ticker);
      } catch (e) {
        notes.push(`Could not list expirations: ${e instanceof Error ? e.message : String(e)}`);
      }
      const futureExp = expirations
        .filter((e) => dteDays(e, now) > currentDte + 2) // must genuinely extend duration
        .sort()
        .slice(0, MAX_ROLL_EXPIRIES);
      // Rollability looks up to a year out; those far chains feed ONLY the rollability read,
      // so the candidate table and its rankings are exactly what they were.
      const rollabilityExp = pickRollabilityExpirations(expirations, currentDte, now);

      const byExpiration = new Map<string, OptionContract[]>();
      for (const exp of [...new Set([...futureExp, ...rollabilityExp])].sort()) {
        try {
          const ch = await this.provider.getOptionsChain(input.ticker, exp);
          byExpiration.set(exp, ch.contracts);
        } catch (e) {
          notes.push(`Skipped ${exp}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      const chainsFor = (exps: readonly string[]) =>
        exps.filter((e) => byExpiration.has(e)).map((e) => ({ expiration: e, contracts: byExpiration.get(e)! }));

      candidates = buildRollCandidates(input, markToClose, currentDte, underlyingPrice, chainsFor(futureExp), metric, now);
      if (candidates.length === 0) notes.push('No net-credit roll found in the scanned expiries/strikes — a debit would be required to roll.');
      rollability = computeRollability(input, markToClose, currentDte, underlyingPrice, chainsFor(rollabilityExp), now);
    }

    return {
      input,
      metric,
      current,
      candidates,
      rollability,
      recommendation: recommendAction(current, candidates),
      notes,
      generatedAt: new Date().toISOString(),
    };
  }
}
