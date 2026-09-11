// GET /strategy-lab/:ticker — Phase 2b/2c: exposes Strategy Lab to the external TraderAgent.
// The Agent's decide phase calls this to pick the best structure instead of always defaulting
// to CSP (wheel) or CC. Returns full scored list + per-category recommendations.

import type { FastifyInstance } from 'fastify';
import type { ApiServerServices } from '../api-server.js';
import type { StrategyScore } from '@shared/types.js';
import { apiOk, apiError, fromServiceError } from './helpers.js';

// Broad category groupings so the Agent can pick based on regime / direction.
const CATEGORY_GROUPS: Record<string, string[]> = {
  income:  ['neutral', 'omnidirectional'],
  bullish: ['bullish', 'neutral-bullish'],
  bearish: ['bearish', 'neutral-bearish'],
};

function bestInGroup(scores: StrategyScore[], categories: string[]): StrategyScore | null {
  return scores
    .filter(s => categories.some(c => s.category === c) && !s.requiresStock && s.totalScore > 0)
    .sort((a, b) => b.totalScore - a.totalScore)[0] ?? null;
}

export function registerStrategyLabRoutes(app: FastifyInstance, svc: ApiServerServices): void {
  // GET /strategy-lab/:ticker
  // Optional query: ?excludeStock=true (skip strategies that require stock ownership)
  app.get<{
    Params: { ticker: string };
    Querystring: { excludeStock?: string };
  }>(
    '/strategy-lab/:ticker',
    async (req, reply) => {
      const ticker = req.params.ticker.toUpperCase();
      if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(ticker)) {
        return apiError(reply, 'Invalid ticker symbol', 'VALIDATION_ERROR');
      }
      const excludeStock = req.query.excludeStock === 'true' || req.query.excludeStock === '1';

      try {
        const result = await svc.strategyLabService.validate(svc.db, ticker);

        const scores = excludeStock
          ? result.scores.filter(s => !s.requiresStock)
          : result.scores;

        // Per-category best picks (no-stock only — more useful for the Agent)
        const noStockScores = result.scores.filter(s => !s.requiresStock);
        const recommendation = {
          bestOverall: noStockScores[0] ?? null,
          bestIncome:  bestInGroup(result.scores, CATEGORY_GROUPS['income'] ?? []),
          bestBullish: bestInGroup(result.scores, CATEGORY_GROUPS['bullish'] ?? []),
          bestBearish: bestInGroup(result.scores, CATEGORY_GROUPS['bearish'] ?? []),
        };

        return apiOk(reply, {
          ticker,
          context:        result.context,
          scores,
          recommendation,
        });
      } catch (err) {
        const { message, code } = fromServiceError(err);
        // 503 for external API failures (options chain unavailable, etc.)
        const status = message.toLowerCase().includes('no suitable expiration') || message.toLowerCase().includes('empty options chain') ? 503 : 500;
        return apiError(reply, message, code, status);
      }
    }
  );
}
