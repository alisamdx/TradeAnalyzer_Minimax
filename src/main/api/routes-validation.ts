import type { FastifyInstance } from 'fastify';
import type { ApiServerServices } from '../api-server.js';
import { apiOk, apiError, fromServiceError } from './helpers.js';

export function registerValidationRoutes(app: FastifyInstance, svc: ApiServerServices): void {
  // GET /validate/:ticker?refresh=true
  app.get<{ Params: { ticker: string }; Querystring: { refresh?: string } }>(
    '/validate/:ticker',
    async (req, reply) => {
      const ticker = req.params.ticker.toUpperCase();
      if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(ticker)) {
        return apiError(reply, 'Invalid ticker symbol', 'VALIDATION_ERROR');
      }

      try {
        const result = await svc.validateAllService.validateTicker(ticker);
        return apiOk(reply, {
          ticker: result.ticker,
          fetchedAt: result.fetchedAt,
          fromCache: false,
          fundamentals: result.fundamentals,
          marketOpinion: result.marketOpinion,
          trend: result.trend,
          technicals: {
            rsi: result.indicators.rsi,
            macdSignal: result.indicators.macdSignal,
            macdValue: result.indicators.macdValue,
            bollingerPosition: result.indicators.bollingerPosition,
            volumeAnomalyPct: result.indicators.volumeAnomalyPct,
            currentIv: result.ivData.currentIv,
            iv52WkHigh: result.ivData.iv52WkHigh,
            iv52WkLow: result.ivData.iv52WkLow,
            ivRank: result.ivData.ivRank,
            ivPercentile: result.ivData.ivPercentile
          },
          chart: result.chart,
          verdict: result.verdict,
          verdictReason: result.verdictReason,
          companyName: result.companyName
        });
      } catch (err) {
        const { message, code } = fromServiceError(err);
        return apiError(reply, message, code, 500);
      }
    }
  );
}
