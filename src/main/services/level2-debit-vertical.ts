// Level-2 debit-vertical builder — narrows a long call/put vertical to a small max-risk budget
// so the Daily Brief can surface an IBKR-Level-2-tradeable (debit) alternative alongside the L3
// credit spreads. The long leg is taken ATM (closest strike to spot); the short leg is pulled in
// from the live chain to the WIDEST strike whose net debit still fits the risk target (max profit
// under the risk cap). Pure + unit-tested in tests/level2-debit-vertical.test.ts.
//
// Display-only — does NOT affect scoring or what the engine trades (no FR-SEY-5 impact). At high
// IV a debit vertical is buying expensive premium and is NOT the optimal structure; it exists so
// a Level-2 account can place small, defined-risk directional trades to build options history.
// see docs/formulas.md#level2-debit-vertical
import type { OptionContract } from './data-provider.js';
import { bsPrice, RISK_FREE_RATE } from './black-scholes.js';
import type { Level2DebitVertical } from '@shared/types.js';

/** Default per-spread max-risk budget (USD) for the account-building variant. */
export const DEFAULT_TARGET_MAX_RISK = 750;

const round2 = (v: number): number => Math.round(v * 100) / 100;

/** Mid from bid/ask when both usable; else Black-Scholes from the contract IV; else null. */
function priceOf(c: OptionContract, spot: number, tYears: number): number | null {
  if (c.ask > 0 && c.bid >= 0) {
    const m = (c.bid + c.ask) / 2;
    if (m > 0) return m;
  }
  // OptionContract.iv is a decimal fraction (0.285) → feed bsPrice directly.
  if (c.iv > 0 && spot > 0) return bsPrice(spot, c.strike, tYears, c.iv, RISK_FREE_RATE, c.side === 'call');
  return null;
}

/**
 * Build a narrowed debit vertical of the given side, targeting `targetMaxRisk` USD of max loss.
 * Returns null when the chain can't support a positive-debit spread on this side.
 */
export function buildNarrowDebitVertical(
  contracts: OptionContract[],
  side: 'call' | 'put',
  spot: number,
  dte: number,
  expiration: string,
  targetMaxRisk: number = DEFAULT_TARGET_MAX_RISK,
): Level2DebitVertical | null {
  if (!contracts.length || spot <= 0) return null;
  const tYears = Math.max(dte, 0) / 365;

  // Same-side strikes with a usable price, sorted ascending by strike.
  const priced = contracts
    .filter(c => c.side === side)
    .map(c => ({ strike: c.strike, price: priceOf(c, spot, tYears) }))
    .filter((x): x is { strike: number; price: number } => x.price !== null && x.price > 0)
    .sort((a, b) => a.strike - b.strike);
  if (priced.length < 2) return null;

  // Long leg = ATM (closest strike to spot).
  const long = priced.reduce((best, x) =>
    Math.abs(x.strike - spot) < Math.abs(best.strike - spot) ? x : best, priced[0]!);

  // Short candidates: OTM relative to the long (above for calls, below for puts), ordered
  // nearest→farthest from the long so the spread widens monotonically (debit grows with width).
  const shorts = side === 'call'
    ? priced.filter(s => s.strike > long.strike)
    : priced.filter(s => s.strike < long.strike).reverse();
  if (!shorts.length) return null;

  // Widen while the debit stays within budget; keep the last one that fits.
  let chosen: { strike: number; price: number } | null = null;
  for (const s of shorts) {
    const debit = long.price - s.price;
    if (debit <= 0) continue;                       // no positive-debit spread at this strike
    if (debit * 100 <= targetMaxRisk) chosen = s;   // fits → record, keep widening
    else break;                                     // first over-budget strike → wider is worse
  }
  let exceededBudget = false;
  if (!chosen) {
    // Even the narrowest spread is over budget — surface it anyway, flagged, so a small account
    // can still see (and decide to skip) the trade rather than getting no chip at all.
    const narrow = shorts.find(s => long.price - s.price > 0);
    if (!narrow) return null;
    chosen = narrow;
    exceededBudget = true;
  }

  const debitPerShare = round2(long.price - chosen.price);
  const width         = Math.abs(chosen.strike - long.strike);
  const breakeven     = side === 'call' ? long.strike + debitPerShare : long.strike - debitPerShare;

  return {
    side,
    longStrike:  long.strike,
    shortStrike: chosen.strike,
    longPremium:  round2(long.price),
    shortPremium: round2(chosen.price),
    expiration,
    dte,
    debitPerShare,
    maxRisk:   Math.round(debitPerShare * 100),
    maxProfit: Math.round((width - debitPerShare) * 100),
    breakeven: round2(breakeven),
    movePctToBreakeven: spot > 0 ? round2(((breakeven - spot) / spot) * 100) : null,
    underlyingPrice: round2(spot),
    exceededBudget,
  };
}
