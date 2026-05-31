// IPC handlers for Strategy Lab — scores all 31 strategies for a single ticker
// using entirely fresh data (bars + live chain + iv_history).
// see SPEC: FR-strategy-lab

import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { Database } from 'better-sqlite3';
import Anthropic from '@anthropic-ai/sdk';
import { StrategyLabService } from '../services/strategy-lab-service.js';
import type { DataProvider } from '../services/data-provider.js';
import type { OptionsProvider } from '../services/options-provider.js';
import { secureGet } from '../services/secure-settings.js';
import type { IpcResult, StrategyScore, StrategyLabContext } from '@shared/types.js';

function ok<T>(value: T): IpcResult<T> {
  return { ok: true, value };
}

function fail(err: unknown): IpcResult<never> {
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, error: { code: 'STRATEGY_LAB_ERROR', message } };
}

function wrapAsync<Args extends unknown[], R>(fn: (...args: Args) => Promise<R>) {
  return async (_e: IpcMainInvokeEvent, ...args: Args): Promise<IpcResult<R>> => {
    try {
      return ok(await fn(...args));
    } catch (err) {
      return fail(err);
    }
  };
}

export function registerStrategyLabIpc(
  db: Database,
  dataProvider: DataProvider,
  optionsProvider: OptionsProvider,
): void {
  const service = new StrategyLabService(dataProvider, optionsProvider);

  // Validate — score all 31 strategies for a ticker with fresh live data
  ipcMain.handle(
    'strategyLab:validate',
    wrapAsync((ticker: string) => service.validate(db, ticker)),
  );

  // Explore — build the concrete setup for a single strategy
  ipcMain.handle(
    'strategyLab:explore',
    wrapAsync((ticker: string, slug: string) => service.explore(db, ticker, slug)),
  );

  // AI Rationale — call Claude with context + score, return 2–3 sentence rationale
  // Uses haiku (cheap ~$0.003–0.005/call) to keep cost per click low.
  ipcMain.handle(
    'strategyLab:aiRationale',
    wrapAsync(async (score: StrategyScore, ctx: StrategyLabContext): Promise<string> => {
      const apiKey = secureGet(db, 'anthropicApiKey');
      if (!apiKey) throw new Error('Anthropic API key not set. Add it in Settings → AI Advisor.');

      const client = new Anthropic({ apiKey });

      const setupSummary = score.setup && !score.setup.unavailableReason
        ? `Net ${score.setup.netCredit != null ? `credit $${score.setup.netCredit.toFixed(0)}` : `debit $${score.setup.netDebit?.toFixed(0) ?? '?'}`}, `
          + `max profit ${score.setup.maxProfit != null ? `$${score.setup.maxProfit.toFixed(0)}` : 'unlimited'}, `
          + `max loss ${score.setup.maxLoss != null ? `$${Math.abs(score.setup.maxLoss).toFixed(0)}` : 'unlimited'}, `
          + `annualized return ${score.setup.annualizedReturn != null ? `${score.setup.annualizedReturn.toFixed(1)}%` : 'N/A'}, `
          + `PoP ${score.setup.popEstimate != null ? `${score.setup.popEstimate.toFixed(0)}%` : 'N/A'}`
        : score.setup?.unavailableReason ?? 'setup unavailable';

      const prompt = `You are a concise options trading analyst. Provide a 2–3 sentence rationale for why this strategy is or isn't a good fit right now. Be specific about the numbers. Do NOT use markdown.

Ticker: ${ctx.ticker}
Underlying: $${ctx.underlyingPx.toFixed(2)}
DTE: ${ctx.dte} days (${ctx.expiration})
IV Rank: ${ctx.ivRank != null ? `${ctx.ivRank.toFixed(0)}%` : 'N/A'} (${ctx.ivDataPoints} data points)
ATM IV: ${ctx.currentAtmIv.toFixed(1)}%
Direction Bias: ${ctx.directionBias} (MA20=${ctx.ma20?.toFixed(2) ?? 'N/A'}, MA50=${ctx.ma50?.toFixed(2) ?? 'N/A'})
Strategy: ${score.name} (${score.category})
Score: ${score.totalScore}/100 — Grade ${score.grade}
Setup: ${setupSummary}
Scoring notes: ${score.flags.join(' | ')}`;

      const msg = await client.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }],
      });

      const text = msg.content.find(b => b.type === 'text');
      return text?.text ?? 'No rationale returned.';
    }),
  );
}
