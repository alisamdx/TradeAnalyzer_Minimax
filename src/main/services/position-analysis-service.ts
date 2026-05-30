/**
 * Position Analysis Service — Phase 2 of AI Portfolio Advisor (migration 014).
 *
 * Runs the existing AnalysisService engine on each open position and stores
 * a structured analysis record in `position_analysis`.
 *
 * Uses 'buy' mode for all positions (returns trend, RSI, SMAs, support/resistance,
 * composite score). Derives options-specific fields (DTE, delta, assignment risk,
 * roll opportunity) from the position row's stored E*Trade data.
 *
 * see docs/formulas.md#position-analysis
 */

import type { Database } from 'better-sqlite3';
import type { AnalysisService, BuyResult } from './analysis-service.js';
import type { PositionAnalysis } from '@shared/types.js';

// ─── DB row shape ─────────────────────────────────────────────────────────────

interface PositionRow {
  id: number;
  ticker: string;
  position_type: 'CSP' | 'CC' | 'Stock';
  quantity: number;
  entry_price: number;
  entry_date: string;
  expiration_date: string | null;
  strike_price: number | null;
  premium_received: number | null;
  market_value: number | null;
  cost_per_share: number | null;
  delta: number | null;
  theta: number | null;
  iv: number | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function dte(expirationDate: string | null): number | null {
  if (!expirationDate) return null;
  const exp = new Date(expirationDate);
  const now = new Date();
  const diff = Math.round((exp.getTime() - now.getTime()) / 86_400_000);
  return diff;
}

function assignmentRisk(
  positionType: 'CSP' | 'CC' | 'Stock',
  stockPrice: number | null,
  strikePrice: number | null,
  daysLeft: number | null
): 'low' | 'medium' | 'high' | null {
  if (positionType === 'Stock') return null;
  if (stockPrice == null || strikePrice == null) return null;

  const isCall = positionType === 'CC';
  const dist = isCall
    ? (strikePrice - stockPrice) / strikePrice   // positive = OTM (safe for CC)
    : (stockPrice - strikePrice) / strikePrice;  // positive = OTM (safe for CSP)

  if (dist < -0.05) return 'high';
  if (dist < 0) return 'medium';
  if (dist < 0.05 && daysLeft !== null && daysLeft <= 14) return 'medium';
  return 'low';
}

interface RollOpportunity {
  reason: string;
  suggestedDte: number;
  urgency: 'immediate' | 'this_week' | 'monitor';
}

function detectRoll(
  positionType: 'CSP' | 'CC' | 'Stock',
  daysLeft: number | null,
  risk: 'low' | 'medium' | 'high' | null,
  delta: number | null
): RollOpportunity | null {
  if (positionType === 'Stock') return null;
  if (daysLeft == null) return null;

  if (daysLeft <= 5) {
    return {
      reason: `Only ${daysLeft} DTE — expiry imminent`,
      suggestedDte: 30,
      urgency: 'immediate',
    };
  }
  if (risk === 'high') {
    return {
      reason: `Deep ITM (${positionType === 'CSP' ? 'stock below strike' : 'stock above strike'}) — defensive roll needed`,
      suggestedDte: 45,
      urgency: 'immediate',
    };
  }
  if (daysLeft <= 14 && (risk === 'medium' || (delta != null && Math.abs(delta) > 0.4))) {
    return {
      reason: `${daysLeft} DTE with elevated risk — consider rolling out`,
      suggestedDte: 30,
      urgency: 'this_week',
    };
  }
  return null;
}

function recommendAction(
  risk: 'low' | 'medium' | 'high' | null,
  roll: RollOpportunity | null,
  trend: 'bullish' | 'bearish' | 'sideways',
  compositeScore: number,
  positionType: 'CSP' | 'CC' | 'Stock',
  currentReturnPct: number | null
): { action: PositionAnalysis['action']; conviction: 1 | 2 | 3; explanation: string } {
  if (positionType === 'Stock') {
    if (trend === 'bearish' && compositeScore < 3) {
      return { action: 'hedge', conviction: 2, explanation: 'Bearish trend — consider hedging the stock position.' };
    }
    if (currentReturnPct !== null && currentReturnPct >= 25) {
      return { action: 'take_profits', conviction: 2, explanation: `Position up ${currentReturnPct.toFixed(1)}% — consider taking partial profits.` };
    }
    return { action: 'hold', conviction: 2, explanation: `Trend: ${trend}, score: ${compositeScore.toFixed(1)}/10 — hold.` };
  }

  if (roll && roll.urgency === 'immediate') {
    return { action: 'roll', conviction: 3, explanation: roll.reason };
  }
  if (risk === 'high') {
    return { action: 'close', conviction: 3, explanation: 'Deep ITM — consider closing or rolling to avoid assignment.' };
  }
  if (roll && roll.urgency === 'this_week') {
    return { action: 'roll', conviction: 2, explanation: roll.reason };
  }
  if (currentReturnPct !== null && currentReturnPct >= 50) {
    return { action: 'take_profits', conviction: 2, explanation: `Captured ${currentReturnPct.toFixed(0)}% of max profit — consider closing early.` };
  }
  return { action: 'hold', conviction: 1, explanation: 'No immediate action required.' };
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class PositionAnalysisService {

  constructor(private readonly analysisService: AnalysisService) {}

  /**
   * Analyze a single open position and upsert into `position_analysis`.
   * Returns the resulting analysis record.
   */
  async analyzePosition(db: Database, positionId: number): Promise<PositionAnalysis> {
    const pos = db.prepare(
      `SELECT id, ticker, position_type, quantity, entry_price, entry_date,
              expiration_date, strike_price, premium_received,
              market_value, cost_per_share, delta, theta, iv
       FROM positions
       WHERE id = ? AND status = 'open'`
    ).get(positionId) as PositionRow | undefined;

    if (!pos) throw new Error(`Position ${positionId} not found or not open`);

    // ── Run buy-mode analysis for technical signals ──────────────────────────
    const result = await this.analysisService.analyzeTicker(pos.ticker, 'buy') as BuyResult;

    const stockPrice = result.lastPrice;
    const daysLeft   = dte(pos.expiration_date);

    // ── Position return % ────────────────────────────────────────────────────
    let currentReturnPct: number | null = null;
    let annualizedReturn: number | null = null;

    if (pos.position_type === 'Stock') {
      if (stockPrice != null && pos.entry_price > 0) {
        currentReturnPct = ((stockPrice - pos.entry_price) / pos.entry_price) * 100;
        const daysHeld = Math.round(
          (Date.now() - new Date(pos.entry_date).getTime()) / 86_400_000
        );
        if (daysHeld > 0) {
          annualizedReturn = (currentReturnPct / daysHeld) * 365;
        }
      }
    } else if (pos.premium_received != null && pos.premium_received > 0) {
      // For CSP/CC: return = premium captured so far (use market_value as proxy if available)
      // Simplest: % of initial premium still at risk (decreasing theta)
      // We don't have current option mid here — just report days-based theta
      const daysHeld = pos.expiration_date
        ? Math.round((Date.now() - new Date(pos.entry_date).getTime()) / 86_400_000)
        : null;
      if (daysHeld != null && daysLeft != null) {
        const totalDays = daysHeld + daysLeft;
        if (totalDays > 0) {
          currentReturnPct = (daysHeld / totalDays) * 100; // time decay captured %
        }
      }
    }

    // ── Options-specific ─────────────────────────────────────────────────────
    const risk = assignmentRisk(pos.position_type, stockPrice, pos.strike_price, daysLeft);
    const roll  = detectRoll(pos.position_type, daysLeft, risk, pos.delta);

    // IV rank: stored from E*Trade sync (already percentage)
    const ivRank = pos.iv;  // E*Trade iv is already % after ingestion

    // ── Recommendation ────────────────────────────────────────────────────────
    const { action, conviction, explanation } = recommendAction(
      risk, roll,
      result.trend,
      result.compositeScore,
      pos.position_type,
      currentReturnPct
    );

    // ── Support / resistance from entry zone ──────────────────────────────────
    const supportLevel    = result.entryZoneLow;
    const resistanceLevel = result.entryZoneHigh;

    // ── Upsert into position_analysis ────────────────────────────────────────
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO position_analysis (
        position_id, analyzed_at,
        trend, rsi, sma20, sma50, sma200, support_level, resistance_level, composite_score,
        days_in_position, current_return_pct, annualized_return,
        current_delta, theta_decay, iv_rank, assignment_risk, roll_opportunity,
        action, conviction, explanation
      ) VALUES (
        ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?
      )
      ON CONFLICT(position_id) DO UPDATE SET
        analyzed_at        = excluded.analyzed_at,
        trend              = excluded.trend,
        rsi                = excluded.rsi,
        sma20              = excluded.sma20,
        sma50              = excluded.sma50,
        sma200             = excluded.sma200,
        support_level      = excluded.support_level,
        resistance_level   = excluded.resistance_level,
        composite_score    = excluded.composite_score,
        days_in_position   = excluded.days_in_position,
        current_return_pct = excluded.current_return_pct,
        annualized_return  = excluded.annualized_return,
        current_delta      = excluded.current_delta,
        theta_decay        = excluded.theta_decay,
        iv_rank            = excluded.iv_rank,
        assignment_risk    = excluded.assignment_risk,
        roll_opportunity   = excluded.roll_opportunity,
        action             = excluded.action,
        conviction         = excluded.conviction,
        explanation        = excluded.explanation
    `).run(
      positionId, now,
      result.trend,
      result.rsi,
      result.smaStack.sma20,
      result.smaStack.sma50,
      result.smaStack.sma200,
      supportLevel,
      resistanceLevel,
      result.compositeScore,
      Math.round((Date.now() - new Date(pos.entry_date).getTime()) / 86_400_000),
      currentReturnPct,
      annualizedReturn,
      pos.delta,
      pos.theta,
      ivRank,
      risk,
      roll ? JSON.stringify(roll) : null,
      action, conviction, explanation
    );

    // ── Read back the upserted row ────────────────────────────────────────────
    const row = db.prepare(
      'SELECT * FROM position_analysis WHERE position_id = ?'
    ).get(positionId) as Record<string, unknown>;

    return this.mapRow(row);
  }

  /** Analyze all open positions (sequential, rate-limited by AnalysisService). */
  async analyzeAll(db: Database): Promise<PositionAnalysis[]> {
    const positions = db.prepare(
      "SELECT id FROM positions WHERE status = 'open'"
    ).all() as { id: number }[];

    const results: PositionAnalysis[] = [];
    for (const { id } of positions) {
      try {
        results.push(await this.analyzePosition(db, id));
      } catch {
        // Skip individual failures — partial results are still useful
      }
    }
    return results;
  }

  /** Retrieve stored analysis for a position (null if not yet analyzed). */
  getAnalysis(db: Database, positionId: number): PositionAnalysis | null {
    const row = db.prepare(
      'SELECT * FROM position_analysis WHERE position_id = ?'
    ).get(positionId) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  private mapRow(row: Record<string, unknown>): PositionAnalysis {
    return {
      id:                 row['id'] as number,
      positionId:         row['position_id'] as number,
      analyzedAt:         row['analyzed_at'] as string,
      trend:              (row['trend'] as 'bullish' | 'bearish' | 'sideways' | null) ?? null,
      rsi:                (row['rsi'] as number | null) ?? null,
      sma20:              (row['sma20'] as number | null) ?? null,
      sma50:              (row['sma50'] as number | null) ?? null,
      sma200:             (row['sma200'] as number | null) ?? null,
      supportLevel:       (row['support_level'] as number | null) ?? null,
      resistanceLevel:    (row['resistance_level'] as number | null) ?? null,
      compositeScore:     (row['composite_score'] as number | null) ?? null,
      daysInPosition:     (row['days_in_position'] as number | null) ?? null,
      currentReturnPct:   (row['current_return_pct'] as number | null) ?? null,
      annualizedReturn:   (row['annualized_return'] as number | null) ?? null,
      currentDelta:       (row['current_delta'] as number | null) ?? null,
      thetaDecay:         (row['theta_decay'] as number | null) ?? null,
      ivRank:             (row['iv_rank'] as number | null) ?? null,
      assignmentRisk:     (row['assignment_risk'] as 'low' | 'medium' | 'high' | null) ?? null,
      rollOpportunity:    row['roll_opportunity']
        ? JSON.parse(row['roll_opportunity'] as string)
        : null,
      action:     (row['action'] as PositionAnalysis['action']),
      conviction: (row['conviction'] as 1 | 2 | 3),
      explanation: row['explanation'] as string,
    };
  }
}
