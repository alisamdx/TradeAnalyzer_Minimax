// Portfolio service - manages positions and P&L calculations
// Supports Phase 6: Portfolio Tracking
// see SPEC: Priority 6 - Portfolio Tracking

import type { DbHandle } from '../db/connection.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type PositionType = 'CSP' | 'CC' | 'Stock';
export type PositionStatus = 'open' | 'closed';

export interface Position {
  id: number;
  ticker: string;
  positionType: PositionType;
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
  status: PositionStatus;
  createdAt: string;
  updatedAt: string;
}

export interface PositionInput {
  ticker: string;
  positionType: PositionType;
  quantity: number;
  entryPrice: number;
  entryDate: string;
  entryNotes?: string | null;
  strikePrice?: number | null;
  expirationDate?: string | null;
  premiumReceived?: number | null;
}

export interface PositionUpdate {
  quantity?: number;
  entryPrice?: number;
  entryDate?: string;
  entryNotes?: string | null;
  strikePrice?: number | null;
  expirationDate?: string | null;
  premiumReceived?: number | null;
}

export interface PositionCloseInput {
  exitPrice: number;
  exitDate: string;
  exitNotes?: string | null;
}

export interface PnLSummary {
  totalPositions: number;
  openPositions: number;
  closedPositions: number;
  totalUnrealizedPnl: number;
  totalRealizedPnl: number;
  totalCapitalDeployed: number;
  winRate: number;
  averageReturnPct: number;
}

export interface PositionWithMetrics extends Position {
  capitalRequired: number;
  daysHeld: number | null;
  returnPct: number | null;
  annualizedReturn: number | null;
}

// ─── Service Implementation ───────────────────────────────────────────────────

export class PortfolioError extends Error {
  constructor(
    public readonly code:
      | 'INVALID_TICKER'
      | 'INVALID_TYPE'
      | 'INVALID_QUANTITY'
      | 'INVALID_PRICE'
      | 'POSITION_NOT_FOUND'
      | 'ALREADY_CLOSED'
      | 'OPTIONS_FIELDS_REQUIRED',
    message: string
  ) {
    super(message);
    this.name = 'PortfolioError';
  }
}

const TICKER_RE = /^[A-Z][A-Z0-9.-]{0,9}$/;

export class PortfolioService {
  private readonly insertStmt;
  private readonly updateStmt;
  private readonly closeStmt;
  private readonly deleteStmt;
  private readonly getByIdStmt;
  private readonly listStmt;
  private readonly listByStatusStmt;
  private readonly listByTickerStmt;
  private readonly updateCurrentPriceStmt;

  constructor(private readonly db: DbHandle) {
    // Insert new position
    this.insertStmt = db.prepare(`
      INSERT INTO positions (
        ticker, position_type, quantity, entry_price, entry_date, entry_notes,
        strike_price, expiration_date, premium_received, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')
    `);

    // Update position details
    this.updateStmt = db.prepare(`
      UPDATE positions SET
        quantity = COALESCE(?, quantity),
        entry_price = COALESCE(?, entry_price),
        entry_date = COALESCE(?, entry_date),
        entry_notes = COALESCE(?, entry_notes),
        strike_price = COALESCE(?, strike_price),
        expiration_date = COALESCE(?, expiration_date),
        premium_received = COALESCE(?, premium_received)
      WHERE id = ?
    `);

    // Close position
    this.closeStmt = db.prepare(`
      UPDATE positions SET
        exit_price = ?,
        exit_date = ?,
        exit_notes = ?,
        status = 'closed',
        realized_pnl = CASE
          WHEN position_type = 'Stock' THEN (? - entry_price) * quantity
          WHEN position_type IN ('CSP', 'CC') THEN
            (? - entry_price) * quantity * 100 + COALESCE(premium_received, 0)
          ELSE 0
        END
      WHERE id = ?
    `);

    // Delete position
    this.deleteStmt = db.prepare(`
      DELETE FROM positions WHERE id = ?
    `);

    // Get position by ID
    this.getByIdStmt = db.prepare(`
      SELECT * FROM positions WHERE id = ?
    `);

    // List all positions
    this.listStmt = db.prepare(`
      SELECT * FROM positions ORDER BY entry_date DESC
    `);

    // List by status
    this.listByStatusStmt = db.prepare(`
      SELECT * FROM positions WHERE status = ? ORDER BY entry_date DESC
    `);

    // List by ticker
    this.listByTickerStmt = db.prepare(`
      SELECT * FROM positions WHERE ticker = ? ORDER BY entry_date DESC
    `);

    // Update current price and unrealized P&L
    this.updateCurrentPriceStmt = db.prepare(`
      UPDATE positions SET
        current_price = ?,
        unrealized_pnl = CASE
          WHEN position_type = 'Stock' AND status = 'open' THEN (? - entry_price) * quantity
          WHEN position_type IN ('CSP', 'CC') AND status = 'open' THEN COALESCE(premium_received, 0)
          ELSE unrealized_pnl
        END
      WHERE id = ?
    `);
  }

  // ─── Validation ─────────────────────────────────────────────────────────────

  private validateTicker(ticker: string): void {
    if (!ticker || !TICKER_RE.test(ticker.toUpperCase())) {
      throw new PortfolioError('INVALID_TICKER', `Invalid ticker: ${ticker}`);
    }
  }

  private validatePositionInput(input: PositionInput): void {
    this.validateTicker(input.ticker);

    if (!['CSP', 'CC', 'Stock'].includes(input.positionType)) {
      throw new PortfolioError('INVALID_TYPE', `Invalid position type: ${input.positionType}`);
    }

    if (!input.quantity || input.quantity <= 0) {
      throw new PortfolioError('INVALID_QUANTITY', 'Quantity must be greater than 0');
    }

    if (input.entryPrice === null || input.entryPrice === undefined || input.entryPrice < 0) {
      throw new PortfolioError('INVALID_PRICE', 'Entry price must be non-negative');
    }

    // Options require strike and expiration
    if (input.positionType !== 'Stock') {
      if (!input.strikePrice || input.strikePrice <= 0) {
        throw new PortfolioError('OPTIONS_FIELDS_REQUIRED', 'Options positions require strike price');
      }
      if (!input.expirationDate) {
        throw new PortfolioError('OPTIONS_FIELDS_REQUIRED', 'Options positions require expiration date');
      }
    }
  }

  // ─── CRUD Operations ────────────────────────────────────────────────────────

  addPosition(input: PositionInput): Position {
    this.validatePositionInput(input);

    const result = this.insertStmt.run(
      input.ticker.toUpperCase(),
      input.positionType,
      input.quantity,
      input.entryPrice,
      input.entryDate,
      input.entryNotes ?? null,
      input.strikePrice ?? null,
      input.expirationDate ?? null,
      input.premiumReceived ?? null
    );

    const position = this.getById(Number(result.lastInsertRowid));
    if (!position) {
      throw new PortfolioError('POSITION_NOT_FOUND', 'Failed to retrieve created position');
    }

    return position;
  }

  updatePosition(id: number, update: PositionUpdate): Position {
    const existing = this.getById(id);
    if (!existing) {
      throw new PortfolioError('POSITION_NOT_FOUND', `Position ${id} not found`);
    }

    if (existing.status === 'closed') {
      throw new PortfolioError('ALREADY_CLOSED', 'Cannot update closed position');
    }

    this.updateStmt.run(
      update.quantity ?? null,
      update.entryPrice ?? null,
      update.entryDate ?? null,
      update.entryNotes ?? null,
      update.strikePrice ?? null,
      update.expirationDate ?? null,
      update.premiumReceived ?? null,
      id
    );

    const updated = this.getById(id);
    if (!updated) {
      throw new PortfolioError('POSITION_NOT_FOUND', 'Failed to retrieve updated position');
    }

    return updated;
  }

  closePosition(id: number, input: PositionCloseInput): Position {
    const existing = this.getById(id);
    if (!existing) {
      throw new PortfolioError('POSITION_NOT_FOUND', `Position ${id} not found`);
    }

    if (existing.status === 'closed') {
      throw new PortfolioError('ALREADY_CLOSED', 'Position is already closed');
    }

    if (input.exitPrice === null || input.exitPrice === undefined || input.exitPrice < 0) {
      throw new PortfolioError('INVALID_PRICE', 'Exit price must be non-negative');
    }

    this.closeStmt.run(
      input.exitPrice,
      input.exitDate,
      input.exitNotes ?? null,
      input.exitPrice,
      input.exitPrice,
      id
    );

    const updated = this.getById(id);
    if (!updated) {
      throw new PortfolioError('POSITION_NOT_FOUND', 'Failed to retrieve closed position');
    }

    return updated;
  }

  deletePosition(id: number): void {
    this.deleteStmt.run(id);
  }

  getById(id: number): Position | null {
    const row = this.getByIdStmt.get(id) as PositionRow | undefined;
    return row ? rowToPosition(row) : null;
  }

  listPositions(status?: PositionStatus): Position[] {
    const rows = status
      ? this.listByStatusStmt.all(status) as PositionRow[]
      : this.listStmt.all() as PositionRow[];
    return rows.map(rowToPosition);
  }

  listByTicker(ticker: string): Position[] {
    const rows = this.listByTickerStmt.all(ticker.toUpperCase()) as PositionRow[];
    return rows.map(rowToPosition);
  }

  // ─── P&L Calculations ───────────────────────────────────────────────────────

  updateCurrentPrice(id: number, currentPrice: number): void {
    this.updateCurrentPriceStmt.run(currentPrice, currentPrice, id);
  }

  updatePricesForTicker(ticker: string, currentPrice: number): void {
    const positions = this.listByTicker(ticker);
    for (const position of positions) {
      if (position.status === 'open') {
        this.updateCurrentPrice(position.id, currentPrice);
      }
    }
  }

  getPnLSummary(): PnLSummary {
    const allPositions = this.listPositions();
    const openPositions = allPositions.filter(p => p.status === 'open');
    const closedPositions = allPositions.filter(p => p.status === 'closed');

    const totalUnrealized = openPositions.reduce((sum, p) => sum + (p.unrealizedPnl ?? 0), 0);
    const totalRealized = closedPositions.reduce((sum, p) => sum + (p.realizedPnl ?? 0), 0);

    const winningTrades = closedPositions.filter(p => (p.realizedPnl ?? 0) > 0).length;
    const winRate = closedPositions.length > 0 ? (winningTrades / closedPositions.length) * 100 : 0;

    const totalCapital = allPositions.reduce((sum, p) => {
      if (p.positionType === 'Stock') {
        return sum + (p.entryPrice * p.quantity);
      } else {
        return sum + ((p.strikePrice ?? 0) * p.quantity * 100);
      }
    }, 0);

    const averageReturn = closedPositions.length > 0
      ? closedPositions.reduce((sum, p) => sum + ((p.realizedPnl ?? 0) / totalCapital * 100), 0) / closedPositions.length
      : 0;

    return {
      totalPositions: allPositions.length,
      openPositions: openPositions.length,
      closedPositions: closedPositions.length,
      totalUnrealizedPnl: totalUnrealized,
      totalRealizedPnl: totalRealized,
      totalCapitalDeployed: totalCapital,
      winRate,
      averageReturnPct: averageReturn
    };
  }

  getPositionWithMetrics(id: number): PositionWithMetrics | null {
    const position = this.getById(id);
    if (!position) return null;

    const capitalRequired = position.positionType === 'Stock'
      ? position.entryPrice * position.quantity
      : (position.strikePrice ?? 0) * position.quantity * 100;

    const daysHeld = position.exitDate && position.entryDate
      ? Math.floor((new Date(position.exitDate).getTime() - new Date(position.entryDate).getTime()) / (1000 * 60 * 60 * 24))
      : null;

    const returnPct = position.status === 'open' && position.currentPrice
      ? ((position.currentPrice - position.entryPrice) / position.entryPrice) * 100
      : position.status === 'closed' && position.exitPrice
        ? ((position.exitPrice - position.entryPrice) / position.entryPrice) * 100
        : null;

    const annualizedReturn = returnPct && daysHeld && daysHeld > 0
      ? (returnPct / daysHeld) * 365
      : null;

    return {
      ...position,
      capitalRequired,
      daysHeld,
      returnPct,
      annualizedReturn
    };
  }
}

// ─── Row Mapping ──────────────────────────────────────────────────────────────

interface PositionRow {
  id: number;
  ticker: string;
  position_type: PositionType;
  quantity: number;
  entry_price: number;
  entry_date: string;
  entry_notes: string | null;
  exit_price: number | null;
  exit_date: string | null;
  exit_notes: string | null;
  strike_price: number | null;
  expiration_date: string | null;
  premium_received: number | null;
  current_price: number | null;
  unrealized_pnl: number | null;
  realized_pnl: number | null;
  status: PositionStatus;
  created_at: string;
  updated_at: string;
}

function rowToPosition(r: PositionRow): Position {
  return {
    id: r.id,
    ticker: r.ticker,
    positionType: r.position_type,
    quantity: r.quantity,
    entryPrice: r.entry_price,
    entryDate: r.entry_date,
    entryNotes: r.entry_notes,
    exitPrice: r.exit_price,
    exitDate: r.exit_date,
    exitNotes: r.exit_notes,
    strikePrice: r.strike_price,
    expirationDate: r.expiration_date,
    premiumReceived: r.premium_received,
    currentPrice: r.current_price,
    unrealizedPnl: r.unrealized_pnl,
    realizedPnl: r.realized_pnl,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}
