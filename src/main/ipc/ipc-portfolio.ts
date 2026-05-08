// IPC handlers for portfolio tracking
// Exposes position management and P&L calculations to renderer
// see SPEC: Priority 6 - Portfolio Tracking

import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { Database } from 'better-sqlite3';
import { PortfolioService, type PositionInput, type PositionUpdate, type PositionCloseInput } from '../services/portfolio-service.js';
import type { IpcResult } from '@shared/types.js';

export interface PositionDto {
  id: number;
  ticker: string;
  positionType: 'CSP' | 'CC' | 'Stock';
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

export function registerPortfolioIpc(db: Database): void {
  const service = new PortfolioService(db);

  // ─── CRUD Operations ────────────────────────────────────────────────────────

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
}
