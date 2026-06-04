// Daily Intelligence Brief batch job — 6-stage pipeline.
// Stage 1: Screen universe (cached data) → Stage 2: Score → Stage 3: Filter overlay
// → Stage 4: Strategy Lab validation (live E*Trade) → Stage 5: AI synthesis
// → Stage 6: Persist brief
// see Requirements/DAILY_INTELLIGENCE_BRIEF.md §5

import type { Database } from 'better-sqlite3';
import Anthropic from '@anthropic-ai/sdk';
import type { BatchJobHandler, BatchJobResult } from '../batch-service.js';
import type { BatchProgressEvent, BriefPick, ScoringStrategy } from '@shared/types.js';
import type { ScoredTicker } from '../scoring-service.js';
import { ScoringService, STRATEGIES } from '../scoring-service.js';
import type { OptionsProvider } from '../options-provider.js';
import type { DataProvider } from '../data-provider.js';
import { StrategyLabService } from '../strategy-lab-service.js';
import { secureGet } from '../secure-settings.js';
import { isTradingDay } from '../iv-history-service.js';
import { SCORING_REFERENCE_TICKERS } from './price-gap-fill-job.js';
import type { EmailService } from '../email-service.js';
import { buildEmailHtml, buildPdf } from '../brief-report-builder.js';
import type { PaperTradingService } from '../paper-trading-service.js';

const PICKS_PER_STRATEGY = 5;

function isAuthError(e: unknown): boolean {
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return msg.includes('401') || msg.includes('token') || msg.includes('auth') || msg.includes('oauth');
}
const STAGE_4_CAP = PICKS_PER_STRATEGY * STRATEGIES.length; // ≤ 25 total
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

// Returns false when the best relevant structure has liquidityScore below the threshold.
// Returns true when we have no lab result (can't gate) or no relevant structure available.
function hasAdequateLiquidity(labResult: object | null, strategy: string): boolean {
  if (!labResult) return true;
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
  if (best === null) return true; // structure unavailable — can't gate
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

  constructor(
    private readonly db: Database,
    private readonly dataProvider: DataProvider,
    private readonly optionsProvider: OptionsProvider,
    private readonly emailService: EmailService | null = null,
    private readonly paperTradingService: PaperTradingService | null = null,
  ) {
    this.scoringService = new ScoringService(db);
    this.strategyLabService = new StrategyLabService(dataProvider, optionsProvider);
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
      const enabledSignals = config.signals.filter(s => s.enabled && !s.phase2);
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
    emit('Stage 3/6: Filter overlay applied');

    // ── Stage 4: Strategy Lab deep validation (live E*Trade) ───────────────
    emit('Stage 4/6: Validating top picks via E*Trade…');
    const t4 = Date.now();

    // Collect top N per strategy (deduplicated by ticker)
    const topPerStrategy = new Map<string, ScoredTicker[]>();
    const stage4Queue: Array<{ ticker: string; strategies: string[] }> = [];
    const seenTickers = new Map<string, string[]>(); // ticker → strategies

    for (const strategy of STRATEGIES) {
      const top = (rankedByStrategy.get(strategy) ?? [])
        .filter(s => s.compositeScore > 0)
        .slice(0, PICKS_PER_STRATEGY);
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

    const aiRationales = new Map<string, string | null>();
    let aiCostEstimate = 0;

    try {
      const apiKey = secureGet(this.db, 'anthropicApiKey');
      if (!apiKey) throw new Error('no_key');

      const client = new Anthropic({ apiKey });

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
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2048,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      });

      const text = response.content.find(b => b.type === 'text')?.text ?? '';
      // Extract JSON array from response
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as Array<{ ticker: string; strategy: string; rationale: string }>;
        for (const item of parsed) {
          const key = `${item.ticker}:${item.strategy}`;
          aiRationales.set(key, item.rationale);
        }
      }

      // Rough cost estimate: haiku input ~$0.25/M + output ~$1.25/M tokens
      const inputTokens = response.usage?.input_tokens ?? 0;
      const outputTokens = response.usage?.output_tokens ?? 0;
      aiCostEstimate = (inputTokens / 1_000_000) * 0.25 + (outputTokens / 1_000_000) * 1.25;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      runMeta['aiError'] = msg === 'no_key' ? 'Anthropic API key not configured' : msg;
    }

    const stage5Ms = Date.now() - t5;
    runMeta['stages'] = { ...runMeta['stages'] as object, stage5: { rationales: aiRationales.size, costUsd: aiCostEstimate, ms: stage5Ms } };
    emit('Stage 5/6: AI synthesis complete');

    // ── Stage 6: Persist brief ───────────────────────────────────────────────
    emit('Stage 6/6: Persisting brief…');
    const validUntil = nextTradingDayOpen(new Date().toISOString());

    this.scoringService.pruneStaleBriefs(RETENTION_DAYS);

    let totalPicks = 0;
    let totalGated = 0;
    const persistedPicks = new Map<ScoringStrategy, BriefPick[]>();
    for (const strategy of STRATEGIES) {
      if (signal.aborted) break;
      const top = topPerStrategy.get(strategy) ?? [];

      // Hard liquidity gate — drop picks where the relevant strategy structure
      // has liquidityScore < MIN_LIQUIDITY_SCORE (e.g. OI=1 with wide spreads)
      const liquidFiltered = top.filter(scored => {
        const labResult = validationResults.get(scored.ticker) ?? null;
        return hasAdequateLiquidity(labResult, strategy);
      });
      const gated = top.length - liquidFiltered.length;
      if (gated > 0) totalGated += gated;

      const picks: BriefPick[] = liquidFiltered.map((scored, idx) => ({
        ticker: scored.ticker,
        compositeScore: scored.compositeScore,
        signals: scored.signals,
        strategyLabResult: validationResults.get(scored.ticker) ?? null,
        aiRationale: aiRationales.get(`${scored.ticker}:${strategy}`) ?? null,
        rank: idx + 1,
        validated: !!validationResults.get(scored.ticker) && validationResults.get(scored.ticker) !== null,
        price: signalData.get(scored.ticker)?.lastPrice ?? null,
      }));

      runMeta['configVersions'] = {
        ...runMeta['configVersions'] as object ?? {},
        [strategy]: this.scoringService.getConfig(strategy).version,
      };

      const briefId = this.scoringService.persistBrief(strategy, picks, validUntil, runMeta);
      persistedPicks.set(strategy, picks);
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
      notes: `Brief generated: ${totalPicks} picks${totalGated > 0 ? ` (${totalGated} gated-illiquid)` : ''} | AI cost ~$${aiCostEstimate.toFixed(3)} | ${Math.round(totalMs / 1000)}s`,
      tickersAttempted: candidates.length,
      tickersUpdated: totalPicks,
      tickersSkipped: 0,
      tickersFailed: stage4Failed,
    };
  }

  // ── Stage 1 helpers ────────────────────────────────────────────────────────

  private loadCandidates(): string[] {
    // Use the most recent screen run to get quality-filtered candidates.
    // Require passScore > 0 (at least one filter passed in soft mode, or all in strict).
    type RunRow = { id: number };
    const latestRun = this.db.prepare(
      'SELECT id FROM screen_runs ORDER BY id DESC LIMIT 1'
    ).get() as RunRow | undefined;

    if (!latestRun) return [];

    type SRow = { ticker: string; payload_json: string };
    const rows = this.db.prepare(`
      SELECT ticker, payload_json
      FROM screen_results
      WHERE screen_run_id = ?
      ORDER BY ticker ASC
    `).all(latestRun.id) as SRow[];

    // Exclude scoring reference tickers (SPY + sector ETFs) — these are infrastructure
    // tickers for the relative-strength signal and are never valid trade picks.
    const refSet = new Set<string>(SCORING_REFERENCE_TICKERS);

    return rows
      .map(r => {
        const p = JSON.parse(r.payload_json) as { passScore?: number; failedFilters?: string[] };
        return { ticker: r.ticker, passScore: p.passScore ?? 0 };
      })
      .filter(r => r.passScore > 0 && !refSet.has(r.ticker))
      .map(r => r.ticker);
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
}
