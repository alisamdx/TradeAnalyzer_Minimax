// Alerts Service - manages user-configurable notifications
// Supports Phase 8: Alerts System
// see SPEC: Priority 8 - Alerts System

import type { DbHandle } from '../db/connection.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type AlertType = 'price' | 'expiration' | 'delta';

export interface Alert {
  id: number;
  ticker: string;
  alertType: AlertType;
  priceThreshold: number | null;
  priceCondition: 'above' | 'below' | null;
  daysBeforeExpiration: number | null;
  deltaThreshold: number | null;
  deltaDirection: 'above' | 'below' | null;
  isActive: boolean;
  isTriggered: boolean;
  triggeredAt: string | null;
  playSound: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AlertInput {
  ticker: string;
  alertType: AlertType;
  priceThreshold?: number;
  priceCondition?: 'above' | 'below';
  daysBeforeExpiration?: number;
  deltaThreshold?: number;
  deltaDirection?: 'above' | 'below';
  playSound?: boolean;
}

export interface AlertCheckResult {
  alertId: number;
  ticker: string;
  alertType: AlertType;
  triggered: boolean;
  message: string;
  playSound: boolean;
}

// ─── Service Implementation ───────────────────────────────────────────────────

export class AlertsError extends Error {
  constructor(
    public readonly code:
      | 'INVALID_TICKER'
      | 'INVALID_TYPE'
      | 'MISSING_THRESHOLD'
      | 'ALERT_NOT_FOUND',
    message: string
  ) {
    super(message);
    this.name = 'AlertsError';
  }
}

export class AlertsService {
  private readonly insertStmt;
  private readonly updateStmt;
  private readonly deleteStmt;
  private readonly getByIdStmt;
  private readonly listActiveStmt;
  private readonly listTriggeredStmt;
  private readonly markTriggeredStmt;
  private readonly resetTriggeredStmt;

  constructor(private readonly db: DbHandle) {
    // Insert new alert
    this.insertStmt = db.prepare(`
      INSERT INTO alerts (
        ticker, alert_type, price_threshold, price_condition,
        days_before_expiration, delta_threshold, delta_direction, play_sound
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // Update alert
    this.updateStmt = db.prepare(`
      UPDATE alerts SET
        ticker = COALESCE(?, ticker),
        price_threshold = COALESCE(?, price_threshold),
        price_condition = COALESCE(?, price_condition),
        days_before_expiration = COALESCE(?, days_before_expiration),
        delta_threshold = COALESCE(?, delta_threshold),
        delta_direction = COALESCE(?, delta_direction),
        is_active = COALESCE(?, is_active),
        play_sound = COALESCE(?, play_sound)
      WHERE id = ?
    `);

    // Delete alert
    this.deleteStmt = db.prepare(`
      DELETE FROM alerts WHERE id = ?
    `);

    // Get alert by ID
    this.getByIdStmt = db.prepare(`
      SELECT * FROM alerts WHERE id = ?
    `);

    // List active alerts
    this.listActiveStmt = db.prepare(`
      SELECT * FROM alerts WHERE is_active = 1 ORDER BY created_at DESC
    `);

    // List triggered alerts
    this.listTriggeredStmt = db.prepare(`
      SELECT * FROM alerts WHERE is_triggered = 1 ORDER BY triggered_at DESC
    `);

    // Mark alert as triggered
    this.markTriggeredStmt = db.prepare(`
      UPDATE alerts SET
        is_triggered = 1,
        triggered_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `);

    // Reset triggered status
    this.resetTriggeredStmt = db.prepare(`
      UPDATE alerts SET
        is_triggered = 0,
        triggered_at = NULL
      WHERE id = ?
    `);
  }

  // ─── CRUD Operations ────────────────────────────────────────────────────────

  createAlert(input: AlertInput): Alert {
    this.validateInput(input);

    const result = this.insertStmt.run(
      input.ticker.toUpperCase(),
      input.alertType,
      input.priceThreshold ?? null,
      input.priceCondition ?? null,
      input.daysBeforeExpiration ?? 7,
      input.deltaThreshold ?? null,
      input.deltaDirection ?? null,
      input.playSound ?? 1
    );

    const alert = this.getById(Number(result.lastInsertRowid));
    if (!alert) {
      throw new AlertsError('ALERT_NOT_FOUND', 'Failed to retrieve created alert');
    }

    return alert;
  }

  updateAlert(id: number, input: Partial<AlertInput>): Alert {
    const existing = this.getById(id);
    if (!existing) {
      throw new AlertsError('ALERT_NOT_FOUND', `Alert ${id} not found`);
    }

    this.updateStmt.run(
      input.ticker ?? null,
      input.priceThreshold ?? null,
      input.priceCondition ?? null,
      input.daysBeforeExpiration ?? null,
      input.deltaThreshold ?? null,
      input.deltaDirection ?? null,
      input.hasOwnProperty('playSound') ? (input.playSound ? 1 : 0) : null,
      id
    );

    const updated = this.getById(id);
    if (!updated) {
      throw new AlertsError('ALERT_NOT_FOUND', 'Failed to retrieve updated alert');
    }

    return updated;
  }

  deleteAlert(id: number): void {
    this.deleteStmt.run(id);
  }

  getById(id: number): Alert | null {
    const row = this.getByIdStmt.get(id) as AlertRow | undefined;
    return row ? rowToAlert(row) : null;
  }

  listActive(): Alert[] {
    const rows = this.listActiveStmt.all() as AlertRow[];
    return rows.map(rowToAlert);
  }

  listTriggered(): Alert[] {
    const rows = this.listTriggeredStmt.all() as AlertRow[];
    return rows.map(rowToAlert);
  }

  // ─── Trigger Management ─────────────────────────────────────────────────────

  markTriggered(id: number): void {
    this.markTriggeredStmt.run(id);
  }

  resetTriggered(id: number): void {
    this.resetTriggeredStmt.run(id);
  }

  // ─── Alert Checking ─────────────────────────────────────────────────────────

  checkPriceAlert(alert: Alert, currentPrice: number): AlertCheckResult {
    if (!alert.priceThreshold || !alert.priceCondition) {
      return { alertId: alert.id, ticker: alert.ticker, alertType: 'price', triggered: false, message: '', playSound: alert.playSound };
    }

    const triggered = alert.priceCondition === 'above'
      ? currentPrice >= alert.priceThreshold
      : currentPrice <= alert.priceThreshold;

    return {
      alertId: alert.id,
      ticker: alert.ticker,
      alertType: 'price',
      triggered,
      message: triggered
        ? `${alert.ticker} price ${alert.priceCondition} $${alert.priceThreshold.toFixed(2)} (current: $${currentPrice.toFixed(2)})`
        : '',
      playSound: alert.playSound
    };
  }

  checkExpirationAlert(alert: Alert, daysToExpiration: number): AlertCheckResult {
    const threshold = alert.daysBeforeExpiration ?? 7;
    const triggered = daysToExpiration <= threshold;

    return {
      alertId: alert.id,
      ticker: alert.ticker,
      alertType: 'expiration',
      triggered,
      message: triggered
        ? `${alert.ticker} expires in ${daysToExpiration} days`
        : '',
      playSound: alert.playSound
    };
  }

  checkDeltaAlert(alert: Alert, currentDelta: number): AlertCheckResult {
    if (!alert.deltaThreshold || !alert.deltaDirection) {
      return { alertId: alert.id, ticker: alert.ticker, alertType: 'delta', triggered: false, message: '', playSound: alert.playSound };
    }

    const triggered = alert.deltaDirection === 'above'
      ? currentDelta >= alert.deltaThreshold
      : currentDelta <= alert.deltaThreshold;

    return {
      alertId: alert.id,
      ticker: alert.ticker,
      alertType: 'delta',
      triggered,
      message: triggered
        ? `${alert.ticker} delta ${alert.deltaDirection} ${(alert.deltaThreshold * 100).toFixed(0)}% (current: ${(currentDelta * 100).toFixed(1)}%)`
        : '',
      playSound: alert.playSound
    };
  }

  // ─── Validation ───────────────────────────────────────────────────────────────

  private validateInput(input: AlertInput): void {
    const TICKER_RE = /^[A-Z][A-Z0-9.-]{0,9}$/;
    if (!input.ticker || !TICKER_RE.test(input.ticker.toUpperCase())) {
      throw new AlertsError('INVALID_TICKER', `Invalid ticker: ${input.ticker}`);
    }

    if (!['price', 'expiration', 'delta'].includes(input.alertType)) {
      throw new AlertsError('INVALID_TYPE', `Invalid alert type: ${input.alertType}`);
    }

    // Validate type-specific fields
    if (input.alertType === 'price' && !input.priceThreshold) {
      throw new AlertsError('MISSING_THRESHOLD', 'Price alerts require priceThreshold');
    }
  }
}

// ─── Row Mapping ──────────────────────────────────────────────────────────────

interface AlertRow {
  id: number;
  ticker: string;
  alert_type: AlertType;
  price_threshold: number | null;
  price_condition: 'above' | 'below' | null;
  days_before_expiration: number | null;
  delta_threshold: number | null;
  delta_direction: 'above' | 'below' | null;
  is_active: number;
  is_triggered: number;
  triggered_at: string | null;
  play_sound: number;
  created_at: string;
  updated_at: string;
}

function rowToAlert(r: AlertRow): Alert {
  return {
    id: r.id,
    ticker: r.ticker,
    alertType: r.alert_type,
    priceThreshold: r.price_threshold,
    priceCondition: r.price_condition,
    daysBeforeExpiration: r.days_before_expiration,
    deltaThreshold: r.delta_threshold,
    deltaDirection: r.delta_direction,
    isActive: r.is_active === 1,
    isTriggered: r.is_triggered === 1,
    triggeredAt: r.triggered_at,
    playSound: r.play_sound === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}
