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
// THE SECOND DESIGN POINT, ADDED v1.1.168: the gates judge the TRADE, never the OPERATOR.
//
// Two different kinds of "no" were originally mixed here. Trade-quality gates (critic passed and
// actually ran, a constructible and liquid CSP, no earnings inside the hold, a real credit) are
// facts about the setup, and they are what makes "take it unread" defensible. Operator-fit gates
// (the capital ceiling, membership of the conviction list) are facts about the OPERATOR — and
// they were silently deleting candidates exactly as if they were quality failures. The operator
// reported both were miscalibrated: the conviction list is small and not actively maintained, and
// what they can fund is a judgement they would rather make on the day. So fit was demoted to
// annotation. It is computed, it is reported loudly, and it excludes nothing.
//
// The cost of that is real and deliberate: this became "here is today's best wheel entry, check
// you can fund it" rather than "close your eyes and do it", and nothing now enforces the operator's
// own own-at-strike rule — the badge says the band was not checked, but a badge is not a band.
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
 * The operator's normal position size, measured in CAPITAL committed rather than share price.
 *
 * Share price was the original gate and it is a lossy proxy: the CSP strike sits below spot, so
 * what you actually tie up is `strike x 100`. A $306 stock struck at $285 commits $28,500 while a
 * $299 stock struck at $295 commits $29,500 — the cheaper-looking stock costs more.
 *
 * SINCE v1.1.168 THIS IS A BUDGET LINE, NOT A GATE — it removes nothing. A pick above it is still
 * selected on merit and reported with `fit.withinCapital = false`. What the line still does is
 * SPLIT the report: when the merit pick is over budget, `withinBudget` names the best candidate
 * that fits, so demoting the gate never leaves a day with nothing fundable in it.
 */
export const DEFAULT_MAX_CAPITAL = 30_000;

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

/**
 * How the pick sits against the OPERATOR — as opposed to the trade's merit, which is what the
 * hard gates judge. Every field here is reported and none of it excludes: these are facts about
 * the operator's situation, and a stale conviction list or a temporary cash position is not
 * evidence about a trade. See the note on `DEFAULT_MAX_CAPITAL`.
 */
export interface DiceFit {
  /** Does the position fit the operator's stated normal size? */
  withinCapital: boolean;
  /** The line it was compared against, carried so the report can name it rather than imply it. */
  maxCapital: number;
  /** `null` = the ticker is not on the conviction list at all, so nothing was pre-committed about
   *  owning it. Otherwise the never-above band and whether the strike respects it;
   *  `strikeWithinBand` is null when the ticker is listed but has no `price_high` set. */
  conviction: { priceHigh: number | null; strikeWithinBand: boolean | null } | null;
}

export interface DicePick {
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
    fit: DiceFit;
}

export interface DiceResult {
  /** The best candidate on MERIT, regardless of what it costs to fund. */
  pick: DicePick | null;
  /** The best candidate that fits `maxCapital`, present ONLY when `pick` itself does not fit.
   *  Null when the pick already fits (there is nothing extra to offer) or when nothing eligible
   *  fits at all. */
  withinBudget: DicePick | null;
  noPickReason: string | null;
  briefDate: string | null;
  briefAgeDays: number | null;
  staleWarning: string | null;
  considered: number;
  rejections: Array<{ ticker: string; reason: string }>;
  runnerUp: { ticker: string; compositeScore: number } | null;
}

/**
 * Where the strike sits against the operator's own pre-committed price bands.
 *
 * Until v1.1.168 this was an exception GATE (`qualifiesForStretch`): a pick over the capital line
 * could proceed only if it was on the conviction list, inside the never-above band, and above
 * raised score and liquidity bars. That machinery existed for exactly one purpose — letting good
 * trades escape the capital gate — and the capital gate is gone, so it went with it.
 *
 * The band is still the right question to ask about a cash-secured put ("would I own this here?"),
 * so it is still computed and still travels with the pick. It now ANSWERS rather than DECIDES.
 * The operator reported the list is small and no longer actively maintained, which makes absence
 * from it evidence about the list, not about the trade — MPC was refused on 2026-09-03 without
 * its score ever being looked at, which is what prompted the change.
 *
 * `price_high` rather than `price_low` deliberately: only the never-above line is semantically
 * reliable (3 of 13 stored rows sat inverted for three weeks before migration 075).
 */
function assessConviction(strike: number, bands: ConvictionBands | undefined): DiceFit['conviction'] {
  if (!bands) return null;
  return {
    priceHigh: bands.priceHigh,
    strikeWithinBand: bands.priceHigh == null ? null : strike <= bands.priceHigh,
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
 * @param conviction ticker -> the operator's own pre-committed price bands. Reported on the
 *                   pick, never used to exclude one (v1.1.168).
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
    withinBudget: null as DicePick | null,
  };

  if (picks.length === 0) {
    return { ...base, pick: null, noPickReason: 'No wheel picks in the latest brief.' };
  }

  interface Candidate {
    p: DicePickInput; s: DiceScoreLike; setup: DiceSetupLike;
    shortPut: { strike: number; mid: number; qty?: number };
    capital: number; fit: DiceFit;
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

    // 5b. FIT — computed, reported, and deliberately NOT a gate (see `DEFAULT_MAX_CAPITAL`).
    //     Capital used to exclude here, with a stretch tier bolted on to let good trades escape
    //     it; both are gone as of v1.1.168. A filter that deletes a setup before the operator
    //     sees it does not inform their funding decision, it REPLACES it — and on 2026-09-03 it
    //     replaced it wrongly, refusing MPC purely for being absent from a list the operator no
    //     longer maintains, without its score ever being evaluated.
    const capital = shortPut.strike * 100 * (shortPut.qty ?? 1);
    const fit: DiceFit = {
      withinCapital: capital <= maxCapital,
      maxCapital,
      conviction: assessConviction(shortPut.strike, conviction.get(p.ticker)),
    };

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

    eligible.push({ p, s, setup: s.setup, shortPut, capital, fit });
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

  // Highest composite score wins — the brief's own ranking, filtered only on the trade's merit.
  eligible.sort((a, b) => b.p.compositeScore - a.p.compositeScore);
  const w = eligible[0]!;
  const runnerUp = eligible[1]
    ? { ticker: eligible[1].p.ticker, compositeScore: eligible[1].p.compositeScore }
    : null;

  const toPick = (c: Candidate): DicePick => {
    const strike = c.shortPut.strike;
    const premiumPerShare = c.shortPut.mid;
    const effectiveCostBasis = strike - premiumPerShare;
    return {
      ticker: c.p.ticker,
      price: c.p.price!,
      compositeScore: c.p.compositeScore,
      briefRank: c.p.rank,
      strike,
      expiration: c.setup.expiration,
      dte: c.setup.dte,
      premiumPerShare,
      creditTotal: c.setup.netCredit!,
      capitalRequired: c.capital,
      effectiveCostBasis,
      discountToSpotPct: ((c.p.price! - effectiveCostBasis) / c.p.price!) * 100,
      annualizedReturn: c.setup.annualizedReturn,
      popEstimate: c.setup.popEstimate,
      liquidityScore: c.s.liquidityScore,
      grade: c.s.grade,
      criticRationale: c.p.criticVerdict?.rationale ?? null,
      aiRationale: c.p.aiRationale,
      fit: c.fit,
    };
  };

  // When the merit pick is over budget, also name the best candidate that FITS. This is what
  // lets capital stop being a gate without a day going empty: the operator sees the best trade
  // AND a fundable one and chooses, instead of the filter choosing by deletion. `find` over the
  // score-sorted list is the best-fitting candidate by construction. Null when the pick already
  // fits (nothing to add) or when nothing eligible fits at all (nothing to offer).
  const fitting = w.fit.withinCapital ? null : eligible.find(c => c.fit.withinCapital);

  return {
    ...base,
    runnerUp,
    pick: toPick(w),
    withinBudget: fitting ? toPick(fitting) : null,
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

  // The operator's own pre-committed bands. Reported on the pick as of v1.1.168, not a gate.
  const conviction = new Map<string, ConvictionBands>();
  for (const r of db.prepare(
    'SELECT ticker, price_low, price_mid, price_high FROM conviction_stocks',
  ).all() as Array<{ ticker: string; price_low: number | null; price_mid: number | null; price_high: number | null }>) {
    conviction.set(r.ticker, { priceLow: r.price_low, priceMid: r.price_mid, priceHigh: r.price_high });
  }

  return rollTheDice(
    picks, earnings, conviction, todayEt,
    brief ? brief.generated_at.slice(0, 10) : null,
    maxCapital,
  );
}
