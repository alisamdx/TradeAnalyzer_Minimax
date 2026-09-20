// Daily Intelligence Brief batch job — 6-stage pipeline.
// Stage 1: Screen universe (cached data) → Stage 2: Score → Stage 3: Filter overlay
// → Stage 4: Strategy Lab validation (live E*Trade) → Stage 5: AI synthesis
// → Stage 6: Persist brief
// see Requirements/DAILY_INTELLIGENCE_BRIEF.md §5

import type { Database } from 'better-sqlite3';
import Anthropic from '@anthropic-ai/sdk';
import type { BatchJobHandler, BatchJobResult, RunTrigger } from '../batch-service.js';
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
import { sendDiceEmail, sendShortlistEmail } from '../brief-emails.js';
import { captureSpreadChains } from '../spread-chain-capture.js';
import { computeSpreadMode } from '../spread-mode.js';
import { SPREAD_MODE_POOLS } from '@shared/spread-mode.js';
import { logEmailOutcome } from '../email-log.js';
import type { PaperTradingService } from '../paper-trading-service.js';
import { CriticService } from '../critic-service.js';
import { WatchlistService } from '../watchlist-service.js';
import { parseRationaleResponse } from '../brief-rationale-parser.js';
import type { EarningsService } from '../earnings-service.js';
import { isEarningsPending } from '../earnings-service.js';
import type { OAuthCredentials } from '../etrade-auth.js';
import { getETradeLastPrice } from '../etrade-options.js';
import { withTransaction } from '../../db/connection.js';
import { STRATEGY_RELEVANT_SLUGS, pickRelevantStructure, relevantSlugsForPick, formatStructureLegs } from '@shared/strategy-structures.js';
import { extractLoggableScores, logStructureLiquidity, pruneStructureLiquidityLog } from '../structure-liquidity-log.js';
import { saveBriefCandidates, pruneBriefCandidates, resolveSlot, type BriefCandidateRow, type CandidateDisposition } from '../brief-candidates.js';
import { osiSymbol, type LegacyBriefHandoff } from '@tradeanalyzer/core';

// VIX sane range — reject anything outside this (a quote typo can return an unrelated
// symbol). Historical VIX spans ~9 (2017) to ~82 (COVID); [5,150] is a safe guard.
const VIX_MIN = 5;
const VIX_MAX = 150;

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

// Which Strategy Lab slugs represent each brief strategy (STRATEGY_RELEVANT_SLUGS,
// shared with the critic / report / UI via '@shared/strategy-structures.js') drive the
// liquidity gate — we check only structures the brief strategy would trade.

// Returns the best liquidityScore (0–15) among the strategy-relevant structures,
// or null when no lab result or no relevant structure is available.
function getBestLiquidityScore(
  labResult: object | null,
  strategy: string,
  breakoutDirection?: 'up' | 'down',
): number | null {
  if (!labResult) return null;
  type SScore = { slug: string; liquidityScore: number; setup: { unavailableReason: string | null } | null };
  type LabRes  = { scores?: SScore[] };
  const result = labResult as LabRes;
  // Direction-locked slugs for inflection so the gate evaluates the SAME structure the
  // brief recommends (an up breakout's bull-put, never the opposite-side bear-call).
  const slugs  = relevantSlugsForPick(strategy, breakoutDirection);
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
function hasAdequateLiquidity(
  labResult: object | null,
  strategy: string,
  breakoutDirection?: 'up' | 'down',
): boolean {
  if (!labResult) return true; // validation failed entirely — can't gate what we didn't measure
  const best = getBestLiquidityScore(labResult, strategy, breakoutDirection);
  if (best === null) return false; // lab ran but no valid structure found for this strategy
  return best >= MIN_LIQUIDITY_SCORE;
}

// Shape of a Strategy Lab score, narrowed to just what candidate capture needs. Declared
// locally and cast from `object | null`, the same way getBestLiquidityScore does — the lab result
// crosses this boundary untyped.
type CandLeg   = {
  action: string; side?: 'call' | 'put' | null; strike: number; mid: number;
  delta?: number | null; iv?: number | null; bid?: number | null; ask?: number | null;
  openInterest?: number | null; volume?: number | null;
};
type CandSetup = {
  unavailableReason?: string | null; maxLoss?: number | null;
  expiration?: string; dte?: number; legs?: CandLeg[];
  netCredit?: number | null; annualizedReturn?: number | null; popEstimate?: number | null;
  currentAtmIv?: number | null;
};
type CandScore = { slug: string; grade: string; liquidityScore: number; setup: CandSetup | null };

// Map a ticker's breakout signal to the inflection trade direction. 1 → up (bull-put),
// −1 → down (bear-call), else undefined (non-breakout / non-inflection).
function breakoutDirectionOf(sd: { breakoutState?: number | null } | undefined | null): 'up' | 'down' | undefined {
  const st = sd?.breakoutState;
  return st === 1 ? 'up' : st === -1 ? 'down' : undefined;
}

// Compact summary of the structure a strategy would actually trade — fed to the
// Stage-5 advocate so its rationale describes THIS trade (credit vs debit, legs)
// rather than guessing one from the strategy name. Without it the advocate
// hallucinated structures: e.g. recommending "straddle sells / iron condors" for an
// inflection pick whose real structure is a bull-put CREDIT spread, then arguing high
// IV was bad (it's favorable when you sell premium). Returns null when no relevant
// validated structure exists.
function summarizeRelevantStructure(
  labResult: object | null,
  strategy: string,
  breakoutDirection?: 'up' | 'down',
): Record<string, unknown> | null {
  type Leg = { action: string; side?: 'call' | 'put'; strike: number; qty?: number };
  type SSetup = { legs: Leg[]; netCredit: number | null; netDebit: number | null; maxLoss?: number | null; unavailableReason?: string | null };
  type SScore = { slug: string; grade: string; setup: SSetup | null };
  const scores = (labResult as { scores?: SScore[] } | null)?.scores;
  const chosen = pickRelevantStructure<SScore>(scores, strategy, breakoutDirection);
  if (!chosen?.setup) return null;
  const s = chosen.setup;
  const isCredit = s.netCredit !== null && s.netCredit > 0;
  return {
    type: chosen.slug,
    grade: chosen.grade,
    // The single most-misread fact: credit structures SELL premium (high IV good),
    // debit structures BUY it (high IV bad).
    premiumDirection: isCredit
      ? 'credit — you SELL premium; high IV/IVR is FAVORABLE (richer premium collected)'
      : 'debit — you BUY premium; high IV/IVR RAISES the cost',
    legs: formatStructureLegs(s.legs),
    netCredit: s.netCredit,
    netDebit: s.netDebit,
  };
}

// America/New_York UTC offset (minutes, negative = west) on the given ET calendar date.
// EDT = −240, EST = −300. Probe at noon UTC (= morning ET, safely past the 2am DST switch).
function etUtcOffsetMinutes(etDate: string): number {
  const probe = new Date(etDate + 'T12:00:00Z');
  const asUtc = new Date(probe.toLocaleString('en-US', { timeZone: 'UTC' }));
  const asEt  = new Date(probe.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return Math.round((asEt.getTime() - asUtc.getTime()) / 60000);
}

// 9:30am ET on the next trading day STRICTLY AFTER `fromIso`'s ET date — used as valid_until.
// Keyed off the ET *calendar date*, not the UTC date: an evening-ET run is already "tomorrow"
// in UTC, so the old UTC-based version skipped a trading day (a Mon-evening brief expired Wed
// instead of Tue). DST-aware: 9:30 ET = 13:30Z under EDT, 14:30Z under EST (the old hardcoded
// 13:30Z was an hour early all winter). see docs/formulas.md#trading-days
export function nextTradingDayOpen(fromIso: string): string {
  const todayEt = new Date(fromIso).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  // Advance ET calendar date to the next trading day. Noon-UTC anchor keeps date math DST-safe.
  const d = new Date(todayEt + 'T12:00:00Z');
  do {
    d.setUTCDate(d.getUTCDate() + 1);
  } while (!isTradingDay(d.toISOString().slice(0, 10)));
  const target = d.toISOString().slice(0, 10); // next trading day, YYYY-MM-DD (ET)
  // 9:30 ET on `target` as a UTC instant: take 9:30 as-if-UTC, then shift by the ET offset.
  const [y, m, day] = target.split('-').map(Number);
  const wallAsUtcMs = Date.UTC(y!, m! - 1, day!, 9, 30, 0, 0);
  return new Date(wallAsUtcMs - etUtcOffsetMinutes(target) * 60000).toISOString();
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
    /**
     * The NewApp legacy hand-off (04 §8) — **fire-and-forget, and optional**.
     *
     * Null in every test and on any install where the new generation does not
     * exist, which is the point: D1 says the collector must not change what the
     * brief decides or emails, and the strongest form of that promise is a
     * dependency the brief runs identically without.
     *
     * The call site below swallows everything it can throw. A collector problem
     * is a collector exception, never a brief failure.
     */
    private readonly legacyHandoff:
      ((payload: Omit<LegacyBriefHandoff, 'legacyAppVersion'>) => void) | null = null,
  ) {
    this.scoringService = new ScoringService(db);
    this.strategyLabService = new StrategyLabService(dataProvider, optionsProvider);
    this.criticService = new CriticService(db);
  }

  async run(
    onProgress: (evt: BatchProgressEvent) => void,
    signal: AbortSignal,
    force = false,
    _trigger?: RunTrigger,
    slotTime?: string | null,
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
    // Tracks which (strategy, ticker) pairs already took the hit, so the
    // post-verification second pass below can never double-penalise.
    const alreadyPenalised = new Set<string>();
    const applyEarningsPenalty = (label: string): number => {
      const penalty = this.loadEarningsPenalty();
      let total = 0;
      if (penalty.size === 0) return 0;
      for (const strategy of EARNINGS_PENALTY_STRATEGIES) {
        const list = rankedByStrategy.get(strategy) ?? [];
        let penalised = 0;
        for (const s of list) {
          const key = `${strategy}:${s.ticker}`;
          if (penalty.has(s.ticker) && !alreadyPenalised.has(key)) {
            s.compositeScore = Math.max(0, s.compositeScore - 20);
            alreadyPenalised.add(key);
            penalised++;
          }
        }
        if (penalised > 0) {
          list.sort((a, b) => b.compositeScore - a.compositeScore);
          total += penalised;
          console.log(`[brief stage3${label}] ${strategy}: penalised ${penalised} tickers for earnings within 45d`);
        }
      }
      return total;
    };

    applyEarningsPenalty('');

    // ── Earnings verification net (v1.1.138) ─────────────────────────────────
    // The penalty above is only as good as `earnings_calendar`. A stored date that
    // is wrong in the FAR direction silently disables the gate — that is how NVDA
    // (stored 2026-11-17, true 2026-08-26) ranked wheel #1 on the day it reported.
    //
    // So before the pool is locked, confirm the earnings dates of the provisional
    // top candidates for the penalty-bearing strategies against E*Trade — an
    // independent source from the Finnhub-derived calendar — then re-apply the
    // penalty to anything newly revealed and re-sort.
    //
    // This used to run AFTER pick selection (Stage 5b), which meant it could never
    // remove a pick no matter what it found; combined with refreshTickers skipping
    // any stored future date, the net was inert in both directions.
    // `refreshTickers` skips dates already inside the risk horizon, so this is
    // typically ~20 calls, not the full pool.
    if (this.earningsService) {
      const provisionalPool = [...new Set(
        EARNINGS_PENALTY_STRATEGIES.flatMap(strategy =>
          (rankedByStrategy.get(strategy) ?? [])
            .filter(s => s.compositeScore > 0)
            .slice(0, STAGE4_POOL_SIZE)
            .map(s => s.ticker)
        )
      )];
      if (provisionalPool.length > 0) {
        try {
          const creds = this.getEtradeCreds?.() ?? null;
          const res = await this.earningsService.refreshTickers(provisionalPool, creds);
          const newlyPenalised = applyEarningsPenalty(' verify');
          runMeta['earningsVerify'] = {
            checked: provisionalPool.length,
            updated: res.updated, skipped: res.skipped, failed: res.failed,
            newlyPenalised,
          };
          if (newlyPenalised > 0) {
            console.log(`[brief stage3 verify] E*Trade confirmation caught ${newlyPenalised} pick-level earnings the calendar had missed`);
          }
        } catch (err) {
          // Non-fatal: the stored-calendar penalty above still stands.
          runMeta['earningsVerify'] = { error: err instanceof Error ? err.message : String(err) };
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

    // Risk-budget-driven spread width (v2 execution, default off — see migration 053). When on,
    // size the inflection vertical's hedge leg to the per-trade budget so it's tradeable on a
    // small account. Read once from exec_config; null = current delta-based width.
    const execCfg = this.db
      .prepare('SELECT capital_ceiling, max_risk_per_trade_pct, budget_width_enabled FROM exec_config WHERE id = 1')
      .get() as { capital_ceiling: number; max_risk_per_trade_pct: number; budget_width_enabled: number } | undefined;
    const maxLossBudget =
      execCfg && execCfg.budget_width_enabled === 1
        ? (execCfg.max_risk_per_trade_pct / 100) * execCfg.capital_ceiling
        : null;

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
        const result = await this.strategyLabService.validate(this.db, ticker, maxLossBudget);
        validationResults.set(ticker, result as unknown as object);
        // Instrumentation (NEW_FRONTIER §11): persist this run's liquidity measurements so
        // intraday vs after-close pairs accumulate (the evening brief deletes the morning
        // brief rows, so brief storage alone can't provide pairs). Never breaks the brief.
        try {
          logStructureLiquidity(this.db, extractLoggableScores(ticker, result as unknown as object));
        } catch (logErr) {
          console.warn('[brief] structure-liquidity log failed:', logErr instanceof Error ? logErr.message : String(logErr));
        }
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
    try { pruneStructureLiquidityLog(this.db); } catch { /* instrumentation only */ }

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
      const picksForAI: Array<{ ticker: string; strategy: string; score: number; signals: Record<string, unknown>; structure: Record<string, unknown> | null }> = [];
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
            // The actual trade being proposed, so the rationale matches it (credit vs
            // debit, legs) instead of being invented from the strategy name.
            structure: summarizeRelevantStructure(
              validationResults.get(pick.ticker) ?? null, strategy,
              breakoutDirectionOf(signalData.get(pick.ticker)),
            ),
          });
        }
      }

      const systemPrompt = `You are an experienced retail options trader reviewing today's top trade candidates.
Each candidate includes a \`structure\` object describing the EXACT trade being proposed: its type, whether it is a CREDIT structure (you sell premium — high IV/IVR is favorable) or a DEBIT structure (you buy premium — high IV/IVR raises cost), and its legs. Base your rationale on THAT structure — never invent or recommend a different one (do not suggest a straddle/condor/long option when the structure says otherwise). When \`structure\` is null, the pick was not validated against a live chain — speak to the signals only, not a specific structure.
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

    // ── Earnings fill for the remaining final picks ──────────────────────────
    // Secondary to the Stage-3 verification net above, which already confirmed the
    // penalty-bearing strategies (income/wheel/bearish) BEFORE the pool was locked.
    // This covers the rest — buy/bullish/inflection picks — where ~11% of the
    // universe has no future earnings row (Finnhub bulk-fill gaps) and the critic
    // treats missing calendar data as unverified event risk. It cannot change which
    // picks were selected (they already are); it exists so the critic and the v2
    // entry gate (`brief-entry-source` earningsBeforeExpiry) see complete data.
    // refreshTickers skips dates already inside the risk horizon, so this is
    // typically only a handful of calls.
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

    // Every Stage-4 candidate, survivors AND losers, for later selection studies. The brief keeps
    // only the top PICKS_PER_STRATEGY, so without this the cut from 15 to 5 is unmeasurable —
    // and that cut is where an anti-predictive composite would do its damage (v1.1.173 F8).
    // Instrumentation only: it never gates, and saveBriefCandidates never throws.
    const candidateRows: BriefCandidateRow[] = [];
    // The NewApp hand-off's candidate list, built alongside the rows above from
    // the same in-scope data (04 §8). Kept separate rather than derived from
    // `candidateRows` later, because a `SetupLeg` carries the contract's `side`
    // and that row shape does not — reconstructing the right afterwards would
    // mean inferring it from a structure slug.
    const handoffCandidates: LegacyBriefHandoff['candidates'][number][] = [];
    const candidateRunAt = new Date().toISOString();
    const candidateDate = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    // Which of the day's two batch phases this is. Both are kept (migration 079) because the two
    // runs disagreeing is the thing worth measuring — the dice emails both, and the liquidity
    // score reads same-day volume, which is monotonic within the session.
    const candidateSlot = resolveSlot(slotTime);
    // Next report date per ticker AS KNOWN NOW. This is the only way the earnings gate ever
    // becomes testable: `earnings_calendar` keeps one row per ticker with no history, so a
    // replay sees today's date rather than the one that was live on the pick date. A stored
    // date already in the past means the row was never refreshed after that report, so the NEXT
    // date is unknown — left null, matching how roll-the-dice.ts fails closed on it.
    const earningsByTicker = new Map<string, string>();
    try {
      for (const r of this.db.prepare(
        'SELECT ticker, report_date FROM earnings_calendar WHERE report_date >= ?',
      ).all(candidateDate) as Array<{ ticker: string; report_date: string }>) {
        earningsByTicker.set(r.ticker, r.report_date);
      }
    } catch { /* instrumentation only — never fail the brief over it */ }
    const daysUntil = (iso: string): number => Math.round(
      (Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${candidateDate}T00:00:00Z`)) / 86_400_000);

    for (const strategy of STRATEGIES) {
      const top = topPerStrategy.get(strategy) ?? [];
      const passedGate = top.filter(scored =>
        hasAdequateLiquidity(
          validationResults.get(scored.ticker) ?? null, strategy,
          breakoutDirectionOf(signalData.get(scored.ticker)),
        )
      );
      const liquidFiltered = passedGate.slice(0, PICKS_PER_STRATEGY);
      // failedGate: rejected by liquidity. cappedOut: liquid but outranked by top 5.
      const failedGate = top.filter(s => !passedGate.includes(s));
      const cappedOut  = passedGate.slice(PICKS_PER_STRATEGY);
      if (failedGate.length > 0) totalGated += failedGate.length;

      const fmt = (s: ScoredTicker) => {
        const liq = getBestLiquidityScore(
          validationResults.get(s.ticker) ?? null, strategy,
          breakoutDirectionOf(signalData.get(s.ticker)),
        );
        return `${s.ticker}(${liq ?? '?'}/15)`;
      };
      let logLine = `[brief funnel] ${strategy}: ${top.length} → ${liquidFiltered.length} final`;
      if (failedGate.length > 0) logLine += ` | liq-failed: ${failedGate.map(fmt).join(', ')}`;
      if (cappedOut.length  > 0) logLine += ` | outranked: ${cappedOut.map(fmt).join(', ')}`;
      console.log(logLine);

      // Record the pool before narrowing to `picks`. Disposition is derived from the same three
      // sets the funnel log above already computes, so the table and the log can never disagree.
      const pickedSet = new Set(liquidFiltered.map(x => x.ticker));
      const failedSet = new Set(failedGate.map(x => x.ticker));
      for (let i = 0; i < top.length; i++) {
        const scored = top[i]!;
        const lab = validationResults.get(scored.ticker) ?? null;
        const dir = breakoutDirectionOf(signalData.get(scored.ticker));
        const disposition: CandidateDisposition =
          pickedSet.has(scored.ticker) ? 'picked'
          : failedSet.has(scored.ticker) ? (lab ? 'failed_liquidity' : 'not_validated')
          : 'capped_out';
        // The structure this strategy would actually trade — the same choice the report, critic
        // and renderer make, so a stored candidate is comparable to a stored pick.
        const struct = pickRelevantStructure<CandScore>(
          (lab as { scores?: CandScore[] } | null)?.scores, strategy, dir,
        );
        const setup = struct?.setup ?? null;
        // For a short-premium structure the meaningful price is the SHORT leg's mid; for anything
        // else fall back to the first leg, so the row is still settleable.
        const shortLeg = setup?.legs?.find(l => String(l.action).toLowerCase().startsWith('sell'))
          ?? setup?.legs?.[0] ?? null;
        candidateRows.push({
          asOfDate: candidateDate,
          generatedAt: candidateRunAt,
          slot: candidateSlot,
          strategy,
          ticker: scored.ticker,
          compositeScore: scored.compositeScore,
          rank: i + 1,
          disposition,
          // The scored signals, same shape daily_briefs keeps for picks — this is what lets a
          // later study attribute a bad cut to a specific signal rather than infer it.
          signalsJson: scored.signals ? JSON.stringify(scored.signals) : null,
          structureSlug: struct?.slug ?? null,
          grade: struct?.grade ?? null,
          strike: shortLeg?.strike ?? null,
          premium: shortLeg?.mid ?? null,
          expiration: setup?.expiration ?? null,
          dte: setup?.dte ?? null,
          liquidityScore: getBestLiquidityScore(lab, strategy, dir),
          spot: signalData.get(scored.ticker)?.lastPrice ?? null,
          delta: shortLeg?.delta ?? null,
          legIv: shortLeg?.iv ?? null,
          bid: shortLeg?.bid ?? null,
          ask: shortLeg?.ask ?? null,
          openInterest: shortLeg?.openInterest ?? null,
          volume: shortLeg?.volume ?? null,
          netCredit: setup?.netCredit ?? null,
          maxLoss: setup?.maxLoss ?? null,
          annualizedReturn: setup?.annualizedReturn ?? null,
          popEstimate: setup?.popEstimate ?? null,
          atmIv: setup?.currentAtmIv ?? null,
          earningsDate: earningsByTicker.get(scored.ticker) ?? null,
          daysToEarnings: earningsByTicker.has(scored.ticker)
            ? daysUntil(earningsByTicker.get(scored.ticker)!) : null,
        });

        // ── NewApp legacy hand-off (04 §8) ───────────────────────────────────
        //
        // Built here rather than reconstructed later, because this is the only
        // place the real `SetupLeg` is in scope — it carries `side`, so the
        // contract's right is READ, never inferred from a structure slug.
        //
        // Every candidate goes in, losers included. That is the entire point of
        // the contract: `daily_briefs` keeps only survivors, so the cut from 15
        // to 5 is unmeasurable, and the rejected candidates are the control
        // group any study of the ranking needs.
        handoffCandidates.push({
          ticker: scored.ticker,
          // No cast. `LegacyHandoffCandidate.mode` is the same six-value list as
          // `STRATEGIES`, so this assigns directly — and if the two ever diverge
          // again the compiler says so here. A cast sat in this spot and is the
          // reason a vocabulary mismatch shipped: it silenced the one check that
          // would have caught `income` having no home in the dictionary enum.
          mode: strategy,
          consideredRank: i + 1,
          survived: disposition === 'picked',
          compositeScore: scored.compositeScore,
          finalDisposition: disposition,
          // The one gate whose tested value and threshold are both known here.
          // Recorded for passes as well as failures — a gate's distribution is
          // what says whether it can ever fire, and only the fires are useless.
          gates: getBestLiquidityScore(lab, strategy, dir) === null ? [] : [{
            name: 'liquidity',
            passed: disposition !== 'failed_liquidity',
            testedValue: getBestLiquidityScore(lab, strategy, dir),
            threshold: MIN_LIQUIDITY_SCORE,
            reason: disposition === 'failed_liquidity' ? 'below the brief liquidity gate' : null,
          }],
          signals: Object.entries(scored.signals ?? {}).map(([key, s]) => ({
            key,
            rawValue: Number.isFinite(s?.raw as number) ? (s?.raw as number) : null,
            normalized: Number.isFinite(s?.normalized as number) ? (s?.normalized as number) : null,
            weight: (s?.weight as number) ?? 0,
            enabled: s?.missing !== true,
          })),
          // A leg is emitted only when its side and the setup's expiration are
          // both known. Both are needed to build the OSI symbol, and a
          // constructed symbol that is wrong does not throw — it pins a
          // contract tomorrow's chain phase never matches, so the sticky set
          // looks populated and captures nothing. Skipping is the honest
          // failure; guessing the right from a structure slug is not.
          legs: (setup?.legs ?? []).flatMap(l => {
            const expiration = setup?.expiration;
            if (!l.side || !expiration) return [];
            return [{
              osiSymbol: osiSymbol({
                ticker: scored.ticker, expiration, side: l.side, strike: l.strike,
              }),
              right: l.side,
              strike: l.strike,
              expiration,
              bid: l.bid ?? null,
              ask: l.ask ?? null,
              mid: l.mid ?? null,
              // **A fraction, and no conversion here.** The lab already holds
              // fractions; a `* 100` anywhere on this path would inflate every
              // stored leg a hundredfold (02 §0.1).
              iv: l.iv ?? null,
              delta: l.delta ?? null,
              openInterest: l.openInterest ?? null,
              volume: l.volume ?? null,
              // The field's PRESENCE, not its truthiness. `?? 0` is what turned
              // "not reported" into "did not trade" on 23 of 250 stored legs.
              volumeReported: l.volume !== null && l.volume !== undefined,
              liquidityScore: getBestLiquidityScore(lab, strategy, dir),
            }];
          }),
        });
      }

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
        // Persist breakout side so the critic / report / renderer lock to the SAME
        // direction-matched structure as the advocate (inflection only; undefined → omitted).
        breakoutDirection: breakoutDirectionOf(signalData.get(scored.ticker)),
      }));
      assembledPicks.set(strategy as ScoringStrategy, picks);
    }

    // ── Stage 5b: AI Critic ──────────────────────────────────────────────────
    emit('Stage 5b/6: Running AI Critic…');
    const t5b = Date.now();
    let criticCostEstimate = 0;

    // Refresh VIX into quote_cache so the critic's macro context (and its VIX rules)
    // have a value. Fail-closed — on any problem the critic falls back to null VIX.
    const vix = await this.refreshVixQuote();
    runMeta['vix'] = vix; // surfaced so the operator can eyeball it vs the real VIX day 1

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

    // The candidate pool outlives the briefs on purpose: `daily_briefs` averages 147.7 KB/row
    // (it carries the full lab result per pick) and is pruned at 90 days, which is why every
    // study on this data reports "one regime". These rows cost ~20 MB per trading year, so
    // they are kept for two years and the evidence survives the window the briefs cannot.
    const savedCandidates = saveBriefCandidates(this.db, candidateRows);
    pruneBriefCandidates(this.db);
    runMeta['candidatesRecorded'] = savedCandidates;
    console.log(`[brief] recorded ${savedCandidates} Stage-4 candidates (survivors + losers)`);

    // ── NewApp legacy hand-off (04 §8) ───────────────────────────────────────
    //
    // **Fire-and-forget, and D1 is the reason.** The collector must not change
    // what the brief decides or emails, so this runs after every decision is
    // made and persisted, and its failure mode is a log line. There is no
    // `await`, no branch on its result, and nothing downstream reads it.
    //
    // It is also the last thing that touches `handoffCandidates`, so a throw
    // here cannot leave the brief's own state half-written.
    if (this.legacyHandoff && handoffCandidates.length > 0) {
      try {
        // `legacyAppVersion` is supplied by the wiring, not here: it comes
        // from `app.getVersion()`, and importing Electron into a batch job to
        // fetch one string would make the job untestable under plain Node for
        // no gain.
        this.legacyHandoff({
          briefId: null,
          tradingDate: candidateDate,
          // The collector's vocabulary, not this app's. `intraday` here is
          // `morning` there, and the slot is part of the run key precisely so
          // the two daily runs stay distinguishable (migration 079).
          slot: candidateSlot === 'intraday' ? 'morning' : 'after_close',
          emailedAt: null,
          candidates: handoffCandidates,
        });
      } catch (err) {
        // A collector problem is a collector exception, never a brief failure.
        console.warn('[brief] legacy hand-off failed (brief unaffected):',
          err instanceof Error ? err.message : String(err));
      }
    }

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
    //
    // Every outcome is recorded in logs/errors (v1.1.241). Until then both emails reported only
    // to the console, which a packaged app does not keep: on 2026-09-11 the after-close brief
    // emailed its 17 picks at ~17:35, the dice email seconds later never arrived, and nothing
    // anywhere said why.
    if (this.emailService?.isConfigured()) {
      if (totalPicks > 0) {
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
        logEmailOutcome({ level: 'INFO', operation: 'brief-email:sent', message: `[brief] brief email sent: ${subject}` });
      } catch (emailErr) {
        // Email failure must not fail the job — brief is already persisted
        logEmailOutcome({
          level: 'ERROR', operation: 'brief-email:send',
          message: `[brief] brief email NOT sent: ${emailErr instanceof Error ? emailErr.message : String(emailErr)}`,
          error: emailErr,
        });
      }
      } else {
        logEmailOutcome({ level: 'INFO', operation: 'brief-email:skipped', message: '[brief] brief email not sent: the brief has 0 picks' });
      }

      // ── Roll the Dice: the same brief, reduced to one actionable wheel entry ──────
      //
      // Sent from HERE rather than as its own batch job on purpose. It is a pure filter over
      // the brief this job just persisted, so running it inline guarantees the ordering that
      // matters and avoids a new `sequence_order` row — a column `registerJob` seeds only on
      // fresh installs, which has caused four separate defects (v1.1.121, v1.1.123,
      // migration 067, v1.1.160).
      //
      // Reads back from the DB rather than reusing `persistedPicks` so the email, the in-app
      // panel and the IPC all resolve today's pick through one code path.
      //
      // A no-pick day still sends: silence cannot be told apart from a failed job. And a no-pick
      // BRIEF still sends it too — this used to sit inside `totalPicks > 0`, contradicting the
      // sentence above. `sendDiceEmail` never throws; it logs which step failed and retries a
      // failed send once.
      await sendDiceEmail({ email: this.emailService, db: this.db, log: logEmailOutcome, source: 'brief' });

      // ── Wheel Shortlist (NewApp 07 §3) — advisory, after every brief run (D5) ─────────────────
      // Top 5 puts at 0.35–0.45Δ / 14–30 DTE from this run's wheel + income candidate pools, priced
      // live. Runs after the brief is persisted so it reads exactly what this run recorded, and it
      // never throws: a failure is logged with its step and the brief's result is unaffected.
      emit('Building Wheel Shortlist…');
      await sendShortlistEmail({
        email: this.emailService, db: this.db, provider: this.optionsProvider, log: logEmailOutcome, source: 'brief',
      });
    }

    // ── Bull put spread chain capture (TODO #42) — data collection only, both legs ─────────────
    // Outside the email block on purpose: capture must not depend on email being configured. Reads
    // this run's candidate pools, so it runs after they are persisted; never throws.
    if (!signal.aborted) {
      emit('Capturing spread chains…');
      const cap = await captureSpreadChains({ db: this.db, provider: this.optionsProvider, slot: candidateSlot });
      const summary = `[brief] spread chains: ${cap.rowsWritten} rows (${cap.entryTickers} entry tickers, ${cap.trackedSeries} tracked series, ${cap.failures.length} failures)`;
      logEmailOutcome({
        level: cap.failures.length > 0 && cap.rowsWritten === 0 ? 'ERROR' : 'INFO',
        operation: 'spread-capture:run',
        message: cap.failures.length > 0
          ? `${summary}; first: ${cap.failures[0]!.ticker} ${cap.failures[0]!.step} — ${cap.failures[0]!.message}`
          : summary,
      });

      // ── Bull put spread mode (TODO #44, NewApp 08) — SHADOW: computed + stored, no panel, no email ──
      // Reads the chains captured just above, so it costs no E*Trade calls; never throws.
      //
      // One pass per candidate pool (08 S11, v1.1.301). `wheel` is the incumbent and the pool §4 judges;
      // `income` is the challenger, run side by side so the comparison is a PAIRED same-day sample. Both
      // pools' chains are already captured (SPREAD_CAPTURE.strategies) and both strategies' candidates are
      // already stored, so the second arm costs nothing beyond the arithmetic. A failure in one pool is
      // logged and the next still runs.
      for (const pool of SPREAD_MODE_POOLS) {
        const spreadMode = computeSpreadMode({ db: this.db, slot: candidateSlot, pool });
        logEmailOutcome({
          level: spreadMode.error ? 'ERROR' : 'INFO',
          operation: 'spread-mode:run',
          message: spreadMode.error
            ? `[brief] spread mode (${pool}) failed (brief unaffected): ${spreadMode.error}`
            : `[brief] spread mode ${spreadMode.mode} (${pool}): ${spreadMode.picks.length} picks from `
              + `${spreadMode.considered} ${pool} candidates, ${spreadMode.rejections.length} rejected, `
              + `${spreadMode.rowsWritten} rows stored`,
        });
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
  /**
   * Fetch the VIX index via E*Trade and upsert it into quote_cache (ticker 'VIX'),
   * where CriticService.getMarketContext() reads it. Fail-closed: any missing creds,
   * fetch error, or out-of-range value leaves quote_cache untouched, so the critic
   * keeps its safe null-VIX behavior. Returns the value written, or null.
   * see CLAUDE.md "Known quirks" (VIX), .ai/AI_CONTEXT.md §10.
   */
  private async refreshVixQuote(): Promise<number | null> {
    try {
      const creds = this.getEtradeCreds?.() ?? null;
      if (!creds) return null;
      const vix = await getETradeLastPrice('VIX', creds);
      if (vix === null || vix < VIX_MIN || vix > VIX_MAX) {
        if (vix !== null) console.warn(`[brief] VIX ${vix} outside [${VIX_MIN},${VIX_MAX}] — ignored (suspect wrong symbol)`);
        return null;
      }
      withTransaction(this.db, () => {
        this.db.prepare(
          `INSERT INTO quote_cache (ticker, last, fetched_at)
             VALUES ('VIX', @last, @fetchedAt)
           ON CONFLICT(ticker) DO UPDATE SET last = @last, fetched_at = @fetchedAt`
        ).run({ last: vix, fetchedAt: new Date().toISOString() });
      });
      return vix;
    } catch (err) {
      console.warn('[brief] VIX refresh failed (non-fatal):', err instanceof Error ? err.message : String(err));
      return null;
    }
  }

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
    // Returns -20 for any ticker with a still-pending earnings event in the next 45 days
    // (including today, if it hasn't happened yet — see isEarningsPending). 45d matches the
    // outer edge of the short-premium hold window (30–45 DTE structures). Applied to
    // EARNINGS_PENALTY_STRATEGIES (income, wheel, bearish) in Stage 3.
    try {
      const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      const [y, m, d] = todayET.split('-').map(Number);
      const horizonDate = new Date(Date.UTC(y!, m! - 1, d! + 45));
      const horizonStr = horizonDate.toISOString().slice(0, 10);
      type ERow = { ticker: string; report_date: string; report_time: 'bmo' | 'amc' | null };
      const rows = this.db.prepare(`
        SELECT ticker, report_date, report_time FROM earnings_calendar
        WHERE report_date >= ? AND report_date <= ?
      `).all(todayET, horizonStr) as ERow[];
      const penalty = new Map<string, number>();
      for (const r of rows) {
        if (isEarningsPending(r.report_date, r.report_time, todayET)) penalty.set(r.ticker, -20);
      }
      return penalty;
    } catch {
      return new Map();
    }
  }
}
