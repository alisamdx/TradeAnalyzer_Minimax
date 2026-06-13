// Daily Intelligence Brief batch job — 6-stage pipeline.
// Stage 1: Screen universe (cached data) → Stage 2: Score → Stage 3: Filter overlay
// → Stage 4: Strategy Lab validation (live E*Trade) → Stage 5: AI synthesis
// → Stage 6: Persist brief
// see Requirements/DAILY_INTELLIGENCE_BRIEF.md §5

import type { Database } from 'better-sqlite3';
import Anthropic from '@anthropic-ai/sdk';
import type { BatchJobHandler, BatchJobResult } from '../batch-service.js';
import type { BatchProgressEvent, BriefPick, CriticFlag, ScoringStrategy } from '@shared/types.js';
import type { ScoredTicker } from '../scoring-service.js';
import { ScoringService, STRATEGIES, minCompositeForStrategy } from '../scoring-service.js';
import type { OptionsProvider } from '../options-provider.js';
import type { DataProvider } from '../data-provider.js';
import { StrategyLabService } from '../strategy-lab-service.js';
import { secureGet } from '../secure-settings.js';
import { isTradingDay } from '../iv-history-service.js';
import { SCORING_REFERENCE_TICKERS } from './price-gap-fill-job.js';
import type { EmailService } from '../email-service.js';
import { buildEmailHtml, buildPdf } from '../brief-report-builder.js';
import type { PaperTradingService } from '../paper-trading-service.js';
import { CriticService } from '../critic-service.js';
import { WatchlistService } from '../watchlist-service.js';
import { parseRationaleResponse } from '../brief-rationale-parser.js';
import type { EarningsService } from '../earnings-service.js';
import type { OAuthCredentials } from '../etrade-auth.js';

const PICKS_PER_STRATEGY = 5;   // final picks shown in brief per strategy (post-gate cap)
const STAGE4_POOL_SIZE   = 15;  // candidates sent to E*Trade validation per strategy — deepened from 10 in v0.32.70 so the liquidity gate (which now correctly rejects thin chains) still leaves 5 picks per strategy
const MAX_PICK_PRICE     = 750; // USD — stocks above this price are excluded from all brief picks

// Strategies whose structures carry naked short legs through the hold window —
// all get the -20 earnings-within-45d composite penalty in Stage 3.
export const EARNINGS_PENALTY_STRATEGIES = ['income', 'wheel', 'bearish'] as const;

function isAuthError(e: unknown): boolean {
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return msg.includes('401') || msg.includes('token') || msg.includes('auth') || msg.includes('oauth');
}
const STAGE_4_CAP = STAGE4_POOL_SIZE * STRATEGIES.length; // ≤ 75 unique tickers through E*Trade (usually far fewer — cross-strategy overlap)
const RETENTION_DAYS = 90;

// Minimum Strategy Lab liquidityScore (0–15) for a pick to survive the hard gate.
// OI=1 + wide spread → ~3; OI<100 + moderate spread → ~7.
// Gate at 5 drops OI=1 with any realistic spread while keeping OI≥100 picks.
const MIN_LIQUIDITY_SCORE = 5;

// Which Strategy Lab slugs represent each brief strategy.
// Used for the liquidity gate — we check only structures the brief strategy would trade.
const STRATEGY_RELEVANT_SLUGS: Record<string, string[]> = {
  wheel:   ['short-naked-put', 'covered-call'],
  bullish: ['long-call-vertical', 'big-lizard', 'call-zebra', 'call-butterfly', 'poor-mans-covered-call'],
  bearish: ['long-put-vertical', 'reverse-big-lizard', 'put-zebra', 'put-butterfly', 'poor-mans-covered-put'],
  income:  ['short-strangle', 'iron-condor', 'short-straddle', 'dynamic-width-iron-condor', 'iron-fly'],
  buy:     ['long-call-vertical', 'call-zebra', 'poor-mans-covered-call', 'call-calendar'],
};

// Returns the best liquidityScore (0–15) among the strategy-relevant structures,
// or null when no lab result or no relevant structure is available.
function getBestLiquidityScore(labResult: object | null, strategy: string): number | null {
  if (!labResult) return null;
  type SScore = { slug: string; liquidityScore: number; setup: { unavailableReason: string | null } | null };
  type LabRes  = { scores?: SScore[] };
  const result = labResult as LabRes;
  const slugs  = STRATEGY_RELEVANT_SLUGS[strategy] ?? [];
  let best: number | null = null;
  for (const s of result.scores ?? []) {
    if (slugs.includes(s.slug) && s.setup && !s.setup.unavailableReason) {
      if (best === null || s.liquidityScore > best) best = s.liquidityScore;
    }
  }
  return best;
}

// Returns false when the best relevant structure has liquidityScore below the threshold,
// or when the lab ran but produced no valid structure for this strategy (all unavailable).
// Returns true only when no lab result exists at all (validation failed — can't gate).
function hasAdequateLiquidity(labResult: object | null, strategy: string): boolean {
  if (!labResult) return true; // validation failed entirely — can't gate what we didn't measure
  const best = getBestLiquidityScore(labResult, strategy);
  if (best === null) return false; // lab ran but no valid structure found for this strategy
  return best >= MIN_LIQUIDITY_SCORE;
}

// Next trading day 9:30am ET — used as valid_until
function nextTradingDayOpen(fromIso: string): string {
  const d = new Date(fromIso);
  d.setUTCHours(13, 30, 0, 0); // 9:30am ET = 13:30 UTC (EST; ET = UTC-5 standard)
  do {
    d.setDate(d.getDate() + 1);
  } while (!isTradingDay(d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' })));
  return d.toISOString();
}

export class DailyIntelligenceBriefJob implements BatchJobHandler {
  readonly name = 'Daily Intelligence Brief';
  readonly description =
    'Scores the full universe across 5 strategies, validates top picks via E*Trade, ' +
    'synthesizes AI rationale, and persists a daily trade shortlist.';

  private readonly scoringService: ScoringService;
  private readonly strategyLabService: StrategyLabService;
  private readonly criticService: CriticService;

  constructor(
    private readonly db: Database,
    private readonly dataProvider: DataProvider,
    private readonly optionsProvider: OptionsProvider,
    private readonly emailService: EmailService | null = null,
    private readonly paperTradingService: PaperTradingService | null = null,
    private readonly onWatchlistUpdated: (() => void) | null = null,
    private readonly earningsService: EarningsService | null = null,
    private readonly getEtradeCreds: (() => OAuthCredentials | null) | null = null,
  ) {
    this.scoringService = new ScoringService(db);
    this.strategyLabService = new StrategyLabService(dataProvider, optionsProvider);
    this.criticService = new CriticService(db);
  }

  async run(
    onProgress: (evt: BatchProgressEvent) => void,
    signal: AbortSignal,
    force = false,
  ): Promise<BatchJobResult> {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

    if (!force && !isTradingDay(today)) {
      return { status: 'skipped', notes: 'Non-trading day', tickersAttempted: 0, tickersUpdated: 0, tickersSkipped: 0, tickersFailed: 0 };
    }

    const runMeta: Record<string, unknown> = { startedAt: new Date().toISOString(), stages: {} };
    const emit = (msg: string, attempted = 0, total = 0) =>
      onProgress({ jobId: 'daily-intelligence-brief', runId: 0, ticker: '', status: 'updated', attempted, updated: 0, skipped: 0, failed: 0, total, message: msg });

    // ── Options provider connectivity check ───────────────────────────────────
    // Stage 4 (Strategy Lab) makes live options chain calls. Probe before starting
    // the pipeline so we don't burn through stages 1–3 only to fail at stage 4.
    try {
      await this.optionsProvider.getOptionsExpirations('SPY');
    } catch (err) {
      if (isAuthError(err)) {
        return {
          status: 'skipped',
          notes: 'Options provider not connected (E*Trade token expired). Reconnect in Settings → E*Trade Connection.',
          tickersAttempted: 0, tickersUpdated: 0, tickersSkipped: 0, tickersFailed: 0,
        };
      }
      return {
        status: 'skipped',
        notes: `Options provider unavailable: ${err instanceof Error ? err.message : String(err)}`,
        tickersAttempted: 0, tickersUpdated: 0, tickersSkipped: 0, tickersFailed: 0,
      };
    }

    // ── Stage 1: Candidates from cached screen results ──────────────────────
    emit('Stage 1/6: Loading screener candidates…');
    const t1 = Date.now();

    const candidates = this.loadCandidates();
    const stage1Ms = Date.now() - t1;
    runMeta['stages'] = { ...runMeta['stages'] as object, stage1: { candidates: candidates.length, ms: stage1Ms } };
    emit(`Stage 1/6: ${candidates.length} candidates from screener cache`, candidates.length, candidates.length);

    if (candidates.length === 0) {
      return { status: 'failed', errorMessage: 'No screener results in cache — run the screener first', tickersAttempted: 0, tickersUpdated: 0, tickersSkipped: 0, tickersFailed: 0 };
    }

    if (signal.aborted) return { status: 'failed', errorMessage: 'Cancelled', tickersAttempted: 0, tickersUpdated: 0, tickersSkipped: 0, tickersFailed: 0 };

    // ── Stage 2: Score all candidates across 5 strategies ───────────────────
    emit('Stage 2/6: Scoring candidates…', 0, candidates.length);
    const t2 = Date.now();

    // Gather signal data once for all tickers (batched DB queries)
    const signalData = this.scoringService.gatherSignalData(candidates);

    // Score per strategy
    const rankedByStrategy = new Map<string, ScoredTicker[]>();
    for (const strategy of STRATEGIES) {
      const config = this.scoringService.getConfig(strategy);
      const enabledSignals = config.signals.filter(s => s.enabled);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const scored = candidates.map(ticker => (this.scoringService as any).scoreTicker(ticker, signalData.get(ticker) ?? null, enabledSignals, config.signals) as ScoredTicker);
      scored.sort((a, b) => b.compositeScore - a.compositeScore);
      rankedByStrategy.set(strategy, scored);
    }

    const stage2Ms = Date.now() - t2;
    runMeta['stages'] = { ...runMeta['stages'] as object, stage2: { ms: stage2Ms } };
    emit(`Stage 2/6: Scored ${candidates.length} tickers × 5 strategies`, candidates.length, candidates.length);

    if (signal.aborted) return { status: 'failed', errorMessage: 'Cancelled', tickersAttempted: 0, tickersUpdated: 0, tickersSkipped: 0, tickersFailed: 0 };

    // ── Stage 3: Filter overlay (+5 bonus for tickers with active filter alerts) ─
    emit('Stage 3/6: Applying filter overlay…');
    const filterBonus = this.loadFilterBonus();
    if (filterBonus.size > 0) {
      for (const [, scored] of rankedByStrategy) {
        for (const s of scored) {
          const bonus = filterBonus.get(s.ticker) ?? 0;
          if (bonus > 0) s.compositeScore = Math.min(100, s.compositeScore + bonus);
        }
        scored.sort((a, b) => b.compositeScore - a.compositeScore);
      }
    }

    // Penalise short-premium candidates with earnings in the next 45 days (-20 pts).
    // Income (strangles/condors), wheel (naked puts), and bearish (reverse lizards)
    // all carry naked short legs — an earnings event within the hold window causes
    // outsized moves that blow through the strikes. High IVR driven by a known event
    // is a trap, not an opportunity.
    const earningsPenalty = this.loadEarningsPenalty();
    if (earningsPenalty.size > 0) {
      for (const strategy of EARNINGS_PENALTY_STRATEGIES) {
        const list = rankedByStrategy.get(strategy) ?? [];
        let penalised = 0;
        for (const s of list) {
          if (earningsPenalty.has(s.ticker)) {
            s.compositeScore = Math.max(0, s.compositeScore - 20);
            penalised++;
          }
        }
        if (penalised > 0) {
          list.sort((a, b) => b.compositeScore - a.compositeScore);
          console.log(`[brief stage3] ${strategy}: penalised ${penalised} tickers for earnings within 45d`);
        }
      }
    }

    emit('Stage 3/6: Filter overlay applied');

    // ── Stage 4: Strategy Lab deep validation (live E*Trade) ───────────────
    emit('Stage 4/6: Validating top picks via E*Trade…');
    const t4 = Date.now();

    // Collect top N per strategy (deduplicated by ticker)
    const topPerStrategy = new Map<string, ScoredTicker[]>();
    const stage4Queue: Array<{ ticker: string; strategies: string[] }> = [];
    const seenTickers = new Map<string, string[]>(); // ticker → strategies

    for (const strategy of STRATEGIES) {
      // Per-strategy quality gate (bearish ≥70; others ungated). Applied before
      // validation so weak bearish picks never consume an E*Trade call, and weak
      // days surface zero bearish picks. see minCompositeForStrategy().
      const minComposite = minCompositeForStrategy(strategy);
      const top = (rankedByStrategy.get(strategy) ?? [])
        .filter(s => s.compositeScore > 0 && s.compositeScore >= minComposite)
        .filter(s => {
          const price = signalData.get(s.ticker)?.lastPrice;
          return price === null || price === undefined || price <= MAX_PICK_PRICE;
        })
        .slice(0, STAGE4_POOL_SIZE);
      topPerStrategy.set(strategy, top);
      for (const s of top) {
        if (!seenTickers.has(s.ticker)) seenTickers.set(s.ticker, []);
        seenTickers.get(s.ticker)!.push(strategy);
      }
    }

    for (const [ticker, strategies] of seenTickers) {
      stage4Queue.push({ ticker, strategies });
      if (stage4Queue.length >= STAGE_4_CAP) break;
    }

    // Validate each ticker; gracefully skip if E*Trade is unavailable
    const validationResults = new Map<string, object | null>();
    let etradeFailed = false;
    let stage4Attempted = 0, stage4Failed = 0;

    for (let i = 0; i < stage4Queue.length; i++) {
      if (signal.aborted) break;
      const { ticker } = stage4Queue[i]!;
      stage4Attempted++;

      onProgress({
        jobId: 'daily-intelligence-brief', runId: 0,
        ticker, status: 'updated',
        attempted: i + 1, updated: 0, skipped: 0, failed: stage4Failed,
        total: stage4Queue.length,
        message: `Stage 4: Validating ${ticker}…`,
      });

      try {
        const result = await this.strategyLabService.validate(this.db, ticker);
        validationResults.set(ticker, result as unknown as object);
      } catch (err) {
        stage4Failed++;
        validationResults.set(ticker, null);
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('401') || msg.includes('auth') || msg.includes('token') || msg.includes('expired')) {
          etradeFailed = true;
          // Don't abort — continue with unvalidated picks
        }
      }

      // Rate-limit: ~1.1s between E*Trade calls
      if (i < stage4Queue.length - 1 && !signal.aborted) {
        await new Promise(r => setTimeout(r, 1100));
      }
    }

    const stage4Ms = Date.now() - t4;
    runMeta['stages'] = { ...runMeta['stages'] as object, stage4: { attempted: stage4Attempted, failed: stage4Failed, etradeFailed, ms: stage4Ms } };
    emit(`Stage 4/6: Validated ${stage4Attempted - stage4Failed}/${stage4Attempted} picks`);

    // ── Stage 5: AI synthesis ────────────────────────────────────────────────
    emit('Stage 5/6: Running AI synthesis…');
    const t5 = Date.now();

    // Retrieve API key once — reused by Stage 5 (advocate) and Stage 5b (critic)
    const anthropicApiKey = secureGet(this.db, 'anthropicApiKey');

    const aiRationales = new Map<string, string | null>();
    let aiCostEstimate = 0;

    try {
      if (!anthropicApiKey) throw new Error('no_key');

      const client = new Anthropic({ apiKey: anthropicApiKey });

      // Build structured summary for all top picks
      const picksForAI: Array<{ ticker: string; strategy: string; score: number; signals: Record<string, unknown> }> = [];
      for (const strategy of STRATEGIES) {
        const top = topPerStrategy.get(strategy) ?? [];
        for (const pick of top) {
          picksForAI.push({
            ticker: pick.ticker,
            strategy,
            score: pick.compositeScore,
            signals: Object.fromEntries(
              Object.entries(pick.signals)
                .filter(([, v]) => !v.missing)
                .map(([k, v]) => [k, v.raw])
            ),
          });
        }
      }

      const systemPrompt = `You are an experienced retail options trader reviewing today's top trade candidates.
Write a concise 2–3 sentence rationale for each pick explaining WHY it is a top candidate for that specific strategy today, citing the 2–3 key signals that drove its score.
Be specific: mention actual values (e.g. "IVR 72", "RSI 58", "EPS growth 42%"). Keep each rationale under 60 words.`;

      const userPrompt = `Review these top trade candidates and provide rationale for each:\n\n${JSON.stringify(picksForAI, null, 2)}\n\nRespond with a JSON array: [{"ticker":"X","strategy":"wheel","rationale":"..."}]`;

      const response = await client.messages.create({
        model: 'claude-sonnet-4-6',
        // Rationales are requested for ALL stage-4 candidates (up to 15 per
        // strategy = 75 picks, not just the final 25) since the liquidity gate
        // runs at assembly, after this stage. 75 × ~90 tokens ≈ 7K output —
        // the previous 4096 cap still truncated (38/75 salvaged on 2026-06-11).
        max_tokens: 16384,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      });

      const text = response.content.find(b => b.type === 'text')?.text ?? '';
      for (const item of parseRationaleResponse(text)) {
        aiRationales.set(`${item.ticker}:${item.strategy}`, item.rationale);
      }
      if (response.stop_reason === 'max_tokens') {
        runMeta['aiError'] =
          `rationale response hit max_tokens — salvaged ${aiRationales.size}/${picksForAI.length}`;
      } else if (aiRationales.size === 0 && picksForAI.length > 0) {
        runMeta['aiError'] = 'rationale response could not be parsed (0 rationales extracted)';
      }

      // Rough cost estimate: sonnet-4-6 input ~$3/M + output ~$15/M tokens
      const inputTokens = response.usage?.input_tokens ?? 0;
      const outputTokens = response.usage?.output_tokens ?? 0;
      aiCostEstimate = (inputTokens / 1_000_000) * 3.00 + (outputTokens / 1_000_000) * 15.00;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      runMeta['aiError'] = msg === 'no_key' ? 'Anthropic API key not configured' : msg;
    }

    const stage5Ms = Date.now() - t5;
    runMeta['stages'] = { ...runMeta['stages'] as object, stage5: { rationales: aiRationales.size, costUsd: aiCostEstimate, ms: stage5Ms } };
    emit('Stage 5/6: AI synthesis complete');

    // ── Stage 5b: Refresh live prices for final picks ───────────────────────
    // signalData.lastPrice comes from analysis_snapshots or historical_prices,
    // which only update overnight. For intraday runs the displayed price in the
    // brief would be yesterday's EOD close. Fetch live Polygon quotes for the
    // ~25 final pick tickers so the brief always shows the current market price.
    const finalPickTickers = [...new Set(
      STRATEGIES.flatMap(s => (topPerStrategy.get(s) ?? []).map(p => p.ticker))
    )];
    if (finalPickTickers.length > 0) {
      try {
        await Promise.allSettled(
          finalPickTickers.map(async (ticker) => {
            try {
              const quote = await this.dataProvider.getQuote(ticker);
              if (quote?.last && quote.last > 0) {
                const d = signalData.get(ticker);
                if (d) d.lastPrice = quote.last;
                // Also write back to quote_cache so other views benefit immediately
                this.db.prepare(
                  `UPDATE quote_cache SET last = ?, fetched_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE ticker = ?`
                ).run(quote.last, ticker);
              }
            } catch {
              // Non-fatal — stale price is better than no brief
            }
          })
        );
      } catch {
        // Ignore bulk errors — proceed with whatever prices we have
      }
    }

    // ── Earnings fallback for final picks ────────────────────────────────────
    // ~11% of the universe has no future earnings row (Finnhub bulk-fill gaps),
    // and the critic treats a ticker with no calendar data as unverified event
    // risk. Fetch the missing dates from E*Trade for just the ~25 final pick
    // tickers — refreshTickers smart-skips any ticker that already has a valid
    // future date, so this is typically only a handful of calls.
    if (this.earningsService && finalPickTickers.length > 0) {
      try {
        const creds = this.getEtradeCreds?.() ?? null;
        const res = await this.earningsService.refreshTickers(finalPickTickers, creds);
        runMeta['earningsFallback'] = { updated: res.updated, skipped: res.skipped, failed: res.failed };
      } catch (err) {
        runMeta['earningsFallback'] = { error: err instanceof Error ? err.message : String(err) };
      }
    }

    // ── Assemble final picks (post-liquidity-gate, with AI rationale) ─────────
    // Must happen before Stage 5b so the critic sees the complete pick data
    // and can run cross-strategy conflict checks across all strategies at once.
    let totalGated = 0;
    const assembledPicks = new Map<ScoringStrategy, BriefPick[]>();
    const strategyConfigs = new Map(STRATEGIES.map(s => [s, this.scoringService.getConfig(s)]));

    for (const strategy of STRATEGIES) {
      const top = topPerStrategy.get(strategy) ?? [];
      const passedGate = top.filter(scored =>
        hasAdequateLiquidity(validationResults.get(scored.ticker) ?? null, strategy)
      );
      const liquidFiltered = passedGate.slice(0, PICKS_PER_STRATEGY);
      // failedGate: rejected by liquidity. cappedOut: liquid but outranked by top 5.
      const failedGate = top.filter(s => !passedGate.includes(s));
      const cappedOut  = passedGate.slice(PICKS_PER_STRATEGY);
      if (failedGate.length > 0) totalGated += failedGate.length;

      const fmt = (s: ScoredTicker) => {
        const liq = getBestLiquidityScore(validationResults.get(s.ticker) ?? null, strategy);
        return `${s.ticker}(${liq ?? '?'}/15)`;
      };
      let logLine = `[brief funnel] ${strategy}: ${top.length} → ${liquidFiltered.length} final`;
      if (failedGate.length > 0) logLine += ` | liq-failed: ${failedGate.map(fmt).join(', ')}`;
      if (cappedOut.length  > 0) logLine += ` | outranked: ${cappedOut.map(fmt).join(', ')}`;
      console.log(logLine);

      const picks: BriefPick[] = liquidFiltered.map((scored, idx) => ({
        ticker: scored.ticker,
        compositeScore: scored.compositeScore,
        signals: scored.signals,
        strategyLabResult: validationResults.get(scored.ticker) ?? null,
        aiRationale: aiRationales.get(`${scored.ticker}:${strategy}`) ?? null,
        criticVerdict: null,
        rank: idx + 1,
        validated: !!validationResults.get(scored.ticker),
        price: signalData.get(scored.ticker)?.lastPrice ?? null,
      }));
      assembledPicks.set(strategy as ScoringStrategy, picks);
    }

    // ── Stage 5b: AI Critic ──────────────────────────────────────────────────
    emit('Stage 5b/6: Running AI Critic…');
    const t5b = Date.now();
    let criticCostEstimate = 0;

    if (anthropicApiKey) {
      const marketContext = this.criticService.getMarketContext();

      // Run critic in serial batches of one strategy at a time (up to 5 picks in parallel).
      // 25 fully-concurrent calls hit Anthropic rate limits (~50% LLM failure).
      // Processing one strategy batch at a time keeps concurrent calls ≤5 and cuts failures.
      for (const [strategy, picks] of assembledPicks) {
        const config = strategyConfigs.get(strategy)!;
        await Promise.allSettled(picks.map(pick => (async () => {
          let flags: CriticFlag[] = [];
          try {
            flags = this.criticService.runRuleChecks(
              pick, strategy, config, assembledPicks as Map<string, BriefPick[]>, marketContext,
            );
          } catch (err) {
            console.warn(`[critic rule-check] ${pick.ticker}/${strategy}:`, err instanceof Error ? err.message : String(err));
            return;
          }
          try {
            pick.criticVerdict = await this.criticService.synthesizeVerdict(
              pick, strategy, flags, anthropicApiKey, marketContext,
            );
          } catch (err) {
            console.warn(`[critic llm] ${pick.ticker}/${strategy}:`, err instanceof Error ? err.message : String(err));
            // LLM failed — persist rule-check verdict so the column is never blank
            const hasWarning = flags.some(f => f.severity === 'warning');
            pick.criticVerdict = {
              verdict: hasWarning ? 'flag' : flags.length > 0 ? 'caution' : 'pass',
              confidence: 'low',
              flags,
              rationale: null,
              generatedAt: new Date().toISOString(),
            };
          }
        })()));
      }

      // Estimate: ~$0.008/pick (sonnet-4-6)
      const totalCriticPicks = [...assembledPicks.values()].reduce((n, p) => n + p.length, 0);
      criticCostEstimate = totalCriticPicks * 0.002;
    } else {
      // No API key — run rule checks only, no LLM
      const marketContext = this.criticService.getMarketContext();
      for (const [strategy, picks] of assembledPicks) {
        const config = strategyConfigs.get(strategy)!;
        for (const pick of picks) {
          try {
            const flags = this.criticService.runRuleChecks(
              pick, strategy, config, assembledPicks as Map<string, BriefPick[]>, marketContext,
            );
            const hasWarning = flags.some(f => f.severity === 'warning');
            pick.criticVerdict = {
              verdict: hasWarning ? 'flag' : flags.length > 0 ? 'caution' : 'pass',
              confidence: 'low',
              flags,
              rationale: null,
              generatedAt: new Date().toISOString(),
            };
          } catch { /* non-fatal */ }
        }
      }
    }

    const stage5bMs = Date.now() - t5b;
    runMeta['stages'] = { ...runMeta['stages'] as object, stage5b: { costUsd: criticCostEstimate, ms: stage5bMs } };
    emit('Stage 5b/6: AI Critic complete');

    // ── Stage 6: Persist brief ───────────────────────────────────────────────
    emit('Stage 6/6: Persisting brief…');
    const validUntil = nextTradingDayOpen(new Date().toISOString());

    this.scoringService.pruneStaleBriefs(RETENTION_DAYS);

    // One-time cleanup: purge open paper trades from stale earlier runs on any date.
    // autoCapture below clears today's stale picks per-strategy before inserting;
    // this handles historical multi-run pollution from past dates.
    if (this.paperTradingService) {
      try {
        const deleted = this.paperTradingService.cleanupStalePicksAllDates();
        if (deleted > 0) console.log(`[brief] pruned ${deleted} stale paper picks from multi-run days`);
      } catch (err) {
        console.warn('[brief] stale pick cleanup failed:', err instanceof Error ? err.message : String(err));
      }
    }

    let totalPicks = 0;
    const persistedPicks = new Map<ScoringStrategy, BriefPick[]>();
    for (const strategy of STRATEGIES) {
      if (signal.aborted) break;
      const picks = assembledPicks.get(strategy as ScoringStrategy) ?? [];

      runMeta['configVersions'] = {
        ...runMeta['configVersions'] as object ?? {},
        [strategy]: strategyConfigs.get(strategy)!.version,
      };

      const briefId = this.scoringService.persistBrief(strategy, picks, validUntil, runMeta);
      persistedPicks.set(strategy as ScoringStrategy, picks);
      totalPicks += picks.length;

      // Auto-capture post-gate picks as paper trades for Retrospect validation.
      if (this.paperTradingService && picks.length > 0) {
        try {
          this.paperTradingService.autoCapture(strategy, picks, today, briefId);
        } catch (err) {
          console.warn('[brief] paper-trade auto-capture failed:', err instanceof Error ? err.message : String(err));
        }
      }
    }

    const totalMs = Date.now() - new Date(runMeta['startedAt'] as string).getTime();
    runMeta['totalMs'] = totalMs;
    runMeta['etradeFailed'] = etradeFailed;
    const gatedMsg = totalGated > 0 ? ` | ${totalGated} dropped (low liquidity)` : '';
    emit(`Stage 6/6: Brief generated — ${totalPicks} picks across 5 strategies${gatedMsg}`, totalPicks, totalPicks);

    // ── Stage 6b: Update DailyBrief-MMDD watchlist ──────────────────────────
    this.upsertBriefWatchlist(persistedPicks, today);

    // ── Email delivery ────────────────────────────────────────────────────────
    if (this.emailService?.isConfigured() && totalPicks > 0) {
      try {
        emit('Sending email…');
        // Use the same persisted picks (post-liquidity-gate) — not topPerStrategy (pre-gate)
        // to ensure email and UI show identical data.
        const dateStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
        const [emailHtml, pdfBuffer] = await Promise.all([
          Promise.resolve(buildEmailHtml(dateStr, persistedPicks)),
          buildPdf(dateStr, persistedPicks),
        ]);

        const subject = `Daily Intelligence Brief — ${new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} — ${totalPicks} picks`;
        await this.emailService.send(subject, emailHtml, [{
          filename: `daily-brief-${dateStr}.pdf`,
          content: pdfBuffer,
          contentType: 'application/pdf',
        }]);
        console.log('[brief] email sent successfully');
      } catch (emailErr) {
        // Email failure must not fail the job — brief is already persisted
        console.warn('[brief] email send failed:', emailErr instanceof Error ? emailErr.message : String(emailErr));
      }
    }

    return {
      status: 'success',
      notes: `Brief generated: ${totalPicks} picks${totalGated > 0 ? ` (${totalGated} gated-illiquid)` : ''} | AI cost ~$${(aiCostEstimate + criticCostEstimate).toFixed(3)} | ${Math.round(totalMs / 1000)}s`,
      tickersAttempted: candidates.length,
      tickersUpdated: totalPicks,
      tickersSkipped: 0,
      tickersFailed: stage4Failed,
    };
  }

  // ── Stage 6b: DailyBrief watchlist sync ────────────────────────────────────

  /**
   * Create or refresh the DailyBrief-MMDD watchlist with today's final picks.
   * If the watchlist already exists for today, all items are cleared and replaced.
   * Each item's notes field contains the strategies the ticker was picked for
   * (e.g. "wheel · buy"), making the watchlist useful across other app views.
   * Non-fatal: failures are logged but never propagate to the job result.
   */
  private upsertBriefWatchlist(
    picks: Map<ScoringStrategy, BriefPick[]>,
    today: string,
  ): void {
    try {
      // today is always YYYY-MM-DD
      const mm = today.slice(5, 7);
      const dd = today.slice(8, 10);
      const wlName = `DailyBrief-${mm}${dd}`;

      const watchlistService = new WatchlistService(this.db);

      // Find or create
      let wl = watchlistService.findByName(wlName);
      if (wl) {
        watchlistService.clearItems(wl.id);
      } else {
        wl = watchlistService.create(wlName);
      }

      // Collect unique tickers, merging strategies when a ticker appears in multiple
      const tickerStrategies = new Map<string, string[]>();
      for (const [strategy, stratPicks] of picks) {
        for (const pick of stratPicks) {
          if (!tickerStrategies.has(pick.ticker)) tickerStrategies.set(pick.ticker, []);
          tickerStrategies.get(pick.ticker)!.push(strategy);
        }
      }

      const items = [...tickerStrategies.entries()].map(([ticker, strategies]) => ({
        ticker,
        notes: strategies.join(' · '),
      }));

      if (items.length > 0) {
        watchlistService.addItemsBulk(wl.id, items);
      }

      console.log(`[brief] watchlist "${wlName}" updated — ${items.length} tickers`);
      // Notify renderer so it refreshes the watchlist dropdown immediately
      this.onWatchlistUpdated?.();
    } catch (err) {
      // Non-fatal — brief is already persisted
      console.warn('[brief] watchlist update failed:', err instanceof Error ? err.message : String(err));
    }
  }

  // ── Stage 1 helpers ────────────────────────────────────────────────────────

  private loadCandidates(): string[] {
    // Score the full S&P 500 + Russell 1000 + ETF universe directly from the
    // constituents table.  The scoring engine has fundamental quality signals
    // (ROIC, FCF, earnings growth, leverage, relative strength) built in, so a
    // separate screener pre-filter is redundant and harmful — in particular it
    // would exclude overleveraged / declining stocks from the Bearish strategy
    // which specifically needs them.
    //
    // The Daily Screener batch job still runs and populates screen_results for
    // the Screener UI, but the Brief no longer depends on it.
    type Row = { ticker: string };
    const rows = this.db.prepare(`
      SELECT DISTINCT ticker FROM constituents
      WHERE index_name IN ('sp500', 'russell1000', 'etf')
      ORDER BY ticker ASC
    `).all() as Row[];

    // Exclude scoring reference tickers (SPY + sector ETFs) — these are
    // infrastructure for the relative-strength signal and are never trade picks.
    const refSet = new Set<string>(SCORING_REFERENCE_TICKERS);
    return rows.map(r => r.ticker).filter(t => !refSet.has(t));
  }

  // ── Stage 3 helpers ────────────────────────────────────────────────────────

  private loadFilterBonus(): Map<string, number> {
    // Check if there are any active alert-triggered tickers.
    // Add +5 bonus per matching active filter alert type.
    try {
      type AlertRow = { ticker: string };
      const triggered = this.db.prepare(`
        SELECT DISTINCT ticker FROM alerts
        WHERE is_triggered = 1 AND is_active = 1
      `).all() as AlertRow[];
      const bonus = new Map<string, number>();
      for (const r of triggered) bonus.set(r.ticker, (bonus.get(r.ticker) ?? 0) + 5);
      return bonus;
    } catch {
      return new Map();
    }
  }

  private loadEarningsPenalty(): Map<string, number> {
    // Returns -20 for any ticker with earnings in the next 45 days.
    // 45d matches the outer edge of the short-premium hold window (30–45 DTE structures).
    // Applied to EARNINGS_PENALTY_STRATEGIES (income, wheel, bearish) in Stage 3.
    try {
      const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      const [y, m, d] = todayET.split('-').map(Number);
      const horizonDate = new Date(Date.UTC(y!, m! - 1, d! + 45));
      const horizonStr = horizonDate.toISOString().slice(0, 10);
      type ERow = { ticker: string };
      const rows = this.db.prepare(`
        SELECT DISTINCT ticker FROM earnings_calendar
        WHERE report_date > ? AND report_date <= ?
      `).all(todayET, horizonStr) as ERow[];
      const penalty = new Map<string, number>();
      for (const r of rows) penalty.set(r.ticker, -20);
      return penalty;
    } catch {
      return new Map();
    }
  }
}
