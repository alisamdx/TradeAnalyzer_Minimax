// IPC handlers for the Options Chain view.
// Provides near-term expiration discovery and full chain fetching.

import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { DataProvider } from '../services/data-provider.js';
import type { QuoteCache } from '../services/cache-service.js';
import type { TokenBucketRateLimiter } from '../services/rate-limiter.js';

interface ExpirationSummary {
  date: string;
  dte: number;
  callCount: number;
  putCount: number;
}

function dteDays(expirationDate: string): number {
  const exp = new Date(expirationDate + 'T00:00:00Z');
  const now = new Date();
  return Math.max(0, Math.round((exp.getTime() - now.getTime()) / 86_400_000));
}

function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}
function fail(err: unknown): { ok: false; error: { code: string; message: string } } {
  const message = err instanceof Error ? err.message : String(err);
  const code = err instanceof Error && 'code' in err ? (err as Error & { code: string }).code : 'UNKNOWN';
  return { ok: false, error: { code, message } };
}

export function registerOptionsIpc(
  dataProvider: DataProvider,
  quoteCache: QuoteCache,
  rateLimiter: TokenBucketRateLimiter
): void {
  // Fetch near-term expirations with contract counts.
  ipcMain.handle(
    'options:get-near-expirations',
    async (_e: IpcMainInvokeEvent, ticker: string) => {
      try {
        // Generate next 5 Fridays.
        const expirations: string[] = [];
        const now = new Date();
        const day = now.getDay(); // Use local time consistently
        // If today is Friday (day=5), include today. Otherwise find next Friday.
        const daysUntilFriday = day <= 5 ? (5 - day) : (12 - day);
        const firstFriday = new Date(now);
        firstFriday.setDate(now.getDate() + daysUntilFriday);
        for (let w = 0; w < 5; w++) {
          const d = new Date(firstFriday);
          d.setDate(firstFriday.getDate() + w * 7);
          // Format as YYYY-MM-DD in local time
          const yyyy = d.getFullYear();
          const mm = String(d.getMonth() + 1).padStart(2, '0');
          const dd = String(d.getDate()).padStart(2, '0');
          expirations.push(`${yyyy}-${mm}-${dd}`);
        }

        // Fetch current price and IV.
        const cachedQuote = quoteCache.get(ticker);
        const currentPrice = cachedQuote?.last ?? null;
        let currentIv: number | null = cachedQuote?.currentIv ?? null;
        if (currentIv === null) {
          try {
            const ivData = await dataProvider.getOptionsIV(ticker);
            currentIv = ivData.currentIv;
          } catch { /* IV unavailable */ }
        }

        // Fetch chain metadata for each expiration.
        const summaries: ExpirationSummary[] = [];
        for (const exp of expirations) {
          try {
            await rateLimiter.acquire(1);
            const chain = await dataProvider.getOptionsChain(ticker, exp);
            const dte = dteDays(exp);
            const callCount = chain.contracts.filter(c => c.side === 'call').length;
            const putCount = chain.contracts.filter(c => c.side === 'put').length;
            summaries.push({ date: exp, dte, callCount, putCount });
          } catch {
            // Skip this expiration if it fails (e.g. no contracts).
            summaries.push({ date: exp, dte: dteDays(exp), callCount: 0, putCount: 0 });
          }
        }

        return ok({ expirations: summaries, currentPrice, currentIv });
      } catch (err) {
        return fail(err);
      }
    }
  );

  // Fetch full options chain for a ticker + expiration.
  ipcMain.handle(
    'options:get-chain',
    async (_e: IpcMainInvokeEvent, ticker: string, expiration: string) => {
      try {
        await rateLimiter.acquire(1);
        const chain = await dataProvider.getOptionsChain(ticker, expiration);

        const cachedQuote = quoteCache.get(ticker);
        const currentPrice = cachedQuote?.last ?? null;
        let currentIv: number | null = cachedQuote?.currentIv ?? null;
        if (currentIv === null) {
          try {
            const ivData = await dataProvider.getOptionsIV(ticker);
            currentIv = ivData.currentIv;
          } catch { /* IV unavailable */ }
        }

        return ok({
          ticker: chain.ticker,
          expiration: chain.expiration,
          contracts: chain.contracts,
          currentPrice,
          currentIv
        });
      } catch (err) {
        return fail(err);
      }
    }
  );
}