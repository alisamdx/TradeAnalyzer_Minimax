// AI Critic — second-opinion engine for Daily Brief picks.
// Runs rule-based pre-checks then calls Claude haiku with a skeptic prompt.
// see Requirements/ai-critic.md

import type { Database } from 'better-sqlite3';
import Anthropic from '@anthropic-ai/sdk';
import type { BriefPick, CriticFlag, CriticVerdict, ScoringConfig } from '@shared/types.js';

// Strategy Lab slugs relevant to each brief strategy (mirrors the brief job constant)
const STRATEGY_RELEVANT_SLUGS: Record<string, string[]> = {
  wheel:   ['short-naked-put', 'covered-call'],
  bullish: ['long-call-vertical', 'big-lizard', 'call-zebra', 'call-butterfly', 'poor-mans-covered-call'],
  bearish: ['long-put-vertical', 'reverse-big-lizard', 'put-zebra', 'put-butterfly', 'poor-mans-covered-put'],
  income:  ['short-strangle', 'iron-condor', 'short-straddle', 'dynamic-width-iron-condor', 'iron-fly'],
  buy:     ['long-call-vertical', 'call-zebra', 'poor-mans-covered-call', 'call-calendar'],
};

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
    legs: Array<{ strike: number; action: string; side?: 'call' | 'put' }>;
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
 * Pull the real volatility figures out of a pick's lab context for the critic
 * LLM, so it never has to invent an IV. Returns null (→ the prompt forbids
 * citing any vol figure) when the lab did not measure IV. impliedVolPct is the
 * underlying's annualized ATM implied vol as a percentage.
 */
export function extractVolatilityContext(
  labResult: { context?: { currentAtmIv?: number; ivRank?: number } } | null,
): { impliedVolPct: number; ivRank: number | null } | null {
  const iv = labResult?.context?.currentAtmIv;
  if (typeof iv !== 'number' || !Number.isFinite(iv)) return null;
  const rank = labResult?.context?.ivRank;
  return {
    impliedVolPct: +iv.toFixed(1),
    ivRank: typeof rank === 'number' && Number.isFinite(rank) ? +rank.toFixed(0) : null,
  };
}

export class CriticService {
  constructor(private readonly db: Database) {}

  // Reads VIX from quote_cache and SPY 200MA from historical_prices.
  getMarketContext(): MarketContext {
    type QuoteRow = { last: number };
    // KNOWN GAP: VIX is effectively always null today — nothing writes a 'VIX' row to
    // quote_cache, and the only VIX fetch (briefing-service) hits Polygon's *stocks*
    // snapshot for ticker 'VIX', which returns nothing (VIX is an index = I:VIX, an
    // Indices-plan ticker the Stocks Starter plan lacks). So the macro context is
    // SPY-trend only and the two VIX rules (wheel/income >30, bearish <14) are dormant.
    // This null path is fail-safe (vixLevel null, rules skip). A real fix needs a
    // verified index-quote source (E*Trade /market/quote, or a Polygon Indices plan).
    // see CLAUDE.md "Known quirks" / .ai/AI_CONTEXT.md §10.
    const vixRow = this.db.prepare(
      `SELECT last FROM quote_cache WHERE ticker = 'VIX' LIMIT 1`
    ).get() as QuoteRow | undefined;
    const vix = vixRow?.last ?? null;

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
      const client = new Anthropic({ apiKey });

      const topSignals = Object.entries(pick.signals)
        .filter(([, v]) => !v.missing && v.raw !== null)
        .sort((a, b) => b[1].weight * b[1].normalized - a[1].weight * a[1].normalized)
        .slice(0, 4)
        .map(([key, v]) => ({ key, raw: v.raw, normalized: v.normalized, weight: v.weight }));

      // Extract the chosen relevant structure for context via the shared selector —
      // the same structure every rule check refers to. Structures with
      // unavailableReason are excluded (non-null setup but no actionable legs).
      let structure: Record<string, unknown> | null = null;
      let structureExpiry: string | null = null;
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
            strike,
            expiry: structureExpiry,
            dte,
            credit,
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
      const volatility = extractVolatilityContext(pick.strategyLabResult as LabResultShape | null);

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
        volatility,        // { impliedVolPct, ivRank } from real data — or null when unavailable
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
STRUCTURE: \`dte\` is pre-computed calendar days to expiry. \`strikeOtmPct\` = (short strike − current price) / price × 100: positive means the strike is ABOVE spot (OTM for short calls, ITM for short puts); negative means BELOW spot (OTM for short puts, ITM for short calls). Judge moneyness by the leg's side — a short put with strikeOtmPct of +30% is deeply ITM and broken, not safe. \`breakevenDistancePct\` (income only) is the distance to the structure's nearest breakeven — how far price can move before it loses; compare this to the expected 1-sigma move to assess real risk. If \`structure.presentation\` says stock purchase, evaluate the pick as a plain stock buy — the option structure shown is an optional alternative; do not penalize the stock thesis for the structure's grade.
VOLATILITY: \`volatility.impliedVolPct\` is the underlying's current annualized at-the-money implied volatility, already expressed as a percentage (e.g. 104.7 means 104.7%). Use ONLY this value for any expected-move or 1-sigma reasoning: expected 1-sigma move over the hold ≈ impliedVolPct × sqrt(dte/365). \`volatility.ivRank\` (0–100) shows where current IV sits in its 1-year range. CRITICAL: do NOT state any implied-volatility or realized-volatility number that is not \`volatility.impliedVolPct\` — never recall or estimate a volatility figure from training knowledge. If \`volatility\` is null, do not cite any volatility number; say it could not be measured.
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
      // LLM unavailable — fall back to rule-based verdict only
      return { verdict: baseVerdict, confidence: 'low', flags, rationale: null, generatedAt };
    }
  }

  // ─── Rule checks ──────────────────────────────────────────────────────────────

  private checkTrendAlignment(pick: BriefPick, strategy: string): CriticFlag | null {
    const s = pick.signals;

    if (strategy === 'wheel') {
      const trend = s['trendStrength'];
      if (trend && !trend.missing && trend.normalized < 35) {
        return {
          key: 'trend_strategy_conflict', severity: 'warning',
          description: `Wheel on a stock with weak trend (trend score ${trend.normalized.toFixed(0)}/100). ` +
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
      const trend = s['trendStrength'];
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
    const slugs = STRATEGY_RELEVANT_SLUGS[strategy] ?? [];
    const valid = (labResult?.scores ?? []).filter(
      s => slugs.includes(s.slug) && s.setup != null && !s.setup.unavailableReason
    );
    if (valid.length === 0) return null;
    // Inflection's two relevant verticals are direction-opposite (bull put vs bear call);
    // the higher-graded one matches the breakout direction (lab direction bias). Other
    // strategies keep their preference order (first valid).
    if (strategy === 'inflection') {
      return valid.reduce((best, s) => (GRADE_RANK[s.grade] ?? 0) > (GRADE_RANK[best.grade] ?? 0) ? s : best);
    }
    return valid[0] ?? null;
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

    // < 4 is genuinely thin (OI ≈ single digits / very wide spreads).
    // 4–6 is normal for single-name large caps and should not preclude a pass.
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

    if (topContrib > 50) {
      return {
        key: 'score_concentrated', severity: 'info',
        description: `Score driven primarily by one signal: ${topKey} contributes ${topContrib.toFixed(0)} of ` +
          `${pick.compositeScore.toFixed(0)} composite points. Single-factor thesis — verify this signal before acting.`,
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

  private hasFutureEarningsRow(ticker: string, today: string): boolean {
    try {
      const row = this.db.prepare(
        `SELECT 1 FROM earnings_calendar WHERE ticker = ? AND report_date > ? LIMIT 1`
      ).get(ticker, today);
      return row !== undefined;
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
      type ERow = { report_date: string; confirmed: number };
      const row = this.db.prepare(`
        SELECT report_date, confirmed FROM earnings_calendar
        WHERE ticker = ? AND report_date > ? AND report_date <= ?
        ORDER BY report_date ASC LIMIT 1
      `).get(ticker, today, expiryDate) as ERow | undefined;
      if (!row) return null;
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
    const shortLeg = chosen?.setup?.legs.find(l => l.action === 'sell');
    const strike = shortLeg?.strike ?? null;
    const price = pick.price;
    if (strike === null || price === null || price <= 0) return null;

    // (strike - price) / price: ≤ 0 means the short strike is at or below price — no cushion.
    const otmPct = (strike - price) / price * 100;
    if (otmPct <= 0) {
      return {
        key: 'counter_trend_itm_strike', severity: 'warning',
        description: `Short strike $${strike} is ${otmPct.toFixed(1)}% OTM (at/in the money) with SPY in an uptrend — ` +
          `the bearish position starts with zero cushion against the prevailing market direction. ` +
          `A modest continuation rally immediately pressures the structure.`,
      };
    }
    return null;
  }
}
