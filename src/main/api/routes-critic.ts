// POST /critic/evaluate — Phase 2a: AI Critic gate for the external TraderAgent.
// The Agent calls this in its decide phase before entering a trade. If verdict is
// "flag", the Agent blocks entry. "caution" adds a warning to the rationale.
// Uses the same CriticService as the Daily Brief (Stage 5b).

import type { FastifyInstance } from 'fastify';
import type { ApiServerServices } from '../api-server.js';
import type { BriefPick, SignalBreakdown, ScoringConfig, ScoringStrategy } from '@shared/types.js';
import { apiOk, apiError, fromServiceError } from './helpers.js';
import { secureGet } from '../services/secure-settings.js';

interface CriticEvalBody {
  ticker:             string;
  strategy:           string;
  compositeScore?:    number;
  signals?:           Record<string, { raw: number | null; normalized: number; weight: number; missing: boolean }>;
  price?:             number | null;
  aiRationale?:       string | null;
  strategyLabResult?: object | null;
  // Cross-strategy conflict check: map of strategy → tickers currently selected in the same run
  allPicksByStrategy?: Record<string, string[]>;
}

const VALID_STRATEGIES = new Set(['wheel', 'bullish', 'bearish', 'income', 'buy']);

export function registerCriticRoutes(app: FastifyInstance, svc: ApiServerServices): void {
  // POST /critic/evaluate
  // Returns a CriticVerdict for the given candidate pick.
  app.post<{ Body: CriticEvalBody }>(
    '/critic/evaluate',
    async (req, reply) => {
      const body = req.body;
      if (!body?.ticker || typeof body.ticker !== 'string') {
        return apiError(reply, 'ticker is required', 'VALIDATION_ERROR');
      }
      if (!body.strategy || !VALID_STRATEGIES.has(body.strategy)) {
        return apiError(reply, `strategy must be one of: ${[...VALID_STRATEGIES].join(', ')}`, 'VALIDATION_ERROR');
      }

      const ticker = body.ticker.toUpperCase();
      const strategy = body.strategy as ScoringStrategy;

      try {
        // Build a minimal BriefPick from the agent payload
        const signals: Record<string, SignalBreakdown> = {};
        if (body.signals && typeof body.signals === 'object') {
          for (const [key, val] of Object.entries(body.signals)) {
            signals[key] = {
              raw:        val.raw ?? null,
              normalized: val.normalized ?? 0,
              weight:     val.weight ?? 0,
              missing:    val.missing ?? false,
            };
          }
        }

        const pick: BriefPick = {
          ticker,
          compositeScore:    body.compositeScore ?? 0,
          signals,
          price:             body.price ?? null,
          aiRationale:       body.aiRationale ?? null,
          strategyLabResult: body.strategyLabResult ?? null,
          rank:              1,
          validated:         body.strategyLabResult != null,
        };

        // Build cross-strategy map for conflict check
        const allPicksByStrategy = new Map<string, BriefPick[]>();
        if (body.allPicksByStrategy && typeof body.allPicksByStrategy === 'object') {
          for (const [strat, tickers] of Object.entries(body.allPicksByStrategy)) {
            if (Array.isArray(tickers)) {
              allPicksByStrategy.set(strat, tickers.map(t => ({
                ticker: String(t).toUpperCase(), compositeScore: 0, signals: {}, price: null, aiRationale: null, rank: 1, validated: false,
              })));
            }
          }
        }
        // Include this pick itself in the map
        if (!allPicksByStrategy.has(strategy)) allPicksByStrategy.set(strategy, []);
        allPicksByStrategy.get(strategy)!.push(pick);

        // Load strategy config for critical-signal-missing check
        let strategyConfig: ScoringConfig | null = null;
        try {
          strategyConfig = svc.scoringService.getConfig(strategy);
        } catch { /* non-fatal — critic runs without config */ }

        // Market context (VIX + SPY 200MA)
        const market = svc.criticService.getMarketContext();

        // Rule-based pre-checks
        const flags = strategyConfig
          ? svc.criticService.runRuleChecks(pick, strategy, strategyConfig, allPicksByStrategy, market)
          : svc.criticService.runRuleChecks(pick, strategy, { strategy, signals: [], version: '', updatedAt: '' }, allPicksByStrategy, market);

        // LLM synthesis (if API key available)
        const apiKey = secureGet(svc.db, 'anthropicApiKey') ?? '';
        const verdict = apiKey
          ? await svc.criticService.synthesizeVerdict(pick, strategy, flags, apiKey, market)
          : {
              verdict: (flags.some(f => f.severity === 'warning') ? 'flag' : flags.length > 0 ? 'caution' : 'pass') as 'pass' | 'caution' | 'flag',
              confidence: 'low' as const,
              flags,
              rationale: null,
              generatedAt: new Date().toISOString(),
            };

        return apiOk(reply, verdict);
      } catch (err) {
        const { message, code } = fromServiceError(err);
        return apiError(reply, message, code, 500);
      }
    }
  );
}
