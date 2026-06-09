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

export interface MarketContext {
  vix: number | null;
  spyAbove200ma: boolean | null;
}

export class CriticService {
  constructor(private readonly db: Database) {}

  // Reads VIX from quote_cache and SPY 200MA from historical_prices.
  getMarketContext(): MarketContext {
    type QuoteRow = { last: number };
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

      // Extract best relevant structure from strategy lab result for context
      type SScore = { slug: string; grade: string; liquidityScore: number; setup: { expiration: string; netCredit: number | null; legs: Array<{ strike: number; action: string }> } | null };
      type LabRes = { scores?: SScore[] };
      const labResult = pick.strategyLabResult as LabRes | null;
      const slugs = STRATEGY_RELEVANT_SLUGS[strategy] ?? [];
      let structure: Record<string, unknown> | null = null;
      let structureExpiry: string | null = null;

      if (labResult?.scores) {
        const best = labResult.scores.find(s => slugs.includes(s.slug) && s.setup != null);
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

          // Strike OTM %: how far is the short strike from current price (positive = OTM)
          const strikeOtmPct = (strike !== null && price !== null && price > 0)
            ? +((price - strike) / price * 100).toFixed(1)
            : null;

          // Breakeven distance %: for income, how far price can move before structure loses
          const breakevenDistancePct = (strategy === 'income' && credit !== null && price !== null && price > 0)
            ? +(Math.abs(credit) / price * 100).toFixed(1)
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
            ...(breakevenDistancePct !== null && { breakevenDistancePct }),
          };
        }
      }

      // Include 52-week return so the model can calibrate price level without relying
      // on training data (e.g. a stock up 300% YoY is correctly priced at 4× its old level).
      const price52wReturn = pick.signals['priceMomentumPct']?.missing === false
        ? (pick.signals['priceMomentumPct']?.raw ?? null)
        : null;

      // Earnings within the hold window — single most important event risk for options
      const earningsInWindow = structureExpiry
        ? this.getEarningsBeforeExpiry(pick.ticker, structureExpiry, today)
        : null;

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
        topSignals,
        structure,
        advocateRationale: pick.aiRationale,
        ruleFlags: flags,
      };

      const systemPrompt = `You are a risk-focused options trading analyst reviewing daily trade recommendations.
Your job is to find problems, not validate decisions. Be skeptical and specific.

MARKET DATA: All values in \`marketData\` are live as of \`date\` from real-time feeds — treat them as ground truth. Do not use training knowledge to contradict provided prices; stocks change dramatically over years of training lag. \`price52wReturnPct\` shows the 1-year return so you can calibrate price level without recalling historical absolutes.
STRUCTURE: \`dte\` is pre-computed calendar days to expiry. \`strikeOtmPct\` is how far the short strike is from current price (positive = OTM). \`breakevenDistancePct\` (income only) is how far price can move before the structure loses.
MARKET CONTEXT: \`vixLevel\` and \`spyTrend\` describe today's macro environment.
EARNINGS: \`earningsInWindow\` is non-null if there is a known earnings event before expiry — this is the single biggest event risk for any options position.

Write exactly 2 sentences:
1. Your verdict on the most significant risk or concern you see (or confirm it looks clean if genuinely clear).
2. The specific condition the user should check or monitor before acting on this pick.

If rule-based flags are present, address the most severe one. Do not repeat the advocate's rationale.
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

  private checkLiquidity(pick: BriefPick, strategy: string): CriticFlag | null {
    if (!pick.strategyLabResult) {
      return {
        key: 'low_liquidity', severity: 'info',
        description: 'Pick was not validated against a live options chain — liquidity and spread quality are unconfirmed.',
      };
    }

    type SScore = { slug: string; liquidityScore: number; setup: { unavailableReason?: string | null } | null };
    type LabRes = { scores?: SScore[] };
    const result = pick.strategyLabResult as LabRes;
    const slugs  = STRATEGY_RELEVANT_SLUGS[strategy] ?? [];
    let best: number | null = null;

    for (const sc of result.scores ?? []) {
      if (slugs.includes(sc.slug) && sc.setup && !sc.setup.unavailableReason) {
        if (best === null || sc.liquidityScore > best) best = sc.liquidityScore;
      }
    }

    if (best === null) return null; // no relevant structure graded — can't assess
    if (best < 6) {
      return {
        key: 'low_liquidity', severity: 'warning',
        description: `Liquidity score ${best.toFixed(0)}/15 — just above the minimum gate. ` +
          `Expect wider spreads and potential fill slippage. Check bid-ask before entering.`,
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
    }

    return null;
  }
}
