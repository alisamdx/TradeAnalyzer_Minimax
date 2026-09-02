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
import type { DbHandle } from '../db/connection.js';

/** The wheel's opening leg. `covered-call` is the OTHER wheel slug but requires already owning
 *  the shares — it cannot be the one thing you do with cash, so this feature is CSP-only. */
const WHEEL_ENTRY_SLUG = 'short-naked-put';

/**
 * Ceiling on the CAPITAL a position commits, not on the share price.
 *
 * Share price was the original gate and it is a lossy proxy: the CSP strike sits below spot, so
 * what you actually tie up is `strike x 100`. A $306 stock struck at $285 commits $28,500 while a
 * $299 stock struck at $295 commits $29,500 — the cheaper-looking stock costs more. Measured over
 * 62 stored briefs, switching the gate moved the hit rate 23 -> 25 days and admitted three AAPL
 * setups whose strike was at or under $300 despite spot being over it.
 */
export const DEFAULT_MAX_CAPITAL = 30_000;

/**
 * The exception ceiling — how far a genuinely better setup may exceed the normal limit.
 *
 * An exception mechanism is how a disciplined filter turns into a rationalisation engine, so the
 * stretch tier demands MORE evidence rather than less, on every axis (see `qualifiesForStretch`).
 */
export const DEFAULT_STRETCH_CAPITAL = 50_000;

/** Composite score a stretch pick must beat. Base-eligible picks over 62 briefs ran 58.9–76.0,
 *  median 65.9, p90 73.3 — so 70 is the real "better than a normal day" line. An earlier draft
 *  used 75, which sat above almost the entire observed range and fired on nothing. */
const STRETCH_MIN_SCORE = 70;

/** Liquidity bar for a stretch pick (base is MIN_TRADABLE_LIQUIDITY_SCORE = 8). Median eligible
 *  liquidity is 11; a larger position needs a better exit, not an equal one. */
const STRETCH_MIN_LIQUIDITY = 11;

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

/** The operator's pre-committed price bands for a ticker (`conviction_stocks`). */
export interface ConvictionBands {
  priceLow: number | null;   // "I'd comfortably buy here"
  priceMid: number | null;   // experimental
  priceHigh: number | null;  // "never enter above this"
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
    /** `stretch` = deliberately over the normal capital limit; see `stretchReason`. */
    tier: 'base' | 'stretch';
    stretchReason: string | null;
  } | null;
  noPickReason: string | null;
  briefDate: string | null;
  briefAgeDays: number | null;
  staleWarning: string | null;
  considered: number;
  rejections: Array<{ ticker: string; reason: string }>;
  runnerUp: { ticker: string; compositeScore: number } | null;
}

/**
 * May this pick exceed the normal capital limit?
 *
 * "Genuinely good opportunity" is the phrase that precedes most bad trades, so the exception is
 * defined by evidence the operator committed to BEFORE seeing the setup, plus quality bars
 * calibrated to what the data actually produces:
 *
 *  1. On the conviction list at all — a name already thought about calmly, not one that merely
 *     looks good tonight. A ticker allowlist was rejected as the alternative: favourite names are
 *     exactly where overconfidence lives.
 *  2. Strike at or below `price_high`, the operator's own "never enter above this". The strike is
 *     the price actually paid on assignment, so this asks: have I already ruled this price out?
 *     `price_high` rather than `price_low` deliberately — 3 of 13 stored rows have low > mid, so
 *     only the never-above line is semantically reliable.
 *  3. Composite >= 70 and liquidity >= 11, both above the observed medians.
 *  4. A hard ceiling regardless. An exception without a bound is not an exception.
 *
 * Critic CONFIDENCE is deliberately NOT a criterion: it reads 'high' on 40 of 41 eligible picks,
 * so requiring it would add the appearance of rigour and none of the substance.
 */
function qualifiesForStretch(
  p: DicePickInput,
  s: DiceScoreLike,
  capital: number,
  bands: ConvictionBands | undefined,
  stretchCapital: number,
): { ok: boolean; why: string } {
  if (capital > stretchCapital) {
    return { ok: false, why: `past the $${stretchCapital.toLocaleString()} exception ceiling too` };
  }
  if (!bands) return { ok: false, why: 'not on your conviction list' };
  const strike = s.setup?.legs.find(l => l.side === 'put' && l.action.toLowerCase().startsWith('sell'))?.strike;
  if (bands.priceHigh == null) return { ok: false, why: 'no "never above" band set for it' };
  if (strike == null || strike > bands.priceHigh) {
    return { ok: false, why: `strike $${strike} is above your $${bands.priceHigh} never-above line` };
  }
  if (p.compositeScore < STRETCH_MIN_SCORE) {
    return { ok: false, why: `score ${p.compositeScore.toFixed(1)} under the ${STRETCH_MIN_SCORE} exception bar` };
  }
  if (s.liquidityScore < STRETCH_MIN_LIQUIDITY) {
    return { ok: false, why: `liquidity ${s.liquidityScore.toFixed(0)}/15 under the ${STRETCH_MIN_LIQUIDITY} exception bar` };
  }
  return {
    ok: true,
    why: `on your conviction list, strike $${strike} within your $${bands.priceHigh} never-above line, `
       + `score ${p.compositeScore.toFixed(1)} and liquidity ${s.liquidityScore.toFixed(0)}/15`,
  };
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
 * @param conviction ticker -> the operator's own pre-committed price bands, which is what makes
 *                   the stretch tier a rule rather than a mood
 * @param todayEt   ISO date in ET
 * @param briefDate ISO date the brief was generated
 */
export function rollTheDice(
  picks: readonly DicePickInput[],
  earnings: ReadonlyMap<string, string>,
  conviction: ReadonlyMap<string, ConvictionBands>,
  todayEt: string,
  briefDate: string | null,
  maxCapital: number = DEFAULT_MAX_CAPITAL,
  stretchCapital: number = DEFAULT_STRETCH_CAPITAL,
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

  interface Candidate {
    p: DicePickInput; s: DiceScoreLike; setup: DiceSetupLike;
    shortPut: { strike: number; mid: number; qty?: number };
    capital: number; tier: 'base' | 'stretch'; stretchReason: string | null;
  }
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

    // 3. A price is needed for the cost-basis maths even though the gate is on capital.
    if (p.price == null) { rejections.push({ ticker: p.ticker, reason: 'no price' }); continue; }

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

    // 5b. CAPITAL — the real sizing constraint. Over the base limit a pick is not simply
    //     rejected: it may still qualify as an EXCEPTION, but only by clearing a strictly
    //     higher bar on every axis. Anything past the stretch ceiling is out regardless.
    const capital = shortPut.strike * 100 * (shortPut.qty ?? 1);
    let tier: 'base' | 'stretch' = 'base';
    let stretchReason: string | null = null;
    if (capital > maxCapital) {
      const st = qualifiesForStretch(p, s, capital, conviction.get(p.ticker), stretchCapital);
      if (!st.ok) {
        rejections.push({ ticker: p.ticker, reason: `$${capital.toLocaleString()} over $${maxCapital.toLocaleString()} — ${st.why}` });
        continue;
      }
      tier = 'stretch';
      stretchReason = st.why;
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

    eligible.push({ p, s, setup: s.setup, shortPut, capital, tier, stretchReason });
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
  const premiumPerShare = w.shortPut.mid;
  const creditTotal = w.setup.netCredit!;
  const capitalRequired = w.capital;
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
      tier: w.tier,
      stretchReason: w.stretchReason,
    },
  };
}

/**
 * Compute the dice from the database — the single path used by BOTH the IPC (the in-app button)
 * and the brief job's email, so the two can never disagree about what today's pick is. The brief
 * email already learned this lesson: it builds from the persisted picks rather than an in-memory
 * pre-gate list, specifically so email and UI show identical data.
 *
 * The earnings map is read LIVE rather than trusted from the pick's stored signals, because a
 * brief outlives a calendar correction — a stale stored date is exactly how the brief once put
 * NVDA at wheel #1 on the day it reported.
 */
export function computeRollTheDice(
  db: DbHandle,
  maxCapital: number = DEFAULT_MAX_CAPITAL,
  stretchCapital: number = DEFAULT_STRETCH_CAPITAL,
): DiceResult {
  const brief = db.prepare(
    `SELECT generated_at, picks FROM daily_briefs WHERE strategy = 'wheel'
      ORDER BY generated_at DESC LIMIT 1`,
  ).get() as { generated_at: string; picks: string } | undefined;

  const picks: DicePickInput[] = brief ? (JSON.parse(brief.picks) as DicePickInput[]) : [];
  const todayEt = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  // A ticker with no row is left OUT of the map entirely. `report_date` is NOT NULL and the table
  // is keyed by ticker, so presence always means "we have a date" -- absence means we do not
  // know, and `rollTheDice` fails closed on that.
  const earnings = new Map<string, string>();
  if (picks.length > 0) {
    const marks = picks.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT ticker, report_date FROM earnings_calendar WHERE ticker IN (${marks})`,
    ).all(...picks.map(p => p.ticker)) as Array<{ ticker: string; report_date: string }>;
    for (const r of rows) earnings.set(r.ticker, r.report_date);
  }

  // The operator's own pre-committed bands — what makes the stretch tier a rule, not a mood.
  const conviction = new Map<string, ConvictionBands>();
  for (const r of db.prepare(
    'SELECT ticker, price_low, price_mid, price_high FROM conviction_stocks',
  ).all() as Array<{ ticker: string; price_low: number | null; price_mid: number | null; price_high: number | null }>) {
    conviction.set(r.ticker, { priceLow: r.price_low, priceMid: r.price_mid, priceHigh: r.price_high });
  }

  return rollTheDice(
    picks, earnings, conviction, todayEt,
    brief ? brief.generated_at.slice(0, 10) : null,
    maxCapital, stretchCapital,
  );
}
