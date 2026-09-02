// Roll the Dice — ONE wheel entry, or nothing.
//
// The Daily Brief presents five strategies and ranks candidates within each. This narrows that
// to a single cash-secured put the operator can act on without reading the whole brief. The name
// is honest: it is still a trade, and it can still lose.
//
// THE DESIGN POINT THAT MATTERS: this function must be able to return NOTHING.
//
// A "close your eyes and do it" feature that always produces a pick would have to lower its bar
// on a bad day, which is precisely when the bar matters. "No dice today" is a first-class result,
// and every rejection is reported so the bar is visibly real rather than a claim.
//
// The gates are HARD, not weighted. The brief already scores and ranks; this layer only removes.
// In particular the earnings gate is an exclusion, not the brief's −20 penalty: this session
// opened with "the last few days brief recommended NVDA, when earnings was days away" — a −20
// penalty on a high scorer still leaves it on top. For a pick meant to be taken unread, an
// earnings event inside the hold window disqualifies outright.
//
// see docs/formulas.md#roll-the-dice

import { MIN_TRADABLE_LIQUIDITY_SCORE } from '@shared/strategy-structures.js';

/** The wheel's opening leg. `covered-call` is the OTHER wheel slug but requires already owning
 *  the shares — it cannot be the one thing you do with cash, so this feature is CSP-only. */
const WHEEL_ENTRY_SLUG = 'short-naked-put';

/** Default ceiling on share price, per the operator's sizing rule: a $300 stock is a $30,000
 *  cash-secured commitment, and above that a single assignment dominates the book. */
export const DEFAULT_MAX_PRICE = 300;

/** A brief older than this is surfaced with a staleness warning rather than silently trusted.
 *  Not a hard gate — a Saturday review of Friday's brief is legitimate — but a blind action on
 *  a week-old brief is not, so the age always travels with the pick. */
const STALE_AFTER_DAYS = 1;

export interface DiceSetupLike {
  expiration: string;
  dte: number;
  legs: Array<{ action: string; side?: 'call' | 'put' | null; strike: number; mid: number; qty?: number }>;
  netCredit: number | null;
  maxLoss: number | null;
  breakevens: number[];
  annualizedReturn: number | null;
  popEstimate: number | null;
  unavailableReason?: string | null;
}

export interface DiceScoreLike {
  slug: string;
  grade: string;
  liquidityScore: number;
  setup: DiceSetupLike | null;
}

export interface DicePickInput {
  ticker: string;
  compositeScore: number;
  rank: number;
  price: number | null;
  aiRationale: string | null;
  criticVerdict?: {
    verdict: 'pass' | 'caution' | 'flag';
    confidence?: 'high' | 'medium' | 'low';
    rationale: string | null;
    degraded?: boolean;
  } | null;
  strategyLabResult?: { scores?: DiceScoreLike[] } | null;
}

export interface DiceResult {
  pick: {
    ticker: string;
    price: number;
    compositeScore: number;
    briefRank: number;
    strike: number;
    expiration: string;
    dte: number;
    premiumPerShare: number;
    creditTotal: number;
    capitalRequired: number;
    effectiveCostBasis: number;
    discountToSpotPct: number;
    annualizedReturn: number | null;
    popEstimate: number | null;
    liquidityScore: number;
    grade: string;
    criticRationale: string | null;
    aiRationale: string | null;
  } | null;
  noPickReason: string | null;
  briefDate: string | null;
  briefAgeDays: number | null;
  staleWarning: string | null;
  considered: number;
  rejections: Array<{ ticker: string; reason: string }>;
  runnerUp: { ticker: string; compositeScore: number } | null;
}

/** Whole days between two ISO dates (date part only). */
function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(`${fromIso.slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${toIso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

/**
 * Pick the single wheel entry, or explain why there isn't one.
 *
 * @param picks     the wheel bucket of the most recent brief, any order
 * @param earnings  ticker → next report date (ISO). `earnings_calendar.report_date` is NOT
 *                  NULL and the table is keyed by ticker, so a ticker is either present WITH a
 *                  date or absent entirely — there is no "present, nothing scheduled" state.
 *                  Absent means UNKNOWN, which fails closed; see the gate below.
 * @param todayEt   ISO date in ET
 * @param briefDate ISO date the brief was generated
 */
export function rollTheDice(
  picks: readonly DicePickInput[],
  earnings: ReadonlyMap<string, string>,
  todayEt: string,
  briefDate: string | null,
  maxPrice: number = DEFAULT_MAX_PRICE,
): DiceResult {
  const rejections: Array<{ ticker: string; reason: string }> = [];
  const briefAgeDays = briefDate ? daysBetween(briefDate, todayEt) : null;
  const staleWarning =
    briefAgeDays != null && briefAgeDays > STALE_AFTER_DAYS
      ? `This brief is ${briefAgeDays} days old — prices and the critic's read have moved. Re-run the batch before acting on it.`
      : null;

  const base = {
    noPickReason: null as string | null,
    briefDate,
    briefAgeDays,
    staleWarning,
    considered: picks.length,
    rejections,
    runnerUp: null as { ticker: string; compositeScore: number } | null,
  };

  if (picks.length === 0) {
    return { ...base, pick: null, noPickReason: 'No wheel picks in the latest brief.' };
  }

  interface Candidate { p: DicePickInput; s: DiceScoreLike; setup: DiceSetupLike; shortPut: { strike: number; mid: number; qty?: number } }
  const eligible: Candidate[] = [];

  for (const p of picks) {
    // 1. The critic must have passed it outright. `caution` and `flag` both fail: the whole
    //    premise is a pick that needs no reading, and a caution is something to read.
    const cv = p.criticVerdict;
    if (!cv) { rejections.push({ ticker: p.ticker, reason: 'no critic verdict' }); continue; }
    if (cv.verdict !== 'pass') { rejections.push({ ticker: p.ticker, reason: `critic ${cv.verdict}` }); continue; }

    // 2. A DEGRADED verdict is the rule-based fallback shown when the LLM critic never ran.
    //    It is un-vetted, not an all-clear — the v2 entry gate rejects it fail-closed and so
    //    does this. Without the check, an Anthropic outage would silently widen the funnel on
    //    exactly the day nothing adversarial had reviewed the pick.
    if (cv.degraded === true) { rejections.push({ ticker: p.ticker, reason: 'critic degraded (un-vetted)' }); continue; }

    // 3. Share price ceiling — the operator's sizing rule.
    if (p.price == null) { rejections.push({ ticker: p.ticker, reason: 'no price' }); continue; }
    if (p.price > maxPrice) { rejections.push({ ticker: p.ticker, reason: `$${p.price.toFixed(0)} over $${maxPrice} limit` }); continue; }

    // 4. A constructible cash-secured put.
    const s = (p.strategyLabResult?.scores ?? []).find(x => x.slug === WHEEL_ENTRY_SLUG);
    if (!s?.setup || s.setup.unavailableReason) {
      rejections.push({ ticker: p.ticker, reason: 'no CSP available' }); continue;
    }
    const shortPut = s.setup.legs.find(l => l.side === 'put' && l.action.toLowerCase().startsWith('sell'));
    if (!shortPut) { rejections.push({ ticker: p.ticker, reason: 'CSP has no short put leg' }); continue; }

    // 5. Liquidity — you must be able to get out. Same bar the critic and v2 engine use.
    if (s.liquidityScore < MIN_TRADABLE_LIQUIDITY_SCORE) {
      rejections.push({ ticker: p.ticker, reason: `illiquid (${s.liquidityScore.toFixed(0)}/15)` }); continue;
    }

    // 6. EARNINGS — a hard exclusion, not the brief's −20 penalty. A short put through an
    //    earnings print is a different trade from the one being recommended. An UNKNOWN date
    //    also fails: for a pick taken unread, "we have no calendar entry" is not "it's clear".
    const rd = earnings.get(p.ticker);
    if (rd === undefined) { rejections.push({ ticker: p.ticker, reason: 'earnings date unknown' }); continue; }

    //    A stored date already in the PAST does not mean "clear" -- it means the row has not
    //    been refreshed since that report, so the NEXT date is unknown. Measured 2026-09-02:
    //    57 of 1,069 `earnings_calendar` rows were stale this way. Treating them as clear is
    //    the same mistake this session opened with -- "there is a date stored" is not "the
    //    stored date is right" -- so a stale row fails closed like an absent one.
    if (rd < todayEt) {
      rejections.push({ ticker: p.ticker, reason: `earnings calendar stale (last known ${rd})` }); continue;
    }
    if (rd <= s.setup.expiration) {
      rejections.push({ ticker: p.ticker, reason: `earnings ${rd} before ${s.setup.expiration} expiry` }); continue;
    }

    // 7. The credit must be real — a zero/negative credit is a broken chain, not a trade.
    if (s.setup.netCredit == null || s.setup.netCredit <= 0) {
      rejections.push({ ticker: p.ticker, reason: 'no net credit' }); continue;
    }

    eligible.push({ p, s, setup: s.setup, shortPut });
  }

  if (eligible.length === 0) {
    // Summarise WHY nothing qualified — the most common rejection is the useful headline.
    const tally = rejections.reduce<Record<string, number>>((a, r) => {
      const k = r.reason.replace(/\$[\d.]+|\d{4}-\d{2}-\d{2}|\(\d+\/15\)/g, '').trim();
      a[k] = (a[k] ?? 0) + 1; return a;
    }, {});
    const top = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
    return {
      ...base, pick: null,
      noPickReason: `No dice today — ${picks.length} wheel pick${picks.length === 1 ? '' : 's'} considered, none cleared every gate`
        + (top ? ` (most common: ${top[0]}, ${top[1]}).` : '.'),
    };
  }

  // Highest composite score wins — the brief's own ranking, just filtered.
  eligible.sort((a, b) => b.p.compositeScore - a.p.compositeScore);
  const w = eligible[0]!;
  const runnerUp = eligible[1]
    ? { ticker: eligible[1].p.ticker, compositeScore: eligible[1].p.compositeScore }
    : null;

  const strike = w.shortPut.strike;
  const qty = w.shortPut.qty ?? 1;
  const premiumPerShare = w.shortPut.mid;
  const creditTotal = w.setup.netCredit!;
  const capitalRequired = strike * 100 * qty;
  const effectiveCostBasis = strike - premiumPerShare;

  return {
    ...base,
    runnerUp,
    pick: {
      ticker: w.p.ticker,
      price: w.p.price!,
      compositeScore: w.p.compositeScore,
      briefRank: w.p.rank,
      strike,
      expiration: w.setup.expiration,
      dte: w.setup.dte,
      premiumPerShare,
      creditTotal,
      capitalRequired,
      effectiveCostBasis,
      discountToSpotPct: ((w.p.price! - effectiveCostBasis) / w.p.price!) * 100,
      annualizedReturn: w.setup.annualizedReturn,
      popEstimate: w.setup.popEstimate,
      liquidityScore: w.s.liquidityScore,
      grade: w.s.grade,
      criticRationale: w.p.criticVerdict?.rationale ?? null,
      aiRationale: w.p.aiRationale,
    },
  };
}
