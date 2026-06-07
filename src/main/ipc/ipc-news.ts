// IPC handlers for the News & Research module.
// Phase 1: raw signals + rule-based scoring.
// Phase 2: Claude AI synthesis after raw signals collected.
// See Requirements/news-research.md — FR-NR-37.

import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { NewsDataFetcher } from '../services/news-data-fetcher.js';
import type { NewsAIService } from '../services/news-ai-service.js';
import type { TokenBucketRateLimiter } from '../services/rate-limiter.js';
import type { NewsResearchResult, MacroEvent, RawSignals } from '@shared/types.js';

function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}
function fail(err: unknown): { ok: false; error: { code: string; message: string } } {
  const message = err instanceof Error ? err.message : String(err);
  const code = err instanceof Error && 'code' in err ? (err as Error & { code: string }).code : 'UNKNOWN';
  return { ok: false, error: { code, message } };
}

export function registerNewsIpc(
  newsFetcher: NewsDataFetcher,
  rateLimiter: TokenBucketRateLimiter,
  aiService: NewsAIService,
): void {

  // ── Single ticker: cache-first, with AI synthesis ─────────────────────────
  ipcMain.handle(
    'news:fetch-ticker',
    async (_e: IpcMainInvokeEvent, ticker: string) => {
      try {
        const today = new Date().toISOString().slice(0, 10);
        const cached = newsFetcher.readCache(ticker, today);
        if (cached) return ok(cached);

        await rateLimiter.acquire(1);
        const signals = await newsFetcher.fetchRawSignals(ticker);
        const result = await buildResultWithAI(ticker, signals, newsFetcher, aiService, today);
        newsFetcher.writeCache(result);
        return ok(result);
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ── Single ticker: force refresh ─────────────────────────────────────────
  ipcMain.handle(
    'news:refresh-ticker',
    async (_e: IpcMainInvokeEvent, ticker: string) => {
      try {
        await rateLimiter.acquire(1);
        const signals = await newsFetcher.fetchRawSignals(ticker);
        const today = new Date().toISOString().slice(0, 10);
        const result = await buildResultWithAI(ticker, signals, newsFetcher, aiService, today);
        newsFetcher.writeCache(result);
        return ok(result);
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ── Read cache only (no fetch) ────────────────────────────────────────────
  ipcMain.handle(
    'news:get-cached',
    (_e: IpcMainInvokeEvent, ticker: string) => {
      try {
        const today = new Date().toISOString().slice(0, 10);
        return ok(newsFetcher.readCache(ticker, today));
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ── Batch run for a watchlist ─────────────────────────────────────────────
  // Phase 1 (fetch): collects raw signals for all tickers, emitting per-ticker progress.
  // Phase 2 (synthesis): one Claude call for all uncached tickers — cross-ticker ranking.
  // Returns all results sorted by impactScore desc.
  ipcMain.handle(
    'news:fetch-watchlist',
    async (e: IpcMainInvokeEvent, tickers: string[], forceRefresh = false) => {
      try {
        const today = new Date().toISOString().slice(0, 10);
        const total = tickers.length;

        // ── Phase 1: collect raw signals ──────────────────────────────────
        const cachedResults = new Map<string, NewsResearchResult>();
        const freshSignals = new Map<string, RawSignals>(); // tickers needing AI
        let done = 0;

        for (const ticker of tickers) {
          if (!forceRefresh) {
            const cached = newsFetcher.readCache(ticker, today);
            if (cached) {
              cachedResults.set(ticker, cached);
              done++;
              e.sender.send('news:batch-progress', { done, total, ticker, phase: 'fetch' });
              continue;
            }
          }

          try {
            await rateLimiter.acquire(1);
            const signals = await newsFetcher.fetchRawSignals(ticker);
            freshSignals.set(ticker, signals);
          } catch {
            // On error, store a rule-based skeleton so the ticker still shows up.
            const skeleton = newsFetcher.buildSkeletonResult(ticker, today);
            cachedResults.set(ticker, skeleton);
          }

          done++;
          e.sender.send('news:batch-progress', { done, total, ticker, phase: 'fetch' });
        }

        // ── Phase 2: batch AI synthesis for freshly-fetched tickers ──────
        const aiResults = new Map<string, NewsResearchResult>();

        if (freshSignals.size > 0) {
          // Signal synthesis phase start.
          e.sender.send('news:batch-progress', {
            done: total,
            total,
            ticker: '__synthesis__',
            phase: 'synthesis',
          });

          const batchItems = Array.from(freshSignals.entries()).map(([ticker, signals]) => ({
            ticker,
            signals,
          }));

          // One AI call for all fresh tickers.
          const aiMap = await aiService.synthesizeBatch(batchItems);

          for (const [ticker, signals] of freshSignals) {
            const aiResult = aiMap.get(ticker) ?? null;
            const result = buildResultFromSignals(ticker, signals, aiResult, newsFetcher, today);
            newsFetcher.writeCache(result);
            aiResults.set(ticker, result);
          }
        }

        // ── Merge and sort ────────────────────────────────────────────────
        const allResults: NewsResearchResult[] = [];
        for (const ticker of tickers) {
          allResults.push(
            aiResults.get(ticker) ??
            cachedResults.get(ticker) ??
            newsFetcher.buildSkeletonResult(ticker, today)
          );
        }

        // Sort by impact score desc; tickers with no score go last.
        allResults.sort((a, b) => (b.impactScore ?? -1) - (a.impactScore ?? -1));

        return ok(allResults);
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ── Macro events ──────────────────────────────────────────────────────────
  ipcMain.handle(
    'news:get-macro-events',
    (_e: IpcMainInvokeEvent, daysAhead = 60) => {
      try {
        const events: MacroEvent[] = newsFetcher.getMacroEvents(daysAhead);
        return ok(events);
      } catch (err) {
        return fail(err);
      }
    }
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a NewsResearchResult for a single ticker, using AI if available, else rule-based. */
async function buildResultWithAI(
  ticker: string,
  signals: RawSignals,
  newsFetcher: NewsDataFetcher,
  aiService: NewsAIService,
  today: string,
): Promise<NewsResearchResult> {
  const aiResult = await aiService.synthesizeTicker(ticker, signals);
  return buildResultFromSignals(ticker, signals, aiResult, newsFetcher, today);
}

import type { AiTickerResult } from '../services/news-ai-service.js';

function buildResultFromSignals(
  ticker: string,
  signals: RawSignals,
  aiResult: AiTickerResult | null,
  newsFetcher: NewsDataFetcher,
  today: string,
): NewsResearchResult {
  // Derive rule-based values as fallback.
  const ruleInsights = newsFetcher.deriveInsights(ticker, signals);

  return {
    ticker,
    cacheDate: today,
    impactScore: aiResult?.impactScore ?? ruleInsights.impactScore,
    bias:        aiResult?.bias        ?? ruleInsights.bias,
    keyFactors:  aiResult?.keyFactors  ?? ruleInsights.keyFactors,
    summary:     aiResult?.summary     ?? ruleInsights.summary,
    portfolioNote: null,
    events:      ruleInsights.events,
    news:        signals.newsHeadlines,
    rawSignals:  signals,
    aiModel:     aiResult?.model ?? null,
    updatedAt:   new Date().toISOString(),
  };
}
