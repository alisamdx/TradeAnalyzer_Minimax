// IPC handlers for portfolio tracking
// Exposes position management and P&L calculations to renderer
// see SPEC: Priority 6 - Portfolio Tracking

import { ipcMain } from 'electron';
import type { Database } from 'better-sqlite3';
import { PortfolioService, type PositionInput, type PositionUpdate, type PositionCloseInput } from '../services/portfolio-service.js';

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

export function registerPortfolioIpc(db: Database): void {
  const service = new PortfolioService(db);

  // ─── CRUD Operations ────────────────────────────────────────────────────────

  ipcMain.handle('portfolio:add', (_event, input: PositionInput) => {
    try {
      const position = service.addPosition(input);
      return { success: true, data: position };
    } catch (err) {
      console.error('[portfolio:add] Error:', err);
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('portfolio:list', (_event, status?: 'open' | 'closed') => {
    try {
      const positions = service.listPositions(status);
      return { success: true, data: positions };
    } catch (err) {
      console.error('[portfolio:list] Error:', err);
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('portfolio:get', (_event, id: number) => {
    try {
      const position = service.getById(id);
      return { success: true, data: position };
    } catch (err) {
      console.error('[portfolio:get] Error:', err);
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('portfolio:getWithMetrics', (_event, id: number) => {
    try {
      const position = service.getPositionWithMetrics(id);
      return { success: true, data: position };
    } catch (err) {
      console.error('[portfolio:getWithMetrics] Error:', err);
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('portfolio:update', (_event, id: number, update: PositionUpdate) => {
    try {
      const position = service.updatePosition(id, update);
      return { success: true, data: position };
    } catch (err) {
      console.error('[portfolio:update] Error:', err);
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('portfolio:close', (_event, id: number, input: PositionCloseInput) => {
    try {
      const position = service.closePosition(id, input);
      return { success: true, data: position };
    } catch (err) {
      console.error('[portfolio:close] Error:', err);
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('portfolio:delete', (_event, id: number) => {
    try {
      service.deletePosition(id);
      return { success: true };
    } catch (err) {
      console.error('[portfolio:delete] Error:', err);
      return { success: false, error: (err as Error).message };
    }
  });

  // ─── P&L Operations ───────────────────────────────────────────────────────

  ipcMain.handle('portfolio:pnlSummary', () => {
    try {
      const summary = service.getPnLSummary();
      return { success: true, data: summary };
    } catch (err) {
      console.error('[portfolio:pnlSummary] Error:', err);
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('portfolio:updatePrice', (_event, ticker: string, price: number) => {
    try {
      service.updatePricesForTicker(ticker, price);
      return { success: true };
    } catch (err) {
      console.error('[portfolio:updatePrice] Error:', err);
      return { success: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('portfolio:listByTicker', (_event, ticker: string) => {
    try {
      const positions = service.listByTicker(ticker);
      return { success: true, data: positions };
    } catch (err) {
      console.error('[portfolio:listByTicker] Error:', err);
      return { success: false, error: (err as Error).message };
    }
  });
}
