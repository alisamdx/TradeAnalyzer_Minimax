import type { FastifyInstance } from 'fastify';
import type { ApiServerServices } from '../api-server.js';
import { apiOk, apiError, fromServiceError } from './helpers.js';

function dteDays(expiration: string): number {
  const exp = new Date(expiration + 'T00:00:00Z');
  return Math.max(0, Math.round((exp.getTime() - Date.now()) / 86_400_000));
}

function nextFridays(count: number): string[] {
  const results: string[] = [];
  const now = new Date();
  const day = now.getDay();
  const daysUntilFriday = day <= 5 ? 5 - day : 6;
  const first = new Date(now);
  first.setDate(now.getDate() + (daysUntilFriday === 0 ? 7 : daysUntilFriday));
  for (let w = 0; w < count; w++) {
    const d = new Date(first);
    d.setDate(first.getDate() + w * 7);
    results.push(d.toISOString().slice(0, 10));
  }
  return results;
}

export function registerOptionsRoutes(app: FastifyInstance, svc: ApiServerServices): void {
  app.get<{
    Params: { ticker: string };
    Querystring: {
      expiration?: string;
      minDTE?: string;
      maxDTE?: string;
      minDelta?: string;
      maxDelta?: string;
    };
  }>('/options/:ticker', async (req, reply) => {
    const ticker = req.params.ticker.toUpperCase();
    if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(ticker)) {
      return apiError(reply, 'Invalid ticker symbol', 'VALIDATION_ERROR');
    }

    const q = req.query;
    const minDTE = q.minDTE !== undefined ? Number(q.minDTE) : undefined;
    const maxDTE = q.maxDTE !== undefined ? Number(q.maxDTE) : undefined;
    const minDelta = q.minDelta !== undefined ? Number(q.minDelta) : undefined;
    const maxDelta = q.maxDelta !== undefined ? Number(q.maxDelta) : undefined;

    // Determine which expiration(s) to fetch
    const expirations = q.expiration ? [q.expiration] : nextFridays(8);

    try {
      const allContracts: unknown[] = [];

      for (const exp of expirations) {
        const dte = dteDays(exp);

        // Skip if DTE filter doesn't match
        if (minDTE !== undefined && dte < minDTE) continue;
        if (maxDTE !== undefined && dte > maxDTE) continue;

        let chain;
        try {
          chain = await svc.dataProvider.getOptionsChain(ticker, exp);
        } catch {
          continue; // skip expirations that fail (no data)
        }

        for (const c of chain.contracts) {
          const delta = c.delta !== null ? Math.abs(c.delta) : null;
          if (minDelta !== undefined && (delta === null || delta < minDelta)) continue;
          if (maxDelta !== undefined && (delta === null || delta > maxDelta)) continue;

          const mid = (c.bid + c.ask) / 2;
          const bidAskSpreadPct = mid > 0 ? (c.ask - c.bid) / mid : 0;

          allContracts.push({
            ticker: c.ticker,
            strike: c.strike,
            expiration: c.expiration,
            dte,
            type: c.side,
            bid: c.bid,
            ask: c.ask,
            mid,
            delta: c.delta,
            gamma: c.gamma,
            theta: c.theta,
            vega: c.vega,
            iv: c.iv,
            openInterest: c.openInterest,
            volume: c.volume,
            bidAskSpreadPct
          });
        }
      }

      return apiOk(reply, allContracts);
    } catch (err) {
      const { message, code } = fromServiceError(err);
      return apiError(reply, message, code, 500);
    }
  });
}
