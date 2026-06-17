// One-click "Fix" for the Payoff strategy rules panel: makes a failing credit-vs-width rule
// pass by NARROWING the protective wing(s) toward the short strike(s). The short/premium legs
// (the thesis) are kept; only the long wing(s) move, re-priced from the live chain at mid,
// choosing the WIDEST passing strike (least narrowing). Pure + unit-tested in
// tests/payoff-fix.test.ts.
import type { PayoffLeg, OptionContract } from './types.js';

const mid = (c: OptionContract): number => parseFloat(((c.bid + c.ask) / 2).toFixed(2));

/** Net credit per share over all legs (sell +, buy −). */
function netCredit(legs: PayoffLeg[]): number {
  return legs.filter(l => l.type !== 'stock')
    .reduce((s, l) => s + (l.side === 'sell' ? 1 : -1) * l.premium, 0);
}

function patchLeg(legs: PayoffLeg[], id: string, c: OptionContract): PayoffLeg[] {
  return legs.map(l => l.id === id
    ? { ...l, strike: c.strike, premium: mid(c), delta: c.delta, theta: c.theta, vega: c.vega, iv: c.iv }
    : l);
}

const first = <T>(arr: T[]): T | undefined => arr[0];

// ── Single-wing credit-vs-width strategies (verticals + lizards) ──────────────
// Each has one long protective wing narrowed toward one short anchor. `mult` is the
// credit-to-width threshold: ⅓ for verticals (minCreditRule), 1 for lizards (credit ≥ width).
interface WingSpec {
  side: 'put' | 'call';
  anchorStrike: number;   // the short strike the wing protects; width = |anchor − wing|
  wingId: string;
  wingStrike: number;
  mult: number;
}

function wingSpecFor(name: string, legs: PayoffLeg[]): WingSpec | null {
  const sellPuts  = legs.filter(l => l.type === 'put'  && l.side === 'sell');
  const buyPuts   = legs.filter(l => l.type === 'put'  && l.side === 'buy');
  const sellCalls = legs.filter(l => l.type === 'call' && l.side === 'sell');
  const buyCalls  = legs.filter(l => l.type === 'call' && l.side === 'buy');

  // Bull/Bear verticals — credit ≥ ⅓ width.
  if (name === 'Bull Put Spread (Short Put Vertical)') {
    const sp = first(sellPuts.sort((a, b) => b.strike - a.strike));
    const bp = first(buyPuts.sort((a, b) => b.strike - a.strike));
    if (sp && bp) return { side: 'put', anchorStrike: sp.strike, wingId: bp.id, wingStrike: bp.strike, mult: 1 / 3 };
  }
  if (name === 'Bear Call Spread (Short Call Vertical)') {
    const sc = first(sellCalls.sort((a, b) => a.strike - b.strike));
    const bc = first(buyCalls.sort((a, b) => a.strike - b.strike));
    if (sc && bc) return { side: 'call', anchorStrike: sc.strike, wingId: bc.id, wingStrike: bc.strike, mult: 1 / 3 };
  }
  // Jade / Big Lizard — short put + short CALL spread; credit ≥ call spread width (no upside risk).
  if (name === 'Jade Lizard' || name === 'Big Lizard') {
    const sc = first(sellCalls.sort((a, b) => a.strike - b.strike));
    const bc = first(buyCalls.sort((a, b) => a.strike - b.strike));
    if (sc && bc) return { side: 'call', anchorStrike: sc.strike, wingId: bc.id, wingStrike: bc.strike, mult: 1 };
  }
  // Reverse Jade / Big Lizard — short call + short PUT spread; credit ≥ put spread width.
  if (name === 'Reverse Jade Lizard' || name === 'Reverse Big Lizard') {
    const sp = first(sellPuts.sort((a, b) => b.strike - a.strike));
    const bp = first(buyPuts.sort((a, b) => b.strike - a.strike));
    if (sp && bp) return { side: 'put', anchorStrike: sp.strike, wingId: bp.id, wingStrike: bp.strike, mult: 1 };
  }
  return null;
}

function fixSingleWing(legs: PayoffLeg[], contracts: OptionContract[], spec: WingSpec): { legs: PayoffLeg[]; note: string } | null {
  const others = legs.filter(l => l.id !== spec.wingId);
  const creditExWing = netCredit(others);                 // wing is a long (buy) → subtract its premium
  const widthOf  = (k: number) => Math.abs(spec.anchorStrike - k);
  const passes   = (k: number, prem: number) => widthOf(k) > 0 && (creditExWing - prem) >= widthOf(k) * spec.mult;

  const wing = legs.find(l => l.id === spec.wingId);
  if (wing && passes(wing.strike, wing.premium)) return null; // already satisfies the rule

  // Strikes strictly between the wing and the anchor, in the narrowing direction, widest-first.
  const candidates = contracts.filter(c => c.side === spec.side &&
    (spec.side === 'put'
      ? c.strike > spec.wingStrike && c.strike < spec.anchorStrike
      : c.strike < spec.wingStrike && c.strike > spec.anchorStrike))
    .sort((a, b) => spec.side === 'put' ? a.strike - b.strike : b.strike - a.strike);

  for (const c of candidates) {
    const prem = mid(c);
    if (passes(c.strike, prem)) {
      return {
        legs: patchLeg(legs, spec.wingId, c),
        note: `${spec.side === 'put' ? 'long put' : 'long call'} → $${c.strike} ($${widthOf(c.strike).toFixed(0)}-wide, $${(creditExWing - prem).toFixed(2)}/sh credit)`,
      };
    }
  }
  return null;
}

// ── Iron condor — two wings; credit ≥ ⅓ × max(put width, call width) ──────────
// Greedily narrow whichever wing is currently WIDER (the binding constraint) one chain strike
// at a time until the rule passes or no strike remains.
function fixCondor(legs: PayoffLeg[], contracts: OptionContract[]): { legs: PayoffLeg[]; note: string } | null {
  const sp = first(legs.filter(l => l.type === 'put'  && l.side === 'sell').sort((a, b) => b.strike - a.strike));
  const bp = first(legs.filter(l => l.type === 'put'  && l.side === 'buy' ).sort((a, b) => b.strike - a.strike));
  const sc = first(legs.filter(l => l.type === 'call' && l.side === 'sell').sort((a, b) => a.strike - b.strike));
  const bc = first(legs.filter(l => l.type === 'call' && l.side === 'buy' ).sort((a, b) => a.strike - b.strike));
  if (!sp || !bp || !sc || !bc) return null;

  const putCands  = contracts.filter(c => c.side === 'put'  && c.strike > bp.strike && c.strike < sp.strike).sort((a, b) => a.strike - b.strike);
  const callCands = contracts.filter(c => c.side === 'call' && c.strike < bc.strike && c.strike > sc.strike).sort((a, b) => b.strike - a.strike);

  let putC: OptionContract | null = null, callC: OptionContract | null = null;
  let pi = 0, ci = 0;
  const putStrike  = () => putC  ? putC.strike  : bp.strike;
  const callStrike = () => callC ? callC.strike : bc.strike;
  const putPrem    = () => putC  ? mid(putC)    : bp.premium;
  const callPrem   = () => callC ? mid(callC)   : bc.premium;
  const credit = () => sp.premium + sc.premium - putPrem() - callPrem();
  const putW   = () => sp.strike - putStrike();
  const callW  = () => callStrike() - sc.strike;
  const passes = () => { const w = Math.max(putW(), callW()); return w > 0 && credit() >= w / 3; };

  if (passes()) return null;

  let guard = 0;
  while (!passes() && guard++ < 200) {
    if (putW() >= callW()) {
      if (pi >= putCands.length) break;
      putC = putCands[pi++]!;
    } else {
      if (ci >= callCands.length) break;
      callC = callCands[ci++]!;
    }
  }
  if (!passes()) return null;

  let out = legs;
  if (putC)  out = patchLeg(out, bp.id, putC);
  if (callC) out = patchLeg(out, bc.id, callC);
  return { legs: out, note: `narrowed to ${putW().toFixed(0)}/${callW().toFixed(0)}-wide ($${credit().toFixed(2)}/sh credit)` };
}

/**
 * Returns adjusted legs (and a short human note) that satisfy a failing credit-vs-width rule,
 * or null when no fix applies — chain absent, an unsupported strategy, the rule already passes,
 * or no strike narrows enough. Supports the vertical credit spreads, the four lizards, and iron
 * condors (incl. dynamic-width).
 */
export function fixLegsForStrategy(
  strategyName: string,
  legs: PayoffLeg[],
  contracts: OptionContract[] | undefined,
): { legs: PayoffLeg[]; note: string } | null {
  if (!contracts || contracts.length === 0) return null;
  if (strategyName === 'Iron Condor' || strategyName === 'Dynamic Width Iron Condor') {
    return fixCondor(legs, contracts);
  }
  const spec = wingSpecFor(strategyName, legs);
  return spec ? fixSingleWing(legs, contracts, spec) : null;
}
