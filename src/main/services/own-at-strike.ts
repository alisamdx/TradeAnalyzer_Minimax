// "Would I be happy owning this at the strike?" — answered from the stock's own price history
// instead of from a hand-maintained list.
//
// WHY THIS EXISTS. The conviction never-above band was supposed to answer this question, and
// measurement showed it could not. The bands are anchored to spot on the day they were written
// (`price_high` ~ 1.13 x spot at write time, across all 13 rows), while an OTM cash-secured put
// strikes at ~0.93 x spot. So the test sits ~21% out of reach by construction and fired on
// 0 of 39 eligible picks over 62 stored briefs — the closest any pick came was still 10% under
// the line. It was decorative before v1.1.168 demoted it, not a protection that was then lost.
//
// WHAT THIS DOES INSTEAD. It reports where the EFFECTIVE COST BASIS (strike − premium, the price
// actually paid on assignment) sits against two point-in-time anchors computed from the ticker's
// own bars: its 200-day average, and its 52-week range. Both are available for 100% of stored
// wheel picks, need no curation, and cannot go stale.
//
// WHAT IT IS NOT. It is NOT a gate, and it must not become one without more data. See
// `scripts/own-at-strike-study.mjs` and docs/formulas.md#own-at-strike: the separation looks
// large (accept +12.1% vs reject −5.3% excess-of-SPY per episode) and survived every robustness
// check available — regime-adjustment, episode de-duplication, leave-one-out — but it rests on
// **12 independent accept episodes inside a single ~4-week window**, because only picks whose
// expiry + 30d has already passed are measurable. This project has rejected several levers that
// looked exactly this good on a one-regime sample (the SPY-regime gate, the overbought guard,
// the expiry-selection lever). So it informs, and the operator decides.
//
// see docs/formulas.md#own-at-strike

/** Point-in-time price anchors for one ticker, computed from bars on or before the brief date. */
export interface PriceWindow {
  /** Mean close over the last 200 sessions — the long-run anchor the study found separates. */
  sma200: number;
  /** Highest high and lowest low over the last ~52 weeks of stored sessions. */
  hi52: number;
  lo52: number;
}

export interface OwnAtStrikeRead {
  /** strike − premium: what assignment actually costs per share. */
  costBasis: number;
  sma200: number;
  /** Signed % of the cost basis against the 200-day average. Negative = below it. */
  basisVsSma200Pct: number;
  /** The one boolean the study separated on. Reported, never used to exclude. */
  atOrBelowSma200: boolean;
  /** Where the basis sits in the 52-week range: 0 = at the low, 100 = at the high. May fall
   *  outside [0,100] when the basis is beyond the stored range, which is real information. */
  rangePctile: number;
  hi52: number;
  lo52: number;
}

/**
 * Read the cost basis against the ticker's own history.
 *
 * Returns null when the window is missing — a ticker without 200 sessions of history has no
 * long-run anchor, and inventing one from a shorter window would silently change what the number
 * means. Absent is reported as "not enough history", never as a pass.
 */
export function readOwnAtStrike(costBasis: number, w: PriceWindow | undefined): OwnAtStrikeRead | null {
  if (!w || !Number.isFinite(w.sma200) || w.sma200 <= 0) return null;
  const span = w.hi52 - w.lo52;
  return {
    costBasis,
    sma200: w.sma200,
    basisVsSma200Pct: (costBasis / w.sma200 - 1) * 100,
    atOrBelowSma200: costBasis <= w.sma200,
    // A degenerate range (a flat or single-bar series) has no meaningful percentile; 50 is the
    // honest "we cannot tell" answer rather than a divide-by-zero or a false extreme.
    rangePctile: span > 0 ? ((costBasis - w.lo52) / span) * 100 : 50,
    hi52: w.hi52,
    lo52: w.lo52,
  };
}

/**
 * The sentence shown to the operator, in both the email and the in-app panel.
 *
 * Phrased around ASSIGNMENT because that is the only scenario in which the question matters — the
 * put expiring worthless makes the cost basis hypothetical. The two readings are given together
 * rather than reduced to a verdict: a basis below the 200-day average but at the top of a narrow
 * 52-week range is a different situation from one below both, and collapsing them to a single
 * word would hide that.
 */
export function ownAtStrikeNote(ticker: string, r: OwnAtStrikeRead | null): string {
  if (!r) return `Not enough price history for ${ticker} to judge the cost basis against its own range.`;
  const basis = `$${r.costBasis.toFixed(2)}`;
  const pct = Math.abs(r.basisVsSma200Pct).toFixed(1);
  const where = `the ${ordinal(Math.round(r.rangePctile))} percentile of its 52-week range`;
  if (r.atOrBelowSma200) {
    return `If assigned you own ${ticker} at ${basis} — ${pct}% BELOW its 200-day average, at ${where}.`;
  }
  return `If assigned you own ${ticker} at ${basis} — ${pct}% ABOVE its 200-day average, at ${where}. `
       + `That is an extended price, not a discount.`;
}

function ordinal(n: number): string {
  const abs = Math.abs(n) % 100;
  const suffix = abs >= 11 && abs <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][abs % 10] ?? 'th';
  return `${n}${suffix}`;
}
