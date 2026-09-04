// IPC handlers for portfolio tracking
// Exposes position management and P&L calculations to renderer
// see SPEC: Priority 6 - Portfolio Tracking
// v0.16.0: E*Trade sync, position analysis, AI advisor (Phase 1–3)

import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { Database } from 'better-sqlite3';
import { PortfolioService, type PositionInput, type PositionUpdate, type PositionCloseInput } from '../services/portfolio-service.js';
import { EtradePortfolioService } from '../services/etrade-portfolio-service.js';
import { PositionAnalysisService } from '../services/position-analysis-service.js';
import { AiAdvisorService } from '../services/ai-advisor-service.js';
import type { AnalysisService } from '../services/analysis-service.js';
import type { OptionsProvider } from '../services/options-provider.js';
import {
  portfolioEfficiency, positionRoc,
  type PositionLike, type PortfolioEfficiency, type PositionRoc,
} from '../services/capital-efficiency.js';
import { secureGet, secureSet } from '../services/secure-settings.js';
import { toPositionSignedGreeks } from '@shared/position-greeks.js';
import { getCapitalUtilisation } from '../services/capital-utilisation.js';
import type { IpcResult, EtradeAccount, EtradeSyncResult, PositionAnalysis, PositionEtrade, AdvisorSession, AdvisorProgressEvent } from '@shared/types.js';

export interface PositionDto {
  id: number;
  ticker: string;
  positionType: 'CSP' | 'CC' | 'Stock' | 'Long Put' | 'Long Call';
  quantity: number;
  entryPrice: number;
  entryDate: string;
  entryNotes: string | null;
  exitPrice: number | null;
  exitDate: string | null;
  exitNotes: string | null;
  strikePrice: number | null;
  expirationDate: string | null;
  premiumReceived: number | null;
  currentPrice: number | null;
  unrealizedPnl: number | null;
  realizedPnl: number | null;
  status: 'open' | 'closed';
  createdAt: string;
  updatedAt: string;
}

export interface PositionWithMetricsDto extends PositionDto {
  capitalRequired: number;
  daysHeld: number | null;
  returnPct: number | null;
  annualizedReturn: number | null;
}

export interface PnLSummaryDto {
  totalPositions: number;
  openPositions: number;
  closedPositions: number;
  totalUnrealizedPnl: number;
  totalRealizedPnl: number;
  totalCapitalDeployed: number;
  winRate: number;
  averageReturnPct: number;
}

function ok<T>(value: T): IpcResult<T> {
  return { ok: true, value };
}

function fail(err: unknown): IpcResult<never> {
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, error: { code: 'PORTFOLIO_ERROR', message } };
}

function wrap<Args extends unknown[], R>(fn: (...args: Args) => R) {
  return (_e: IpcMainInvokeEvent, ...args: Args): IpcResult<R> => {
    try {
      return ok(fn(...args));
    } catch (err) {
      return fail(err);
    }
  };
}

export function registerPortfolioIpc(db: Database, analysisService?: AnalysisService, optionsProvider?: OptionsProvider): void {
  const service          = new PortfolioService(db);
  const etradePortfolio  = new EtradePortfolioService();
  const positionAnalysis = analysisService ? new PositionAnalysisService(analysisService) : null;
  const aiAdvisor        = new AiAdvisorService();

  // ─── CRUD Operations ────────────────────────────────────────────────────────

  // Capital utilisation — how much is working, how much is idle. Read-only over the latest
  // balance snapshot plus the open book; see capital-utilisation.ts for why available and
  // committed are complementary rather than overlapping.
  ipcMain.handle('portfolio:capital-utilisation', wrap(() =>
    getCapitalUtilisation(db, new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }))
  ));

  ipcMain.handle('portfolio:add', wrap((input: PositionInput) => {
    const position = service.addPosition(input);
    return { success: true, data: position };
  }));

  ipcMain.handle('portfolio:list', wrap((status?: 'open' | 'closed') => {
    const positions = service.listPositions(status);
    return { success: true, data: positions };
  }));

  ipcMain.handle('portfolio:get', wrap((id: number) => {
    const position = service.getById(id);
    return { success: true, data: position };
  }));

  ipcMain.handle('portfolio:getWithMetrics', wrap((id: number) => {
    const position = service.getPositionWithMetrics(id);
    return { success: true, data: position };
  }));

  ipcMain.handle('portfolio:update', wrap((id: number, update: PositionUpdate) => {
    const position = service.updatePosition(id, update);
    return { success: true, data: position };
  }));

  ipcMain.handle('portfolio:close', wrap((id: number, input: PositionCloseInput) => {
    const position = service.closePosition(id, input);
    return { success: true, data: position };
  }));

  ipcMain.handle('portfolio:delete', wrap((id: number) => {
    service.deletePosition(id);
    return { success: true };
  }));

  // ─── P&L Operations ───────────────────────────────────────────────────────

  ipcMain.handle('portfolio:pnlSummary', wrap(() => {
    const summary = service.getPnLSummary();
    return { success: true, data: summary };
  }));

  ipcMain.handle('portfolio:updatePrice', wrap((ticker: string, price: number) => {
    service.updatePricesForTicker(ticker, price);
    return { success: true };
  }));

  ipcMain.handle('portfolio:listByTicker', wrap((ticker: string) => {
    const positions = service.listByTicker(ticker);
    return { success: true, data: positions };
  }));

  // ─── Live Greeks fetch (ENH-3) ────────────────────────────────────────────
  // Fetches delta/theta/vega for open CSP/CC positions from the options chain
  // and persists them to the positions table so the portfolio Greeks bar reflects
  // manually entered positions (not just E*Trade-synced ones).

  // Capital efficiency: return on the capital actually at risk, not on the whole account.
  //
  // Measuring a wheel against total portfolio value understates it whenever capital is held
  // back on purpose \u2014 this book realised 3.73% of a ~$79k account but 11.56% of the ~$26k
  // actually deployed. Both are returned so a sizing decision is never read as a strategy
  // result. Pure derivation from `positions`: no sync, no provider call.
  ipcMain.handle('portfolio:capitalEfficiency', async (
    _e: IpcMainInvokeEvent,
  ): Promise<IpcResult<{ portfolio: PortfolioEfficiency; positions: PositionRoc[]; portfolioValue: number | null }>> => {
    try {
      const rows = db.prepare('SELECT * FROM positions').all() as PositionLike[];
      if (rows.length === 0) {
        return ok({
          portfolio: portfolioEfficiency([], [], null),
          positions: [],
          portfolioValue: null,
        });
      }

      // Trading-day calendar from SPY, spanning the book's own life.
      const first = rows.map(r => r.entry_date.slice(0, 10)).sort()[0]!;
      const dates = (db.prepare(
        `SELECT DISTINCT date FROM historical_prices
          WHERE ticker = 'SPY' AND date >= ? ORDER BY date ASC`,
      ).all(first) as Array<{ date: string }>).map(r => r.date);

      // Account value is inferred from any synced row carrying both a market value and its
      // share of the portfolio; the median guards against one stale row skewing it.
      type PctRow = { market_value: number | null; pct_of_portfolio: number | null };
      const implied = (db.prepare(
        `SELECT market_value, pct_of_portfolio FROM positions
          WHERE market_value IS NOT NULL AND pct_of_portfolio IS NOT NULL
            AND pct_of_portfolio <> 0`,
      ).all() as PctRow[])
        .map(r => Math.abs((r.market_value as number) / ((r.pct_of_portfolio as number) / 100)))
        .filter(v => Number.isFinite(v) && v > 0)
        .sort((a, b) => a - b);
      const portfolioValue = implied.length ? implied[Math.floor(implied.length / 2)]! : null;

      return ok({
        portfolio: portfolioEfficiency(rows, dates, portfolioValue),
        positions: rows.map(positionRoc).filter((r): r is PositionRoc => r !== null)
          .sort((a, b) => (b.realizedAnnualPct ?? 0) - (a.realizedAnnualPct ?? 0)),
        portfolioValue,
      });
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle('portfolio:fetchGreeks', async (_e: IpcMainInvokeEvent): Promise<IpcResult<{ updated: number; failed: number; errors: string[] }>> => {
    if (!optionsProvider) {
      return fail(new Error('Options provider not available'));
    }

    const open = service.listPositions('open').filter(p => p.positionType !== 'Stock' && p.strikePrice !== null && p.expirationDate !== null);
    if (open.length === 0) {
      return ok({ updated: 0, failed: 0, errors: [] });
    }

    // Group positions by (ticker, expiry) to fetch one chain per combo
    const groups = new Map<string, typeof open>();
    for (const pos of open) {
      const key = `${pos.ticker}::${pos.expirationDate}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(pos);
    }

    let updated = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const [key, positions] of groups) {
      const [ticker, expiry] = key.split('::') as [string, string];
      try {
        const chain = await optionsProvider.getOptionsChain(ticker, expiry);

        for (const pos of positions) {
          const side = (pos.positionType === 'CSP' || pos.positionType === 'Long Put') ? 'put' : 'call';
          const contract = chain.contracts.find(c =>
            c.side === side && Math.abs(c.strike - (pos.strikePrice ?? 0)) < 0.51
          );

          if (!contract) {
            failed++;
            errors.push(`${pos.ticker} ${side} $${pos.strikePrice} ${expiry}: contract not found in chain`);
            continue;
          }

          // Store POSITION-SIGNED greeks via the shared helper (short CSP/CC negate the raw
          // chain greeks → +theta/−vega) — same convention the E*Trade sync now uses, so the
          // two write paths can't drift (the v1.1.80 bug).
          const { delta, theta, vega } = toPositionSignedGreeks(
            pos.positionType, contract.delta, contract.theta, contract.vega,
          );
          service.updateGreeks(pos.id, delta, theta, vega);
          updated++;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${ticker} ${expiry}: ${msg}`);
        failed += positions.length;
      }
    }

    return ok({ updated, failed, errors });
  });

  // ─── Phase 1: E*Trade Sync ────────────────────────────────────────────────

  ipcMain.handle('portfolio:etrade:listAccounts', async (_e): Promise<IpcResult<EtradeAccount[]>> => {
    try {
      const creds = {
        consumerKey:    secureGet(db, 'etradeConsumerKey'),
        consumerSecret: secureGet(db, 'etradeConsumerSecret'),
        accessToken:    secureGet(db, 'etradeAccessToken'),
        accessSecret:   secureGet(db, 'etradeAccessSecret'),
      };
      const accounts = await etradePortfolio.listAccounts(creds);
      return ok(accounts);
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle('portfolio:etrade:sync', async (_e, accountIdKey?: string): Promise<IpcResult<EtradeSyncResult>> => {
    try {
      const creds = {
        consumerKey:    secureGet(db, 'etradeConsumerKey'),
        consumerSecret: secureGet(db, 'etradeConsumerSecret'),
        accessToken:    secureGet(db, 'etradeAccessToken'),
        accessSecret:   secureGet(db, 'etradeAccessSecret'),
      };
      const result = await etradePortfolio.syncPortfolio(db, creds, accountIdKey);
      return ok(result);
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle('portfolio:etrade:sync-closed', async (_e, accountIdKey?: string): Promise<IpcResult<EtradeSyncResult>> => {
    try {
      const creds = {
        consumerKey:    secureGet(db, 'etradeConsumerKey'),
        consumerSecret: secureGet(db, 'etradeConsumerSecret'),
        accessToken:    secureGet(db, 'etradeAccessToken'),
        accessSecret:   secureGet(db, 'etradeAccessSecret'),
      };
      const result = await etradePortfolio.syncClosedPositions(db, creds, accountIdKey);
      return ok(result);
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle('portfolio:etrade:lastSync', (_e): IpcResult<string | null> => {
    try {
      return ok(etradePortfolio.getLastSyncedAt(db));
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle('portfolio:etrade:listPositions', (_e): IpcResult<PositionEtrade[]> => {
    try {
      const rows = db.prepare(`
        SELECT * FROM positions
        WHERE status = 'open'
        ORDER BY ticker
      `).all() as Record<string, unknown>[];
      const mapped: PositionEtrade[] = rows.map(r => mapPositionEtrade(r));
      return ok(mapped);
    } catch (err) {
      return fail(err);
    }
  });

  // ─── Phase 2: Per-Position Analysis ──────────────────────────────────────

  ipcMain.handle('portfolio:analysis:run', async (_e, positionId: number): Promise<IpcResult<PositionAnalysis>> => {
    if (!positionAnalysis) {
      return fail(new Error('Analysis service not available'));
    }
    try {
      const result = await positionAnalysis.analyzePosition(db, positionId);
      return ok(result);
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle('portfolio:analysis:runAll', async (_e): Promise<IpcResult<PositionAnalysis[]>> => {
    if (!positionAnalysis) {
      return fail(new Error('Analysis service not available'));
    }
    try {
      const results = await positionAnalysis.analyzeAll(db);
      return ok(results);
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle('portfolio:analysis:get', (_e, positionId: number): IpcResult<PositionAnalysis | null> => {
    if (!positionAnalysis) return ok(null);
    try {
      return ok(positionAnalysis.getAnalysis(db, positionId));
    } catch (err) {
      return fail(err);
    }
  });

  // ─── Phase 3: AI Advisor ──────────────────────────────────────────────────

  ipcMain.handle('portfolio:advisor:run', async (event): Promise<IpcResult<AdvisorSession>> => {
    try {
      const onProgress = (evt: AdvisorProgressEvent) => {
        // Forward streaming progress to renderer (thinking text, status updates)
        event.sender.send('portfolio:advisor:progress', evt);
      };
      const session = await aiAdvisor.advise(db, onProgress);
      return ok(session);
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle('portfolio:advisor:history', (_e, limit?: number): IpcResult<AdvisorSession[]> => {
    try {
      return ok(aiAdvisor.getHistory(db, limit));
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle('portfolio:advisor:setApiKey', (_e, key: string): IpcResult<boolean> => {
    try {
      secureSet(db, 'anthropicApiKey', key);
      return ok(true);
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle('portfolio:advisor:hasApiKey', (_e): IpcResult<boolean> => {
    try {
      const key = secureGet(db, 'anthropicApiKey');
      return ok(Boolean(key));
    } catch {
      return ok(false);
    }
  });
}

// ─── Row mapper ───────────────────────────────────────────────────────────────

function mapPositionEtrade(r: Record<string, unknown>): PositionEtrade {
  return {
    id:               r['id'] as number,
    ticker:           r['ticker'] as string,
    positionType:     r['position_type'] as 'CSP' | 'CC' | 'Stock' | 'Long Put' | 'Long Call',
    quantity:         r['quantity'] as number,
    entryPrice:       r['entry_price'] as number,
    entryDate:        r['entry_date'] as string,
    entryNotes:       (r['entry_notes'] as string | null) ?? null,
    exitPrice:        (r['exit_price'] as number | null) ?? null,
    exitDate:         (r['exit_date'] as string | null) ?? null,
    exitNotes:        (r['exit_notes'] as string | null) ?? null,
    strikePrice:      (r['strike_price'] as number | null) ?? null,
    expirationDate:   (r['expiration_date'] as string | null) ?? null,
    premiumReceived:  (r['premium_received'] as number | null) ?? null,
    currentPrice:     (r['current_price'] as number | null) ?? null,
    unrealizedPnl:    (r['unrealized_pnl'] as number | null) ?? null,
    realizedPnl:      (r['realized_pnl'] as number | null) ?? null,
    status:           r['status'] as 'open' | 'closed',
    createdAt:        r['created_at'] as string,
    updatedAt:        r['updated_at'] as string,
    etradePositionId: (r['etrade_position_id'] as number | null) ?? null,
    etradeAccountId:  (r['etrade_account_id'] as string | null) ?? null,
    marketValue:      (r['market_value'] as number | null) ?? null,
    totalGainPct:     (r['total_gain_pct'] as number | null) ?? null,
    daysGain:         (r['days_gain'] as number | null) ?? null,
    daysGainPct:      (r['days_gain_pct'] as number | null) ?? null,
    costPerShare:     (r['cost_per_share'] as number | null) ?? null,
    pctOfPortfolio:   (r['pct_of_portfolio'] as number | null) ?? null,
    delta:            (r['delta'] as number | null) ?? null,
    gamma:            (r['gamma'] as number | null) ?? null,
    theta:            (r['theta'] as number | null) ?? null,
    vega:             (r['vega'] as number | null) ?? null,
    iv:               (r['iv'] as number | null) ?? null,
    beta:             (r['beta'] as number | null) ?? null,
    lastSyncedAt:     (r['last_synced_at'] as string | null) ?? null,
  };
}
