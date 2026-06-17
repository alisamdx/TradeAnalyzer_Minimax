// One-click "Fix" for the Payoff strategy rules panel: makes a failing credit-vs-width rule
// pass by NARROWING the protective wing toward the short strike. The short/premium leg (the
// thesis) is kept; only the long wing moves, re-priced from the live chain at mid. Picks the
// WIDEST passing strike (least narrowing). Pure + unit-tested in tests/payoff-fix.test.ts.
import type { PayoffLeg, OptionContract } from './types.js';

const mid = (c: OptionContract): number => parseFloat(((c.bid + c.ask) / 2).toFixed(2));

/**
 * Returns adjusted legs (and a short human note) that satisfy a failing credit-vs-width rule,
 * or null when no fix applies — chain absent, an unsupported strategy, or no strike narrows
 * enough. Scope: the two vertical credit spreads (the inflection launch structures and the
 * common "credit ≥ ⅓ width" failure).
 */
export function fixLegsForStrategy(
  strategyName: string,
  legs: PayoffLeg[],
  contracts: OptionContract[] | undefined,
): { legs: PayoffLeg[]; note: string } | null {
  if (!contracts || contracts.length === 0) return null;

  const patchWing = (id: string, c: OptionContract): PayoffLeg[] =>
    legs.map(l => l.id === id
      ? { ...l, strike: c.strike, premium: mid(c), delta: c.delta, theta: c.theta, vega: c.vega, iv: c.iv }
      : l);

  if (strategyName === 'Bull Put Spread (Short Put Vertical)') {
    const sp = legs.filter(l => l.type === 'put' && l.side === 'sell').sort((a, b) => b.strike - a.strike)[0];
    const bp = legs.filter(l => l.type === 'put' && l.side === 'buy').sort((a, b) => b.strike - a.strike)[0];
    if (!sp || !bp) return null;
    // Long put moves UP toward the short put; ascending strike = widest-first = least narrowing.
    const candidates = contracts
      .filter(c => c.side === 'put' && c.strike > bp.strike && c.strike < sp.strike)
      .sort((a, b) => a.strike - b.strike);
    for (const c of candidates) {
      const width = sp.strike - c.strike;
      const credit = sp.premium - mid(c);
      if (width > 0 && credit >= width / 3) {
        return { legs: patchWing(bp.id, c), note: `long put → $${c.strike} ($${width.toFixed(0)}-wide, $${credit.toFixed(2)}/sh credit)` };
      }
    }
    return null;
  }

  if (strategyName === 'Bear Call Spread (Short Call Vertical)') {
    const sc = legs.filter(l => l.type === 'call' && l.side === 'sell').sort((a, b) => a.strike - b.strike)[0];
    const bc = legs.filter(l => l.type === 'call' && l.side === 'buy').sort((a, b) => a.strike - b.strike)[0];
    if (!sc || !bc) return null;
    // Long call moves DOWN toward the short call; descending strike = widest-first = least narrowing.
    const candidates = contracts
      .filter(c => c.side === 'call' && c.strike < bc.strike && c.strike > sc.strike)
      .sort((a, b) => b.strike - a.strike);
    for (const c of candidates) {
      const width = c.strike - sc.strike;
      const credit = sc.premium - mid(c);
      if (width > 0 && credit >= width / 3) {
        return { legs: patchWing(bc.id, c), note: `long call → $${c.strike} ($${width.toFixed(0)}-wide, $${credit.toFixed(2)}/sh credit)` };
      }
    }
    return null;
  }

  return null;
}
