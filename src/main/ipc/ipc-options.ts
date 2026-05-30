// IPC handlers for the Options Chain view.
// Provides near-term expiration discovery and full chain fetching.

import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { OptionsProvider } from '../services/options-provider.js';
import type { QuoteCache } from '../services/cache-service.js';
import type { TokenBucketRateLimiter } from '../services/rate-limiter.js';

interface ExpirationSummary {
  date: string;
  dte: number;
  callCount: number;
  putCount: number;
}

function isMarketHoliday(d: Date): boolean {
  const m = d.getMonth() + 1, day = d.getDate(), dow = d.getDay();
  const fixedHolidays: [number, number][] = [[1,1],[6,19],[7,4],[12,25]];
  for (const [hm, hd] of fixedHolidays) {
    if (m === hm) {
      if (day === hd - 1 && dow === 5) return true; // observed Friday
      if (day === hd && dow >= 1 && dow <= 5) return true;
      if (day === hd + 1 && dow === 1) return true; // observed Monday
    }
  }
  if (m === 1 && dow === 1 && day >= 15 && day <= 21) return true; // MLK
  if (m === 2 && dow === 1 && day >= 15 && day <= 21) return true; // Presidents Day
  if (m === 5 && dow === 1 && day >= 25) return true;              // Memorial Day
  if (m === 9 && dow === 1 && day <= 7) return true;               // Labor Day
  if (m === 11 && dow === 4 && day >= 22 && day <= 28) return true; // Thanksgiving
  return false;
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
  optionsProvider: OptionsProvider,
  quoteCache: QuoteCache,
  rateLimiter: TokenBucketRateLimiter,
  onChainFetched?: (ticker: string, contracts: import('@shared/types.js').OptionContract[], underlyingPx: number | null) => void,
): void {
  // Fetch near-term expirations with contract counts.
  ipcMain.handle(
    'options:get-near-expirations',
    async (_e: IpcMainInvokeEvent, ticker: string) => {
      try {
        // Try to get real expirations from the provider (E*Trade supports this).
        // Fall back to generating next 8 Fridays when the provider returns [] (Polygon).
        let expirations: string[] = await optionsProvider.getOptionsExpirations(ticker);
        if (expirations.length === 0) {
          expirations = generateNextFridays(8);
        } else {
          // Limit to nearest 12 to avoid overloading the UI.
          expirations = expirations.slice(0, 12);
        }

        // Fetch current price and IV.
        const cachedQuote = quoteCache.get(ticker);
        const currentPrice = cachedQuote?.last ?? null;
        let currentIv: number | null = cachedQuote?.currentIv ?? null;
        if (currentIv === null) {
          try {
            const ivData = await optionsProvider.getOptionsIV(ticker);
            currentIv = ivData.currentIv;
          } catch { /* IV unavailable */ }
        }

        // Fetch chain metadata for each expiration.
        const summaries: ExpirationSummary[] = [];
        for (const exp of expirations) {
          try {
            await rateLimiter.acquire(1);
            const chain = await optionsProvider.getOptionsChain(ticker, exp);
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
        const chain = await optionsProvider.getOptionsChain(ticker, expiration);

        const cachedQuote = quoteCache.get(ticker);
        const currentPrice = cachedQuote?.last ?? null;
        let currentIv: number | null = cachedQuote?.currentIv ?? null;
        if (currentIv === null) {
          try {
            const ivData = await optionsProvider.getOptionsIV(ticker);
            currentIv = ivData.currentIv;
          } catch { /* IV unavailable */ }
        }

        onChainFetched?.(chain.ticker, chain.contracts, currentPrice);

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

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Generate the next N standard weekly expiration Fridays, shifting holidays to Thursday. */
function generateNextFridays(count: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  const now = new Date();
  const day = now.getDay();
  const daysUntilFriday = day <= 5 ? (5 - day) : (12 - day);
  const firstFriday = new Date(now);
  firstFriday.setDate(now.getDate() + daysUntilFriday);
  for (let w = 0; result.length < count; w++) {
    const d = new Date(firstFriday);
    d.setDate(firstFriday.getDate() + w * 7);
    if (isMarketHoliday(d)) d.setDate(d.getDate() - 1); // use Thursday
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const key = `${yyyy}-${mm}-${dd}`;
    if (!seen.has(key)) { seen.add(key); result.push(key); }
  }
  return result;
}