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

      const chains: { expiration: string; contracts: OptionContract[] }[] = [];
      for (const exp of futureExp) {
        try {
          const ch = await this.provider.getOptionsChain(input.ticker, exp);
          chains.push({ expiration: exp, contracts: ch.contracts });
        } catch (e) {
          notes.push(`Skipped ${exp}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      candidates = buildRollCandidates(input, markToClose, currentDte, underlyingPrice, chains, metric, now);
      if (candidates.length === 0) notes.push('No net-credit roll found in the scanned expiries/strikes — a debit would be required to roll.');
    }

    return {
      input,
      metric,
      current,
      candidates,
      recommendation: recommendAction(current, candidates),
      notes,
      generatedAt: new Date().toISOString(),
    };
  }
}
