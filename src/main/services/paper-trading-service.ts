// Paper Trading Service — tracks Daily Brief picks as paper trades for scoring-engine validation.
// Auto-captures post-liquidity-gate picks at end of each brief run.
// P&L computed from historical_prices (no live API calls — Tier 1).
// see Requirements/paper-trading.md

import type { Database } from 'better-sqlite3';
import { withTransaction } from '../db/connection.js';
import type {
  ScoringStrategy,
  BriefPick,
  PaperTrade,
  PaperTradeWithPnl,
  PaperTradeSummary,
  StrategyBreakdown,
  RetroSettings,
  BriefAccuracy,
  TradeVerdict,
  TradeRecommendation,
  TradeOutcome,
  TradeStatus,
} from '@shared/types.js';

// Default thresholds — user can override via Settings tab in Retrospect screen.
const DEFAULT_RETRO_SETTINGS: RetroSettings = {
  wheel:   { negThresholdPct: 5, incomeRangeThresholdPct: 8, closeSignalDte: 7, maxMoveAgainstPct: 15 },
  bullish: { negThresholdPct: 5, incomeRangeThresholdPct: 8, closeSignalDte: 7, maxMoveAgainstPct: 15 },
  bearish: { negThresholdPct: 5, incomeRangeThresholdPct: 8, closeSignalDte: 7, maxMoveAgainstPct: 15 },
  income:  { negThresholdPct: 8, incomeRangeThresholdPct: 8, closeSignalDte: 7, maxMoveAgainstPct: 15 },
  buy:     { negThresholdPct: 5, incomeRangeThresholdPct: 8, closeSignalDte: 7, maxMoveAgainstPct: 15 },
};

// Which StrategyLab slugs represent each brief strategy — mirrors DailyIntelligenceBriefJob.
const STRATEGY_RELEVANT_SLUGS: Record<ScoringStrategy, string[]> = {
  wheel:   ['short-naked-put', 'covered-call'],
  bullish: ['long-call-vertical', 'big-lizard', 'call-zebra', 'call-butterfly', 'poor-mans-covered-call'],
  bearish: ['long-put-vertical', 'reverse-big-lizard', 'put-zebra', 'put-butterfly', 'poor-mans-covered-put'],
  income:  ['short-strangle', 'iron-condor', 'short-straddle', 'dynamic-width-iron-condor', 'iron-fly'],
  buy:     ['long-call-vertical', 'call-zebra', 'poor-mans-covered-call', 'call-calendar'],
};

type DbRow = {
  id: number;
  brief_id: number | null;
  brief_strategy: string;
  brief_score: number | null;
  brief_rank: number | null;
  ticker: string;
  brief_date: string;
  strategy_name: string | null;
  legs_json: string;
  entry_date: string;
  entry_price: number | null;
  entry_premium: number | null;
  expiry_date: string | null;
  status: string;
  exit_date: string | null;
  exit_price: number | null;
  exit_notes: string | null;
  stock_return_pct: number | null;
  outcome: string | null;
  created_at: string;
};

function toTrade(row: DbRow): PaperTrade {
  return {
    id:             row.id,
    briefId:        row.brief_id,
    briefStrategy:  row.brief_strategy as ScoringStrategy,
    briefScore:     row.brief_score,
    briefRank:      row.brief_rank,
    ticker:         row.ticker,
    briefDate:      row.brief_date,
    strategyName:   row.strategy_name,
    legsJson:       row.legs_json,
    entryDate:      row.entry_date,
    entryPrice:     row.entry_price,
    entryPremium:   row.entry_premium,
    expiryDate:     row.expiry_date,
    status:         row.status as TradeStatus,
    exitDate:       row.exit_date,
    exitPrice:      row.exit_price,
    exitNotes:      row.exit_notes,
    stockReturnPct: row.stock_return_pct,
    outcome:        row.outcome as TradeOutcome | null,
    createdAt:      row.created_at,
  };
}

// Extract the best relevant StrategyLab structure for auto-capture.
function extractLabSetup(
  labResult: object | null,
  strategy: ScoringStrategy,
): { strategyName: string | null; legsJson: string; entryPremium: number | null; expiryDate: string | null } {
  if (!labResult) return { strategyName: null, legsJson: '[]', entryPremium: null, expiryDate: null };

  type SScore = {
    slug: string;
    name: string;
    totalScore: number;
    setup: {
      legs: unknown[];
      expiration: string;
      netCredit: number | null;
      netDebit: number | null;
      unavailableReason: string | null;
    } | null;
  };

  const result = labResult as { scores?: SScore[] };
  const slugs = STRATEGY_RELEVANT_SLUGS[strategy];
  let best: SScore | null = null;

  for (const s of result.scores ?? []) {
    if (slugs.includes(s.slug) && s.setup && !s.setup.unavailableReason) {
      if (!best || s.totalScore > best.totalScore) best = s;
    }
  }

  if (!best?.setup) return { strategyName: null, legsJson: '[]', entryPremium: null, expiryDate: null };

  const setup = best.setup;
  // Credit received = positive, debit paid = negative (per-share basis)
  const premium = setup.netCredit !== null && setup.netCredit > 0
    ? setup.netCredit
    : setup.netDebit !== null
      ? -setup.netDebit
      : null;

  return {
    strategyName: best.name,
    legsJson: JSON.stringify(setup.legs),
    entryPremium: premium,
    expiryDate: setup.expiration,
  };
}

// Verdict and recommendation logic — see Requirements/paper-trading.md thresholds.
function computeVerdict(
  strategy: ScoringStrategy,
  stockReturnPct: number,
  daysToExpiry: number | null,
  settings: RetroSettings,
): { verdict: TradeVerdict; recommendation: TradeRecommendation } {
  const cfg = settings[strategy];

  let isNegative: boolean;
  if (strategy === 'income') {
    isNegative = Math.abs(stockReturnPct) > cfg.incomeRangeThresholdPct;
  } else if (strategy === 'bearish') {
    isNegative = stockReturnPct > cfg.negThresholdPct;
  } else {
    isNegative = stockReturnPct < -cfg.negThresholdPct;
  }

  const verdict: TradeVerdict = isNegative ? 'negative'
    : Math.abs(stockReturnPct) < 1 ? 'neutral'
    : 'positive';

  let recommendation: TradeRecommendation = 'hold';
  if (isNegative) {
    // moveAgainst: positive = stock moved in the wrong direction by this %
    const moveAgainst = strategy === 'bearish' ? stockReturnPct : Math.abs(stockReturnPct);
    const exceedsMax = moveAgainst > cfg.maxMoveAgainstPct;
    const dteLow = daysToExpiry !== null && daysToExpiry <= cfg.closeSignalDte;
    if (exceedsMax || dteLow) recommendation = 'close_signal';
  }

  return { verdict, recommendation };
}

function computeOutcome(strategy: ScoringStrategy, stockReturnPct: number): TradeOutcome {
  if (Math.abs(stockReturnPct) <= 1) return 'breakeven';
  if (strategy === 'income') return Math.abs(stockReturnPct) <= 8 ? 'win' : 'loss';
  if (strategy === 'bearish') return stockReturnPct < 0 ? 'win' : 'loss';
  return stockReturnPct > 0 ? 'win' : 'loss';
}

export class PaperTradingService {
  constructor(private readonly db: Database) {}

  // ── Settings ───────────────────────────────────────────────────────────────

  getSettings(): RetroSettings {
    type Row = { value: string };
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get('retroSettings') as Row | undefined;
    if (!row) return DEFAULT_RETRO_SETTINGS;
    try {
      return { ...DEFAULT_RETRO_SETTINGS, ...JSON.parse(row.value) } as RetroSettings;
    } catch {
      return DEFAULT_RETRO_SETTINGS;
    }
  }

  saveSettings(settings: RetroSettings): void {
    this.db.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).run('retroSettings', JSON.stringify(settings));
  }

  // ── Auto-capture (called by DailyIntelligenceBriefJob after Stage 6) ──────

  autoCapture(
    strategy: ScoringStrategy,
    picks: BriefPick[],
    briefDate: string,   // YYYY-MM-DD ET
    briefId: number,
  ): void {
    withTransaction(this.db, () => {
      for (const pick of picks) {
        const { strategyName, legsJson, entryPremium, expiryDate } =
          extractLabSetup(pick.strategyLabResult ?? null, strategy);

        this.db.prepare(`
          INSERT INTO paper_trades (
            brief_id, brief_strategy, brief_score, brief_rank,
            ticker, brief_date, strategy_name, legs_json,
            entry_date, entry_price, entry_premium, expiry_date, status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')
          ON CONFLICT(ticker, brief_strategy, brief_date) DO UPDATE SET
            brief_id      = excluded.brief_id,
            brief_score   = excluded.brief_score,
            brief_rank    = excluded.brief_rank,
            strategy_name = excluded.strategy_name,
            legs_json     = excluded.legs_json,
            entry_price   = excluded.entry_price,
            entry_premium = excluded.entry_premium,
            expiry_date   = excluded.expiry_date
          WHERE paper_trades.status = 'open'
        `).run(
          briefId, strategy, pick.compositeScore, pick.rank,
          pick.ticker, briefDate, strategyName, legsJson,
          briefDate, pick.price ?? null, entryPremium, expiryDate,
        );
      }
    });
  }

  // ── Open positions with live P&L ──────────────────────────────────────────

  getOpenPositions(): PaperTradeWithPnl[] {
    const rows = this.db.prepare(`
      SELECT pt.*,
        hp.close AS current_price,
        hp.date  AS price_date
      FROM paper_trades pt
      LEFT JOIN (
        SELECT h.ticker, h.close, h.date
        FROM historical_prices h
        INNER JOIN (
          SELECT ticker, MAX(date) AS max_date FROM historical_prices GROUP BY ticker
        ) latest ON h.ticker = latest.ticker AND h.date = latest.max_date
      ) hp ON hp.ticker = pt.ticker
      WHERE pt.status = 'open'
      ORDER BY pt.brief_date DESC, pt.brief_strategy, pt.brief_rank
    `).all() as Array<DbRow & { current_price: number | null; price_date: string | null }>;

    const settings = this.getSettings();
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

    return rows.map(row => {
      const trade = toTrade(row);
      const currentPrice = row.current_price;

      const entryMs = new Date(trade.entryDate + 'T12:00:00Z').getTime();
      const todayMs = new Date(today + 'T12:00:00Z').getTime();
      const daysHeld = Math.max(0, Math.round((todayMs - entryMs) / 86_400_000));

      let daysToExpiry: number | null = null;
      if (trade.expiryDate) {
        const expiryMs = new Date(trade.expiryDate + 'T12:00:00Z').getTime();
        daysToExpiry = Math.max(0, Math.round((expiryMs - todayMs) / 86_400_000));
      }

      let verdict: TradeVerdict = 'neutral';
      let recommendation: TradeRecommendation = 'hold';
      let estimatedPnl: number | null = null;

      if (currentPrice !== null && trade.entryPrice !== null && trade.entryPrice > 0) {
        const stockReturnPct = (currentPrice - trade.entryPrice) / trade.entryPrice * 100;
        const result = computeVerdict(trade.briefStrategy, stockReturnPct, daysToExpiry, settings);
        verdict = result.verdict;
        recommendation = result.recommendation;

        // Delta-based estimated P&L (approximation — label clearly in UI)
        try {
          type Leg = { delta: number | null; qty: number; action: 'buy' | 'sell' };
          const legs = JSON.parse(trade.legsJson) as Leg[];
          if (legs.length > 0 && legs.every(l => l.delta !== null)) {
            const priceDelta = currentPrice - trade.entryPrice;
            estimatedPnl = legs.reduce((sum, leg) => {
              const sign = leg.action === 'sell' ? -1 : 1;
              return sum + (leg.delta! * priceDelta * 100 * leg.qty * sign);
            }, 0);
          }
        } catch {
          estimatedPnl = null;
        }
      }

      return {
        ...trade,
        currentPrice,
        priceDate: row.price_date,
        daysHeld,
        daysToExpiry,
        verdict,
        recommendation,
        estimatedPnl,
      };
    });
  }

  // ── Closed / expired positions ─────────────────────────────────────────────

  getClosedPositions(limit = 100): PaperTrade[] {
    const rows = this.db.prepare(`
      SELECT * FROM paper_trades
      WHERE status IN ('closed', 'expired')
      ORDER BY exit_date DESC, id DESC
      LIMIT ?
    `).all(limit) as DbRow[];
    return rows.map(toTrade);
  }

  // ── Close a position (auto-fills exit price from historical_prices) ────────

  closePosition(id: number, notes?: string): void {
    const row = this.db.prepare('SELECT * FROM paper_trades WHERE id = ?').get(id) as DbRow | undefined;
    if (!row || row.status !== 'open') return;

    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

    type PriceRow = { close: number };
    const priceRow = this.db.prepare(
      'SELECT close FROM historical_prices WHERE ticker = ? ORDER BY date DESC LIMIT 1'
    ).get(row.ticker) as PriceRow | undefined;

    const exitPrice = priceRow?.close ?? null;
    let stockReturnPct: number | null = null;
    let outcome: TradeOutcome | null = null;

    if (exitPrice !== null && row.entry_price !== null && row.entry_price > 0) {
      stockReturnPct = (exitPrice - row.entry_price) / row.entry_price * 100;
      outcome = computeOutcome(row.brief_strategy as ScoringStrategy, stockReturnPct);
    }

    this.db.prepare(`
      UPDATE paper_trades
      SET status = 'closed', exit_date = ?, exit_price = ?, exit_notes = ?,
          stock_return_pct = ?, outcome = ?
      WHERE id = ?
    `).run(today, exitPrice, notes ?? null, stockReturnPct, outcome, id);
  }

  deleteTrade(id: number): void {
    this.db.prepare('DELETE FROM paper_trades WHERE id = ?').run(id);
  }

  // ── Auto-expire positions past expiry_date ─────────────────────────────────

  expireStalePositions(): number {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

    type ExpiredRow = { id: number; ticker: string; expiry_date: string; entry_price: number | null; brief_strategy: string };
    const stale = this.db.prepare(`
      SELECT id, ticker, expiry_date, entry_price, brief_strategy
      FROM paper_trades
      WHERE status = 'open' AND expiry_date IS NOT NULL AND expiry_date < ?
    `).all(today) as ExpiredRow[];

    let count = 0;
    for (const row of stale) {
      type PriceRow = { close: number };
      // Use last available close on or before the expiry date
      const priceRow = this.db.prepare(`
        SELECT close FROM historical_prices
        WHERE ticker = ? AND date <= ?
        ORDER BY date DESC LIMIT 1
      `).get(row.ticker, row.expiry_date) as PriceRow | undefined;

      const exitPrice = priceRow?.close ?? null;
      let stockReturnPct: number | null = null;
      let outcome: TradeOutcome | null = null;

      if (exitPrice !== null && row.entry_price !== null && row.entry_price > 0) {
        stockReturnPct = (exitPrice - row.entry_price) / row.entry_price * 100;
        outcome = computeOutcome(row.brief_strategy as ScoringStrategy, stockReturnPct);
      }

      this.db.prepare(`
        UPDATE paper_trades
        SET status = 'expired', exit_date = ?, exit_price = ?,
            stock_return_pct = ?, outcome = ?
        WHERE id = ?
      `).run(row.expiry_date, exitPrice, stockReturnPct, outcome, row.id);
      count++;
    }

    return count;
  }

  // ── Summary stats ──────────────────────────────────────────────────────────

  getSummary(): PaperTradeSummary {
    type CountRow = { total: number; open_count: number; closed_count: number };
    const counts = this.db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open_count,
        SUM(CASE WHEN status IN ('closed', 'expired') THEN 1 ELSE 0 END) AS closed_count
      FROM paper_trades
    `).get() as CountRow;

    type WinRow = { wins: number; total_closed: number; avg_return: number | null };
    const winRow = this.db.prepare(`
      SELECT
        SUM(CASE WHEN outcome = 'win' THEN 1 ELSE 0 END) AS wins,
        COUNT(*) AS total_closed,
        AVG(stock_return_pct) AS avg_return
      FROM paper_trades
      WHERE status IN ('closed', 'expired') AND stock_return_pct IS NOT NULL
    `).get() as WinRow;

    type BestRow = { ticker: string; stock_return_pct: number };
    const best = this.db.prepare(`
      SELECT ticker, stock_return_pct FROM paper_trades
      WHERE status IN ('closed', 'expired') AND stock_return_pct IS NOT NULL
      ORDER BY stock_return_pct DESC LIMIT 1
    `).get() as BestRow | undefined;

    const worst = this.db.prepare(`
      SELECT ticker, stock_return_pct FROM paper_trades
      WHERE status IN ('closed', 'expired') AND stock_return_pct IS NOT NULL
      ORDER BY stock_return_pct ASC LIMIT 1
    `).get() as BestRow | undefined;

    return {
      totalTrades:  counts.total,
      openTrades:   counts.open_count,
      closedTrades: counts.closed_count,
      winRate:      winRow.total_closed > 0 ? (winRow.wins / winRow.total_closed) * 100 : null,
      avgReturn:    winRow.avg_return,
      bestTrade:    best  ? { ticker: best.ticker,  returnPct: best.stock_return_pct  } : null,
      worstTrade:   worst ? { ticker: worst.ticker, returnPct: worst.stock_return_pct } : null,
    };
  }

  // ── Per-strategy breakdown ─────────────────────────────────────────────────

  getStrategyBreakdown(): StrategyBreakdown[] {
    type BdRow = {
      strategy: string;
      total: number;
      wins: number;
      losses: number;
      breakevens: number;
      open_count: number;
      avg_return: number | null;
    };
    const rows = this.db.prepare(`
      SELECT
        brief_strategy AS strategy,
        COUNT(*) AS total,
        SUM(CASE WHEN outcome = 'win'       THEN 1 ELSE 0 END) AS wins,
        SUM(CASE WHEN outcome = 'loss'      THEN 1 ELSE 0 END) AS losses,
        SUM(CASE WHEN outcome = 'breakeven' THEN 1 ELSE 0 END) AS breakevens,
        SUM(CASE WHEN status = 'open'       THEN 1 ELSE 0 END) AS open_count,
        AVG(CASE WHEN status IN ('closed','expired') THEN stock_return_pct ELSE NULL END) AS avg_return
      FROM paper_trades
      GROUP BY brief_strategy
      ORDER BY brief_strategy
    `).all() as BdRow[];

    return rows.map(row => {
      const closed = row.wins + row.losses + row.breakevens;
      return {
        strategy:   row.strategy as ScoringStrategy,
        total:      row.total,
        wins:       row.wins,
        losses:     row.losses,
        breakevens: row.breakevens,
        open:       row.open_count,
        winRate:    closed > 0 ? (row.wins / closed) * 100 : null,
        avgReturn:  row.avg_return,
      };
    });
  }

  // ── Brief accuracy (shown as banner on DailyBriefView history) ────────────

  getBriefAccuracy(briefDate: string): BriefAccuracy {
    type AccRow = { total_closed: number; wins: number };
    const row = this.db.prepare(`
      SELECT
        COUNT(*) AS total_closed,
        SUM(CASE WHEN outcome = 'win' THEN 1 ELSE 0 END) AS wins
      FROM paper_trades
      WHERE brief_date = ? AND status IN ('closed', 'expired') AND outcome IS NOT NULL
    `).get(briefDate) as AccRow;

    return {
      date:        briefDate,
      totalClosed: row.total_closed,
      wins:        row.wins,
      // Requires ≥ 3 closed trades to report accuracy (avoid misleading 100% on 1 trade)
      accuracy:    row.total_closed >= 3 ? (row.wins / row.total_closed) * 100 : null,
    };
  }

  // Returns accuracy for multiple brief dates in one query (for history banner)
  getBriefAccuracyBatch(briefDates: string[]): BriefAccuracy[] {
    if (briefDates.length === 0) return [];
    const placeholders = briefDates.map(() => '?').join(',');
    type AccRow = { brief_date: string; total_closed: number; wins: number };
    const rows = this.db.prepare(`
      SELECT
        brief_date,
        COUNT(*) AS total_closed,
        SUM(CASE WHEN outcome = 'win' THEN 1 ELSE 0 END) AS wins
      FROM paper_trades
      WHERE brief_date IN (${placeholders})
        AND status IN ('closed', 'expired') AND outcome IS NOT NULL
      GROUP BY brief_date
    `).all(...briefDates) as AccRow[];

    return rows.map(row => ({
      date:        row.brief_date,
      totalClosed: row.total_closed,
      wins:        row.wins,
      accuracy:    row.total_closed >= 3 ? (row.wins / row.total_closed) * 100 : null,
    }));
  }
}
