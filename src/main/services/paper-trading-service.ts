// Paper Trading Service — tracks Daily Brief picks as paper trades for scoring-engine validation.
// Auto-captures post-liquidity-gate picks at end of each brief run.
// P&L computed from historical_prices (no live API calls — Tier 1).
// see Requirements/paper-trading.md

import type { Database } from 'better-sqlite3';
import Anthropic from '@anthropic-ai/sdk';
import { withTransaction } from '../db/connection.js';
import { secureGet } from './secure-settings.js';
import type {
  ScoringStrategy,
  BriefPick,
  PaperTrade,
  PaperTradeWithPnl,
  PaperTradeSummary,
  StrategyBreakdown,
  RetroSettings,
  BriefAccuracy,
  SnapshotAccuracy,
  SnapshotStrategyRow,
  SnapshotBriefRow,
  TradeVerdict,
  TradeRecommendation,
  TradeOutcome,
  TradeStatus,
  TradeInsight,
  TradeLearning,
  TradeLearningGapCause,
  BriefLearningRecommendation,
  BriefPerformanceSummary,
  BriefPickDetail,
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
  learning_json: string | null;
};

function toTrade(row: DbRow): PaperTrade {
  let learning: TradeLearning | null = null;
  if (row.learning_json) {
    try { learning = JSON.parse(row.learning_json) as TradeLearning; } catch { /* ignore */ }
  }
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
    learning,
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

// ── Rule-based trade insight ──────────────────────────────────────────────────
// Gives a plain-English recommendation for each open position based on current
// market state. No AI — purely deterministic from price data.
function computeInsight(
  strategy: ScoringStrategy,
  stockReturnPct: number,
  daysToExpiry: number | null,
  verdict: TradeVerdict,
  recommendation: TradeRecommendation,
  settings: RetroSettings,
  entryPremium?: number | null,
  estimatedPnl?: number | null,
): TradeInsight {
  // 2× credit stop triggered by option P&L (not stock move)
  if (
    recommendation === 'close_signal' &&
    entryPremium != null && entryPremium > 0 &&
    estimatedPnl != null && estimatedPnl < -(entryPremium * 2)
  ) {
    return {
      action: 'close', urgency: 'high',
      reason: `Option P&L stop: est. loss $${Math.abs(estimatedPnl).toFixed(0)} exceeds 2× credit ($${(entryPremium * 2).toFixed(0)})`,
      suggestion: 'Close position — loss has exceeded 2× the credit received (hard stop)',
    };
  }
  const cfg = settings[strategy];
  const dte  = daysToExpiry;

  // ── Pin risk: ≤ 3 DTE, close regardless of direction ─────────────────────
  if (dte !== null && dte <= 3) {
    return {
      action: 'close', urgency: 'high',
      reason: `${dte}d to expiry — avoid pin risk and potential assignment`,
      suggestion: 'Close the entire position today',
    };
  }

  // ── Close signal: move too large or DTE too low + negative ───────────────
  if (recommendation === 'close_signal') {
    const moveAgainst = strategy === 'bearish' ? stockReturnPct : stockReturnPct;
    const isBigMove   = Math.abs(stockReturnPct) > cfg.maxMoveAgainstPct;
    return {
      action: 'close', urgency: 'high',
      reason: isBigMove
        ? `Stock moved ${Math.abs(stockReturnPct).toFixed(1)}% against position (limit: ${cfg.maxMoveAgainstPct}%)`
        : `${dte}d left with negative verdict — close to limit loss`,
      suggestion: 'Close position to prevent further loss',
    };
  }

  // ── Take profit: credit strategies at ≤21 DTE while positive ─────────────
  if ((strategy === 'wheel' || strategy === 'income') && verdict === 'positive' && dte !== null && dte <= 21) {
    return {
      action: 'take_profit', urgency: 'medium',
      reason: `${dte}d left, position is positive — standard 50% profit rule applies`,
      suggestion: 'Close for roughly 50% of max profit and redeploy capital',
    };
  }

  // ── Take profit: directional strategies on big favourable moves ───────────
  if ((strategy === 'bullish' || strategy === 'buy') && stockReturnPct >= 8 && dte !== null && dte <= 14) {
    return {
      action: 'take_profit', urgency: 'medium',
      reason: `Stock up ${stockReturnPct.toFixed(1)}% with only ${dte}d remaining`,
      suggestion: 'Lock in gains — most of the directional move may already be priced in',
    };
  }
  if (strategy === 'bearish' && stockReturnPct <= -8 && dte !== null && dte <= 14) {
    return {
      action: 'take_profit', urgency: 'medium',
      reason: `Stock down ${Math.abs(stockReturnPct).toFixed(1)}% with only ${dte}d remaining`,
      suggestion: 'Lock in gains — consider closing the put spread',
    };
  }

  // ── Roll: credit strategies with ≤14 DTE not losing badly ────────────────
  if ((strategy === 'wheel' || strategy === 'income') && dte !== null && dte <= 14 && verdict !== 'negative') {
    return {
      action: 'roll', urgency: 'low',
      reason: `${dte}d to expiry — ${verdict} position worth rolling for more premium`,
      suggestion: `Close current expiry and sell the next monthly cycle`,
    };
  }

  // ── Watch: negative but not yet at close-signal threshold ────────────────
  if (verdict === 'negative') {
    const buffer = cfg.maxMoveAgainstPct - Math.abs(stockReturnPct);
    return {
      action: 'watch', urgency: 'medium',
      reason: `Position negative (${stockReturnPct >= 0 ? '+' : ''}${stockReturnPct.toFixed(1)}% stock) — ${buffer.toFixed(1)}% buffer to close signal`,
      suggestion: null,
    };
  }

  // ── Hold ──────────────────────────────────────────────────────────────────
  return {
    action: 'hold', urgency: 'low',
    reason: verdict === 'positive'
      ? `On track — stock ${stockReturnPct >= 0 ? '+' : ''}${stockReturnPct.toFixed(1)}%`
      : `Range-bound — theta decaying as expected`,
    suggestion: null,
  };
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
      let stockReturnPct: number | null = null;

      // Day 0: no full trading day has elapsed since capture — the historical_prices
      // price may predate the brief, making any comparison a data-freshness artefact
      // rather than real price movement. Suppress verdict until daysHeld >= 1.
      const canComputeVerdict = daysHeld >= 1;

      if (canComputeVerdict && currentPrice !== null && trade.entryPrice !== null && trade.entryPrice > 0) {
        stockReturnPct = (currentPrice - trade.entryPrice) / trade.entryPrice * 100;
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

      // 1a: Option P&L stop — 2× credit received, regardless of stock move.
      // Uses delta-estimated P&L. Only fires for credit strategies (entryPremium > 0).
      if (
        recommendation !== 'close_signal' &&
        trade.entryPremium !== null && trade.entryPremium > 0 &&
        estimatedPnl !== null && estimatedPnl < -(trade.entryPremium * 2)
      ) {
        recommendation = 'close_signal';
        verdict = 'negative';
      }

      const insight = computeInsight(
        trade.briefStrategy, stockReturnPct ?? 0,
        daysToExpiry, verdict, recommendation, settings,
        trade.entryPremium, estimatedPnl,
      );

      return {
        ...trade,
        currentPrice,
        priceDate: row.price_date,
        daysHeld,
        daysToExpiry,
        verdict,
        recommendation,
        estimatedPnl,
        insight,
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

    // Fire-and-forget AI learning capture — completes async, updates DB when done
    this.captureCloseLearning(id).catch(() => { /* silent */ });
  }

  deleteTrade(id: number): void {
    this.db.prepare('DELETE FROM paper_trades WHERE id = ?').run(id);
  }

  // ── AI learning capture ───────────────────────────────────────────────────
  // Called fire-and-forget after every close/expire. Silently skips if no
  // Anthropic API key is configured or if the trade already has learning.
  async captureCloseLearning(id: number): Promise<void> {
    try {
      const apiKey = secureGet(this.db, 'anthropicApiKey');
      if (!apiKey) return;

      const row = this.db.prepare('SELECT * FROM paper_trades WHERE id = ?').get(id) as DbRow | undefined;
      if (!row || row.status === 'open' || row.learning_json) return;

      const daysHeld = row.exit_date
        ? Math.round((new Date(row.exit_date + 'T12:00:00Z').getTime() - new Date(row.entry_date + 'T12:00:00Z').getTime()) / 86_400_000)
        : null;

      const prompt = `Analyze this completed paper options trade and return JSON learning notes.

Ticker: ${row.ticker}
Strategy type: ${row.brief_strategy} — structure: ${row.strategy_name ?? 'unknown'}
Duration: ${daysHeld !== null ? `${daysHeld} days` : 'unknown'} (${row.entry_date} → ${row.exit_date ?? 'today'})
Entry stock price: $${row.entry_price?.toFixed(2) ?? '?'} | Exit: $${row.exit_price?.toFixed(2) ?? '?'}
Stock return: ${row.stock_return_pct !== null ? row.stock_return_pct.toFixed(1) + '%' : 'unknown'}
Outcome: ${row.outcome ?? 'unknown'} (${row.status})${row.exit_notes ? '\nExit notes: ' + row.exit_notes : ''}

In exactly one sentence each:
1. Did the setup fit conditions? (strategyWorked: true/false, entryFit: good/early/late/wrong)
2. What was the key outcome driver? (keyLesson)
3. Specific tweak for next similar trade? (suggestedTweak, or null)
4. Which gap cause best classifies this outcome? Pick EXACTLY ONE:
   EARNINGS_GAP_RISK = earnings during hold caused binary move
   IV_CRUSH = IV declined after entry reducing premium value
   TREND_REVERSAL = stock direction reversed against the position
   THETA_UNDERESTIMATE = slower theta decay than expected
   EARLY_CLOSE_MISSED = closed profitable trade before reaching full target
   MODEL_ERROR = loss unexplained by the above

Respond with JSON only:
{"strategyWorked":bool,"entryFit":"good"|"early"|"late"|"wrong","gapCause":"EARNINGS_GAP_RISK"|"IV_CRUSH"|"TREND_REVERSAL"|"THETA_UNDERESTIMATE"|"EARLY_CLOSE_MISSED"|"MODEL_ERROR","keyLesson":"...","suggestedTweak":"..."|null}`;

      const client = new Anthropic({ apiKey });
      const resp = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 350,
        messages: [{ role: 'user', content: prompt }],
      });

      const text = resp.content.find(b => b.type === 'text')?.text ?? '';
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) return;

      const raw = JSON.parse(match[0]) as Record<string, unknown>;
      const VALID_FIT  = new Set(['good', 'early', 'late', 'wrong']);
      const VALID_CAUSE = new Set<TradeLearningGapCause>([
        'EARNINGS_GAP_RISK', 'IV_CRUSH', 'TREND_REVERSAL',
        'THETA_UNDERESTIMATE', 'EARLY_CLOSE_MISSED', 'MODEL_ERROR',
      ]);
      const rawCause = String(raw['gapCause'] ?? '');
      const learning: TradeLearning = {
        strategyWorked: Boolean(raw['strategyWorked']),
        entryFit:       VALID_FIT.has(String(raw['entryFit'])) ? raw['entryFit'] as TradeLearning['entryFit'] : 'good',
        gapCause:       VALID_CAUSE.has(rawCause as TradeLearningGapCause) ? rawCause as TradeLearningGapCause : null,
        keyLesson:      String(raw['keyLesson'] ?? ''),
        suggestedTweak: raw['suggestedTweak'] ? String(raw['suggestedTweak']) : null,
        capturedAt:     new Date().toISOString(),
      };

      this.db.prepare('UPDATE paper_trades SET learning_json = ? WHERE id = ?')
        .run(JSON.stringify(learning), id);

      // 1c: Check if this gap cause has now recurred ≥3 times → generate recommendation
      if (learning.gapCause) {
        this.checkForPatternRecommendations(row.brief_strategy as ScoringStrategy, learning.gapCause);
      }
    } catch {
      // Non-fatal — learning capture is best-effort
    }
  }

  // ── 1c: Pattern-based recommendations ─────────────────────────────────────
  private checkForPatternRecommendations(strategy: ScoringStrategy, gapCause: TradeLearningGapCause): void {
    try {
      type CountRow = { n: number };
      const count = (this.db.prepare(`
        SELECT COUNT(*) AS n FROM paper_trades
        WHERE brief_strategy = ?
          AND json_extract(learning_json, '$.gapCause') = ?
          AND status IN ('closed', 'expired')
      `).get(strategy, gapCause) as CountRow).n;

      if (count < 3) return;

      const { description, proposedTweak } = this.buildPatternRecommendation(strategy, gapCause, count);

      this.db.prepare(`
        INSERT INTO brief_learning_recommendations
          (strategy, gap_cause, occurrence_count, description, proposed_tweak, status)
        VALUES (?, ?, ?, ?, ?, 'open')
        ON CONFLICT(strategy, gap_cause) DO UPDATE SET
          occurrence_count = excluded.occurrence_count,
          description      = excluded.description,
          proposed_tweak   = excluded.proposed_tweak,
          status           = CASE WHEN status = 'acknowledged' THEN 'open' ELSE status END,
          created_at       = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      `).run(strategy, gapCause, count, description, proposedTweak);
    } catch { /* non-fatal */ }
  }

  private buildPatternRecommendation(
    strategy: ScoringStrategy, cause: TradeLearningGapCause, count: number,
  ): { description: string; proposedTweak: string } {
    const s = strategy.charAt(0).toUpperCase() + strategy.slice(1);
    const descMap: Record<TradeLearningGapCause, string> = {
      EARNINGS_GAP_RISK:   `${count} ${s} picks were caught in earnings moves. IV spikes and binary gaps are eroding premium.`,
      IV_CRUSH:            `${count} ${s} picks suffered IV crush after entry — premium decayed faster than the stock moved.`,
      TREND_REVERSAL:      `${count} ${s} picks had the underlying reverse direction after entry.`,
      THETA_UNDERESTIMATE: `${count} ${s} picks showed slower theta decay than expected.`,
      EARLY_CLOSE_MISSED:  `${count} ${s} picks were closed profitably before reaching full target — leaving premium on the table.`,
      MODEL_ERROR:         `${count} ${s} picks had unexplained losses — composite score may be missing a key factor.`,
    };
    const tweakMap: Record<TradeLearningGapCause, string> = {
      EARNINGS_GAP_RISK:   'Tighten earnings exclusion or require IV rank > 40 for earnings-sensitive names.',
      IV_CRUSH:            'Only enter when IV rank ≥ 50 and IV percentile ≥ 60 — avoid entering after a recent IV spike has already peaked.',
      TREND_REVERSAL:      'Add trend-confirmation: require MA20 > MA50 (bullish/wheel) or MA20 < MA50 (bearish) at brief time.',
      THETA_UNDERESTIMATE: 'Target 40% profit instead of 50% to capture gains before theta plateaus in the back half of the position.',
      EARLY_CLOSE_MISSED:  'Review close-signal thresholds — early closes have lower average return than full holds to the 50% target.',
      MODEL_ERROR:         `Review ${s} signal weights — consider increasing IV rank and liquidity weights which have the clearest options-theory basis.`,
    };
    return { description: descMap[cause], proposedTweak: tweakMap[cause] };
  }

  getLearningRecommendations(): BriefLearningRecommendation[] {
    type Row = {
      id: number; strategy: string; gap_cause: string; occurrence_count: number;
      description: string; proposed_tweak: string; status: string; created_at: string;
    };
    try {
      const rows = this.db.prepare(`
        SELECT id, strategy, gap_cause, occurrence_count, description, proposed_tweak, status, created_at
        FROM brief_learning_recommendations
        WHERE status = 'open'
        ORDER BY occurrence_count DESC, created_at DESC
      `).all() as Row[];
      return rows.map(r => ({
        id:              r.id,
        strategy:        r.strategy,
        gapCause:        r.gap_cause as TradeLearningGapCause,
        occurrenceCount: r.occurrence_count,
        description:     r.description,
        proposedTweak:   r.proposed_tweak,
        status:          r.status as 'open' | 'acknowledged',
        createdAt:       r.created_at,
      }));
    } catch { return []; }
  }

  acknowledgeLearningRecommendation(id: number): void {
    this.db.prepare(
      "UPDATE brief_learning_recommendations SET status = 'acknowledged' WHERE id = ?"
    ).run(id);
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

      // Fire-and-forget AI learning capture
      this.captureCloseLearning(row.id).catch(() => { /* silent */ });
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

  // ── Daily price snapshots (called by DailyPaperSnapshotJob) ──────────────
  //
  // For every paper trade whose entry_date is before today, insert one snapshot row
  // per trading-day close available in historical_prices that we haven't snapshotted
  // yet.  ON CONFLICT DO NOTHING makes this fully idempotent — safe to run many
  // times per day.
  //
  // Returns the number of new snapshot rows written.
  snapshotTrades(): number {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const settings = this.getSettings();

    // Load all trades that have at least one full trading day of history to snapshot.
    type TradeRow = {
      id: number;
      brief_strategy: string;
      entry_date: string;
      entry_price: number | null;
      expiry_date: string | null;
      ticker: string;
    };
    const trades = this.db.prepare(`
      SELECT id, brief_strategy, entry_date, entry_price, expiry_date, ticker
      FROM paper_trades
      WHERE entry_date < ?
    `).all(today) as TradeRow[];

    if (trades.length === 0) return 0;

    // Build a set of (paper_trade_id, snapshot_date) already in the table so we
    // can skip them without relying solely on the DB conflict (avoids lock churn).
    type ExistingRow = { paper_trade_id: number; snapshot_date: string };
    const existingRows = this.db.prepare(
      'SELECT paper_trade_id, snapshot_date FROM paper_trade_snapshots'
    ).all() as ExistingRow[];
    const existing = new Set(existingRows.map(r => `${r.paper_trade_id}|${r.snapshot_date}`));

    const insert = this.db.prepare(`
      INSERT INTO paper_trade_snapshots
        (paper_trade_id, snapshot_date, days_held, price, return_pct, verdict)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(paper_trade_id, snapshot_date) DO NOTHING
    `);

    // Price lookup: for a given ticker get all (date, close) after a given entry date.
    type PriceRow = { date: string; close: number };

    let written = 0;
    withTransaction(this.db, () => {
      for (const trade of trades) {
        if (trade.entry_price == null || trade.entry_price <= 0) continue;

        const prices = this.db.prepare(`
          SELECT date, close
          FROM historical_prices
          WHERE ticker = ? AND date > ? AND date <= ?
          ORDER BY date ASC
        `).all(trade.ticker, trade.entry_date, today) as PriceRow[];

        for (const { date: snapDate, close } of prices) {
          if (existing.has(`${trade.id}|${snapDate}`)) continue;

          const entryMs   = new Date(trade.entry_date + 'T12:00:00Z').getTime();
          const snapMs    = new Date(snapDate        + 'T12:00:00Z').getTime();
          const daysHeld  = Math.max(1, Math.round((snapMs - entryMs) / 86_400_000));

          const returnPct = (close - trade.entry_price) / trade.entry_price * 100;

          // DTE at snapshot date (for verdict thresholds — not the close_signal check)
          let daysToExpiry: number | null = null;
          if (trade.expiry_date) {
            const expiryMs = new Date(trade.expiry_date + 'T12:00:00Z').getTime();
            daysToExpiry = Math.max(0, Math.round((expiryMs - snapMs) / 86_400_000));
          }

          const { verdict } = computeVerdict(
            trade.brief_strategy as ScoringStrategy,
            returnPct,
            daysToExpiry,
            settings,
          );

          const result = insert.run(trade.id, snapDate, daysHeld, close, returnPct, verdict);
          if (result.changes > 0) {
            written++;
            existing.add(`${trade.id}|${snapDate}`); // prevent double-insert within same tx
          }
        }
      }
    });

    return written;
  }

  // ── Snapshot-based accuracy (next-day, from paper_trade_snapshots) ──────────
  //
  // Uses the FIRST available snapshot per trade (= next trading day's close) as the
  // evaluation point so every brief and every strategy are measured on equal footing.
  // Requires ≥ 3 trades per cell before reporting accuracy (avoid misleading 100%).
  getSnapshotAccuracy(): SnapshotAccuracy {
    // Total snapshot rows
    type CountRow = { n: number };
    const totalSnapshots = (this.db.prepare('SELECT COUNT(*) AS n FROM paper_trade_snapshots').get() as CountRow).n;

    if (totalSnapshots === 0) {
      return { totalSnapshots: 0, byStrategy: [], byBriefDate: [] };
    }

    // Common CTE: find the first snapshot (min days_held) per trade
    const cte = `
      WITH first_snap AS (
        SELECT paper_trade_id, MIN(days_held) AS min_held
        FROM paper_trade_snapshots
        GROUP BY paper_trade_id
      ),
      day1 AS (
        SELECT s.paper_trade_id, s.return_pct, s.verdict
        FROM paper_trade_snapshots s
        JOIN first_snap fs
          ON fs.paper_trade_id = s.paper_trade_id AND s.days_held = fs.min_held
      )
    `;

    // Per-strategy
    type SRow = {
      strategy: string; total: number;
      positives: number; negatives: number; neutrals: number;
      avg_return: number | null;
    };
    const stratRows = this.db.prepare(`
      ${cte}
      SELECT
        pt.brief_strategy        AS strategy,
        COUNT(*)                 AS total,
        SUM(CASE WHEN d.verdict = 'positive' THEN 1 ELSE 0 END) AS positives,
        SUM(CASE WHEN d.verdict = 'negative' THEN 1 ELSE 0 END) AS negatives,
        SUM(CASE WHEN d.verdict = 'neutral'  THEN 1 ELSE 0 END) AS neutrals,
        AVG(d.return_pct)        AS avg_return
      FROM paper_trades pt
      JOIN day1 d ON d.paper_trade_id = pt.id
      GROUP BY pt.brief_strategy
      ORDER BY pt.brief_strategy
    `).all() as SRow[];

    const byStrategy: SnapshotStrategyRow[] = stratRows.map(r => ({
      strategy:  r.strategy as ScoringStrategy,
      total:     r.total,
      positives: r.positives,
      negatives: r.negatives,
      neutrals:  r.neutrals,
      accuracy:  r.total >= 3 ? (r.positives / r.total) * 100 : null,
      avgReturn: r.avg_return,
    }));

    // Per-brief-date
    type BRow = {
      brief_date: string; total: number;
      positives: number; negatives: number;
      avg_return: number | null;
    };
    const briefRows = this.db.prepare(`
      ${cte}
      SELECT
        pt.brief_date            AS brief_date,
        COUNT(*)                 AS total,
        SUM(CASE WHEN d.verdict = 'positive' THEN 1 ELSE 0 END) AS positives,
        SUM(CASE WHEN d.verdict = 'negative' THEN 1 ELSE 0 END) AS negatives,
        AVG(d.return_pct)        AS avg_return
      FROM paper_trades pt
      JOIN day1 d ON d.paper_trade_id = pt.id
      GROUP BY pt.brief_date
      ORDER BY pt.brief_date DESC
    `).all() as BRow[];

    const byBriefDate: SnapshotBriefRow[] = briefRows.map(r => ({
      briefDate:  r.brief_date,
      total:      r.total,
      positives:  r.positives,
      negatives:  r.negatives,
      accuracy:   r.total >= 3 ? (r.positives / r.total) * 100 : null,
      avgReturn:  r.avg_return,
    }));

    return { totalSnapshots, byStrategy, byBriefDate };
  }

  // Returns Day+5 performance for the most recent brief that has mature snapshot data.
  // Used by the Daily Brief header banner (B-01). Returns null when no Day+5 data exists yet.
  getBriefPerformanceSummary(): BriefPerformanceSummary | null {
    // 1. Find the most-recent brief_date that has at least one trade with a Day+5 snapshot
    type DateRow = { brief_date: string };
    const latestRow = this.db.prepare(`
      SELECT DISTINCT pt.brief_date
      FROM paper_trades pt
      WHERE EXISTS (
        SELECT 1 FROM paper_trade_snapshots s
        WHERE s.paper_trade_id = pt.id AND s.days_held >= 5
      )
      ORDER BY pt.brief_date DESC
      LIMIT 1
    `).get() as DateRow | undefined;

    if (!latestRow) return null;
    const { brief_date: briefDate } = latestRow;

    // 2. For that brief_date, per strategy: pick the snapshot closest to Day+5
    //    (first snapshot with days_held >= 5 per trade)
    type StratRow = { strategy: string; picks: number; hits: number; avg_return: number | null };
    const rows = this.db.prepare(`
      WITH day5 AS (
        SELECT
          s.paper_trade_id,
          s.return_pct,
          s.verdict
        FROM paper_trade_snapshots s
        JOIN (
          SELECT paper_trade_id, MIN(days_held) AS min_held
          FROM paper_trade_snapshots
          WHERE days_held >= 5
          GROUP BY paper_trade_id
        ) best ON best.paper_trade_id = s.paper_trade_id
               AND s.days_held = best.min_held
      )
      SELECT
        pt.brief_strategy              AS strategy,
        COUNT(*)                       AS picks,
        SUM(CASE WHEN d.verdict = 'positive' THEN 1 ELSE 0 END) AS hits,
        AVG(d.return_pct)              AS avg_return
      FROM paper_trades pt
      JOIN day5 d ON d.paper_trade_id = pt.id
      WHERE pt.brief_date = ?
      GROUP BY pt.brief_strategy
      ORDER BY pt.brief_strategy
    `).all(briefDate) as StratRow[];

    if (rows.length === 0) return null;

    return {
      briefDate,
      strategies: rows.map(r => ({
        strategy:     r.strategy as BriefPerformanceSummary['strategies'][number]['strategy'],
        picks:        r.picks,
        hits:         r.hits,
        avgReturnPct: r.avg_return,
      })),
    };
  }

  // ── Brief Trend: available brief dates ───────────────────────────────────────
  getBriefDates(): string[] {
    type Row = { brief_date: string };
    return (this.db.prepare(
      'SELECT DISTINCT brief_date FROM paper_trades ORDER BY brief_date DESC'
    ).all() as Row[]).map(r => r.brief_date);
  }

  // ── Brief Trend: per-pick drilldown for one brief date ───────────────────────
  // Joins paper_trades with Day+5 snapshots, then enriches each pick with
  // the critic verdict/rationale from daily_briefs.picks JSON, and the
  // entry zone from analysis_snapshots (buy strategy only).
  getBriefPickDrilldown(briefDate: string): BriefPickDetail[] {
    type TradeRow = {
      id: number;
      ticker: string;
      brief_strategy: string;
      brief_score: number;
      brief_rank: number;
      entry_price: number | null;
      day5_price: number | null;
      day5_return_pct: number | null;
      day5_verdict: string | null;
      day5_days_actual: number | null;
    };

    const trades = this.db.prepare(`
      WITH day5 AS (
        SELECT paper_trade_id, MIN(days_held) AS min_held
        FROM paper_trade_snapshots
        WHERE days_held >= 5
        GROUP BY paper_trade_id
      ),
      day5_snap AS (
        SELECT s.paper_trade_id, s.price AS day5_price,
               s.return_pct, s.verdict, s.days_held
        FROM paper_trade_snapshots s
        JOIN day5 d ON s.paper_trade_id = d.paper_trade_id
                   AND s.days_held = d.min_held
      )
      SELECT pt.id, pt.ticker, pt.brief_strategy, pt.brief_score, pt.brief_rank,
             pt.entry_price,
             s.day5_price, s.return_pct AS day5_return_pct,
             s.verdict AS day5_verdict, s.days_held AS day5_days_actual
      FROM paper_trades pt
      LEFT JOIN day5_snap s ON s.paper_trade_id = pt.id
      WHERE pt.brief_date = ?
      ORDER BY pt.brief_strategy, pt.brief_rank
    `).all(briefDate) as TradeRow[];

    if (trades.length === 0) return [];

    // Load brief picks JSON → critic verdict + AI rationale
    // Use the most-recent brief row per strategy for this calendar date
    type BriefRow = { strategy: string; picks: string };
    const briefRows = this.db.prepare(`
      WITH ranked AS (
        SELECT strategy, picks,
               ROW_NUMBER() OVER (PARTITION BY strategy ORDER BY generated_at DESC) AS rn
        FROM daily_briefs
        WHERE DATE(generated_at) = ?
      )
      SELECT strategy, picks FROM ranked WHERE rn = 1
    `).all(briefDate) as BriefRow[];

    type PickMeta = { criticVerdict: string | null; criticRationale: string | null; aiRationale: string | null };
    const pickMeta = new Map<string, PickMeta>();
    for (const row of briefRows) {
      try {
        const picks = JSON.parse(row.picks) as Array<{
          ticker: string;
          criticVerdict?: { verdict?: string; rationale?: string | null } | null;
          aiRationale?: string | null;
        }>;
        for (const p of picks) {
          pickMeta.set(`${row.strategy}:${p.ticker}`, {
            criticVerdict:   p.criticVerdict?.verdict   ?? null,
            criticRationale: p.criticVerdict?.rationale ?? null,
            aiRationale:     p.aiRationale              ?? null,
          });
        }
      } catch { /* skip malformed rows */ }
    }

    // Entry zone — buy strategy only, from nearest analysis_snapshot ≤ brief date
    // payload_json stores { jobRunId, results: AnalysisResult[] }
    const entryZoneStmt = this.db.prepare(`
      SELECT json_extract(je.value, '$.entryZoneLow')  AS entry_zone_low,
             json_extract(je.value, '$.entryZoneHigh') AS entry_zone_high
      FROM analysis_snapshots,
           json_each(json_extract(analysis_snapshots.payload_json, '$.results')) AS je
      WHERE analysis_snapshots.mode = 'buy'
        AND analysis_snapshots.run_at <= ?
        AND json_extract(je.value, '$.ticker') = ?
      ORDER BY analysis_snapshots.run_at DESC
      LIMIT 1
    `);

    return trades.map(t => {
      const meta = pickMeta.get(`${t.brief_strategy}:${t.ticker}`);

      let entryZoneLow: number | null = null;
      let entryZoneHigh: number | null = null;
      if (t.brief_strategy === 'buy') {
        type ZoneRow = { entry_zone_low: number | null; entry_zone_high: number | null };
        const zr = entryZoneStmt.get(`${briefDate}T23:59:59`, t.ticker) as ZoneRow | undefined;
        if (zr) { entryZoneLow = zr.entry_zone_low; entryZoneHigh = zr.entry_zone_high; }
      }

      return {
        ticker:          t.ticker,
        strategy:        t.brief_strategy as ScoringStrategy,
        briefScore:      t.brief_score,
        briefRank:       t.brief_rank,
        briefPrice:      t.entry_price,
        entryZoneLow,
        entryZoneHigh,
        day5Price:       t.day5_price,
        day5ReturnPct:   t.day5_return_pct,
        day5Verdict:     (t.day5_verdict ?? null) as BriefPickDetail['day5Verdict'],
        day5DaysActual:  t.day5_days_actual,
        criticVerdict:   ((meta?.criticVerdict) ?? null) as BriefPickDetail['criticVerdict'],
        criticRationale: meta?.criticRationale ?? null,
        aiRationale:     meta?.aiRationale     ?? null,
      };
    });
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
