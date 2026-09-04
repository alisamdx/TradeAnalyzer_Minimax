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
// WHY THIS LIVES IN `shared/`. The sentence below is rendered in BOTH the dice email and the
// in-app panel, and until v1.1.188 the panel kept its own hand-copied duplicate of it. That is the
// same trap the strategy slug map fell into (v1.1.23/25), where four copies drifted and the card,
// the email and the critic disagreed about the same pick. One definition, imported by main,
// preload and renderer alike.
//
// see docs/formulas.md#own-at-strike

/** Point-in-time price anchors for one ticker, computed from bars on or before the brief date. */
export interface PriceWindow {
  /** Mean close over the last 200 sessions — the long-run anchor the study found separates. */
  sma200: number;
  /** Highest high and lowest low over the last ~52 weeks of stored sessions. */
  hi52: number;
  lo52: number;
  /** Lowest LOW of the last 20 sessions — the support anchor, mirroring
   *  `findSwingHighLow(bars, 20).low` in analysis-service. Null when there are fewer than 20 bars,
   *  which is reported as unknown rather than treated as "no support". */
  swingLow20: number | null;
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

  /** The SHORT STRIKE, not the basis — the support test is about the strike, see the note below. */
  strike: number;
  /** Lowest low of the last 20 sessions, or null when there is not enough history for one. */
  swingLow20: number | null;
  /** Strike strictly below that low: the stock has not traded at the strike in the last month.
   *  Null when `swingLow20` is null — unknown, never asserted as false. */
  strikeBelowSwing: boolean | null;
}

/**
 * Read the cost basis against the ticker's own history.
 *
 * Returns null when the window is missing — a ticker without 200 sessions of history has no
 * long-run anchor, and inventing one from a shorter window would silently change what the number
 * means. Absent is reported as "not enough history", never as a pass.
 */
export function readOwnAtStrike(
  strike: number, costBasis: number, w: PriceWindow | undefined,
): OwnAtStrikeRead | null {
  if (!w || !Number.isFinite(w.sma200) || w.sma200 <= 0) return null;
  const span = w.hi52 - w.lo52;
  const swing = w.swingLow20 != null && Number.isFinite(w.swingLow20) && w.swingLow20 > 0
    ? w.swingLow20 : null;
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
    strike,
    swingLow20: swing,
    // NOTE THE ASYMMETRY, and do not "tidy" it: the long-run half of this read tests the COST
    // BASIS, the support half tests the STRIKE. That is exactly what was measured
    // (`basis <= SMA200` and `strike < 20-day low`), and the code matches the study rather than
    // the other way round. see docs/formulas.md#own-at-strike
    strikeBelowSwing: swing === null ? null : strike < swing,
  };
}

/**
 * The sentence shown to the operator, in both the email and the in-app panel.
 *
 * Phrased around ASSIGNMENT because that is the only scenario in which the question matters — the
 * put expiring worthless makes the cost basis hypothetical. The readings are given together rather
 * than reduced to a verdict: collapsing them to a single word would hide that a basis below the
 * 200-day average but at the top of a narrow 52-week range is a different situation from one below
 * both.
 *
 * TWO AXES SINCE v1.1.188, and the second one is why the first got quieter:
 *   long-run — cost basis vs the ticker's SMA200 (and its position in the 52-week range)
 *   support  — the STRIKE vs the lowest low of the last 20 sessions
 *
 * The connective carries the relationship: **and** when the two agree, **but** when they conflict.
 * Measured over 250 stored brief picks / 186 settled (`scripts/dice-entry-annotation-replay.mjs`):
 *
 *   both favourable            18%   +2.17% mean    8% assigned
 *   long-run only              16%   +2.97%         4%
 *   SUPPORT only               14%   +3.46%        26%   <- the best cell of the four
 *   neither                    52%   -2.10%        44%
 *
 * WHAT CHANGED AND WHY IT IS A REMOVAL, NOT AN ADDITION. "That is an extended price, not a
 * discount" used to fire on every basis above SMA200 — 166 of 250 picks (66%), which includes the
 * SUPPORT-only cell that outperformed every other. It now fires only when BOTH readings agree
 * (52%). So the new axis does not add a warning to the operator's morning email; it withdraws one
 * from the picks the data says were fine. A line that fired on two thirds of picks was already
 * close to wallpaper, and the cell it was most wrong about was the one worth taking.
 *
 * The support half is deliberately NOT phrased as a verdict — it states what the stock has and has
 * not traded at. `strikeBelowSwing === null` (too little history) is rendered as silence on that
 * axis, never as either answer.
 */
export function ownAtStrikeNote(ticker: string, r: OwnAtStrikeRead | null): string {
  if (!r) return `Not enough price history for ${ticker} to judge the cost basis against its own range.`;

  const basis = `$${r.costBasis.toFixed(2)}`;
  const pct = Math.abs(r.basisVsSma200Pct).toFixed(1);
  const where = `the ${ordinal(Math.round(r.rangePctile))} percentile of its 52-week range`;
  // Kept UPPERCASE, as it has been since v1.1.169: in an email this is the one word that makes
  // the reading scannable without parsing the sentence.
  const dir = r.atOrBelowSma200 ? 'BELOW' : 'ABOVE';
  const longRun = `If assigned you own ${ticker} at ${basis} — ${pct}% ${dir} its 200-day average, at ${where}`;

  // No support reading: fall back to the EXACT pre-v1.1.188 sentence, "extended price" clause and
  // all. The clause is withdrawn only when the support axis is known AND disagrees — an axis we
  // could not measure must never be the reason a caution disappears. Same fail-closed reasoning as
  // the earnings gate's absent calendar row.
  if (r.strikeBelowSwing === null || r.swingLow20 === null) {
    return r.atOrBelowSma200 ? `${longRun}.` : `${longRun}. That is an extended price, not a discount.`;
  }

  const low = `$${r.swingLow20.toFixed(2)}`;
  const strike = `$${r.strike}`;
  // `and` when the two axes agree, `but` when they disagree — the connective is the merge.
  const agree = r.atOrBelowSma200 === r.strikeBelowSwing;
  const joint = agree ? 'and' : 'but';

  if (r.strikeBelowSwing) {
    return `${longRun} — ${joint} the ${strike} strike sits below its 20-day low of ${low}, `
         + `a price it has not traded at in the last month.`;
  }
  return `${longRun} — ${joint} the ${strike} strike is above its 20-day low of ${low}: `
       + `it has already traded below your strike this month.`
       // Only when BOTH readings agree that this is an extended entry. Before v1.1.188 this
       // clause fired on every basis above SMA200, including the support-only cell that
       // outperformed every other — see the note above.
       + (r.atOrBelowSma200 ? '' : ' An extended price with no recent floor under it.');
}

function ordinal(n: number): string {
  const abs = Math.abs(n) % 100;
  const suffix = abs >= 11 && abs <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][abs % 10] ?? 'th';
  return `${n}${suffix}`;
}
