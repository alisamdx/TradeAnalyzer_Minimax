// IPC handlers for the News & Research module.
// See Requirements/news-research.md — FR-NR-37.

import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { NewsDataFetcher } from '../services/news-data-fetcher.js';
import type { TokenBucketRateLimiter } from '../services/rate-limiter.js';
import type { NewsResearchResult, MacroEvent } from '@shared/types.js';

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
): void {

  // ── Single ticker: cache-first ────────────────────────────────────────────
  ipcMain.handle(
    'news:fetch-ticker',
    async (_e: IpcMainInvokeEvent, ticker: string) => {
      try {
        const today = new Date().toISOString().slice(0, 10);
        const cached = newsFetcher.readCache(ticker, today);
        if (cached) return ok(cached);

        await rateLimiter.acquire(1);
        const result = await newsFetcher.buildResult(ticker);
        newsFetcher.writeCache(result);
        return ok(result);
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ── Single ticker: force refresh ──────────────────────────────────────────
  ipcMain.handle(
    'news:refresh-ticker',
    async (_e: IpcMainInvokeEvent, ticker: string) => {
      try {
        await rateLimiter.acquire(1);
        const result = await newsFetcher.buildResult(ticker);
        newsFetcher.writeCache(result);
        return ok(result);
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ── Read from cache only (no fetch) ──────────────────────────────────────
  ipcMain.handle(
    'news:get-cached',
    (_e: IpcMainInvokeEvent, ticker: string) => {
      try {
        const today = new Date().toISOString().slice(0, 10);
        const result = newsFetcher.readCache(ticker, today);
        return ok(result);
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ── Batch run for a watchlist (tickers array) ─────────────────────────────
  // Emits 'news:batch-progress' events as each ticker completes.
  // Returns all results sorted by impactScore desc.
  ipcMain.handle(
    'news:fetch-watchlist',
    async (e: IpcMainInvokeEvent, tickers: string[], forceRefresh = false) => {
      try {
        const results: NewsResearchResult[] = [];
        const today = new Date().toISOString().slice(0, 10);
        let done = 0;
        const total = tickers.length;

        for (const ticker of tickers) {
          // Check cache first (unless forced).
          if (!forceRefresh) {
            const cached = newsFetcher.readCache(ticker, today);
            if (cached) {
              results.push(cached);
              done++;
              e.sender.send('news:batch-progress', { done, total, ticker });
              continue;
            }
          }

          try {
            await rateLimiter.acquire(1);
            const result = await newsFetcher.buildResult(ticker);
            newsFetcher.writeCache(result);
            results.push(result);
          } catch {
            // Push skeleton on error — don't abort the batch.
            results.push({
              ticker,
              cacheDate: today,
              impactScore: null,
              bias: null,
              keyFactors: [],
              summary: null,
              portfolioNote: null,
              events: [],
              news: [],
              rawSignals: { earnings: null, analystRatings: [], insiderTransactions: [], shortInterest: null, macroEvents: [], newsHeadlines: [] },
              aiModel: null,
              updatedAt: new Date().toISOString(),
            });
          }

          done++;
          e.sender.send('news:batch-progress', { done, total, ticker });
        }

        // Sort by impact score descending.
        results.sort((a, b) => (b.impactScore ?? -1) - (a.impactScore ?? -1));
        return ok(results);
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ── Macro events (next N days) ────────────────────────────────────────────
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
