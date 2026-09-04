// AI Critic — second-opinion engine for Daily Brief picks.
// Runs rule-based pre-checks then calls Claude haiku with a skeptic prompt.
// see Requirements/ai-critic.md

import type { Database } from 'better-sqlite3';
import Anthropic from '@anthropic-ai/sdk';
import type { BriefPick, CriticFlag, CriticVerdict, ScoringConfig } from '@shared/types.js';
import { STRATEGY_RELEVANT_SLUGS, pickRelevantStructure, formatStructureLegs, MIN_TRADABLE_LIQUIDITY_SCORE } from '@shared/strategy-structures.js';
import { readOwnAtStrike, type PriceWindow } from '@shared/own-at-strike.js';
import { isEarningsPending } from './earnings-service.js';

// A VIX value older than this is treated as unknown (null), not stale-but-confident.
// refreshVixQuote runs at the top of every brief (both daily slots, ~18h apart on a normal
// day), so a value this old means the fetch has been failing (e.g. E*Trade auth) — the cached
// number no longer describes today's market. Fail-safe: null skips the VIX rules entirely.
const VIX_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Grade ordering for structure quality checks (A+=best, F=worst).
// 'A+' must be present: lab grades include it, and a missing key ranks 0 (below F).
const GRADE_RANK: Record<string, number> = { 'A+': 6, A: 5, B: 4, C: 3, D: 2, F: 1 };

// Shape of strategy-lab scores embedded in BriefPick.strategyLabResult.
// One definition shared by every rule/context consumer so they all select
// the SAME structure — a flag citing one structure's liquidity while the
// LLM context shows another's confuses the critic (observed: HAYW 5/15 vs 3/15).
interface LabStructureScore {
  slug: string;
  grade: string;
  liquidityScore: number;
  setup: {
    expiration: string;
    netCredit: number | null;
    maxLoss?: number | null;   // null/absent ⇒ unbounded risk (drives defined-risk preference)
    maxProfit?: number | null; // null ⇒ unbounded profit (net-long calls)
    breakevens?: number[];
    legs: Array<{ strike: number; action: string; side?: 'call' | 'put'; qty?: number; bid?: number; ask?: number }>;
    unavailableReason?: string | null;
  } | null;
}
interface LabResultShape {
  // currentAtmIv / ivRank are the underlying's annualized ATM implied vol (percentage)
  // and its 1-year rank — fed to the LLM so it never has to invent a volatility figure.
  context?: { underlyingPx?: number; currentAtmIv?: number; ivRank?: number; ivPercentile?: number };
  scores?: LabStructureScore[];
}

export interface MarketContext {
  vix: number | null;
  spyAbove200ma: boolean | null;
}

/**
 * Distance (% of spot) from the current price to the NEAREST breakeven of a
 * short-premium structure — how far price can move before the structure loses.
 *
 * For an at-the-money short straddle this equals credit/price, but for short
 * strangles, iron condors, and OTM-strike cash-secured puts the short strikes
 * sit away from spot, so the true breakeven is `shortStrike ± credit` and
 * credit/price badly UNDERSTATES it (e.g. a 25%-OTM iron condor reads ~2% on
 * the old proxy but is really ~28%). Returns the binding (nearer) side, or null
 * when there is no short leg or an input is missing.
 *
 * `netCredit` is per-contract (×100 shares). Leg `side` is used when present;
 * older data without it infers put/call from strike-vs-spot.
 * see docs/formulas.md#breakeven-distance
 */
export function breakevenDistancePct(
  legs: Array<{ strike: number; action: string; side?: 'call' | 'put' }>,
  netCredit: number | null,
  price: number | null,
): number | null {
  if (netCredit === null || price === null || price <= 0) return null;
  const sells = legs.filter(l => l.action === 'sell');
  if (sells.length === 0) return null;
  const creditPerShare = Math.abs(netCredit) / 100;
  const sideOf = (l: { strike: number; side?: 'call' | 'put' }): 'call' | 'put' =>
    l.side ?? (l.strike <= price ? 'put' : 'call');
  const putStrikes  = sells.filter(l => sideOf(l) === 'put').map(l => l.strike);
  const callStrikes = sells.filter(l => sideOf(l) === 'call').map(l => l.strike);
  const dists: number[] = [];
  if (putStrikes.length) {
    const shortPut = Math.max(...putStrikes);          // nearest put = highest strike
    dists.push(((price - (shortPut - creditPerShare)) / price) * 100);
  }
  if (callStrikes.length) {
    const shortCall = Math.min(...callStrikes);        // nearest call = lowest strike
    dists.push((((shortCall + creditPerShare) - price) / price) * 100);
  }
  if (dists.length === 0) return null;
  return +Math.min(...dists).toFixed(1);
}

/**
 * Pull the real volatility figures out of a pick's lab context for the critic LLM, so it
 * never has to invent one. impliedVolPct is the underlying's annualized ATM implied vol (%);
 * `realizedVolPct` (the recentVolatility scoring signal the advocate cites as "recent
 * volatility") is included when known so the critic can reconcile the advocate's number
 * instead of mistaking it for an IV discrepancy. Returns null (→ the prompt forbids citing
 * any vol figure) only when NEITHER measure is available.
 */
/**
 * Expected 1-sigma move of the underlying over the hold: impliedVolPct × √(dte/365), returned
 * as both a percentage and (when price is known) a dollar amount. PRECOMPUTED so the critic
 * LLM cites it instead of doing the arithmetic itself — it routinely overstated the move (AMD
 * wheel "±$149 (~29%)" vs the true ±$104/20.5%; MRVL bullish "~$152" vs ±$82/29.5%), the same
 * class of error as the IV fabrication the volatility context already fixed. Returns nulls when
 * IV is missing/non-finite or dte ≤ 0. see docs/formulas.md#expected-move
 */
export function expectedOneSigmaMove(
  impliedVolPct: number | null | undefined,
  dte: number | null,
  price: number | null,
): { pct: number | null; usd: number | null } {
  if (typeof impliedVolPct !== 'number' || !Number.isFinite(impliedVolPct) || dte === null || dte <= 0) {
    return { pct: null, usd: null };
  }
  const pct = impliedVolPct * Math.sqrt(dte / 365);
  const usd = typeof price === 'number' && Number.isFinite(price) && price > 0 ? (price * pct) / 100 : null;
  return { pct: +pct.toFixed(1), usd: usd !== null ? +usd.toFixed(2) : null };
}

export function extractVolatilityContext(
  labResult: { context?: { currentAtmIv?: number; ivRank?: number } } | null,
  realizedVolPct: number | null = null,
): { impliedVolPct: number | null; ivRank: number | null; realizedVolPct?: number } | null {
  const iv = labResult?.context?.currentAtmIv;
  const hasIv = typeof iv === 'number' && Number.isFinite(iv);
  if (!hasIv && realizedVolPct === null) return null;
  const rank = labResult?.context?.ivRank;
  return {
    impliedVolPct: hasIv ? +iv!.toFixed(1) : null,
    ivRank: hasIv && typeof rank === 'number' && Number.isFinite(rank) ? +rank.toFixed(0) : null,
    ...(realizedVolPct !== null && { realizedVolPct }),
  };
}

/**
 * v1.1.189 — what the adversarial reviewer is allowed to see.
 *
 * Two defects, measured on 948 stored picks, both in the same direction: the reviewer was shown a
 * filtered-favourable view of the pick it was meant to attack.
 *
 * 1. THE SIGNAL LIST SELECTED FOR GOOD NEWS. `topSignals` sorted by `weight × normalized` and took
 *    4 — a descending sort on CONTRIBUTION, so a signal scoring badly is pushed out by the
 *    arithmetic. Measured: the worst-scoring signal reached the critic on **8.3%** of picks, and a
 *    reading below 35/100 reached it on **2.8%** (18 of 653). On the DINO pick that raised this,
 *    `technicalNeutral` at 30.6/100 — the app's own "this is extended" read — never arrived, while
 *    `notDowntrend` at 100 did. 24% of wheel picks were passed clean, with no warning flag, while
 *    carrying a sub-35 reading the reviewer never saw.
 * 2. THE ONE MEASURED OWNERSHIP READ WAS COMPUTED AFTER IT. `own-at-strike` runs in
 *    `roll-the-dice.ts`, downstream of the verdict, so the critic has never seen it in any form.
 *    On 82 critic-PASSED wheel picks, 57 (70%) had a cost basis above the ticker's own 200-day
 *    average and 37 were more than 10% above — DELL at +97.9%, AMD at +79.2%. The reviewer was not
 *    given the chance to have an opinion about that.
 *
 * WHAT THIS DOES NOT DO. It does not re-weight anything, and it deliberately says NOTHING new
 * about TREND — that is T7, still open, and `docs/wheel-parameters.md` records why a prompt tweak
 * there is not justified on current evidence.
 *
 * MEASURED, AND BOTH HALVES DEFAULT **OFF**. The verdict is a hard gate, so this changes which
 * trades are taken (FR-SEY-5). An outcome replay is not constructible — "verdict flipped" ∩ "expiry
 * settled" over one regime is a handful of trades — so `tests/critic-context-ab.test.ts` measures
 * the blast radius instead. On 20 wheel picks, 2026-09-04:
 *
 *     before   pass 8   caution 10   flag 2
 *     after    pass 0   caution 19   flag 1        <- 40% stricter, and NO PASSES SURVIVE
 *
 * **The dice rejects anything that is not `pass`, so this would have taken it to zero picks.**
 *
 * THE CAUSE IS THE OWNERSHIP HALF, and every one of the 8 flipped rationales says so in its own
 * words — each cites the cost basis against SMA200, none cites a weak signal. The model treats ANY
 * basis above the 200-day as a caution, including **AAPL at 4.5% above**. That is precisely the
 * error v1.1.188 removed from the operator-facing sentence: a basis above SMA200 is the NORMAL
 * case (70% of 82 critic-passed wheel picks) and the support-only cell — above SMA200 but with the
 * strike under the 20-day low — was the BEST performing of the four (+3.46% mean / +5.49% median).
 * Handing a reviewer a 70%-prevalence property with no base rate turns it into a blanket veto.
 *
 * **The general lesson, which outlives this flag: giving a model a measured fact is not the same as
 * giving it the fact's base rate, and without the base rate a common property reads as an alarm.**
 * The same shape as the conviction band (a threshold that could never fire) inverted — a threshold
 * that always fires.
 *
 * The signals half is UNMEASURED ALONE. It is defaulted off too, not because it was shown harmful
 * but because the only measurement available bundled it with a half that was, and FR-SEY-5 does not
 * accept "probably fine". Isolate it with CRITIC_CONTEXT_SIGNALS=1 and re-run the A/B.
 */
/**
 * MEASURED AND DEFAULTED OFF — see the A/B result below. Split into two flags because the two
 * halves turned out to behave completely differently and must be testable apart.
 */
const CRITIC_CONTEXT_SIGNALS = false;
const CRITIC_CONTEXT_OWNERSHIP = false;

/** Show the reviewer the pick's WEAKEST reading, not only its best contributors. */
function criticSignalsV2(): boolean {
  return process.env['CRITIC_CONTEXT_SIGNALS'] === '1' ? true
       : process.env['CRITIC_CONTEXT_SIGNALS'] === '0' ? false
       : CRITIC_CONTEXT_SIGNALS;
}
/** Put the own-at-strike read in the reviewer's context (wheel only). */
function criticOwnershipV2(): boolean {
  return process.env['CRITIC_CONTEXT_OWNERSHIP'] === '1' ? true
       : process.env['CRITIC_CONTEXT_OWNERSHIP'] === '0' ? false
       : CRITIC_CONTEXT_OWNERSHIP;
}

export interface CriticSignalEntry {
  key: string; raw: number | null; normalized: number; weight: number;
  /** Present only on the pick's worst reading — see `selectCriticSignals`. */
  isWeakestReading?: true;
}

/**
 * Which signals the reviewer is shown.
 *
 * The 4 biggest CONTRIBUTORS, as it has always been — plus, since v1.1.189, the pick's WEAKEST
 * reading when it did not already make that cut. The original sort is descending on
 * `weight × normalized`, which is a sort on GOOD NEWS: a signal scoring badly has a small product
 * and is pushed out by the arithmetic, so an adversarial reviewer was handed the bull case by
 * construction. Measured over 948 stored picks — the worst-scoring signal reached the critic on
 * 8.3% of them, a reading below 35/100 on 2.8% (18 of 653).
 *
 * The weakest entry is MARKED rather than silently appended: "the worst thing measured about this
 * pick" and "one of the things that drove the score" are different claims, and the prompt leans on
 * the distinction.
 *
 * Deliberately still a SAMPLE and not the whole signal set. Three of the signals this would
 * otherwise surface for wheel — `technicalNeutral`, `recentVolatility`, `notDowntrend` — were
 * measured flat, mildly inverted and anti-predictive respectively (T6, v1.1.178), so handing the
 * model every reading would invite confident cautions built on signals this project has already
 * shown do not predict. One guaranteed sight of the worst reading is the smallest change that
 * removes the bias.
 */
export function selectCriticSignals(signals: BriefPick['signals']): CriticSignalEntry[] {
  const scored = Object.entries(signals).filter(([, v]) => !v.missing && v.raw !== null);
  const byContribution = [...scored]
    .sort((a, b) => b[1].weight * b[1].normalized - a[1].weight * a[1].normalized)
    .slice(0, 4);
  const weakest = [...scored].sort((a, b) => a[1].normalized - b[1].normalized)[0];
  const shown = new Set(byContribution.map(([k]) => k));
  const selected = criticSignalsV2() && weakest && !shown.has(weakest[0])
    ? [...byContribution, weakest]
    : byContribution;
  return selected.map(([key, v]) => ({
    key, raw: v.raw, normalized: v.normalized, weight: v.weight,
    ...(criticSignalsV2() && weakest && key === weakest[0] ? { isWeakestReading: true as const } : {}),
  }));
}


export class CriticService {
  constructor(private readonly db: Database) {}

  // Reads VIX from quote_cache and SPY 200MA from historical_prices.
  getMarketContext(): MarketContext {
    type QuoteRow = { last: number };
    // VIX is populated daily by the brief job (`refreshVixQuote` → E*Trade /market/quote,
    // sane-range-validated, upserted to quote_cache). It is null when E*Trade is not
    // connected, the fetch fails, the value is out of range, or the account's index
    // symbol differs from 'VIX' — in which case the macro context is SPY-trend only and
    // the two VIX rules (wheel/income >30, bearish <14) skip (fail-safe). NOTE: Polygon's
    // *stocks* snapshot cannot serve VIX (it is an index, I:VIX), so this is the only
    // source. see CLAUDE.md "Known quirks" / .ai/AI_CONTEXT.md §10.
    const vixRow = this.db.prepare(
      `SELECT last, fetched_at FROM quote_cache WHERE ticker = 'VIX' LIMIT 1`
    ).get() as (QuoteRow & { fetched_at: string }) | undefined;
    const vixFresh = vixRow !== undefined
      && (Date.now() - new Date(vixRow.fetched_at).getTime()) <= VIX_MAX_AGE_MS;
    const vix = vixFresh ? vixRow!.last : null;

    let spyAbove200ma: boolean | null = null;
    try {
      type PriceRow = { close: number };
      const rows = this.db.prepare(`
        SELECT close FROM historical_prices
        WHERE ticker = 'SPY'
        ORDER BY date DESC LIMIT 201
      `).all() as PriceRow[];
      if (rows.length >= 201) {
        const currentClose = rows[0]!.close;
        const ma200 = rows.slice(1, 201).reduce((sum, r) => sum + r.close, 0) / 200;
        spyAbove200ma = currentClose > ma200;
      }
    } catch { /* non-fatal — SPY bars may not be loaded */ }

    return { vix, spyAbove200ma };
  }

  // Deterministic rule checks — no DB or LLM calls; all data comes from the pick.
  runRuleChecks(
    pick: BriefPick,
    strategy: string,
    strategyConfig: ScoringConfig,
    allPicksByStrategy: Map<string, BriefPick[]>,
    market: MarketContext,
  ): CriticFlag[] {
    const flags: CriticFlag[] = [];

    const f = (flag: CriticFlag | null) => { if (flag) flags.push(flag); };

    f(this.checkTrendAlignment(pick, strategy));
    f(this.checkLiquidity(pick, strategy));
    f(this.checkCriticalSignalMissing(pick, strategyConfig));
    f(this.checkScoreConcentration(pick));
    f(this.checkCrossStrategyConflict(pick, strategy, allPicksByStrategy));
    f(this.checkMarketRisk(strategy, market));
    f(this.checkAnomalousMomentum(pick));
    f(this.checkEarningsInWindow(pick, strategy));
    f(this.checkStructureGrade(pick, strategy));
    f(this.checkHighVolNakedStructure(pick, strategy));
    f(this.checkThinBreakeven(pick, strategy));
    f(this.checkCounterTrendStrike(pick, strategy, market));
    f(this.checkLabPriceConsistency(pick));

    return flags;
  }

  // LLM synthesis — one sonnet call per pick with adversarial system prompt.
  async synthesizeVerdict(
    pick: BriefPick,
    strategy: string,
    flags: CriticFlag[],
    apiKey: string,
    market: MarketContext,
  ): Promise<CriticVerdict> {
    const generatedAt = new Date().toISOString();
    const today = new Date().toISOString().slice(0, 10);
    const hasWarning = flags.some(f => f.severity === 'warning');
    const baseVerdict: CriticVerdict['verdict'] = hasWarning ? 'flag' : flags.length > 0 ? 'caution' : 'pass';
    const baseConfidence: CriticVerdict['confidence'] =
      flags.some(f => f.key === 'critical_signal_missing') ? 'medium' : 'high';

    try {
      // maxRetries above the SDK default (2): the critic is the engine's adversarial gate, and a
      // transient Anthropic overload (429/500/529) blanking it degrades the whole brief (and used
      // to fail OPEN). 4 retries with the SDK's exponential backoff rides out brief overloads.
      const client = new Anthropic({ apiKey, maxRetries: 4 });

      const topSignals = selectCriticSignals(pick.signals);

      // The own-at-strike read (v1.1.169/188), which until now was computed in `roll-the-dice.ts`
      // AFTER this verdict and so had never reached the reviewer in any form. Wheel only: the
      // measurement behind it (T8) is a short-put study and says nothing about the other
      // strategies. Never throws — a missing price window degrades to `null`, which the prompt
      // instructs the model to treat as unknown rather than as clear.
      const ownership = criticOwnershipV2() && strategy === 'wheel'
        ? this.readOwnership(pick, strategy)
        : null;

      // Extract the chosen relevant structure for context via the shared selector —
      // the same structure every rule check refers to. Structures with
      // unavailableReason are excluded (non-null setup but no actionable legs).
      let structure: Record<string, unknown> | null = null;
      let structureExpiry: string | null = null;
      let structureDte: number | null = null; // hoisted: also feeds the precomputed expected move
      const presentAsStock = this.shouldPresentAsStock(pick, strategy);

      {
        const best = this.selectRelevantStructure(pick, strategy);
        if (best?.setup) {
          const shortLeg = best.setup.legs.find(l => l.action === 'sell');
          const credit = best.setup.netCredit;
          const strike = shortLeg?.strike ?? null;
          const price = pick.price;
          structureExpiry = best.setup.expiration;

          // DTE: pre-computed — removes LLM date arithmetic errors
          const dte = structureExpiry
            ? Math.round((new Date(structureExpiry).getTime() - new Date(today).getTime()) / 86400000)
            : null;
          structureDte = dte;

          // Strike-vs-spot %: (strike - price) / price. Positive = strike above spot
          // (OTM for short calls, ITM for short puts). The prompt defines this
          // side-aware — do not describe it as simply "positive = OTM".
          const strikeOtmPct = (strike !== null && price !== null && price > 0)
            ? +((strike - price) / price * 100).toFixed(1)
            : null;

          // Breakeven distance %: for income, how far price can move before the structure
          // loses — strike-aware (correct for strangles/condors, not just ATM straddles).
          // see docs/formulas.md#breakeven-distance
          const beDistancePct = strategy === 'income'
            ? breakevenDistancePct(best.setup.legs, credit, price)
            : null;

          structure = {
            type: best.slug,
            grade: best.grade,
            // Full leg list so the critic sees the WHOLE structure, not just the short
            // strike — multi-leg structures (zebra/butterfly/condor) were misread otherwise.
            legs: formatStructureLegs(best.setup.legs),
            shortStrike: strike,
            expiry: structureExpiry,
            dte,
            credit,
            // Computed payoff bounds (per-contract, ×100). maxLoss null ⇒ UNBOUNDED loss (only
            // naked short calls); a finite value is the real worst case — feeding it stops the
            // LLM calling a bounded short-PUT loss "unlimited/uncapped" (it's worst at S→0).
            maxProfit: best.setup.maxProfit ?? null,
            maxLoss: best.setup.maxLoss ?? null,
            ...(best.setup.breakevens && best.setup.breakevens.length > 0 && { breakevens: best.setup.breakevens }),
            liquidityScore: best.liquidityScore,
            ...(strikeOtmPct !== null && { strikeOtmPct }),
            ...(beDistancePct !== null && { breakevenDistancePct: beDistancePct }),
            ...(presentAsStock && {
              presentation: 'stock purchase — all option structures graded C/F in the current IV regime; ' +
                'the structure above is an optional alternative, not the recommendation',
            }),
          };
        }
      }

      // Include 52-week return so the model can calibrate price level without relying
      // on training data (e.g. a stock up 300% YoY is correctly priced at 4× its old level).
      const price52wReturn = pick.signals['priceMomentumPct']?.missing === false
        ? (pick.signals['priceMomentumPct']?.raw ?? null)
        : null;

      // Real volatility, so the model never invents an IV/realized-vol figure. The lab
      // context carries the underlying's annualized ATM implied vol (a percentage) and
      // its 1-year rank — without these the prompt's "expected 1-sigma move" instruction
      // forced the LLM to fabricate a vol number (e.g. "140.8% IV" vs the true 104.7%).
      // Also surface the realized-vol scoring signal the advocate cites as "recent
      // volatility" — without it the critic mistook the advocate's realized figure for an
      // IV claim and flagged a phantom "IV discrepancy" (e.g. ASTS 138.7% vs IV 111.6%).
      const rvSig = pick.signals['recentVolatility'];
      const realizedVolPct = rvSig && rvSig.missing === false && typeof rvSig.raw === 'number'
        ? +rvSig.raw.toFixed(1) : null;
      const volatilityBase = extractVolatilityContext(pick.strategyLabResult as LabResultShape | null, realizedVolPct);
      // Precompute the expected 1-sigma move so the LLM cites it rather than (mis)computing it.
      const expMove = expectedOneSigmaMove(volatilityBase?.impliedVolPct ?? null, structureDte, pick.price);
      const volatility = volatilityBase && {
        ...volatilityBase,
        ...(expMove.pct !== null && { expectedMove1SigmaPct: expMove.pct }),
        ...(expMove.usd !== null && { expectedMove1SigmaUsd: expMove.usd }),
      };

      // Earnings within the hold window — single most important event risk for options
      const earningsInWindow = structureExpiry
        ? this.getEarningsBeforeExpiry(pick.ticker, structureExpiry, today)
        : null;
      // Distinguish "known clear" from "no data": ~11% of the universe has no
      // future earnings row, and the AI must not read that absence as safety.
      const earningsKnown = this.hasFutureEarningsRow(pick.ticker, today);

      const context = {
        ticker: pick.ticker,
        strategy,
        compositeScore: pick.compositeScore,
        marketData: {
          price: pick.price,
          date: today,
          price52wReturnPct: price52wReturn,
        },
        marketContext: {
          vix: market.vix,
          vixLevel: market.vix === null ? null
            : market.vix < 15 ? 'low — complacency regime (<15)'
            : market.vix > 25 ? 'high — fear regime (>25)'
            : 'normal (15–25)',
          spyTrend: market.spyAbove200ma === null ? null
            : market.spyAbove200ma ? 'bullish — SPY above 200-day MA'
            : 'bearish — SPY below 200-day MA',
        },
        earningsInWindow,  // null = no earnings before expiry; otherwise { date, daysFromNow, confirmed }
        earningsKnown,     // false = calendar has no future earnings data for this ticker at all
        volatility,        // { impliedVolPct, ivRank, realizedVolPct?, expectedMove1SigmaPct?, expectedMove1SigmaUsd? } — or null
        ...(ownership ? { ownership } : {}),   // wheel only; absent means it could not be measured
        topSignals,
        structure,
        advocateRationale: pick.aiRationale,
        ruleFlags: flags,
      };

      const systemPrompt = `You are a risk-focused options trading analyst reviewing daily trade recommendations.
Be skeptical and specific — but calibrate your verdict to the actual risk level.

VERDICT CALIBRATION (apply precisely):
- 'pass': No material concern — the setup is sound for the strategy. Use this when you cannot identify a specific, non-generic issue a prudent trader should address before acting.
- 'caution': A real but manageable risk exists, or an important condition to verify before acting.
- 'flag': A significant risk that may invalidate the thesis or cause material loss.
Do NOT default to 'caution' — only raise an issue if it is specific and actionable. Generic market risk is not a caution.
FLAG SEVERITIES: 'warning' flags indicate material risk. 'info' flags are advisory only — a pick whose only flags are info-severity can still merit 'pass'; mention the advisory briefly but do not let it alone drive a 'caution'.

MARKET DATA: All values in \`marketData\` are live as of \`date\` from real-time feeds — treat them as ground truth. Do not use training knowledge to contradict provided prices; stocks change dramatically over years of training lag. \`price52wReturnPct\` shows the 1-year return so you can calibrate price level without recalling historical absolutes.
STRUCTURE: \`structure.legs\` is the COMPLETE trade — judge the whole structure from it, not from any single leg. Multi-leg structures (zebra = 2:1 long/short same side, butterfly = 1-2-1, condor) are defined by all their legs; do not treat one leg in isolation (e.g. a put zebra's short leg sitting at/above spot is normal financing, not a broken ITM strike). \`dte\` is pre-computed calendar days to expiry. \`shortStrike\` / \`strikeOtmPct\` refer to the primary SHORT leg: \`strikeOtmPct\` = (shortStrike − current price) / price × 100: positive means ABOVE spot (OTM for short calls, ITM for short puts); negative means BELOW spot (OTM for short puts, ITM for short calls). Judge moneyness by the leg's side. \`breakevenDistancePct\` (income only) is the distance to the structure's nearest breakeven — compare it to the expected 1-sigma move. If \`structure.presentation\` says stock purchase, evaluate the pick as a plain stock buy — the option structure shown is optional; do not penalize the stock thesis for the structure's grade. \`structure.maxProfit\` / \`structure.maxLoss\` are the PRECOMPUTED dollar payoff bounds (per contract, already ×100) and \`structure.breakevens\` the expiry breakeven prices — cite these provided numbers for any reward/risk or max-loss statement; do NOT compute or estimate them. A **null** \`maxLoss\` means TRULY UNBOUNDED loss — this only happens with a naked short CALL (e.g. short strangle/straddle, reverse lizard) and is a material risk worth flagging. A **finite** \`maxLoss\` means the loss is DEFINED/BOUNDED: never call it "unlimited", "uncapped", or "nearly unlimited" — a short PUT's worst case is bounded (underlying → 0) and is given in \`maxLoss\`; state that figure instead. Likewise a null \`maxProfit\` means unbounded profit (net-long calls).
VOLATILITY: \`volatility.impliedVolPct\` is the underlying's current annualized at-the-money implied volatility as a percentage (e.g. 104.7 = 104.7%). \`volatility.expectedMove1SigmaPct\` and \`volatility.expectedMove1SigmaUsd\` are the PRECOMPUTED expected 1-sigma move of the underlying over the hold (= impliedVolPct × sqrt(dte/365)), in percent and in dollars. When you discuss the expected or 1-sigma move, cite THESE provided numbers verbatim — do NOT compute, derive, or estimate the move yourself (your manual arithmetic has been unreliable and overstated it). If they are absent (e.g. impliedVolPct is null), do not attempt any expected-move reasoning. \`volatility.ivRank\` (0–100) is where IV sits in its 1-year range. \`volatility.realizedVolPct\`, when present, is the stock's RECENT REALIZED volatility — a momentum signal, NOT implied vol; the advocate may cite it as "recent volatility". It is normal and expected for realized vol to differ from impliedVolPct — do NOT treat that gap as a discrepancy, error, or red flag. CRITICAL: do NOT state any implied- or realized-volatility number that is not in \`volatility\`; never recall or estimate one from training knowledge. If \`volatility\` is null, do not cite any volatility number; say it could not be measured.
SIGNALS: \`topSignals\` lists the pick's biggest scoring contributors PLUS, when it is not already among them, the pick's WEAKEST reading, marked \`isWeakestReading\`. \`normalized\` is 0-100 and always oriented so HIGHER IS BETTER for this strategy, whatever the raw units. A low \`normalized\` therefore means the app's own scoring judged that dimension poorly, and the marked entry is the worst thing measured about this pick — a fact worth weighing, not automatically a reason to caution. The list is a SAMPLE of the signals, never the whole set, so the absence of a concern from it is not evidence there is none.
OWNERSHIP (wheel only, may be absent): \`ownership\` answers "is the assignment price a price worth owning?", measured against the stock's OWN history rather than any list. \`costBasisIfAssigned\` = strike minus premium, the price actually paid on assignment. \`basisVsSma200Pct\` is that basis against the ticker's 200-day average — POSITIVE means assignment happens ABOVE the long-run average, which is an extended entry rather than a discount however good the premium looks. \`basisRangePctile52w\` places it in the 52-week range (0 = the low, 100 = the high). \`strikeBelow20dLow\` says whether the STRIKE sits under the lowest low of the last 20 sessions — true means the stock has not traded at your strike in a month; false means it already has. These are the only measured price-level facts you have; cite the provided numbers and do not compute your own. When \`ownership\` is ABSENT it could not be measured — treat it as unknown, never as satisfactory.
MARKET CONTEXT: \`vixLevel\` and \`spyTrend\` describe today's macro environment.
EARNINGS: \`earningsInWindow\` is non-null if there is a known earnings event before expiry — this is the single biggest event risk for any options position. If \`earningsKnown\` is false the calendar has NO future earnings data for this ticker, so treat earnings risk as unverified rather than absent — for options positions, note that the report date must be checked manually.

Write 1–2 sentences. If no material concern exists, one sentence confirming the pick looks clean is sufficient — do not manufacture a concern to fill a second sentence. If a concern exists, describe it specifically (sentence 1), then what to verify (sentence 2).

If warning-severity flags are present, address the most severe one. Do not repeat the advocate's rationale.
Be direct. Do not hedge with "potentially" or "may" unless genuinely uncertain.
End your response with a JSON object on its own line: {"verdict":"pass","confidence":"high"}
Use verdict: pass, caution, or flag. Use confidence: high, medium, or low.`;

      const response = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 256,
        system: systemPrompt,
        messages: [{ role: 'user', content: JSON.stringify(context) }],
      });

      const text = response.content.find(b => b.type === 'text')?.text ?? '';

      // Extract JSON verdict from last line
      const jsonMatch = text.match(/\{"verdict":\s*"(pass|caution|flag)",\s*"confidence":\s*"(high|medium|low)"\}/);
      const verdict = (jsonMatch?.[1] as CriticVerdict['verdict']) ?? baseVerdict;
      const confidence = (jsonMatch?.[2] as CriticVerdict['confidence']) ?? baseConfidence;
      const rationale = text.replace(/\s*\{[^}]*"verdict"[^}]*\}\s*$/, '').trim() || null;

      return { verdict, confidence, flags, rationale, generatedAt };
    } catch {
      // LLM unavailable (e.g. Anthropic 529/overload) — fall back to the rule-based verdict only.
      // `degraded: true` marks it as un-vetted so consumers DON'T treat this as an adversarial
      // all-clear: the v2 entry gate rejects it (fail-closed) and the UI flags it.
      return { verdict: baseVerdict, confidence: 'low', flags, rationale: null, generatedAt, degraded: true };
    }
  }

  /**
   * The own-at-strike read for a wheel pick, computed here so the reviewer can see it.
   *
   * Duplicates nothing: it calls the same `readOwnAtStrike` the dice uses, on the same anchors,
   * from the same table. What differs is only WHEN — the dice computes it after the verdict, this
   * computes it before, so the two can never disagree about a pick.
   *
   * Returns null on any shortfall (no CSP structure, a short leg without a usable mid, fewer than
   * 200 sessions of history) and NEVER throws — this is context for a reviewer, and a failure to
   * assemble it must not take the whole verdict down with it. Null reads as unknown in the prompt.
   */
  readOwnership(pick: BriefPick, strategy: string): object | null {
    try {
      const best = this.selectRelevantStructure(pick, strategy);
      const setup = best?.setup as { legs?: Array<Record<string, unknown>> } | undefined;
      const leg = setup?.legs?.find(l =>
        String(l['side']).toLowerCase() === 'put' &&
        String(l['action']).toLowerCase().startsWith('sell'));
      const strike = typeof leg?.['strike'] === 'number' ? leg['strike'] : null;
      const mid = typeof leg?.['mid'] === 'number' ? leg['mid'] : null;
      if (strike === null || mid === null) return null;

      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      const bars = this.db.prepare(
        `SELECT close, high, low FROM historical_prices WHERE ticker = ? AND date <= ?
          ORDER BY date DESC LIMIT 260`,
      ).all(pick.ticker, today) as Array<{ close: number; high: number; low: number }>;
      if (bars.length < 200) return null;

      const w: PriceWindow = {
        sma200: bars.slice(0, 200).reduce((a, b) => a + b.close, 0) / 200,
        hi52: Math.max(...bars.map(b => b.high)),
        lo52: Math.min(...bars.map(b => b.low)),
        swingLow20: bars.length >= 20 ? Math.min(...bars.slice(0, 20).map(b => b.low)) : null,
      };
      const r = readOwnAtStrike(strike, strike - mid, w);
      if (!r) return null;
      // Rounded, and named for what they MEAN rather than for the fields they came from — the
      // model reasons about the labels, not about the storage.
      return {
        costBasisIfAssigned: +r.costBasis.toFixed(2),
        sma200: +r.sma200.toFixed(2),
        basisVsSma200Pct: +r.basisVsSma200Pct.toFixed(1),
        basisAtOrBelowSma200: r.atOrBelowSma200,
        basisRangePctile52w: +r.rangePctile.toFixed(0),
        strike: r.strike,
        low20d: r.swingLow20 === null ? null : +r.swingLow20.toFixed(2),
        strikeBelow20dLow: r.strikeBelowSwing,
      };
    } catch {
      return null;   // context, not a gate — never take the verdict down over it
    }
  }

  // ─── Rule checks ──────────────────────────────────────────────────────────────

  private checkTrendAlignment(pick: BriefPick, strategy: string): CriticFlag | null {
    const s = pick.signals;

    if (strategy === 'wheel') {
      // Wheel's config has no 'trendStrength' key (that belongs to bullish) — this read
      // was always missing and could never fire. Wheel's live trend signal is
      // 'notDowntrend' (scoring-service computeTrendDirectionScore 'wheel' mode:
      // bullish=100, sideways=75, confirmed-downtrend=10), so <35 isolates the real
      // falling-knife case. Fixed v1.1.116.
      const trend = s['notDowntrend'];
      if (trend && !trend.missing && trend.normalized < 35) {
        return {
          key: 'trend_strategy_conflict', severity: 'warning',
          description: `Wheel on a stock in a confirmed downtrend (trend score ${trend.normalized.toFixed(0)}/100). ` +
            `Assignment risk is elevated — wheel works best on stocks trending sideways to up.`,
        };
      }
    }

    if (strategy === 'bullish') {
      const trend = s['trendStrength'];
      if (trend && !trend.missing && trend.normalized < 35) {
        return {
          key: 'trend_strategy_conflict', severity: 'warning',
          description: `Bullish pick with weak trend confirmation (score ${trend.normalized.toFixed(0)}/100). ` +
            `Stock may lack the institutional buying support needed for sustained upside.`,
        };
      }
    }

    if (strategy === 'bearish') {
      const down = s['downtrendScore'];
      if (down && !down.missing && down.normalized < 35) {
        return {
          key: 'trend_strategy_conflict', severity: 'warning',
          description: `Bearish pick with weak downtrend confirmation (score ${down.normalized.toFixed(0)}/100). ` +
            `Short-side entries work best after confirmed MA breakdown.`,
        };
      }
    }

    if (strategy === 'income') {
      // 'trendNeutral' reads trendStrengthAdx, which is permanently null while ADX is
      // excluded from scoring (USE_ADX_IN_SCORING=false in scoring-service.ts — validated
      // on full-year Brief Replay, not a bug to reverse here). No live substitute signal
      // exists for "trending too hard for range-bound income" without reintroducing ADX
      // (which would need its own replay validation per FR-SEY-5), so this check is
      // currently a structural no-op — left in place, documented, rather than silently
      // pretending it's live.
      const neutral = s['trendNeutral'];
      if (neutral && !neutral.missing && neutral.normalized < 30) {
        return {
          key: 'trend_strategy_conflict', severity: 'warning',
          description: `Income structure on a stock with strong directional trend ` +
            `(neutral score ${neutral.normalized.toFixed(0)}/100). Strangles and condors require range-bound action.`,
        };
      }
    }

    if (strategy === 'buy') {
      // Buy's config has no 'trendStrength' key (that belongs to bullish) — this read was
      // always missing and could never fire. Buy's live trend signal is 'trendAlignment'
      // (scoring-service computeTrendDirectionScore 'directional' mode: bullish=100,
      // sideways=25, bearish=0). Fixed v1.1.116.
      const trend = s['trendAlignment'];
      const rs    = s['relativeStrength'];
      if (trend && rs && !trend.missing && !rs.missing &&
          trend.normalized < 40 && rs.normalized < 40) {
        return {
          key: 'trend_strategy_conflict', severity: 'warning',
          description: `Buy/swing pick lagging on both trend (${trend.normalized.toFixed(0)}/100) and ` +
            `relative strength (${rs.normalized.toFixed(0)}/100). Momentum stocks should lead, not lag.`,
        };
      }
    }

    return null;
  }

  /**
   * The single structure every critic consumer (rules + LLM context) refers to:
   * the first strategy-relevant score with a valid (non-unavailable) setup.
   * Lab scores are ordered best-first, so first match = the chosen structure.
   */
  private selectRelevantStructure(pick: BriefPick, strategy: string): LabStructureScore | null {
    const labResult = pick.strategyLabResult as LabResultShape | null;
    // breakoutDirection locks inflection to the breakout-side vertical (up → bull-put,
    // down → bear-call) so the critic evaluates the same structure the advocate proposed.
    return pickRelevantStructure<LabStructureScore>(labResult?.scores, strategy, pick.breakoutDirection);
  }

  /**
   * Buy strategy is stock-first: its relevant option structures are all debit
   * (zebra/vertical/calendar), which systematically grade C/F in high-IV regimes.
   * When no relevant structure grades B or better, the pick is presented as a
   * plain stock purchase and the structure grade must not drag the verdict.
   */
  shouldPresentAsStock(pick: BriefPick, strategy: string): boolean {
    if (strategy !== 'buy') return false;
    const labResult = pick.strategyLabResult as LabResultShape | null;
    if (!labResult?.scores) return false;
    const slugs = STRATEGY_RELEVANT_SLUGS[strategy] ?? [];
    for (const s of labResult.scores) {
      if (slugs.includes(s.slug) && s.setup && !s.setup.unavailableReason &&
          (GRADE_RANK[s.grade] ?? 0) >= GRADE_RANK['B']!) {
        return false; // a B-or-better structure exists — present it
      }
    }
    return true;
  }

  private checkLiquidity(pick: BriefPick, strategy: string): CriticFlag | null {
    if (!pick.strategyLabResult) {
      return {
        key: 'low_liquidity', severity: 'info',
        description: 'Pick was not validated against a live options chain — liquidity and spread quality are unconfirmed.',
      };
    }

    // Use the SAME structure the LLM context shows — flagging a different
    // structure's liquidity produces contradictory numbers in the prompt.
    const chosen = this.selectRelevantStructure(pick, strategy);
    if (chosen === null) return null; // no relevant structure graded — can't assess

    const legs = chosen.setup?.legs ?? [];
    // A defined-risk multi-leg spread (the kind the v2 engine trades): you cross two+ spreads to
    // open AND to exit, so liquidity matters far more than for a single-name short option.
    const isDefinedRiskSpread = legs.length > 1 && chosen.setup?.maxLoss != null;
    const hasNoBidLeg = legs.some((l) => (l.bid ?? 0) <= 0); // a $0-bid leg can't be reliably exited

    // For tradable defined-risk spreads, align the critic with the engine's tradability bar
    // (MIN_TRADABLE_LIQUIDITY_SCORE): a structure below it — or with a no-bid leg — would be
    // REJECTED by the entry gate, so it must not read as a clean pass. warning severity so the
    // verdict reflects it (a human trading the brief sees the same liquidity wall the engine enforces).
    if (isDefinedRiskSpread && (chosen.liquidityScore < MIN_TRADABLE_LIQUIDITY_SCORE || hasNoBidLeg)) {
      return {
        key: 'low_liquidity', severity: 'warning',
        description: hasNoBidLeg
          ? `A leg of the ${chosen.slug} has no bid — you may be unable to exit it. Liquidity ${chosen.liquidityScore.toFixed(0)}/15; below the tradability bar (${MIN_TRADABLE_LIQUIDITY_SCORE}), so the engine would reject this entry. Confirm bid-ask before trading.`
          : `Liquidity ${chosen.liquidityScore.toFixed(0)}/15 on the ${chosen.slug} — below the tradability bar (${MIN_TRADABLE_LIQUIDITY_SCORE}). Crossing the spread will bleed a meaningful share of the credit, and the engine would reject this entry. Confirm bid-ask before trading.`,
      };
    }

    // < 4 is genuinely thin (OI ≈ single digits / very wide spreads); for a single-name short
    // option, 4–7 is normal and should not preclude a pass.
    if (chosen.liquidityScore < 4) {
      return {
        key: 'low_liquidity', severity: 'info',
        description: `Liquidity score ${chosen.liquidityScore.toFixed(0)}/15 on the ${chosen.slug} structure — thin. ` +
          `Expect wider spreads; check bid-ask before entering.`,
      };
    }
    return null;
  }

  private checkCriticalSignalMissing(pick: BriefPick, config: ScoringConfig): CriticFlag | null {
    const top2 = [...config.signals]
      .filter(s => s.enabled)
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 2);

    const missing = top2.filter(s => pick.signals[s.key]?.missing);
    if (missing.length === 0) return null;

    const combinedWeight = missing.reduce((n, s) => n + s.weight, 0);
    return {
      key: 'critical_signal_missing', severity: 'warning',
      description: `High-weight signal${missing.length > 1 ? 's' : ''} missing data: ` +
        `${missing.map(s => s.label).join(', ')} (combined weight ${combinedWeight}%). ` +
        `Score was computed without these — actual rank may be lower.`,
    };
  }

  private checkScoreConcentration(pick: BriefPick): CriticFlag | null {
    let topKey = '';
    let topContrib = 0;

    for (const [key, v] of Object.entries(pick.signals)) {
      if (v.missing) continue;
      const contrib = (v.normalized * v.weight) / 100;
      if (contrib > topContrib) { topContrib = contrib; topKey = key; }
    }

    // Share of the total composite this one signal accounts for. The original comparison
    // (`topContrib > 50`) treated an absolute points value as if it were a percentage — but
    // topContrib is bounded by that signal's own weight (max ~30 across every baseline
    // config), so it could never exceed 50 and this check has never fired since it was
    // written. The description already describes a share ("X of Y composite points"); the
    // fix compares the actual share against the 50% threshold it was meant to enforce.
    // Fixed v1.1.117.
    if (pick.compositeScore <= 0) return null;
    const sharePct = (topContrib / pick.compositeScore) * 100;

    if (sharePct > 50) {
      return {
        key: 'score_concentrated', severity: 'info',
        description: `Score driven primarily by one signal: ${topKey} contributes ${topContrib.toFixed(0)} of ` +
          `${pick.compositeScore.toFixed(0)} composite points (${sharePct.toFixed(0)}%). Single-factor thesis — verify this signal before acting.`,
      };
    }
    return null;
  }

  private checkCrossStrategyConflict(
    pick: BriefPick,
    strategy: string,
    allPicksByStrategy: Map<string, BriefPick[]>,
  ): CriticFlag | null {
    const opponent = strategy === 'bullish' ? 'bearish' : strategy === 'bearish' ? 'bullish' : null;
    if (!opponent) return null;

    const opposingPicks = allPicksByStrategy.get(opponent) ?? [];
    if (opposingPicks.some(p => p.ticker === pick.ticker)) {
      return {
        key: 'cross_strategy_conflict', severity: 'info',
        description: `${pick.ticker} appears in both ${strategy} and ${opponent} picks — ` +
          `scoring noise may be producing a conflicting signal. Verify the current trend direction before acting.`,
      };
    }
    return null;
  }

  private getStructureExpiry(pick: BriefPick, strategy: string): string | null {
    return this.selectRelevantStructure(pick, strategy)?.setup?.expiration ?? null;
  }

  private checkAnomalousMomentum(pick: BriefPick): CriticFlag | null {
    const sig = pick.signals['priceMomentumPct'];
    if (!sig || sig.missing || sig.raw === null) return null;
    if (sig.raw <= 500) return null;
    return {
      key: 'data_anomaly_suspected', severity: 'info',
      description: `1Y price return of ${sig.raw.toFixed(0)}% is extreme — likely reflects a corporate event ` +
        `(spinoff, reverse merger, relisting). Verify price history is accurate before acting on this pick.`,
    };
  }

  private checkEarningsInWindow(pick: BriefPick, strategy: string): CriticFlag | null {
    const today = new Date().toISOString().slice(0, 10);
    const expiry = this.getStructureExpiry(pick, strategy);
    if (!expiry) return null;
    const earnings = this.getEarningsBeforeExpiry(pick.ticker, expiry, today);
    if (!earnings) {
      // "No earnings in window" is only meaningful if the calendar actually has
      // data for this ticker. With no future-dated row at all, an earnings event
      // inside the hold window is unverified — not absent.
      if (!this.hasFutureEarningsRow(pick.ticker, today)) {
        return {
          key: 'earnings_unknown', severity: 'info',
          description: `No earnings date on file for ${pick.ticker} — the position spans ${expiry} ` +
            `but earnings risk inside that window is unverified. Check the report date before entering.`,
        };
      }
      return null;
    }
    const status = earnings.confirmed ? 'confirmed' : 'unconfirmed';
    return {
      key: 'earnings_in_window', severity: 'warning',
      description: `Earnings on ${earnings.date} (${earnings.daysFromNow}d away, ${status}) fall before expiry ${expiry}. ` +
        `Earnings events cause outsized moves — consider avoiding or sizing down.`,
    };
  }

  // "Do we have any still-pending earnings data at all for this ticker" — including a
  // same-day amc/unknown-time report that hasn't happened yet (see isEarningsPending).
  private hasFutureEarningsRow(ticker: string, today: string): boolean {
    try {
      type ERow = { report_date: string; report_time: 'bmo' | 'amc' | null };
      const row = this.db.prepare(
        `SELECT report_date, report_time FROM earnings_calendar WHERE ticker = ? AND report_date >= ? LIMIT 1`
      ).get(ticker, today) as ERow | undefined;
      return row !== undefined && isEarningsPending(row.report_date, row.report_time, today);
    } catch {
      return false;
    }
  }

  private getEarningsBeforeExpiry(
    ticker: string,
    expiryDate: string,
    today: string,
  ): { date: string; daysFromNow: number; confirmed: boolean } | null {
    try {
      type ERow = { report_date: string; report_time: 'bmo' | 'amc' | null; confirmed: number };
      const row = this.db.prepare(`
        SELECT report_date, report_time, confirmed FROM earnings_calendar
        WHERE ticker = ? AND report_date >= ? AND report_date <= ?
        ORDER BY report_date ASC LIMIT 1
      `).get(ticker, today, expiryDate) as ERow | undefined;
      if (!row || !isEarningsPending(row.report_date, row.report_time, today)) return null;
      const daysFromNow = Math.round(
        (new Date(row.report_date).getTime() - new Date(today).getTime()) / 86400000
      );
      return { date: row.report_date, daysFromNow, confirmed: row.confirmed === 1 };
    } catch {
      return null;
    }
  }

  private checkStructureGrade(pick: BriefPick, strategy: string): CriticFlag | null {
    if (!pick.strategyLabResult) return null;

    // Stock-first buy picks: the thesis is the shares, not the options structure —
    // a poorly graded debit structure (normal in high-IV regimes) is not a warning.
    if (this.shouldPresentAsStock(pick, strategy)) return null;

    const result = pick.strategyLabResult as LabResultShape;
    const slugs = STRATEGY_RELEVANT_SLUGS[strategy] ?? [];

    let bestGrade: string | null = null;
    for (const s of result.scores ?? []) {
      if (slugs.includes(s.slug) && s.setup && !s.setup.unavailableReason) {
        const rank = GRADE_RANK[s.grade] ?? 0;
        if (bestGrade === null || rank > (GRADE_RANK[bestGrade] ?? 0)) bestGrade = s.grade;
      }
    }

    if (bestGrade === 'F') {
      return {
        key: 'poor_structure_grade', severity: 'warning',
        description: `Best available structure for ${strategy} strategy is grade F — risk/reward is unfavorable at current price and IV levels. Consider waiting for better conditions or choosing a different ticker.`,
      };
    }
    return null;
  }

  private checkMarketRisk(strategy: string, market: MarketContext): CriticFlag | null {
    if (market.vix !== null) {
      if ((strategy === 'wheel' || strategy === 'income') && market.vix > 30) {
        return {
          key: 'elevated_market_risk', severity: 'info',
          description: `VIX at ${market.vix.toFixed(1)} — elevated market fear. Premium is rich but ` +
            `volatility expansion risk is high. Consider narrower strikes or smaller size.`,
        };
      }
      if (strategy === 'bearish' && market.vix < 14) {
        return {
          key: 'elevated_market_risk', severity: 'info',
          description: `VIX at ${market.vix.toFixed(1)} — complacency environment. Short-side setups ` +
            `often fail or reverse quickly in low-volatility regimes.`,
        };
      }
    }

    if (market.spyAbove200ma !== null) {
      if ((strategy === 'bullish' || strategy === 'buy') && !market.spyAbove200ma) {
        return {
          key: 'elevated_market_risk', severity: 'info',
          description: `SPY is below its 200-day MA — broad market in a downtrend. ` +
            `Bullish single-stock setups face macro headwinds; extra confirmation recommended.`,
        };
      }
      // Mirror of the above: bearish picks fighting a confirmed market uptrend.
      if (strategy === 'bearish' && market.spyAbove200ma) {
        return {
          key: 'elevated_market_risk', severity: 'info',
          description: `SPY is above its 200-day MA — broad market in an uptrend. ` +
            `Bearish single-stock setups are counter-trend; require independent weakness catalysts.`,
        };
      }
    }

    return null;
  }

  /**
   * Bearish structure entering with the short strike at or below the current
   * price (zero upside cushion) while the broad market trends up — the position
   * starts under directional pressure with no buffer. Observed pattern: 3 of 5
   * bearish picks on 2026-06-10 had ATM/ITM short strikes on a bullish SPY tape.
   */
  /**
   * Data-integrity guard: the lab's underlying price must agree with the live
   * pick price. E*Trade serves stale Greeks on thin chains, which (pre-fix)
   * anchored structures to a months-old spot — WSO built a wheel put 11.8% ITM,
   * AWI an income straddle struck 31% above spot that the LLM passed. A >5%
   * deviation means every strike, credit, and grade in the lab result is suspect.
   */
  private checkLabPriceConsistency(pick: BriefPick): CriticFlag | null {
    const labPx = (pick.strategyLabResult as LabResultShape | null)?.context?.underlyingPx ?? null;
    const price = pick.price;
    if (labPx === null || price === null || price <= 0 || labPx <= 0) return null;

    const devPct = Math.abs(labPx - price) / price * 100;
    if (devPct > 5) {
      return {
        key: 'stale_lab_price', severity: 'warning',
        description: `Strategy Lab built structures at $${labPx} but the live price is $${price} ` +
          `(${devPct.toFixed(1)}% apart) — strikes, credits, and grades are unreliable. ` +
          `Data integrity issue (stale chain Greeks); do not trade this structure as shown.`,
      };
    }
    return null;
  }

  /**
   * Income straddles/strangles are unlimited-risk and require range-bound action.
   * Selecting one for a stock with strong directional momentum contradicts the thesis.
   * Threshold: 1Y return > 100% — clearly directional; defined-risk alternatives exist.
   */
  private checkHighVolNakedStructure(pick: BriefPick, strategy: string): CriticFlag | null {
    if (strategy !== 'income') return null;
    const chosen = this.selectRelevantStructure(pick, strategy);
    if (!chosen || !['short-straddle', 'short-strangle'].includes(chosen.slug)) return null;
    const sig = pick.signals['priceMomentumPct'];
    if (!sig || sig.missing || sig.raw === null || sig.raw <= 100) return null;
    return {
      key: 'high_vol_naked_structure',
      severity: 'warning',
      description: `Income strategy selected a ${chosen.slug} (unlimited-risk) for a stock with ` +
        `${sig.raw.toFixed(0)}% 1Y return — strong directional momentum contradicts the range-bound ` +
        `thesis. Prefer a defined-risk structure (iron condor or iron fly) instead.`,
    };
  }

  /**
   * Short-premium structures with very thin breakeven offer minimal cushion against
   * adverse moves. < 2% means a 2% move wipes the entire premium collected.
   * see docs/formulas.md#breakeven-distance
   */
  private checkThinBreakeven(pick: BriefPick, strategy: string): CriticFlag | null {
    if (strategy !== 'income' && strategy !== 'wheel') return null;
    const chosen = this.selectRelevantStructure(pick, strategy);
    if (!chosen?.setup || chosen.setup.netCredit === null || !pick.price || pick.price <= 0) return null;
    // Strike-aware nearest breakeven — credit/price alone understates it for
    // strangles/condors/OTM CSPs (a wide condor is not "thin"). see docs/formulas.md#breakeven-distance
    const breakevenPct = breakevenDistancePct(chosen.setup.legs, chosen.setup.netCredit, pick.price);
    if (breakevenPct === null || breakevenPct >= 2.0) return null;
    return {
      key: 'thin_breakeven',
      severity: 'warning',
      description: `Breakeven buffer is ${breakevenPct.toFixed(1)}% on this ${chosen.slug} — thin for a ` +
        `short-premium structure. A ${breakevenPct.toFixed(1)}% adverse move erases the entire premium; ` +
        `verify realized vol and size accordingly.`,
    };
  }

  private checkCounterTrendStrike(pick: BriefPick, strategy: string, market: MarketContext): CriticFlag | null {
    if (strategy !== 'bearish' || market.spyAbove200ma !== true) return null;

    const chosen = this.selectRelevantStructure(pick, strategy);
    const price = pick.price;
    if (price === null || price <= 0) return null;

    // Only a SHORT CALL is exposed to a continuation rally with limited/no upside
    // cushion. A bearish DEBIT put vertical (long-put-vertical) has defined risk and
    // its short put correctly sits BELOW spot — that is not "zero cushion", so the
    // old "first sell leg" logic wrongly flagged it (e.g. a 7% OTM short put as
    // "at/in the money"). Pick the nearest short call (lowest strike); skip if none.
    const sells = chosen?.setup?.legs.filter(l => l.action === 'sell') ?? [];
    const sideOf = (l: { strike: number; side?: 'call' | 'put' }): 'call' | 'put' =>
      l.side ?? (l.strike <= price ? 'put' : 'call');
    const shortCallStrikes = sells.filter(l => sideOf(l) === 'call').map(l => l.strike);
    if (shortCallStrikes.length === 0) return null;
    const strike = Math.min(...shortCallStrikes);

    // (strike - price) / price ≤ 0 means the short call is at or below spot — no cushion.
    const otmPct = (strike - price) / price * 100;
    if (otmPct <= 0) {
      return {
        key: 'counter_trend_itm_strike', severity: 'warning',
        description: `Short call $${strike} is at or below spot (${otmPct.toFixed(1)}% from price) with SPY in an uptrend — ` +
          `the bearish structure starts with no upside cushion. A modest continuation rally immediately pressures the short call.`,
      };
    }
    return null;
  }
}
