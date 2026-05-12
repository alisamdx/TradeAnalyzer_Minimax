// Read-only access to the TraderAgent SQLite database.
// Opens a separate DB handle; never writes to this DB from TradeAnalyzer
// (agent:close-trade spawns the agent CLI instead).

import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import type {
  AgentTrade, AgentLesson, AgentRecommendation, AgentMemorySnapshot, AgentStatus
} from '@shared/types.js';

interface TradeRow {
  id: number; ticker: string; mode: string; strategy: string;
  strike: number; expiration: string; dte_at_entry: number;
  entry_premium: number; capital_required: number;
  composite_score: number; rank_at_entry: number; rationale: string;
  status: string; entry_date: string; close_date: string | null;
  actual_pl: number | null; close_reason: string | null;
  target_pl: number | null; max_loss: number | null;
  annualized_return: number | null;
}

interface LessonRow {
  id: number; trade_id: number; gap_cause: string;
  gap_amount_usd: number; gap_pct: number; narrative: string; created_at: string;
}

interface RecommendationRow {
  id: number; category: string; severity: string;
  description: string; proposed_change: string; status: string; created_at: string;
}

interface MemoryRow {
  id: number;
  weights_json: string;
  win_rate_by_mode_json: string;
  top_lessons_json: string;
  trade_count: number;
  confidence: number;
  created_at: string;
}

export class AgentDbService {
  private db: InstanceType<typeof Database> | null = null;
  private dbPath = '';

  open(path: string): boolean {
    if (!path || !existsSync(path)) {
      this.db = null;
      this.dbPath = '';
      return false;
    }
    if (this.db && this.dbPath === path) return true;
    try {
      this.db?.close();
      this.db = new Database(path, { readonly: true, fileMustExist: true });
      this.dbPath = path;
      return true;
    } catch {
      this.db = null;
      this.dbPath = '';
      return false;
    }
  }

  close(): void {
    this.db?.close();
    this.db = null;
    this.dbPath = '';
  }

  isOpen(): boolean { return this.db !== null; }

  getStatus(): AgentStatus {
    if (!this.db) return { dbExists: false, openTrades: 0, closedTrades: 0, totalPl: 0, winRate: 0, lastRunAt: null, confidence: 0 };

    const open = (this.db.prepare("SELECT COUNT(*) AS n FROM agent_trades WHERE status = 'open'").get() as { n: number }).n;
    const closed = (this.db.prepare("SELECT COUNT(*) AS n FROM agent_trades WHERE status IN ('closed','expired')").get() as { n: number }).n;
    const plRow = this.db.prepare("SELECT SUM(actual_pl) AS total FROM agent_trades WHERE status IN ('closed','expired') AND actual_pl IS NOT NULL").get() as { total: number | null };
    const winRow = this.db.prepare("SELECT SUM(CASE WHEN actual_pl >= 0 THEN 1 ELSE 0 END) * 1.0 / COUNT(*) AS wr FROM agent_trades WHERE status IN ('closed','expired') AND actual_pl IS NOT NULL").get() as { wr: number | null };
    const lastRun = this.db.prepare("SELECT run_date FROM scout_runs ORDER BY id DESC LIMIT 1").get() as { run_date: string } | undefined;
    const mem = this.db.prepare("SELECT confidence FROM agent_memory ORDER BY id DESC LIMIT 1").get() as { confidence: number } | undefined;
    const confidence = mem?.confidence ?? 0;

    return {
      dbExists: true,
      openTrades: open,
      closedTrades: closed,
      totalPl: plRow.total ?? 0,
      winRate: winRow.wr ?? 0,
      lastRunAt: lastRun?.run_date ?? null,
      confidence
    };
  }

  getTrades(statusFilter?: 'open' | 'closed' | 'all'): AgentTrade[] {
    if (!this.db) return [];
    const where = statusFilter === 'open'
      ? "WHERE t.status = 'open'"
      : statusFilter === 'closed'
      ? "WHERE t.status IN ('closed','expired')"
      : '';

    const rows = this.db.prepare(`
      SELECT t.id, t.ticker, t.mode, t.strategy, t.strike, t.expiration,
             t.dte_at_entry, t.entry_premium, t.capital_required,
             t.composite_score, t.rank_at_entry, t.rationale,
             t.status, t.entry_date, t.close_date, t.actual_pl, t.close_reason,
             p.target_pl, p.max_loss, p.annualized_return
      FROM agent_trades t
      LEFT JOIN agent_trade_projections p ON p.trade_id = t.id
      ${where}
      ORDER BY t.id DESC
    `).all() as TradeRow[];

    return rows.map((r) => ({
      id: r.id, ticker: r.ticker, mode: r.mode, strategy: r.strategy,
      strike: r.strike, expiration: r.expiration, dteAtEntry: r.dte_at_entry,
      entryPremium: r.entry_premium, capitalRequired: r.capital_required,
      compositeScore: r.composite_score, rankAtEntry: r.rank_at_entry,
      rationale: r.rationale, status: r.status as AgentTrade['status'],
      entryDate: r.entry_date, closeDate: r.close_date,
      actualPl: r.actual_pl, closeReason: r.close_reason,
      targetPl: r.target_pl, maxLoss: r.max_loss, annualizedReturn: r.annualized_return
    }));
  }

  getLessons(limit = 50): AgentLesson[] {
    if (!this.db) return [];
    const rows = this.db.prepare(
      'SELECT id, trade_id, gap_cause, gap_amount_usd, gap_pct, narrative, created_at FROM agent_lessons ORDER BY id DESC LIMIT ?'
    ).all(limit) as LessonRow[];
    return rows.map((r) => ({
      id: r.id, tradeId: r.trade_id, gapCause: r.gap_cause,
      gapAmountUsd: r.gap_amount_usd, gapPct: r.gap_pct,
      narrative: r.narrative, createdAt: r.created_at
    }));
  }

  getRecommendations(): AgentRecommendation[] {
    if (!this.db) return [];
    const rows = this.db.prepare(
      "SELECT id, category, severity, description, proposed_change, status, created_at FROM agent_recommendations ORDER BY id DESC"
    ).all() as RecommendationRow[];
    return rows.map((r) => ({
      id: r.id, category: r.category, severity: r.severity,
      description: r.description, proposedChange: r.proposed_change,
      status: r.status, createdAt: r.created_at
    }));
  }

  getMemory(): AgentMemorySnapshot | null {
    if (!this.db) return null;
    const row = this.db.prepare(
      'SELECT id, weights_json, win_rate_by_mode_json, top_lessons_json, trade_count, confidence, created_at FROM agent_memory ORDER BY id DESC LIMIT 1'
    ).get() as MemoryRow | undefined;
    if (!row) return null;
    return {
      id: row.id,
      weights: row.weights_json ? (JSON.parse(row.weights_json) as Record<string, number>) : {},
      winRateByMode: row.win_rate_by_mode_json ? (JSON.parse(row.win_rate_by_mode_json) as Record<string, number>) : {},
      tradeCount: row.trade_count ?? 0,
      confidence: row.confidence ?? 0,
      topLessons: row.top_lessons_json ? (JSON.parse(row.top_lessons_json) as string[]) : [],
      savedAt: row.created_at
    };
  }
}
